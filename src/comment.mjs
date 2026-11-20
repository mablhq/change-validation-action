// The pull request comment: after the stage request, keeps the pull request's comment on mabl's change
// validation report, posting the markdown mabl renders. It never fails the run. The README says when
// it posts.

import {readFileSync} from 'node:fs';

import {escapeInvisible} from './lib/policy-read.mjs';
import {apiUrlOf, basicAuthorization} from './lib/mabl-api.mjs';
import {MAX_ANNOTATION_CHARS, MINUTE_MS, TITLE, isObject, redactor, repositoryIdOf} from './lib/shared.mjs';
import {annotation, shorten} from './lib/workflow-commands.mjs';

export const REPORT_PATH = '/changeValidation/report';
// The first line of every comment mabl renders, and how its second line opens.
export const MARKER = '<!-- mabl-change-validation -->';
const DATA_PREFIX = '<!-- mabl-change-validation-data ';
const DATA_SUFFIX = ' -->';
export const POLL_INTERVAL_MS = 20_000;
const DEFAULT_WAIT_MINUTES = 15;
const REQUEST_TIMEOUT_MS = 30_000;
const COMMENTS_PER_PAGE = 100;
const MAX_COMMENT_PAGES = 30;
const TAKEN = new Set(['accepted', 'duplicate']);

const firstLine = (text) => String(text).split(/\r?\n/, 1)[0];
const sameBody = (a, b) => String(a).replace(/\r\n/g, '\n').trimEnd() === String(b).replace(/\r\n/g, '\n').trimEnd();

const FIND_QUERY =
  'query($owner: String!, $name: String!, $number: Int!, $after: String) { viewer { login } repository(owner: $owner, name: $name) { pullRequest(number: $number) { id comments(first: 100, after: $after) { nodes { id body author { __typename login } } pageInfo { hasNextPage endCursor } } } } }';
const CREATE_MUTATION = 'mutation($subject: ID!, $body: String!) { addComment(input: {subjectId: $subject, body: $body}) { commentEdge { node { id } } } }';
const UPDATE_MUTATION = 'mutation($id: ID!, $body: String!) { updateIssueComment(input: {id: $id, body: $body}) { issueComment { id } } }';

// `wait` on a pull request's own stage request mabl took, `once` after a merged event mabl took or an
// awaited merge queue entry's status was published, otherwise null.
export function commentPlan({env, payload}) {
  if (String(env.CHANGE_VALIDATION_COMMENT ?? '').trim().toLowerCase() !== 'true' || !/^[1-9][0-9]*$/.test(String(env.PULL_REQUEST_NUMBER ?? ''))) {
    return null;
  }
  const eventName = env.GITHUB_EVENT_NAME;
  if (env.CHANGE_VALIDATION_AWAIT === 'true') {
    return eventName === 'merge_group' && String(env.CHANGE_VALIDATION_STATUS ?? '') !== '' ? 'once' : null;
  }
  if (eventName !== 'pull_request' || !TAKEN.has(env.CHANGE_VALIDATION_OUTCOME)) {
    return null;
  }
  return payload?.action === 'closed' ? 'once' : 'wait';
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
// marker and whose data line names `markdown`'s session; says which it did.
async function upsertComment({env, number, markdown, fetchImpl}) {
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

  const session = dataSession(markdown);
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
  if (!oldest) {
    await graphql(CREATE_MUTATION, {subject, body: markdown});
    return 'created';
  }
  if (sameBody(oldest.body, markdown)) {
    return 'unchanged';
  }
  await graphql(UPDATE_MUTATION, {id: oldest.id, body: markdown});
  return 'updated';
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
  for (;;) {
    const answer = await readReport({apiUrl, apiKey, request, fetchImpl});
    const ok = answer.status >= 200 && answer.status < 300;
    const reason = ok ? unreadableReason(answer.body) : null;
    if (answer.status >= 400 && answer.status < 500 && answer.status !== 429) {
      warn(`${commentLabel} not posted: mabl's report read answered ${describeAnswer(answer)}`);
      return;
    }
    if (ok && !reason) {
      let posted = false;
      try {
        log(`${commentLabel}: ${await upsertComment({env, number, markdown: answer.body.markdown, fetchImpl})}`);
        posted = true;
      } catch (error) {
        if (error.forbidden) {
          warn(`${commentLabel} not posted: the token can't comment (${error.message}); it needs pull-requests: write`);
          return;
        }
        log(`${commentLabel}: not posted this time (${error.message})`);
      }
      if (plan === 'once' || (posted && analysesFinished(answer.body))) {
        return;
      }
    } else {
      log(`${commentLabel}: skipped a read, mabl answered ${ok ? reason : describeAnswer(answer)}`);
    }
    if (plan === 'once' || now() >= deadline) {
      log(`${commentLabel}: stopped`);
      return;
    }
    await sleep(Math.min(POLL_INTERVAL_MS, deadline - now()));
  }
}
