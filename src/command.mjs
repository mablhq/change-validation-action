// What a pull request comment asks for.

// The `command` input, or with a trigger word the rest of the comment's first line after it. Empty
// sends the pull request's current head; null means the comment doesn't start with the trigger word.
export function commentCommand({env, payload}) {
  const word = String(env.CHANGE_VALIDATION_TRIGGER_WORD ?? '').trim();
  if (word === '') {
    return String(env.CHANGE_VALIDATION_COMMAND ?? '').trim();
  }
  const [first] = String(payload?.comment?.body ?? '').split(/\r?\n/, 1);
  if (first !== word && !first.startsWith(`${word} `)) {
    return null;
  }
  return first.slice(word.length).trim();
}
