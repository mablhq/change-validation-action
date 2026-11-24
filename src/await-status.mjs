// Await mode, for merge queue entries and revisions: after a stage request is accepted, poll mabl's
// status of that stage at the queue commit or the revision and publish it as a commit status.

import {readFileSync} from 'node:fs';

import {escapeInvisible} from './lib/policy-read.mjs';
import {basicAuthorization, oneLine} from './lib/mabl-api.mjs';
import {commentCommand} from './command.mjs';
import {COMMIT_SHA, MAX_ANNOTATION_CHARS, MINUTE_MS, TITLE, isObject, redactor} from './lib/shared.mjs';
import {annotation, shorten} from './lib/workflow-commands.mjs';
import {REVISION_EVENTS, revisionHead} from './revision.mjs';

export const STATUS_PATH = '/changeValidation/status';
export const POLL_INTERVAL_MS = 20_000;
// Between failed status reads; the last repeats until the deadline.
export const READ_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
export const PUBLISH_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];
export const DEFAULT_DEADLINE_MINUTES = 40;
const MAX_DEADLINE_MINUTES = 120;
// Past the action's own start + deadline-minutes, so it publishes inside a job timeout 5 above them.
export const INVOCATION_SLACK_MINUTES = 3;
// Publishing must finish this long after the overall budget runs out...
export const PUBLISH_GRACE_MS = 90_000;
// ...and the last part of that is kept for the conclusion, which a pending publish can't use.
export const CONCLUSION_RESERVE_MS = 60_000;
// GitHub's limit on a commit status description is 140.
export const MAX_DESCRIPTION_CHARS = 139;
const READ_TIMEOUT_MS = 30_000;
const GITHUB_TIMEOUT_MS = 30_000;
// Answers from the events route after which the stage is polled; `superseded` publishes nothing.
const POLLED = new Set(['accepted', 'duplicate']);
const NOT_JUDGED = {
  feature_disabled: 'mabl change validation is off for this workspace, so nothing was judged',
  change_agent_closed: "this change's mabl agent is closed, so nothing was judged",
  no_change_agent: 'this change has no mabl agent, so nothing was judged',
};
// The api's gate for a stage, as this action concludes it.
const VERDICTS = {ready: 'pass', fail: 'fail', wait: 'wait'};
// On a failed gate, the must_pass check whose summary and link explain it, by these statuses in order.
const DECIDING = ['failed', 'dry_run', 'cant_tell'];

const retryable = (status) => status === 0 || status === 429 || status >= 500;
const isUrl = (value) => typeof value === 'string' && /^https?:\/\/\S+$/.test(value);
const reasonOf = (item) => (typeof item?.reason === 'string' && item.reason !== '' ? item.reason : undefined);
const lead = (head, tail) => (head && tail ? `${head}: ${tail}` : head || tail);
const text = (value) => (typeof value === 'string' ? oneLine(value) : '');

// The gate's view of `stage` in a status answer: {verdict: pass | fail | wait | unreadable,
// description, link}, plus `waitingOn` for the deadline's message and `headReplaced` when a newer
// request replaced the head. The api decides it as the stage's `gate`; the checks only pick the
// description and link. `unreadable` is retried like an answer that isn't JSON.
export function gateView(answer, stage) {
  const malformed = (what) => ({verdict: 'unreadable', description: `mabl's status answer was malformed: ${what}`});
  if (!isObject(answer) || !Array.isArray(answer.stages)) {
    return malformed('no stages list');
  }
  if (!answer.stages.every(isObject)) {
    return malformed('a stage that is not an object');
  }
  const entry = answer.stages.find((item) => item.stage === stage);
  if (!entry) {
    return {verdict: 'fail', description: `mabl's status lists no ${stage} stage`};
  }
  const verdict = typeof entry.gate === 'string' && Object.hasOwn(VERDICTS, entry.gate) ? VERDICTS[entry.gate] : undefined;
  if (!verdict) {
    return malformed(`the ${stage} stage's gate is ${JSON.stringify(entry.gate) ?? 'missing'}`);
  }
  const checks = (Array.isArray(entry.checks) ? entry.checks : []).filter(isObject);
  const linkOf = (check) => (isObject(check?.links) ? [check.links.deployment_event, check.links.analysis].find(isUrl) : undefined);
  const deciding =
    verdict === 'fail' ? DECIDING.map((status) => checks.find((check) => check.must_pass === true && check.status === status)).find(Boolean) : undefined;
  const reason = reasonOf(entry);
  const description =
    text(entry.summary) ||
    text(answer.summary) ||
    text(deciding?.summary) ||
    (reason ? `${stage} can't be judged (${reason})` : `${stage}: gate ${entry.gate}`);
  const view = {verdict, description, link: linkOf(deciding) ?? checks.map(linkOf).find(Boolean)};
  // Nothing must pass, so the gate passes before anything runs.
  if (verdict === 'pass' && !checks.some((check) => check.must_pass === true)) {
    view.vacuous = true;
  }
  if (entry.head_replaced === true) {
    view.headReplaced = true;
  }
  // A must_pass check with nothing dispatched says why in its own summary, which the stage's leaves out.
  const undispatched = verdict === 'wait' ? text(checks.find((check) => check.must_pass === true && check.status === 'waiting')?.summary) : '';
  return undispatched ? {...view, waitingOn: undispatched} : view;
}

// The overall budget, set before anything is sent: the action's start + `minutes` + 3. Preparing,
// sending and polling all stop by it. The queue commit's timestamp can't bound it: a rebuilt entry
// keeps an earlier commit's timestamp, while GitHub's 60 minutes restart with each rebuild.
export function budgetAt({invokedAt, minutes}) {
  return invokedAt + (minutes + INVOCATION_SLACK_MINUTES) * MINUTE_MS;
}

async function readStatus({apiUrl, apiKey, request, fetchImpl, signal}) {
  try {
    const response = await fetchImpl(`${apiUrl}${STATUS_PATH}`, {
      method: 'POST',
      headers: {authorization: basicAuthorization(apiKey), 'content-type': 'application/json', accept: 'application/json'},
      body: JSON.stringify(request),
      redirect: 'error',
      signal,
    });
    const raw = await response.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
    return {status: response.status, body: json, errorCode: typeof json?.error_code === 'string' ? oneLine(json.error_code) : ''};
  } catch (error) {
    return {status: 0, body: null, errorCode: '', error: String(error?.message ?? error)};
  }
}

function describeAnswer(answer) {
  const detail = answer.error ?? (typeof answer.body?.message === 'string' ? answer.body.message : '');
  return `${answer.status ? `HTTP ${answer.status}` : 'no answer'}${answer.errorCode ? ` ${answer.errorCode}` : ''}${detail ? `: ${detail}` : ''}`;
}

async function postStatus({github, sha, state, context, description, targetUrl, fetchImpl, signal}) {
  try {
    const response = await fetchImpl(`${github.apiUrl}/repos/${github.repository}/statuses/${sha}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${String(github.token).trim()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'mabl-change-validation-action',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({state, context, description, ...(targetUrl ? {target_url: targetUrl} : {})}),
      signal,
    });
    return {status: response.status};
  } catch (error) {
    return {status: 0, error: String(error?.message ?? error)};
  }
}

// Where await mode publishes: the status context, the commit, and how to reach GitHub. `target` is
// null when the event names no commit.
function statusTarget(env) {
  const eventName = env.GITHUB_EVENT_NAME;
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8'));
  } catch {
    payload = null;
  }
  let head = String(payload?.merge_group?.head_sha ?? '');
  if (REVISION_EVENTS.has(eventName)) {
    try {
      head = revisionHead({eventName, payload, env});
    } catch {
      head = '';
    }
  }
  const normalizedHead = head.toLowerCase();
  const github = {
    apiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
    repository: env.GITHUB_REPOSITORY ?? '',
    token: env.GH_TOKEN ?? '',
  };
  const serverUrl = (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  return {
    payload,
    context: oneLine(env.STATUS_CONTEXT),
    target: COMMIT_SHA.test(normalizedHead) ? normalizedHead : null,
    github,
    runUrl: env.GITHUB_RUN_ID ? `${serverUrl}/${github.repository}/actions/runs/${env.GITHUB_RUN_ID}` : undefined,
  };
}

// Ends an awaited run that never got to a conclusion, on an input it can't use or an error nobody
// expected, by publishing `error` when it can, in one attempt. A required context then doesn't stay
// pending, and an earlier status for the same commit doesn't stand in for this run's.
export async function endWithErrorStatus({env, fetchImpl, signalAfter, print}, message) {
  const redact = redactor(env);
  print(annotation('error', shorten(escapeInvisible(redact(message)), MAX_ANNOTATION_CHARS), {title: TITLE}));
  const {context, target, github, runUrl} = statusTarget(env);
  let status = '';
  if (context && target) {
    const description = shorten(oneLine(redact(message)), MAX_DESCRIPTION_CHARS);
    const signal = signalAfter(GITHUB_TIMEOUT_MS, 'publish');
    const answer = await postStatus({github, sha: target, state: 'error', context, description, targetUrl: runUrl, fetchImpl, signal});
    print(`${context}: error (${answer.status || 'no answer'}): ${description}`);
    status = answer.status >= 200 && answer.status < 300 ? 'error' : '';
  }
  return {exitCode: 1, outputs: {outcome: 'failed', 'session-id': '', created: '', agent: '', 'description-source': '', status}};
}

export async function awaitStage({env, fetchImpl, sleep, now, signalAfter, invokedAt, print, apiUrl, sendStage, queuedPullRequestHead}) {
  const apiKey = env.MABL_API_KEY ?? '';
  const redact = redactor(env);
  const report = (level, message) =>
    print(annotation(level, shorten(escapeInvisible(redact(message)), MAX_ANNOTATION_CHARS), {title: TITLE}));
  const eventName = env.GITHUB_EVENT_NAME;
  const {payload, context, target, github, runUrl} = statusTarget(env);
  // Neither a comment's request nor a comment that isn't for mabl is awaited, so they need none of the await inputs.
  const command = eventName === 'issue_comment' ? commentCommand({env, payload}) : '';
  const notForMabl = command === null;
  if (command !== '') {
    if (!notForMabl) {
      report('notice', "await doesn't apply to a comment's request, which is sent without waiting");
    }
    const {exitCode, outputs} = await sendStage({env, fetchImpl, sleep, now, print});
    return {exitCode, outputs: {...outputs, status: ''}};
  }
  const isRevision = REVISION_EVENTS.has(eventName);
  const stage = String(env.CHANGE_VALIDATION_STAGE ?? '').trim();
  const minutesText = String(env.DEADLINE_MINUTES ?? '').trim() || String(DEFAULT_DEADLINE_MINUTES);
  const minutes = /^[0-9]+$/.test(minutesText) ? Number(minutesText) : NaN;
  const failed = (message) => endWithErrorStatus({env, fetchImpl, signalAfter, print}, message);
  if (eventName !== 'merge_group' && !isRevision) {
    return failed(`await mode runs on merge_group events and revisions (${[...REVISION_EVENTS].join(', ')}), not ${eventName || 'none'}`);
  }
  if (!context) {
    return failed('status-context is required with await: the commit status context to publish');
  }
  if (!(minutes >= 1 && minutes <= MAX_DEADLINE_MINUTES)) {
    return failed(`deadline-minutes has to be a whole number from 1 to ${MAX_DEADLINE_MINUTES}, got ${minutesText}`);
  }

  const where = isRevision ? 'the revision' : 'the merge group';
  const overall = budgetAt({invokedAt, minutes});
  const finishBy = overall + PUBLISH_GRACE_MS;
  // Every request while preparing and sending is cut off at the overall budget.
  const overallSignal = signalAfter(Math.max(0, overall - now()), 'overall');
  const budgeted = (url, init = {}) => fetchImpl(url, {...init, signal: init.signal ? AbortSignal.any([init.signal, overallSignal]) : overallSignal});
  const clean = (value) => shorten(oneLine(redact(value)), MAX_DESCRIPTION_CHARS);

  // Posts one commit status, retrying 429, 5xx and no answer, and done by `by`; null when it landed,
  // else why not.
  const publish = async (state, shown, link, by) => {
    for (let attempt = 0; ; attempt += 1) {
      const left = by - now();
      if (left <= 0) {
        return 'no time left to publish';
      }
      const signal = signalAfter(Math.min(GITHUB_TIMEOUT_MS, left), 'publish');
      const answer = await postStatus({github, sha: target, state, context, description: shown, targetUrl: link ?? runUrl, fetchImpl, signal});
      print(`${context}: ${state} (${answer.status || 'no answer'}): ${shown}`);
      if (answer.status >= 200 && answer.status < 300) {
        return null;
      }
      const why = answer.status ? `HTTP ${answer.status}` : `no answer: ${answer.error}`;
      if (!retryable(answer.status) || attempt >= PUBLISH_RETRY_DELAYS_MS.length || now() + PUBLISH_RETRY_DELAYS_MS[attempt] >= by) {
        return why;
      }
      await sleep(PUBLISH_RETRY_DELAYS_MS[attempt]);
    }
  };
  let lastPending = null;
  // Null once pending shows `description`; otherwise why it couldn't be published, so the wait stops
  // rather than leave an earlier conclusion showing on this head.
  const pending = async (description, link) => {
    const shown = clean(description);
    if (shown === lastPending) {
      return null;
    }
    const failed = await publish('pending', shown, link, finishBy - CONCLUSION_RESERVE_MS);
    if (failed) {
      return `couldn't publish ${context} pending (${failed})`;
    }
    lastPending = shown;
    return null;
  };
  const conclude = async (sent, state, description, link) => {
    const outputs = {...sent.outputs, status: ''};
    if (!target) {
      report('error', `${context} not published, since ${where} names no commit: ${description}`);
      return {exitCode: 1, outputs};
    }
    const shown = clean(description);
    const failed = await publish(state, shown, link, finishBy);
    if (failed) {
      report('error', `publishing ${context} ${state} answered ${failed}`);
      return {exitCode: 1, outputs};
    }
    report(state === 'success' ? 'notice' : 'error', `${context} ${state}: ${shown}`);
    return {exitCode: state === 'success' ? 0 : 1, outputs: {...outputs, status: state}};
  };

  // The polling deadline: the stage request + `minutes`, timed from just before its first attempt so
  // its retries count, and never past the overall budget.
  let sentAt = NaN;
  let deadline = overall;
  const sent = await sendStage({
    env,
    fetchImpl: budgeted,
    sleep,
    now,
    print,
    onSending: async () => {
      sentAt = now();
      deadline = Math.min(sentAt + minutes * MINUTE_MS, overall);
      return {deadline, now, signalAfter};
    },
  });
  const {outcome} = sent.outputs;
  // A revision event that isn't a deploy finishing, such as a queued deployment_status, judges nothing.
  if (isRevision && outcome === 'skipped') {
    return {exitCode: 0, outputs: {...sent.outputs, status: ''}};
  }
  // A newer request owns this head's status; publishing here could overwrite its conclusion. A
  // revision's newer request is for this same commit, so its run is the one to wait for.
  if (outcome === 'superseded' && !isRevision) {
    report('notice', `${context} not published: mabl already has a newer ${stage} request, whose run owns this head's status`);
    return {exitCode: 0, outputs: {...sent.outputs, status: ''}};
  }
  // The queue dropped this commit, so nothing will merge on its status.
  const entryGone = () => {
    report('notice', `${context} not published: the merge queue no longer has this commit`);
    return {exitCode: 0, outputs: {...sent.outputs, outcome: 'entry_gone', status: ''}};
  };
  if (outcome === 'entry_gone') {
    return entryGone();
  }
  // A rebuild's request replaced this head. Stay quiet only when the queue dropped this commit;
  // otherwise, or when that can't be read, the failure stands.
  const droppedFromQueue = async () => {
    try {
      const number = Number(sent.outputs['pull-request-number']);
      if (!Number.isInteger(number) || number < 1) {
        throw new Error('the stage request named no pull request');
      }
      const graphqlUrl = env.GITHUB_GRAPHQL_URL || `${github.apiUrl}/graphql`;
      return (await queuedPullRequestHead({graphqlUrl, repository: github.repository, number, queueSha: target, token: github.token, fetchImpl})) === null;
    } catch (error) {
      report('warning', `couldn't read the merge queue entry after its head was replaced: ${error?.message ?? error}`);
      return false;
    }
  };
  if (!POLLED.has(outcome) && outcome !== 'superseded') {
    const late = outcome === 'timed_out' || now() >= overall;
    const why = !late
      ? NOT_JUDGED[outcome] ?? lead('stage request', sent.detail || outcome)
      : Number.isFinite(sentAt)
        ? `timed out before the ${stage} request went out`
        : `timed out preparing the ${stage} request`;
    return conclude(sent, 'failure', why);
  }

  const {body} = sent;
  const unpublished = await pending(`waiting for ${stage}`);
  if (unpublished) {
    return conclude(sent, 'failure', unpublished);
  }
  const request = {
    workspace_id: body.workspace_id,
    reference: {type: body.reference.type, id: body.reference.id},
    stages: [{stage, head_sha: body.event.head_sha}],
    trusted_providers: 'caller',
  };
  print(`waiting for ${stage} at ${body.event.head_sha} until ${new Date(deadline).toISOString()}`);
  let failures = 0;
  let lastWait = null;
  let lastError = null;
  const timedOut = () => {
    const waited = Math.max(0, Math.round((deadline - sentAt) / MINUTE_MS));
    return conclude(sent, 'failure', lead(`timed out after ${waited} min`, lastError ?? lastWait?.waitingOn ?? lastWait?.description ?? ''), lastWait?.link);
  };
  for (;;) {
    const budget = deadline - now();
    if (budget <= 0) {
      return timedOut();
    }
    const answer = await readStatus({apiUrl, apiKey, request, fetchImpl, signal: signalAfter(Math.min(READ_TIMEOUT_MS, budget), 'read')});
    // Whatever arrives after the deadline is too late to count.
    if (now() > deadline) {
      return timedOut();
    }
    print(redact(`POST ${STATUS_PATH}: ${answer.status || 'no answer'}${answer.errorCode ? ` ${answer.errorCode}` : ''}`));
    let delay = POLL_INTERVAL_MS;
    const ok = answer.status >= 200 && answer.status < 300;
    const view = ok && answer.body && typeof answer.body === 'object' ? gateView(answer.body, stage) : null;
    if (view && view.verdict !== 'unreadable') {
      failures = 0;
      lastError = null;
      if (view.vacuous) {
        report('notice', `${stage} has no must_pass check, so it passes without waiting for anything to run; give it one to make it a gate`);
      }
      if (view.verdict !== 'wait') {
        if (view.headReplaced && !isRevision && target && (await droppedFromQueue())) {
          return entryGone();
        }
        return conclude(sent, view.verdict === 'pass' ? 'success' : 'failure', view.description, view.link);
      }
      lastWait = view;
      const stuck = await pending(view.description, view.link);
      if (stuck) {
        return conclude(sent, 'failure', stuck, view.link);
      }
    } else if (ok || retryable(answer.status)) {
      lastError = view?.description ?? `mabl's status read kept failing (${ok ? `HTTP ${answer.status} with an unreadable body` : describeAnswer(answer)})`;
      report('warning', `retrying until the deadline: ${lastError}`);
      delay = READ_RETRY_DELAYS_MS[Math.min(failures, READ_RETRY_DELAYS_MS.length - 1)];
      failures += 1;
    } else {
      return conclude(sent, 'failure', `mabl's status read answered ${describeAnswer(answer)}`);
    }
    await sleep(Math.max(0, Math.min(delay, deadline - now())));
  }
}
