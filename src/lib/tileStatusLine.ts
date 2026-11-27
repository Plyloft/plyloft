// UX-8.2 (the Terminals board): what a tile header says on its right — a dot
// and words, never colour alone. One place decides the words and the tone;
// Tile renders them and the tile CSS maps each tone to a token.
//
// Pure: no React, no store, no clock (callers pass `now`).

import { formatElapsed, playfulStatus, type TileStatusKind } from "./playfulStatus.ts";
import { exitedAsCrash, exitedCalmly, exitedLabel, exitedTitle, isRestartableKind } from "./tileExit.ts";
import { tileHeaderStatusFor, type Readiness } from "./tileHeaderStatus.ts";
import { pausedLabel, SESSION_WORDS } from "./deliveryWords.ts";

/** 1.171.0 C2 (CF8): an AI session's header at work — the session word and
 *  how long this turn has run ("Working · 4m 12s"); the playful verbs stay
 *  the agent runs'. */
function workingFor(elapsedMs: number): string {
  return `${SESSION_WORDS.working} · ${formatElapsed(elapsedMs)}`;
}

/**
 * - `running`: working, the dot pulses (`--signal-running-*`).
 * - `ready`: at its prompt, words only.
 * - `pending`: not started yet, words only, muted.
 * - `done`: an agent run that finished (`--signal-done-*`).
 * - `exited`: a PTY process that ended cleanly (or with Ctrl-C) — muted,
 *   "Ended" (QoL 1.168).
 * - `failed`: errored — a shell's last command, an agent run (amber,
 *   `--signal-aborted-*`).
 * - `crashed`: QoL 1.168 (block 10, A6) — a real crash, red
 *   (`--signal-crashed-fg`): a process that stopped with no exit code, or a
 *   Claude or Codex session that ended abnormally.
 * - `ended`: killed by Ply, muted.
 * - `quiet`: working, but nothing printed for `IDLE_WARNING_MS` — amber
 *   (`--warn`), "No output for 10m" (UX-8.4).
 */
export type TileTone =
  | "running"
  | "ready"
  | "pending"
  | "done"
  | "exited"
  | "failed"
  | "crashed"
  | "ended"
  | "quiet"
  | "asks";

/** Terminals block P3: what a Claude/Codex tile's session waits on the
 *  member for — a question or a permission (`decision`), the folder-trust
 *  question, the usage limit, Claude's warning before working without
 *  asking. Read from its drawn screen (Terminal's scan). */
export type TileQuestion = "decision" | "trust" | "usageLimit" | "bypass";

/** P3: the tile's words while it waits — the header, the sidebar row and
 *  the Inbox say the same. */
export function tileQuestionWords(kind: string, question: TileQuestion, resetsAt?: string | null): string {
  const who = kind === "codex" ? "Codex" : "Claude";
  switch (question) {
    case "trust":
      return `${who} asks to trust the folder`;
    case "usageLimit":
      // 1.171.0 C2 (CF8): the session word Paused, with when it resets.
      return pausedLabel(resetsAt);
    case "bypass":
      return `${who} asks before working without asking`;
    default:
      return SESSION_WORDS.asks;
  }
}

/** 1.174.0 E4 (P21, mockup terminals.html §1): the short form a narrow tile
 *  (≤ 480 px) shows in its header. The full words stay in the tooltip and the
 *  screen-reader label; the sidebar row and the Inbox keep the full words. */
export function tileQuestionShort(question: TileQuestion, resetsAt?: string | null): string {
  switch (question) {
    case "trust":
      return "Asks: trust";
    case "usageLimit": {
      // Challenger 1: the short form drops the time zone in brackets
      // ("3:30pm (Europe/Rome)" → "3:30pm"); the full words keep it.
      const time = resetsAt?.trim().replace(/\s*\([^)]*\)\s*$/, "") ?? "";
      return time ? `Paused till ${time}` : "Paused";
    }
    default:
      // A question, a permission, and the warning before working without
      // asking all read "Asks you".
      return "Asks you";
  }
}

/** UX-8.4: a working PTY tile that has printed nothing for this long says so
 *  instead of its playful verb. */
export const IDLE_WARNING_MS = 10 * 60_000;

/**
 * UX-8.4: "No output for 10m", or null while the tile is under the threshold.
 * Minutes roll up (10m, 11m, …), then hours ("1h 5m").
 */
export function idleWarning(lastOutputAt: number, now: number): string | null {
  const quiet = now - lastOutputAt;
  if (quiet < IDLE_WARNING_MS) return null;
  const minutes = Math.floor(quiet / 60_000);
  if (minutes < 60) return `No output for ${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `No output for ${m === 0 ? `${h}h` : `${h}h ${m}m`}`;
}

/** QoL 1.168 (block 4): what a Claude or Codex tile says until its first
 *  Ready, for at most `STARTING_MS` (a session given work at its start is
 *  working after that, and says how long). */
export const STARTING = "Starting…";
export const STARTING_MS = 20_000;

/** A shell tile at work: a command holds it (or, where the PTY cannot say,
 *  it is printing). No timer and no playful verb — those are the agents'. */
export const SHELL_RUNNING = "Running";

export interface TileStatusInput {
  kind: string;
  /** The tile's status, or its live run's for an agent-run tile. */
  status: TileStatusKind;
  exitCode?: number | null;
  startedAt: number;
  /** codex-chat: a turn is in flight, and since when. */
  sessionBusy?: boolean;
  sessionTurnStartedAt?: number;
  /** PTY tiles: the readiness folded from Terminal's scans. */
  readiness?: Readiness;
  /** PTY tiles: the last PTY output (coalesced to 1 s); the start without. */
  lastOutputAt?: number;
  /** P3: what the session waits on the member for, while it does. */
  question?: TileQuestion | null;
  questionResetsAt?: string | null;
  /** Windows: its Ctrl-C exit code reads as Ctrl-C. */
  windows?: boolean;
  /** 1.176.0 R7: a Claude or Codex tile whose CLI didn't start. */
  startFailed?: boolean;
  /** An agent-run tile: when its run ended. A finished run says how long it
   *  took ("Done · 7s"), not the time since it started. */
  endedAt?: number | null;
  now: number;
}

export interface TileStatusLine {
  text: string;
  tone: TileTone;
  /** The tooltip, when it says more than the words (an exit code). */
  title?: string;
  /** 1.174.0 E4 (P21): the words a narrow tile (≤ 480 px) shows instead;
   *  `text` stays the tooltip and the screen-reader label. */
  short?: string;
  /** The dot pulses (a process at work). */
  live: boolean;
}

function toneOf(status: TileStatusKind): TileTone {
  switch (status) {
    case "running":
      return "running";
    case "pending":
      return "pending";
    case "done":
      return "done";
    case "killed":
      return "ended";
    default:
      return "failed";
  }
}

/** 1.176.0 R7: the header chip of a tile whose CLI didn't start. */
export const DIDNT_START = "Didn't start";

export function tileStatusLine(input: TileStatusInput): TileStatusLine {
  const { kind, status, now } = input;
  // UX-0.1: an ended PTY tile says how it ended, and stays.
  if (isRestartableKind(kind) && (status === "done" || status === "crashed")) {
    const code = input.exitCode ?? (status === "done" ? 0 : null);
    const windows = input.windows ?? false;
    // R7: its CLI didn't start (the line under the header says why).
    if (input.startFailed && (kind === "claude" || kind === "codex")) {
      return { text: DIDNT_START, tone: "crashed", title: exitedTitle(code, kind, windows), live: false };
    }
    return {
      text: exitedLabel(status, code, windows, kind),
      tone:
        status === "done" || exitedCalmly(code, windows)
          ? "exited"
          : exitedAsCrash(code, kind, windows)
            ? "crashed"
            : "failed",
      title: exitedTitle(code, kind, windows),
      live: false,
    };
  }
  if (status === "running" && input.question && (kind === "claude" || kind === "codex")) {
    // P3: a waiting session never reads "Ready" (a decision prompt drawn as
    // an idle box did).
    return {
      text: tileQuestionWords(kind, input.question, input.questionResetsAt),
      short: tileQuestionShort(input.question, input.questionResetsAt),
      tone: "asks",
      live: false,
    };
  }
  if (status === "running") {
    // v1.103.0 (D7): a chat session reports the session — "Ready" between
    // turns, a timer for the turn in flight.
    if (kind === "codex-chat") {
      if (!input.sessionBusy) return { text: SESSION_WORDS.yourTurn, tone: "ready", live: false };
      return {
        text: workingFor(now - (input.sessionTurnStartedAt ?? now)),
        tone: "running",
        live: true,
      };
    }
    // GH #70: a live PTY tile — "Ready" at its prompt, and otherwise the
    // time since it last left Ready (Claude, Codex) or "Running" (a shell).
    if (kind === "claude" || kind === "codex" || kind === "shell") {
      // Block 10 Windows walk: Claude or Codex that has drawn nothing yet is
      // starting, whatever a scan of the empty screen said.
      if (kind !== "shell" && input.lastOutputAt == null && !input.readiness?.waiting && now - input.startedAt < STARTING_MS) {
        return { text: STARTING, tone: "running", live: true };
      }
      const header = tileHeaderStatusFor(kind, input.readiness, input.startedAt, now);
      if (header.ready) return { text: kind === "shell" ? "Ready" : SESSION_WORDS.yourTurn, tone: "ready", live: false };
      // QoL 1.168 (block 4): Claude or Codex still coming up — never Ready
      // since the tile started — says so, not "Working for 0s".
      if (kind !== "shell" && header.workingSince <= input.startedAt && now - input.startedAt < STARTING_MS) {
        return { text: STARTING, tone: "running", live: true };
      }
      // Quiet since the later of the last output and the moment it started
      // working: silence while it sat at Ready is not the work's.
      const quiet = idleWarning(
        Math.max(input.lastOutputAt ?? input.startedAt, header.workingSince),
        now,
      );
      if (quiet) return { text: quiet, tone: "quiet", live: false };
      // Owner (2026-10-19): a shell says shell words. The playful verbs and
      // their timer are the agents'; a shell tile only says it is running.
      if (kind === "shell") return { text: SHELL_RUNNING, tone: "running", live: true };
      return {
        text: workingFor(now - header.workingSince),
        tone: "running",
        live: true,
      };
    }
  }
  return {
    text: playfulStatus(
      Math.max(0, (status === "running" ? now : (input.endedAt ?? now)) - input.startedAt),
      status,
    ),
    tone: toneOf(status),
    live: status === "running",
  };
}
