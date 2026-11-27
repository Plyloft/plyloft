import { useKanban } from "../store/kanbanStore";
import { useSwarms } from "../store/swarmStore";
import { useUi } from "../store/uiStore";
import { pushToast, UNDO_TOAST_MS } from "../store/toastStore";
import type { MailboxEntry } from "../ipc";
import { CBtn } from "./ux";
import { pushErrorToast } from "../lib/errorToast";

type Props = {
  workspaceId: string;
  swarmId: string;
  entry: MailboxEntry;
};

/**
 * v1.24.0 (Cycle G4): hover affordance on brainstorm `MailboxEntry`
 * messages. Click → appends the entry's body (or report summary text)
 * to the originating card's `knowledge` field with a provenance
 * prefix. Toast with 10s Undo.
 *
 * Linked-card resolution chain:
 *   1. `swarmStore.linkedCardId[swarmId]` — session-only map populated
 *      when a brainstorm was launched from a card's context.
 *   2. `kanban.cards.find(c => c.linkedSwarmId === swarmId)` — fallback
 *      for card-driven swarms (kanban moveCard flow) and for
 *      brainstorms launched in a prior session.
 *
 * If neither resolves, the button is hidden entirely (the parent's
 * `findLinkedCardId` returns null and short-circuits the render).
 */
export function PromoteButton({ workspaceId, swarmId, entry }: Props) {
  const cardId = useLinkedCardId(workspaceId, swarmId);
  if (!cardId) return null;

  const text = bodyToText(entry);
  if (!text) return null;

  // Pin `text` non-null for the closure body — TS narrowing doesn't
  // survive across the async-handler boundary without an alias.
  const promotedText = text;

  async function onClick(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (!cardId) return;

    const cards =
      useKanban.getState().byWorkspace[workspaceId]?.cards ?? [];
    const card = cards.find((c) => c.id === cardId);
    if (!card) {
      pushToast({
        kind: "error",
        title: "Card not found",
        body: "The originating card may have been archived or deleted.",
      });
      return;
    }

    const prev = card.knowledge ?? "";
    const stamp = formatTimestamp(entry.ts);
    const role = entry.role ? `role/${entry.role}` : `kind/${entry.kind}`;
    const provenance = `> [from brainstorm ${stamp}, ${role}]`;
    const addition = `${provenance}\n${promotedText.trim()}`;
    const next = prev ? `${prev}\n\n${addition}` : addition;

    try {
      await useKanban.getState().updateCard(cardId, { knowledge: next });
    } catch (err) {
      pushErrorToast("It wasn't added to the card's notes", err);
      return;
    }

    // v1.25.1 hotfix, re-homed v1.76.0: set uiStore.selectedCardId so
    // the promoted-to card's lifecycle is the open one the next time
    // the user lands on the Board. `openBoard: false` keeps the user on
    // their current history surface; we only set the state.
    useUi.getState().selectCard(workspaceId, cardId, false);

    pushToast({
      kind: "info",
      title: `Added to the notes of “${card.title}”`,
      body: "The Builder gets them on this card's next run.",
      action: {
        label: "Undo",
        ttlMs: UNDO_TOAST_MS,
        onClick: () => {
          // The prev value is captured by closure — no race with
          // concurrent edits since the user has ≤10s before this
          // expires anyway. If the card was edited externally in that
          // window, prev still represents the snapshot the user saw
          // when they clicked Promote.
          useKanban
            .getState()
            .updateCard(cardId, { knowledge: prev || null })
            .catch((e) =>
              pushErrorToast("Undo failed", e),
            );
        },
      },
    });
  }

  // GH #255: the card's longer notes are "Notes for the Builder" now; no
  // page shows a Knowledge store.
  return (
    <CBtn
      tone="quiet"
      onClick={onClick}
      title="Add this to the linked card's notes for the Builder"
    >
      Add to the card's notes
    </CBtn>
  );
}

/**
 * Hook variant of the resolution chain so React can subscribe to both
 * stores. Returns `null` when no linked card can be found in either
 * source.
 *
 * v1.26.0 (Cycle H): the kanban-side fallback now checks both
 * `linkedSwarmId` (card-driven dispatch via moveCard) and
 * `linkedBrainstormId` (brainstorm launched from CardDetailPanel).
 * Separate fields are required because moveCard overwrites
 * `linkedSwarmId` on dispatch — using a shared field would orphan the
 * brainstorm after the user confirms intake.
 */
function useLinkedCardId(workspaceId: string, swarmId: string): string | null {
  const fromMap = useSwarms((s) => s.linkedCardId[swarmId] ?? null);
  const fromKanban = useKanban((s) => {
    const cards = s.byWorkspace[workspaceId]?.cards ?? [];
    return (
      cards.find(
        (c) =>
          c.linkedSwarmId === swarmId || c.linkedBrainstormId === swarmId,
      )?.id ?? null
    );
  });
  return fromMap ?? fromKanban;
}

/**
 * Render a `MailboxEntry`'s body as text suitable for the card
 * knowledge field. Returns null when the entry has nothing
 * promote-worthy.
 *
 * - `artifact` entries: body is a JSON value (per swarms.rs §3
 *   `append_run_completion`). String body → use as-is; object → JSON
 *   stringify with indent.
 * - `report` entries: body is null; surface `run_summary` text from
 *   the run's transcript would require a separate fetch. For now,
 *   format the summary metadata so the user can see what was promoted
 *   (status + bytes). Better than skipping outright since the
 *   user may be promoting "checkpoint X passed" as context.
 * - other kinds: skip.
 */
function bodyToText(entry: MailboxEntry): string | null {
  if (entry.kind === "artifact") {
    if (typeof entry.body === "string") return entry.body.trim() || null;
    if (entry.body == null) return null;
    try {
      return JSON.stringify(entry.body, null, 2);
    } catch {
      return null;
    }
  }
  if (entry.kind === "report" && entry.runSummary) {
    const s = entry.runSummary;
    const model = s.model ? ` · ${s.model}` : "";
    return `Role: ${s.role} · status: ${s.status} · bytes: ${s.bytesWritten}${model}`;
  }
  return null;
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}
