// Which events send a deployed commit, and which commit they send.

import {COMMIT_SHA} from './lib/shared.mjs';

// Events that send a revision, a deployed commit, rather than a pull request.
export const REVISION_EVENTS = new Set(['push', 'workflow_dispatch', 'deployment_status', 'release', 'workflow_run', 'schedule']);

// The commit a revision event validates: head-sha, else a deployment's sha or a workflow run's head,
// else the run's commit. On workflow_run GITHUB_SHA is the default branch's tip, not the run's commit.
export function revisionHead({eventName, payload, env}) {
  const fromEvent = {deployment_status: payload?.deployment?.sha, workflow_run: payload?.workflow_run?.head_sha}[eventName];
  const head = String(String(env.CHANGE_VALIDATION_HEAD_SHA ?? '').trim() || fromEvent || env.GITHUB_SHA || '').toLowerCase();
  if (!COMMIT_SHA.test(head)) {
    throw new Error(`head-sha has to be a 40-character commit sha, got ${JSON.stringify(head)}`);
  }
  return head;
}
