import { useEffect, useRef, useState } from "react";
import type { KanbanCard } from "../ipc";
import {
  AREAS_SETTINGS_LABEL,
  AREAS_SETTINGS_SECTION,
  AREA_LABEL,
  AREA_NOT_CHOSEN,
  CHOOSE_AREA_LABEL,
  WHICH_AREA,
  areaChoosable,
  areaGoneLabel,
  areaChoiceLabel,
  areaChoiceStart,
  areaChoices,
  areaLineShown,
  newCardAreaStart,
} from "../lib/cardArea";
import { pickerAreas } from "../lib/areaPicker";
import { machineWords } from "../lib/platform";
import { useAreasView, useCurrentArea } from "../store/areaStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useCardArea } from "../store/cardAreaStore";
import { useUi } from "../store/uiStore";
import { CBtn, Select, type Property } from "./ux";

/**
 * 1.173.0 (B3): the card's area as one of the card page's facts, read again
 * when the card's area, column or copy changes. Shown only in a repository
 * with two areas or more (UX: show only where it applies). 1.174.0 (C2,
 * BCI-11): said in words; it is changed under Change… (`CardAreaPick`).
 */
export function useCardAreaProperty(card: KanbanCard): Property | null {
  const state = useCardArea((s) => s.byCard[card.id]);
  useEffect(() => {
    void useCardArea.getState().refresh(card.workspaceId, card.id);
  }, [card.workspaceId, card.id, card.area, card.columnId, card.worktreePath]);
  if (!areaLineShown(state)) return null;
  return { icon: "repository", label: AREA_LABEL, wide: state?.kind === "held", value: <CardAreaValue card={card} /> };
}

/**
 * The facts line's area, in words (1.174.0 C2, BCI-11 — no field here):
 * - the card's area: "Site · cards go to main";
 * - no area: "Not chosen yet"; one the repository no longer lists:
 *   "docs · not in the areas any more";
 * - areas that can't be used: the problem and the way to Settings.
 */
export function CardAreaValue({ card }: { card: KanbanCard }) {
  const state = useCardArea((s) => s.byCard[card.id]);
  if (!state || !areaLineShown(state)) return null;
  if (state.kind === "held") {
    return (
      <span className="ux-card-area" data-ply-card-area="held">
        <span>{state.sentence}</span>{" "}
        <CBtn tone="quiet" size="sm" onClick={() => useUi.getState().openSettingsSection(AREAS_SETTINGS_SECTION)}>
          {AREAS_SETTINGS_LABEL}
        </CBtn>
      </span>
    );
  }
  if (state.kind === "area" && state.area) {
    return (
      <span className="ux-card-area" data-ply-card-area="area">
        {/* C2: "Site · cards go to main" stays on one line — a wrap never
            starts with "·". */}
        <span className="ux-card-area-name">{areaChoiceLabel(state.area)}</span>
        {/* C1: a calm line while its issue's label hasn't gone up. */}
        {state.labelLine ? (
          <span className="ux-card-area-note" data-ply-card-area-label="">
            {" "}
            {state.labelLine}
          </span>
        ) : null}
      </span>
    );
  }
  // An area the repository no longer lists is named, not "Not chosen yet";
  // Change… keeps the whole reason.
  return (
    <span className="ux-card-area" data-ply-card-area="choose">
      <span className="ux-card-area-name">
        {state.kind === "unknown" && card.area ? areaGoneLabel(card.area) : AREA_NOT_CHOSEN}
      </span>
    </span>
  );
}

/** Whether Change… holds the card's area (`CardAreaPick`). */
export function useCardAreaChoosable(cardId: string): boolean {
  return useCardArea((s) => areaChoosable(s.byCard[cardId]));
}

/**
 * 1.174.0 (C2, BCI-11): the area under Change…, beside the Builder and the
 * Reviewer:
 * - a Not started card's area: a choice that changes it;
 * - no area, or one the repository no longer lists: why it asks (when it
 *   says more than "Which area is this?"), the areas starting on the one
 *   its changed files point to, and *Use this area*.
 * A press of Start or Ship that had to ask opens Change… with the focus
 * here.
 */
export function CardAreaPick({ card }: { card: KanbanCard }) {
  const state = useCardArea((s) => s.byCard[card.id]);
  const asked = useCardArea((s) => s.asked[card.id]);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (state) setChoice(areaChoiceStart(state));
  }, [state]);
  useEffect(() => {
    if (!asked) return;
    const field = box.current?.querySelector("select");
    field?.scrollIntoView?.({ block: "center" });
    field?.focus();
  }, [asked]);
  if (!areaChoosable(state) || !state) return null;
  const choose = async (area: string) => {
    if (!area || busy) return;
    setBusy(true);
    try {
      await useCardArea.getState().choose(card.workspaceId, card.id, area);
    } finally {
      setBusy(false);
    }
  };
  if (state.kind === "area" && state.area) {
    return (
      <span className="ux-card-builder-pick" ref={box} data-ply-card-area-pick="area">
        <Select
          label={AREA_LABEL}
          value={state.area.id}
          options={areaChoices(state)}
          disabled={busy}
          onChange={(next) => void choose(next)}
        />
      </span>
    );
  }
  const why = state.sentence && state.sentence.trim() !== WHICH_AREA ? state.sentence : null;
  return (
    <span className="ux-card-builder-pick" ref={box} data-ply-card-area-pick="choose">
      {why && <span className="ux-card-muted">{why}</span>}
      <Select label={AREA_LABEL} value={choice} options={areaChoices(state)} disabled={busy} onChange={setChoice} />
      <CBtn tone="quiet" size="sm" disabled={busy || !choice} onClick={() => void choose(choice)}>
        {CHOOSE_AREA_LABEL}
      </CBtn>
    </span>
  );
}

/** The last area a new card was made in here, this viewer's only
 *  (`localStorage`; a private window or blocked storage simply forgets). */
const LAST_AREA_KEY = "plyloft.newCardArea.";

function readLastArea(workspaceId: string): string | null {
  try {
    return window.localStorage.getItem(LAST_AREA_KEY + workspaceId);
  } catch {
    return null;
  }
}

function writeLastArea(workspaceId: string, area: string): void {
  try {
    window.localStorage.setItem(LAST_AREA_KEY + workspaceId, area);
  } catch {
    // Forgotten: the next card starts on this Mac's default or the first.
  }
}

/**
 * 1.174.0 (C3, AR-3; card-page.html §2f): on *All areas* in a repository
 * with two areas or more, New card asks its area, already chosen — this
 * Mac's default, else the last one used here, else the first. `area` is
 * what `addCard` takes: `undefined` (the Board's current area) where it
 * isn't asked.
 */
export function useNewCardArea(workspaceId: string) {
  const view = useAreasView(workspaceId);
  const current = useCurrentArea(workspaceId);
  const defaultArea = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.defaultArea ?? null);
  const areas = pickerAreas(view);
  const shown = areas.length >= 2 && current === null;
  const [picked, setPicked] = useState<string | null>(null);
  const start = shown ? newCardAreaStart(areas, defaultArea, readLastArea(workspaceId)) : null;
  const value = picked != null && areas.some((a) => a.id === picked) ? picked : (start?.id ?? "");
  const hint = picked == null || picked === start?.id ? (start?.hint ?? null) : null;
  return {
    shown,
    areas,
    value,
    hint,
    setValue: setPicked,
    area: shown && value ? value : undefined,
    /** After a card was made with it: the next one starts here. */
    remember: () => {
      if (shown && value) writeLastArea(workspaceId, value);
    },
  };
}

/** The composer's Area: its label, the choice, and why it starts there. */
export function NewCardAreaPick({ pick, disabled }: { pick: ReturnType<typeof useNewCardArea>; disabled?: boolean }) {
  if (!pick.shown) return null;
  return (
    <span className="ux-new-card-area" data-ply-new-card-area="">
      <span className="ux-card-muted-inline" aria-hidden>
        {AREA_LABEL}
      </span>
      <Select
        label={AREA_LABEL}
        value={pick.value}
        options={pick.areas.map((a) => ({ value: a.id, label: areaChoiceLabel(a) }))}
        disabled={disabled}
        onChange={pick.setValue}
      />
      {pick.hint && <span className="ux-card-muted-inline">{machineWords(pick.hint)}</span>}
    </span>
  );
}
