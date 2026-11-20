import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it} from 'node:test';

import {STATUS_PATH} from '../src/await-status.mjs';
import {MARKER, POLL_INTERVAL_MS, REPORT_PATH, main} from '../src/comment.mjs';
import {DEFAULT_API_URL, basicAuthorization} from '../src/lib/mabl-api.mjs';
import {EVENTS_PATH, RESOLVE_PATH, run} from '../src/stage-request.mjs';

const GITHUB_API = 'https://api.github.example.test';
const GRAPHQL = `${GITHUB_API}/graphql`;
const MABL = DEFAULT_API_URL;
const API_KEY = 'mabl-key-secret';
const GH_TOKEN = 'ghs_token_secret';
const HEAD = 'a'.repeat(40);
const MINUTE = 60_000;
const VIEWER = 'github-actions[bot]';
const OURS = {__typename: 'Bot', login: 'github-actions'};

const json = (status, body) => ({status, body: JSON.stringify(body)});

// One application per entry of `analysed`: true gives it an analysis, false none yet.
const reportOf = ({analysed = [false], text = 'analysing', session = 's1-as', applications} = {}) => ({
  session_id: session,
  reference: {type: 'pull_request', id: 'github.com/org/repo#7'},
  status: {status: 'pending', stages: []},
  applications:
    applications ??
    analysed.map((done, index) => ({
      application: `app${index}`,
      mabl_application_id: `app${index}-a`,
      applies: true,
      ...(done ? {analysis: {session_id: `a${index}-as`, tests: [], gaps: []}} : {}),
    })),
  markdown: `${MARKER}\n<!-- mabl-change-validation-data {"session_id":"${session}"} -->\n### ${text}`,
});
const bodyOf = (text, session) => reportOf({text, session}).markdown;
const DONE = json(200, reportOf({analysed: [true], text: 'done'}));

// mabl's report route and GitHub's GraphQL, on a clock that sleeping moves. `reports` answers each
// read in order, the last repeating; `comments` is the pull request's, which the mutations change.
// `graphqlAnswer(query)` may answer a GraphQL call in place of the store.
function stub({reports = [DONE], comments = [], viewer = VIEWER, graphqlAnswer = () => undefined} = {}) {
  const calls = [];
  let clock = Date.parse('2026-11-18T12:00:00Z');
  const store = comments.map((comment) => ({...comment}));
  const answers = [...reports];
  let created = 0;
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({url: String(url), headers: init.headers ?? {}, body, at: clock, redirect: init.redirect});
    let answer;
    if (String(url) === `${MABL}${REPORT_PATH}`) {
      answer = answers.length > 1 ? answers.shift() : answers[0];
    } else if (String(url) === GRAPHQL) {
      const {query, variables} = body;
      answer = graphqlAnswer(query);
      if (answer !== undefined) {
        // Answered by the test.
      } else if (query.includes('viewer')) {
        answer = json(200, {data: {viewer: {login: viewer}, repository: {pullRequest: {id: 'PR_7', comments: {nodes: store, pageInfo: {hasNextPage: false}}}}}});
      } else if (query.includes('addComment')) {
        created += 1;
        store.push({id: `IC_new${created}`, body: variables.body, author: OURS});
        answer = json(200, {data: {}});
      } else if (query.includes('updateIssueComment')) {
        store.find((comment) => comment.id === variables.id).body = variables.body;
        answer = json(200, {data: {}});
      }
    }
    if (answer === undefined) {
      throw new Error(`unexpected ${url}`);
    }
    if (answer.throws) {
      throw new Error(answer.throws);
    }
    return new Response(answer.body, {status: answer.status});
  };
  const graphql = (word) => calls.filter((call) => call.url === GRAPHQL && call.body.query.includes(word));
  return {
    fetchImpl,
    calls,
    store,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    reads: () => calls.filter((call) => call.url === `${MABL}${REPORT_PATH}`),
    creates: () => graphql('addComment'),
    updates: () => graphql('updateIssueComment'),
  };
}

const PULL_REQUEST_ENV = {GITHUB_EVENT_NAME: 'pull_request', CHANGE_VALIDATION_OUTCOME: 'accepted'};
const QUEUE_ENV = {GITHUB_EVENT_NAME: 'merge_group', CHANGE_VALIDATION_AWAIT: 'true', CHANGE_VALIDATION_OUTCOME: 'accepted', CHANGE_VALIDATION_STATUS: 'success'};

async function step(stubbed, env = {}, payload = {action: 'opened'}) {
  const dir = mkdtempSync(join(tmpdir(), 'change-validation-comment-'));
  const eventPath = join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify(payload));
  const lines = [];
  await main({
    env: {
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: 'Org/Repo',
      GITHUB_API_URL: GITHUB_API,
      GITHUB_SERVER_URL: 'https://github.com',
      GH_TOKEN,
      MABL_API_KEY: API_KEY,
      MABL_WORKSPACE_ID: 'ws-w',
      CHANGE_VALIDATION_COMMENT: 'true',
      PULL_REQUEST_NUMBER: '7',
      ...PULL_REQUEST_ENV,
      ...env,
    },
    fetchImpl: stubbed.fetchImpl,
    sleep: stubbed.sleep,
    now: stubbed.now,
    print: (line) => lines.push(line),
  });
  return lines;
}

const warnings = (lines) => lines.filter((line) => line.startsWith('::warning'));
const FORBIDDEN = json(200, {errors: [{type: 'FORBIDDEN', message: 'Resource not accessible by integration'}]});

describe('the comment on a pull_request stage request', () => {
  it('reads nothing and posts nothing without a workspace-id', async () => {
    const stubbed = stub({reports: [json(200, reportOf({analysed: [true], text: 'done'}))]});
    const lines = await step(stubbed, {MABL_WORKSPACE_ID: ' '});

    assert.equal(stubbed.calls.length, 0);
    assert.ok(lines.includes("pull request #7's comment: not posted, workspace-id is empty"));
  });

  it('reads the report without following a redirect', async () => {
    const stubbed = stub({reports: [json(200, reportOf({analysed: [true], text: 'done'}))]});
    await step(stubbed);

    assert.ok(stubbed.reads().length > 0);
    assert.ok(stubbed.reads().every((read) => read.redirect === 'error'));
  });

  it('posts at the first read, updates when the markdown changes, and stops once each application mabl can analyse has its analysis', async () => {
    const pending = (text) => json(200, reportOf({analysed: [false], text}));
    const lastApplications = [
      {application: 'web', mabl_application_id: 'web-a', applies: true, analysis: {session_id: 'a-as', tests: [], gaps: []}},
      {application: 'docs', applies: true},
      {application: 'admin', mabl_application_id: 'admin-a', applies: false},
    ];
    const stubbed = stub({reports: [pending('analysing'), pending('analysing'), pending('one done'), json(200, reportOf({applications: lastApplications, text: 'done'}))]});
    const lines = await step(stubbed);

    const reads = stubbed.reads();
    assert.deepEqual(
      reads.map((read) => read.at - reads[0].at),
      [0, 1, 2, 3].map((n) => n * POLL_INTERVAL_MS),
    );
    assert.deepEqual(reads[0].body, {workspace_id: 'ws-w', reference: {type: 'pull_request', id: 'github.com/org/repo#7'}, trusted_providers: 'caller', format: 'markdown'});
    assert.equal(stubbed.creates().length, 1);
    assert.equal(stubbed.updates().length, 2);
    assert.deepEqual(stubbed.store, [{id: 'IC_new1', body: bodyOf('done'), author: OURS}]);
    assert.deepEqual(
      lines.filter((line) => line.startsWith("pull request #7's comment: ")),
      ['created', 'unchanged', 'updated', 'updated'].map((what) => `pull request #7's comment: ${what}`),
    );
    assert.deepEqual(warnings(lines), []);
  });

  it('stops at comment-wait-minutes, 15 when the value is not a whole number', async () => {
    for (const [minutes, waited] of [
      ['2', 2],
      ['soon', 15],
      ['', 15],
    ]) {
      const stubbed = stub({reports: [json(200, reportOf())]});
      await step(stubbed, {COMMENT_WAIT_MINUTES: minutes});
      const reads = stubbed.reads();
      assert.equal(reads[reads.length - 1].at - reads[0].at, waited * MINUTE, minutes);
    }
  });

  it("updates the oldest comment of this token's for the same agent, and leaves an unchanged one alone", async () => {
    const stubbed = stub({
      comments: [
        {id: 'IC_first', body: bodyOf('one'), author: OURS},
        {id: 'IC_second', body: bodyOf('two'), author: OURS},
      ],
    });
    await step(stubbed);
    assert.deepEqual(
      stubbed.updates().map((call) => call.body.variables.id),
      ['IC_first'],
    );
    assert.equal(stubbed.store[1].body, bodyOf('two'));

    const same = stub({comments: [{id: 'IC_same', body: bodyOf('done').replaceAll('\n', '\r\n'), author: OURS}]});
    await step(same);
    assert.equal(same.creates().length + same.updates().length, 0);
  });

  it("never edits a comment someone else wrote, even one that quotes the marker and data line", async () => {
    const others = [
      {id: 'IC_human', body: bodyOf('quoted'), author: {__typename: 'User', login: 'dev'}},
      {id: 'IC_namesake', body: bodyOf('quoted'), author: {__typename: 'User', login: 'github-actions'}},
      {id: 'IC_other_bot', body: bodyOf('quoted'), author: {__typename: 'Bot', login: 'other-app'}},
      {id: 'IC_ghost', body: bodyOf('quoted'), author: null},
      {id: 'IC_ours_quoting', body: `> quoted\n${bodyOf('quoted')}`, author: OURS},
    ];
    const stubbed = stub({comments: others});
    await step(stubbed);

    assert.equal(stubbed.updates().length, 0);
    assert.equal(stubbed.creates().length, 1);
    assert.deepEqual(stubbed.store.slice(0, others.length), others);
  });

  it("keeps each change agent's comment apart when two callers share a token", async () => {
    const theirs = {id: 'IC_theirs', body: bodyOf('other workspace', 's0-as'), author: OURS};
    const stubbed = stub({comments: [theirs]});
    await step(stubbed);

    assert.equal(stubbed.updates().length, 0);
    assert.deepEqual(stubbed.store, [theirs, {id: 'IC_new1', body: bodyOf('done'), author: OURS}]);
  });

  it('never posts markdown without the marker on its first line or a data line naming its session', async () => {
    const report = reportOf({analysed: [true]});
    const [, dataLine, ...rest] = report.markdown.split('\n');
    for (const markdown of [
      '### hello',
      ['<!-- someone else -->', dataLine, ...rest].join('\n'),
      [`  ${MARKER}`, dataLine, ...rest].join('\n'),
      report.markdown.replace('"session_id":"s1-as"', '"session":"s1-as"'),
      MARKER,
    ]) {
      const stubbed = stub({reports: [json(200, {...report, markdown})]});
      const lines = await step(stubbed, {COMMENT_WAIT_MINUTES: '0'});
      assert.equal(stubbed.calls.filter((call) => call.url === GRAPHQL).length, 0, markdown);
      assert.equal(warnings(lines).length, 0);
    }
  });

  it('warns once and stops when the report read answers 4xx', async () => {
    const stubbed = stub({reports: [json(404, {error_code: 'no_change_agent', message: 'no agent'})]});
    const lines = await step(stubbed);

    assert.equal(stubbed.reads().length, 1);
    assert.deepEqual(warnings(lines), ["::warning title=mabl change validation::pull request #7's comment not posted: mabl's report read answered HTTP 404 no_change_agent: no agent"]);
  });

  it('keeps polling when the report read is rate limited, and posts once it answers', async () => {
    const stubbed = stub({reports: [json(429, {}), json(200, reportOf({text: 'a'})), DONE]});
    const lines = await step(stubbed);

    assert.equal(stubbed.reads().length, 3);
    assert.deepEqual(warnings(lines), []);
    assert.ok(lines.includes("pull request #7's comment: skipped a read, mabl answered HTTP 429"));
    assert.deepEqual(
      stubbed.store.map((comment) => comment.body),
      [bodyOf('done')],
    );
  });

  it('skips a poll, with a log line, when the read answers 5xx or nothing, or a post fails', async () => {
    let failedPost = false;
    const stubbed = stub({
      reports: [json(503, {}), {throws: 'socket hang up'}, json(200, reportOf({text: 'a'})), DONE],
      graphqlAnswer: (query) => (query.includes('addComment') && !failedPost && (failedPost = true) ? json(502, {}) : undefined),
    });
    const lines = await step(stubbed);

    assert.equal(stubbed.reads().length, 4);
    assert.deepEqual(warnings(lines), []);
    assert.ok(lines.includes("pull request #7's comment: skipped a read, mabl answered HTTP 503"));
    assert.ok(lines.includes("pull request #7's comment: skipped a read, mabl answered no answer: socket hang up"));
    assert.ok(lines.includes("pull request #7's comment: not posted this time (HTTP 502)"));
    assert.deepEqual(
      stubbed.store.map((comment) => comment.body),
      [bodyOf('done')],
    );
  });

  it('keeps polling when the post of a finished report fails, and posts it on the next read', async () => {
    let failedPost = false;
    const stubbed = stub({
      reports: [DONE],
      graphqlAnswer: (query) => (query.includes('addComment') && !failedPost && (failedPost = true) ? json(502, {}) : undefined),
    });
    const lines = await step(stubbed);

    assert.equal(stubbed.reads().length, 2);
    assert.ok(lines.includes("pull request #7's comment: not posted this time (HTTP 502)"));
    assert.deepEqual(stubbed.store.map((comment) => comment.body), [bodyOf('done')]);
  });

  it("warns once and stops when the token can't comment", async () => {
    const stubbed = stub({reports: [json(200, reportOf())], graphqlAnswer: (query) => (query.includes('addComment') ? FORBIDDEN : undefined)});
    const lines = await step(stubbed);

    assert.equal(stubbed.reads().length, 1);
    assert.equal(warnings(lines).length, 1);
    assert.match(warnings(lines)[0], /the token can't comment \(FORBIDDEN: Resource not accessible by integration\); it needs pull-requests: write/);
  });
});

describe('a token that cannot read or write the comments, as on a fork', () => {
  for (const [name, answer] of [
    ['HTTP 403', json(403, {message: 'Resource not accessible by integration'})],
    ['a GraphQL FORBIDDEN', FORBIDDEN],
  ]) {
    it(`gives one warning and stops after one read when listing the comments answers ${name}`, async () => {
      const stubbed = stub({reports: [json(200, reportOf())], graphqlAnswer: (query) => (query.includes('viewer') ? answer : undefined)});
      const lines = await step(stubbed);

      assert.equal(stubbed.reads().length, 1);
      assert.equal(stubbed.creates().length + stubbed.updates().length, 0);
      assert.equal(warnings(lines).length, 1);
      assert.match(warnings(lines)[0], /the token can't comment/);
    });
  }
});

describe('the comment on a merged pull request', () => {
  it("reads and posts once after mabl took the merge, whether or not every analysis finished, so it shows the branch's outcome", async () => {
    for (const outcome of ['accepted', 'duplicate']) {
      const merged = reportOf({text: 'mabl branch feature-x: merged'});
      const stubbed = stub({reports: [json(200, merged)], comments: [{id: 'IC_1', body: bodyOf('before the merge'), author: OURS}]});
      await step(stubbed, {CHANGE_VALIDATION_OUTCOME: outcome}, {action: 'closed', pull_request: {merged: true}});
      assert.equal(stubbed.reads().length, 1);
      assert.equal(stubbed.updates().length, 1);
      assert.deepEqual(
        stubbed.store.map((comment) => comment.body),
        [bodyOf('mabl branch feature-x: merged')],
      );
    }
  });
});

describe('the comment on a merge queue entry', () => {
  it('reads and posts once after a published verdict', async () => {
    for (const status of ['success', 'failure']) {
      const stubbed = stub({reports: [json(200, reportOf({text: `queue ${status}`}))]});
      await step(stubbed, {...QUEUE_ENV, CHANGE_VALIDATION_STATUS: status});
      assert.equal(stubbed.reads().length, 1);
      assert.deepEqual(
        stubbed.store.map((comment) => comment.body),
        [bodyOf(`queue ${status}`)],
      );
    }
  });

  it('posts nothing when no verdict was published, as when superseded, or the send named no pull request, as when the entry was gone', async () => {
    for (const env of [
      {CHANGE_VALIDATION_OUTCOME: 'superseded', CHANGE_VALIDATION_STATUS: ''},
      {CHANGE_VALIDATION_OUTCOME: 'entry_gone', CHANGE_VALIDATION_STATUS: '', PULL_REQUEST_NUMBER: ''},
    ]) {
      const stubbed = stub();
      await step(stubbed, {...QUEUE_ENV, ...env});
      assert.equal(stubbed.calls.length, 0);
    }
  });

  it("gets the entry's pull request number from the request step, and none when the queue dropped the entry", async () => {
    const QUEUE_HEAD = 'd'.repeat(40);
    const mergeGroup = {
      action: 'checks_requested',
      merge_group: {head_sha: QUEUE_HEAD, head_ref: `refs/heads/gh-readonly-queue/main/pr-7-${'f'.repeat(40)}`, base_sha: 'e'.repeat(40), head_commit: {timestamp: '2026-11-18T11:55:00Z'}},
    };
    const sendWith = async (entryHead) => {
      let clock = Date.parse('2026-11-18T12:00:00Z');
      const pullRequest = {number: 7, html_url: 'https://github.com/Org/Repo/pull/7', title: 't', body: '', updated_at: '2026-11-18T11:00:00Z', head: {sha: HEAD, ref: 'b', repo: {id: 1}}, base: {sha: 'b'.repeat(40), ref: 'main', repo: {id: 1}}, labels: []};
      const fetchImpl = async (url, init = {}) => {
        const path = new URL(url).pathname;
        const answer =
          path === '/repos/Org/Repo/pulls/7'
            ? json(200, pullRequest)
            : path.startsWith('/repos/Org/Repo/git/commits/')
              ? json(200, {parents: [{sha: '1'.repeat(40)}]})
              : path.startsWith('/repos/Org/Repo/compare/')
                ? json(200, {status: 'ahead', files: [{filename: 'a.ts'}]})
                : path.startsWith('/repos/Org/Repo/contents/')
                  ? {status: 200, body: 'version: 1\n'}
                  : path === '/graphql'
                    ? json(200, {data: {repository: {pullRequest: {headRefOid: HEAD, mergeQueueEntry: {headCommit: {oid: entryHead}}}}}})
                    : path.startsWith('/repos/Org/Repo/statuses/')
                      ? {status: 201, body: '{}'}
                      : path === RESOLVE_PATH
                        ? json(200, {valid: true, stages: {}})
                        : path === EVENTS_PATH
                          ? json(201, {session_id: 's1-as', event: 'accepted'})
                          : path === STATUS_PATH
                            ? json(200, {summary: 'ok', stages: [{stage: 'merge_queue', gate: 'ready', summary: 'ok', checks: [{must_pass: true, status: 'passed'}]}]})
                            : undefined;
        assert.ok(answer, `unexpected ${url}`);
        return new Response(answer.body, {status: answer.status});
      };
      const dir = mkdtempSync(join(tmpdir(), 'change-validation-comment-'));
      writeFileSync(join(dir, 'event.json'), JSON.stringify(mergeGroup));
      return run({
        env: {
          GITHUB_EVENT_NAME: 'merge_group',
          GITHUB_EVENT_PATH: join(dir, 'event.json'),
          GITHUB_REPOSITORY: 'Org/Repo',
          GITHUB_API_URL: GITHUB_API,
          GH_TOKEN,
          MABL_API_KEY: API_KEY,
          MABL_WORKSPACE_ID: 'ws-w',
          CHANGE_VALIDATION_STAGE: 'merge_queue',
          CHANGE_VALIDATION_AWAIT: 'true',
          STATUS_CONTEXT: 'ctx',
        },
        fetchImpl,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        signalAfter: () => new AbortController().signal,
        print: () => {},
      });
    };
    const queued = await sendWith('d'.repeat(40));
    assert.equal(queued.outputs['pull-request-number'], '7');
    assert.equal(queued.outputs.status, 'success');
    const gone = await sendWith('f'.repeat(40));
    assert.equal(gone.outputs.outcome, 'entry_gone');
    assert.equal(gone.outputs['pull-request-number'], '');
  });
});

describe('when the comment step posts nothing', () => {
  it('is off unless comment is true, and off for commands, pull requests closed without merging and requests mabl did not take', async () => {
    for (const [env, payload] of [
      [{CHANGE_VALIDATION_COMMENT: ''}, undefined],
      [{CHANGE_VALIDATION_COMMENT: 'false'}, undefined],
      [{GITHUB_EVENT_NAME: 'issue_comment'}, {action: 'created'}],
      [{CHANGE_VALIDATION_OUTCOME: 'skipped'}, {action: 'closed'}],
      [{CHANGE_VALIDATION_OUTCOME: 'superseded'}, {action: 'closed'}],
      [{CHANGE_VALIDATION_OUTCOME: 'no_change_agent'}, {action: 'closed'}],
      [{CHANGE_VALIDATION_OUTCOME: 'superseded'}, undefined],
      [{CHANGE_VALIDATION_OUTCOME: 'invalid_request'}, undefined],
      [{GITHUB_EVENT_NAME: 'merge_group'}, undefined],
      [{GITHUB_EVENT_NAME: 'push', PULL_REQUEST_NUMBER: ''}, undefined],
      [{PULL_REQUEST_NUMBER: '0'}, undefined],
      [{PULL_REQUEST_NUMBER: '07'}, undefined],
      [{PULL_REQUEST_NUMBER: '7) { x'}, undefined],
      [{PULL_REQUEST_NUMBER: '-1'}, undefined],
    ]) {
      const stubbed = stub();
      await step(stubbed, env, payload);
      assert.equal(stubbed.calls.length, 0, JSON.stringify(env));
    }
  });
});

describe('what the step sends and prints', () => {
  it("escapes line breaks and invisible characters in mabl's answers, so no answer can forge a workflow command", async () => {
    const forged = `x\n::error::forged\r\n%0A \u202e`;
    const stubbed = stub({reports: [json(500, {message: forged}), json(403, {error_code: 'forbidden', message: forged})]});
    const lines = await step(stubbed);

    assert.equal(stubbed.reads().length, 2);
    assert.equal(lines.filter((line) => line.includes('forged')).length, 2);
    for (const line of lines) {
      assert.ok(!/[\r\n\u202e]/.test(line), JSON.stringify(line));
      assert.ok(!line.startsWith('::error'), line);
    }
  });

  it('sends the repository, pull request and body to GitHub only as GraphQL variables, under fixed queries', async () => {
    const queriesFor = async (repository, number) => {
      const stubbed = stub({reports: [json(200, reportOf({text: 'a'})), DONE], comments: []});
      await step(stubbed, {GITHUB_REPOSITORY: repository, PULL_REQUEST_NUMBER: number});
      const calls = stubbed.calls.filter((call) => call.url === GRAPHQL);
      assert.deepEqual(
        calls.map((call) => Object.keys(call.body).sort()),
        calls.map(() => ['query', 'variables']),
      );
      const [owner, name] = repository.split('/');
      for (const {body} of calls) {
        for (const value of [owner, name, number, 'PR_7', bodyOf('a'), bodyOf('done'), 'IC_new1']) {
          assert.ok(!body.query.includes(value), `${value} in ${body.query}`);
        }
      }
      const finds = calls.filter((call) => call.body.query.includes('viewer'));
      assert.ok(finds.every((call) => call.body.variables.owner === owner && call.body.variables.name === name && call.body.variables.number === Number(number)));
      assert.deepEqual(stubbed.creates()[0].body.variables, {subject: 'PR_7', body: bodyOf('a')});
      assert.deepEqual(stubbed.updates()[0].body.variables, {id: 'IC_new1', body: bodyOf('done')});
      return [...new Set(calls.map((call) => call.body.query))].sort();
    };
    const first = await queriesFor('Org/Repo', '7');
    assert.equal(first.length, 3);
    assert.deepEqual(await queriesFor('Some-Org/other.repo', '4321'), first);
  });
});

describe('secrets', () => {
  it('prints neither secret, even when mabl and GitHub echo them, and sends each only to its own host', async () => {
    const echo = `${API_KEY} ${GH_TOKEN}`;
    const stubbed = stub({
      reports: [json(500, {message: echo}), json(200, reportOf({text: 'a'})), json(403, {error_code: 'forbidden', message: echo})],
      graphqlAnswer: (query) => (query.includes('addComment') ? json(200, {errors: [{type: 'INTERNAL', message: echo}]}) : undefined),
    });
    const lines = await step(stubbed);

    assert.ok(lines.some((line) => line.includes('***')));
    for (const line of lines) {
      assert.ok(!line.includes(API_KEY) && !line.includes(GH_TOKEN), line);
    }
    for (const call of stubbed.calls) {
      const sent = JSON.stringify([call.headers, call.body]);
      assert.equal(sent.includes(basicAuthorization(API_KEY)), call.url.startsWith(MABL), call.url);
      assert.ok(!sent.includes(API_KEY), call.url);
      assert.equal(sent.includes(GH_TOKEN), call.url === GRAPHQL, call.url);
    }
    assert.ok(stubbed.calls.some((call) => call.url === GRAPHQL));
  });
});
