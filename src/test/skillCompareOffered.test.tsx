// GH #312: the duplicate notice's Compare opens the comparison, and once the
// comparison is open the notice no longer offers it — a button that cannot do
// anything is not offered (PATTERNS.md §3). `Hide` on the comparison's own
// heading puts it away, and Compare is back.
//
// The real Skills page on its real data hook: `deploy` is both a skill of your
// own on this Mac and one that comes with Ply, so each page carries the notice.
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import type { ProjectSkillsView } from "../ipc";
import { useLibrary } from "../store/libraryStore";
import { act, renderUi, screen, waitFor } from "./render";

const WS = "ws-312";
const CWD = "/Users/someone/code/project";

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

describe("GH #312: Compare while the comparison is open", () => {
  it("is not offered on the notice while its comparison shows", async () => {
    const { user, tauri } = renderUi(<Host />, {
      fixtures: {
        project_skills_view: () => view,
        // An unshared workspace: the read is refused, which the page treats as ordinary.
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
              dir: "/Users/someone/.claude/skills/deploy",
            },
          ],
          rootsPresent: [".claude/skills"],
          errors: [],
        }),
        fs_list_dir: ({ path }: Record<string, unknown>) => [
          { name: "SKILL.md", path: `${String(path)}/SKILL.md`, isDir: false },
        ],
        // Two copies that differ, so the notice has something to compare.
        fs_read_text_file: ({ path }: Record<string, unknown>) =>
          String(path).startsWith("/Applications") ? "# Deploy\nPly's way.\n" : "# Deploy\nMine.\n",
        skills_hub_links: () => ({ links: [], unreadable: [] }),
        ply_skills_view: () => ({
          skills: [
            {
              name: "deploy",
              title: "Deploy",
              description: "Ships it, Plyloft's way.",
              dir: "/Applications/Ply.app/skills/deploy",
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
    act(() => useLibrary.getState().openSkill(WS, "this-mac:deploy"));
    const notice = () => document.querySelector<HTMLElement>(".ux-notice")!;
    await waitFor(() => expect(notice()).not.toBeNull());
    await user.click(within(notice()).getByRole("button", { name: "Compare" }));
    await waitFor(() =>
      expect(useLibrary.getState().byWorkspace[WS]?.compare).toEqual({
        key: "this-mac:deploy",
        what: "duplicate",
      }),
    );
    const hide = await screen.findByRole("button", { name: "Hide" });
    expect(within(notice()).queryByRole("button", { name: "Compare" })).toBeNull();
    // The notice itself stays: it still says what the two copies are.
    expect(notice().querySelector(".ux-notice-text")?.textContent).toBeTruthy();

    await user.click(hide);
    await waitFor(() =>
      expect(within(notice()).getByRole("button", { name: "Compare" })).toBeTruthy(),
    );
  });
});
