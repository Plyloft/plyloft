import { CBtn, CIcon } from "./ux";
import { GUIDED_PERMISSION_MODE, guidedSessionTitle } from "../lib/firstCardGuide";
import { type KanbanCard } from "../store/kanbanStore";
import { type ReactNode } from "react";
import { cardShippedOrPrOpen, uniqueSnapshots } from "../lib/cardLifecycle";
import { describeWorktreeBase } from "../lib/worktreeBase";
import { isUndecided, laneOf, laneVendorName } from "../lib/buildBoth";
import { isWindows, platformWord } from "../lib/platform";
import { linkDidNotOpen } from "../lib/linkToast";
import { openWebLink } from "../ipc";
import { portHint, portRangeWords } from "../lib/worktreeSetup";
import { reviewOnly } from "../lib/prReview";
import { createdByValue } from "../lib/issueText";
import { pushToast } from "../store/toastStore";
import { useTiles } from "../store/tileStore";
import { openCenterMode } from "../store/uiStore";
import { rawError } from "../lib/cardPage";
import { sessionPermissionsWords } from "../lib/builderPermissions";
import { shipTargetOf } from "../lib/deliveryStage";
import { usedModelWords } from "../lib/cardModels";

export const OPEN_WORKTREE_TERMINAL_LABEL = "Open a terminal in the card's copy";

/** #370 gap (Tier 4 walk 2026-10-14): an ordinary shell tile whose cwd is
 *  the card's worktree, shown on the workspace's terminals. Its PTY is
 *  `pty_spawn`'s, which gives a spawn in a card worktree that worktree's
 *  PLYLOFT_PORT_BASE / PLYLOFT_PORT_COUNT (`worktree_ports::env_for_cwd`). */
export function openWorktreeTerminal(workspaceId: string, cardCopy: string): void {
  useTiles.getState().addShellTile(workspaceId, cardCopy);
  openCenterMode(workspaceId, "terminals");
}

/** UX-6.2: what a person needs only to go looking — branch, worktree,
 *  snapshots, model ids — under "Technical details". */
export function CardTechnicalDetails({
  card,
  claim,
  reviewNote,
}: {
  card: KanbanCard;
  claim: ReactNode;
  /** 1.171.0 C2 (CF11, K3): a review Plyloft delivers to the Builder by
   *  itself, said here only. */
  reviewNote?: string | null;
}) {
  const base = card.worktreeBase ? describeWorktreeBase(card.worktreeBase) : null;
  const snapshots = card.builder ? uniqueSnapshots(card.builder.snapshots) : [];
  const path = card.worktreePath ?? null;

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      pushToast({ kind: "info", title: `${what} copied`, body: text });
    } catch (e) {
      pushToast({ kind: "warn", title: `${what} couldn't be copied`, body: "Select it and copy it by hand.", copyText: rawError(e) });
    }
  }
  async function reveal() {
    if (!path) return;
    try {
      const { worktreeReveal } = await import("../ipc");
      await worktreeReveal(card.workspaceId, path);
    } catch (e) {
      pushToast({ kind: "warn", title: `${platformWord("fileManager")} couldn't show the worktree`, body: path, copyText: rawError(e) });
    }
  }

  const rows: { label: string; value: ReactNode }[] = [];
  if (card.branchName) rows.push({ label: "Branch", value: <code className="ux-card-mono">{card.branchName}</code> });
  if (base) rows.push({ label: "Started", value: <span title={base.title} data-ply-card-base={card.worktreeBase?.commit}>{base.label}</span> });
  if (path) {
    rows.push({
      label: "Card's copy",
      value: (
        <>
          <code className="ux-card-mono ux-card-tech-grow">{path}</code>
          <CIcon icon="copy" tone="quiet" aria-label="Copy the path of the card's copy" title="Copy the path" onClick={() => void copy(path, "Path of the card's copy")} />
          <CIcon icon="reveal" tone="quiet" aria-label={`Show the card's copy in ${platformWord("fileManager")}`} title={platformWord("showIn")} onClick={() => void reveal()} />
          {/* 1.175.0 G7 (proof P3): never in the copy of a pull request
              somebody else opened — a session there would run that copy's
              own settings without asking. */}
          {!card.archived && !reviewOnly(card) && (
            <CIcon
              icon="terminals"
              tone="quiet"
              aria-label={OPEN_WORKTREE_TERMINAL_LABEL}
              title={`${OPEN_WORKTREE_TERMINAL_LABEL} — it gets this card's ports`}
              onClick={() => openWorktreeTerminal(card.workspaceId, path)}
            />
          )}
        </>
      ),
    });
  }
  if (path && card.portBase != null) {
    rows.push({
      label: "Ports",
      value: (
        <span className="ux-card-tech-stack" data-ply-card-ports={card.portBase}>
          <code className="ux-card-mono">{portRangeWords(card.portBase)}</code>
          <span className="ux-card-tech-hint">{portHint(isWindows())}</span>
        </span>
      ),
    });
  }
  // Build with both: the second build's worktree has ports of its own.
  const laneB = isUndecided(card) ? laneOf(card.buildBoth, "b") : undefined;
  if (path && laneB?.portBase != null) {
    rows.push({
      label: `${laneVendorName(laneB, "b")}'s ports`,
      value: (
        <code className="ux-card-mono" data-ply-card-ports-lane="b">
          {portRangeWords(laneB.portBase)}
        </code>
      ),
    });
  }
  if (snapshots.length > 0) {
    rows.push({
      label: "Snapshots",
      value: (
        <span className="ux-card-snapshots">
          {snapshots.map((s) => (
            <code key={s.n} className="ux-card-mono" title={new Date(s.at).toLocaleString()}>
              #{s.n} {s.sha.slice(0, 8)}
            </code>
          ))}
        </span>
      ),
    });
  }
  // 1.168.1 (E3): what the session and the review ran on — what Plyloft
  // passed, or the tool's default when it passed none.
  if (card.builder) rows.push({ label: "Builder model", value: <code className="ux-card-mono">{usedModelWords(card.builder.model)}</code> });
  if (card.builder?.review && card.builder.review.status !== "skipped") {
    rows.push({ label: "Reviewer model", value: <code className="ux-card-mono">{usedModelWords(card.builder.review.model)}</code> });
  }
  if (reviewNote) rows.push({ label: "The review", value: <span data-ply-owed-verdict-note="">{reviewNote}</span> });
  const chosen = card.builder ? sessionPermissionsWords(card.builder.permissions, card.builder.vendor) : null;
  if (chosen) rows.push({ label: "Permissions", value: chosen.title });
  else if (card.builder?.bypass) rows.push({ label: "Permissions", value: "Built without asking" });
  else if (card.builder?.permissionMode === GUIDED_PERMISSION_MODE) {
    rows.push({ label: "Permissions", value: guidedSessionTitle(card.builder.vendor, cardShippedOrPrOpen(card), shipTargetOf(card)) });
  }
  if (card.prUrl) {
    rows.push({
      label: "Pull request",
      value: (
        <>
          <code className="ux-card-mono ux-card-tech-grow">{card.prUrl}</code>
          <CIcon icon="copy" tone="quiet" aria-label="Copy the pull request link" title="Copy the link" onClick={() => void copy(card.prUrl!, "Pull request link")} />
          {/* 1.169.1 (R13, Challenger): opened from beside its link too. */}
          <CBtn
            tone="quiet"
            size="sm"
            aria-label="Open the pull request on GitHub"
            data-ply-tech-pr-open=""
            onClick={() =>
              void openWebLink(card.prUrl!).catch((e: unknown) =>
                pushToast(linkDidNotOpen(card.prUrl!, e)),
              )
            }
          >
            Open
          </CBtn>
        </>
      ),
    });
  }
  if (card.syncPending || card.ghLabelsPending) {
    rows.push({ label: "GitHub", value: "A local edit is not on the issue yet — the next Sync retries it." });
  }
  if (claim) rows.push({ label: "Claim", value: claim });
  // U8: the GitHub login when the issue says it, not this Mac's git email.
  const createdBy = card.ghAuthor || card.author;
  // 1.175.0 (B3): an issue's author outside the repository is said so.
  if (createdBy) {
    rows.push({ label: "Created by", value: card.ghAuthor ? createdByValue(createdBy, card.ghAuthorAssociation) : createdBy });
  }
  rows.push({ label: "Card id", value: <code className="ux-card-mono">{card.id}</code> });
  return (
    <dl className="ux-card-tech">
      {rows.map((r) => (
        <div key={r.label} className="ux-card-tech-row">
          <dt className="ux-card-tech-label">{r.label}</dt>
          <dd className="ux-card-tech-value">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
