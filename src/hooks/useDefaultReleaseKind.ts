import { usePutOnGithub } from "../store/putOnGithubStore";
import { useEffect, useState } from "react";
import { workspaceShipOffersPr, type ReleaseKind } from "../ipc";
import { chosenDefaultKind, defaultReleaseKind } from "../lib/shippingPage";
import { useAreasView } from "../store/areaStore";
import { useWorkspaces } from "../store/workspaceStore";

/**
 * G1 Challenger (6) of 1.170.0: whether the workspace's Ship it can open a
 * pull request — the card's own reading (`CardOutcome.hasRemote`), so a
 * GitHub Enterprise project reads as Ship it does. null while it is read,
 * or when it can't be.
 */
export function useShipOffersPr(workspaceId: string | null): boolean | null {
  const reading = useShipOffersPrReading(workspaceId);
  return typeof reading === "boolean" ? reading : null;
}

/** The same reading with its failure: "reading" until it answers, "failed"
 *  when it can't (the workspace's folder can't be resolved). */
export function useShipOffersPrReading(workspaceId: string | null): boolean | "reading" | "failed" {
  const [answer, setAnswer] = useState<{ id: string; on: boolean | "failed" } | null>(null);
  // 1.175.0 F3: read again once the project was put on GitHub.
  const putCount = usePutOnGithub((s) => (workspaceId ? (s.puts[workspaceId] ?? 0) : 0));
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    workspaceShipOffersPr(workspaceId)
      .then((on) => {
        if (live) setAnswer({ id: workspaceId, on: typeof on === "boolean" ? on : "failed" });
      })
      .catch(() => {
        if (live) setAnswer({ id: workspaceId, on: "failed" });
      });
    return () => {
      live = false;
    };
  }, [workspaceId, putCount]);
  // Another workspace's answer is not this one's.
  return answer && answer.id === workspaceId ? answer.on : "reading";
}

/**
 * 1.174.0 (A1, SL-1c): where Release… and Ship batch start — the area's or
 * the repository's Default release, else, nothing chosen, what How Ship it
 * ships says (`defaultReleaseKind`). Nothing is saved.
 *
 * Round 1: `null` while a kind not chosen waits for the reading, so Release
 * stays off until it is in. A reading that fails reads as a project that
 * can't take a pull request (On this Mac only), as Ship it's own does.
 */
export function useDefaultReleaseKind(workspaceId: string | null, areaId: string | null | undefined): ReleaseKind | null {
  const view = useAreasView(workspaceId);
  const shipVia = useWorkspaces((s) => (workspaceId ? s.workspaces.find((w) => w.id === workspaceId)?.shipVia : undefined));
  const reading = useShipOffersPrReading(workspaceId);
  if (!workspaceId) return defaultReleaseKind(view, areaId, shipVia, false);
  const chosen = chosenDefaultKind(view, areaId);
  if (chosen) return chosen;
  if (reading === "reading") return null;
  return defaultReleaseKind(view, areaId, shipVia, reading === true);
}
