/**
 * 1.173.0 (B3): a card belongs to one area of its repository. Pure: the
 * words and the rules, tested once (`cardArea.test.ts`). The Rust side
 * (`card_area.rs`) decides and refuses; this side asks first.
 *
 * - A new card is made in the current area (`currentAreaFor`).
 * - A card with no area in a repository with two areas or more reads
 *   "Which area is this?" and is never started or shipped until one is
 *   chosen; the choice starts on the area its changed files point to.
 * - Before Ship, files the card changed outside its area are named on a
 *   sheet: Back · Leave those out (focus) · Ship anyway.
 */
import type { CardAreaState, OutsideFiles, ResolvedArea } from "../ipc.ts";

/**
 * The area a new card is made in: the current area of the workspace
 * (B2's picker, "Area: Site", starting at this Mac's default). `null` for
 * *All areas*: the card then asks "Which area is this?" before it starts,
 * in a repository with two areas or more.
 *
 * B2–B3 join: this module stays pure (node-tested), so the area store
 * (`store/areaStore.ts`) hands its `currentAreaFor` in when it loads
 * (`provideCurrentArea`); every new card goes through it
 * (`kanbanStore.addCard`, which loads the store).
 */
let currentArea: (workspaceId: string) => string | null = () => null;

export function currentAreaFor(workspaceId: string): string | null {
  return currentArea(workspaceId);
}

/** The area store's reading of the current area. */
export function provideCurrentArea(read: (workspaceId: string) => string | null): void {
  currentArea = read;
}

/** Settings › This repository › Areas (B5), where the areas are fixed: one
 *  id for every link to it (the picker's Edit areas…, the notice's Set up
 *  areas…, the card's area line, the Doctor). */
export const AREAS_SETTINGS_SECTION = "areas";
export const AREAS_SETTINGS_LABEL = "Open Settings › Project › Areas";

/** The card page's label for the area line. */
export const AREA_LABEL = "Area";
export const WHICH_AREA = "Which area is this?";
export const CHOOSE_AREA_LABEL = "Use this area";
/** 1.174.0 (C2, BCI-11): the facts line's area of a card with none — in
 *  words; it is chosen under Change…. */
export const AREA_NOT_CHOSEN = "Not chosen yet";

/** The facts line's area when the repository no longer lists it (C2,
 *  Challenger): "docs · not in the areas any more" — the whole reason
 *  (`card_area.rs::unknown_words`) is under Change…. */
export function areaGoneLabel(id: string): string {
  return `${id} · not in the areas any more`;
}

/** One area as a choice: "Site · cards go to main" — or, in a project not
 *  set up yet, "Site · cards go to the project's branch" (as Settings ›
 *  Project › Areas says it). */
export function areaChoiceLabel(area: Pick<ResolvedArea, "name" | "branch">): string {
  return `${area.name} · cards go to ${area.branch.trim() || "the project's branch"}`;
}

/** The choices of the area line, in the repository's order; an area a
 *  started card can't take (its cards go to another branch than the one
 *  the card's copy was cut from) is shown and can't be chosen. */
export function areaChoices(
  state: Pick<CardAreaState, "areas"> & { fits?: string[] },
): { value: string; label: string; disabled?: boolean }[] {
  return state.areas.map((a) => {
    const fits = state.fits == null || state.fits.includes(a.id);
    return fits ? { value: a.id, label: areaChoiceLabel(a) } : { value: a.id, label: areaChoiceLabel(a), disabled: true };
  });
}

/** The area line shows: two areas or more and something to say. */
export function areaLineShown(state: Pick<CardAreaState, "kind"> | null | undefined): boolean {
  return state != null && state.kind !== "none";
}

/** 1.174.0 (C2, BCI-11): the area is chosen under Change…, beside the
 *  Builder and the Reviewer — a Not started card's area, or a card that
 *  has none (or one the repository no longer lists). Held areas and a
 *  started card's area are said, never chosen. */
export function areaChoosable(
  state: Pick<CardAreaState, "kind" | "editable"> & { area?: CardAreaState["area"] } | null | undefined,
): boolean {
  if (!state) return false;
  if (state.kind === "area") return Boolean(state.area && state.editable);
  return state.kind === "needsArea" || state.kind === "unknown";
}

/** What the area line starts on: the card's area, else the area its files
 *  point to, else the first listed. */
export function areaChoiceStart(
  state: Pick<CardAreaState, "area" | "suggested" | "areas"> & { fits?: string[] },
): string {
  const fits = (id: string | null | undefined) => id != null && (state.fits == null || state.fits.includes(id));
  if (state.area) return state.area.id;
  if (fits(state.suggested)) return state.suggested!;
  return state.areas.find((a) => fits(a.id))?.id ?? "";
}

/**
 * 1.174.0 (C3, P9; card-page.html §2): Now asks before Start build, not a
 * toast after it. The question, why it is asked, the one press that
 * chooses and starts ("Start in Site"). Held areas offer no filled press,
 * only the way to Settings.
 */
export const WHICH_AREA_CARD = "Which area is this card for?";
export const AREA_ASK_WHY = "It was made on All areas. Its area decides where its changes go and which release takes it.";
export const AREAS_HELD_HEADLINE = "This repository's areas can't be used";

export function startInAreaLabel(name: string): string {
  return `Start in ${name}`;
}

/** §2b: the press that chose the area, starting — then, once saved, what
 *  happens now; Stop beside it (the area stays saved). */
export function startingInAreaLabel(name: string): string {
  return `Starting in ${name}…`;
}

export function areaSetLine(name: string, ai: string): string {
  return `Area set to ${name} · ${ai} is opening this card's copy`;
}

export const AREA_START_STOP_LABEL = "Stop";

/** Beside the select when its changed files point to one area (§2). */
export function areaFilesHint(area: Pick<ResolvedArea, "path" | "root">): string | null {
  return area.root || !area.path ? null : `Its files are in ${area.path}`;
}

/** Why it asks, in the backend's words, without the question itself — an
 *  unlisted area or an issue label no area has; `null` for a card that was
 *  simply made on All areas. */
export function areaAskWhy(sentence: string | null | undefined): string | null {
  const why = (sentence ?? "")
    .trim()
    .replace(/\s*(Which area is this\?|Choose an area\.)$/, "")
    .trim();
  return why && why !== WHICH_AREA ? why : null;
}

/** What Now knows about the card's area, as `presentCard` takes it
 *  (`CardLive.areaAsk`): the area the select is on, or why it can't. */
export type NowAreaAsk =
  | { kind: "choose"; area: string; why: string | null }
  | { kind: "held"; sentence: string };

/** The card page's reading of its area as Now's fact: `null` when it goes. */
export function nowAreaAsk(
  state: CardAreaState | null | undefined,
  choice: string,
): NowAreaAsk | null {
  const ask = areaAsk(state ?? null);
  if (ask.kind === "go" || !state) return null;
  if (ask.kind === "held") return { kind: "held", sentence: ask.sentence };
  const area = state.areas.find((a) => a.id === choice) ?? state.areas.find((a) => a.id === areaChoiceStart(state));
  if (!area) return null;
  return { kind: "choose", area: area.name, why: areaAskWhy(state.sentence) };
}

/** 1.174.0 (C3, AR-3; §2f): New card on All areas asks its area too, already
 *  chosen — this Mac's default, else the last one used here, else the
 *  first — so Now asks only for cards made without one. */
export const NEW_CARD_DEFAULT_HINT = "this Mac's default";
export const NEW_CARD_LAST_HINT = "last used";

export function newCardAreaStart(
  areas: readonly Pick<ResolvedArea, "id">[],
  defaultArea: string | null | undefined,
  lastUsed: string | null | undefined,
): { id: string; hint: string | null } | null {
  if (areas.length < 2) return null;
  if (defaultArea && areas.some((a) => a.id === defaultArea)) return { id: defaultArea, hint: NEW_CARD_DEFAULT_HINT };
  if (lastUsed && areas.some((a) => a.id === lastUsed)) return { id: lastUsed, hint: NEW_CARD_LAST_HINT };
  return { id: areas[0].id, hint: null };
}

/** Whether Start or Ship must ask first, and what it says. */
export type AreaAsk =
  | { kind: "go" }
  | { kind: "choose"; sentence: string }
  | { kind: "held"; sentence: string };

export function areaAsk(state: Pick<CardAreaState, "kind" | "sentence"> | null): AreaAsk {
  if (!state) return { kind: "go" };
  switch (state.kind) {
    case "needsArea":
    case "unknown":
      return { kind: "choose", sentence: state.sentence ?? WHICH_AREA };
    case "held":
      return { kind: "held", sentence: state.sentence ?? "This repository's areas can't be used." };
    default:
      return { kind: "go" };
  }
}

/** The toast when Start or Ship is pressed on a card that has to choose. */
export function chooseAreaToast(sentence: string, pressed: "start" | "ship"): { title: string; body: string } {
  // C1 (Challenger 4): the question is the title; why it is asked (an
  // unlisted area, an issue label no area has) leads the body.
  const why = areaAskWhy(sentence);
  const then = pressed === "start" ? "Choose its area on the card, then start it again." : "Choose its area on the card, then ship it again.";
  return { title: WHICH_AREA, body: why ? `${why} ${then}` : then };
}

/** A file's name on the sheet; a rename is its two paths. */
export function outsideFilePath(file: { path: string; from?: string | null }): string {
  return file.from ? `${file.from} → ${file.path}` : file.path;
}

/** One row of the sheet, as plain words: "AGENTS.md · whole repository". */
export function outsideFileRow(file: { path: string; from?: string | null; belongs: string }): string {
  return `${outsideFilePath(file)} · ${file.belongs}`;
}

export const BACK_LABEL = "Back";
export const LEAVE_OUT_LABEL = "Leave those out";
export const OUTSIDE_SHIP_ANYWAY_LABEL = "Ship anyway";

/** Scene 4: the sheet before Ship, when the card changed files outside its
 *  area. `null` when there are none. Answers: `cancel` Back, `confirm`
 *  Leave those out (the focus), `alt` Ship anyway. */
export function outsideFilesQuestion(out: OutsideFiles | null | undefined): {
  title: string;
  body: string;
  /** Scene 4's rows: the path in code style and an outline chip. */
  fileRows: { path: string; tag: string }[];
  note: string;
  cancelLabel: string;
  confirmLabel: string;
  altLabel: string;
  altAfter: true;
} | null {
  if (!out || out.files.length === 0) return null;
  return {
    title: `This card also changes files outside ${out.area.name}`,
    body: `${out.area.name} cards go to ${out.area.branch}. These files belong somewhere else:`,
    fileRows: out.files.map((f) => ({ path: outsideFilePath(f), tag: f.belongs })),
    note: out.hint,
    cancelLabel: BACK_LABEL,
    confirmLabel: LEAVE_OUT_LABEL,
    altLabel: OUTSIDE_SHIP_ANYWAY_LABEL,
    altAfter: true,
  };
}

/** The toast after *Leave those out*: the checks run again before Ship. */
export function leftOutToast(count: number, area: string, changed: boolean): { title: string; body: string } {
  const files = count === 1 ? "1 file" : `${count} files`;
  if (count === 0) {
    return { title: "Nothing to leave out", body: `The card no longer changes files outside ${area}.` };
  }
  if (!changed) {
    // Only edits not in a commit yet were put back: the card's work is as
    // its checks saw it.
    return {
      title: `${files} put back`,
      body: "Those were edits not saved in the card yet; nothing it saved changed. Ship again when you're ready.",
    };
  }
  return {
    title: `${files} left out`,
    body: `They are back as they were. The checks run again; ship once they pass.`,
  };
}
