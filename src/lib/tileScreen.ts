// 1.177.0 Compare: a Claude or Codex tile's drawn screen, read on demand.
// The tile's terminal registers a reader while it is mounted; Compare reads
// it synchronously right before it writes into the tile (the store's flags
// can be 700 ms old). Nothing here writes, logs or keeps the screen's text.
// Pure module state, no Tauri: node-testable.
import {
  CLAUDE_BOX_RULE,
  CLAUDE_RUNNING_WORDS,
  CLAUDE_SPINNER,
  CLAUDE_TURN_DONE,
  choiceMenuInView,
  claudeTurnRunning,
  decisionMatcherFor,
  inputRowHasDraft,
  promptBoxMatcherFor,
  promptInputEmpty,
  settledTail,
  turnDoneAboveComposer,
  type InputCell,
} from "./attention.ts";
import { readinessProbe } from "./tileHeaderStatus.ts";
import { isWindows } from "./platform.ts";

/** What the screen shows now. `null` for any field the screen can't say. */
export interface TileScreenNow {
  /** The settled 20-row tail of the visible screen. */
  tail: string;
  /** The settled 40-row tail the scan gives `tileScreenBlock`. */
  blockTail: string;
  /** The CLI's prompt box is drawn and idle. */
  promptIdle: boolean | null;
  /** The input row holds text the member typed. */
  draft: boolean | null;
  /** A turn is running on screen. */
  working: boolean | null;
  /** A question or permission is drawn (the CLI's own matcher). */
  decision: boolean | null;
  /** Codex's transcript search is drawn over the composer. */
  overlay: boolean;
  /** Claude only: the screen proves the last turn is over (`claudeTurnOver`);
   *  null for Codex or when the screen can't say. */
  turnOver?: boolean | null;
  /** 1.177.1: the screen positively shows the CLI's idle box, ready for text
   *  (`BoxProof.ready`); absent: not read. */
  readyBox?: boolean | null;
  /** 1.177.1: the CLI's box is what the screen's bottom shows (`BoxProof.drawn`). */
  boxDrawn?: boolean | null;
  /** Round 3 (M2): `BoxProof.idleShape`. */
  boxIdle?: boolean | null;
  /** Round 5: `BoxProof.askedShape`. */
  boxAsked?: boolean | null;
  /** Round 9: `BoxProof.boxMode`. */
  boxMode?: boolean | null;
  /** When the tile last printed (epoch ms); null when not known. */
  lastOutputAt: number | null;
  /** When the tile's screen last changed by output that was not its own
   *  resize redraw (`workStamp`); null when not known. */
  lastWorkOutputAt?: number | null;
  /** When the member last typed into this tile (epoch ms; 0 never): keys and
   *  pastes through xterm, and their writes that go straight to the PTY
   *  (`noteTileInput`: a dropped file's path, a `/rename`, a command typed
   *  for them). */
  lastInputAt: number;
  /** Round 8 (review M1): when output last changed what the tile draws, once
   *  xterm has drawn it — resize redraws included (no discount: an echo drawn
   *  right after the grid refitted is still the echo). Null: never. */
  lastDrawnAt?: number | null;
  /** Whether the composer holds this pasted text (Codex only). */
  holds: (text: string) => boolean | null;
}

const readers = new Map<string, () => TileScreenNow | null>();
const outputReaders = new Map<string, () => number | null>();
const inputNoters = new Map<string, () => void>();

/** Round 8 (review M2): the member's own text went into the tile's PTY by a
 *  path other than xterm's input (a dropped file's path, a command typed for
 *  them): it counts as their typing (`lastInputAt`). Never Compare's writes. */
export function noteTileInput(tileId: string): void {
  try {
    inputNoters.get(tileId)?.();
  } catch {
    // nothing to note
  }
}

/** The tile's terminal can be read until the returned function is called.
 *  `lastOutputAt` reads only the tile's last output stamp, cheaply (no
 *  screen is read for it). */
export function registerTileScreen(
  tileId: string,
  read: () => TileScreenNow | null,
  lastOutputAt?: () => number | null,
  noteInput?: () => void,
): () => void {
  readers.set(tileId, read);
  if (lastOutputAt) outputReaders.set(tileId, lastOutputAt);
  if (noteInput) inputNoters.set(tileId, noteInput);
  return () => {
    if (readers.get(tileId) === read) readers.delete(tileId);
    if (lastOutputAt && outputReaders.get(tileId) === lastOutputAt) outputReaders.delete(tileId);
    if (noteInput && inputNoters.get(tileId) === noteInput) inputNoters.delete(tileId);
  };
}

/** When the tile last printed (epoch ms), or null when not known. */
export function tileLastOutputAt(tileId: string): number | null {
  try {
    const own = outputReaders.get(tileId)?.();
    if (own !== undefined) return own;
    return readers.get(tileId)?.()?.lastOutputAt ?? null;
  } catch {
    return null;
  }
}

/** The tile's screen now, or null when no live terminal can be read. */
export function tileScreenNow(tileId: string): TileScreenNow | null {
  try {
    return readers.get(tileId)?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether a turn is running, from the readiness probe of the drawn screen:
 * true on a running sign, a status row or a box that is not idle; null when
 * the box is drawn and nothing shows work but the turn's start is off the
 * visible page (Claude).
 */
export function liveWorking(probe: { running: boolean; idle: boolean | null; status?: string | null }): boolean | null {
  // Codex draws `• Working (1s • esc to interrupt)` above its box while the
  // box itself still reads idle: a status row of the current turn is work.
  if (probe.running || probe.idle === false || (probe.status ?? null) !== null) return true;
  // Claude's `idle: null`: the box is drawn but the line that started the
  // turn (and a spinner above a tall todo list) is off the page — unknown.
  // The guard accepts it only when the backend says the conversation is known
  // and its turn is not open (`deliveryGate`).
  return probe.idle === null ? null : false;
}

/** What a drawn Claude or Codex screen says, from its visible rows (the
 *  terminal's own reader uses it, and the tests pin it on real captures; the
 *  settled scan computes its own flags). `cells`: the input row's cells where the buffer can
 *  say which are the CLI's dim placeholder and which are typed text. */
export function liveScreenFacts(
  vendor: "claude" | "codex",
  rows: readonly string[],
  cells: readonly InputCell[] | null,
): Pick<TileScreenNow, "tail" | "blockTail" | "promptIdle" | "draft" | "working" | "decision" | "turnOver" | "readyBox" | "boxDrawn" | "boxIdle" | "boxAsked" | "boxMode"> {
  const tail = settledTail(rows, 20).join("\n");
  const probe = readinessProbe(vendor, rows);
  const emptyNow = promptInputEmpty(vendor, tail);
  const box = boxProof(vendor, rows);
  return {
    tail,
    blockTail: settledTail(rows, 40).join("\n"),
    promptIdle: promptBoxMatcherFor(vendor)(tail),
    draft: emptyNow ? false : cells ? inputRowHasDraft(cells) : null,
    // Round 9: Claude's box drawn with a turn running on screen — at 35
    // columns its footer's words are cut (`· es…`) where the probe can't read them.
    working: vendor === "claude" && box.running === true ? true : liveWorking(probe),
    // A numbered menu is never an idle box: the decision matcher and the
    // choice-menu shape both count.
    decision:
      decisionMatcherFor(vendor)(tail) ||
      choiceMenuInView(vendor, tail) ||
      (vendor === "codex" && codexPickerOpen(rows)) ||
      (vendor === "claude" && claudePickerOpen(rows)) ||
      box.asks === true,
    turnOver: vendor === "claude" ? box.turnOver : null,
    readyBox: box.ready,
    boxDrawn: box.drawn,
    boxIdle: box.idleShape,
    boxAsked: box.askedShape,
    boxMode: box.boxMode === true,
  };
}

/**
 * What a drawn screen proves of the CLI's own input box (1.177.1, items 18
 * and 4/16). Compare writes into a tile only on POSITIVE proof of its idle
 * box (`ready`); anything it doesn't recognise — an unknown menu, a picker, a
 * half-drawn frame, a narrow tile whose footer it can't read — is no proof.
 *  - `drawn`: the box's shape is the bottom of the screen (what the member
 *    typed may be in it). False: whatever is drawn is not the CLI's box.
 *  - `ready`: the box is drawn, holds one row, its footer is the CLI's idle
 *    footer, and nothing on screen shows a turn running.
 *  - `turnOver` (Claude): the box is drawn, nothing shows a turn running,
 *    and the last row above it is how a turn ends (`turnEndRow`).
 */
export interface BoxProof {
  drawn: boolean;
  ready: boolean;
  turnOver: boolean;
  /** Round 3 (M2), Codex: its box and idle footer with nothing running and
   *  no prompt of the member's right above it, whatever else is above (a
   *  slash command's output: `/status`, `/model` then Esc). Proof only with
   *  the rollout's word that no turn is open (`deliveryGate`). Claude: `ready`. */
  idleShape: boolean;
  /** Round 5, Codex: the same shape with a prompt of the member's as the
   *  first row at the first column above the box (`codexJustAsked`). Either a
   *  turn just started, or — final Mac walk 2026-11-26, step 6 — an earlier
   *  prompt's row left at the top over a slash command's output once a resize
   *  scrolled that output's echo off (pinned by Codex or left over: the rule
   *  doesn't depend on which). The guard tells them apart by the member's
   *  input (`deliveryGate`). */
  askedShape: boolean;
  /** 1.179.0, Claude on Windows with its footer lost: a question drawn above
   *  the box since the last finished turn (`claudeFooterLostProof`). */
  asks?: boolean;
  /** Round 9, Claude: its box with one row and its mode line, nothing running
   *  anywhere on screen, whatever is above (see `claudeBoxProof`). */
  boxMode?: boolean;
  /** Round 9, Claude: its box is drawn and the screen shows a turn running
   *  (its footer's running words, cut short or not; a spinner after the last
   *  finished turn; `⎿ Running…`). */
  running?: boolean;
}
const NO_BOX: BoxProof = { drawn: false, ready: false, turnOver: false, idleShape: false, askedShape: false, boxMode: false };

/** Claude's box rules: the top one may carry the session's name once the
 *  session is named (`──────── add-notes-list-title ─`, Windows walk
 *  2026-11-25); the bottom one never does. A pre-2.1 rounded box too. */
const CLAUDE_TOP_RULE = /^\s*(?:╭[─━]{2,}.*╮|[─━]{8,}(?:\s+\S.*?\s+[─━]+)?)\s*$/;
const CLAUDE_BOTTOM_RULE = /^\s*(?:╰[─━]{2,}╯|[─━]{8,})\s*$/;
/** The box's first row: the chevron, alone or with text (placeholder, draft). */
const CLAUDE_BOX_INPUT = /^[\s│|]*[>❯](?:\s.*)?$/;
/** Claude's idle footer always says how to change mode or ask for help:
 *  `⏵⏵ auto mode on (shift+tab to cycle)`, `⏸ manual mode on · ? for
 *  shortcuts`, `⏸ plan mode on (shift+tab to cycle)` (2.1.33x captures);
 *  text typed in the box takes the hint away. */
const CLAUDE_IDLE_FOOTER = /\(shift\+tab to cycle\)|\? for shortcuts/i;
/** A footer that is not the idle one: a running turn's words ("esc to
 *  interrupt", "ctrl+b to run in background", queued messages). */
const CLAUDE_FOOTER_NOT_IDLE = /esc to interrupt|ctrl\+b|queued/i;
/** Any other `esc` in the footer (`esc again to clear`): not a turn, but no
 *  idle footer either. */
const CLAUDE_FOOTER_ESC = /\besc\b/i;
/** Round 9 (narrow capture walk, 35 columns): Claude cuts its footer's last
 *  part short with `…` when it doesn't fit — a running turn's `· esc to
 *  inter…` / `· 1 shell · es…`, a closed turn's `· 1 shell · ↓ …`. A cut part
 *  that could be the start of a running turn's words (or nothing left at
 *  all) counts as them. */
const CLAUDE_RUNNING_PHRASES = ["esc to interrupt", "ctrl+b to run in background", "press up to edit queued messages"];
function claudeFooterRunning(footerText: string): boolean {
  if (CLAUDE_FOOTER_NOT_IDLE.test(footerText)) return true;
  const parts = footerText.trim().split(/\s+·\s+/);
  const last = parts[parts.length - 1] ?? "";
  if (!last.endsWith("…")) return false;
  const stub = last.slice(0, -1).trim().toLowerCase();
  return stub === "" || CLAUDE_RUNNING_PHRASES.some((p) => p.startsWith(stub));
}
/** Round 9: Claude's mode line, the first part of its footer at any width
 *  (`⏵⏵ auto mode on`, `⏸ manual mode on`, `⏵⏵ accept edits on`, `⏸ plan
 *  mode on`), whatever follows it (` · 1 shell · ↓ …`, its hint). */
const CLAUDE_MODE_FOOTER = /^(?:⏵⏵|⏸)\s+[a-z][a-z ]*\bon\b/i;
/** A spinner row after the screen's last finished turn: a turn running, its
 *  spinner anywhere between that turn's prompt and the box (a tip or todo
 *  rows under it), timer or not (`✶ Caramelizing… (thought for 1s)`). */
function claudeSpinnerAfterLastDone(rows: readonly string[], top: number): boolean {
  let from = 0;
  for (let i = top - 1; i >= 0; i--) {
    if (CLAUDE_TURN_DONE.test(rows[i])) {
      from = i + 1;
      break;
    }
  }
  for (let i = from; i < top; i++) if (CLAUDE_SPINNER.test(rows[i])) return true;
  return false;
}
/** The most rows Claude's footer takes under the box: the mode line, a
 *  right-aligned line (`◐ medium · /effort`, `✔ Update installed`), wraps. */
const CLAUDE_FOOTER_MAX = 4;
/** How a turn ends, as the last row above the box: its `· done` line
 *  (`✻ Brewed for 2s · done 9:20 AM`), Esc's `⎿ Interrupted · What should
 *  Claude do instead?`, or an error that ended it (`● Login reached its time
 *  limit · Please run /login`, Windows walk 2026-11-24; `API Error`). */
const CLAUDE_TURN_ERROR_END = /^\s*⎿\s+API Error\b|^\s*[⏺●]\s.*·\s*Please run \/login\b/i;
/** Review round 1 (M1): Claude's retry row (`⎿  API Error (Connection
 *  error.) · Retrying in 4 seconds… (attempt 2/10)`) is printed while the
 *  turn goes on: never its end. */
const CLAUDE_RETRY_ROW = /retrying|attempt \d+\s*\/\s*\d+/i;
/** A row Claude draws at the margin for the member's own prompt (`❯ …`):
 *  where the turn that ends above the box started. */
const CLAUDE_PROMPT_ECHO = /^❯\s+\S/;
const CLAUDE_TURN_INTERRUPTED_END = /^\s*⎿\s*Interrupted\b/;
/** Claude's notices right above its box (`Your login expires in 1 day · run
 *  /login to renew`, `Not logged in · run /l… · ✓ Update installed`): never
 *  a turn's own row. */
const CLAUDE_NOTICE_ROW = /\/l(?:ogin\b|…)|\/restart\b|update installed|\/effort\b|restart to|expires in/i;

/** A narrow tile's mode footer with no hint: `⏵⏵ auto mode on`, `⏸ manual
 *  mode on`, `⏵⏵ accept edits on`, `⏸ plan mode on`. */
const CLAUDE_BARE_MODE_FOOTER = /^(?:⏵⏵|⏸)\s+[a-z][a-z ]*\bon$/i;

/** The last rows above the box are a local command's result: a `⎿` row (and
 *  its indented rows) right under the member's `❯ /command` at the first
 *  column — no turn (`/model` then Esc: `⎿ Kept model as Fable 5.2`). */
function claudeCommandResultAbove(rows: readonly string[], top: number): boolean {
  let i = top - 1;
  while (i >= 0 && rows[i].trim() === "") i--;
  let sawResult = false;
  for (; i >= 0; i--) {
    const r = rows[i];
    if (/^\s*⎿/.test(r)) {
      sawResult = true;
      continue;
    }
    if (/^❯\s*\//.test(r)) return sawResult;
    if (/^\s/.test(r) && r.trim() !== "") continue;
    return false;
  }
  return false;
}

/** A wrapped row's continuation: indented, no transcript mark. */
const CLAUDE_CONTINUATION_ROW = /^\s+[^\s⎿⏺●✻✳✢✶·*]/;
/** A turn's done line starts at the first column with its glyph (`✻ Worked …`). */
const CLAUDE_DONE_HEAD = /^[✻✳✢✶·*]\s+[A-Z]/;

function claudeTurnEndRow(rows: readonly string[], top: number): boolean {
  let i = top - 1;
  let notices = 0;
  for (; i >= 0; i--) {
    const r = rows[i];
    if (r.trim() === "") continue;
    if (notices < 2 && !/^\s*[⏺●⎿✻✳✢✶·*]/.test(r) && CLAUDE_NOTICE_ROW.test(r)) {
      notices++;
      continue;
    }
    break;
  }
  if (i < 0) return false;
  let r = rows[i];
  // Round 11 (review round 7, L1): a narrow tile wraps the end row (real
  // `claude-35-turn-closed-bg-shell`: `✻ Worked for 4s · done 12:23 PM · 1` /
  // `  shell still running`). Its continuation rows are indented with no mark;
  // up to two are joined to the row that starts it. A joined done line must
  // start with the done glyph at the first column, so an answer's wrapped prose
  // ("…ran for 4s · done") is never one.
  let head = i;
  while (head > 0 && i - head < 2 && CLAUDE_CONTINUATION_ROW.test(rows[head]) && rows[head - 1].trim() !== "") head--;
  if (head < i && !CLAUDE_CONTINUATION_ROW.test(rows[head])) {
    const joined = [rows[head], ...rows.slice(head + 1, i + 1).map((x) => x.trim())].join(" ");
    if (CLAUDE_DONE_HEAD.test(rows[head]) && CLAUDE_TURN_DONE.test(joined)) return true;
    if (/^\s*⎿/.test(rows[head]) || /^\s*[⏺●]\s/.test(rows[head])) {
      r = joined;
      i = head;
    }
  }
  // A done line is the row that starts with its glyph (an answer row that
  // says "…for 4s · done" is not one).
  if (CLAUDE_DONE_HEAD.test(r) && CLAUDE_TURN_DONE.test(r)) return true;
  // A wrapped error row whose second half reads like a notice (`● Login
  // reached its time limit ·` / `  Please run /login`): joined again.
  if (/^\s*[⏺●⎿]/.test(r) && i + 1 < top && CLAUDE_CONTINUATION_ROW.test(rows[i + 1])) {
    r = `${r} ${rows[i + 1].trim()}`;
  }
  if (CLAUDE_RETRY_ROW.test(r)) return false;
  if (!CLAUDE_TURN_INTERRUPTED_END.test(r) && !CLAUDE_TURN_ERROR_END.test(r)) return false;
  // An interruption or an error ends the turn only with no spinner above it
  // in that turn (up to its prompt, or the previous turn's `done` line): a
  // spinner over the row means the turn went on (review round 1, M1).
  for (let j = i - 1; j >= 0; j--) {
    if (CLAUDE_PROMPT_ECHO.test(rows[j]) || CLAUDE_TURN_DONE.test(rows[j])) break;
    if (CLAUDE_SPINNER.test(rows[j])) return false;
  }
  return true;
}

/** `BoxProof` of a Claude Code screen (its visible rows). */
export function claudeBoxProof(screen: readonly string[]): BoxProof {
  const rows = settledTail(screen, screen.length);
  // 1.179.0 Windows walk (step 7): the box with blank rows under its bottom
  // rule (`claudeFooterLostProof`), on Windows only: on the Mac that shape is
  // a frame read halfway through a redraw, never proof. A bottom rule on the
  // screen's last row says nothing (its footer may be below the view): no
  // box, as before.
  if (
    isWindows() &&
    rows.length >= 3 &&
    rows.length < screen.length &&
    CLAUDE_BOTTOM_RULE.test(rows[rows.length - 1])
  ) {
    return claudeFooterLostProof(rows);
  }
  // The footer: the rows under the box's bottom rule, at most a few.
  let bottom = rows.length - 1;
  while (bottom >= 0 && rows.length - 1 - bottom < CLAUDE_FOOTER_MAX && !CLAUDE_BOTTOM_RULE.test(rows[bottom])) bottom--;
  if (bottom < 2 || bottom === rows.length - 1 || !CLAUDE_BOTTOM_RULE.test(rows[bottom])) return NO_BOX;
  const footer = rows.slice(bottom + 1);
  if (footer.some((r) => /^[\s│|]*[>❯›]/.test(r) || /^\s*\d+\.\s/.test(r) || CLAUDE_BOX_RULE.test(r))) return NO_BOX;
  // The box: its first row is the chevron's, right under the top rule; a
  // draft of several lines has more rows (at most a screenful, ~12).
  let top = -1;
  for (let i = bottom - 1; i >= Math.max(0, bottom - 12); i--) {
    if (CLAUDE_TOP_RULE.test(rows[i])) {
      top = i;
      break;
    }
  }
  if (top < 0 || top + 1 >= bottom || !CLAUDE_BOX_INPUT.test(rows[top + 1])) return NO_BOX;
  const footerText = footer.join(" ").replace(/\s+/g, " ");
  const tail = settledTail(rows, 20).join("\n");
  const running =
    claudeFooterRunning(footerText) ||
    rows.some((r) => CLAUDE_RUNNING_WORDS.test(r)) ||
    claudeTurnRunning(tail) ||
    claudeSpinnerAfterLastDone(rows, top);
  const quiet = !running && !CLAUDE_FOOTER_ESC.test(footerText);
  const turnOver = quiet && claudeTurnEndRow(rows, top);
  // Round 7 (final walk 2, step 15, real 35-column frame): a narrow tile's
  // footer loses its hint (`  ⏵⏵ auto mode on`) — the same footer a box with
  // text in it has, and, unmeasured, perhaps a running turn's. It proves the
  // box idle only with the rest of the proof the hint stood for: a turn's end
  // right above the box, or a local command's result (`❯ /model` over
  // `⎿ Kept model as …`); the box's text is the draft check's.
  const bareMode = CLAUDE_BARE_MODE_FOOTER.test(footerText.trim());
  const ready =
    quiet &&
    top + 2 === bottom &&
    (CLAUDE_IDLE_FOOTER.test(footerText) || (bareMode && (turnOver || claudeCommandResultAbove(rows, top))));
  // Round 9: the box itself — one row between its rules, Claude's mode line
  // as its footer — with nothing running anywhere on screen, whatever sits
  // above it (the plan Esc left there, a background shell's turn closed with
  // its done line wrapped). Proof only with the transcript's word that no turn
  // is open, or the screen's that the last one ended (`deliveryGate`).
  const boxMode = quiet && top + 2 === bottom && CLAUDE_MODE_FOOTER.test(footerText.trim());
  return { drawn: true, ready, turnOver, idleShape: ready, askedShape: false, boxMode, running };
}

/**
 * 1.179.0 Windows walk (step 7, screenshots of Claude Code 2.1.332 in a
 * ConPTY): when a tile shrinks (the Compare composer's preview opens), ConPTY
 * drops the rows under Claude's cursor, which sits in its box, and Claude
 * doesn't draw its footer again: the box stays with blank rows under its
 * bottom rule, also once the tile grows back. With no footer `ready` can't be
 * proven, and the box read as no box at all ("Can't tell if Claude is ready")
 * however long the member waited or clicked. `rows` end with the bottom rule;
 * the screen had blank rows under it.
 *
 * The box counts as drawn (the draft check reads it), never `ready` or
 * `turnOver` (the footer and the end row are what proved those). One row
 * between its rules with nothing running anywhere on screen is `boxMode`:
 * proof only with the transcript's word that no turn is open
 * (`deliveryGate`, `claudeModeProof`) — the open turn a lost footer might
 * have shown running is refused there. A numbered row in the box is a menu,
 * never the box.
 */
function claudeFooterLostProof(rows: readonly string[]): BoxProof {
  const bottom = rows.length - 1;
  let top = -1;
  for (let i = bottom - 1; i >= Math.max(0, bottom - 12); i--) {
    if (CLAUDE_TOP_RULE.test(rows[i])) {
      top = i;
      break;
    }
  }
  if (top < 0 || top + 1 >= bottom || !CLAUDE_BOX_INPUT.test(rows[top + 1])) return NO_BOX;
  if (/^[\s│|]*[>❯]\s*\d+\.\s/.test(rows[top + 1])) return NO_BOX;
  const tail = settledTail(rows, 20).join("\n");
  const running =
    rows.some((r) => CLAUDE_RUNNING_WORDS.test(r)) || claudeTurnRunning(tail) || claudeSpinnerAfterLastDone(rows, top);
  // Review of the fix: with the footer gone, a question drawn above the box
  // since the last finished turn (a permission's `Do you want to …?`, a
  // plan's `Would you like to proceed?`, a numbered choice) is the screen
  // asking, which the matchers miss (the box's chevron is the last one).
  let from = 0;
  for (let i = top - 1; i >= 0; i--) {
    if (CLAUDE_TURN_DONE.test(rows[i])) {
      from = i + 1;
      break;
    }
  }
  const asks = rows
    .slice(from, top)
    .some((r) => /do you want to|would you like to/i.test(r) || /^[\s│|]*❯\s*\d+\.\s/.test(r));
  const boxMode = !running && !asks && top + 2 === bottom;
  return { drawn: true, ready: false, turnOver: false, idleShape: false, askedShape: false, boxMode, running, asks };
}

/**
 * Review B1 (F1), widened in 1.177.1 (item 4/16): positive proof, on every
 * visible row, that Claude's last turn is over — never the mere absence of a
 * spinner: Claude's box is drawn at the bottom with its footer, nothing on
 * screen shows a turn running ("esc to interrupt", queued messages, "ctrl+b",
 * a spinner or `⎿ Running…` above the box), and the last row above the box
 * is how a turn ends — its `· done` line, `⎿ Interrupted`, or an error that
 * ended it (a sign-in or API error). A running turn puts its own prompt row
 * and its spinner there. Anything else is no proof: the open turn stands.
 */
export function claudeTurnOver(screen: readonly string[]): boolean {
  return claudeBoxProof(screen).turnOver;
}

/** Codex's box: the `›` row at the first column (a numbered menu's `› 1.`
 *  is no box); its footer rows indented under it, the idle one ending with
 *  `? for shortcuts` (a long folder wraps it over several rows: Mac walk
 *  2026-11-25); text typed in the box takes that row away. */
const CODEX_BOX_ROW = /^›(?:\s|$)/;
const CODEX_BOX_CHOICE = /^›\s+\d+\.\s/;
const CODEX_FOOTER_NOT_IDLE = /esc to|press enter|enter to|enter select|^\s*\d+\.\s/i;
const CODEX_FOOTER_MAX = 8;
/** How a turn ends above Codex's box: `Worked for 21s • 11:22`, or its
 *  `■` line (`■ Conversation interrupted …`, an error). */
const CODEX_TURN_END_ROW = /^\s*(?:─\s*)?Worked for (?:\d+h\s*)?(?:\d+m\s*)?\d+s\b|^\s*■\s/;
const CODEX_BANNER_ROW = />_ OpenAI Codex\b/;
/** Rows that are no content: blank, Codex 0.154's composer animation, its
 *  braille logo. */
const CODEX_EMPTY_ROW = /^[\s·.•*+˙⠀-⣿]*$/;

/**
 * Round 3 (M2), review round 2 (M1): a prompt of the member's is the last
 * thing above Codex's box, with nothing after it — a turn that has just
 * started and drawn nothing yet. A prompt of several lines (every Compare
 * pass) is a `›` row and its indented rows, blank ones among them: walk up
 * over those to the first row at the first column. A turn's end on the way
 * (`Worked for …`, `■ …`) or an answer row (`• …`) there means the prompt was
 * answered. A slash command's echo (`› /status`) is no turn: its output under
 * it is what the idle shape accepts.
 */
function codexJustAsked(rows: readonly string[], above: number): boolean {
  for (let i = above; i >= 0; i--) {
    const r = rows[i];
    if (CODEX_TURN_END_ROW.test(r)) return false;
    if (r.trim() === "" || /^\s/.test(r)) continue;
    return r.startsWith("›") && !/^›\s*\//.test(r);
  }
  return false;
}

/**
 * `BoxProof` of a Codex screen (its visible rows). Codex draws the same box
 * while it works — streaming an answer, or writing a long patch in silence,
 * hides its status row (review B1) — so the box alone is no proof: above it
 * must be how a turn ends (`Worked for …`, `■ …`), the start screen's banner,
 * or nothing at all on the visible page (the answer scrolled above it, the
 * real X3 screen), and "esc to interrupt" nowhere.
 */
export function codexBoxProof(screen: readonly string[]): BoxProof {
  const rows = settledTail(screen, screen.length);
  let box = -1;
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 1 - CODEX_FOOTER_MAX); i--) {
    if (rows[i].startsWith("›")) {
      box = i;
      break;
    }
  }
  if (box < 0 || !CODEX_BOX_ROW.test(rows[box]) || CODEX_BOX_CHOICE.test(rows[box])) return NO_BOX;
  const footer = rows.slice(box + 1);
  // Under the box only its own indented rows: a row at the first column there
  // means the `›` row is a message in a pager or a menu, not the box.
  if (footer.some((r) => r.trim() !== "" && !/^\s/.test(r))) return NO_BOX;
  const footerText = footer.join(" ").replace(/\s+/g, " ");
  if (CODEX_FOOTER_NOT_IDLE.test(footerText)) return NO_BOX;
  const running = rows.some((r) => /esc to interrupt/i.test(r) || /^• (Working|Booting|Starting)\b/.test(r));
  let above = box - 1;
  while (above >= 0 && CODEX_EMPTY_ROW.test(rows[above])) above--;
  const ended =
    above < 0 ||
    CODEX_TURN_END_ROW.test(rows[above]) ||
    CODEX_BANNER_ROW.test(rows[above]) ||
    (above > 0 && CODEX_BANNER_ROW.test(rows[above - 1]));
  // The idle footer: its model and folder row (wrapped over more rows on a
  // long folder), then the hints ending `? for shortcuts`. Codex's start-up
  // splash draws the hints alone, right before its trust question (real
  // capture codex-0.171-mac-trust-2-splash): no proof.
  const footerRows = footer.filter((r) => r.trim() !== "");
  const idleFooter =
    footerRows.length >= 2 && /\? for shortcuts/i.test(footerRows[footerRows.length - 1]) && !/\? for shortcuts/i.test(footerRows[0]);
  const justAsked = codexJustAsked(rows, above);
  return {
    drawn: true,
    ready: !running && ended && idleFooter,
    turnOver: false,
    idleShape: !running && !justAsked && idleFooter,
    askedShape: !running && justAsked && idleFooter,
    boxMode: false,
  };
}

/**
 * 1.177.1 (item 21, final Mac walk step 16): the live screen proves the
 * tile's last turn over — what the quit guard takes over the header's 2 s
 * quiet window after the answer's last output. Claude: `turnOver` (its box
 * and idle footer, a turn's end the last row above it, nothing running).
 * Codex: its own `Worked for …` the last row above an idle box with its idle
 * footer, nothing running (a silent patch has no such row). Nothing asks.
 */
export function screenProvesTurnOver(
  vendor: "claude" | "codex",
  screen: Pick<TileScreenNow, "tail" | "working" | "decision" | "turnOver" | "readyBox"> | null,
): boolean {
  if (!screen || screen.decision === true || screen.working === true) return false;
  if (vendor === "claude") return screen.turnOver === true;
  return screen.readyBox === true && turnDoneAboveComposer("codex", screen.tail);
}

/** Round 3 (capture walk 2026-11-26, cap 12-c): a Codex picker or menu is
 *  open — its own footer is the screen's last row (`enter select · esc
 *  back`, the `/new` and `/model` pickers; `enter continue · esc back`, the
 *  trust question). Its marked row can be far above the bottom 20 rows (the
 *  `/model` list), out of the decision matchers' reach. */
const CODEX_PICKER_FOOTER = /^\s*enter (?:select|continue|to (?:select|confirm))\b.*\besc (?:back|to cancel|cancel)\b/i;
export function codexPickerOpen(screen: readonly string[]): boolean {
  const rows = settledTail(screen, screen.length);
  return rows.length > 0 && CODEX_PICKER_FOOTER.test(rows[rows.length - 1]);
}

/** Round 9 (narrow capture walk, cap 5): Claude's picker or menu is open — its
 *  marked numbered row is the last `❯` row with no box rule under it, and its
 *  own footer (`… Enter to save · Esc to cancel`, `Esc to cancel · Tab to
 *  amend`, wrapped over the last rows) ends the screen. At 35 columns the
 *  `/model` options wrap so far apart that no sibling is within the decision
 *  matchers' reach. Compare only. */
export function claudePickerOpen(screen: readonly string[]): boolean {
  const rows = settledTail(screen, screen.length);
  let chevron = -1;
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 40); i--) {
    if (/^[\s│|]*❯/.test(rows[i])) {
      chevron = i;
      break;
    }
  }
  if (chevron < 0 || !/^[\s│|]*❯\s*\d+\.\s/.test(rows[chevron])) return false;
  if (rows.slice(chevron + 1).some((r) => CLAUDE_BOTTOM_RULE.test(r))) return false;
  const lastRows = rows
    .slice(-3)
    .filter((r) => r.trim() !== "")
    .join(" ")
    .replace(/\s+/g, " ");
  return /\besc to cancel\b/i.test(lastRows);
}

/** `BoxProof` for a vendor. */
export function boxProof(vendor: "claude" | "codex", screen: readonly string[]): BoxProof {
  return vendor === "claude" ? claudeBoxProof(screen) : codexBoxProof(screen);
}

/** Review H1: output this tile prints right after its own size changed, or
 *  inside its refit window, is the CLI repainting for the new size, not
 *  work: it doesn't restart the quiet clock Compare reads (`RESIZE_SETTLE_MS`
 *  after a real change of rows or columns, Claude's reflow included). */
export const REDRAW_AFTER_RESIZE_MS = 5_000;
export function outputIsRedraw(at: number, rebaselineUntil: number, sizeChangedAt: number): boolean {
  return at < rebaselineUntil || (sizeChangedAt > 0 && at - sizeChangedAt < REDRAW_AFTER_RESIZE_MS);
}

/** Walk round 4: the stamp Compare's quiet clock reads, after a batch xterm
 *  has drawn — moved only when the batch changed what the tile shows and was
 *  not its own resize redraw (a focus change's re-sent modes, the same screen
 *  painted again: no work). */
export function workStamp(prev: number, at: number, screenChanged: boolean, rebaselineUntil: number, sizeChangedAt: number): number {
  return screenChanged && !outputIsRedraw(at, rebaselineUntil, sizeChangedAt) ? at : prev;
}

/** The most rows a Codex scan walks up from the bottom looking for its last
 *  banner; past it the answer is "not the start screen" (no flag). */
export const CODEX_SCAN_CAP = 2000;

const CODEX_BANNER = ">_ OpenAI Codex (v";
/** A live status row (`• Working (1s • esc to interrupt)`, `• Booting MCP
 *  server …`): drawn above the box and gone after, never an answer. */
const CODEX_STATUS_ROW = /esc to interrupt\)|^• Working \(|^• (Booting|Starting)\b/;

/** An answer's own row: a `• ` at the first column that is no status row, or
 *  the `Worked for` row. Indented rows are a box's continuation, never one. */
function codexTurnRow(row: string): boolean {
  if (row.startsWith("• ")) return !CODEX_STATUS_ROW.test(row);
  return row.trimStart().startsWith("Worked for");
}

/**
 * What the buffer says of a Codex tile's conversation, read from the bottom
 * up to the LAST banner row (old turns above it, kept in the scrollback, never
 * count) and lazily — only the rows walked are read.
 *  - `turn`: between that banner and the box (the last row that starts with
 *    `› ` at the first column) there is an answer row or a `Worked for` row.
 *  - `start`: the start screen: that banner, its folder row, then only blank
 *    rows or Codex's logo art to the box, the box is no numbered menu, and
 *    under it only its footer with the `? for shortcuts` row. A banner out of reach (`cap`) or any other row
 *    below it is not the start screen.
 * No box (a cleared terminal) says nothing. Codex 0.171+ draws on the
 * alternate screen all the time, so the scan runs on either buffer.
 */
export function codexScreenFacts(
  count: number,
  read: (i: number) => string,
  cap: number = CODEX_SCAN_CAP,
): { turn: boolean; start: boolean } {
  let box = -1;
  let banner = -1;
  let turn = false;
  for (let i = count - 1, lo = Math.max(0, count - cap); i >= lo; i--) {
    const r = read(i);
    if (box < 0) {
      if (r.startsWith("›")) box = i;
      continue;
    }
    if (r.trimStart().startsWith(CODEX_BANNER)) {
      banner = i;
      break;
    }
    // A turn settles it (never the start screen): no need to reach the banner.
    if (codexTurnRow(r)) {
      turn = true;
      break;
    }
  }
  if (box < 0) return { turn: false, start: false };
  if (banner < 0 || turn || /^›\s+\d+\.\s/.test(read(box))) return { turn, start: false };
  // Between the folder row and the box: blank rows, or Codex's logo (braille
  // art, drawn when the tile is tall enough: 0.171 and 0.172).
  for (let i = banner + 2; i < box; i++) if (!/^[\s\u2800-\u28ff]*$/.test(read(i))) return { turn, start: false };
  // Under the box only its footer: an answer row there means that `›` row is a
  // message in Codex's transcript pager, not the box (Codex 0.171+ draws on the
  // alternate screen all the time, so the buffer kind can't tell them apart).
  // Review round 3: and the box is known by its own footer — the empty box's
  // `? for shortcuts` row under it (in every real start screen; a long
  // folder wraps the footer over several rows: Mac walk, 2026-11-25), nothing at the first column there. A long message at the top of
  // the pager has neither. A draft hides that row: no flag until the files say.
  let footer = false;
  for (let i = box + 1; i < count; i++) {
    const r = read(i);
    if (codexTurnRow(r) || (r.trim() !== "" && !/^\s/.test(r))) return { turn, start: false };
    if (r.includes("? for shortcuts")) footer = true;
  }
  return { turn, start: footer };
}

/** `codexScreenFacts` on rows already in hand. */
export function codexTurnInBuffer(rows: readonly string[]): boolean {
  return codexScreenFacts(rows.length, (i) => rows[i]).turn;
}
export function isCodexStartScreen(rows: readonly string[]): boolean {
  return codexScreenFacts(rows.length, (i) => rows[i]).start;
}
