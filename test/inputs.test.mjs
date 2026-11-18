import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

import {INPUTS, envFromInputs} from '../src/inputs.mjs';

const ACTION = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
const MAIN = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
const keysOf = (section) => [...ACTION.split(`\n${section}:\n`)[1].split(/\n(?=\S)/)[0].matchAll(/^ {2}([\w-]+):$/gm)].map((match) => match[1]);

describe('action.yml', () => {
  it('maps every input, and only those', () => {
    assert.deepEqual(keysOf('inputs').sort(), Object.keys(INPUTS).sort());
  });

  it('runs main.mjs on node24', () => {
    assert.match(ACTION, /\nruns:\n {2}using: node24\n {2}main: src\/main\.mjs\n$/);
  });

  it('defaults to the mabl api and never names another host', () => {
    assert.match(ACTION, /\n {2}api-url:\n(?: {4}.*\n)*? {4}default: 'https:\/\/api\.mabl\.com'\n/);
    assert.deepEqual([...new Set([...ACTION.matchAll(/https:\/\/[^\s'";,]+/g)].map((match) => match[0]))], ['https://api.mabl.com']);
  });
});

describe('envFromInputs', () => {
  it("reads the runner's INPUT_ names, hyphens kept", () => {
    const env = envFromInputs({'INPUT_MABL-API-KEY': 'key', INPUT_STAGE: 'merge_queue', 'INPUT_DRY-RUN': 'true', OTHER: 'kept'});
    assert.equal(env.MABL_API_KEY, 'key');
    assert.equal(env.CHANGE_VALIDATION_STAGE, 'merge_queue');
    assert.equal(env.CHANGE_VALIDATION_DRY_RUN, 'true');
    assert.equal(env.OTHER, 'kept');
    assert.equal(env.MABL_WORKSPACE_ID, '');
  });

  it('passes a value through untouched', () => {
    assert.equal(envFromInputs({'INPUT_CHANGE-DESCRIPTION': '  two\nlines '}).CHANGE_DESCRIPTION, '  two\nlines ');
  });
});

describe('main.mjs', () => {
  it('runs as the runner starts it and writes its outputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'change-validation-main-'));
    const event = join(dir, 'event.json');
    const output = join(dir, 'output');
    writeFileSync(event, '{}');
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, [MAIN], {
      env: {
        PATH: process.env.PATH,
        GITHUB_EVENT_NAME: 'pull_request_target',
        GITHUB_EVENT_PATH: event,
        GITHUB_OUTPUT: output,
        'INPUT_MABL-API-KEY': 'mabl-key',
        INPUT_STAGE: 'pull_request',
        'INPUT_API-URL': 'https://api.mabl.com',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^::error title=mabl change validation::not sent: /m);
    assert.match(readFileSync(output, 'utf8'), /^outcome<<ghadelimiter_[0-9a-f-]+\nfailed\n/);
  });
});
