import { useWorkspaces } from "../store/workspaceStore";
import { openCenterMode, useUi } from "../store/uiStore";
import { useKanban } from "../store/kanbanStore";
import { useTiles } from "../store/tileStore";
import { useAgents } from "../store/agentStore";
import { agentRunGet, type HistoryHit, type KanbanCard } from "../ipc";
import type { SessionHistoryRow } from "./terminalConversations";

/**
 * v1.25.0 (Cycle G2): kind-specific deep links from a history-search hit.
 *
 * QoL 11.3: every hit opens what it points at.
 * - A card hit opens that card (Rust names the card its line is in); only a
 *   hit whose card can't be told lands on the Board.
 * - A run record, transcript or saved work (a snapshot) shows the run: its
 *   tile if one is still open, else its output with the changes it saved
 *   (`HistoryItemSheet`). Their files are not kept per workspace, so the
 *   workspace comes from the run's own record.
 * - A brainstorm opens the card it was for, else its mailbox in the sheet.
 * - An intake conversation opens its card.
 * Returns false when there is nothing left to open (the toast says so).
 */

const EMPTY_CARDS: KanbanCard[] = [];

/** A workspace's cards, read from disk once if the Board hasn't yet. */
async function cardsOf(wsId: string): Promise<KanbanCard[]> {
  const loaded = useKanban.getState().byWorkspace[wsId]?.cards;
  if (loaded) return loaded;
  try {
    await useKanban.getState().loadFromDisk(wsId);
  } catch {
    // Nothing to read: no card to open.
  }
  return useKanban.getState().byWorkspace[wsId]?.cards ?? EMPTY_CARDS;
}

async function openCard(wsId: string, cardId: string): Promise<void> {
  if (useWorkspaces.getState().activeId !== wsId) await useWorkspaces.getState().setActive(wsId);
  useUi.getState().selectCard(wsId, cardId, true);
}

/** The workspace a run belongs to: the hit's, the loaded runs', else the
 *  run's own record. */
async function runWorkspace(hit: HistoryHit): Promise<string | null> {
  if (hit.workspaceId) return hit.workspaceId;
  for (const [wsId, slice] of Object.entries(useAgents.getState().byWorkspace)) {
    if (slice.runs.some((r) => r.id === hit.artifactId)) return wsId;
  }
  try {
    const run = await agentRunGet(hit.artifactId);
    return run?.workspaceId ?? null;
  } catch {
    return null;
  }
}

export async function dispatchHistoryHit(hit: HistoryHit): Promise<boolean> {
  switch (hit.kind) {
    case "card": {
      const wsId = hit.workspaceId ?? hit.artifactId;
      if (!useWorkspaces.getState().workspaces.some((w) => w.id === wsId)) return false;
      if (hit.cardId && (await cardsOf(wsId)).some((c) => c.id === hit.cardId)) {
        await openCard(wsId, hit.cardId);
        return true;
      }
      await useWorkspaces.getState().setActive(wsId);
      openCenterMode(wsId, "board");
      return true;
    }
    case "runRecord":
    case "runTranscript":
    case "snapshot": {
      const wsId = await runWorkspace(hit);
      if (!wsId || !useWorkspaces.getState().workspaces.some((w) => w.id === wsId)) return false;
      const tile = (useTiles.getState().byWorkspace[wsId]?.tiles ?? []).find((t) => t.runId === hit.artifactId);
      if (tile && hit.kind !== "snapshot") {
        await useWorkspaces.getState().setActive(wsId);
        openCenterMode(wsId, "terminals");
        useTiles.getState().setExpanded(wsId, tile.id);
        return true;
      }
      useUi.getState().openHistorySheet({ kind: "run", workspaceId: wsId, runId: hit.artifactId });
      return true;
    }
    case "intakeTranscript": {
      const wsId = hit.workspaceId;
      if (!wsId) return false;
      const card = (await cardsOf(wsId)).find((c) =>
        (c.intakeHistory ?? []).some((i) => i.intakeId === hit.artifactId),
      );
      if (card) {
        await openCard(wsId, card.id);
      } else {
        await useWorkspaces.getState().setActive(wsId);
        openCenterMode(wsId, "board");
      }
      return true;
    }
    case "swarmMailbox": {
      const wsId = hit.workspaceId;
      if (!wsId) return false;
      const card = (await cardsOf(wsId)).find(
        (c) => c.linkedBrainstormId === hit.artifactId || c.linkedSwarmId === hit.artifactId,
      );
      if (card) {
        await openCard(wsId, card.id);
      } else {
        useUi.getState().openHistorySheet({ kind: "brainstorm", workspaceId: wsId, swarmId: hit.artifactId });
      }
      return true;
    }
  }
}

/**
 * QoL 11.3: a Terminals session found by its title. One still running is
 * shown in its tile; any other opens History › Sessions filtered to it,
 * where Resume is one press — a search hit never starts a session itself.
 */
export async function openSessionHit(row: Pick<SessionHistoryRow, "workspaceId" | "title" | "running" | "ptyId">): Promise<void> {
  const live = row.running && row.ptyId ? useTiles.getState().getTileByPtyId(row.ptyId) : null;
  if (live) {
    if (useWorkspaces.getState().activeId !== live.workspaceId) await useWorkspaces.getState().setActive(live.workspaceId);
    openCenterMode(live.workspaceId, "terminals");
    useTiles.getState().setExpanded(live.workspaceId, live.id);
    return;
  }
  const wsId = useWorkspaces.getState().activeId ?? row.workspaceId;
  if (!useWorkspaces.getState().activeId) await useWorkspaces.getState().setActive(wsId);
  openCenterMode(wsId, "activity");
  // After the open: the open resets a filter a search set before.
  useUi.getState().setHistoryView({ tab: "sessions", workspaceId: row.workspaceId, text: row.title, fromSearch: true });
}

/** QoL 11.3: the sessions a search finds — by their stored short title
 *  only, never what was said (the record keeps no more); the same
 *  case-insensitive, whole-string match the other kinds get. */
export function sessionHits<T extends Pick<SessionHistoryRow, "title" | "workspaceId">>(
  rows: readonly T[],
  query: string,
  workspaceId: string | null,
): T[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return rows.filter((r) => (workspaceId == null || r.workspaceId === workspaceId) && r.title.toLowerCase().includes(q));
}

/** Where in a card a board line is, in words. */
const CARD_FIELD_WORDS: Record<string, string> = {
  title: "in its title",
  notes: "in its brief",
  knowledge: "in its notes",
  dispatchPrompt: "in its prompt",
};

/**
 * Walk (block 11): a ⌘⇧H card hit as words, never the board file's JSON
 * line. `"notes": "In index.html, …",` → where ("in its brief") and a short
 * plain excerpt around the match; a line that isn't a key and a string
 * value says "in the card" with its plain text.
 */
export function cardHitExcerpt(lineText: string, match: string, max = 80): { where: string; text: string } {
  const line = lineText.trim().replace(/,$/, "");
  let key: string | null = null;
  let text = line;
  const kv = /^"([^"\\]+)":\s*(.*)$/.exec(line);
  if (kv) {
    key = kv[1];
    const raw = kv[2];
    try {
      const v: unknown = JSON.parse(raw);
      text = typeof v === "string" ? v : raw;
    } catch {
      text = cutJsonString(raw);
    }
  } else {
    try {
      const v: unknown = JSON.parse(line);
      if (typeof v === "string") text = v;
    } catch {
      // Not JSON on its own: keep the words.
    }
  }
  text = text.replace(/\s+/g, " ").replace(/^["\s]+|["\s]+$/g, "").trim();
  if (text.length > max) {
    const at = match ? text.toLowerCase().indexOf(match.toLowerCase()) : -1;
    const start = at > max / 2 ? Math.min(at - Math.floor(max / 3), text.length - max) : 0;
    text = `${start > 0 ? "…" : ""}${text.slice(start, start + max).trim()}${start + max < text.length ? "…" : ""}`;
  }
  return { where: (key && CARD_FIELD_WORDS[key]) || "in the card", text };
}

/** 1.168.1 (A3): a JSON string the search cut at 500 characters (no closing
 *  quote, an ellipsis instead — or cut just after its closing `",`) doesn't
 *  parse; its escapes are still read as what they stand for, never shown as
 *  a literal `\n`, and an escape the cut split is dropped. Anything else is
 *  returned as it is. */
export function cutJsonString(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  let body = raw.slice(1).replace(/…$/, "").replace(/,$/, "");
  // Its own closing quote, when the cut came after it (not an escaped one).
  if (/(^|[^\\])(\\\\)*"$/.test(body)) body = body.slice(0, -1);
  // An escape the cut split: a dangling backslash, or `\u` short of 4 digits.
  body = body.replace(/(^|[^\\])((?:\\\\)*)\\(u[0-9a-fA-F]{0,3})?$/, "$1$2");
  return body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, e: string) => {
    if (e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    return ({ n: "\n", r: "\r", t: "\t", b: "", f: "" } as Record<string, string>)[e] ?? e;
  });
}

/** 1.168.1 (A3): a transcript or record hit's line as one line of words —
 *  a terminal transcript ends its lines with carriage returns, which drew
 *  nothing and glued "toggle" to "Notes:". */
export function hitLineText(lineText: string): string {
  return lineText.replace(/\s+/g, " ").trim();
}

export function kindLabel(kind: HistoryHit["kind"]): string {
  switch (kind) {
    case "card":
      return "Card";
    case "runRecord":
      return "Run record";
    case "runTranscript":
      return "Run transcript";
    case "snapshot":
      return "Saved work";
    case "intakeTranscript":
      return "Planning conversation";
    case "swarmMailbox":
      return "Brainstorm";
  }
}
