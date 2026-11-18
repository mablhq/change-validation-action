// The action's entry: runs the stage request with the action's inputs, writes its outputs, then keeps
// the pull request comment. The comment can't change the exit code or the outputs.

import {main as keepComment} from './comment.mjs';
import {envFromInputs} from './inputs.mjs';
import {escapeInvisible} from './lib/policy-read.mjs';
import {MAX_ANNOTATION_CHARS, TITLE, redactor} from './lib/shared.mjs';
import {annotation, isMain, shorten, writeOutputs} from './lib/workflow-commands.mjs';
import {run} from './stage-request.mjs';

// The outputs action.yml declares.
export const OUTPUTS = ['outcome', 'session-id', 'created', 'agent', 'description-source', 'status'];

export async function action({
  env = envFromInputs(process.env),
  fetchImpl = fetch,
  sleep,
  now,
  signalAfter,
  print = (line) => process.stdout.write(`${line}\n`),
  comment = keepComment,
} = {}) {
  const {exitCode, outputs} = await run({env, fetchImpl, sleep, now, signalAfter, print});
  const declared = Object.fromEntries(OUTPUTS.filter((name) => name in outputs).map((name) => [name, outputs[name]]));
  if (env.GITHUB_OUTPUT) {
    writeOutputs(env.GITHUB_OUTPUT, declared);
  }
  try {
    await comment({
      env: {
        ...env,
        CHANGE_VALIDATION_OUTCOME: String(outputs.outcome ?? ''),
        CHANGE_VALIDATION_STATUS: String(outputs.status ?? ''),
        PULL_REQUEST_NUMBER: String(outputs['pull-request-number'] ?? ''),
      },
      fetchImpl,
      sleep,
      now,
      print,
    });
  } catch (error) {
    const message = `the pull request comment stopped: ${redactor(env)(escapeInvisible(String(error?.message ?? error)))}`;
    print(annotation('warning', shorten(message, MAX_ANNOTATION_CHARS), {title: TITLE}));
  }
  return {exitCode, outputs: declared};
}

if (isMain(import.meta.url)) {
  const {exitCode} = await action();
  process.exitCode = exitCode;
}
