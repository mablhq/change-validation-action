import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it} from 'node:test';

import {EVENTS_PATH, MERGED_TIMEOUT_MS, RESOLVE_PATH, RETRY_DELAYS_MS, mablBranchFromDescription, run} from '../src/stage-request.mjs';
import {DEFAULT_API_URL, apiUrlOf} from '../src/lib/mabl-api.mjs';

const GITHUB_API = 'https://api.github.example.test';
const MABL = DEFAULT_API_URL;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const STALE_HEAD = 'c'.repeat(40);
const UPDATED_AT = '2026-11-04T12:00:00Z';
const POLICY = 'version: 1\n# café\n';
const API_KEY = 'mabl-key-secret';
const REPO_ID = 1001;
const LABELS = ['mabl:waive-flaky', 'area: web'];

const pullRequest = (overrides = {}) => ({
  number: 7,
  html_url: 'https://github.com/Org/Repo/pull/7',
  title: 'Add a thing',
  body: 'Why it matters',
  updated_at: UPDATED_AT,
  head: {sha: HEAD, ref: 'feature/thing', repo: {id: REPO_ID, full_name: 'Org/Repo'}},
  base: {sha: BASE, ref: 'main', repo: {id: REPO_ID, full_name: 'Org/Repo'}},
  labels: LABELS.map((name, id) => ({id, name})),
  changed_files: 4,
  additions: 30,
  deletions: 5,
  ...overrides,
});

const FILES = [
  {filename: 'frontend/src/Checkout.tsx', status: 'modified'},
  {filename: 'backend/src/Users.tsx', status: 'modified'},
  {filename: 'shared/src/Button.tsx', status: 'modified'},
  {filename: 'docs/README.md', status: 'modified'},
];
// The same change as a queue commit sees it, with totals matching the pull request's.
const ENTRY_FILES = FILES.map((file, index) => ({...file, additions: [10, 10, 5, 5][index], deletions: [2, 1, 1, 1][index]}));
// The api's answer for POLICY: web at both stages, admin at pull_request only.
const STAGES = {
  web: {
    pull_request: {mabl_application: 'web-a', analysis_roots: ['frontend', 'shared']},
    merge_queue: {mabl_application: 'web-a', analysis_roots: ['frontend', 'shared']},
  },
  admin: {pull_request: {mabl_application: 'admin-a', analysis_roots: ['backend', 'shared']}},
};
const PATHS = FILES.map((file) => file.filename);
const RESOLVED = (stages = STAGES) => ({status: 200, body: JSON.stringify({valid: true, errors: [], policy: {}, stages})});
const BUILT = [
  'Title: Add a thing',
  '',
  "Changed paths per mabl application, by the policy's analysis_roots:",
  '- web (2 files): frontend/src/Checkout.tsx, shared/src/Button.tsx',
  '- admin (2 files): backend/src/Users.tsx, shared/src/Button.tsx',
  '',
  'Description:',
  '',
  'Why it matters',
  '',
  'Diff stat: 4 files changed, 30 insertions(+), 5 deletions(-)',
].join('\n');

const prEvent = (action, extra = {}) => ({
  action,
  pull_request: {number: 7, head: {sha: STALE_HEAD}, base: {sha: BASE}},
  ...extra,
});

const COMMENT_ID = 4242;
const COMMENTED_AT = '2026-11-04T12:05:00Z';
const commentEvent = (association, extra = {}) => ({
  action: 'created',
  issue: {number: 7, pull_request: {url: 'x'}},
  comment: {id: COMMENT_ID, created_at: COMMENTED_AT, author_association: association, body: '/mabl author 2', user: {login: 'dev'}},
  ...extra,
});

const json = (status, body) => ({status, body: JSON.stringify(body), headers: {'content-type': 'application/json'}});
const ACCEPTED = json(201, {session_id: 's1-as', created: true, event: 'accepted', agent: 'working'});

// GitHub's PR read, files and contents API, the policy resolve, then the other mabl answers in order.
// `files` is the PR's files, served 100 a page. `pr` may be a list of reads in order, the last one
// repeating. Records every call.
function stub({
  pr = pullRequest(),
  policy = {status: 200, body: POLICY},
  mabl = [ACCEPTED],
  permission = json(200, {permission: 'write'}),
  commits = {},
  files = FILES,
  filesAnswer,
  // The queue commit's files over the merge group's base, from compare/<base_sha>...<queue commit>.
  entryFiles = ENTRY_FILES,
  compareAnswer,
  resolve = RESOLVED(),
  graphql = queueEntry(),
} = {}) {
  const calls = [];
  const answers = [...mabl];
  const prReads = Array.isArray(pr) ? [...pr] : [pr];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({url: parsed, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body, redirect: init.redirect});
    let answer;
    if (parsed.origin === GITHUB_API && parsed.pathname === '/repos/Org/Repo/pulls/7') {
      answer = json(200, prReads.length > 1 ? prReads.shift() : prReads[0]);
    } else if (parsed.origin === GITHUB_API && parsed.pathname === '/repos/Org/Repo/pulls/7/files') {
      const page = Number(parsed.searchParams.get('page'));
      const size = Number(parsed.searchParams.get('per_page'));
      answer = filesAnswer ?? json(200, files.slice((page - 1) * size, page * size));
    } else if (parsed.origin === MABL && parsed.pathname === RESOLVE_PATH) {
      answer = resolve;
    } else if (parsed.origin === GITHUB_API && parsed.pathname.startsWith('/repos/Org/Repo/contents/')) {
      answer = {headers: {'content-type': 'application/vnd.github.raw'}, ...policy};
    } else if (parsed.origin === GITHUB_API && parsed.pathname === '/repos/Org/Repo/collaborators/dev/permission') {
      answer = permission;
    } else if (parsed.origin === GITHUB_API && parsed.pathname.startsWith('/repos/Org/Repo/git/commits/')) {
      answer = commits[parsed.pathname.split('/').pop()] ?? json(200, {});
    } else if (parsed.origin === GITHUB_API && parsed.pathname.startsWith('/repos/Org/Repo/compare/')) {
      answer = compareAnswer ?? json(200, {status: 'ahead', files: entryFiles});
    } else if (parsed.origin === GITHUB_API && parsed.pathname === '/graphql') {
      answer = graphql;
    } else if (parsed.origin === MABL) {
      answer = answers.shift();
    }
    if (answer === undefined) {
      throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
    }
    return new Response(answer.body ?? '', {status: answer.status ?? 200, headers: answer.headers ?? {}});
  };
  const mablCalls = () => calls.filter((call) => call.url.origin === MABL && call.url.pathname !== RESOLVE_PATH);
  const resolveCalls = () => calls.filter((call) => call.url.pathname === RESOLVE_PATH);
  const fileCalls = () => calls.filter((call) => call.url.pathname.endsWith('/files'));
  const compareCalls = () => calls.filter((call) => call.url.pathname.startsWith('/repos/Org/Repo/compare/'));
  const graphqlCalls = () => calls.filter((call) => call.url.pathname === '/graphql');
  const sent = () => mablCalls().map((call) => JSON.parse(call.body));
  return {fetchImpl, calls, mablCalls, resolveCalls, fileCalls, compareCalls, graphqlCalls, sent};
}

async function runWith(eventName, payload, stubbed, env = {}, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'change-agent-'));
  const eventPath = join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify(payload));
  const lines = [];
  const delays = [];
  const result = await run({
    env: {
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: 'Org/Repo',
      GITHUB_API_URL: GITHUB_API,
      GITHUB_RUN_ID: '555',
      GITHUB_RUN_ATTEMPT: '2',
      GH_TOKEN: 'ghs_test',
      MABL_API_KEY: API_KEY,
      MABL_WORKSPACE_ID: 'ws-w',
      CHANGE_VALIDATION_STAGE: 'pull_request',
      ...env,
    },
    fetchImpl: stubbed.fetchImpl,
    sleep: async (ms) => delays.push(ms),
    print: (line) => lines.push(line),
    ...options,
  });
  return {...result, lines, delays};
}

const STAMPED_FIELDS = ['provided_by', 'provided_at', 'event_occurred_at', 'event_change_description', 'event_replaced_revisions', 'event_stage', 'event_labels', 'stages'];

describe('a pull_request event', () => {
  it("asks to validate the caller's stage at the fetched head, with the PR's labels and the policy read at the base", async () => {
    const stubbed = stub();
    const {exitCode, outputs} = await runWith('pull_request', prEvent('opened'), stubbed);

    assert.equal(exitCode, 0);
    assert.deepEqual(outputs, {outcome: 'accepted', 'session-id': 's1-as', created: 'true', agent: 'working', 'description-source': 'built', 'pull-request-number': '7'});
    const contents = stubbed.calls.find((call) => call.url.pathname.includes('/contents/'));
    assert.equal(contents.url.searchParams.get('ref'), BASE);
    assert.equal(stubbed.mablCalls().length, 1);
    const [call] = stubbed.mablCalls();
    assert.equal(call.method, 'POST');
    assert.equal(call.url.href, `${MABL}${EVENTS_PATH}`);
    assert.equal(call.headers.authorization, `Basic ${Buffer.from(`${API_KEY}:`).toString('base64')}`);
    assert.deepEqual(JSON.parse(call.body), {
      workspace_id: 'ws-w',
      reference: {type: 'pull_request', id: 'github.com/org/repo#7', url: 'https://github.com/Org/Repo/pull/7'},
      event: {
        kind: 'stage.requested',
        stage: 'pull_request',
        head_sha: HEAD,
        base_sha: BASE,
        head_ref: 'feature/thing',
        occurred_at: Date.parse(UPDATED_AT),
        labels: LABELS,
        changed_paths: PATHS,
        changed_paths_truncated: false,
        pull_request_head_sha: HEAD,
      },
      change_description: BUILT,
      related_artifacts: [
        {
          artifact_type: 'inline',
          name: 'validation_policy',
          artifact_data: {
            type: 'json',
            value: {
              repository: 'github.com/org/repo',
              pull_request: 7,
              base_sha: BASE,
              head_sha: HEAD,
              head_ref: 'feature/thing',
              path: '.mabl/policy.yaml',
              found: true,
              text: POLICY,
              sha256: createHash('sha256').update(Buffer.from(POLICY, 'utf8')).digest('hex'),
            },
          },
        },
      ],
      dry_run: false,
    });
    assert.equal(stubbed.graphqlCalls().length, 0);
  });

  it("sends dry_run on every stage request, true only when the input is 'true'", async () => {
    for (const [input, expected] of [['true', true], ['false', false], ['', false], ['TRUE', false], [undefined, false]]) {
      const stubbed = stub();
      await runWith('pull_request', prEvent('opened'), stubbed, {CHANGE_VALIDATION_DRY_RUN: input});

      assert.equal(stubbed.sent()[0].dry_run, expected, `input ${JSON.stringify(input)}`);
    }
  });

  it('sends found: false with no text or digest when the base has no policy', async () => {
    const stubbed = stub({policy: json(404, {message: 'Not Found'})});
    const {exitCode} = await runWith('pull_request', prEvent('synchronize'), stubbed);

    assert.equal(exitCode, 0);
    const [body] = stubbed.sent();
    assert.equal(body.event.kind, 'stage.requested');
    const {value} = body.related_artifacts[0].artifact_data;
    assert.equal(value.found, false);
    assert.equal('text' in value, false);
    assert.equal('sha256' in value, false);
  });

  it("sends the caller's change description as is, building none, and builds one when it is blank", async () => {
    const provided = stub();
    const {outputs} = await runWith('pull_request', prEvent('synchronize'), provided, {
      CHANGE_DESCRIPTION: '  Checkout totals now include tax.  ',
      CHANGE_DESCRIPTION_HEAD_SHA: HEAD.toUpperCase(),
    });
    assert.equal(provided.sent()[0].change_description, 'Checkout totals now include tax.');
    assert.equal(outputs['description-source'], 'provided');
    assert.equal(provided.resolveCalls().length, 0);
    // Listed for changed_paths only.
    assert.deepEqual(provided.sent()[0].event.changed_paths, PATHS);

    const blank = stub();
    const built = await runWith('pull_request', prEvent('synchronize'), blank, {CHANGE_DESCRIPTION: '   '});
    assert.equal(blank.sent()[0].change_description, BUILT);
    assert.equal(built.outputs['description-source'], 'built');
  });

  it('sends nothing when the change description was written for an older head', async () => {
    const stubbed = stub();
    const {exitCode, outputs} = await runWith('pull_request', prEvent('synchronize'), stubbed, {
      CHANGE_DESCRIPTION: 'Checkout totals now include tax.',
      CHANGE_DESCRIPTION_HEAD_SHA: STALE_HEAD,
    });

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'skipped');
    assert.equal(stubbed.mablCalls().length, 0);
  });

  it('fails a change description that does not say which head it describes', async () => {
    const stubbed = stub();
    const {exitCode} = await runWith('pull_request', prEvent('synchronize'), stubbed, {
      CHANGE_DESCRIPTION: 'Checkout totals now include tax.',
    });

    assert.equal(exitCode, 1);
    assert.equal(stubbed.mablCalls().length, 0);
  });

  it("digests the decoded text's UTF-8 bytes, as mabl checks, so a leading BOM is not part of it", async () => {
    const stubbed = stub({policy: {status: 200, body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(POLICY, 'utf8')])}});
    const {exitCode} = await runWith('pull_request', prEvent('opened'), stubbed);

    assert.equal(exitCode, 0);
    const {value} = stubbed.sent()[0].related_artifacts[0].artifact_data;
    assert.equal(value.text, POLICY);
    assert.equal(value.sha256, createHash('sha256').update(Buffer.from(POLICY, 'utf8')).digest('hex'));
  });

  it('sends nothing when the policy is over 64 KiB', async () => {
    const stubbed = stub({policy: {status: 200, body: 'x'.repeat(64 * 1024 + 1)}});
    const {exitCode, outputs, lines} = await runWith('pull_request', prEvent('opened'), stubbed);

    assert.equal(exitCode, 1);
    assert.equal(outputs.outcome, 'failed');
    assert.equal(stubbed.mablCalls().length, 0);
    assert.match(lines.join('\n'), /larger than 64 KiB/);
  });

  it('sends nothing when the policy read fails', async () => {
    const stubbed = stub({policy: json(500, {message: 'boom'})});
    const {exitCode} = await runWith('pull_request', prEvent('opened'), stubbed);

    assert.equal(exitCode, 1);
    assert.equal(stubbed.mablCalls().length, 0);
  });

  it('never sends a field mabl stamps, an idempotency key, or a separate artifacts write', async () => {
    const stubbed = stub();
    await runWith('pull_request', prEvent('reopened'), stubbed);

    assert.deepEqual(
      stubbed.calls.filter((call) => call.method !== 'GET').map((call) => call.url.pathname),
      [RESOLVE_PATH, EVENTS_PATH],
    );
    const [body] = stubbed.sent();
    assert.equal('idempotency_key' in body, false);
    for (const field of STAMPED_FIELDS) {
      assert.equal(stubbed.mablCalls()[0].body.includes(`"${field}"`), false, field);
    }
  });

  it('sends an edit only when it moved the base branch', async () => {
    const unmoved = stub();
    const skipped = await runWith('pull_request', prEvent('edited', {changes: {title: {from: 'x'}}}), unmoved);
    assert.equal(skipped.outputs.outcome, 'skipped');
    assert.equal(unmoved.calls.length, 0);

    const moved = stub();
    await runWith('pull_request', prEvent('edited', {changes: {base: {ref: {from: 'old'}}}}), moved);
    assert.equal(moved.sent()[0].event.kind, 'stage.requested');
  });

  it('sends a stage of any name the policy gives, and no labels when the PR has none', async () => {
    const stubbed = stub({pr: pullRequest({labels: []})});
    await runWith('pull_request', prEvent('synchronize'), stubbed, {CHANGE_VALIDATION_STAGE: ' pre-prod_2 '});

    const [{event}] = stubbed.sent();
    assert.equal(event.stage, 'pre-prod_2');
    assert.deepEqual(event.labels, []);
  });

  for (const [name, stage, message] of [
    ['missing', '', /stage is required/],
    ['not a policy stage name', 'pre prod', /not a policy stage name/],
    ['too long', 'x'.repeat(65), /not a policy stage name/],
  ]) {
    it(`fails, calling nothing, when the stage is ${name}`, async () => {
      const stubbed = stub();
      const {exitCode, outputs, lines} = await runWith('pull_request', prEvent('opened'), stubbed, {CHANGE_VALIDATION_STAGE: stage});

      assert.equal(exitCode, 1);
      assert.equal(outputs.outcome, 'failed');
      assert.equal(stubbed.calls.length, 0);
      assert.match(lines.join('\n'), message);
    });
  }

  it('skips a pull_request action mabl does not take', async () => {
    const stubbed = stub();
    const {exitCode, outputs} = await runWith('pull_request', prEvent('labeled'), stubbed);

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'skipped');
    assert.equal(stubbed.calls.length, 0);
  });
});

const MERGE = 'f'.repeat(40);
const MERGED_AT = '2026-11-16T18:00:00Z';
const closedEvent = (overrides = {}) => ({
  action: 'closed',
  pull_request: pullRequest({merged: true, merge_commit_sha: MERGE, merged_at: MERGED_AT, ...overrides}),
});

describe('a merged pull request', () => {
  it('tells the agent it merged, with the policy read at the merge commit, and needs no stage', async () => {
    const stubbed = stub({mabl: [json(200, {session_id: 's1-as', created: false, event: 'accepted', agent: 'working'})]});
    const {exitCode, outputs, lines} = await runWith('pull_request', closedEvent(), stubbed, {CHANGE_VALIDATION_STAGE: ''});

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'accepted');
    const contents = stubbed.calls.find((call) => call.url.pathname.includes('/contents/'));
    assert.equal(contents.url.searchParams.get('ref'), MERGE);
    assert.equal(stubbed.calls.filter((call) => call.url.pathname.startsWith('/repos/Org/Repo/pulls/')).length, 0);
    assert.equal(stubbed.resolveCalls().length, 0);
    assert.deepEqual(stubbed.sent(), [
      {
        workspace_id: 'ws-w',
        reference: {type: 'pull_request', id: 'github.com/org/repo#7', url: 'https://github.com/Org/Repo/pull/7'},
        event: {kind: 'pull_request.merged', head_sha: MERGE, head_ref: 'feature/thing', occurred_at: Date.parse(MERGED_AT)},
        related_artifacts: [
          {
            artifact_type: 'inline',
            name: 'validation_policy',
            artifact_data: {
              type: 'json',
              value: {
                repository: 'github.com/org/repo',
                pull_request: 7,
                base_sha: MERGE,
                head_sha: MERGE,
                head_ref: 'feature/thing',
                path: '.mabl/policy.yaml',
                found: true,
                text: POLICY,
                sha256: createHash('sha256').update(Buffer.from(POLICY, 'utf8')).digest('hex'),
              },
            },
          },
        ],
      },
    ]);
    assert.match(lines.join('\n'), /merged: accepted/);
  });

  it('sends nothing for a pull request closed without merging', async () => {
    const stubbed = stub();
    const {exitCode, outputs} = await runWith('pull_request', closedEvent({merged: false, merge_commit_sha: null}), stubbed);

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'skipped');
    assert.equal(stubbed.calls.length, 0);
  });

  it('refuses a fork', async () => {
    const stubbed = stub();
    const fork = {sha: HEAD, ref: 'feature/thing', repo: {id: 999, full_name: 'Someone/Repo'}};
    const {exitCode, outputs} = await runWith('pull_request', closedEvent({head: fork}), stubbed);

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'refused');
    assert.equal(stubbed.calls.length, 0);
  });

  for (const [what, overrides, message] of [
    ['no merge commit', {merge_commit_sha: null}, /has no merge commit/],
    ['no merged_at', {merged_at: null}, /has no merged_at/],
  ]) {
    it(`fails with ${what}`, async () => {
      const stubbed = stub();
      const {exitCode, lines} = await runWith('pull_request', closedEvent(overrides), stubbed);

      assert.equal(exitCode, 1);
      assert.match(lines.join('\n'), message);
      assert.equal(stubbed.mablCalls().length, 0);
    });
  }

  const mergedAnswer = (event, landed) => json(200, {session_id: 's1-as', created: false, event, ...(landed === undefined ? {} : {landed})});
  const landedWith = (...branches) => ({merge_commit_sha: MERGE, merge_mabl_branches: true, branches});
  const annotations = (lines, level) => lines.filter((line) => line.startsWith(`::${level} `)).map((line) => line.slice(line.indexOf('::', 2) + 2));

  for (const [outcome, message] of [
    ['merged', 'mabl branch feature-x: merged into master'],
    ['nothing_to_merge', 'mabl branch feature-x: nothing to merge into master'],
    ['not_open', "mabl branch feature-x: nothing to merge, it doesn't exist, is already merged or isn't a working branch"],
    ['left', "mabl branch feature-x: left open, the policy doesn't set merge_mabl_branches"],
  ]) {
    it(`logs a ${outcome} mabl branch as a notice and passes`, async () => {
      const stubbed = stub({mabl: [mergedAnswer('accepted', landedWith({name: 'feature-x', outcome}))]});
      const {exitCode, outputs, lines} = await runWith('pull_request', closedEvent(), stubbed);

      assert.equal(exitCode, 0);
      assert.equal(outputs.outcome, 'accepted');
      assert.deepEqual(annotations(lines, 'notice'), ['merged: accepted (s1-as)', message]);
      assert.deepEqual(annotations(lines, 'error'), []);
    });
  }

  it('fails on a diverged mabl branch, naming the branch and the tests and flows master moved past', async () => {
    const stubbed = stub({
      mabl: [
        mergedAnswer(
          'accepted',
          landedWith({
            name: 'feature-x',
            outcome: 'diverged',
            diverged_entities: [
              {id: 'checkout-j', type: 'test', name: 'Checkout'},
              {id: 'login-f', type: 'flow', name: 'Log in'},
            ],
          }),
        ),
      ],
    });
    const {exitCode, outputs, lines} = await runWith('pull_request', closedEvent(), stubbed);

    assert.equal(exitCode, 1);
    assert.equal(outputs.outcome, 'accepted');
    assert.deepEqual(annotations(lines, 'error'), [
      'mabl branch feature-x: not merged, master changed after the branch. Merge it into master by hand in mabl. Master moved past 1 test and 1 flow: test "Checkout", flow "Log in"',
    ]);
    assert.ok(lines.includes('mabl branch feature-x: master moved past test "Checkout" (checkout-j)'));
    assert.ok(lines.includes('mabl branch feature-x: master moved past flow "Log in" (login-f)'));
  });

  it('fails on a failed merge, and again on a repeat of the event, which says it reports the recorded outcome', async () => {
    const recorded = " (as recorded when the pull request merged; a re-run doesn't check the branch again)";
    for (const [event, note] of [
      ['accepted', ''],
      ['duplicate', recorded],
    ]) {
      const stubbed = stub({mabl: [mergedAnswer(event, landedWith({name: 'feature-x', outcome: 'failed'}))]});
      const {exitCode, outputs, lines} = await runWith('pull_request', closedEvent(), stubbed);

      assert.equal(exitCode, 1);
      assert.equal(outputs.outcome, event);
      assert.deepEqual(annotations(lines, 'error'), [
        `mabl branch feature-x: the merge into master failed, and the branch may be partly merged${note}. Check it and finish the merge by hand in mabl`,
      ]);
    }
    const diverged = await runWith('pull_request', closedEvent(), stub({mabl: [mergedAnswer('duplicate', landedWith({name: 'feature-x', outcome: 'diverged'}))]}));
    assert.deepEqual(annotations(diverged.lines, 'error'), [
      `mabl branch feature-x: not merged, master changed after the branch${recorded}. Merge it into master by hand in mabl.`,
    ]);
  });

  it("names ten of a diverged branch's tests and flows in the error, after the count, and lists each in the log", async () => {
    const entities = Array.from({length: 13}, (_, index) => ({id: `t${index}-j`, type: 'test', name: `Test ${index}`}));
    const stubbed = stub({mabl: [mergedAnswer('accepted', landedWith({name: 'feature-x', outcome: 'diverged', diverged_entities: entities}))]});
    const {exitCode, lines} = await runWith('pull_request', closedEvent(), stubbed);

    assert.equal(exitCode, 1);
    const [error] = annotations(lines, 'error');
    assert.match(error, /by hand in mabl\. Master moved past 13 tests: test "Test 0", .*, test "Test 9" and 3 more$/);
    assert.ok(!error.includes('Test 10'), error);
    assert.equal(lines.filter((line) => line.startsWith('mabl branch feature-x: master moved past ')).length, 13);
  });

  it('keeps what to do and the count in the error when names are long, and the full names in the log', async () => {
    const long = (index) => `${'n'.repeat(300)} ${index}`;
    const entities = Array.from({length: 12}, (_, index) => ({id: `t${index}-j`, type: index % 2 ? 'flow' : 'test', name: long(index)}));
    const stubbed = stub({
      mabl: [mergedAnswer('duplicate', landedWith({name: `b${'r'.repeat(199)}`, outcome: 'diverged', diverged_entities: entities}))],
    });
    const {exitCode, lines} = await runWith('pull_request', closedEvent(), stubbed);

    assert.equal(exitCode, 1);
    const [error] = annotations(lines, 'error');
    assert.ok([...error].length <= 500, `${[...error].length}`);
    assert.match(error, /\(as recorded when the pull request merged; a re-run doesn't check the branch again\)\. Merge it into master by hand in mabl\. Master moved past 6 tests and 6 flows: test "n{39}\u2026"/);
    assert.ok(!error.includes('r'.repeat(150)), 'the branch name is cut in the error');
    assert.ok(lines.includes(`mabl branch b${'r'.repeat(199)}: master moved past test "${long(0)}" (t0-j)`));
    const huge = await runWith('pull_request', closedEvent(), stub({mabl: [mergedAnswer('accepted', landedWith({name: 'b', outcome: 'diverged', diverged_entities: [{id: 'x-j', type: 'test', name: 'h'.repeat(5000)}]}))]}));
    assert.ok(huge.lines.includes(`mabl branch b: master moved past test "${'h'.repeat(499)}\u2026" (x-j)`));
    const hugeBranch = await runWith('pull_request', closedEvent(), stub({mabl: [mergedAnswer('accepted', landedWith({name: 'b'.repeat(5000), outcome: 'diverged', diverged_entities: [{id: 'x-j', type: 'test', name: 'T'}]}))]}));
    assert.ok(hugeBranch.lines.includes(`mabl branch ${'b'.repeat(499)}\u2026: master moved past test "T" (x-j)`));
  });

  it('logs at most 200 of a diverged branch\'s tests and flows, then counts the rest', async () => {
    const entities = Array.from({length: 205}, (_, index) => ({id: `t${index}-j`, type: 'test', name: `Test ${index}`}));
    const stubbed = stub({mabl: [mergedAnswer('accepted', landedWith({name: 'feature-x', outcome: 'diverged', diverged_entities: entities}))]});
    const {lines} = await runWith('pull_request', closedEvent(), stubbed);

    assert.equal(lines.filter((line) => line.startsWith('mabl branch feature-x: master moved past ')).length, 200);
    assert.ok(lines.includes('mabl branch feature-x: and 5 more'));
  });

  it("can't be made to forge a workflow command by a branch, test or flow name", async () => {
    const forged = 'x\n::error::forged\r\n%0A \u202e';
    const stubbed = stub({
      mabl: [mergedAnswer('accepted', landedWith({name: forged, outcome: 'diverged', diverged_entities: [{id: forged, type: 'test', name: forged}]}))],
    });
    const {exitCode, lines} = await runWith('pull_request', closedEvent(), stubbed);

    assert.equal(exitCode, 1);
    assert.equal(lines.filter((line) => line.startsWith('::error')).length, 1);
    for (const line of lines) {
      assert.ok(!/[\r\n\u202e]/.test(line), JSON.stringify(line));
    }
  });

  it('passes with a notice when no stage ran on a mabl branch, and with a warning when mabl names no outcome', async () => {
    const none = await runWith('pull_request', closedEvent(), stub({mabl: [mergedAnswer('accepted', landedWith())]}));
    assert.equal(none.exitCode, 0);
    assert.deepEqual(annotations(none.lines, 'notice').slice(1), ["no mabl branch to merge: the pull request's tests didn't run on one"]);

    const older = await runWith('pull_request', closedEvent(), stub({mabl: [mergedAnswer('accepted')]}));
    assert.equal(older.exitCode, 0);
    assert.deepEqual(annotations(older.lines, 'warning'), ["mabl's answer doesn't say what became of the pull request's mabl branch, so check it in mabl"]);

    const malformed = await runWith('pull_request', closedEvent(), stub({mabl: [mergedAnswer('accepted', {merge_commit_sha: 'f'.repeat(40), branches: 'x'})]}));
    assert.equal(malformed.exitCode, 0);
    assert.deepEqual(annotations(malformed.lines, 'warning'), ["mabl's answer doesn't say what became of the pull request's mabl branch, so check it in mabl"]);
  });

  it("reports nothing about a branch for a superseded merge, which is another merge commit's", async () => {
    const stubbed = stub({mabl: [mergedAnswer('superseded', landedWith({name: 'feature-x', outcome: 'diverged'}))]});
    const {exitCode, outputs, lines} = await runWith('pull_request', closedEvent(), stubbed);

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'superseded');
    assert.ok(!lines.some((line) => line.includes('mabl branch')), lines.join('\n'));
  });

  it('warns on an outcome it does not know, and passes, so a newer one never fails the step', async () => {
    const stubbed = stub({mabl: [mergedAnswer('accepted', landedWith({name: 'feature-x', outcome: 'queued'}))]});
    const {exitCode, lines} = await runWith('pull_request', closedEvent(), stubbed);

    assert.equal(exitCode, 0);
    assert.deepEqual(annotations(lines, 'warning'), ["mabl branch feature-x: queued, an outcome this action doesn't know"]);
    assert.deepEqual(annotations(lines, 'error'), []);
  });

  it('waits longer for the merged event, which merges the branch inside the call', async () => {
    const timeouts = [];
    await runWith('pull_request', closedEvent(), stub({mabl: [mergedAnswer('accepted', landedWith())]}), {}, {
      signalAfter: (ms, label) => {
        timeouts.push([label, ms]);
        return new AbortController().signal;
      },
    });
    assert.deepEqual(timeouts, [['events', MERGED_TIMEOUT_MS]]);
  });

  it('never resends a merged event that got no answer or a gateway error, which may still be merging, and says to re-run', async () => {
    for (const [answers, outcome] of [
      [[], 'failed'],
      [[{status: 504, body: '<html>gateway timeout</html>'}], 'failed'],
      [[json(504, {message: 'Gateway Timeout'})], 'failed'],
      [[json(502, {error: {code: 502}})], 'failed'],
      [[json(500, {code: 500, message: 'boom'})], 'failed'],
      [[json(500, {code: 500, error_code: 'internal', message: 'boom'})], 'internal'],
      [[json(503, {})], 'failed'],
    ]) {
      const stubbed = stub({mabl: answers});
      const {exitCode, outputs, lines, delays} = await runWith('pull_request', closedEvent(), stubbed);

      assert.equal(stubbed.mablCalls().length, 1, JSON.stringify(answers));
      assert.deepEqual(delays, []);
      assert.equal(exitCode, 1);
      assert.equal(outputs.outcome, outcome);
      assert.match(annotations(lines, 'error')[0], /mabl may still be merging the mabl branch, so re-run this job in a few minutes to read what it recorded$/);
    }
  });

  it("retries a merged event mabl answered with agent_stopping or a 429, which it finished handling", async () => {
    const stubbed = stub({
      mabl: [
        json(503, {code: 503, error_code: 'agent_stopping', message: 'retry'}),
        json(429, {code: 429, message: 'slow down'}),
        mergedAnswer('accepted', landedWith({name: 'feature-x', outcome: 'merged'})),
      ],
    });
    const {exitCode, delays} = await runWith('pull_request', closedEvent(), stubbed);

    assert.equal(stubbed.mablCalls().length, 3);
    assert.deepEqual(delays, RETRY_DELAYS_MS.slice(0, 2));
    assert.equal(exitCode, 0);
  });

  it("is quiet when the pull request never had a mabl agent", async () => {
    const stubbed = stub({mabl: [json(404, {code: 404, error_code: 'no_change_agent', message: 'no agent'})]});
    const {exitCode, outputs} = await runWith('pull_request', closedEvent(), stubbed);

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'no_change_agent');
  });
});

describe('the built change description', () => {
  it("resolves the policy it sends through the api, with the caller's key, and scopes the paths to the stage's applications", async () => {
    const stubbed = stub();
    await runWith('pull_request', prEvent('opened'), stubbed);

    const [resolve] = stubbed.resolveCalls();
    assert.equal(resolve.url.href, `${MABL}${RESOLVE_PATH}`);
    assert.equal(resolve.headers.authorization, `Basic ${Buffer.from(`${API_KEY}:`).toString('base64')}`);
    assert.deepEqual(JSON.parse(resolve.body), {yaml: POLICY});
    const description = stubbed.sent()[0].change_description;
    assert.equal(description, BUILT);
    assert.equal(description.includes('docs/README.md'), false);
  });

  it('takes an application with no analysis_roots as the whole repository', async () => {
    const stubbed = stub({resolve: RESOLVED({web: {pull_request: {mabl_application: 'web-a'}}})});
    await runWith('pull_request', prEvent('opened'), stubbed);

    assert.match(
      stubbed.sent()[0].change_description,
      /\n- web \(4 files\): frontend\/src\/Checkout\.tsx, backend\/src\/Users\.tsx, shared\/src\/Button\.tsx, docs\/README\.md\n/,
    );
  });

  it('reads every page of the files and lists both names of a rename', async () => {
    const docs = Array.from({length: 149}, (_, index) => ({filename: `docs/page-${index}.md`, status: 'added'}));
    const renamed = {filename: 'frontend/src/New.tsx', previous_filename: 'frontend/src/Old.tsx', status: 'renamed'};
    const stubbed = stub({files: [...docs, renamed], pr: pullRequest({changed_files: 150})});
    await runWith('pull_request', prEvent('opened'), stubbed);

    assert.deepEqual(
      stubbed.fileCalls().map((call) => [call.url.searchParams.get('per_page'), call.url.searchParams.get('page')]),
      [['100', '1'], ['100', '2']],
    );
    assert.match(stubbed.sent()[0].change_description, /\n- web \(2 files\): frontend\/src\/Old\.tsx, frontend\/src\/New\.tsx\n/);
  });

  it("cuts each application's list with a count and keeps the title, inside the events route's cap", async () => {
    const files = Array.from({length: 3000}, (_, index) => ({filename: `frontend/src/${'deep/'.repeat(20)}file-${index}.tsx`}));
    const stages = Object.fromEntries(Array.from({length: 12}, (_, index) => [`app${index}`, {pull_request: {}}]));
    const stubbed = stub({files, resolve: RESOLVED(stages), pr: pullRequest({body: 'why '.repeat(10_000), changed_files: 3000})});
    await runWith('pull_request', prEvent('opened'), stubbed);

    const description = stubbed.sent()[0].change_description;
    assert.ok(description.length <= 20_000, `${description.length}`);
    assert.ok(description.startsWith('Title: Add a thing\n'));
    assert.match(description, /\n- app0 \(3000 files\): [^\n]+ \(\+\d+ more\)\n/);
  });

  it('lists fewer paths for every application rather than lose the last ones, the body or the totals', async () => {
    const files = Array.from({length: 3000}, (_, index) => ({filename: `frontend/src/${'deep/'.repeat(20)}file-${index}.tsx`}));
    const stages = Object.fromEntries(Array.from({length: 12}, (_, index) => [`app${index}`, {pull_request: {}}]));
    const stubbed = stub({files, resolve: RESOLVED(stages), pr: pullRequest({body: 'why '.repeat(10_000), changed_files: 3000})});
    await runWith('pull_request', prEvent('opened'), stubbed);

    const description = stubbed.sent()[0].change_description;
    assert.ok(description.length <= 20_000, `${description.length}`);
    const bullets = description.split('\n').filter((line) => /^- app\d+ \(3000 files\): /.test(line));
    assert.deepEqual(
      bullets.map((line) => /^- (app\d+) /.exec(line)[1]),
      Array.from({length: 12}, (_, index) => `app${index}`),
    );
    const shown = bullets.map((line) => line.split(', ').length);
    assert.ok(shown.every((count) => count === shown[0] && count < 30), `${shown}`);
    assert.match(description, /\nDescription:\n\nwhy why /);
    assert.match(description, /\nDiff stat: 3000 files changed, 30 insertions\(\+\), 5 deletions\(-\)$/);
  });

  it('starts over at the new head when a push lands while the files are listed', async () => {
    const NEW_HEAD = 'd'.repeat(40);
    const moved = pullRequest({head: {...pullRequest().head, sha: NEW_HEAD}});
    const stubbed = stub({pr: [pullRequest(), moved]});
    const {exitCode} = await runWith('pull_request', prEvent('opened'), stubbed);

    assert.equal(exitCode, 0);
    assert.equal(stubbed.fileCalls().length, 2);
    const [body] = stubbed.sent();
    assert.equal(body.event.head_sha, NEW_HEAD);
    assert.equal(body.related_artifacts[0].artifact_data.value.head_sha, NEW_HEAD);
    assert.equal(body.change_description, BUILT);
  });

  it('sends nothing when the head moves again on the second read', async () => {
    const heads = ['d', 'e', 'f'].map((c) => pullRequest({head: {...pullRequest().head, sha: c.repeat(40)}}));
    const stubbed = stub({pr: [pullRequest(), ...heads]});
    const {exitCode, outputs, lines} = await runWith('pull_request', prEvent('opened'), stubbed);

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'skipped');
    assert.equal(stubbed.mablCalls().length, 0);
    assert.match(lines.join('\n'), /moved from e{40} on main at b{40} to f{40} on main at b{40} while its files were listed/);
  });

  it("starts over when the base moves while the files are listed, though its branch doesn't change", async () => {
    const NEW_BASE = 'e'.repeat(40);
    const advanced = pullRequest({base: {...pullRequest().base, sha: NEW_BASE}});
    const stubbed = stub({pr: [pullRequest(), advanced]});
    await runWith('pull_request', prEvent('opened'), stubbed);

    assert.equal(stubbed.fileCalls().length, 2);
    assert.equal(stubbed.sent()[0].event.base_sha, NEW_BASE);
  });

  it("says when GitHub couldn't list every changed file", async () => {
    const files = Array.from({length: 3000}, (_, index) => ({filename: `frontend/src/file-${index}.tsx`}));
    const stubbed = stub({files, pr: pullRequest({changed_files: 3500})});
    await runWith('pull_request', prEvent('opened'), stubbed);

    assert.match(
      stubbed.sent()[0].change_description,
      /\nChanged paths per mabl application, by the policy's analysis_roots \(GitHub lists at most 3,000 of a pull request's files and this one changes 3500, so some applications may be missing\):\n/,
    );
  });

  it('starts over when the pull request is retargeted while the files are listed', async () => {
    const NEW_BASE = 'e'.repeat(40);
    const retargeted = pullRequest({base: {...pullRequest().base, sha: NEW_BASE, ref: 'release'}});
    const stubbed = stub({pr: [pullRequest(), retargeted]});
    await runWith('pull_request', prEvent('opened'), stubbed);

    assert.equal(stubbed.fileCalls().length, 2);
    assert.equal(stubbed.sent()[0].event.base_sha, NEW_BASE);
  });

  it('keeps every application when even one path each would pass the cap, listing only names and counts', async () => {
    const long = `${'a/'.repeat(999)}x.ts`;
    const stages = Object.fromEntries(Array.from({length: 12}, (_, index) => [`app${index}`, {pull_request: {}}]));
    const stubbed = stub({files: [{filename: long}], resolve: RESOLVED(stages), pr: pullRequest({changed_files: 1})});
    await runWith('pull_request', prEvent('opened'), stubbed);

    const description = stubbed.sent()[0].change_description;
    assert.ok(description.length <= 20_000, `${description.length}`);
    for (let index = 0; index < 12; index += 1) {
      assert.match(description, new RegExp(`\\n- app${index} \\(1 file\\)`));
    }
    assert.match(description, /\nDescription:\n\nWhy it matters\n/);
    assert.match(description, /\nDiff stat: 1 file changed/);
  });

  it("sends nothing for a caller's own description when a push lands while the files are listed, since it describes the older head", async () => {
    const NEW_HEAD = 'd'.repeat(40);
    const stubbed = stub({pr: [pullRequest(), pullRequest({head: {...pullRequest().head, sha: NEW_HEAD}})]});
    const {exitCode, outputs, lines} = await runWith('pull_request', prEvent('opened'), stubbed, {
      CHANGE_DESCRIPTION: 'Mine',
      CHANGE_DESCRIPTION_HEAD_SHA: HEAD,
    });

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'skipped');
    assert.equal(stubbed.mablCalls().length, 0);
    assert.match(lines.join('\n'), new RegExp(`written for ${HEAD}, and the head is now ${NEW_HEAD}`));
  });

  for (const [name, overrides, notice] of [
    ['the api fails to resolve the policy', {resolve: json(500, {message: 'boom'})}, /HTTP 500/],
    ['the api finds the policy invalid', {resolve: json(200, {valid: false, errors: [{message: 'bad'}]})}, /not valid/],
    ['the base has no policy', {policy: json(404, {message: 'Not Found'})}, null],
    ['no application has the stage', {resolve: RESOLVED({admin: {release: {}}})}, null],
  ]) {
    it(`lists every changed path under one heading when ${name}`, async () => {
      const stubbed = stub(overrides);
      const {exitCode, outputs, lines} = await runWith('pull_request', prEvent('opened'), stubbed);

      assert.equal(exitCode, 0);
      assert.equal(outputs['description-source'], 'built');
      assert.match(
        stubbed.sent()[0].change_description,
        /\n\nChanged paths:\n- repository \(4 files\): frontend\/src\/Checkout\.tsx, backend\/src\/Users\.tsx, shared\/src\/Button\.tsx, docs\/README\.md\n\n/,
      );
      const notices = lines.filter((line) => line.startsWith('::notice') && line.includes('without grouping'));
      if (notice) {
        assert.equal(notices.length, 1);
        assert.match(notices[0], notice);
      } else {
        assert.equal(notices.length, 0);
      }
    });
  }

  it("doesn't ask the api to resolve a policy the base doesn't have", async () => {
    const stubbed = stub({policy: json(404, {message: 'Not Found'})});
    await runWith('pull_request', prEvent('opened'), stubbed);

    assert.equal(stubbed.resolveCalls().length, 0);
  });

  it("fails, sending nothing, when GitHub can't list the files", async () => {
    const stubbed = stub({filesAnswer: json(502, {message: 'Bad Gateway'})});
    const {exitCode, outputs, lines} = await runWith('pull_request', prEvent('opened'), stubbed);

    assert.equal(exitCode, 1);
    assert.equal(outputs.outcome, 'failed');
    assert.equal(stubbed.mablCalls().length, 0);
    assert.match(lines.join('\n'), /files answered HTTP 502/);
  });
});

// A fork's run gets no secrets, so these run without a key.
const NO_KEY = {MABL_API_KEY: ''};

describe('a fork', () => {
  for (const [name, head] of [
    ['another repository', {sha: HEAD, ref: 'f', repo: {id: 2002, full_name: 'Someone/Repo'}}],
    ['a deleted head repository', {sha: HEAD, ref: 'f', repo: null}],
  ]) {
    it(`is refused for ${name}, before reading the policy`, async () => {
      const stubbed = stub({pr: pullRequest({head})});
      const {exitCode, outputs} = await runWith('pull_request', prEvent('opened'), stubbed, NO_KEY);

      assert.equal(exitCode, 0);
      assert.equal(outputs.outcome, 'refused');
      assert.deepEqual(
        stubbed.calls.map((call) => call.url.pathname),
        ['/repos/Org/Repo/pulls/7'],
      );
    });
  }

  it("is refused for a comment's request too", async () => {
    const stubbed = stub({pr: pullRequest({head: {sha: HEAD, ref: 'f', repo: {id: 2002}}})});
    const {outputs} = await runWith('issue_comment', commentEvent('MEMBER'), stubbed, {...NO_KEY, CHANGE_VALIDATION_COMMAND: 'author 2'});

    assert.equal(outputs.outcome, 'refused');
    assert.equal(stubbed.mablCalls().length, 0);
  });
});

describe("a comment's request", () => {
  it("asks for the caller's stage at the current head with the commenter's text, keyed by the comment and timed at it", async () => {
    const stubbed = stub({mabl: [json(200, {session_id: 's1-as', created: false, event: 'accepted', agent: 'working'})]});
    const {exitCode, outputs, lines} = await runWith('issue_comment', commentEvent('COLLABORATOR'), stubbed, {
      CHANGE_VALIDATION_COMMAND: ' run it again, focusing on the checkout page ',
      CHANGE_VALIDATION_DRY_RUN: 'true',
    });

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'accepted');
    assert.equal(outputs.created, 'false');
    assert.equal(outputs['description-source'], 'built');
    assert.equal(outputs['pull-request-number'], '7');
    const [body, ...more] = stubbed.sent();
    assert.deepEqual(more, []);
    assert.deepEqual(body.event, {
      kind: 'stage.requested',
      stage: 'pull_request',
      head_sha: HEAD,
      base_sha: BASE,
      head_ref: 'feature/thing',
      occurred_at: Date.parse(COMMENTED_AT),
      labels: LABELS,
      changed_paths: PATHS,
      changed_paths_truncated: false,
      pull_request_head_sha: HEAD,
      command: 'run it again, focusing on the checkout page',
    });
    assert.equal('idempotency_key' in body, false);
    assert.equal(body.dry_run, true);
    assert.equal(body.change_description, BUILT);
    assert.equal(body.related_artifacts[0].artifact_data.value.text, POLICY);
    assert.ok(lines.some((line) => line.startsWith('::notice') && line.includes("stage pull_request with the comment's request: accepted")));
  });

  it('keeps the same time on a retry and on a re-run of the job', async () => {
    const retried = stub({mabl: [json(503, {error_code: 'agent_stopping'}), ACCEPTED]});
    await runWith('issue_comment', commentEvent('MEMBER'), retried, {CHANGE_VALIDATION_COMMAND: 're-run this'});
    const rerun = stub();
    await runWith('issue_comment', commentEvent('MEMBER'), rerun, {CHANGE_VALIDATION_COMMAND: 're-run this', GITHUB_RUN_ATTEMPT: '3'});

    const bodies = [...retried.sent(), ...rerun.sent()];
    assert.equal(bodies.length, 3);
    assert.deepEqual(new Set(bodies.map((body) => body.event.occurred_at)), new Set([Date.parse(COMMENTED_AT)]));
  });

  it('needs a stage, as any stage request does', async () => {
    const stubbed = stub();
    const {exitCode, lines} = await runWith('issue_comment', commentEvent('MEMBER'), stubbed, {
      CHANGE_VALIDATION_COMMAND: 'author 2',
      CHANGE_VALIDATION_STAGE: '',
    });

    assert.equal(exitCode, 1);
    assert.equal(stubbed.mablCalls().length, 0);
    assert.match(lines.join('\n'), /stage is required/);
  });

  it('takes 2,000 characters, and fails, sending nothing, on more', async () => {
    const taken = stub();
    await runWith('issue_comment', commentEvent('MEMBER'), taken, {CHANGE_VALIDATION_COMMAND: 'x'.repeat(2_000)});
    assert.equal(taken.sent()[0].event.command.length, 2_000);

    const stubbed = stub();
    const {exitCode, outputs, lines} = await runWith('issue_comment', commentEvent('MEMBER'), stubbed, {CHANGE_VALIDATION_COMMAND: 'x'.repeat(2_001)});
    assert.equal(exitCode, 1);
    assert.equal(outputs.outcome, 'failed');
    assert.equal(stubbed.mablCalls().length, 0);
    assert.match(lines.join('\n'), /the request after the trigger word is 2001 characters, over the 2000 mabl takes/);
  });

  for (const [label, comment] of [
    ['no creation time', {created_at: undefined}],
    ['a creation time that is not one', {created_at: 'yesterday'}],
  ]) {
    it(`fails, sending nothing, when the comment has ${label}`, async () => {
      const stubbed = stub();
      const payload = commentEvent('MEMBER');
      const {exitCode} = await runWith('issue_comment', {...payload, comment: {...payload.comment, ...comment}}, stubbed, {CHANGE_VALIDATION_COMMAND: 'author 2'});

      assert.equal(exitCode, 1);
      assert.equal(stubbed.mablCalls().length, 0);
    });
  }

  for (const [label, permission] of [
    ['read access only', json(200, {permission: 'read'})],
    ['triage access only', json(200, {permission: 'triage'})],
    ['no access', json(404, {message: 'Not Found'})],
  ]) {
    it(`is refused from an org member with ${label}`, async () => {
      const stubbed = stub({permission});
      const {exitCode, outputs} = await runWith('issue_comment', commentEvent('MEMBER'), stubbed, {
        CHANGE_VALIDATION_COMMAND: 'author 2',
      });

      assert.equal(exitCode, 0);
      assert.equal(outputs.outcome, 'refused');
      assert.equal(stubbed.mablCalls().length, 0);
    });
  }

  it('fails, sending nothing, when the permission read fails', async () => {
    const stubbed = stub({permission: json(500, {message: 'boom'})});
    const {exitCode} = await runWith('issue_comment', commentEvent('MEMBER'), stubbed, {CHANGE_VALIDATION_COMMAND: 'author 2'});

    assert.equal(exitCode, 1);
    assert.equal(stubbed.mablCalls().length, 0);
  });

  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', undefined]) {
    it(`is refused from a commenter who is ${association ?? 'unknown'}`, async () => {
      const stubbed = stub();
      const {exitCode, outputs} = await runWith('issue_comment', commentEvent(association), stubbed, {
        CHANGE_VALIDATION_COMMAND: 'author 2',
      });

      assert.equal(exitCode, 0);
      assert.equal(outputs.outcome, 'refused');
      assert.equal(stubbed.calls.length, 0);
    });
  }

  it('is skipped on an issue that is not a pull request', async () => {
    const stubbed = stub();
    const {outputs} = await runWith('issue_comment', commentEvent('MEMBER', {issue: {number: 7}}), stubbed, {
      CHANGE_VALIDATION_COMMAND: 'author 2',
    });

    assert.equal(outputs.outcome, 'skipped');
    assert.equal(stubbed.calls.length, 0);
  });

  for (const action of ['edited', 'deleted']) {
    it(`is skipped when the comment is ${action}`, async () => {
      const stubbed = stub();
      const {exitCode, outputs} = await runWith('issue_comment', commentEvent('MEMBER', {action}), stubbed, {
        CHANGE_VALIDATION_COMMAND: 'author 2',
      });

      assert.equal(exitCode, 0);
      assert.equal(outputs.outcome, 'skipped');
      assert.equal(stubbed.calls.length, 0);
    });
  }
});

describe('the trigger word alone', () => {
  for (const command of ['', '  \t ']) {
    it(`asks for the caller's stage at the current head, starting the agent, when the command is ${JSON.stringify(command)}`, async () => {
      const stubbed = stub();
      const {exitCode, outputs} = await runWith('issue_comment', commentEvent('MEMBER'), stubbed, {
        CHANGE_VALIDATION_COMMAND: command,
      });

      assert.equal(exitCode, 0);
      assert.equal(outputs.created, 'true');
      const [body] = stubbed.sent();
      assert.deepEqual(body.event, {
        kind: 'stage.requested',
        stage: 'pull_request',
        head_sha: HEAD,
        base_sha: BASE,
        head_ref: 'feature/thing',
        occurred_at: Date.parse(UPDATED_AT),
        labels: LABELS,
        changed_paths: PATHS,
        changed_paths_truncated: false,
        pull_request_head_sha: HEAD,
      });
      assert.equal(body.related_artifacts[0].artifact_data.value.text, POLICY);
      assert.equal(body.idempotency_key, undefined);
      assert.equal('command' in body.event, false);
    });
  }

  it('is refused from an org member with read access only', async () => {
    const stubbed = stub({permission: json(200, {permission: 'read'})});
    const {exitCode, outputs} = await runWith('issue_comment', commentEvent('MEMBER'), stubbed);

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'refused');
    assert.equal(stubbed.mablCalls().length, 0);
    assert.equal(stubbed.calls.some((call) => call.url.pathname.includes('/contents/')), false);
  });

  it('is refused on a fork', async () => {
    const stubbed = stub({pr: pullRequest({head: {sha: HEAD, ref: 'f', repo: {id: 2002}}})});
    const {outputs} = await runWith('issue_comment', commentEvent('MEMBER'), stubbed, NO_KEY);

    assert.equal(outputs.outcome, 'refused');
    assert.equal(stubbed.mablCalls().length, 0);
  });
});

describe('the trigger-word input', () => {
  const WORD = {CHANGE_VALIDATION_TRIGGER_WORD: '/mabl', CHANGE_VALIDATION_COMMAND: 'not this'};
  const commentOf = (body, association = 'MEMBER') => {
    const payload = commentEvent(association);
    return {...payload, comment: {...payload.comment, body}};
  };

  it("sends the rest of the comment's first line as the request, not the command input", async () => {
    const stubbed = stub();
    const {exitCode} = await runWith('issue_comment', commentOf('/mabl  author 2 \r\nand a second line'), stubbed, WORD);

    assert.equal(exitCode, 0);
    assert.equal(stubbed.sent()[0].event.kind, 'stage.requested');
    assert.equal(stubbed.sent()[0].event.command, 'author 2');
  });

  for (const body of ['/mabl', '/mabl ', '/mabl\nplease']) {
    it(`asks for the stage at the current head when the comment is ${JSON.stringify(body)}`, async () => {
      const stubbed = stub();
      const {exitCode} = await runWith('issue_comment', commentOf(body), stubbed, WORD);

      assert.equal(exitCode, 0);
      assert.equal(stubbed.sent()[0].event.kind, 'stage.requested');
      assert.equal(stubbed.sent()[0].event.head_sha, HEAD);
      assert.equal('command' in stubbed.sent()[0].event, false);
      assert.equal('idempotency_key' in stubbed.sent()[0], false);
    });
  }

  for (const body of ['looks good', '/mablx author 2', ' /mabl', 'please /mabl', '']) {
    it(`skips the comment ${JSON.stringify(body)} from anyone, before checking who wrote it`, async () => {
      const stubbed = stub();
      const {exitCode, outputs} = await runWith('issue_comment', commentOf(body, 'NONE'), stubbed, WORD);

      assert.equal(exitCode, 0);
      assert.equal(outputs.outcome, 'skipped');
      assert.equal(stubbed.calls.length, 0);
    });
  }

  it('still refuses a commenter who is not trusted', async () => {
    const stubbed = stub();
    const {outputs} = await runWith('issue_comment', commentOf('/mabl author 2', 'NONE'), stubbed, WORD);

    assert.equal(outputs.outcome, 'refused');
    assert.equal(stubbed.calls.length, 0);
  });
});

const QUEUE_HEAD = 'd'.repeat(40);
// The entry ahead in the queue: the queue commit's first parent, which is not the target branch's base.
const QUEUE_PARENT = '1'.repeat(40);
const QUEUE_BASE = 'e'.repeat(40);
// A squash queue's commit: the pull request's head is not among its parents.
const QUEUE_COMMITS = {[QUEUE_HEAD]: json(200, {sha: QUEUE_HEAD, parents: [{sha: QUEUE_PARENT}]})};
const QUEUED_AT = '2026-11-05T15:00:00Z';
// GitHub's GraphQL answer for PR 7: its head and the queue commit of its merge queue entry, if any.
function queueEntry({head = HEAD, entry = QUEUE_HEAD, merged = null} = {}) {
  return json(200, {
    data: {repository: {pullRequest: {headRefOid: head, mergeCommit: merged ? {oid: merged} : null, mergeQueueEntry: entry ? {headCommit: {oid: entry}} : null}}},
  });
}
const mergeGroup = (action = 'checks_requested', extra = {}) => ({
  action,
  merge_group: {
    head_sha: QUEUE_HEAD,
    head_ref: `refs/heads/gh-readonly-queue/main/pr-7-${'f'.repeat(40)}`,
    base_sha: QUEUE_BASE,
    base_ref: 'refs/heads/main',
    head_commit: {id: QUEUE_HEAD, timestamp: QUEUED_AT},
    ...extra,
  },
});

describe('a merge_group entry', () => {
  it("asks for the caller's stage at the queue's commit over its first parent, for the entry's pull request, with the policy read at the merge group's base", async () => {
    const stubbed = stub({commits: QUEUE_COMMITS});
    const {exitCode} = await runWith('merge_group', mergeGroup(), stubbed, {CHANGE_VALIDATION_DRY_RUN: 'true', CHANGE_VALIDATION_STAGE: 'merge_queue'});

    assert.equal(exitCode, 0);
    const contents = stubbed.calls.find((call) => call.url.pathname.includes('/contents/'));
    assert.equal(contents.url.searchParams.get('ref'), QUEUE_BASE);
    const [body] = stubbed.sent();
    assert.equal(body.reference.id, 'github.com/org/repo#7');
    assert.deepEqual(body.event, {
      kind: 'stage.requested',
      stage: 'merge_queue',
      head_sha: QUEUE_HEAD,
      base_sha: QUEUE_PARENT,
      head_ref: 'feature/thing',
      occurred_at: Date.parse(QUEUED_AT),
      labels: LABELS,
      changed_paths: PATHS,
      changed_paths_truncated: false,
      pull_request_head_sha: HEAD,
    });
    const {value} = body.related_artifacts[0].artifact_data;
    assert.equal(value.head_sha, QUEUE_HEAD);
    assert.equal(value.base_sha, QUEUE_BASE);
    assert.equal(value.head_ref, 'feature/thing');
    // The caller's stage picks the applications: admin has no merge_queue stage.
    assert.equal(
      body.change_description,
      BUILT.replace('\n- admin (2 files): backend/src/Users.tsx, shared/src/Button.tsx', ''),
    );
    assert.equal(body.dry_run, true);
    const [graphql] = stubbed.graphqlCalls();
    assert.equal(graphql.method, 'POST');
    assert.equal(graphql.headers.Authorization, 'Bearer ghs_test');
    assert.deepEqual(JSON.parse(graphql.body).variables, {owner: 'Org', name: 'Repo', number: 7});
    // From the merge group's base, as the build filter compares, not the first parent: under a rebase
    // queue the first parent is the pull request's own previous commit.
    assert.deepEqual(
      stubbed.compareCalls().map((call) => call.url.pathname),
      [`/repos/Org/Repo/compare/${QUEUE_BASE}...${QUEUE_HEAD}`],
    );
    assert.equal(stubbed.fileCalls().length, 0);
  });

  it('sends dry_run false on a queue entry when the input is not true', async () => {
    const stubbed = stub({commits: QUEUE_COMMITS});
    await runWith('merge_group', mergeGroup(), stubbed, {CHANGE_VALIDATION_DRY_RUN: 'false', CHANGE_VALIDATION_STAGE: 'merge_queue'});

    assert.equal(stubbed.sent()[0].dry_run, false);
  });

  it('skips an action other than checks_requested', async () => {
    const stubbed = stub();
    const {outputs} = await runWith('merge_group', mergeGroup('destroyed'), stubbed);

    assert.equal(outputs.outcome, 'skipped');
    assert.equal(stubbed.calls.length, 0);
  });

  it('fails, sending nothing, when the queue ref names no pull request', async () => {
    const stubbed = stub();
    const {exitCode} = await runWith('merge_group', mergeGroup('checks_requested', {head_ref: 'refs/heads/main'}), stubbed);

    assert.equal(exitCode, 1);
    assert.equal(stubbed.calls.length, 0);
  });

  it('fails, sending nothing, when the queue commit has no parent to read', async () => {
    const stubbed = stub({commits: {[QUEUE_HEAD]: json(404, {message: 'Not Found'})}});
    const {exitCode} = await runWith('merge_group', mergeGroup(), stubbed);

    assert.equal(exitCode, 1);
    assert.equal(stubbed.mablCalls().length, 0);
  });

  it('fails, sending nothing, when the merge group has no base to read the policy at', async () => {
    const stubbed = stub({commits: QUEUE_COMMITS});
    const {exitCode} = await runWith('merge_group', mergeGroup('checks_requested', {base_sha: ''}), stubbed);

    assert.equal(exitCode, 1);
    assert.equal(stubbed.mablCalls().length, 0);
  });

  it("checks a caller's description against the queue's commit, not the pull request's head", async () => {
    const described = {CHANGE_DESCRIPTION: 'What the queue entry does'};
    const matching = stub({commits: QUEUE_COMMITS});
    await runWith('merge_group', mergeGroup(), matching, {...described, CHANGE_DESCRIPTION_HEAD_SHA: QUEUE_HEAD});
    assert.equal(matching.sent()[0].change_description, 'What the queue entry does');

    const atPullRequestHead = stub({commits: QUEUE_COMMITS});
    const {outputs} = await runWith('merge_group', mergeGroup(), atPullRequestHead, {...described, CHANGE_DESCRIPTION_HEAD_SHA: HEAD});
    assert.equal(outputs.outcome, 'skipped');
    assert.equal(atPullRequestHead.mablCalls().length, 0);
  });

  it('reads the pull request once, since its later pushes and base moves cannot change the queue commit', async () => {
    const moved = pullRequest({head: {...pullRequest().head, sha: 'd'.repeat(40)}, base: {...pullRequest().base, sha: 'c'.repeat(40)}});
    const stubbed = stub({commits: QUEUE_COMMITS, pr: [pullRequest(), moved]});
    const {outputs} = await runWith('merge_group', mergeGroup(), stubbed, {CHANGE_VALIDATION_STAGE: 'merge_queue'});

    assert.equal(outputs.outcome, 'accepted');
    assert.equal(stubbed.calls.filter((call) => call.url.pathname === '/repos/Org/Repo/pulls/7').length, 1);
    assert.equal(stubbed.sent()[0].event.pull_request_head_sha, HEAD);
    assert.equal(stubbed.sent()[0].event.changed_paths_truncated, false);
  });

  it("is refused for a fork's pull request", async () => {
    const stubbed = stub({pr: pullRequest({head: {sha: HEAD, ref: 'f', repo: {id: 2002}}})});
    const {outputs} = await runWith('merge_group', mergeGroup(), stubbed, NO_KEY);

    assert.equal(outputs.outcome, 'refused');
    assert.equal(stubbed.mablCalls().length, 0);
  });
});

const warningsOf = (lines) => lines.filter((line) => line.startsWith('::warning'));

describe('mabl_branch', () => {
  it('reads the first Mabl branch line, in either case, with or without backticks', () => {
    assert.equal(mablBranchFromDescription('Why\n\nMabl branch: checkout-tests\nmabl branch: other'), 'checkout-tests');
    assert.equal(mablBranchFromDescription('  MABL BRANCH:   `checkout-tests`  '), 'checkout-tests');
    assert.equal(mablBranchFromDescription('Why\r\nMabl branch: checkout-tests\r\n'), 'checkout-tests');
  });

  it('skips lines in code fences and HTML comments, and lines with more than a name', () => {
    const body = [
      '```',
      'Mabl branch: <name>',
      'Mabl branch: from-a-fence',
      '```',
      '<!--',
      'Mabl branch: from-a-comment',
      '-->',
      'See the Mabl branch: line below',
      'Mabl branch: two words',
      'Mabl branch: the-real-one',
    ].join('\n');
    assert.equal(mablBranchFromDescription(body), 'the-real-one');
  });

  it('reads HTML comment delimiters in order, across and within lines', () => {
    const reopened = ['<!-- template note --> <!--', 'Mabl branch: example', '-->', 'Mabl branch: the-real-one'].join('\n');
    assert.equal(mablBranchFromDescription(reopened), 'the-real-one');
    const closeThenOpen = ['<!--', 'note', '--> text <!--', 'Mabl branch: example', '-->', 'Mabl branch: the-real-one'].join('\n');
    assert.equal(mablBranchFromDescription(closeThenOpen), 'the-real-one');
    const closedOnOneLine = ['<!-- a --> <!-- b -->', 'Mabl branch: the-real-one'].join('\n');
    assert.equal(mablBranchFromDescription(closedOnOneLine), 'the-real-one');
  });

  it('skips tilde fences and longer fences, closed only by a matching fence', () => {
    const tilde = ['~~~', 'Mabl branch: from-tildes', '~~~', 'Mabl branch: the-real-one'].join('\n');
    assert.equal(mablBranchFromDescription(tilde), 'the-real-one');
    const longer = ['````md', '```', 'Mabl branch: inside-a-longer-fence', '```', '````', 'Mabl branch: the-real-one'].join('\n');
    assert.equal(mablBranchFromDescription(longer), 'the-real-one');
    const mixed = ['~~~', '```', 'Mabl branch: still-fenced', '~~~', 'Mabl branch: the-real-one'].join('\n');
    assert.equal(mablBranchFromDescription(mixed), 'the-real-one');
    const withInfo = ['```yaml', 'Mabl branch: from-yaml', '``` not a close', 'Mabl branch: still-fenced', '```', 'Mabl branch: the-real-one'].join('\n');
    assert.equal(mablBranchFromDescription(withInfo), 'the-real-one');
  });

  it('finds none in an empty or missing description', () => {
    assert.equal(mablBranchFromDescription(''), null);
    assert.equal(mablBranchFromDescription(null), null);
    assert.equal(mablBranchFromDescription('Why it matters'), null);
  });

  it('sends the named branch on a pull request stage request and leaves it out when none is named', async () => {
    const named = stub({pr: pullRequest({body: 'Why\n\nMabl branch: checkout-tests'})});
    await runWith('pull_request', prEvent('opened'), named);
    assert.equal(named.sent()[0].event.mabl_branch, 'checkout-tests');

    const unnamed = stub();
    await runWith('pull_request', prEvent('opened'), unnamed);
    assert.equal('mabl_branch' in unnamed.sent()[0].event, false);
  });

  it("sends the entry's pull request's named branch on a queue entry", async () => {
    const stubbed = stub({commits: QUEUE_COMMITS, pr: pullRequest({body: 'Mabl branch: checkout-tests'})});
    await runWith('merge_group', mergeGroup(), stubbed, {CHANGE_VALIDATION_STAGE: 'merge_queue'});

    assert.equal(stubbed.sent()[0].event.mabl_branch, 'checkout-tests');
  });

  it('leaves out a name over 200 characters, with a warning, and still sends', async () => {
    const stubbed = stub({pr: pullRequest({body: `Mabl branch: ${'b'.repeat(201)}`})});
    const {outputs, lines} = await runWith('pull_request', prEvent('opened'), stubbed);

    assert.equal(outputs.outcome, 'accepted');
    assert.equal('mabl_branch' in stubbed.sent()[0].event, false);
    assert.ok(lines.some((line) => line.startsWith('::warning') && line.includes('sent without mabl_branch')));
  });
});

describe('changed_paths', () => {
  it('sends both names of a rename, from every page of the files', async () => {
    const docs = Array.from({length: 149}, (_, index) => ({filename: `docs/page-${index}.md`, status: 'added'}));
    const renamed = {filename: 'frontend/src/New.tsx', previous_filename: 'frontend/src/Old.tsx', status: 'renamed'};
    const stubbed = stub({files: [...docs, renamed], pr: pullRequest({changed_files: 150})});
    await runWith('pull_request', prEvent('opened'), stubbed);

    const {event} = stubbed.sent()[0];
    assert.deepEqual(event.changed_paths, [...docs.map((file) => file.filename), 'frontend/src/Old.tsx', 'frontend/src/New.tsx']);
    assert.equal(event.changed_paths_truncated, false);
  });

  it("sends a queue entry's own commit's paths, not its pull request's", async () => {
    // The pull request's files are listed against its merge base, which can hold files the queue
    // commit doesn't change: here a docs change already on the base the entry was built on.
    const renamed = {filename: 'mobile/src/New.ts', previous_filename: 'mobile/src/Old.ts', status: 'renamed', additions: 3, deletions: 1};
    const stubbed = stub({
      commits: QUEUE_COMMITS,
      files: [{filename: 'docs/strings.json'}, renamed],
      entryFiles: [renamed],
      pr: pullRequest({changed_files: 2}),
    });
    await runWith('merge_group', mergeGroup(), stubbed, {CHANGE_VALIDATION_STAGE: 'merge_queue'});

    assert.equal(stubbed.fileCalls().length, 0);
    const [body] = stubbed.sent();
    assert.deepEqual(body.event.changed_paths, ['mobile/src/Old.ts', 'mobile/src/New.ts']);
    assert.equal(body.event.changed_paths_truncated, false);
    assert.match(body.change_description, /Diff stat: 1 file changed, 3 insertions\(\+\), 1 deletion\(-\)$/);
  });

  it("marks a queue entry's paths truncated at GitHub's 300 compared files, and leaves out the totals", async () => {
    const entryFiles = Array.from({length: 300}, (_, index) => ({filename: `frontend/src/file-${index}.tsx`, additions: 1}));
    const stubbed = stub({commits: QUEUE_COMMITS, entryFiles});
    await runWith('merge_group', mergeGroup(), stubbed, {CHANGE_VALIDATION_STAGE: 'merge_queue'});

    const [body] = stubbed.sent();
    assert.equal(body.event.changed_paths.length, 300);
    assert.equal(body.event.changed_paths_truncated, true);
    assert.match(body.change_description, /GitHub lists at most 300 of a comparison's files/);
    assert.doesNotMatch(body.change_description, /Diff stat/);
  });

  it("keeps a queue entry's paths whole below 300 compared files", async () => {
    const entryFiles = Array.from({length: 299}, (_, index) => ({filename: `frontend/src/file-${index}.tsx`}));
    const stubbed = stub({commits: QUEUE_COMMITS, entryFiles});
    await runWith('merge_group', mergeGroup(), stubbed, {CHANGE_VALIDATION_STAGE: 'merge_queue'});

    assert.equal(stubbed.sent()[0].event.changed_paths_truncated, false);
  });

  it("fails a queue entry with a built description, sending nothing, when GitHub can't compare its commit", async () => {
    const stubbed = stub({commits: QUEUE_COMMITS, compareAnswer: json(502, {message: 'Bad Gateway'})});
    const {exitCode} = await runWith('merge_group', mergeGroup(), stubbed, {CHANGE_VALIDATION_STAGE: 'merge_queue'});

    assert.equal(exitCode, 1);
    assert.equal(stubbed.mablCalls().length, 0);
  });

  it("sends a queue entry with a caller's description without them, warning, when GitHub can't compare its commit", async () => {
    const stubbed = stub({commits: QUEUE_COMMITS, compareAnswer: json(502, {message: 'Bad Gateway'})});
    const {outputs, lines} = await runWith('merge_group', mergeGroup(), stubbed, {
      CHANGE_VALIDATION_STAGE: 'merge_queue',
      CHANGE_DESCRIPTION: 'Mine',
      CHANGE_DESCRIPTION_HEAD_SHA: QUEUE_HEAD,
    });

    assert.equal(outputs.outcome, 'accepted');
    assert.equal('changed_paths' in stubbed.sent()[0].event, false);
    const warnings = warningsOf(lines);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /sent without changed_paths: comparing e{40}\.\.\.d{40} answered HTTP 502/);
  });

  it('marks them truncated when the pull request changes more files than GitHub lists', async () => {
    const files = Array.from({length: 3000}, (_, index) => ({filename: `frontend/src/file-${index}.tsx`}));
    const stubbed = stub({files, pr: pullRequest({changed_files: 3500})});
    await runWith('pull_request', prEvent('opened'), stubbed);

    const {event} = stubbed.sent()[0];
    assert.equal(event.changed_paths.length, 3000);
    assert.equal(event.changed_paths_truncated, true);
  });

  it("cuts them at the route's 3,000 and marks them truncated when renames push past it", async () => {
    const files = Array.from({length: 1600}, (_, index) => ({filename: `new/${index}.ts`, previous_filename: `old/${index}.ts`}));
    const stubbed = stub({files, pr: pullRequest({changed_files: 1600})});
    await runWith('pull_request', prEvent('opened'), stubbed);

    const {event} = stubbed.sent()[0];
    assert.equal(event.changed_paths.length, 3000);
    assert.equal(event.changed_paths_truncated, true);
  });

  it('sends exactly 3,000 paths untruncated', async () => {
    const files = Array.from({length: 3000}, (_, index) => ({filename: `frontend/src/file-${index}.tsx`}));
    const stubbed = stub({files, pr: pullRequest({changed_files: 3000})});
    await runWith('pull_request', prEvent('opened'), stubbed);

    const {event} = stubbed.sent()[0];
    assert.equal(event.changed_paths.length, 3000);
    assert.equal(event.changed_paths_truncated, false);
  });

  it('leaves out a path over 1,024 characters and marks them truncated, keeping one of exactly 1,024', async () => {
    const atLimit = `${'a'.repeat(1021)}.ts`;
    const overLimit = `${'b'.repeat(1022)}.ts`;
    const stubbed = stub({files: [{filename: atLimit}, {filename: overLimit}], pr: pullRequest({changed_files: 2})});
    await runWith('pull_request', prEvent('opened'), stubbed);

    const {event} = stubbed.sent()[0];
    assert.deepEqual(event.changed_paths, [atLimit]);
    assert.equal(event.changed_paths_truncated, true);
  });

  for (const [name, overrides, failReread] of [
    ['the files', {filesAnswer: json(502, {message: 'Bad Gateway'})}, false],
    ['the pull request again', {}, true],
  ]) {
    it(`sends a caller's description without them, warning, when GitHub can't read ${name}`, async () => {
      const stubbed = stub(overrides);
      if (failReread) {
        let reads = 0;
        const {fetchImpl} = stubbed;
        stubbed.fetchImpl = async (url, init) => {
          if (new URL(url).pathname === '/repos/Org/Repo/pulls/7' && (reads += 1) > 1) {
            return new Response('{}', {status: 503});
          }
          return fetchImpl(url, init);
        };
      }
      const {exitCode, outputs, lines} = await runWith('pull_request', prEvent('opened'), stubbed, {
        CHANGE_DESCRIPTION: 'Mine',
        CHANGE_DESCRIPTION_HEAD_SHA: HEAD,
      });

      assert.equal(exitCode, 0);
      assert.equal(outputs.outcome, 'accepted');
      const [body] = stubbed.sent();
      assert.equal(body.change_description, 'Mine');
      assert.equal('changed_paths' in body.event, false);
      assert.equal('changed_paths_truncated' in body.event, false);
      assert.equal(body.event.pull_request_head_sha, HEAD);
      const warnings = warningsOf(lines);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /sent without changed_paths: .*HTTP 50[23]/);
    });
  }
});

describe('pull_request_head_sha on a queue entry', () => {
  const sendEntry = async (graphql) => {
    const stubbed = stub({commits: QUEUE_COMMITS, graphql});
    const result = await runWith('merge_group', mergeGroup(), stubbed, {CHANGE_VALIDATION_STAGE: 'merge_queue'});
    return {...result, stubbed, body: stubbed.sent()[0]};
  };

  for (const [name, graphql] of [
    ['the entry is at another queue commit (the queue rebuilt it)', queueEntry({entry: '2'.repeat(40)})],
    ['the pull request has no entry', queueEntry({entry: null})],
    ['the pull request merged from another queue commit', queueEntry({entry: null, merged: '2'.repeat(40)})],
  ]) {
    it(`sends nothing when ${name}, so a dropped build can't replace the live entry's request`, async () => {
      const stubbed = stub({commits: QUEUE_COMMITS, graphql});
      const {exitCode, outputs, lines} = await runWith('merge_group', mergeGroup(), stubbed, {CHANGE_VALIDATION_STAGE: 'merge_queue'});

      assert.equal(exitCode, 0);
      assert.equal(outputs.outcome, 'entry_gone');
      assert.deepEqual(stubbed.sent(), []);
      assert.ok(lines.some((line) => line.startsWith('::notice') && /not sent: pull request #7 has no merge queue entry at d{40} any more/.test(line)));
    });
  }

  it('sends with the head when the entry already merged at this queue commit', async () => {
    const {exitCode, outputs, lines, body} = await sendEntry(queueEntry({entry: null, merged: QUEUE_HEAD}));

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'accepted');
    assert.equal(body.event.pull_request_head_sha, HEAD);
    assert.deepEqual(warningsOf(lines), []);
  });

  for (const [name, graphql, warning] of [
    ['the pull request moved since it was read', queueEntry({head: 'f'.repeat(40)}), /moved from a{40} to f{40}/],
    ['GitHub fails', json(502, {message: 'Bad Gateway'}), /merge queue entry answered HTTP 502/],
    [
      'GitHub answers with an error',
      json(200, {data: {repository: {pullRequest: {headRefOid: HEAD, mergeQueueEntry: null}}}, errors: [{message: 'Resource not accessible by integration'}]}),
      /Resource not accessible by integration/,
    ],
  ]) {
    it(`is left out, with a warning, when ${name}, and the request still goes out`, async () => {
      const {exitCode, outputs, lines, body} = await sendEntry(graphql);

      assert.equal(exitCode, 0);
      assert.equal(outputs.outcome, 'accepted');
      assert.equal('pull_request_head_sha' in body.event, false);
      assert.equal(body.event.head_sha, QUEUE_HEAD);
      // The paths are the queue commit's own, so an unverified head leaves them whole.
      assert.deepEqual(body.event.changed_paths, PATHS);
      assert.equal(body.event.changed_paths_truncated, false);
      const warnings = warningsOf(lines);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /sent without pull_request_head_sha: /);
      assert.match(warnings[0], warning);
    });
  }

  it('takes the head in any case, sending it lowercase', async () => {
    const stubbed = stub({commits: QUEUE_COMMITS, graphql: queueEntry({head: HEAD.toUpperCase(), entry: QUEUE_HEAD.toUpperCase()})});
    const {lines} = await runWith('merge_group', mergeGroup(), stubbed, {CHANGE_VALIDATION_STAGE: 'merge_queue'});

    assert.equal(stubbed.sent()[0].event.pull_request_head_sha, HEAD);
    assert.deepEqual(warningsOf(lines), []);
  });

  it('reads the GraphQL url the runner names', async () => {
    const stubbed = stub({commits: QUEUE_COMMITS});
    const {fetchImpl} = stubbed;
    const seen = [];
    stubbed.fetchImpl = async (url, init) => {
      if (url === 'https://ghes.example.test/api/graphql') {
        seen.push(url);
        return fetchImpl(`${GITHUB_API}/graphql`, init);
      }
      return fetchImpl(url, init);
    };
    await runWith('merge_group', mergeGroup(), stubbed, {CHANGE_VALIDATION_STAGE: 'merge_queue', GITHUB_GRAPHQL_URL: 'https://ghes.example.test/api/graphql'});

    assert.equal(seen.length, 1);
    assert.equal(stubbed.sent()[0].event.pull_request_head_sha, HEAD);
  });
});

describe('the answer', () => {
  for (const event of ['superseded', 'duplicate']) {
    it(`treats ${event} as sent, not an error`, async () => {
      const stubbed = stub({mabl: [json(200, {session_id: 's1-as', created: false, event})]});
      const {exitCode, outputs, lines} = await runWith('pull_request', prEvent('synchronize'), stubbed);

      assert.equal(exitCode, 0);
      assert.deepEqual(outputs, {outcome: event, 'session-id': 's1-as', created: 'false', agent: '', 'description-source': 'built', 'pull-request-number': '7'});
      assert.equal(stubbed.mablCalls().length, 1);
      assert.equal(lines.some((line) => line.startsWith('::error')), false);
    });
  }

  it('retries 429, 5xx and agent_stopping with the same body', async () => {
    const stubbed = stub({
      mabl: [
        json(429, {code: 429, message: 'slow down'}),
        json(503, {code: 503, message: 'stopping', error_code: 'agent_stopping'}),
        json(502, {}),
        ACCEPTED,
      ],
    });
    const {exitCode, outputs, delays} = await runWith('pull_request', prEvent('opened'), stubbed);

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'accepted');
    assert.deepEqual(delays, RETRY_DELAYS_MS);
    const bodies = stubbed.mablCalls().map((call) => call.body);
    assert.equal(bodies.length, 4);
    assert.equal(new Set(bodies).size, 1);
  });

  it('retries when mabl does not answer', async () => {
    const stubbed = stub();
    const {fetchImpl} = stubbed;
    let dropped = false;
    stubbed.fetchImpl = async (url, init) => {
      if (!dropped && new URL(url).pathname === EVENTS_PATH) {
        dropped = true;
        throw new TypeError('fetch failed');
      }
      return fetchImpl(url, init);
    };
    const {exitCode, outputs, delays} = await runWith('pull_request', prEvent('opened'), stubbed);

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'accepted');
    assert.deepEqual(delays, [RETRY_DELAYS_MS[0]]);
  });

  it('gives up after the last retry', async () => {
    const stubbed = stub({mabl: Array.from({length: RETRY_DELAYS_MS.length + 1}, () => json(500, {message: 'down'}))});
    const {exitCode, outputs} = await runWith('pull_request', prEvent('opened'), stubbed);

    assert.equal(exitCode, 1);
    assert.equal(outputs.outcome, 'failed');
    assert.equal(stubbed.mablCalls().length, RETRY_DELAYS_MS.length + 1);
  });

  for (const [status, errorCode] of [
    [400, 'invalid_request'],
    [403, 'principal_too_narrow'],
    [403, 'principal_gone'],
  ]) {
    it(`fails on ${status} ${errorCode} without retrying`, async () => {
      const stubbed = stub({mabl: [json(status, {code: status, message: `no: ${API_KEY}`, error_code: errorCode})]});
      const {exitCode, outputs, lines, delays} = await runWith('pull_request', prEvent('opened'), stubbed);

      assert.equal(exitCode, 1);
      assert.equal(outputs.outcome, errorCode);
      assert.equal(stubbed.mablCalls().length, 1);
      assert.deepEqual(delays, []);
      assert.equal(lines.join('\n').includes(API_KEY), false);
    });
  }

  for (const [status, errorCode, eventName, payload] of [
    [403, 'feature_disabled', 'pull_request', prEvent('opened')],
    [409, 'change_agent_closed', 'pull_request', prEvent('opened')],
    [404, 'no_change_agent', 'issue_comment', commentEvent('MEMBER')],
  ]) {
    it(`ends with a notice on ${errorCode}`, async () => {
      const stubbed = stub({mabl: [json(status, {code: status, message: 'no', error_code: errorCode})]});
      const {exitCode, outputs} = await runWith(eventName, payload, stubbed, {CHANGE_VALIDATION_COMMAND: 'author 2'});

      assert.equal(exitCode, 0);
      assert.equal(outputs.outcome, errorCode);
      assert.equal(stubbed.mablCalls().length, 1);
    });
  }
});

describe('inputs', () => {
  for (const apiUrl of [
    'https://evil.example.test',
    'http://api.mabl.com',
    'https://api.mabl.com.evil.test',
    'https://api.mabl.com/x',
    'https://user@api.mabl.com',
    'https://api.mabl.com:8443',
    'https://help.mabl.com',
    'https://mabl.com',
    'https://API.mabl.com',
    'not a url',
  ]) {
    it(`sends the key only to the mabl api, not ${apiUrl}`, async () => {
      const stubbed = stub();
      const {exitCode} = await runWith('pull_request', prEvent('opened'), stubbed, {MABL_API_URL: apiUrl});

      assert.equal(exitCode, 1);
      assert.equal(stubbed.calls.length, 0);
    });
  }

  it('takes only https://api.mabl.com as api-url, with or without a trailing slash', () => {
    assert.equal(apiUrlOf({}), DEFAULT_API_URL);
    assert.equal(apiUrlOf({MABL_API_URL: 'https://api.mabl.com/'}), 'https://api.mabl.com');
    assert.equal(apiUrlOf({MABL_API_URL: 'https://api.example.mabl.com'}), '');
  });

  it('never follows a redirect from mabl', async () => {
    const stubbed = stub();
    const {exitCode} = await runWith('pull_request', prEvent('opened'), stubbed);

    assert.equal(exitCode, 0);
    const toMabl = stubbed.calls.filter((call) => call.url.origin === MABL);
    assert.ok(toMabl.length >= 2);
    for (const call of toMabl) {
      assert.equal(call.redirect, 'error', call.url.pathname);
    }
  });

  it('prints an error code from mabl on one line', async () => {
    const stubbed = stub({mabl: [json(409, {message: 'no', error_code: 'odd\n::error::forged'})]});
    const {lines} = await runWith('pull_request', prEvent('opened'), stubbed);

    assert.ok(lines.some((line) => line.includes('odd ::error::forged')));
    assert.equal(lines.some((line) => line.startsWith('::error::forged')), false);
  });

  it('refuses an event it does not handle', async () => {
    const stubbed = stub();
    const {exitCode} = await runWith('pull_request_target', {}, stubbed);

    assert.equal(exitCode, 1);
    assert.equal(stubbed.calls.length, 0);
  });

  it('sends nothing to mabl without a workspace-id', async () => {
    for (const workspace of ['', '   ']) {
      const stubbed = stub();
      const {exitCode, outputs, lines} = await runWith('pull_request', prEvent('opened'), stubbed, {MABL_WORKSPACE_ID: workspace});

      assert.equal(exitCode, 1);
      assert.equal(outputs.outcome, 'failed');
      assert.equal(stubbed.calls.filter((call) => call.url.origin === MABL).length, 0);
      assert.ok(lines.some((line) => line.startsWith('::error') && line.includes('workspace-id is required')));
    }
  });
});

describe('expected-head-sha', () => {
  const NEW_HEAD = 'd'.repeat(40);
  const movedTo = (sha) => pullRequest({head: {...pullRequest().head, sha}});

  it('sends when the pull request is at the expected head, in any case', async () => {
    const stubbed = stub();
    const {exitCode, outputs} = await runWith('pull_request', prEvent('synchronize'), stubbed, {CHANGE_VALIDATION_EXPECTED_HEAD_SHA: ` ${HEAD.toUpperCase()} `});

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'accepted');
    assert.equal(stubbed.sent()[0].event.head_sha, HEAD);
  });

  it('sends nothing when the pull request has moved on from the expected head', async () => {
    const stubbed = stub({pr: movedTo(NEW_HEAD)});
    const {exitCode, outputs, lines} = await runWith('pull_request', prEvent('synchronize'), stubbed, {CHANGE_VALIDATION_EXPECTED_HEAD_SHA: HEAD});

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'skipped');
    assert.equal(outputs['pull-request-number'], '');
    assert.equal(stubbed.mablCalls().length, 0);
    assert.equal(stubbed.fileCalls().length, 0);
    assert.ok(lines.some((line) => line.startsWith('::notice') && line.includes(`head is ${NEW_HEAD}, not the expected ${HEAD}`)));
  });

  it('sends nothing when a push lands at another head while the files are listed', async () => {
    const stubbed = stub({pr: [pullRequest(), movedTo(NEW_HEAD)]});
    const {exitCode, outputs} = await runWith('pull_request', prEvent('opened'), stubbed, {CHANGE_VALIDATION_EXPECTED_HEAD_SHA: HEAD});

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'skipped');
    assert.equal(stubbed.fileCalls().length, 1);
    assert.equal(stubbed.mablCalls().length, 0);
  });

  it('applies to the trigger word alone', async () => {
    const stubbed = stub({pr: movedTo(NEW_HEAD)});
    const {outputs} = await runWith('issue_comment', commentEvent('MEMBER'), stubbed, {CHANGE_VALIDATION_COMMAND: '', CHANGE_VALIDATION_EXPECTED_HEAD_SHA: HEAD});

    assert.equal(outputs.outcome, 'skipped');
    assert.equal(stubbed.mablCalls().length, 0);
  });

  it("applies to a comment's request", async () => {
    const moved = stub({pr: movedTo(NEW_HEAD)});
    const skipped = await runWith('issue_comment', commentEvent('MEMBER'), moved, {CHANGE_VALIDATION_COMMAND: 'look again', CHANGE_VALIDATION_EXPECTED_HEAD_SHA: HEAD});
    assert.equal(skipped.exitCode, 0);
    assert.equal(skipped.outputs.outcome, 'skipped');
    assert.equal(moved.mablCalls().length, 0);
    assert.ok(skipped.lines.some((line) => line.startsWith('::notice') && line.includes(`head is ${NEW_HEAD}, not the expected ${HEAD}`)));

    const atHead = stub();
    const sent = await runWith('issue_comment', commentEvent('MEMBER'), atHead, {CHANGE_VALIDATION_COMMAND: 'look again', CHANGE_VALIDATION_EXPECTED_HEAD_SHA: HEAD});
    assert.equal(sent.outputs.outcome, 'accepted');
    assert.equal(atHead.sent()[0].event.command, 'look again');
  });

  it('is ignored by a merged pull request', async () => {
    const merged = stub({mabl: [json(200, {session_id: 's1-as', created: false, event: 'accepted', agent: 'working'})]});
    const told = await runWith('pull_request', closedEvent(), merged, {CHANGE_VALIDATION_STAGE: '', CHANGE_VALIDATION_EXPECTED_HEAD_SHA: NEW_HEAD});
    assert.equal(told.outputs.outcome, 'accepted');
  });

  for (const [label, eventName, payload, env] of [
    ['a stage request', 'pull_request', prEvent('opened'), {}],
    ['a merge queue entry', 'merge_group', {action: 'checks_requested'}, {CHANGE_VALIDATION_STAGE: 'merge_queue'}],
    ["a comment's request", 'issue_comment', commentEvent('MEMBER'), {CHANGE_VALIDATION_COMMAND: 'look again'}],
    ['a merged pull request', 'pull_request', closedEvent(), {CHANGE_VALIDATION_STAGE: ''}],
    ['an action not sent', 'pull_request', prEvent('labeled'), {}],
    ["send: 'false'", 'pull_request', prEvent('synchronize', {pull_request: pullRequest()}), {CHANGE_VALIDATION_SEND: 'false', CHANGE_VALIDATION_COMMENT: 'true'}],
  ]) {
    it(`fails, calling nothing, when it is not a commit sha, even on ${label}`, async () => {
      const stubbed = stub();
      const {exitCode, outputs, lines} = await runWith(eventName, payload, stubbed, {...env, CHANGE_VALIDATION_EXPECTED_HEAD_SHA: 'abc1234'});

      assert.equal(exitCode, 1);
      assert.equal(outputs.outcome, 'failed');
      assert.equal(stubbed.calls.length, 0);
      assert.match(lines.join('\n'), /expected-head-sha has to be a 40-character commit sha/);
    });
  }

  it('publishes error, with await, when it is not a commit sha', async () => {
    const statuses = [];
    const stubbed = stub();
    const fetchImpl = async (url, init = {}) => {
      if (new URL(url).pathname.startsWith('/repos/Org/Repo/statuses/')) {
        statuses.push(JSON.parse(init.body));
        return new Response('{}', {status: 201});
      }
      return stubbed.fetchImpl(url, init);
    };
    const {exitCode, outputs} = await runWith('merge_group', {action: 'checks_requested', merge_group: {head_sha: HEAD}}, {fetchImpl}, {
      CHANGE_VALIDATION_STAGE: 'merge_queue',
      CHANGE_VALIDATION_AWAIT: 'true',
      STATUS_CONTEXT: 'ctx',
      CHANGE_VALIDATION_EXPECTED_HEAD_SHA: 'nope',
    });

    assert.equal(exitCode, 1);
    assert.equal(outputs.status, 'error');
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].state, 'error');
  });
});

describe('require-expected-head', () => {
  const REQUIRE = {CHANGE_VALIDATION_REQUIRE_EXPECTED_HEAD: 'true'};

  for (const [label, eventName, payload, env] of [
    ['a pull request', 'pull_request', prEvent('synchronize'), {}],
    ['the trigger word alone', 'issue_comment', commentEvent('MEMBER'), {CHANGE_VALIDATION_COMMAND: ''}],
    ["a comment's request", 'issue_comment', commentEvent('MEMBER'), {CHANGE_VALIDATION_COMMAND: 'look again'}],
  ]) {
    for (const value of ['', '   ']) {
      it(`fails, calling nothing, on ${label} when expected-head-sha is ${JSON.stringify(value)}`, async () => {
        const stubbed = stub();
        const {exitCode, outputs, lines} = await runWith(eventName, payload, stubbed, {...env, ...REQUIRE, CHANGE_VALIDATION_EXPECTED_HEAD_SHA: value});

        assert.equal(exitCode, 1);
        assert.equal(outputs.outcome, 'failed');
        assert.equal(stubbed.calls.length, 0);
        assert.match(lines.join('\n'), /require-expected-head is true, but expected-head-sha is empty/);
      });
    }
  }

  it('sends at the expected head when one is given', async () => {
    const stubbed = stub();
    const {outputs} = await runWith('pull_request', prEvent('synchronize'), stubbed, {...REQUIRE, CHANGE_VALIDATION_EXPECTED_HEAD_SHA: HEAD});

    assert.equal(outputs.outcome, 'accepted');
  });

  it('sends unchecked when expected-head-sha is empty and not required', async () => {
    for (const require of ['', 'false']) {
      const stubbed = stub();
      const {outputs} = await runWith('pull_request', prEvent('synchronize'), stubbed, {CHANGE_VALIDATION_REQUIRE_EXPECTED_HEAD: require});
      assert.equal(outputs.outcome, 'accepted', require);
    }
  });

  it('does not apply to a merged pull request', async () => {
    const merged = stub({mabl: [json(200, {session_id: 's1-as', created: false, event: 'accepted', agent: 'working'})]});
    const told = await runWith('pull_request', closedEvent(), merged, {...REQUIRE, CHANGE_VALIDATION_STAGE: ''});
    assert.equal(told.outputs.outcome, 'accepted');
  });

  it("fails on a value other than 'true' or 'false'", async () => {
    const stubbed = stub();
    const {exitCode} = await runWith('pull_request', prEvent('opened'), stubbed, {CHANGE_VALIDATION_REQUIRE_EXPECTED_HEAD: 'yes'});

    assert.equal(exitCode, 1);
    assert.equal(stubbed.calls.length, 0);
  });
});

describe("send: 'false'", () => {
  const COMMENT_ONLY = {CHANGE_VALIDATION_SEND: 'false', CHANGE_VALIDATION_COMMENT: 'true'};

  it('sends no stage request on a pull_request, and names the pull request for the comment', async () => {
    const stubbed = stub();
    const {exitCode, outputs, lines} = await runWith('pull_request', prEvent('synchronize', {pull_request: pullRequest()}), stubbed, COMMENT_ONLY);

    assert.equal(exitCode, 0);
    assert.deepEqual(outputs, {outcome: 'comment_only', 'session-id': '', created: '', agent: '', 'description-source': '', 'pull-request-number': '7'});
    assert.equal(stubbed.calls.length, 0);
    assert.ok(lines.some((line) => line.startsWith('::notice') && line.includes("no stage request sent (send: 'false')")));
  });

  it('skips an edit that did not move the base, as a stage request would', async () => {
    const stubbed = stub();
    const {exitCode, outputs} = await runWith('pull_request', prEvent('edited', {pull_request: pullRequest(), changes: {title: {from: 'a'}}}), stubbed, COMMENT_ONLY);

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'skipped');
    assert.equal(stubbed.calls.length, 0);
  });

  it('is not gated by require-expected-head, which it ignores', async () => {
    const stubbed = stub();
    const {exitCode, outputs} = await runWith('pull_request', prEvent('synchronize', {pull_request: pullRequest()}), stubbed, {
      ...COMMENT_ONLY,
      CHANGE_VALIDATION_REQUIRE_EXPECTED_HEAD: 'true',
      CHANGE_VALIDATION_EXPECTED_HEAD_SHA: '',
    });

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'comment_only');
    assert.equal(stubbed.calls.length, 0);
  });

  it('takes a trusted commenter with write access on issue_comment, reading only the pull request and the permission', async () => {
    const stubbed = stub();
    const {exitCode, outputs} = await runWith('issue_comment', commentEvent('MEMBER'), stubbed, COMMENT_ONLY);

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'comment_only');
    assert.equal(outputs['pull-request-number'], '7');
    assert.deepEqual(stubbed.calls.map((call) => call.url.pathname), ['/repos/Org/Repo/pulls/7', '/repos/Org/Repo/collaborators/dev/permission']);
  });

  it("refuses a fork's pull request on issue_comment, before checking the commenter", async () => {
    const stubbed = stub({pr: pullRequest({head: {sha: HEAD, ref: 'f', repo: {id: 2002}}})});
    const {exitCode, outputs} = await runWith('issue_comment', commentEvent('MEMBER'), stubbed, COMMENT_ONLY);

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'refused');
    assert.deepEqual(stubbed.calls.map((call) => call.url.pathname), ['/repos/Org/Repo/pulls/7']);
  });

  it('refuses a commenter without write access, or outside the repository, and a fork', async () => {
    const readOnly = await runWith('issue_comment', commentEvent('MEMBER'), stub({permission: json(200, {permission: 'read'})}), COMMENT_ONLY);
    assert.equal(readOnly.outputs.outcome, 'refused');
    assert.equal(readOnly.exitCode, 0);

    const outsider = stub();
    const contributed = await runWith('issue_comment', commentEvent('CONTRIBUTOR'), outsider, COMMENT_ONLY);
    assert.equal(contributed.outputs.outcome, 'refused');
    assert.equal(outsider.calls.length, 0);

    const fork = pullRequest({head: {sha: HEAD, ref: 'f', repo: {id: 2002}}});
    const forked = await runWith('pull_request', prEvent('synchronize', {pull_request: fork}), stub(), {...COMMENT_ONLY, ...NO_KEY});
    assert.equal(forked.outputs.outcome, 'refused');
    assert.equal(forked.exitCode, 0);
  });

  it('skips a comment without the trigger word, a closed pull request and an issue', async () => {
    for (const [eventName, payload, env] of [
      ['issue_comment', commentEvent('MEMBER'), {CHANGE_VALIDATION_TRIGGER_WORD: '/other'}],
      ['pull_request', closedEvent(), {}],
      ['pull_request', prEvent('labeled', {pull_request: pullRequest()}), {}],
      ['issue_comment', commentEvent('MEMBER', {issue: {number: 7}}), {}],
      ['issue_comment', commentEvent('MEMBER', {action: 'edited'}), {}],
    ]) {
      const stubbed = stub();
      const {exitCode, outputs} = await runWith(eventName, payload, stubbed, {...COMMENT_ONLY, ...env});
      assert.equal(exitCode, 0, eventName);
      assert.equal(outputs.outcome, 'skipped', JSON.stringify(env));
      assert.equal(stubbed.calls.length, 0);
    }
  });

  for (const [label, eventName, payload, env, message] of [
    ['without comment', 'pull_request', prEvent('synchronize'), {CHANGE_VALIDATION_COMMENT: 'false'}, /needs comment: 'true'/],
    ['with await', 'pull_request', prEvent('synchronize'), {CHANGE_VALIDATION_AWAIT: 'true'}, /nothing to await/],
    ['on merge_group', 'merge_group', {action: 'checks_requested'}, {}, /runs on pull_request and issue_comment events, not merge_group/],
    ['on a deployed commit', 'push', {}, {}, /not push/],
    ['without a key', 'pull_request', prEvent('synchronize', {pull_request: pullRequest()}), NO_KEY, /mabl-api-key is required/],
    ['without a workspace', 'pull_request', prEvent('synchronize', {pull_request: pullRequest()}), {MABL_WORKSPACE_ID: ' '}, /workspace-id is required/],
    ['with another api', 'pull_request', prEvent('synchronize'), {MABL_API_URL: 'https://evil.example.test'}, /api-url has to be/],
  ]) {
    it(`fails, calling nothing, ${label}`, async () => {
      const stubbed = stub();
      const {exitCode, outputs, lines} = await runWith(eventName, payload, stubbed, {...COMMENT_ONLY, ...env});

      assert.equal(exitCode, 1);
      assert.equal(outputs.outcome, 'failed');
      assert.equal(stubbed.calls.length, 0);
      assert.match(lines.join('\n'), message);
    });
  }

  it("fails on a value other than 'true' or 'false', and sends on 'true' or empty", async () => {
    const odd = stub();
    const failed = await runWith('pull_request', prEvent('opened'), odd, {CHANGE_VALIDATION_SEND: 'no'});
    assert.equal(failed.exitCode, 1);
    assert.equal(odd.calls.length, 0);

    for (const send of ['true', '', ' true ']) {
      const stubbed = stub();
      const {outputs} = await runWith('pull_request', prEvent('opened'), stubbed, {CHANGE_VALIDATION_SEND: send});
      assert.equal(outputs.outcome, 'accepted', JSON.stringify(send));
      assert.equal(stubbed.mablCalls().length, 1);
    }
  });
});
