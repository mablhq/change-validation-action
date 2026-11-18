// GitHub Actions plumbing the action's scripts share: workflow commands, step outputs, and the entry check.

import {randomUUID} from 'node:crypto';
import {appendFileSync, realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const escapeData = (value) =>
  String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const escapeProperty = (value) => escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');

// A workflow command: `::error file=f,line=1,col=2,title=t::message`.
export function annotation(level, message, {file, line, col, title} = {}) {
  const properties = Object.entries({file, line, col, title})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([name, value]) => `${name}=${escapeProperty(value)}`)
    .join(',');
  return `::${level}${properties === '' ? '' : ` ${properties}`}::${escapeData(message)}`;
}

// $GITHUB_OUTPUT's `name<<delimiter` form, under a delimiter made after the value, so no value can hold it.
export function writeOutputs(path, values) {
  let text = '';
  for (const [name, value] of Object.entries(values)) {
    const delimiter = `ghadelimiter_${randomUUID()}`;
    text += `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
  }
  appendFileSync(path, text);
}

export const shorten = (text, max) => {
  const chars = [...String(text)];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}\u2026` : chars.join('');
};

// Real paths on both sides, so a path through a symlink still runs it.
export function isMain(moduleUrl, argv = process.argv) {
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv[1]);
  } catch {
    return false;
  }
}
