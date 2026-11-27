/**
 * Skills hub H3a (Mac walk 2): a skill card whose origin moved on since the
 * card was made says so itself, with **Refresh card** in its Now callout —
 * read from the card's kind and this Mac's team clone
 * (`skills_hub_card_behind`), not only from a Ship that was refused and a
 * toast that has gone.
 *
 * Read when the card opens, when its version changes (a refresh), when the
 * team library is pulled and when the window comes back to the front. A
 * refused Ship marks it at once (`markSkillCardBehind`).
 */
import { useEffect } from "react";
import { create } from "zustand";
import { skillsHubCardBehind, skillsHubCardRefresh, type KanbanCard } from "../ipc";
import { isRefreshShowFirst, isScriptsWait, isSkillCard } from "../lib/skillCards";
import { teamRowsKey } from "../lib/skillsHub";
import { machineWords } from "../lib/platform";
import { rawError } from "../lib/cardPage";
import { useSkillsHub } from "../store/skillsHubStore";
import { useKanban } from "../store/kanbanStore";
import { pushToast } from "../store/toastStore";

/** The Now callout's words while the card is behind (P-A: said by
 *  `presentCard`, defined there). */
export { SKILL_BEHIND_HELPER, SKILL_BEHIND_LABEL } from "../lib/cardPresentation";

const SEP = "\u0000";
const keyOf = (workspaceId: string, cardId: string) => `${workspaceId}${SEP}${cardId}`;

/** Whether a skill card is behind: `true` when Refresh card takes the newer
 *  version in; `"script"` / `"file"` (Windows walk, H6b step 9) when that
 *  version brings a new or changed script or file that is not text, which
 *  Refresh card refuses — it is shown first by making the card again. */
export type SkillBehind = boolean | "script" | "file";

/** The command's answer, as the store keeps it. */
export function skillBehindOf(answer: unknown): SkillBehind {
  // A build before H6b step 9 answered a bare boolean.
  if (typeof answer === "boolean") return answer;
  if (answer && typeof answer === "object" && (answer as { behind?: unknown }).behind === true) {
    const first = (answer as { showsFirst?: unknown }).showsFirst;
    return first === "script" || first === "file" ? first : true;
  }
  return false;
}

interface BehindState {
  byCard: Record<string, SkillBehind>;
  set: (workspaceId: string, cardId: string, behind: SkillBehind) => void;
}

const useBehind = create<BehindState>((set) => ({
  byCard: {},
  set: (workspaceId, cardId, behind) =>
    set((s) => {
      const key = keyOf(workspaceId, cardId);
      return s.byCard[key] === behind ? s : { byCard: { ...s.byCard, [key]: behind } };
    }),
}));

/** A refused Ship ("the team changed it again") says so before the next read. */
export function markSkillCardBehind(workspaceId: string, cardId: string, behind: SkillBehind = true): void {
  // A refused Ship doesn't say whether the newer version is shown first: a
  // read that said so stands until the next read.
  const known = useBehind.getState().byCard[keyOf(workspaceId, cardId)];
  if (behind === true && typeof known === "string") return;
  useBehind.getState().set(workspaceId, cardId, behind);
}

/** What the last read said for one card. */
export function skillBehindNow(workspaceId: string, cardId: string): SkillBehind {
  return useBehind.getState().byCard[keyOf(workspaceId, cardId)] ?? false;
}

/** P-A (UX P1 point 2): the answers, for every surface's live facts
 *  (`useCardLive`): the Board and the List say what the card page read. */
export function useSkillBehindAnswers(): Record<string, SkillBehind> {
  return useBehind((s) => s.byCard);
}
export function skillBehindAnswersNow(): Record<string, SkillBehind> {
  return useBehind.getState().byCard;
}
/** Whether `card` is behind, from the answers (the hook's rule). */
export function skillCardBehindFrom(
  answers: Record<string, SkillBehind>,
  card: Pick<KanbanCard, "id" | "workspaceId" | "kind" | "builder" | "linkedSwarmId" | "linkedRunId" | "runHistory" | "buildBoth" | "shipStatus" | "reviewStatus" | "archived">,
): SkillBehind {
  return openSkillCard(card) ? (answers[keyOf(card.workspaceId, card.id)] ?? false) : false;
}

function openSkillCard(
  card: Pick<KanbanCard, "id" | "workspaceId" | "kind" | "builder" | "linkedSwarmId" | "linkedRunId" | "runHistory" | "buildBoth" | "shipStatus" | "reviewStatus" | "archived">,
): boolean {
  // Skills hub H3b: a Link card is never behind — it records the version
  // each copy already is, so it never offers Refresh.
  return (
    isSkillCard(card) &&
    card.kind?.verb !== "link" &&
    card.shipStatus !== "shipped" &&
    card.reviewStatus !== "merged" &&
    !card.archived
  );
}

/** Tests: forget every card's answer. */
export function resetSkillCardBehindForTests(): void {
  useBehind.setState({ byCard: {} });
}

/** Whether `card` is an open skill card behind its origin. */
export function useSkillCardBehind(
  card: Pick<KanbanCard, "id" | "workspaceId" | "kind" | "builder" | "linkedSwarmId" | "linkedRunId" | "runHistory" | "buildBoth" | "shipStatus" | "reviewStatus" | "archived">,
): SkillBehind {
  // Skills hub H3b: a Link card is never behind — it records the version
  // each copy already is, so it never offers Refresh.
  const open =
    isSkillCard(card) &&
    card.kind?.verb !== "link" &&
    card.shipStatus !== "shipped" &&
    card.reviewStatus !== "merged" &&
    !card.archived;
  const version = open ? (card.kind?.origin.version.contentId ?? "") : "";
  const teamKey = useSkillsHub((s) => teamRowsKey(s.team));
  const behind = useBehind((s) => s.byCard[keyOf(card.workspaceId, card.id)] ?? false);
  const { workspaceId, id } = card;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const read = () => {
      skillsHubCardBehind(workspaceId, id).then(
        (answer) => {
          if (!cancelled) useBehind.getState().set(workspaceId, id, skillBehindOf(answer));
        },
        // A read that fails leaves the last answer: the Ship's own preflight
        // still refuses an old version.
        () => {},
      );
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", read);
    };
  }, [open, workspaceId, id, version, teamKey]);
  return open ? behind : false;
}

/** **Refresh card**: the card's one commit, rebuilt at the library's version
 *  now. Said in a toast either way. */
export async function refreshSkillCard(workspaceId: string, cardId: string): Promise<void> {
  try {
    await skillsHubCardRefresh(workspaceId, cardId);
  } catch (e) {
    // Challenger (H3a): a script waiting for this Mac's OK is the usual
    // reason, and its way out is said in plain words. Windows walk (H6b
    // step 9): the newer version shown first is said in the body too — it
    // is the backend's own sentence, and the card's way on.
    const raw = rawError(e);
    const showFirst = isRefreshShowFirst(raw);
    if (showFirst) markSkillCardBehind(workspaceId, cardId, /script,/.test(raw) ? "script" : "file");
    pushToast({
      kind: "error",
      title: "Couldn't refresh the card",
      body: showFirst
        ? machineWords(raw)
        : isScriptsWait(raw)
          ? machineWords(
              "The library's new version brings a script you haven't said OK to on this Mac. Open the skill in the Library's team section and press Review, then refresh again.",
            )
          : undefined,
      details: showFirst ? undefined : raw,
    });
    return;
  }
  markSkillCardBehind(workspaceId, cardId, false);
  await useKanban.getState().loadFromDisk(workspaceId, true);
  pushToast({ kind: "info", title: "Card refreshed", body: "It carries the library's version now. Ship it when you're ready." });
}
