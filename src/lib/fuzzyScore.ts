// Subsequence fuzzy scorer for the command palette.
// Returns null if `query` is not a subsequence of `target` (case-insensitive),
// otherwise a score where higher is better. Hand-rolled to avoid pulling fuse.js.

const WORD_BOUNDARY = /[\s\-_./:]/;

export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let prevMatch = -2;
  let firstMatch = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    if (firstMatch < 0) firstMatch = ti;
    if (ti === prevMatch + 1) score += 10; // consecutive bonus
    else score += 1;
    if (ti === 0 || WORD_BOUNDARY.test(t[ti - 1])) score += 15; // word-start bonus
    prevMatch = ti;
    qi++;
  }
  if (qi < q.length) return null;
  // Reward early matches, slight penalty for long targets.
  return score - firstMatch * 0.5 - t.length * 0.01;
}
