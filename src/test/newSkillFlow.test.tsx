// Group B decision §3: `New skill…` in Library › Skills — a Flow that asks a
// name and a one-line description, writes the same SKILL.md for both CLIs in
// the checkout (`project_skill_create`), and opens Claude's copy in Code.
//
// The real Skills page on its real data hook.
import { describe, expect, it } from "vitest";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import type { ProjectSkillsView } from "../ipc";
import { useEditor } from "../store/editorStore";
import { useLibrary } from "../store/libraryStore";
import { renderUi, screen, waitFor } from "./render";

const WS = "ws-new-skill";
const CWD = "/Users/someone/code/project";
const CLAUDE_FILE = `${CWD}/.claude/skills/deploy-checklist/SKILL.md`;

function view(overrides: Partial<ProjectSkillsView> = {}): ProjectSkillsView {
  return {
    workspaceId: WS,
    workspaceName: "project",
    cwd: CWD,
    skills: [
      {
        name: "release",
        codexName: null,
        description: "Use when releasing.",
        claude: true,
        codex: true,
        roots: [".claude/skills", ".agents/skills"],
        diverged: false,
        ignoredRoots: [],
        team: "absent",
        promoteBlocked: null,
      },
    ],
    team: [],
    unloadable: [],
    rootsPresent: [".claude/skills", ".agents/skills"],
    ignoredRoots: [],
    configured: false,
    hasClone: false,
    canPromote: false,
    promoteReason: null,
    promotePlugin: "ply-team",
    errors: [],
    ...overrides,
  };
}

function Host() {
  const data = useSkillsData(WS, true);
  return <SkillsPage workspaceId={WS} cwd={CWD} data={data} />;
}

function fixtures(projectView: ProjectSkillsView, create?: (args: Record<string, unknown>) => unknown) {
  return {
    project_skills_view: () => projectView,
    knowledge_project_state: () => {
      throw new Error("not shared");
    },
    personal_skills_view: () => ({ skills: [], rootsPresent: [], errors: [] }),
    skills_hub_links: () => ({ links: [], unreadable: [] }),
    ply_skills_view: () => ({ skills: [], problem: null }),
    fs_read_text_file: () => "---\nname: deploy-checklist\n---\n",
    project_skill_create:
      create ??
      (() => ({
        name: "deploy-checklist",
        claudeFile: CLAUDE_FILE,
        codexFile: `${CWD}/.agents/skills/deploy-checklist/SKILL.md`,
      })),
  };
}

const createButton = () => screen.getByRole("button", { name: /Create and open in Code/ });

describe("Decision §3: New skill…", () => {
  it("checks the name, writes both copies and opens Claude's in Code", async () => {
    const { user, tauri } = renderUi(<Host />, { fixtures: fixtures(view()) });
    await user.click(await screen.findByRole("button", { name: "New skill…" }));
    expect(useLibrary.getState().byWorkspace[WS]?.flow?.kind).toBe("new-skill");
    // The closing line says where both copies go and how they stay in step.
    expect(screen.getByText(/Edit both copies, or Align them once published/)).toBeTruthy();
    expect(createButton()).toHaveProperty("disabled", true);

    const name = screen.getByRole("textbox", { name: "Name" });
    const description = screen.getByRole("textbox", { name: "Description" });
    await user.type(name, "Deploy");
    expect(screen.getByText("Use lowercase letters, digits and hyphens only.")).toBeTruthy();
    await user.clear(name);
    // Taken: the repository already has `release`.
    await user.type(name, "release");
    expect(screen.getByText(/already has a skill called release/)).toBeTruthy();
    await user.clear(name);
    await user.type(name, "deploy-checklist");
    expect(createButton()).toHaveProperty("disabled", true);
    await user.type(description, "Use when deploying to production.");
    expect(createButton()).toHaveProperty("disabled", false);

    await user.click(createButton());
    await waitFor(() => expect(tauri.callsOf("project_skill_create")).toHaveLength(1));
    expect(tauri.callsOf("project_skill_create")[0].args).toEqual({
      workspaceId: WS,
      name: "deploy-checklist",
      description: "Use when deploying to production.",
    });
    await waitFor(() =>
      expect(
        useEditor.getState().byWorkspace[WS]?.openFiles.some((f) => f.path === CLAUDE_FILE),
      ).toBe(true),
    );
    expect(useLibrary.getState().byWorkspace[WS]?.flow).toBeNull();
  });

  it("refuses while a root it writes is gitignored, and offers Un-ignore", async () => {
    const { user } = renderUi(<Host />, {
      fixtures: fixtures(view({ ignoredRoots: [".agents/skills"] })),
    });
    await user.click(await screen.findByRole("button", { name: "New skill…" }));
    expect(screen.getByText(/Git ignores \.agents\/skills here/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Let Git see it" })).toBeTruthy();
    expect(createButton()).toHaveProperty("disabled", true);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveProperty("disabled", true);
  });

  it("keeps the flow open with the backend's refusal", async () => {
    const { user } = renderUi(<Host />, {
      fixtures: fixtures(view(), () => {
        throw "This workspace is not a git repository, so a skill here could not be shipped with a card. Open a repository to add one.";
      }),
    });
    await user.click(await screen.findByRole("button", { name: "New skill…" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "deploy-checklist");
    await user.type(screen.getByRole("textbox", { name: "Description" }), "Use when deploying.");
    await user.click(createButton());
    expect(await screen.findByText(/not a git repository/)).toBeTruthy();
    expect(useLibrary.getState().byWorkspace[WS]?.flow?.kind).toBe("new-skill");
  });
});
