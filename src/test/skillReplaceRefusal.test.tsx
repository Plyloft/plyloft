// The Replace question hangs on one refusal: Install or Promote found a
// different skill at a destination and wrote nothing. The backend rejects with
// that refusal as a value (`project_skills::NotTheSameSkill`), and the page
// asks by the value, never by the sentence — so a reworded message still asks,
// and a string that merely says the same words is only a toast.
//
// The real Skills page on its real data hook: `deploy` is a skill of your own
// on this Mac, promoted into this repository.
import { describe, expect, it } from "vitest";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import type { ProjectSkillsView } from "../ipc";
import { renderUi, screen, waitFor } from "./render";

const WS = "ws-replace";
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

async function promoteIntoRepository(refusal: unknown) {
  const r = renderUi(<Host />, {
    withToasts: true,
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
            dir: "/Users/someone/.claude/skills/deploy",
          },
        ],
        rootsPresent: [".claude/skills"],
        errors: [],
      }),
      skills_hub_links: () => ({ links: [], unreadable: [] }),
      ply_skills_view: () => ({ skills: [], problem: null }),
      personal_skill_promote: ({ replace }: Record<string, unknown>) => {
        if (!replace) throw refusal;
        return {
          skill: "deploy",
          plugin: null,
          copied: { written: [], unchanged: [], ignored: [], unknown: [] },
          committed: false,
          pushed: false,
        };
      },
    },
  });
  r.tauri.allowUnhandled();
  await screen.findByRole("button", { name: "deploy" });
  // Cold read 2026-10-19: drawn on hover or focus only, and still a button
  // Tab reaches (hidden by opacity, never removed).
  expect(screen.getByRole("button", { name: "Share…" }).closest(".ux-row-action-reveal")).not.toBeNull();
  await r.user.click(screen.getByRole("button", { name: "Share…" }));
  await screen.findByText(/Where should/);
  // (Challenger) Team is chosen to start with whenever the flow offers it.
  expect(screen.getByRole("radio", { name: /^Team/, checked: true })).toBeTruthy();
  expect(screen.getByText("Share · 1 step")).toBeTruthy();
  await r.user.click(screen.getByRole("radio", { name: /This repository/ }));
  const flowPromote = screen
    .getAllByRole("button", { name: "Share" })
    .find((b) => b.closest(".ux-flow"))!;
  await r.user.click(flowPromote);
  return r;
}

describe("the Replace question is asked by the refusal's value", () => {
  it("asks, whatever the words, and Replace passes `replace`", async () => {
    const { user, tauri } = await promoteIntoRepository({
      notTheSameSkill: `${CWD}/.claude/skills/deploy`,
      message: "Worded some new way entirely.",
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Replace deploy?");
    await user.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(tauri.callsOf("personal_skill_promote")).toHaveLength(2));
    expect(tauri.callsOf("personal_skill_promote").map((c) => c.args?.replace)).toEqual([
      false,
      true,
    ]);
  });

  it("does not ask for a plain string that says the old sentence", async () => {
    const said = `${CWD}/.claude/skills/deploy already exists and is not the same skill.`;
    const { tauri } = await promoteIntoRepository(said);
    expect(await screen.findByText(said)).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: /Replace/ })).toBeNull();
    expect(tauri.callsOf("personal_skill_promote")).toHaveLength(1);
  });
});
