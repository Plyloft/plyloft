// Getting started TU-3 (docs/tutorial/TUTORIAL_SPEC.md §4.3, §12.1): the
// coverage test in the gate. Named `.tsx` because vitest collects only those
// (vitest.config.ts); the spec's `tutorialCoverage.test.ts` is this file.
//
//  1. Every destination has a step or a written reason: the centre modes, the
//     sidebar's nav (`NAV_DESTINATIONS`, which the sidebar draws every row
//     from), the Library pages, the Settings pages and the card page's
//     sections. Each is in a step's `covers`, planned for a chapter with no
//     steps yet, or in `NOT_A_TOUR_STEP` — one of the three, never two.
//  2. Every anchor renders: each owning component is rendered and carries its
//     `data-ply-tour` on one element ("render it, do not read its source",
//     PATTERNS). None is pending since TU-4 built the Help menu (`help`).
//  3. Inside the app the anchor is found on the one visible host: warmed
//     workspaces keep hidden copies (`findTourAnchor`).
//  4. Every step has its `<!-- tour:<id> -->` marker in the user guide text,
//     and every marker names a step.
//
// §12.1 (4) (banned words) and (5) (`since`) are in the manifest's own node
// test, src/lib/tutorialEngine.test.ts.
import { useEffect, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar } from "../components/WorkspaceSidebar";
import { KanbanBoard } from "../components/KanbanBoard";
import { CardDetailPanel } from "../components/CardDetailPanel";
import { TileGrid } from "../components/TileGrid";
import { CodeModeHost } from "../components/CodeModeHost";
import { LibraryModeHost } from "../components/library/LibraryModeHost";
import type { KanbanCard, ShellEnvInfo } from "../ipc";
import { ALL_STEPS, CHAPTERS, PENDING_ANCHORS, TOUR_ANCHORS, type TourAnchor } from "../lib/tutorial/manifest";
import {
  CENTER_MODES,
  NOT_A_TOUR_STEP,
  PLANNED_IN_CHAPTER,
  tourDestinations,
} from "../lib/tutorial/coverage";
import { findTourAnchor, shownTourAnchors, tourSelector } from "../lib/tutorial/tourAnchors";
import { NAV_DESTINATIONS } from "../lib/sidebarNav";
import { CARD_PAGE_PARTS } from "../lib/cardLifecycle";
import { TRY_IT_TOUR } from "../lib/tryPanel";
import { useEditor } from "../store/editorStore";
import { useSettings } from "../store/settingsStore";
import { useKanban } from "../store/kanbanStore";
import { useShip } from "../store/shipStore";
import { useTiles } from "../store/tileStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { stopTryWatchesForTests } from "../store/tryRunStore";
import { BOARD_WS, boardCard, boardWorkspace, seedBoard } from "./boardFixtures";
import { act, fireEvent, nextFrame, renderUi, screen, tauri, waitFor, within } from "./render";

// What the anchors sit beside, not what they are: terminals, the editor's
// file tree, the card's heavier parts.
vi.mock("../components/Terminal", () => ({ Terminal: () => <div data-testid="terminal" /> }));
vi.mock("../components/CodexSession", () => ({ CodexSession: () => <div data-testid="codex" /> }));
vi.mock("../components/FilesPanel", () => ({ FilesPanel: () => <div /> }));
vi.mock("../components/BuilderSession", () => ({ BuilderSession: () => <div data-testid="builder-terminal" /> }));
vi.mock("../components/IntakeConversation", () => ({ IntakeConversation: () => <div data-testid="intake-terminal" /> }));
vi.mock("../components/CardReviewPanel", () => ({ CardReviewPanel: () => <div data-testid="review-diff" /> }));
vi.mock("../components/OutcomeScreen", () => ({
  OutcomeScreen: ({
    onPresentationChange,
    tryIt,
  }: {
    onPresentationChange?: (s: { loading: boolean; filesChanged: number | null; shipBusy: boolean }) => void;
    tryIt?: ReactNode;
  }) => {
    useEffect(() => {
      const t = setTimeout(() => onPresentationChange?.({ loading: false, filesChanged: 3, shipBusy: false }));
      return () => clearTimeout(t);
    }, [onPresentationChange]);
    return <div data-testid="outcome">{tryIt}</div>;
  },
}));

afterEach(() => stopTryWatchesForTests());

// ── 1. Every destination has a step or a reason ─────────────────────────

describe("every destination has a tour step or a written reason (§12.1 (1))", () => {
  const covered = new Map<string, string>();
  for (const step of ALL_STEPS) for (const key of step.covers ?? []) covered.set(key, step.id);
  const destinations = tourDestinations();

  it("lists every centre mode, sidebar row, Library page, Settings page and card section", () => {
    for (const m of CENTER_MODES) expect(destinations).toContain(`mode:${m}`);
    for (const d of NAV_DESTINATIONS) expect(destinations).toContain(d.covers);
    expect(destinations).toContain("library:skills");
    expect(destinations).toContain("library:instructions");
    expect(destinations).toContain("settings:setup");
    for (const p of CARD_PAGE_PARTS) expect(destinations).toContain(`card:${p}`);
  });

  it.each(tourDestinations())("%s is covered, planned or exempted — exactly one", (key) => {
    const ways = [
      covered.has(key) && `covered by ${covered.get(key)}`,
      key in PLANNED_IN_CHAPTER && `planned in ${PLANNED_IN_CHAPTER[key]}`,
      key in NOT_A_TOUR_STEP && "exempted",
    ].filter(Boolean);
    expect(ways, `${key}: add it to a step's covers, PLANNED_IN_CHAPTER or NOT_A_TOUR_STEP`).toHaveLength(1);
    if (key in NOT_A_TOUR_STEP) expect(NOT_A_TOUR_STEP[key]!.trim().length).toBeGreaterThan(20);
  });

  it("names only destinations that exist, and plans only for chapters with no steps yet", () => {
    const known = new Set<string>(destinations);
    for (const key of covered.keys()) expect(known, `a step covers ${key}`).toContain(key);
    for (const key of Object.keys(PLANNED_IN_CHAPTER)) expect(known, `planned: ${key}`).toContain(key);
    for (const key of Object.keys(NOT_A_TOUR_STEP)) expect(known, `exempted: ${key}`).toContain(key);
    // TU-7: once a chapter has steps, its destinations move to their covers.
    const written = new Set(CHAPTERS.filter((c) => c.steps.length > 0).map((c) => c.id));
    for (const [key, chapter] of Object.entries(PLANNED_IN_CHAPTER)) {
      expect(written.has(chapter!), `${key} is planned in ${chapter}, which now has steps: cover it there`).toBe(false);
    }
  });

  it("TU-7: every optional chapter has its steps, and nothing is left planned", () => {
    for (const c of CHAPTERS) expect(c.steps.length, `${c.id} has steps`).toBeGreaterThan(0);
    expect(Object.keys(PLANNED_IN_CHAPTER)).toEqual([]);
  });

  it("the sidebar's destinations are the anchors' nav rows, one each", () => {
    expect(new Set(NAV_DESTINATIONS.map((d) => d.id)).size).toBe(NAV_DESTINATIONS.length);
    expect(new Set(NAV_DESTINATIONS.map((d) => d.tour)).size).toBe(NAV_DESTINATIONS.length);
    const anchors = new Set<string>(TOUR_ANCHORS);
    for (const d of NAV_DESTINATIONS) expect(anchors).toContain(d.tour);
    for (const a of TOUR_ANCHORS.filter((a) => a.startsWith("nav-"))) {
      expect(NAV_DESTINATIONS.map((d) => d.tour as string)).toContain(a);
    }
  });
});

// ── 2. Every anchor renders ──────────────────────────────────────────────

/** Anchors seen by the renders below, checked against TOUR_ANCHORS last. */
const seen = new Set<TourAnchor>();

/** The anchor is on exactly one element of what was rendered. */
function one(anchor: TourAnchor): HTMLElement {
  const found = document.querySelectorAll<HTMLElement>(tourSelector(anchor));
  expect(found, `data-ply-tour="${anchor}"`).toHaveLength(1);
  seen.add(anchor);
  return found[0];
}

/** Every anchor in what was rendered, so a pending one cannot hide. */
function noteAll() {
  for (const el of document.querySelectorAll<HTMLElement>("[data-ply-tour]")) {
    seen.add(el.getAttribute("data-ply-tour") as TourAnchor);
  }
}

const env: ShellEnvInfo = {
  path: "/usr/bin",
  shell: "/bin/zsh",
  claudePath: "/usr/local/bin/claude",
  claudeVersion: "2.1.232",
  codexPath: "/usr/local/bin/codex",
  codexVersion: "0.151.0",
  codexHealthy: true,
  gitPath: "/usr/bin/git",
  gitVersion: "2.50.1",
  ghPath: null,
  ghVersion: null,
  supportsStreamJson: true,
  probeError: null,
};

const CARD_FIXTURES = {
  card_overlap_check: [],
  reviewer_list: [],
  verify_status: null,
  improvement_proposal_state: null,
  improvement_proposal_trust_stopped: null,
  ship_pending_release: { release: null, unreadable: null },
  card_review_tip: null,
  project_try_command_get: {
    command: "npm run dev",
    approved: true,
    shared: false,
    readOnly: false,
    hasConfig: true,
    detection: { kind: "none" },
  },
};

function openCard(card: KanbanCard) {
  seedBoard([card]);
  useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
  const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, { fixtures: CARD_FIXTURES });
  view.tauri.allowUnhandled();
  return view;
}

describe("every tour anchor renders, on one element (§4.3, §12.1 (2))", () => {
  it("the sidebar: every nav row, Ship batch, Help, Settings and the card sessions under Terminals", async () => {
    tauri().allowUnhandled();
    tauri().fixture("drain_status", { draining: false, startedAt: null });
    tauri().fixture("ship_pending_count", 5);
    tauri().fixture("ship_pending_cards", null);
    tauri().fixture("ship_unverified_count", 0);
    act(() => {
      useWorkspaces.setState({ workspaces: [boardWorkspace], activeId: BOARD_WS });
      useShip.setState({ pendingCount: 5 });
      // 1.174.1 P3: the row counts the active project's own ready cards.
      const ready = { columnId: "complete", verifyStatus: "passed", shipStatus: "unshipped" } as const;
      useKanban.setState({ byWorkspace: { [BOARD_WS]: { cards: [boardCard("r1", ready), boardCard("r2", ready)], loaded: true } } } as never);
      useTiles.getState().addShellTile(BOARD_WS, boardWorkspace.cwd);
    });
    renderUi(<WorkspaceSidebar env={env} />);
    await screen.findByText("Release 2 cards…");
    for (const d of NAV_DESTINATIONS) {
      const row = one(d.tour);
      // Drawn from the list: its words (Ship batch says its count).
      if (d.id !== "ship-batch") expect(row.textContent).toContain(d.label);
    }
    expect(one("terminals-card-sessions").getAttribute("aria-label")).toBe("Live sessions");
    // TU-4 (§3.3), C9: Help, a row of its own above the foot's line.
    expect(one("help").textContent).toBe("Help");
    expect(one("help").getAttribute("aria-haspopup")).toBe("menu");
    expect(one("help").closest(".shell-foot")).toBeNull();
    expect(one("settings").closest(".shell-foot")).not.toBeNull();
    // No sidebar row without a destination: each one carries a listed anchor
    // (Help opens a menu, not a destination: its own anchor, above).
    const tours = new Set<string>(NAV_DESTINATIONS.map((d) => d.tour));
    const rows = [...document.querySelectorAll<HTMLElement>(".shell-nav-item:not([data-ply-tour='help'])")];
    expect(rows).toHaveLength(NAV_DESTINATIONS.length);
    for (const row of rows) expect(tours).toContain(row.getAttribute("data-ply-tour"));
    noteAll();
  });

  // 1.173.0 B2: the area picker shows only with two areas or more (and so
  // does its step, `audience.areas`); with none it is not drawn at all.
  it("the sidebar with two areas: the area picker under the workspace's name", async () => {
    tauri().allowUnhandled();
    tauri().fixture("drain_status", { draining: false, startedAt: null });
    tauri().fixture("ship_pending_count", 0);
    tauri().fixture("ship_pending_cards", null);
    tauri().fixture("ship_unverified_count", 0);
    const area = (id: string, branch: string, first: boolean) => ({
      id,
      name: id === "app" ? "App" : "Site",
      path: id === "app" ? "" : "site",
      root: id === "app",
      first,
      targetBranch: null,
      branch,
      versionFiles: null,
      tagPrefix: first ? "" : `${id}-`,
      label: `area:${id}`,
      lookAt: null,
    });
    tauri().fixture("areas_get", {
      shared: true,
      readOnly: false,
      defined: [],
      areas: [area("app", "staging", true), area("site", "main", false)],
      workspaceBranch: "staging",
      check: { errors: [], warnings: [] },
      problem: null,
      held: false,
    });
    act(() => useWorkspaces.setState({ workspaces: [boardWorkspace], activeId: BOARD_WS }));
    renderUi(<WorkspaceSidebar env={env} />);
    await waitFor(() => expect(document.querySelector('[data-ply-tour="sidebar-area"]')).not.toBeNull());
    const picker = one("sidebar-area");
    expect(picker.textContent).toBe("Area: All areas");
    expect(picker.getAttribute("aria-haspopup")).toBe("menu");
    // Under the workspace's name, before the navigation.
    expect(picker.closest(".shell-nav")).toBeNull();
    noteAll();
  });

  it("the Board: the header's New card, not the empty Board's", () => {
    act(() => seedBoard([]));
    // 1.174.0 (A6, D2c): Next improvement shows by itself once a card shipped
    // on this Mac (before that, ⋯ › Next improvement… or Take me there).
    act(() =>
      useSettings.setState((s) => ({
        settings: { ...s.settings, nextImprovement: { view: {}, firstCardShippedAt: "2026-10-01T09:00:00.000Z" } },
      })),
    );
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />);
    expect(one("board-new-card").textContent).toBe("New card");
    // 1.173.0 (E3): Next improvement, above the Board, from the first use.
    const ni = one("board-next-improvement");
    expect(ni.getAttribute("aria-label")).toBe("Next improvement");
    expect(ni.closest(".kanban-view")).not.toBeNull();
    noteAll();
  });

  it("a draft card: What you want, the Now action, Chat, Plan it first (Plan with two AIs), the ⋯ and The result", () => {
    openCard(boardCard("c1"));
    expect(one("card-brief").getAttribute("aria-label")).toBe("What you want");
    const primary = one("card-primary");
    expect(primary.hasAttribute("data-ply-primary-action-id")).toBe(true);
    expect(within(screen.getByRole("region", { name: "Now" })).getByText(primary.textContent!)).toBe(primary);
    expect(one("card-tab-chat").textContent).toBe("Ask about this card");
    // 1.172.0 (C1): Plan with two AIs is in Now's Plan it first ▾.
    const planFirst = one("card-plan-two-ais");
    expect(planFirst.textContent).toBe("Plan it first");
    expect(planFirst.getAttribute("aria-haspopup")).toBe("menu");
    expect(planFirst.closest("[aria-label='Now']")).not.toBeNull();
    expect(one("card-more").getAttribute("aria-label")).toBe("More for this card");
    const review = one("card-review");
    expect(review.getAttribute("data-ply-card-section")).toBe("outcome");
    noteAll();
  });

  // 1.172.0 (C2; CP-3): Ready to ship — Try it is the Review's, and the
  // tour's anchor with it; Now's copy, where a state keeps one, takes it.
  it("a card with changes: Try it in the Review on Ready to ship (tryPanel's TRY_IT_TOUR), the primary still one", async () => {
    expect(TRY_IT_TOUR).toBe("card-try-it");
    openCard(
      boardCard("c1", {
        notes: "x",
        columnId: "complete",
        lastRunStatus: "success",
        verifyStatus: "passed",
        worktreePath: "/r/.plyloft-worktrees/c1",
        portBase: 41000,
      }),
    );
    const now = within(screen.getByRole("region", { name: "Now" }));
    await now.findByRole("button", { name: "Read the review" });
    expect(now.queryByRole("button", { name: "Try it" })).toBeNull();
    const button = document.querySelector<HTMLElement>("[data-ply-try-it='review']")!;
    expect(one("card-try-it")).toBe(button);
    expect(button.closest("[data-ply-tour='card-review']")).not.toBeNull();
    one("card-primary");
    noteAll();
  });

  it("Terminals: New", () => {
    act(() => useWorkspaces.setState({ workspaces: [boardWorkspace], activeId: BOARD_WS }));
    const view = renderUi(<TileGrid env={env} workspace={boardWorkspace} />);
    view.tauri.allowUnhandled();
    expect(one("terminals-new").textContent).toBe("New");
    // 1.173.0 A3: the In a new copy… item, once New's menu is open.
    fireEvent.click(one("terminals-new"));
    expect(one("terminals-new-copy").textContent).toContain("In a new copy…");
    noteAll();
  });

  it("Code: More for Code", async () => {
    tauri().allowUnhandled();
    useEditor.getState().open(BOARD_WS, "/p/main.rs", "fn main() {}\n", null);
    renderUi(<CodeModeHost workspaceId={BOARD_WS} cwd="/p" />, { fixtures: { probe_localhost_ports: [] } });
    await nextFrame();
    expect(one("code-more").getAttribute("aria-label")).toBe("More for Code");
    noteAll();
  });

  it("the Library: its pages, as the nav column or the compact row", () => {
    tauri().allowUnhandled();
    renderUi(<LibraryModeHost workspaceId={BOARD_WS} cwd="/tmp/ws" visible={false} />);
    expect(one("library-tabs").textContent).toContain("Skills");
    noteAll();
  });

  // Last: what every render above drew.
  it("every anchor of TOUR_ANCHORS rendered, but the pending ones", () => {
    for (const anchor of TOUR_ANCHORS) {
      if (anchor in PENDING_ANCHORS) {
        expect(seen.has(anchor), `${anchor} renders now: move it out of PENDING_ANCHORS`).toBe(false);
      } else {
        expect(seen.has(anchor), `${anchor} is not rendered by its owning component`).toBe(true);
      }
    }
    for (const a of seen) expect(TOUR_ANCHORS as readonly string[]).toContain(a);
    expect(Object.keys(PENDING_ANCHORS)).toEqual([]);
  });
});

// ── 3. One visible element in the app ────────────────────────────────────

describe("an anchor is looked up on the visible host (§4.3)", () => {
  it("skips the hidden warmed hosts, closed sections, inert layers and the stage under All skills", () => {
    document.body.innerHTML = `
      <div class="center-stage">
        <div class="center-mode-host"><div class="tile-grid-host hidden"><button data-ply-tour="terminals-new" id="t-a"></button></div>
          <div class="tile-grid-host"><button data-ply-tour="terminals-new" id="t-b"></button></div></div>
        <div class="center-mode-host center-mode-sticky hidden"><button data-ply-tour="code-more" id="c-a"></button></div>
        <div class="center-card-host"><section aria-hidden="true" inert data-ply-tour="card-review" id="r-a"></section></div>
      </div>
      <div class="center-stage center-stage--app-page">
        <div class="center-mode-host"><button data-ply-tour="library-tabs" id="l-a"></button></div>
      </div>`;
    expect(document.querySelectorAll(tourSelector("terminals-new"))).toHaveLength(2);
    expect(findTourAnchor("terminals-new")?.id).toBe("t-b");
    expect(shownTourAnchors("terminals-new")).toHaveLength(1);
    expect(findTourAnchor("code-more")).toBeNull();
    expect(findTourAnchor("card-review")).toBeNull();
    expect(findTourAnchor("library-tabs")).toBeNull();
    document.body.innerHTML = "";
  });

  it("skips what is under a modal or the sidebar overlay, and the shell under Setup", () => {
    document.body.innerHTML = `
      <div class="app-shell-under">
        <div class="center-card-host"><button data-ply-tour="card-primary" id="p-a"></button></div>
        <div class="shell-sidebar-slot"><button data-ply-tour="settings" id="s-a"></button></div>
      </div>
      <div class="center-card-host hidden"><div role="dialog" aria-modal="true"></div></div>`;
    // A modal in a hidden host covers nothing.
    expect(findTourAnchor("card-primary")?.id).toBe("p-a");
    // A Sheet over the card, Settings, Search: what is outside it is under it.
    const sheet = document.createElement("div");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.innerHTML = `<button data-ply-tour="card-more" id="m-a"></button>`;
    document.querySelector(".center-card-host")!.append(sheet);
    expect(findTourAnchor("card-primary")).toBeNull();
    expect(findTourAnchor("settings")).toBeNull();
    expect(findTourAnchor("card-more")?.id).toBe("m-a");
    sheet.remove();
    // The sidebar overlay in a narrow window covers the stage, not itself.
    const overlay = document.createElement("div");
    overlay.className = "shell-sidebar-slot shell-sidebar-slot--overlay";
    overlay.innerHTML = `<button data-ply-tour="nav-board" id="n-a"></button>`;
    document.body.append(overlay);
    expect(findTourAnchor("card-primary")).toBeNull();
    expect(findTourAnchor("nav-board")?.id).toBe("n-a");
    overlay.remove();
    // Setup up: the shell under it is inert and aria-hidden.
    const under = document.querySelector(".app-shell-under")!;
    under.setAttribute("inert", "");
    under.setAttribute("aria-hidden", "true");
    expect(findTourAnchor("card-primary")).toBeNull();
    expect(findTourAnchor("settings")).toBeNull();
    document.body.innerHTML = "";
  });

  it("asks the browser in the app, and without checkVisibility (WebKit before 17.4) the box and the style", () => {
    const ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 AppleWebKit/605.1.15");
    try {
      document.body.innerHTML = `<button data-ply-tour="terminals-new" id="a"></button><button data-ply-tour="code-more" id="b"></button>`;
      const a = document.getElementById("a")!;
      const b = document.getElementById("b")!;
      const box = [{ width: 10, height: 10 }] as unknown as DOMRectList;
      const empty = [] as unknown as DOMRectList;
      // The app's browser has it: its answer decides.
      Object.defineProperty(a, "checkVisibility", { configurable: true, value: () => false });
      Object.defineProperty(b, "checkVisibility", { configurable: true, value: () => true });
      expect(findTourAnchor("terminals-new")).toBeNull();
      expect(findTourAnchor("code-more")).toBe(b);
      // Without it: no box (display: none somewhere above) is not shown…
      for (const el of [a, b]) Object.defineProperty(el, "checkVisibility", { configurable: true, value: undefined });
      Object.defineProperty(a, "getClientRects", { configurable: true, value: () => empty });
      Object.defineProperty(b, "getClientRects", { configurable: true, value: () => box });
      expect(findTourAnchor("terminals-new")).toBeNull();
      expect(findTourAnchor("code-more")).toBe(b);
      // …nor is a box whose computed visibility is hidden.
      b.style.visibility = "hidden";
      expect(findTourAnchor("code-more")).toBeNull();
    } finally {
      ua.mockRestore();
      document.body.innerHTML = "";
    }
  });

  it("finds the card page's anchors in the active workspace's host only", async () => {
    // Two warmed card hosts, as NewWorkspaceShell draws them: one hidden.
    seedBoard([boardCard("c1")]);
    useWorkspaces.setState({ workspaces: [boardWorkspace, { ...boardWorkspace, id: "ws-2", name: "Vega" }] });
    useKanban.setState((st) => ({
      byWorkspace: { ...st.byWorkspace, "ws-2": { cards: [boardCard("c2", { workspaceId: "ws-2" })], loaded: true } },
    }));
    useUi.setState({ selectedCardId: { [BOARD_WS]: "c1", "ws-2": "c2" }, centerMode: { [BOARD_WS]: "board" } });
    const view = renderUi(
      <>
        <div className="center-card-host hidden">
          <CardDetailPanel workspaceId="ws-2" />
        </div>
        <div className="center-card-host">
          <CardDetailPanel workspaceId={BOARD_WS} />
        </div>
      </>,
      { fixtures: CARD_FIXTURES },
    );
    view.tauri.allowUnhandled();
    await waitFor(() => expect(document.querySelectorAll(tourSelector("card-brief"))).toHaveLength(2));
    expect(document.querySelectorAll(tourSelector("card-primary"))).toHaveLength(2);
    const shown = findTourAnchor("card-brief");
    expect(shown?.closest("[data-ply-card-host]")?.getAttribute("data-ply-card-id")).toBe("c1");
    expect(shownTourAnchors("card-primary")).toHaveLength(1);
  });
});

// ── 4. Every step is in the user guide ──────────────────────────────────

describe("every step has its marker in the user guide, and every marker a step (§12.1 (3))", () => {
  // TU-9 folded the draft into the guide's "The Getting started tour"; the
  // guide is also what release.sh publishes to the site (D26).
  const GUIDE = "docs/onboarding/USER_GUIDE.md";
  const text = readFileSync(GUIDE, "utf8");
  const markers = [...text.matchAll(/<!--\s*tour:([\w.-]+)\s*-->/g)].map((m) => m[1]);

  it("has no marker twice", () => {
    expect(new Set(markers).size).toBe(markers.length);
  });

  it.each(ALL_STEPS.map((s) => s.id))("%s has its marker", (id) => {
    expect(markers, `${GUIDE} needs <!-- tour:${id} -->`).toContain(id);
  });

  it("names no step that does not exist", () => {
    const ids = new Set(ALL_STEPS.map((s) => s.id));
    for (const m of markers) expect(ids, `${GUIDE}: <!-- tour:${m} --> names no step`).toContain(m);
  });
});
