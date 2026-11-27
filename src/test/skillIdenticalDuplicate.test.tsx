// Decision §6 (group B): a skill at two scopes whose copies are the same whole
// tree — what a Promote or an Install leaves behind — shows only the `Also …`
// chip: no duplicate notice on its page and no `Compare` as the row's action.
// As soon as either copy changes (the digests differ) the notice is back.
//
// The real Skills page on its real data hook: `deploy` is a skill of your own on
// this Mac and one that comes with Plyloft.
import { describe, expect, it } from "vitest";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import type { ProjectSkillsView } from "../ipc";
import { useLibrary } from "../store/libraryStore";
import { act, renderUi, screen, waitFor } from "./render";

const WS = "ws-identical";
const CWD = "/Users/someone/code/project";
const MINE = "/Users/someone/.claude/skills/deploy";
const PLYS = "/Applications/Ply.app/skills/deploy";

const view: ProjectSkillsView = {
  workspaceId: WS,
  workspaceName: "project",
  cwd: CWD,
  skills: [],
  team: [],
  unloadable: [],
  rootsPresent: [],
  ignoredRoots: [],
  configured: false,
  hasClone: false,
  canPromote: false,
  promoteReason: null,
  promotePlugin: "ply-team",
  errors: [],
};

function Host() {
  const data = useSkillsData(WS, true);
  return <SkillsPage workspaceId={WS} cwd={CWD} data={data} />;
}

async function openDeploy(digests: Record<string, string>) {
  let asked: string[][] | null = null;
  const { tauri } = renderUi(<Host />, {
    fixtures: {
      project_skills_view: () => view,
      knowledge_project_state: () => {
        throw new Error("not shared");
      },
      personal_skills_view: () => ({
        skills: [
          {
            name: "deploy",
            codexName: null,
            description: "Ships it.",
            claude: true,
            codex: false,
            roots: [".claude/skills"],
            dir: MINE,
          },
        ],
        rootsPresent: [".claude/skills"],
        errors: [],
      }),
      fs_list_dir: ({ path }: Record<string, unknown>) => [
        { name: "SKILL.md", path: `${String(path)}/SKILL.md`, isDir: false },
      ],
      fs_read_text_file: () => "# Deploy\nShips it.\n",
      skill_tree_digests: ({ groups, workspaceId }: Record<string, unknown>) => {
        // The backend answers only inside this workspace's skill places (L9).
        expect(workspaceId).toBe(WS);
        asked = groups as string[][];
        return asked.map((dirs) => digests[dirs[0]] ?? null);
      },
      skills_hub_links: () => ({ links: [], unreadable: [] }),
      ply_skills_view: () => ({
        skills: [
          {
            name: "deploy",
            title: "Deploy",
            description: "Ships it.",
            dir: PLYS,
            claude: true,
            codex: true,
            on: true,
          },
        ],
        problem: null,
      }),
    },
  });
  tauri.allowUnhandled();
  await screen.findByRole("button", { name: "deploy" });
  await waitFor(() => expect(asked).not.toBeNull());
  act(() => useLibrary.getState().openSkill(WS, "this-mac:deploy"));
  await screen.findByRole("button", { name: "Reveal in Finder" });
  return () => asked;
}

describe("Decision §6: no duplicate notice when the copies are identical", () => {
  it("shows only the chip while both copies are the same tree", async () => {
    const asked = await openDeploy({ [MINE]: "abc", [PLYS]: "abc" });
    // Both copies were asked about, each as its own directory.
    expect(asked()).toEqual(expect.arrayContaining([[MINE], [PLYS]]));
    // Give the page its settled read, then: no notice…
    await act(async () => {});
    expect(document.querySelector(".ux-notice")).toBeNull();
    // …and back in the list the chip is still there (it is the fact).
    act(() => useLibrary.getState().openSkill(WS, null));
    expect((await screen.findAllByText(/^Also /)).length).toBeGreaterThan(0);
  });

  it("brings the notice back when either copy differs", async () => {
    await openDeploy({ [MINE]: "abc", [PLYS]: "def" });
    await waitFor(() => expect(document.querySelector(".ux-notice")).not.toBeNull());
  });
});
