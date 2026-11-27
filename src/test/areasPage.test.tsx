// 1.173.0 (B5): Settings › This repository › Areas (mockup areas.html scene
// 3) — the list and its rows, the rules said beside their field, the save's
// payload (every tag prefix written out), Suggest areas, the suggestion *Set
// up areas…* left, held, read-only and a repository that shares nothing.
import { describe, expect, it } from "vitest";
import { useState, type ReactNode } from "react";
import { FoundRow } from "../components/ux/Row";
import { AreasPage } from "../components/settings/AreasPage";
import { AdoptDirectionSheetHost } from "../components/settings/AdoptDirectionSheet";
import { useNextImprovement } from "../store/nextImprovementStore";
import type { AreaCheck, AreaDef, AreaDiscovery, AreaRelease, AreasView, ProjectConfig, ResolvedArea } from "../ipc";
import { useAreas } from "../store/areaStore";
import { useWorkspaces } from "../store/workspaceStore";
import { hasLeaveGuard, leavePage } from "../lib/leaveGuard";
import { act, fireEvent, renderUi, screen, waitFor, within } from "./render";
import { setPlatformForTests } from "../lib/platform";

const WS = "ws";

const config: ProjectConfig = {
  schemaVersion: 2,
  targetBranch: "staging",
  versionFiles: [],
  installScript: null,
  verifyPipeline: null,
  createdAt: 0,
  updatedAt: 0,
};

const APP: AreaDef = { id: "app", name: "App", path: "" };
const SITE: AreaDef = {
  id: "site",
  name: "Site",
  path: "lyrappc-astro",
  targetBranch: "main",
  versionFiles: [{ path: "lyrappc-astro/package.json", kind: "package_json" }],
  lookAt: "https://www.lyrappc.com",
};

function resolved(a: AreaDef, index: number): ResolvedArea {
  return {
    id: a.id,
    name: a.name,
    path: a.path,
    root: a.path === "",
    first: index === 0,
    targetBranch: a.targetBranch ?? null,
    branch: a.targetBranch ?? "staging",
    versionFiles: a.versionFiles ?? null,
    tagPrefix: a.tagPrefix ?? (index === 0 ? "" : `${a.id}-`),
    label: a.label ?? `area:${a.id}`,
    lookAt: a.lookAt ?? null,
  };
}

function view(areas: AreaDef[], extra: Partial<AreasView> = {}): AreasView {
  return {
    shared: true,
    readOnly: false,
    defined: areas,
    areas: areas.map(resolved),
    workspaceBranch: "staging",
    check: { errors: [], warnings: [] },
    problem: null,
    held: false,
    ...extra,
  };
}

const OK: AreaCheck = { errors: [], warnings: [] };

function open(
  areas: AreaDef[] | null,
  opts: {
    readOnly?: boolean;
    areasView?: AreasView;
    check?: (list: AreaDef[]) => AreaCheck;
    discover?: AreaDiscovery | null;
    releases?: AreaRelease[];
    /** `workspace_adoption_status` (C10 round 1); by default a read that fails. */
    adoption?: () => unknown;
    /** `workspace_definition_branches` (Areas round 1). */
    branches?: unknown;
    /** Drawn inside this (a search's landing, Challenger round 2). */
    wrap?: (page: ReactNode) => ReactNode;
  } = {},
) {
  const definition = { schemaVersion: 1, name: "LYRA", board: "local", integrationBranch: "staging", versionFiles: [], areas };
  const definitionView = {
    cache: { definition, branch: "staging", author: "Matteo", changedAt: null, pending: {} },
    effective: definition,
    defaultBranch: "main",
    queue: { createDefinition: false, fields: {}, createPullRequest: null, lastError: null },
    readOnly: opts.readOnly ?? false,
  };
  // C11 review: the direction's question is drawn by App's host, which
  // outlives the page.
  useNextImprovement.setState({ adoptAsk: null });
  const page = <AreasPage workspaceId={WS} />;
  const r = renderUi(<><Shown>{opts.wrap ? opts.wrap(page) : page}</Shown><AdoptDirectionSheetHost /></>, {
    withToasts: true,
    fixtures: {
      workspace_definition_get: definitionView,
      project_config_get: config,
      project_review_get: { selfCheck: true, reviewChecklist: [] },
      worktree_settings_get: {},
      workspace_definition_branches: opts.branches ?? { branches: ["staging", "main"], defaultBranch: "main", error: null, hasOrigin: true },
      areas_get: opts.areasView ?? view(areas ?? [], { readOnly: opts.readOnly ?? false }),
      areas_check: (args: Record<string, unknown>) => (opts.check ? opts.check(args.areas as AreaDef[]) : OK),
      areas_discover: opts.discover ?? null,
      areas_releases: opts.releases ?? [],
      workspace_definition_save: () => definitionView,
      workspace_adoption_status: opts.adoption ?? (() => Promise.reject(new Error("not in these tests"))),
    },
  });
  r.tauri.allowUnhandled();
  // C11 round 3: the direction's question shows on the active workspace.
  act(() => onWorkspace(WS));
  return r;
}

/** `id` is a workspace of the list, and the active one. */
function onWorkspace(id: string) {
  useWorkspaces.setState((s) => ({
    activeId: id,
    workspaces: s.workspaces.some((w) => w.id === id)
      ? s.workspaces
      : [...s.workspaces, { ...(s.workspaces[0] ?? {}), id, name: id } as never],
  }));
}

/** The page, until a test leaves it (`leaveAreas`). */
let leaveAreas: () => void = () => {};
function Shown({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(true);
  leaveAreas = () => setShown(false);
  return shown ? <>{children}</> : null;
}

function textbox(name: string) {
  return screen.findByRole("textbox", { name }) as Promise<HTMLInputElement>;
}

/** DS6: an area's fields are on its sub-page (Edit…). */
async function editArea(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${name}…` }));
  await screen.findByRole("button", { name: "Areas" });
}

/** Back to the list. */
function backToAreas() {
  fireEvent.click(screen.getByRole("button", { name: "Areas" }));
}

describe("Settings › Areas", () => {
  // DS6 (scenes 9, 10): one row per area with Edit…; its fields on a
  // sub-page named after it.
  // Challenger round 2: with no list line drawn, a search for "Areas"
  // still lands on the list, and nothing says the row isn't there.
  it("a search for Areas lands on a two-area list's first row", async () => {
    const arrived: string[] = [];
    const missing: string[] = [];
    open([APP, SITE], {
      wrap: (page) => (
        <FoundRow token="Areas" nonce={1} marked onArrived={(t) => arrived.push(t)} onMissing={(t) => missing.push(t)}>
          {page}
        </FoundRow>
      ),
    });
    await screen.findByRole("button", { name: "Edit App…" });
    await waitFor(() => expect(arrived).toContain("Areas"));
    expect(missing).toEqual([]);
    expect(document.body.textContent).not.toContain("is not on this page");
  });

  // G2 Windows walk: the shared page's leave sheet says this PC on Windows,
  // and the safe choice, Stay, has the focus.
  it("leaving a shared draft on Windows: this PC included, focus on Stay", async () => {
    setPlatformForTests("windows");
    try {
      open([APP, SITE]);
      await screen.findByRole("button", { name: "Edit App…" });
      fireEvent.click(screen.getByRole("button", { name: "Add an area" }));
      await waitFor(() => expect(hasLeaveGuard()).toBe(true));
      act(() => leavePage(() => {}));
      const sheet = await screen.findByRole("dialog", { name: /^Leave with 1 change nobody else has\?$/ });
      expect(sheet.textContent).toContain("this PC included");
      expect(sheet.textContent).not.toMatch(/this Mac/);
      await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "Stay" })));
    } finally {
      setPlatformForTests(null);
    }
  });

  it("lists one row per area, and Edit… opens its sub-page", async () => {
    open([APP, SITE]);
    expect(await screen.findByText("whole project · cards go to staging · no release tagged yet; its tags will start with v")).toBeTruthy();
    expect(screen.getByText("lyrappc-astro/ · cards go to main · no release tagged yet; its tags will start with site-v · www.lyrappc.com")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    await waitFor(() => expect(document.body.textContent).toContain("last changed by Matteo"));
    expect(screen.getByRole("button", { name: "Add an area" }).className).not.toContain("cbtn--quiet");
    expect(screen.getByRole("button", { name: "Suggest areas from this project" }).className).not.toContain("cbtn--quiet");
    // C10 walk: with nothing to say, no lone "Areas" line under the list.
    expect(document.querySelector('.ux-row[data-kind="procedure"]')).toBeNull();
    await editArea("Site");
    expect(document.querySelector(".ux-page-title")?.textContent).toBe("Site");
    expect(document.body.textContent).toContain("lyrappc-astro/ · one of 2 areas");
    expect((await textbox("Site: Folder")).value).toBe("lyrappc-astro");
    expect((screen.getByRole("combobox", { name: "Site: Cards go to" }) as HTMLSelectElement).value).toBe("main");
    expect((await textbox("Site: Version files")).value).toBe("lyrappc-astro/package.json");
    expect((await textbox("Site: Where to look at it")).value).toBe("https://www.lyrappc.com");
    // A local board: no Board label.
    expect(screen.queryByRole("textbox", { name: "Site: Board label" })).toBeNull();
    // G2 walk: no kind of its own — what Shipping says, follow included.
    expect(screen.getByText("Same as Ship it (On this Mac only) — set in Shipping.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Shipping" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Site" }).className).not.toContain("cbtn--quiet");
    backToAreas();
    expect(await screen.findByRole("button", { name: "Edit App…" })).toBeTruthy();
  });

  // C12 (AR-4; areas.html §2): the mark says there were none; the bar says
  // who it reaches, in whole words.
  it("a first area: there were no areas before, and the bar reaches everyone who opens this repository", async () => {
    open(null);
    fireEvent.click(await screen.findByRole("button", { name: "Add an area" }));
    const bar = await screen.findByRole("region", { name: "Changes not published yet" });
    expect(bar.textContent).toContain("1 change · reaches everyone who opens this repository");
    backToAreas();
    expect(await screen.findByText(/Changed here, not published yet — there were no areas before\./)).toBeTruthy();
    expect(document.body.textContent).not.toContain("was None");
  });

  it("Cards go to is a branch from the project; its own branch means none of its own", async () => {
    const r = open([APP, SITE]);
    await editArea("Site");
    const select = (await screen.findByRole("combobox", { name: "Site: Cards go to" })) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: "staging" } });
    fireEvent.click(await screen.findByRole("button", { name: "Publish to staging" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_definition_save")).toHaveLength(1));
    const draft = r.tauri.callsOf("workspace_definition_save")[0].args.draft as { areas: AreaDef[] };
    expect(draft.areas[1].targetBranch ?? null).toBeNull();
  });

  // 1.173.0 (B4 follow-up): the area's latest real tag and the version its
  // files are at, read once when the page opens; vX.Y.Z when unknown.
  it("says each area's latest tag and current version when the repository has them", async () => {
    const r = open([APP, SITE], {
      releases: [
        { id: "app", tagPrefix: "", latestTag: null, version: null },
        { id: "site", tagPrefix: "site-", latestTag: "site-v3.0.2", version: "3.0.1" },
      ],
    });
    // C12 (AR-4): the real last tag, or that there is none yet.
    expect(await screen.findByText(/releases tagged site-v3\.0\.2 \(last\)/)).toBeTruthy();
    expect(screen.getByText(/whole project · cards go to staging · no release tagged yet; its tags will start with v$/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("vX.Y.Z");
    await editArea("Site");
    expect(document.body.textContent).toContain("Now 3.0.1.");
    expect(r.tauri.callsOf("areas_releases")).toHaveLength(1);
    // Changing the files in the draft: the version read no longer applies.
    const files = await textbox("Site: Version files");
    fireEvent.change(files, { target: { value: "lyrappc-astro/other.json" } });
    fireEvent.blur(files);
    await waitFor(() => expect(document.body.textContent).not.toContain("Now 3.0.1."));
    expect(r.tauri.callsOf("areas_releases")).toHaveLength(1);
  });

  it("says the rules' words beside the field they are about, as it is typed", async () => {
    open([APP, SITE], {
      check: (list) =>
        list.some((a) => a.label === "status:site")
          ? {
              errors: [{ area: "site", field: "label", message: "Site's board label “status:site” is one Plyloft uses for its own: choose another." }],
              warnings: [{ area: null, field: "tagPrefix", message: "No area's releases are tagged plain v1.2.3: every release tag has a prefix." }],
            }
          : OK,
    });
    act(() => useWorkspaces.setState({ workspaces: [{ ...useWorkspaces.getState().workspaces[0], id: WS, kanbanSyncMode: "githubIssues" } as never] }));
    await editArea("Site");
    const label = await textbox("Site: Board label");
    fireEvent.change(label, { target: { value: "status:site" } });
    expect(await screen.findByText("Site's board label “status:site” is one Plyloft uses for its own: choose another.")).toBeTruthy();
    expect(screen.getByText("No area's releases are tagged plain v1.2.3: every release tag has a prefix.")).toBeTruthy();
  });

  it("publishes the list with every tag prefix written out, so moving an area never retags it", async () => {
    const r = open([APP, SITE]);
    fireEvent.click(await screen.findByRole("button", { name: "Add an area" }));
    const name = await textbox("New area: Name");
    fireEvent.change(name, { target: { value: "Docs site" } });
    fireEvent.change(await textbox("Docs site: Folder"), { target: { value: "docs" } });
    fireEvent.click(await screen.findByRole("button", { name: "Publish to staging" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_definition_save")).toHaveLength(1));
    const draft = r.tauri.callsOf("workspace_definition_save")[0].args.draft as { areas: AreaDef[] };
    expect(draft.areas.map((a) => [a.id, a.tagPrefix, a.path, a.label])).toEqual([
      ["app", "", "", undefined],
      ["site", "site-", "lyrappc-astro", undefined],
      ["docs-site", "docs-site-", "docs", "area:docs-site"],
    ]);
  });

  it("a published area keeps its id when renamed, and Remove takes it out", async () => {
    const r = open([APP, SITE]);
    await editArea("Site");
    fireEvent.change(await textbox("Site: Name"), { target: { value: "Website" } });
    backToAreas();
    await editArea("App");
    fireEvent.click(await screen.findByRole("button", { name: "Remove App" }));
    expect(await screen.findByRole("button", { name: "Edit Website…" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Publish to staging" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_definition_save")).toHaveLength(1));
    const draft = r.tauri.callsOf("workspace_definition_save")[0].args.draft as { areas: AreaDef[] };
    // Site keeps the prefix it was tagged with, though it is first now.
    expect(draft.areas.map((a) => [a.id, a.name, a.tagPrefix])).toEqual([["site", "Website", "site-"]]);
  });

  it("Suggest areas from this project fills in what Plyloft found", async () => {
    const discovery: AreaDiscovery = {
      products: [
        { path: "", kind: "app" },
        { path: "lyrappc-astro", kind: "site" },
      ],
      suggestion: [
        { id: "app", name: "App", path: "", label: "area:app", tagPrefix: "" },
        {
          id: "site",
          name: "Site",
          path: "lyrappc-astro",
          label: "area:site",
          tagPrefix: "site-",
          versionFiles: [{ path: "lyrappc-astro/package.json", kind: "package_json" }],
          lookAt: "https://www.lyrappc.com",
        },
      ],
      notice: true,
    };
    open(null, { discover: discovery });
    expect(await screen.findByText(/This project ships as one product/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Suggest areas from this project" }));
    expect(await screen.findByText("lyrappc-astro/ · cards go to staging · no release tagged yet; its tags will start with site-v · www.lyrappc.com")).toBeTruthy();
    await editArea("Site");
    expect((await textbox("Site: Folder")).value).toBe("lyrappc-astro");
    expect((await textbox("Site: Where to look at it")).value).toBe("https://www.lyrappc.com");
    backToAreas();
    await editArea("App");
    expect((await textbox("App: Name")).value).toBe("App");
  });

  it("Suggest never touches the areas already here: with both found, nothing changes", async () => {
    const discovery: AreaDiscovery = {
      products: [
        { path: "", kind: "app" },
        { path: "lyrappc-astro", kind: "site" },
      ],
      suggestion: [
        { id: "app", name: "App", path: "", label: "area:app", tagPrefix: "" },
        { id: "site", name: "Site", path: "lyrappc-astro", label: "area:site", tagPrefix: "site-" },
      ],
      notice: true,
    };
    open([APP, { ...SITE, name: "Website" }], { discover: discovery });
    fireEvent.click(await screen.findByRole("button", { name: "Suggest areas from this project" }));
    expect(await screen.findByText(/already has its area here: nothing to add/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Website…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Publish to staging" })).toBeNull();
  });

  it("Suggest adds only the missing area, after the ones here", async () => {
    const discovery: AreaDiscovery = {
      products: [
        { path: "", kind: "app" },
        { path: "lyrappc-astro", kind: "site" },
      ],
      suggestion: [
        { id: "app", name: "App", path: "", label: "area:app", tagPrefix: "" },
        { id: "site", name: "Site", path: "lyrappc-astro", label: "area:site", tagPrefix: "site-" },
      ],
      notice: true,
    };
    const r = open([{ ...APP, name: "Product" }], { discover: discovery });
    fireEvent.click(await screen.findByRole("button", { name: "Suggest areas from this project" }));
    expect(await screen.findByRole("button", { name: "Edit Site…" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Publish to staging" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_definition_save")).toHaveLength(1));
    const draft = r.tauri.callsOf("workspace_definition_save")[0].args.draft as { areas: AreaDef[] };
    expect(draft.areas.map((a) => [a.id, a.name, a.path, a.tagPrefix])).toEqual([
      ["app", "Product", "", ""],
      ["site", "Site", "lyrappc-astro", "site-"],
    ]);
  });

  it("a new area starts with its folder to choose, no error; a removed area's id isn't reused, and the row says why", async () => {
    const r = open([APP, SITE], {
      check: (list) =>
        list.filter((a) => a.path === "").length > 1
          ? { errors: [{ area: list[list.length - 1].id, field: "path", message: "App and New area both take the whole repository: only one area can." }], warnings: [] }
          : OK,
    });
    await editArea("Site");
    fireEvent.click(await screen.findByRole("button", { name: "Remove Site" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add an area" }));
    const folder = await textbox("New area: Folder");
    expect(folder.value).toBe("");
    expect(screen.getByText("Choose the folder this product lives in.")).toBeTruthy();
    // Checked as a folder of its own until one is typed.
    await new Promise((res) => setTimeout(res, 300));
    expect(screen.queryByText(/both take the whole repository/)).toBeNull();
    fireEvent.change(await textbox("New area: Name"), { target: { value: "Site" } });
    expect(await screen.findByText(/“site” belonged to an area removed here, and its cards still carry it, so this one is “site-2”/)).toBeTruthy();
    fireEvent.change(await textbox("Site: Folder"), { target: { value: "web" } });
    fireEvent.click(await screen.findByRole("button", { name: "Publish to staging" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_definition_save")).toHaveLength(1));
    const draft = r.tauri.callsOf("workspace_definition_save")[0].args.draft as { areas: AreaDef[] };
    expect(draft.areas.map((a) => [a.id, a.path])).toEqual([
      ["app", ""],
      ["site-2", "web"],
    ]);
  });

  it("an unchosen folder beside an area that takes the whole repository is an error, as B1's save refuses it", async () => {
    open([APP, SITE]);
    fireEvent.click(await screen.findByRole("button", { name: "Add an area" }));
    const folder = await textbox("New area: Folder");
    const row = folder.closest(".ux-row") as HTMLElement;
    expect(row.classList.contains("ux-row--error")).toBe(true);
    expect(within(row).getByText("Choose the folder this product lives in.")).toBeTruthy();
    expect(folder.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(folder, { target: { value: "docs" } });
    await waitFor(() => expect((folder.closest(".ux-row") as HTMLElement).classList.contains("ux-row--error")).toBe(false));
  });

  it("with no area taking the whole repository, an empty folder stays valid: it becomes the root", async () => {
    open([SITE]);
    fireEvent.click(await screen.findByRole("button", { name: "Add an area" }));
    const folder = await textbox("New area: Folder");
    const row = folder.closest(".ux-row") as HTMLElement;
    expect(row.classList.contains("ux-row--error")).toBe(false);
    expect(within(row).getByText("Choose the folder this product lives in.")).toBeTruthy();
  });

  it("removing an area keeps what was typed in the ones after it", async () => {
    open([APP, SITE, { id: "docs", name: "Docs", path: "docs" }]);
    await editArea("Docs");
    const docs = await textbox("Docs: Version files");
    fireEvent.change(docs, { target: { value: "docs/package.json" } });
    fireEvent.blur(docs);
    backToAreas();
    await editArea("Site");
    fireEvent.click(screen.getByRole("button", { name: "Remove Site" }));
    await editArea("Docs");
    expect((await textbox("Docs: Version files")).value).toBe("docs/package.json");
  });

  it("with nothing to suggest, says so", async () => {
    open(null, { discover: null });
    fireEvent.click(await screen.findByRole("button", { name: "Suggest areas from this project" }));
    expect(await screen.findByText(/Plyloft found one product in this repository/)).toBeTruthy();
  });

  it("starts from the suggestion the Board's Set up areas… left, merged like Suggest", async () => {
    act(() => useAreas.getState().offerSuggestion(WS, [APP, { id: "site", name: "Site", path: "site" }]));
    const r = open([{ ...APP, name: "Product" }]);
    expect(await screen.findByText("site/ · cards go to staging · no release tagged yet; its tags will start with site-v")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Product…" })).toBeTruthy();
    expect(useAreas.getState().takeSuggestion(WS)).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Publish to staging" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_definition_save")).toHaveLength(1));
  });

  it("held: says why no card can start at the top", async () => {
    open([], { areasView: view([], { held: true, problem: "Two areas use the folder site/." }) });
    const line = await screen.findByText(/This repository's areas can't be used: Two areas use the folder site\/\. No card can start, ship or release/);
    expect(line.getAttribute("data-ply-area-problem")).toBe("held");
  });

  it("read-only: the values, no fields and no Add", async () => {
    open([APP, SITE], { readOnly: true });
    await waitFor(() => expect(document.body.textContent).toContain("Changing it needs write access"));
    expect(screen.queryByRole("button", { name: "Add an area" })).toBeNull();
    await editArea("Site");
    await screen.findByText("lyrappc-astro/");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add an area" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  // 1.174.0 (C10, D6; areas.html §1, §1b, solo): nothing shared — the page
  // works, the draft is saved on this Mac, and the page says where it stays.
  it("a repository that shares no settings: the page works and Save keeps the areas on this Mac", async () => {
    const saved = view([APP, SITE], { shared: false, keptHere: true });
    const r = open(null, { areasView: { ...view([]), shared: false, keptHere: false } });
    r.tauri.fixture("areas_save_local", () => saved);
    await screen.findByText("Kept on this Mac only.");
    // G3a walk: nowhere to share it — the header's mark says only where it is.
    expect(screen.queryByText("on this Mac until you share the project")).toBeNull();
    expect(screen.getAllByText("on this Mac").length).toBeGreaterThan(0);
    expect(screen.queryByText(/share them from the Board first/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Share it…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Suggest areas from this project" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add an area" }));
    const bar = await screen.findByRole("region", { name: "Changes not saved yet" });
    expect(bar.textContent).toContain("1 change · stays on this Mac only");
    // C10 walk: the bar's name agrees with its words, and no lone "Areas"
    // line sits under the list.
    expect(screen.queryByRole("region", { name: "Changes not published yet" })).toBeNull();
    expect(within(bar).queryByRole("button", { name: /^Publish/ })).toBeNull();
    // DS6 with C10 §1b: back on the list, the new area's row says so.
    backToAreas();
    expect(await screen.findByText("Changed here, not saved yet — there was no New area before.")).toBeTruthy();
    fireEvent.click(within(bar).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(r.tauri.callsOf("areas_save_local")).toHaveLength(1));
    const sent = r.tauri.callsOf("areas_save_local")[0].args as { workspaceId: string; areas: AreaDef[] };
    expect(sent.workspaceId).toBe(WS);
    expect(sent.areas.map((a) => a.id)).toEqual(["new-area"]);
    expect(sent.areas[0].tagPrefix, "the first area's prefix written out").toBe("");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Changes not saved yet" })).toBeNull());
    expect(r.tauri.callsOf("workspace_definition_save")).toHaveLength(0);
  });

  it("Discard drops the draft; a refused save keeps it and says why", async () => {
    const r = open(null, { areasView: { ...view([APP]), shared: false, keptHere: true } });
    r.tauri.fixture("areas_save_local", () => Promise.reject("Two areas are called “app”: each needs its own name."));
    await screen.findByText("Kept on this Mac only.");
    fireEvent.click(screen.getByRole("button", { name: "Add an area" }));
    let bar = await screen.findByRole("region", { name: "Changes not saved yet" });
    fireEvent.click(within(bar).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Changes not saved yet" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Add an area" }));
    bar = await screen.findByRole("region", { name: "Changes not saved yet" });
    fireEvent.click(within(bar).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.body.textContent).toContain("“Areas” couldn't be saved on this Mac."));
    expect(document.body.textContent).toContain("Two areas are called “app”");
    expect(screen.getByRole("region", { name: "Changes not saved yet" })).toBeTruthy();
  });

  // C10 round 0 (owner): leaving with an unsaved draft asks Save or Discard.
  it("leaving with unsaved areas asks once: Save saves then leaves, Discard leaves", async () => {
    const r = open(null, { areasView: { ...view([APP]), shared: false, keptHere: true } });
    r.tauri.fixture("areas_save_local", () => view([APP, SITE], { shared: false, keptHere: true }));
    await screen.findByText("Kept on this Mac only.");
    expect(hasLeaveGuard()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Add an area" }));
    await screen.findByRole("region", { name: "Changes not saved yet" });
    expect(hasLeaveGuard()).toBe(true);
    // On the new area's sub-page (its back link reads Areas).
    expect(screen.getByRole("button", { name: "Areas" })).toBeTruthy();
    let left = 0;
    act(() => leavePage(() => (left += 1)));
    let sheet = await screen.findByRole("dialog", { name: "Leave without saving your areas?" });
    // C10 round 1: the safe action, Save, has the focus.
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "Save" })));
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(left).toBe(1));
    expect(r.tauri.callsOf("areas_save_local")).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "Leave without saving your areas?" })).toBeNull();
    // G3a walk: left from the new area's sub-page, the move lands where the
    // person pressed — the list (the Settings sidebar's Areas), not the
    // sub-page.
    expect(screen.queryByRole("button", { name: "Areas" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add an area" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add an area" }));
    await screen.findByRole("region", { name: "Changes not saved yet" });
    act(() => leavePage(() => (left += 1)));
    sheet = await screen.findByRole("dialog", { name: "Leave without saving your areas?" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(left).toBe(2));
    expect(r.tauri.callsOf("areas_save_local")).toHaveLength(1);
    await waitFor(() => expect(hasLeaveGuard()).toBe(false));
  });

  // Round 1: until it is known whether Share is offered, neither line is said.
  it("holds the line and the bar until the sharing status lands", async () => {
    let land: (v: unknown) => void = () => {};
    open(null, {
      areasView: { ...view([APP]), shared: false, keptHere: true },
      adoption: () => new Promise((resolve) => (land = resolve)),
    });
    await screen.findByRole("button", { name: "Add an area" });
    fireEvent.click(screen.getByRole("button", { name: "Add an area" }));
    await act(async () => {});
    expect(screen.queryByText(/Kept on this Mac/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Changes not saved yet" })).toBeNull();
    await act(async () => land({ githubRepo: "o/lyra", hasDefinition: false, action: { kind: "ask" } }));
    expect((await screen.findByRole("region", { name: "Changes not saved yet" })).textContent).toContain(
      "stays on this Mac until you share this project's setup",
    );
    backToAreas();
    expect(await screen.findByText(/Kept on this Mac until you share this project's setup\./)).toBeTruthy();
  });

  // Areas round 1: the refused save's whole story, the raw text behind
  // Details, and no filled button but the bar's Save.
  it("a refused save shows its raw reason behind Details, with no way out of its own", async () => {
    const r = open(null, { areasView: { ...view([APP]), shared: false, keptHere: true } });
    r.tauri.fixture("areas_save_local", () => Promise.reject("rename: Operation not permitted (os error 1)"));
    fireEvent.click(await screen.findByRole("button", { name: "Add an area" }));
    const bar = await screen.findByRole("region", { name: "Changes not saved yet" });
    fireEvent.click(within(bar).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.body.textContent).toContain("“Areas” couldn't be saved on this Mac."));
    // Said once: the error block has the story, the bar points at it.
    expect(document.body.textContent!.split("“Areas” couldn't be saved on this Mac.")).toHaveLength(2);
    expect(within(bar).getByText("Not saved; see above.")).toBeTruthy();
    fireEvent.click(screen.getByText("Details"));
    expect(await screen.findByText(/Operation not permitted \(os error 1\)/)).toBeTruthy();
    expect(document.querySelectorAll(".cbtn--accent")).toHaveLength(1);
  });

  // Areas round 1: kept here with no origin, Cards go to offers this
  // computer's branches, and never says there's nowhere to publish.
  it("kept here with no origin: Cards go to offers this computer's branches", async () => {
    const r = open(null, {
      areasView: { ...view([APP, SITE]), shared: false, keptHere: true },
      branches: { branches: [], localBranches: ["staging", "main", "site-preview"], defaultBranch: "main", error: null, hasOrigin: false },
    });
    r.tauri.fixture("areas_save_local", () => view([APP, SITE], { shared: false, keptHere: true }));
    await editArea("Site");
    const select = (await screen.findByRole("combobox", { name: "Site: Cards go to" })) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect([...select.options].map((o) => o.value)).toContain("site-preview");
    expect(document.body.textContent).not.toContain("nowhere to publish");
    fireEvent.change(select, { target: { value: "site-preview" } });
    expect(await screen.findByRole("region", { name: "Changes not saved yet" })).toBeTruthy();
  });

  it("kept here with origin read: Cards go to offers origin's branches and this computer's", async () => {
    open(null, {
      areasView: { ...view([APP, SITE]), shared: false, keptHere: true },
      branches: { branches: ["main", "release"], localBranches: ["main", "site-preview"], defaultBranch: "main", error: null, hasOrigin: true },
    });
    await editArea("Site");
    const select = (await screen.findByRole("combobox", { name: "Site: Cards go to" })) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    const values = [...select.options].map((o) => o.value);
    expect(values).toContain("release");
    expect(values).toContain("site-preview");
    expect(values.filter((v) => v === "main")).toHaveLength(1);
  });

  it("no branch list at all: Cards go to is a text field", async () => {
    open(null, {
      areasView: { ...view([APP, SITE]), shared: false, keptHere: true },
      branches: { branches: [], localBranches: [], defaultBranch: "main", error: "offline", hasOrigin: true },
    });
    await editArea("Site");
    expect(((await textbox("Site: Cards go to")) as HTMLInputElement).value).toBe("main");
    expect(document.body.textContent).not.toContain("nowhere to publish");
  });

  it("where sharing is possible: the line says until you share, and Share it… brings the Share", async () => {
    open(null, {
      areasView: { ...view([APP, SITE]), shared: false, keptHere: true },
      adoption: () => ({ githubRepo: "o/lyra", hasDefinition: false, action: { kind: "ask" } }),
    });
    await screen.findByText(/Kept on this Mac until you share this project's setup\./);
    fireEvent.click(screen.getByRole("button", { name: "Share it…" }));
    const region = await screen.findByRole("region", { name: "Share the setup" });
    expect(region.textContent).toContain("Also shares the areas kept on this Mac: App, Site.");
    expect(within(region).getByRole("button", { name: "Share the setup" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add an area" }));
    const bar = await screen.findByRole("region", { name: "Changes not saved yet" });
    expect(bar.textContent).toContain("1 change · stays on this Mac until you share this project's setup");
    // C10 round 1: Share is off while the draft is unsaved, and says why beside it.
    const share = within(region).getByRole("button", { name: "Share the setup" }) as HTMLButtonElement;
    expect(share.disabled).toBe(true);
    const why = document.getElementById(share.getAttribute("aria-describedby")!);
    expect(why?.textContent).toBe("Save your areas first.");
  });

  // C10 round 1: until the areas are read, only the page's head is drawn —
  // never the shared layout first.
  // C10 round 3: a read that fails says so, with Try again.
  it("a failed areas read says so with Try again, which reads them again", async () => {
    let calls = 0;
    open(null, {
      areasView: (() => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("git: not a repository")) : view([APP], { shared: false, keptHere: true });
      }) as never,
    });
    expect(await screen.findByText("The areas couldn't be loaded.")).toBeTruthy();
    expect(screen.queryByText("Reading this project's areas…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Kept on this Mac only.")).toBeTruthy();
    expect(calls).toBe(2);
  });

  it("until the areas are read, only the page head, then the kept-here page", async () => {
    let land: (v: unknown) => void = () => {};
    open(null, { areasView: (() => new Promise((resolve) => (land = resolve))) as never });
    await screen.findByRole("heading", { name: "Areas" });
    await act(async () => {});
    expect(screen.getByText("Reading this project's areas…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add an area" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    await act(async () => land({ ...view([APP]), shared: false, keptHere: true }));
    expect(await screen.findByText("Kept on this Mac only.")).toBeTruthy();
  });

  // 1.174.0 (C11, P15; next-improvement.html §5): the first save of two or
  // more areas asks about the direction written before them.
  const BEFORE = {
    direction: {
      schemaVersion: 1,
      audience: "Italian and English PPC agencies that run Google Ads.",
      better: "They start a trial without help.",
      avoid: "",
      lookAt: "",
      approaches: ["polish"],
      rejected: [1, 2, 3, 4, 5].map((n) => ({ title: `Idea ${n}`, reason: "no", at: n })),
    },
    areas: ["app", "site"],
  };

  it("kept here: the first save of two areas asks, Use it for both has the focus and copies into both", async () => {
    const r = open(null, { areasView: { ...view([APP]), shared: false, keptHere: true } });
    r.tauri.fixture("areas_save_local", () => view([APP, SITE], { shared: false, keptHere: true }));
    r.tauri.fixture("ni_direction_project", () => BEFORE);
    r.tauri.fixture("ni_direction_adopt_project", () => ["app", "site"]);
    await screen.findByText("Kept on this Mac only.");
    fireEvent.click(screen.getByRole("button", { name: "Add an area" }));
    const bar = await screen.findByRole("region", { name: "Changes not saved yet" });
    fireEvent.click(within(bar).getByRole("button", { name: "Save" }));
    const sheet = await screen.findByRole("dialog", { name: "Use the project's direction for App and Site?" });
    expect(sheet.textContent).toContain(
      "You wrote a direction for the whole project before it had areas: “Italian and English PPC agencies…”, with 5 ideas not to propose again.",
    );
    expect(sheet.textContent).toContain(
      "Each area gets its own copy, which you can change on its own. Start fresh: each area asks for its direction the first time.",
    );
    expect(sheet.textContent).not.toMatch(/default/i);
    const both = within(sheet).getByRole("button", { name: "Use it for both" });
    await waitFor(() => expect(document.activeElement).toBe(both));
    expect(both.className).toContain("cbtn--accent");
    expect(within(sheet).getByRole("button", { name: "Start fresh" }).className).not.toContain("cbtn--accent");
    fireEvent.click(both);
    await waitFor(() => expect(r.tauri.callsOf("ni_direction_adopt_project")).toHaveLength(1));
    expect(r.tauri.callsOf("ni_direction_adopt_project")[0].args).toEqual({ workspaceId: WS, areas: ["app", "site"], direction: null });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Start fresh writes nothing; a later save with two or more areas doesn't ask again", async () => {
    const r = open(null, { areasView: { ...view([APP]), shared: false, keptHere: true } });
    r.tauri.fixture("areas_save_local", () => view([APP, SITE], { shared: false, keptHere: true }));
    r.tauri.fixture("ni_direction_project", () => BEFORE);
    await screen.findByText("Kept on this Mac only.");
    fireEvent.click(screen.getByRole("button", { name: "Add an area" }));
    let bar = await screen.findByRole("region", { name: "Changes not saved yet" });
    fireEvent.click(within(bar).getByRole("button", { name: "Save" }));
    const sheet = await screen.findByRole("dialog", { name: "Use the project's direction for App and Site?" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Start fresh" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(r.tauri.callsOf("ni_direction_adopt_project")).toHaveLength(0);
    // Two areas saved already: a third is no first save of two.
    backToAreas();
    fireEvent.click(screen.getByRole("button", { name: "Add an area" }));
    bar = await screen.findByRole("region", { name: "Changes not saved yet" });
    fireEvent.click(within(bar).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(r.tauri.callsOf("areas_save_local")).toHaveLength(2));
    expect(r.tauri.callsOf("ni_direction_project")).toHaveLength(1);
  });

  it("Save from the leave guard leaves the page and still asks", async () => {
    const r = open(null, { areasView: { ...view([APP]), shared: false, keptHere: true } });
    r.tauri.fixture("areas_save_local", () => view([APP, SITE], { shared: false, keptHere: true }));
    r.tauri.fixture("ni_direction_project", () => BEFORE);
    await screen.findByText("Kept on this Mac only.");
    fireEvent.click(screen.getByRole("button", { name: "Add an area" }));
    await screen.findByRole("region", { name: "Changes not saved yet" });
    act(() => leavePage(() => leaveAreas()));
    const leave = await screen.findByRole("dialog", { name: "Leave without saving your areas?" });
    fireEvent.click(within(leave).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByText("Kept on this Mac only.")).toBeNull());
    expect(await screen.findByRole("dialog", { name: "Use the project's direction for App and Site?" })).toBeTruthy();
  });

  it("an ask for another workspace waits until it is the active one, and goes with it", async () => {
    open([APP, SITE]);
    await screen.findByRole("button", { name: "Edit Site…" });
    act(() => {
      onWorkspace("other");
      onWorkspace(WS);
      useNextImprovement.setState({ adoptAsk: { workspaceId: "other", ask: BEFORE } });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => onWorkspace("other"));
    expect(await screen.findByRole("dialog", { name: /^Use the project's direction for/ })).toBeTruthy();
    // Removed: its ask goes too.
    act(() => useWorkspaces.setState((s) => ({ activeId: WS, workspaces: s.workspaces.filter((w) => w.id !== "other") })));
    await waitFor(() => expect(useNextImprovement.getState().adoptAsk).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("no direction written before the areas: no sheet", async () => {
    const r = open(null, { areasView: { ...view([APP]), shared: false, keptHere: true } });
    r.tauri.fixture("areas_save_local", () => view([APP, SITE], { shared: false, keptHere: true }));
    r.tauri.fixture("ni_direction_project", () => null);
    await screen.findByText("Kept on this Mac only.");
    fireEvent.click(screen.getByRole("button", { name: "Add an area" }));
    const bar = await screen.findByRole("region", { name: "Changes not saved yet" });
    fireEvent.click(within(bar).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(r.tauri.callsOf("ni_direction_project")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shared: the publish that makes two areas asks too", async () => {
    const r = open([APP]);
    r.tauri.fixture("ni_direction_project", () => BEFORE);
    fireEvent.click(await screen.findByRole("button", { name: "Add an area" }));
    fireEvent.change(await textbox("New area: Folder"), { target: { value: "site" } });
    fireEvent.click(await screen.findByRole("button", { name: "Publish to staging" }));
    await waitFor(() => expect(r.tauri.callsOf("workspace_definition_save")).toHaveLength(1));
    expect(await screen.findByRole("dialog", { name: /^Use the project's direction for/ })).toBeTruthy();
  });
});
