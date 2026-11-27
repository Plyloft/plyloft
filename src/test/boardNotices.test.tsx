// 1.174.0 (A4, P2 BCI-1 AR-2 VC-2 VC-3): one slot for the notes above the
// Board (mockups/board.html §1–3, §8). The worst case of a new monorepo — a
// shared setup made for another branch, the project folder behind GitHub,
// two products — shows one note whole and "2 more notes: …"; Show and Show
// fewer work from the keyboard; answering the first raises the next; no
// note draws a filled button, so the Board's one is New card.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { AreaDiscovery, AreasView, LocalBranchReport } from "../ipc";
import type { AdoptionStatus } from "../lib/adoption";
import { BoardNotices } from "../components/BoardNotices";
import { KanbanBoard } from "../components/KanbanBoard";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useAreas } from "../store/areaStore";
import { useSettings } from "../store/settingsStore";
import { useErrorBlocks } from "../store/errorBlockStore";
import { useProjectFolder } from "../store/projectFolderStore";
import { lookAtTheIdeas, niKey, useNextImprovement } from "../store/nextImprovementStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, renderUi, screen, waitFor, within } from "./render";

const NOTES = "Notes about this project";

const elsewhere = (): AdoptionStatus => ({
  githubRepo: "o/lyra",
  hasDefinition: true,
  boardRepo: "o/lyra",
  action: { kind: "setupElsewhere", here: "lyra", branch: "main", name: "lyra" },
});

const noAreas: AreasView = {
  shared: true,
  readOnly: false,
  defined: [],
  areas: [],
  workspaceBranch: "main",
  check: { errors: [], warnings: [] },
  problem: null,
  held: false,
};

const TWO_PRODUCTS: AreaDiscovery = {
  products: [
    { path: "", kind: "app" },
    { path: "lyrappc-astro", kind: "site" },
  ],
  suggestion: [
    { id: "app", name: "App", path: "" },
    { id: "site", name: "Site", path: "lyrappc-astro" },
  ],
  notice: true,
};

/** The folder on main with changes in it, GitHub's main 6 updates ahead. */
const behind: LocalBranchReport = {
  branch: "main",
  outcome: { kind: "dirty", behind: 6 },
  folder: {
    branch: "main",
    head: "a".repeat(40),
    headAt: null,
    targetLocal: "a".repeat(40),
    targetRemote: "b".repeat(40),
    newer: 6,
    onlyHere: 0,
    changedCount: 3,
    changedPaths: ["a", "b", "c"],
  },
};

/** `ni`: Next improvement shown (its first use); hidden otherwise, as A6
 *  keeps it until a first card has shipped. */
function seed(folder: LocalBranchReport | null = behind, ni = false, cards: Parameters<typeof seedBoard>[0] = []) {
  act(() => {
    if (!ni) useNextImprovement.getState().hide(niKey(BOARD_WS, null), "first-use");
    seedBoard(cards);
    useAreas.setState({ views: {}, discoveries: {} });
    useErrorBlocks.setState({
      byWorkspace: {
        [BOARD_WS]: {
          localBranch: null,
          shipStep: null,
          publishRefused: null,
          unpublished: null,
          unreadableRecord: null,
          localState: folder,
        },
      },
    });
    useProjectFolder.setState({ sheetFor: null, answered: {} });
  });
}

const fixtures = (status: () => unknown = elsewhere) => ({
  workspace_adoption_status: status,
  areas_get: noAreas,
  areas_discover: TWO_PRODUCTS,
  workspace_setup_elsewhere: null,
  workspace_adoption_setup_elsewhere: null,
  workspace_dismiss_area_notice: null,
});

const slot = () => screen.getByRole("region", { name: NOTES });

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
  // A6 (D2c): a card shipped on this Mac, so Next improvement shows by itself.
  useSettings.setState((s) => ({
    settings: { ...s.settings, nextImprovement: { view: {}, firstCardShippedAt: "2026-10-01T09:00:00.000Z" } },
  }));
});

describe("U31: the project's folder isn't where Plyloft left it", () => {
  // Walk 2026-11-03: its box stopped at the page column, inside the slot's frame.
  it("takes the slot's whole width, with no box of its own", () => {
    const board = readFileSync("src/components/board.css", "utf8");
    const rule = board.slice(board.indexOf(".ux-notes-item > [data-ply-project-folder-gone] .ux-callout {"));
    expect(rule.length).toBeLessThan(board.length);
    const body = rule.slice(rule.indexOf("{"), rule.indexOf("}"));
    expect(body).toContain("max-width: none");
    expect(body).toContain("border: 0");
  });

  const seed = () =>
    act(() => {
      seedBoard([]);
      const cwd = useWorkspaces.getState().workspaces.find((w) => w.id === BOARD_WS)!.cwd;
      useWorkspaces.setState({ cwdMissing: { [BOARD_WS]: true } });
      return cwd;
    });
  const cwdNow = () => useWorkspaces.getState().workspaces.find((w) => w.id === BOARD_WS)!.cwd;
  const note = () => document.querySelector('[data-ply-note="project-folder-gone"]') as HTMLElement;

  it("a team's project: the way back, and what a new clone won't bring", async () => {
    seed();
    const r = renderUi(<BoardNotices workspaceId={BOARD_WS} ghBacked={false} />, {
      fixtures: {
        team_status: () => ({
          workspaces: [{ repo: "o/r", name: "r", registered: true, cloned: false, folderPresent: false, localPath: cwdNow(), conflict: null }],
        }),
      },
    });
    r.tauri.allowUnhandled();
    expect(note().textContent).toContain("This project's folder isn't where Plyloft left it");
    await r.user.click(await within(note()).findByRole("button", { name: "Clone it again" }));
    expect(useUi.getState().settingsOverlayOpen).toBe(true);
    expect(note().textContent).toContain("A new clone doesn't bring back the card copies");
  });

  it("a personal project, in a team or alone: the note and no Team page", async () => {
    seed();
    const r = renderUi(<BoardNotices workspaceId={BOARD_WS} ghBacked={false} />, {
      fixtures: { team_status: { workspaces: [] } },
    });
    r.tauri.allowUnhandled();
    await waitFor(() => expect(r.tauri.callsOf("team_status").length).toBeGreaterThan(0));
    expect(note().textContent).toContain("isn't where Plyloft left it");
    expect(within(note()).queryByRole("button", { name: "Clone it again" })).toBeNull();
  });

  it("coming back to the window reads the folder again", async () => {
    act(() => seedBoard([]));
    const r = renderUi(<BoardNotices workspaceId={BOARD_WS} ghBacked={false} />, {
      fixtures: { workspace_cwd_exists: false, team_status: { workspaces: [] } },
    });
    r.tauri.allowUnhandled();
    expect(note()).toBeNull();
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(note()).toBeTruthy());
    // Back from hidden too, and it goes once the folder is back.
    r.tauri.fixture("workspace_cwd_exists", true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(note()).toBeNull());
  });
});

describe("the Board's notes slot (A4)", () => {
  it("the worst case: one note whole, the others named in one line; Show and Show fewer from the keyboard", async () => {
    seed();
    const r = renderUi(<BoardNotices workspaceId={BOARD_WS} ghBacked />, { fixtures: fixtures() });
    r.tauri.allowUnhandled();
    await screen.findByRole("region", { name: "This project has a shared setup on GitHub" });
    await waitFor(() =>
      expect(within(slot()).getByText(/^2 more notes:/).textContent).toBe(
        "2 more notes: your project folder is behind GitHub · two products in this repository",
      ),
    );
    // Only the first note's body is drawn.
    expect(within(slot()).queryByRole("region", { name: "Products in this repository" })).toBeNull();
    expect(slot().querySelector("[data-ply-folder-state]")).toBeNull();
    // The keyboard: Tab to Show, Enter; focus lands on Show fewer.
    const show = within(slot()).getByRole("button", { name: "Show" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    show.focus();
    await r.user.keyboard("{Enter}");
    const fewer = await within(slot()).findByRole("button", { name: "Show fewer" });
    expect(fewer.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(fewer));
    // In the slot's order: setup, folder, areas.
    const notes = [...slot().querySelectorAll("[data-ply-note]")].map((n) => n.getAttribute("data-ply-note"));
    expect(notes).toEqual(["adoption", "folder", "areas"]);
    expect(within(slot()).getByRole("region", { name: "Products in this repository" })).toBeTruthy();
    expect(within(slot()).getByRole("button", { name: "Bring it up to date" })).toBeTruthy();
    // No note draws a filled button.
    expect(slot().querySelectorAll(".cbtn--accent")).toHaveLength(0);
    await r.user.keyboard("{Enter}");
    const again = await within(slot()).findByRole("button", { name: "Show" });
    await waitFor(() => expect(document.activeElement).toBe(again));
    expect(slot().querySelectorAll("[data-ply-note]")).toHaveLength(1);
  });

  it("answering the first raises the next", async () => {
    seed();
    let answered = false;
    const r = renderUi(<BoardNotices workspaceId={BOARD_WS} ghBacked />, {
      fixtures: fixtures(() =>
        answered ? { ...elsewhere(), action: { kind: "none" } } : elsewhere(),
      ),
    });
    r.tauri.fixture("workspace_adoption_setup_elsewhere", () => {
      answered = true;
      return null;
    });
    r.tauri.allowUnhandled();
    await screen.findByRole("region", { name: "This project has a shared setup on GitHub" });
    await within(slot()).findByText(/^2 more notes:/);
    await r.user.click(within(slot()).getByRole("button", { name: "Keep this folder's setup" }));
    // The folder's note is first now, the areas behind it.
    await waitFor(() => expect(slot().querySelector('[data-ply-note="folder"]')).not.toBeNull());
    expect(screen.queryByRole("region", { name: "This project has a shared setup on GitHub" })).toBeNull();
    expect(within(slot()).getByText("1 more note: two products in this repository")).toBeTruthy();
  });

  it("one note alone has no line; none leaves no slot", async () => {
    seed(null);
    const r = renderUi(<BoardNotices workspaceId={BOARD_WS} ghBacked />, {
      fixtures: { ...fixtures(), areas_discover: { products: [], suggestion: [], notice: false } },
    });
    r.tauri.allowUnhandled();
    await screen.findByRole("region", { name: "This project has a shared setup on GitHub" });
    expect(within(slot()).queryByRole("button", { name: "Show" })).toBeNull();
    expect(within(slot()).queryByText(/more note/)).toBeNull();
    r.unmount();

    seed(null);
    const none = renderUi(<BoardNotices workspaceId={BOARD_WS} ghBacked />, {
      fixtures: {
        ...fixtures(() => ({ ...elsewhere(), action: { kind: "none" } })),
        areas_discover: { products: [], suggestion: [], notice: false },
      },
    });
    none.tauri.allowUnhandled();
    await waitFor(() => expect(none.tauri.callsOf("workspace_adoption_status").length).toBeGreaterThan(0));
    await act(async () => {});
    expect(screen.queryByRole("region", { name: NOTES })).toBeNull();
  });

  it("the folder's note is a GitHub-backed Board's only", async () => {
    seed();
    const r = renderUi(<BoardNotices workspaceId={BOARD_WS} ghBacked={false} />, { fixtures: fixtures() });
    r.tauri.allowUnhandled();
    await within(await screen.findByRole("region", { name: NOTES })).findByText("1 more note: two products in this repository");
  });

  it("on the Board: Next improvement is a name in the line, and the one filled button is the empty Board's Make the card", async () => {
    seed(null, true);
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: fixtures() });
    r.tauri.allowUnhandled();
    await screen.findByRole("region", { name: "This project has a shared setup on GitHub" });
    await waitFor(() =>
      expect(within(slot()).getByText(/^2 more notes:/).textContent).toBe(
        "2 more notes: two products in this repository · Next improvement",
      ),
    );
    // Behind another note Next improvement draws nothing until Show.
    expect(screen.queryByRole("region", { name: "Next improvement" })).toBeNull();
    await r.user.click(within(slot()).getByRole("button", { name: "Show" }));
    expect(await screen.findByRole("region", { name: "Next improvement" })).toBeTruthy();
    const filled = [...document.querySelectorAll(".cbtn--accent")].map((b) => b.textContent?.trim());
    // 1.176.3: while the Board is empty the box in the middle holds it.
    expect(filled).toEqual(["Make the card"]);
  });

  it("on the Board: Next improvement is a name in the line, and New card is the one filled button (a Board with a card)", async () => {
    seed(null, true, [boardCard("c1")]);
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: fixtures() });
    r.tauri.allowUnhandled();
    await screen.findByRole("region", { name: "This project has a shared setup on GitHub" });
    await waitFor(() =>
      expect(within(slot()).getByText(/^2 more notes:/).textContent).toBe(
        "2 more notes: two products in this repository · Next improvement",
      ),
    );
    // Behind another note Next improvement draws nothing until Show.
    expect(screen.queryByRole("region", { name: "Next improvement" })).toBeNull();
    await r.user.click(within(slot()).getByRole("button", { name: "Show" }));
    expect(await screen.findByRole("region", { name: "Next improvement" })).toBeTruthy();
    const filled = [...document.querySelectorAll(".cbtn--accent")].map((b) => b.textContent?.trim());
    expect(filled).toEqual(["New card"]);
  });

  it("round 1: Look at the ideas and ⋯ › Show Next improvement open the slot behind another note, the heading focused", async () => {
    seed(null, true);
    const r = renderUi(<BoardNotices workspaceId={BOARD_WS} ghBacked />, {
      fixtures: { ...fixtures(), areas_discover: { products: [], suggestion: [], notice: false } },
    });
    r.tauri.allowUnhandled();
    await screen.findByRole("region", { name: "This project has a shared setup on GitHub" });
    await within(slot()).findByText("1 more note: Next improvement");
    expect(screen.queryByRole("region", { name: "Next improvement" })).toBeNull();
    act(() => lookAtTheIdeas(BOARD_WS, "default"));
    const ni = await screen.findByRole("region", { name: "Next improvement" });
    expect(within(slot()).getByRole("button", { name: "Show fewer" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(ni.querySelector(".ni-title")));

    // Show fewer, then the menu's Show Next improvement (it was hidden).
    await r.user.click(within(slot()).getByRole("button", { name: "Show fewer" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Next improvement" })).toBeNull());
    act(() => useNextImprovement.getState().show(niKey(BOARD_WS, null), BOARD_WS));
    expect(await screen.findByRole("region", { name: "Next improvement" })).toBeTruthy();
  });

  it("round 1: answering the first note with focus in the slot hands focus to the next note's first button", async () => {
    seed();
    let answered = false;
    const r = renderUi(<BoardNotices workspaceId={BOARD_WS} ghBacked />, {
      fixtures: fixtures(() => (answered ? { ...elsewhere(), action: { kind: "none" } } : elsewhere())),
    });
    r.tauri.fixture("workspace_adoption_setup_elsewhere", () => {
      answered = true;
      return null;
    });
    r.tauri.allowUnhandled();
    await screen.findByRole("region", { name: "This project has a shared setup on GitHub" });
    await r.user.click(within(slot()).getByRole("button", { name: "Keep this folder's setup" }));
    await waitFor(() => expect(slot().querySelector('[data-ply-note="folder"]')).not.toBeNull());
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Bring it up to date"));
  });

  it("round 1: once nothing more waits, the slot is short again for the next note", async () => {
    seed(null);
    const r = renderUi(<BoardNotices workspaceId={BOARD_WS} ghBacked />, {
      fixtures: { ...fixtures(), workspace_dismiss_area_notice: null },
    });
    r.tauri.allowUnhandled();
    await within(await screen.findByRole("region", { name: NOTES })).findByText(/^1 more note: two products/);
    await r.user.click(within(slot()).getByRole("button", { name: "Show" }));
    expect(within(slot()).getByRole("button", { name: "Show fewer" })).toBeTruthy();
    // The areas' Don't ask again: one note left, nothing more.
    await r.user.click(within(slot()).getByRole("button", { name: "Don't ask again" }));
    await waitFor(() => expect(slot().querySelector('[data-ply-note="areas"]')).toBeNull());
    expect(within(slot()).queryByRole("button", { name: "Show fewer" })).toBeNull();
    // A note that comes later starts short.
    act(() => useNextImprovement.getState().show(niKey(BOARD_WS, null)));
    expect(await within(slot()).findByRole("button", { name: "Show" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Next improvement" })).toBeNull();
  });

  it("round 1: a note behind another still runs its automatic step — ConvertLegacy publishes once", async () => {
    seed(null);
    const r = renderUi(<BoardNotices workspaceId={BOARD_WS} ghBacked />, {
      fixtures: {
        ...fixtures(() => ({ ...elsewhere(), action: { kind: "convertLegacy" } })),
        areas_get: { ...noAreas, problem: "Two areas use one folder.", held: true },
        workspace_definition_publish: null,
      },
    });
    r.tauri.allowUnhandled();
    await waitFor(() => expect(slot().querySelector('[data-ply-note="areas"]')).not.toBeNull());
    await waitFor(() => expect(r.tauri.callsOf("workspace_definition_publish")).toHaveLength(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(r.tauri.callsOf("workspace_definition_publish")).toHaveLength(1);
  });
});
