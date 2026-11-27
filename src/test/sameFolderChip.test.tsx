// 1.173.0 (A4): two Claude/Codex terminals in one folder. Each tile's header
// carries "Same folder as <other>", a real button: Tab reaches it, Enter or
// Space opens the popover (mockup copies.html, scene 1), Esc closes it and
// gives focus back. The popover offers a new terminal in a copy (A3's sheet,
// through `openNewCopySheet`) and Show <other>.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SameFolderChip } from "../components/SameFolderChip";
import { Tile as TileView } from "../components/Tile";
import { useTiles, type Tile } from "../store/tileStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useCoordination } from "../store/coordinationStore";
import { onOpenNewCopySheet, type NewCopySheetRequest } from "../lib/newCopySheet";
import { useUi } from "../store/uiStore";
import type { CoordinationLiveWarning, CoordinationSession, WorkspaceCoordinationStatus } from "../ipc";
import { act, fireEvent, renderUi, screen, waitFor, within } from "./render";
import { START_WAIT_MS } from "../components/SameFolderChip";
import { forgetFolderChanges, resetFolderChangesForTests, useFolderChanges } from "../store/folderChanges";
import { useAreas } from "../store/areaStore";
import type { AreasView, ResolvedArea } from "../ipc";

vi.mock("@xterm/xterm", () => {
  const deep = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, prop) => (prop === "dispose" ? () => {} : deep()),
      apply: () => deep(),
    });
  class FakeTerm {
    cols = 100;
    rows = 4;
    options: Record<string, unknown> = {};
    buffer = { active: { baseY: 0, length: 0, getLine: () => ({ translateToString: () => "" }) } };
    constructor() {
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          if (prop === "then") return undefined;
          return deep();
        },
      });
    }
    write(_data: string | Uint8Array, done?: () => void) {
      done?.();
    }
  }
  return { Terminal: FakeTerm };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} proposeDimensions() { return undefined; } } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { dispose() {} onContextLoss() { return { dispose() {} }; } } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { dispose() {} } }));
vi.mock("@xterm/addon-image", () => ({ ImageAddon: class { dispose() {} } }));

const WS = "ws-1";

afterEach(() => {
  act(() => {
    resetFolderChangesForTests();
    useWorkspaces.setState({ workspaces: [] } as Partial<ReturnType<typeof useWorkspaces.getState>>);
    useTiles.setState({ byWorkspace: {} });
    useCoordination.setState({ byWorkspace: {} });
    useAreas.setState({ views: {}, chosen: {} });
  });
});

function session(id: string, ptyId: string, provider: "claude" | "codex", git = true): CoordinationSession {
  return {
    id,
    ptyId,
    runId: null,
    provider,
    executionKind: "provider-tile",
    status: "running",
    project: {
      kind: "project",
      workspaceId: WS,
      git,
      project: { displayPath: "/p/.git", comparisonKey: "/p/.git" },
      worktree: { displayPath: "/p", comparisonKey: "/p" },
      displayCwd: "/p",
    },
  } as unknown as CoordinationSession;
}

/** What the popover reads for where a copy starts: GitHub, main. */
const ON_GITHUB = {
  project_config_get: { targetBranch: "main" },
  project_local_origin: { hasOrigin: true, defaultBranch: "main", githubRepo: "me/app" },
  // E1-7: this Mac's main diverged from GitHub's (1 step of its own), so the
  // popover says what the copy leaves out.
  copy_start_point: { target: "main", fromGitHub: true, localAhead: 1, startsLocal: false },
  // E1-4 (b): git ignores none of the changed files.
  fs_ignored_paths: [],
  // No areas: the copy starts from the workspace's target.
  areas_get: null,
};
const NOTHING = { project_config_get: null, project_local_origin: { hasOrigin: false, defaultBranch: null }, copy_start_point: null, areas_get: null };

/** A Claude tile and a Codex tile in the project folder, both running. */
function seed(): { claude: Tile; codex: Tile; sessions: CoordinationSession[]; warnings: CoordinationLiveWarning[] } {
  act(() => {
    useWorkspaces.setState({ activeId: WS } as Partial<ReturnType<typeof useWorkspaces.getState>>);
    useUi.setState({ centerMode: { [WS]: "terminals" } } as Partial<ReturnType<typeof useUi.getState>>);
    const s = useTiles.getState();
    s.addClaudeTile(WS, "/p");
    s.addCodexTile(WS, "/p");
    const [a, b] = useTiles.getState().byWorkspace[WS].tiles;
    s.setPtyId(a.id, "pty-a");
    s.setPtyId(b.id, "pty-b");
  });
  const [claude, codex] = useTiles.getState().byWorkspace[WS].tiles;
  const sessions = [session("s-a", "pty-a", "claude"), session("s-b", "pty-b", "codex")];
  const warnings: CoordinationLiveWarning[] = [
    { sessionId: "s-a", peerSessionId: "s-b", code: "two-provider-tiles", summary: "Another AI terminal is working in this folder" },
    { sessionId: "s-b", peerSessionId: "s-a", code: "two-provider-tiles", summary: "Another AI terminal is working in this folder" },
  ];
  return { claude, codex, sessions, warnings };
}

describe("Same folder chip (A4)", () => {
  it("is a button named after the other tile, and opens the popover in the mockup's words", async () => {
    const { claude, sessions, warnings } = seed();
    const { user } = renderUi(
      <SameFolderChip tile={claude} session={sessions[0]} hidden={false} warnings={warnings.filter((w) => w.sessionId === "s-a")} sessions={sessions} />,
      { fixtures: ON_GITHUB },
    );
    const chip = screen.getByRole("button", { name: "Same folder as Codex" });
    expect(chip.getAttribute("aria-haspopup")).toBe("dialog");
    expect(chip.getAttribute("aria-expanded")).toBe("false");

    await user.click(chip);
    const dialog = screen.getByRole("dialog", { name: "Same folder as Codex" });
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.textContent).toContain("Claude and Codex are working in the same folder.");
    await waitFor(() =>
      expect(dialog.textContent).toContain(
        "Start the next session in a copy of its own instead. It starts from main on GitHub; changes not yet on GitHub aren't in it.",
      ),
    );
    expect(screen.getByRole("button", { name: "Start a new one in a copy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show Codex" })).toBeTruthy();
    expect(dialog.textContent).toContain("They can change the same files without seeing each other's edits.");
    expect(dialog.textContent).toContain("Then close Claude here: its conversation stays in Resume…");
    expect(dialog.textContent).not.toMatch(/worktree|Overlap/);
    // Focus is in the popover, on its first action.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Start a new one in a copy" }));
  });

  it("opens with Enter and with Space, and Esc closes it and gives focus back", async () => {
    const { claude, sessions, warnings } = seed();
    const { user } = renderUi(
      <SameFolderChip tile={claude} session={sessions[0]} hidden={false} warnings={warnings.slice(0, 1)} sessions={sessions} />,
      { fixtures: NOTHING },
    );
    const chip = screen.getByRole("button", { name: "Same folder as Codex" });
    await user.tab();
    expect(document.activeElement).toBe(chip);

    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(chip);

    await user.keyboard(" ");
    const dialog = screen.getByRole("dialog");
    // No origin and no branch saved: no GitHub claim.
    await waitFor(() => expect(dialog.textContent).toContain("It starts from the project's main branch."));
    expect(dialog.textContent).not.toContain("GitHub");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("Start a new one in a copy asks for A3's sheet with this tile's AI, and closes", async () => {
    const { codex, sessions, warnings } = seed();
    const asked: NewCopySheetRequest[] = [];
    const stop = onOpenNewCopySheet((request) => asked.push(request));
    try {
      const { user } = renderUi(
        <SameFolderChip tile={codex} session={sessions[1]} hidden={false} warnings={warnings.slice(1)} sessions={sessions} />,
        { fixtures: NOTHING },
      );
      await user.click(screen.getByRole("button", { name: "Same folder as Claude" }));
      await user.click(screen.getByRole("button", { name: "Start a new one in a copy" }));
      // E1: who asked rides along, for the toast after the copy.
      expect(asked).toEqual([{ workspaceId: WS, provider: "codex", from: { tileId: codex.id, self: "Codex", peer: "Claude" } }]);
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      stop();
    }
  });

  it("Show <other> brings the other tile forward; with this one filling the grid, the other takes it", async () => {
    const { claude, codex, sessions, warnings } = seed();
    act(() => useTiles.getState().setExpanded(WS, claude.id));
    const { user } = renderUi(
      <SameFolderChip tile={claude} session={sessions[0]} hidden={false} warnings={warnings.slice(0, 1)} sessions={sessions} />,
      { fixtures: NOTHING },
    );
    await user.click(screen.getByRole("button", { name: "Same folder as Codex" }));
    await user.click(screen.getByRole("button", { name: "Show Codex" }));
    expect(useTiles.getState().byWorkspace[WS].expandedTileId).toBe(codex.id);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a peer with a title is named by it; a peer with no tile here has no Show", async () => {
    const { claude, codex, sessions, warnings } = seed();
    act(() => useTiles.getState().setTitleLabel(codex.id, "Tidy the Inbox", "auto"));
    const fresh = useTiles.getState().byWorkspace[WS].tiles.find((t) => t.id === claude.id)!;
    const { user, unmount } = renderUi(
      <SameFolderChip tile={fresh} session={sessions[0]} hidden={false} warnings={warnings.slice(0, 1)} sessions={sessions} />,
      { fixtures: NOTHING },
    );
    expect(screen.getByRole("button", { name: "Same folder as Tidy the Inbox" })).toBeTruthy();
    unmount();

    // A card's Codex session in this folder, with no tile on this page.
    const card = { ...session("s-card", "pty-card", "codex") };
    renderUi(
      <SameFolderChip
        tile={fresh}
        session={sessions[0]}
        hidden={false}
        warnings={[{ sessionId: "s-a", peerSessionId: "s-card", code: "two-provider-tiles", summary: "" }]}
        sessions={[...sessions, card]}
      />,
      { fixtures: NOTHING },
    );
    await user.click(screen.getByRole("button", { name: "Same folder as Codex" }));
    expect(screen.getByRole("button", { name: "Start a new one in a copy" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Show / })).toBeNull();
  });

  it("outside a git project no copy is offered: the risk and Show <other> only", async () => {
    const { claude, warnings } = seed();
    const sessions = [session("s-a", "pty-a", "claude", false), session("s-b", "pty-b", "codex", false)];
    const { user } = renderUi(
      <SameFolderChip tile={claude} session={sessions[0]} hidden={false} warnings={warnings.slice(0, 1)} sessions={sessions} />,
      { fixtures: NOTHING },
    );
    await user.click(screen.getByRole("button", { name: "Same folder as Codex" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Claude and Codex are working in the same folder.");
    expect(dialog.textContent).toContain("They can change the same files without seeing each other's edits.");
    expect(dialog.textContent).not.toMatch(/copy|GitHub|Resume/);
    expect(screen.queryByRole("button", { name: "Start a new one in a copy" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show Codex" }));
  });

  it("an agent run's tile asks for its session's AI, not a shell", async () => {
    const { codex, sessions, warnings } = seed();
    const run = { ...codex, kind: "agent-run" as const, label: "builder" };
    const asked: NewCopySheetRequest[] = [];
    const stop = onOpenNewCopySheet((request) => asked.push(request));
    try {
      const { user } = renderUi(
        <SameFolderChip tile={run} session={sessions[1]} hidden={false} warnings={warnings.slice(1)} sessions={sessions} />,
        { fixtures: NOTHING },
      );
      await user.click(screen.getByRole("button", { name: "Same folder as Claude" }));
      await user.click(screen.getByRole("button", { name: "Start a new one in a copy" }));
      expect(asked).toEqual([{ workspaceId: WS, provider: "codex", from: { tileId: run.id, self: "Builder", peer: "Claude" } }]);
    } finally {
      stop();
    }
  });

  it("closes when its tile leaves the screen: hidden, another workspace, another mode, a resize", async () => {
    const { claude, sessions, warnings } = seed();
    const props = { tile: claude, session: sessions[0], warnings: warnings.slice(0, 1), sessions };
    const { user, rerender } = renderUi(<SameFolderChip {...props} hidden={false} />, { fixtures: NOTHING });
    const chip = () => screen.getByRole("button", { name: "Same folder as Codex" });

    await user.click(chip());
    rerender(<SameFolderChip {...props} hidden={true} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<SameFolderChip {...props} hidden={false} />);

    await user.click(chip());
    act(() => useWorkspaces.setState({ activeId: "ws-2" } as Partial<ReturnType<typeof useWorkspaces.getState>>));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => useWorkspaces.setState({ activeId: WS } as Partial<ReturnType<typeof useWorkspaces.getState>>));

    await user.click(chip());
    act(() => useUi.setState({ centerMode: { [WS]: "board" } } as Partial<ReturnType<typeof useUi.getState>>));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => useUi.setState({ centerMode: { [WS]: "terminals" } } as Partial<ReturnType<typeof useUi.getState>>));

    await user.click(chip());
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a scroll elsewhere (a Codex chat's transcript) leaves it open; a scroll around the tile closes it", async () => {
    const { claude, sessions, warnings } = seed();
    const { user } = renderUi(
      <>
        <div data-testid="grid">
          <SameFolderChip tile={claude} session={sessions[0]} hidden={false} warnings={warnings.slice(0, 1)} sessions={sessions} />
        </div>
        <div data-testid="transcript" />
      </>,
      { fixtures: NOTHING },
    );
    await user.click(screen.getByRole("button", { name: "Same folder as Codex" }));
    await screen.findByRole("dialog");
    fireEvent.scroll(screen.getByTestId("transcript"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.scroll(screen.getByTestId("grid"));
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Same folder as Codex" }));
    await screen.findByRole("dialog");
    fireEvent.scroll(document);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays invisible until it knows where the copy starts, so its sentence never changes on screen", async () => {
    const { claude, sessions, warnings } = seed();
    let answer: (v: unknown) => void = () => {};
    const { user } = renderUi(
      <SameFolderChip tile={claude} session={sessions[0]} hidden={false} warnings={warnings.slice(0, 1)} sessions={sessions} />,
      {
        fixtures: {
          project_config_get: { targetBranch: "main" },
          project_local_origin: () => new Promise((resolve) => (answer = resolve)),
          copy_start_point: { target: "main", fromGitHub: true, localAhead: 0 },
          areas_get: null,
        },
      },
    );
    await user.click(screen.getByRole("button", { name: "Same folder as Codex" }));
    const pop = document.querySelector<HTMLElement>(".tile-folder-pop")!;
    expect(pop.style.visibility).toBe("hidden");
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => answer({ hasOrigin: true, defaultBranch: "main", githubRepo: "me/app" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("It starts from main on GitHub");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Start a new one in a copy" }));
  });

  it("a read that never answers shows it anyway after a short wait, without a GitHub claim", async () => {
    const { claude, sessions, warnings } = seed();
    const { user } = renderUi(
      <SameFolderChip tile={claude} session={sessions[0]} hidden={false} warnings={warnings.slice(0, 1)} sessions={sessions} />,
      {
        fixtures: {
          project_config_get: () => new Promise(() => {}),
          project_local_origin: () => new Promise(() => {}),
          copy_start_point: () => new Promise(() => {}),
          areas_get: null,
        },
      },
    );
    await user.click(screen.getByRole("button", { name: "Same folder as Codex" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const dialog = await screen.findByRole("dialog", {}, { timeout: START_WAIT_MS + 1000 });
    expect(dialog.textContent).toContain("It starts from the project's main branch.");
    expect(dialog.textContent).not.toContain("GitHub");
  });

  it("only a host's own workspace answers: the helper hands each request to every host to filter", () => {
    const mine: NewCopySheetRequest[] = [];
    const stop = onOpenNewCopySheet((request) => {
      if (request.workspaceId === WS) mine.push(request);
    });
    try {
      window.dispatchEvent(new CustomEvent("ply:open-new-copy", { detail: { workspaceId: "ws-2", provider: "claude" } }));
      window.dispatchEvent(new CustomEvent("ply:open-new-copy", { detail: { workspaceId: WS, provider: "codex" } }));
    } finally {
      stop();
    }
    window.dispatchEvent(new CustomEvent("ply:open-new-copy", { detail: { workspaceId: WS, provider: "shell" } }));
    expect(mine).toEqual([{ workspaceId: WS, provider: "codex" }]);
  });

  it("the tile header carries the chip only while the coordination status warns about it", () => {
    const { claude, sessions, warnings } = seed();
    const status = (live: CoordinationLiveWarning[]): WorkspaceCoordinationStatus => ({
      trackingActive: true,
      state: "active",
      workspaceId: WS,
      activeSessions: sessions,
      liveWarnings: live,
      recentInterruptedCount: 0,
    });
    act(() =>
      useCoordination.setState({
        byWorkspace: { [WS]: { status: status(warnings), loading: false, error: null } },
      }),
    );
    const tile = useTiles.getState().byWorkspace[WS].tiles.find((t) => t.id === claude.id)!;
    const { tauri } = renderUi(<TileView tile={tile} env={null} workspaceCwd="/p" hidden={false} />);
    // The terminal itself is not what this test looks at.
    tauri.allowUnhandled();
    expect(screen.getByRole("button", { name: "Same folder as Codex" })).toBeTruthy();
    expect(screen.queryByText("Overlap")).toBeNull();

    act(() =>
      useCoordination.setState({
        byWorkspace: { [WS]: { status: status([]), loading: false, error: null } },
      }),
    );
    expect(screen.queryByRole("button", { name: /^Same folder/ })).toBeNull();
  });
});

// 1.174.0 E4 (P21, mockup terminals.html §1): the tile header doesn't
// overflow. At 1280 × Quad a tile is about 440 px, under the 480 px
// breakpoint: "Same folder" and "Asks: trust" show, the full words stay the
// tooltip and what a screen reader reads, Expand and Close keep their room.
// jsdom can't measure, so this pins the structure and the classes the
// `@container tile` rules act on.
describe("the tile header at 1280 × Quad with Same folder and a trust question (E4)", () => {
  /** terminals.css without comments. */
  const css = readFileSync("src/components/terminals.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /** The body of every plain rule whose selector list names `sel` exactly. */
  const rules = (source: string, sel: string) =>
    [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => m[1].split(",").map((x) => x.trim()).includes(sel))
      .map((m) => m[2]);
  /** The inside of every `@container tile (max-width: <px>px) { … }`. */
  function container(px: number): string {
    const head = `@container tile (max-width: ${px}px)`;
    const bodies: string[] = [];
    for (let at = css.indexOf(head); at > -1; at = css.indexOf(head, at + 1)) {
      let depth = 0;
      let i = css.indexOf("{", at);
      const start = i + 1;
      for (; i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}" && --depth === 0) break;
      }
      bodies.push(css.slice(start, i));
    }
    expect(bodies.length).toBeGreaterThan(0);
    return bodies.join("\n");
  }

  function renderQuadPair() {
    const { claude, codex, sessions, warnings } = seed();
    act(() => {
      useTiles.getState().markQuestion("pty-a", "trust");
      useCoordination.setState({
        byWorkspace: {
          [WS]: {
            status: {
              trackingActive: true,
              state: "active",
              workspaceId: WS,
              activeSessions: sessions,
              liveWarnings: warnings,
              recentInterruptedCount: 0,
            },
            loading: false,
            error: null,
          },
        },
      });
    });
    const tiles = useTiles.getState().byWorkspace[WS].tiles;
    const { tauri } = renderUi(
      <div style={{ width: 1280, display: "grid", gridTemplateColumns: "1fr 1fr" }}>
        <TileView tile={tiles.find((t) => t.id === claude.id)!} env={null} workspaceCwd="/p" hidden={false} />
        <TileView tile={tiles.find((t) => t.id === codex.id)!} env={null} workspaceCwd="/p" hidden={false} />
      </div>,
    );
    tauri.allowUnhandled();
    return document.querySelector(`[data-tile-id="${claude.id}"] .tile-header`) as HTMLElement;
  }

  it("the status carries its full words and its short form; a reader gets the full words", () => {
    const header = renderQuadPair();
    const status = within(header).getByRole("status");
    expect(status.className).toBe("tile-status tile-status--asks");
    // No aria-label: the reader reads the full words (visually hidden when
    // narrow), never the short form, which is aria-hidden.
    expect(status.getAttribute("aria-label")).toBeNull();
    expect(status.getAttribute("title")).toBe("Claude asks to trust the folder");
    expect(status.querySelector(".tile-status-full")?.textContent).toBe("Claude asks to trust the folder");
    const short = status.querySelector(".tile-status-short") as HTMLElement;
    expect(short.textContent).toBe("Asks: trust");
    expect(short.getAttribute("aria-hidden")).toBe("true");
    expect(status.querySelector(".tile-status-dot")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("the chip is a button with its full name and both forms; Expand and Close come after the status", () => {
    const header = renderQuadPair();
    const chip = within(header).getByRole("button", { name: "Same folder as Codex" });
    expect(chip.className).toBe("tile-chip tile-chip--folder");
    expect(chip.getAttribute("title")).toBe("Same folder as Codex");
    expect(chip.querySelector(".tile-chip-full")?.textContent).toBe("Same folder as Codex");
    const short = chip.querySelector(".tile-chip-short") as HTMLElement;
    expect(short.textContent).toBe("Same folder");
    expect(short.getAttribute("aria-hidden")).toBe("true");
    expect(chip.querySelector(".tile-chip-dot")).toBeTruthy();
    // The status, then the actions, both direct children of the header.
    const kids = [...header.children];
    const status = header.querySelector(".tile-status") as HTMLElement;
    const actions = header.querySelector(".tile-actions") as HTMLElement;
    expect(kids.indexOf(status)).toBeGreaterThan(kids.indexOf(chip));
    expect(kids.indexOf(actions)).toBe(kids.indexOf(status) + 1);
    expect(within(actions).getByRole("button", { name: "Expand tile" })).toBeTruthy();
    expect(within(actions).getByRole("button", { name: "Close tile" })).toBeTruthy();
    // The other tile, which isn't asking, has no short form.
    const other = document.querySelectorAll(".tile-header")[1] as HTMLElement;
    expect(other.querySelector(".tile-status-short")).toBeNull();
    expect(within(other).getByRole("button", { name: "Same folder as Claude" })).toBeTruthy();
  });

  it("the CSS: chips give way, the status never does and goes before the actions, which never shrink", () => {
    const [chip] = rules(css, ".tile-chip");
    expect(chip).toMatch(/flex:\s*0 1 auto/);
    expect(chip).toMatch(/min-width:\s*0/);
    expect(chip).toMatch(/text-overflow:\s*ellipsis/);
    const [status] = rules(css, ".tile-status");
    expect(status).toMatch(/flex:\s*0 0 auto/);
    expect(status).toMatch(/order:\s*1/);
    const [actions] = rules(css, ".tile-actions");
    expect(actions).toMatch(/flex:\s*0 0 auto/);
    expect(actions).toMatch(/order:\s*2/);
    // At rest the short forms are hidden.
    expect(rules(css, ".tile-status-short")[0]).toMatch(/display:\s*none/);
    expect(rules(css, ".tile-chip-short").some((r) => /display:\s*none/.test(r))).toBe(true);
    // The popover's two lines keep their spacing without a class of their own.
    expect(rules(css, ".tile-folder-pop > p:not(.tile-folder-pop-hint)")[0]).toMatch(
      /margin:\s*0 0 var\(--space-sm\)/,
    );
    // The breakpoints measure the tile itself.
    expect(rules(css, ".tile")[0]).toMatch(/container:\s*tile \/ inline-size/);
  });

  it("the CSS: ≤ 480 px shows the short forms, the full status words stay readable; ≤ 320 px the chip is its dot", () => {
    const narrow = container(480);
    expect(rules(narrow, ".tile-chip-full")[0]).toMatch(/display:\s*none/);
    expect(rules(narrow, ".tile-chip-short")[0]).toMatch(/display:\s*block/);
    expect(rules(narrow, ".tile-status-short")[0]).toMatch(/display:\s*inline/);
    // Visually hidden, not display:none: the live region keeps its words.
    const full = rules(narrow, ".tile-status-full")[0];
    expect(full).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(full).not.toMatch(/display:\s*none/);
    const tiny = container(320);
    expect(rules(tiny, ".tile-chip--folder .tile-chip-full")[0]).toMatch(/display:\s*none/);
    expect(rules(tiny, ".tile-chip--folder .tile-chip-short")[0]).toMatch(/display:\s*none/);
    expect(rules(tiny, ".tile-chip--folder")[0]).toMatch(/width:\s*22px/);
    // No tint and no left bar in the new rules.
    for (const block of [narrow, tiny]) {
      expect(block).not.toMatch(/border-left|box-shadow:\s*inset/);
      expect(block).not.toMatch(/background:/);
    }
  });
});

// 1.174.0 E1 (P18, D7 b, owner: any changed file): in the project folder the
// chip waits for a write, then names what changed; two tiles of one AI are
// told apart by their labels.
describe("Same folder only after a write (E1)", () => {
  function twoCodex(cwd = "/p") {
    act(() => {
      useWorkspaces.setState({
        activeId: WS,
        workspaces: [{ id: WS, name: "P", cwd: "/p", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
      } as Partial<ReturnType<typeof useWorkspaces.getState>>);
      useUi.setState({ centerMode: { [WS]: "terminals" } } as Partial<ReturnType<typeof useUi.getState>>);
      const s = useTiles.getState();
      s.addCodexTile(WS, cwd);
      s.addCodexTile(WS, cwd);
      const [a, b] = useTiles.getState().byWorkspace[WS].tiles;
      s.setPtyId(a.id, "pty-a");
      s.setPtyId(b.id, "pty-b");
    });
    const [one, two] = useTiles.getState().byWorkspace[WS].tiles;
    const sessions = [session("s-a", "pty-a", "codex"), session("s-b", "pty-b", "codex")];
    const warnings: CoordinationLiveWarning[] = [
      { sessionId: "s-a", peerSessionId: "s-b", code: "two-provider-tiles", summary: "" },
    ];
    return { one, two, sessions, warnings };
  }

  // 1.174.1 P6 (T6): three tiles in one folder — "they", not "both".
  it("with three tiles, says since they opened", async () => {
    act(() => {
      useWorkspaces.setState({
        activeId: WS,
        workspaces: [{ id: WS, name: "P", cwd: "/p", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
      } as Partial<ReturnType<typeof useWorkspaces.getState>>);
      useUi.setState({ centerMode: { [WS]: "terminals" } } as Partial<ReturnType<typeof useUi.getState>>);
      const s = useTiles.getState();
      s.addCodexTile(WS, "/p");
      s.addCodexTile(WS, "/p");
      s.addCodexTile(WS, "/p");
      const [a, b, c] = useTiles.getState().byWorkspace[WS].tiles;
      s.setPtyId(a.id, "pty-a");
      s.setPtyId(b.id, "pty-b");
      s.setPtyId(c.id, "pty-c");
    });
    const [one] = useTiles.getState().byWorkspace[WS].tiles;
    const sessions = [session("s-a", "pty-a", "codex"), session("s-b", "pty-b", "codex"), session("s-c", "pty-c", "codex")];
    const warnings: CoordinationLiveWarning[] = [
      { sessionId: "s-a", peerSessionId: "s-b", code: "two-provider-tiles", summary: "" },
      { sessionId: "s-a", peerSessionId: "s-c", code: "two-provider-tiles", summary: "" },
    ];
    const { user } = renderUi(
      <SameFolderChip tile={one} session={sessions[0]} hidden={false} warnings={warnings} sessions={sessions} />,
      { fixtures: ON_GITHUB },
    );
    const at = Date.now() + 1000;
    act(() => useFolderChanges.getState().record(WS, "/p/src/lib/inboxView.ts", at));
    await user.click(await screen.findByRole("button", { name: /^Same folder/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("codex 1 and 2 other terminals are working in the same folder.");
    expect(dialog.textContent).toContain("1 file changed here since they opened: inboxView.ts.");
    expect(dialog.textContent).not.toContain("since both opened");
  });

  it("shows nothing while both are idle; a change after both opened brings it, named codex 2", async () => {
    const { one, sessions, warnings } = twoCodex();
    const { user } = renderUi(
      <SameFolderChip tile={one} session={sessions[0]} hidden={false} warnings={warnings} sessions={sessions} />,
      { fixtures: ON_GITHUB },
    );
    expect(screen.queryByRole("button", { name: /^Same folder/ })).toBeNull();
    // A change from before the younger opened doesn't count.
    act(() => useFolderChanges.getState().record(WS, "/p/old.ts", 0));
    expect(screen.queryByRole("button", { name: /^Same folder/ })).toBeNull();
    // Inside .git (or a copy's folder) the watcher reports nothing; here a
    // file in the project changed.
    const at = Date.now() + 1000;
    act(() => {
      useFolderChanges.getState().record(WS, "/p/src/components/InboxPanel.tsx", at);
      useFolderChanges.getState().record(WS, "/p/src/lib/inboxView.ts", at + 1);
    });
    const chip = await screen.findByRole("button", { name: "Same folder as codex 2" });
    await user.click(chip);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("codex 1 and codex 2 are working in the same folder.");
    expect(dialog.textContent).toContain(
      "2 files changed here since both opened: inboxView.ts, InboxPanel.tsx. They can change the same files without seeing each other's edits.",
    );
    expect(dialog.textContent).toContain("Then close codex 1 here: its conversation stays in Resume…");
    expect(screen.getByRole("button", { name: "Show codex 2" })).toBeTruthy();
  });

  it("listens to the watcher's fs://changed", async () => {
    const { one, sessions, warnings } = twoCodex();
    const r = renderUi(
      <SameFolderChip tile={one} session={sessions[0]} hidden={false} warnings={warnings} sessions={sessions} />,
      { fixtures: ON_GITHUB },
    );
    const { listenForFolderChanges } = await import("../store/folderChanges");
    await act(async () => listenForFolderChanges());
    act(() => r.tauri.emit("fs://changed", { workspaceId: WS, path: "/p/README.md", kind: "modified" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Same folder as codex 2" })).toBeTruthy());
  });

  // Challenger 1 (E1-1): a copy's or card's folder lies inside the project
  // folder and the watcher reports it; its files never count for a tile in
  // the project folder (making a copy writes thousands).
  it("a change inside a copy's folder shows no chip on tiles in the project folder", async () => {
    const { one, sessions, warnings } = twoCodex();
    const r = renderUi(
      <SameFolderChip tile={one} session={sessions[0]} hidden={false} warnings={warnings} sessions={sessions} />,
      { fixtures: ON_GITHUB },
    );
    const at = Date.now() + 1000;
    act(() => {
      useFolderChanges.getState().record(WS, "/p/.plyloft-worktrees/copy-x/src/App.tsx", at);
      useFolderChanges.getState().record(WS, "/p/.atelier-worktrees/card-1/README.md", at);
    });
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /^Same folder/ })).toBeNull();
    expect(r.tauri.calls.some((c) => c.cmd === "fs_ignored_paths")).toBe(false);
  });

  // E1-2: two tiles in one copy follow the same rule, on that copy's files.
  it("two tiles in one copy: only a change in that copy brings the chip", async () => {
    const { one, sessions, warnings } = twoCodex("/p/.plyloft-worktrees/copy-x");
    renderUi(
      <SameFolderChip tile={one} session={sessions[0]} hidden={false} warnings={warnings} sessions={sessions} />,
      { fixtures: ON_GITHUB },
    );
    expect(screen.queryByRole("button", { name: /^Same folder/ })).toBeNull();
    const at = Date.now() + 1000;
    act(() => useFolderChanges.getState().record(WS, "/p/src/elsewhere.ts", at));
    act(() => useFolderChanges.getState().record(WS, "/p/.plyloft-worktrees/copy-y/a.ts", at));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /^Same folder/ })).toBeNull();
    act(() => useFolderChanges.getState().record(WS, "/p/.plyloft-worktrees/copy-x/src/a.ts", at));
    expect(await screen.findByRole("button", { name: "Same folder as codex 2" })).toBeTruthy();
  });

  // E1-3: nothing is reported with the watcher off (or the folder missing):
  // the old rule, a warning at once.
  it("with the watcher off, or the project folder missing, it warns at once", async () => {
    const { one, sessions, warnings } = twoCodex();
    const { useSettings } = await import("../store/settingsStore");
    const before = useSettings.getState().settings;
    act(() => useSettings.setState({ settings: { ...before, behavior: { ...before.behavior, fileWatcherEnabled: false } } }));
    try {
      const r = renderUi(
        <SameFolderChip tile={one} session={sessions[0]} hidden={false} warnings={warnings} sessions={sessions} />,
        { fixtures: ON_GITHUB },
      );
      expect(screen.getByRole("button", { name: "Same folder as codex 2" })).toBeTruthy();
      r.unmount();
    } finally {
      act(() => useSettings.setState({ settings: before }));
    }
    act(() => useWorkspaces.setState({ cwdMissing: { [WS]: true } } as Partial<ReturnType<typeof useWorkspaces.getState>>));
    try {
      renderUi(
        <SameFolderChip tile={one} session={sessions[0]} hidden={false} warnings={warnings} sessions={sessions} />,
        { fixtures: ON_GITHUB },
      );
      expect(screen.getByRole("button", { name: "Same folder as codex 2" })).toBeTruthy();
    } finally {
      act(() => useWorkspaces.setState({ cwdMissing: {} } as Partial<ReturnType<typeof useWorkspaces.getState>>));
    }
  });

  // E1-4: a file git ignores doesn't count (asked once); Plyloft's own
  // editor saves do.
  it("an ignored file doesn't count; an editor save does", async () => {
    const { one, sessions, warnings } = twoCodex();
    const asked: unknown[] = [];
    renderUi(
      <SameFolderChip tile={one} session={sessions[0]} hidden={false} warnings={warnings} sessions={sessions} />,
      {
        fixtures: {
          ...ON_GITHUB,
          fs_ignored_paths: (args: { cwd: string; paths: string[] }) => {
            asked.push(args);
            return args.paths.filter((p) => p.endsWith(".log"));
          },
        },
      },
    );
    const at = Date.now() + 1000;
    act(() => useFolderChanges.getState().record(WS, "/p/debug.log", at));
    await waitFor(() => expect(asked).toEqual([{ cwd: "/p", paths: ["/p/debug.log"] }]));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /^Same folder/ })).toBeNull();
    const { noteEditorSave } = await import("../store/folderChanges");
    act(() => noteEditorSave(WS, "/p/src/App.tsx"));
    expect(await screen.findByRole("button", { name: "Same folder as codex 2" })).toBeTruthy();
    // Each file is asked about once.
    expect(asked).toHaveLength(2);
  });

  // E1-1: reported changes are gathered, and a repeat within a second skipped.
  it("gathers reported changes and skips a file recorded a moment ago", async () => {
    const { queueFolderChange, flushFolderChangesForTests } = await import("../store/folderChanges");
    let renders = 0;
    const stop = useFolderChanges.subscribe(() => (renders += 1));
    try {
      act(() => {
        for (let i = 0; i < 50; i++) queueFolderChange(WS, `/p/.plyloft-worktrees/copy-x/f${i}.ts`, 10_000);
        queueFolderChange(WS, "/p/a.ts", 10_000);
        queueFolderChange(WS, "/p/a.ts", 10_100);
        flushFolderChangesForTests();
      });
      expect(renders).toBe(1);
      expect(Object.keys(useFolderChanges.getState().byWorkspace[WS])).toHaveLength(51);
      act(() => {
        queueFolderChange(WS, "/p/a.ts", 10_500);
        flushFolderChangesForTests();
      });
      expect(useFolderChanges.getState().byWorkspace[WS]["/p/a.ts"].at).toBe(10_000);
    } finally {
      stop();
    }
  });

  // Round 2 (E1 1): the cap is per folder — making a copy (hundreds of
  // files in its folder) never pushes the project folder's change out.
  it("a copy's flood of files keeps the project folder's change, and its chip", async () => {
    const { one, sessions, warnings } = twoCodex();
    renderUi(
      <SameFolderChip tile={one} session={sessions[0]} hidden={false} warnings={warnings} sessions={sessions} />,
      { fixtures: ON_GITHUB },
    );
    const at = Date.now() + 1000;
    act(() => useFolderChanges.getState().record(WS, "/p/src/App.tsx", at));
    expect(await screen.findByRole("button", { name: "Same folder as codex 2" })).toBeTruthy();
    act(() =>
      useFolderChanges
        .getState()
        .recordMany(Array.from({ length: 400 }, (_, i) => ({ workspaceId: WS, path: `/p/.plyloft-worktrees/copy-x/f${i}.ts`, at: at + 1 + i }))),
    );
    const kept = useFolderChanges.getState().byWorkspace[WS];
    expect(kept[`/p/src/App.tsx`]).toBeTruthy();
    expect(Object.keys(kept).filter((k) => k.includes("copy-x"))).toHaveLength(300);
    expect(screen.getByRole("button", { name: "Same folder as codex 2" })).toBeTruthy();
  });

  // Round 2 (E1 3, 4): an evicted file's git answer goes too; a workspace
  // whose watcher stopped forgets everything.
  it("drops an evicted file's git answer, and forgets a closed workspace", () => {
    act(() => {
      const s = useFolderChanges.getState();
      s.record(WS, "/p/.plyloft-worktrees/copy-x/old.ts", 1);
      s.markIgnored(WS, { "/p/.plyloft-worktrees/copy-x/old.ts": true });
      s.recordMany(Array.from({ length: 300 }, (_, i) => ({ workspaceId: WS, path: `/p/.plyloft-worktrees/copy-x/n${i}.ts`, at: 10 + i })));
    });
    expect(useFolderChanges.getState().ignored[WS]["/p/.plyloft-worktrees/copy-x/old.ts"]).toBeUndefined();
    act(() => forgetFolderChanges(WS));
    expect(useFolderChanges.getState().byWorkspace[WS]).toBeUndefined();
    expect(useFolderChanges.getState().ignored[WS]).toBeUndefined();
  });

  // Round 2 (E1 2): the popover reads where a copy starts from the current
  // area's branch, as the sheet does.
  it("with two areas, the popover asks for the current area's branch and names it", async () => {
    const { one, sessions, warnings } = twoCodex();
    const area = (id: string, branch: string, first: boolean): ResolvedArea =>
      ({
        id,
        name: id,
        path: first ? "" : id,
        root: first,
        first,
        targetBranch: first ? null : branch,
        branch,
        versionFiles: null,
        tagPrefix: first ? "" : `${id}-`,
        label: `area:${id}`,
        lookAt: null,
      }) as ResolvedArea;
    const areas = [area("app", "main", true), area("site", "site-main", false)];
    const view = {
      shared: true,
      readOnly: false,
      defined: areas.map((a) => ({ id: a.id, name: a.name, path: a.path })),
      areas,
      workspaceBranch: "main",
      check: { errors: [], warnings: [] },
      problem: null,
      held: false,
    } as unknown as AreasView;
    act(() => useAreas.setState({ views: { [WS]: view }, chosen: { [WS]: "site" } }));
    const r = renderUi(
      <SameFolderChip tile={one} session={sessions[0]} hidden={false} warnings={warnings} sessions={sessions} />,
      {
        fixtures: {
          ...ON_GITHUB,
          copy_start_point: (args: { target: string | null }) => ({ target: args.target ?? "main", fromGitHub: true, localAhead: 0 }),
        },
      },
    );
    act(() => useFolderChanges.getState().record(WS, "/p/README.md", Date.now() + 1000));
    const { user } = r;
    await user.click(await screen.findByRole("button", { name: "Same folder as codex 2" }));
    const dialog = await screen.findByRole("dialog");
    expect(r.tauri.callsOf("copy_start_point")[0].args).toMatchObject({ workspaceId: WS, target: "site-main", skipChanged: true });
    expect(dialog.textContent).toContain("It starts from site-main on GitHub.");
  });

  // 1.174.0 walk G3b: Plyloft's own save writes "<file>.atelier-tmp" and
  // renames it; only the file itself counts.
  it("Plyloft's atomic-write temp file doesn't count", async () => {
    const { one, sessions, warnings } = twoCodex();
    const { queueFolderChange, flushFolderChangesForTests } = await import("../store/folderChanges");
    renderUi(
      <SameFolderChip tile={one} session={sessions[0]} hidden={false} warnings={warnings} sessions={sessions} />,
      { fixtures: ON_GITHUB },
    );
    const at = Date.now() + 1000;
    act(() => {
      useFolderChanges.getState().record(WS, "/p/notes/count.md.atelier-tmp", at);
      queueFolderChange(WS, "/p/notes/count.md.a1b2c3.atelier-tmp", at);
      flushFolderChangesForTests();
    });
    await act(async () => {});
    expect(useFolderChanges.getState().byWorkspace[WS]).toBeUndefined();
    expect(screen.queryByRole("button", { name: /^Same folder/ })).toBeNull();
    act(() => useFolderChanges.getState().record(WS, "/p/notes/count.md", at));
    await user_click_chip_and_check();
    async function user_click_chip_and_check() {
      const chip = await screen.findByRole("button", { name: "Same folder as codex 2" });
      chip.click();
      const dialog = await screen.findByRole("dialog");
      expect(dialog.textContent).toContain("1 file changed here since both opened: count.md.");
    }
  });
});
