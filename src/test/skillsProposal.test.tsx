// GH #271: the improvement proposal on the Skills list names the skill it is
// about and opens it, is drawn only under a scope that lists that skill, and a
// sentence that asks for something comes with the way to do it. GH #315: the
// page's own navigation (the narrow Instructions | Skills switch and scope
// picker) sits straight under the lede, above the proposal.
//
// The real Skills page on its real data hook, the proposal put in its store as
// `improvement_proposal_state` would answer it.
import { describe, expect, it } from "vitest";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import type { ProjectSkillsView } from "../ipc";
import type { ProposalView } from "../lib/proposals";
import { useLibrary } from "../store/libraryStore";
import { useProposal } from "../store/proposalStore";
import { act, renderUi, screen, waitFor } from "./render";

const WS = "ws-271";
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

function proposal(scope: "ply" | "this-mac", name: string): ProposalView {
  return {
    target: { kind: "elsewhere", name, scope },
    label: name,
    scope,
    path: `${name}/SKILL.md`,
    cardId: "c-1",
    cardRef: "#88",
    reason: "The Builder reported done twice before running PPVP.",
    words: "Add one line: run the checks before saying done.",
    diff: null,
    createdAt: Date.now() - 3 * 3600_000,
    canApprove: false,
  };
}

function Host({ controls }: { controls?: React.ReactNode }) {
  const data = useSkillsData(WS, true);
  return <SkillsPage workspaceId={WS} cwd={CWD} data={data} controls={controls} />;
}

function render(p: ProposalView, controls?: React.ReactNode) {
  act(() =>
    useProposal.setState({ byWorkspace: { [WS]: { view: p, loading: false, error: null } } }),
  );
  return renderUi(<Host controls={controls} />, {
    fixtures: {
      project_skills_view: () => view,
      personal_skill_share_preview: () => null,
      // An unshared workspace: the read is refused, which the page treats as ordinary.
      knowledge_project_state: () => {
        throw new Error("not shared");
      },
      personal_skills_view: () => ({
        skills: [
          {
            name: "deploy",
            codexName: null,
            description: "Ships it. Then checks it.",
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
      ply_skills_view: () => ({
        skills: [
          {
            name: "verify-before-done",
            title: "Verify before done",
            description: "Makes an agent check its own work.",
            dir: "/Applications/Ply.app/skills/verify-before-done",
            claude: true,
            codex: true,
            on: true,
          },
        ],
        problem: null,
      }),
    },
  });
}

const block = () => document.querySelector<HTMLElement>(".ux-proposal");

describe("GH #271: the proposal on the Skills list", () => {
  it("names its target with its section, and the name opens that skill's page", async () => {
    const { user, tauri } = render(proposal("ply", "verify-before-done"));
    tauri.allowUnhandled();
    const link = await screen.findByRole("button", { name: "verify-before-done" });
    expect(block()?.textContent).toContain("About verify-before-done · Comes with Plyloft");
    // A Ply skill cannot be brought into the repository: nothing asks for it.
    expect(block()?.textContent).not.toMatch(/Bring a copy/);
    expect(block()?.textContent).toContain("changes only when Plyloft is updated");

    await user.click(link);
    await waitFor(() =>
      expect(useLibrary.getState().byWorkspace[WS]?.openSkill).toBe("ply:verify-before-done"),
    );
    // On the skill's own page the block is drawn above its header, once.
    await waitFor(() => expect(document.querySelectorAll(".ux-proposal")).toHaveLength(1));
    const header = document.querySelector(".ux-page-header");
    expect(block()?.compareDocumentPosition(header!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("is absent under a scope that does not list its target", async () => {
    render(proposal("ply", "verify-before-done"));
    await screen.findByRole("button", { name: "verify-before-done" });
    act(() => useLibrary.getState().setScope(WS, "repository"));
    await waitFor(() => expect(block()).toBeNull());
    act(() => useLibrary.getState().setScope(WS, "this-mac"));
    expect(block()).toBeNull();
    act(() => useLibrary.getState().setScope(WS, "ply"));
    await waitFor(() => expect(block()).not.toBeNull());
  });

  it("offers the Promote a personal skill's proposal asks for", async () => {
    const { user } = render(proposal("this-mac", "deploy"));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "deploy" })).toHaveLength(2));
    expect(block()?.textContent).toContain("About deploy · On this Mac");
    expect(block()?.textContent).toContain("Promote it into this repository");
    const promote = screen.getByRole("button", { name: "Promote…" });
    await user.click(promote);
    expect(useLibrary.getState().byWorkspace[WS]?.flow).toEqual({
      kind: "promote",
      key: "this-mac:deploy",
    });
  });
});

describe("GH #104 walk (C2): the proposal names its source", () => {
  it("says the correction it comes from, and nothing when it named none", async () => {
    const sourced = {
      ...proposal("ply", "verify-before-done"),
      source: 'the human\'s correction: "every new function in math.js is named with a calc prefix"',
    };
    const { tauri, unmount } = render(sourced);
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "verify-before-done" });
    const line = block()?.querySelector("[data-ply-proposal-source]");
    expect(line?.textContent).toBe(
      "From your correction: “every new function in math.js is named with a calc prefix”",
    );
    // GH #104 walk 2: the byline agrees — the lesson is the human's.
    expect(block()?.querySelector(".ux-proposal-byline")?.textContent).toMatch(/^from your correction · /);
    unmount();

    const again = render(proposal("ply", "verify-before-done"));
    again.tauri.allowUnhandled();
    await screen.findByRole("button", { name: "verify-before-done" });
    expect(block()?.querySelector("[data-ply-proposal-source]")).toBeNull();
    expect(block()?.querySelector(".ux-proposal-byline")?.textContent).toMatch(/^from the Reviewer · /);
    expect(block()?.textContent).toContain("The Builder reported done twice");
  });
});

describe("GH #315: the page's own navigation stays under the lede", () => {
  it("draws the controls before the proposal block", async () => {
    render(proposal("ply", "verify-before-done"), <div data-testid="controls">switch</div>);
    await screen.findByRole("button", { name: "verify-before-done" });
    const controls = screen.getByTestId("controls");
    const lede = document.querySelector(".ux-page-header");
    expect(lede?.compareDocumentPosition(controls)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(controls.compareDocumentPosition(block()!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});
