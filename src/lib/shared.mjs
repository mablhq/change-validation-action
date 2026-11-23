// Constants and small helpers the action's scripts share.

export const TITLE = 'mabl change validation';
export const MAX_ANNOTATION_CHARS = 500;
export const COMMIT_SHA = /^[0-9a-f]{40}$/;
export const MINUTE_MS = 60_000;
// Events mabl took as its own, as opposed to ones it ignored or replaced.
export const TAKEN = new Set(['accepted', 'duplicate']);

export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A repository as mabl's references name it: <host>/<owner>/<repo>, lowercase.
export const repositoryIdOf = (serverUrl, repository) => `${new URL(serverUrl).host}/${repository}`.toLowerCase();

// Masks the mabl key and the GitHub token in anything printed.
export function redactor(env) {
  const secrets = [String(env.MABL_API_KEY ?? ''), String(env.GH_TOKEN ?? '').trim()].filter((secret) => secret.length >= 8);
  return (text) => secrets.reduce((out, secret) => out.replaceAll(secret, '***'), String(text));
}
