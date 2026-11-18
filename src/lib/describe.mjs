// Builds a change description from pull request metadata alone: the title, the description, the
// changed paths grouped by area, and the diff totals. Deterministic and bounded: the events route
// caps `change_description` at 20000 UTF-16 code units, so every budget here is measured in `.length`
// and every cut lands on a code-point boundary. The title and body are the PR author's text.

import {CONTROL_PATTERN, oneLine} from './mabl-api.mjs';

const MAX_DESCRIPTION_CHARS = 20_000;
const MAX_BODY_CHARS = 8_000;
const MAX_PATHS_PER_AREA = 8;

// The one `git diff --stat` line that says something without naming a path. Read from the end,
// because git prints its totals last and a file may legally be named `9999 files changed, 1
// insertion(+)`, which the stat lists above them: the first match would be that filename, and the
// description's only number would be the PR author's to choose.
const DIFF_TOTALS_PATTERN = /^\s*\d+ files? changed.*$/gm;

const REGEXP_META_PATTERN = /[.*+?^${}()|[\]\\]/g;

// Line structure survives, because a PR body's list and paragraph breaks are most of what makes it
// readable; everything else that could forge structure downstream does not.
const multiLine = (value) =>
  String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line.replace(CONTROL_PATTERN, ' ').replace(/[^\S\n]+/g, ' ').trimEnd(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const codePoints = (value) => [...value];
// The server checks `change_description.length`, so every budget here counts UTF-16 units.
const units = (value) => value.length;
// Accumulated by code point, so a cut never splits a surrogate pair.
const clamp = (value, maxUnits) => {
  if (value.length <= maxUnits) {
    return value;
  }
  let kept = '';
  for (const char of value) {
    if (kept.length + char.length > maxUnits) {
      break;
    }
    kept += char;
  }
  return kept;
};
const fileCountLabel = (count) => `${count} file${count === 1 ? '' : 's'}`;
// Globs are matched against the raw path, but a bullet lists several paths on one line, so a path
// that legally contains a newline is shown escaped and never forges structure in the description.
const displayPath = (path) => oneLine(String(path).replace(/\n/g, '\\n'));

// Anchored on both ends, so a glob matches a whole path or nothing: `frontend/**` must not claim
// `frontendx/`. `**/` is the only form that may match nothing at all, which is what makes
// `**/*.snap` cover a root-level snapshot as well as a nested one. No implicit basename matching
// and no brace expansion -- both would make a map line mean more than it says.
// (path.matchesGlob is experimental on Node 24, so it is not used here.)
export function globToRegExp(glob) {
  const chars = codePoints(String(glob));
  let pattern = '^';
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (char === '*' && chars[index + 1] === '*') {
      // A whole run of stars is one `**`: stacked quantifiers backtrack for seconds on the kind of
      // path a PR author names.
      let end = index + 1;
      while (chars[end + 1] === '*') {
        end += 1;
      }
      if (chars[end + 1] === '/') {
        pattern += '(?:.*/)?';
        index = end + 1;
      } else {
        pattern += '.*';
        index = end;
      }
      continue;
    }
    if (char === '*') {
      pattern += '[^/]*';
      continue;
    }
    if (char === '?') {
      pattern += '[^/]';
      continue;
    }
    pattern += char.replace(REGEXP_META_PATTERN, '\\$&');
  }
  // `u`, so `?` matches one code point rather than one UTF-16 unit. `s`, so `**` spans a path
  // that legally contains a newline: each subject here is one whole path, never a line.
  return new RegExp(`${pattern}$`, 'su');
}

// First match wins, so map order is precedence. Phrases are merged, so two globs naming the same
// product area produce one bullet rather than two competing counts. What no line matches is
// counted, not listed: a path with no phrase is not product vocabulary.
export function groupByArea(changedFiles, areaMap) {
  const byPhrase = new Map();
  for (const entry of areaMap) {
    if (!byPhrase.has(entry.phrase)) {
      byPhrase.set(entry.phrase, {phrase: entry.phrase, paths: [], count: 0});
    }
  }
  let filesUnmapped = 0;
  for (const file of changedFiles) {
    const entry = areaMap.find((candidate) => candidate.pattern.test(file));
    if (!entry) {
      filesUnmapped += 1;
      continue;
    }
    const area = byPhrase.get(entry.phrase);
    area.paths.push(file);
    area.count += 1;
  }
  return {
    areas: [...byPhrase.values()].filter((area) => area.count > 0),
    filesUnmapped,
  };
}

export function buildDescription(input, limits = {}) {
  const maxDescription = limits.maxDescriptionChars ?? MAX_DESCRIPTION_CHARS;
  const maxBody = limits.maxBodyChars ?? MAX_BODY_CHARS;
  const maxPaths = limits.maxPathsPerArea ?? MAX_PATHS_PER_AREA;

  const title = oneLine(input.title) || '(untitled)';
  const wholeBody = multiLine(input.body);
  const bodyTruncated = units(wholeBody) > maxBody;
  const body = bodyTruncated ? clamp(wholeBody, maxBody) : wholeBody;

  // The changed paths, already grouped, in groupByArea's shape.
  const grouped = input.grouped ?? {areas: [], filesUnmapped: 0};

  const areaBullets = [];
  for (const area of grouped.areas) {
    const shown = area.paths.slice(0, maxPaths);
    const more = area.count - shown.length;
    areaBullets.push(
      `- ${area.phrase} (${fileCountLabel(area.count)}): ${shown.map(displayPath).join(', ')}${more > 0 ? ` (+${more} more)` : ''}`,
    );
  }

  // Areas before the body.
  const sections = [`Title: ${title}`];
  if (areaBullets.length > 0) {
    sections.push(
      [
        input.areasHeading ?? 'Changed paths:',
        ...areaBullets,
      ].join('\n'),
    );
  }
  sections.push(
    ['Description:', '', body === '' ? '(no description)' : body].join('\n'),
  );
  // matchAll clones the regex, so the module-level `g` never carries lastIndex between calls.
  const totals = [
    ...multiLine(input.diffStat).matchAll(DIFF_TOTALS_PATTERN),
  ].at(-1);
  if (totals) {
    sections.push(`Diff stat: ${totals[0].trim()}`);
  }

  let description = sections.join('\n\n');
  const capped = units(description) > maxDescription;
  if (capped) {
    description = clamp(description, maxDescription);
  }

  // `description` is exactly the string the request body carries.
  return {description, capped};
}
