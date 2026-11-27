// 1.175.0 (B3; review SEC-8): what GitHub hides in an issue's text, and who
// wrote the issue. The mirror, for the card page and the Board, of
// `issue_text.rs` (which decides what the Builder gets and whose marks
// count); both are held to `issueText.fixtures.json`.
//
// An HTML comment (`<!-- … -->`) in an issue is not shown to the people who
// read it on GitHub, but it is in the card's brief. The card page lists each
// such part under the brief, for every card of an issue, whoever wrote it:
// what the Builder receives is never invisible to who presses Start build.

/** A part of the text GitHub doesn't show: the 1-based line it opens on,
 *  and what is between `<!--` and `-->`. */
export interface HiddenPart {
  line: number;
  text: string;
}

const OPEN = "<!--";
const CLOSE = "-->";

/** `text` with every line break there is written as `\n`: `\r\n`, a lone
 *  `\r`, vertical tab, form feed, the file, group and record separators,
 *  NEL, U+2028 and U+2029. Mirrors `issue_text.rs::plain_lines`: a part's
 *  line is counted the same way in the box and in what the Builder gets. */
export function plainLines(text: string): string {
  return text.replace(/\r\n?|[\u000B\u000C\u001C\u001D\u001E\u0085\u2028\u2029]/g, "\n");
}

function lineBreaks(text: string): number {
  let n = 0;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** The parts of `text` inside HTML comments, in order. **Every `<!--` opens
 *  one** — also inside a code fence or a code span, where GitHub shows it
 *  (round 2 of B3: telling those apart let text GitHub hides through
 *  unmarked) — and it ends at the next `-->` on any later line; one never
 *  closed runs to the end (GitHub hides all of it). A comment with nothing
 *  in it hides nothing and is left out. */
export function hiddenParts(text: string | null | undefined): HiddenPart[] {
  const out: HiddenPart[] = [];
  if (!text || !text.includes(OPEN)) return out;
  const plain = plainLines(text);
  let at = 0;
  let line = 1;
  for (;;) {
    const open = plain.indexOf(OPEN, at);
    if (open < 0) break;
    line += lineBreaks(plain.slice(at, open));
    const start = open + OPEN.length;
    const close = plain.indexOf(CLOSE, start);
    const inner = close < 0 ? plain.slice(start) : plain.slice(start, close);
    const trimmed = inner.trim();
    if (trimmed) out.push({ line, text: trimmed });
    line += lineBreaks(inner);
    if (close < 0) break;
    at = close + CLOSE.length;
  }
  return out;
}

/** The box's heading under the brief: "Hidden on GitHub, shown here · 1
 *  part, line 3", "… · 3 parts". */
export function hiddenPartsHeading(parts: readonly HiddenPart[]): string {
  return parts.length === 1
    ? `Hidden on GitHub, shown here · 1 part, line ${parts[0].line}`
    : `Hidden on GitHub, shown here · ${parts.length} parts`;
}

/** Each part's own label when there are several: "Line 3". */
export function hiddenPartLabel(part: HiddenPart): string {
  return `Line ${part.line}`;
}

/** Under the box. */
export function hiddenPartsNote(count: number): string {
  return count === 1
    ? "GitHub doesn't show this part to people reading the issue. The Builder gets it marked as hidden text."
    : "GitHub doesn't show these parts to people reading the issue. The Builder gets them marked as hidden text.";
}

// ── Who wrote the issue ─────────────────────────────────────────────────

/** Whether an author with `association` (GitHub's word: OWNER, MEMBER,
 *  COLLABORATOR, CONTRIBUTOR, NONE, …) is outside the repository. `null`
 *  when GitHub didn't say: nothing is stated then. Mirrors
 *  `issue_text.rs::outside`. */
export function outsideRepository(association: string | null | undefined): boolean | null {
  const a = association?.trim().toUpperCase();
  if (!a) return null;
  return !["OWNER", "MEMBER", "COLLABORATOR"].includes(a);
}

type IssueCard = {
  ghIssueNumber?: number | null;
  ghAuthor?: string | null;
  ghAuthorAssociation?: string | null;
};

/** The login of the issue's author when they are outside the repository;
 *  null for a collaborator, an unknown association, a card with no issue or
 *  an author GitHub no longer names. */
export function outsideAuthor(card: IssueCard): string | null {
  const login = card.ghAuthor?.trim();
  if (!card.ghIssueNumber || !login) return null;
  return outsideRepository(card.ghAuthorAssociation) === true ? login : null;
}

/** The Board card's quiet line: "From outside the repository · {login}". */
export function outsideLine(login: string): string {
  return `From outside the repository · ${login}`;
}

/** Now's sentence under "The brief is written and nothing has started." */
export function outsideSentence(login: string, repo: string | null | undefined): string {
  const where = repo?.trim() ? ` on ${repo.trim()}` : "";
  return `From outside the repository: ${login} wrote this issue and isn't a collaborator${where}. Read the brief before you start; the Builder gets it as the issue's text, not as instructions.`;
}

/** Beside the brief's heading: "Issue #173 by drive-by-dev" (the number
 *  alone when GitHub names no author). Null for a card with no issue. */
export function issueByline(card: IssueCard): string | null {
  if (!card.ghIssueNumber) return null;
  const login = card.ghAuthor?.trim();
  return login ? `Issue #${card.ghIssueNumber} by ${login}` : `Issue #${card.ghIssueNumber}`;
}

/** Technical details › Created by: "{login} · not a collaborator" for an
 *  author outside the repository; the login alone otherwise. */
export function createdByValue(login: string, association: string | null | undefined): string {
  return outsideRepository(association) === true ? `${login} · not a collaborator` : login;
}
