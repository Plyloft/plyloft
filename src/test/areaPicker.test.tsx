// 1.173.0 (B2): the area picker under the workspace's name, what follows it
// on the Board (filter, title, the empty area), the held and kept lines, the
// two-products notice and where a new copy starts.
// Mockup: ~/ply-build/next-1173/mockups/areas.html, scenes 1–2.
import { describe, expect, it, vi } from "vitest";
import { AreaPicker } from "../components/AreaPicker";
import { KanbanBoard } from "../components/KanbanBoard";
import { NewCopySheet } from "../components/NewCopySheet";
import type { AreaDiscovery, AreasView, KanbanCard, ResolvedArea, ShellEnvInfo } from "../ipc";
import { currentAreaFor, copyBranchFor, useAreas } from "../store/areaStore";
import { useUi } from "../store/uiStore";
import { useToasts } from "../store/toastStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useKanban } from "../store/kanbanStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { setTeamAllowed } from "./planGates";
import { act, fireEvent, renderUi, screen, waitFor, within } from "./render";
import { setPlatformForTests } from "../lib/platform";

vi.mock("../components/Terminal", () => ({ Terminal: () => <div data-testid="terminal" /> }));

function area(id: string, name: string, branch: string, first = false): ResolvedArea {
  return {
    id,
    name,
    path: id === "app" ? "" : "lyrappc-astro",
    root: id === "app",
    first,
    targetBranch: branch === "staging" ? null : branch,
    branch,
    versionFiles: null,
    tagPrefix: first ? "" : `${id}-`,
    label: `area:${id}`,
    lookAt: null,
  };
}

const APP = area("app", "App", "staging", true);
const SITE = area("site", "Site", "main");

function view(areas: ResolvedArea[], extra: Partial<AreasView> = {}): AreasView {
  return {
    shared: true,
    readOnly: false,
    defined: areas.map((a) => ({ id: a.id, name: a.name, path: a.path })),
    areas,
    workspaceBranch: "staging",
    check: { errors: [], warnings: [] },
    problem: null,
    held: false,
    ...extra,
  };
}

const LYRA: AreaDiscovery = {
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

function withArea(card: KanbanCard, id: string | null): KanbanCard {
  return { ...card, area: id };
}

function seed(defaultArea: string | null = null, cards: KanbanCard[] = []) {
  act(() => seedBoard(cards, defaultArea ? { defaultArea } : {}));
}

/** What a screen reader reads after the item's name (`aria-describedby`). */
function description(el: HTMLElement): string {
  const id = el.getAttribute("aria-describedby");
  return id ? (document.getElementById(id)?.textContent ?? "") : "";
}

async function trigger(name: RegExp) {
  return screen.findByRole("button", { name });
}

describe("the area picker's visibility", () => {
  it("shows nothing with no areas, one area, or held areas", async () => {
    const views = [view([]), view([APP]), view([], { held: true, problem: "Two areas use one folder." })];
    for (const [i, v] of views.entries()) {
      seed();
      act(() => useAreas.setState({ views: {}, chosen: {} }));
      const r = renderUi(<AreaPicker workspaceId={BOARD_WS} />, { fixtures: { areas_get: v } });
      r.tauri.fixture("areas_get", v);
      await waitFor(() => expect(r.tauri.callsOf("areas_get")).toHaveLength(i + 1));
      await waitFor(() => expect(useAreas.getState().views[BOARD_WS]).toEqual(v));
      expect(screen.queryByRole("button", { name: /^Area:/ })).toBeNull();
      expect(document.querySelector('[data-ply-tour="sidebar-area"]')).toBeNull();
      r.unmount();
    }
  });

  it("with two areas reads Area: All areas, carries its tour anchor, and the menu says where each area's cards go", async () => {
    seed();
    renderUi(<AreaPicker workspaceId={BOARD_WS} />, { fixtures: { areas_get: view([APP, SITE]) } });
    const button = await trigger(/^Area: All areas/);
    expect(button.getAttribute("data-ply-tour")).toBe("sidebar-area");
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.textContent).toBe("Area: All areas");
    fireEvent.click(button);
    const menu = await screen.findByRole("menu", { name: "Area" });
    const all = within(menu).getByRole("menuitemradio", { name: "All areas" });
    expect(all.getAttribute("aria-checked")).toBe("true");
    expect(description(within(menu).getByRole("menuitemradio", { name: "App" }))).toBe("cards go to staging");
    expect(description(within(menu).getByRole("menuitemradio", { name: "Site" }))).toBe("cards go to main");
    expect(within(menu).getByRole("menuitem", { name: "Edit areas…" })).toBeTruthy();
    // All areas is already this Mac's default: nothing to make default.
    expect(within(menu).queryByRole("menuitemcheckbox")).toBeNull();
    // Focus is on the current choice.
    expect(document.activeElement).toBe(all);
  });
});

describe("choosing an area and this Mac's default", () => {
  it("starts at this Mac's default, and Make Site this Mac's default is checked; pressing it goes back to All areas", async () => {
    seed("site");
    const r = renderUi(<AreaPicker workspaceId={BOARD_WS} />, {
      fixtures: { areas_get: view([APP, SITE]), workspace_set_default_area: null },
    });
    const button = await trigger(/^Area: Site/);
    expect(currentAreaFor(BOARD_WS)).toBe("site");
    fireEvent.click(button);
    const make = await screen.findByRole("menuitemcheckbox", { name: "Make Site this Mac's default" });
    expect(make.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(make);
    await waitFor(() =>
      expect(r.tauri.callsOf("workspace_set_default_area")).toEqual([
        { cmd: "workspace_set_default_area", args: { id: BOARD_WS, area: null } },
      ]),
    );
    expect(useWorkspaces.getState().workspaces[0].defaultArea).toBeNull();
    // The session's choice stays Site until another is picked.
    expect(screen.getByRole("button", { name: /^Area: Site/ })).toBeTruthy();
  });

  it("is a keyboard menu: Enter opens it, arrows move, Enter picks, and the default can be made from there", async () => {
    seed();
    const r = renderUi(<AreaPicker workspaceId={BOARD_WS} />, {
      fixtures: { areas_get: view([APP, SITE]), workspace_set_default_area: null },
    });
    const button = await trigger(/^Area: All areas/);
    fireEvent.click(button);
    const menu = await screen.findByRole("menu", { name: "Area" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(within(menu).getByRole("menuitemradio", { name: "Site" }));
    fireEvent.click(document.activeElement!);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Area: Site/ }));
    expect(currentAreaFor(BOARD_WS)).toBe("site");
    expect(copyBranchFor(BOARD_WS)).toBe("main");

    fireEvent.click(screen.getByRole("button", { name: /^Area: Site/ }));
    const make = await screen.findByRole("menuitemcheckbox", { name: "Make Site this Mac's default" });
    expect(make.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(make);
    await waitFor(() =>
      expect(r.tauri.callsOf("workspace_set_default_area")[0]?.args).toEqual({ id: BOARD_WS, area: "site" }),
    );
    await waitFor(() => expect(make.getAttribute("aria-checked")).toBe("true"));
    // Esc closes it and gives the keyboard back to the row.
    fireEvent.keyDown(screen.getByRole("menu", { name: "Area" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Area: Site/ }));
  });

  it("a default the repository no longer has is All areas, with no error", async () => {
    seed("docs");
    renderUi(<AreaPicker workspaceId={BOARD_WS} />, { fixtures: { areas_get: view([APP, SITE]) } });
    await trigger(/^Area: All areas/);
    expect(currentAreaFor(BOARD_WS)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Edit areas… opens Settings › Areas for the workspace", async () => {
    seed();
    renderUi(<AreaPicker workspaceId={BOARD_WS} />, { fixtures: { areas_get: view([APP, SITE]) } });
    fireEvent.click(await trigger(/^Area:/));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit areas…" }));
    expect(useUi.getState().settingsSection).toBe("areas");
  });
});

describe("the Board follows the picker", () => {
  const cards = [
    withArea(boardCard("Pricing page"), "site"),
    withArea(boardCard("Search terms"), "app"),
    withArea(boardCard("Untagged issue"), null),
  ];

  it("on Site: its cards only, titled Board · Site; on All areas: every card", async () => {
    seed("site", cards);
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { areas_get: view([APP, SITE]) } });
    r.tauri.allowUnhandled();
    await screen.findByRole("heading", { name: "Board · Site" });
    expect(screen.getByText("Pricing page")).toBeTruthy();
    expect(screen.queryByText("Search terms")).toBeNull();
    expect(screen.queryByText("Untagged issue")).toBeNull();
    act(() => useAreas.getState().choose(BOARD_WS, null));
    await screen.findByRole("heading", { name: "Board" });
    expect(screen.getByText("Search terms")).toBeTruthy();
    expect(screen.getByText("Untagged issue")).toBeTruthy();
  });

  // 1.173.0 (F1, Challenger 4): on an area the Board's Needs you counts its
  // cards and says what the other areas hold, so it adds up to the Inbox.
  it("on Site, Needs you says how many need you in other areas", async () => {
    const failed = { columnId: "in_progress" as const, lastRunStatus: "failed" as const };
    seed("site", [
      withArea(boardCard("Pricing page", failed), "site"),
      withArea(boardCard("Search terms", failed), "app"),
      withArea(boardCard("Untagged issue", failed), null),
    ]);
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { areas_get: view([APP, SITE]) } });
    r.tauri.allowUnhandled();
    await screen.findByRole("heading", { name: "Board · Site" });
    const needs = screen.getByRole("region", { name: /^Needs you/ });
    expect(needs.querySelector(".board-column-heading")?.textContent).toBe("Needs you1· 2 in other areas");
    act(() => useAreas.getState().choose(BOARD_WS, null));
    await screen.findByRole("heading", { name: "Board" });
    expect(screen.getByRole("region", { name: /^Needs you/ }).querySelector(".board-column-heading")?.textContent).toBe("Needs you3");
  });

  it("an area with no cards says so, with Show all areas", async () => {
    seed("site", [withArea(boardCard("Search terms"), "app")]);
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { areas_get: view([APP, SITE]) } });
    r.tauri.allowUnhandled();
    await screen.findByText("No cards in Site.");
    fireEvent.click(screen.getByRole("button", { name: "Show all areas" }));
    await screen.findByText("Search terms");
  });

  it("cards with no area — from before areas, or stamped as the whole workspace's — are under All areas only", async () => {
    seed("site", [boardCard("Old card"), withArea(boardCard("Skill card"), "default"), withArea(boardCard("Pricing page"), "site")]);
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { areas_get: view([APP, SITE]) } });
    r.tauri.allowUnhandled();
    await screen.findByRole("heading", { name: "Board · Site" });
    expect(screen.getByText("Pricing page")).toBeTruthy();
    expect(screen.queryByText("Old card")).toBeNull();
    expect(screen.queryByText("Skill card")).toBeNull();
    act(() => useAreas.getState().choose(BOARD_WS, null));
    await screen.findByText("Old card");
    expect(screen.getByText("Skill card")).toBeTruthy();
  });

  it("Archived holds the area's archived cards only", async () => {
    const archived = (title: string, id: string | null) =>
      withArea(boardCard(title, { archived: true, archivedAt: Date.now() }), id);
    seed("site", [withArea(boardCard("Pricing page"), "site"), archived("Old site card", "site"), archived("Old app card", "app")]);
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { areas_get: view([APP, SITE]) } });
    r.tauri.allowUnhandled();
    await screen.findByRole("heading", { name: "Board · Site" });
    const toggle = screen.getByRole("button", { name: /Archived/ });
    expect(toggle.textContent).toContain("1");
    fireEvent.click(toggle);
    await screen.findByText("Old site card");
    expect(screen.queryByText("Old app card")).toBeNull();
  });

  it("a new card made while Site is current is Site's (B3's addCard)", async () => {
    seed("site", []);
    const r = renderUi(<AreaPicker workspaceId={BOARD_WS} />, {
      fixtures: {
        areas_get: view([APP, SITE]),
        kanban_card_create: (args: Record<string, unknown>) =>
          boardCard(String(args.cardId), { title: String(args.title), area: (args.area as string) ?? null }),
      },
    });
    r.tauri.allowUnhandled();
    await trigger(/^Area: Site/);
    await act(async () => {
      await useKanban.getState().addCard(BOARD_WS, "Glossary links");
    });
    act(() => useAreas.getState().choose(BOARD_WS, null));
    await act(async () => {
      await useKanban.getState().addCard(BOARD_WS, "Anywhere");
    });
    expect(r.tauri.callsOf("kanban_card_create").map((c) => c.args.area)).toEqual(["site", null]);
  });

  // 1.174.0 (C3, AR-3; card-page.html §2f): New card on All areas asks its
  // area, already chosen: this Mac's default, then the last one used.
  it("on All areas, New card's Area starts on this Mac's default, then on the last used; on Site it isn't asked", async () => {
    try {
      window.localStorage.removeItem(`plyloft.newCardArea.${BOARD_WS}`);
    } catch {
      /* no storage: the test still holds */
    }
    seed("site", []);
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: {
        areas_get: view([APP, SITE]),
        kanban_card_create: (args: Record<string, unknown>) =>
          boardCard(String(args.cardId), { title: String(args.title), area: (args.area as string) ?? null }),
      },
    });
    r.tauri.allowUnhandled();
    await screen.findByRole("heading", { name: "Board · Site" });
    expect(document.querySelector("[data-ply-new-card-area]")).toBeNull();
    act(() => useAreas.getState().choose(BOARD_WS, null));
    await screen.findByRole("heading", { name: "Board" });
    const pick = () => document.querySelector<HTMLElement>("[data-ply-new-card-area]")!;
    await waitFor(() => expect(pick()).not.toBeNull());
    const field = within(pick()).getByRole("combobox", { name: "Area" }) as HTMLSelectElement;
    expect(field.value).toBe("site");
    expect(pick().textContent).toContain("this Mac's default");
    fireEvent.change(field, { target: { value: "app" } });
    expect(pick().textContent).not.toContain("this Mac's default");
    const hero = screen.getByRole("textbox", { name: "What do you want to build?" });
    fireEvent.change(hero, { target: { value: "Glossary links" } });
    fireEvent.click(screen.getByRole("button", { name: /Make the card/ }));
    await waitFor(() => expect(r.tauri.callsOf("kanban_card_create")).toHaveLength(1));
    expect(r.tauri.callsOf("kanban_card_create")[0].args.area).toBe("app");
    // Without a default, the next one starts on the last used.
    r.unmount();
    seed(null, []);
    const again = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { areas_get: view([APP, SITE]) } });
    again.tauri.allowUnhandled();
    await waitFor(() => expect(document.querySelector("[data-ply-new-card-area]")).not.toBeNull());
    expect((within(pick()).getByRole("combobox", { name: "Area" }) as HTMLSelectElement).value).toBe("app");
    expect(pick().textContent).toContain("last used");
  });

  it("held: the problem line, no picker, no filter", async () => {
    seed("site", [boardCard("Old card")]);
    const held = view([], { held: true, problem: "Two areas use the folder site/." });
    const r = renderUi(
      <>
        <AreaPicker workspaceId={BOARD_WS} />
        <KanbanBoard workspaceId={BOARD_WS} />
      </>,
      { fixtures: { areas_get: held } },
    );
    r.tauri.allowUnhandled();
    const line = await screen.findByText(
      "This repository's areas can't be used: Two areas use the folder site/. Fix them in Settings › Project › Areas.",
    );
    expect(line.closest("[data-ply-area-problem]")?.getAttribute("data-ply-area-problem")).toBe("held");
    expect(screen.queryByRole("button", { name: /^Area:/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "Board" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fix them" }));
    expect(useUi.getState().settingsSection).toBe("areas");
  });

  it("kept: the problem line says this Mac keeps the last good areas, and the picker stays", async () => {
    seed("site", []);
    const kept = view([APP, SITE], { problem: "“all” is a name Plyloft keeps for itself" });
    const r = renderUi(
      <>
        <AreaPicker workspaceId={BOARD_WS} />
        <KanbanBoard workspaceId={BOARD_WS} />
      </>,
      { fixtures: { areas_get: kept } },
    );
    r.tauri.allowUnhandled();
    await screen.findByText(/This Mac keeps using the last good ones/);
    expect(screen.getByRole("button", { name: /^Area: Site/ })).toBeTruthy();
  });
});

// C1 (scene 2): a GitHub Issues board on an area names the label its cards
// come with; on All areas the line is as it was.
describe("the GitHub board's source line on an area", () => {
  const empty = { created: 0, patched: 0, missing: [], prunedWorktrees: 0, trashFreedBytes: 0 };
  function seedGithub(defaultArea: string | null) {
    act(() => {
      seedBoard([withArea(boardCard("Pricing page"), "site")], defaultArea ? { defaultArea } : {});
      useWorkspaces.setState((s) => ({
        workspaces: s.workspaces.map((w) =>
          w.id === BOARD_WS ? { ...w, kanbanSyncMode: "githubIssues" as const, githubOwnerRepo: "MatteoB-adv/lyra-jun-2025" } : w,
        ),
      }));
      setTeamAllowed(true);
    });
  }
  const words = () => (document.querySelector("[data-ply-board-source]")?.textContent ?? "").replace(/\s+/g, " ");

  it("on Site: …labeled area:site; on All areas: no label", async () => {
    seedGithub("site");
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { areas_get: view([APP, SITE]), kanban_github_reconcile: () => empty, kanban_github_refresh: () => empty },
    });
    r.tauri.allowUnhandled();
    await waitFor(() =>
      expect(words()).toBe(
        "Cards come from the GitHub issues of MatteoB-adv/lyra-jun-2025 labeled area:site · read just now · Get new issues",
      ),
    );
    act(() => useAreas.getState().choose(BOARD_WS, null));
    await waitFor(() => expect(words()).toMatch(/^Cards come from the GitHub issues of MatteoB-adv\/lyra-jun-2025 · /));
  });

  it("an area's own label is the one named", async () => {
    seedGithub("site");
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { areas_get: view([APP, { ...SITE, label: "website" }]), kanban_github_reconcile: () => empty },
    });
    r.tauri.allowUnhandled();
    await waitFor(() => expect(words()).toContain("MatteoB-adv/lyra-jun-2025 labeled website ·"));
  });
});

describe("the two-products notice (scene 1)", () => {
  it("says what Plyloft saw, Set up areas… leaves the suggestion for Settings › Areas, Don't ask again hides it for good", async () => {
    seed();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { areas_get: view([]), areas_discover: LYRA, workspace_dismiss_area_notice: null },
    });
    r.tauri.allowUnhandled();
    const notice = await screen.findByRole("region", { name: "Products in this repository" });
    // Scene 1: only the kinds in bold.
    expect([...notice.querySelectorAll("strong")].map((b) => b.textContent)).toEqual(["the app", "a site"]);
    expect(notice.textContent).toContain(
      "This repository seems to hold two products: the app (the root) and a site (lyrappc-astro/).",
    );
    expect(notice.textContent).toContain("Areas keep them apart");
    fireEvent.click(within(notice).getByRole("button", { name: "Set up areas…" }));
    expect(useUi.getState().settingsSection).toBe("areas");
    expect(useAreas.getState().takeSuggestion(BOARD_WS)).toEqual(LYRA.suggestion);
    expect(useAreas.getState().takeSuggestion(BOARD_WS)).toBeNull();

    // C7 (BCI-3): the press says what it does.
    fireEvent.click(within(notice).getByRole("button", { name: "Don't ask again" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Products in this repository" })).toBeNull());
    expect(r.tauri.callsOf("workspace_dismiss_area_notice")).toEqual([
      { cmd: "workspace_dismiss_area_notice", args: { id: BOARD_WS } },
    ]);
  });

  it("Don't ask again that isn't saved: the note stays, and the toast names the press (TX6 E12)", async () => {
    seed();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: {
        areas_get: view([]),
        areas_discover: LYRA,
        workspace_dismiss_area_notice: () => Promise.reject("disk full"),
      },
    });
    r.tauri.allowUnhandled();
    const notice = await screen.findByRole("region", { name: "Products in this repository" });
    fireEvent.click(within(notice).getByRole("button", { name: "Don't ask again" }));
    await waitFor(() => expect(useToasts.getState().toasts.slice(-1)[0]?.title).toBe("“Don't ask again” wasn't saved"));
    expect(screen.getByRole("region", { name: "Products in this repository" })).toBeTruthy();
  });

  // 1.174.0 (C10, D6 §3): also where nothing is shared — the areas stay on
  // this Mac until the setup is, and the notice says so.
  it("shows where nothing is shared too, saying where the areas will stay", async () => {
    seed();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { areas_get: view([], { shared: false }), areas_discover: LYRA },
    });
    r.tauri.allowUnhandled();
    const notice = await screen.findByRole("region", { name: "Products in this repository" });
    expect(notice.textContent).toContain("Areas keep them apart");
    expect(notice.textContent).toContain("They're kept on this Mac only.");
    expect(within(notice).getByRole("button", { name: "Set up areas…" })).toBeTruthy();
  });

  it("where sharing is possible, says the areas stay until the setup is shared", async () => {
    seed();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: {
        areas_get: view([], { shared: false }),
        areas_discover: LYRA,
        workspace_adoption_status: { githubRepo: "o/lyra", hasDefinition: false, action: { kind: "ask" } },
      },
    });
    r.tauri.allowUnhandled();
    // The Share question comes first in the slot; the areas' note is behind it.
    fireEvent.click(await screen.findByRole("button", { name: "Show" }));
    const notice = await screen.findByRole("region", { name: "Products in this repository" });
    await waitFor(() =>
      expect(notice.textContent).toContain("They're kept on this Mac until you share this project's setup."),
    );
  });

  // §4a: the Share question names the areas kept here, which its commit takes.
  it("the Share question says it also shares the areas kept on this Mac", async () => {
    seed();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: {
        areas_get: view([APP, SITE], { shared: false, keptHere: true }),
        areas_discover: null,
        workspace_adoption_status: { githubRepo: "o/lyra", hasDefinition: false, action: { kind: "ask" } },
      },
    });
    r.tauri.allowUnhandled();
    const question = await screen.findByRole("region", { name: /Share this workspace's setup/ });
    await waitFor(() => expect(question.textContent).toContain("Also shares the areas kept on this Mac: App, Site."));
  });

  it("is not looked for where Set up areas… can't save: read-only", async () => {
    for (const extra of [{ readOnly: true }]) {
      act(() => useAreas.setState({ views: {}, discoveries: {} }));
      seed();
      const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
        fixtures: { areas_get: view([], extra), areas_discover: LYRA },
      });
      r.tauri.allowUnhandled();
      await waitFor(() => expect(useAreas.getState().views[BOARD_WS]).toBeDefined());
      expect(screen.queryByRole("region", { name: "Products in this repository" })).toBeNull();
      expect(r.tauri.callsOf("areas_discover")).toHaveLength(0);
      r.unmount();
    }
  });

  it("is not looked for once answered, nor shown in a repository with areas or one product", async () => {
    act(() => seedBoard([], { areaNoticeDismissed: true }));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { areas_get: view([]), areas_discover: LYRA },
    });
    r.tauri.allowUnhandled();
    await waitFor(() => expect(r.tauri.callsOf("areas_get")).toHaveLength(1));
    await waitFor(() => expect(useAreas.getState().views[BOARD_WS]).toBeDefined());
    expect(r.tauri.callsOf("areas_discover")).toHaveLength(0);
    r.unmount();

    act(() => useAreas.setState({ views: {}, discoveries: {} }));
    seed();
    const withAreas = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { areas_get: view([APP, SITE]), areas_discover: LYRA },
    });
    withAreas.tauri.allowUnhandled();
    await screen.findByRole("heading", { name: "Board" });
    await waitFor(() => expect(useAreas.getState().views[BOARD_WS]).toBeDefined());
    expect(screen.queryByRole("region", { name: "Products in this repository" })).toBeNull();
    expect(withAreas.tauri.callsOf("areas_discover")).toHaveLength(0);
  });
});

// 1.174.0 (C10, D6 §4b; owner's answer 12): the setup came in with other
// areas than the ones kept on this Mac.
describe("the repository already has areas", () => {
  const MINE = [area("app", "App", "staging", true), { ...area("site", "Site", "main"), path: "site" }];
  const WEB = { ...area("web", "Web", "main"), path: "web" };

  function board(extra: Partial<AreasView> = {}) {
    seed();
    act(() => useUi.setState({ centerMode: { [BOARD_WS]: "board" } }));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: {
        areas_get: view([{ ...APP, targetBranch: "staging" }, WEB], { setAside: MINE, ...extra }),
        areas_discover: null,
        areas_answer_set_aside: null,
      },
    });
    r.tauri.allowUnhandled();
    return r;
  }

  it("asks in one sheet, its focus on Use the repository's, which writes nothing", async () => {
    const r = board();
    const sheet = await screen.findByRole("dialog", { name: "The repository already has areas" });
    expect(sheet.textContent).toContain(
      "On GitHub: App (cards go to staging) and Web (web/). Kept on this Mac: App and Site (site/).",
    );
    expect(sheet.textContent).toContain("your App and Site are set aside on this Mac, not deleted.");
    const safe = within(sheet).getByRole("button", { name: "Use the repository's" });
    await waitFor(() => expect(document.activeElement).toBe(safe));
    expect(safe.className).toContain("cbtn--accent");
    expect(within(sheet).getByRole("button", { name: "Publish mine" }).className).not.toContain("cbtn--accent");
    fireEvent.click(safe);
    await waitFor(() =>
      expect(r.tauri.callsOf("areas_answer_set_aside")).toEqual([
        { cmd: "areas_answer_set_aside", args: { workspaceId: BOARD_WS, publishMine: false } },
      ]),
    );
  });

  it("Publish mine is the other answer; a read-only computer isn't offered it", async () => {
    const r = board();
    const sheet = await screen.findByRole("dialog", { name: "The repository already has areas" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Publish mine" }));
    await waitFor(() =>
      expect(r.tauri.callsOf("areas_answer_set_aside")[0]?.args).toEqual({ workspaceId: BOARD_WS, publishMine: true }),
    );
    r.unmount();
    act(() => useAreas.setState({ views: {}, discoveries: {} }));
    board({ readOnly: true });
    const again = await screen.findByRole("dialog", { name: "The repository already has areas" });
    expect(within(again).queryByRole("button", { name: "Publish mine" })).toBeNull();
  });

  it("only over the Board on screen; Esc leaves the question for the next time the Board shows", async () => {
    board();
    const name = "The repository already has areas";
    const sheet = await screen.findByRole("dialog", { name });
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());
    // Away from the Board and back: it asks again.
    act(() => useUi.setState({ centerMode: { [BOARD_WS]: "terminals" } }));
    act(() => useUi.setState({ centerMode: { [BOARD_WS]: "board" } }));
    expect(await screen.findByRole("dialog", { name })).toBeTruthy();
    // Not under Settings, the palette or Release.
    act(() => useUi.setState({ settingsOverlayOpen: true }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());
    act(() => useUi.setState({ settingsOverlayOpen: false }));
    expect(await screen.findByRole("dialog", { name })).toBeTruthy();
    act(() => useUi.setState({ releaseSheet: { workspaceId: BOARD_WS } }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());
    act(() => useUi.setState({ releaseSheet: null }));
    act(() => useAreas.setState({ views: {}, discoveries: {} }));
  });

  it("the repository's setup with no areas, or a list that can't be used, has its own title", async () => {
    let r = board({ areas: [], defined: [] });
    let sheet = await screen.findByRole("dialog", { name: "The repository's setup has no areas" });
    expect(sheet.textContent).toContain("On GitHub: no areas. Kept on this Mac: App and Site (site/).");
    r.unmount();
    act(() => useAreas.setState({ views: {}, discoveries: {} }));
    r = board({ areas: [], defined: [], problem: "Two areas are called “app”", held: true });
    sheet = await screen.findByRole("dialog", { name: "The repository's areas can't be used" });
    expect(sheet.textContent).toContain("On GitHub the areas list can't be read. Kept on this Mac: App and Site (site/).");
    r.unmount();
    act(() => useAreas.setState({ views: {}, discoveries: {} }));
  });

  it("read-only: only the answer it has, said alone", async () => {
    board({ readOnly: true });
    const sheet = await screen.findByRole("dialog", { name: "The repository already has areas" });
    expect(sheet.textContent).toContain("not deleted.");
    expect(sheet.textContent).not.toContain("Publish mine");
    act(() => useAreas.setState({ views: {}, discoveries: {} }));
  });

  it("on Windows says this PC", async () => {
    setPlatformForTests("windows");
    try {
      board();
      const sheet = await screen.findByRole("dialog", { name: "The repository already has areas" });
      expect(sheet.textContent).toContain("Kept on this PC: App and Site (site/).");
      expect(sheet.textContent).toContain("set aside on this PC, not deleted.");
      expect(sheet.textContent).not.toContain("this Mac");
    } finally {
      setPlatformForTests(null);
      act(() => useAreas.setState({ views: {}, discoveries: {} }));
    }
  });
});

describe("a new copy starts from the area's branch", () => {
  const env = { claudePath: "/usr/local/bin/claude", codexPath: null } as ShellEnvInfo;

  it("asks where it would start, and makes it, from Site's branch", async () => {
    seed("site");
    const r = renderUi(<NewCopySheet workspaceId={BOARD_WS} env={env} provider="shell" onClose={() => {}} />, {
      fixtures: {
        areas_get: view([APP, SITE]),
        copy_start_point: (args: Record<string, unknown>) => ({
          target: args.target ?? "staging",
          fromGitHub: false,
          readAt: null,
        }),
      },
    });
    r.tauri.allowUnhandled();
    await waitFor(() =>
      expect(r.tauri.callsOf("copy_start_point").map((c) => c.args.target)).toContain("main"),
    );
  });
});
