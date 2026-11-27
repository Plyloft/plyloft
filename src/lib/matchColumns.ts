// QoL 3.4 (E9): where an In files match sits in its line, in the editor's
// units. ripgrep reports a match's start and end as **byte** offsets into the
// line's UTF-8; CodeMirror counts UTF-16 code units. They agree only on an
// ASCII line, so an accented word or an emoji before the match moved the
// selection off it.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The match's `from`/`to` in UTF-16 units of `lineText`, from ripgrep's
 *  byte offsets; clamped to the line, and `from <= to`. */
export function utf16Columns(
  lineText: string,
  byteStart: number,
  byteEnd: number,
): { from: number; to: number } {
  const bytes = encoder.encode(lineText);
  const clamp = (n: number) => Math.max(0, Math.min(bytes.length, Math.floor(Number.isFinite(n) ? n : 0)));
  const start = clamp(byteStart);
  const end = Math.max(start, clamp(byteEnd));
  const from = decoder.decode(bytes.subarray(0, start)).length;
  const to = from + decoder.decode(bytes.subarray(start, end)).length;
  return { from, to };
}
