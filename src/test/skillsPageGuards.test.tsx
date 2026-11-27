// The Skills page's guards and its missing states, on the real page and its
// real data hook through the stubbed Tauri layer:
//
// - `Remove from <branch>…` asks first, as `Remove from Team…` does — it
//   reaches every colleague;
// - a row whose write is running has its action and its `⋯` inert;
// - a skill's page lists the files under its folders (`scripts/run.sh`), and
//   the fact line counts them;
// - a first read that failed is an error block with `Try again`, not a filter
//   over zero skills;
// - a refused publish is drawn on the refused skill's own page.
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import type { ProjectSkillsView } from "../ipc";
import type { LibraryStateLike } from "../lib/sharedLibrary";
import {
  alignedOnBranchLine,
  alignedOnBranchPullLine,
  compareActions,
  skillSections,
  type SkillsInput,
} from "../lib/librarySkills";
import { useLibrary } from "../store/libraryStore";
import { useEditor } from "../store/editorStore";
import { useErrorBlocks } from "../store/errorBlockStore";
import { useToasts } from "../store/toastStore";
import { act, renderUi, screen, waitFor } from "./render";

const WS = "ws-guards";
const CWD = "/Users/someone/code/project";
const DEPLOY = `${CWD}/.claude/skills/deploy`;

const view: ProjectSkillsView = {
  workspaceId: WS,
  workspaceName: "project",
  cwd: CWD,
  skills: [
    {
      name: "deploy",
      codexName: null,
      description: "Ships the app to staging.",
      claude: true,
      codex: true,
      roots: [".claude/skills", ".agents/skills"],
      diverged: false,
      ignoredRoots: [],
      team: "absent",
      promoteBlocked: null,
    },
  ],
  team: [
    {
      name: "lint",
      codexName: null,
      description: "Lints the change.",
      plugin: "ply-team",
      claude: true,
      codex: true,
      repo: "absent",
      ignoredRoots: [],
      unknownRoots: [],
      dir: "/Users/someone/team/library/claude/lint",
    },
  ],
  unloadable: [],
  rootsPresent: [".claude/skills", ".agents/skills"],
  ignoredRoots: [],
  configured: true,
  hasClone: true,
  canPromote: false,
  promoteReason: null,
  promotePlugin: "ply-team",
  errors: [],
};

const library = {
  shared: true,
  branch: "staging",
  readOnly: false,
  repository: "someone/project",
  pending: [],
  branchSkills: ["deploy"],
  branchSkillRows: [],
  skipped: [],
} as unknown as LibraryStateLike;

function Host() {
  const data = useSkillsData(WS, true);
  return <SkillsPage workspaceId={WS} cwd={CWD} data={data} />;
}

/** A promise the test settles when it chooses: a write that is still running. */
function held<T>(): { promise: Promise<T>; settle: (value: T) => void } {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

function render(extra: Record<string, unknown> = {}) {
  return renderUi(<Host />, {
    fixtures: {
      project_skills_view: () => view,
      knowledge_project_state: () => library,
      personal_skills_view: () => ({ skills: [], rootsPresent: [], errors: [] }),
      skills_hub_links: () => ({ links: [], unreadable: [] }),
      ply_skills_view: () => ({ skills: [], problem: null }),
      ...extra,
    },
  });
}

describe("Remove from <branch>…", () => {
  it("asks before it removes, and removes only on yes", async () => {
    const { user, tauri } = render({ project_skill_unpublish: () => undefined });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "deploy" });
    await user.click(screen.getByRole("button", { name: "More for deploy" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from staging…" }));

    expect(await screen.findByText("Remove deploy from staging?")).toBeTruthy();
    expect(tauri.callsOf("project_skill_unpublish")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(tauri.callsOf("project_skill_unpublish")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "More for deploy" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from staging…" }));
    await user.click(await screen.findByRole("button", { name: "Remove from staging" }));
    await waitFor(() =>
      expect(tauri.callsOf("project_skill_unpublish")).toEqual([
        { cmd: "project_skill_unpublish", args: { workspaceId: WS, skill: "deploy", shown: null } },
      ]),
    );
  });

  // 1.169.0 (C4): the removal waits 10 s for Undo on the toast.
  for (const [found, title] of [
    ["withdrawn", "Kept deploy on staging"],
    ["restored", "Kept deploy on staging"],
    ["notQueued", "deploy was already removed from staging"],
    ["replaced", "Nothing to undo for deploy"],
    ["noLibrary", "Couldn't undo the removal of deploy"],
  ] as const) {
    it(`Undo on the toast takes the removal back (${found})`, async () => {
      const { user, tauri } = render({
        project_skill_unpublish: () => undefined,
        project_skill_unpublish_undo: () => found,
      });
      tauri.allowUnhandled();
      await screen.findByRole("button", { name: "deploy" });
      await user.click(screen.getByRole("button", { name: "More for deploy" }));
      await user.click(await screen.findByRole("menuitem", { name: "Remove from staging…" }));
      await user.click(await screen.findByRole("button", { name: "Remove from staging" }));
      await waitFor(() =>
        expect(useToasts.getState().toasts.some((t) => t.title === "Removing deploy from staging")).toBe(true),
      );
      const toast = useToasts.getState().toasts.find((t) => t.title === "Removing deploy from staging")!;
      expect(toast.action?.label).toBe("Undo");
      expect(toast.action?.ttlMs).toBe(10_000);
      act(() => toast.action!.onClick());
      await waitFor(() =>
        expect(tauri.callsOf("project_skill_unpublish_undo")).toEqual([
          { cmd: "project_skill_unpublish_undo", args: { workspaceId: WS, skill: "deploy" } },
        ]),
      );
      // The Undo press's answer waits behind the toast on screen (one at a time).
      await waitFor(() => {
        const { toasts, queue } = useToasts.getState();
        expect([...toasts, ...queue].some((t) => t.title === title)).toBe(true);
      });
    });
  }
});

// Walk F4 (review): `Update on <branch>` is always offered — the rows are a
// snapshot — and the press reads the library state again: a checkout already
// the branch's publishes nothing and says so; one edited since publishes.
describe("Update on <branch>", () => {
  it("reads fresh at the press and publishes only what differs", async () => {
    let current: string[] = [];
    const { user, tauri } = render({
      knowledge_project_state: () => ({ ...library, currentInCheckout: current }),
      project_skill_publish: () => undefined,
    });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "deploy" });

    current = ["deploy"];
    await user.click(screen.getByRole("button", { name: "More for deploy" }));
    await user.click(await screen.findByRole("menuitem", { name: "Update on staging" }));
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.title)).toContain(
        "deploy is already the same on staging",
      ),
    );
    expect(tauri.callsOf("project_skill_publish")).toHaveLength(0);

    current = [];
    await user.click(screen.getByRole("button", { name: "More for deploy" }));
    await user.click(await screen.findByRole("menuitem", { name: "Update on staging" }));
    await waitFor(() => expect(tauri.callsOf("project_skill_publish")).toHaveLength(1));
  });

  // Owner, 2026-10-19: "published" when the push went through, "queued" only
  // when it truly waits, and no toast of its own when the drain's says it.
  it("says published, queued, or leaves it to the drain's toast", async () => {
    let outcome: string = "published";
    const { user, tauri } = render({
      knowledge_project_state: () => ({ ...library, currentInCheckout: [] }),
      project_skill_publish: () => ({ follows: null, outcome }),
    });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "deploy" });
    const press = async () => {
      useToasts.setState({ toasts: [] });
      await user.click(screen.getByRole("button", { name: "More for deploy" }));
      await user.click(await screen.findByRole("menuitem", { name: "Update on staging" }));
    };
    const titles = () => useToasts.getState().toasts.map((t) => t.title);
    await press();
    await waitFor(() => expect(titles()).toEqual(["Published deploy to staging"]));
    outcome = "queued";
    await press();
    await waitFor(() => expect(titles()).toEqual(["deploy is queued for staging"]));
    outcome = "said";
    await press();
    await waitFor(() => expect(tauri.callsOf("project_skill_publish")).toHaveLength(3));
    expect(titles()).toEqual([]);
    // Owner-fixes Windows walk: the branch already held it — not "queued".
    outcome = "current";
    await press();
    await waitFor(() => expect(titles()).toEqual(["deploy is already the same on staging"]));
  });
});

describe("a row whose write is running", () => {
  it("keeps its action and its ⋯ inert until the write ends", async () => {
    const install = held<unknown>();
    const { user, tauri } = render({ skills_hub_install: () => install.promise });
    tauri.allowUnhandled();
    const open = await screen.findByRole("button", { name: "lint" });
    const row = open.closest<HTMLElement>(".ux-row")!;
    const action = within(row).getByRole("button", { name: "Install" }) as HTMLButtonElement;
    await user.click(action);
    await waitFor(() => expect(action.disabled).toBe(true));
    const more = within(row).getByRole("button", { name: "More for lint" }) as HTMLButtonElement;
    expect(more.disabled).toBe(true);
    // Another row is not this write's.
    expect(
      (screen.getByRole("button", { name: "More for deploy" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    await act(async () => install.settle({ kind: "written", copied: { written: [], unchanged: [], ignored: [], unknown: [] } }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "More for lint" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });
});

describe("a skill's own page", () => {
  it("lists the files under its folders, and counts them", async () => {
    const { tauri } = render({
      fs_list_dir: ({ path }: Record<string, unknown>) =>
        path === DEPLOY
          ? [
              { name: "scripts", path: `${DEPLOY}/scripts`, isDir: true, size: 0 },
              { name: "SKILL.md", path: `${DEPLOY}/SKILL.md`, isDir: false, size: 20 },
            ]
          : path === `${DEPLOY}/scripts`
            ? [{ name: "run.sh", path: `${DEPLOY}/scripts/run.sh`, isDir: false, size: 10 }]
            : [],
      fs_read_text_file: ({ path }: Record<string, unknown>) =>
        String(path).endsWith("SKILL.md") ? "# Deploy\nShips it.\n" : "#!/bin/sh\necho hi\n",
      skill_history: () => ({ gitRef: null, author: null, at: null, commit: null }),
    });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "deploy" });
    act(() => useLibrary.getState().openSkill(WS, "repository:deploy"));

    expect(await screen.findByRole("button", { name: /scripts\/run\.sh/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^SKILL\.md/ })).toBeTruthy();
    await waitFor(() =>
      expect(document.querySelector(".ux-skill-facts")?.textContent).toContain("2 files"),
    );
    // The nested file's own lines were read at its joined path.
    expect(
      tauri.callsOf("fs_read_text_file").some((c) => c.args.path === `${DEPLOY}/scripts/run.sh`),
    ).toBe(true);
  });

  it("draws a refused publish when this skill is what waits", async () => {
    useErrorBlocks.getState().setPublishRefused(WS, {
      branch: "staging",
      titles: ["deploy", "other"],
      kinds: ["skill"],
      output: "remote: Permission denied",
    });
    const { tauri } = render({
      fs_list_dir: () => [],
      fs_read_text_file: () => "# Deploy\n",
      skill_history: () => ({ gitRef: null, author: null, at: null, commit: null }),
    });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "deploy" });
    // The list draws it for everything that waits…
    expect(screen.getByText("deploy and other can't reach staging.")).toBeTruthy();
    act(() => useLibrary.getState().openSkill(WS, "repository:deploy"));
    // …and the skill's page for itself alone.
    expect(await screen.findByText("deploy can't reach staging.")).toBeTruthy();
  });
});

describe("a skill root git ignores", () => {
  it("offers the Diagnostics Un-ignore, which only reads until confirmed", async () => {
    const ignored: ProjectSkillsView = {
      ...view,
      skills: [{ ...view.skills[0], ignoredRoots: [".claude/skills"] }],
    };
    const { user, tauri } = render({
      project_skills_view: () => ignored,
      skill_root_ignore_plan: () => ({
        roots: [".claude/skills"],
        edits: [
          {
            file: ".gitignore",
            lines: ["!.claude/skills/"],
            roots: [".claude/skills"],
            reach: "repository",
            rules: [],
          },
        ],
        refused: [],
      }),
    });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "deploy" });
    await user.click(screen.getByRole("button", { name: "Let Git see it" }));
    expect(await screen.findByText("Let Git see .claude/skills?")).toBeTruthy();
    expect(tauri.callsOf("skill_root_ignore_plan")).toHaveLength(1);
    expect(tauri.callsOf("skill_root_ignore_fix")).toHaveLength(0);
  });
});

const NO_HISTORY = { gitRef: null, author: null, at: null, commit: null };
const file = (dir: string, name: string, size = 10) => ({
  name,
  path: `${dir}/${name}`,
  isDir: false,
  size,
});

/** Open deploy's own page once the list has drawn it. */
async function openDeploy() {
  // Two rows can be called deploy (a repository copy and one on this Mac).
  await screen.findAllByRole("button", { name: "deploy" });
  act(() => useLibrary.getState().openSkill(WS, "repository:deploy"));
}

const facts = () => document.querySelector(".ux-skill-facts")?.textContent ?? "";

describe("a skill's file list, where it stops", () => {
  it("says 200+ when it reaches its bound, and why", async () => {
    const many = Array.from({ length: 201 }, (_, i) => file(DEPLOY, `f${String(i).padStart(3, "0")}.md`));
    const { tauri } = render({
      fs_list_dir: ({ path }: Record<string, unknown>) =>
        path === DEPLOY ? [file(DEPLOY, "SKILL.md"), ...many] : [],
      fs_read_text_file: () => "x\n",
      skill_history: () => NO_HISTORY,
    });
    tauri.allowUnhandled();
    await openDeploy();
    await waitFor(() => expect(facts()).toContain("200+ files"));
    expect(screen.getByText("Not every file is listed: the list stops at 200 files.")).toBeTruthy();
    // Hidden files are asked for: the tree copy carries them.
    expect(tauri.callsOf("fs_list_dir")[0]?.args).toMatchObject({ includeHidden: true });
  });

  it("keeps the rest when a folder can't be read, and leaves a symlink out", async () => {
    const { tauri } = render({
      fs_list_dir: ({ path }: Record<string, unknown>) => {
        if (path === `${DEPLOY}/secret`) throw new Error("permission denied");
        return path === DEPLOY
          ? [
              { name: "secret", path: `${DEPLOY}/secret`, isDir: true, size: 0 },
              { name: "linked", path: `${DEPLOY}/linked`, isDir: false, size: 5, isSymlink: true },
              file(DEPLOY, ".helper"),
              file(DEPLOY, "SKILL.md"),
            ]
          : [];
      },
      fs_read_text_file: () => "x\n",
      skill_history: () => NO_HISTORY,
    });
    tauri.allowUnhandled();
    await openDeploy();
    expect(await screen.findByRole("button", { name: /^\.helper/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^linked/ })).toBeNull();
    expect(
      await screen.findByText(
        "Not every file is listed: Plyloft couldn't read 1 folder. 1 symlink is left out — " +
          "Plyloft won't copy a skill that holds one.",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(facts()).toContain("2+ files"));
  });
});

describe("a skill's page while its write runs", () => {
  it("keeps its ⋯ inert with the primary", async () => {
    const publish = held<unknown>();
    const { user, tauri } = render({
      project_skill_publish: () => publish.promise,
      fs_list_dir: () => [],
      fs_read_text_file: () => "# Deploy\n",
      skill_history: () => NO_HISTORY,
    });
    tauri.allowUnhandled();
    await openDeploy();
    const more = (await screen.findByRole("button", { name: "More for deploy" })) as HTMLButtonElement;
    await user.click(more);
    await user.click(await screen.findByRole("menuitem", { name: "Update on staging" }));
    await waitFor(() => expect(more.disabled).toBe(true));
    expect(
      (screen.getByRole("button", { name: "Edit in Code" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => publish.settle(undefined));
    await waitFor(() => expect(more.disabled).toBe(false));
  });
});

describe("Remove from <branch>… under Compare", () => {
  it("asks first there too", async () => {
    const { user, tauri } = render({
      project_skill_unpublish: () => undefined,
      personal_skills_view: () => ({
        skills: [
          {
            name: "deploy",
            codexName: null,
            description: "Mine.",
            claude: true,
            codex: false,
            roots: [".claude/skills"],
            dir: "/Users/someone/.claude/skills/deploy",
          },
        ],
        rootsPresent: [".claude/skills"],
        errors: [],
      }),
      fs_list_dir: () => [],
      fs_read_text_file: ({ path }: Record<string, unknown>) =>
        String(path).startsWith(CWD) ? "# Deploy\nRepo.\n" : "# Deploy\nMine.\n",
      skill_history: () => NO_HISTORY,
    });
    tauri.allowUnhandled();
    await openDeploy();
    const notice = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(".ux-notice");
      if (!found) throw new Error("no notice yet");
      return found;
    });
    await user.click(within(notice).getByRole("button", { name: "Compare" }));
    await user.click(await screen.findByRole("button", { name: "Remove from staging…" }));
    expect(await screen.findByText("Remove deploy from staging?")).toBeTruthy();
    expect(tauri.callsOf("project_skill_unpublish")).toHaveLength(0);
  });
});

describe("a refused publish on a skill's page", () => {
  function refuse(titles: string[]) {
    useErrorBlocks.getState().setPublishRefused(WS, {
      branch: "staging",
      titles,
      kinds: ["skill"],
      output: "remote: Permission denied",
    });
  }
  const pageFixtures = {
    fs_list_dir: () => [],
    fs_read_text_file: () => "# Deploy\n",
    skill_history: () => NO_HISTORY,
  };

  it("is not drawn for a skill that is not waiting", async () => {
    refuse(["other"]);
    const { tauri } = render(pageFixtures);
    tauri.allowUnhandled();
    await openDeploy();
    await screen.findByRole("button", { name: "More for deploy" });
    expect(screen.queryByText(/can't reach staging/)).toBeNull();
  });

  it("claims its Make available to both and its Align", async () => {
    refuse(["deploy for Claude and Codex", "deploy aligned for Claude and Codex", "other"]);
    const { tauri } = render(pageFixtures);
    tauri.allowUnhandled();
    await openDeploy();
    expect(
      await screen.findByText(
        "deploy for Claude and Codex and deploy aligned for Claude and Codex can't reach staging.",
      ),
    ).toBeTruthy();
  });
});

describe("a first read that failed", () => {
  it("is an error block with Try again, and Try again reads again", async () => {
    let fail = true;
    const { user, tauri } = render({
      project_skills_view: () => {
        if (fail) throw new Error("git: not a repository");
        return view;
      },
    });
    tauri.allowUnhandled();
    expect(await screen.findByText("Plyloft couldn't read this repository's skills.")).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByPlaceholderText(/Filter/)).toBeNull();

    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "deploy" })).toBeTruthy();
    expect(screen.queryByText("Plyloft couldn't read this repository's skills.")).toBeNull();
  });
});

// Team walk 2026-10-01 (F4 stopgap): two copies that disagree keep Promote to
// Team refused — now shown off with the reason, not missing — and the skill's
// page lists Codex's copy under Its files, so the pair can be made to match
// from Plyloft.
describe("a skill whose two copies disagree", () => {
  const BLOCKED =
    "The copies of deploy in this repo are not the same file, so Plyloft cannot tell which one the team should get. Make them match first.";
  const CODEX = `${CWD}/.agents/skills/deploy`;
  const blocked: ProjectSkillsView = {
    ...view,
    canPromote: true,
    skills: [{ ...view.skills[0], promoteBlocked: BLOCKED }],
  };

  it("shows Promote to Team off with why, and lists Codex's copy to open", async () => {
    const { user, tauri } = render({
      project_skills_view: () => blocked,
      fs_list_dir: ({ path }: Record<string, unknown>) =>
        path === DEPLOY
          ? [{ name: "SKILL.md", path: `${DEPLOY}/SKILL.md`, isDir: false, size: 20 }]
          : path === CODEX
            ? [{ name: "SKILL.md", path: `${CODEX}/SKILL.md`, isDir: false, size: 20 }]
            : [],
      fs_read_text_file: () => "# Deploy\nShips it.\n",
      skill_history: () => ({ gitRef: null, author: null, at: null, commit: null }),
    });
    tauri.allowUnhandled();
    await openDeploy();

    const codexFile = await screen.findByRole("button", {
      name: ".agents/skills/deploy/SKILL.md",
    });
    expect(screen.getByText("Codex's copy · 2 lines")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "More for deploy" }));
    const promote = await screen.findByRole("menuitem", { name: "Promote to Team" });
    expect((promote as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole(promote.getAttribute("role")!, { description: BLOCKED })).toBe(promote);
    await user.keyboard("{Escape}");

    await user.click(codexFile);
    await waitFor(() =>
      expect(
        useEditor.getState().byWorkspace[WS]?.openFiles.some((f) => f.path === `${CODEX}/SKILL.md`),
      ).toBe(true),
    );
  });
});

// Skills hub H4 step 8 c (Windows walk): a member GitHub lets read the team
// library and not change it saw no Promote on a repository row, and no word
// why. It is there now, off, with GitHub's refusal; the rows' notes stop
// telling that member what a Promote would share. A caveat while Promote is
// offered keeps it on; a Mac on no team is offered none.
// 1.175.0 B1 (SEC-1, proof P1): "Promote to Team" of a skill whose text asks
// to run things went at once, with nothing on screen. It now opens the Share
// page, which says what the text asks for and whose OK sharing it is.
describe("Promote to Team of a skill whose text asks", () => {
  const promoted = {
    skill: "deploy",
    plugin: "ply-team",
    branch: "staging",
    leftOut: null,
    copied: { written: [], unchanged: [], ignored: [], unknown: [] },
    committed: true,
    pushed: true,
    pullRequest: null,
  };

  async function pressPromote(skill: Record<string, unknown>) {
    // Round 2 (G3): the view gives the id of the text it read.
    const r = render({
      project_skills_view: () => ({ ...view, canPromote: true, skills: [{ ...view.skills[0], ...skill }] }),
      project_skill_promote: () => promoted,
    });
    r.tauri.allowUnhandled();
    await screen.findByRole("button", { name: "deploy" });
    await r.user.click(screen.getByRole("button", { name: "More for deploy" }));
    await r.user.click(await screen.findByRole("menuitem", { name: "Promote to Team" }));
    return r;
  }

  it("opens the Share page and shares only on its press", async () => {
    const { user, tauri } = await pressPromote({ asks: "commands", asksId: "id-of-the-text-shown" });
    expect(await screen.findByText("Share · 1 step")).toBeTruthy();
    expect(
      screen.getByText(
        "Its text lets agents run commands without asking. Every other computer asks its person for an OK before its sessions get it; on this Mac, sharing it is your OK.",
      ),
    ).toBeTruthy();
    expect(tauri.callsOf("project_skill_promote")).toHaveLength(0);
    // One confirming button beside Cancel; nothing new.
    const share = screen.getByRole("button", { name: /^Share( with .*)?$/ });
    await user.click(share);
    await waitFor(() => expect(tauri.callsOf("project_skill_promote")).toHaveLength(1));
    // Round 2 (G3): the press carries the id of the bytes the page showed.
    expect(tauri.callsOf("project_skill_promote")[0].args).toMatchObject({ skill: "deploy", replace: false, shown: "id-of-the-text-shown" });
  });

  it("can be cancelled with nothing shared, and says a command at load in its own words", async () => {
    const { user, tauri } = await pressPromote({ asks: "inline" });
    expect(await screen.findByText(/^Its text runs a command when the skill loads\. Every other computer asks/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Share · 1 step")).toBeNull();
    expect(tauri.callsOf("project_skill_promote")).toHaveLength(0);
  });

  // Round 2 (G6): a name Windows can't have is said on the page, with the
  // button off, as a personal skill's Share page says it.
  it("says a refused name in place of the status line and keeps Share off", async () => {
    const refusal =
      "deploy holds “notes: v2.md”, a name Windows can't have, so Plyloft won't share it. Rename the file in the skill's folder.";
    const { user, tauri } = await pressPromote({ asks: "commands", asksId: "id", shareRefusal: refusal });
    expect(await screen.findByText(refusal)).toBeTruthy();
    expect(screen.queryByText(/^Its text lets agents run commands without asking\./)).toBeNull();
    const share = screen.getByRole("button", { name: /^Share( with .*)?$/ }) as HTMLButtonElement;
    expect(share.disabled).toBe(true);
    await user.click(share);
    expect(tauri.callsOf("project_skill_promote")).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("goes at once for a skill of plain text, as before", async () => {
    const { tauri } = await pressPromote({});
    await waitFor(() => expect(tauri.callsOf("project_skill_promote")).toHaveLength(1));
    expect(tauri.callsOf("project_skill_promote")[0].args).toMatchObject({ shown: null });
    expect(screen.queryByText("Share · 1 step")).toBeNull();
  });
});

describe("Promote to Team for a read-only member", () => {
  const READ_ONLY =
    "You can read the team library but not change it. Ask matteo for write access, or open a pull request from a fork on GitHub.";
  const NOTE =
    "This checkout's `deploy` has changes not on staging. Promote to Team shares the copy committed on staging; your local changes aren't included.";
  const withNote = { ...view.skills[0], promoteNote: NOTE };

  const rowText = () =>
    screen.getByRole("button", { name: "deploy" }).closest<HTMLElement>(".ux-row")?.textContent ?? "";

  async function promoteEntry(over: Partial<ProjectSkillsView>) {
    const { user, tauri } = render({
      project_skills_view: () => ({ ...view, skills: [withNote], ...over }),
    });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "deploy" });
    await user.click(screen.getByRole("button", { name: "More for deploy" }));
    await screen.findByRole("menuitem", { name: "Open in Code" });
    return screen.queryByRole("menuitem", { name: /Promote to Team|Replace in Team/ }) as HTMLButtonElement | null;
  }

  it("is off with GitHub's refusal, and the row says nothing of what it would share", async () => {
    const promote = await promoteEntry({ canPromote: false, promoteReason: READ_ONLY, promoteRefused: true });
    expect(promote?.textContent).toContain("Promote to Team");
    expect(promote?.disabled).toBe(true);
    expect(screen.getByRole(promote!.getAttribute("role")!, { description: READ_ONLY })).toBe(promote);
    expect(rowText()).not.toContain("Promote to Team shares");
  });

  it("stays on with the caveat when GitHub could not be asked", async () => {
    const promote = await promoteEntry({
      canPromote: true,
      promoteReason:
        "Plyloft has not been able to check your write access to the team repo with GitHub. Sharing may be refused when it reaches GitHub.",
    });
    expect(promote).toBeTruthy();
    expect(promote?.disabled).toBe(false);
    expect(rowText()).toContain("Promote to Team shares the copy committed on staging");
  });

  it("is not offered on a Mac with no team", async () => {
    const promote = await promoteEntry({
      configured: false,
      hasClone: false,
      canPromote: false,
      promoteReason: "This Mac is not on a team yet, so there is no team library to share with.",
      promoteRefused: false,
    });
    expect(promote).toBeNull();
  });
});

// H4 step 8 c (Challenger): the rows' model, here so vitest runs it (the
// hand-run `librarySkills.test.ts` holds the rest).
describe("a Promote shown off, everywhere the row's menu is read", () => {
  const READ_ONLY =
    "You can read the team library but not change it. Ask matteo for write access, or open a pull request from a fork on GitHub.";
  const BLOCKED = "The copies of `deploy` in this repo are not the same file. Make them match first.";
  const base: SkillsInput = {
    repository: [],
    mirror: [],
    team: [],
    personal: [],
    ply: [],
    shared: true,
    branch: "staging",
    branchReadOnly: false,
    branchSkills: ["deploy"],
    pending: [],
    removedUpstream: [],
    nowMs: 0,
    canPromote: false,
  };
  const repoSkill = (over: Record<string, unknown> = {}) => ({
    name: "deploy",
    description: "Ships it.",
    claude: true,
    codex: false,
    roots: [".claude/skills"],
    team: "differs" as const,
    ...over,
  });
  const teamSkill = {
    name: "deploy",
    description: "The team's.",
    plugin: "ply",
    claude: true,
    codex: true,
    repo: "differs" as const,
    dir: "/clone/deploy",
  };
  const rows = (over: Partial<SkillsInput>) => skillSections({ ...base, ...over }).flatMap((s) => s.rows);
  const entry = (row: { menu: unknown[] }, id: string) =>
    row.menu.find((e) => e !== "divider" && (e as { id: string }).id === id);

  it("a duplicate's Compare offers no Promote the ⋯ shows off — refused or blocked", () => {
    const refused = rows({ promoteRefusal: READ_ONLY, repository: [repoSkill()], team: [teamSkill] });
    const repo = refused.find((r) => r.scope === "repository")!;
    expect(entry(repo, "promote-to-team")).toMatchObject({ disabled: true, hint: READ_ONLY });
    expect(compareActions(repo).map((a) => a.id)).not.toContain("promote-to-team");

    const blocked = rows({ canPromote: true, repository: [repoSkill({ promoteBlocked: BLOCKED })], team: [teamSkill] });
    const blockedRepo = blocked.find((r) => r.scope === "repository")!;
    expect(entry(blockedRepo, "promote-to-team")).toMatchObject({ disabled: true, hint: BLOCKED });
    expect(compareActions(blockedRepo).map((a) => a.id)).not.toContain("promote-to-team");

    // Offered, it is still there to press.
    const offered = rows({ canPromote: true, repository: [repoSkill()], team: [teamSkill] });
    expect(compareActions(offered.find((r) => r.scope === "repository")!)).toContainEqual({
      id: "promote-to-team",
      label: "Promote this one to Team",
      confirm: true,
    });
  });

  // Walk follow-ups 2026-10-19: the Compare shows this checkout's copy, and a
  // Replace there shares the branch's — the row says which, and so does the
  // Compare's button (the `⋯`'s label, not "this one").
  it("a checkout copy that isn't what Promote shares names the copy it shares", () => {
    const NOTE =
      "This checkout's `deploy` has changes not on staging. Promote to Team shares the copy committed on staging; your local changes aren't included.";
    const apart = rows({ canPromote: true, repository: [repoSkill({ promoteNote: NOTE })], team: [teamSkill] }).find(
      (r) => r.scope === "repository",
    )!;
    expect(apart.promoteShares).toBe(
      "This checkout's `deploy` has changes not on staging. Replace in Team shares the copy committed on staging; your local changes aren't included.",
    );
    expect(compareActions(apart)).toContainEqual({ id: "promote-to-team", label: "Replace in Team…", confirm: true });
    // The same copy: "this one" is what goes.
    const same = rows({ canPromote: true, repository: [repoSkill()], team: [teamSkill] }).find((r) => r.scope === "repository")!;
    expect(same.promoteShares ?? null).toBeNull();
    // Refused, there is nothing it shares.
    const refused = rows({ promoteRefusal: READ_ONLY, repository: [repoSkill({ promoteNote: NOTE })], team: [teamSkill] }).find(
      (r) => r.scope === "repository",
    )!;
    expect(refused.promoteShares ?? null).toBeNull();
    // Challenger: a copy the team library already holds has no Promote to
    // press, so nothing to say it shares (the Compare keeps "in use here").
    const held = rows({ canPromote: true, repository: [repoSkill({ team: "same", promoteNote: NOTE })], team: [teamSkill] }).find(
      (r) => r.scope === "repository",
    )!;
    expect(entry(held, "promote-to-team")).toBeUndefined();
    expect(held.promoteShares ?? null).toBeNull();
    // Complete in Team (partial): the same note, its own label, no confirm.
    const partial = rows({ canPromote: true, repository: [repoSkill({ team: "partial", promoteNote: NOTE })], team: [teamSkill] }).find(
      (r) => r.scope === "repository",
    )!;
    expect(partial.promoteShares).toContain("Complete in Team shares the copy committed on staging");
    expect(compareActions(partial)).toContainEqual({ id: "promote-to-team", label: "Complete in Team" });
    // Solo mode has no team to promote to: nothing it shares.
    const solo = rows({ canPromote: false, repository: [repoSkill({ promoteNote: NOTE })], team: [] }).find(
      (r) => r.scope === "repository",
    )!;
    expect(solo.promoteShares ?? null).toBeNull();
  });

  it("a team row's Remove from Team… is off with GitHub's refusal, and absent without a team", () => {
    const team = (over: Partial<SkillsInput>) => rows({ team: [teamSkill], ...over }).find((r) => r.scope === "team")!;
    expect(entry(team({ promoteRefusal: READ_ONLY }), "remove-from-team")).toEqual({
      id: "remove-from-team",
      label: "Remove from Team…",
      danger: true,
      disabled: true,
      hint: READ_ONLY,
    });
    expect(entry(team({ canPromote: true }), "remove-from-team")).toEqual({
      id: "remove-from-team",
      label: "Remove from Team…",
      danger: true,
    });
    expect(entry(team({}), "remove-from-team")).toBeUndefined();
  });

  it("keeps the aligned copies' pull, without Promote, under the refusal", () => {
    const lint = (over: Partial<SkillsInput>) =>
      rows({
        repository: [
          repoSkill({
            name: "lint",
            codex: true,
            roots: [".claude/skills", ".agents/skills"],
            team: "absent",
            promoteBlocked: "The copies of `lint` in this repo are not the same file. Make them match first.",
          }),
        ],
        mirror: [{ name: "lint", description: "Lints.", dir: "/m/c", codexDir: "/m/x", claude: true, codex: true, differs: false }],
        branchSkills: ["lint"],
        ...over,
      })[0];
    const refused = lint({ promoteRefusal: READ_ONLY });
    expect(refused.notes).toContain(alignedOnBranchPullLine("lint", "staging"));
    expect(refused.notes.join(" ")).not.toMatch(/promoted/);
    expect(alignedOnBranchPullLine("lint", "staging")).toMatch(/Your project folder is behind staging\. Ask the Builder to bring the aligned copies here\.$/);
    expect(lint({ canPromote: true }).notes).toContain(alignedOnBranchLine("lint", "staging"));
  });
});
