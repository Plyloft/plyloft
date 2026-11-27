// GH #70: the tile header chip for a live PTY tile — "Ready" while the
// program waits for input, "Working for Ns" otherwise, counted from the
// moment the tile last left Ready.
//
// Pure: no React, no clock. Terminal scans the screen and reports what it
// saw (`readinessProbe` for Claude and the Codex TUI, `pty_prompt_idle` and
// the OSC 133 command block for a shell); the tile store folds each report
// with `nextReadiness`; the header renders `tileHeaderStatus` on its 1 Hz
// tick. Nothing here is persisted.

import { claudeTurnRunning, matchesClaudePromptBox, settledTail } from "./attention.ts";
import { isTerminalReport } from "./builderInject.ts";

export type ReadinessKind = "claude" | "codex" | "shell";

/** The prompt matcher must hold, with nothing counted as activity, this long
 *  before the tile reads Ready. */
export const READY_QUIET_MS = 2_000;

export type HeaderStatus =
  | { ready: true }
  | { ready: false; workingSince: number };

/**
 * The header chip's state.
 *
 * - `lastOutputAt`: the last activity that counts against Ready. Terminal
 *   counts a busy verdict, a verdict turning idle, and a change on the screen
 *   outside the prompt — not bytes that only redraw an idle screen (Codex's
 *   composer animation, a spinner in the footer, Claude's chrome row above
 *   its box). When the matcher cannot answer, a shell's PTY output counts
 *   except the echo of the user's typing; a Claude or Codex screen's only
 *   when it changes the signature or shows a turn running (B3).
 * - `matcherIdle`: the kind's prompt matcher. `false` is busy. `null` means
 *   it cannot answer — a shell whose probe cannot say, or a Claude screen
 *   whose turn started above the visible page — and output quiet decides.
 * - `leftReadyAt`: when the tile last left Ready (its start until it has
 *   ever been Ready). The working counter runs from here.
 */
export function tileHeaderStatus(
  kind: ReadinessKind,
  lastOutputAt: number,
  matcherIdle: boolean | null,
  leftReadyAt: number,
  now: number,
): HeaderStatus {
  void kind; // one rule for every kind; kept for the call sites' clarity
  const idle = matcherIdle ?? true;
  if (idle && now - lastOutputAt >= READY_QUIET_MS) return { ready: true };
  return { ready: false, workingSince: Math.min(leftReadyAt, now) };
}

/** 1.169.0 (B3 walk): when the header turns Ready by time alone — an idle
 *  verdict, quiet for READY_QUIET_MS — or null when only a new scan can
 *  make it Ready. Tile redraws at that moment even with its 1 Hz tick
 *  stopped, so a stale "Working" never outlives the turn. */
export function headerTurnsReadyAt(readiness: Readiness | undefined): number | null {
  if (!readiness || !(readiness.matcherIdle ?? true) || readiness.running) return null;
  return readiness.lastOutputAt + READY_QUIET_MS;
}

export interface Readiness {
  lastOutputAt: number;
  matcherIdle: boolean | null;
  leftReadyAt: number;
  /** QoL 1.168 (M2): the screen is a permission or decision prompt — idle
   *  for the header, but the session waits on the member. */
  waiting?: boolean;
  /** QoL 1.168 (M3): the footer below the prompt shows work running in the
   *  background (a shell or task the CLI started). */
  background?: boolean;
  /** QoL 1.168 (walk lane 1): Claude's screen shows its turn running (the
   *  spinner line, a tool's Running…, "esc to interrupt") — what closing a
   *  tile reads, beside the header's output quiet. */
  running?: boolean;
}

/**
 * The header for a tile as the store holds it. A tile with no readiness yet
 * has not been scanned: working since it started. An explicit `null` verdict
 * is kept — it is a shell whose probe could not answer, which falls back to
 * output quiet.
 */
export function tileHeaderStatusFor(
  kind: ReadinessKind,
  readiness: Readiness | undefined,
  startedAt: number,
  now: number,
): HeaderStatus {
  if (!readiness) return tileHeaderStatus(kind, startedAt, false, startedAt, now);
  return tileHeaderStatus(
    kind,
    readiness.lastOutputAt,
    readiness.matcherIdle,
    readiness.leftReadyAt,
    now,
  );
}

/**
 * Fold one scan into a tile's readiness. Returns `prev` itself when nothing
 * the header shows would change, so the store can skip the `set`: a busy
 * tile's activity stamp does not matter until its matcher turns idle, and
 * that scan carries the stamp.
 *
 * Leaving Ready is only ever a report (time alone never takes a tile out of
 * Ready), so the counter restarts here: at the activity that ended it, but
 * no earlier than the tile became Ready and no later than now.
 */
export function nextReadiness(
  kind: ReadinessKind,
  prev: Readiness,
  observed: { lastOutputAt: number; matcherIdle: boolean | null; waiting?: boolean; background?: boolean; running?: boolean },
  now: number,
): Readiness {
  const flags = (r: { waiting?: boolean; background?: boolean; running?: boolean }) => ({
    ...(r.waiting ? { waiting: true } : {}),
    ...(r.background ? { background: true } : {}),
    ...(r.running ? { running: true } : {}),
  });
  const sameFlags =
    !!prev.waiting === !!observed.waiting &&
    !!prev.background === !!observed.background &&
    !!prev.running === !!observed.running;
  if (
    prev.matcherIdle === observed.matcherIdle &&
    (observed.matcherIdle === false || prev.lastOutputAt === observed.lastOutputAt)
  ) {
    return sameFlags ? prev : { lastOutputAt: prev.lastOutputAt, matcherIdle: prev.matcherIdle, leftReadyAt: prev.leftReadyAt, ...flags(observed) };
  }
  const wasReady = tileHeaderStatus(
    kind,
    prev.lastOutputAt,
    prev.matcherIdle,
    prev.leftReadyAt,
    now,
  ).ready;
  const next: Readiness = {
    lastOutputAt: observed.lastOutputAt,
    matcherIdle: observed.matcherIdle,
    leftReadyAt: prev.leftReadyAt,
    ...flags(observed),
  };
  const isReady = tileHeaderStatus(
    kind,
    next.lastOutputAt,
    next.matcherIdle,
    next.leftReadyAt,
    now,
  ).ready;
  if (wasReady && !isReady) {
    const becameReady = prev.lastOutputAt + READY_QUIET_MS;
    next.leftReadyAt = Math.min(now, Math.max(becameReady, observed.lastOutputAt));
  }
  return next;
}

/** What Terminal remembers between readiness scans of one tile. */
export interface ScanMemory {
  /** The last activity counted: `lastOutputAt` for the store. */
  activityAt: number;
  /** The verdict the last scan settled on — what the store is told. */
  lastVerdict: boolean | null | undefined;
  lastSignature: string | null;
  /** The status-shaped rows the last scan saw, and when they last changed. */
  lastStatus: string | null;
  statusChangedAt: number;
}

export const FRESH_SCAN_MEMORY: ScanMemory = {
  activityAt: 0,
  lastVerdict: undefined,
  lastSignature: null,
  lastStatus: null,
  statusChangedAt: 0,
};

/** A status-shaped row that has not changed for this long is not a running
 *  turn's status: Claude's spinner glyph cycles and Codex's "Working (Ns"
 *  counts seconds, while the same words in an answer stay put. */
export const STATUS_STALE_MS = 3_000;

/**
 * Fold one scan into the scan memory.
 *
 * The verdict: the probe's `idle`, except busy while a status-shaped row is
 * on screen and has changed within `STATUS_STALE_MS` — a live status
 * animates, an answer quoting one does not.
 *
 * Counted as activity, stamped at
 * `dataAt` (the latest PTY output before the scan, or the scan's own time
 * when no output came since the last one): a busy verdict, a verdict leaving
 * busy or turning idle (so the quiet window starts when the prompt came
 * back), a changed signature (unless a resize is being redrawn), and — only
 * when the matcher cannot answer — output Terminal did not attribute to the
 * user's own typing: any for a shell, for a TUI screen only while it shows
 * a turn running (`screen`, `running`; B3). An idle screen that merely
 * redraws counts nothing.
 */
export function foldScan(
  memory: ScanMemory,
  scan: {
    idle: boolean | null;
    /** Status-shaped rows on screen (see `readinessProbe`), or null. */
    status: string | null;
    signature: string;
    sawData: boolean;
    dataAt: number;
    rebaselining: boolean;
    now: number;
    /** 1.169.0 (B3): the verdict is read from a TUI's screen (Claude, Codex).
     *  With no verdict, bytes that leave its signature as it was — the echo
     *  of a draft the member types, the modes Claude re-sends on a key, a
     *  ConPTY's late repaint of either — are the screen's own, not activity;
     *  a running turn still changes the signature (its spinner's seconds,
     *  the answer arriving). A shell (no signature) keeps counting output. */
    screen?: boolean;
    /** B3 (Challenger): the screen shows a turn running (Claude's
     *  `claudeTurnRunning`: "esc to interrupt", a tool's Running…). With no
     *  verdict its output counts again, whatever the signature: a tall todo
     *  list under the spinner keeps the eight signature rows still. */
    running?: boolean;
    /** 1.169.0 (B3 walk): a few seconds after the tile's own refit (expand,
     *  restore, a layout change), past `rebaselining`. A TUI's late repaint
     *  — Claude reflowing at the new width, a footer hint appearing — lands
     *  here; on a screen that read Ready at the refit (Terminal arms it),
     *  with no status row and no turn running, it is a redraw, as inside the
     *  window. A turn running still counts. */
    settling?: boolean;
  },
): ScanMemory {
  const statusChangedAt =
    scan.status !== null && scan.status !== memory.lastStatus
      ? scan.now
      : memory.statusChangedAt;
  const raw =
    scan.status !== null && scan.now - statusChangedAt < STATUS_STALE_MS
      ? false
      : scan.idle;
  // Block 10 walks (Mac, then Windows): while a resize is redrawn (a
  // text-size change refits the tile; ConPTY repaints the whole screen), a
  // half-drawn screen can miss the prompt box — "not idle" or "can't tell" —
  // and its bytes are the repaint. With no status line on screen none of it
  // is a turn: the verdict stays what it was and only a verdict turning idle
  // counts, until the window ends. A real status line still says working.
  // Terminal arms it only on a tile whose header read Ready at the refit
  // (a starting or working tile keeps every rule it had); a verdict that
  // was "not idle" since then ends it.
  const settled =
    scan.settling === true && scan.screen === true && scan.running !== true && memory.lastVerdict !== false;
  // Quit-guard Challenger: a screen that shows its turn running is never a
  // redraw, inside the window or not (the same rule as the settle).
  const redraw = (scan.rebaselining || settled) && scan.status === null && scan.running !== true;
  const idle = redraw && raw !== true ? memory.lastVerdict : raw;
  const changed =
    memory.lastSignature !== null &&
    scan.signature !== memory.lastSignature &&
    !scan.rebaselining;
  const counts = redraw
    ? (idle === false && memory.lastVerdict === false) || (idle === true && memory.lastVerdict !== true)
    : idle === false ||
      changed ||
      (idle === true && memory.lastVerdict !== true) ||
      (idle === null && memory.lastVerdict === false) ||
      (idle === null && scan.sawData && (!scan.screen || scan.running === true));
  return {
    activityAt: counts
      ? Math.max(memory.activityAt, scan.dataAt)
      : memory.activityAt,
    lastVerdict: idle,
    lastSignature: scan.signature,
    lastStatus: scan.status,
    statusChangedAt,
  };
}

/** How often a shell tile that is not at its line editor is asked again
 *  with no output. */
export const SHELL_BUSY_RECHECK_MS = 1_000;

/**
 * When Terminal must scan again without waiting for output. A shell that is
 * not editing its prompt line can change hands silently in either
 * direction — a job ending into a builtin `read` prints nothing, and a
 * `read -t 5` timing out into the next command prints nothing either — so it
 * is re-asked until its line editor has the prompt again. That last state
 * only ends with a submitted line, which schedules its own scan. A
 * status-shaped row on a Claude or Codex screen is re-judged once it would
 * be stale, since a still one in a silent answer brings no output. Claude
 * and Codex otherwise redraw when a turn ends, and a shell leaving its
 * prompt echoes the Enter that did it. `null`: output drives the next scan.
 */
export function readinessRecheckMs(
  kind: ReadinessKind,
  verdict: boolean | null,
  statusOnScreen: boolean,
): number | null {
  if (kind === "shell") return verdict === true ? null : SHELL_BUSY_RECHECK_MS;
  return statusOnScreen ? STATUS_STALE_MS + 50 : null;
}

/** Delay from parsed output to the scan that judges it. */
export const READINESS_SCAN_MS = 300;

/**
 * 1.169.0 (B3 walk): a layout change — a tile opening or closing, one
 * expanded or restored, the grid rearranged — refits many tiles, one
 * ResizeObserver callback each, spread over the change (a transition, a
 * chain of reflows). Each tile's own refit opens its own window; a tile that
 * refitted early in the change could have its window close while the
 * change still goes on, and its program's (or ConPTY's) late repaint read
 * as a changed signature: an idle tile flashed Working. Any tile's refit is
 * stamped here, and a tile whose own size changed within one window of the
 * latest stamp keeps rebaselining until that stamp's window ends. A tile
 * whose size did not change is not covered: its screen has no reason to
 * redraw, and what it draws is its own.
 */
let layoutRefitAt = 0;

/** Stamps a tile's refit (Terminal's `refit`; `at` for tests). */
export function noteLayoutRefit(at: number = Date.now()): void {
  layoutRefitAt = Math.max(layoutRefitAt, at);
}

/** The latest stamp (tests). */
export function lastLayoutRefitAt(): number {
  return layoutRefitAt;
}

/** B3 walk: how long after a tile's refit a TUI's late repaint is still a
 *  redraw (`foldScan`'s `settling`) — Claude's reflow after an expand was
 *  seen landing past the 1.5 s window. */
export const RESIZE_SETTLE_MS = 5_000;

/** Whether a scan at `now` is inside a resize redraw: the tile's own refit
 *  window, or — its size having changed during the change (`sizeChangedAt`,
 *  0 when never) — the window of the latest refit of any tile. */
export function refitRebaselining(args: {
  now: number;
  ownUntil: number;
  sizeChangedAt: number;
  layoutAt: number;
  windowMs: number;
}): boolean {
  if (args.now < args.ownUntil) return true;
  if (args.sizeChangedAt <= 0 || args.layoutAt <= 0) return false;
  const partOfChange = args.layoutAt - args.sizeChangedAt <= args.windowMs;
  return partOfChange && args.now < args.layoutAt + args.windowMs;
}

/**
 * 1.177.1 (capture walk 2026-11-26, step 11): the screen shows a turn running
 * and no question — the menu the member answered is gone. The settled scan
 * that set the tile's "asks" doesn't run while a spinner keeps the tile
 * printing, so the header kept "Asks you something" through the work.
 */
export function questionGoneWhileWorking(probe: { running: boolean; waiting: boolean }): boolean {
  return probe.running && !probe.waiting;
}

/**
 * 1.177.1 (capture walk 2026-11-26, step 13): when the redraw window that
 * `refitRebaselining` reports open ends, or null when it isn't open. A scan
 * inside it keeps the last verdict when the screen can't say (`foldScan`'s
 * hold), and a Claude tile that has finished prints nothing after it: with no
 * scan once the window closes, a "working" held through the window stayed
 * on the header ("Working · 22s" on an idle tile — the Compare bar's reason
 * row going away at the turn's end refits the grid right then). Terminal
 * scans again when it ends.
 */
export function rebaselineEndsAt(args: {
  now: number;
  ownUntil: number;
  sizeChangedAt: number;
  layoutAt: number;
  windowMs: number;
}): number | null {
  if (!refitRebaselining(args)) return null;
  const layoutEnd =
    args.sizeChangedAt > 0 && args.layoutAt > 0 && args.layoutAt - args.sizeChangedAt <= args.windowMs
      ? args.layoutAt + args.windowMs
      : 0;
  return Math.max(args.ownUntil, layoutEnd);
}

/**
 * What a shell tile's PTY state and its OSC 133 command block say together.
 *
 * `running`: busy. `editing`: the prompt is the shell's own — idle.
 * `canonical` cannot be told apart: a builtin `read` waiting for input (idle)
 * looks like the prompt of a shell with no line editor (idle) and like a
 * builtin loop (busy), so output quiet decides — with an open command block
 * too, or `read answer` under shell integration would never reach Ready.
 * The block is the busy signal where it is the only one: when the PTY cannot
 * answer at all.
 */
export function shellVerdict(
  state: "running" | "editing" | "canonical" | null,
  commandBlockOpen: boolean,
): boolean | null {
  if (state === "running") return false;
  if (state === "editing") return true;
  if (state === "canonical") return null;
  return commandBlockOpen ? false : null;
}

/**
 * The user submitted a line: what they typed can start a program that prints
 * nothing (`read -s answer; sleep 30` — the silent read does not even echo),
 * so Terminal scans after it instead of waiting for output that never comes.
 * Ordinary keystrokes are left to their echo.
 */
export function isSubmission(input: string): boolean {
  return input.includes("\r") || input.includes("\n");
}

/** 1.169.0 (B3): what xterm's `onData` says about the member. xterm also
 *  writes its own replies to the program there — a DA1 answer (the bundled
 *  ConPTY asks at every start), focus in/out, the colour-scheme and OSC 11
 *  answers, cursor and mouse reports — which are no typing (no input stamp,
 *  whose echo window would hide real output) and never a submitted line. */
export function memberInput(data: string): { typed: boolean; submitted: boolean } {
  const typed = !isTerminalReport(data);
  return { typed, submitted: typed && isSubmission(data) };
}

export interface ScanClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface ScanScheduler {
  /** Ask for a scan in `delayMs`. The earliest pending deadline wins: parsed
   *  output pulls a pending recheck forward, and a recheck never pushes back
   *  a scan output already asked for. */
  request(delayMs: number): void;
  cancel(): void;
}

/** One pending readiness scan per terminal, at the earliest deadline asked. */
export function createScanScheduler(run: () => void, clock: ScanClock): ScanScheduler {
  let timer: unknown = null;
  let deadline = Infinity;
  const cancel = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    deadline = Infinity;
  };
  return {
    request(delayMs) {
      const at = clock.now() + delayMs;
      if (timer !== null && deadline <= at) return;
      cancel();
      deadline = at;
      timer = clock.setTimeout(() => {
        timer = null;
        deadline = Infinity;
        run();
      }, delayMs);
    },
    cancel,
  };
}

/** Rows the matchers judge: the settled bottom of the screen. */
const TAIL_ROWS = 20;
/** Rows above the prompt that make up the screen signature. */
const SIGNATURE_ROWS = 8;
/** A running turn's status row: a leading glyph, then a parenthesised group
 *  ending the row that says "esc to interrupt" — Claude Code's
 *  `✻ Pondering… (4s · ↑ 120 tokens · esc to interrupt)`, Codex's
 *  `• Working (2s • esc to interrupt)`. The phrase in a draft or in an
 *  answer's prose is not this shape, and a draft is below the prompt line. */
const TURN_STATUS_ROW =
  /^\s*[^\p{L}\p{N}\s]\s*\p{L}[^()]*\([^()]*esc to interrupt[^()]*\)$/iu;
/** Claude Code's input line, `>` (pre-2.1) or `❯` (2.1.x), box-framed or bare.
 *  Terminal reads rows with trailing whitespace trimmed, so an empty prompt
 *  is the bare glyph at the end of the row. */
const CLAUDE_INPUT_LINE = /^[\s│|]*[>❯](\s|$)/;
/** Claude Code is asking for a decision: a permission prompt's question, or
 *  its chevron on a numbered choice. Either is waiting for the user, even
 *  when the dialog replaces the composer box. */
const CLAUDE_DECISION = /do you want to[^\n]*\?/i;
const CLAUDE_CHOICE_LINE = /^[\s│|]*❯\s*\d+\.\s/m;
/** The Codex chevron: the composer, or the selected choice of a decision. */
const CODEX_COMPOSER_LINE = /^[\s│|]*›/;
/** Codex is asking for a decision (an approval): waiting for input too.
 *  1.176.2: Codex 0.158+'s own footer on its folder-trust screen, "enter
 *  continue · esc back" (0.171) or "· esc quit" (0.158), says it as well. */
const CODEX_DECISION = /would you like to|press enter to (confirm|continue)|^\s*enter (confirm|continue)\s*·/im;
/** A Codex transcript entry — an answer, a command it ran, its working
 *  status — starts at column 0 with a bullet. A draft's rows are indented. */
const CODEX_TRANSCRIPT_ENTRY = /^•/;
/** A row with something to read. Rows of glyphs only — the starfield, a
 *  rule, a spinner frame — are animation and stay out of the signature. */
const HAS_TEXT = /[\p{L}\p{N}]/u;

/** 1.169.0 (B3): Claude Code's own line right above its input box, drawn
 *  right-aligned to the box's edge — the effort hint (`◐ medium · /effort`),
 *  notices such as `Your login expires in 1 day · run /login to renew` —
 *  which it swaps as the member types (recorded in a ConPTY,
 *  fixtures/claudeTypingConpty.json). In a narrow tile the notice fills the
 *  row from two columns in and is cut with `…` (recorded at 60 and 40
 *  columns). Chrome, not the conversation: never part of the screen
 *  signature, or typing a draft read as activity and the tile left Ready.
 *  A chrome row starts at least `CHROME_INDENT` columns in and ends within
 *  `CHROME_EDGE` columns of the box rule's end. */
const CHROME_INDENT = 2;
const CHROME_EDGE = 3;

function isChromeAbove(row: string, ruleEnd: number): boolean {
  const indent = row.length - row.trimStart().length;
  return indent >= CHROME_INDENT && row.trimEnd().length >= ruleEnd - CHROME_EDGE;
}

/** Where the signature ends for the prompt at `prompt`: above the box's top
 *  rule (no text anyway) and the chrome row right above it. */
function withoutChromeAbove(rows: readonly string[], prompt: number): number {
  let end = prompt;
  while (end > 0 && !HAS_TEXT.test(rows[end - 1])) end--;
  // The box's top rule: the row just under the first text row above it.
  const rule = rows.slice(end, prompt).find((row) => row.trim().length > 0);
  if (rule === undefined || !/^\s*[─━╭┌]{8,}/.test(rule)) return end;
  if (end > 0 && isChromeAbove(rows[end - 1], rule.trimEnd().length)) end--;
  return end;
}

/** Index of the last row matching `line`, or -1. */
function lastRow(rows: readonly string[], line: RegExp): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (line.test(rows[i])) return i;
  }
  return -1;
}

/** Up to `count` text rows directly above row `end`, top to bottom, trimmed. */
function textRowsAbove(rows: readonly string[], end: number, count: number): string[] {
  const above: string[] = [];
  for (let i = end - 1; i >= 0 && above.length < count; i--) {
    const row = rows[i].trim();
    if (HAS_TEXT.test(row)) above.push(row);
  }
  return above.reverse();
}

/** The status-shaped rows among `rows`, trimmed and joined, or null. */
function statusRows(rows: readonly string[]): string | null {
  const found = rows.map((row) => row.trim()).filter((row) => TURN_STATUS_ROW.test(row));
  return found.length > 0 ? found.join("\n") : null;
}

/**
 * The rows where a running turn's status row can be: between the previous
 * prompt line (the prompt that started the turn) and the current one. The
 * status row sits right after that prompt's transcript, with whatever is
 * drawn under it — a tip, a todo list of any length, queued messages —
 * between it and the current prompt. Anything older belongs to a finished
 * turn, which leaves no status row behind.
 */
function rowsOfCurrentTurn(
  rows: readonly string[],
  prompt: number,
  line: RegExp,
): readonly string[] {
  const previous = lastRow(rows.slice(0, prompt), line);
  return rows.slice(previous + 1, prompt);
}

/**
 * What a Claude or Codex TUI screen says about readiness.
 *
 * `status`: the status-shaped rows of the current turn — between the
 * previous prompt line and the current one — or null. Claude Code draws its
 * box during a turn too, and Codex its composer, so a running turn shows
 * only here; `foldScan` decides whether they are live.
 *
 * `idle`, beside that status, for Claude: a decision prompt (a permission
 * question or its chevron on a numbered choice), else the prompt-box
 * matcher; `null` when the previous input line is not on the screen. For Codex: the last
 * chevron — the composer, however long its draft, or a decision's selected
 * choice — with no transcript entry below it (a past prompt, not the
 * composer); with no chevron, a decision prompt. The dictation gate's
 * `matchesCodexComposerIdle` is not reused: it also refuses a chevron far
 * from the bottom and scans draft rows for status phrases, both of which
 * would call an unsent draft a running turn.
 *
 * `signature` is the text above the prompt: up to 8 rows that have a letter
 * or a digit, directly above the last prompt line. The prompt line, a draft
 * under it and the footer are left out, and so are glyph-only rows, so an
 * idle screen that animates keeps its signature. Codex streaming an answer
 * with no status line changes it, and Terminal counts that as activity.
 */
export function readinessProbe(
  kind: "claude" | "codex",
  screen: readonly string[],
): { idle: boolean | null; status: string | null; signature: string; waiting: boolean; background: boolean; running: boolean } {
  const rows = settledTail(screen, screen.length);
  const tail = settledTail(rows, TAIL_ROWS);
  const promptLine = kind === "claude" ? CLAUDE_INPUT_LINE : CODEX_COMPOSER_LINE;
  const prompt = lastRow(rows, promptLine);
  const status = statusRows(prompt < 0 ? tail : rowsOfCurrentTurn(rows, prompt, promptLine));
  let idle: boolean | null;
  let waiting = false;
  let running = false;
  if (kind === "claude") {
    // Terminal reads the visible page only. When the prompt that started
    // this turn is not on it, the spinner can be above the page (a tall todo
    // list pushes it off), so the box alone does not say idle (`null`): a
    // changed signature or the running signs (`running`, below) decide, not
    // bytes alone — an idle screen redraws as the member types (B3). Codex is not judged this way — its idle composer
    // animates — and draws its status right above the composer.
    const text = tail.join("\n");
    running = claudeTurnRunning(text);
    const turnStartVisible = prompt >= 0 && lastRow(rows.slice(0, prompt), CLAUDE_INPUT_LINE) >= 0;
    if (CLAUDE_DECISION.test(text) || CLAUDE_CHOICE_LINE.test(text)) {
      // A permission prompt waits for the user whether or not it kept the
      // composer box, and wherever this turn started.
      idle = true;
      waiting = true;
    } else {
      idle = matchesClaudePromptBox(text) ? (turnStartVisible ? true : null) : false;
      // 1.169.0 (B3 walk, Windows step 8): Claude 2.1.30x draws its box the
      // whole turn and says the turn runs in its footer ("esc to interrupt")
      // and its spinner line with a timer — no status row of the old shape.
      // A turn the screen shows running is busy, whether or not its start is
      // in view: the header stays Working through the turn, a repaint (a
      // resize, another tile's refit) included.
      if (running) idle = false;
    }
  } else if (prompt >= 0) {
    idle = !rows.slice(prompt + 1).some((row) => CODEX_TRANSCRIPT_ENTRY.test(row));
  } else {
    idle = CODEX_DECISION.test(tail.join("\n"));
    waiting = idle;
  }
  if (kind === "codex" && prompt >= 0 && CODEX_DECISION.test(tail.join("\n"))) waiting = true;
  const signatureEnd = prompt < 0 ? rows.length : kind === "claude" ? withoutChromeAbove(rows, prompt) : prompt;
  return {
    idle,
    status,
    signature: textRowsAbove(rows, signatureEnd, SIGNATURE_ROWS).join("\n"),
    waiting,
    running,
    background: prompt >= 0 && rows.slice(prompt + 1).some((row) => BACKGROUND_WORK.test(row)),
  };
}

/** QoL 1.168 (M3): the CLI's footer, below its prompt, saying something it
 *  started still runs in the background ("1 background task", "2 shells
 *  running", "background terminal running"). No recorded screen names the
 *  exact words, so any footer mention of background work, or a count of
 *  shells or tasks, counts — a close then asks, which is the safe side. */
export const BACKGROUND_WORK = /\bbackground\b|\b\d+\s+(?:shells?|bash(?:es)?|tasks?|terminals?|jobs?)\b/i;
