import { useCallback, useEffect, useRef, useState } from "react";
import {
  worktreeDelete,
  worktreeKeptDelete,
  worktreeKeptList,
  worktreeList,
  worktreeReveal,
  type KeptTrashEntry,
  type KanbanColumnId,
  type WorktreeInfo,
} from "../../ipc";
import { KANBAN_COLUMNS, useKanban } from "../../store/kanbanStore";
import { pushToast } from "../../store/toastStore";
import { EMPTY_ARRAY } from "../../lib/empties";
import { confirmSheet } from "../../store/confirmStore";
import { useCopies, useWorkspaceCopies } from "../../store/copiesStore";
import { copyTileMark, THROW_AWAY } from "../../lib/copyWords";
import {
  CBtn,
  DangerZone,
  Details,
  EmptyState,
  Group,
  MoreMenu,
  Row,
  Section,
  StatusLine,
  usePageReading,
} from "../ux";
import { SettingsPage } from "./rows";
import { LocalBranchBlock } from "../errors/LocalBranchBlock";
import { LocalBranchState } from "../errors/LocalBranchState";
import type { Scope } from "../../lib/settingsNav";
import { platformWord } from "../../lib/platform";
import { worktreeOwner, worktreeOwnerLabel } from "../../lib/buildBoth";
import { worktreeTrashFolder } from "../../lib/worktreeBase";
import { pushErrorToast } from "../../lib/errorToast";

/**
 * UX language card 8 (GH #103): Settings › This workspace › Worktrees, on the
 * `ux` layer. Every live per-card checkout under
 * `<workspace>/.plyloft-worktrees/` (and the legacy `.atelier-worktrees/`,
 * where cards made before the rename keep theirs), and the folders a card's delete could not
 * judge.
 *
 * GH #116's contract holds: **a kept folder is only findable because this page
 * lists it.** Nothing else in the app shows the trash, and a kept folder is the
 * one kind that holds work nobody has looked at — so it keeps its own group,
 * its own sentence, and `Delete for good`. `cardDeleteSheet.test.ts` reads this
 * file for exactly that.
 *
 * GH #102's `Local <branch> can't be updated.` sits at the top when the paths
 * git named are not the Library's (`uxError.ts::placementOf`).
 */
export function WorktreesPage({
  scope,
  hiddenNote,
  workspaceId,
}: {
  scope: Scope;
  hiddenNote?: string | null;
  workspaceId: string;
}) {
  const [items, setItems] = useState<WorktreeInfo[]>([]);
  // GH #116: staged checkouts no sweep will reap.
  const [kept, setKept] = useState<KeptTrashEntry[]>([]);
  const [loading, setLoading] = useState(false);
  // The read's raw error: shown only in its Details (UX P-D2).
  const [error, setErrorDetails] = useState<string | null>(null);
  /** Whether the read this page opens with has come back yet. `loading` is
   *  false until the effect starts it, so on its own it would tell a search
   *  that the page had settled before it had read anything (review 3, NF3). */
  const [read, setRead] = useState(false);
  // GH #107 (review 2, F2): the rows are the checkouts on disk, read when the
  // page opens, so a landing waits for that read rather than calling a row
  // missing while it is in flight.
  usePageReading(loading || !read);

  // Card lookup, so a row reads as the card it belongs to rather than as a
  // directory name.
  const cards = useKanban((s) => s.byWorkspace[workspaceId]?.cards ?? EMPTY_ARRAY);
  // SL-6: a card built by both has two checkouts (`<id>` and `<id>-b`), and
  // one that continues on Codex's keeps `<id>-b` — each row reads as its card.
  const ownerOf = (dirName: string) => worktreeOwner(cards, dirName);
  const titleOf = (dirName: string): string | undefined => {
    const owner = ownerOf(dirName);
    return owner ? worktreeOwnerLabel(owner) : undefined;
  };
  const columnOf = (dirName: string): KanbanColumnId | undefined => ownerOf(dirName)?.card.columnId;
  // 1.173.0 A3: a copy made from Terminals reads as one ("Copy · name"), and
  // a copy a card took (its folder keeps the copy's name) as its card.
  const copies = useWorkspaceCopies(workspaceId);
  useEffect(() => {
    void useCopies.getState().refresh(workspaceId);
  }, [workspaceId]);
  const copyOf = (dirName: string) => copies.find((c) => c.id === dirName && c.state === "active");
  const cardAt = (path: string) => cards.find((c) => c.worktreePath === path);
  const rowLabel = (item: WorktreeInfo): string => {
    const copy = copyOf(item.dirName);
    if (copy) return copyTileMark(copy.name);
    return titleOf(item.dirName) ?? cardAt(item.worktreePath)?.title ?? "A card copy no card owns";
  };
  // 1.174.0 B4: `worktree_list` runs off the main thread, so two reads (a
  // workspace switch, a refresh after a delete) can answer out of order;
  // only the latest one is shown.
  const latest = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++latest.current;
    const current = () => mine === latest.current;
    setLoading(true);
    setErrorDetails(null);
    try {
      const list = await worktreeList(workspaceId);
      if (!current()) return;
      setItems(list);
      // Secondary, and never allowed to take the page down with it: a
      // workspace whose trash cannot be read still has worktrees worth
      // showing.
      try {
        const keptList = await worktreeKeptList(workspaceId);
        if (current()) setKept(keptList);
      } catch (e) {
        console.warn("worktrees: reading the kept entries failed:", e);
        if (current()) setKept([]);
      }
    } catch (e) {
      if (current()) setErrorDetails(String(e));
    } finally {
      if (current()) {
        setLoading(false);
        setRead(true);
      }
    }
  }, [workspaceId]);

  useEffect(() => {
    setRead(false);
    void refresh();
  }, [refresh]);

  async function onReveal(path: string) {
    try {
      await worktreeReveal(workspaceId, path);
    } catch (e) {
      pushErrorToast(`Couldn't open it in ${platformWord("fileManager")}`, e);
    }
  }

  async function onDelete(item: WorktreeInfo) {
    const copy = copyOf(item.dirName);
    if (copy) {
      // A2 routes it through the copy's own Throw away (its refusals, its
      // Trash record); Terminals › Copies can bring it back.
      const ok = await confirmSheet({
        title: `${THROW_AWAY} “${copy.name}”?`,
        body: "The copy moves to the Trash for 7 days. Terminals › Copies can bring it back until then.",
        confirmLabel: THROW_AWAY,
      });
      if (!ok) return;
      try {
        await worktreeDelete(workspaceId, item.worktreePath);
        pushToast({ kind: "info", title: "Copy thrown away", body: `${copy.name} stays in the Trash for 7 days.` });
        await refresh();
        void useCopies.getState().refresh(workspaceId);
      } catch (e) {
        pushErrorToast("Couldn't throw the copy away", e);
      }
      return;
    }
    const title = titleOf(item.dirName) ?? cardAt(item.worktreePath)?.title ?? item.dirName;
    const ok = await confirmSheet({
      title: `Delete the copy of “${title}”?`,
      body:
        `${item.worktreePath} (branch ${item.branchName ?? "unknown"}) moves to ` +
        `${worktreeTrashFolder(item.worktreePath)} for 7 days, then it is removed for good. ` +
        `Its branch is kept.`,
      confirmLabel: "Delete the copy",
      destructive: true,
    });
    if (!ok) return;
    try {
      const clearedCard = await worktreeDelete(workspaceId, item.worktreePath);
      pushToast({
        kind: "info",
        // QoL 1.168 block 8 (A4): plain words, also on this technical page.
        title: "Card copy moved to the Trash",
        body: clearedCard
          ? `"${clearedCard}" no longer has a copy of its own; the copy stays in the Trash for 7 days.`
          : `${title} stays in the Trash for 7 days.`,
      });
      await refresh();
    } catch (e) {
      // Challenger L4: it may have stopped part-way — say what is known.
      pushErrorToast("Couldn't delete the card copy", e, { then: "If it left the list, it's in the Trash." });
    }
  }

  async function onDeleteKept(entry: KeptTrashEntry) {
    const title = titleOf(entry.cardId) ?? entry.cardId;
    const ok = await confirmSheet({
      title: `Delete the kept folder from “${title}”?`,
      body:
        `Plyloft kept ${entry.path} because something in it was never judged — the ` +
        `card was deleted while the folder held work nothing had checked. ` +
        `Deleting it here removes it for good, now.`,
      confirmLabel: "Delete for good",
      destructive: true,
    });
    if (!ok) return;
    try {
      await worktreeKeptDelete(workspaceId, entry.dirName);
      pushToast({ kind: "info", title: "Kept folder deleted", body: entry.path });
      await refresh();
    } catch (e) {
      // Challenger L4: it may have stopped part-way — say what is known.
      pushErrorToast("Couldn't delete the card copy", e, { then: "If it left the list, it's in the Trash." });
    }
  }

  return (
    // 1.174.0 (DS5, scene 11): a page of its own, in its own words.
    <SettingsPage
      entry="board-worktrees"
      scope={scope}
      hiddenNote={hiddenNote}
      status={
        error ? (
          <>
            <StatusLine state="aborted">Plyloft couldn't read them.</StatusLine>
            <Details>
              <pre className="ux-output">{error}</pre>
            </Details>
          </>
        ) : loading ? (
          <StatusLine state="running">Reading the copies…</StatusLine>
        ) : null
      }
    >
      {/* GH #102: `Local <branch> can't be updated` sits here when the paths
          git named are not the Library's. */}
      <LocalBranchBlock workspaceId={workspaceId} on="worktrees" />
      {/* E3: the local branch's lasting state, said once in a toast, kept here. */}
      <LocalBranchState workspaceId={workspaceId} />

      <Section title="Copies" scope="this-mac" count={`${items.length}`}>
        {items.length === 0 && !loading && !error ? (
          // G2 walk: one Look again — "Read them again", below.
          <EmptyState>
            No card or copy has its own copy on this Mac right now.
          </EmptyState>
        ) : (
          <Group>
            {items.map((item) => (
              // GH #317: the card's words first — its title and where it is
              // on the board; the path and the branch are behind ⋯.
              <Row
                key={item.worktreePath}
                kind="item"
                label={rowLabel(item)}
                hint={
                  copyOf(item.dirName)
                    ? COPY_STARTED_HINT
                    : worktreeHint(columnOf(item.dirName) ?? cardAt(item.worktreePath)?.columnId)
                }
                action={
                  <CBtn onClick={() => void onReveal(item.worktreePath)}>Reveal</CBtn>
                }
                more={
                  <MoreMenu
                    label={`More for ${rowLabel(item)}`}
                    items={[
                      ...(item.branchName
                        ? [{ label: "Copy the branch name", onSelect: () => copy(item.branchName!) }]
                        : []),
                      { label: "Copy where it is", onSelect: () => copy(item.worktreePath) },
                      {
                        label: "Delete this copy",
                        danger: true,
                        onSelect: () => void onDelete(item),
                      },
                    ]}
                  />
                }
              />
            ))}
          </Group>
        )}
      </Section>

      {/* GH #116: nothing else in the app shows the trash, so a folder the
          card's delete could not judge would otherwise be invisible. */}
      {kept.length > 0 && (
        <Section title="Kept from deleted cards" scope="this-mac" count={`${kept.length}`}>
          <p className="ux-footnote">
            Something was written to these folders that the card's delete never judged, so Plyloft kept
            them instead of queueing them for the 7-day sweep. They stay until you deal with them.
          </p>
          <DangerZone>
            {kept.map((entry) => (
              <Row
                key={entry.path}
                kind="procedure"
                label={titleOf(entry.cardId) ?? `a card that was deleted — ${entry.cardId}`}
                hint="Reveal it to see what was written before you delete it."
                action={<CBtn onClick={() => void onReveal(entry.path)}>Reveal</CBtn>}
                more={
                  <MoreMenu
                    label={`More for ${entry.dirName}`}
                    items={[
                      { label: "Copy where it is", onSelect: () => copy(entry.path) },
                      {
                        label: "Delete for good",
                        danger: true,
                        onSelect: () => void onDeleteKept(entry),
                      },
                    ]}
                  />
                }
              />
            ))}
          </DangerZone>
        </Section>
      )}

      {/* 1.174.0 (DS2, SL-3): Fix failing checks by itself, the card-branch
          cleanup and the branches it kept are in Settings › Shipping. */}
      <Section title="Read them again" scope="this-mac">
        <Group>
          <Row
            kind="procedure"
            label="Look again"
            hint="Reads the copies on this Mac as they are now."
            action={
              <CBtn disabled={loading} onClick={() => void refresh()}>
                {loading ? "Looking…" : "Look again"}
              </CBtn>
            }
          />
        </Group>
      </Section>
    </SettingsPage>
  );
}

/** 1.174.0 (DS5, scene 11): a copy started from Terminals says so. */
export const COPY_STARTED_HINT = "started from Terminals";

/** GH #317: what a copy's row says under its card's title — that it is a
 *  card's, and where the card is on the board (the Board's own column
 *  names, 1.174.0 DS5); or that no card owns it. */
export function worktreeHint(column: KanbanColumnId | undefined): string {
  if (column === undefined) return "No card here owns it any more. Reveal it to look inside before you delete it.";
  // The store's "Todo" is the Board's Not started (1.171.0 A3, LG-19).
  const label = column === "todo" ? "Not started" : KANBAN_COLUMNS.find((c) => c.id === column)?.label;
  return label ? `card · ${label}` : "card";
}

function copy(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}
