import { useEffect, useState } from "react";
import { cardOverlapCheck, type OverlapWarning } from "../ipc";
import { useSolo } from "../store/workModeStore";
import { Icon } from "./ux";
import { overlapChipWords } from "../lib/reviewSection";

/** The overlap rows for this card, read once per page (card, solo). Null
 *  while not read; an empty list when nothing overlaps or the read failed. */
export function useOverlapWarnings(workspaceId: string, cardId: string, enabled = true): OverlapWarning[] | null {
  const [read, setRead] = useState<{ key: string; warnings: OverlapWarning[] } | null>(null);
  // OB-9 (onboarding §10 row 8): in solo mode the teammates' pull requests
  // are not fetched; the local half stays.
  const solo = useSolo();
  const key = `${workspaceId}\u0000${cardId}\u0000${solo}`;

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    cardOverlapCheck(workspaceId, cardId, !solo)
      .then((w) => {
        if (live) setRead({ key, warnings: w });
      })
      .catch(() => {
        if (live) setRead({ key, warnings: [] }); // advisory: quiet degrade
      });
    return () => {
      live = false;
    };
  }, [workspaceId, cardId, solo, key, enabled]);

  if (!enabled || read?.key !== key) return null;
  // A teammate row read before the switch to solo is not drawn either.
  return solo ? read.warnings.filter((w) => w.kind !== "teammate_pr") : read.warnings;
}

/**
 * v1.86.0 (team-tier roadmap cycle 3): the pre-merge overlap warning —
 * advisory rows naming the files this card's work shares with other
 * in-flight cards (free) or teammates' open PRs (team-gated backend-
 * side; unlicensed just gets no PR rows). Rendered by the card
 * lifecycle's Run and Ship steps. Self-gating: nothing → renders null.
 *
 * SP-2: the result's one overlap warning — the amber `.ux-conflict` callout
 * with the warning icon, "Overlapping edits · Shipping both may conflict
 * on: …" (the workspace-wide `ConflictBanner` no longer repeats it there).
 */
export function OverlapWarnings({
  workspaceId,
  cardId,
  warnings: given,
}: {
  workspaceId: string;
  cardId: string;
  /** 1.172.0 (C2): the rows the card page read once for its chip under Now
   *  and its Review; without them this reads its own. */
  warnings?: OverlapWarning[] | null;
}) {
  if (given !== undefined) return <OverlapList warnings={given ?? []} />;
  return <OverlapWarningsRead workspaceId={workspaceId} cardId={cardId} />;
}

function OverlapWarningsRead({ workspaceId, cardId }: { workspaceId: string; cardId: string }) {
  return <OverlapList warnings={useOverlapWarnings(workspaceId, cardId) ?? []} />;
}

function OverlapList({ warnings: shown }: { warnings: OverlapWarning[] }) {
  if (shown.length === 0) return null;

  return (
    <div className="ux-conflict" role="note" data-ply-overlap-warnings="">
      <strong className="ux-conflict-head">
        <Icon name="warning" size="sm" />
        Overlapping edits
      </strong>
      <p className="ux-conflict-sub">Shipping both may conflict on:</p>
      <ul className="ux-conflict-list">
        {shown.map((w) => (
          <li key={`${w.kind}:${w.otherId}`}>
            <span>{w.kind === "teammate_pr" ? w.otherTitle : `card “${w.otherTitle}”`}</span>
            {" · "}
            <code>
              {w.files.slice(0, 6).join(", ")}
              {w.files.length > 6 ? ` +${w.files.length - 6} more` : ""}
            </code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 1.172.0 (C2; CP-19): under Now on Ready to ship, beside Ship it — one line
 * saying who else changes these files and what to do. The files stay in the
 * Review's list.
 */
export function OverlapChip({ warnings, target }: { warnings: OverlapWarning[] | null; target: string | null }) {
  const words = overlapChipWords(warnings ?? [], target);
  if (!words) return null;
  return (
    <p className="ux-overlap-chip" role="note" data-ply-overlap-chip="">
      {/* 1.174.0 (A7, P32): an outline chip with an amber dot. */}
      <span className="ux-overlap-chip-dot" aria-hidden="true" />
      <span>{words}</span>
    </p>
  );
}
