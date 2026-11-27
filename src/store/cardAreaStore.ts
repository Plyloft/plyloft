import { create } from "zustand";
import { cardAreaState, cardLeaveOutFiles, cardOutsideFiles, kanbanCardSetArea, type CardAreaState } from "../ipc";
import {
  AREAS_SETTINGS_LABEL,
  AREAS_SETTINGS_SECTION,
  areaAsk,
  chooseAreaToast,
  leftOutToast,
  outsideFilesQuestion,
} from "../lib/cardArea";
import { plainFailure } from "../lib/plainError";
import { useBuilder } from "./builderStore";
import { confirmChoice } from "./confirmStore";
import { useKanban } from "./kanbanStore";
import { pushToast } from "./toastStore";
import { useUi } from "./uiStore";
import { useVerify } from "./verifyStore";

/**
 * 1.173.0 (B3): a card's area on the card page, and the question Start and
 * Ship ask first on a card that has none to choose ("Which area is this?").
 * `byCard` is the last reading of each card; `asked` a card's line was asked
 * to take focus (a press of Start or Ship on it).
 */
interface CardAreaStore {
  byCard: Record<string, CardAreaState | undefined>;
  asked: Record<string, number | undefined>;
  refresh: (workspaceId: string, cardId: string) => Promise<CardAreaState | null>;
  choose: (workspaceId: string, cardId: string, area: string) => Promise<boolean>;
  ask: (cardId: string) => void;
}

export const useCardArea = create<CardAreaStore>((set, get) => ({
  byCard: {},
  asked: {},
  refresh: async (workspaceId, cardId) => {
    try {
      const state = await cardAreaState(workspaceId, cardId);
      set((s) => ({ byCard: { ...s.byCard, [cardId]: state } }));
      return state;
    } catch (e) {
      console.warn("card_area_state failed", e);
      return null;
    }
  },
  choose: async (workspaceId, cardId, area) => {
    try {
      await kanbanCardSetArea(workspaceId, cardId, area);
      await useKanban.getState().loadFromDisk(workspaceId, true);
      await get().refresh(workspaceId, cardId);
      set((s) => ({ asked: { ...s.asked, [cardId]: undefined } }));
      return true;
    } catch (e) {
      const failure = plainFailure(e);
      pushToast({ kind: "error", title: "The area wasn't changed", body: failure.sentence, details: failure.details });
      return false;
    }
  },
  ask: (cardId) => set((s) => ({ asked: { ...s.asked, [cardId]: Date.now() } })),
}));

/**
 * Before Start or Ship: `true` when the card may go on. A card that has to
 * choose its area is opened with its area line asked for; held areas are
 * said with the way to Settings. A reading that fails lets the press go on:
 * the backend refuses it with the same words.
 */
export async function ensureCardArea(workspaceId: string, cardId: string, pressed: "start" | "ship"): Promise<boolean> {
  const state = await useCardArea.getState().refresh(workspaceId, cardId);
  const ask = areaAsk(state);
  if (ask.kind === "go") return true;
  if (ask.kind === "held") {
    pushToast({
      kind: "error",
      title: ask.sentence,
      action: { label: AREAS_SETTINGS_LABEL, onClick: () => useUi.getState().openSettingsSection(AREAS_SETTINGS_SECTION) },
    });
    return false;
  }
  useCardArea.getState().ask(cardId);
  const words = chooseAreaToast(ask.sentence, pressed);
  pushToast({
    kind: "warn",
    title: words.title,
    body: words.body,
    action: { label: "Open the card", onClick: () => useUi.getState().selectCard(workspaceId, cardId, true) },
  });
  return false;
}

/**
 * Before Ship (scene 4): the files the card changed outside its area, on a
 * sheet — Back · Leave those out (the focus) · Ship anyway. `go` ships on;
 * `stop` ships nothing now: Back, or *Leave those out*, which puts those
 * files back in one commit and runs the checks again (a Builder card's
 * Finish and check), so Ship waits for them to pass. A reading that fails
 * asks nothing.
 */
export async function askOutsideFiles(workspaceId: string, cardId: string): Promise<"go" | "stop"> {
  const out = await cardOutsideFiles(workspaceId, cardId).catch((e: unknown) => {
    console.warn("card_outside_files failed", e);
    return null;
  });
  const question = outsideFilesQuestion(out);
  if (!out || !question) return "go";
  const answer = await confirmChoice(question);
  if (answer === "alt") return "go";
  if (answer !== "confirm") return "stop";
  try {
    const done = await cardLeaveOutFiles(
      workspaceId,
      cardId,
      out.files.map((f) => f.path),
    );
    await useKanban.getState().loadFromDisk(workspaceId, true);
    pushToast({ kind: "info", ...leftOutToast(done.leftOut.length, out.area.name, done.sha != null) });
    if (done.sha) {
      if (done.builder) await useBuilder.getState().done(workspaceId, cardId);
      else await useVerify.getState().start({ workspaceId, cardId });
    }
  } catch (e) {
    const failure = plainFailure(e);
    pushToast({ kind: "error", title: "Nothing was left out", body: failure.sentence, details: failure.details });
  }
  return "stop";
}
