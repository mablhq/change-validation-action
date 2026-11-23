// The pull request comment: after the stage request, keeps the pull request's comment on mabl's change
// validation report, posting the markdown mabl renders. It never fails the run. The README says when
// it posts.

import {readFileSync} from 'node:fs';

import {escapeInvisible} from './lib/policy-read.mjs';
import {apiUrlOf, basicAuthorization} from './lib/mabl-api.mjs';
import {MAX_ANNOTATION_CHARS, MINUTE_MS, TAKEN, TITLE, isObject, redactor, repositoryIdOf} from './lib/shared.mjs';
import {annotation, shorten} from './lib/workflow-commands.mjs';

export const REPORT_PATH = '/changeValidation/report';
// The first line of every comment mabl renders, and how its second line opens.
export const MARKER = '<!-- mabl-change-validation -->';
const DATA_PREFIX = '<!-- mabl-change-validation-data ';
const DATA_SUFFIX = ' -->';
export const POLL_INTERVAL_MS = 20_000;
const NO_CHANGE_AGENT = 'no_change_agent';
const DEFAULT_WAIT_MINUTES = 15;
const REQUEST_TIMEOUT_MS = 30_000;
const COMMENTS_PER_PAGE = 100;
const MAX_COMMENT_PAGES = 30;

const firstLine = (text) => String(text).split(/\r?\n/, 1)[0];
const sameBody = (a, b) => String(a).replace(/\r\n/g, '\n').trimEnd() === String(b).replace(/\r\n/g, '\n').trimEnd();

const FIND_QUERY =
  'query($owner: String!, $name: String!, $number: Int!, $after: String) { viewer { login } repository(owner: $owner, name: $name) { pullRequest(number: $number) { id comments(first: 100, after: $after) { nodes { id body author { __typename login } } pageInfo { hasNextPage endCursor } } } } }';
const CREATE_MUTATION = 'mutation($subject: ID!, $body: String!) { addComment(input: {subjectId: $subject, body: $body}) { commentEdge { node { id } } } }';
const UPDATE_MUTATION = 'mutation($id: ID!, $body: String!) { updateIssueComment(input: {id: $id, body: $body}) { issueComment { id } } }';

const sendsNothing = (env) => String(env.CHANGE_VALIDATION_SEND ?? '').trim() === 'false';

// `wait` on a pull request's own stage request mabl took, or on a pull request or comment event with
// send: 'false'; `merged` after a merged event mabl took; `once` after an awaited merge queue entry's
// status was published; otherwise null.
export function commentPlan({env, payload}) {
  if (String(env.CHANGE_VALIDATION_COMMENT ?? '').trim().toLowerCase() !== 'true' || !/^[1-9][0-9]*$/.test(String(env.PULL_REQUEST_NUMBER ?? ''))) {
    return null;
  }
  const eventName = env.GITHUB_EVENT_NAME;
  if (sendsNothing(env)) {
    return env.CHANGE_VALIDATION_OUTCOME === 'comment_only' && (eventName === 'pull_request' || eventName === 'issue_comment') ? 'wait' : null;
  }
  if (env.CHANGE_VALIDATION_AWAIT === 'true') {
    return eventName === 'merge_group' && String(env.CHANGE_VALIDATION_STATUS ?? '') !== '' ? 'once' : null;
  }
  if (eventName !== 'pull_request' || !TAKEN.has(env.CHANGE_VALIDATION_OUTCOME)) {
    return null;
  }
  return payload?.action === 'closed' ? 'merged' : 'wait';
}

// The mabl agent's session_id on a comment's data line, or null. A workspace has one agent per pull
// request, so it tells two callers' comments apart even when they share a token.
export function dataSession(text) {
  const line = String(text).split(/\r?\n/, 2)[1] ?? '';
  if (!line.startsWith(DATA_PREFIX) || !line.endsWith(DATA_SUFFIX)) {
    return null;
  }
  try {
    const session = JSON.parse(line.slice(DATA_PREFIX.length, -DATA_SUFFIX.length))?.session_id;
    return typeof session === 'string' && session !== '' ? session : null;
  } catch {
    return null;
  }
}

// Whether every application the change reaches, and mabl can analyse, has its analysis.
export function analysesFinished(report) {
  return report.applications
    .filter((application) => isObject(application) && application.applies === true && typeof application.mabl_application_id === 'string' && application.mabl_application_id !== '')
    .every((application) => isObject(application.analysis));
}

// Why a report can't be posted, or null.
function unreadableReason(report) {
  if (!isObject(report) || !Array.isArray(report.applications)) {
    return 'no applications list';
  }
  if (typeof report.markdown !== 'string' || firstLine(report.markdown) !== MARKER) {
    return `markdown that doesn't start with ${MARKER}`;
  }
  return dataSession(report.markdown) ? null : 'markdown with no data line naming its session';
}

class CommentFailure extends Error {
  constructor(message, {forbidden = false} = {}) {
    super(message);
    this.forbidden = forbidden;
  }
}

async function readReport({apiUrl, apiKey, request, fetchImpl}) {
  try {
    const response = await fetchImpl(`${apiUrl}${REPORT_PATH}`, {
      method: 'POST',
      headers: {authorization: basicAuthorization(apiKey), 'content-type': 'application/json', accept: 'application/json'},
      body: JSON.stringify(request),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const raw = await response.text();
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    return {status: response.status, body};
  } catch (error) {
    return {status: 0, body: null, error: String(error?.message ?? error)};
  }
}

const describeAnswer = ({status, body, error}) =>
  `${status ? `HTTP ${status}` : 'no answer'}${typeof body?.error_code === 'string' ? ` ${body.error_code}` : ''}${(error ?? body?.message) ? `: ${error ?? body.message}` : ''}`;

// Creates or updates the oldest comment this token wrote on the pull request whose first line is the
// marker and whose data line names `report`'s session. With `reread`, the report is read again just
// before the write, and the newer one is written when it names the same session; if that read fails
// or names another session, it throws and writes nothing. Returns what it did and the report the
// comment now shows.
async function upsertComment({env, number, report, fetchImpl, reread}) {
  const githubApiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const graphqlUrl = env.GITHUB_GRAPHQL_URL || `${githubApiUrl}/graphql`;
  const [owner, name] = String(env.GITHUB_REPOSITORY ?? '').split('/');
  const graphql = async (query, variables) => {
    let response;
    try {
      response = await fetchImpl(graphqlUrl, {
        method: 'POST',
        headers: {Authorization: `Bearer ${String(env.GH_TOKEN ?? '').trim()}`, 'Content-Type': 'application/json', 'User-Agent': 'mabl-change-validation-action'},
        body: JSON.stringify({query, variables}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new CommentFailure(`no answer: ${error?.message ?? error}`);
    }
    if (!response.ok) {
      throw new CommentFailure(`HTTP ${response.status}`, {forbidden: response.status === 401 || response.status === 403});
    }
    const answer = await response.json().catch(() => null);
    // A token that can't write answers 200 with a FORBIDDEN error.
    const [error] = Array.isArray(answer?.errors) ? answer.errors : [];
    if (error) {
      throw new CommentFailure(`${error?.type ?? 'error'}: ${error?.message ?? ''}`, {forbidden: error?.type === 'FORBIDDEN'});
    }
    return answer?.data ?? {};
  };

  const session = dataSession(report.markdown);
  let after = null;
  let subject = null;
  let oldest = null;
  for (let page = 0; page < MAX_COMMENT_PAGES && !oldest; page += 1) {
    const data = await graphql(FIND_QUERY, {owner, name, number, after});
    const viewer = data?.viewer?.login;
    const pull = data?.repository?.pullRequest;
    if (typeof viewer !== 'string' || viewer === '' || !pull) {
      throw new CommentFailure(`GitHub named no ${pull ? 'login for the token' : `pull request #${number}`}`);
    }
    subject = pull.id;
    // GraphQL names a bot author without the [bot] its viewer login has.
    const own = (author) =>
      isObject(author) && typeof author.login === 'string' && (author.login === viewer || (author.__typename === 'Bot' && `${author.login}[bot]` === viewer));
    const nodes = Array.isArray(pull.comments?.nodes) ? pull.comments.nodes : [];
    oldest = nodes.find(
      (node) => isObject(node) && own(node.author) && typeof node.body === 'string' && firstLine(node.body) === MARKER && dataSession(node.body) === session,
    );
    if (pull.comments?.pageInfo?.hasNextPage !== true || nodes.length < COMMENTS_PER_PAGE) {
      break;
    }
    after = pull.comments.pageInfo.endCursor;
  }
  let latestReport = report;
  // Nothing is written when the comment already shows this report, so there is nothing to read again for.
  if (reread && !(oldest && sameBody(oldest.body, report.markdown))) {
    const rereadReport = await reread();
    // An older report must not replace what a sending run may have just written, so a read that
    // fails or names another session writes nothing and leaves the next poll to start again.
    if (!rereadReport) {
      throw new CommentFailure("mabl's report couldn't be read again before the write");
    }
    if (dataSession(rereadReport.markdown) !== session) {
      throw new CommentFailure("mabl's report moved to another session before the write");
    }
    latestReport = rereadReport;
  }
  const markdown = latestReport.markdown;
  if (!oldest) {
    await graphql(CREATE_MUTATION, {subject, body: markdown});
    return {effect: 'created', latestReport};
  }
  if (sameBody(oldest.body, markdown)) {
    return {effect: 'unchanged', latestReport};
  }
  await graphql(UPDATE_MUTATION, {id: oldest.id, body: markdown});
  return {effect: 'updated', latestReport};
}

export async function main({env = process.env, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, print = (line) => process.stdout.write(`${line}\n`)} = {}) {
  const redact = redactor(env);
  const log = (line) => print(redact(escapeInvisible(line)));
  const warn = (message) => print(annotation('warning', shorten(redact(escapeInvisible(message)), MAX_ANNOTATION_CHARS), {title: TITLE}));
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8'));
  } catch {
    payload = null;
  }
  const plan = commentPlan({env, payload});
  const apiUrl = apiUrlOf(env);
  if (!plan || !apiUrl) {
    return;
  }
  const number = Number(env.PULL_REQUEST_NUMBER);
  const commentLabel = `pull request #${number}'s comment`;
  const apiKey = env.MABL_API_KEY ?? '';
  const workspaceId = String(env.MABL_WORKSPACE_ID ?? '').trim();
  if (!workspaceId) {
    log(`${commentLabel}: not posted, workspace-id is empty`);
    return;
  }
  const serverUrl = env.GITHUB_SERVER_URL || 'https://github.com';
  const request = {
    workspace_id: workspaceId,
    reference: {type: 'pull_request', id: `${repositoryIdOf(serverUrl, env.GITHUB_REPOSITORY ?? '')}#${number}`},
    trusted_providers: 'caller',
    format: 'markdown',
  };
  const minutesText = String(env.COMMENT_WAIT_MINUTES ?? '').trim();
  const minutes = /^[0-9]+$/.test(minutesText) ? Number(minutesText) : DEFAULT_WAIT_MINUTES;
  const deadline = now() + minutes * MINUTE_MS;
  // A merged pull request's comment is read and posted again after one interval: a merge queue run that
  // read the report before the merge may post after this run's first write, and a single read may fail.
  const maxReads = {once: 1, merged: 2}[plan] ?? Infinity;
  for (let reads = 1; ; reads += 1) {
    const answer = await readReport({apiUrl, apiKey, request, fetchImpl});
    const ok = answer.status >= 200 && answer.status < 300;
    const reason = ok ? unreadableReason(answer.body) : null;
    // Expected before the pull request's first stage request, so a log line, not a warning.
    if (sendsNothing(env) && answer.status === 404 && answer.body?.error_code === NO_CHANGE_AGENT) {
      log(`${commentLabel}: not posted, mabl has no report for it yet`);
      return;
    }
    if (answer.status >= 400 && answer.status < 500 && answer.status !== 429) {
      warn(`${commentLabel} not posted: mabl's report read answered ${describeAnswer(answer)}`);
      return;
    }
    if (ok && !reason) {
      let posted = false;
      let latestReport = answer.body;
      try {
        // Without a request of its own, this run can hold an older report than a sending run just wrote.
        const reread = sendsNothing(env)
          ? async () => {
              const secondRead = await readReport({apiUrl, apiKey, request, fetchImpl});
              return secondRead.status >= 200 && secondRead.status < 300 && !unreadableReason(secondRead.body) ? secondRead.body : null;
            }
          : undefined;
        const upserted = await upsertComment({env, number, report: answer.body, fetchImpl, reread});
        latestReport = upserted.latestReport;
        log(`${commentLabel}: ${upserted.effect}`);
        posted = true;
      } catch (error) {
        if (error.forbidden) {
          warn(`${commentLabel} not posted: the token can't comment (${error.message}); it needs pull-requests: write`);
          return;
        }
        log(`${commentLabel}: not posted this time (${error.message})`);
      }
      if (plan === 'wait' && posted && analysesFinished(latestReport)) {
        return;
      }
    } else {
      log(`${commentLabel}: skipped a read, mabl answered ${ok ? reason : describeAnswer(answer)}`);
    }
    if (reads >= maxReads || (plan === 'wait' && now() >= deadline)) {
      log(`${commentLabel}: stopped`);
      return;
    }
    await sleep(plan === 'wait' ? Math.min(POLL_INTERVAL_MS, deadline - now()) : POLL_INTERVAL_MS);
  }
}
