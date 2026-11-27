/**
 * SL-5 (ship loop): line comments on a card's review diff — the selection
 * model, its mapping to line ranges, and the one message **Send to Builder**
 * pastes into the card's Builder session. Pure (no Tauri, no React), so it
 * is unit-tested under node (`lineComments.test.ts`).
 *
 * Line numbers: an added or context line is named by its number in the
 * card's version of the file (the new side of the diff) — what the Builder
 * sees in its worktree. A removed line exists only in the base version, so
 * it is named by its number there, and said to be. A selection may cross
 * hunks within one file; the unchanged lines between two hunks are not in
 * the diff, so the quote marks the jump with `…` and the ranges cover the
 * selected lines' numbers from first to last.
 */

/** The fields of a diff hunk this needs (`ipc.ts`'s `DiffHunk`). */
export interface HunkLike {
  newStart: number;
  oldStart: number;
  body: string;
}

export type RowKind = "add" | "del" | "ctx" | "meta";

/** One line of a file's diff as drawn, with its numbers. */
export interface DiffRow {
  /** Position in the file's diff, across hunks: what a selection spans. */
  order: number;
  hunk: number;
  kind: RowKind;
  /** The line as shown, with its `+`, `-` or space prefix. */
  text: string;
  /** Number in the base version (context and removed lines). */
  oldLine: number | null;
  /** Number in the card's version (context and added lines). */
  newLine: number | null;
}

/** Lines of a hunk's body, without the empty one after its last newline. */
function bodyLines(body: string): string[] {
  const lines = body.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Every line of a file's hunks, numbered. `\ No newline at end of file`
 *  is `meta`: shown, never selected, never counted. */
export function diffRows(hunks: HunkLike[]): DiffRow[] {
  const rows: DiffRow[] = [];
  hunks.forEach((h, hunk) => {
    let oldLine = h.oldStart;
    let newLine = h.newStart;
    for (const text of bodyLines(h.body)) {
      const order = rows.length;
      if (text.startsWith("+")) {
        rows.push({ order, hunk, kind: "add", text, oldLine: null, newLine });
        newLine += 1;
      } else if (text.startsWith("-")) {
        rows.push({ order, hunk, kind: "del", text, oldLine, newLine: null });
        oldLine += 1;
      } else if (text.startsWith("\\")) {
        rows.push({ order, hunk, kind: "meta", text, oldLine: null, newLine: null });
      } else {
        rows.push({ order, hunk, kind: "ctx", text, oldLine, newLine });
        oldLine += 1;
        newLine += 1;
      }
    }
  });
  return rows;
}

export function isSelectable(row: DiffRow): boolean {
  return row.kind !== "meta";
}

/**
 * v1.154.1 (walk F21): a selectable line's accessible name — its file, its
 * side, its number and its text — so a screen reader, the keyboard and the
 * app tester reach the same line a click does. An unchanged line whose
 * numbers differ names both.
 */
export function rowLabel(path: string, row: DiffRow): string {
  const text = row.text.slice(1).trim() || "(empty line)";
  const where =
    row.kind === "add"
      ? `added line ${row.newLine}`
      : row.kind === "del"
        ? `removed line ${row.oldLine} of the base version`
        : row.oldLine === row.newLine
          ? `unchanged line ${row.newLine}`
          : `unchanged line ${row.newLine} (line ${row.oldLine} of the base version)`;
  return `${path}, ${where}: ${text}`;
}

/** The next selectable row after (`step` 1) or before (`step` -1) `order`,
 *  or `order` itself at either end. `step` Infinity / -Infinity: the last
 *  / first selectable row. */
export function stepSelectable(rows: DiffRow[], order: number, step: number): number {
  const pickable = rows.filter(isSelectable).map((r) => r.order);
  if (pickable.length === 0) return order;
  if (step === Infinity) return pickable[pickable.length - 1];
  if (step === -Infinity) return pickable[0];
  if (step > 0) return pickable.find((o) => o > order) ?? order;
  const before = pickable.filter((o) => o < order);
  return before.length ? before[before.length - 1] : order;
}

/** Quoted lines kept at most; a longer selection is cut, and says so. */
export const QUOTE_MAX_LINES = 80;
/** Characters of the quote kept at most (the backend refuses > 20 000). */
export const QUOTE_MAX_CHARS = 12_000;
/** The longest message Send to Builder pastes; more is refused, with words. */
export const MESSAGE_MAX_CHARS = 100_000;
/** The line that marks a jump from one hunk to the next in a quote. */
export const HUNK_GAP = "…";

export interface SelectionRange {
  newStart: number | null;
  newEnd: number | null;
  oldStart: number | null;
  oldEnd: number | null;
  quoted: string;
}

/** The ranges and quote of the rows from `anchor` to `focus` (either
 *  order, inclusive). Null when nothing selectable is between them. */
export function selectionRange(rows: DiffRow[], anchor: number, focus: number): SelectionRange | null {
  const lo = Math.min(anchor, focus);
  const hi = Math.max(anchor, focus);
  const picked = rows.filter((r) => r.order >= lo && r.order <= hi && isSelectable(r));
  if (picked.length === 0) return null;
  const news = picked.filter((r) => r.kind !== "del").map((r) => r.newLine as number);
  const olds = picked.filter((r) => r.kind === "del").map((r) => r.oldLine as number);
  const quoteLines: string[] = [];
  let lastHunk = picked[0].hunk;
  for (const r of picked) {
    if (r.hunk !== lastHunk) quoteLines.push(HUNK_GAP);
    lastHunk = r.hunk;
    quoteLines.push(r.text);
  }
  return {
    newStart: news.length ? Math.min(...news) : null,
    newEnd: news.length ? Math.max(...news) : null,
    oldStart: olds.length ? Math.min(...olds) : null,
    oldEnd: olds.length ? Math.max(...olds) : null,
    quoted: cutQuote(quoteLines),
  };
}

function cutQuote(lines: string[]): string {
  let kept = lines;
  let cut = 0;
  if (kept.length > QUOTE_MAX_LINES) {
    cut = kept.length - QUOTE_MAX_LINES;
    kept = kept.slice(0, QUOTE_MAX_LINES);
  }
  let text = kept.join("\n");
  if (text.length > QUOTE_MAX_CHARS) {
    // By code points, so a cut never leaves half a surrogate pair.
    text = Array.from(text).slice(0, QUOTE_MAX_CHARS).join("");
    cut = Math.max(cut, 1);
  }
  return cut > 0 ? `${text}\n${HUNK_GAP} (the selection goes on; cut here)` : text;
}

/** The ranges a comment names, in words. */
export interface RangeLike {
  newStart?: number | null;
  newEnd?: number | null;
  oldStart?: number | null;
  oldEnd?: number | null;
}

function span(a: number, b: number): string {
  return a === b ? `line ${a}` : `lines ${a}–${b}`;
}

export function rangeLabel(r: RangeLike): string {
  const hasNew = r.newStart != null && r.newEnd != null;
  const hasOld = r.oldStart != null && r.oldEnd != null;
  const removed = hasOld ? `removed ${span(r.oldStart as number, r.oldEnd as number)}` : "";
  if (hasNew && hasOld) {
    return `${span(r.newStart as number, r.newEnd as number)}, and ${removed} of the base version`;
  }
  if (hasNew) return span(r.newStart as number, r.newEnd as number);
  if (hasOld) return `${removed} of the base version`;
  return "no lines";
}

/** What a comment on the card needs to be sent. */
export interface SendableComment extends RangeLike {
  id: string;
  path: string;
  quoted: string;
  body: string;
  sentAt?: number | null;
}

/** Terminal control characters (all but tab and newline) are dropped:
 *  the message goes into a bracketed paste, and an escape sequence in a
 *  quoted line could end that paste early or drive the terminal. */
export function sanitizeForPaste(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g, "");
}

function fenceFor(quoted: string): string {
  let fence = "```";
  while (quoted.includes(fence)) fence += "`";
  return fence;
}

/** The comments not sent yet, in the order they were written. */
export function unsentComments<T extends { sentAt?: number | null }>(list: T[] | undefined): T[] {
  return (list ?? []).filter((c) => c.sentAt == null);
}

/**
 * The one message Send to Builder pastes: every comment, each with its file,
 * its lines, the quoted lines and the comment.
 */
export function composeLineCommentsMessage(comments: SendableComment[]): string {
  const n = comments.length;
  const parts: string[] = [
    `[Plyloft] Review comments on this card's changes (${n}). Please address ${n === 1 ? "it" : "each one"} in this worktree. ` +
      "Line numbers are from the card's last committed version of each file; removed lines are numbered in the base version. " +
      "If the code has moved since, find the place by the quoted lines.",
  ];
  comments.forEach((c, i) => {
    const quoted = sanitizeForPaste(c.quoted).replace(/\n+$/, "");
    const lines = [`${i + 1}. ${sanitizeForPaste(c.path)}, ${rangeLabel(c)}`];
    if (quoted) {
      const fence = fenceFor(quoted);
      lines.push(`${fence}diff`, quoted, fence);
    }
    lines.push(`Comment: ${sanitizeForPaste(c.body).trim()}`);
    parts.push(lines.join("\n"));
  });
  return parts.join("\n\n");
}
