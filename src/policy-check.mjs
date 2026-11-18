// The policy check: reads the policy at `ref` (and at `compare-ref`), has the mabl api resolve it,
// and writes the outputs, the annotations and the job summary. Exits 1 only when the file at `ref`
// is invalid or can't be read or resolved.
//
// Everything here comes from a file a PR author may control, so the summary puts every value in a
// code span and the outputs are written under a random delimiter.

import {createHash} from 'node:crypto';
import {appendFileSync} from 'node:fs';

import {DEFAULT_API_URL, basicAuthorization, oneLine} from './lib/mabl-api.mjs';
import {POLICY_FILE, escapeInvisible, readPolicyAt} from './lib/policy-read.mjs';
import {MAX_ANNOTATION_CHARS} from './lib/shared.mjs';
import {annotation, shorten, writeOutputs} from './lib/workflow-commands.mjs';

const TITLE = 'mabl policy';
const MAX_CELL_CHARS = 200;
// How much of what two long values share is kept before where they first differ.
const LEAD_CHARS = 40;
// GitHub refuses a step summary over 1 MiB.
export const MAX_SUMMARY_BYTES = 512 * 1024;
const RESOLVE_TIMEOUT_MS = 60_000;
export const RESOLVE_PATH = '/validationPolicy/resolve';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const shortSha = (sha) => String(sha).slice(0, 7);

// Escaped rather than dropped, so a value that differs only in what can't be seen, or in a backtick,
// still shows a change.
const escaped = (text) => escapeInvisible(text).replaceAll('`', '\\u0060');
const clip = (text) => shorten(escaped(text), MAX_CELL_CHARS);
// A code span outside a table.
export const code = (text) => `\`${clip(text)}\``;
// A code span inside a table cell, of text already escaped and cut. GitHub takes any `\|` as a pipe
// that doesn't end the cell, and gives it back without its backslash, so only the pipe needs escaping.
const inCell = (text) => `\`${text.replaceAll('|', '\\|')}\``;
export const cell = (text) => inCell(clip(text));

// A value's text in a cell, as code points, before it's cut.
const cellText = (value) => [...escaped(canonicalJson(value))];
const tooLong = (value) => cellText(value).length > MAX_CELL_CHARS;

// One row per setting that differs; a side that doesn't exist is undefined. An object on one side
// only is listed setting by setting.
function settingRows(before, after, path) {
  const beforeObject = isPlainObject(before);
  const afterObject = isPlainObject(after);
  if ((beforeObject || afterObject) && (beforeObject || before === undefined) && (afterObject || after === undefined)) {
    const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
    if (keys.length > 0) {
      return keys.flatMap((key) =>
        settingRows(
          beforeObject && Object.hasOwn(before, key) ? before[key] : undefined,
          afterObject && Object.hasOwn(after, key) ? after[key] : undefined,
          path === '' ? key : `${path}.${key}`,
        ),
      );
    }
  }
  if (before === undefined && after === undefined) {
    return [];
  }
  if (before !== undefined && after !== undefined && canonicalJson(before) === canonicalJson(after)) {
    return [];
  }
  return [{path, before, after}];
}

const entries = (count) => `${count} ${count === 1 ? 'entry' : 'entries'}`;

// The entries of `list` that `other` doesn't have, a repeated entry counted once per time it appears.
function missingFrom(other, list) {
  const left = new Map();
  for (const entry of other) {
    const key = canonicalJson(entry);
    left.set(key, (left.get(key) ?? 0) + 1);
  }
  return list.filter((entry) => {
    const key = canonicalJson(entry);
    const count = left.get(key) ?? 0;
    if (count === 0) {
      return true;
    }
    left.set(key, count - 1);
    return false;
  });
}

// Two texts, as code points, cut to a cell each. When one is cut and they first differ near or past
// where it's cut, both start a little before that, so the difference shows.
function cutPair(before, after) {
  let same = 0;
  while (same < before.length && same < after.length && before[same] === after[same]) {
    same += 1;
  }
  const from =
    Math.max(before.length, after.length) > MAX_CELL_CHARS && same > MAX_CELL_CHARS - LEAD_CHARS ? same - LEAD_CHARS : 0;
  return [before, after].map((chars) => shorten(`${from > 0 ? '\u2026' : ''}${chars.slice(from).join('')}`, MAX_CELL_CHARS));
}

// A row's before and after cells. A list too long for a cell, with entries on both sides, shows the
// entries removed and added rather than the whole list; another list that's cut says how many
// entries it has.
function shownPair(before, after) {
  const lists = Array.isArray(before) && Array.isArray(after) && before.length > 0 && after.length > 0;
  if (lists && (tooLong(before) || tooLong(after))) {
    const removed = missingFrom(after, before);
    const added = missingFrom(before, after);
    const [removedText, addedText] = cutPair(cellText(removed), cellText(added));
    const change = (list, verb, text) => (list.length > 0 ? `, ${list.length} ${verb}: ${inCell(text)}` : '');
    return [
      `${entries(before.length)}${change(removed, 'removed', removedText)}`,
      `${entries(after.length)}${change(added, 'added', addedText)}${removed.length + added.length === 0 ? ', reordered' : ''}`,
    ];
  }
  const texts = [before, after].map((value) => (value === undefined ? [] : cellText(value)));
  const cut = cutPair(...texts);
  return [before, after].map((value, side) => {
    if (value === undefined) {
      return '\u2014';
    }
    const shown = inCell(cut[side]);
    return Array.isArray(value) && texts[side].length > MAX_CELL_CHARS ? `${entries(value.length)}: ${shown}` : shown;
  });
}

function statusLine({file, ref, compareRef, head, base}) {
  const at = `${code(file)} at ${code(shortSha(ref))}`;
  if (head.readError) {
    return `${at} could not be read: ${code(head.readError)}`;
  }
  if (head.errors) {
    return `${at} is invalid: ${head.errors.length} error${head.errors.length === 1 ? '' : 's'}.`;
  }
  const from = code(shortSha(compareRef));
  if (!head.found) {
    return base?.found ? `${at}: no policy file. It was removed; there is one at ${from}.` : `${at}: no policy file.`;
  }
  const valid = `${at} is valid (digest ${code(head.digest.slice(0, 12))}).`;
  if (base === null) {
    return valid;
  }
  if (base.readError) {
    return `${valid} The file at ${from} could not be read: ${code(base.readError)}`;
  }
  if (!base.found) {
    return `${valid} It was added: there is no policy at ${from}.`;
  }
  if (base.errors) {
    return `${valid} The file at ${from} is invalid, so every setting is compared with nothing.`;
  }
  return base.digest === head.digest ? `${valid} No resolved setting changed from ${from}.` : `${valid} Resolved settings changed from ${from}:`;
}

// The lines that fit in MAX_SUMMARY_BYTES, then one saying where they stopped.
function within(lines) {
  let bytes = 0;
  for (const [index, line] of lines.entries()) {
    bytes += Buffer.byteLength(line, 'utf8') + 1;
    if (bytes > MAX_SUMMARY_BYTES) {
      const stop = `The summary stops here, at ${MAX_SUMMARY_BYTES / 1024} KiB.`;
      return [...lines.slice(0, index), '', stop];
    }
  }
  return lines;
}

export function renderSummary({file, ref, compareRef = '', head, base = null}) {
  const lines = [`### ${TITLE}`, '', statusLine({file, ref, compareRef, head, base})];
  if (head.errors) {
    lines.push('');
    for (const error of head.errors) {
      const where = Number.isInteger(error.line) ? `${error.line}:${error.column} ` : '';
      lines.push(`- ${code(`${where}${error.path ? `${error.path}: ` : ''}${error.message}`)}`);
    }
    return `${within(lines).join('\n')}\n`;
  }
  // An unreadable side leaves nothing to compare: its settings aren't known, not removed.
  if (base === null || base.readError || head.readError) {
    return `${lines.join('\n')}\n`;
  }
  const before = base.resolved ?? {};
  const after = head.resolved ?? {};
  const tables = [];
  for (const app of [...new Set([...Object.keys(before), ...Object.keys(after)])]) {
    const stagesBefore = before[app] ?? {};
    const stagesAfter = after[app] ?? {};
    for (const stage of [...new Set([...Object.keys(stagesBefore), ...Object.keys(stagesAfter)])]) {
      const rows = settingRows(stagesBefore[stage], stagesAfter[stage], '');
      if (rows.length === 0) {
        continue;
      }
      const change = stagesBefore[stage] === undefined ? ' (added)' : stagesAfter[stage] === undefined ? ' (removed)' : '';
      tables.push('', `#### ${code(app)} ${code(stage)}${change}`, '', '| setting | before | after |', '| --- | --- | --- |');
      for (const row of rows) {
        const [shownBefore, shownAfter] = shownPair(row.before, row.after);
        tables.push(`| ${cell(row.path)} | ${shownBefore} | ${shownAfter} |`);
      }
    }
  }
  return `${within([...lines, ...tables]).join('\n')}\n`;
}

// The api's answer for `text`: its errors, or the policy and its resolved stages. No answer throws.
export async function resolveWithApi(text, {apiKey, apiUrl = DEFAULT_API_URL, fetchImpl = fetch}) {
  let response;
  try {
    response = await fetchImpl(`${apiUrl}${RESOLVE_PATH}`, {
      method: 'POST',
      headers: {authorization: basicAuthorization(apiKey), 'content-type': 'application/json', accept: 'application/json'},
      body: JSON.stringify({yaml: text}),
      redirect: 'error',
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`could not resolve: ${error?.message ?? error}`);
  }
  const answer = await response.json().catch(() => null);
  if (!response.ok || typeof answer?.valid !== 'boolean') {
    const code = typeof answer?.error_code === 'string' ? ` ${oneLine(answer.error_code)}` : '';
    throw new Error(`could not resolve: the mabl api answered HTTP ${response.status}${code}`);
  }
  return answer;
}

async function load(read, resolve, ref) {
  try {
    const answer = await read(ref);
    if (!answer.found) {
      return {found: false};
    }
    const result = await resolve(answer.text);
    if (result.valid !== true) {
      return {found: true, errors: result.errors ?? []};
    }
    const stages = result.stages ?? {};
    return {
      found: true,
      policy: result.policy,
      resolved: stages,
      digest: createHash('sha256').update(canonicalJson(stages)).digest('hex'),
    };
  } catch (error) {
    return {readError: String(error?.message ?? error)};
  }
}

export async function main({
  env = process.env,
  fetchImpl = fetch,
  resolveImpl,
  print = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const apiKey = env.MABL_API_KEY ?? '';
  const resolve = resolveImpl ?? ((text) => resolveWithApi(text, {apiKey, fetchImpl}));
  const file = env.POLICY_FILE || POLICY_FILE;
  const ref = env.POLICY_REF ?? '';
  const compareRef = env.POLICY_COMPARE_REF ?? '';
  const read = (at) =>
    readPolicyAt({
      repository: env.POLICY_REPOSITORY ?? '',
      file,
      ref: at,
      token: env.GH_TOKEN ?? '',
      apiUrl: env.GITHUB_API_URL || undefined,
      fetchImpl,
    });

  const head = await load(read, resolve, ref);
  const base = compareRef === '' ? null : await load(read, resolve, compareRef);
  // Inputs and the api's messages may hold what wouldn't show as written.
  const report = (level, message, properties = {}) =>
    print(annotation(level, shorten(escapeInvisible(message), MAX_ANNOTATION_CHARS), {...properties, title: TITLE}));

  if (head.readError) {
    report('error', `could not read ${file} at ${ref}: ${head.readError}`);
  } else if (head.errors) {
    for (const error of head.errors) {
      report('error', error.path ? `${error.path}: ${error.message}` : error.message, {file, line: error.line, col: error.column});
    }
  } else if (!head.found) {
    // Deleting the file is the largest change a policy can make, so it isn't left as a notice.
    if (base?.found) {
      report('warning', `no ${file} at ${ref}, but ${compareRef} has one: every setting there is removed`);
    } else {
      report('notice', `no ${file} at ${ref}`);
    }
  }
  if (base?.readError) {
    report('warning', `could not read ${file} at ${compareRef}, so nothing is compared: ${base.readError}`);
  } else if (base?.errors) {
    report('warning', `${file} at ${compareRef} is invalid, so every setting is compared with nothing`);
  }

  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary({file, ref, compareRef, head, base}));
  }
  if (env.GITHUB_OUTPUT) {
    writeOutputs(env.GITHUB_OUTPUT, {
      found: head.readError ? '' : String(Boolean(head.found)),
      digest: head.digest ?? '',
      policy: JSON.stringify(head.policy ?? {}),
      stages: JSON.stringify(head.resolved ?? {}),
    });
  }
  return head.readError || head.errors ? 1 : 0;
}
