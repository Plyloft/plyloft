// 1.173.0 (G1): Settings › Shipping (mockup needs-and-shipping.html scene 3).
// 1.174.0 (DS2; settings.html scenes 3, 4, 15): the whole path of a card
// after the build — Where cards go (Cards go to, moved from Build and
// release), Ship it (How Ship it ships and Fix failing checks, this Mac's),
// After shipping (After a release, run), Card branches (the cleanup and the
// branches it kept, moved from Cards' copies), Releases (each area's default
// release, or the repository's, and the version files) and How this goes
// live — one draft, published on its own; and the old places say nothing.
import { describe, expect, it } from "vitest";
import { ProjectShareableContext } from "../components/ux";
import { ShippingPage } from "../components/settings/ShippingPage";
import { RepositoryBuildRelease, RepositoryGeneral } from "../components/RepositorySettings";
import { BoardPage } from "../components/settings/BoardPage";
import { WorktreesPage } from "../components/settings/WorktreesPage";
import { SettingsOverlay } from "../components/SettingsOverlay";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { changeSetUpAction } from "../store/uiStore";
import type { AreaDef, AreasView, DeployMap, ProjectConfig, ResolvedArea } from "../ipc";
import { useAreas } from "../store/areaStore";
import { useAccount } from "../store/accountStore";
import { useKanban } from "../store/kanbanStore";
import { useWorkMode } from "../store/workModeStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { act, renderUi, screen, waitFor, within } from "./render";
import { putDone } from "../store/putOnGithubStore";
import { setTeamAllowed } from "./planGates";

const WS = "ws";

const config: ProjectConfig = {
  schemaVersion: 2,
  targetBranch: "main",
  versionFiles: [],
  installScript: null,
  verifyPipeline: null,
  createdAt: 0,
  updatedAt: 0,
};

const APP: AreaDef = { id: "app", name: "App", path: "", targetBranch: "staging" };
const SITE: AreaDef = { id: "site", name: "Site", path: "lyrappc-astro", targetBranch: "main", releaseKind: "push_only" };

function resolved(a: AreaDef, index: number): ResolvedArea {
  return {
    id: a.id,
    name: a.name,
    path: a.path,
    root: a.path === "",
    first: index === 0,
    targetBranch: a.targetBranch ?? null,
    branch: a.targetBranch ?? "main",
    versionFiles: null,
    tagPrefix: index === 0 ? "" : `${a.id}-`,
    label: `area:${a.id}`,
    lookAt: null,
    releaseKind: a.releaseKind ?? null,
  };
}

function areasView(areas: AreaDef[], extra: Partial<AreasView> = {}): AreasView {
  return {
    shared: true,
    readOnly: false,
    defined: areas,
    areas: areas.map(resolved),
    workspaceBranch: "main",
    check: { errors: [], warnings: [] },
    problem: null,
    held: false,
    releaseKind: null,
    ...extra,
  };
}

const nothingMap: DeployMap = {
  repo: "acme/lyra",
  railway: { state: "noCli", project: null, services: [], message: null, readAt: null },
  workflows: [],
};

function seed(extra: Record<string, unknown> = {}, cards: unknown[] = []) {
  act(() => {
    useKanban.setState({ byWorkspace: { [WS]: { cards } } } as never);
    useAccount.setState({ gates: null });
    useWorkspaces.setState({
      workspaces: [
        { id: WS, name: "lyra", cwd: "/r", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null, ...extra },
      ],
      activeId: WS,
    });
    useAreas.setState({ views: {} });
  });
}

function open(opts: {
  overlay?: boolean;
  shared?: boolean;
  areas?: AreaDef[] | null;
  releaseKind?: string | null;
  offersPr?: boolean | (() => unknown);
  map?: DeployMap;
  view?: AreasView;
  workspace?: Record<string, unknown>;
  cards?: unknown[];
  installScript?: string | null;
  readOnly?: boolean;
  provenance?: Record<string, unknown>;
  pending?: Record<string, unknown>;
  /** G3a walk: the project can't be shared at all (solo, no GitHub). */
  shareable?: boolean;
  /** 1.175.0 F3: `put_on_github_preview` (a project only here) and
   *  `setup_github_status`. */
  preview?: unknown;
  github?: unknown;
  /** `workspace_definition_branches`. */
  branches?: unknown;
}) {
  seed(opts.workspace, opts.cards);
  const shared = opts.shared ?? true;
  const definition = {
    schemaVersion: 1,
    name: "LYRA",
    board: "local",
    integrationBranch: "main",
    versionFiles: [],
    installScript: opts.installScript ?? null,
    areas: opts.areas ?? null,
    releaseKind: shared ? (opts.releaseKind ?? null) : undefined,
  };
  const definitionView = shared
    ? {
        cache: { definition, branch: "main", author: "Matteo", changedAt: null, pending: opts.pending ?? {} },
        effective: definition,
        defaultBranch: "main",
        queue: { createDefinition: false, fields: {}, createPullRequest: null, lastError: null },
        readOnly: opts.readOnly ?? false,
        provenance: opts.provenance,
      }
    : null;
  if (opts.overlay) useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true } as never);
  const page = opts.overlay ? <SettingsOverlay /> : <ShippingPage workspaceId={WS} scope="repository" />;
  const r = renderUi(
    opts.shareable === false ? <ProjectShareableContext.Provider value={false}>{page}</ProjectShareableContext.Provider> : page,
    {
    withToasts: true,
    fixtures: {
      settings_get: () => DEFAULT_SETTINGS,
      settings_set: ({ settings }: Record<string, unknown>) => settings,
      workspace_definition_get: definitionView,
      project_config_get: config,
      project_review_get: { selfCheck: true, reviewChecklist: [] },
      worktree_settings_get: {},
      workspace_definition_branches: opts.branches ?? { branches: ["main", "staging"], defaultBranch: "main", error: null, hasOrigin: true },
      project_config_detect: { config: { ...config, installScript: "scripts/install.sh" }, hasClaudeMd: false, notes: [] },
      project_config_set: null,
      areas_get:
        opts.view ??
        (shared
          ? areasView(opts.areas ?? [], { releaseKind: (opts.releaseKind as AreasView["releaseKind"]) ?? null })
          : { ...areasView([], { shared: false }), releaseKind: opts.releaseKind ?? null }),
      areas_releases: [
        { id: "site", tagPrefix: "site-", latestTag: "site-v3.0.1", version: "3.0.1" },
        { id: "default", tagPrefix: "", latestTag: "v1.4.0", version: "1.4.0" },
      ],
      deploy_map_get: opts.map ?? nothingMap,
      workspace_ship_offers_pr: opts.offersPr ?? true,
      workspace_set_ship_via: null,
      workspace_set_merge_when_checks_pass: null,
      workspace_set_fix_failing_checks: () => 1,
      workspace_set_delete_card_branches: null,
      workspace_definition_save: () => definitionView,
      release_kind_set: null,
      ...(opts.preview !== undefined ? { put_on_github_preview: opts.preview } : {}),
      ...(opts.github !== undefined ? { setup_github_status: opts.github } : {}),
    },
  },
  );
  r.tauri.allowUnhandled();
  return r;
}

describe("Settings › Shipping › in the order things happen (1.174.0, DS2)", () => {
  it("draws Where cards go · Ship it · After shipping · Card branches · Releases · How this goes live, each with its mark", async () => {
    open({});
    await screen.findByRole("combobox", { name: "Cards go to" });
    const titles = [...document.querySelectorAll(".ux-section-title")].map((h) => h.textContent);
    expect(titles).toEqual(["Where cards go", "Ship it", "After shipping", "Card branches", "Releases", "How this goes live"]);
    expect(screen.getByText("Where a card's change goes, how it leaves this Mac, and how it goes live.")).toBeTruthy();
    // The project's rows say they are shared; this Mac's say so.
    expect(screen.getAllByText("shared with the project")).toHaveLength(4);
    expect(screen.getAllByText("on this Mac")).toHaveLength(2);
    // SL-5: no Merge when checks pass row; its sentence is How Ship it ships'.
    expect(screen.queryByText("Merge when checks pass")).toBeNull();
    await waitFor(() =>
      expect(
        screen.getByText(
          "Ship it opens a pull request on GitHub and merges it once GitHub's checks pass and the Reviewer approved. To merge it yourself, choose “pull request only” in Ship ▾.",
        ),
      ).toBeTruthy(),
    );
  });

  it("Ship it holds How Ship it ships and Fix failing checks, saved on this Mac as they change", async () => {
    const { user, tauri } = open({});
    const select = (await screen.findByRole("combobox", { name: "How Ship it ships" })) as HTMLSelectElement;
    expect(select.value).toBe("github");
    await user.selectOptions(select, "local");
    await waitFor(() => expect(tauri.callsOf("workspace_set_ship_via")).toHaveLength(1));
    expect(tauri.callsOf("workspace_set_ship_via")[0].args).toEqual({ id: WS, via: "local" });
    expect(tauri.callsOf("workspace_set_merge_when_checks_pass")).toHaveLength(0);

    await user.click(screen.getByRole("switch", { name: "Fix failing checks by itself" }));
    await waitFor(() => expect(tauri.callsOf("workspace_set_fix_failing_checks")).toHaveLength(1));
    expect(tauri.callsOf("workspace_set_fix_failing_checks")[0].args).toEqual({ id: WS, on: true });
    expect(screen.getByText(/the Builder fixes them and the Reviewer checks the fix; up to 3 tries\. The default for new cards; each card can turn it on or off\./)).toBeTruthy();

    const branches = screen.getByRole("switch", { name: "Delete card branches when their trash expires" });
    expect(branches.getAttribute("aria-checked")).toBe("true");
    await user.click(branches);
    await waitFor(() => expect(tauri.callsOf("workspace_set_delete_card_branches")).toHaveLength(1));
    expect(tauri.callsOf("workspace_set_delete_card_branches")[0].args).toEqual({ id: WS, on: false });
    expect(screen.getByText(/never one checked out\. Archived cards' branches are asked about in the Inbox first\./)).toBeTruthy();
    expect(tauri.callsOf("workspace_definition_save")).toHaveLength(0);
  });

  it("a project that can't take a pull request says Ship it lands here", async () => {
    // On another host: the preview refuses it.
    open({ offersPr: false, preview: () => Promise.reject(new Error("This project already sends its changes to another copy")) });
    await waitFor(() => expect(screen.getByText(/This project isn't on GitHub, so Ship it merges the card on this Mac/)).toBeTruthy());
    // X6 (G1 Windows walk): the field shows what happens — only here — and
    // is off; fixing a pull request's checks can't apply, so it isn't shown.
    const via = screen.getByRole("combobox", { name: "How Ship it ships" }) as HTMLSelectElement;
    expect(via.value).toBe("local");
    expect(via.disabled).toBe(true);
    // 1.175.0 F3: fixing a pull request's checks can't apply — shown off,
    // with why.
    await waitFor(() => expect(screen.getByText("For projects on GitHub.")).toBeTruthy());
    expect((screen.getByRole("switch", { name: "Fix failing checks by itself" }) as HTMLInputElement).disabled).toBe(true);
    // On another host (the preview refuses): no Put it on GitHub….
    expect(screen.queryByRole("button", { name: /Put it on GitHub|Connect GitHub first/ })).toBeNull();
  });

  it("1.175.0 F3: a project only on this Mac offers Put it on GitHub… beside How Ship it ships", async () => {
    open({
      offersPr: false,
      preview: () => ({ branch: "main", commits: 42, unsavedFiles: 0, name: "lyra" }),
      github: () => ({ accounts: [{ login: "octocat", active: true, state: "signed-in", scopes: null }] }),
    });
    await waitFor(() =>
      expect(
        screen.getByText(
          "This project is only on this Mac, so Ship it merges the card here. Put it on GitHub to ship cards as pull requests.",
        ),
      ).toBeTruthy(),
    );
    expect(await screen.findByRole("button", { name: "Put it on GitHub…" })).toBeTruthy();
  });

  // F3 walk: after the put, Where cards go still said the project wasn't
  // online until the page was opened again.
  it("1.175.0 F3: Where cards go reads the branches again after Put it on GitHub", async () => {
    let online = false;
    open({
      offersPr: false,
      shared: false,
      branches: () =>
        online
          ? { branches: ["main"], defaultBranch: "main", error: null, hasOrigin: true }
          : { branches: [], defaultBranch: "", error: null, hasOrigin: false },
    });
    await waitFor(() => expect(screen.getByText(/this project isn't online/)).toBeTruthy());
    online = true;
    act(() => putDone(WS, "octocat/lyra"));
    await waitFor(() => expect(screen.queryByText(/this project isn't online/)).toBeNull());
  });

  it("1.175.0 F3: GitHub not connected, the press is Connect GitHub first", async () => {
    open({
      offersPr: false,
      preview: () => ({ branch: "main", commits: 42, unsavedFiles: 0, name: "lyra" }),
      github: () => ({ accounts: [] }),
    });
    expect(await screen.findByRole("button", { name: "Connect GitHub first" })).toBeTruthy();
  });

  // X6 round 1: only a known "not on GitHub" hides and turns off — a reading
  // that fails, or hasn't answered yet, leaves both rows as they are.
  for (const [what, offersPr] of [
    ["fails", () => Promise.reject(new Error("no folder"))],
    ["never answers", () => new Promise(() => {})],
  ] as const) {
    it(`keeps Fix failing checks and an enabled How Ship it ships when the reading ${what}`, async () => {
      open({ offersPr });
      const via = (await screen.findByRole("combobox", { name: "How Ship it ships" })) as HTMLSelectElement;
      await act(async () => {});
      expect(via.disabled).toBe(false);
      expect(via.value).toBe("github");
      expect(screen.getByText("Fix failing checks by itself")).toBeTruthy();
    });
  }

  it("Cards go to, After a release, run and the default release go out in one publish, and only they", async () => {
    const { user, tauri } = open({ releaseKind: "push_only" });
    const branch = (await screen.findByRole("combobox", { name: "Cards go to" })) as HTMLSelectElement;
    expect(screen.getByText("The branch every card's change goes to, and new cards start from.")).toBeTruthy();
    await waitFor(() => expect(branch.disabled).toBe(false));
    await user.selectOptions(branch, "staging");
    const after = screen.getByRole("combobox", { name: "After a release, run" }) as HTMLSelectElement;
    // W6: the empty choice is Nothing; the scan's script is offered.
    expect(within(after).getByRole("option", { name: "Nothing" })).toBeTruthy();
    await waitFor(() => expect(within(after).getByRole("option", { name: "scripts/install.sh" })).toBeTruthy());
    await user.selectOptions(after, "scripts/install.sh");
    await user.selectOptions(screen.getByRole("combobox", { name: "Default release" }), "github");
    await user.click(await screen.findByRole("button", { name: /^Review/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Review 3 changes")).toBeTruthy();
    expect(within(sheet).getByText(/chore\(config\): “Cards go to” — main → staging/)).toBeTruthy();
    expect(within(sheet).getByText(/chore\(config\): “After a release, run” — none → scripts\/install\.sh/)).toBeTruthy();
    await user.click(within(sheet).getByRole("button", { name: "Publish to main" }));
    await waitFor(() => expect(tauri.callsOf("workspace_definition_save")).toHaveLength(1));
    const draft = tauri.callsOf("workspace_definition_save")[0].args.draft as Record<string, unknown>;
    expect([draft.integrationBranch, draft.installScript, draft.releaseKind]).toEqual(["staging", "scripts/install.sh", "github"]);
    // Nothing was saved on this Mac: a shared page publishes.
    expect(tauri.callsOf("project_config_set")).toHaveLength(0);
  });

  // 1.175.0 (C3, SC-3): a field drafted here that a teammate changed in the
  // repository meanwhile is said on its row and in Review, and the save
  // carries what it was changed from as its base — the publish then asks.
  it("C3: a drafted Cards go to the repository moved meanwhile is said, and the save says what it was changed from", async () => {
    const { user, tauri } = open({});
    const branch = (await screen.findByRole("combobox", { name: "Cards go to" })) as HTMLSelectElement;
    await waitFor(() => expect(branch.disabled).toBe(false));
    await user.selectOptions(branch, "staging");
    expect(await screen.findByText("Changed here, not published yet — was main.")).toBeTruthy();

    // Giulia publishes `release`; this computer's read applies it.
    const moved = {
      schemaVersion: 1, name: "LYRA", board: "local", integrationBranch: "release", versionFiles: [], installScript: null, areas: null, releaseKind: null,
    };
    tauri.fixture("workspace_definition_get", {
      cache: { definition: moved, branch: "main", author: "example-teammate", changedAt: Math.floor(Date.now() / 1000) - 240, pending: {} },
      effective: moved,
      defaultBranch: "main",
      queue: { createDefinition: false, fields: {}, createPullRequest: null, lastError: null },
      readOnly: false,
    });
    act(() => tauri.emit("workspace-definition://edited", WS));
    expect(
      await screen.findByText(
        "Changed here, and example-teammate changed it in the repository meanwhile: it is release there now. Publish asks which to keep.",
      ),
    ).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: /^Review/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(/example-teammate set it to release 4 min ago; Publish asks which to keep\./)).toBeTruthy();
    await user.click(within(sheet).getByRole("button", { name: "Publish to main" }));
    await waitFor(() => expect(tauri.callsOf("workspace_definition_save")).toHaveLength(1));
    const call = tauri.callsOf("workspace_definition_save")[0].args as { base: Record<string, unknown>; draft: Record<string, unknown> };
    expect(call.base.integrationBranch).toBe("main");
    expect(call.draft.integrationBranch).toBe("staging");
  });

  // 1.175.0 (C4, SC-7): a sign-in that failed is said as such, with its press.
  it("C4: a publish git couldn't sign in for says so, with Open GitHub setup, never offline", async () => {
    const { user, tauri } = open({ pending: { integrationBranch: "staging" } });
    tauri.fixture("workspace_definition_get", {
      cache: { definition: { schemaVersion: 1, name: "LYRA", board: "local", integrationBranch: "main", versionFiles: [], installScript: null, areas: null, releaseKind: null }, source: "repo", branch: "main", author: "Matteo", changedAt: null, pending: { integrationBranch: "staging" } },
      effective: { schemaVersion: 1, name: "LYRA", board: "local", integrationBranch: "staging", versionFiles: [], installScript: null, areas: null, releaseKind: null },
      defaultBranch: "main",
      queue: {
        createDefinition: false,
        fields: { integrationBranch: { pullRequest: null } },
        createPullRequest: null,
        lastError: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        lastOffline: false,
        lastErrorKind: { kind: "gitSignIn" },
      },
      readOnly: false,
    });
    act(() => tauri.emit("workspace-definition://edited", WS));
    expect(await screen.findByText("Not published — Git couldn't sign in to GitHub")).toBeTruthy();
    expect(screen.queryByText(/you're offline/)).toBeNull();
    expect(screen.getByText(/Git couldn't sign in to GitHub, so Plyloft can't write it right now\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open GitHub setup" })).toBeTruthy();
    void user;
  });

  // G3a walk: a project with nowhere to share it never says "until you
  // share the project" — on this page as on Areas.
  it("a project that can't be shared: every project mark says on this Mac", async () => {
    open({ shared: false, releaseKind: null, shareable: false });
    await screen.findByRole("combobox", { name: "Cards go to" });
    expect(screen.queryByText("on this Mac until you share the project")).toBeNull();
    expect(screen.getAllByText("on this Mac").length).toBeGreaterThanOrEqual(4);
  });

  it("not shared: Cards go to saves at once, and its section says it stays here until the project is shared", async () => {
    const { user, tauri } = open({ shared: false, releaseKind: null });
    const branch = (await screen.findByRole("combobox", { name: "Cards go to" })) as HTMLSelectElement;
    expect(screen.getAllByText("on this Mac until you share the project")).toHaveLength(4);
    await waitFor(() => expect(branch.disabled).toBe(false));
    await user.selectOptions(branch, "staging");
    await waitFor(() => expect(tauri.callsOf("project_config_set")).toHaveLength(1));
    expect((tauri.callsOf("project_config_set")[0].args.config as ProjectConfig).targetBranch).toBe("staging");
    expect(screen.queryByRole("button", { name: /Publish to/ })).toBeNull();
    expect(await screen.findByText("“Cards go to” set on this Mac")).toBeTruthy();
  });

  it("with two areas, Cards go to says each area's and is changed in Areas", async () => {
    const { user } = open({ areas: [APP, SITE] });
    expect(await screen.findByText("Each area has its own: App → staging · Site → main.")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Cards go to" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Change in Areas" }));
    expect(useUi.getState().settingsSection).toBe("areas");
  });

  it("Version files opens its sub-page here", async () => {
    const { user } = open({});
    const row = await screen.findByRole("button", { name: /Version files/ });
    await user.click(row);
    expect(await screen.findByRole("button", { name: /Shipping/ })).toBeTruthy();
    expect(screen.getByText(/bumped together on every release/)).toBeTruthy();
  });

  it("Kept after shipping: Show N opens the branches the cleanup kept, only when there are some", async () => {
    const kept = (id: string, title: string) => ({
      id,
      title,
      columnId: "complete",
      branchName: null,
      branchCleanup: { branch: `ply/${id}`, tip: "abc", reason: "shipped", since: 1, outcome: "movedOn" },
    });
    const { user } = open({ cards: [kept("c1", "Pricing page"), kept("c2", "Footer")] });
    expect(
      await screen.findByText(
        "2 branches with commits made after they shipped. On GitHub, Plyloft deletes only a card's own branch, once its pull request merged.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show 2" }));
    expect(await screen.findByText("Pricing page")).toBeTruthy();
    expect(screen.getByText("Footer")).toBeTruthy();
    expect(screen.getByText(/Automatically delete head branches/)).toBeTruthy();
  });

  it("no kept branch, no Kept after shipping row", async () => {
    open({});
    await screen.findByRole("switch", { name: "Delete card branches when their trash expires" });
    expect(screen.queryByText("Kept after shipping")).toBeNull();
  });

  it("on Free, Default release says the same as on every plan, and nothing on the page names a plan", async () => {
    open({ releaseKind: null });
    act(() => useAccount.setState({ gates: { teamAllowed: false } as never }));
    expect(await screen.findByText("v1.4.0 · cards go to main")).toBeTruthy();
    expect(screen.queryByText(/Pro\b|On Free/)).toBeNull();
  });
});

describe("Settings › Shipping › Releases", () => {
  it("each area has its default release kind, with its latest tag and where its cards go, published with the areas", async () => {
    const { user, tauri } = open({ areas: [APP, SITE] });
    const site = (await screen.findByRole("combobox", { name: "Site: default release" })) as HTMLSelectElement;
    const app = screen.getByRole("combobox", { name: "App: default release" }) as HTMLSelectElement;
    expect(site.value).toBe("push_only");
    expect(screen.getByText("Releases")).toBeTruthy();
    expect(screen.getByText("Where Release… starts for each area; each release can still choose.")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("site-v3.0.1 · cards go to main")).toBeTruthy());
    // 1.174.0 (A1, SL-1c): App chose nothing, so it follows How Ship it
    // ships — on GitHub here — and says so; Site's own choice says nothing.
    await waitFor(() =>
      expect(within(app).getByRole("option", { name: "Same as Ship it (Put the version on GitHub)" })).toBeTruthy(),
    );
    expect(app.value).toBe("follow");
    expect(within(app).getByRole("option", { name: "Same as Ship it (Put the version on GitHub)" })).toBeTruthy();

    await user.selectOptions(app, "github");
    await user.click(await screen.findByRole("button", { name: "Publish to main" }));
    await waitFor(() => expect(tauri.callsOf("workspace_definition_save")).toHaveLength(1));
    const draft = tauri.callsOf("workspace_definition_save")[0].args.draft as { areas: AreaDef[] };
    expect(draft.areas.map((a) => [a.id, a.releaseKind ?? null])).toEqual([
      ["app", "github"],
      ["site", "push_only"],
    ]);
    // Only the kind changed: every other key of each area is as it was.
    expect(draft.areas[1]).toEqual(SITE);
  });

  it("one listed area is the whole repository's: one Default release row, written on the area", async () => {
    const { user, tauri } = open({ areas: [SITE] });
    const select = (await screen.findByRole("combobox", { name: "Default release" })) as HTMLSelectElement;
    expect(select.value).toBe("push_only");
    expect(screen.queryByText("Where Release… starts for each area; each release can still choose.")).toBeNull();
    await user.selectOptions(select, "github");
    await user.click(await screen.findByRole("button", { name: "Publish to main" }));
    await waitFor(() => expect(tauri.callsOf("workspace_definition_save")).toHaveLength(1));
    const draft = tauri.callsOf("workspace_definition_save")[0].args.draft as { areas: AreaDef[]; releaseKind?: string };
    expect(draft.areas[0].releaseKind).toBe("github");
    expect(draft.releaseKind ?? null).toBeNull();
  });

  it("a change of the areas on its way marks the first row, once", async () => {
    open({ areas: [APP, SITE], pending: { areas: [APP, { ...SITE, releaseKind: "github" }] } });
    await screen.findByRole("combobox", { name: "Site: default release" });
    await waitFor(() => expect(screen.getAllByLabelText("Waiting to publish")).toHaveLength(1));
    const first = document.getElementById("ux-repo-row-areas")!;
    expect(within(first).getByLabelText("Waiting to publish")).toBeTruthy();
  });

  it("Review says the default release kind, not the areas", async () => {
    const { user } = open({ areas: [APP, SITE] });
    const app = (await screen.findByRole("combobox", { name: "App: default release" })) as HTMLSelectElement;
    await user.selectOptions(app, "push_only");
    await user.click(await screen.findByRole("button", { name: /^Review/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("App's default release: Put the version on GitHub. Each release can still choose.")).toBeTruthy();
    expect(within(sheet).queryByText(/2 areas/)).toBeNull();
  });

  it("a Mac that can't publish reads who set the areas on each row", async () => {
    open({
      areas: [APP, SITE],
      readOnly: true,
      // Two people: no one footer line speaks for the page, so each row says.
      provenance: {
        areas: { author: "Ana", changedAt: 1_700_000_000 },
        releaseKind: { author: "Bo", changedAt: 1_600_000_000 },
      },
    });
    await waitFor(() => expect(screen.getAllByText(/^Set by Ana on /)).toHaveLength(2));
    expect(screen.queryByRole("combobox", { name: "Site: default release" })).toBeNull();
  });

  it("areas that break a rule can't change here, and say where to fix them", async () => {
    open({ areas: [APP, SITE], view: areasView([APP, SITE], { problem: "two root areas", held: false }) });
    const site = (await screen.findByRole("combobox", { name: "Site: default release" })) as HTMLSelectElement;
    await waitFor(() => expect(site.disabled).toBe(true));
    expect(screen.getAllByText(/fix them in Settings › Project › Areas first/)).toHaveLength(2);
  });

  it("without areas, one Default release row, published like any shared setting", async () => {
    const { user, tauri } = open({ releaseKind: "push_only" });
    const select = (await screen.findByRole("combobox", { name: "Default release" })) as HTMLSelectElement;
    expect(select.value).toBe("push_only");
    expect(screen.getByText("Releases")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("v1.4.0 · cards go to main")).toBeTruthy());
    await user.selectOptions(select, "github");
    await user.click(await screen.findByRole("button", { name: "Publish to main" }));
    await waitFor(() => expect(tauri.callsOf("workspace_definition_save")).toHaveLength(1));
    expect((tauri.callsOf("workspace_definition_save")[0].args.draft as { releaseKind: string }).releaseKind).toBe(
      "github",
    );
    expect(tauri.callsOf("release_kind_set")).toHaveLength(0);
  });

  it("a repository that shares nothing keeps the default on this Mac, saved as it changes", async () => {
    const { user, tauri } = open({ shared: false, releaseKind: null });
    const select = (await screen.findByRole("combobox", { name: "Default release" })) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("follow");
    expect(screen.getAllByText("on this Mac until you share the project").length).toBeGreaterThan(0);
    // Round 0 (owner): the kind Follow gives now still saves when picked.
    await waitFor(() => expect(within(select).getByRole("option", { name: "Same as Ship it (Put the version on GitHub)" })).toBeTruthy());
    await user.selectOptions(select, "push_only");
    await waitFor(() => expect(tauri.callsOf("release_kind_set")).toHaveLength(1));
    expect(tauri.callsOf("release_kind_set")[0].args).toEqual({ workspaceId: WS, kind: "push_only" });
    expect(screen.queryByRole("button", { name: /Publish to/ })).toBeNull();
  });
});

describe("Settings › Shipping › Releases, not chosen (1.174.0, A1)", () => {
  it("on GitHub it shows Same as Ship it (Put the version on GitHub), without repeating it in the line, saving nothing", async () => {
    const { tauri } = open({ releaseKind: null });
    const select = (await screen.findByRole("combobox", { name: "Default release" })) as HTMLSelectElement;
    await waitFor(() => expect(screen.getByText("v1.4.0 · cards go to main")).toBeTruthy());
    expect(screen.queryByText(/not chosen/)).toBeNull();
    expect(select.value).toBe("follow");
    expect(within(select).getByRole("option", { name: "Same as Ship it (Put the version on GitHub)" })).toBeTruthy();
    expect(tauri.callsOf("workspace_definition_save")).toHaveLength(0);
    expect(tauri.callsOf("release_kind_set")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Publish to main" })).toBeNull();
  });

  it("Ship it only on this Mac starts at On this Mac only, and follows a change of How Ship it ships", async () => {
    const { user } = open({ releaseKind: null, workspace: { shipVia: "local" } });
    const select = (await screen.findByRole("combobox", { name: "Default release" })) as HTMLSelectElement;
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: "Same as Ship it (On this Mac only)" })).toBeTruthy(),
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "How Ship it ships" }), "github");
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: "Same as Ship it (Put the version on GitHub)" })).toBeTruthy(),
    );
    expect(select.value).toBe("follow");
  });

  it("a project that can't take a pull request starts on this Mac only", async () => {
    open({ releaseKind: null, offersPr: false });
    const select = (await screen.findByRole("combobox", { name: "Default release" })) as HTMLSelectElement;
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: "Same as Ship it (On this Mac only)" })).toBeTruthy(),
    );
  });

  it("picking the kind Same as Ship it gives saves it", async () => {
    const { user, tauri } = open({ releaseKind: null });
    const select = (await screen.findByRole("combobox", { name: "Default release" })) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getByRole("option", { name: "Same as Ship it (Put the version on GitHub)" })).toBeTruthy());
    await user.selectOptions(select, "push_only");
    await user.click(await screen.findByRole("button", { name: "Publish to main" }));
    await waitFor(() => expect(tauri.callsOf("workspace_definition_save")).toHaveLength(1));
    expect((tauri.callsOf("workspace_definition_save")[0].args.draft as { releaseKind: string }).releaseKind).toBe("push_only");
  });

  it("Same as Ship it on a chosen kind sets it back to not chosen, and Review says so", async () => {
    const { user } = open({ releaseKind: "local" });
    const select = (await screen.findByRole("combobox", { name: "Default release" })) as HTMLSelectElement;
    await user.selectOptions(select, "follow");
    await user.click(await screen.findByRole("button", { name: /^Review/ }));
    const sheet = await screen.findByRole("dialog");
    expect(
      within(sheet).getByText(/Release… follows How Ship it ships; each release can still choose\./),
    ).toBeTruthy();
  });

  it("a kind chosen is the row's", async () => {
    open({ releaseKind: "local" });
    const select = (await screen.findByRole("combobox", { name: "Default release" })) as HTMLSelectElement;
    await waitFor(() => expect(screen.getByText("v1.4.0 · cards go to main")).toBeTruthy());
    expect(select.value).toBe("local");
    expect(screen.queryByText(/not chosen/)).toBeNull();
  });
});

describe("Settings › Shipping › How this goes live", () => {
  it("says the addresses in one line and opens D2's sheet", async () => {
    const map: DeployMap = {
      repo: "acme/lyra",
      railway: {
        state: "ok",
        project: "lyra",
        message: null,
        readAt: Date.now() - 3 * 60_000,
        services: [
          {
            name: "site",
            rootDirectory: "lyrappc-astro",
            branch: "main",
            domains: ["www.lyrappc.com"],
            watchPatterns: [],
            thisRepository: true,
          },
          {
            name: "app",
            rootDirectory: null,
            branch: "main",
            domains: ["app.lyrappc.com"],
            watchPatterns: [],
            thisRepository: true,
          },
        ] as unknown as DeployMap["railway"]["services"],
      },
      workflows: [],
    };
    const { user } = open({ map });
    expect(
      await screen.findByText("www.lyrappc.com and app.lyrappc.com · read from Railway 3 min ago"),
    ).toBeTruthy();
    // G2 Windows walk (tidy tables): Open sits in a row's action column, the
    // page's button size; the head keeps only the title and the mark.
    const openButton = screen.getByRole("button", { name: "Open" });
    expect(openButton.closest(".ux-row-cell--action")).toBeTruthy();
    expect(openButton.className).not.toMatch(/cbtn--sm|cbtn--quiet/);
    expect(openButton.closest(".ux-section-head")).toBeNull();
    await user.click(openButton);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(/How this goes live/)).toBeTruthy();
  });

  it("nothing to read is one calm line", async () => {
    open({});
    expect(await screen.findByText("Plyloft doesn't see where this project goes online.")).toBeTruthy();
  });
});

describe("A link to a row that moved lands on it and says so (1.174.0, DS2, scene 15)", () => {
  it("the Change toast after a start that set the project up opens Shipping on Cards go to", async () => {
    open({ overlay: true });
    act(() => useUi.getState().setSettingsOverlayOpen(true));
    await screen.findByRole("navigation");
    act(() => changeSetUpAction(WS).onClick());
    expect(await screen.findByRole("heading", { name: "Shipping" })).toBeTruthy();
    expect(await screen.findByRole("combobox", { name: "Cards go to" })).toBeTruthy();
    expect(document.body.textContent).toContain("“Integration branch” is “Cards go to” now, here in Shipping.");
  });
});

describe("General's Where the cards live (DS5 round 1, scene 8)", () => {
  const section = () => screen.getByText("Where the cards live").closest(".ux-section") as HTMLElement;
  function board(ws: Record<string, unknown>, props: Partial<Parameters<typeof BoardPage>[0]> = {}) {
    seed(ws);
    const r = renderUi(<BoardPage scope="repository" workspaceId={WS} {...props} />, {
      fixtures: { workspace_set_kanban_sync_mode: null },
    });
    r.tauri.allowUnhandled();
    return r;
  }

  it("a GitHub Issues board this Mac chose: one Board row with Move the board back, marked not shared yet", async () => {
    board({ kanbanSyncMode: "githubIssues", githubOwnerRepo: "MatteoB-adv/lyra" });
    expect(
      await screen.findByText("On GitHub Issues · MatteoB-adv/lyra. Everyone who opens this project sees the same cards."),
    ).toBeTruthy();
    expect(within(section()).getByRole("button", { name: "Move the board back to this Mac" })).toBeTruthy();
    expect(within(section()).getAllByRole("group")[0].querySelectorAll(".ux-row")).toHaveLength(1);
    expect(within(section()).getByText("on this Mac until you share the project")).toBeTruthy();
  });

  it("an empty repository name is left out", async () => {
    board({ kanbanSyncMode: "githubIssues", githubOwnerRepo: "  " });
    expect(await screen.findByText("On GitHub Issues. Everyone who opens this project sees the same cards.")).toBeTruthy();
  });

  it("a board the repository sets is shared with the project", async () => {
    board({ kanbanSyncMode: "githubIssues", githubOwnerRepo: "acme/lyra" }, { setByRepository: true });
    await screen.findByText("This repository sets its board, so it is the same for everyone who opens it.");
    expect(within(section()).getByText("shared with the project")).toBeTruthy();
  });

  // U13/U35: the status never contradicts "The cards live on this Mac".
  it("a local board the repository sets says everyone has their own cards", async () => {
    board({ kanbanSyncMode: "local" }, { setByRepository: true, adoption: { repoBoard: "local" } as never });
    await screen.findByText("This repository keeps its board on each computer: everyone who opens it has their own cards.");
    expect(screen.queryByText(/the same for everyone/)).toBeNull();
    expect(within(section()).getByText("The cards live on this Mac. Nobody else sees them.")).toBeTruthy();
  });

  it("a GitHub Issues board the plan keeps on this Mac says it is the plan", async () => {
    board({ kanbanSyncMode: "local" }, { setByRepository: true, adoption: { repoBoard: "githubIssues" } as never });
    act(() => setTeamAllowed(false));
    await screen.findByText("This repository's board is on GitHub Issues; your plan keeps it on this Mac.");
    expect(screen.queryByText(/the same for everyone/)).toBeNull();
  });

  it("a GitHub Issues board not moved here yet says so", async () => {
    board({ kanbanSyncMode: "local" }, { setByRepository: true, adoption: { repoBoard: "githubIssues" } as never });
    act(() => setTeamAllowed(true));
    await screen.findByText("This repository's board is on GitHub Issues; this Mac hasn't moved to it yet.");
  });

  it("the gates not read yet say nothing about the plan to a Team member", async () => {
    board({ kanbanSyncMode: "local" }, { setByRepository: true, adoption: { repoBoard: "githubIssues" } as never });
    expect(useAccount.getState().gates).toBeNull();
    expect(screen.queryByText(/This repository/)).toBeNull();
    expect(screen.queryByText(/your plan keeps it/)).toBeNull();
  });

  it("another GitHub account isn't called the plan", async () => {
    board({ kanbanSyncMode: "local" }, { setByRepository: true, adoption: { repoBoard: "githubIssues" } as never });
    act(() =>
      useAccount.setState({
        gates: { team: { state: "other_account", login: "a", teamLogin: "b" }, teamAllowed: false, teamRefusal: "x" } as never,
      }),
    );
    await screen.findByText("This repository's board is on GitHub Issues; team features are off on this Mac, so it stays here.");
  });

  it("no answer from the repository yet says nothing", () => {
    board({ kanbanSyncMode: "local" }, { setByRepository: true, adoption: null });
    expect(screen.queryByText(/This repository/)).toBeNull();
  });

  it("solo, the repository's GitHub Issues board held here: on this Mac", async () => {
    act(() => useWorkMode.setState({ mode: "solo" } as never));
    board({}, { setByRepository: true, adoption: { repoBoard: "githubIssues", action: { kind: "none" } } as never });
    expect(await screen.findByText("The cards live on this Mac. Nobody else sees them.")).toBeTruthy();
    expect(within(section()).getByText("on this Mac")).toBeTruthy();
    act(() => useWorkMode.setState({ mode: "team" } as never));
  });

  it("Choose a repository, then Cancel, keeps a Name being typed", async () => {
    let renamed = "lyra";
    seed();
    act(() => useAccount.setState({ gates: { teamAllowed: true } as never }));
    const r = renderUi(
      <RepositoryGeneral workspaceId={WS} board={<BoardPage scope="repository" workspaceId={WS} />} />,
      {
        fixtures: {
          workspace_definition_get: null,
          project_config_get: config,
          project_review_get: { selfCheck: true, reviewChecklist: [] },
          worktree_settings_get: {},
          workspace_rename: ({ name }: Record<string, unknown>) => {
            renamed = String(name);
            return null;
          },
          workspace_list: () => ({
            workspaces: [{ id: WS, name: renamed, cwd: "/r", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null }],
            activeId: WS,
          }),
          workspace_cwd_exists: true,
        },
      },
    );
    r.tauri.allowUnhandled();
    const name = (await screen.findByRole("textbox", { name: "Name" })) as HTMLInputElement;
    await r.user.clear(name);
    await r.user.type(name, "Lyra web");
    await r.user.click(screen.getByRole("button", { name: "Choose a repository" }));
    await r.user.click(await screen.findByRole("button", { name: "Cancel" }));
    // The rename, its read-back and the workspaces' refresh are still in the queue.
    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Lyra web"),
    );
    act(() => useAccount.setState({ gates: null }));
  });

  it("a local board is this Mac's", async () => {
    board({});
    expect(await screen.findByText("The cards live on this Mac. Nobody else sees them.")).toBeTruthy();
    expect(within(section()).getByText("on this Mac")).toBeTruthy();
  });
});

describe("Each page's shared Re-detect drafts only its own rows (DS2 round 1)", () => {
  const found = {
    ...config,
    versionFiles: [{ path: "package.json", kind: "json" }],
    installScript: "scripts/install.sh",
    verifyPipeline: [{ kind: "script", path: "scripts/verify.sh" }],
  } as unknown as ProjectConfig;
  const definition = { schemaVersion: 1, name: "LYRA", board: "local", integrationBranch: "main", versionFiles: [] };
  const shared = {
    workspace_definition_get: {
      cache: { definition, branch: "main", author: "Matteo", changedAt: null, pending: {} },
      effective: definition,
      defaultBranch: "main",
      queue: { createDefinition: false, fields: {}, createPullRequest: null, lastError: null },
    },
    project_config_get: config,
    project_review_get: { selfCheck: true, reviewChecklist: [] },
    worktree_settings_get: {},
    project_config_detect: { config: found, hasClaudeMd: false, notes: [] },
    workspace_definition_branches: { branches: ["main"], defaultBranch: "main", error: null, hasOrigin: true },
    areas_get: areasView([]),
    areas_releases: [],
    deploy_map_get: nothingMap,
    workspace_ship_offers_pr: true,
  };

  it("Building and checking drafts its checks; Shipping takes the version files and After a release, run", async () => {
    seed();
    const b = renderUi(<RepositoryBuildRelease workspaceId={WS} />, { withToasts: true, fixtures: shared });
    b.tauri.allowUnhandled();
    await b.user.click(await screen.findByRole("button", { name: "Re-detect" }));
    // Two-instance walk (B2): the checks it found differ from the shared ones
    // — said first (a warn holds the screen against the info behind it).
    expect(await screen.findByText(/^Re-detect proposes a change to the shared checks/)).toBeTruthy();
    await b.user.click(screen.getByRole("button", { name: "Dismiss" }));
    // Toasts never sit over a sheet (X2): read it before Review opens.
    expect(await screen.findByText(/^Version files and After a release, run were read too/)).toBeTruthy();
    await b.user.click(await screen.findByRole("button", { name: /^Review/ }));
    let sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Review 1 change")).toBeTruthy();
    expect(within(sheet).getByText(/“Checks before shipping” — none → scripts\/verify\.sh/)).toBeTruthy();
    expect(within(sheet).queryByText(/After a release, run/)).toBeNull();
    b.unmount();

    const s = renderUi(<ShippingPage workspaceId={WS} />, { fixtures: shared });
    s.tauri.allowUnhandled();
    await s.user.click(await screen.findByRole("button", { name: /^Review/ }));
    sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Review 2 changes")).toBeTruthy();
    expect(within(sheet).getByText(/“After a release, run” — none → scripts\/install\.sh/)).toBeTruthy();
    expect(within(sheet).queryByText(/Checks before shipping/)).toBeNull();
  });

  it("Shipping's own Read the repository again drafts only the version files and After a release, run", async () => {
    seed();
    const s = renderUi(<ShippingPage workspaceId={WS} />, { fixtures: shared });
    s.tauri.allowUnhandled();
    await s.user.click(await screen.findByRole("button", { name: /Version files/ }));
    await s.user.click(await screen.findByRole("button", { name: "Re-detect" }));
    await waitFor(() => expect(screen.getByText("package.json")).toBeTruthy());
    await s.user.click(await screen.findByRole("button", { name: /^Review/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Review 2 changes")).toBeTruthy();
    expect(within(sheet).queryByText(/Checks before shipping/)).toBeNull();
  });
});

describe("The old places hold only their own rows (1.174.0, DS2)", () => {
  it("Building and checking: no Cards go to, After a release, run, Version files or Ship it", async () => {
    seed();
    const r = renderUi(<RepositoryBuildRelease workspaceId={WS} cwd="/r" />, {
      fixtures: {
        workspace_definition_get: null,
        project_config_get: config,
        project_review_get: { selfCheck: true, reviewChecklist: [] },
        project_config_detect: { config, hasClaudeMd: false, notes: [] },
        workspace_definition_branches: { branches: ["main"], defaultBranch: "main", error: null, hasOrigin: true },
        worktree_settings_get: {},
      },
    });
    r.tauri.allowUnhandled();
    expect(await screen.findByRole("combobox", { name: "Checks before shipping" })).toBeTruthy();
    for (const gone of ["Cards go to", "After a release, run", "How Ship it ships"]) {
      expect(screen.queryByRole("combobox", { name: gone })).toBeNull();
    }
    expect(screen.queryByText("Version files")).toBeNull();
    expect(screen.queryByText(/moved to Settings › Shipping/)).toBeNull();
    // 1.174.0 (DS3, scene 5): building and checking only, each section marked.
    const titles = [...document.querySelectorAll(".ux-section-title")].map((h) => h.textContent);
    // Unshared, the page keeps its Reset danger zone last.
    expect(titles).toEqual(["Checks", "Review", "Each card's copy", "Build cache", "Try it", "Read the project again", "Reset"]);
    expect(screen.queryByText("Shared definition")).toBeNull();
    expect(screen.getAllByText("on this Mac until you share the project")).toHaveLength(5);
    expect(screen.getAllByText("on this Mac")).toHaveLength(2);
    expect(screen.getByText("How cards in this project are built and checked before they ship.")).toBeTruthy();
  });

  it("Building and checking on a shared project: its project sections are shared, Review stays here, no Reset", async () => {
    seed();
    const definition = { schemaVersion: 1, name: "LYRA", board: "local", integrationBranch: "main", versionFiles: [] };
    const r = renderUi(<RepositoryBuildRelease workspaceId={WS} />, {
      fixtures: {
        workspace_definition_get: {
          cache: { definition, branch: "main", author: "Matteo", changedAt: null, pending: {} },
          effective: definition,
          defaultBranch: "main",
          queue: { createDefinition: false, fields: {}, createPullRequest: null, lastError: null },
        },
        project_config_get: config,
        project_review_get: { selfCheck: true, reviewChecklist: [] },
        project_config_detect: { config, hasClaudeMd: false, notes: [] },
        workspace_definition_branches: { branches: ["main"], defaultBranch: "main", error: null, hasOrigin: true },
        worktree_settings_get: {},
      },
    });
    r.tauri.allowUnhandled();
    await screen.findByRole("combobox", { name: "Checks before shipping" });
    expect(screen.getAllByText("shared with the project")).toHaveLength(5);
    expect(screen.getAllByText("on this Mac")).toHaveLength(1);
    expect(screen.getByText("How cards in this project are built and checked before they ship.")).toBeTruthy();
    const titles = [...document.querySelectorAll(".ux-section-title")].map((h) => h.textContent);
    expect(titles).not.toContain("Reset");
  });

  it("Cards' copies: no Pull requests or Card branches sections", async () => {
    seed({ githubOwnerRepo: "acme/lyra" });
    const r = renderUi(<WorktreesPage scope="repository" workspaceId={WS} />, {
      fixtures: { worktree_list: () => [], worktree_kept_list: () => [], local_branch_status: () => null },
    });
    r.tauri.allowUnhandled();
    await screen.findByText("Read them again");
    expect(screen.queryByText("Pull requests")).toBeNull();
    expect(screen.queryByText("Card branches")).toBeNull();
    expect(screen.queryByText(/moved to Settings › Shipping/)).toBeNull();
    expect(screen.queryByText(/Automatically delete head branches/)).toBeNull();
    // 1.174.0 (DS5, scene 11): a page of its own, in its own words.
    expect(screen.getByRole("heading", { level: 1, name: "Cards' copies" })).toBeTruthy();
    expect(
      screen.getByText(
        "Each card, and each copy you start from Terminals, has its own copy of the project on this Mac, so two never write the same files.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Copies")).toBeTruthy();
    expect(await screen.findByText("No card or copy has its own copy on this Mac right now.")).toBeTruthy();
    expect(screen.getByText("Reads the copies on this Mac as they are now.")).toBeTruthy();
    // G2 walk: one Look again on the empty page.
    expect(screen.getAllByRole("button", { name: "Look again" })).toHaveLength(1);
    expect(screen.queryByText("Worktrees")).toBeNull();
  });

  it("General: This project, then Where the cards live, and no Models for this workspace (DS5, scene 8)", async () => {
    seed();
    const r = renderUi(
      <RepositoryGeneral workspaceId={WS} board={<BoardPage scope="repository" workspaceId={WS} />} />,
      {
        fixtures: {
          workspace_definition_get: null,
          project_config_get: config,
          project_review_get: { selfCheck: true, reviewChecklist: [] },
          worktree_settings_get: {},
        },
      },
    );
    r.tauri.allowUnhandled();
    await screen.findByText("This project");
    const titles = [...document.querySelectorAll(".ux-section-title")].map((h) => h.textContent);
    expect(titles).toEqual(["This project", "Where the cards live"]);
    expect(screen.getByText("This project's name, color and board.")).toBeTruthy();
    expect(screen.getByText("The cards live on this Mac. Nobody else sees them.")).toBeTruthy();
    expect(screen.queryByText("Models for this workspace")).toBeNull();
    // The board part draws no heading of its own.
    expect(screen.queryByRole("heading", { name: "Board" })).toBeNull();
  });
});
