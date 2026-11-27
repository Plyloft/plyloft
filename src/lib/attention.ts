// "wants you" attention layer — Phase 1 detection core.
//
// Pure, ephemeral derivation: the tri-state for a tile is a function of
// (lastOutputAt, now, promptBoxIdle) and is recomputed by each consumer on a
// ~1s tick. Nothing here is stored or persisted. No React import — keep it
// unit-testable in isolation. See architect-plan.md.

import type { Tile } from "../store/tileStore";
import type { KanbanCard } from "../ipc";
import { closedBuilderAborted } from "./cardLifecycle.ts";
import { basename } from "./paths.ts";
import { isWindows } from "./platform.ts";
import { targetName } from "./worktreeBase.ts";

export type TileAttention = "working" | "wants-you" | "asking-you";

/** Single decision threshold. Silent >= this => wants-you. */
export const SILENCE_MS = 10_000;
/** Below this, the working indicator may render an "active" pulse (cosmetic only). */
export const WORKING_PULSE_MS = 3_000;

/**
 * A resize reflows the terminal and the TUI redraws its whole screen
 * (SIGWINCH): output this soon after the last resize is that redraw, not
 * activity. Resizing the window resizes every warmed host, hidden ones too,
 * so without this a session waiting for an hour read "working" for the next
 * ten seconds each time. Terminal's readiness scan rebaselines for the same
 * window (`lib/waitingNotify.ts` relies on it), so the count and the
 * notification agree about a resize.
 */
export const RESIZE_REDRAW_MS = 1_500;

/**
 * Whether PTY output arriving at `now` restarts the silence clock
 * (`lastOutputAt`). Output within `RESIZE_REDRAW_MS` of the last resize does
 * not — except a session's very first output, which always counts (a tile is
 * resized as it opens, and its first output is what says it started). Output
 * after the window counts as before.
 */
export function outputRestartsSilence(
  prev: { lastOutputAt?: number; resizedAt?: number },
  now: number,
): boolean {
  if (prev.lastOutputAt == null) return true;
  return prev.resizedAt == null || now - prev.resizedAt >= RESIZE_REDRAW_MS;
}

export type AttentionTile = Pick<
  Tile,
  | "kind"
  | "status"
  | "startedAt"
  | "lastOutputAt"
  | "promptBoxIdle"
  | "sessionBusy"
  | "sessionIdleSince"
  | "sessionApprovalPending"
> & {
  /** CL-11 (walk): the screen shows the CLI asking for a decision — an
   *  approval (`codexAwaitingDecision`, `claudeAwaitingDecision`). Asking
   *  you at once, whatever its output does: a Codex self-check sat six
   *  minutes on a `git commit` approval while the card said it was
   *  checking its own work. A Builder's runtime sets it. */
  questionInView?: boolean;
  /** Terminals block P3: a tile's session waits on the member (its drawn
   *  screen): asking at once, no 10 s of silence first. */
  question?: string | null;
  questionResetsAt?: string | null;
};

/**
 * Tri-state for an interactive tile. Returns null for any tile the feature
 * must not derive for (shell, agent-run) or a tile that is not alive — the
 * caller falls back to the existing lifecycle glyph.
 *
 * `claude` and `codex` (the Codex CLI TUI in a PTY) are silence-derived:
 * silence alone decides working vs wants-you. `promptBoxIdle` is a
 * refinement that only *upgrades* the label to "asking-you" — never decides
 * the base state, so a mistuned prompt-box matcher is never wrong, only less
 * informative. `now` is injected for testability. When `lastOutputAt` is
 * undefined the tile's `startedAt` stands in (a freshly spawned tile counts
 * as "working" until its first output or the silence window elapses).
 *
 * v1.105.0: `codex-chat` is NOT silence-derived — the App Server tells us
 * when a turn completes (`sessionIdleSince`) and when Codex is blocked on an
 * approval (`sessionApprovalPending`), so those are authoritative and
 * immediate. A session that has never run a turn is "working" (nothing to
 * read yet); between turns it is "asking-you" until the next turn starts.
 */
export function deriveTileAttention(
  tile: AttentionTile,
  now: number,
): TileAttention | null {
  if (tile.status !== "running") return null;
  if (tile.kind === "codex-chat") {
    if (tile.sessionApprovalPending === true) return "asking-you";
    if (tile.sessionBusy === true) return "working";
    return tile.sessionIdleSince != null ? "asking-you" : "working";
  }
  if (tile.kind !== "claude" && tile.kind !== "codex") return null;
  if (tile.questionInView === true || (tile.question != null && tile.question !== undefined)) return "asking-you";
  const last = tile.lastOutputAt ?? tile.startedAt;
  if (now - last < SILENCE_MS) return "working";
  return tile.promptBoxIdle === true ? "asking-you" : "wants-you";
}

// --- prompt-box matcher (the ONE isolated, unit-tested refinement) ----------
// Operates on plain text — xterm's translateToString already strips ANSI.

/** A box border: a corner glyph followed by a rule (pre-2.1 rounded box),
 *  or a flat rule line of its own (Claude Code 2.1.x draws the input area
 *  between two plain `────` lines with no corners). */
const HRULE = /[╭╰┌└][─━]{2,}|(^|\n)[ \t]*[─━]{8,}[ \t]*(\n|$)/;
/** The input line, box-framed or bare: `> ` (pre-2.1) or `❯ ` (2.1.x). The
 *  2.1 line carries a placeholder after the chevron (`❯ Try "fix …"`), so
 *  only the chevron plus one space is required. */
const INPUT = /^[\s│|]*[>❯]\s/m;
/** Claude Code's own idle footer: `? for shortcuts` (pre-2.1) or the 2.1.x
 *  mode line `auto mode on (shift+tab to cycle)`. */
const HINT = /\?\s+for\s+shortcuts|shift\+tab to cycle/i;

/**
 * Refinement matcher — returns true only when the tail of the terminal buffer
 * confidently looks like Claude Code's idle REPL input box. Conservative by
 * design: the border alone shows up in other panels and a bare "> " line can
 * appear in pasted text, so both are required together; the standalone idle
 * hint is accepted on its own. Anything else => false => the label degrades
 * to plain "wants-you" (never a wrong state).
 */
export function matchesClaudePromptBox(tailText: string): boolean {
  if (!tailText) return false;
  return (HRULE.test(tailText) && INPUT.test(tailText)) || HINT.test(tailText);
}

/** Claude Code shows a turn still running: its status line ("esc to
 *  interrupt", in the spinner line or the mode line), messages it holds
 *  for the end of the turn ("Press up to edit queued messages"), a
 *  foreground command's "ctrl+b to run in background". */
export const CLAUDE_RUNNING_WORDS =
  /esc to interrupt|press up to edit queued messages|ctrl\+b to run in background/i;
/** A tool still running (`⎿ Running… (6s · timeout 1m 30s)`). */
const CLAUDE_TOOL_RUNNING = /⎿\s*Running…/;
/** The spinner line: a glyph (never a prompt chevron: `❯ Keep going…` is
 *  an echoed prompt), a capitalised word (or a few) and an ellipsis
 *  (`✻ Processing… (16s · ↓ 129 tokens)`). The finished line
 *  (`✻ Cogitated for 6s · done 2:53 PM`) has no ellipsis. */
export const CLAUDE_SPINNER = /^[\s]*[^\s\w(){}[\]<>❯›"'`|│]\s+[A-Z][\p{L}'’-]*(?: [\p{L}'’-]+){0,3}…(?:\s|$)/u;
/** 1.169.0 (B3 walk, Windows step 8): the spinner line with its elapsed
 *  timer — `· Stewing… (58s · ↓ 324 tokens)`, `✻ Pondering… (1m 26s ·
 *  thinking)` — wherever it is between the last finished turn and the box
 *  (Claude 2.1.309 draws a tip under it, so it is not always the last row
 *  above the box). The finished line has no ellipsis. */
const CLAUDE_SPINNER_TIMER = /^[\s]*[^\s\w(){}[\]<>❯›"'`|│]\s+[A-Z][\p{L}'’-]*(?: [\p{L}'’-]+){0,3}…\s*\((?:\d+h\s*)?(?:\d+m\s*)?\d+s\b/u;
/** A turn that ended: `✻ Worked for 55s · done 2:55 PM`. */
export const CLAUDE_TURN_DONE = /\bfor \d[^\n]*·\s*done\b/i;
/** Claude's input line (its chevron), where the box starts. */
export const CLAUDE_INPUT_LINE = /^[\s│|]*[>❯]\s/;
/** The input box's top rule (a flat rule, or a rounded box's top). */
export const CLAUDE_BOX_RULE = /^[\s]*(?:[╭┌][─━]{2,}|[─━]{8,})/;

/**
 * v1.154.1 (walk H1): Claude Code shows that its turn is still running.
 * Claude 2.1 draws its input box the whole turn long, so the box alone is
 * not "at its prompt". Two signs, each where Claude draws it:
 * - the last row above the input box's top rule is a tool's "⎿ Running…"
 *   or the spinner line;
 * - "esc to interrupt", the queued-message hint or "ctrl+b to run in
 *   background" below the last finished turn (`… · done`) — never in an
 *   answer or a diff above it. With no finished turn in view, only from
 *   just above the box down.
 */
export function claudeTurnRunning(tailText: string): boolean {
  if (!tailText) return false;
  const rows = settledTail(tailText.split("\n"), 20);
  let box = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    // The chevron with a draft, or alone at the end of its row.
    if (CLAUDE_INPUT_LINE.test(rows[i]) || /^[\s│|]*[>❯]$/.test(rows[i])) {
      box = i;
      break;
    }
  }
  let top = box;
  if (box > 0 && CLAUDE_BOX_RULE.test(rows[box - 1])) top = box - 1;
  if (top > 0) {
    let above = top - 1;
    while (above >= 0 && rows[above].trim() === "") above--;
    if (above >= 0 && (CLAUDE_TOOL_RUNNING.test(rows[above]) || CLAUDE_SPINNER.test(rows[above]))) return true;
  }
  let done = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (CLAUDE_TURN_DONE.test(rows[i])) {
      done = i;
      break;
    }
  }
  const end = top >= 0 ? top : rows.length;
  // 1.169.0: the spinner with its timer anywhere after the last finished
  // turn and above the box, when only its own indented rows follow it (a
  // tip, a todo list) — not a spinner left above a later answer.
  const spinnerFrom = done >= 0 ? done + 1 : 0;
  for (let i = end - 1; i >= spinnerFrom; i--) {
    if (!CLAUDE_SPINNER_TIMER.test(rows[i])) continue;
    if (rows.slice(i + 1, end).every((row) => row.trim() === "" || /^\s/.test(row))) return true;
    break;
  }
  // The running words: below the box (Claude 2.1.30x's footer: "esc to
  // interrupt", "ctrl+b to run in background"), or above it in a status row
  // of the old shape (a glyph, words, the phrase in parentheses) or the
  // queued-messages hint on a row of its own — never in an answer's prose
  // or a draft.
  if (box >= 0) {
    let close = -1;
    for (let i = box + 1; i < rows.length; i++) {
      if (CLAUDE_BOX_RULE.test(rows[i])) {
        close = i;
        break;
      }
    }
    if (close >= 0 && CLAUDE_RUNNING_WORDS.test(rows.slice(close + 1).join("\n"))) return true;
  }
  const from = done >= 0 ? done + 1 : Math.max(0, end - 3);
  return rows
    .slice(from, end)
    .some((row) => CLAUDE_STATUS_SHAPED.test(row.trim()) || /^\s*press up to edit queued messages/i.test(row));
}

/** A status row of the old shape: a glyph that is no transcript mark, words,
 *  and a parenthesised group with the running words
 *  (`✻ Pondering… (4s · ↑ 120 tokens · esc to interrupt)`). */
const CLAUDE_STATUS_SHAPED =
  /^[^\p{L}\p{N}\s⏺●>❯]\s*\p{L}[^()]*\([^()]*(?:esc to interrupt|ctrl\+b to run in background)[^()]*\)$/iu;

/**
 * v1.154.1 (walk H1): the Builder's "at its prompt" for Claude — its input
 * box in view and no running turn (`claudeTurnRunning`). What a message
 * held for the prompt waits on (`deliverWhenIdle`), and the "asking-you"
 * refinement of a Claude tile. A question with numbered choices still
 * counts (the tile's "asking-you"); the self-check's stricter gate is
 * `matchesClaudeTurnIdle`.
 */
export function matchesClaudePromptIdle(tailText: string): boolean {
  return matchesClaudePromptBox(tailText) && !claudeTurnRunning(tailText) && !claudeComposerEscaped(tailText);
}

/** A rule line of Claude's input box: flat (2.1.x) or a box corner. */
const CLAUDE_ANY_BOX_RULE = /^[\s]*(?:[╭╰┌└][─━]{2,}|[─━]{8,})/;
/** The chevron line holding a draft that starts with `!` or `/`. */
const CLAUDE_ESCAPED_INPUT = /^[\s│|]*[>❯]\s+[!/]/;
/** Bash mode's input line, should Claude draw `!` in place of the chevron. */
const CLAUDE_BANG_PROMPT = /^[\s│|]*!/;

/**
 * 2026-10-15 (chat spike Phase 0, Claude Code 2.1.300): the member's draft
 * in Claude's input box starts with `!` (bash mode: what is submitted next
 * runs as a shell command) or `/` (the slash-command menu). A message of
 * Plyloft's pasted now would land after that `!` and run in the shell — its
 * own leading space (`builderInject.ts::composerSafe`) cannot help — so the
 * box is not idle: Plyloft holds its message and the hold/flush delivers it
 * once the member has cleared or sent the draft.
 *
 * Read only from the input box's first row (the row below the top of the
 * settled tail's last two rules): a chevron followed by `!` or `/`, or a
 * `!` in the chevron's place (should bash mode draw it so). Which of the two
 * bash mode draws on 2.1.300 (and its footer) is unmeasured; both are held.
 * An empty box reads back as a bare `❯` (rows are read trimmed), and the
 * transcript above the box (an echoed `❯ /compact`) is never looked at.
 * Claude's placeholder (`❯ Try "…"`) never starts with either.
 */
export function claudeComposerEscaped(tailText: string): boolean {
  return claudeDraftEscape(tailText) === true;
}

/** `claudeComposerEscaped`, or null when no input box is in view (a picker,
 *  a menu): the screen says nothing about the draft then. */
export function claudeDraftEscape(tailText: string): boolean | null {
  if (!tailText) return null;
  // Walk 2026-10-15 (F1): a `/` draft opens Claude's slash menu, ~30 rows
  // below the box — 20 rows held only the menu, the box was out of reach.
  const rows = settledTail(tailText.split("\n"), CLAUDE_ESCAPE_SCAN_ROWS);
  let bottom = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (CLAUDE_ANY_BOX_RULE.test(rows[i])) {
      bottom = i;
      break;
    }
  }
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--) {
    if (CLAUDE_ANY_BOX_RULE.test(rows[i])) {
      top = i;
      break;
    }
  }
  // The draft's first row only: what Claude reads the escape from. A later
  // line of a multi-line draft (`!important`) is just text.
  if (top < 0 || top + 1 >= bottom) {
    // No box in view, but the slash menu is: the draft starts with `/`.
    return rows.filter((row) => CLAUDE_SLASH_MENU_ROW.test(row)).length >= 3 ? true : null;
  }
  const first = rows[top + 1];
  if (CLAUDE_ESCAPED_INPUT.test(first) || CLAUDE_BANG_PROMPT.test(first)) return true;
  // The slash menu hangs below the box only while the draft starts with `/`.
  return rows.slice(bottom + 1).some((row) => CLAUDE_SLASH_MENU_ROW.test(row));
}

/** How many settled rows the escape check reads: the box and a slash menu
 *  of ~30 rows below it (measured in the 2026-10-15 walk), with margin. */
export const CLAUDE_ESCAPE_SCAN_ROWS = 80;
/** A row of Claude's slash-command menu: indented, an optional selection
 *  chevron, `/name` (letters, digits, `:._@-`), then a description after
 *  two or more spaces, or nothing (`  ❯ /ply:release-notes   (ply) Writes…`,
 *  `  /compact   Free up context…`). A path (`/tmp/x`) has a second `/`. */
const CLAUDE_SLASH_MENU_ROW = /^\s+(?:❯\s+)?\/[\w:.@-]+(?:\s{2,}\S.*)?$/u;

/** Codex TUI composer line: a "›" chevron prompt, box-framed or bare. The
 *  chevron alone decides, whatever follows it: Codex 0.154 can draw an
 *  animation glyph right after it, and a screen row read with its trailing
 *  whitespace trimmed turns an empty or whitespace-only draft into a bare
 *  `›` (GH #67). */
const CODEX_INPUT = /^[\s│|]*›/m;
/** Codex TUI footer hint shown while the composer is idle. */
const CODEX_HINT = /\?\s+for\s+shortcuts/i;
/** Codex TUI approval prompt (command / patch / network) waiting on y/n. */
const CODEX_APPROVAL = /(allow|approve|run this command|apply this patch)[^\n]*\?/i;

/**
 * v1.105.0: the same conservative refinement for the Codex CLI TUI. True
 * when the settled tail looks like Codex's idle composer or an approval
 * prompt — both are "your turn". Same degrade rule as Claude's: a miss
 * only leaves the label at plain "wants-you".
 */
export function matchesCodexPromptBox(tailText: string): boolean {
  if (!tailText) return false;
  if (codexComposerEscaped(tailText)) return false;
  return (
    CODEX_HINT.test(tailText) ||
    CODEX_INPUT.test(tailText) ||
    CODEX_APPROVAL.test(tailText)
  );
}

/** Codex's composer line holding a draft that starts with `!` or `/`. */
const CODEX_ESCAPED_INPUT = /^[\s│|]*›\s*[!/]/;

/**
 * 2026-10-15: Codex's equivalent of `claudeComposerEscaped` — the last
 * composer line (`›`) holds a draft starting with `!` (a local shell
 * command) or `/` (a slash command), so a paste of Plyloft's waits. Read
 * from the shape of the line only; unmeasured against a live Codex.
 */
export function codexComposerEscaped(tailText: string): boolean {
  return codexDraftEscape(tailText) === true;
}

/** `codexComposerEscaped`, or null when no composer line is in view. */
export function codexDraftEscape(tailText: string): boolean | null {
  if (!tailText) return null;
  const rows = settledTail(tailText.split("\n"), 12);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (/^[\s│|]*›/.test(rows[i])) return CODEX_ESCAPED_INPUT.test(rows[i]);
  }
  return null;
}

/**
 * #47: the settled tail of a terminal screen — trailing blank rows dropped,
 * then the last `rows`. A TUI that draws inline (Codex 0.154 does) starts at
 * the top of a fresh screen, so the plain last-N rows of a tall tile are all
 * blank and would miss its composer entirely.
 */
export function settledTail(lines: readonly string[], rows: number): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return lines.slice(Math.max(0, end - rows), end);
}

/** What a screen scan reads of an xterm buffer (`term.buffer.active`). */
export interface ScanBuffer {
  baseY: number;
  getLine(i: number): { translateToString(trimRight?: boolean): string } | undefined;
}

/**
 * v1.154.1 round 4 (RW-C2): the rows a Builder's prompt scan judges — the
 * settled tail of the visible screen (`settledTail` of the viewport), as
 * Terminal.tsx has read tiles since #47. Claude 2.1 draws inline from the
 * top of a fresh screen: after a session's first turn its input box sits
 * mid-screen with blank rows below, and the buffer's last raw rows were all
 * blank — no prompt box, no finished turn, so the self-check (GH #111)
 * waited its full 10 minutes. Once more output filled the screen it worked.
 */
export function scanTail(buf: ScanBuffer, viewRows: number, rows: number): string {
  const view: string[] = [];
  for (let i = buf.baseY; i < buf.baseY + viewRows; i++) {
    const line = buf.getLine(i);
    view.push(line ? line.translateToString(true) : "");
  }
  return settledTail(view, rows).join("\n");
}

/** A composer line: the `›` chevron at the start of the line, whatever
 *  follows — a placeholder, a draft, nothing (the row is read trimmed), a
 *  cursor block or an animation glyph. None of those is evidence of a
 *  running turn (GH #67). */
const CODEX_COMPOSER_LINE = /^[\s│|]*›/;
/** The chevron as a selection marker on a numbered choice (approval, trust). */
const CODEX_CHOICE_LINE = /^[\s│|]*›\s+\d+\.\s/;
/** Codex is not waiting at its composer: a turn's status line, or a modal
 *  asking for a decision. Measured against codex-cli 0.154.0. */
const CODEX_NOT_AT_COMPOSER =
  /esc to interrupt|press enter to (confirm|continue)|esc to cancel|would you like to/i;

/** The settled rows `matchesCodexComposerIdle` judges — what a refusal logs,
 *  so a false negative can be read back from Ply.log (GH #67). */
export function codexComposerRows(tailText: string): string[] {
  return settledTail(tailText.split("\n"), 12);
}

/**
 * #47: the dictation gate for the Codex TUI — true when the tail shows its
 * composer as the thing waiting for input.
 *
 * Stricter than `matchesCodexPromptBox`, which only has to refine a label
 * after 10 s of silence. Measured on codex-cli 0.154.0: the `›` composer is
 * drawn during a turn too, past prompts in the transcript start with `›`, an
 * approval marks its choice with `› 1.`, and the footer no longer says
 * "? for shortcuts". So the composer must be the last chevron line and near
 * the bottom, not a numbered choice, with no "Working (… esc to interrupt)"
 * status and no decision modal in view. While Codex streams an answer the
 * status line is gone and this is true — harmless: Codex accepts typing
 * mid-turn and the dictated text waits in the composer, unsent.
 */
export function matchesCodexComposerIdle(tailText: string): boolean {
  if (!tailText) return false;
  const lines = codexComposerRows(tailText);
  if (lines.some((line) => CODEX_NOT_AT_COMPOSER.test(line))) return false;
  let chevron = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CODEX_COMPOSER_LINE.test(lines[i])) {
      chevron = i;
      break;
    }
  }
  if (chevron < 0 || CODEX_CHOICE_LINE.test(lines[chevron])) return false;
  // Composer, a spacer and the footer sit at the bottom; a few more rows
  // cover a multi-line draft.
  return lines.length - chevron <= 8;
}

/** Codex's transcript search bar, drawn under its composer: `Find: <query>`
 *  over a footer that ends `esc cancel` ("Type to find · full transcript ·
 *  esc cancel", "No matches · …", "enter accept · ⌃p older · ⌃n newer · …";
 *  codex-cli 0.164.0 on the Mac, and the Windows walk's 2026-10-28 screen). */
const CODEX_FIND_ROW = /^[\s│|]*Find:(\s|$)/;
const CODEX_FIND_FOOTER = /\besc cancel[\s│|]*$/;
/** The bar sits at the bottom: the footer is the last row with text, at
 *  most this many rows under `Find:` (a long query wraps). */
const CODEX_FIND_FOOTER_BELOW = 3;

/**
 * 1.172.0 E2 (Windows walk 2026-10-28): Codex shows its transcript search
 * over the composer — F3 (`find_transcript`, codex-cli 0.164.0's default)
 * opened it, and keys typed now go into its query, not the composer. True
 * only for that bar at the bottom of the screen: a `Find:` row with its
 * `esc cancel` footer under it, the last rows on screen. Anything else is
 * false — including a `Find:` in the transcript, or a footer alone.
 */
export function codexOverlayOpen(tailText: string): boolean {
  if (!tailText) return false;
  // The settled rows end at the screen's last row with text: the footer.
  const rows = codexComposerRows(tailText);
  const last = rows.length - 1;
  if (last < 1 || !CODEX_FIND_FOOTER.test(rows[last])) return false;
  for (let i = last - 1; i >= Math.max(0, last - CODEX_FIND_FOOTER_BELOW); i--) {
    if (CODEX_FIND_ROW.test(rows[i])) return true;
  }
  return false;
}

/** Codex's placeholder for a long paste in its composer:
 *  `[Pasted Content 3210 chars]` (codex-cli 0.157.0), and the forms other
 *  versions draw — a grouped count (`3,210`) or `[Pasted text #1 +40 lines]`.
 *  A bracket that starts "Pasted" and holds a number, on one row. */
const CODEX_PASTED_BLOCK = /\[Pasted[^\]\n]*\d[^\]\n]*\]/;

/**
 * 1.170.0 F1: Codex's composer still holds Plyloft's pasted message — the
 * Enter after it was not taken. Only at its idle composer (no running
 * turn, no question: `matchesCodexComposerIdle`), and only when the
 * composer row — the last chevron row, never a past prompt in the
 * transcript above it — shows the `[Pasted … N …]` placeholder,
 * or (a short paste, drawn as text) starts with the message's own first
 * words — or (a long paste drawn as text, the composer scrolled) ends with
 * the message's own end (`codexComposerHoldsPastedText`). Anything else is
 * false: the Enter is never sent again on a guess.
 */
export function codexComposerHoldsPaste(tailText: string, message: string): boolean {
  if (codexComposerHoldsPasteAtChevron(tailText, message)) return true;
  return codexComposerHoldsPastedText(tailText, message);
}

/** The composer row itself shows the placeholder, or a short paste's own
 *  first words. */
function codexComposerHoldsPasteAtChevron(tailText: string, message: string): boolean {
  if (!matchesCodexComposerIdle(tailText)) return false;
  const rows = codexComposerRows(tailText);
  let row: string | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (CODEX_COMPOSER_LINE.test(rows[i])) {
      row = rows[i];
      break;
    }
  }
  if (row === null) return false;
  const text = row.replace(/^[\s│|]*›/, "").replace(/[│|]\s*$/, "").trim();
  if (CODEX_PASTED_BLOCK.test(text)) return true;
  const first = (message.split("\n").find((line) => line.trim() !== "") ?? "").trim().slice(0, 24);
  return first.length >= 8 && text.startsWith(first);
}

/** A long paste drawn as text: how many settled rows are read, at most
 *  (a tall composer under a few transcript rows). */
const CODEX_PASTED_TEXT_ROWS = 80;
/** Under the message's last row: the cursor's row, a spacer and the
 *  footer (one or two rows). */
const CODEX_PASTED_TEXT_BELOW = 4;
/** Rows above the composer where a running turn's status line sits. */
const CODEX_STATUS_ABOVE = 6;
/** Text as compared across a wrap: no whitespace, no box borders. */
function compactText(text: string): string {
  return text.replace(/[\s│|]+/g, "");
}

/**
 * 1.170 walk fix (Windows re-walk 2026-10-27, step 2): a long paste Codex
 * drew as text, not as `[Pasted …]`. Its composer is taller than the
 * screen's 12-row composer check and scrolled to the cursor: the chevron
 * row shows a line from the middle of the message (a blank one between
 * two paragraphs in the walk), never its first words, and the Enter that
 * Codex took inside the paste is a newline under the last line. Held when
 * the rows from the last chevron down — wrapped as Codex wraps them, so
 * compared without whitespace — end with the message's own end (at least
 * 24 characters of it) with only the cursor row, a spacer and the footer
 * under it, and no running turn or question above the composer or in its
 * footer. A submitted message leaves an empty composer (its echo is above
 * the last chevron); the person's own draft doesn't end like the message.
 */
function codexComposerHoldsPastedText(tailText: string, message: string): boolean {
  if (!tailText) return false;
  const msg = compactText(message);
  if (msg.length < 24) return false;
  const rows = settledTail(tailText.split("\n"), CODEX_PASTED_TEXT_ROWS);
  let chevron = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (CODEX_COMPOSER_LINE.test(rows[i])) {
      chevron = i;
      break;
    }
  }
  if (chevron < 0 || CODEX_CHOICE_LINE.test(rows[chevron])) return false;
  const body = rows.slice(chevron).map((row, i) => (i === 0 ? row.replace(CODEX_COMPOSER_LINE, "") : row));
  // The message's last row: the lowest row that is part of it.
  let end = body.length - 1;
  for (; end >= 0; end--) {
    const text = compactText(body[end]);
    if (text !== "" && msg.includes(text)) break;
  }
  if (end < 0 || body.length - 1 - end > CODEX_PASTED_TEXT_BELOW) return false;
  // Under it: blank rows (the cursor's, a spacer), then only the footer at
  // the bottom — a draft typed under the message is not Plyloft's paste.
  const below = body.slice(end + 1);
  const footerFrom = below.findIndex((row) => row.trim() !== "");
  if (footerFrom === 0) return false;
  if (footerFrom > 0 && below.slice(footerFrom).some((row) => row.trim() === "")) return false;
  // Upwards while the rows still read as one piece of the message.
  let joined = compactText(body[end]);
  for (let i = end - 1; i >= 0; i--) {
    const next = compactText(body[i]) + joined;
    if (!msg.includes(next)) break;
    joined = next;
  }
  if (!msg.endsWith(joined) || joined.length < 24) return false;
  const around = [...rows.slice(Math.max(0, chevron - CODEX_STATUS_ABOVE), chevron), ...body.slice(end + 1)];
  return !around.some((row) => CODEX_NOT_AT_COMPOSER.test(row));
}

/**
 * 2026-10-15: the Codex Builder's "turn over, at its composer" — what the
 * self-check is delivered on (`canDeliver`) — refuses a draft of the
 * member's that starts with `!` or `/` (`codexComposerEscaped`), as Claude's
 * does. Dictation keeps `matchesCodexComposerIdle` on purpose: it inserts
 * the member's own words into the member's own draft, `!` or not.
 */
export function matchesCodexTurnIdle(tailText: string): boolean {
  return matchesCodexComposerIdle(tailText) && !codexComposerEscaped(tailText);
}

/** Claude Code is not waiting at its input box: a turn's status line
 *  (`esc to interrupt`), or a permission or other question with numbered
 *  choices (`Do you want to proceed?` / `❯ 1. Yes`). */
const CLAUDE_NOT_AT_PROMPT =
  /esc to interrupt|do you want to|would you like to|esc to cancel|^[\s│|]*[❯>]\s*\d+\.\s/im;

/**
 * ADR 0006 (third card), GH #111: the Builder's turn is over and it is at
 * its input box — what the self-check waits for before Build done goes on.
 * Stricter than `matchesClaudePromptBox`, which Claude 2.1 satisfies while it
 * works (the box stays drawn) and on a permission question (its `❯ 1. Yes`
 * choice): no status line and no question may be in view.
 */
export function matchesClaudeTurnIdle(tailText: string): boolean {
  if (!matchesClaudePromptIdle(tailText)) return false;
  return !CLAUDE_NOT_AT_PROMPT.test(settledTail(tailText.split("\n"), 20).join("\n"));
}

/** CL-11 (walk): Codex is asking for a decision — an approval of a command
 *  or an edit (`Would you like to run the following command?` over `› 1.
 *  Yes, proceed (y)` and `Press enter to confirm or esc to cancel`).
 *  Measured on the Codex TUI. Round 2: the last chevron row in the settled
 *  tail is the marked choice — an echoed past prompt (`› 1. fix X`) or a
 *  draft has the composer below it — the modal's footer is under it, and
 *  its own words are in view; no running turn. */
const CODEX_DECISION_WORDS = /would you like to|press enter to confirm/i;
const CODEX_MODAL_FOOTER = /press enter to confirm|esc to cancel/i;
export function codexAwaitingDecision(tailText: string): boolean {
  if (!tailText) return false;
  const rows = settledTail(tailText.split("\n"), 14);
  if (rows.some((row) => /esc to interrupt/i.test(row))) return false;
  let chevron = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (CODEX_COMPOSER_LINE.test(rows[i])) {
      chevron = i;
      break;
    }
  }
  if (chevron < 0 || !CODEX_CHOICE_LINE.test(rows[chevron])) return false;
  // The modal's footer sits under its choices; a draft `› 1. …` in the
  // composer has the composer's footer instead.
  return rows.slice(chevron + 1).some((row) => CODEX_MODAL_FOOTER.test(row)) && rows.some((row) => CODEX_DECISION_WORDS.test(row));
}

/** CL-11: Claude Code is asking for a decision — a permission question
 *  (`Do you want to proceed?` over `❯ 1. Yes`). The folder-trust question
 *  has its own detection (`trustQuestion.ts`). Round 2: the marked choice
 *  is the last `❯` row, with no input-box rule under it — a draft `❯ 1. …`
 *  typed in the input box is not a question. */
const CLAUDE_CHEVRON_LINE = /^[\s│|]*❯/;
const CLAUDE_CHOICE_LINE = /^[\s│|]*❯\s*\d+\.\s/;
const CLAUDE_BOX_BOTTOM = /^[\s]*(?:[╰└][─━]{2,}|[─━]{8,})/;
const CLAUDE_DECISION_WORDS = /do you want to|would you like to/i;
/** UX P-B Mac walk 2: Claude's own question to the person (its
 *  AskUserQuestion picker — "☐ Second line / Should I add a second line to
 *  note.txt? / ❯ 1. No, leave it / 2. Yes, add a line / 3. Type something.
 *  / Enter to select · ↑/↓ to navigate · Esc to cancel") asks in its own
 *  words, so it is told by the picker's footer under the marked choice. */
const CLAUDE_PICKER_FOOTER = /enter to select/i;
/** 1.177.0 (walk round 4, Windows, Claude Code 2.1.332): the permission
 *  menu's own footer (`Esc to cancel · Tab to amend`), a row of its own. */
const CLAUDE_MENU_FOOTER = /^\s*esc to cancel\b/i;
/**
 * Claude's menu is closed by its own footer under the marked choice, before
 * any input-box rule: then a rule under the footer is not the box's.
 * Claude 2.1.332 draws the session's name as the screen's last row once a
 * session is named — `──────── add-notes-list-title ─` — which reads as a
 * box rule and made the permission menu read as a draft in the box.
 */
function claudeMenuFooterBelow(rows: readonly string[], chevron: number): boolean {
  for (let i = chevron + 1; i < rows.length; i++) {
    if (CLAUDE_MENU_FOOTER.test(rows[i])) return true;
    if (CLAUDE_BOX_BOTTOM.test(rows[i])) return false;
  }
  return false;
}
/** Another numbered choice within three rows of the marked one. */
function numberedSibling(rows: readonly string[], chevron: number): boolean {
  for (let i = Math.max(0, chevron - 3); i <= Math.min(rows.length - 1, chevron + 3); i++) {
    if (i !== chevron && NUMBERED_CHOICE_ROW.test(rows[i])) return true;
  }
  return false;
}
export function claudeAwaitingDecision(tailText: string): boolean {
  if (!tailText) return false;
  const rows = settledTail(tailText.split("\n"), 20);
  let chevron = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (CLAUDE_CHEVRON_LINE.test(rows[i])) {
      chevron = i;
      break;
    }
  }
  if (chevron < 0 || !CLAUDE_CHOICE_LINE.test(rows[chevron])) return false;
  // Before the input-box rule: the picker draws its own rules, and a draft
  // in the input box has the box's footer under it, never the picker's.
  if (rows.slice(chevron + 1).some((row) => CLAUDE_PICKER_FOOTER.test(row))) return true;
  // A numbered menu closed by its own footer asks, whatever rule is under it.
  if (claudeMenuFooterBelow(rows, chevron) && numberedSibling(rows, chevron)) return true;
  if (rows.slice(chevron + 1).some((row) => CLAUDE_BOX_BOTTOM.test(row))) return false;
  return rows.slice(0, chevron).some((row) => CLAUDE_DECISION_WORDS.test(row));
}

/** A row of a numbered menu, marked or not (`› 1. Trust and continue`,
 *  `  2. Back to Agent Command Center`). */
const NUMBERED_CHOICE_ROW = /^[\s│|]*(?:[›❯]\s*)?\d+\.\s/;

/**
 * 1.176.3 (off-screen Builders, the 2026-11-23 walks): the screen ends on a
 * menu of numbered choices — a folder-trust question, an approval, Claude's
 * Bypass warning or usage-limit menu, a picker — whatever its words. Codex
 * 0.171's trust screen (`Trust this folder? … › 1. Trust and continue /
 * 2. Back to Agent Command Center / enter continue · esc back`) has none of
 * the words the decision matchers read. The last chevron row (`›` Codex,
 * `❯` Claude) marks a numbered choice, another numbered choice sits within
 * three rows of it, and (Claude) no input-box rule is under it: a draft
 * `❯ 1. …` typed in Claude's box has the box's rule under it.
 */
export function choiceMenuInView(vendor: string, tailText: string): boolean {
  if (!tailText) return false;
  const chevronLine = vendor === "codex" ? CODEX_COMPOSER_LINE : vendor === "claude" ? CLAUDE_CHEVRON_LINE : null;
  const choiceLine = vendor === "codex" ? CODEX_CHOICE_LINE : CLAUDE_CHOICE_LINE;
  if (!chevronLine) return false;
  const rows = settledTail(tailText.split("\n"), 20);
  let chevron = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (chevronLine.test(rows[i])) {
      chevron = i;
      break;
    }
  }
  if (chevron < 0 || !choiceLine.test(rows[chevron])) return false;
  if (
    vendor === "claude" &&
    !claudeMenuFooterBelow(rows, chevron) &&
    rows.slice(chevron + 1).some((row) => CLAUDE_BOX_BOTTOM.test(row))
  ) {
    return false;
  }
  return numberedSibling(rows, chevron);
}

/** Codex's own turn-done line: `Worked for 21s • 11:22` (Codex 0.171, the
 *  2026-11-23 walks, Mac and ConPTY). */
const CODEX_TURN_DONE = /^\s*(?:─\s*)?Worked for (?:\d+h\s*)?(?:\d+m\s*)?\d+s\b/;
/** A row of Codex 0.154's composer animation: glyphs and blanks only. */
const CODEX_GLYPH_ROW = /^[\s·.•*+˙]*$/;

/**
 * 1.176.3 (off-screen review MF1): the last row with text above the
 * composer is the CLI's own turn-done line — Claude's `✻ Churned for 9s ·
 * done 11:19 AM` above its box, Codex's `Worked for 21s • 11:22` above its
 * composer. The proof a turn ended, where the idle shape alone is not
 * (Codex 0.171 hides its status line while it streams, and while a tool
 * call is written).
 */
export function turnDoneAboveComposer(vendor: string, tailText: string): boolean {
  if (!tailText) return false;
  const rows = tailText.split("\n");
  let row = rows.length - 1;
  if (vendor === "codex") {
    while (row >= 0 && !(CODEX_COMPOSER_LINE.test(rows[row]) && !CODEX_CHOICE_LINE.test(rows[row]))) row--;
    if (row < 0) return false;
    for (row--; row >= 0 && CODEX_GLYPH_ROW.test(rows[row]); row--);
    return row >= 0 && CODEX_TURN_DONE.test(rows[row]);
  }
  if (vendor === "claude") {
    while (row >= 0 && !(CLAUDE_INPUT_LINE.test(rows[row]) || /^[\s│|]*[>❯]$/.test(rows[row]))) row--;
    if (row < 0) return false;
    if (row > 0 && CLAUDE_BOX_RULE.test(rows[row - 1])) row--;
    for (row--; row >= 0 && rows[row].trim() === ""; row--);
    return row >= 0 && CLAUDE_TURN_DONE.test(rows[row]);
  }
  return false;
}

/** CL-11: the decision matcher for a Builder vendor. */
export function decisionMatcherFor(vendor: string): (tail: string) => boolean {
  if (vendor === "codex") return codexAwaitingDecision;
  if (vendor === "claude") return claudeAwaitingDecision;
  return () => false;
}

/** 2026-10-15: whether the member's draft in a Builder vendor's composer
 *  starts with `!` or `/` — what holds Plyloft's messages, the held-message
 *  valve included (`BuilderRuntime.composerEscaped`). Null when no composer
 *  is in view (a picker, a menu): the last scan's verdict stands. */
export function composerEscapedMatcherFor(vendor: string): (tail: string) => boolean | null {
  if (vendor === "codex") return codexDraftEscape;
  if (vendor === "claude") return claudeDraftEscape;
  return () => false;
}

/** The "turn over, at its prompt" matcher for a Builder vendor: Codex's
 *  strict composer gate (no approval, no running turn) or Claude's. */
export function turnIdleMatcherFor(vendor: string): (tail: string) => boolean {
  if (vendor === "codex") return matchesCodexTurnIdle;
  if (vendor === "claude") return matchesClaudeTurnIdle;
  return () => false;
}

/** 1.174.3: the scan positively sees a turn running: the CLI's own status line.
 *  Not `!turnIdle`, which a redraw or a screen not yet drawn also gives. */
export function turnRunningMatcherFor(vendor: string): (tail: string) => boolean {
  if (vendor === "codex") {
    return (tail) => codexComposerRows(tail).some((row) => /esc to interrupt/i.test(row));
  }
  if (vendor === "claude") return claudeTurnRunning;
  return () => false;
}

/** 1.174.3: the last thing above Codex's composer is its own "Conversation
 *  interrupted" line: the turn on screen was cut off. An earlier interruption
 *  with a finished turn below it doesn't count. */
const CODEX_INTERRUPTED_LINE = /^[\s│|]*(?:■\s*)?Conversation interrupted\b/i;
function codexTurnInterrupted(tail: string): boolean {
  const lines = tail.split("\n");
  let row = lines.length - 1;
  while (row >= 0 && !CODEX_COMPOSER_LINE.test(lines[row])) row--;
  for (row--; row >= 0; row--) {
    if (lines[row].trim()) return CODEX_INTERRUPTED_LINE.test(lines[row]);
  }
  return false;
}

/** 1.174.4 (measured on a Mac walk, 2026-11-05, Claude Code on Haiku): Claude
 *  says nothing of a turn cut off by a closed session. After `claude --resume`
 *  its last row above the input box is the person's own message, unanswered.
 *  Cut off during a command it prints `⎿ Interrupted · …`.
 *  Rows going up: the message's own lines, until its chevron (cut off) or a row
 *  of Claude's: a reply, a tool result, the turn's summary (answered). Read only
 *  after a Resume with nothing submitted since (`markPromptBox`). A turn cut off
 *  after Claude had already answered something looks finished, and stays so. */
const CLAUDE_REPLY_ROW = /^\s*[⏺●✻⎿]/;
/** Cut off during a command, Claude does say so (same walk). */
const CLAUDE_INTERRUPTED_ROW = /^\s*⎿\s*Interrupted\b/;
function claudeTurnInterrupted(tail: string): boolean {
  const lines = tail.split("\n");
  let row = lines.length - 1;
  while (row >= 0 && !CLAUDE_CHEVRON_LINE.test(lines[row])) row--;
  for (row--; row >= 0; row--) {
    const line = lines[row];
    if (!line.trim() || CLAUDE_ANY_BOX_RULE.test(line)) continue;
    if (CLAUDE_INTERRUPTED_ROW.test(line)) return true;
    if (CLAUDE_REPLY_ROW.test(line)) return false;
    // The person's message starts at the margin; a `❯` Claude quotes is indented.
    if (/^❯\s+\S/.test(line)) return true;
  }
  return false;
}

/** 1.174.3: the scan sees a cut-off turn, by each CLI's own signs. */
export function turnInterruptedMatcherFor(vendor: string): (tail: string) => boolean {
  if (vendor === "codex") return codexTurnInterrupted;
  if (vendor === "claude") return claudeTurnInterrupted;
  return () => false;
}

/**
 * Pick the prompt-box matcher for a PTY tile by the command it runs. Shell
 * tiles get a matcher that never matches (they are not derived anyway).
 */
/**
 * Terminals block P2: the CLI's input line holds nothing — no draft of the
 * member's, no placeholder (Claude's `❯ Try "…"` reads as text: never
 * empty, so Plyloft never types over it). Only then may Plyloft type a
 * command into the session (a member's `/rename`, passed on).
 */
/** Terminals block P3: the CLI a tile's command runs, by its name. */
export function cliVendorOf(cmd: string): "claude" | "codex" | null {
  const base = isWindows()
    ? basename(cmd, true).replace(/\.(exe|cmd|bat)$/i, "")
    : basename(cmd, false);
  return base === "claude" ? "claude" : base === "codex" ? "codex" : null;
}

/** What Codex draws in an empty composer, as the fixtures recorded it. */
const CODEX_PLACEHOLDERS = new Set(["Ask Codex to do anything"]);

export function promptInputEmpty(cmd: string, tailText: string): boolean {
  const base = isWindows()
    ? basename(cmd, true).replace(/\.(exe|cmd|bat)$/i, "")
    : basename(cmd, false);
  const line = base === "claude" ? /^[\s│|]*[>❯](.*)$/ : base === "codex" ? /^[\s│|]*›(.*)$/ : null;
  if (!line || !tailText) return false;
  const rows = tailText.split("\n");
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const m = line.exec(rows[i]);
    if (m) {
      const text = m[1].replace(/[│|]/g, "").trim();
      // Challenger round 1: Codex's own placeholder in an empty composer
      // (fixtures: `› Ask Codex to do anything`), drawn dim — not a draft.
      return text === "" || (base === "codex" && CODEX_PLACEHOLDERS.has(text));
    }
  }
  return false;
}

/** QoL 1.168 (walk lane 1, step 4): one cell of the CLI's input row as
 *  xterm draws it. `plain`: neither dim, inverse (the CLI's cursor block)
 *  nor a faint grey (`faintFg`) — how the member's own typing is drawn. Claude's placeholder (`❯ Try "refactor <filepath>"`)
 *  and its suggestion after a turn, and Codex's placeholder, are drawn dim
 *  or in a grey of their own. */
export interface InputCell {
  ch: string;
  plain: boolean;
}

/** A foreground colour as xterm's cell reports it. */
export type CellFg =
  | { kind: "default" }
  | { kind: "palette"; index: number }
  | { kind: "rgb"; rgb: number };

/** The CLI's own faint text: a mid grey. Typed text is the default colour, a
 *  light one (Claude draws it in explicit RGB white on some screens) or, on a
 *  light theme, near black; a placeholder or suggestion is dim (SGR 2,
 *  `InputCell.plain` false already) or grey — palette 8, the greyscale ramp
 *  below light, an RGB grey like Claude's 153,153,153. */
const FAINT_MIN = 48;

export function faintFg(fg: CellFg): boolean {
  const grey = (r: number, g: number, b: number) =>
    Math.max(r, g, b) - Math.min(r, g, b) <= 24 && (r + g + b) / 3 < 180 && (r + g + b) / 3 >= FAINT_MIN;
  if (fg.kind === "default") return false;
  if (fg.kind === "rgb") return grey((fg.rgb >> 16) & 0xff, (fg.rgb >> 8) & 0xff, fg.rgb & 0xff);
  const i = fg.index;
  if (i === 8) return true;
  if (i >= 232 && i <= 255) return grey(8 + (i - 232) * 10, 8 + (i - 232) * 10, 8 + (i - 232) * 10);
  if (i >= 16 && i <= 231) {
    const level = (n: number) => (n === 0 ? 0 : 55 + n * 40);
    const n = i - 16;
    return grey(level(Math.floor(n / 36)), level(Math.floor(n / 6) % 6), level(n % 6));
  }
  return false;
}

/** Whether the input row (from the chevron on) holds text the member typed:
 *  any visible character drawn plain after the chevron. Dim or coloured
 *  text alone is the CLI's placeholder or suggestion, not a draft. */
export function inputRowHasDraft(cells: readonly InputCell[]): boolean {
  const at = cells.findIndex((c) => c.ch === "❯" || c.ch === ">" || c.ch === "›");
  if (at < 0) return false;
  return cells.slice(at + 1).some((c) => c.plain && c.ch.trim() !== "" && c.ch !== "│" && c.ch !== "|");
}

export function promptBoxMatcherFor(cmd: string): (tail: string) => boolean {
  // Windows: either separator and a launcher's extension — `C:\…\claude.exe`
  // and npm's `claude.cmd` are Claude too.
  const base = isWindows()
    ? basename(cmd, true).replace(/\.(exe|cmd|bat)$/i, "")
    : basename(cmd, false);
  if (base === "claude") return matchesClaudePromptIdle;
  if (base === "codex") return matchesCodexPromptBox;
  return () => false;
}

// --- card predicate (Phase 2) ----------------------------------------------

export type CardWantsReason =
  | "failed — needs you"
  | "session ended — needs you"
  | "changes requested — needs you"
  | "verification failed"
  | "done — review"
  | "ship stopped on a conflict"
  | `conflict with ${string}`
  | "complete — decide"
  | null;

/**
 * Part 3 canonical card-attention predicate. Attention is derived only from
 * persisted card state.
 *
 * GH #104 (ADR 0005): a second source used to be spliced in here — the Inbox's
 * pending post-ship lesson, which kept a landed card wanting attention. That
 * feature is retired, and the Challenger's improvement proposal replaces it
 * **without** touching this: a proposal is about a skill or the instructions, not
 * about a card, so it is the Library page and the Inbox row that carry it and no
 * card's chip changes because one exists.
 */
export function cardWantsYou(
  card: Pick<
    KanbanCard,
    | "lastRunStatus"
    | "reviewStatus"
    | "verifyStatus"
    | "shipStatus"
    | "columnId"
    | "archived"
  > &
    Partial<Pick<KanbanCard, "builder" | "buildBoth" | "linkedRunId" | "linkedSwarmId" | "shipConflict">>,
): { wants: boolean; reason: CardWantsReason } {
  // Archive is the universal terminal state.
  if (card.archived === true) return { wants: false, reason: null };

  const landed =
    card.shipStatus === "shipped" || card.reviewStatus === "merged";
  if (landed) return { wants: false, reason: null };

  // A reviewer asking for changes is an explicit human decision regardless
  // of which persisted column currently contains the card.
  if (card.reviewStatus === "changes_requested") {
    return { wants: true, reason: "changes requested — needs you" };
  }

  const s = card.lastRunStatus;
  // F11: a closed Builder session records its run as aborted; it is the
  // Inbox's "session ended" row, not a failed run.
  if (closedBuilderAborted(card)) {
    return { wants: true, reason: "session ended — needs you" };
  }
  if (s === "failed" || s === "aborted" || s === "rate_limited") {
    return { wants: true, reason: "failed — needs you" };
  }
  // 1.170.0 (G6): a conflict met bringing in the target's changes, in its
  // words ("conflict with main") and whatever the last run said — not
  // while a turn runs (`inbox.rs::sync_conflict_row`).
  const sync = card.reviewStatus === "conflict_blocked" && card.shipConflict?.sync ? card.shipConflict : null;
  if (sync && s !== "running") {
    return { wants: true, reason: `conflict with ${sync.branch?.trim() ? sync.branch : targetName(null)}` };
  }
  if (card.verifyStatus === "failed") {
    return { wants: true, reason: "verification failed" };
  }
  if (s === "success" && (card.reviewStatus == null || card.reviewStatus === "pending")) {
    return { wants: true, reason: "done — review" };
  }
  // P-A (UX P1 point 2): a local ship that stopped on a conflict
  // (`inbox.rs`'s `conflict:<card>:<run>` row, "Ship stopped on a conflict").
  if (s === "success" && card.reviewStatus === "conflict_blocked") {
    return { wants: true, reason: "ship stopped on a conflict" };
  }
  // GH #243: a card in Complete that never ran and has no checks on
  // record is closed (its GitHub issue was closed) — history, not a
  // decision. Mirrors `inbox.rs::card_is_closed_without_work`.
  const closed =
    s == null &&
    (card.verifyStatus == null || card.verifyStatus === "none" || card.verifyStatus === "legacy");
  if (card.columnId === "complete" && !closed) {
    return { wants: true, reason: "complete — decide" };
  }
  return { wants: false, reason: null };
}

/**
 * CL-3: the words for a card whose review requests changes, as the Inbox
 * says them — "1 serious issue · changes requested" while a P1 is open,
 * else the plain reason. The P1s are read from the card's findings ledger
 * once it has one, else from the review's blocking findings. Nothing new is
 * stored.
 *
 * No TS surface draws this: the Inbox row's words come from
 * `inbox.rs::changes_requested_detail`. This is that function's parity
 * reference, held to the same `p1Detail.fixtures.json` on both sides.
 */
export function changesRequestedDetail(card: Pick<KanbanCard, "builder">): string {
  const n = openP1Count(card.builder?.review);
  if (n === 0) return "changes requested — needs you";
  return n === 1 ? "1 serious issue · changes requested" : `${n} serious issues · changes requested`;
}

type CardReview = NonNullable<NonNullable<KanbanCard["builder"]>["review"]>;

/** CL-3: the P1 findings still open on a review, as `{ title, location }`,
 *  in the order the review lists them (see `changesRequestedDetail`). */
export function openP1Findings(
  review: Pick<CardReview, "ledger" | "findings"> | null | undefined,
): { title: string; location: string | null }[] {
  if (!review) return [];
  const ledger = review.ledger ?? [];
  const shown = (f: { title: string; location?: string | null }) => ({ title: f.title, location: f.location ?? null });
  if (ledger.length > 0) {
    return ledger
      // The Inbox's rule (`inbox.rs::open_p1_count`): open, blocking as the
      // last review read it (`LedgerFinding::blocks`), and a P1.
      .filter(
        (f) =>
          f.state !== "closed" &&
          !f.dismissal &&
          (f.blocking ?? (!f.preExisting && !f.note && f.severity !== "P3")) &&
          f.severity === "P1",
      )
      .map(shown);
  }
  return (review.findings ?? []).filter((f) => !f.preExisting && f.severity === "P1").map(shown);
}

export function openP1Count(review: Pick<CardReview, "ledger" | "findings"> | null | undefined): number {
  return openP1Findings(review).length;
}

// --- aggregate (Phases 3/4) ------------------------------------------------

// UX-4.4: the counts every surface shows — the sidebar's Inbox row, the
// switcher, the dock — are `lib/needsYou.ts`: unseen feed attention plus the
// sessions this derivation finds waiting, each of them an Inbox row.

/** Count of wants-you tiles + cards in one workspace — the board-local
 *  aggregate. Not a badge: the one count is `lib/needsYou.ts`. */
export function countWorkspaceWantsYou(
  tiles: readonly Tile[],
  cards: readonly KanbanCard[],
  now: number,
): { tiles: number; cards: number; total: number } {
  let tileCount = 0;
  for (const t of tiles) {
    const a = deriveTileAttention(t, now);
    if (a === "wants-you" || a === "asking-you") tileCount++;
  }
  let cardCount = 0;
  for (const c of cards) {
    if (cardWantsYou(c).wants) cardCount++;
  }
  return { tiles: tileCount, cards: cardCount, total: tileCount + cardCount };
}
