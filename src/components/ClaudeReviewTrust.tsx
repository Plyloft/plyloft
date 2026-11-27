import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  claudeReviewTrustStatus,
  reviewerCapabilityProbe,
  type ClaudeReviewTrust,
} from "../ipc";
import { showsTrustStep, trustStepError, type TrustSubject } from "../lib/claudeReviewTrust";
import { useDoctor } from "../store/doctorStore";
import { useTiles } from "../store/tileStore";
import { openCenterMode, useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { ErrorBlock } from "./ux";
import { pushErrorToast } from "../lib/errorToast";

/**
 * "Claude needs to trust Plyloft's review folder." Claude's interactive TUI
 * asks whether to trust a folder it has not seen, and Plyloft never answers
 * it (`claude_session::FOLDER_TRUST_REFUSAL`). The member answers once, in a
 * Claude tile Plyloft opens on its session folder (`<config>/claude-sessions`,
 * which holds none of Plyloft's state); every session folder below it
 * inherits the trust.
 *
 * It reads `claude_review_trust_status` itself, and shows only when Claude
 * says the folder is untrusted — or, when Claude's state is unreadable, when
 * a session already met the question (`refused`). `Look again` re-reads it
 * and, once trusted, proves the Claude reviewer again through the usual
 * probe, then refreshes the doctor so every reviewer surface agrees.
 *
 * The tile is an ordinary Claude tile (`tileStore.addClaudeTile`): its PTY is
 * the one `Terminal` spawns, with the cached PATH, killed on exit like any
 * other. Nothing here spawns anything.
 */
export function ClaudeReviewTrustStep({
  refused = false,
  workspaceId,
  density = "page",
  subject = "review",
  whenTrusted,
  onTrusted,
}: {
  /** What stopped at the question (the words under the title). */
  subject?: TrustSubject;
  /** Drawn instead of nothing once Claude trusts the folder. */
  whenTrusted?: ReactNode;
  /** A Claude session already stopped at the trust question. */
  refused?: boolean;
  /** Where the tile opens; absent → the active workspace. */
  workspaceId?: string;
  density?: "page" | "dense";
  /** Called once Look again found the folder trusted (after the probe). */
  onTrusted?: () => void;
}) {
  const activeId = useWorkspaces((s) => s.activeId);
  const wsId = workspaceId ?? activeId;
  const wsKnown = useWorkspaces((s) => (wsId ? s.workspaces.some((w) => w.id === wsId) : false));
  const [status, setStatus] = useState<ClaudeReviewTrust | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      const next = await claudeReviewTrustStatus();
      setStatus(next);
      return next;
    } catch {
      setStatus(null);
      return null;
    }
  }, []);

  // Read again when a session has just met the question: the answer read
  // on mount may be older than that.
  useEffect(() => {
    void read();
  }, [read, refused]);

  if (status?.trusted === true && whenTrusted) return <>{whenTrusted}</>;
  if (!status || !showsTrustStep(status.trusted, refused)) return null;

  const noWorkspace = !wsId || !wsKnown;

  const open = () => {
    if (!wsId || noWorkspace) return;
    const tile = useTiles.getState().addClaudeTile(wsId, status.folder);
    openCenterMode(wsId, "terminals");
    useTiles.getState().setExpanded(wsId, tile.id);
    // Settings is a modal over the app, so the tile would open behind it.
    if (useUi.getState().settingsOverlayOpen) useUi.getState().setSettingsOverlayOpen(false);
  };

  const check = async () => {
    setBusy("check");
    try {
      const next = await read();
      setChecked(true);
      if (next?.trusted !== true) return;
      try {
        await reviewerCapabilityProbe("claude");
      } catch (e) {
        pushErrorToast("Claude is trusted, but its reviewer proof didn't finish.", e, { then: "Run the proof again from Settings › Setup and account › Diagnostics." });
      }
      await useDoctor.getState().refresh();
      onTrusted?.();
    } finally {
      setBusy(null);
    }
  };

  return (
    <ErrorBlock
      error={trustStepError(status.folder, checked && status.trusted === false, noWorkspace, subject)}
      density={density}
      busy={busy}
      onAction={(id) => {
        if (id === "open") open();
        else if (id === "check") void check();
      }}
    />
  );
}
