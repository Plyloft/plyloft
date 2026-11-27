// 1.171.0 D3 (FR-5): the card's line when the project folder has changes
// not saved in Git — its copy started from the last saved version and
// doesn't have them. Read when the card opens, when it changes and when the
// window comes back (the person may save or add work in between), at most
// once every 15 s; read-only, without Git's optional lock.
import { useEffect, useRef, useState } from "react";
import type { KanbanCard } from "../ipc";
import { projectUnsavedFiles } from "../ipc";
import { cardShippedOrPrOpen } from "../lib/cardLifecycle";
import { asksAboutUnsavedWork, startedWithoutLine } from "../lib/unsavedWork";
import { useWorkspaces } from "../store/workspaceStore";

const REREAD_MS = 15_000;

export function UnsavedWorkLine({ card }: { card: KanbanCard }) {
  const folder = useWorkspaces((s) => s.workspaces.find((w) => w.id === card.workspaceId)?.cwd ?? null);
  const asks =
    folder !== null &&
    asksAboutUnsavedWork({
      worktreePath: card.worktreePath,
      archived: card.archived,
      prReview: card.prReview,
      landed: cardShippedOrPrOpen(card),
    });
  const target = card.worktreeBase?.refName ?? null;
  const [line, setLine] = useState<{ cardId: string; text: string | null } | null>(null);
  const [looked, setLooked] = useState(0);
  const lastRead = useRef(0);
  useEffect(() => {
    if (!asks) return;
    const again = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastRead.current < REREAD_MS) return;
      setLooked((n) => n + 1);
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [asks]);
  useEffect(() => {
    if (!asks || folder === null) return;
    let cancelled = false;
    lastRead.current = Date.now();
    projectUnsavedFiles(folder)
      .then((unsaved) => {
        if (!cancelled) setLine({ cardId: card.id, text: startedWithoutLine(unsaved, target) });
      })
      .catch(() => {
        if (!cancelled) setLine(null);
      });
    return () => {
      cancelled = true;
    };
  }, [asks, folder, card.id, target, looked]);
  const text = asks && line?.cardId === card.id ? line.text : null;
  return text ? (
    <p className="ux-card-muted" data-ply-card-unsaved-work="">
      {text}
    </p>
  ) : null;
}
