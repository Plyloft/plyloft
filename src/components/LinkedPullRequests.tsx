import { useEffect, useState } from "react";
import {
  kanbanCardLinkedPullRequests,
  openWebLink,
  type KanbanCard,
  type LinkedPullRequest,
} from "../ipc";
import { linkedPullRequestState, linkedPullRequestWords } from "../lib/cardClaim";
import { useKanban } from "../store/kanbanStore";
import { useTeamAllowed } from "../store/accountStore";
import { pushToast } from "../store/toastStore";
import { StateWord } from "./ux";
import { linkDidNotOpen } from "../lib/linkToast";

/**
 * N14 (item 4): the pull requests linked to the card's GitHub issue — a
 * teammate's "Closes #21" — read from the issue's timeline when the card
 * page opens and after each Sync. Not the card's own ship PR (the backend
 * leaves it out). Display only; a failed read shows nothing.
 */
export function useLinkedPullRequests(card: KanbanCard, githubBoard: boolean): LinkedPullRequest[] {
  // Challenger P3-2: the backend read is team-gated like Claim; without the
  // team permission it is not asked (it could only fail).
  const licensed = useTeamAllowed();
  const enabled = githubBoard && licensed;
  // Keyed by the card read, so another card's list never shows here.
  const [read, setRead] = useState<{ key: string; prs: LinkedPullRequest[] }>({ key: "", prs: [] });
  // QoL 14.1 (Challenger): read again after each Sync, and when a refresh
  // changed this card — not on every refresh of the Board.
  const syncRound = useKanban((s) => s.syncRound[card.workspaceId] ?? 0);
  const changedAt = card.updatedAt;
  const number = card.ghIssueNumber ?? null;
  const own = card.pr?.number ?? null;
  const key = `${card.workspaceId}/${card.id}/${number ?? ""}/${own ?? ""}`;
  useEffect(() => {
    if (!enabled || number == null) return;
    let cancelled = false;
    kanbanCardLinkedPullRequests(card.workspaceId, card.id).then(
      (list) => {
        if (!cancelled) setRead({ key, prs: Array.isArray(list) ? list : [] });
      },
      (e: unknown) => console.warn("card: linked pull requests not read", e),
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, card.workspaceId, card.id, number, syncRound, changedAt, key]);
  return enabled && read.key === key ? read.prs : EMPTY;
}

const EMPTY: LinkedPullRequest[] = [];

/** Each linked pull request as a link to it on GitHub, with its state. */
export function LinkedPullRequestList({
  prs,
  login,
}: {
  prs: readonly LinkedPullRequest[];
  login: string | null;
}) {
  return (
    <span className="ux-card-linked-prs">
      {prs.map((pr) => {
        const state = linkedPullRequestState(pr);
        return (
          <span key={pr.number} data-ply-linked-pr={pr.number}>
            <button
              type="button"
              className="ux-card-mono-link"
              title={`${pr.url} — open it on GitHub`}
              onClick={() =>
                void openWebLink(pr.url).catch((e: unknown) =>
                  pushToast(linkDidNotOpen(pr.url, e)),
                )
              }
            >
              {linkedPullRequestWords(pr, login)}
            </button>{" "}
            <StateWord state={state.state}>{state.word}</StateWord>
          </span>
        );
      })}
    </span>
  );
}
