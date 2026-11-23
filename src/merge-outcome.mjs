// What became of a merged pull request's mabl branch, from `landed` in mabl's answer to the merged event.
// diverged and failed leave a merge for someone to finish by hand, so they fail the step; other known outcomes are
// notices and unknown ones warnings.

import {oneLine} from './lib/mabl-api.mjs';
import {isObject} from './lib/shared.mjs';
import {shorten} from './lib/workflow-commands.mjs';

const FAILING_OUTCOMES = new Set(['diverged', 'failed']);
const KNOWN_OUTCOMES = new Set(['merged', 'nothing_to_merge', 'not_open', 'left', ...FAILING_OUTCOMES]);
// The annotation names this many tests and flows, each cut to fit, after what to do, so a cut never loses that.
const MAX_NAMED = 10;
const MAX_ANNOTATION_NAME = 40;
const MAX_BRANCH_NAME = 100;
const MAX_LOGGED = 200;
const MAX_LOGGED_NAME = 500;
const RECORDED = " (as recorded when the pull request merged; a re-run doesn't check the branch again)";

const counted = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const entityOf = (entity, max) =>
  `${shorten(oneLine(entity?.type) || 'entity', 20)} "${shorten(oneLine(entity?.name) || oneLine(entity?.id), max)}"`;

// "Master moved past 2 tests and 1 flow: test "A", ...", the count first so a cut list keeps it.
function movedPast(entities) {
  if (entities.length === 0) {
    return '';
  }
  const tests = entities.filter((entity) => entity.type === 'test').length;
  const flows = entities.filter((entity) => entity.type === 'flow').length;
  const others = entities.length - tests - flows;
  const kinds = [tests && counted(tests, 'test'), flows && counted(flows, 'flow'), others && counted(others, 'other')].filter(Boolean);
  const named = entities.slice(0, MAX_NAMED).map((entity) => entityOf(entity, MAX_ANNOTATION_NAME));
  const more = entities.length > MAX_NAMED ? ` and ${entities.length - MAX_NAMED} more` : '';
  return ` Master moved past ${kinds.join(' and ')}: ${named.join(', ')}${more}`;
}

function branchMessage(name, outcome, entities, recorded) {
  const asRecorded = recorded ? RECORDED : '';
  switch (outcome) {
    case 'merged':
      return `mabl branch ${name}: merged into master`;
    case 'nothing_to_merge':
      return `mabl branch ${name}: nothing to merge into master`;
    case 'not_open':
      return `mabl branch ${name}: nothing to merge, it doesn't exist, is already merged or isn't a working branch`;
    case 'left':
      return `mabl branch ${name}: left open, the policy doesn't set merge_mabl_branches`;
    case 'diverged':
      return `mabl branch ${name}: not merged, master changed after the branch${asRecorded}. Merge it into master by hand in mabl.${movedPast(entities)}`;
    case 'failed':
      return `mabl branch ${name}: the merge into master failed, and the branch may be partly merged${asRecorded}. Check it and finish the merge by hand in mabl`;
    default:
      return `mabl branch ${name}: ${outcome || 'no outcome'}, an outcome this action doesn't know`;
  }
}

function levelOf(outcome) {
  if (FAILING_OUTCOMES.has(outcome)) {
    return 'error';
  }
  return KNOWN_OUTCOMES.has(outcome) ? 'notice' : 'warning';
}

// What to report for `landed`: one annotation per branch (a single warning if `landed` is missing or malformed), an
// error for an outcome someone has to act on, and a log line per test or flow a diverged branch names.
// `failed` says whether any outcome fails the step.
// `recorded` is a repeat's answer, which reports the outcome recorded the first time.
export function mergeOutcome(landed, {recorded = false} = {}) {
  if (!isObject(landed) || !Array.isArray(landed.branches)) {
    return {annotations: [{level: 'warning', message: "mabl's answer doesn't say what became of the pull request's mabl branch, so check it in mabl"}], log: [], failed: false};
  }
  const branches = landed.branches.filter(isObject);
  if (branches.length === 0) {
    return {annotations: [{level: 'notice', message: "no mabl branch to merge: the pull request's tests didn't run on one"}], log: [], failed: false};
  }
  const annotations = [];
  const log = [];
  for (const branch of branches) {
    const fullName = shorten(oneLine(branch.name) || 'unnamed', MAX_LOGGED_NAME);
    const outcome = oneLine(branch.outcome);
    const entities = outcome === 'diverged' && Array.isArray(branch.diverged_entities) ? branch.diverged_entities.filter(isObject) : [];
    annotations.push({level: levelOf(outcome), message: branchMessage(shorten(fullName, MAX_BRANCH_NAME), outcome, entities, recorded)});
    for (const entity of entities.slice(0, MAX_LOGGED)) {
      log.push(`mabl branch ${fullName}: master moved past ${entityOf(entity, MAX_LOGGED_NAME)} (${shorten(oneLine(entity.id), MAX_LOGGED_NAME)})`);
    }
    if (entities.length > MAX_LOGGED) {
      log.push(`mabl branch ${fullName}: and ${entities.length - MAX_LOGGED} more`);
    }
  }
  return {annotations, log, failed: annotations.some((each) => each.level === 'error')};
}
