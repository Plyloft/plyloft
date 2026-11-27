import { useEffect } from "react";
import type { KanbanCard } from "../ipc";
import { FINISH_LABEL } from "../lib/cardLifecycle";
import { ASK_BUILDER_LABEL, ASK_BUILDER_TITLE, syncConflictHeadline } from "../lib/shipConflict";
import {
  askBuilderOnLine,
  bringInLabel,
  bringInOffered,
  bringInTitle,
  cardTarget,
  targetSyncBadge,
  targetSyncSentence,
} from "../lib/targetSync";
import { useBuilder } from "../store/builderStore";
import { finishAndCheck } from "../store/finishAndCheck";
import { useTargetSync } from "../store/targetSyncStore";
import { CBtn } from "./ux";

/**
 * 1.170.0 (G6): under the card's Now — "Behind main" or "Conflict ahead",
 * what it means, and Bring in main's changes (only ever on the press). A
 * merge waiting in the card's copy says Finish and check commits it. The
 * page reads GitHub's target again when it opens (bounded, throttled).
 *
 * 1.174.0 (A7, VC-2 · P32; mockups/card-done.html §1, §2): one filled button
 * per view. While Now has its own primary (`nowHasPrimary`), every press
 * here is bordered; without one, Finish and check may stay filled. The badge
 * is text with an amber dot, not a chip — left out when Now's headline
 * already says the conflict ("Conflict with main", `nowHeadline`).
 */
export function TargetSyncLine({
  card,
  nowHasPrimary = false,
  nowHeadline,
}: {
  card: KanbanCard;
  nowHasPrimary?: boolean;
  /** Now's headline as drawn (its title, else its label). */
  nowHeadline?: string;
}) {
  const report = useTargetSync((s) => s.byWorkspace[card.workspaceId]);
  const pressing = useTargetSync((s) => Boolean(s.pressing[card.id]));
  const asking = useBuilder((s) => s.fixBusy[card.id] != null);
  useEffect(() => {
    void useTargetSync.getState().refresh(card.workspaceId, true);
  }, [card.workspaceId, card.id]);
  if (!report) return null;
  const sync = report.cards[card.id];
  // 1.173.0 (B3): the card's area's branch, when it isn't the workspace's.
  const target = cardTarget(report, card.id);
  const sentence = targetSyncSentence(card, sync, target);
  if (!sentence) return null;
  const badge = targetSyncBadge(card, sync, target);
  // A7 round 1: Now saying "Conflict with main" needs no second conflict word.
  const echoed =
    badge?.kind === "conflict" && nowHeadline === syncConflictHeadline(card.shipConflict?.branch || target);
  return (
    <div className="ux-target-sync" data-ply-target-sync={badge?.kind ?? "merging"}>
      <p className="ux-card-muted">
        {badge && !echoed && (
          <span className="ux-target-sync-lead" title={badge.title}>
            <span className="ux-target-sync-dot" aria-hidden="true" />
            {badge.label}
          </span>
        )}{" "}
        {sentence}
      </p>
      {sync?.merging && !badge && card.builder && card.lastRunStatus !== "running" && (
        <CBtn
          tone={nowHasPrimary ? undefined : "accent"}
          data-ply-bring-in-finish=""
          onClick={() =>
            void (async () => {
              await finishAndCheck(card.workspaceId, card.id);
              await useTargetSync.getState().refresh(card.workspaceId, false);
            })()
          }
        >
          {FINISH_LABEL}
        </CBtn>
      )}
      {/* (orchestrator #8) An open pull request's bring-in that met a
          conflict: Plyloft starts the merge for the Builder, which only
          resolves it. */}
      {askBuilderOnLine(card) && (
        <CBtn
          title={ASK_BUILDER_TITLE}
          disabled={asking}
          data-ply-bring-in-ask=""
          onClick={() =>
            void (async () => {
              await useBuilder.getState().resolveShipConflict(card.workspaceId, card.id);
              await useTargetSync.getState().refresh(card.workspaceId, false);
            })()
          }
        >
          {ASK_BUILDER_LABEL}
        </CBtn>
      )}
      {bringInOffered(card, sync, target) && (
        <CBtn
          title={bringInTitle(target)}
          disabled={pressing}
          data-ply-bring-in=""
          onClick={() => void useTargetSync.getState().bringIn(card.workspaceId, card.id)}
        >
          {pressing ? "Bringing in…" : bringInLabel(target)}
        </CBtn>
      )}
    </div>
  );
}
