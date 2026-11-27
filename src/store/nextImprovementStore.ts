// 1.173.0 (E3): the Next improvement section's state on this Mac — each
// area's latest round (`niRoundGet`, then `ni://progress`), its direction
// (`niDirectionGet`, for the first use and "Waiting for your choice"),
// whether the person hid the section, and the direction sheet's request.
//
// Hidden is per round on this Mac (`localStorage`, a convenience only): *Hide*
// (on the first use and on a slate; the same key the first use's *Not now*
// wrote before 1.174.0, C7) hides that round's section, and
// the Board's ⋯ › Show Next improvement or the Inbox's *Look at the ideas*
// bring it back. A new round shows again.
//
// 1.174.0 (A4, P3 BCI-2): how the slate opens is kept per area in this Mac's
// settings (`settings.nextImprovement.view`): a round that has just arrived
// opens once; once seen it opens folded, after the person leaves the Board.
// Collapse and Show are remembered for that round.
//
// 1.174.0 (A6, D2c): it shows by itself only once this person shipped a card
// on this computer or finished or fully skipped the tour's base chapter
// (recorded once in `nextImprovement.opensSince`)
// (`niOpensByItself`, `useNiOpens`); before that, the Board's ⋯ ›
// Next improvement… opens it for that project, this session (`openEarly`).
import { create } from "zustand";
import { niDirectionNoticeSeen, type NiBeforeAreas, type NiDirectionView, type NiRoundView } from "../ipc";
import type { NiSlateView } from "../lib/settingsShape";
import { niOpensByItself } from "../lib/nextImprovement";
import { useAreas } from "./areaStore";
import { useSettings } from "./settingsStore";
import { openCenterMode } from "./uiStore";

const HIDDEN_KEY = "ply.nextImprovement.hidden.";
const OFFER_KEY = "ply.nextImprovement.offerDismissed.";

/** The key of a workspace's section: the area it asked for (`""` for none —
 *  the backend resolves it). */
export function niKey(workspaceId: string, area: string | null): string {
  return `${workspaceId}::${area ?? ""}`;
}

function readFlag(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeFlag(key: string, value: string | null) {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // A convenience only: it shows again next time.
  }
}

/** What a hidden section is hidden for: the round's id, or the first use. */
export function hiddenToken(round: { id: string } | null | undefined): string {
  return round?.id ?? "first-use";
}

type DirectionAsk = {
  workspaceId: string;
  area: string | null;
  thenStart: boolean;
  /** 1.174.0 (C11): *Check the direction first…* — prefilled from the
   *  direction written before the areas, and saved as this area's copy. */
  fromProject?: boolean;
};

interface NiState {
  rounds: Record<string, NiRoundView | undefined>;
  directions: Record<string, NiDirectionView | null | undefined>;
  /** The token the section was hidden for, per key (session copy of the
   *  stored one). */
  hidden: Record<string, string | null | undefined>;
  /** The offer after a card shipped, answered *Not now*, per round id. */
  offerDismissed: Record<string, boolean | undefined>;
  /** The slate's view per key, this session's copy of the one saved in
   *  settings (it answers at once; the save follows). */
  slate: Record<string, NiSlateView | undefined>;
  /** The round each section opened unfolded on this visit to the Board: it
   *  stays open until the person leaves (`leave`). */
  openNow: Record<string, string | undefined>;
  /** The Inbox asked to show this workspace's slate for `area` (the area
   *  the backend names: its id, or "default"); the section that resolved
   *  to it shows, unfolds and takes focus. */
  reveal: { workspaceId: string; area: string; at: number } | null;
  /** 1.174.0 (A4): open the Board's notes slot of this workspace, so the
   *  section shows even behind another note (⋯ › Show Next improvement, the
   *  Inbox's Look at the ideas). */
  openSlot: { workspaceId: string; at: number } | null;
  /** The direction sheet (E5 builds the full editor; see `NiDirectionSheet`). */
  directionAsk: DirectionAsk | null;
  /** 1.174.0 (C11): the question after the first save of two or more
   *  areas — kept here so it outlives the Areas page (a Save from the
   *  leave guard leaves it) and drawn by `AdoptDirectionSheetHost`. */
  adoptAsk: { workspaceId: string; ask: NiBeforeAreas } | null;
  /** 1.174.0 (A6): the workspaces whose ⋯ › Next improvement… opened it
   *  before it shows by itself — this session only. */
  early: Record<string, boolean | undefined>;
  /** ⋯ › Next improvement…: shown here now, its slot open. */
  openEarly: (workspaceId: string, key: string) => void;
  setRound: (key: string, view: NiRoundView) => void;
  setDirection: (key: string, view: NiDirectionView | null) => void;
  /** Read it again next time the section shows. */
  dropDirection: (key: string) => void;
  /** Collapse (true) or Show (false), remembered for that round. */
  collapse: (key: string, token: string) => void;
  expand: (key: string, token?: string) => void;
  /** The round was shown unfolded: it opens folded after this visit. */
  markSeen: (key: string, token: string) => void;
  /** The person left the Board: a round seen opens folded next time. */
  leave: (key: string) => void;
  hide: (key: string, token: string) => void;
  /** `workspaceId`: also open that Board's notes slot (A4). */
  show: (key: string, workspaceId?: string) => void;
  dismissOffer: (roundId: string) => void;
}

export const useNextImprovement = create<NiState>((set) => ({
  rounds: {},
  directions: {},
  hidden: {},
  slate: {},
  openNow: {},
  offerDismissed: {},
  reveal: null,
  openSlot: null,
  directionAsk: null,
  adoptAsk: null,
  early: {},
  openEarly: (workspaceId, key) => {
    set((s) => ({ early: { ...s.early, [workspaceId]: true } }));
    useNextImprovement.getState().show(key, workspaceId);
  },
  setRound: (key, view) => set((s) => ({ rounds: { ...s.rounds, [key]: view } })),
  setDirection: (key, view) => set((s) => ({ directions: { ...s.directions, [key]: view } })),
  dropDirection: (key) =>
    set((s) => {
      const directions = { ...s.directions };
      delete directions[key];
      return { directions };
    }),
  collapse: (key, token) => setSlate(key, { seenRound: token, collapsed: true }),
  expand: (key, token) => {
    const t = token ?? hiddenToken(useNextImprovement.getState().rounds[key]?.round);
    setSlate(key, { seenRound: t, collapsed: false });
  },
  markSeen: (key, token) => {
    set((s) => ({ openNow: { ...s.openNow, [key]: token } }));
    if (slateViewFor(useNextImprovement.getState(), key)?.seenRound !== token) {
      setSlate(key, { seenRound: token, collapsed: null });
    }
  },
  leave: (key) =>
    set((s) => {
      if (s.openNow[key] === undefined) return s;
      const openNow = { ...s.openNow };
      delete openNow[key];
      return { openNow };
    }),
  hide: (key, token) => {
    writeFlag(HIDDEN_KEY + key, token);
    set((s) => ({ hidden: { ...s.hidden, [key]: token } }));
  },
  show: (key, workspaceId) => {
    writeFlag(HIDDEN_KEY + key, null);
    set((s) => ({
      hidden: { ...s.hidden, [key]: null },
      ...(workspaceId ? { openSlot: { workspaceId, at: Date.now() } } : {}),
    }));
  },
  dismissOffer: (roundId) => {
    writeFlag(OFFER_KEY + roundId, "1");
    set((s) => ({ offerDismissed: { ...s.offerDismissed, [roundId]: true } }));
  },
}));

/** 1.174.0 (A6): the tour's Take me there on its Next improvement step —
 *  shown on this workspace's Board now, its slot open, shown again if hidden. */
export function openNextImprovementEarly(workspaceId: string, key: string): void {
  // Round 1: a section the person hid comes back too.
  useNextImprovement.getState().openEarly(workspaceId, key);
}

/**
 * 1.174.0 (A6, D2c): whether Next improvement may show on this workspace's
 * Board — by itself (a card shipped on this computer, the tour's base chapter
 * closed), opened early from the ⋯, or with a round already there.
 */
export function useNiOpens(workspaceId: string, key: string): boolean {
  const byItself = useSettings((s) =>
    niOpensByItself(s.settings.nextImprovement, s.settings.onboarding?.tutorial),
  );
  const early = useNextImprovement((s) => s.early[workspaceId] === true);
  const hasRound = useNextImprovement((s) => !!s.rounds[key]?.round);
  return byItself || early || hasRound;
}

/** The token the section of `key` is hidden for (`null`: shown). */
export function hiddenFor(state: Pick<NiState, "hidden">, key: string): string | null {
  const session = state.hidden[key];
  if (session !== undefined) return session;
  return readFlag(HIDDEN_KEY + key);
}

/** The slate's saved view of `key`: this session's copy, else settings'. */
export function slateViewFor(state: Pick<NiState, "slate">, key: string): NiSlateView | undefined {
  return state.slate[key] ?? useSettings.getState().settings.nextImprovement?.view?.[key];
}

/**
 * Whether the section of round `token` opens folded (mockup board.html 4a,
 * 4b): the person's own Collapse or Show for that round wins; else a round
 * opened on this visit stays open; else a round seen once opens folded and
 * a new one opens. The first use has nothing to fold.
 */
export function slateCollapsed(view: NiSlateView | undefined, openNow: string | undefined, token: string): boolean {
  if (token === hiddenToken(null)) return false;
  if (view?.seenRound === token && view.collapsed != null) return view.collapsed;
  if (openNow === token) return false;
  return view?.seenRound === token;
}

/** Keeps the view for the session at once, and in this Mac's settings once
 *  they are read (a save before that would write the defaults over them). */
function setSlate(key: string, view: NiSlateView) {
  useNextImprovement.setState((s) => ({ slate: { ...s.slate, [key]: view } }));
  saveSlates({ [key]: view });
}

const sameSlate = (a: NiSlateView | undefined, b: NiSlateView) =>
  (a?.seenRound ?? null) === (b.seenRound ?? null) && (a?.collapsed ?? null) === (b.collapsed ?? null);

/** Writes the views that differ from the saved ones, once settings are read. */
function saveSlates(views: Record<string, NiSlateView>) {
  const settings = useSettings.getState();
  if (!settings.loaded) return;
  void settings
    .update((latest) => {
      const saved = latest.nextImprovement?.view ?? {};
      const changed = Object.entries(views).filter(([k, v]) => !sameSlate(saved[k], v));
      if (changed.length === 0) return latest;
      const view = { ...saved };
      for (const [k, v] of changed) {
        const next: NiSlateView = { seenRound: v.seenRound ?? null };
        if (v.collapsed != null) next.collapsed = v.collapsed;
        view[k] = next;
      }
      return { ...latest, nextImprovement: { ...latest.nextImprovement, view } };
    })
    .catch(() => {
      // A convenience: this session keeps it; it opens unfolded next time.
    });
}

// Round 1 (6): views kept before settings were read are written once they are.
useSettings.subscribe((state, prev) => {
  if (!state.loaded || prev.loaded) return;
  const slate = useNextImprovement.getState().slate;
  const views = Object.fromEntries(Object.entries(slate).filter((e): e is [string, NiSlateView] => !!e[1]));
  if (Object.keys(views).length > 0) saveSlates(views);
});

export function offerDismissed(state: Pick<NiState, "offerDismissed">, roundId: string): boolean {
  return state.offerDismissed[roundId] ?? readFlag(OFFER_KEY + roundId) === "1";
}

/**
 * E3 → E5: open the direction editor of a workspace's area (`null`: the one
 * the backend resolves). `thenStart`: *Save and prepare proposals* starts
 * the round after saving (a start refused for a missing direction). E5
 * replaces the sheet that answers it; the request stays this one.
 */
export function openDirectionEditor(workspaceId: string, area: string | null, thenStart = false, fromProject = false): void {
  useNextImprovement.setState({ directionAsk: { workspaceId, area, thenStart, ...(fromProject ? { fromProject } : {}) } });
}

export function closeDirectionEditor(): void {
  useNextImprovement.setState({ directionAsk: null });
}

/**
 * The Inbox's *Look at the ideas*: the Board of that workspace, on that
 * area, with the section shown, unfolded and focused. The area is chosen at
 * once, even on a cold workspace whose areas aren't read yet: the picker
 * takes the choice once they are (`currentAreaId`), and a repository with one
 * area or none ignores it. The section that resolves to `area` answers the
 * reveal (`NextImprovementSection`).
 */
export function lookAtTheIdeas(workspaceId: string, area: string): void {
  openCenterMode(workspaceId, "board");
  if (area !== "default") useAreas.getState().choose(workspaceId, area);
  const at = Date.now();
  useNextImprovement.setState((s) => ({
    reveal: { workspaceId, area, at },
    openSlot: { workspaceId, at },
    // A6: an Inbox row means a round is there; it shows whatever the gate.
    early: { ...s.early, [workspaceId]: true },
  }));
}

const noticesSaid = new Set<string>();

/** E6: a view's `notice` (the repository's direction was kept over the one
 *  this computer kept) is said once: `true` for the first caller, which
 *  says it; the backend then forgets it (`niDirectionNoticeSeen`). */
export function takeNotice(workspaceId: string, view: Pick<NiDirectionView, "area" | "notice"> | null | undefined): boolean {
  if (!view?.notice) return false;
  const key = `${workspaceId}::${view.area}`;
  if (noticesSaid.has(key)) return false;
  noticesSaid.add(key);
  // Forgotten once the backend has it: a later notice for the area is new.
  void niDirectionNoticeSeen(workspaceId, view.area)
    .catch(() => {})
    .finally(() => noticesSaid.delete(key));
  return true;
}
