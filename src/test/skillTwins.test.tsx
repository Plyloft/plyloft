// Skills hub H5 (R12) on the real Skills page and its data hook, through
// the stubbed Tauri layer:
//
// - the Claude copy edited alone says *Codex copy will follow the Claude
//   copy at the next ship*, and the ⋯ Align makes the card with no question;
// - both copies edited apart say *Claude and Codex copies differ*; Align asks
//   which wins and makes the card with that choice;
// - a legacy `.codex/skills` copy that disagrees is said, never aligned;
// - a refusal that waits for an Align offers it on its toast.
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import type { ProjectSkillsView, SkillLinkRow, SkillTwinRow } from "../ipc";
import { useToasts } from "../store/toastStore";
import { useKanban } from "../store/kanbanStore";
import { renderUi, screen, waitFor } from "./render";

const WS = "ws-skill-twins";
const CWD = "/Users/someone/code/project";

const view: ProjectSkillsView = {
  workspaceId: WS,
  workspaceName: "project",
  cwd: CWD,
  skills: [
    {
      name: "review-rules",
      codexName: null,
      description: "Reviews the change.",
      claude: true,
      codex: true,
      roots: [".claude/skills", ".agents/skills"],
      diverged: true,
      ignoredRoots: [],
      team: "absent",
      promoteBlocked: null,
    },
  ],
  team: [],
  unloadable: [],
  rootsPresent: [".claude/skills", ".agents/skills"],
  ignoredRoots: [],
  configured: true,
  hasClone: true,
  canPromote: false,
  promoteReason: null,
  promotePlugin: "",
  errors: [],
};

const card = (title: string, winner: "claude" | "codex") => ({
  id: "card-5",
  workspaceId: WS,
  title,
  columnId: "complete",
  createdAt: 0,
  updatedAt: 0,
  kind: {
    type: "skill",
    verb: "align",
    skill: "review-rules",
    alignWinner: winner,
    origin: { kind: "", source: "", name: "", version: { commit: "", contentId: "" } },
  },
});

function twin(twins: SkillTwinRow["twins"], extra: Partial<SkillTwinRow> = {}): SkillTwinRow {
  return { skill: "review-rules", twins, line: "", legacy: false, committed: true, ...extra };
}

function Host() {
  const data = useSkillsData(WS, true);
  return <SkillsPage workspaceId={WS} cwd={CWD} data={data} />;
}

function render(twins: SkillTwinRow[], links: SkillLinkRow[] = [], extra: Record<string, unknown> = {}) {
  return renderUi(<Host />, {
    fixtures: {
      project_skills_view: () => view,
      knowledge_project_state: () => ({ shared: false, pending: [], branchSkills: [], branchSkillRows: [], skipped: [] }),
      personal_skills_view: () => ({ skills: [], rootsPresent: [], errors: [] }),
      skills_hub_links: () => ({ links, unreadable: [], twins }),
      ply_skills_view: () => ({ skills: [], problem: null }),
      ...extra,
    },
  });
}

function rowOf(name: string): HTMLElement {
  return screen.getByRole("button", { name }).closest<HTMLElement>(".ux-row")!;
}

describe("Skills hub H5: the Claude and Codex copies", () => {
  it("says the Codex copy will follow, and Align makes the card at once", async () => {
    const { user, tauri } = render([twin({ state: "follows", winner: "claude" })], [], {
      skills_hub_align: () => ({ card: card("Skill: align review-rules (Codex's copy follows Claude's)", "claude"), winner: "claude", legacyNote: null }),
    });
    tauri.allowUnhandled();
    await screen.findByText(/The Codex copy gets the Claude copy's changes when the next card ships/);
    const row = rowOf("review-rules");
    await user.click(within(row).getByRole("button", { name: "More for review-rules" }));
    await user.click(screen.getByRole("menuitem", { name: "Align" }));
    await waitFor(() => expect(tauri.callsOf("skills_hub_align")).toHaveLength(1));
    expect(tauri.callsOf("skills_hub_align")[0].args).toEqual({ workspaceId: WS, skill: "review-rules", winner: null });
    await waitFor(() =>
      expect(
        useToasts.getState().toasts.some(
          (t) => t.title === "Card made: Skill: align review-rules (Codex's copy follows Claude's)",
        ),
      ).toBe(true),
    );
    // No question was asked.
    expect(screen.queryByRole("radio", { name: /Claude's copy/ })).toBeNull();
  });

  it("says the copies differ, and Align asks which wins", async () => {
    const { user, tauri } = render([twin({ state: "differ" })], [], {
      skills_hub_align: () => ({ card: card("Skill: align review-rules (Claude's copy follows Codex's)", "codex"), winner: "codex", legacyNote: null }),
    });
    tauri.allowUnhandled();
    await screen.findByText("Claude and Codex copies differ.");
    const row = rowOf("review-rules");
    await user.click(within(row).getByRole("button", { name: "Align" }));
    expect(await screen.findByText(/Both changed, so Plyloft can't tell which one is meant/)).toBeTruthy();
    expect(screen.getByText(/One card, with one commit/)).toBeTruthy();
    // Owner, 2026-10-19: nothing is chosen for the person.
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    expect((screen.getByRole("button", { name: "Align" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("radio", { name: /^Codex's copy/ }));
    expect((screen.getByRole("button", { name: "Align" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Align" }));
    await waitFor(() => expect(tauri.callsOf("skills_hub_align")).toHaveLength(1));
    expect(tauri.callsOf("skills_hub_align")[0].args).toEqual({ workspaceId: WS, skill: "review-rules", winner: "codex" });
  });

  it("says a legacy copy is never written and offers no Align for it", async () => {
    const { tauri } = render([twin({ state: "aligned" }, { legacy: true })]);
    tauri.allowUnhandled();
    await screen.findByText(/\.codex\/skills\/review-rules is an old copy from before Plyloft managed skills; Plyloft no longer updates it. Remove it in a card/);
    const row = rowOf("review-rules");
    expect(within(row).queryByRole("button", { name: "Align" })).toBeNull();
  });

  it("offers Align on the toast of a choice that waits for it", async () => {
    const link: SkillLinkRow = {
      skill: "review-rules",
      originKind: "team",
      originWords: "the team library",
      source: "acme/team",
      plugin: "acme",
      versionCommit: "a3f9c21",
      state: "bothChanged",
      upstreamMoved: true,
    };
    const { user, tauri } = render([twin({ state: "follows", winner: "claude" })], [link], {
      skills_hub_compare3: () => ({
        skill: "review-rules",
        originWords: "the team library",
        baseLabel: "The team library when linked",
        upstreamLabel: "The team library now",
        hereLabel: "This repository",
        files: [{ path: "SKILL.md", status: "both", base: "a\n", upstream: "b\n", here: "c\n", notShown: false }],
        note: null,
        state: "bothChanged",
        proposeBlocked: null,
      }),
      skills_hub_align: () => ({ card: card("Skill: align review-rules (Codex's copy follows Claude's)", "claude"), winner: "claude", legacyNote: null }),
      skills_hub_keep_mine: () => {
        throw new Error(
          "The Claude and Codex copies of review-rules here differ, so Plyloft can't tell which one is yours. Align them first, then keep yours.",
        );
      },
    });
    tauri.allowUnhandled();
    await screen.findByText(/changed here and in the team library/);
    // One copy waiting to follow keeps the library's Compare as the row's
    // action; its Keep mine is refused with the way out.
    await user.click(within(rowOf("review-rules")).getByRole("button", { name: /^Compare/ }));
    await user.click(await screen.findByRole("radio", { name: /^Keep mine/ }));
    await user.click(screen.getByRole("button", { name: "Keep mine" }));
    await waitFor(() =>
      expect(useToasts.getState().toasts.some((t) => t.action?.label === "Align")).toBe(true),
    );
    useToasts.getState().toasts.find((t) => t.action?.label === "Align")!.action!.onClick();
    await waitFor(() => expect(tauri.callsOf("skills_hub_align")).toHaveLength(1));
    expect(tauri.callsOf("skills_hub_align")[0].args).toEqual({ workspaceId: WS, skill: "review-rules", winner: null });
  });

  it("offers no Align on that toast when the difference is only in this checkout (Reviewer)", async () => {
    const link: SkillLinkRow = {
      skill: "review-rules",
      originKind: "team",
      originWords: "the team library",
      source: "acme/team",
      plugin: "acme",
      versionCommit: "a3f9c21",
      state: "bothChanged",
      upstreamMoved: true,
    };
    const refusal =
      "The Claude and Codex copies of review-rules here differ, so Plyloft can't tell which one is yours. Align them first, then keep yours.";
    const { user, tauri } = render([twin({ state: "follows", winner: "claude" }, { committed: false })], [link], {
      skills_hub_compare3: () => ({
        skill: "review-rules",
        originWords: "the team library",
        baseLabel: "The team library when linked",
        upstreamLabel: "The team library now",
        hereLabel: "This repository",
        files: [{ path: "SKILL.md", status: "both", base: "a\n", upstream: "b\n", here: "c\n", notShown: false }],
        note: null,
        state: "bothChanged",
        proposeBlocked: null,
      }),
      skills_hub_keep_mine: () => {
        throw new Error(refusal);
      },
    });
    tauri.allowUnhandled();
    await screen.findByText(/changed here and in the team library/);
    await user.click(within(rowOf("review-rules")).getByRole("button", { name: /^Compare/ }));
    await user.click(await screen.findByRole("radio", { name: /^Keep mine/ }));
    await user.click(screen.getByRole("button", { name: "Keep mine" }));
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => t.body === refusal)).toBe(true));
    // An Align there would open nothing: no card can carry it yet.
    expect(useToasts.getState().toasts.find((t) => t.body === refusal)!.action).toBeUndefined();
  });

  it("puts Align first when both copies of a linked skill changed (R3 edge: R12 first)", async () => {
    const link: SkillLinkRow = {
      skill: "review-rules",
      originKind: "team",
      originWords: "the team library",
      source: "acme/team",
      plugin: "acme",
      versionCommit: "a3f9c21",
      state: "bothChanged",
      upstreamMoved: true,
    };
    const { user, tauri } = render([twin({ state: "differ" })], [link], {
      skills_hub_compare3: () => ({
        skill: "review-rules",
        originWords: "the team library",
        baseLabel: "The team library when linked",
        upstreamLabel: "The team library now",
        hereLabel: "This repository",
        files: [{ path: "SKILL.md", status: "both", base: "a\n", upstream: "b\n", here: "c\n", notShown: false }],
        note: null,
        state: "bothChanged",
        proposeBlocked: null,
      }),
    });
    tauri.allowUnhandled();
    await screen.findByText(/changed here and in the team library/);
    expect(within(rowOf("review-rules")).getByRole("button", { name: "Align" })).toBeTruthy();
    // Owner-fixes walk: Align has the row, and the ⋯'s Compare with the
    // library is still the 3-way one — the team's version now, and the choices.
    await user.click(within(rowOf("review-rules")).getByRole("button", { name: "More for review-rules" }));
    await user.click(screen.getByRole("menuitem", { name: "Compare with the library" }));
    await waitFor(() => expect(tauri.callsOf("skills_hub_compare3")).toHaveLength(1));
    expect(await screen.findByRole("radio", { name: /^Keep mine/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Take theirs|^Take the library/ })).toBeTruthy();
  });

  it("puts the 3-way Compare first once the two copies of a Both changed skill are aligned", async () => {
    const link: SkillLinkRow = {
      skill: "review-rules",
      originKind: "team",
      originWords: "the team library",
      source: "acme/team",
      plugin: "acme",
      versionCommit: "a3f9c21",
      state: "bothChanged",
      upstreamMoved: true,
    };
    const { user, tauri } = render([twin({ state: "aligned" })], [link], {
      skills_hub_compare3: () => ({
        skill: "review-rules",
        originWords: "the team library",
        baseLabel: "The team library when linked",
        upstreamLabel: "The team library now",
        hereLabel: "This repository",
        files: [{ path: "SKILL.md", status: "both", base: "a\n", upstream: "b\n", here: "c\n", notShown: false }],
        note: null,
        state: "bothChanged",
        proposeBlocked: null,
      }),
    });
    tauri.allowUnhandled();
    await screen.findByText(/changed here and in the team library/);
    await user.click(within(rowOf("review-rules")).getByRole("button", { name: /^Compare/ }));
    await waitFor(() => expect(tauri.callsOf("skills_hub_compare3")).toHaveLength(1));
    expect(await screen.findByRole("radio", { name: /^Keep mine/ })).toBeTruthy();
  });

  it("in a shared workspace, a skill its branch doesn't carry yet aligns by card (Reviewer, H5 Mac walk)", async () => {
    const { user, tauri } = render([twin({ state: "follows", winner: "codex" })], [], {
      knowledge_project_state: () => ({
        shared: true,
        branch: "walk-1014",
        readOnly: false,
        pending: [],
        branchSkills: [],
        branchSkillRows: [],
        skipped: [],
      }),
      skills_hub_align: () => ({ card: card("Skill: align review-rules (Claude's copy follows Codex's)", "codex"), winner: "codex", legacyNote: null }),
    });
    tauri.allowUnhandled();
    await screen.findByText(/The Claude copy gets the Codex copy's changes when the next card ships/);
    await user.click(within(rowOf("review-rules")).getByRole("button", { name: "More for review-rules" }));
    await user.click(screen.getByRole("menuitem", { name: "Align" }));
    await waitFor(() => expect(tauri.callsOf("skills_hub_align")).toHaveLength(1));
    expect(tauri.callsOf("skills_hub_align")[0].args).toEqual({ workspaceId: WS, skill: "review-rules", winner: null });
  });

  it("says which card holds the Align back when one already changes the skill (Reviewer, H5 Mac re-walk)", async () => {
    const update = {
      ...card("Skill: update review-rules from the team library", "claude"),
      id: "card-old",
      kind: { ...card("", "claude").kind, verb: "update", alignWinner: null },
    };
    useKanban.setState({ byWorkspace: { [WS]: { cards: [update as never], loaded: true } } });
    const { user, tauri } = render([twin({ state: "follows", winner: "codex" })]);
    tauri.allowUnhandled();
    await screen.findByText(/The Claude copy gets the Codex copy's changes when the next card ships/);
    expect(
      screen.getByText(/The card "Skill: update review-rules from the team library" already changes review-rules\. Ship it or delete it, then Align\./),
    ).toBeTruthy();
    await user.click(within(rowOf("review-rules")).getByRole("button", { name: "More for review-rules" }));
    expect(screen.queryByRole("menuitem", { name: "Align" })).toBeNull();
    useKanban.setState({ byWorkspace: {} });
  });

  it("says a difference only in the project folder ships with a card first (QoL 13.2)", async () => {
    const { user, tauri } = render([twin({ state: "differ" }, { committed: false })]);
    tauri.allowUnhandled();
    await screen.findByText(/differ only in your project folder\. Ship it with a card first, then Align\./);
    const row = rowOf("review-rules");
    expect(within(row).queryByRole("button", { name: "Align" })).toBeNull();
    await user.click(within(row).getByRole("button", { name: "More for review-rules" }));
    expect(screen.queryByRole("menuitem", { name: "Align" })).toBeNull();
  });
});
