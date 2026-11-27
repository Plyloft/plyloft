// UX-3.3: the sidebar's workspace switcher (the Shell board, the
// WorkspaceSwitcher spec). It names the current workspace; its popover
// switches (recent first), searches when there are more than five, and removes
// a workspace only from its ⋯ and only after a confirmation.
import { describe, expect, it } from "vitest";
import { WorkspaceSidebar } from "../components/WorkspaceSidebar";
import { WorkspaceIconPicker } from "../components/WorkspaceIconPicker";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useTiles } from "../store/tileStore";
import { useKanban } from "../store/kanbanStore";
import { boardCard } from "./boardFixtures";
import { effectiveCenterMode, useUi } from "../store/uiStore";
import { act, nextFrame, renderUi, screen, tauri, waitFor, within } from "./render";
import { setPlatformForTests } from "../lib/platform";

function ws(id: string, name: string, lastOpenedAt: number): Workspace {
  return {
    id,
    name,
    cwd: `/Users/someone/code/${name}`,
    createdAt: 1,
    lastOpenedAt,
    openFiles: [],
    activeFile: null,
  };
}

async function renderWith(workspaces: Workspace[], activeId: string) {
  tauri().allowUnhandled();
  tauri().fixture("drain_status", { draining: false, startedAt: null });
  tauri().fixture("ship_pending_count", 0);
  tauri().fixture("ship_pending_cards", null);
  tauri().fixture("ship_unverified_count", 0);
  act(() => {
    useWorkspaces.setState({ workspaces, activeId });
  });
  const r = renderUi(<WorkspaceSidebar env={null} />);
  await nextFrame();
  return r;
}

async function open(r: Awaited<ReturnType<typeof renderWith>>) {
  await r.user.click(screen.getByRole("button", { name: /switch workspace/ }));
  await nextFrame();
  return screen.getByRole("dialog", { name: "Workspaces" });
}

describe("the workspace switcher", () => {
  it("names the current workspace and lists the others, most recent first", async () => {
    const r = await renderWith(
      [ws("a", "alpha", 10), ws("b", "beta", 30), ws("c", "gamma", 20)],
      "a",
    );
    expect(screen.getByRole("button", { name: "alpha, switch workspace" })).toBeTruthy();
    // The sidebar no longer lists every workspace.
    expect(screen.queryByRole("button", { name: "beta" })).toBeNull();

    const pop = await open(r);
    const names = within(pop)
      .getAllByRole("button")
      .filter((b) => b.classList.contains("shell-switcher-item") && !b.classList.contains("shell-switcher-new"))
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["beta", "gamma", "alpha"]);
    // No search field with only three.
    expect(within(pop).queryByRole("textbox", { name: "Find a workspace" })).toBeNull();
  });

  it("switches on a click and closes", async () => {
    const r = await renderWith([ws("a", "alpha", 10), ws("b", "beta", 30)], "a");
    const pop = await open(r);
    await r.user.click(within(pop).getByRole("button", { name: "beta" }));
    expect(useWorkspaces.getState().activeId).toBe("b");
    expect(screen.queryByRole("dialog", { name: "Workspaces" })).toBeNull();
  });

  it("opens a workspace with no mode chosen on the Inbox (UX-4.3)", async () => {
    const r = await renderWith([ws("a", "alpha", 10), ws("b", "beta", 30), ws("c", "gamma", 20)], "a");
    // gamma was left on the Inbox by an earlier choice; beta was never opened.
    act(() => useUi.getState().setCenterMode("c", "inbox"));
    await r.user.click(within(await open(r)).getByRole("button", { name: "beta" }));
    expect(effectiveCenterMode(useUi.getState().centerMode, "b")).toBe("inbox");
    // Choosing one parked on a global view asks for its content: its Board.
    await r.user.click(within(await open(r)).getByRole("button", { name: "gamma" }));
    expect(useUi.getState().centerMode.c).toBe("board");
  });

  it("offers a search field past five workspaces; Enter opens the first match", async () => {
    const names = ["alpha", "beta", "gamma", "delta", "epsilon", "lyra"];
    const r = await renderWith(
      names.map((n, i) => ws(n, n, i)),
      "alpha",
    );
    const pop = await open(r);
    const field = within(pop).getByRole("textbox", { name: "Find a workspace" });
    expect(document.activeElement).toBe(field);
    await r.user.type(field, "ly");
    const rows = within(pop)
      .getAllByRole("button")
      .filter((b) => b.classList.contains("shell-switcher-item") && !b.classList.contains("shell-switcher-new"));
    expect(rows.map((b) => b.getAttribute("aria-label"))).toEqual(["lyra"]);
    await r.user.keyboard("{Enter}");
    expect(useWorkspaces.getState().activeId).toBe("lyra");
  });

  it("removes a workspace only from its ⋯, after a confirmation", async () => {
    const r = await renderWith([ws("a", "alpha", 10), ws("b", "beta", 30)], "a");
    tauri().fixture("workspace_delete", null);
    tauri().fixture("workspace_list", { workspaces: [ws("a", "alpha", 10)], activeId: "a" });
    tauri().fixture("workspace_cwd_exists", true);
    const pop = await open(r);
    await r.user.click(within(pop).getByRole("button", { name: "More for beta" }));
    await r.user.click(screen.getByRole("menuitem", { name: "Remove…" }));
    expect(tauri().callsOf("workspace_delete")).toHaveLength(0);
    // GH #320: it says what leaves, not "the sidebar", with no straight quotes.
    const sheet = screen.getByRole("dialog", { name: "Remove beta from Plyloft?" });
    expect(sheet.textContent).toContain("Its board and sessions leave Plyloft. The folder on disk stays as it is.");
    expect(sheet.textContent).not.toMatch(/sidebar|"/);
    await r.user.click(screen.getByRole("button", { name: "Remove" }));
    expect(tauri().callsOf("workspace_delete")).toEqual([
      { cmd: "workspace_delete", args: { id: "b" } },
    ]);
  });

  // Owner decision 2026-09-30: the destructive sheet opens on Cancel.
  it("opens the remove sheet with focus on Cancel, so Enter removes nothing", async () => {
    const r = await renderWith([ws("a", "alpha", 10), ws("b", "beta", 30)], "a");
    tauri().fixture("workspace_delete", null);
    const pop = await open(r);
    await r.user.click(within(pop).getByRole("button", { name: "More for beta" }));
    await r.user.click(screen.getByRole("menuitem", { name: "Remove…" }));
    const sheet = screen.getByRole("dialog", { name: "Remove beta from Plyloft?" });
    const cancel = within(sheet).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    await r.user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog", { name: "Remove beta from Plyloft?" })).toBeNull();
    expect(tauri().callsOf("workspace_delete")).toHaveLength(0);
  });

  // GH #287: a failure is said where it happened.
  it("keeps a refused remove's sheet up with the reason", async () => {
    const r = await renderWith([ws("a", "alpha", 10), ws("b", "beta", 30)], "a");
    tauri().fixture("workspace_delete", () => {
      throw new Error("workspace is busy");
    });
    const pop = await open(r);
    await r.user.click(within(pop).getByRole("button", { name: "More for beta" }));
    await r.user.click(screen.getByRole("menuitem", { name: "Remove…" }));
    await r.user.click(screen.getByRole("button", { name: "Remove" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't remove it: workspace is busy");
    expect(screen.getByRole("dialog", { name: "Remove beta from Plyloft?" })).toBeTruthy();
  });

  it("keeps the rename field open with the reason when a rename fails", async () => {
    const r = await renderWith([ws("a", "alpha", 10), ws("b", "beta", 30)], "a");
    tauri().fixture("workspace_rename", () => {
      throw new Error("name taken");
    });
    const pop = await open(r);
    await r.user.click(within(pop).getByRole("button", { name: "More for beta" }));
    await r.user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = screen.getByRole("textbox", { name: "Rename beta" });
    await r.user.clear(field);
    await r.user.type(field, "gamma{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't rename it: name taken");
    expect((screen.getByRole("textbox", { name: "Rename beta" }) as HTMLInputElement).value).toBe("gamma");
  });

  it("says in the picker when a colour change fails", async () => {
    const r = renderUi(
      <WorkspaceIconPicker
        workspaceId="a"
        name="alpha"
        icon={null}
        accentColor={null}
        anchor={{ left: 0, top: 0, bottom: 0 }}
        onClose={() => {}}
        onAccentChange={() => Promise.reject(new Error("disk full"))}
      />,
    );
    await r.user.click(screen.getByRole("radio", { name: "Violet" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't change the colour.");
    // UX P-D2: the error's own text is behind Details.
    expect(alert.textContent).toContain("disk full");
  });

  // GH #289: the picker is on the one scale — sentence-case captions, the
  // ux Swatches, CBtn buttons.
  it("draws the icon and colour picker on the one scale", async () => {
    renderUi(
      <WorkspaceIconPicker
        workspaceId="a"
        name="alpha"
        icon={null}
        accentColor="#7c3aed"
        anchor={{ left: 0, top: 0, bottom: 0 }}
        onClose={() => {}}
        onAccentChange={() => {}}
      />,
    );
    const pop = screen.getByRole("dialog", { name: "Icon and colour for alpha" });
    expect(pop.classList.contains("ux-popover")).toBe(true);
    const captions = [...pop.querySelectorAll(".ux-icon-picker-caption")].map((c) => c.textContent);
    expect(captions).toEqual(["Colour", "Emoji", "Image"]);
    expect(within(pop).getByRole("radio", { name: "Violet" }).getAttribute("aria-checked")).toBe("true");
    for (const b of within(pop).getAllByRole("button")) {
      expect(b.classList.contains("cbtn")).toBe(true);
    }
    expect(pop.textContent).not.toMatch(/COLOR|EMOJI|IMAGE|\bauto\b/);
    expect(pop.querySelector("[class*='ws-icon-picker']")).toBeNull();
  });

  // GH #293: a session row says its state in words, as its tile header does.
  it("names each live session's state, Ready sessions without the running dot", async () => {
    const now = Date.now();
    const tile = (id: string, label: string, extra: Record<string, unknown>) => ({
      id,
      kind: "claude",
      label,
      cwd: "/x",
      startedAt: now - 60 * 60_000,
      status: "running",
      pendingClose: false,
      expanded: false,
      ...extra,
    });
    act(() =>
      useTiles.setState({
        byWorkspace: {
          a: {
            tiles: [
              tile("t1", "claude 1", {
                readiness: { lastOutputAt: now - 5_000, matcherIdle: true, leftReadyAt: now - 60 * 60_000 },
              }),
              tile("t2", "codex chat 1", { kind: "codex-chat", sessionBusy: false }),
            ] as never,
            expandedTileId: null,
            detailTileId: null,
          },
        },
      }),
    );
    await renderWith([ws("a", "alpha", 10)], "a");
    const ready = screen.getByRole("button", { name: "claude 1, your turn" });
    expect(ready.querySelector(".shell-dot--empty")).toBeTruthy();
    expect(ready.getAttribute("title")).toContain("claude 1 — your turn");
    expect(screen.getByRole("button", { name: "codex chat 1, your turn" })).toBeTruthy();
    expect(document.querySelector(".shell-sessions .shell-dot--running")).toBeNull();
  });
  // E4 (owner, 2026-10-28): a session that asks is its amber dot and its
  // second line in words — no edge on the row; only the session open in the
  // centre has a highlight (aria-current), the neutral selected wash.
  it("says a session asks by its dot and words, and marks only the open session", async () => {
    const now = Date.now();
    const tile = (id: string, label: string, extra: Record<string, unknown>) => ({
      id,
      kind: "claude",
      label,
      cwd: "/x",
      startedAt: now - 60_000,
      status: "running",
      pendingClose: false,
      expanded: false,
      ...extra,
    });
    act(() => {
      useTiles.setState({
        byWorkspace: {
          a: {
            tiles: [tile("t1", "claude 1", { question: "decision" }), tile("t2", "claude 2", {})] as never,
            expandedTileId: "t2",
            detailTileId: null,
          },
        },
      });
      useUi.setState({ centerMode: { a: "terminals" } });
    });
    await renderWith([ws("a", "alpha", 10)], "a");
    const asks = document.querySelector(".shell-sessions .shell-session--asks")!;
    expect(asks).toBeTruthy();
    expect(asks.querySelector(".shell-dot--warn")).toBeTruthy();
    expect(asks.querySelector(".shell-session-state")!.textContent).toMatch(/asks you something/);
    expect(asks.classList.contains("is-selected")).toBe(false);
    const current = document.querySelectorAll(".shell-sessions [aria-current]");
    expect(current).toHaveLength(1);
    expect(current[0].classList.contains("is-selected")).toBe(true);
    expect(current[0].textContent).toContain("claude 2");
  });
  // E4: on the Board, the open card's Builder row is the current one; the
  // same card selected while the centre shows another mode marks no row.
  for (const [mode, current] of [["board", true], ["terminals", false], ["inbox", false]] as const) {
    it(`marks the open card's Builder row only on the Board (${mode})`, async () => {
      const card = (id: string, title: string) => ({
        ...boardCard(id, {
          title,
          columnId: "in_progress",
          lastRunStatus: "running",
          builder: { vendor: "claude", bypass: false, ptyId: `pty-${id}`, sessionLost: false, startedAt: Date.now() - 60_000, snapshots: [] },
        }),
        workspaceId: "a",
      });
      act(() => {
        useTiles.setState({ byWorkspace: {} });
        useKanban.setState({ byWorkspace: { a: { cards: [card("x", "open one"), card("y", "other one")], loaded: true } } } as never);
        useUi.setState({ centerMode: { a: mode }, selectedCardId: { a: "x" } });
      });
      await renderWith([ws("a", "alpha", 10)], "a");
      const rows = document.querySelectorAll(".shell-sessions .shell-session--builder");
      expect(rows).toHaveLength(2);
      const marked = document.querySelectorAll(".shell-sessions [aria-current]");
      if (current) {
        expect(marked).toHaveLength(1);
        expect(marked[0].textContent).toContain("open one");
        expect(marked[0].classList.contains("is-selected")).toBe(true);
      } else {
        expect(marked).toHaveLength(0);
        expect(document.querySelector(".shell-sessions .is-selected")).toBeNull();
      }
    });
  }
});

// 1.174.0 (TX2, T9; WALK 32; D-T5): a folder line only when two workspaces
// share a name; the accessible name says it too.
describe("two workspaces with the same name", () => {
  const items = (pop: HTMLElement) =>
    within(pop)
      .getAllByRole("button")
      .filter((b) => b.classList.contains("shell-switcher-item") && !b.classList.contains("shell-switcher-new"));

  it("each shows its folder from the home folder; a unique name shows none", async () => {
    const twinA = { ...ws("a", "sandbox monorepo", 30), cwd: "/Users/someone/code/sandbox-monorepo" };
    const twinB = { ...ws("b", "sandbox monorepo", 20), cwd: "/Users/someone/Desktop/sandbox-monorepo" };
    const r = await renderWith([twinA, twinB, ws("c", "lyra", 10)], "c");
    tauri().fixture("plugin:path|resolve_directory", "/Users/someone");
    const pop = await open(r);
    await waitFor(() =>
      expect(items(pop).map((b) => b.getAttribute("aria-label"))).toEqual([
        "sandbox monorepo, in ~/code/sandbox-monorepo",
        "sandbox monorepo, in ~/Desktop/sandbox-monorepo",
        "lyra",
      ]),
    );
    const [a, b, c] = items(pop);
    expect(a.querySelector(".shell-switcher-folder")?.textContent).toBe("~/code/sandbox-monorepo");
    expect(b.querySelector(".shell-switcher-folder")?.textContent).toBe("~/Desktop/sandbox-monorepo");
    expect(c.querySelector(".shell-switcher-folder")).toBeNull();
  });

  it("unique names: no folder line", async () => {
    const r = await renderWith([ws("a", "alpha", 10), ws("b", "beta", 30)], "a");
    const pop = await open(r);
    expect(pop.querySelector(".shell-switcher-folder")).toBeNull();
    expect(items(pop).map((b) => b.getAttribute("aria-label"))).toEqual(["beta", "alpha"]);
  });

  it("on Windows the folder starts from the user folder with backslashes", async () => {
    setPlatformForTests("windows");
    try {
      const twinA = { ...ws("a", "sandbox monorepo", 30), cwd: "C:\\Users\\someone\\code\\sandbox-monorepo" };
      const twinB = { ...ws("b", "sandbox monorepo", 20), cwd: "D:\\work\\sandbox-monorepo" };
      const r = await renderWith([twinA, twinB], "a");
      tauri().fixture("plugin:path|resolve_directory", "C:\\Users\\someone");
      const pop = await open(r);
      await waitFor(() =>
        expect(items(pop).map((b) => b.querySelector(".shell-switcher-folder")?.textContent)).toEqual([
          "…\\code\\sandbox-monorepo",
          "D:\\work\\sandbox-monorepo",
        ]),
      );
    } finally {
      setPlatformForTests(null);
    }
  });
});
