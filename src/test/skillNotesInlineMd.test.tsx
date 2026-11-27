// SP-5 walk: the note a skill row (and its page) carries for two copies that
// are not the same file is the backend's sentence with `code` in it. It is
// drawn as code, never shown with raw backticks.
import { describe, expect, it } from "vitest";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import type { ProjectSkillsView } from "../ipc";
import { renderUi, screen, waitFor } from "./render";

const WS = "ws-notes";
const CWD = "/Users/someone/code/project";
const BLOCKED =
  "The copies of `review-rules` in this repo are not the same file, so Plyloft cannot tell which one the team should get. Make them match first.";

const view: ProjectSkillsView = {
  workspaceId: WS,
  workspaceName: "project",
  cwd: CWD,
  skills: [
    {
      name: "review-rules",
      codexName: null,
      description: "How reviews are done here.",
      claude: true,
      codex: true,
      roots: [".claude/skills", ".agents/skills"],
      diverged: true,
      ignoredRoots: [],
      team: "absent",
      promoteBlocked: BLOCKED,
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
};

function Host() {
  const data = useSkillsData(WS, true);
  return <SkillsPage workspaceId={WS} cwd={CWD} data={data} />;
}

describe("SP-5 walk: the copies-differ note", () => {
  it("draws `review-rules` as code on the row, with no raw backticks", async () => {
    const { tauri, user } = renderUi(<Host />, {
      fixtures: {
        project_skills_view: () => view,
        knowledge_project_state: () => {
          throw new Error("not shared");
        },
        personal_skills_view: () => ({ skills: [], rootsPresent: [], errors: [] }),
        skills_hub_links: () => ({ links: [], unreadable: [] }),
        ply_skills_view: () => ({ skills: [], problem: null }),
      },
    });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "review-rules" });
    await waitFor(() => expect(document.body.textContent).toContain("are not the same file"));
    expect(document.body.textContent).not.toContain("`");
    const code = [...document.querySelectorAll("code.ux-md-code")].map((c) => c.textContent);
    expect(code).toContain("review-rules");

    // And on the skill's own page.
    await user.click(screen.getByRole("button", { name: "review-rules" }));
    await waitFor(() => expect(document.querySelector(".ux-skill-facts")).toBeTruthy());
    expect(document.body.textContent).toContain("Make them match first.");
    expect(document.body.textContent).not.toContain("`");
  });
});
