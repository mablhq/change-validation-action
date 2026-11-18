// Reads a repository's policy file at a commit through the GitHub contents API.

export const POLICY_FILE = '.mabl/policy.yaml';
// The largest file readPolicyAt reads.
const MAX_POLICY_BYTES = 64 * 1024;
const PRINTABLE_ASCII_PATTERN = /^[\x21-\x7e]*$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FILE_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const MAX_FILE_CHARS = 200;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
// What fetch trims from a header value's ends.
const HTTP_WHITESPACE = '\t\n\r ';
const READ_TIMEOUT_MS = 30_000;
// Controls, format characters (zero-width, bidi), what Unicode says to ignore (variation selectors,
// fillers), and every space and line separator but " ".
const INVISIBLE_PATTERN = /(?! )[\p{Cc}\p{Cf}\p{Z}\p{Default_Ignorable_Code_Point}]/gu;

// Each character that shows as nothing, as a space or as a line break, or that reorders the text
// around it, as \u escapes, so text quoting a value can't hide or spoof anything.
export function escapeInvisible(text) {
  return String(text).replace(INVISIBLE_PATTERN, (char) =>
    Array.from({length: char.length}, (_, index) => `\\u${char.charCodeAt(index).toString(16).padStart(4, '0')}`).join(''),
  );
}

// A value in double quotes, for a message.
const quote = (text) => escapeInvisible(JSON.stringify(String(text)));

// `text` without any of `chars` at either end. Linear: a regex like / +$/ backtracks quadratically.
function trim(text, chars) {
  let from = 0;
  let to = text.length;
  while (from < to && chars.includes(text[from])) {
    from += 1;
  }
  while (to > from && chars.includes(text[to - 1])) {
    to -= 1;
  }
  return text.slice(from, to);
}

const hasDotSegment = (path) => path.split('/').some((part) => part === '.' || part === '..');

function checkReadInputs({repository, file, ref}) {
  const repo = String(repository ?? '');
  if (!REPOSITORY_PATTERN.test(repo) || hasDotSegment(repo)) {
    throw new Error(`repository has to be owner/name, got ${quote(repo)}`);
  }
  const path = String(file ?? '');
  if (path.length > MAX_FILE_CHARS || !FILE_PATTERN.test(path) || hasDotSegment(path)) {
    throw new Error(
      `file has to be a relative path of letters, digits, ., _, - and /, with no . or .. segment, up to ${MAX_FILE_CHARS} characters; got ${quote(path)}`,
    );
  }
  if (!SHA_PATTERN.test(String(ref ?? ''))) {
    throw new Error(`ref has to be a full commit sha, got ${quote(String(ref ?? ''))}`);
  }
}

// Whether `bytes` are UTF-8; text() and 'utf8' would write U+FFFD over what isn't.
function isUtf8(bytes) {
  try {
    new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

// fetch's own error for a bad header value would quote the token.
function bearer(token) {
  const value = trim(String(token ?? ''), HTTP_WHITESPACE);
  if (!PRINTABLE_ASCII_PATTERN.test(value)) {
    throw new Error('token has to be printable ASCII, with no space or line break inside it');
  }
  return `Bearer ${value}`;
}

// {found: false} when the commit has no such file, else {found: true, text}. Throws on anything
// else, an unknown commit or a repository the token can't see included, since then nobody can say
// whether the file exists. timeoutMs is per request, and a missing file takes two.
export async function readPolicyAt({
  repository,
  file,
  ref,
  token,
  apiUrl = 'https://api.github.com',
  fetchImpl = fetch,
  timeoutMs = READ_TIMEOUT_MS,
}) {
  checkReadInputs({repository, file, ref});
  const authorization = bearer(token);
  const repositoryUrl = `${apiUrl}/repos/${repository}`;
  const get = (url, accept) =>
    fetchImpl(url, {
      headers: {
        Authorization: authorization,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'mabl-change-validation-action',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  const contentPath = file.split('/').map(encodeURIComponent).join('/');
  const response = await get(`${repositoryUrl}/contents/${contentPath}?ref=${encodeURIComponent(ref)}`, 'application/vnd.github.raw');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (response.status === 200) {
    // The raw media type only applies to a file; a directory or a submodule comes back as JSON.
    if ((response.headers.get('content-type') ?? '').startsWith('application/json')) {
      throw new Error(`${file} at ${ref} is not a file`);
    }
    if (bytes.length > MAX_POLICY_BYTES) {
      throw new Error(`${file} at ${ref} is larger than ${MAX_POLICY_BYTES / 1024} KiB`);
    }
    if (!isUtf8(bytes)) {
      throw new Error(`${file} at ${ref} is not valid UTF-8`);
    }
    return {found: true, text: new TextDecoder().decode(bytes)};
  }
  const body = new TextDecoder().decode(bytes);
  let message = '';
  try {
    message = String(JSON.parse(body)?.message ?? '');
  } catch {
    message = '';
  }
  if (response.status === 404 && message === 'Not Found') {
    // GitHub says the same for a repository the token can't see, so the commit has to be visible.
    const commit = await get(`${repositoryUrl}/git/commits/${ref}`, 'application/vnd.github+json');
    await commit.arrayBuffer();
    if (commit.status === 200) {
      return {found: false};
    }
    throw new Error(
      `reading ${file} at ${ref} answered HTTP 404, and asking for the commit answered HTTP ${commit.status}: check that repository ${repository} exists and the token can read it`,
    );
  }
  throw new Error(`reading ${file} at ${ref} answered HTTP ${response.status}${message ? `: ${message}` : ''}`);
}
