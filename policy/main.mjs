// The policy check's entry: hands the action's inputs to the check under the names it reads.

import {main} from '../src/policy-check.mjs';
import {isMain} from '../src/lib/workflow-commands.mjs';

// input name -> the variable policy-check.mjs reads
export const POLICY_INPUTS = {
  ref: 'POLICY_REF',
  'compare-ref': 'POLICY_COMPARE_REF',
  file: 'POLICY_FILE',
  repository: 'POLICY_REPOSITORY',
  token: 'GH_TOKEN',
  'mabl-api-key': 'MABL_API_KEY',
};

// The runner names an input INPUT_ plus its name upper-cased, hyphens kept.
export function policyEnvFromInputs(env) {
  const mapped = {...env};
  for (const [input, name] of Object.entries(POLICY_INPUTS)) {
    mapped[name] = String(env[`INPUT_${input.toUpperCase()}`] ?? '');
  }
  return mapped;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main({env: policyEnvFromInputs(process.env)});
}
