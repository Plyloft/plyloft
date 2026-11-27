import {
  kanbanLoad,
  projectConfigGet,
  projectConfigSet,
  projectDetectForSetup,
  worktreeSettingsGet,
  type KanbanCard,
  type ProjectConfig,
} from "../ipc";
import {
  FIRST_CARD_BRIEF,
  FIRST_CARD_TITLE,
  endedGuide,
  firstCardVendor,
  guideAfterBoard,
  guidedSetUpLine,
  startedGuide,
  type GuidedSetUp,
} from "../lib/firstCardGuide";
import { autoSetUpConfig, verifyStepWords } from "../lib/projectSettingsStep";
import { refreshConfiguredProjects } from "./setupFinishStore";
import type { FirstCardGuide } from "../lib/settingsShape";
import { vendorReadiness } from "../lib/vendorReadiness";
import { useBuilder } from "./builderStore";
import { useDoctor } from "./doctorStore";
import { useKanban } from "./kanbanStore";
import { useSettings } from "./settingsStore";
import { newCardBuilderVendor } from "../lib/settingsShape";
import { useUi } from "./uiStore";
import { useWorkspaces } from "./workspaceStore";
import { pushErrorToast } from "../lib/errorToast";

/**
 * OB-16 (onboarding §14): the guided first card's writes. The card is an
 * ordinary card made through the Board's own `addCard` (Todo, with the brief,
 * so it reads *Ready to start* under Needs you); the guide is only the
 * `settings.onboarding.firstCard` record and the callout on that card's page
 * (`components/FirstCardGuide.tsx`). No run lifecycle of its own: Start
 * build, Build done, the review and Ship are the card's usual ones.
 */

function writeGuide(next: (cur: FirstCardGuide | null) => FirstCardGuide | null) {
  return useSettings.getState().update((cur) => {
    const guide = next(cur.onboarding?.firstCard ?? null);
    return { ...cur, onboarding: { ...cur.onboarding, firstCard: guide } };
  });
}

let starting: Promise<KanbanCard> | null = null;

/** Make the card in `workspaceId`, record the guide, and open the card's
 *  page. The Builder is the default vendor, or the other one when only that
 *  one can run here (stored on the card, so Start build isn't refused).
 *  One at a time: a second press (Setup's step 10 or Settings › Setup) while
 *  one is under way gets the same card. If the record can't be written the
 *  card is deleted again, so a retry doesn't leave a duplicate. Throws when
 *  the card can't be made (the Board's toast has said why). */
export function startGuidedFirstCard(workspaceId: string): Promise<KanbanCard> {
  if (starting) return starting;
  starting = makeGuidedCard(workspaceId).finally(() => {
    starting = null;
  });
  return starting;
}

async function makeGuidedCard(workspaceId: string): Promise<KanbanCard> {
  const kanban = useKanban.getState();
  // The board is read first: an add on a board never loaded would stand
  // alone in the store until the next read.
  await kanban.loadFromDisk(workspaceId);
  const card = await kanban.addCard(workspaceId, FIRST_CARD_TITLE, FIRST_CARD_BRIEF, "todo");
  try {
    const { save } = firstCardVendor(
      newCardBuilderVendor(useSettings.getState().settings.behavior),
      vendorReadiness(useDoctor.getState().report),
    );
    if (save) await useBuilder.getState().setVendorPref(workspaceId, card.id, save);
    await writeGuide(() => startedGuide(workspaceId, card.id, new Date().toISOString()));
  } catch (e) {
    await useKanban.getState().removeCard(card.id).catch(() => false);
    pushErrorToast("Couldn't start the guide", e);
    throw e;
  }
  await openGuidedCard(workspaceId, card.id);
  return card;
}

/** UX P-C (UX_P1 point 5, item 2): what Setup's Ready reads of how
 *  `workspaceId` builds when it has no config yet — the plain detected
 *  proposal (`autoSetUpConfig`, never a silent `main`), with the line that
 *  says what the press will use; `unreadable` when there is none to propose
 *  (detection failed, no branch, shared settings) or a read failed; null
 *  when the repository turns out to be set up already. Read-only. */
export async function readGuidedSetUp(
  workspaceId: string,
  name: string,
): Promise<{ view: GuidedSetUp; config: ProjectConfig | null } | null> {
  const unreadable = { view: { kind: "unreadable", name } as GuidedSetUp, config: null };
  try {
    const view = await projectDetectForSetup(workspaceId, null);
    if (!view) return unreadable;
    if ((view.state === "existing" || view.state === "shared") && view.config) return null;
    const config = autoSetUpConfig(view);
    if (!config) return unreadable;
    // SL-4: a setup command the card's copy runs before the Builder starts.
    const setupCommand = await worktreeSettingsGet(workspaceId).then(
      (s) => s?.worktreeSetup ?? null,
      () => null,
    );
    const checks = (config.verifyPipeline ?? []).map(verifyStepWords);
    return {
      view: { kind: "proposal", workspaceId, line: guidedSetUpLine(name, config.targetBranch, checks, setupCommand) },
      config,
    };
  } catch (e) {
    console.warn("guided first card: project settings not read", e);
    return unreadable;
  }
}

/** UX P-C: the press saves the proposal Ready showed (the existing
 *  `project_config_set`), then makes the guided card as usual.
 *  (Challenger) Never over a config that exists by the time of the press —
 *  one saved through Change, another window or a teammate's shared
 *  settings since Ready read it: that one is kept, and the card is made on
 *  it. A config that can't be read is not overwritten either. */
export async function startGuidedFirstCardWithSetUp(workspaceId: string, config: ProjectConfig): Promise<KanbanCard> {
  await saveGuidedSetUp(workspaceId, config);
  return startGuidedFirstCard(workspaceId);
}

/** UX P-C: the proposal Ready showed, saved unless a config exists by now
 *  (kept) or can't be read (not overwritten). Getting started TU-5: Ready's
 *  Start the tour saves it the same way, so the tour's first card builds. */
export async function saveGuidedSetUp(workspaceId: string, config: ProjectConfig): Promise<void> {
  try {
    const existing = await projectConfigGet(workspaceId);
    if (!existing) await projectConfigSet(workspaceId, config);
  } catch (e) {
    pushErrorToast("Couldn't save how your project builds", e);
    throw e;
  }
  refreshConfiguredProjects();
}

/** Take the person to the guided card's page. */
export async function openGuidedCard(workspaceId: string, cardId: string): Promise<void> {
  await useWorkspaces.getState().setActive(workspaceId).catch(() => {});
  // UX P-C Mac walk 2: Setup reopened from Settings › Account › Setup left
  // the Settings sheet open on top of the card; the card is where the
  // person goes now, from Ready, Settings or anywhere else.
  if (useUi.getState().settingsOverlayOpen) useUi.getState().setSettingsOverlayOpen(false);
  useUi.getState().selectCard(workspaceId, cardId, true);
}

/** `End the guide`: ended now; `dismissed` unless it had shipped. */
export function endGuide(): Promise<unknown> {
  const now = new Date().toISOString();
  return writeGuide((cur) => (cur ? endedGuide(cur, now) : cur));
}

/** The guided workspace's board as the store has it, once loaded; `[]` when
 *  the workspace itself is gone; null when nothing can be concluded yet. */
function guidedCards(guide: FirstCardGuide): { cards: KanbanCard[] | null; workspaceGone: boolean } {
  const ws = useWorkspaces.getState();
  if (ws.loaded && !ws.workspaces.some((w) => w.id === guide.workspaceId)) {
    return { cards: [], workspaceGone: true };
  }
  const board = useKanban.getState().byWorkspace[guide.workspaceId];
  return { cards: board?.loaded ? board.cards : null, workspaceGone: false };
}

let started = false;
let stops: (() => void)[] = [];
let busy = false;
/** The Board list a disk read already answered for (the card was there, or
 *  the read failed): not asked again until the list changes. */
let answered: KanbanCard[] | null = null;

const sameGuide = (a: FirstCardGuide | null, b: FirstCardGuide) =>
  a !== null && a.cardId === b.cardId && a.workspaceId === b.workspaceId && !a.endedAt;

/** Follow the guided card: its landing records `shipped`, and the card (or
 *  its workspace) gone ends the guide. The Board store's list alone is not
 *  proof the card is gone — a failed read leaves it empty, and a reload that
 *  began before the card was made can land after it — so a card missing
 *  there is looked up on disk first (`kanban_load`, started now), and only a
 *  successful read without it ends the guide. Idempotent; App starts it. */
export function startFirstCardGuideSubscription(): void {
  if (started) return;
  started = true;
  const check = () => {
    if (busy || starting) return;
    const guide = useSettings.getState().settings.onboarding?.firstCard ?? null;
    if (!guide || guide.endedAt) return;
    const seen = guidedCards(guide);
    const next = guideAfterBoard(guide, seen.cards, new Date().toISOString());
    if (!next) return;
    const ended = next.endedAt != null && !seen.workspaceGone;
    // Already read from disk for this very list: nothing new to ask. Before
    // `busy`, or the subscription would stay locked (OB-16 review 2).
    if (ended && seen.cards === answered) return;
    busy = true;
    const confirmed: Promise<FirstCardGuide | null> = ended
      ? kanbanLoad(guide.workspaceId).then(
          (cards) => {
            const result = guideAfterBoard(guide, Array.isArray(cards) ? cards : null, new Date().toISOString());
            if (!result?.endedAt) answered = seen.cards;
            return result;
          },
          () => {
            answered = seen.cards;
            return null;
          },
        )
      : Promise.resolve(next);
    void confirmed
      .then((result) =>
        result && sameGuide(useSettings.getState().settings.onboarding?.firstCard ?? null, guide)
          ? writeGuide((cur) => (cur && sameGuide(cur, guide) ? result : cur))
          : undefined,
      )
      .catch((e) => console.warn("first card guide: not saved", e))
      .finally(() => {
        busy = false;
      });
  };
  stops.push(useKanban.subscribe(check), useSettings.subscribe(check), useWorkspaces.subscribe(check));
  check();
}

/** Tests: forget the subscription. */
export function stopFirstCardGuideForTests(): void {
  for (const stop of stops) stop();
  stops = [];
  started = false;
  busy = false;
  answered = null;
  starting = null;
}
