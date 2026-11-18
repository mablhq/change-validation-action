import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it} from 'node:test';

import {EVENTS_PATH, RESOLVE_PATH, run} from '../src/stage-request.mjs';
import {DEFAULT_API_URL} from '../src/lib/mabl-api.mjs';
import {STATUS_PATH} from '../src/await-status.mjs';

const GITHUB_API = 'https://api.github.example.test';
const MABL = DEFAULT_API_URL;
const API_KEY = 'mabl-key-secret';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const POLICY = 'version: 1\n';
const NOW = 1_794_600_000_000;
const CONTEXT = 'mabl-release';

const json = (status, body) => ({status, body: JSON.stringify(body), headers: {'content-type': 'application/json'}});
const ACCEPTED = json(201, {session_id: 'r1-as', created: true, event: 'accepted', agent: 'working'});
const STAGES = {web: {release: {mabl_application: 'web-a', analysis_roots: ['frontend']}}};
const pull = (number, title, labels = [], state = 'MERGED', base = 'Org/Repo') => ({
  number,
  title,
  state,
  baseRepository: {nameWithOwner: base},
  labels: {nodes: labels.map((name) => ({name}))},
});
// The pull requests behind each commit, as GraphQL's associatedPullRequests lists them.
const BEHIND = {
  [C1]: [pull(41, 'Fix login')],
  [C2]: [],
  [HEAD]: [pull(42, 'Add checkout', ['skip-release-check']), pull(9, 'Still open', ['other'], 'OPEN'), pull(3, 'In a fork', ['fork-label'], 'MERGED', 'Someone/Repo')],
};
const FILES = [
  {filename: 'frontend/src/Checkout.tsx', additions: 10, deletions: 2},
  {filename: 'frontend/src/New.tsx', previous_filename: 'frontend/src/Old.tsx', additions: 1, deletions: 1},
  {filename: 'docs/README.md', additions: 3, deletions: 0},
];

// GitHub's repository, compare, GraphQL and contents APIs, the policy resolve, then mabl's answers in
// order. `commits` is the range, served `per_page` a page; `files` comes on the first page only.
// `onDefault` is the compare of the head with the default branch: `ahead` when main holds the head.
function stub({
  commits = [C1, C2, HEAD],
  files = FILES,
  total,
  rangeStatus = 'ahead',
  behind = BEHIND,
  compare,
  onDefault = json(200, {status: 'ahead'}),
  mabl = [ACCEPTED],
  statuses = [],
  published = [{status: 201}],
} = {}) {
  const calls = [];
  const answers = [...mabl];
  const reads = [...statuses];
  let clock = NOW;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({url: parsed, method: init.method ?? 'GET', body: init.body});
    let answer;
    if (parsed.origin === GITHUB_API && parsed.pathname === '/repos/Org/Repo') {
      answer = json(200, {default_branch: 'main'});
    } else if (parsed.origin === GITHUB_API && parsed.pathname.startsWith('/repos/Org/Repo/compare/') && parsed.pathname.endsWith('...main')) {
      answer = onDefault;
    } else if (parsed.origin === GITHUB_API && parsed.pathname.startsWith('/repos/Org/Repo/compare/')) {
      const page = Number(parsed.searchParams.get('page'));
      const size = Number(parsed.searchParams.get('per_page'));
      answer =
        compare ??
        json(200, {
          status: rangeStatus,
          total_commits: total ?? commits.length,
          commits: commits.slice((page - 1) * size, page * size).map((sha) => ({sha})),
          ...(page === 1 ? {files} : {}),
        });
    } else if (parsed.origin === GITHUB_API && parsed.pathname === '/graphql') {
      const {query, variables} = JSON.parse(init.body);
      assert.ok(!Object.entries(variables).some(([key, value]) => /^c[0-9]+$/.test(key) && query.includes(value)), 'shas go in variables, not the query');
      const repository = {};
      for (const [key, sha] of Object.entries(variables)) {
        if (/^c[0-9]+$/.test(key)) {
          repository[key] = {associatedPullRequests: {nodes: behind[sha] ?? []}};
        }
      }
      answer = json(200, {data: {repository}});
    } else if (parsed.origin === GITHUB_API && parsed.pathname.startsWith('/repos/Org/Repo/contents/')) {
      answer = {status: 200, body: POLICY, headers: {'content-type': 'application/vnd.github.raw'}};
    } else if (parsed.origin === GITHUB_API && parsed.pathname.startsWith('/repos/Org/Repo/statuses/')) {
      answer = published.length > 1 ? published.shift() : published[0];
    } else if (parsed.origin === MABL && parsed.pathname === RESOLVE_PATH) {
      answer = json(200, {valid: true, errors: [], policy: {}, stages: STAGES});
    } else if (parsed.origin === MABL && parsed.pathname === STATUS_PATH) {
      answer = reads.length > 1 ? reads.shift() : reads[0];
    } else if (parsed.origin === MABL) {
      answer = answers.shift();
    }
    if (answer === undefined) {
      throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
    }
    return new Response(answer.body ?? '', {status: answer.status ?? 200, headers: answer.headers ?? {}});
  };
  const sent = () => calls.filter((call) => call.url.origin === MABL && call.url.pathname === EVENTS_PATH).map((call) => JSON.parse(call.body));
  return {
    fetchImpl,
    calls,
    sent,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    signalAfter: () => new AbortController().signal,
  };
}

async function runWith(eventName, payload, stubbed, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'change-agent-revision-'));
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
      GITHUB_SHA: HEAD,
      GITHUB_REF_NAME: 'v1.2.3',
      GITHUB_RUN_ID: '555',
      GITHUB_RUN_ATTEMPT: '1',
      GH_TOKEN: 'ghs_test',
      MABL_API_KEY: API_KEY,
      MABL_WORKSPACE_ID: 'ws-w',
      CHANGE_VALIDATION_STAGE: 'release',
      CHANGE_VALIDATION_BASE_SHA: BASE,
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

const tagPush = {ref: 'refs/tags/v1.2.3', before: '0'.repeat(40), after: HEAD};

describe('a revision', () => {
  it('asks for the stage at the deployed commit, measured from base-sha, with the head pull request labels and the policy read at the head', async () => {
    const stubbed = stub();
    const {exitCode, outputs} = await runWith('push', tagPush, stubbed);

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'accepted');
    assert.equal(outputs['description-source'], 'built');
    const [body] = stubbed.sent();
    assert.deepEqual(body.reference, {type: 'commit', id: HEAD, url: `https://github.com/Org/Repo/commit/${HEAD}`});
    assert.deepEqual(body.event, {
      kind: 'stage.requested',
      stage: 'release',
      head_sha: HEAD,
      base_sha: BASE,
      head_ref: 'v1.2.3',
      occurred_at: NOW,
      labels: ['skip-release-check'],
      changed_paths: ['frontend/src/Checkout.tsx', 'frontend/src/Old.tsx', 'frontend/src/New.tsx', 'docs/README.md'],
      changed_paths_truncated: false,
    });
    assert.equal(body.dry_run, false);
    assert.deepEqual(body.related_artifacts[0].artifact_data.value, {
      repository: 'github.com/org/repo',
      revision: HEAD,
      base_sha: HEAD,
      head_sha: HEAD,
      head_ref: 'v1.2.3',
      path: '.mabl/policy.yaml',
      found: true,
      text: POLICY,
      sha256: createHash('sha256').update(POLICY, 'utf8').digest('hex'),
    });
    assert.ok(!('pull_request_head_sha' in body.event));
    const contents = stubbed.calls.find((call) => call.url.pathname.includes('/contents/'));
    assert.equal(contents.url.searchParams.get('ref'), HEAD);
    assert.ok(stubbed.calls.some((call) => call.url.pathname === `/repos/Org/Repo/compare/${BASE}...${HEAD}`));
    assert.ok(stubbed.calls.some((call) => call.url.pathname === `/repos/Org/Repo/compare/${HEAD}...main`));
    const {query, variables} = JSON.parse(stubbed.calls.find((call) => call.url.pathname === '/graphql').body);
    const [headAlias] = Object.entries(variables).find(([, sha]) => sha === HEAD);
    const aliases = query.split(/ (?=c[0-9]+: object)/).filter((part) => /^c[0-9]+: object/.test(part));
    assert.deepEqual(
      aliases.filter((part) => part.includes('labels(')).map((part) => part.split(':')[0]),
      [headAlias],
      'labels are asked for on the head commit only',
    );
  });

  it("takes the default branch from the event when it names one, without reading the repository", async () => {
    const stubbed = stub();
    const {outputs} = await runWith(
      'deployment_status',
      {deployment: {sha: HEAD}, deployment_status: {state: 'success'}, repository: {default_branch: 'main'}},
      stubbed,
    );

    assert.equal(outputs.outcome, 'accepted');
    assert.ok(!stubbed.calls.some((call) => call.url.pathname === '/repos/Org/Repo'));
    assert.ok(stubbed.calls.some((call) => call.url.pathname === `/repos/Org/Repo/compare/${HEAD}...main`));
  });

  it("is refused, sending nothing, for a commit that isn't on the default branch, such as a fork's", async () => {
    for (const onDefault of [json(200, {status: 'diverged'}), json(200, {status: 'behind'}), json(404, {message: 'Not Found'})]) {
      const stubbed = stub({onDefault});
      const {exitCode, outputs, lines} = await runWith('deployment_status', {deployment: {sha: HEAD}, deployment_status: {state: 'success'}}, stubbed);

      assert.equal(exitCode, 0);
      assert.equal(outputs.outcome, 'refused');
      assert.equal(stubbed.sent().length, 0);
      assert.ok(!stubbed.calls.some((call) => call.url.pathname.includes('/contents/')));
      assert.ok(lines.some((line) => line.includes("is not on Org/Repo's default branch")));
    }
  });

  it("takes the commit a branch push just pushed without asking where it is, but not a head-sha the push didn't push", async () => {
    let stubbed = stub({onDefault: json(200, {status: 'diverged'})});
    let result = await runWith('push', {ref: 'refs/heads/release', before: BASE, after: HEAD}, stubbed, {CHANGE_VALIDATION_BASE_SHA: ''});
    assert.equal(result.outputs.outcome, 'accepted');
    assert.ok(!stubbed.calls.some((call) => call.url.pathname.endsWith('...main')));

    stubbed = stub({onDefault: json(200, {status: 'diverged'})});
    result = await runWith('push', {ref: 'refs/heads/release', before: BASE, after: HEAD}, stubbed, {CHANGE_VALIDATION_HEAD_SHA: C1});
    assert.equal(result.outputs.outcome, 'refused');
  });

  it("takes a workflow run's own commit and branch, not the default branch's, and only when it succeeded", async () => {
    const payload = (conclusion) => ({workflow_run: {head_sha: C1, head_branch: 'release/2.3', conclusion}});
    let stubbed = stub({commits: [C1]});
    await runWith('workflow_run', payload('success'), stubbed);
    assert.equal(stubbed.sent()[0].event.head_sha, C1);
    assert.equal(stubbed.sent()[0].event.head_ref, 'release/2.3');

    stubbed = stub();
    const result = await runWith('workflow_run', payload('failure'), stubbed);
    assert.equal(result.outputs.outcome, 'skipped');
    assert.equal(stubbed.calls.length, 0);
  });

  it('skips a push that deleted a branch, since GITHUB_SHA is then the default branch tip', async () => {
    const stubbed = stub();
    const {exitCode, outputs} = await runWith('push', {ref: 'refs/heads/gone', deleted: true, before: BASE, after: '0'.repeat(40)}, stubbed, {
      CHANGE_VALIDATION_BASE_SHA: '',
    });

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'skipped');
    assert.equal(stubbed.calls.length, 0);
  });

  it('sends a deployment only once it succeeded', async () => {
    for (const state of ['queued', 'in_progress', 'failure', undefined]) {
      const stubbed = stub();
      const {exitCode, outputs} = await runWith('deployment_status', {deployment: {sha: HEAD}, deployment_status: {state}}, stubbed);
      assert.equal(exitCode, 0);
      assert.equal(outputs.outcome, 'skipped');
      assert.equal(stubbed.calls.length, 0);
    }
  });

  it('counts only pull requests merged into this repository, for the labels and the description', async () => {
    const stubbed = stub();
    await runWith('push', tagPush, stubbed);

    const [body] = stubbed.sent();
    assert.deepEqual(body.event.labels, ['skip-release-check']);
    assert.doesNotMatch(body.change_description, /#3 |#9 /);
  });

  it("sends at most the route's 100 labels, with a warning", async () => {
    const many = Array.from({length: 120}, (_, index) => `label-${index}`);
    const stubbed = stub({behind: {...BEHIND, [HEAD]: [pull(42, 'Add checkout', many)]}});
    const {lines} = await runWith('push', tagPush, stubbed);

    assert.deepEqual(stubbed.sent()[0].event.labels, many.slice(0, 100));
    assert.ok(lines.some((line) => line.startsWith('::warning') && line.includes('first 100 of the 120 labels')));
  });

  it('marks the paths truncated when the base is not an ancestor of the head, since the comparison starts at their merge base', async () => {
    const stubbed = stub({rangeStatus: 'diverged'});
    const {lines} = await runWith('push', tagPush, stubbed);

    const [body] = stubbed.sent();
    assert.equal(body.event.changed_paths_truncated, true);
    assert.match(body.change_description, /bbbbbbb is not an ancestor of aaaaaaa, so these are measured from their merge base/);
    assert.ok(lines.some((line) => line.startsWith('::warning') && line.includes('is not an ancestor')));
  });

  it('describes the range by its merged pull requests, its paths per application and its totals', async () => {
    const stubbed = stub();
    await runWith('push', tagPush, stubbed);

    assert.equal(
      stubbed.sent()[0].change_description,
      [
        `Title: aaaaaaa on v1.2.3: 2 pull requests since bbbbbbb`,
        '',
        "Changed paths per mabl application, by the policy's analysis_roots:",
        '- web (3 files): frontend/src/Checkout.tsx, frontend/src/Old.tsx, frontend/src/New.tsx',
        '',
        'Description:',
        '',
        '- #41 Fix login\n- #42 Add checkout\n- 1 commit with no merged pull request',
        '',
        'Diff stat: 3 files changed, 14 insertions(+), 3 deletions(-)',
      ].join('\n'),
    );
  });

  it("defaults the base to a branch push's previous commit", async () => {
    const stubbed = stub();
    await runWith('push', {ref: 'refs/heads/main', before: BASE, after: HEAD}, stubbed, {CHANGE_VALIDATION_BASE_SHA: ''});

    assert.equal(stubbed.sent()[0].event.base_sha, BASE);
  });

  it('fails, sending nothing, without a base on any other event, or on a new branch', async () => {
    for (const [eventName, payload] of [
      ['push', tagPush],
      ['push', {ref: 'refs/heads/new', before: '0'.repeat(40)}],
      // A moved tag's previous commit is not what any environment ran.
      ['push', {ref: 'refs/tags/v1.2.3', before: BASE}],
      ['workflow_dispatch', {}],
    ]) {
      const stubbed = stub();
      const {exitCode, lines} = await runWith(eventName, payload, stubbed, {CHANGE_VALIDATION_BASE_SHA: ''});

      assert.equal(exitCode, 1);
      assert.equal(stubbed.calls.length, 0);
      assert.ok(lines.some((line) => line.startsWith('::error') && line.includes(`base-sha is required on ${eventName}`)));
    }
  });

  it("takes a deployment's sha and ref on deployment_status, and head-sha over both", async () => {
    const payload = {deployment: {sha: C1, ref: 'main'}, deployment_status: {state: 'success'}};
    let stubbed = stub({commits: [C1]});
    await runWith('deployment_status', payload, stubbed);
    assert.equal(stubbed.sent()[0].event.head_sha, C1);
    assert.equal(stubbed.sent()[0].event.head_ref, 'main');

    stubbed = stub({commits: [C2]});
    await runWith('deployment_status', payload, stubbed, {CHANGE_VALIDATION_HEAD_SHA: C2.toUpperCase()});
    assert.equal(stubbed.sent()[0].event.head_sha, C2);
    assert.equal(stubbed.sent()[0].reference.id, C2);
  });

  it('refuses a head or base that is not a full sha', async () => {
    for (const env of [{CHANGE_VALIDATION_HEAD_SHA: 'abc123'}, {CHANGE_VALIDATION_BASE_SHA: 'main'}]) {
      const stubbed = stub();
      const {exitCode} = await runWith('workflow_dispatch', {}, stubbed, env);
      assert.equal(exitCode, 1);
      assert.equal(stubbed.calls.length, 0);
    }
  });

  it('needs a stage, and takes no command', async () => {
    let stubbed = stub();
    let result = await runWith('push', tagPush, stubbed, {CHANGE_VALIDATION_STAGE: ''});
    assert.equal(result.exitCode, 1);
    assert.equal(stubbed.calls.length, 0);

    stubbed = stub();
    result = await runWith('push', tagPush, stubbed, {CHANGE_VALIDATION_COMMAND: 'author 2'});
    assert.equal(result.exitCode, 0);
    assert.equal(stubbed.sent()[0].event.kind, 'stage.requested');
  });

  it('stamps each send with when it was sent, so running the job again runs the stage again', async () => {
    const stubbed = stub({mabl: [ACCEPTED, ACCEPTED]});
    await runWith('push', tagPush, stubbed);
    await stubbed.sleep(60_000);
    await runWith('push', tagPush, stubbed);

    assert.deepEqual(stubbed.sent().map((body) => body.event.occurred_at), [NOW, NOW + 60_000]);
  });

  it('stamps the send after the description is built, so a run that stalls there is not older than one that overtook it', async () => {
    const stubbed = stub();
    const fetchImpl = stubbed.fetchImpl;
    stubbed.fetchImpl = async (url, init) => {
      if (new URL(url).pathname === RESOLVE_PATH) {
        await stubbed.sleep(30_000);
      }
      return fetchImpl(url, init);
    };
    await runWith('push', tagPush, stubbed);

    assert.equal(stubbed.sent()[0].event.occurred_at, NOW + 30_000);
  });

  it('reads every page of commits, and asks GraphQL 50 commits at a time', async () => {
    const commits = Array.from({length: 120}, (_, index) => index.toString(16).padStart(40, '0'));
    const stubbed = stub({commits: [...commits, HEAD], behind: {}});
    await runWith('push', tagPush, stubbed);

    const pages = stubbed.calls.filter((call) => call.url.pathname.includes('/compare/') && !call.url.pathname.endsWith('...main')).map((call) => call.url.searchParams.get('page'));
    assert.deepEqual(pages, ['1', '2']);
    assert.equal(stubbed.calls.filter((call) => call.url.pathname === '/graphql').length, 3);
    assert.match(stubbed.sent()[0].change_description, /- 121 commits with no merged pull request/);
  });

  it('marks the paths truncated at the 300 files the compare API lists, and says so', async () => {
    const files = Array.from({length: 300}, (_, index) => ({filename: `frontend/f${index}.ts`}));
    const stubbed = stub({files});
    await runWith('push', tagPush, stubbed);

    const [body] = stubbed.sent();
    assert.equal(body.event.changed_paths.length, 300);
    assert.equal(body.event.changed_paths_truncated, true);
    assert.match(body.change_description, /GitHub lists at most 300 of a comparison's files, so some applications may be missing/);
  });

  it('says when the commits ran past what GitHub listed', async () => {
    const stubbed = stub({total: 5000});
    await runWith('push', tagPush, stubbed);

    assert.match(stubbed.sent()[0].change_description, /more commits than GitHub listed/);
  });

  it('warns and still sends when the head adds nothing to the base, such as a redeploy or a rollback', async () => {
    const stubbed = stub({commits: [], files: []});
    const {exitCode, lines} = await runWith('push', tagPush, stubbed);

    assert.equal(exitCode, 0);
    assert.ok(lines.some((line) => line.startsWith('::warning') && line.includes('adds no commits')));
    const [body] = stubbed.sent();
    assert.deepEqual(body.event.changed_paths, []);
    assert.equal(body.event.changed_paths_truncated, true);
    assert.deepEqual(body.event.labels, ['skip-release-check']);
  });

  it('fails, sending nothing, when the base is not in the repository', async () => {
    const stubbed = stub({compare: json(404, {message: 'Not Found'})});
    const {exitCode, lines} = await runWith('push', tagPush, stubbed);

    assert.equal(exitCode, 1);
    assert.equal(stubbed.sent().length, 0);
    assert.ok(lines.some((line) => line.includes('is not a commit in this repository')));
  });

  it('never prints the GitHub token or the mabl key, even when an answer echoes them', async () => {
    const stubbed = stub({mabl: [json(400, {error_code: 'invalid_request', message: `bad ghs_test and ${API_KEY}`})]});
    const {exitCode, lines} = await runWith('push', tagPush, stubbed);

    assert.equal(exitCode, 1);
    assert.ok(lines.some((line) => line.includes('bad *** and ***')));
    assert.ok(!lines.some((line) => line.includes('ghs_test') || line.includes(API_KEY)));
  });

  it("sends a caller's description only for the revision it was written for", async () => {
    let stubbed = stub();
    let result = await runWith('push', tagPush, stubbed, {CHANGE_DESCRIPTION: 'Release notes', CHANGE_DESCRIPTION_HEAD_SHA: HEAD});
    assert.equal(result.outputs['description-source'], 'provided');
    assert.equal(stubbed.sent()[0].change_description, 'Release notes');

    stubbed = stub();
    result = await runWith('push', tagPush, stubbed, {CHANGE_DESCRIPTION: 'Release notes', CHANGE_DESCRIPTION_HEAD_SHA: C1});
    assert.equal(result.exitCode, 1);
    assert.equal(stubbed.sent().length, 0);
  });
});

const statusOf = (gate, checks) =>
  json(200, {status: 'complete', summary: `release: ${gate}`, stages: [{stage: 'release', gate, summary: `release: ${gate}`, head_sha: HEAD, checks}]});
const smoke = {id: 'release/web/suite/smoke', must_pass: true, status: 'passed', summary: 'smoke passed', links: {}};

describe('await mode on a revision', () => {
  it("polls the stage by the commit and publishes on the revision's commit", async () => {
    const stubbed = stub({statuses: [statusOf('wait', [{...smoke, status: 'running'}]), statusOf('ready', [smoke])]});
    const {exitCode, outputs} = await runWith('push', tagPush, stubbed, {CHANGE_VALIDATION_AWAIT: 'true', STATUS_CONTEXT: CONTEXT});

    assert.equal(exitCode, 0);
    assert.equal(outputs.status, 'success');
    const read = stubbed.calls.find((call) => call.url.pathname === STATUS_PATH);
    assert.deepEqual(JSON.parse(read.body), {
      workspace_id: 'ws-w',
      reference: {type: 'commit', id: HEAD},
      stages: [{stage: 'release', head_sha: HEAD}],
      trusted_providers: 'caller',
    });
    const posts = stubbed.calls.filter((call) => call.url.pathname.startsWith('/repos/Org/Repo/statuses/'));
    assert.ok(posts.length >= 2);
    assert.ok(posts.every((call) => call.url.pathname === `/repos/Org/Repo/statuses/${HEAD}`));
    assert.deepEqual(posts.map((call) => JSON.parse(call.body).state), ['pending', 'pending', 'success']);
  });

  it("waits for the newer request's run when this one is superseded, since it is for the same commit", async () => {
    const superseded = json(200, {session_id: 'r1-as', created: false, event: 'superseded'});
    const stubbed = stub({mabl: [superseded], statuses: [statusOf('ready', [smoke])]});
    const {exitCode, outputs} = await runWith('push', tagPush, stubbed, {CHANGE_VALIDATION_AWAIT: 'true', STATUS_CONTEXT: CONTEXT});

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'superseded');
    assert.equal(outputs.status, 'success');
    assert.ok(stubbed.calls.some((call) => call.url.pathname === STATUS_PATH));
  });

  it("publishes nothing for a deployment that hasn't succeeded", async () => {
    const stubbed = stub();
    const {exitCode, outputs} = await runWith('deployment_status', {deployment: {sha: HEAD}, deployment_status: {state: 'in_progress'}}, stubbed, {
      CHANGE_VALIDATION_AWAIT: 'true',
      STATUS_CONTEXT: CONTEXT,
    });

    assert.equal(exitCode, 0);
    assert.equal(outputs.status, '');
    assert.equal(stubbed.calls.length, 0);
  });

  it('says so when the stage passes with no must_pass check', async () => {
    const stubbed = stub({statuses: [statusOf('ready', [{...smoke, must_pass: false}])]});
    const {exitCode, lines} = await runWith('push', tagPush, stubbed, {CHANGE_VALIDATION_AWAIT: 'true', STATUS_CONTEXT: CONTEXT});

    assert.equal(exitCode, 0);
    assert.ok(lines.some((line) => line.startsWith('::notice') && line.includes('release has no must_pass check')));
  });

  it("fails without publishing when the revision's head is not a commit", async () => {
    const stubbed = stub();
    const {exitCode} = await runWith('workflow_dispatch', {}, stubbed, {CHANGE_VALIDATION_AWAIT: 'true', STATUS_CONTEXT: CONTEXT, CHANGE_VALIDATION_HEAD_SHA: 'nope'});

    assert.equal(exitCode, 1);
    assert.ok(!stubbed.calls.some((call) => call.url.pathname.startsWith('/repos/Org/Repo/statuses/')));
  });
});
