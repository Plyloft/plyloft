// The card page's brainstorm banner, moved unchanged out of
// `CardDetailPanel.tsx` (its size ceiling, `file_size_ratchet_tests.rs`).
import { useEffect } from "react";
import type { MailboxEntry } from "../ipc";
import { EMPTY_ARRAY } from "../lib/empties";
import { useKanban } from "../store/kanbanStore";
import { useSwarms } from "../store/swarmStore";
import { openCenterMode } from "../store/uiStore";
import { Icon } from "./ux";

// ──────────────────────────────────────────────────────────────────────
// v1.26.0 (Cycle H): LinkedBrainstormBanner
//
// Surfaces a brainstorm linked to this card. Without this banner,
// completion is silent and the user has no signal that artifacts are
// waiting to be promoted into `knowledge`. Renders three categories of
// state by (status × artifact count); clicking the banner body opens
// Activity with this brainstorm selected (same route as
// `historyDeepLink.ts`); the ✕
// button records a dismiss into `card.dismissedBanners` so the banner
// hides without touching `linkedBrainstormId` (the durable routing
// PromoteButton's cross-restart fallback depends on — see
// `docs/design/card-roundtrip-audit.md` Finding #1, v1.27.0).
// ──────────────────────────────────────────────────────────────────────

const EMPTY_MAILBOX: MailboxEntry[] = EMPTY_ARRAY;
const BRAINSTORM_BANNER_PREFIX = "brainstorm:";
const DISMISSED_BANNERS_CAP = 16;

export function LinkedBrainstormBanner({
  workspaceId,
  cardId,
  linkedBrainstormId,
  dismissedBanners,
}: {
  workspaceId: string;
  cardId: string;
  linkedBrainstormId: string | null;
  dismissedBanners: string[];
}) {
  const swarm = useSwarms((s) =>
    linkedBrainstormId
      ? s.byWorkspace[workspaceId]?.swarms.find(
          (sw) => sw.id === linkedBrainstormId,
        ) ?? null
      : null,
  );
  const entries = useSwarms((s) =>
    linkedBrainstormId
      ? s.byWorkspace[workspaceId]?.mailboxes[linkedBrainstormId] ??
        EMPTY_MAILBOX
      : EMPTY_MAILBOX,
  );
  const mailboxCached = useSwarms((s) =>
    linkedBrainstormId
      ? !!s.byWorkspace[workspaceId]?.mailboxes[linkedBrainstormId]
      : false,
  );

  // Lazy-load the mailbox the first time we render with a linked
  // brainstorm whose entries haven't been fetched yet (e.g. a brainstorm
  // from a prior session that the user has never opened in this run).
  useEffect(() => {
    if (linkedBrainstormId && !mailboxCached) {
      void useSwarms
        .getState()
        .loadMailbox(workspaceId, linkedBrainstormId);
    }
  }, [linkedBrainstormId, mailboxCached, workspaceId]);

  // v1.27.4 hotfix: if linkedBrainstormId is set but the swarm record
  // isn't in our cache, force a per-swarm refresh. The App.tsx-level
  // preload (v1.27.3) handles the common case at workspace activation,
  // but a swarm that doesn't appear in swarmList's first page — or any
  // future timing edge — would silently hide the banner. This belt-and-
  // suspenders fetch guarantees the banner can resolve.
  useEffect(() => {
    if (linkedBrainstormId && !swarm) {
      void useSwarms
        .getState()
        .refreshSwarm(workspaceId, linkedBrainstormId);
    }
  }, [linkedBrainstormId, swarm, workspaceId]);

  if (!linkedBrainstormId) return null;
  // Render gate: dismissal hides the banner without destroying
  // `linkedBrainstormId`, so the PromoteButton cross-restart fallback
  // at `PromoteButton.useLinkedCardId` keeps resolving this card.
  const dismissKey = `${BRAINSTORM_BANNER_PREFIX}${linkedBrainstormId}`;
  if (dismissedBanners.includes(dismissKey)) return null;

  const artifactCount = entries.filter((e) => e.kind === "artifact").length;
  // v1.27.4: when the swarm record isn't cached yet (e.g. mid-refresh
  // race), render a neutral "linked — state unknown" variant rather
  // than silently hiding. The card persists `linkedBrainstormId`, so
  // we KNOW a brainstorm is linked; pretending otherwise is the bug.
  const variant = swarm
    ? bannerVariant(swarm.status, artifactCount)
    : bannerVariant("unknown", artifactCount);

  const onOpen = () => {
    // v1.81.0 (P2-3): the Swarm tab is retired — the brainstorm's live
    // detail is this banner's own feed; the jump target is Activity.
    useSwarms.getState().setActiveSwarm(workspaceId, linkedBrainstormId);
    openCenterMode(workspaceId, "activity");
  };

  const onDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Idempotent add + FIFO cap. Filter first so re-dismissing an
    // already-present key doesn't grow the array; slice(-N) keeps
    // the most-recent N entries.
    const existing = dismissedBanners.filter((k) => k !== dismissKey);
    const next = [...existing, dismissKey].slice(-DISMISSED_BANNERS_CAP);
    void useKanban.getState().updateCard(cardId, { dismissedBanners: next });
  };

  return (
    <div
      className={`card-detail-brainstorm-banner card-detail-brainstorm-banner--${variant.tone}`}
    >
      <button
        type="button"
        className="card-detail-brainstorm-banner-body"
        onClick={onOpen}
        aria-label={`${variant.label} — click to open in Activity`}
        title="Open this brainstorm in Activity"
      >
        <span className="card-detail-brainstorm-banner-icon">
          {variant.icon}
        </span>
        <span className="card-detail-brainstorm-banner-text">
          {variant.label}
        </span>
      </button>
      <button
        type="button"
        className="card-detail-brainstorm-banner-dismiss"
        onClick={onDismiss}
        title="Hide this banner"
        aria-label="Dismiss brainstorm banner"
      >
        <Icon name="close" size="sm" />
      </button>
    </div>
  );
}

function bannerVariant(
  status: string,
  artifactCount: number,
): { tone: "running" | "done" | "aborted" | "empty"; icon: string; label: string } {
  // v1.27.4: "unknown" is the synthetic status the banner passes in
  // when the swarm record is missing from the FE cache. Render a
  // neutral "linked" message rather than misclassifying as "ended
  // early" (which is what the catch-all aborted branch would do).
  if (status === "unknown") {
    return {
      tone: "empty",
      icon: "·",
      label:
        artifactCount > 0
          ? `Brainstorm linked — ${artifactCount} ${pluralize(
              "insight",
              "insights",
              artifactCount,
            )} cached, open Activity to review`
          : "Brainstorm linked — open Activity to review",
    };
  }
  // "suspended" is treated as in-flight: the swarm can be resumed and is
  // not yet a terminal state. Only "done" gets the green-finished tone;
  // every other terminal kind (aborted / failed / timed_out / max_iter)
  // gets the amber aborted tone.
  if (status === "running" || status === "suspended") {
    return {
      tone: "running",
      icon: "·",
      label:
        artifactCount === 0
          ? "Brainstorm running — waiting on first response…"
          : `Brainstorm running — ${artifactCount} ${pluralize(
              "entry",
              "entries",
              artifactCount,
            )} so far`,
    };
  }
  if (status === "done") {
    return {
      tone: artifactCount === 0 ? "empty" : "done",
      icon: "·",
      label:
        artifactCount === 0
          ? "Brainstorm ended — no insights produced"
          : `Brainstorm finished — ${artifactCount} ${pluralize(
              "insight",
              "insights",
              artifactCount,
            )} ready to review`,
    };
  }
  // aborted, failed, timed_out, max_iter — partial-result variant
  return {
    tone: artifactCount === 0 ? "empty" : "aborted",
    icon: "·",
    label:
      artifactCount === 0
        ? "Brainstorm ended before any role completed"
        : `Brainstorm ended early — ${artifactCount} partial ${pluralize(
            "insight",
            "insights",
            artifactCount,
          )} available`,
  };
}

function pluralize(singular: string, plural: string, n: number): string {
  return n === 1 ? singular : plural;
}
