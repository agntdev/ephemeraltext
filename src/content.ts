// Basic spam / abuse heuristics for user-submitted message text. These are
// deliberately conservative — they reject obvious spam without blocking normal
// messages. Pure functions of the input (no randomness, no external calls) so
// the decision is deterministic and testable.

// Matches http(s) URLs.
const URL_RE = /https?:\/\/\S+/gi;

// Reject anything with at least this many links (typical of link spam).
const MAX_URLS = 4;

// Reject a run of the same character at least this long (e.g. "aaaa…").
const MAX_CHAR_RUN = 40;

// Reject the same whitespace-delimited token repeated at least this many times.
const MAX_TOKEN_REPEAT = 10;

/** Number of http(s) URLs in the text. */
function urlCount(text: string): number {
  return (text.match(URL_RE) ?? []).length;
}

/** Longest run of a single repeated character. */
function longestCharRun(text: string): number {
  let longest = 0;
  let run = 0;
  let prev = "";
  for (const ch of text) {
    run = ch === prev ? run + 1 : 1;
    prev = ch;
    if (run > longest) longest = run;
  }
  return longest;
}

/** Highest number of times any single token is repeated. */
function maxTokenRepeat(text: string): number {
  const counts = new Map<string, number>();
  let max = 0;
  for (const token of text.toLowerCase().split(/\s+/)) {
    if (!token) continue;
    const next = (counts.get(token) ?? 0) + 1;
    counts.set(token, next);
    if (next > max) max = next;
  }
  return max;
}

/**
 * isAbusive — true when the text trips one of the spam heuristics and should be
 * rejected before it is stored or shared.
 */
export function isAbusive(text: string): boolean {
  if (urlCount(text) >= MAX_URLS) return true;
  if (longestCharRun(text) > MAX_CHAR_RUN) return true;
  if (maxTokenRepeat(text) >= MAX_TOKEN_REPEAT) return true;
  return false;
}
