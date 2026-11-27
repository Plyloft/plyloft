// GH #172: loaded by vitest before every behavioural UI test file
// (vitest.config.ts `setupFiles`). What a rendered component needs from a
// browser that jsdom does not give, the Tauri stub, and the reset between tests.
// Anything a single test would otherwise have to patch belongs here.
import { resetAreaListenersForTests } from "../store/areaStore";
import { resetCardRemovalsForTests } from "../store/boardStore";
import { resetPressesForTests } from "../lib/pressOnce";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";
import { installTauriStub, tauri } from "./tauri";
import { resetCopiesListenerForTests, useCopies } from "../store/copiesStore";
import { stopRestoredReadsForTests } from "../store/kanbanStore";
import { resetDefinitionReadsForTests } from "../store/definitionReadStore";
import { stopSettingsSubscriptionForTests } from "../store/settingsStore";
import { resetModelCatalogForTests } from "../store/modelCatalogStore";
import { FALLBACK_CATALOG } from "../lib/modelCatalog";
import { resetTeamModelsForTests } from "../store/teamModelsStore";
import { useCardArea } from "../store/cardAreaStore";
import { stopSetupListenersForTests } from "../store/setupRunStore";
import { resetWorkModeForTests } from "../store/workModeStore";
import { resetGithubStatusForTests } from "../store/githubStatusStore";
import { stopSetupFinishForTests } from "../store/setupFinishStore";
import { stopFirstCardGuideForTests } from "../store/firstCardGuideStore";
import { stopTutorialForTests } from "../store/tutorialStore";
import { stopAccountListenersForTests, stopPlanGatesForTests } from "../store/accountStore";
import { setPlatformForTests } from "../lib/platform";
import { resetLastReviewTips } from "../components/useReviewTip";
import { resetNotifyGateForTests } from "../store/notifyGate";
import { dropTarget } from "../lib/notifyTarget";
import { setNotificationAccessCache } from "../store/notificationAccessCache";
import { resetToastsForTests } from "../store/toastStore";
import { resetBuilderAtDoneForTests } from "../store/builderAtDone";
import { resetChecksConsentForTests } from "../store/checksConsentStore";

// ── The platform ─────────────────────────────────────────────────────────
// Ply is a Mac app: CodeMirror reads `navigator.platform` once, when
// @codemirror/view loads, to decide that `Mod` is ⌘. jsdom reports "", which
// would make `Mod-s` Ctrl-S. Set before any test file imports CodeMirror.
Object.defineProperty(window.navigator, "platform", {
  value: "MacIntel",
  configurable: true,
});
// W5: Ply's own platform check is the Mac too, on every host CI runs on
// (a Windows runner's jsdom says "(win32)"). A test that wants Windows forces
// it; each test starts on the Mac again.
setPlatformForTests("mac");
beforeEach(() => setPlatformForTests("mac"));

// jsdom lays nothing out and has no scrollIntoView, yet a search or a link
// that lands on a row scrolls it into view (Row.tsx). A fresh no-op before
// each test, so a test that spies on it (soloMode, reveal) never leaks its
// spy into the next.
beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
});

// ── Waiting under load ───────────────────────────────────────────────────
// `waitFor` / `findBy…` give up after 1 s by default. A test that takes
// 200 ms alone took over a second in a full run beside a cargo build (the
// card chat follow-ups: cardPage's Put back, findingAnchors' list, failing
// once in a loaded run and never alone). A wait ends as soon as what it
// waits for is there, so a longer bound costs a passing test nothing.
configure({ asyncUtilTimeout: 5000 });

// ── What jsdom leaves out ────────────────────────────────────────────────
// CodeMirror measures text through Range and element rects, and schedules
// through ResizeObserver; `useColorScheme` reads `matchMedia`. jsdom lays out
// nothing, so each answers "empty" — enough for the view to mount and handle
// keys and input, which is what these tests are about.
const emptyRect = (): DOMRect =>
  ({ x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
const emptyRects = (): DOMRectList => {
  const list = [] as unknown as DOMRectList & DOMRect[];
  (list as unknown as { item: (i: number) => DOMRect | null }).item = () => null;
  return list;
};
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = emptyRect;
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = emptyRects;
if (!document.elementFromPoint) document.elementFromPoint = () => null;
// GH #210: the codex-chat transcript follows its tail with `scrollTo`, which
// jsdom does not implement on elements. Nothing is laid out, so nothing moves.
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
// …and a Space typed into its composer goes through `insertText`
// (`execCommand`), which jsdom lacks too. Answering "not done" takes the
// composer's own fallback, which splices the draft.
if (!document.execCommand) document.execCommand = () => false;

// The card page finds its own parts by `CSS.escape`d ids; jsdom has no CSS
// namespace. Ids in these tests are plain words, so an identity is enough.
if (!("CSS" in window) || typeof (window as { CSS?: { escape?: unknown } }).CSS?.escape !== "function") {
  const css = { escape: (value: string) => value.replace(/["\\]/g, "\\$&") };
  (window as unknown as { CSS: unknown }).CSS = css;
  (globalThis as unknown as { CSS: unknown }).CSS = css;
}

if (!("ResizeObserver" in window)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// ── Fake timers ──────────────────────────────────────────────────────────
// Testing Library drains its async wrappers (user-event, waitFor) with a
// `setTimeout(0)`, and only advances a fake clock for it when a global `jest`
// exists; under vitest's fake timers that timeout would never fire and every
// `await user.click` would hang. This is the bridge it looks for.
(globalThis as unknown as { jest: unknown }).jest = {
  advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms),
};

// ── Stores ───────────────────────────────────────────────────────────────
// Every store in src/store is `create` from zustand. Wrapped here, each store
// records the state it was created with and is put back to it after every test,
// so a test never sees what the previous one left — without each store having to
// export a reset of its own.
// Hoisted with the mock: the settings store is imported above, so stores are
// created before this file's own body runs.
const storeResets = vi.hoisted(() => new Set<() => void>());

vi.mock("zustand", async (importOriginal) => {
  const actual = await importOriginal<typeof import("zustand")>();
  type Creator = import("zustand").StateCreator<unknown>;
  const track = (creator: Creator) => {
    const store = actual.create(creator);
    const initial = store.getInitialState();
    storeResets.add(() => store.setState(initial, true));
    return store;
  };
  // `create(fn)` and the curried `create<T>()(fn)` are both in use.
  const create = (creator?: Creator) => (creator ? track(creator) : track);
  return { ...actual, create };
});

// ── Per test ─────────────────────────────────────────────────────────────

beforeEach(() => {
  // A fresh stub: no fixtures, no calls, no listeners. A test adds its fixtures
  // through `renderUi(…, { fixtures })` or `tauri().fixture(…)`.
  // 1.169.0 (A1): every model menu and card page reads the model catalog, a
  // read-only answer; a test that cares sets its own fixture.
  // 1.169.0 (A2): so does the team's suggestion (`team_models_get`); none
  // unless a test gives one.
  // 1.170.0 (G6): the Board and the card page read how far the cards are
  // behind their target (`cards_target_sync`): up to date unless a test
  // says otherwise.
  // 1.173.0 (A3): Terminals and Settings › Worktrees read the copies
  // without a card (`copy_list`): none unless a test gives some.
  installTauriStub({
    model_catalog_get: FALLBACK_CATALOG,
    team_models_get: { shared: false, readOnly: false, models: null },
    // 1.173.0 (B1): no areas — the implicit area — unless a test gives some.
    areas_get: {
      shared: false,
      readOnly: false,
      defined: [],
      areas: [],
      workspaceBranch: "",
      check: { errors: [], warnings: [] },
      problem: null,
      held: false,
    },
    // 1.173.0 (B2): one product (no two-products notice) unless a test
    // gives a discovery.
    areas_discover: null,
    // 1.173.0 (B4 follow-up): Settings › Areas reads no tags unless a test
    // gives some.
    areas_releases: [],
    // 1.174.0 (A1): a project whose Ship it can't open a pull request unless
    // a test says so — so a release not chosen starts on this Mac only.
    workspace_ship_offers_pr: false,
    cards_target_sync: { target: "main", cards: {} },
    // 1.175.0 (B2): a release, a ship and the two Settings rows read what
    // this Mac allowed of the checks and the install step: nothing recorded,
    // nothing asked, unless a test says otherwise.
    checks_consent_view: {
      checks: { needsOk: false, firstTime: true, approved: [], current: [], hash: "", who: null, changedAt: null },
      install: { needsOk: false, approved: null, current: null, who: null, changedAt: null, waiting: null },
    },
    // 1.174.0 (X3): Library › Skills reads All skills' index (its cache) and
    // My library's view: nothing in either, no My library, unless a test
    // gives some.
    skills_hub_index: {
      index: { schemaVersion: 1, builtAt: null, workspaces: [], team: null, myLibrary: null, thisMac: null, plyloft: null },
      refreshing: false,
      reading: [],
    },
    // The Library asks whether the account already has a My library when
    // this computer uses none: it has none, unless a test says so.
    my_library_find: null,
    my_library_status: {
      repo: null,
      account: null,
      hasClone: false,
      lastPullAt: null,
      lastAttemptAt: null,
      lastError: null,
      goneAt: null,
      defaultName: "plyloft-skills",
      accounts: [],
      plugin: "mine",
    },
    copy_list: [],
    copy_refresh_prs: null,
    // 1.176.0 (R6): Diagnostics' Repair group reads a plan per AI tool —
    // fine, nothing to repair, unless a test gives another.
    cli_health: ({ tool }: Record<string, unknown>) => ({
      tool,
      healthy: true,
      runsToday: null,
      shouldRun: null,
      installDir: null,
      cached: null,
      copies: [],
      folders: [],
      findings: [],
      passedOver: null,
    }),
    cli_repair_plan: ({ tool }: Record<string, unknown>) => ({
      tool,
      situations: [{ kind: "healthy" }],
      notes: [],
      steps: [],
      block: { kind: "nothingToRepair", healthyEnough: false },
      nextStep: null,
      manual: [],
      quick: false,
    }),
    // 1.175.0 (D2): Move back, Stop and Archive ask what became of the
    // member's name on the issue — nothing was asked of GitHub, unless a
    // test says otherwise.
    card_name_off_outcome: null,
    // 1.175.0 (R2): the Board asks once, after its first load, whether its
    // file couldn't be read — it could, unless a test says otherwise.
    board_unreadable_notice: null,
    // Round 4 (T1): and, at launch, for every board at once — none.
    board_unreadable_notices: { notices: [], awaitingRead: [] },
    // Round 6 (W3): the window says when a board notice is on screen.
    board_unreadable_said: null,
    // 1.175.0 (R3): the window asks once at launch whether the project list
    // couldn't be read — it could, unless a test says otherwise.
    project_list_notice: null,
    project_list_trouble: null,
    // 1.175.0 F2: Setup's solo/team deduction asks GitHub once step 3 is
    // behind — nothing found, unless a test says otherwise.
    setup_team_hint: { read: true, login: "me", teams: [], invitations: 0, problem: null },
    // 1.173.0 (B3): a card in a repository without areas — nothing to ask,
    // nothing outside — unless a test gives some.
    card_area_state: { kind: "none", areas: [], area: null, sentence: null, suggested: null, editable: false },
    card_outside_files: null,
    // 1.173.0 (D1): nothing read about where a project goes live — no
    // Railway, no GitHub checks — unless a test gives some.
    deploy_map_get: {
      repo: null,
      railway: { state: "noCli", project: null, services: [], message: null, readAt: null },
      workflows: [],
    },
    deploy_what_changes: null,
    // 1.174.0 (DR3): the Board's ⋯ reads what each area would release
    // when it opens — nothing read unless a test gives some.
    release_scopes: [],
    // 1.173.0 (E3): the Board's Next improvement section reads the area's
    // last round and its direction — none of either unless a test gives them.
    ni_round_get: ({ workspaceId, area }: Record<string, unknown>) => ({
      workspaceId,
      area: area ?? "default",
      round: null,
      byline: null,
      elapsedMs: null,
    }),
    ni_direction_get: null,
    // 1.173.0 (H1): Diagnostics › Responsiveness — no freezes, unless a test
    // gives some.
    watchdog_status: { startedAt: 0, episodes: [], lines: [], previousRun: null },
    // 1.179.0 (C1): AI and models' Claude accounts — Main alone unless a
    // test gives more.
    ai_accounts_list: [{ id: null, name: "Main", signedIn: "unknown", isCurrent: true, folder: null }],
  });
});

afterEach(() => {
  // Unmount first, so effects clean up (unlisten, timers) against this test's
  // stub and stores; stop the module-level subscriptions a test started, so
  // the next test's `startSettingsSubscription` listens on the next stub
  // (review 1); then put the stores back and the clock right.
  cleanup();
  stopSettingsSubscriptionForTests();
  resetModelCatalogForTests();
  resetDefinitionReadsForTests();
  resetTeamModelsForTests();
  useCardArea.setState({ byCard: {}, asked: {} });
  stopSetupListenersForTests();
  resetWorkModeForTests();
  resetGithubStatusForTests();
  stopSetupFinishForTests();
  stopFirstCardGuideForTests();
  stopTutorialForTests();
  stopAccountListenersForTests();
  stopPlanGatesForTests();
  resetLastReviewTips();
  resetNotifyGateForTests();
  resetBuilderAtDoneForTests();
  resetChecksConsentForTests();
  resetCopiesListenerForTests();
  resetAreaListenersForTests();
  stopRestoredReadsForTests();
  useCopies.setState({ byWorkspace: {} });
  dropTarget();
  setNotificationAccessCache(null);
  // An Archive or Delete still in its 6 s Undo window: left running, it wrote
  // during whichever later test had a card with that id, failed against that
  // test's stub, and its error toast replaced that test's own.
  resetCardRemovalsForTests();
  resetPressesForTests();
  // QoL 1.168 block 8 (A2): an error left on screen by one test would make
  // the next test's toasts wait behind it.
  resetToastsForTests();
  for (const reset of storeResets) reset();
  vi.useRealTimers();
  // Last, so the test still fails on it after everything above has run: an
  // `invoke` with no fixture, unless the test allowed it (review 1).
  tauri().assertNoUnhandled();
});
