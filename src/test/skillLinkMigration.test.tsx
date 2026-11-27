// Skills hub H3b (R-M) on the real Skills page and its data hook, through
// the stubbed Tauri layer:
//
// - an unlinked copy equal to a team version says so and offers Link, which
//   makes one Link card (`skills_hub_link`) and opens it;
// - two such copies offer Link all, which sends both in one press — one card;
// - a copy that isn't committed says so and offers nothing to press.
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import type { ProjectSkillsView, SkillLinkOffer } from "../ipc";
import { useToasts } from "../store/toastStore";
import { renderUi, screen, waitFor } from "./render";

const WS = "ws-skill-links";
const CWD = "/Users/someone/code/project";

function repoSkill(name: string) {
  return {
    name,
    codexName: null,
    description: `${name} skill.`,
    claude: true,
    codex: true,
    roots: [".claude/skills", ".agents/skills"],
    diverged: false,
    ignoredRoots: [],
    team: "same" as const,
    promoteBlocked: null,
  };
}

function view(names: string[]): ProjectSkillsView {
  return {
    workspaceId: WS,
    workspaceName: "project",
    cwd: CWD,
    skills: names.map(repoSkill),
    team: [],
    unloadable: [],
    rootsPresent: [".claude/skills", ".agents/skills"],
    ignoredRoots: [],
    configured: true,
    hasClone: true,
    canPromote: false,
    promoteReason: null,
    promotePlugin: "acme",
    errors: [],
  };
}

function offer(skill: string, over: Partial<SkillLinkOffer> = {}): SkillLinkOffer {
  return {
    skill,
    plugin: "acme",
    originWords: "the team library",
    versionCommit: "b7c1e09ffff",
    current: true,
    committed: true,
    ...over,
  };
}

function Host() {
  const data = useSkillsData(WS, true);
  return <SkillsPage workspaceId={WS} cwd={CWD} data={data} />;
}

function render(names: string[], offers: SkillLinkOffer[], extra: Record<string, unknown> = {}) {
  return renderUi(<Host />, {
    fixtures: {
      project_skills_view: () => view(names),
      knowledge_project_state: () => ({ shared: false, pending: [], branchSkills: [], branchSkillRows: [], skipped: [] }),
      personal_skills_view: () => ({ skills: [], rootsPresent: [], errors: [] }),
      skills_hub_links: () => ({ links: [], unreadable: [], offers }),
      ply_skills_view: () => ({ skills: [], problem: null }),
      ...extra,
    },
  });
}

function rowOf(name: string): HTMLElement {
  return screen.getByRole("button", { name }).closest<HTMLElement>(".ux-row")!;
}

const linkCard = (title: string) => ({
  card: { id: "card-l", workspaceId: WS, title, columnId: "complete", createdAt: 0, updatedAt: 0 },
  skipped: [],
});

describe("Skills hub H3b: Link an unlinked copy", () => {
  it("offers Link on a copy equal to an older team version, and makes one card", async () => {
    const { user, tauri } = render(["review-rules"], [offer("review-rules", { current: false })], {
      skills_hub_link: () => linkCard("Skill: link review-rules to the team library"),
    });
    tauri.allowUnhandled();
    await screen.findByText(/Same as an older version of the team library's review-rules · not linked/);
    // Owner, 2026-10-17: no commit id in the row's words.
    expect(screen.queryByText(/b7c1e09f/)).toBeNull();
    // One copy: its row's Link, and no Link all.
    expect(screen.queryByRole("button", { name: "Link all" })).toBeNull();
    await user.click(within(rowOf("review-rules")).getByRole("button", { name: "Link" }));
    await waitFor(() =>
      expect(tauri.callsOf("skills_hub_link")).toEqual([
        { cmd: "skills_hub_link", args: { workspaceId: WS, skills: ["review-rules"] } },
      ]),
    );
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.title)).toContain(
        "Card made: Skill: link review-rules to the team library",
      ),
    );
  });

  it("offers Link all for two copies and sends both in one press", async () => {
    const { user, tauri } = render(["other", "review-rules"], [offer("other"), offer("review-rules", { current: false })], {
      skills_hub_link: () => ({
        ...linkCard("Skill: link 2 skills to the team library"),
        skipped: [],
      }),
    });
    tauri.allowUnhandled();
    await screen.findByText("2 skills here are the same as a version in the team library and aren't linked yet.");
    await user.click(screen.getByRole("button", { name: "Link all" }));
    await waitFor(() => expect(tauri.callsOf("skills_hub_link")).toHaveLength(1));
    const [call] = tauri.callsOf("skills_hub_link");
    expect((call.args as { skills: string[] }).skills.slice().sort()).toEqual(["other", "review-rules"]);
  });

  it("says what Link all couldn't link", async () => {
    const { user, tauri } = render(["other", "review-rules"], [offer("other"), offer("review-rules")], {
      skills_hub_link: () => ({
        ...linkCard("Skill: link other to the team library"),
        skipped: [["review-rules", "already linked on main"]],
      }),
    });
    tauri.allowUnhandled();
    await user.click(await screen.findByRole("button", { name: "Link all" }));
    // Challenger (H3b): one toast — the card's, which also names what it
    // left out (a second toast would replace it: one at a time, GH #296).
    await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
    const [toast] = useToasts.getState().toasts;
    expect(toast.title).toBe("Card made: Skill: link other to the team library");
    expect(toast.body).toMatch(/Not linked: review-rules: already linked on main\.$/);
  });

  it("a copy not committed yet says so and offers nothing to press", async () => {
    const { tauri } = render(["review-rules"], [offer("review-rules", { committed: false })]);
    tauri.allowUnhandled();
    await screen.findByText(/not committed here yet/);
    expect(within(rowOf("review-rules")).queryByRole("button", { name: "Link" })).toBeNull();
  });
});
