/**
 * 1.175.0 F3 walk (R13): which cards' lands here GitHub has since — after
 * Put it on GitHub sent the project's branch, a card shipped only here
 * before is on GitHub too. One fact for every surface (Now's path line,
 * What shipped, the Board): `put_on_github_sent`, read from local refs
 * only (never a fetch), once per commit, and again for a project after
 * its put (`usePutOnGithub.puts`).
 */
import { create } from "zustand";
import type { KanbanCard } from "../ipc";
import { ownShipEntry } from "../lib/shipVersion";
import { putOnGithubSent } from "../lib/putOnGithubIpc";
import { useKanban } from "./kanbanStore";
import { usePutOnGithub } from "./putOnGithubStore";

type State = {
  /** By workspace: the shas GitHub has, of those read. */
  byWorkspace: Record<string, ReadonlySet<string>>;
};

export const useSentToGitHub = create<State>(() => ({ byWorkspace: {} }));

/** Shas read already, by workspace (sent or not). */
const read = new Map<string, Set<string>>();
const inFlight = new Set<string>();

/** The commit of a card's own land here, or null. */
function landSha(card: KanbanCard): string | null {
  const last = ownShipEntry(card);
  return last && last.releaseKind === "local" && last.commitSha ? last.commitSha : null;
}

/** Read the lands of `workspaceId`'s cards not read yet. */
export async function readSent(workspaceId: string, cards: readonly KanbanCard[]): Promise<void> {
  if (inFlight.has(workspaceId)) return;
  const known = read.get(workspaceId) ?? new Set<string>();
  const shas = [...new Set(cards.map(landSha).filter((s): s is string => Boolean(s)))].filter((s) => !known.has(s)).slice(0, 64);
  if (shas.length === 0) return;
  inFlight.add(workspaceId);
  try {
    const sent = await putOnGithubSent(workspaceId, shas);
    for (const s of shas) known.add(s);
    read.set(workspaceId, known);
    if (sent && sent.length > 0) {
      useSentToGitHub.setState((s) => ({
        byWorkspace: { ...s.byWorkspace, [workspaceId]: new Set([...(s.byWorkspace[workspaceId] ?? []), ...sent]) },
      }));
    }
  } catch {
    // Unknown: the cards keep saying what their own record says.
  } finally {
    inFlight.delete(workspaceId);
  }
}

/** Each workspace's ships, as a key: a new entry anywhere (a Ship, a ship
 *  batch, a release that carried a card) changes it. */
function shipsKey(cards: readonly KanbanCard[]): string {
  return cards.map((c) => `${c.id}:${c.shipHistory?.length ?? 0}:${c.prUrl ?? ""}`).join(",");
}
const seenShips = new Map<string, string>();

/** 1.175.0 F3 walk (review): a land's commit can reach GitHub another way
 *  later — a later Ship carrying it, Bring in, a push by hand: the
 *  workspace's lands are read again after a Ship or a Bring in. */
export function forgetSentToGitHub(workspaceId: string): void {
  read.delete(workspaceId);
  const cards = useKanban.getState().byWorkspace[workspaceId]?.cards;
  if (cards) void readSent(workspaceId, cards);
}

function readAll() {
  for (const [ws, entry] of Object.entries(useKanban.getState().byWorkspace)) {
    if (entry?.cards?.length) void readSent(ws, entry.cards);
  }
}

let started = false;

/** Started once, at launch (`App.tsx`). */
export function startSentToGitHub(): void {
  if (started) return;
  started = true;
  useKanban.subscribe((s, prev) => {
    if (s.byWorkspace === prev.byWorkspace) return;
    for (const [ws, entry] of Object.entries(s.byWorkspace)) {
      const key = shipsKey(entry?.cards ?? []);
      const was = seenShips.get(ws);
      seenShips.set(ws, key);
      if (was != null && was !== key) read.delete(ws);
    }
    readAll();
  });
  // After a put (Send it again too), the project's lands are read again.
  usePutOnGithub.subscribe((s, prev) => {
    if (s.puts === prev.puts) return;
    for (const ws of Object.keys(s.puts)) {
      if (s.puts[ws] !== prev.puts[ws]) {
        read.delete(ws);
        const cards = useKanban.getState().byWorkspace[ws]?.cards;
        if (cards) void readSent(ws, cards);
      }
    }
  });
  readAll();
}

/** Tests only. */
export function resetSentToGitHubForTests(): void {
  read.clear();
  seenShips.clear();
  inFlight.clear();
  useSentToGitHub.setState({ byWorkspace: {} });
}
