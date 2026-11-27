import { useEffect } from "react";
import type { KanbanCard } from "../ipc";
import { cardClaimState, claimChipLabel, otherDeviceReading, otherDeviceWords, type CardClaimState } from "../lib/cardClaim";
import { machineWords } from "../lib/platform";
import { useIdentity } from "../store/identityStore";
import { useWorkspaces } from "../store/workspaceStore";
import { CBtn, StateWord } from "./ux";

/** OB-7b: the GitHub login a workspace's claims are seen from — its own
 *  chosen account, else the signed-in one; null while unknown. N14: the
 *  Board reads it to put cards someone else holds under Waiting. */
export function useClaimLogin(workspaceId: string): string | null {
  const activeLogin = useIdentity((s) => s.githubLogin);
  const chosen = useWorkspaces(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.githubAccount ?? null,
  );
  return chosen || activeLogin || null;
}

/** `useClaimLogin` read outside React (a drop handler). */
export function claimLoginNow(workspaceId: string): string | null {
  const chosen =
    useWorkspaces.getState().workspaces.find((w) => w.id === workspaceId)?.githubAccount ?? null;
  return chosen || useIdentity.getState().githubLogin || null;
}

/** GH #66: the card's claim as this Mac sees it. The GitHub login can change
 *  under a mounted card (`gh auth switch`), so it is re-read — past its
 *  one-minute TTL — on every render and whenever the window regains focus;
 *  Sync forces a re-read too. OB-7b: a workspace with its own GitHub account
 *  claims as that account (Rust's claim uses it too), so "Claimed by you" is
 *  that login's. T2: the Board tile and the card page's Now read it too. */
export function useCardClaim(card: KanbanCard): { state: CardClaimState; loginKnown: boolean } {
  const login = useClaimLogin(card.workspaceId);
  const hasAssignees = (card.ghAssignees?.length ?? 0) > 0;
  useEffect(() => {
    if (hasAssignees) void useIdentity.getState().loadGithubLogin();
  });
  useEffect(() => {
    if (!hasAssignees) return;
    const onFocus = () => void useIdentity.getState().loadGithubLogin();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [hasAssignees]);
  return { state: cardClaimState(card.ghAssignees, login), loginKnown: Boolean(login) };
}

/** 1.173.0 (C2): the card's line when another of this person's computers
 *  took it — "On your MacBook Pro · 2 h ago", "Taken over by Mac mini";
 *  null otherwise (one computer, another login, a local board: nothing
 *  shows). The words are this platform's; the name is quoted as it is. */
export function useOtherDeviceWords(card: KanbanCard): string | null {
  const login = useClaimLogin(card.workspaceId);
  const reading = otherDeviceReading(card, login);
  return reading ? otherDeviceWords(reading, Date.now(), (t) => machineWords(t)) : null;
}

/** GH #302: the card's Technical details on a GitHub-backed board — "Claimed by you"
 *  as a state word, "Claimed by X" with a quiet way to claim it too (after
 *  asking), or Claim when nobody holds it. */
export function CardClaimControl({
  card,
  onClaim,
}: {
  card: KanbanCard;
  onClaim: () => void;
}) {
  const { state } = useCardClaim(card);
  const label = claimChipLabel(state);
  if (state.kind === "none" || label === null) {
    return (
      <CBtn
        tone="quiet"
        disabled={!card.ghIssueNumber}
        onClick={onClaim}
        title="Assign yourself to the backing issue so you can move this card to Working"
      >
        Claim
      </CBtn>
    );
  }
  if (state.kind === "mine") {
    return (
      <span title="You are assigned to the backing issue">
        <StateWord state="done">{label}</StateWord>
      </span>
    );
  }
  return (
    <>
      <StateWord state="empty">{label}</StateWord>
      <CBtn
        tone="quiet"
        onClick={onClaim}
        disabled={!card.ghIssueNumber}
        title={`${label} on GitHub. Assign yourself too.`}
      >
        Claim it too
      </CBtn>
    </>
  );
}
