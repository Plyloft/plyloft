/**
 * Windows (W4): the words of the close sheet — what quitting would stop.
 *
 * Closing the window on Windows asks (Settings › Appearance › When I close the
 * window): keep Ply running in the notification area, or quit it. Sessions,
 * tiles, runs and builds keep going only while Ply runs, so the sheet names
 * what a quit would stop, counted from the stores that already hold them
 * (`WindowsCloseSheet.tsx` reads them). The Mac never asks: its close hides.
 *
 * Pure, so node runs it (`closeChoice.test.ts`).
 */

/** The persisted choice, `behavior.windowsCloseAction`. */
export type WindowsCloseAction = "ask" | "tray" | "quit";

export function windowsCloseActionOf(value: unknown): WindowsCloseAction {
  return value === "tray" || value === "quit" ? value : "ask";
}

/** What is running now, that a quit would stop. */
export interface RunningCounts {
  /** Live Claude and Codex tiles, and Builder sessions on cards. */
  sessions: number;
  /** 1.169.0 (owner): sessions waiting for the member's answer — a
   *  permission prompt, a question, a chat's approval. Only the quit guard
   *  counts them (`workingNow`); 0 or absent elsewhere. */
  waiting?: number;
  /** Live shell tiles. */
  terminals: number;
  /** Agent runs in flight. */
  runs: number;
  /** Challenger reviews running on cards. */
  reviews: number;
  /** Swarms running. */
  swarms: number;
  /** Verify jobs running or queued. */
  builds: number;
  /** A ship is in flight. */
  shipping: boolean;
}

export const NOTHING_RUNNING: RunningCounts = {
  sessions: 0,
  terminals: 0,
  runs: 0,
  reviews: 0,
  swarms: 0,
  builds: 0,
  shipping: false,
};

/** The fields `runningCounts` reads from a tile. */
export interface TileLike {
  kind: string;
  status: string;
  pendingClose?: boolean;
}

const ALIVE = new Set(["pending", "running"]);

/**
 * Count what is running. Agent-run tiles are not counted as tiles: their run
 * is in `runs`, so one run is never said twice.
 */
export function runningCounts(input: {
  tiles: TileLike[];
  builderSessions: number;
  runStatuses: string[];
  reviewStatuses: string[];
  swarmStatuses: string[];
  verifyJobs: number;
  shipping: boolean;
}): RunningCounts {
  let sessions = input.builderSessions;
  let terminals = 0;
  for (const t of input.tiles) {
    if (!ALIVE.has(t.status) || t.pendingClose) continue;
    if (t.kind === "claude" || t.kind === "codex" || t.kind === "codex-chat") sessions += 1;
    else if (t.kind === "shell") terminals += 1;
  }
  return {
    sessions,
    terminals,
    runs: input.runStatuses.filter((s) => ALIVE.has(s)).length,
    reviews: input.reviewStatuses.filter((s) => s === "running").length,
    swarms: input.swarmStatuses.filter((s) => s === "running").length,
    builds: input.verifyJobs,
    shipping: input.shipping,
  };
}

function counted(n: number, one: string, many: string): string | null {
  if (n <= 0) return null;
  return `${n} ${n === 1 ? one : many}`;
}

/** `a`, `a and b`, `a, b and c`. */
function listed(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What a quit would stop, as a sentence: `If you quit, 2 sessions and 1
 *  build will stop.` The counts are what the stores know — a discussion or a
 *  card's own Ship now is not among them — so with none counted the sentence
 *  never claims that nothing runs. */
export function stopSentence(c: RunningCounts): string {
  const parts = [
    counted(c.sessions, "session", "sessions"),
    counted(c.terminals, "terminal", "terminals"),
    counted(c.runs, "agent run", "agent runs"),
    counted(c.reviews, "review", "reviews"),
    counted(c.swarms, "multi-AI run", "multi-AI runs"),
    counted(c.builds, "build", "builds"),
    c.shipping ? "the ship in progress" : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return "If you quit, anything Plyloft is still running stops.";
  return `If you quit, ${listed(parts)} will stop.`;
}

export const CLOSE_SHEET = {
  title: "Close Plyloft?",
  lede: "Sessions, tiles and builds keep going only while Plyloft is open. It can keep running in the notification area, or quit completely.",
  /** Without a notification-area icon, keeping it running minimizes it. */
  ledeMinimized: "Sessions, tiles and builds keep going only while Plyloft is open. It can keep running minimized, or quit completely.",
  keep: "Keep running in the notification area",
  /** Without a notification-area icon the window is minimized instead. */
  keepMinimized: "Keep running, minimized",
  quit: "Quit Plyloft",
  cancel: "Cancel",
  dontAsk: "Don't ask again",
  dontAskHint: "You can change this in Settings › Look and feel › Appearance.",
} as const;
