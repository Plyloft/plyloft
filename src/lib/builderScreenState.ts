/**
 * 1.176.2 (A5F-01) and 1.176.3 phase 2: whether a Builder session no
 * terminal of the window shows (its card page gone, or never opened) is at
 * work or waits for the person, for the quit guard and "Install when my
 * work is done" — judged from its screen with the card terminal's own
 * matchers (`attention.ts`), on the rows the backend draws of it
 * (`builder_session_screens`, `builder_screens.rs`) and the time the rows
 * above its composer last changed.
 *
 * Measured on the 2026-11-23 walks (Claude Code 2.1.330 and Codex 0.171, on
 * the Mac and on ConPTY, every 5 s through a real turn each, the card off
 * screen; frames in `src-tauri/src/builder_screens_fixtures/`):
 *
 * - **A question in view** (an approval, a permission question, any menu of
 *   numbered choices: the trust question, Bypass, the usage limit): waiting.
 * - **A turn running** (Claude's spinner or running tool, Codex's
 *   `Working (… esc to interrupt)`): working. While those lines are drawn
 *   their timer ticks every second, so in every turn recorded the content
 *   above the composer never held still for more than one 450 ms frame. But
 *   Codex 0.171 hides its status line while it streams an answer (and, the
 *   phase 2 review warns, may while it writes a long tool call: unrecorded).
 *   A turn line whose content has not changed for `OFF_SCREEN_HUNG_MS` is a
 *   hung screen, not a turn (review round 2, M2b: a frozen status line, or a
 *   finished answer that quotes "esc to interrupt"): 1.176.2's byte rule
 *   decides it, so it is never counted less carefully than 1.176.2 did.
 * - **At its prompt** (review MF1): nothing only with proof the turn ended —
 *   its own done line (`✻ Churned for 9s · done …`, `Worked for 21s • …`)
 *   is the last row with text above the composer — once both the content
 *   above the composer and its output have been still for
 *   `OFF_SCREEN_SETTLE_MS`. The idle shape alone proves nothing: mid-turn
 *   Codex 0.171 frames read as its idle composer (the fixtures'
 *   `*-streaming` frames). Without the done line (a silent phase mid-turn, a
 *   first prompt, a tip under the done line) and for **a screen no matcher
 *   knows**: working while its content changed in the last 10 s, then
 *   1.176.2's 2-minute byte rule. Codex's animated composer and the rows of
 *   glyphs just above it never count as content
 *   (`builder_screen_judge::content_rows`); Codex 0.171 prints nothing when
 *   idle, so it lets go about 10–12 s after its turn (owner decision 1,
 *   2026-11-23). 0.154's animated composer prints, so it holds by the byte
 *   rule as in 1.176.2.
 * - **No screen** (an older backend, nothing drawn yet): 1.176.2's rule —
 *   at work while it printed in the last `OFF_SCREEN_WORKING_MS`. No reading
 *   at all, or a failed one, is the caller's (`workingNow`): at work.
 * - **Process ended**: nothing.
 *
 * Pure — no React, no store. The rows are the person's screen: nothing here
 * logs or keeps them; `why` names states and times only.
 */
import {
  choiceMenuInView,
  codexOverlayOpen,
  decisionMatcherFor,
  settledTail,
  turnDoneAboveComposer,
  turnIdleMatcherFor,
  turnRunningMatcherFor,
} from "./attention.ts";

/** 1.176.2's rule: how long after its last output a session whose screen
 *  can't be read still counts as at work. */
export const OFF_SCREEN_WORKING_MS = 2 * 60_000;
/** An idle-looking or unknown screen counts as at work while the content
 *  above its composer changed this recently (the on-screen `SILENCE_MS`).
 *  Every turn recorded changed its content at least once a second; two of
 *  the hidden window's 5 s polls fit in it. */
export const OFF_SCREEN_SETTLE_MS = 10_000;
/** A turn line whose screen content has not changed for this long is a hung
 *  screen, not a turn: a live turn ticks its timer every second. */
export const OFF_SCREEN_HUNG_MS = 5 * 60_000;
/** The rows judged: the settled tail, as the card terminal's prompt scan
 *  reads it (`BuilderSession`'s `PROMPT_BOX_TAIL_ROWS`). */
const SCAN_ROWS = 20;

/** What a Builder's screen shows, read with `attention.ts`. */
export type BuilderScreenRead = "asking" | "running" | "idle" | "unknown";

/** The screen `rows` of a `vendor` Builder, as the card terminal would read
 *  them; null when nothing is drawn. */
export function readBuilderScreen(vendor: string, rows: readonly string[]): BuilderScreenRead | null {
  const tail = settledTail(rows, SCAN_ROWS).join("\n");
  if (tail.trim() === "") return null;
  if (decisionMatcherFor(vendor)(tail) || choiceMenuInView(vendor, tail)) return "asking";
  if (turnRunningMatcherFor(vendor)(tail)) return "running";
  if (turnIdleMatcherFor(vendor)(tail) && !(vendor === "codex" && codexOverlayOpen(tail))) return "idle";
  return "unknown";
}

/** A session no terminal shows, as `builder_session_screens` reads it
 *  (`BuilderSessionScreen`). `rows` and `contentChangedAt` are missing from
 *  an older backend's answer. */
export interface OffScreenSession {
  vendor?: string;
  exited: boolean;
  lastOutputAt: number | null;
  rows?: readonly string[];
  contentChangedAt?: number | null;
}

export interface OffScreenJudgement {
  state: "working" | "waiting" | null;
  /** States and times only — never screen text (it goes to the log). */
  why: string;
}

const seconds = (ms: number) => `${Math.round(Math.max(0, ms) / 1000)}s`;

export function offScreenJudgement(s: OffScreenSession, now: number): OffScreenJudgement {
  if (s.exited) return { state: null, why: "its process ended" };
  const byOutput = (said: string): OffScreenJudgement => {
    if (s.lastOutputAt != null && now - s.lastOutputAt < OFF_SCREEN_WORKING_MS) {
      return { state: "working", why: `${said}, printed ${seconds(now - s.lastOutputAt)} ago` };
    }
    return { state: null, why: `${said}, nothing printed for 2 minutes` };
  };
  if (!Array.isArray(s.rows)) return byOutput("screen not read");
  const read = readBuilderScreen(s.vendor ?? "", s.rows);
  if (read === null) return byOutput("nothing drawn");
  if (read === "asking") return { state: "waiting", why: "a question in view" };
  // A first reading counts as a change now.
  const quiet = s.contentChangedAt == null ? 0 : Math.max(0, now - s.contentChangedAt);
  if (read === "running") {
    if (quiet < OFF_SCREEN_HUNG_MS) return { state: "working", why: `turn running, screen changed ${seconds(quiet)} ago` };
    return byOutput(`turn line unchanged for ${seconds(quiet)}`);
  }
  const shape = read === "idle" ? "at its prompt" : "screen not recognised";
  if (quiet < OFF_SCREEN_SETTLE_MS) return { state: "working", why: `${shape}, screen changed ${seconds(quiet)} ago` };
  // Review MF1: nothing only with proof the turn ended — its own done line
  // last above the composer — and no byte for as long. Else 1.176.2's rule.
  const printed = s.lastOutputAt == null ? Infinity : now - s.lastOutputAt;
  if (read === "idle" && turnDoneAboveComposer(s.vendor ?? "", settledTail(s.rows, SCAN_ROWS).join("\n"))) {
    if (printed >= OFF_SCREEN_SETTLE_MS) return { state: null, why: `turn over, screen unchanged for ${seconds(quiet)}` };
    return { state: "working", why: `turn over, but printed ${seconds(printed)} ago` };
  }
  return byOutput(`${read === "idle" ? "at its prompt with no turn-done line" : shape}, screen unchanged for ${seconds(quiet)}`);
}

export function offScreenQuitState(s: OffScreenSession, now: number): "working" | "waiting" | null {
  return offScreenJudgement(s, now).state;
}
