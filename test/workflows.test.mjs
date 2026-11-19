import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';

import {INPUTS} from '../src/inputs.mjs';

const workflow = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
// The keys one level under the first `<indent><section>:` line.
function keysUnder(text, section, indent) {
  const pad = ' '.repeat(indent);
  const [, body = ''] = text.split(`\n${pad}${section}:\n`);
  const lines = body.split('\n');
  const end = lines.findIndex((line) => line.trim() !== '' && !line.startsWith(`${pad}  `));
  return (end === -1 ? lines : lines.slice(0, end)).flatMap((line) => new RegExp(`^${pad}  ([\\w-]+):`).exec(line)?.[1] ?? []);
}

describe('the reusable workflows', () => {
  for (const name of ['pull-request.yml', 'merge-queue.yml', 'deployed-commit.yml']) {
    it(`${name} passes the action only inputs it declares`, () => {
      const text = workflow(name);
      assert.match(text, /\n {8}uses: mablhq\/change-validation-action@v1\n {8}with:\n/, 'expected the action step, with its inputs, at an 8-space indent');
      const passed = keysUnder(text, 'with', 8);
      assert.ok(passed.length > 0, 'found no inputs under the action step');
      assert.deepEqual(
        passed.filter((input) => !Object.hasOwn(INPUTS, input)),
        [],
      );
    });
  }

  for (const [name, step] of [
    ['merge-queue.yml', 'await'],
    ['deployed-commit.yml', 'send'],
  ]) {
    it(`${name} publishes error itself when the action failed without publishing a status`, () => {
      const text = workflow(name);
      const [, fallback = ''] = text.split('\n      - name: Publish error when nothing was published\n');
      assert.ok(fallback.includes(`steps.${step}.outcome == 'failure' && steps.${step}.outputs.status == ''`), 'expected the step to run only when the action failed with no status');
      assert.ok(fallback.includes('-f state=error'), 'expected the step to publish error');
    });
  }

  it("revision.yml, the deployed commit workflow's earlier name, passes every input and the key through", () => {
    const alias = workflow('revision.yml');
    const inputs = keysUnder(workflow('deployed-commit.yml'), 'inputs', 4);

    assert.ok(inputs.includes('stage') && inputs.includes('status-context'));
    assert.match(alias, /\n {4}uses: \.\/\.github\/workflows\/deployed-commit\.yml\n/);
    assert.deepEqual(keysUnder(alias, 'inputs', 4), inputs);
    assert.deepEqual(keysUnder(alias, 'with', 4), inputs);
    for (const input of inputs) {
      assert.ok(alias.includes(`\n      ${input}: \${{ inputs.${input} }}\n`), `expected revision.yml to pass ${input} through, at a 6-space indent`);
    }
    assert.deepEqual(keysUnder(alias, 'outputs', 4), keysUnder(workflow('deployed-commit.yml'), 'outputs', 4));
    assert.ok(alias.includes('\n      mabl-api-key: ${{ secrets.mabl-api-key }}\n'));
  });
});
