/**
 * v1.43.0 (Sidebar identity): derive a one-letter monogram (GH #288) from a
 * workspace name for the default chip rendering.
 *
 * Strategy:
 *   - Split the name on whitespace / `-` / `_` / `.`.
 *   - For each segment, find the first grapheme that is a letter or
 *     digit (skip leading emoji/symbol graphemes so `"🎨 design"`
 *     resolves to `"D"`, not half an emoji).
 *   - Take the first such grapheme, uppercased.
 *   - Pathological cases (empty, all-emoji, all-symbol) fall back to
 *     `"·"` so the chip never shows blank.
 *
 * Why `Array.from(s)` and `Intl.Segmenter` instead of `s[0]`:
 *   - `s[0]` on a surrogate-pair grapheme (most emoji, many CJK) returns
 *     half the codepoint and renders as a replacement glyph or a tofu.
 *   - `Array.from(s)` splits on codepoint boundaries — good enough for
 *     letter/digit detection in workspace names. ZWJ-joined emoji
 *     sequences are rare in workspace names and would be skipped anyway.
 *
 * Pure function. Trivially unit-testable in Node.
 */

const SEGMENT_DELIM = /[\s\-_.]+/;

/** Return the one-letter monogram for `name`. Never returns empty.
 *  GH #288: one letter, as the Shell board and the WorkspaceSwitcher spec
 *  draw it — two letters on the 20 px chip fell to 8 px. */
export function workspaceMonogram(name: string): string {
  const first = name
    .split(SEGMENT_DELIM)
    .map((s) => firstLetterOrDigit(s))
    .find((s): s is string => s !== null);
  return first ? first.toUpperCase() : "·";
}

/** First letter-or-digit grapheme in `segment`, or `null` if none. */
function firstLetterOrDigit(segment: string): string | null {
  for (const ch of Array.from(segment)) {
    if (isLetterOrDigit(ch)) return ch;
  }
  return null;
}

function isLetterOrDigit(ch: string): boolean {
  // Unicode property escapes — supported in Safari 12+, which is well
  // below the macOS WKWebView floor Ply ships on.
  return /[\p{L}\p{N}]/u.test(ch);
}
