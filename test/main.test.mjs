import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it} from 'node:test';

import {STATUS_PATH} from '../src/await-status.mjs';
import {commentPlan} from '../src/comment.mjs';
import {OUTPUTS, action} from '../src/main.mjs';
import {EVENTS_PATH, RESOLVE_PATH} from '../src/stage-request.mjs';

const GITHUB_API = 'https://api.github.example.test';
const HEAD = 'a'.repeat(40);
const json = (status, body) => ({status, body: JSON.stringify(body)});

function files(payload) {
  const dir = mkdtempSync(join(tmpdir(), 'change-validation-main-'));
  writeFileSync(join(dir, 'event.json'), JSON.stringify(payload));
  writeFileSync(join(dir, 'output'), '');
  return {event: join(dir, 'event.json'), output: join(dir, 'output')};
}

// A pull_request event the action skips without calling anyone: exit code 0.
function skippedRun() {
  const {event, output} = files({action: 'labeled', pull_request: {number: 7}});
  return {
    env: {GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output, MABL_API_KEY: 'mabl-key', CHANGE_VALIDATION_STAGE: 'pull_request', CHANGE_VALIDATION_COMMENT: 'true'},
    output,
  };
}

const fetchNothing = async (url) => {
  throw new Error(`unexpected ${url}`);
};

describe('the action', () => {
  it('keeps its exit code and outputs when the comment throws, and only warns', async () => {
    const quiet = skippedRun();
    const plain = await action({env: quiet.env, fetchImpl: fetchNothing, print: () => {}, comment: async () => {}});
    const throwing = skippedRun();
    const lines = [];
    const thrown = await action({
      env: throwing.env,
      fetchImpl: fetchNothing,
      print: (line) => lines.push(line),
      comment: async () => {
        throw new Error('boom mabl-key\n::error::forged');
      },
    });

    assert.equal(thrown.exitCode, plain.exitCode);
    assert.deepEqual(thrown.outputs, plain.outputs);
    const warnings = lines.filter((line) => line.startsWith('::warning'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /the pull request comment stopped: boom \*\*\*/);
    assert.ok(!lines.some((line) => line.startsWith('::error')));
  });

  it('writes its declared outputs before the comment runs, and never the pull request number', async () => {
    const {env, output} = skippedRun();
    let seen = null;
    const {outputs} = await action({
      env,
      fetchImpl: fetchNothing,
      print: () => {},
      comment: async () => {
        seen = readFileSync(output, 'utf8');
      },
    });

    assert.match(seen, /^outcome<<ghadelimiter_[0-9a-f-]+\nskipped\n/);
    assert.ok(!seen.includes('pull-request-number'));
    assert.ok(Object.keys(outputs).every((name) => OUTPUTS.includes(name)));
  });

  it('runs the comment once after an awaited merge queue entry that failed', async () => {
    const mergeGroup = {
      action: 'checks_requested',
      merge_group: {head_sha: 'd'.repeat(40), head_ref: `refs/heads/gh-readonly-queue/main/pr-7-${'f'.repeat(40)}`, base_sha: 'e'.repeat(40), head_commit: {timestamp: '2026-11-18T11:55:00Z'}},
    };
    const pullRequest = {number: 7, html_url: 'https://github.com/Org/Repo/pull/7', title: 't', body: '', updated_at: '2026-11-18T11:00:00Z', head: {sha: HEAD, ref: 'b', repo: {id: 1}}, base: {sha: 'b'.repeat(40), ref: 'main', repo: {id: 1}}, labels: []};
    const fetchImpl = async (url) => {
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
                  ? json(200, {data: {repository: {pullRequest: {headRefOid: HEAD, mergeQueueEntry: {headCommit: {oid: 'd'.repeat(40)}}}}}})
                  : path.startsWith('/repos/Org/Repo/statuses/')
                    ? {status: 201, body: '{}'}
                    : path === RESOLVE_PATH
                      ? json(200, {valid: true, stages: {}})
                      : path === EVENTS_PATH
                        ? json(201, {session_id: 's1-as', event: 'accepted'})
                        : path === STATUS_PATH
                          ? json(200, {summary: 'smoke failed', stages: [{stage: 'merge_queue', gate: 'fail', summary: 'smoke failed', checks: [{must_pass: true, status: 'failed'}]}]})
                          : undefined;
      assert.ok(answer, `unexpected ${url}`);
      return new Response(answer.body, {status: answer.status});
    };
    const {event, output} = files(mergeGroup);
    let clock = Date.parse('2026-11-18T12:00:00Z');
    const calls = [];
    const {exitCode, outputs} = await action({
      env: {
        GITHUB_EVENT_NAME: 'merge_group',
        GITHUB_EVENT_PATH: event,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: 'Org/Repo',
        GITHUB_API_URL: GITHUB_API,
        GH_TOKEN: 'ghs_token',
        MABL_API_KEY: 'mabl-key',
        MABL_WORKSPACE_ID: 'ws-w',
        CHANGE_VALIDATION_STAGE: 'merge_queue',
        CHANGE_VALIDATION_AWAIT: 'true',
        CHANGE_VALIDATION_COMMENT: 'true',
        STATUS_CONTEXT: 'ctx',
      },
      fetchImpl,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      signalAfter: () => new AbortController().signal,
      print: () => {},
      comment: async ({env}) => {
        calls.push(env);
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(outputs.status, 'failure');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].CHANGE_VALIDATION_STATUS, 'failure');
    assert.equal(calls[0].PULL_REQUEST_NUMBER, '7');
    assert.equal(commentPlan({env: calls[0], payload: mergeGroup}), 'once');
  });

  it("hands the comment a pull request to keep current with send 'false', having sent nothing", async () => {
    const payload = {action: 'synchronize', pull_request: {number: 7, head: {sha: HEAD, repo: {id: 1}}, base: {repo: {id: 1}}}};
    const {event, output} = files(payload);
    const calls = [];
    const {exitCode, outputs} = await action({
      env: {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: event,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: 'Org/Repo',
        MABL_API_KEY: 'mabl-key',
        MABL_WORKSPACE_ID: 'ws-w',
        CHANGE_VALIDATION_SEND: 'false',
        CHANGE_VALIDATION_COMMENT: 'true',
      },
      fetchImpl: fetchNothing,
      print: () => {},
      comment: async ({env}) => {
        calls.push(env);
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(outputs.outcome, 'comment_only');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].PULL_REQUEST_NUMBER, '7');
    assert.equal(commentPlan({env: calls[0], payload}), 'wait');
    assert.match(readFileSync(output, 'utf8'), /^outcome<<ghadelimiter_[0-9a-f-]+\ncomment_only\n/);
  });

  it("fails on a diverged mabl branch at the merge, and still updates the comment once to show it", async () => {
    const closed = {
      action: 'closed',
      pull_request: {
        number: 7,
        html_url: 'https://github.com/Org/Repo/pull/7',
        merged: true,
        merge_commit_sha: 'f'.repeat(40),
        merged_at: '2026-11-18T11:00:00Z',
        head: {sha: HEAD, ref: 'feature-x', repo: {id: 1}},
        base: {sha: 'b'.repeat(40), ref: 'main', repo: {id: 1}},
      },
    };
    const landed = {merge_commit_sha: 'f'.repeat(40), merge_mabl_branches: true, branches: [{name: 'feature-x', outcome: 'diverged', diverged_entities: [{id: 'checkout-j', type: 'test', name: 'Checkout'}]}]};
    const fetchImpl = async (url) => {
      const path = new URL(url).pathname;
      const answer = path.startsWith('/repos/Org/Repo/contents/')
        ? {status: 200, body: 'version: 1\nmerge_mabl_branches: true\n'}
        : path === EVENTS_PATH
          ? json(200, {session_id: 's1-as', created: false, event: 'accepted', agent: 'working', landed})
          : undefined;
      assert.ok(answer, `unexpected ${url}`);
      return new Response(answer.body, {status: answer.status});
    };
    const {event, output} = files(closed);
    const calls = [];
    const lines = [];
    const {exitCode, outputs} = await action({
      env: {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: event,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: 'Org/Repo',
        GITHUB_API_URL: GITHUB_API,
        GH_TOKEN: 'ghs_token',
        MABL_API_KEY: 'mabl-key',
        MABL_WORKSPACE_ID: 'ws-w',
        CHANGE_VALIDATION_STAGE: 'pull_request',
        CHANGE_VALIDATION_COMMENT: 'true',
      },
      fetchImpl,
      print: (line) => lines.push(line),
      comment: async ({env}) => {
        calls.push(env);
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(outputs.outcome, 'accepted');
    assert.ok(lines.some((line) => line.startsWith('::error ') && line.includes('mabl branch feature-x: not merged') && line.includes('test "Checkout"')), lines.join('\n'));
    assert.equal(calls.length, 1);
    assert.equal(commentPlan({env: calls[0], payload: closed}), 'merged');
  });
});
