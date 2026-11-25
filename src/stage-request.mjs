// Asks mabl to validate a policy stage at a head, with a trusted commenter's request when a comment
// carries one: one POST /changeValidation/events per run, a stage request carrying the policy file.
// The README has the inputs and outputs.

import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

import {DEFAULT_API_URL, apiUrlOf, basicAuthorization, oneLine} from './lib/mabl-api.mjs';
import {buildDescription, globToRegExp, groupByArea} from './lib/describe.mjs';
import {POLICY_FILE, escapeInvisible, readPolicyAt} from './lib/policy-read.mjs';
import {awaitStage, endWithErrorStatus} from './await-status.mjs';
import {commentCommand} from './command.mjs';
import {mergeOutcome} from './merge-outcome.mjs';
import {COMMIT_SHA, MAX_ANNOTATION_CHARS, TAKEN, TITLE, redactor, repositoryIdOf} from './lib/shared.mjs';
import {annotation, shorten} from './lib/workflow-commands.mjs';
import {REVISION_EVENTS, revisionHead} from './revision.mjs';

export const EVENTS_PATH = '/changeValidation/events';
export const RESOLVE_PATH = '/validationPolicy/resolve';
const PULL_REQUEST_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'edited']);
// refs/heads/gh-readonly-queue/<base>/pr-<n>-<sha>: the entry's own pull request.
const QUEUE_ENTRY = /\/pr-([1-9][0-9]*)-[0-9a-f]+$/;
// The api's rule for a policy stage's name.
const STAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
// The base level; a custom role still reports one of these.
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];
// Answers that end the run without failing it.
const QUIET_ERRORS = new Set(['feature_disabled', 'change_agent_closed', 'no_change_agent']);
const MERGED_EVENT_KIND = 'pull_request.merged';
const REQUEST_TIMEOUT_MS = 60_000;
// mabl merges the pull request's mabl branch inside the merged event's call, which can take a while.
export const MERGED_TIMEOUT_MS = 300_000;
const GITHUB_TIMEOUT_MS = 30_000;
const RESOLVE_TIMEOUT_MS = 30_000;
// The events route's caps, in UTF-16 units.
const MAX_DESCRIPTION_CHARS = 20_000;
const MAX_COMMAND_CHARS = 2_000;
const MAX_PATHS_PER_APPLICATION = 30;
const FILES_PER_PAGE = 100;
// GitHub lists at most 3,000 of a pull request's files.
const MAX_FILE_PAGES = 30;
// The events route's limits on event.changed_paths.
export const MAX_CHANGED_PATHS = 3_000;
const MAX_CHANGED_PATH_CHARS = 1_024;
const NO_COMMIT = /^0{40}$/;
const COMMITS_PER_PAGE = 100;
const MAX_COMMIT_PAGES = 10;
// The compare API lists at most 300 files, on its first page only.
const MAX_COMPARE_FILES = 300;
const COMMITS_PER_QUERY = 50;
// The most pull requests a revision's description lists.
const MAX_PULL_REQUESTS = 100;
// The events route's cap on event.labels.
const MAX_LABELS = 100;


const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// No lone high surrogate at the cut.
function clip(text, max) {
  const cut = text.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

class Refusal extends Error {}
const forkRefusal = (number) => new Refusal(`pull request #${number} comes from a fork, or one that can't be told apart from a fork`);

function githubGet({githubApiUrl, path, token, fetchImpl}) {
  return fetchImpl(`${githubApiUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${String(token).trim()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'mabl-change-validation-action',
    },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
}

async function fetchPullRequest({githubApiUrl, repository, number, token, fetchImpl}) {
  const response = await githubGet({githubApiUrl, path: `/repos/${repository}/pulls/${number}`, token, fetchImpl});
  if (!response.ok) {
    throw new Error(`reading pull request #${number} answered HTTP ${response.status}`);
  }
  return response.json();
}

// author_association is org membership or any collaborator role, not write access to this repository.
async function commenterCanWrite({githubApiUrl, repository, login, token, fetchImpl}) {
  const path = `/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`;
  const response = await githubGet({githubApiUrl, path, token, fetchImpl});
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`reading ${login}'s permission answered HTTP ${response.status}`);
  }
  const {permission} = await response.json();
  return WRITE_PERMISSIONS.has(permission);
}

// The queue commit is the base plus every entry ahead plus this one, so the entry's own change is
// the commit against its first parent.
async function firstParent({githubApiUrl, repository, sha, token, fetchImpl}) {
  const response = await githubGet({githubApiUrl, path: `/repos/${repository}/git/commits/${sha}`, token, fetchImpl});
  if (!response.ok) {
    throw new Error(`reading the queue commit ${sha} answered HTTP ${response.status}`);
  }
  const parent = (await response.json()).parents?.[0]?.sha;
  if (typeof parent !== 'string' || parent === '') {
    throw new Error(`the queue commit ${sha} has no parent`);
  }
  return parent;
}

// Every path the pull request touches, both names of a rename, in GitHub's order. `truncated` when
// GitHub listed fewer files than the pull request changes.
export async function fetchChangedPaths({githubApiUrl, repository, number, changedFiles, token, fetchImpl}) {
  const paths = new Set();
  let listed = 0;
  for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
    const path = `/repos/${repository}/pulls/${number}/files?per_page=${FILES_PER_PAGE}&page=${page}`;
    const response = await githubGet({githubApiUrl, path, token, fetchImpl});
    if (!response.ok) {
      throw new Error(`listing pull request #${number}'s files answered HTTP ${response.status}`);
    }
    const files = await response.json();
    if (!Array.isArray(files)) {
      throw new Error(`listing pull request #${number}'s files answered something other than a list`);
    }
    for (const file of files) {
      for (const name of [file?.previous_filename, file?.filename]) {
        if (typeof name === 'string' && name !== '') {
          paths.add(name);
        }
      }
    }
    listed += files.length;
    if (files.length < FILES_PER_PAGE) {
      break;
    }
  }
  return {paths: [...paths], truncated: Number.isInteger(changedFiles) && listed < changedFiles};
}

// The paths as the events route takes them. A path it would refuse is left out and, like a list cut
// at the cap, marks the list truncated, so mabl applies every application.
export function changedPathsFields({paths, truncated}) {
  const fitting = paths.filter((path) => path.length <= MAX_CHANGED_PATH_CHARS);
  return {
    changed_paths: fitting.slice(0, MAX_CHANGED_PATHS),
    changed_paths_truncated: truncated || fitting.length < paths.length || fitting.length > MAX_CHANGED_PATHS,
  };
}

// A GraphQL query's `repository` field. `what` names the read in errors.
async function githubGraphql({graphqlUrl, query, variables, token, fetchImpl, what}) {
  const response = await fetchImpl(graphqlUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${String(token).trim()}`,
      'Content-Type': 'application/json',
      'User-Agent': 'mabl-change-validation-action',
    },
    body: JSON.stringify({query, variables}),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${what} answered HTTP ${response.status}`);
  }
  const answer = await response.json();
  const repository = answer?.data?.repository;
  if (answer?.errors?.length || !repository) {
    throw new Error(`${what} failed: ${answer?.errors?.[0]?.message ?? 'no repository'}`);
  }
  return repository;
}

// The head of the pull request whose merge queue entry is at `queueSha`, or null when it has no entry
// there (the queue rebuilt or dropped it). GitHub drops an entry whose pull request is pushed, so an
// entry still at this commit was built from the pull request's current head, whatever the merge method.
// An entry that already merged left the queue at this commit, so it counts as still there.
async function queuedPullRequestHead({graphqlUrl, repository, number, queueSha, token, fetchImpl}) {
  const [owner, name] = repository.split('/');
  const what = `reading pull request #${number}'s merge queue entry`;
  const found = await githubGraphql({
    graphqlUrl,
    query:
      'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { headRefOid mergeCommit { oid } mergeQueueEntry { headCommit { oid } } } } }',
    variables: {owner, name, number},
    token,
    fetchImpl,
    what,
  });
  const pull = found.pullRequest;
  if (!pull) {
    throw new Error(`${what} failed: no pull request`);
  }
  const at = String(queueSha).toLowerCase();
  const entry = String(pull.mergeQueueEntry?.headCommit?.oid ?? '').toLowerCase();
  const merged = String(pull.mergeCommit?.oid ?? '').toLowerCase();
  return entry === at || merged === at ? String(pull.headRefOid ?? '').toLowerCase() : null;
}

// The api's resolved stages for the policy text; the client never reads the policy itself.
async function resolveStages({apiUrl, apiKey, text, fetchImpl}) {
  const response = await fetchImpl(`${apiUrl}${RESOLVE_PATH}`, {
    method: 'POST',
    headers: {authorization: basicAuthorization(apiKey), 'content-type': 'application/json', accept: 'application/json'},
    body: JSON.stringify({yaml: text}),
    redirect: 'error',
    signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`resolving the policy answered HTTP ${response.status}`);
  }
  const answer = await response.json();
  if (answer?.valid !== true) {
    throw new Error('the policy is not valid');
  }
  return answer.stages ?? {};
}

// The applications the resolved policy checks at `stage`, each with its analysis_roots (null for the
// whole repository).
export function applicationsAt(stages, stage) {
  return Object.entries(stages ?? {}).flatMap(([name, byStage]) => {
    const settings = byStage && Object.hasOwn(byStage, stage) ? byStage[stage] : null;
    if (!settings || typeof settings !== 'object') {
      return [];
    }
    const roots = Array.isArray(settings.analysis_roots) ? settings.analysis_roots.filter((root) => typeof root === 'string') : [];
    return [{name: oneLine(name), roots: roots.length > 0 ? roots : null}];
  });
}

// A root as a magic-free pathspec: the path itself or anything under it. A wildcard in one matches
// as describe.mjs's globs do, inside one path segment.
function rootPatterns(root) {
  const trimmed = root.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  return trimmed === '' || trimmed === '.' ? [globToRegExp('**')] : [globToRegExp(trimmed), globToRegExp(`${trimmed}/**`)];
}

// One group per application, in the policy's order; a path under two applications' roots is in both.
export function groupByApplication(paths, applications) {
  const areas = [];
  const grouped = new Set();
  for (const {name, roots} of applications) {
    const areaMap = (roots ?? ['.']).flatMap(rootPatterns).map((pattern) => ({phrase: name, pattern}));
    const [area] = groupByArea(paths, areaMap).areas;
    if (area) {
      areas.push(area);
      area.paths.forEach((path) => grouped.add(path));
    }
  }
  return {areas, filesUnmapped: paths.filter((path) => !grouped.has(path)).length};
}

// git's --stat totals line, which buildDescription takes the totals from.
function diffTotals({changed_files: files, additions, deletions}) {
  if (!Number.isInteger(files)) {
    return '';
  }
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return [
    count(files, 'file changed', 'files changed'),
    ...(Number.isInteger(additions) && additions > 0 ? [count(additions, 'insertion(+)', 'insertions(+)')] : []),
    ...(Number.isInteger(deletions) && deletions > 0 ? [count(deletions, 'deletion(-)', 'deletions(-)')] : []),
  ].join(', ');
}

// The description sent when the caller passes none: title, the changed paths per application by its
// analysis_roots (all of them under one heading when no application can be named), body, totals.
// The path cap is a count, so when long paths would push the description past the events route's
// cap, every application lists fewer paths, down to none; otherwise the cut would drop the last
// applications.
// A queue entry's `totals` are its comparison's, not the pull request's.
export function describeChange({pr, paths, applications, truncated = false, truncationNote, totals = pr}) {
  const named = applications.length > 0;
  const heading = named ? "Changed paths per mabl application, by the policy's analysis_roots" : 'Changed paths';
  const caveat = truncated
    ? ` (${truncationNote ?? `GitHub lists at most 3,000 of a pull request's files and this one changes ${pr.changed_files}`}, so some applications may be missing)`
    : '';
  const input = {
    title: pr.title,
    body: pr.body,
    diffStat: diffTotals(totals),
    grouped: groupByApplication(paths, named ? applications : [{name: 'repository', roots: null}]),
    areasHeading: `${heading}${caveat}:`,
  };
  for (let maxPathsPerArea = MAX_PATHS_PER_APPLICATION; ; maxPathsPerArea -= 1) {
    const {description, capped} = buildDescription(input, {maxDescriptionChars: MAX_DESCRIPTION_CHARS, maxPathsPerArea});
    if (!capped || maxPathsPerArea === 0) {
      return description;
    }
  }
}

// A push to a branch, not a tag, so its `before` and `after` are that branch's commits.
const isBranchPush = (eventName, payload) => eventName === 'push' && String(payload?.ref ?? '').startsWith('refs/heads/');

// What the revision is measured from: base-sha, else a branch push's previous commit. Only the
// pipeline knows what an environment ran before, so no other event has a default.
function revisionBase({eventName, payload, env}) {
  const given = String(env.CHANGE_VALIDATION_BASE_SHA ?? '').trim().toLowerCase();
  const before = String(payload?.before ?? '').toLowerCase();
  const pushed = isBranchPush(eventName, payload) && !NO_COMMIT.test(before) ? before : '';
  const base = given || pushed;
  if (base === '') {
    throw new Error(`base-sha is required on ${eventName}: the commit this environment ran before this one`);
  }
  if (!COMMIT_SHA.test(base)) {
    throw new Error(`base-sha has to be a 40-character commit sha, got ${JSON.stringify(base)}`);
  }
  return base;
}

// Whether `head` is merged: on the default branch, or the commit a branch push just pushed. A
// deployment or a workflow run can name a fork's commit, which GitHub resolves across the fork
// network, and its policy would then be the fork's.
async function isMerged({githubApiUrl, repository, head, eventName, payload, token, fetchImpl}) {
  if (isBranchPush(eventName, payload) && String(payload?.after ?? '').toLowerCase() === head) {
    return true;
  }
  let defaultBranch = payload?.repository?.default_branch;
  if (typeof defaultBranch !== 'string' || defaultBranch === '') {
    const repo = await githubGet({githubApiUrl, path: `/repos/${repository}`, token, fetchImpl});
    if (!repo.ok) {
      throw new Error(`reading ${repository} answered HTTP ${repo.status}`);
    }
    defaultBranch = (await repo.json())?.default_branch;
  }
  if (typeof defaultBranch !== 'string' || defaultBranch === '') {
    throw new Error(`${repository} has no default branch`);
  }
  const path = `/repos/${repository}/compare/${head}...${encodeURIComponent(defaultBranch)}?per_page=1`;
  const response = await githubGet({githubApiUrl, path, token, fetchImpl});
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`comparing ${head} with ${defaultBranch} answered HTTP ${response.status}`);
  }
  const {status} = await response.json();
  return status === 'ahead' || status === 'identical';
}

// The branch or tag the revision was deployed from, for display.
function revisionRef({eventName, payload, env, head}) {
  const fromEvent = {deployment_status: payload?.deployment?.ref, workflow_run: payload?.workflow_run?.head_branch}[eventName];
  const ref = String(fromEvent || env.GITHUB_REF_NAME || '').trim();
  return ref === '' ? head : ref;
}

// The commits in base...head, oldest first, and the paths they change. `pathsTruncated` when the
// compare API's 300 files may not be all of them, `commitsTruncated` when the commits ran past the pages read.
export async function fetchRange({githubApiUrl, repository, base, head, token, fetchImpl}) {
  const commits = [];
  let files = [];
  let total = 0;
  let status = '';
  for (let page = 1; page <= MAX_COMMIT_PAGES; page += 1) {
    const path = `/repos/${repository}/compare/${base}...${head}?per_page=${COMMITS_PER_PAGE}&page=${page}`;
    const response = await githubGet({githubApiUrl, path, token, fetchImpl});
    if (!response.ok) {
      throw new Error(`comparing ${base}...${head} answered HTTP ${response.status}${response.status === 404 ? ', so one of them is not a commit in this repository' : ''}`);
    }
    const answer = await response.json();
    const listed = Array.isArray(answer?.commits) ? answer.commits : [];
    if (page === 1) {
      files = Array.isArray(answer?.files) ? answer.files : [];
      total = Number.isInteger(answer?.total_commits) ? answer.total_commits : 0;
      status = String(answer?.status ?? '');
    }
    commits.push(...listed.map((commit) => String(commit?.sha ?? '').toLowerCase()).filter((sha) => COMMIT_SHA.test(sha)));
    if (listed.length < COMMITS_PER_PAGE || commits.length >= total) {
      break;
    }
  }
  const paths = new Set();
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    for (const name of [file?.previous_filename, file?.filename]) {
      if (typeof name === 'string' && name !== '') {
        paths.add(name);
      }
    }
    additions += Number.isInteger(file?.additions) ? file.additions : 0;
    deletions += Number.isInteger(file?.deletions) ? file.deletions : 0;
  }
  return {
    commits,
    paths: [...paths],
    files: files.length,
    additions,
    deletions,
    // Diverged, the comparison runs from the merge base, so it misses what the base had that the head drops.
    pathsTruncated: files.length >= MAX_COMPARE_FILES || status === 'diverged',
    diverged: status === 'diverged',
    commitsTruncated: commits.length < total,
  };
}

// The merged pull requests behind each commit, by sha, in one GraphQL query per 50 commits. Labels
// are read for `labelsOf` only, the commit whose pull requests can waive a check.
export async function fetchMergedPullRequests({graphqlUrl, repository, shas, labelsOf, token, fetchImpl}) {
  const [owner, name] = repository.split('/');
  const found = new Map();
  for (let start = 0; start < shas.length; start += COMMITS_PER_QUERY) {
    const batch = shas.slice(start, start + COMMITS_PER_QUERY);
    const variables = {owner, name};
    batch.forEach((sha, index) => {
      variables[`c${index}`] = sha;
    });
    const declared = batch.map((_, index) => `$c${index}: GitObjectID!`).join(', ');
    const fields = batch
      .map((sha, index) => {
        const labels = sha === labelsOf ? ` labels(first: ${MAX_LABELS}) { nodes { name } }` : '';
        return `c${index}: object(oid: $c${index}) { ... on Commit { associatedPullRequests(first: 5) { nodes { number title state baseRepository { nameWithOwner }${labels} } } } }`;
      })
      .join(' ');
    const commits = await githubGraphql({
      graphqlUrl,
      query: `query($owner: String!, $name: String!, ${declared}) { repository(owner: $owner, name: $name) { ${fields} } }`,
      variables,
      token,
      fetchImpl,
      what: 'reading the pull requests behind the commits',
    });
    batch.forEach((sha, index) => {
      const nodes = commits[`c${index}`]?.associatedPullRequests?.nodes ?? [];
      found.set(
        sha,
        nodes
          .filter(
            (pull) =>
              pull?.state === 'MERGED' &&
              Number.isInteger(pull?.number) &&
              String(pull?.baseRepository?.nameWithOwner ?? '').toLowerCase() === repository.toLowerCase(),
          )
          .map((pull) => ({
            number: pull.number,
            title: oneLine(pull.title ?? ''),
            labels: (pull.labels?.nodes ?? []).map((label) => label?.name).filter((label) => typeof label === 'string' && label !== ''),
          })),
      );
    });
  }
  return found;
}

const short = (sha) => sha.slice(0, 7);

// A revision's stage request. Its policy is read at the head, which is merged code; its labels are
// those of the pull requests behind the head commit, the one that was deployed.
async function buildRevisionRequest({eventName, payload, env, fetchImpl}) {
  const stage = String(env.CHANGE_VALIDATION_STAGE ?? '').trim();
  if (!STAGE_NAME.test(stage)) {
    throw new Error(
      stage === ''
        ? `stage is required on ${eventName}: the policy stage to validate, of scope revision`
        : `stage ${JSON.stringify(stage)} is not a policy stage name: a letter or digit, then letters, digits, - and _, up to 64 characters`,
    );
  }
  // A deleted branch pushed nothing; GITHUB_SHA is then the default branch's tip.
  if (eventName === 'push' && payload?.deleted === true) {
    return {skip: 'a deleted ref pushed no revision'};
  }
  // Each deployment's queued, in_progress and failure statuses would otherwise run the stage again.
  if (eventName === 'deployment_status' && payload?.deployment_status?.state !== 'success') {
    return {skip: `deployment_status ${payload?.deployment_status?.state ?? 'without a state'} is not sent; only success is`};
  }
  if (eventName === 'workflow_run' && payload?.workflow_run?.conclusion !== 'success') {
    return {skip: `a workflow run that ended ${payload?.workflow_run?.conclusion ?? 'without a conclusion'} is not sent; only success is`};
  }
  const head = revisionHead({eventName, payload, env});
  const base = revisionBase({eventName, payload, env});
  const headRef = revisionRef({eventName, payload, env, head});
  const repository = env.GITHUB_REPOSITORY ?? '';
  const githubApiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const serverUrl = (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  const token = env.GH_TOKEN ?? '';
  const repositoryId = repositoryIdOf(serverUrl, repository);

  if (!(await isMerged({githubApiUrl, repository, head, eventName, payload, token, fetchImpl}))) {
    throw new Refusal(`${head} is not on ${repository}'s default branch, and a revision has to be merged code`);
  }
  const range = await fetchRange({githubApiUrl, repository, base, head, token, fetchImpl});
  const graphqlUrl = env.GITHUB_GRAPHQL_URL || `${githubApiUrl}/graphql`;
  const shas = range.commits.includes(head) ? range.commits : [...range.commits, head];
  const behind = await fetchMergedPullRequests({graphqlUrl, repository, shas, labelsOf: head, token, fetchImpl});
  const pulls = new Map();
  let unmerged = 0;
  for (const sha of range.commits) {
    const merged = behind.get(sha) ?? [];
    if (merged.length === 0) {
      unmerged += 1;
    }
    merged.forEach((pull) => pulls.set(pull.number, pull));
  }
  const allLabels = [...new Set((behind.get(head) ?? []).flatMap((pull) => pull.labels))];
  const labels = allLabels.slice(0, MAX_LABELS);

  const warnings = [];
  if (allLabels.length > labels.length) {
    warnings.push(`sent the first ${MAX_LABELS} of the ${allLabels.length} labels on the pull requests behind ${short(head)}`);
  }
  if (range.diverged) {
    warnings.push(`${short(base)} is not an ancestor of ${short(head)}, so the changed paths are measured from their merge base and every application applies`);
  }
  if (range.commits.length === 0) {
    warnings.push(`${short(head)} adds no commits to ${short(base)}, so every application applies`);
  }
  // A rollback's comparison lists nothing, though the environment changed.
  const paths = changedPathsFields({paths: range.paths, truncated: range.pathsTruncated || range.commits.length === 0});
  const policyPath = env.POLICY_FILE || POLICY_FILE;
  const policy = await readPolicyAt({repository, file: policyPath, ref: head, token, apiUrl: githubApiUrl, fetchImpl});
  const value = {
    repository: repositoryId,
    revision: head,
    // The commit the policy was read at.
    base_sha: head,
    head_sha: head,
    head_ref: headRef,
    path: policyPath,
    found: policy.found,
    ...(policy.found ? {text: policy.text, sha256: sha256(policy.text)} : {}),
  };

  const listed = [...pulls.values()];
  const shown = listed.slice(0, MAX_PULL_REQUESTS);
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const body = [
    ...shown.map((pull) => `- #${pull.number} ${pull.title}`),
    ...(listed.length > shown.length ? [`- and ${listed.length - shown.length} more`] : []),
    ...(unmerged > 0 ? [`- ${count(unmerged, 'commit', 'commits')} with no merged pull request`] : []),
    ...(range.commitsTruncated ? ['- more commits than GitHub listed, so some pull requests may be missing'] : []),
  ].join('\n');
  const summary = {
    title: `${short(head)} on ${headRef}: ${count(listed.length, 'pull request', 'pull requests')} since ${short(base)}`,
    body,
    changed_files: range.files,
    additions: range.additions,
    deletions: range.deletions,
  };
  const provided = String(env.CHANGE_DESCRIPTION ?? '').trim();
  const describe = provided
    ? async () => ({source: 'provided', text: provided})
    : async ({apiUrl, apiKey, notice, log}) => {
        let applications = [];
        if (policy.found) {
          try {
            applications = applicationsAt(await resolveStages({apiUrl, apiKey, text: policy.text, fetchImpl}), stage);
          } catch (error) {
            notice(`the change description lists the changed paths without grouping them by application: ${error?.message ?? error}`);
          }
        }
        log(`change description: built from ${range.commits.length} commits, ${listed.length} pull requests and ${range.paths.length} changed paths, ${applications.length} applications at ${stage}`);
        return {
          source: 'built',
          text: describeChange({
            pr: summary,
            paths: range.paths,
            applications,
            truncated: range.pathsTruncated,
            truncationNote: range.diverged
              ? `${short(base)} is not an ancestor of ${short(head)}, so these are measured from their merge base`
              : `GitHub lists at most ${MAX_COMPARE_FILES} of a comparison's files`,
          }),
        };
      };
  if (provided) {
    const describedHead = String(env.CHANGE_DESCRIPTION_HEAD_SHA ?? '').trim().toLowerCase();
    if (describedHead !== head) {
      throw new Error(`change-description-head-sha has to be the revision ${head}, got ${JSON.stringify(describedHead)}`);
    }
  }
  return {
    describe,
    warnings,
    // A later request for the same commit and stage runs it again, so the time is taken at sending.
    stampAtSend: true,
    body: {
      reference: {type: 'commit', id: head, url: `${serverUrl}/${repository}/commit/${head}`},
      event: {
        kind: 'stage.requested',
        stage,
        head_sha: head,
        base_sha: base,
        head_ref: headRef,
        labels,
        ...paths,
      },
      related_artifacts: [{artifact_type: 'inline', name: 'validation_policy', artifact_data: {type: 'json', value}}],
      dry_run: env.CHANGE_VALIDATION_DRY_RUN === 'true',
    },
  };
}

// Tells mabl the pull request merged, with the policy at the merge commit, which says whether mabl merges its
// mabl branch.
async function buildMergedRequest({payload, env, fetchImpl}) {
  const pr = payload.pull_request;
  if (pr?.merged !== true) {
    return {skip: 'the pull request closed without merging'};
  }
  if (isFork(pr)) {
    throw forkRefusal(pr.number);
  }
  const merge = String(pr.merge_commit_sha ?? '').toLowerCase();
  if (!COMMIT_SHA.test(merge)) {
    throw new Error(`pull request #${pr.number} has no merge commit`);
  }
  const occurredAt = Date.parse(pr.merged_at);
  if (!Number.isFinite(occurredAt)) {
    throw new Error(`pull request #${pr.number} has no merged_at`);
  }
  const repository = env.GITHUB_REPOSITORY ?? '';
  const githubApiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const repositoryId = repositoryIdOf(env.GITHUB_SERVER_URL || 'https://github.com', repository);
  const path = env.POLICY_FILE || POLICY_FILE;
  const policy = await readPolicyAt({repository, file: path, ref: merge, token: env.GH_TOKEN ?? '', apiUrl: githubApiUrl, fetchImpl});
  const value = {
    repository: repositoryId,
    pull_request: pr.number,
    base_sha: merge,
    head_sha: merge,
    head_ref: pr.head.ref,
    path,
    found: policy.found,
    ...(policy.found ? {text: policy.text, sha256: sha256(policy.text)} : {}),
  };
  return {
    warnings: [],
    body: {
      reference: {type: 'pull_request', id: `${repositoryId}#${pr.number}`, url: pr.html_url},
      event: {kind: MERGED_EVENT_KIND, head_sha: merge, head_ref: pr.head.ref, occurred_at: occurredAt},
      related_artifacts: [{artifact_type: 'inline', name: 'validation_policy', artifact_data: {type: 'json', value}}],
    },
  };
}

// A pull request names its mabl branch with a `Mabl branch: <name>` line in its description. Lines in
// code fences and HTML comments are examples, not the pull request's own.
const MABL_BRANCH_LINE = /^\s*mabl\s+branch:\s*`?([^`<>\s]+)`?\s*$/i;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// The events route's cap on event.mabl_branch.
const MAX_MABL_BRANCH_CHARS = 200;

// Whether an HTML comment is still open at the end of the line, reading its delimiters in order.
function endsInComment(line, open) {
  let inComment = open;
  for (let at = 0; ; ) {
    const next = line.indexOf(inComment ? '-->' : '<!--', at);
    if (next === -1) {
      return inComment;
    }
    at = next + (inComment ? 3 : 4);
    inComment = !inComment;
  }
}

// The name on the description's first `Mabl branch:` line, or null.
export function mablBranchFromDescription(body) {
  let skip = null;
  let fence = null;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (skip === 'fence') {
      // CommonMark: closed by the same character, at least as many, and nothing after.
      const closing = FENCE_LINE.exec(line);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length && closing[2].trim() === '') {
        skip = null;
      }
      continue;
    }
    if (skip === 'comment') {
      skip = endsInComment(line, true) ? 'comment' : null;
      continue;
    }
    const opening = FENCE_LINE.exec(line);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      skip = 'fence';
      fence = opening[1];
      continue;
    }
    if (endsInComment(line, false)) {
      skip = 'comment';
      continue;
    }
    const match = MABL_BRANCH_LINE.exec(line);
    if (match) {
      return match[1];
    }
  }
  return null;
}

// A deleted head repository counts as a fork: nobody can say it isn't one.
export function isFork(pr) {
  return !pr?.head?.repo || pr.head.repo.id !== pr?.base?.repo?.id;
}

// What this event sends, or {skip} when it sends nothing. Throws a Refusal for a fork or an
// untrusted commenter, and an Error when the event can't be sent.
export async function buildRequest({eventName, payload, env, fetchImpl, now = Date.now, reread = false}) {
  if (REVISION_EVENTS.has(eventName)) {
    return buildRevisionRequest({eventName, payload, env, fetchImpl});
  }
  let number;
  let fromComment = false;
  let command = '';
  let queued;
  if (eventName === 'pull_request') {
    if (payload.action === 'closed') {
      return buildMergedRequest({payload, env, fetchImpl});
    }
    if (!PULL_REQUEST_ACTIONS.has(payload.action)) {
      return {skip: `pull_request ${payload.action} is not sent`};
    }
    // mabl takes an edit only when it moved the base.
    if (payload.action === 'edited' && !payload.changes?.base) {
      return {skip: 'the edit did not change the base branch'};
    }
    number = payload.pull_request?.number;
  } else if (eventName === 'issue_comment') {
    if (!payload.issue?.pull_request) {
      return {skip: 'the comment is not on a pull request'};
    }
    if (payload.action !== 'created') {
      return {skip: `issue_comment ${payload.action} is not sent`};
    }
    command = commentCommand({env, payload});
    if (command === null) {
      return {skip: 'the comment does not start with the trigger word'};
    }
    const association = payload.comment?.author_association;
    if (!TRUSTED_ASSOCIATIONS.has(association)) {
      throw new Refusal(`comments are taken only from an owner, member or collaborator; the commenter is ${association ?? 'unknown'}`);
    }
    number = payload.issue.number;
    fromComment = true;
  } else if (eventName === 'merge_group') {
    if (payload.action !== 'checks_requested') {
      return {skip: `merge_group ${payload.action} is not sent`};
    }
    queued = payload.merge_group;
    number = Number(QUEUE_ENTRY.exec(String(queued?.head_ref ?? ''))?.[1]);
  } else {
    throw new Error(
      `runs on pull_request, issue_comment and merge_group events, or for a revision on ${[...REVISION_EVENTS].join(', ')}; not ${eventName || 'none'}`,
    );
  }
  const stage = String(env.CHANGE_VALIDATION_STAGE ?? '').trim();
  if (!STAGE_NAME.test(stage)) {
    throw new Error(
      stage === ''
        ? 'stage is required: the policy stage to validate, such as pull_request'
        : `stage ${JSON.stringify(stage)} is not a policy stage name: a letter or digit, then letters, digits, - and _, up to 64 characters`,
    );
  }
  if (!Number.isInteger(number) || number < 1) {
    throw new Error('the event names no pull request');
  }
  const expectedHeadApplies = !queued;
  const expectedHead = expectedHeadApplies ? String(env.CHANGE_VALIDATION_EXPECTED_HEAD_SHA ?? '').trim().toLowerCase() : '';
  if (expectedHeadApplies && !expectedHead && String(env.CHANGE_VALIDATION_REQUIRE_EXPECTED_HEAD ?? '').trim() === 'true') {
    throw new Error('require-expected-head is true, but expected-head-sha is empty');
  }

  const repository = env.GITHUB_REPOSITORY ?? '';
  const githubApiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const token = env.GH_TOKEN ?? '';
  // Fetched rather than taken from the payload: mabl wants the head as of sending.
  const pr = await fetchPullRequest({githubApiUrl, repository, number, token, fetchImpl});
  if (isFork(pr)) {
    throw forkRefusal(number);
  }
  const repositoryId = repositoryIdOf(env.GITHUB_SERVER_URL || 'https://github.com', repository);
  const base = {
    reference: {type: 'pull_request', id: `${repositoryId}#${number}`, url: pr.html_url},
  };

  if (fromComment) {
    const login = payload.comment?.user?.login;
    if (!login || !(await commenterCanWrite({githubApiUrl, repository, login, token, fetchImpl}))) {
      throw new Refusal(`comments are taken only from someone with write access to ${repository}; ${login ?? 'the commenter'} has none`);
    }
  }
  // A comment's request is timed at the comment's creation, so a retried delivery is the same request.
  let commentedAt = null;
  if (command !== '') {
    if (command.length > MAX_COMMAND_CHARS) {
      throw new Error(`the request after the trigger word is ${command.length} characters, over the ${MAX_COMMAND_CHARS} mabl takes`);
    }
    commentedAt = Date.parse(payload.comment?.created_at);
    if (!Number.isFinite(commentedAt)) {
      throw new Error('the comment has no created_at');
    }
  }

  const headSha = queued ? queued.head_sha : pr.head.sha;
  // Checked on each pass, so a head that moved while the files were listed is checked again. run()
  // has already checked its format.
  if (expectedHead && expectedHead !== String(headSha).toLowerCase()) {
    return {skip: `pull request #${number}'s head is ${headSha}, not the expected ${expectedHead}`};
  }
  const provided = String(env.CHANGE_DESCRIPTION ?? '').trim();
  if (provided) {
    const describedHead = String(env.CHANGE_DESCRIPTION_HEAD_SHA ?? '').trim().toLowerCase();
    if (!describedHead) {
      throw new Error('change-description needs change-description-head-sha, the head it was written for');
    }
    // A push landed after the description was written; that push's own run sends the new head.
    if (describedHead !== String(headSha).toLowerCase()) {
      return {skip: `the change description was written for ${describedHead}, and the head is now ${headSha}`};
    }
  }

  // A queue entry's base is its commit's first parent, the entry ahead or the base branch.
  const baseSha = queued
    ? await firstParent({githubApiUrl, repository, sha: headSha, token, fetchImpl})
    : pr.base?.sha;
  // A queue entry's policy, and the base its paths are listed from, is the merge group's, so entries
  // ahead of it can't change the policy.
  const groupBaseSha = queued ? queued.base_sha : null;
  if (queued && (typeof groupBaseSha !== 'string' || groupBaseSha === '')) {
    throw new Error('the merge group has no base_sha');
  }

  // A queue entry's paths are its commit's over the group's base, which no later push or merge can change.
  // A pull request's come from the files API, which lists it as it is now, so it's read again
  // afterwards: a push, a new base branch or a base that moved in between would describe another
  // change than the one sent, and the pull request starts over once.
  // The paths also go out as changed_paths. A built description can't do without them; with a
  // caller's description a failed read only leaves changed_paths out.
  const warnings = [];
  let changed = null;
  let moved = null;
  try {
    if (queued) {
      // The comparison a path filter makes on merge_group: the entry plus the entries ahead, all
      // of which the queue commit's build holds, whatever the merge method. The pull request's own
      // files are listed against its merge base, which can hold changes the queue commit doesn't.
      const range = await fetchRange({githubApiUrl, repository, base: groupBaseSha, head: headSha, token, fetchImpl});
      changed = {
        paths: range.paths,
        truncated: range.pathsTruncated,
        totals: range.pathsTruncated ? {} : {changed_files: range.files, additions: range.additions, deletions: range.deletions},
      };
    } else {
      changed = await fetchChangedPaths({githubApiUrl, repository, number, changedFiles: pr.changed_files, token, fetchImpl});
      const after = await fetchPullRequest({githubApiUrl, repository, number, token, fetchImpl});
      const at = (pull) => `${pull.head?.sha} on ${pull.base?.ref} at ${pull.base?.sha}`;
      moved = at(after) === at(pr) ? null : `pull request #${number} moved from ${at(pr)} to ${at(after)} while its files were listed`;
    }
  } catch (error) {
    if (!provided) {
      throw error;
    }
    changed = null;
    warnings.push(`sent without changed_paths: ${error?.message ?? error}`);
  }
  if (moved) {
    if (reread) {
      return {skip: moved};
    }
    return buildRequest({eventName, payload, env, fetchImpl, reread: true});
  }

  let pullRequestHead = queued ? null : String(headSha).toLowerCase();
  if (queued) {
    try {
      const graphqlUrl = env.GITHUB_GRAPHQL_URL || `${githubApiUrl}/graphql`;
      const entryHead = await queuedPullRequestHead({graphqlUrl, repository, number, queueSha: headSha, token, fetchImpl});
      // A dropped build sending late would replace the live entry's request for the stage.
      if (entryHead === null) {
        return {skip: `pull request #${number} has no merge queue entry at ${headSha} any more`, gone: true};
      } else if (entryHead !== String(pr.head.sha).toLowerCase()) {
        warnings.push(`sent without pull_request_head_sha: pull request #${number} moved from ${pr.head.sha} to ${entryHead}`);
      } else {
        pullRequestHead = entryHead;
      }
    } catch (error) {
      warnings.push(`sent without pull_request_head_sha: ${error?.message ?? error}`);
    }
  }
  if (pullRequestHead !== null && !COMMIT_SHA.test(pullRequestHead)) {
    warnings.push(`sent without pull_request_head_sha: ${pullRequestHead} is not a 40-character commit sha`);
    pullRequestHead = null;
  }
  const paths = changed ? changedPathsFields(changed) : null;

  // mabl runs the stage's tests on the branch the pull request names, else one named like its head branch.
  let mablBranch = mablBranchFromDescription(pr.body);
  if (mablBranch && mablBranch.length > MAX_MABL_BRANCH_CHARS) {
    warnings.push(`sent without mabl_branch: the description names one over ${MAX_MABL_BRANCH_CHARS} characters`);
    mablBranch = null;
  }
  const occurredAt = commentedAt ?? Date.parse(queued ? queued.head_commit?.timestamp : pr.updated_at);
  if (!Number.isFinite(occurredAt)) {
    throw new Error(queued ? 'the merge group has no head commit timestamp' : `pull request #${number} has no updated_at`);
  }
  const policySha = queued ? groupBaseSha : baseSha;
  const path = env.POLICY_FILE || POLICY_FILE;
  const policy = await readPolicyAt({repository, file: path, ref: policySha, token, apiUrl: githubApiUrl, fetchImpl});
  const value = {
    repository: repositoryId,
    pull_request: number,
    base_sha: policySha,
    head_sha: headSha,
    head_ref: pr.head.ref,
    path,
    found: policy.found,
    ...(policy.found ? {text: policy.text, sha256: sha256(policy.text)} : {}),
  };
  const labels = (pr.labels ?? []).map((label) => label?.name).filter((name) => typeof name === 'string' && name !== '');
  // Run after the key check, since resolving the policy takes the key.
  const describe = provided
    ? async () => ({source: 'provided', text: provided})
    : async ({apiUrl, apiKey, notice, log}) => {
        let applications = [];
        if (policy.found) {
          try {
            applications = applicationsAt(await resolveStages({apiUrl, apiKey, text: policy.text, fetchImpl}), stage);
          } catch (error) {
            notice(`the change description lists the changed paths without grouping them by application: ${error?.message ?? error}`);
          }
        }
        log(
          `change description: built from ${changed.paths.length} changed paths${changed.truncated ? ` (GitHub listed only part of the ${queued ? "queue entry's" : pr.changed_files} files)` : ''}, ${applications.length} applications at ${stage}`,
        );
        const text = queued
          ? describeChange({
              pr,
              paths: changed.paths,
              applications,
              truncated: changed.truncated,
              totals: changed.totals,
              truncationNote: `GitHub lists at most ${MAX_COMPARE_FILES} of a comparison's files`,
            })
          : describeChange({pr, paths: changed.paths, applications, truncated: changed.truncated});
        return {source: 'built', text};
      };
  return {
    describe,
    warnings,
    body: {
      ...base,
      event: {
        kind: 'stage.requested',
        stage,
        head_sha: headSha,
        base_sha: baseSha,
        head_ref: pr.head.ref,
        occurred_at: occurredAt,
        labels,
        ...(paths ?? {}),
        ...(pullRequestHead ? {pull_request_head_sha: pullRequestHead} : {}),
        ...(mablBranch ? {mabl_branch: mablBranch} : {}),
        ...(command !== '' ? {command} : {}),
      },
      related_artifacts: [{artifact_type: 'inline', name: 'validation_policy', artifact_data: {type: 'json', value}}],
      // Explicit either way: mabl stores it per stage request, and absent would follow the agent's.
      dry_run: env.CHANGE_VALIDATION_DRY_RUN === 'true',
    },
  };
}

// agent_stopping comes as a 503.
export const isRetryable = ({status}) => status === 0 || status === 429 || status >= 500;
// A merged event that got no answer, or any answer but mabl saying it stopped before merging, may still be
// merging the mabl branch, and a second call made meanwhile could record the half-done merge as diverged. A
// gateway's JSON error looks like mabl's own, so only a 429 and agent_stopping are retried.
export const isRetryableMerged = ({status, errorCode}) => status === 429 || (status >= 500 && errorCode === 'agent_stopping');

// The same body each attempt. The api dedupes a repeat it has finished with, so a retry is safe
// once an earlier attempt's call has ended; `retryable` says which answers mean it has. With a
// `deadline`, no attempt starts, runs or waits past it; `expired` says the first one never started.
export async function send({
  apiUrl,
  apiKey,
  body,
  fetchImpl,
  sleep,
  log,
  deadline,
  now = Date.now,
  signalAfter = (ms) => AbortSignal.timeout(ms),
  timeoutMs = REQUEST_TIMEOUT_MS,
  retryable = isRetryable,
}) {
  const authorization = basicAuthorization(apiKey);
  const bounded = Number.isFinite(deadline);
  for (let attempt = 0; ; attempt += 1) {
    const remaining = bounded ? deadline - now() : timeoutMs;
    if (remaining <= 0) {
      log(`POST ${EVENTS_PATH}: not sent, the deadline has passed`);
      return {status: 0, body: null, errorCode: '', expired: true};
    }
    let answer;
    try {
      const response = await fetchImpl(`${apiUrl}${EVENTS_PATH}`, {
        method: 'POST',
        headers: {authorization, 'content-type': 'application/json', accept: 'application/json'},
        body: JSON.stringify(body),
        redirect: 'error',
        signal: signalAfter(Math.min(timeoutMs, remaining), 'events'),
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      answer = {status: response.status, body: json, errorCode: typeof json?.error_code === 'string' ? oneLine(json.error_code) : ''};
    } catch (error) {
      answer = {status: 0, body: null, errorCode: '', error: String(error?.message ?? error)};
    }
    log(`POST ${EVENTS_PATH}: ${answer.status || 'no answer'}${answer.errorCode ? ` ${answer.errorCode}` : ''}`);
    if (answer.status >= 200 && answer.status < 300) {
      return answer;
    }
    if (!retryable(answer) || attempt >= RETRY_DELAYS_MS.length) {
      return answer;
    }
    if (bounded && now() + RETRY_DELAYS_MS[attempt] >= deadline) {
      return answer;
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

const NO_OUTPUTS = {outcome: '', 'session-id': '', created: '', agent: '', 'description-source': '', 'pull-request-number': ''};
// The pull request a request named, for the comment; not one of the action's outputs.
const pullRequestNumberOf = (body) => (body?.reference?.type === 'pull_request' ? (/#([1-9][0-9]*)$/.exec(body.reference.id)?.[1] ?? '') : '');

export async function run({
  env = process.env,
  fetchImpl = fetch,
  sleep = realSleep,
  now = Date.now,
  // A timeout signal; callers also pass a label naming what it bounds.
  signalAfter = (ms) => AbortSignal.timeout(ms),
  print = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  // Inputs no path may ignore. With await, an error status is published, as for any input it can't use.
  const inputError = (message) => {
    if (env.CHANGE_VALIDATION_AWAIT === 'true') {
      return endWithErrorStatus({env, fetchImpl, signalAfter, print}, `not sent: ${message}`);
    }
    print(annotation('error', shorten(escapeInvisible(redactor(env)(`not sent: ${message}`)), MAX_ANNOTATION_CHARS), {title: TITLE}));
    return {exitCode: 1, outputs: {...NO_OUTPUTS, outcome: 'failed'}};
  };
  const quoted = (value) => JSON.stringify(shorten(value, 100));
  const sendInput = String(env.CHANGE_VALIDATION_SEND ?? '').trim();
  if (sendInput !== '' && sendInput !== 'true' && sendInput !== 'false') {
    return inputError(`send has to be 'true' or 'false', got ${quoted(sendInput)}`);
  }
  const expectedInput = String(env.CHANGE_VALIDATION_EXPECTED_HEAD_SHA ?? '').trim();
  if (expectedInput !== '' && !COMMIT_SHA.test(expectedInput.toLowerCase())) {
    return inputError(`expected-head-sha has to be a 40-character commit sha, got ${quoted(expectedInput)}`);
  }
  const requireInput = String(env.CHANGE_VALIDATION_REQUIRE_EXPECTED_HEAD ?? '').trim();
  if (requireInput !== '' && requireInput !== 'true' && requireInput !== 'false') {
    return inputError(`require-expected-head has to be 'true' or 'false', got ${quoted(requireInput)}`);
  }
  if (sendInput === 'false') {
    if (env.CHANGE_VALIDATION_AWAIT === 'true') {
      return inputError("send: 'false' sends no stage request, so there is nothing to await");
    }
    return planCommentOnlyRun({env, fetchImpl, print});
  }
  if (env.CHANGE_VALIDATION_AWAIT === 'true') {
    const invokedAt = now();
    try {
      return await awaitStage({
        env,
        fetchImpl,
        sleep,
        now,
        signalAfter,
        invokedAt,
        print,
        apiUrl: apiUrlOf(env),
        sendStage,
        queuedPullRequestHead,
      });
    } catch (error) {
      return endWithErrorStatus({env, fetchImpl, signalAfter, print}, `await stopped: ${error?.message ?? error}`);
    }
  }
  const {exitCode, outputs} = await sendStage({env, fetchImpl, sleep, now, print, signalAfter});
  return {exitCode, outputs};
}

// send: 'false' sends nothing: it names the pull request whose comment comment.mjs then keeps current,
// with the checks a stage request from the same event would make first.
// Mirrors the event checks in buildRequest; keep the two in step.
async function planCommentOnlyRun({env, fetchImpl, print}) {
  const redact = redactor(env);
  const annotate = (level, message) => print(annotation(level, shorten(escapeInvisible(redact(message)), MAX_ANNOTATION_CHARS), {title: TITLE}));
  const finish = (outcome, exitCode, number = '') => ({exitCode, outputs: {...NO_OUTPUTS, outcome, 'pull-request-number': number}});
  const fail = (message) => {
    annotate('error', `not sent: ${message}`);
    return finish('failed', 1);
  };
  if (String(env.CHANGE_VALIDATION_COMMENT ?? '').trim().toLowerCase() !== 'true') {
    return fail("send: 'false' only keeps the comment current, so it needs comment: 'true'");
  }
  if (!apiUrlOf(env)) {
    return fail(`api-url has to be ${DEFAULT_API_URL}, got ${JSON.stringify(String(env.MABL_API_URL ?? ''))}`);
  }
  let payload;
  try {
    payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8'));
  } catch (error) {
    return fail(`the event can't be read: ${error?.message ?? error}`);
  }
  const eventName = env.GITHUB_EVENT_NAME;
  let number;
  try {
    if (eventName === 'pull_request') {
      if (!PULL_REQUEST_ACTIONS.has(payload.action)) {
        annotate('notice', `not sent: pull_request ${payload.action} is not taken`);
        return finish('skipped', 0);
      }
      if (payload.action === 'edited' && !payload.changes?.base) {
        annotate('notice', 'not sent: the edit did not change the base branch');
        return finish('skipped', 0);
      }
      if (isFork(payload.pull_request)) {
        throw forkRefusal(payload.pull_request?.number);
      }
      number = payload.pull_request?.number;
    } else if (eventName === 'issue_comment') {
      if (!payload.issue?.pull_request) {
        annotate('notice', 'not sent: the comment is not on a pull request');
        return finish('skipped', 0);
      }
      if (payload.action !== 'created') {
        annotate('notice', `not sent: issue_comment ${payload.action} is not taken`);
        return finish('skipped', 0);
      }
      if (commentCommand({env, payload}) === null) {
        annotate('notice', 'not sent: the comment does not start with the trigger word');
        return finish('skipped', 0);
      }
      const association = payload.comment?.author_association;
      if (!TRUSTED_ASSOCIATIONS.has(association)) {
        throw new Refusal(`comments are taken only from an owner, member or collaborator; the commenter is ${association ?? 'unknown'}`);
      }
      const repository = env.GITHUB_REPOSITORY ?? '';
      const githubApiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
      const token = env.GH_TOKEN ?? '';
      const pr = await fetchPullRequest({githubApiUrl, repository, number: payload.issue.number, token, fetchImpl});
      if (isFork(pr)) {
        throw forkRefusal(payload.issue.number);
      }
      const login = payload.comment?.user?.login;
      if (!login || !(await commenterCanWrite({githubApiUrl, repository, login, token, fetchImpl}))) {
        throw new Refusal(`comments are taken only from someone with write access to ${repository}; ${login ?? 'the commenter'} has none`);
      }
      number = payload.issue.number;
    } else {
      return fail(`send: 'false' runs on pull_request and issue_comment events, not ${eventName || 'none'}`);
    }
  } catch (error) {
    if (error instanceof Refusal) {
      annotate('notice', `not sent: ${error.message}`);
      return finish('refused', 0);
    }
    return fail(error?.message ?? error);
  }
  if (!Number.isInteger(number) || number < 1) {
    return fail('the event names no pull request');
  }
  if (!env.MABL_API_KEY) {
    return fail('mabl-api-key is required');
  }
  if (!String(env.MABL_WORKSPACE_ID ?? '').trim()) {
    return fail('workspace-id is required: the id of the mabl workspace to validate in');
  }
  annotate('notice', `pull request #${number}: no stage request sent (send: 'false'); keeping its comment current`);
  return finish('comment_only', 0, String(number));
}

// One request, as `run` sends it. Also returns the body sent (or built) and the last notice or error
// reported, for await mode; `onSending` runs just before the request goes out and may return a
// `{deadline, now, signalAfter}` budget for it.
async function sendStage({env, fetchImpl, sleep, now = Date.now, print, signalAfter, onSending = async () => {}}) {
  const apiKey = env.MABL_API_KEY ?? '';
  const redact = redactor(env);
  let said = '';
  let body = null;
  const report = (level, message) => {
    if (level !== 'warning') {
      said = redact(message);
    }
    print(annotation(level, shorten(escapeInvisible(redact(message)), MAX_ANNOTATION_CHARS), {title: TITLE}));
  };
  const finish = (outcome, exitCode, extra = {}) => ({
    exitCode,
    outputs: {...NO_OUTPUTS, outcome, 'pull-request-number': pullRequestNumberOf(body), ...extra},
    body,
    detail: said,
  });

  const apiUrl = apiUrlOf(env);
  if (!apiUrl) {
    report('error', `api-url has to be ${DEFAULT_API_URL}, got ${JSON.stringify(String(env.MABL_API_URL ?? ''))}`);
    return finish('failed', 1);
  }
  let request;
  try {
    const payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8'));
    request = await buildRequest({eventName: env.GITHUB_EVENT_NAME, payload, env, fetchImpl, now});
  } catch (error) {
    if (error instanceof Refusal) {
      report('notice', `not sent: ${error.message}`);
      return finish('refused', 0);
    }
    report('error', `not sent: ${error?.message ?? error}`);
    return finish('failed', 1);
  }
  if (request.skip) {
    report('notice', `not sent: ${request.skip}`);
    return finish(request.gone ? 'entry_gone' : 'skipped', 0);
  }
  for (const warning of request.warnings ?? []) {
    report('warning', warning);
  }
  // Checked after the refusals: a fork's run gets no secrets.
  if (!apiKey) {
    report('error', 'mabl-api-key is required');
    return finish('failed', 1);
  }
  const workspaceId = String(env.MABL_WORKSPACE_ID ?? '').trim();
  if (!workspaceId) {
    report('error', 'workspace-id is required: the id of the mabl workspace to validate in');
    return finish('failed', 1);
  }
  body = {workspace_id: workspaceId, ...request.body};
  const described = {};
  if (request.describe) {
    try {
      const {source, text} = await request.describe({
        apiUrl,
        apiKey,
        notice: (message) => report('notice', message),
        log: (line) => print(redact(line)),
      });
      described['description-source'] = source;
      if (text !== '') {
        body.change_description = clip(text, MAX_DESCRIPTION_CHARS);
      }
    } catch (error) {
      report('error', `not sent: ${error?.message ?? error}`);
      return finish('failed', 1);
    }
  }

  if (request.stampAtSend) {
    body.event.occurred_at = now();
  }
  const budget = await onSending(body);
  const merged = body.event.kind === MERGED_EVENT_KIND;
  const answer = await send({
    apiUrl,
    apiKey,
    body,
    fetchImpl,
    sleep,
    log: (line) => print(redact(line)),
    ...(signalAfter ? {signalAfter} : {}),
    ...(merged ? {timeoutMs: MERGED_TIMEOUT_MS, retryable: isRetryableMerged} : {}),
    ...budget,
  });
  if (answer.expired) {
    report('error', 'not sent: the deadline passed before the stage request could go out');
    return finish('timed_out', 1, described);
  }
  if (answer.status >= 200 && answer.status < 300) {
    const result = answer.body ?? {};
    const what = body.event.kind === MERGED_EVENT_KIND ? 'merged' : `stage ${body.event.stage}${body.event.command ? " with the comment's request" : ''}`;
    report('notice', `${what}: ${result.event}${result.agent ? `, agent ${result.agent}` : ''} (${result.session_id})`);
    let exitCode = 0;
    let unmerged = [];
    // A superseded merged event is another merge commit's, so its branch isn't this one's to report.
    if (merged && TAKEN.has(result.event)) {
      const branchReport = mergeOutcome(result.landed, {recorded: result.event === 'duplicate'});
      branchReport.annotations.forEach(({level, message}) => report(level, message));
      branchReport.log.forEach((line) => print(redact(escapeInvisible(line))));
      exitCode = branchReport.failed ? 1 : 0;
      unmerged = branchReport.unmerged;
    }
    return finish(String(result.event ?? ''), exitCode, {
      ...described,
      ...(unmerged.length > 0 ? {'unmerged-branches': JSON.stringify(unmerged)} : {}),
      'session-id': String(result.session_id ?? ''),
      created: String(result.created === true),
      agent: String(result.agent ?? ''),
    });
  }
  const detail = answer.error ?? (typeof answer.body?.message === 'string' ? answer.body.message : '');
  const what = `${answer.status ? `HTTP ${answer.status}` : 'no answer'}${answer.errorCode ? ` ${answer.errorCode}` : ''}${detail ? `: ${detail}` : ''}`;
  if (QUIET_ERRORS.has(answer.errorCode)) {
    report('notice', what);
    return finish(answer.errorCode, 0, described);
  }
  // Not retried, so whoever reads the log needs to know a re-run is how to learn the outcome.
  const inFlight = merged && (answer.status === 0 || answer.status >= 500) && !isRetryableMerged(answer);
  report('error', inFlight ? `${what}; mabl may still be merging the mabl branch, so re-run this job in a few minutes to read what it recorded` : what);
  return finish(answer.errorCode || 'failed', 1, described);
}
