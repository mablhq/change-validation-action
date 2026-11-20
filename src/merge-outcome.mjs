// What became of a merged pull request's mabl branch, from `landed` in mabl's answer to the merged event.
// diverged and failed leave a merge for someone to finish by hand, so they fail the step; the rest are notices.

import {oneLine} from './lib/mabl-api.mjs';
import {isObject} from './lib/shared.mjs';

const FAILING_OUTCOMES = new Set(['diverged', 'failed']);
// The annotation names this many tests and flows; the log lists them all.
const MAX_NAMED = 10;

const listed = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const entityOf = (entity) => `${oneLine(entity?.type) || 'entity'} "${oneLine(entity?.name) || oneLine(entity?.id)}"`;

function divergedSentence(entities) {
  if (entities.length === 0) {
    return 'a test or flow';
  }
  const named = entities.slice(0, MAX_NAMED).map(entityOf);
  return listed(entities.length > MAX_NAMED ? [...named, `${entities.length - MAX_NAMED} more`] : named);
}

function branchMessage(name, outcome, entities) {
  switch (outcome) {
    case 'merged':
      return `mabl branch ${name}: merged into master`;
    case 'nothing_to_merge':
      return `mabl branch ${name}: nothing to merge into master`;
    case 'not_open':
      return `mabl branch ${name}: not merged, it doesn't exist, is already merged or isn't a working branch`;
    case 'left':
      return `mabl branch ${name}: left open, the policy doesn't set merge_mabl_branches`;
    case 'diverged':
      return `mabl branch ${name}: not merged, master changed after the branch for ${divergedSentence(entities)}. Merge it into master by hand in mabl`;
    case 'failed':
      return `mabl branch ${name}: the merge into master failed, and the branch may be partly merged. Check it and finish the merge by hand in mabl`;
    default:
      return `mabl branch ${name}: ${outcome || 'no outcome'}`;
  }
}

// What to report for `landed`: one annotation per branch, an error for an outcome someone has to act on, and a
// log line per test or flow a diverged branch names. `failed` says whether any outcome fails the step.
export function mergeOutcome(landed) {
  if (!isObject(landed)) {
    return {annotations: [], log: ["mabl's answer doesn't say what became of the pull request's mabl branch"], failed: false};
  }
  const branches = (Array.isArray(landed.branches) ? landed.branches : []).filter(isObject);
  if (branches.length === 0) {
    return {annotations: [{level: 'notice', message: "no mabl branch to merge: the pull request's tests didn't run on one"}], log: [], failed: false};
  }
  const annotations = [];
  const log = [];
  for (const branch of branches) {
    const name = oneLine(branch.name) || 'unnamed';
    const outcome = oneLine(branch.outcome);
    const entities = outcome === 'diverged' && Array.isArray(branch.diverged_entities) ? branch.diverged_entities.filter(isObject) : [];
    const failing = FAILING_OUTCOMES.has(outcome);
    annotations.push({level: failing ? 'error' : 'notice', message: branchMessage(name, outcome, entities)});
    for (const entity of entities) {
      log.push(`mabl branch ${name}: master moved past ${entityOf(entity)} (${oneLine(entity.id)})`);
    }
  }
  return {annotations, log, failed: annotations.some((each) => each.level === 'error')};
}
