// UX-3.6: one ⌘K. Quick Open (⌘P), the search modal (⌘⇧F) and the history
// search (⌘⇧H) are scopes of the same surface: one field, one chrome, the
// query carried when the scope changes, each scope on its own IPC.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CommandPalette } from "../components/CommandPalette";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useUi } from "../store/uiStore";
import { act, fireEvent, nextFrame, renderUi, screen, tauri, waitFor, within } from "./render";

const lyra: Workspace = {
  id: "l",
  name: "Lyra",
  cwd: "/Users/someone/code/lyra",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

async function renderPalette(scope: "commands" | "files" | "text" | "history" = "commands") {
  tauri().allowUnhandled();
  tauri().fixture("fs_list_files_recursive", {
    paths: ["scripts/ship.sh", "docs/RELEASING.md", "src/App.tsx"],
    truncated: false,
  });
  tauri().fixture("ripgrep_available", true);
  tauri().fixture("search_start", null);
  tauri().fixture("search_cancel", null);
  tauri().fixture("history_search_start", null);
  tauri().fixture("history_search_cancel", null);
  act(() => useWorkspaces.setState({ workspaces: [lyra], activeId: "l" }));
  const r = renderUi(
    <CommandPalette activeWorkspaceId="l" claudeAvailable onOpenInstalledSelfCheck={() => {}} />,
  );
  act(() => useUi.getState().openPalette(scope));
  await nextFrame();
  return r;
}

const dialog = () => screen.getByRole("dialog", { name: "Search" });
const selectedScope = () =>
  within(dialog())
    .getAllByRole("tab")
    .find((t) => t.getAttribute("aria-selected") === "true")?.textContent;

describe("⌘K", () => {
  it("offers the shell's places and actions as commands", async () => {
    await renderPalette();
    const list = within(dialog()).getByRole("listbox");
    for (const label of [
      "Go to Terminals",
      "Go to History",
      "Go to Library",
      "Add a project…",
      "Release…",
      "Rename workspace…",
      "New card…",
    ]) {
      expect(within(list).getByText(label)).toBeTruthy();
    }
    expect(selectedScope()).toBe("Commands");
  });

  // 1.174.0 (DR3, release.html state 11): Release <Area>… (Release…
  // without areas) says what is new since the last tag, read on open, and
  // opens the Release sheet — on every plan.
  it("names what the release would carry, and opens the Release sheet", async () => {
    tauri().fixture("release_scopes", [
      {
        workspaceId: "l",
        area: null,
        name: null,
        targetBranch: "main",
        sinceTag: "v1.4.0",
        sinceAt: null,
        cards: [],
        cardsTotal: 4,
        otherChanges: [],
        otherTotal: 2,
        readyCardIds: [],
        refusal: null,
        inFlight: null,
        countProblem: null,
      },
    ]);
    const r = await renderPalette();
    const list = within(dialog()).getByRole("listbox");
    await waitFor(() => expect(within(list).getByText("4 cards and 2 other changes on main since v1.4.0")).toBeTruthy());
    await r.user.click(within(list).getByText("Release…"));
    expect(useUi.getState().releaseSheet).toEqual({ workspaceId: "l", areaId: null });
    act(() => useUi.getState().setReleaseSheet(null));
  });

  // Walk fix (DR3 early walk): an area that can't release comes after the
  // ones that can, saying why.
  it("lists the areas that can release first", async () => {
    const area = (id: string, name: string, over: object) => ({
      workspaceId: "l", area: id, name, targetBranch: "main", sinceTag: null, sinceAt: null, cards: [], cardsTotal: 0,
      otherChanges: [], otherTotal: 0, readyCardIds: [], refusal: null, inFlight: null, countProblem: null, ...over,
    });
    tauri().fixture("areas_get", {
      shared: false, readOnly: false, defined: [], workspaceBranch: "main", check: { errors: [], warnings: [] }, problem: null, held: false,
      areas: [
        { id: "app", name: "App", tagPrefix: "" },
        { id: "site", name: "Site", tagPrefix: "site-" },
      ],
    });
    tauri().fixture("release_scopes", [
      area("app", "App", { targetBranch: "staging", refusal: "GitHub has no branch staging." }),
      area("site", "Site", { cardsTotal: 2 }),
    ]);
    await renderPalette();
    const list = within(dialog()).getByRole("listbox");
    await waitFor(() => expect(within(list).getByText("GitHub has no branch staging.")).toBeTruthy());
    const labels = within(list).getAllByText(/^Release (App|Site)…$/).map((e) => e.textContent);
    expect(labels).toEqual(["Release Site…", "Release App…"]);
  });

  // G2 (1.173.0): the old names still find it, and are never shown.
  it("finds Release… under its old name, Ship batch", async () => {
    const r = await renderPalette();
    await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "Ship batch");
    const list = within(dialog()).getByRole("listbox");
    await waitFor(() => expect(within(list).getByText("Release…")).toBeTruthy());
    // only the searches that echo the query say it; no command row does
    expect(within(list).queryByText(/^(?!Search ").*Ship batch/)).toBeNull();
  });

  it("under a query lists commands, a few files and the two deeper searches", async () => {
    const r = await renderPalette();
    await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "ship");
    await waitFor(() => expect(within(dialog()).getByText("ship.sh")).toBeTruthy());
    const captions = [...dialog().querySelectorAll(".palette-section")].map((c) => c.textContent);
    // Settings that mention it may sit between; the order is the board's.
    expect(captions.filter((c) => c !== "Settings")).toEqual(["Commands", "Files", "In files · History"]);
    expect(within(dialog()).getByText('Search "ship" in files')).toBeTruthy();
    // 1.174.0 E9 round 1: ⌘⇧H's own name.
    expect(within(dialog()).getByText('Search "ship" inside past sessions')).toBeTruthy();

    // Choosing the deeper search keeps the surface and the query, and runs
    // the text search the old modal ran.
    await r.user.click(within(dialog()).getByText('Search "ship" in files'));
    expect(selectedScope()).toBe("In files");
    expect((within(dialog()).getByRole("textbox", { name: "Search" }) as HTMLInputElement).value).toBe("ship");
    await waitFor(() => expect(tauri().callsOf("search_start")).toHaveLength(1));
    expect(tauri().callsOf("search_start")[0].args).toMatchObject({ workspaceId: "l", query: "ship" });
  });

  it("⌘P's scope finds files by name and opens one in Code", async () => {
    tauri().fixture("fs_read_text_file", "echo ship\n");
    const r = await renderPalette("files");
    expect(selectedScope()).toBe("Files");
    await waitFor(() => expect(within(dialog()).getByText("App.tsx")).toBeTruthy());
    await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "releasing");
    await waitFor(() => expect(within(dialog()).queryByText("App.tsx")).toBeNull());
    await r.user.keyboard("{Enter}");
    expect(useUi.getState().palette.open).toBe(false);
    await waitFor(() =>
      expect(tauri().callsOf("fs_read_text_file")[0]?.args).toEqual({
        path: "/Users/someone/code/lyra/docs/RELEASING.md",
      }),
    );
    expect(useUi.getState().centerMode.l).toBe("code");
  });

  it("⌘⇧H's scope searches session history with the same field", async () => {
    const r = await renderPalette("history");
    expect(selectedScope()).toBe("History");
    await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "login");
    await waitFor(() => expect(tauri().callsOf("history_search_start")).toHaveLength(1));
    expect(tauri().callsOf("history_search_start")[0].args).toEqual({
      query: "login",
      scope: { kind: "workspace", workspaceId: "l" },
    });
  });

  it("switches scope from its tabs and closes on Esc", async () => {
    const r = await renderPalette();
    await r.user.click(within(dialog()).getByRole("tab", { name: "Files" }));
    expect(useUi.getState().palette.scope).toBe("files");
    await r.user.keyboard("{Escape}");
    expect(useUi.getState().palette.open).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
  });

  /** The rows the list shows: label, hint and whether they have an icon. */
  const rows = () =>
    [...dialog().querySelectorAll<HTMLElement>("[role='option']")].map((o) => ({
      label: o.querySelector(".palette-item-label")?.textContent ?? "",
      hint: o.querySelector(".palette-item-hint")?.textContent ?? "",
      icon: o.querySelector(".palette-item-icon svg") != null,
      section: o.closest("li")?.dataset.section ?? "",
    }));

  // GH #284: under the Settings caption, a row says its setting once and
  // where it lives; no two rows read the same.
  it("lists settings rows without a 'Settings:' prefix, each one distinct", async () => {
    const r = await renderPalette();
    for (const q of ["reset", "ship"]) {
      await r.user.clear(within(dialog()).getByRole("textbox", { name: "Search" }));
      await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), q);
      await nextFrame();
      const all = rows();
      expect(all.some((x) => x.section === "Settings")).toBe(true);
      for (const x of all) expect(x.label.startsWith("Settings")).toBe(false);
      const seen = all.map((x) => `${x.label}|${x.hint}`);
      expect(new Set(seen).size).toBe(seen.length);
    }
    await r.user.clear(within(dialog()).getByRole("textbox", { name: "Search" }));
    await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "reset");
    const labels = rows().map((x) => x.label);
    expect(labels).toContain("Reset Editor and terminals to defaults");
    expect(labels).not.toContain("Reset this page to defaults");
  });

  // GH #321: every row has an icon in the icon column; no path in a hint —
  // a workspace's folder is its tooltip.
  it("gives every command row an icon and no row a path for a hint", async () => {
    const r = await renderPalette();
    act(() =>
      useWorkspaces.setState({
        workspaces: [lyra, { ...lyra, id: "v", name: "Vega", cwd: "/Users/someone/code/vega" }],
      }),
    );
    await nextFrame();
    const empty = rows();
    expect(empty.length).toBeGreaterThan(5);
    for (const x of empty) {
      expect(x.icon, x.label).toBe(true);
      expect(x.hint.startsWith("/"), x.label).toBe(false);
    }
    const vega = [...dialog().querySelectorAll<HTMLElement>("[role='option']")].find((o) =>
      o.textContent?.includes("Switch to workspace: Vega"),
    );
    expect(vega?.getAttribute("title")).toBe("/Users/someone/code/vega");
    await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "reset");
    for (const x of rows()) expect(x.icon, x.label).toBe(true);
  });

  // GH #285: History and In files draw ⌘K's rows under sentence-case
  // captions; their options are words, not 10 px capitals or glyphs.
  it("draws History hits as rows under sentence-case captions", async () => {
    const r = await renderPalette("history");
    expect(within(dialog()).getByRole("group", { name: "Where" })).toBeTruthy();
    await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "login");
    await waitFor(() => expect(tauri().callsOf("history_search_start")).toHaveLength(1));
    act(() => {
      tauri().emit("history://result", {
        kind: "card",
        workspaceId: "l",
        artifactId: "fx-ready-to-ship-0001",
        path: "/x/cards.json",
        lineNumber: 1,
        lineText: "  Fix the login redirect",
        matchText: "login",
      });
      tauri().emit("history://done", { status: "completed", message: null, total: 1 });
    });
    const hit = await within(dialog()).findByRole("button", { name: /Fix the login redirect/ });
    expect(hit.querySelector("svg")).toBeTruthy();
    expect(hit.textContent).not.toMatch(/fx-ready|:1/);
    const captions = [...dialog().querySelectorAll(".palette-section")].map((c) => c.textContent);
    expect(captions).toEqual(["Cards"]);
    expect(dialog().textContent).not.toMatch(/CARD|grouped by kind|Cards · runs/);
  });

  it("offers In files' options in words and lists matches as rows", async () => {
    const r = await renderPalette("text");
    await waitFor(() =>
      expect(within(dialog()).getByRole("group", { name: "Search options" })).toBeTruthy(),
    );
    const options = within(within(dialog()).getByRole("group", { name: "Search options" }))
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(options).toEqual(["Match case", "Whole word", "Regular expression", "Hidden files"]);
    await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "ship");
    await waitFor(() => expect(tauri().callsOf("search_start")).toHaveLength(1));
    act(() => {
      tauri().emit("search://result", {
        workspaceId: "l",
        path: "/Users/someone/code/lyra/scripts/ship.sh",
        lineNumber: 3,
        lineText: "echo ship",
      });
    });
    const row = await within(dialog()).findByRole("button", { name: /echo ship/ });
    expect(row.textContent).toContain("Line 3");
    expect(dialog().querySelector(".palette-section")?.textContent).toContain("scripts/ship.sh");
  });

  it("keeps the scopes' CSS on the one scale — no capitals, nothing under 12 px", () => {
    const shell = readFileSync("src/components/shell.css", "utf8");
    const app = readFileSync("src/App.css", "utf8");
    expect(app).not.toMatch(/\.history-search-(?!body)|\.search-(toggles|glob|file|result-row|line|status)/);
    const palette = [...shell.matchAll(/([^{}]*\.(?:palette|history-search|search-panel)[^{}]*)\{([^}]*)\}/g)];
    for (const [, sel, body] of palette) {
      expect(body, sel).not.toMatch(/text-transform:\s*uppercase/);
      expect(body, sel).not.toMatch(/font-size:\s*\d+px/);
    }
  });
});

describe("an exact title leads (walk of 2026-11-03)", () => {
  const selected = () =>
    screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")?.textContent ?? "";

  it("Go to Board typed in full selects Go to Board, and Enter is that", async () => {
    const r = await renderPalette();
    await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "Go to Board");
    await nextFrame();
    expect(selected()).toContain("Go to Board");
  });

  it("a row appearing under a pointer that hasn't moved takes nothing; a moved pointer does", async () => {
    const r = await renderPalette();
    await r.user.type(within(dialog()).getByRole("textbox", { name: "Search" }), "Go to");
    await nextFrame();
    const options = screen.getAllByRole("option");
    const first = selected();
    fireEvent.mouseEnter(options[2]);
    expect(selected()).toBe(first);
    fireEvent.mouseMove(options[2]);
    expect(selected()).toBe(options[2].textContent);
  });
});
