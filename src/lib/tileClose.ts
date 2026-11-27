// GH #327: what closing a live tile asks — what happens and what is kept, in
// words. Not "Close & kill the running codex chat": the kind by its name,
// what is lost, what survives (Claude and Codex keep their own history; a
// shell's output does not survive).
//
// Pure: no React, no store.

export type CloseKind = "shell" | "claude" | "codex" | "codex-chat" | "agent-run";

export interface CloseQuestion {
  title: string;
  body: string;
  confirmLabel: string;
}

const BODY: Record<CloseKind, string> = {
  shell:
    "The shell and whatever it is running stop, and its output here is gone.",
  claude:
    "The session ends and its output here is gone. Claude keeps the conversation history: pick it up again from New › Resume… or History › Sessions.",
  codex:
    "The session ends and its output here is gone. Codex keeps its own session history: pick it up again from New › Resume… or History › Sessions.",
  "codex-chat": "The turn in progress stops and this chat closes.",
  "agent-run": "The run stops and is marked aborted.",
};

export function closeQuestion(kind: CloseKind, label: string): CloseQuestion {
  return {
    title: `Stop ${label}?`,
    body: BODY[kind],
    confirmLabel: "Stop and close",
  };
}

/** QoL 1.168 (D4): what decides whether closing a tile asks first. */
export interface CloseFacts {
  kind: CloseKind;
  status: "pending" | "running" | "done" | "error" | "killed" | "crashed";
  /** codex-chat: a turn is in flight. */
  sessionBusy?: boolean;
  /** Claude and Codex: the header's readiness (`tileHeaderStatus`). */
  readiness?: {
    lastOutputAt: number;
    matcherIdle: boolean | null;
    leftReadyAt: number;
    /** A permission or decision prompt on screen (M2). */
    waiting?: boolean;
    /** Background work in the CLI's footer (M3). */
    background?: boolean;
    /** Claude's screen shows its turn running. */
    running?: boolean;
  };
  /** Claude and Codex: the input line held nothing at the last scan;
   *  `false` is a draft not yet sent (M1). */
  inputEmpty?: boolean;
  /** The input line holds the member's own typing (not a dim placeholder
   *  or suggestion); absent, `inputEmpty` decides. */
  inputDraft?: boolean;
  /** Claude and Codex: what the session waits on the member for. */
  question?: string | null;
  startedAt: number;
  /** A shell: its PTY says it is alone — at its prompt with no job,
   *  foreground or background, in its session (the Mac) or its job
   *  (Windows) (`pty_shell_alone`); `null` when it cannot say. */
  shellAlone?: boolean | null;
}

/** Quiet this long, at the prompt, is idle (`READY_QUIET_MS`). */
const IDLE_QUIET_MS = 2_000;

/**
 * QoL 1.168 (D4): closing loses nothing, so it does not ask — a shell at its
 * prompt with no command running, Claude or Codex at its prompt (Ready, no
 * question; the CLI keeps the conversation), a Codex chat between turns, a
 * session that has already ended. Anything working, waiting on the member,
 * or that cannot be read asks, as before.
 */
export function closeAsks(t: CloseFacts, now: number): boolean {
  if (t.kind === "codex-chat") return t.sessionBusy ?? false;
  const live = t.status === "running" || t.status === "pending";
  if (!live) return false;
  if (t.status === "pending") return true;
  if (t.kind === "agent-run") return true;
  if (t.kind === "shell") return t.shellAlone !== true;
  // Claude, Codex: at Ready as the header reads it — the prompt matcher not
  // busy, quiet for the Ready window — with no question, no permission
  // prompt, no background work and no unsent draft of the member's.
  if (t.question) return true;
  if (t.inputDraft ?? t.inputEmpty === false) return true;
  const r = t.readiness;
  // `null` is Claude's box at rest with the turn that started it scrolled
  // off the page (a fresh tile, a long answer): the header then reads Ready
  // by output quiet, as here — Claude's spinner writes all turn long
  // (walk lane 1, step 4).
  if (!r || r.matcherIdle === false || r.waiting || r.background || r.running) return true;
  return now - r.lastOutputAt < IDLE_QUIET_MS;
}

/** QoL 1.168 (D4, M4): `Close all` asks once — always for more than one
 *  session, and for a single one that is working — naming how many are
 *  working and a swarm it would abort. */
export function closeAllAsks(working: number, total: number): boolean {
  return total > 1 || working > 0;
}

export function closeAllQuestion(working: number, total: number, swarm = false): CloseQuestion {
  const title = total === 1 ? "Stop the session that is working?" : `Close all ${total} sessions?`;
  const what =
    working === 0
      ? "None of them is working."
      : working === 1
        ? "One of them is working: it stops and its output here is gone."
        : `${working} of them are working: they stop and their output here is gone.`;
  const body =
    (total === 1 ? "It stops and its output here is gone. " : `${what} `) +
    (swarm ? "A step of a multi-AI run among them is stopped, and the run is marked stopped. " : "") +
    "Claude and Codex keep their conversation history.";
  return { title, body, confirmLabel: total === 1 ? "Stop and close" : "Close all" };
}
