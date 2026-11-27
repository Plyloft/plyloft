// 1.174.0 (X3, SL-16; mockup next-1174/mockups/my-library.html): My library in
// a project's Library › Skills — after the team library, read-only, its rows
// opening All skills, "Manage in All skills", and without one an empty
// section that says how to make one. Nothing on it writes.
import { beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import type { MyLibraryView, ProjectSkillsView } from "../ipc";
import type { LibraryStateLike } from "../lib/sharedLibrary";
import { flattenIndex, DEFAULT_FILTERS, EMPTY_INDEX } from "../lib/allSkills";
import { useAllSkills } from "../store/allSkillsStore";
import { useMyLibrary } from "../store/myLibraryStore";
import { useLibrary } from "../store/libraryStore";
import { useUi } from "../store/uiStore";
import { act, renderUi, screen } from "./render";

const WS = "ws-mine";
const CWD = "/Users/someone/code/project";

const projectView: ProjectSkillsView = {
  workspaceId: WS,
  workspaceName: "project",
  cwd: CWD,
  skills: [
    {
      name: "railway-deploy",
      codexName: null,
      description: "Deploys a service to Railway. Then reads its logs.",
      claude: true,
      codex: false,
      roots: [".claude/skills"],
      diverged: false,
      ignoredRoots: [],
      team: "absent",
      promoteBlocked: null,
    },
  ],
  team: [],
  unloadable: [],
  rootsPresent: [".claude/skills"],
  ignoredRoots: [],
  configured: false,
  hasClone: false,
  canPromote: false,
  promoteReason: null,
  promotePlugin: null,
  errors: [],
} as unknown as ProjectSkillsView;

const library = {
  shared: false,
  branch: "main",
  readOnly: false,
  repository: null,
  pending: [],
  branchSkills: [],
  branchSkillRows: [],
  skipped: [],
} as unknown as LibraryStateLike;

const NOW = Date.now();

function libraryView(over: Partial<MyLibraryView> = {}): MyLibraryView {
  return {
    repo: "someone/plyloft-skills",
    account: "someone",
    hasClone: true,
    lastPullAt: NOW - 2 * 60 * 60_000,
    lastAttemptAt: NOW - 2 * 60 * 60_000,
    lastError: null,
    goneAt: null,
    defaultName: "plyloft-skills",
    accounts: [],
    plugin: "mine",
    ...over,
  };
}

function hubRow(name: string, description: string) {
  return {
    name,
    description,
    claude: true,
    codex: true,
    claudeId: null,
    codexId: null,
    twinsDiffer: false,
    legacyCodex: false,
    dir: `/lib/${name}`,
    changedAt: null,
    tooManyFiles: false,
    needsOk: false,
    offHere: false,
  };
}

function withMine(names: [string, string][]) {
  const index = {
    ...EMPTY_INDEX,
    myLibrary: { rows: names.map(([n, d]) => hubRow(n, d)) },
  } as unknown as typeof EMPTY_INDEX;
  useAllSkills.setState({ index, rows: flattenIndex(index), loaded: true });
}

function Host() {
  const data = useSkillsData(WS, true);
  return <SkillsPage workspaceId={WS} cwd={CWD} data={data} />;
}

function render(view: MyLibraryView, extra: Record<string, unknown> = {}) {
  useMyLibrary.setState({ view, found: null, foundFor: null });
  return renderUi(<Host />, {
    fixtures: {
      project_skills_view: () => projectView,
      knowledge_project_state: () => library,
      personal_skills_view: () => ({ skills: [], rootsPresent: [], errors: [] }),
      skills_hub_links: () => ({ links: [], unreadable: [] }),
      ply_skills_view: () => ({ skills: [], problem: null }),
      my_library_status: () => view,
      my_library_find: () => null,
      ...extra,
    },
  });
}

beforeEach(() => {
  useAllSkills.setState({ index: EMPTY_INDEX, rows: [], loaded: true, openKey: null, copy: null, filters: DEFAULT_FILTERS });
  useUi.getState().setAllSkillsOpen(false);
});

describe("X3: My library in the project's Library", () => {
  it("lists My library's skills after the repository, read-only, with Manage in All skills", async () => {
    withMine([
      ["italian-copy", "Writes Italian interface copy in my tone. Short."],
      ["railway-deploy", "Deploys a service to Railway."],
    ]);
    const { user, tauri } = render(libraryView());
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "italian-copy" });

    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf("In My library")).toBeGreaterThan(headings.indexOf("In this repository"));
    expect(screen.getByText("2 skills · your sessions on every Mac")).toBeTruthy();
    expect(
      screen.getByText(
        "Yours alone, from your private repository someone/plyloft-skills. Sessions get them as mine:<name>. Add, change or remove them in All skills.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Updated 2 hours ago")).toBeTruthy();

    // Read-only: no action and no ⋯ on its rows; the duplicate both ways.
    const group = screen.getByRole("group", { name: "In My library" });
    expect(within(group).queryByRole("button", { name: /^More for/ })).toBeNull();
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["italian-copy", "railway-deploy"]);
    expect(within(group).getByText("also in this repository")).toBeTruthy();
    const repo = screen.getByRole("group", { name: "In this repository" });
    expect(within(repo).getByText("also in My library")).toBeTruthy();

    // A row opens that skill's page in All skills.
    await user.click(within(group).getByRole("button", { name: "italian-copy" }));
    expect(useUi.getState().allSkillsOpen).toBe(true);
    expect(useAllSkills.getState().openKey).toBe("myLibrary:italian-copy");

    // Manage in All skills opens All skills' list.
    act(() => useUi.getState().setAllSkillsOpen(false));
    useAllSkills.getState().setFilters({ scope: "thisMac" });
    await user.click(screen.getByRole("button", { name: "Manage in All skills" }));
    expect(useUi.getState().allSkillsOpen).toBe(true);
    expect(useAllSkills.getState().openKey).toBeNull();
    expect(useAllSkills.getState().filters.scope).toBe("myLibrary");
    expect(tauri.callsOf("my_library_publish")).toHaveLength(0);
  });

  it("sits between this repository and Comes with Plyloft (Q1 a)", async () => {
    withMine([["italian-copy", "Writes Italian copy."]]);
    const { tauri } = render(libraryView(), {
      fs_read_text_file: () => "# Write a good card brief\n",
      ply_skills_view: () => ({
        skills: [
          {
            name: "card-brief",
            title: "Write a good card brief",
            description: "Turns a rough idea into a brief an agent can work from.",
            dir: "/Applications/Plyloft.app/ply-skills/card-brief",
            claude: true,
            codex: true,
            on: true,
            version: "1.167.0",
            changes: [],
            switch: { on: true, level: "default", workspace: null, fork: false, teamOff: false, macOn: true },
          },
        ],
        problem: null,
        place: { workspaceName: "project", repository: null, shared: false, readOnly: false, team: null },
      }),
    });
    tauri.allowUnhandled();
    await screen.findByRole("heading", { level: 2, name: "Comes with Plyloft" });
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["In this repository", "In My library", "Comes with Plyloft"]);
  });

  it("is absent when a filter matches none of its skills", async () => {
    withMine([["italian-copy", "Writes Italian copy."]]);
    const { tauri } = render(libraryView());
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "italian-copy" });
    act(() => useLibrary.getState().setFilter(WS, "zzz"));
    expect(screen.queryByRole("heading", { level: 2, name: "In My library" })).toBeNull();
    expect(screen.queryByText("Manage in All skills")).toBeNull();
    act(() => useLibrary.getState().setFilter(WS, ""));
  });

  it("says a grey status when it isn't current", async () => {
    withMine([["italian-copy", "Writes Italian copy."]]);
    const { tauri } = render(libraryView({ lastError: "offline" }));
    tauri.allowUnhandled();
    const line = await screen.findByText("Last updated 2 hours ago · offline");
    expect(line.closest(".ux-status")!.className).toContain("ux-status--empty");
  });

  it("without a My library, says how to make one, once, under All", async () => {
    const { user, tauri } = render(libraryView({ repo: null, hasClone: false, lastPullAt: null }));
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "railway-deploy" });
    expect(screen.getByRole("heading", { level: 2, name: "In My library" })).toBeTruthy();
    expect(screen.getByText("not set up on this Mac")).toBeTruthy();
    expect(
      screen.getByText(
        "Keep your own skills in a private repository on your GitHub account. They reach your sessions on every Mac you use, as mine:<name>.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Create one, or use one you already have, in All skills.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Set it up in All skills" }));
    expect(useUi.getState().allSkillsOpen).toBe(true);

    // Not under another scope, and not to a filter.
    act(() => useLibrary.getState().setScope(WS, "repository"));
    expect(screen.queryByRole("heading", { level: 2, name: "In My library" })).toBeNull();
    act(() => {
      useLibrary.getState().setScope(WS, "all");
      useLibrary.getState().setFilter(WS, "rail");
    });
    expect(screen.queryByRole("heading", { level: 2, name: "In My library" })).toBeNull();
    act(() => useLibrary.getState().setFilter(WS, ""));
  });

  it("under the My library scope shows only My library", async () => {
    withMine([["italian-copy", "Writes Italian copy."]]);
    act(() => useLibrary.getState().setScope(WS, "my-library"));
    const { tauri } = render(libraryView());
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "italian-copy" });
    expect(screen.queryByRole("heading", { level: 2, name: "In this repository" })).toBeNull();
    act(() => useLibrary.getState().setScope(WS, "all"));
  });
});
