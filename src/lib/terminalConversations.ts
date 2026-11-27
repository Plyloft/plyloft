/**
 * Terminals block P4 and P5 (owner, 2026-10-21): the words of Resume… and
 * History › Sessions. A conversation is named by its title only — the
 * tile's, or the CLI's own (`terminal_sessions.rs`) — never by what was
 * said. Pure, so node runs its tests (`terminalConversations.test.ts`).
 */
import type { TerminalHistorySession } from "../ipc.ts";
import { shortDuration } from "./boardSemantics.ts";
import { ACCOUNT_REMOVED } from "./claudeAccountNames.ts";

export type ConversationKind = "claude" | "codex";

export const KIND_WORD: Record<ConversationKind, string> = { claude: "Claude", codex: "Codex" };

/** History › Sessions and Resume… look back this far (the record's window). */
export const SESSIONS_WINDOW_DAYS = 28;
const DAY_MS = 24 * 60 * 60 * 1000;

export const RESUME_TITLE = "Resume a conversation";
export const RESUME_EMPTY = `No Claude or Codex conversation in this project from the last ${SESSIONS_WINDOW_DAYS} days. A conversation shows up here once you've written something in it.`;

/** A conversation's name; one with none says which AI it was with. */
export function conversationTitle(c: { kind: ConversationKind; title?: string | null }): string {
  const t = c.title?.trim();
  return t ? t : `${KIND_WORD[c.kind]} conversation`;
}

/** Resume…'s time: when the conversation was last written to — History ›
 *  Sessions' Started is when a session began, so the two say which. */
export function lastUsed(at: number, now: number): string {
  return `last used ${ago(at, now)}`;
}

/** How long ago, in the Inbox's short words ("5m ago", "3d ago", "just now"). */
export function ago(at: number, now: number): string {
  const d = Math.max(0, now - at);
  return d < 60_000 ? "just now" : `${shortDuration(d)} ago`;
}

/** What opening a conversation whose file is gone says, inline. */
export function goneMessage(kind: ConversationKind): string {
  return kind === "claude"
    ? "This Claude conversation is no longer on this computer, so it can't be resumed. Claude Code removes its conversations after 30 days (you can keep them longer in Claude Code's own settings)."
    : "This Codex conversation is no longer on this computer, so it can't be resumed.";
}

/** Challenger round 1: where Resume can't open one. Mac words, through
 *  `machineWords` where drawn. */
export const OPEN_ELSEWHERE =
  "It looks open somewhere else on this Mac (another Terminal or Plyloft), so it isn't opened twice. Close it there first, or open it anyway if it isn't.";
export const FOLDER_GONE = "The folder it ran in is no longer there (moved or deleted), so it can't be resumed.";
/** 1.174.0 walk G3b: a conversation of one of the project's copies whose
 *  copy was thrown away. Codex picks a conversation up in any folder;
 *  Claude only in the one it ran in. */
export function copyGoneMessage(kind: ConversationKind): string {
  return kind === "codex"
    ? "The copy this conversation ran in is no longer there. Codex can pick it up in the project folder instead."
    : "The copy this conversation ran in is no longer there, and Claude resumes a conversation only in the folder it ran in.";
}
export const RESUME_IN_PROJECT = "Resume in the project folder";

/** Only the AIs installed here can open a conversation. */
export function resumableKinds(env: { claudePath?: string | null; codexPath?: string | null } | null | undefined): ConversationKind[] {
  const out: ConversationKind[] = [];
  if (env?.claudePath) out.push("claude");
  if (env?.codexPath) out.push("codex");
  return out;
}

// ── History › Sessions ───────────────────────────────────────────────────

/** "under a minute", "12 min", "1 h 5 min", "2 days". */
export function durationWords(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

export type SessionAction =
  | { kind: "show" }
  | { kind: "resume" }
  | { kind: "none"; reason: string };

export interface SessionHistoryRow {
  id: string;
  workspaceId: string;
  workspaceName: string;
  kind: ConversationKind;
  /** "Claude", or "Claude · resumed" for a session that picked up an
   *  earlier one (the earlier one has its own row, under the same title). */
  kindWord: string;
  title: string;
  startedAt: number;
  /** 1.174.0 E9 (T9): when it was last used — the clock Resume… keeps:
   *  now while it runs, else its end; with no end, its conversation's last
   *  write (`lastWriteAt`, the transcript History already looks up), else
   *  when Plyloft quit with it open, else its start. */
  lastUsedAt: number;
  /** "12 min", or "Running" while its tile runs. */
  duration: string;
  running: boolean;
  action: SessionAction;
  /** What Resume or Show acts on. */
  cwd: string;
  cliSessionId: string | null;
  ptyId: string | null;
  titleSource: TerminalHistorySession["titleSource"] | null;
  /** 1.179.0 (C2): the Claude account it ran on (null: Main); Resume runs
   *  there. */
  account: string | null;
}

/** Why a row can't be resumed. */
export const NO_CONVERSATION_YET = "Codex hadn't saved this conversation yet (it does after the first message).";
export const FILE_GONE = "Its conversation is no longer on this computer.";
export const ROW_FOLDER_GONE = "The folder it ran in is no longer there.";

/**
 * P5: the rows of History › Sessions, from every workspace's record —
 * Claude and Codex only, the last 28 days, most recently used first (1.174.0
 * E9: Resume…'s order; was newest started first). A running one is
 * shown, not resumed a second time; one whose file or folder is gone says
 * so. An ended one with no title had nothing typed in it (a tile opened and
 * closed, the conversation before a `/clear`): left out.
 */
export function sessionHistoryRows(
  sessions: ReadonlyArray<TerminalHistorySession>,
  workspaceNames: Readonly<Record<string, string>>,
  now: number,
): SessionHistoryRow[] {
  const since = now - SESSIONS_WINDOW_DAYS * DAY_MS;
  const rows: SessionHistoryRow[] = [];
  for (const s of sessions) {
    if (s.kind !== "claude" && s.kind !== "codex") continue;
    const running = s.live === true;
    // E9 round 1: the window counts from the last use, as the record's prune does.
    // Its own end first: a conversation resumed later in another session
    // writes the same transcript, and that later use is the other row's.
    const lastUsedAt = running ? now : (s.endedAt ?? s.lastWriteAt ?? s.openAtQuit ?? s.startedAt);
    if (lastUsedAt < since && !running) continue;
    if (!running && !s.title?.trim()) continue;
    const action: SessionAction = running
      ? { kind: "show" }
      : !s.cliSessionId
        ? { kind: "none", reason: NO_CONVERSATION_YET }
        : s.resumable
          ? { kind: "resume" }
          : {
              kind: "none",
              reason: s.gone === "account" ? ACCOUNT_REMOVED : s.gone === "folder" ? ROW_FOLDER_GONE : FILE_GONE,
            };
    rows.push({
      id: `${s.workspaceId}:${s.id}`,
      workspaceId: s.workspaceId,
      workspaceName: workspaceNames[s.workspaceId] ?? s.workspaceId,
      kind: s.kind,
      kindWord: s.resumedFrom ? `${KIND_WORD[s.kind]} · resumed` : KIND_WORD[s.kind],
      title: conversationTitle(s),
      startedAt: s.startedAt,
      lastUsedAt,
      // A row with no end that isn't running ended when Plyloft did.
      duration: running ? "Running" : s.endedAt != null ? durationWords(s.endedAt - s.startedAt) : "Ended when Plyloft quit",
      running,
      action,
      cwd: s.cwd,
      cliSessionId: s.cliSessionId ?? null,
      ptyId: s.ptyId ?? null,
      titleSource: s.titleSource ?? null,
      account: s.account ?? null,
    });
  }
  rows.sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.startedAt - a.startedAt);
  return rows;
}

// ── QoL 1.168 (block 4, D5, owner D11): Reopen the sessions open at quit ──

/** F3 (1.172.1, owner 2026-10-28): the offer is one calm line naming the
 *  session(s) — "Dark mode was open when Plyloft quit." or "3 sessions were
 *  open when Plyloft quit: A, B and 1 more." In parts, so the names are drawn
 *  in normal ink and the rest muted; the full list is `reopenList`. */
export type ReopenPart = { text: string; name?: true };

export function reopenLine(titles: readonly string[]): ReopenPart[] {
  const n = titles.length;
  if (n === 0) return [];
  if (n === 1) return [{ text: titles[0], name: true }, { text: " was open when Plyloft quit." }];
  const head: ReopenPart = { text: `${n} sessions were open when Plyloft quit: ` };
  if (n === 2) return [head, { text: titles[0], name: true }, { text: " and " }, { text: titles[1], name: true }, { text: "." }];
  return [head, { text: titles[0], name: true }, { text: ", " }, { text: titles[1], name: true }, { text: ` and ${n - 2} more.` }];
}

/** The line as plain text. */
export function reopenLineText(titles: readonly string[]): string {
  return reopenLine(titles)
    .map((p) => p.text)
    .join("");
}

/** What the offer's button says. */
export function reopenButtonWords(n: number): string {
  return n === 1 ? "Reopen it" : "Reopen them";
}

/** 1.169.0 (C3): the Inbox's pointer to the offer, which lives in
 *  Terminals. */
export function reopenPointerWords(n: number): string {
  return n === 1
    ? "1 session was open when Plyloft quit · Reopen it in Terminals"
    : `${n} sessions were open when Plyloft quit · Reopen them in Terminals`;
}

/** The offer's tooltip: the sessions, by name. 1.179.0 (C2): `kindWord`
 *  says the AI with its account, where accounts are named. */
export function reopenList<R extends { kind: ConversationKind; title?: string | null }>(
  rows: ReadonlyArray<R>,
  kindWord: (r: R) => string = (r) => KIND_WORD[r.kind],
): string {
  return rows.map((r) => `${kindWord(r)}: ${conversationTitle(r)}`).join("\n");
}

/** What a reopen that didn't open them all says (null: they all opened). */
export function reopenOutcome(
  opened: number,
  failed: ReadonlyArray<{ title: string; message: string }>,
): { title: string; body: string } | null {
  if (failed.length === 0) return null;
  const total = opened + failed.length;
  const first = failed[0];
  return {
    title:
      opened === 0
        ? total === 1
          ? "That session couldn't be reopened"
          : "Those sessions couldn't be reopened"
        : `Reopened ${opened} of ${total} sessions`,
    body: `${first.title}: ${first.message}${failed.length > 1 ? ` (and ${failed.length - 1} more)` : ""}`,
  };
}

/** QoL 1.168 (block 4): Resume…'s second line for a conversation whose name
 *  another one has too — how it opened (its first message's short title,
 *  when that isn't the name) or the day and time it was last used. Never
 *  more of what was said. */
export function resumeDetail(
  c: { kind: ConversationKind; title?: string | null; opening?: string | null; updatedAt: number },
  duplicate: boolean,
  when: (at: number) => string,
): string | null {
  if (!duplicate) return null;
  const opening = c.opening?.trim();
  if (opening && opening !== conversationTitle(c)) return `Began “${opening}” · last used ${when(c.updatedAt)}`;
  return `Last used ${when(c.updatedAt)}`;
}

/** The titles more than one conversation of the list has. */
export function duplicateTitles(rows: ReadonlyArray<{ kind: ConversationKind; title?: string | null }>): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const r of rows) {
    const t = conversationTitle(r);
    if (seen.has(t)) twice.add(t);
    seen.add(t);
  }
  return twice;
}

/** QoL 1.168 (block 4): the empty page after the member closed this
 *  launch's tiles. */
export function noSessionsOpenWords(canResume: boolean): string {
  return canResume ? "No sessions open. Resume… picks up an earlier one." : "No sessions open.";
}
