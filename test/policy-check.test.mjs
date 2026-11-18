import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {delimiter, dirname, join} from 'node:path';
import {describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

import {MAX_SUMMARY_BYTES, RESOLVE_PATH, canonicalJson, main, renderSummary, resolveWithApi} from '../src/policy-check.mjs';
import {annotation, writeOutputs} from '../src/lib/workflow-commands.mjs';
import {POLICY_INPUTS, policyEnvFromInputs} from '../policy/main.mjs';
import {POLICY_FILE, readPolicyAt} from '../src/lib/policy-read.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
// How a message or the summary writes a character that wouldn't show: \u and four hex digits.
const u = (code) => `\\u${code.toString(16).padStart(4, '0')}`;
// What none of the action's text may hold raw.
const HIDDEN_PATTERN = /(?! )[\p{Cc}\p{Cf}\p{Z}\p{Default_Ignorable_Code_Point}]/u;
const EM_DASH = String.fromCodePoint(0x2014);

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const API = 'https://api.example.test';
const NOT_FOUND = {status: 404, body: JSON.stringify({message: 'Not Found', documentation_url: 'https://docs.example.test'})};
const file = (text) => ({status: 200, body: text, headers: {'content-type': 'application/vnd.github.raw+json'}});

// Answers the contents api from `byRef`, by ref, and a commit lookup from `commits`, by sha, or
// with 200; records every url, its headers and its signal. Refuses a header as fetch does.
function stubContents(byRef, commits = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    new Headers(init?.headers);
    const parsed = new URL(url);
    calls.push({url: parsed, headers: init?.headers ?? {}, signal: init?.signal});
    const commit = /\/git\/commits\/([0-9a-f]{40})$/.exec(parsed.pathname);
    const answer = commit ? (commits[commit[1]] ?? {status: 200, body: '{}'}) : byRef[parsed.searchParams.get('ref')];
    if (answer === undefined) {
      throw new Error(`unexpected ${url}`);
    }
    return new Response(answer.body ?? '', {status: answer.status ?? 200, headers: answer.headers ?? {}});
  };
  return {fetchImpl, calls};
}

const READ = {repository: 'org/repo', file: POLICY_FILE, ref: HEAD, token: 'ghs_test', apiUrl: API};

describe('reading the file at a commit', () => {
  it('asks the contents api for the raw file at that commit', async () => {
    const {fetchImpl, calls} = stubContents({[HEAD]: file('version: 1\n')});
    assert.deepEqual(await readPolicyAt({...READ, file: 'config/mabl_policy-v1.yaml', fetchImpl}), {
      found: true,
      text: 'version: 1\n',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.href, `${API}/repos/org/repo/contents/config/mabl_policy-v1.yaml?ref=${HEAD}`);
    assert.deepEqual(calls[0].headers, {
      Authorization: 'Bearer ghs_test',
      Accept: 'application/vnd.github.raw',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'mabl-change-validation-action',
    });
    assert.ok(calls[0].signal instanceof AbortSignal, 'a time limit');
    assert.equal(calls[0].signal.aborted, false);
  });

  it('says there is no file only for a plain 404 at a commit the token can see', async () => {
    const {fetchImpl, calls} = stubContents({[HEAD]: NOT_FOUND});
    assert.deepEqual(await readPolicyAt({...READ, fetchImpl}), {found: false});
    assert.deepEqual(
      calls.map(({url, headers}) => [url.href, headers.Authorization, headers.Accept]),
      [
        [`${API}/repos/org/repo/contents/${POLICY_FILE}?ref=${HEAD}`, 'Bearer ghs_test', 'application/vnd.github.raw'],
        [`${API}/repos/org/repo/git/commits/${HEAD}`, 'Bearer ghs_test', 'application/vnd.github+json'],
      ],
    );
    assert.ok(calls[1].signal instanceof AbortSignal, 'a time limit');
  });

  it('waits for an answer that takes a while', async () => {
    const {fetchImpl} = stubContents({[HEAD]: file('version: 1\n'), [BASE]: NOT_FOUND});
    // Answers after 100 ms, unless the request's signal gives up first.
    const slowly = (url, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(fetchImpl(url, init)), 100);
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal.reason);
        });
      });
    assert.deepEqual(await readPolicyAt({...READ, fetchImpl: slowly}), {found: true, text: 'version: 1\n'});
    assert.deepEqual(await readPolicyAt({...READ, ref: BASE, fetchImpl: slowly}), {found: false});
  });

  // GitHub answers a plain 404 for the file in a repository that doesn't exist or the token can't see.
  for (const status of [404, 401, 500]) {
    it(`throws on a plain 404 when asking for the commit answers ${status}`, async () => {
      const {fetchImpl} = stubContents({[HEAD]: NOT_FOUND}, {[HEAD]: {...NOT_FOUND, status}});
      await assert.rejects(readPolicyAt({...READ, fetchImpl}), (error) => {
        assert.equal(
          error.message,
          `reading .mabl/policy.yaml at ${HEAD} answered HTTP 404, and asking for the commit answered HTTP ${status}: check that repository org/repo exists and the token can read it`,
        );
        return true;
      });
    });
  }

  // The stubs above hang before the headers; this one answers the headers and then stalls the body.
  it('gives up on a body that stalls', {timeout: 10_000}, async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, {'content-type': 'application/vnd.github.raw', 'content-length': '100'});
      response.write('# x');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const apiUrl = `http://127.0.0.1:${server.address().port}`;
      await assert.rejects(readPolicyAt({...READ, apiUrl, fetchImpl: fetch, timeoutMs: 200}), {name: 'TimeoutError'});
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('trims a long token in linear time', async () => {
    const {fetchImpl} = stubContents({[HEAD]: file('version: 1\n')});
    const start = performance.now();
    await assert.rejects(readPolicyAt({...READ, token: `a${' '.repeat(128 * 1024)}b`, fetchImpl}), /token has to be printable ASCII/);
    assert.ok(performance.now() - start < 250, `${Math.round(performance.now() - start)} ms`);
  });

  it('takes a file of exactly 64 KiB', async () => {
    const {fetchImpl} = stubContents({[HEAD]: file(`#${'x'.repeat(64 * 1024 - 2)}\n`)});
    assert.equal((await readPolicyAt({...READ, fetchImpl})).found, true);
  });

  it('refuses a token with a space or control character inside it, without quoting it', async () => {
    for (const token of ['ghs_SECRET1\nSECRET2', 'ghs_SECRET1\u0000SECRET2', 'ghs_SECRET1 SECRET2', 'ghs_SECRET1é']) {
      const {fetchImpl, calls} = stubContents({[HEAD]: NOT_FOUND});
      await assert.rejects(readPolicyAt({...READ, token, fetchImpl}), (error) => {
        assert.equal(error.message, 'token has to be printable ASCII, with no space or line break inside it');
        return true;
      });
      assert.equal(calls.length, 0, JSON.stringify(token));
    }
  });

  it('sends a token with whitespace at its ends trimmed, as fetch would', async () => {
    const {fetchImpl, calls} = stubContents({[HEAD]: NOT_FOUND});
    assert.deepEqual(await readPolicyAt({...READ, token: ' ghs_test\r\n', fetchImpl}), {found: false});
    assert.equal(calls[0].headers.Authorization, 'Bearer ghs_test');
  });

  it('takes a file path of 200 characters', async () => {
    const {fetchImpl, calls} = stubContents({[HEAD]: NOT_FOUND});
    assert.deepEqual(await readPolicyAt({...READ, file: 'x'.repeat(200), fetchImpl}), {found: false});
    assert.equal(calls[0].url.pathname, `/repos/org/repo/contents/${'x'.repeat(200)}`);
  });

  for (const [what, answer, message] of [
    ['a file over 64 KiB in bytes but not in characters', file('\u00e9'.repeat(33 * 1024)), /larger than 64 KiB/],
    ['an unknown commit', {status: 404, body: JSON.stringify({message: `No commit found for the ref ${HEAD}`})}, /HTTP 404: No commit found/],
    ['a 404 with no body', {status: 404}, /HTTP 404/],
    ['a server error', {status: 500, body: 'oops'}, /HTTP 500/],
    ['a 403', {status: 403, body: JSON.stringify({message: 'Resource not accessible by integration'})}, /HTTP 403: Resource/],
    ['a directory', {status: 200, body: '[]', headers: {'content-type': 'application/json; charset=utf-8'}}, /is not a file/],
    ['bytes that are not UTF-8', {...file(''), body: Uint8Array.of(0x23, 0x20, 0xff, 0xfe, 0x0a)}, /is not valid UTF-8/],
    ['a truncated UTF-8 sequence', {...file(''), body: Uint8Array.of(0x23, 0x20, 0xe2, 0x82)}, /is not valid UTF-8/],
    ['a file over 64 KiB', file(`# ${'x'.repeat(64 * 1024)}\n`), /larger than 64 KiB/],
    ['a BOM and 64 KiB after it', file(`\ufeff#${'x'.repeat(64 * 1024 - 2)}\n`), /larger than 64 KiB/],
    ['bytes that are not UTF-8, under 64 KiB', {...file(''), body: new Uint8Array(40 * 1024).fill(0xff)}, /is not valid UTF-8/],
  ]) {
    it(`throws on ${what}`, async () => {
      const {fetchImpl} = stubContents({[HEAD]: answer});
      await assert.rejects(readPolicyAt({...READ, fetchImpl}), {message});
    });
  }

  for (const [field, values] of [
    ['repository', ['', 'org', 'org/repo/x', '../repo', 'org/..', './repo', 'org/.', 'org/re po']],
    ['file', ['', '/etc/passwd', '../x.yaml', 'a/../b.yaml', './a.yaml', 'a//b.yaml', 'a b.yaml', 'a/', 'x'.repeat(201), 'a%2F..']],
    ['ref', ['', 'main', 'abc1234', 'A'.repeat(40), `${HEAD}0`, `${HEAD.slice(1)}/`]],
  ]) {
    for (const value of values) {
      it(`refuses ${field} ${JSON.stringify(value.length > 40 ? `${value.slice(0, 20)}...` : value)} before asking`, async () => {
        const {fetchImpl, calls} = stubContents({});
        await assert.rejects(readPolicyAt({...READ, [field]: value, fetchImpl}), new RegExp(`^Error: ${field} has to be`));
        assert.equal(calls.length, 0);
      });
    }
  }
});

// GitHub's reading of $GITHUB_OUTPUT: `name=value` lines and `name<<delimiter` blocks.
function parseOutputs(text) {
  const outputs = {};
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const heredoc = /^([^=<]+)<<(.+)$/.exec(lines[index]);
    if (heredoc) {
      const value = [];
      for (index += 1; lines[index] !== heredoc[2]; index += 1) {
        assert.ok(index < lines.length, `unterminated ${heredoc[1]}`);
        value.push(lines[index]);
      }
      outputs[heredoc[1]] = value.join('\n');
    } else if (lines[index] !== '') {
      const [name, ...rest] = lines[index].split('=');
      outputs[name] = rest.join('=');
    }
  }
  return outputs;
}


// What the api answers, built here.
const stage = (settings = {}) => ({
  mabl_application: 'app-web',
  scope: 'pull_request',
  mabl_branch: 'match-pr',
  author_gaps: {when: 'never'},
  suite_checks: {},
  suite_labels: {},
  ...settings,
});
const impacted = (exclude, mustPass = false) => ({must_pass: mustPass, run: true, budget_minutes: 50, include: {suites: ['smoke', 'regression']}, exclude: {median_minutes_over: exclude}});
const STAGES = {
  web: {
    pull_request: stage({impacted: impacted(10)}),
    merge_queue: stage({impacted: impacted(10, true), suite_labels: {smoke: ['ci-smoke']}}),
    release: stage({target: {credentials: 'login-id-789'}}),
  },
  admin: {pull_request: stage({mabl_application: 'app-admin', suite_checks: {}})},
};
const CHANGED_STAGES = {
  web: {
    pull_request: stage({impacted: impacted(20)}),
    merge_queue: stage({impacted: impacted(20, true), suite_labels: {smoke: ['ci-smoke']}}),
    release: STAGES.web.release,
  },
};
const POLICY = {version: 1, applications: {web: {mabl_application: 'app-web'}, admin: {mabl_application: 'app-admin'}}};
const valid = (stages) => ({valid: true, errors: [], policy: POLICY, stages});
const invalid = (errors) => ({valid: false, errors});
const UNKNOWN_SUITE = {path: 'impacted.logins_from[1]', message: 'unknown suite "nightly" (suites: smoke, regression)', line: 14, column: 24};
const digestOf = (stages) => createHash('sha256').update(canonicalJson(stages)).digest('hex');
// The same value with every object's keys in reverse order.
const reversedKeys = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reversedKeys(entry)]))
    : value;

// The api's answer for each file text the tests read.
const ANSWERS = new Map([
  ['# example\n', valid(STAGES)],
  ['# example, reformatted\n', valid(reversedKeys(STAGES))],
  ['# changed\n', valid(CHANGED_STAGES)],
  ['# unknown suite\n', invalid([UNKNOWN_SUITE])],
]);
const [EXAMPLE, REFORMATTED, CHANGED, BROKEN] = ANSWERS.keys();

async function runAction({head, base, compare = '', policyFile, token = 'ghs_test', commits = {}, answers = ANSWERS} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mabl-policy-action-'));
  const outputPath = join(dir, 'output');
  const summaryPath = join(dir, 'step-summary.md');
  writeFileSync(outputPath, '');
  writeFileSync(summaryPath, '');
  const {fetchImpl, calls} = stubContents({[HEAD]: head, ...(base ? {[BASE]: base} : {})}, commits);
  const resolved = [];
  const resolveImpl = (text) => {
    resolved.push(text);
    const answer = answers.get(text);
    if (answer instanceof Error) {
      throw answer;
    }
    return answer ?? assert.fail(`no answer for ${JSON.stringify(text)}`);
  };
  const printed = [];
  const envRead = new Set();
  const env = {
    POLICY_REF: HEAD,
    POLICY_COMPARE_REF: compare,
    POLICY_FILE: policyFile ?? '',
    POLICY_REPOSITORY: 'org/repo',
    GH_TOKEN: token,
    MABL_API_KEY: 'mabl-key',
    GITHUB_API_URL: API,
    GITHUB_OUTPUT: outputPath,
    GITHUB_STEP_SUMMARY: summaryPath,
    RUNNER_TEMP: dir,
  };
  const code = await main({
    env: new Proxy(env, {
      get(target, name) {
        envRead.add(name);
        return target[name];
      },
    }),
    fetchImpl,
    resolveImpl,
    print: (line) => printed.push(line),
  });
  const outputs = parseOutputs(readFileSync(outputPath, 'utf8'));
  return {code, outputs, printed, calls, resolved, envRead, dir, stepSummary: readFileSync(summaryPath, 'utf8')};
}

describe('the action', () => {
  it('outputs what the api resolves a valid file to', async () => {
    const {code, outputs, printed, stepSummary, calls, resolved} = await runAction({head: file(EXAMPLE)});
    assert.equal(code, 0);
    assert.deepEqual(printed, []);
    assert.deepEqual(
      calls.map(({url, headers}) => [url.origin, headers.Authorization]),
      [[API, 'Bearer ghs_test']],
    );
    assert.deepEqual(resolved, [EXAMPLE]);
    assert.equal(outputs.found, 'true');
    assert.equal(outputs.digest, digestOf(STAGES));
    assert.deepEqual(JSON.parse(outputs.policy), POLICY);
    assert.deepEqual(JSON.parse(outputs.stages), STAGES);
    assert.match(stepSummary, new RegExp(`is valid \\(digest \`${digestOf(STAGES).slice(0, 12)}\`\\)\\.\\n$`));
  });

  it('notices a missing file and passes, resolving nothing', async () => {
    const {code, outputs, printed, resolved} = await runAction({head: NOT_FOUND});
    assert.equal(code, 0);
    assert.deepEqual(printed, [`::notice title=mabl policy::no ${POLICY_FILE} at ${HEAD}`]);
    assert.deepEqual([outputs.found, outputs.digest, outputs.policy, outputs.stages], ['false', '', '{}', '{}']);
    assert.deepEqual(resolved, []);
  });

  for (const [what, run, error] of [
    [
      'the api gives no answer',
      {head: file(EXAMPLE), answers: new Map([[EXAMPLE, new Error('could not resolve: Request failed with status code 503')]])},
      'could not resolve: Request failed with status code 503',
    ],
    ['the file cannot be read', {head: {status: 502, body: 'bad gateway'}}, `reading ${POLICY_FILE} at ${HEAD} answered HTTP 502`],
    [
      'the token is one fetch would refuse',
      {head: file(EXAMPLE), token: 'ghs_SECRET1\nSECRET2'},
      'token has to be printable ASCII, with no space or line break inside it',
    ],
  ]) {
    it(`fails, and outputs no found value, when ${what}`, async () => {
      const {code, outputs, printed, stepSummary} = await runAction(run);
      assert.equal(code, 1);
      assert.deepEqual(printed, [`::error title=mabl policy::could not read ${POLICY_FILE} at ${HEAD}: ${error}`]);
      assert.deepEqual([outputs.found, outputs.digest, outputs.policy, outputs.stages], ['', '', '{}', '{}']);
      assert.ok(stepSummary.endsWith(` could not be read: \`${error}\`\n`), stepSummary);
      assert.doesNotMatch(stepSummary, /SECRET/);
    });
  }

  it('annotates every error, at its line and column when it has one, clipped, and fails', async () => {
    const errors = [UNKNOWN_SUITE, {path: '', message: `too long ${'x'.repeat(5000)}`}];
    const {code, outputs, printed, stepSummary} = await runAction({
      head: file(BROKEN),
      base: file(EXAMPLE),
      compare: BASE,
      answers: new Map([...ANSWERS, [BROKEN, invalid(errors)]]),
    });
    assert.equal(code, 1);
    assert.equal(printed.length, 2);
    assert.equal(
      printed[0],
      '::error file=.mabl/policy.yaml,line=14,col=24,title=mabl policy::impacted.logins_from[1]: unknown suite "nightly" (suites: smoke, regression)',
    );
    assert.match(printed[1], /^::error file=\.mabl\/policy\.yaml,title=mabl policy::too long x+\u2026$/);
    assert.ok(printed[1].length < 600, String(printed[1].length));
    assert.deepEqual([outputs.found, outputs.digest, outputs.policy, outputs.stages], ['true', '', '{}', '{}'], "the base's policy is not the head's");
    assert.match(stepSummary, /is invalid: 2 errors\./);
    assert.match(stepSummary, /^- `14:24 impacted\.logins_from\[1\]: unknown suite "nightly"/m);
    assert.match(stepSummary, /^- `too long x+\u2026`$/m);
    assert.doesNotMatch(stepSummary, /####|^\| /m, 'no settings, which would read as all removed');
  });

  it('lists what changed from compare-ref, one table per application stage', async () => {
    const {code, stepSummary, calls, resolved} = await runAction({head: file(CHANGED), base: file(EXAMPLE), compare: BASE});
    assert.equal(code, 0);
    assert.deepEqual(
      calls.map(({url, headers}) => [url.origin, url.searchParams.get('ref'), headers.Authorization]),
      [
        [API, HEAD, 'Bearer ghs_test'],
        [API, BASE, 'Bearer ghs_test'],
      ],
    );
    assert.deepEqual(resolved, [CHANGED, EXAMPLE]);
    assert.match(stepSummary, /Resolved settings changed from `bbbbbbb`:/);
    const tables = stepSummary.match(/^#### .*$/gm);
    assert.deepEqual(tables, ['#### `web` `pull_request`', '#### `web` `merge_queue`', '#### `admin` `pull_request` (removed)']);
    assert.match(stepSummary, /^\| `impacted\.exclude\.median_minutes_over` \| `10` \| `20` \|$/m);
  });

  it('says nothing changed when the resolved stages are the same', async () => {
    const {stepSummary} = await runAction({head: file(EXAMPLE), base: file(REFORMATTED), compare: BASE});
    assert.match(stepSummary, /No resolved setting changed from `bbbbbbb`\./);
    assert.doesNotMatch(stepSummary, /####/);
  });

  it('shows a file new at ref as added', async () => {
    const {code, stepSummary} = await runAction({head: file(EXAMPLE), base: NOT_FOUND, compare: BASE});
    assert.equal(code, 0);
    assert.match(stepSummary, /It was added: there is no policy at `bbbbbbb`\./);
    assert.match(stepSummary, /^#### `web` `release` \(added\)$/m);
    assert.match(stepSummary, /^\| `target\.credentials` \| \u2014 \| `"login-id-789"` \|$/m);
    const admin = stepSummary.indexOf('#### `admin` `pull_request` (added)');
    assert.ok(admin >= 0);
    assert.ok(stepSummary.slice(admin).split('\n').includes(`| \`suite_checks\` | ${EM_DASH} | \`{}\` |`), 'an empty mapping is a row');
  });

  it('shows the base stages as removed when the file is gone', async () => {
    const {code, outputs, printed, stepSummary} = await runAction({head: NOT_FOUND, base: file(EXAMPLE), compare: BASE});
    assert.equal(code, 0);
    assert.deepEqual(printed, [
      `::warning title=mabl policy::no ${POLICY_FILE} at ${HEAD}, but ${BASE} has one: every setting there is removed`,
    ]);
    assert.deepEqual([outputs.found, outputs.digest, outputs.policy], ['false', '', '{}']);
    assert.match(stepSummary, /no policy file\. It was removed; there is one at `bbbbbbb`\./);
    assert.match(stepSummary, /^#### `admin` `pull_request` \(removed\)$/m);
  });

  it('warns about an invalid base and compares with nothing', async () => {
    const {code, printed, stepSummary} = await runAction({head: file(EXAMPLE), base: file(BROKEN), compare: BASE});
    assert.equal(code, 0);
    assert.deepEqual(printed, [
      `::warning title=mabl policy::${POLICY_FILE} at ${BASE} is invalid, so every setting is compared with nothing`,
    ]);
    assert.match(stepSummary, /is valid \(digest `[0-9a-f]{12}`\)\. The file at `bbbbbbb` is invalid, so every setting is compared with nothing\.\n/);
  });

  it('only warns when compare-ref cannot be read', async () => {
    const {code, printed, stepSummary} = await runAction({head: file(EXAMPLE), base: {status: 500}, compare: BASE});
    assert.equal(code, 0);
    assert.match(printed[0], /^::warning title=mabl policy::could not read .* so nothing is compared/);
    assert.match(
      stepSummary,
      new RegExp(`is valid \\(digest \`[0-9a-f]{12}\`\\)\\. The file at \`bbbbbbb\` could not be read: \`reading \\.mabl/policy\\.yaml at ${BASE} answered HTTP 500\`\\n`),
    );
    assert.doesNotMatch(stepSummary, /It was added|####/);
  });

  it("shows no value from the api's errors raw, in an annotation or the summary", async () => {
    const hidden = ['\u009b2K', '\u0085', '\u2028', '\u202e', '\u200b', '\u00a0', '\u2003', ...[0x34f, 0xfe0f, 0x3164].map((c) => String.fromCodePoint(c))].join('');
    const errors = [
      {path: 'applications.web.mabl_application', message: `must be an id, got "x${hidden}"`, line: 4, column: 5},
      {path: `applications["w${hidden}"]`, message: 'must be a name', line: 6, column: 3},
    ];
    const {code, printed, stepSummary} = await runAction({head: file(BROKEN), answers: new Map([[BROKEN, invalid(errors)]])});
    assert.equal(code, 1);
    assert.equal(printed.length, 2);
    for (const line of [...printed, ...stepSummary.split('\n')]) {
      assert.doesNotMatch(line, HIDDEN_PATTERN, JSON.stringify(line));
    }
    assert.ok(printed[0].endsWith(`got "x${u(0x9b)}2K${u(0x85)}${u(0x2028)}${u(0x202e)}${u(0x200b)}${u(0xa0)}${u(0x2003)}${u(0x34f)}${u(0xfe0f)}${u(0x3164)}"`), printed[0]);
  });

  it("writes what wouldn't show in its own inputs as \\u escapes", async () => {
    const rlo = String.fromCodePoint(0x202e);
    const printed = [];
    const code = await main({
      env: {
        POLICY_REF: `fix-${rlo}exe`,
        POLICY_COMPARE_REF: `main${String.fromCodePoint(0x2028)}x`,
        POLICY_FILE: `.mabl/${rlo}policy.yaml`,
        POLICY_REPOSITORY: 'org/repo',
        RUNNER_TEMP: mkdtempSync(join(tmpdir(), 'mabl-policy-action-')),
      },
      fetchImpl: () => assert.fail('nothing is asked for'),
      resolveImpl: () => assert.fail('nothing is resolved'),
      print: (line) => printed.push(line),
    });
    assert.equal(code, 1);
    assert.equal(printed.length, 2);
    for (const line of printed) {
      assert.doesNotMatch(line, HIDDEN_PATTERN, JSON.stringify(line));
    }
    const shownFile = `.mabl/${u(0x202e)}policy.yaml`;
    assert.ok(printed[0].startsWith(`::error title=mabl policy::could not read ${shownFile} at fix-${u(0x202e)}exe: file has to be`), printed[0]);
    assert.ok(printed[1].startsWith(`::warning title=mabl policy::could not read ${shownFile} at main${u(0x2028)}x, so nothing`), printed[1]);
  });
});

describe('resolving with the mabl api', () => {
  // Answers the resolve call with `answer` and records it.
  function api(answer) {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({url: new URL(url), init});
      if (answer instanceof Error) {
        throw answer;
      }
      return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), {status: answer.status});
    };
    return {fetchImpl, calls};
  }

  for (const [what, answer] of [
    ['a valid answer', valid(STAGES)],
    ['an invalid answer', invalid([UNKNOWN_SUITE])],
  ]) {
    it(`returns ${what} as the api gives it`, async () => {
      const {fetchImpl, calls} = api({status: 200, body: answer});
      assert.deepEqual(await resolveWithApi('# the file\n', {apiKey: 'mabl-key', fetchImpl}), answer);
      const [{url, init}] = calls;
      assert.equal(url.href, `https://api.mabl.com${RESOLVE_PATH}`);
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.authorization, `Basic ${Buffer.from('mabl-key:').toString('base64')}`);
      assert.deepEqual(JSON.parse(init.body), {yaml: '# the file\n'});
    });
  }

  for (const [what, answer, message] of [
    ['a refusal', {status: 403, body: {error_code: 'forbidden\n::error::x'}}, 'could not resolve: the mabl api answered HTTP 403 forbidden ::error::x'],
    ['a body that is not an answer', {status: 200, body: 'Unknown'}, 'could not resolve: the mabl api answered HTTP 200'],
    ['no answer', new Error('fetch failed'), 'could not resolve: fetch failed'],
  ]) {
    it(`throws on ${what}, never naming the key`, async () => {
      const {fetchImpl} = api(answer);
      await assert.rejects(resolveWithApi('# the file\n', {apiKey: 'mabl-key', fetchImpl}), (error) => {
        assert.equal(error.message, message);
        assert.doesNotMatch(error.message, /mabl-key/);
        return true;
      });
    });
  }
});

describe('action.yml', () => {
  const ACTION = read('../policy/action.yml');
  // The keys two spaces under a top-level section, in order.
  const keysOf = (section) => [...ACTION.split(`\n${section}:\n`)[1].split(/\n(?=\S)/)[0].matchAll(/^ {2}([\w-]+):$/gm)].map((match) => match[1]);

  it('runs main.mjs on node24, with nothing to install', () => {
    assert.match(ACTION, /\nruns:\n {2}using: node24\n {2}main: main\.mjs\n$/);
    assert.doesNotMatch(ACTION, /uses:|setup-node|mabl-cli/);
  });

  it('hands each input to the check under a name it reads', async () => {
    assert.deepEqual(keysOf('inputs'), Object.keys(POLICY_INPUTS));
    const env = policyEnvFromInputs({INPUT_REF: 'r', 'INPUT_COMPARE-REF': 'c', 'INPUT_MABL-API-KEY': 'k', OTHER: 'kept'});
    assert.equal(env.POLICY_REF, 'r');
    assert.equal(env.POLICY_COMPARE_REF, 'c');
    assert.equal(env.MABL_API_KEY, 'k');
    assert.equal(env.POLICY_FILE, '');
    assert.equal(env.OTHER, 'kept');
    const {envRead} = await runAction({head: file(EXAMPLE), base: file(EXAMPLE), compare: BASE});
    const fromRunner = (name) => name.startsWith('GITHUB_') || name.startsWith('RUNNER_');
    assert.deepEqual([...envRead].filter((name) => !fromRunner(name)).sort(), Object.values(POLICY_INPUTS).sort());
  });

  it('runs the check as the runner starts it, through a symlink too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mabl-policy-link-'));
    const linked = join(dir, 'linked');
    symlinkSync(join(dirname(fileURLToPath(import.meta.url)), '..'), linked, 'dir');
    let result;
    try {
      execFileSync(process.execPath, [join(linked, 'policy', 'main.mjs')], {
        env: {PATH: process.env.PATH, INPUT_REF: 'main', INPUT_REPOSITORY: 'org/repo', RUNNER_TEMP: dir},
        stdio: 'pipe',
        encoding: 'utf8',
      });
      result = {code: 0};
    } catch (error) {
      result = {code: error.status, stdout: error.stdout};
    }
    assert.equal(result.code, 1);
    assert.equal(
      result.stdout,
      `::error title=mabl policy::could not read ${POLICY_FILE} at main: ref has to be a full commit sha, got "main"\n`,
    );
  });

  it('declares exactly the outputs the check writes', async () => {
    const {outputs} = await runAction({head: file(EXAMPLE)});
    assert.deepEqual(keysOf('outputs'), Object.keys(outputs));
  });
});

describe('workflow commands and outputs', () => {
  it('escapes annotation data and properties', () => {
    assert.equal(
      annotation('error', '100% done\r\nnext', {file: 'a:b,c.yaml', line: 3, col: 4, title: 'mabl policy'}),
      '::error file=a%3Ab%2Cc.yaml,line=3,col=4,title=mabl policy::100%25 done%0D%0Anext',
    );
    assert.equal(annotation('notice', 'x'), '::notice::x');
    assert.doesNotMatch(annotation('error', 'x\n::add-mask::y'), /\n/);
  });

  it('writes each output under its own delimiter', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mabl-policy-out-')), 'output');
    writeFileSync(path, 'earlier=1\n');
    const tricky = 'ghadelimiter_00000000-0000-0000-0000-000000000000\nfound<<x\n';
    writeOutputs(path, {found: 'true', policy: '{"a":1}', tricky});
    assert.deepEqual(parseOutputs(readFileSync(path, 'utf8')), {earlier: '1', found: 'true', policy: '{"a":1}', tricky});
  });

  it('makes every delimiter random', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mabl-policy-out-')), 'output');
    writeOutputs(path, {a: '1', b: '2'});
    writeOutputs(path, {c: '3'});
    const delimiters = [...readFileSync(path, 'utf8').matchAll(/^[a-z]<<(.+)$/gm)].map((match) => match[1]);
    assert.equal(delimiters.length, 3);
    assert.equal(new Set(delimiters).size, 3);
    for (const delimiter of delimiters) {
      assert.match(delimiter, /^ghadelimiter_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

// A markdown table row's cells as GitHub shows them: split on each pipe with no backslash right
// before it, then each `\|` shown as `|`, whatever comes before the backslash.
function cells(row) {
  return row
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim().replaceAll('\\|', '|'));
}

describe('the summary', () => {
  const HOSTILE = 'a|b`c<script>x</script>\nd\\|e\r\u2028f\u202eg\u200bh';
  const outsideCode = (text) => text.replace(/`[^`\n]*`/g, '');

  it('keeps a hostile value inside one table cell and one code span', () => {
    const summary = renderSummary({
      file: POLICY_FILE,
      ref: HEAD,
      compareRef: BASE,
      head: {found: true, digest: 'c'.repeat(64), resolved: {web: {pull_request: {[HOSTILE]: HOSTILE}}}},
      base: {found: true, digest: 'd'.repeat(64), resolved: {web: {pull_request: {[HOSTILE]: 'plain'}}}},
    });
    const rows = summary.split('\n').filter((line) => line.startsWith('| `'));
    assert.equal(rows.length, 1);
    const [setting, before, after] = cells(rows[0]);
    assert.equal(cells(rows[0]).length, 3);
    for (const cell of [setting, before, after]) {
      assert.match(cell, /^`[^`]*`$/);
    }
    assert.doesNotMatch(after, /[\r\n\u2028\u202e\u200b]/);
    assert.doesNotMatch(outsideCode(summary), /[<>]/);
  });

  it('shows a value with a backslash or a pipe exactly as its JSON', () => {
    const labels = ['ci\\smoke', 'a|b\\', '\\|'];
    const summary = renderSummary({
      file: POLICY_FILE,
      ref: HEAD,
      compareRef: BASE,
      head: {found: true, digest: 'c'.repeat(64), resolved: {web: {pull_request: {suite_labels: {smoke: labels}}}}},
      base: {found: true, digest: 'd'.repeat(64), resolved: {web: {pull_request: {suite_labels: {smoke: ['ci-smoke']}}}}},
    });
    const row = summary.split('\n').find((line) => line.startsWith('| `suite_labels'));
    assert.deepEqual(cells(row), ['`suite_labels.smoke`', '`["ci-smoke"]`', `\`${canonicalJson(labels)}\``]);
  });

  it("compares nothing when the head can't be read, rather than showing the base as removed", () => {
    const summary = renderSummary({
      file: POLICY_FILE,
      ref: HEAD,
      compareRef: BASE,
      head: {readError: 'reading .mabl/policy.yaml answered HTTP 502'},
      base: {found: true, digest: 'd'.repeat(64), resolved: {web: {pull_request: {scope: 'pull_request'}}}},
    });
    assert.match(summary, /could not be read/);
    assert.doesNotMatch(summary, /removed|\| setting \|/);
  });

  it('keeps each error on one line and in a code span', () => {
    const summary = renderSummary({
      file: POLICY_FILE,
      ref: HEAD,
      head: {found: true, errors: [{path: 'suites["a`b"]', message: HOSTILE, line: 2, column: 3}, {path: '', message: 'x'}]},
    });
    const items = summary.split('\n').filter((line) => line.startsWith('- '));
    assert.equal(items.length, 2);
    const escaped = `a|b${u(0x60)}c<script>x</script>${u(0x0a)}d\\|e${u(0x0d)}${u(0x2028)}f${u(0x202e)}g${u(0x200b)}h`;
    assert.equal(items[0], `- \`2:3 suites["a${u(0x60)}b"]: ${escaped}\``);
    assert.doesNotMatch(outsideCode(summary), /[<>|]/);
  });

  it('cuts a long error to 200 characters, never inside one', () => {
    for (const long of ['y'.repeat(500), `a${String.fromCodePoint(0x1f600).repeat(300)}`]) {
      const summary = renderSummary({file: POLICY_FILE, ref: HEAD, head: {found: true, errors: [{path: '', message: long}]}});
      const item = summary.split('\n').find((line) => line.startsWith('- '));
      assert.equal([...item.slice(3, -1)].length, 200);
      assert.ok(item.endsWith('\u2026`'));
      assert.ok(summary.isWellFormed(), 'no half of a surrogate pair');
    }
  });

  it('cuts a long value to 200 characters, never inside one', () => {
    for (const long of ['y'.repeat(500), `a${String.fromCodePoint(0x1f600).repeat(300)}`]) {
      const summary = renderSummary({
        file: POLICY_FILE,
        ref: HEAD,
        compareRef: BASE,
        head: {found: true, digest: 'c'.repeat(64), resolved: {web: {release: {x: long}}}},
        base: {found: false},
      });
      const [, , after] = cells(summary.split('\n').find((line) => line.startsWith('| `x`')));
      assert.equal([...after.slice(1, -1)].length, 200);
      assert.ok(after.endsWith('…`'));
      assert.ok(summary.isWellFormed(), 'no half of a surrogate pair');
    }
  });

  const tableRows = (before, after) =>
    renderSummary({
      file: POLICY_FILE,
      ref: HEAD,
      compareRef: BASE,
      head: {found: true, digest: 'c'.repeat(64), resolved: after},
      base: {found: true, digest: 'd'.repeat(64), resolved: before},
    })
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .map(cells);

  it('starts two long values just before where they first differ, so a late change shows', () => {
    const url = `https://preview.example.test/${'p'.repeat(300)}`;
    const at = (value) => ({web: {pull_request: {target: {url: value}}}});
    assert.deepEqual(tableRows(at(`${url}?env=dev`), at(`${url}?env=prod`)), [
      ['`target.url`', `\`…${'p'.repeat(35)}?env=dev"\``, `\`…${'p'.repeat(35)}?env=prod"\``],
    ]);
    const smiles = String.fromCodePoint(0x1f600).repeat(300);
    const [[, before, after]] = tableRows(at(`${smiles}x`), at(`${smiles}y`));
    assert.ok(before.endsWith('x"`') && after.endsWith('y"`'), `${before} ${after}`);
    assert.ok(before.isWellFormed() && after.isWellFormed(), 'no half of a surrogate pair');
    const glob = `src/${'d/'.repeat(150)}`;
    const paths = (list) => ({web: {pull_request: {trigger_paths: list}}});
    assert.deepEqual(tableRows(paths([`${glob}*.ts`]), paths([`${glob}*.tsx`])), [
      [
        '`trigger_paths`',
        `1 entry, 1 removed: \`…${'d/'.repeat(18)}*.ts"]\``,
        `1 entry, 1 added: \`…${'d/'.repeat(18)}*.tsx"]\``,
      ],
    ]);
  });

  it('reads a setting named like an Object method as missing on the side without it', () => {
    const at = (labels) => ({web: {release: {suite_labels: labels}}});
    assert.deepEqual(tableRows(at({}), at({toString: ['ci-to-string']})), [['`suite_labels.toString`', EM_DASH, '`["ci-to-string"]`']]);
    assert.deepEqual(tableRows(at({toString: ['ci-to-string']}), at({})), [['`suite_labels.toString`', '`["ci-to-string"]`', EM_DASH]]);
  });

  it('shows a long list by the entries removed and added, however they move', () => {
    const labels = Array.from({length: 20}, (_, i) => `release-${i}`);
    const at = (list) => ({web: {pull_request: {impacted: {trusted: {plan_labels: list}}}}});
    const rowsFor = (after) => tableRows(at(labels), at(after));
    const path = '`impacted.trusted.plan_labels`';
    const anythingGoes = '1 added: `["anything-goes"]`';
    assert.deepEqual(rowsFor([...labels, 'anything-goes']), [[path, '20 entries', `21 entries, ${anythingGoes}`]]);
    assert.deepEqual(rowsFor(['anything-goes', ...labels]), [[path, '20 entries', `21 entries, ${anythingGoes}`]]);
    assert.deepEqual(rowsFor([...labels.slice(1), 'anything-goes']), [
      [path, '20 entries, 1 removed: `["release-0"]`', `20 entries, ${anythingGoes}`],
    ]);
    assert.deepEqual(rowsFor(labels.toSpliced(7, 1)), [[path, '20 entries, 1 removed: `["release-7"]`', '19 entries']]);
    assert.deepEqual(rowsFor(labels.toReversed()), [[path, '20 entries', '20 entries, reordered']]);
    assert.deepEqual(rowsFor([...labels, labels[3]]), [[path, '20 entries', '21 entries, 1 added: `["release-3"]`']]);
  });

  it('keeps a change to a long list to one short row, however long the list', () => {
    const labels = Array.from({length: 9000}, (_, i) => `l${i}`);
    const at = (exclude, trusted) => ({web: {pull_request: {impacted: {exclude: {test_labels: exclude}, trusted: {plan_labels: trusted}}}}});
    const rows = tableRows(at(labels, ['release']), at([...labels.slice(1), labels[0]], ['release', 'anything-goes']));
    assert.deepEqual(rows, [
      ['`impacted.exclude.test_labels`', '9000 entries', '9000 entries, reordered'],
      ['`impacted.trusted.plan_labels`', '`["release"]`', '`["release","anything-goes"]`'],
    ]);
  });

  it('says how many entries a long list has when it cuts it, and shows an empty one as []', () => {
    const labels = Array.from({length: 20}, (_, i) => `release-${i}`);
    const at = (list) => ({web: {pull_request: {impacted: {include: {suites: list}}}}});
    const cut = `\`${canonicalJson(labels).slice(0, 199)}…\``;
    assert.deepEqual(tableRows(at(labels), at([])), [['`impacted.include.suites`', `20 entries: ${cut}`, '`[]`']]);
    assert.deepEqual(tableRows(at([]), at(labels)), [['`impacted.include.suites`', '`[]`', `20 entries: ${cut}`]]);
  });

  const settings = Object.fromEntries(Array.from({length: 4000}, (_, i) => [`setting_${i}`, 'v'.repeat(150)]));
  for (const [what, head, shown] of [
    ['settings', {found: true, digest: 'c'.repeat(64), resolved: {web: {pull_request: settings}}}, /\| `setting_1000` \|/],
    ['errors', {found: true, errors: Array.from({length: 4000}, (_, i) => ({path: `p${i}`, message: 'v'.repeat(150)}))}, /^- `p1000: v+`$/m],
  ]) {
    it(`stops a summary of many ${what} well inside GitHub's 1 MiB, and says so`, () => {
      const summary = renderSummary({file: POLICY_FILE, ref: HEAD, compareRef: BASE, head, base: {found: false}});
      assert.ok(Buffer.byteLength(summary) <= MAX_SUMMARY_BYTES + 200, String(Buffer.byteLength(summary)));
      assert.ok(MAX_SUMMARY_BYTES < 1024 * 1024);
      assert.match(summary, shown);
      assert.ok(summary.endsWith(`\n\nThe summary stops here, at ${MAX_SUMMARY_BYTES / 1024} KiB.\n`));
    });
  }
});
