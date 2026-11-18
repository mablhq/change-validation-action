// Text escaping and the mabl api authorization shared by the action's scripts.

// A newline followed by `::error::` in a job log is a workflow command whichever script printed it.
export const CONTROL_PATTERN = /[\p{Cc}\p{Cf}]/gu;

export const oneLine = (value) =>
  String(value ?? '')
    .replace(CONTROL_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// The key as the basic-auth user with no password.
export const basicAuthorization = (apiKey) =>
  `Basic ${Buffer.from(`${apiKey}:`, 'utf8').toString('base64')}`;

export const DEFAULT_API_URL = 'https://api.mabl.com';
// The key is sent only to mabl's api, https://api.mabl.com, written with nothing more than a trailing slash.
export const API_URLS = new Set([DEFAULT_API_URL]);
export function apiUrlOf(env) {
  const raw = String(env.MABL_API_URL ?? '').trim() || DEFAULT_API_URL;
  const origin = raw.replace(/\/$/, '');
  return API_URLS.has(origin) ? origin : '';
}
