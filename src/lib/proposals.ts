/**
 * UX language card 8 (GH #104, ADR 0005; BOARDS.md §4 "Improvement proposal,
 * state C"): what the Challenger's one suggested change **says**, on each of
 * the three surfaces that show it.
 *
 * Pure, so the three are tested without a window: the block on the target's
 * Library page, the Inbox item and the line in the card's Ship step come out of
 * one `ProposalView` and one set of functions here, and none of them decides
 * anything for itself. A surface that worded the same fact differently from
 * another is how "the Inbox says one thing and the page says another" happens.
 */

import type { CompareMark } from "./librarySkills.ts";
import { parseUnifiedDiff, type DiffFile } from "./unifiedDiff.ts";
import { SUGGESTED_SKILL_CHANGE } from "./words.ts";

/** What `improvement_proposal_state` answers (`proposals::ProposalView`). */
export interface ProposalView {
  target:
    | { kind: "skill"; name: string; path: string }
    | { kind: "instructions"; file: string }
    | { kind: "elsewhere"; name: string; scope: "this-mac" | "team" | "ply" };
  /** `deploy`, `AGENTS.md` — the word every surface uses for it. */
  label: string;
  /**
   * The Library scope whose page carries the block (`uxScope::Scope`).
   *
   * GH #104 review 1 (MINOR): matching by name alone drew a proposal about the
   * **personal** `deploy` on the **repository** `deploy`'s page — over a file it
   * was not about, with an `Approve` that would have published the wrong one.
   */
  scope: "repository" | "this-mac" | "team" | "ply";
  /** Repository-relative, for the diff's header. */
  path: string;
  cardId: string;
  /** `#88`, or the card's title in quotes. */
  cardRef: string;
  reason: string;
  words: string;
  /** `null` for a personal, Team or Ply target: words only, never a diff. */
  diff: string | null;
  createdAt: number;
  /** A read-only collaborator, or a words-only proposal: no `Approve`. */
  canApprove: boolean;
  /**
   * SP-5: the branch an approval commits to on this Mac — a workspace with no
   * shared definition whose repository has no remote. `null` or absent: the
   * change is published (`Approve and publish`).
   */
  commitTo?: string | null;
  /**
   * SP-5 review: why `Approve and commit to <branch>` can't work here (the
   * branch's copy is not the one the Challenger read). `canApprove` is then
   * false, and the block says this where the button would be.
   */
  approveBlocked?: string | null;
  /**
   * SP-5 walk: what Approve does to the skill's other CLI's copy — "Codex's
   * copy (…) is the same file, so it changes too." or "Only Claude's copy …
   * changes." — said before the press. `null` when there is one copy.
   */
  copiesNote?: string | null;
  /**
   * GH #104 walk (C2): where the lesson comes from, as the Challenger named it
   * (`the human's correction: "…"`, `review round 2`). `null` or absent when
   * the answer named none — the block then says no source.
   */
  source?: string | null;
}

/** The eyebrow chip, verbatim from the board. */
export const PROPOSAL_CHIP = SUGGESTED_SKILL_CHANGE;
/** Under the actions, verbatim from the board. */
export const PROPOSAL_FOOTNOTE = "Publishing reaches everyone who opens this repository.";
/** The board's two actions. */
export const PROPOSAL_APPROVE = "Approve and publish";
export const PROPOSAL_DISMISS = "Dismiss";

/**
 * SP-5: what `Approve` says. A repository with no remote has nobody to publish
 * to, so the button says what it does there: a commit on its branch.
 */
export function proposalApproveLabel(view: Pick<ProposalView, "commitTo">): string {
  return view.commitTo ? `Approve and commit to ${view.commitTo}` : PROPOSAL_APPROVE;
}

/** SP-5: the line under the actions, true for where the change goes. */
export function proposalFootnote(view: Pick<ProposalView, "commitTo">): string {
  return view.commitTo
    ? `A commit on ${view.commitTo} in this repository. It isn't connected to GitHub, so nothing is pushed.`
    : PROPOSAL_FOOTNOTE;
}

/** SP-5: what an approval of a workspace with no shared definition did, in the
 *  toast's words (`proposals::Approved`). */
export interface ProposalApproved {
  title: string;
  body: string;
}
/**
 * What a words-only proposal says instead of the diff (BOARDS.md §4: "when the
 * trouble sits in a personal, Team or Ply skill it says so in words and
 * suggests bringing a copy into the repository").
 *
 * GH #271: a sentence that asks for an action comes with that action, or does
 * not ask (PATTERNS.md §3). Only a skill of your own, on this Mac, can be
 * brought into the repository — its Promote does that, and the block offers it
 * ({@link PROPOSAL_PROMOTE}). A Team or Ply skill has no such way, so its
 * sentence says where the change belongs instead of asking for one.
 */
export function proposalNoDiff(view: ProposalView): string {
  switch (view.scope) {
    case "this-mac":
      return "This skill is yours alone, on this Mac, so Plyloft does not change it. Promote it into this repository and the change can travel with it.";
    case "team":
      return "This skill lives in the team library, so the change is made there, not in this repository.";
    case "ply":
      return "This skill comes with Plyloft and changes only when Plyloft is updated, so there is nothing to change in this repository.";
    case "repository":
      return "Plyloft could not read this change as a diff of the file, so there is nothing to publish.";
  }
}
/** The action a personal skill's words-only proposal asks for. */
export const PROPOSAL_PROMOTE = "Promote…";

/**
 * GH #271: the line that names what a proposal is about, on the Skills list
 * where the block is not on its target's own page: `verify-before-done` · `Comes
 * with Ply`. The name opens the target's page; `scopeWords` is the section the
 * skill is listed under, so the member finds it where the list puts it.
 */
export function proposalTarget(
  view: ProposalView,
  scopeWords: Record<ProposalView["scope"], string>,
): { name: string; scope: string; key: string } {
  return { name: view.label, scope: scopeWords[view.scope], key: `${view.scope}:${view.label}` };
}

/**
 * `from the Challenger · 2 hours ago` — the board's byline.
 *
 * The clock is coarse on purpose: the board says "2 hours ago", and a proposal
 * is dropped at 30 days, so nothing beyond days has to be said.
 *
 * GH #104 walk 2: a lesson the Challenger drew from the human's own correction
 * is the human's, and the byline says so — `from your correction · 2 hours
 * ago`, the same words as the source line below it. Any other source (a review
 * round, a Verify failure, none named) keeps the Challenger's byline.
 */
export function proposalByline(createdAt: number, nowMs: number, source?: string | null): string {
  const from = isCorrectionSource(source) ? "from your correction" : "from the Reviewer";
  return `${from} · ${relativeWhen(createdAt, nowMs)}`;
}

/** `the human's correction: "…"` (as the Challenger's SOURCE names one). */
const CORRECTION_SOURCE = /^(?:the\s+)?human['’]?s?\s+correction(?:\s+(?:no\.?\s*)?\d+)?\s*:?\s*(.*)$/i;

function isCorrectionSource(source: string | null | undefined): boolean {
  const raw = source?.trim();
  return Boolean(raw && CORRECTION_SOURCE.test(raw));
}

/** `just now` · `4 minutes ago` · `2 hours ago` · `3 days ago`. */
export function relativeWhen(at: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  return plural(Math.floor(hours / 24), "day");
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/**
 * One line of the proposal's diff, as the block draws it.
 *
 * The marks are #100's `CompareMark` glyphs, because a member who has read one
 * comparison has learnt them — but their **words** are the diff's, not the
 * comparison's: `+` here is "added", not "only here". The same glyph answering
 * two different questions needs two labels, or a screen reader is told
 * something untrue (GH #100 review 1 found the mirror of this).
 */
export interface ProposalDiffLine {
  /** 1-based in the changed file, or null for a removed line and a header. */
  no: number | null;
  mark: CompareMark;
  text: string;
  /** A hunk header (`@@ … @@`): drawn as a quiet separator, never as content. */
  hunk: boolean;
}

export const DIFF_MARK_LABEL: Record<Exclude<CompareMark, "">, string> = {
  "+": "added",
  "−": "removed",
  "≠": "changed",
};

export interface ProposalDiff {
  /** The file, in mono, on the diff group's header. */
  path: string;
  /** `4 lines added` · `4 lines added, 1 removed` (BOARDS.md §4). */
  count: string;
  lines: ProposalDiffLine[];
}

/**
 * The diff the block draws, or `null` when there is none to draw — a words-only
 * proposal, or a diff Ply could not read as one. Never a half-rendered patch:
 * `parseUnifiedDiff` is not a patch applier, so a malformed hunk would
 * otherwise be shown as plain lines and read as content.
 */
export function proposalDiff(view: ProposalView): ProposalDiff | null {
  if (!view.diff) return null;
  const files: DiffFile[] = parseUnifiedDiff(view.diff);
  const file = files[0];
  if (!file || file.lines.length === 0) return null;
  const lines: ProposalDiffLine[] = [];
  // The numbers are the changed file's, read off each hunk header, so a reader
  // can find the place in the file rather than in the patch.
  let no = 0;
  for (const line of file.lines) {
    if (line.kind === "hunk") {
      const start = newStartOf(line.text);
      if (start != null) no = start - 1;
      lines.push({ no: null, mark: "", text: line.text, hunk: true });
      continue;
    }
    if (line.kind === "meta") continue;
    if (line.kind === "del") {
      lines.push({ no: null, mark: "−", text: line.text.slice(1), hunk: false });
      continue;
    }
    // Both an added and a context line carry their marker in column 0, so one
    // slice serves both; the mark column says which it was.
    no += 1;
    lines.push({
      no,
      mark: line.kind === "add" ? "+" : "",
      text: line.text.slice(1),
      hunk: false,
    });
  }
  // A patch ends with a newline, so splitting it leaves one empty trailing
  // "context" line that is not in the file at all. Drawn, it is a numbered
  // blank row at the bottom of every diff.
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last.hunk || last.mark !== "" || last.text !== "") break;
    lines.pop();
  }
  if (lines.length === 0) return null;
  return { path: view.path, count: changeCount(file), lines };
}

/** `@@ -1,2 +7,4 @@` → 7. */
function newStartOf(header: string): number | null {
  const match = /@@[^+]*\+(\d+)/.exec(header);
  if (!match) return null;
  const start = Number(match[1]);
  return Number.isFinite(start) ? start : null;
}

function changeCount(file: DiffFile): string {
  const added = `${file.added} ${file.added === 1 ? "line" : "lines"} added`;
  if (file.removed === 0) return added;
  return `${added}, ${file.removed} removed`;
}

// GH #104 review 1 (NIT): the Inbox row's words are composed in Rust
// (`inbox::derive_proposal_events`), because the feed is a backend-derived view.
// A second copy here was dead code that could drift from the row people read, so
// it is gone; `src-tauri/src/inbox.rs`'s own test asserts the two strings.

/**
 * The line in the card's Ship step, verbatim from the board:
 * `A suggested skill change is waiting — deploy · Review` (G2: the old
 * improvement proposal is a "Suggested skill change" wherever it shows).
 *
 * `action` is the word on the control beside it; the line itself never carries
 * the only copy of what to do (PATTERNS.md §4).
 */
export function proposalShipLine(view: ProposalView): { line: string; action: string } {
  return {
    line:
      view.target.kind === "instructions"
        ? `A suggested change to ${view.label} is waiting`
        : `A suggested skill change is waiting — ${view.label}`,
    action: "See the change",
  };
}

/**
 * GH #104 walk (C2): the block's source line — `From your correction: “…”`,
 * `From review round 2`, `From the failed checks` — out of the Challenger's
 * `SOURCE:` line. `null` when it named none, and the block says nothing.
 */
export function proposalSourceLine(view: Pick<ProposalView, "source">): string | null {
  const raw = view.source?.trim();
  if (!raw) return null;
  const correction = CORRECTION_SOURCE.exec(raw);
  if (correction) {
    const quote = unquote(correction[1]);
    return quote ? `From your correction: “${quote}”` : "From your correction";
  }
  const round = /review\s+round\s+(\d+)/i.exec(raw);
  if (round) return `From review round ${round[1]}`;
  if (/verify/i.test(raw)) return "From the failed checks";
  return `From ${raw}`;
}

function unquote(text: string): string {
  return text.trim().replace(/^["'“‘«]+/, "").replace(/["'”’»]+$/, "").trim();
}

/**
 * Which Library page the three surfaces open: the target's own.
 *
 * A skill — in this repository or not — opens the Skills page with that skill's
 * sub-page showing; an instruction file opens Instructions. The key is
 * `<scope>:<name>`, which is what `libraryStore.openSkill` takes, and the scope
 * is the one the row lives under. `null` when no row of that name is loaded yet,
 * and then the list is where the member lands, with the proposal's block on it.
 */
export function proposalPage(view: ProposalView): "skills" | "instructions" {
  return view.target.kind === "instructions" ? "instructions" : "skills";
}

/** Does this proposal belong on the page being drawn? */
export function proposalIsFor(
  view: ProposalView | null,
  where:
    | { page: "skill"; name: string; scope: ProposalView["scope"] }
    | { page: "instructions"; file: string }
    | { page: "skills-list"; scope?: ProposalView["scope"] | "all" | "my-library" },
): boolean {
  if (!view) return false;
  switch (where.page) {
    case "skill":
      // `<scope>:<name>`, which is the Library's own row key: the same name at
      // two scopes is two skills, and only one of them is what this is about.
      return (
        view.target.kind !== "instructions" &&
        view.label === where.name &&
        view.scope === where.scope
      );
    case "instructions":
      return view.target.kind === "instructions" && view.label === where.file;
    case "skills-list":
      // The list carries it only while no skill of that name is open to carry
      // it: the block belongs to the target, and two copies of one block on one
      // scroll would read as two proposals. GH #271: and only under a scope
      // filter that lists its target — `Repository` never carries a proposal
      // about a skill that comes with Ply.
      return (
        view.target.kind !== "instructions" &&
        (where.scope == null || where.scope === "all" || where.scope === view.scope)
      );
  }
}

// ── The friction rule's one frontend half ────────────────────────────

/**
 * What the human has typed into the Builder session, and what the last screen
 * scan saw. Local to one attach; nothing is persisted.
 */
export interface TypingState {
  /** Raw bytes typed since the last submission. */
  typed: string;
  /** The session has been seen back at an idle prompt at least once, so it has
   *  answered. */
  answered: boolean;
  /** The **last** scan found the turn over with no question in view
   *  (`attention.ts::turnIdleMatcherFor`). False while a turn runs and while a
   *  permission question is on screen. */
  atPrompt: boolean;
  /** GH #104 walk: inside a bracketed paste (`ESC[200~` … `ESC[201~`), whose
   *  line breaks are part of one submission, not several. */
  inPaste?: boolean;
}

/** The plain text of a submission: backspaces applied, escape sequences and
 *  other control bytes dropped, trimmed. */
export function correctionPayload(raw: string): string {
  // Escape sequences first, so a bracketed paste's markers and an arrow key do
  // not survive as content.
  const withoutEscapes = raw.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b./g, "");
  let out = "";
  for (const ch of withoutEscapes) {
    if (ch === "\u007f" || ch === "\b") {
      out = out.slice(0, -1);
      continue;
    }
    // Every other C0 control byte is a key, not a character — except a pasted
    // line break, which `observeBuilderTyping` keeps inside one submission.
    if (ch < " " && ch !== "\t" && ch !== "\n") continue;
    out += ch;
  }
  return out.trim();
}

/** Bare answers to a question the scan may have missed by a beat. */
const PROMPT_ANSWER = /^(y|n|yes|no|\d{1,2})$/i;

/**
 * GH #104: whether a completed submission counts as **one correction after the
 * Builder's first answer** — the third condition of `proposals::met_friction`.
 *
 * Review 1 (MAJOR) narrowed this. The first version counted any Enter once the
 * session had been idle once, so a permission answer, a bare Return, a
 * `/compact` and an interruption all read as "the human had to correct the
 * Builder" — and one of them is enough to make a card meet friction. What counts
 * now, and only this:
 *
 * - the session has **answered** at least once (`answered`), so the vendor's own
 *   start-up questions are not corrections;
 * - the session is at its prompt **right now** (`atPrompt`), so an answer to a
 *   question on screen and an interruption of a running turn are not;
 * - the submission carries **non-whitespace text**, so a bare Return is not;
 * - it is not a **slash command** (`/compact`, `/clear`, `/model`): those steer
 *   the tool, not the work;
 * - it is not a bare **y / n / yes / no / number**, which is an answer to a
 *   question even when the last scan had not caught up with it.
 *
 * Everything left is a human typing a sentence at an idle Builder, which is the
 * thing the card means.
 */
export function countsAsCorrection(input: {
  payload: string;
  answered: boolean;
  atPrompt: boolean;
}): boolean {
  if (!input.answered || !input.atPrompt) return false;
  const text = correctionPayload(input.payload);
  if (text === "") return false;
  if (text.startsWith("/")) return false;
  if (PROMPT_ANSWER.test(text)) return false;
  return true;
}

/**
 * Fold one chunk of `term.onData` into the typing state, and say whether it
 * completed a submission that counts.
 *
 * This is the only place the human's keystrokes exist: the Builder is the
 * vendor's own TUI in a PTY and Ply keeps no transcript of it. Ply's own
 * injections (`verdictDelivery`, `handedOverDelivery`, the self-check) reach
 * `ptyWrite` directly and never pass through here.
 */
export function observeBuilderTyping(
  state: TypingState,
  data: string,
): { state: TypingState; correction: boolean; texts: string[] } {
  let typed = state.typed;
  let inPaste = state.inPaste ?? false;
  // GH #104 walk (B3): the words of **every** submission that counted, in
  // order, so the card keeps the human's side and not only a count.
  const texts: string[] = [];
  let rest = data;
  for (;;) {
    // GH #104 walk: a bracketed paste is one submission whatever lines it
    // carries — its markers go, its line breaks stay inside it.
    const at = rest.search(inPaste ? /\u001b\[201~/ : /\u001b\[200~|[\r\n]/);
    if (at === -1) {
      typed += inPaste ? pastedLines(rest) : rest;
      break;
    }
    if (inPaste) {
      typed += pastedLines(rest.slice(0, at));
      inPaste = false;
      rest = rest.slice(at + PASTE_END.length);
      continue;
    }
    if (rest.startsWith(PASTE_START, at)) {
      typed += rest.slice(0, at);
      inPaste = true;
      rest = rest.slice(at + PASTE_START.length);
      continue;
    }
    const payload = typed + rest.slice(0, at);
    if (countsAsCorrection({ payload, answered: state.answered, atPrompt: state.atPrompt })) {
      texts.push(correctionPayload(payload));
    }
    typed = "";
    rest = rest.slice(at + 1);
  }
  // A long paste cannot grow without bound: only its tail can still be a
  // submission's payload.
  const TYPED_MAX = 4096;
  if (typed.length > TYPED_MAX) typed = typed.slice(-TYPED_MAX);
  return { state: { ...state, typed, inPaste }, correction: texts.length > 0, texts };
}

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/** A paste's line breaks, as one `\n` each. */
function pastedLines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
