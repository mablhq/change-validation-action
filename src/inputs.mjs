// The action's inputs, as the runner passes them, under the names the stage request reads.

// input name -> the variable stage-request.mjs, await-status.mjs and comment.mjs read
export const INPUTS = {
  'mabl-api-key': 'MABL_API_KEY',
  'workspace-id': 'MABL_WORKSPACE_ID',
  'api-url': 'MABL_API_URL',
  stage: 'CHANGE_VALIDATION_STAGE',
  command: 'CHANGE_VALIDATION_COMMAND',
  'trigger-word': 'CHANGE_VALIDATION_TRIGGER_WORD',
  'change-description': 'CHANGE_DESCRIPTION',
  'change-description-head-sha': 'CHANGE_DESCRIPTION_HEAD_SHA',
  'expected-head-sha': 'CHANGE_VALIDATION_EXPECTED_HEAD_SHA',
  'head-sha': 'CHANGE_VALIDATION_HEAD_SHA',
  'base-sha': 'CHANGE_VALIDATION_BASE_SHA',
  'dry-run': 'CHANGE_VALIDATION_DRY_RUN',
  send: 'CHANGE_VALIDATION_SEND',
  file: 'POLICY_FILE',
  await: 'CHANGE_VALIDATION_AWAIT',
  'status-context': 'STATUS_CONTEXT',
  'deadline-minutes': 'DEADLINE_MINUTES',
  comment: 'CHANGE_VALIDATION_COMMENT',
  'comment-wait-minutes': 'COMMENT_WAIT_MINUTES',
  token: 'GH_TOKEN',
};

// The runner names an input INPUT_ plus its name upper-cased, hyphens kept.
export function envFromInputs(env) {
  const mapped = {...env};
  for (const [input, name] of Object.entries(INPUTS)) {
    mapped[name] = String(env[`INPUT_${input.toUpperCase()}`] ?? '');
  }
  return mapped;
}
