import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it} from 'node:test';

import {EVENTS_PATH, RESOLVE_PATH, run} from '../src/stage-request.mjs';
import {DEFAULT_API_URL} from '../src/lib/mabl-api.mjs';
import {
  CONCLUSION_RESERVE_MS,
  MAX_DESCRIPTION_CHARS,
  POLL_INTERVAL_MS,
  PUBLISH_GRACE_MS,
  PUBLISH_RETRY_DELAYS_MS,
  READ_RETRY_DELAYS_MS,
  STATUS_PATH,
  budgetAt,
  gateView,
} from '../src/await-status.mjs';

const GITHUB_API = 'https://api.github.example.test';
const MABL = DEFAULT_API_URL;
const API_KEY = 'mabl-key-secret';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const QUEUE_HEAD = 'd'.repeat(40);
const QUEUE_PARENT = '1'.repeat(40);
const QUEUE_BASE = 'e'.repeat(40);
const QUEUED_AT = '2026-11-05T15:00:00Z';
// What a queue entry's paths are listed from.
const ENTRY_COMPARE = `/repos/Org/Repo/compare/${QUEUE_BASE}...${QUEUE_HEAD}`;
const UPDATED_AT = '2026-11-04T12:00:00Z';
const MINUTE = 60_000;
const CONTEXT = 'mabl-change-validation';
const EVENT_LINK = 'https://app.mabl.com/workspaces/w/events/e1-v';
const ANALYSIS_LINK = 'https://app.mabl.com/workspaces/w/analysis/a1-as';
const RUN_URL = 'https://github.com/Org/Repo/actions/runs/555';

const json = (status, body) => ({status, body: JSON.stringify(body)});
const ACCEPTED = json(201, {session_id: 's1-as', created: false, event: 'accepted', agent: 'working'});

const pullRequest = {
  number: 7,
  html_url: 'https://github.com/Org/Repo/pull/7',
  title: 'Add a thing',
  body: 'Why',
  updated_at: UPDATED_AT,
  head: {sha: HEAD, ref: 'feature/thing', repo: {id: 1}},
  base: {sha: BASE, ref: 'main', repo: {id: 1}},
  labels: [],
  changed_files: 1,
};
const mergeGroup = {
  action: 'checks_requested',
  merge_group: {
    head_sha: QUEUE_HEAD,
    head_ref: `refs/heads/gh-readonly-queue/main/pr-7-${'f'.repeat(40)}`,
    base_sha: QUEUE_BASE,
    head_commit: {id: QUEUE_HEAD, timestamp: QUEUED_AT},
  },
};
const prEvent = {action: 'synchronize', pull_request: {number: 7, head: {sha: HEAD}}};
// The trigger word alone would be a stage request at the PR's head.
const triggerComment = {action: 'created', issue: {number: 7, pull_request: {}}, comment: {author_association: 'MEMBER', user: {login: 'dev'}}};

const check = (overrides = {}) => ({
  id: 'merge_queue/web/impacted',
  application: 'web',
  kind: 'impacted',
  must_pass: true,
  status: 'passed',
  summary: 'impacted passed',
  links: {deployment_event: EVENT_LINK, analysis: ANALYSIS_LINK},
  ...overrides,
});
const smoke = (overrides = {}) => check({id: 'merge_queue/web/suite/smoke', kind: 'suite', suite: 'smoke', summary: 'smoke passed', links: {}, ...overrides});
const statusOf = ({gate = 'ready', stage = {}, checks = [check(), smoke()], summary = 'merge_queue: smoke passed, impacted passed'} = {}) => ({
  status: 'complete',
  summary,
  session_id: 's1-as',
  stages: [{stage: 'merge_queue', gate, summary, head_sha: QUEUE_HEAD, requested_head_sha: QUEUE_HEAD, head_replaced: false, outdated: false, checks, ...stage}],
});

// GitHub and mabl, with a fake clock: sleeping and each answer's `takesMs` (or `slow[path]`) move it,
// and the timeouts `signalAfter` hands out abort when it passes them. A request whose signal aborts
// throws as fetch does, unless its answer `ignoresAbort`; `stuck[path]` hangs that long whatever
// its signal says. `statuses` answers each status read in
// order, the last repeating; `published` answers each commit status post the same way.
function stub({events = [ACCEPTED], statuses = [json(200, statusOf())], published = [{status: 201}], graphql, slow = {}, stuck = {}, clockStart}) {
  const calls = [];
  // The timeout each events attempt and status read was given, in order; then each publish attempt's.
  const timeouts = [];
  const publishTimeouts = [];
  const timers = [];
  let clock = clockStart;
  const advanceTo = (at) => {
    clock = Math.max(clock, at);
    for (const timer of timers) {
      if (timer.at <= clock && !timer.controller.signal.aborted) {
        timer.controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      }
    }
  };
  // Moves the clock `ms` on, stopping early when `signal` aborts; false when it did.
  const pass = (ms, signal) => {
    const end = clock + ms;
    for (const at of timers.map((timer) => timer.at).filter((at) => at > clock && at <= end).sort((a, b) => a - b)) {
      advanceTo(at);
      if (signal?.aborted) {
        return false;
      }
    }
    advanceTo(end);
    return !signal?.aborted;
  };
  const eventAnswers = [...events];
  const statusAnswers = [...statuses];
  const publishAnswers = [...published];
  const next = (list) => (list.length > 1 ? list.shift() : list[0]);
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({url: parsed, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body, at: clock});
    const aborted = () => init.signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
    if (init.signal?.aborted) {
      throw aborted();
    }
    let answer;
    const path = parsed.pathname;
    if (parsed.origin === GITHUB_API && path === '/repos/Org/Repo/pulls/7') {
      answer = json(200, pullRequest);
    } else if (parsed.origin === GITHUB_API && path === '/repos/Org/Repo/pulls/7/files') {
      answer = json(200, parsed.searchParams.get('page') === '1' ? [{filename: 'frontend/a.ts'}] : []);
    } else if (parsed.origin === GITHUB_API && path === ENTRY_COMPARE) {
      answer = json(200, {status: 'ahead', files: [{filename: 'frontend/a.ts'}]});
    } else if (parsed.origin === GITHUB_API && path.startsWith('/repos/Org/Repo/contents/')) {
      answer = {status: 200, body: 'version: 1\n', headers: {'content-type': 'application/vnd.github.raw'}};
    } else if (parsed.origin === GITHUB_API && path.startsWith('/repos/Org/Repo/git/commits/')) {
      answer = json(200, {sha: QUEUE_HEAD, parents: [{sha: QUEUE_PARENT}]});
    } else if (parsed.origin === GITHUB_API && path === '/graphql') {
      answer = graphql ?? json(200, {data: {repository: {pullRequest: {headRefOid: HEAD, mergeQueueEntry: {headCommit: {oid: QUEUE_HEAD}}}}}});
    } else if (parsed.origin === GITHUB_API && path === '/repos/Org/Repo/collaborators/dev/permission') {
      answer = json(200, {permission: 'write'});
    } else if (parsed.origin === GITHUB_API && path.startsWith('/repos/Org/Repo/statuses/')) {
      answer = next(publishAnswers);
    } else if (parsed.origin === MABL && path === RESOLVE_PATH) {
      answer = json(200, {valid: true, stages: {}});
    } else if (parsed.origin === MABL && path === EVENTS_PATH) {
      answer = eventAnswers.shift();
    } else if (parsed.origin === MABL && path === STATUS_PATH) {
      answer = next(statusAnswers);
    }
    if (answer === undefined) {
      throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
    }
    const ms = (answer.takesMs ?? 0) + (slow[path] ?? 0);
    if (!pass(ms, answer.ignoresAbort ? undefined : init.signal)) {
      throw aborted();
    }
    pass(stuck[path] ?? 0);
    if (answer.throws) {
      throw new Error(answer.throws);
    }
    return new Response(answer.body ?? '', {status: answer.status ?? 200, headers: answer.headers ?? {}});
  };
  const named = (path) => calls.filter((call) => call.url.pathname === path);
  return {
    fetchImpl,
    calls,
    now: () => clock,
    sleep: async (ms) => {
      advanceTo(clock + ms);
    },
    timeouts,
    publishTimeouts,
    signalAfter: (ms, label) => {
      if (!(ms >= 0)) {
        throw new RangeError(`AbortSignal.timeout takes no negative delay, got ${ms}`);
      }
      if (label === 'publish') {
        publishTimeouts.push(ms);
      } else if (label !== 'overall') {
        timeouts.push(ms);
      }
      const controller = new AbortController();
      timers.push({controller, at: clock + ms});
      advanceTo(clock);
      return controller.signal;
    },
    events: () => named(EVENTS_PATH),
    reads: () => named(STATUS_PATH),
    published: () =>
      calls
        .filter((call) => call.url.pathname.startsWith('/repos/Org/Repo/statuses/'))
        .map((call) => ({sha: call.url.pathname.split('/').pop(), at: call.at, ...JSON.parse(call.body)})),
  };
}

async function awaitWith(eventName, payload, stubbed, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'change-agent-await-'));
  const eventPath = join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify(payload));
  const lines = [];
  const result = await run({
    env: {
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: 'Org/Repo',
      GITHUB_API_URL: GITHUB_API,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_RUN_ID: '555',
      GITHUB_RUN_ATTEMPT: '1',
      GH_TOKEN: 'ghs_test',
      MABL_API_KEY: API_KEY,
      MABL_WORKSPACE_ID: 'ws-w',
      CHANGE_VALIDATION_STAGE: 'merge_queue',
      CHANGE_VALIDATION_AWAIT: 'true',
      STATUS_CONTEXT: CONTEXT,
      ...env,
    },
    fetchImpl: stubbed.fetchImpl,
    sleep: stubbed.sleep,
    now: stubbed.now,
    signalAfter: stubbed.signalAfter,
    print: (line) => lines.push(line),
  });
  return {...result, lines};
}

// A queue entry whose stage request goes out 8 minutes after it started, after the preview deploys.
const queueStub = (options = {}) => stub({clockStart: Date.parse(QUEUED_AT) + 8 * MINUTE, ...options});
const last = (list) => list[list.length - 1];

describe("the gate's view of a stage", () => {
  const view = (options) => gateView(statusOf(options), 'merge_queue');

  it("follows the api's gate: ready passes, fail fails, wait keeps polling", () => {
    assert.deepEqual(view({gate: 'ready'}), {verdict: 'pass', description: 'merge_queue: smoke passed, impacted passed', link: EVENT_LINK});
    assert.equal(view({gate: 'fail'}).verdict, 'fail');
    assert.equal(view({gate: 'wait'}).verdict, 'wait');
  });

  it('decides from the gate alone, whatever the checks say', () => {
    assert.equal(view({gate: 'ready', checks: [check({status: 'failed'})]}).verdict, 'pass');
    assert.equal(view({gate: 'fail', checks: [check(), smoke()]}).verdict, 'fail');
    assert.equal(view({gate: 'wait', checks: []}).verdict, 'wait');
    assert.equal(view({gate: 'fail', checks: [], stage: {status: 'cant_tell', reason: 'stage_out_of_scope'}}).verdict, 'fail');
  });

  for (const gate of [undefined, null, '', 'READY', 'pass', 'constructor', 7, {}]) {
    it(`reads a missing or unknown gate as malformed: ${JSON.stringify(gate)}`, () => {
      const answer = statusOf();
      answer.stages[0].gate = gate;
      if (gate === undefined) {
        delete answer.stages[0].gate;
      }
      const result = gateView(answer, 'merge_queue');
      assert.equal(result.verdict, 'unreadable');
      assert.match(result.description, /^mabl's status answer was malformed: the merge_queue stage's gate is /);
    });
  }

  it("describes the stage with its summary, and links the check that failed it", () => {
    const checks = [
      check({status: 'cant_tell', reason: 'over_budget', links: {deployment_event: 'https://app.mabl.com/impacted-v'}}),
      smoke({status: 'dry_run', links: {deployment_event: 'https://app.mabl.com/smoke-dry-v'}}),
      smoke({id: 'merge_queue/web/suite/regression', must_pass: false, status: 'failed', links: {deployment_event: 'https://app.mabl.com/advisory-v'}}),
      smoke({id: 'merge_queue/web/suite/sanity', status: 'failed', links: {deployment_event: 'https://app.mabl.com/sanity-v'}}),
    ];
    assert.deepEqual(view({gate: 'fail', checks, summary: 'merge_queue: sanity failed'}), {
      verdict: 'fail',
      description: 'merge_queue: sanity failed',
      link: 'https://app.mabl.com/sanity-v',
    });
    assert.equal(view({gate: 'fail', checks: checks.slice(0, 3)}).link, 'https://app.mabl.com/smoke-dry-v');
    assert.equal(view({gate: 'fail', checks: checks.slice(0, 1)}).link, 'https://app.mabl.com/impacted-v');
    // Off a failed gate, the first check that has a link.
    assert.equal(view({gate: 'wait', checks: [smoke({links: {}}), check()]}).link, EVENT_LINK);
  });

  it('falls back to the rollup summary, the deciding check, the stage reason, then the gate', () => {
    const bare = (stage, summary = '') => gateView({summary, stages: [{stage: 'merge_queue', checks: [], ...stage}]}, 'merge_queue').description;
    assert.equal(bare({gate: 'ready', summary: 'merge_queue: smoke passed'}, 'app#7: complete'), 'merge_queue: smoke passed');
    assert.equal(bare({gate: 'ready', summary: ''}, 'all good'), 'all good');
    assert.equal(bare({gate: 'fail', checks: [check({status: 'failed', summary: '1 of 4 tests failed'})]}), '1 of 4 tests failed');
    assert.equal(bare({gate: 'fail', status: 'cant_tell', reason: 'no_policy_file'}), "merge_queue can't be judged (no_policy_file)");
    assert.equal(bare({gate: 'fail', reasons: ['no_policy_file']}), 'merge_queue: gate fail');
  });

  it("names a must_pass check with nothing dispatched, for the deadline's message", () => {
    const advisory = smoke({must_pass: false, status: 'waiting', summary: 'smoke: waiting for dispatch'});
    const impacted = check({status: 'waiting', summary: 'impacted: waiting; the last dispatch queued nothing: no credits'});
    assert.equal(view({gate: 'wait', checks: [advisory, impacted]}).waitingOn, impacted.summary);
    assert.equal(view({gate: 'wait', checks: [advisory, check({status: 'running'})]}).waitingOn, undefined);
    assert.equal(view({gate: 'fail', checks: [impacted]}).waitingOn, undefined);
  });

  it('fails when the answer lists no such stage', () => {
    assert.equal(gateView({stages: [{stage: 'pull_request', gate: 'ready', checks: []}]}, 'merge_queue').verdict, 'fail');
  });

  it('reads an answer with no stages list, or a stage that is not an object, as malformed', () => {
    for (const [answer, why] of [
      [{}, 'no stages list'],
      [{stages: 'x'}, 'no stages list'],
      [{stages: [null]}, 'a stage that is not an object'],
    ]) {
      assert.deepEqual(gateView(answer, 'merge_queue'), {verdict: 'unreadable', description: `mabl's status answer was malformed: ${why}`});
    }
  });

  it('never throws on odd shapes', () => {
    const oddCheck = {must_pass: true, status: 'failed', links: 'x', summary: {}, id: {}, reason: ['x']};
    const odd = [
      null,
      'x',
      1,
      [],
      {stages: [[]]},
      {stages: [{stage: 'merge_queue', gate: 'fail', checks: {}}]},
      {stages: [{stage: 'merge_queue', gate: 'fail', checks: [null, 'x', oddCheck]}]},
      {stages: [{stage: 'merge_queue', gate: 'wait', summary: 3, reason: {}, checks: [{must_pass: true, status: 'cant_tell', links: [], reason: 1}]}]},
    ];
    for (const answer of odd) {
      assert.ok(['pass', 'fail', 'wait', 'unreadable'].includes(gateView(answer, 'merge_queue').verdict), JSON.stringify(answer));
    }
    assert.deepEqual(gateView({stages: [{stage: 'merge_queue', gate: 'fail', checks: [oddCheck]}]}, 'merge_queue'), {
      verdict: 'fail',
      description: 'merge_queue: gate fail',
      link: undefined,
    });
  });
});

describe('the overall budget', () => {
  it("is the action's start + the minutes + 3", () => {
    const start = Date.parse(QUEUED_AT);
    assert.equal(budgetAt({invokedAt: start, minutes: 40}), start + 43 * MINUTE);
    assert.equal(budgetAt({invokedAt: start, minutes: 1}), start + 4 * MINUTE);
  });
});

describe('await mode on a merge queue entry', () => {
  it('publishes pending once the request is accepted, polls the stage at the queue commit, then publishes success', async () => {
    const stubbed = queueStub({
      statuses: [
        json(200, statusOf({gate: 'wait', checks: [check({status: 'waiting'}), smoke({status: 'waiting'})], summary: 'merge_queue: waiting'})),
        json(200, statusOf({gate: 'wait', checks: [check({status: 'waiting'}), smoke({status: 'waiting'})], summary: 'merge_queue: waiting'})),
        json(200, statusOf({gate: 'wait', checks: [check({status: 'running'}), smoke()], summary: 'merge_queue: smoke passed, impacted running'})),
        json(200, statusOf()),
      ],
    });
    const {exitCode, outputs} = await awaitWith('merge_group', mergeGroup, stubbed);

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'accepted');
    assert.equal(outputs.status, 'success');
    const published = stubbed.published();
    assert.deepEqual(
      published.map(({state, description}) => [state, description]),
      [
        ['pending', 'waiting for merge_queue'],
        ['pending', 'merge_queue: waiting'],
        ['pending', 'merge_queue: smoke passed, impacted running'],
        ['success', 'merge_queue: smoke passed, impacted passed'],
      ],
    );
    assert.ok(published.every((status) => status.sha === QUEUE_HEAD && status.context === CONTEXT));
    assert.equal(published[0].target_url, RUN_URL);
    assert.equal(last(published).target_url, EVENT_LINK);
    // Pending went out after the stage request was accepted, and before the first read.
    const order = stubbed.calls.map((call) => call.url.pathname);
    assert.ok(order.indexOf(EVENTS_PATH) < order.indexOf(`/repos/Org/Repo/statuses/${QUEUE_HEAD}`));
    assert.ok(order.indexOf(`/repos/Org/Repo/statuses/${QUEUE_HEAD}`) < order.indexOf(STATUS_PATH));

    const reads = stubbed.reads();
    assert.equal(reads.length, 4);
    assert.equal(reads[0].headers.authorization, `Basic ${Buffer.from(`${API_KEY}:`).toString('base64')}`);
    assert.deepEqual(JSON.parse(reads[0].body), {
      workspace_id: 'ws-w',
      reference: {type: 'pull_request', id: 'github.com/org/repo#7'},
      stages: [{stage: 'merge_queue', head_sha: QUEUE_HEAD}],
      trusted_providers: 'caller',
    });
    assert.deepEqual(reads.slice(1).map((read, i) => read.at - reads[i].at), [POLL_INTERVAL_MS, POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
  });

  it('publishes failure at once when a must_pass check failed', async () => {
    const stubbed = queueStub({statuses: [json(200, statusOf({gate: 'fail', checks: [check({status: 'failed'}), smoke()], summary: 'merge_queue: impacted failed (1 of 4)'}))]});
    const {exitCode, outputs} = await awaitWith('merge_group', mergeGroup, stubbed);

    assert.equal(exitCode, 1);
    assert.equal(outputs.status, 'failure');
    assert.equal(stubbed.reads().length, 1);
    assert.deepEqual(last(stubbed.published()), {
      sha: QUEUE_HEAD,
      at: last(stubbed.published()).at,
      state: 'failure',
      context: CONTEXT,
      description: 'merge_queue: impacted failed (1 of 4)',
      target_url: EVENT_LINK,
    });
  });

  it("keeps polling while nothing is dispatched, and at the deadline gives the waiting check's own summary", async () => {
    const queuedNothing = 'impacted: waiting; the last dispatch queued nothing: event e-v: no credits';
    const undispatched = statusOf({
      gate: 'wait',
      checks: [check({status: 'waiting', summary: queuedNothing, links: {}}), smoke({status: 'waiting'})],
      summary: 'merge_queue: impacted waiting, smoke waiting',
    });
    const stubbed = queueStub({statuses: [json(200, undispatched)]});
    const {exitCode, outputs} = await awaitWith('merge_group', mergeGroup, stubbed);

    assert.equal(exitCode, 1);
    assert.equal(outputs.status, 'failure');
    const sentAt = stubbed.events()[0].at;
    const reads = stubbed.reads();
    // No read starts at the deadline itself.
    assert.equal(last(reads).at, sentAt + 40 * MINUTE - POLL_INTERVAL_MS);
    assert.equal(reads.length, (40 * MINUTE) / POLL_INTERVAL_MS);
    assert.equal(last(stubbed.published()).description, `timed out after 40 min: ${queuedNothing}`);
    // The pending description changed once, so it was published once after the send.
    assert.equal(stubbed.published().filter((status) => status.state === 'pending').length, 2);
  });

  it('retries a 5xx or no answer with backoff until the deadline, then publishes failure', async () => {
    const stubbed = queueStub({statuses: [{throws: 'socket hang up'}, json(503, {error_code: 'unavailable', message: `down ${API_KEY}`})]});
    const {exitCode} = await awaitWith('merge_group', mergeGroup, stubbed, {DEADLINE_MINUTES: '5'});

    assert.equal(exitCode, 1);
    const reads = stubbed.reads();
    const gaps = reads.slice(1).map((read, i) => read.at - reads[i].at);
    assert.deepEqual(gaps.slice(0, READ_RETRY_DELAYS_MS.length), READ_RETRY_DELAYS_MS);
    // Reads at 0, 5, 15, 35, 75, 135, 195 and 255 s; the next would be at the 300 s deadline.
    assert.equal(last(reads).at, stubbed.events()[0].at + 255_000);
    const {description, state} = last(stubbed.published());
    assert.equal(state, 'failure');
    assert.equal(description, "timed out after 5 min: mabl's status read kept failing (HTTP 503 unavailable: down ***)");
  });

  it('recovers from a 5xx when a later read answers', async () => {
    const stubbed = queueStub({statuses: [json(502, {}), json(429, {}), json(200, statusOf())]});
    const {exitCode} = await awaitWith('merge_group', mergeGroup, stubbed);

    assert.equal(exitCode, 0);
    assert.equal(stubbed.reads().length, 3);
    assert.equal(last(stubbed.published()).state, 'success');
  });

  for (const [status, errorCode] of [
    [400, 'invalid_request'],
    [403, 'forbidden'],
    [404, 'no_change_agent'],
  ]) {
    it(`publishes failure at once on a ${status} ${errorCode} from the status read`, async () => {
      const stubbed = queueStub({statuses: [json(status, {error_code: errorCode, message: 'no'})]});
      const {exitCode} = await awaitWith('merge_group', mergeGroup, stubbed);

      assert.equal(exitCode, 1);
      assert.equal(stubbed.reads().length, 1);
      assert.equal(last(stubbed.published()).description, `mabl's status read answered HTTP ${status} ${errorCode}: no`);
    });
  }

  for (const [status, errorCode, description] of [
    [403, 'feature_disabled', 'mabl change validation is off for this workspace, so nothing was judged'],
    [409, 'change_agent_closed', "this change's mabl agent is closed, so nothing was judged"],
    [404, 'no_change_agent', 'this change has no mabl agent, so nothing was judged'],
  ]) {
    it(`publishes failure on ${errorCode}, where the send alone passes`, async () => {
      const stubbed = queueStub({events: [json(status, {error_code: errorCode, message: 'no'})]});
      const {exitCode, outputs} = await awaitWith('merge_group', mergeGroup, stubbed);

      assert.equal(exitCode, 1);
      assert.equal(outputs.outcome, errorCode);
      assert.equal(outputs.status, 'failure');
      assert.equal(stubbed.reads().length, 0);
      assert.deepEqual(
        stubbed.published().map(({state, description: text}) => [state, text]),
        [['failure', description]],
      );
    });
  }

  it('publishes failure when the events route fails', async () => {
    const invalid = queueStub({events: [json(400, {error_code: 'invalid_request', message: 'bad'})]});
    await awaitWith('merge_group', mergeGroup, invalid);
    assert.equal(last(invalid.published()).description, 'stage request: HTTP 400 invalid_request: bad');
  });

  it('publishes nothing when mabl has a newer request, whose run owns the status', async () => {
    const superseded = queueStub({events: [json(200, {session_id: 's1-as', event: 'superseded'})]});
    const {exitCode, outputs, lines} = await awaitWith('merge_group', mergeGroup, superseded);

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'superseded');
    assert.equal(outputs.status, '');
    assert.deepEqual(superseded.published(), []);
    assert.equal(superseded.reads().length, 0);
    assert.ok(lines.some((line) => line.startsWith('::notice') && line.includes('owns this head')));
  });

  it('sends and publishes nothing when the queue dropped the commit', async () => {
    const gone = queueStub({graphql: json(200, {data: {repository: {pullRequest: {headRefOid: HEAD, mergeCommit: null, mergeQueueEntry: null}}}})});
    const {exitCode, outputs, lines} = await awaitWith('merge_group', mergeGroup, gone);

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'entry_gone');
    assert.equal(outputs.status, '');
    assert.equal(gone.calls.filter((call) => call.url.pathname === EVENTS_PATH).length, 0);
    assert.deepEqual(gone.published(), []);
    assert.equal(gone.reads().length, 0);
    assert.ok(lines.some((line) => line.startsWith('::notice') && line.includes('no longer has this commit')));
  });

  it('retries a malformed answer like an unreadable one, then fails saying so', async () => {
    const malformed = json(200, {summary: 'x', stages: [{stage: 'merge_queue', status: 'pending'}]});
    const stubbed = queueStub({statuses: [malformed]});
    const {exitCode} = await awaitWith('merge_group', mergeGroup, stubbed, {DEADLINE_MINUTES: '5'});

    assert.equal(exitCode, 1);
    const reads = stubbed.reads();
    assert.deepEqual(reads.slice(1, 3).map((read, i) => read.at - reads[i].at), READ_RETRY_DELAYS_MS.slice(0, 2));
    assert.equal(last(reads).at, stubbed.events()[0].at + 255_000);
    assert.equal(last(stubbed.published()).description, "timed out after 5 min: mabl's status answer was malformed: the merge_queue stage's gate is missing");

    const recovers = queueStub({statuses: [malformed, json(200, statusOf())]});
    assert.equal((await awaitWith('merge_group', mergeGroup, recovers)).exitCode, 0);
  });

  it('runs the deadline from just before the stage request, so a slow send shortens the wait', async () => {
    const stubbed = queueStub({
      events: [{...json(503, {error_code: 'agent_stopping'}), takesMs: 50_000}, {...ACCEPTED, takesMs: 40_000}],
      statuses: [json(200, statusOf({gate: 'wait', checks: [check({status: 'running'})], summary: 'running'}))],
    });
    await awaitWith('merge_group', mergeGroup, stubbed);

    const [first, second] = stubbed.events();
    const reads = stubbed.reads();
    assert.equal(second.at, first.at + 52_000);
    assert.equal(reads[0].at, second.at + 40_000);
    assert.ok(last(reads).at < first.at + 40 * MINUTE);
    assert.ok(last(reads).at >= first.at + 40 * MINUTE - POLL_INTERVAL_MS);
    assert.equal(last(stubbed.published()).description, 'timed out after 40 min: running');
  });

  it('polls after a duplicate, as on a rerun of the job', async () => {
    const stubbed = queueStub({events: [json(200, {session_id: 's1-as', event: 'duplicate'})]});
    const {exitCode} = await awaitWith('merge_group', mergeGroup, stubbed);

    assert.equal(exitCode, 0);
    assert.equal(stubbed.reads().length, 1);
  });

  it('publishes failure when nothing is sent, so the entry never sits pending', async () => {
    const noKey = queueStub();
    await awaitWith('merge_group', mergeGroup, noKey, {MABL_API_KEY: ''});
    assert.equal(last(noKey.published()).description, 'stage request: mabl-api-key is required');

    const skipped = queueStub();
    await awaitWith('merge_group', {...mergeGroup, action: 'destroyed'}, skipped);
    assert.equal(last(skipped.published()).state, 'failure');
    assert.equal(skipped.events().length, 0);
  });

  it('sends the request and publishes its conclusion when the queue commit is stamped an hour before the action', async () => {
    // A rebuilt entry keeps an earlier commit's timestamp; GitHub's 60 minutes start again with its run.
    const stubbed = stub({clockStart: Date.parse(QUEUED_AT) + 60 * MINUTE});
    const {exitCode, outputs} = await awaitWith('merge_group', mergeGroup, stubbed);

    assert.equal(exitCode, 0);
    assert.equal(outputs.status, 'success');
    assert.equal(stubbed.events().length, 1);
    assert.equal(last(stubbed.published()).state, 'success');
  });

  it('stops preparing when the overall budget runs out, and still publishes failure in time', async () => {
    const invokedAt = Date.parse(QUEUED_AT) + 8 * MINUTE;
    const stubbed = queueStub({slow: {[ENTRY_COMPARE]: 10 * MINUTE}});
    const {exitCode} = await awaitWith('merge_group', mergeGroup, stubbed, {DEADLINE_MINUTES: '1'});

    assert.equal(exitCode, 1);
    assert.equal(stubbed.events().length, 0);
    // The listing was cut off at the budget, the action's start + 1 + 3 minutes.
    const [failure] = stubbed.published();
    assert.equal(failure.at, invokedAt + 4 * MINUTE);
    assert.equal(failure.description, 'timed out preparing the merge_queue request');
  });

  it('sends nothing when preparing used the whole budget, and publishes failure', async () => {
    // Resolving the policy only shapes the description, so its cut-off doesn't stop the run.
    const stubbed = queueStub({slow: {[RESOLVE_PATH]: 10 * MINUTE}});
    const {exitCode, outputs} = await awaitWith('merge_group', mergeGroup, stubbed, {DEADLINE_MINUTES: '1'});

    assert.equal(exitCode, 1);
    assert.equal(outputs.outcome, 'timed_out');
    assert.equal(stubbed.events().length, 0);
    assert.equal(last(stubbed.published()).description, 'timed out before the merge_queue request went out');
  });

  it("caps each stage request attempt at the time left, and starts no retry that would cross the deadline", async () => {
    const unavailable = json(503, {error_code: 'agent_stopping', message: 'later'});
    const stubbed = queueStub({events: [{...unavailable, takesMs: 50_000}, unavailable, unavailable, unavailable]});
    const {exitCode} = await awaitWith('merge_group', mergeGroup, stubbed, {DEADLINE_MINUTES: '1'});

    assert.equal(exitCode, 1);
    const sentAt = stubbed.events()[0].at;
    // 0 s, then after 50 s and a 2 s backoff, then a 5 s backoff; a 15 s backoff would cross 60 s.
    assert.deepEqual(stubbed.events().map((call) => call.at - sentAt), [0, 52_000, 57_000]);
    assert.deepEqual(stubbed.timeouts, [60_000, 8_000, 3_000]);
    assert.equal(last(stubbed.published()).description, 'stage request: HTTP 503 agent_stopping: later');
  });

  it("counts a slow preparation against the action's own start", async () => {
    const stubbed = queueStub({
      slow: {[ENTRY_COMPARE]: 10 * MINUTE},
      statuses: [json(200, statusOf({gate: 'wait', checks: [check({status: 'running'})], summary: 'running'}))],
    });
    await awaitWith('merge_group', mergeGroup, stubbed);

    const invokedAt = Date.parse(QUEUED_AT) + 8 * MINUTE;
    assert.equal(stubbed.events()[0].at, invokedAt + 10 * MINUTE);
    const lastRead = last(stubbed.reads()).at;
    assert.ok(lastRead < invokedAt + 43 * MINUTE);
    assert.ok(lastRead >= invokedAt + 43 * MINUTE - POLL_INTERVAL_MS);
    assert.equal(last(stubbed.published()).description, 'timed out after 33 min: running');
  });

  it('reads nothing when sending used the whole budget', async () => {
    const stubbed = queueStub({events: [{...ACCEPTED, takesMs: MINUTE, ignoresAbort: true}]});
    const {exitCode} = await awaitWith('merge_group', mergeGroup, stubbed, {DEADLINE_MINUTES: '1'});

    assert.equal(exitCode, 1);
    assert.equal(stubbed.reads().length, 0);
    assert.equal(last(stubbed.published()).description, 'timed out after 1 min');
  });

  it('caps each read at the time left, and does not take an answer that arrives after the deadline', async () => {
    const running = json(200, statusOf({gate: 'wait', checks: [check({status: 'running'})], summary: 'running'}));
    const stubbed = queueStub({statuses: [running, running, {...json(200, statusOf()), takesMs: 30_000, ignoresAbort: true}]});
    const {exitCode, outputs} = await awaitWith('merge_group', mergeGroup, stubbed, {DEADLINE_MINUTES: '1'});

    assert.equal(exitCode, 1);
    assert.equal(outputs.status, 'failure');
    const sentAt = stubbed.events()[0].at;
    assert.deepEqual(stubbed.reads().map((read) => read.at - sentAt), [0, 20_000, 40_000]);
    // The stage request's own 60 s, then the reads.
    assert.deepEqual(stubbed.timeouts, [60_000, 30_000, 30_000, 20_000]);
    // The third read passed when it answered, 10 s after the deadline.
    assert.deepEqual(stubbed.published().map(({state}) => state), ['pending', 'pending', 'failure']);
    assert.equal(last(stubbed.published()).description, 'timed out after 1 min: running');
  });

  it('retries a pending publish with the same backoff as the conclusion', async () => {
    const stubbed = queueStub({published: [{status: 502}, {status: 0}, {status: 201}]});
    const {exitCode} = await awaitWith('merge_group', mergeGroup, stubbed);

    assert.equal(exitCode, 0);
    const published = stubbed.published();
    assert.deepEqual(published.map(({state}) => state), ['pending', 'pending', 'pending', 'success']);
    assert.deepEqual([published[1].at - published[0].at, published[2].at - published[1].at], PUBLISH_RETRY_DELAYS_MS.slice(0, 2));
    assert.ok(stubbed.reads()[0].at >= published[2].at);
  });

  it("stops and publishes failure when pending can't be published, so an earlier conclusion doesn't keep showing", async () => {
    const tries = PUBLISH_RETRY_DELAYS_MS.length + 1;
    const stubbed = queueStub({published: [...Array(tries).fill({status: 502}), {status: 201}]});
    const {exitCode, outputs} = await awaitWith('merge_group', mergeGroup, stubbed);

    assert.equal(exitCode, 1);
    assert.equal(outputs.status, 'failure');
    assert.equal(stubbed.reads().length, 0);
    const published = stubbed.published();
    assert.deepEqual(published.map(({state}) => state), [...Array(tries).fill('pending'), 'failure']);
    assert.equal(last(published).description, `couldn't publish ${CONTEXT} pending (HTTP 502)`);

    const refused = queueStub({published: [{status: 403}, {status: 201}]});
    await awaitWith('merge_group', mergeGroup, refused);
    assert.deepEqual(refused.published().map(({state}) => state), ['pending', 'failure']);
  });

  it('stops polling when a later pending fails', async () => {
    const tries = PUBLISH_RETRY_DELAYS_MS.length + 1;
    const waiting = json(200, statusOf({gate: 'wait', checks: [check({status: 'running'})], summary: 'merge_queue: impacted running'}));
    const stubbed = queueStub({statuses: [waiting], published: [{status: 201}, ...Array(tries).fill({status: 503}), {status: 201}]});
    const {exitCode} = await awaitWith('merge_group', mergeGroup, stubbed);

    assert.equal(exitCode, 1);
    assert.equal(stubbed.reads().length, 1);
    const {state, description, target_url: link} = last(stubbed.published());
    assert.equal(state, 'failure');
    assert.equal(description, `couldn't publish ${CONTEXT} pending (HTTP 503)`);
    assert.equal(link, EVENT_LINK);
  });

  it('caps each conclusion attempt at what is left of its 90 s, and starts none past it', async () => {
    // Preparing takes 3 of the budget's 4 minutes, so polling ends at the budget.
    const invokedAt = Date.parse(QUEUED_AT) + 8 * MINUTE;
    const stubbed = stub({
      clockStart: invokedAt,
      slow: {[ENTRY_COMPARE]: 3 * MINUTE},
      statuses: [json(200, statusOf({gate: 'wait', checks: [check({status: 'running'})], summary: 'running'}))],
      published: [{status: 201}, {status: 201}, {status: 502, takesMs: 40_000}],
    });
    const {exitCode, outputs} = await awaitWith('merge_group', mergeGroup, stubbed, {DEADLINE_MINUTES: '1'});

    assert.equal(exitCode, 1);
    assert.equal(outputs.status, '');
    const budget = invokedAt + 4 * MINUTE;
    const conclusion = stubbed.published().filter(({state}) => state === 'failure');
    // At the budget, then after a 30 s timeout and a 2 s backoff, then a 30 s timeout and a 5 s backoff.
    assert.deepEqual(conclusion.map(({at}) => at - budget), [0, 32_000, 67_000]);
    assert.deepEqual(stubbed.publishTimeouts.slice(-3), [30_000, 30_000, PUBLISH_GRACE_MS - 67_000]);
  });

  it("publishes nothing, and fails the step, once publishing's own time is gone", async () => {
    // A pull request read that hangs past every timeout leaves the run 4.5 minutes past its budget.
    const stubbed = queueStub({stuck: {'/repos/Org/Repo/pulls/7': 10 * MINUTE}});
    const {exitCode, outputs, lines} = await awaitWith('merge_group', mergeGroup, stubbed, {DEADLINE_MINUTES: '1'});

    assert.equal(exitCode, 1);
    assert.equal(outputs.status, '');
    assert.deepEqual(stubbed.published(), []);
    assert.ok(lines.some((line) => line.startsWith('::error') && line.includes('no time left to publish')));
  });

  it('keeps the last 60 s for the conclusion when pending keeps failing', async () => {
    // Preparing takes 3 of the budget's 4 minutes.
    const invokedAt = Date.parse(QUEUED_AT) + 8 * MINUTE;
    const slowFailure = {status: 502, takesMs: 40_000};
    const stubbed = stub({
      clockStart: invokedAt,
      slow: {[ENTRY_COMPARE]: 3 * MINUTE},
      published: [slowFailure, slowFailure, slowFailure, {status: 201}],
    });
    const {exitCode, outputs} = await awaitWith('merge_group', mergeGroup, stubbed, {DEADLINE_MINUTES: '1'});

    assert.equal(exitCode, 1);
    assert.equal(outputs.status, 'failure');
    const finishBy = invokedAt + 4 * MINUTE + PUBLISH_GRACE_MS;
    const published = stubbed.published();
    const pending = published.filter(({state}) => state === 'pending');
    // Each pending attempt is cut off by the time the conclusion keeps for itself.
    assert.equal(pending.length, 3);
    assert.equal(stubbed.publishTimeouts[2], finishBy - CONCLUSION_RESERVE_MS - last(pending).at);
    const failure = last(published);
    assert.equal(failure.state, 'failure');
    assert.equal(failure.at, finishBy - CONCLUSION_RESERVE_MS);
    assert.match(failure.description, /^couldn't publish mabl-change-validation pending \(no answer: /);
  });

  it('cuts the description to 139 characters', async () => {
    const summary = `merge_queue: ${'x'.repeat(300)}`;
    const stubbed = queueStub({statuses: [json(200, statusOf({summary}))]});
    await awaitWith('merge_group', mergeGroup, stubbed);

    const {description} = last(stubbed.published());
    assert.equal([...description].length, MAX_DESCRIPTION_CHARS);
    assert.ok(description.endsWith('…'));
  });

  it('retries publishing the conclusion, and fails the step when it never lands', async () => {
    const stubbed = queueStub({published: [{status: 201}, {status: 502}]});
    const {exitCode, outputs} = await awaitWith('merge_group', mergeGroup, stubbed);

    assert.equal(exitCode, 1);
    assert.equal(outputs.status, '');
    assert.equal(stubbed.published().filter((status) => status.state === 'success').length, PUBLISH_RETRY_DELAYS_MS.length + 1);
  });
});

describe('await inputs', () => {
  it('runs only on merge_group events and revisions, refusing anything else before doing anything', async () => {
    for (const [eventName, payload] of [
      ['pull_request', prEvent],
      ['issue_comment', triggerComment],
    ]) {
      const stubbed = stub({clockStart: 0});
      const {exitCode, outputs, lines} = await awaitWith(eventName, payload, stubbed);

      assert.equal(exitCode, 1);
      assert.equal(outputs.outcome, 'failed');
      assert.equal(stubbed.calls.length, 0);
      assert.ok(lines.some((line) => line.startsWith('::error') && line.includes(`await mode runs on merge_group events and revisions (`) && line.endsWith(`not ${eventName}`)));
    }
  });

  it('sends a command without waiting', async () => {
    const stubbed = stub({clockStart: 0, events: [json(201, {session_id: 's1-as', event: 'accepted'})]});
    const {exitCode, outputs} = await awaitWith('issue_comment', triggerComment, stubbed, {CHANGE_VALIDATION_COMMAND: 'author 2'});

    assert.equal(exitCode, 0);
    assert.equal(outputs.status, '');
    assert.equal(stubbed.reads().length, 0);
    assert.deepEqual(stubbed.published(), []);
  });

  it('sends a command without needing the await inputs', async () => {
    for (const env of [{STATUS_CONTEXT: ''}, {DEADLINE_MINUTES: '0'}]) {
      const stubbed = stub({clockStart: 0, events: [json(201, {session_id: 's1-as', event: 'accepted'})]});
      const {exitCode, outputs} = await awaitWith('issue_comment', triggerComment, stubbed, {CHANGE_VALIDATION_COMMAND: 'author 2', ...env});

      assert.equal(exitCode, 0);
      assert.equal(outputs.outcome, 'accepted');
      assert.equal(stubbed.events().length, 1);
      assert.deepEqual(JSON.parse(stubbed.events()[0].body).event, {kind: 'command', command: 'author 2'});
      assert.deepEqual(stubbed.published(), []);
    }
  });

  it('needs a status context, before sending anything', async () => {
    const stubbed = queueStub();
    const {exitCode, outputs} = await awaitWith('merge_group', mergeGroup, stubbed, {STATUS_CONTEXT: ''});

    assert.equal(exitCode, 1);
    assert.equal(outputs.status, '');
    assert.equal(stubbed.calls.length, 0);
  });

  it('needs a deadline in range, and publishes error rather than leave the context pending', async () => {
    for (const minutes of ['0', '121', '4.5']) {
      const stubbed = queueStub();
      const {exitCode, outputs} = await awaitWith('merge_group', mergeGroup, stubbed, {DEADLINE_MINUTES: minutes});

      assert.equal(exitCode, 1);
      assert.equal(outputs.outcome, 'failed');
      assert.equal(outputs.status, 'error');
      assert.equal(stubbed.calls.length, 1);
      assert.deepEqual(
        stubbed.published().map(({at, ...status}) => status),
        [{sha: QUEUE_HEAD, state: 'error', context: CONTEXT, description: `deadline-minutes has to be a whole number from 1 to 120, got ${minutes}`, target_url: RUN_URL}],
      );
    }
  });

  it("leaves the status output empty when the error can't be published", async () => {
    const stubbed = queueStub({published: [{status: 403}]});
    const {exitCode, outputs} = await awaitWith('merge_group', mergeGroup, stubbed, {DEADLINE_MINUTES: '0'});

    assert.equal(exitCode, 1);
    assert.equal(outputs.status, '');
    assert.equal(stubbed.published().length, 1);
  });

  it('publishes error when the wait stops on an error nobody expected', async () => {
    const stubbed = queueStub({statuses: [json(200, statusOf({gate: 'wait', checks: [check({status: 'running'})], summary: 'running'}))]});
    const broken = {
      ...stubbed,
      sleep: async () => {
        throw new Error(`the timer broke ${API_KEY}`);
      },
    };
    const {exitCode, outputs, lines} = await awaitWith('merge_group', mergeGroup, broken);

    assert.equal(exitCode, 1);
    assert.equal(outputs.outcome, 'failed');
    assert.equal(outputs.status, 'error');
    const published = stubbed.published();
    assert.deepEqual(
      published.map(({state}) => state),
      ['pending', 'pending', 'error'],
    );
    assert.equal(last(published).description, 'await stopped: the timer broke ***');
    assert.ok(lines.some((line) => line.startsWith('::error') && line.includes('await stopped: the timer broke ***')));
  });

  it('skips a comment that does not start with the trigger word, publishing nothing', async () => {
    const stubbed = stub({clockStart: 0});
    const comment = {...triggerComment, comment: {...triggerComment.comment, body: 'looks good to me'}};
    const {exitCode, outputs, lines} = await awaitWith('issue_comment', comment, stubbed, {CHANGE_VALIDATION_TRIGGER_WORD: '/mabl'});

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'skipped');
    assert.equal(outputs.status, '');
    assert.equal(stubbed.calls.length, 0);
    assert.ok(!lines.some((line) => line.includes('the command is sent without waiting')));
  });

  it('reads the command after the trigger word, and sends it without waiting', async () => {
    const stubbed = stub({clockStart: 0, events: [json(201, {session_id: 's1-as', event: 'accepted'})]});
    const comment = {...triggerComment, comment: {...triggerComment.comment, body: '/mabl author 2'}};
    const {exitCode} = await awaitWith('issue_comment', comment, stubbed, {CHANGE_VALIDATION_TRIGGER_WORD: '/mabl'});

    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(stubbed.events()[0].body).event, {kind: 'command', command: 'author 2'});
    assert.deepEqual(stubbed.published(), []);
  });

  it('publishes nothing and adds no output without await', async () => {
    const stubbed = queueStub();
    const {exitCode, outputs} = await awaitWith('merge_group', mergeGroup, stubbed, {CHANGE_VALIDATION_AWAIT: 'false'});

    assert.equal(exitCode, 0);
    assert.equal(Object.hasOwn(outputs, 'status'), false);
    assert.deepEqual(stubbed.published(), []);
    assert.equal(stubbed.reads().length, 0);
  });
});
