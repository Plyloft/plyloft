// Skills hub H3a on the real Skills page and its data hook, through the
// stubbed Tauri layer:
//
// - Install makes a skill card (`skills_hub_install`), says so, and writes
//   nothing itself;
// - a linked copy with an update says so and offers Update;
// - a linked copy modified here offers only Compare — 2-way, read only —
//   and never Update.
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { SkillsPage } from "../components/library/SkillsPage";
import { isSkillFilePath, useSkillsData } from "../components/library/useSkillsData";
import type { KanbanCard, ProjectSkillsView, SkillLinkRow } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { useToasts } from "../store/toastStore";
import { useLibrary } from "../store/libraryStore";
import { useSkillsHub } from "../store/skillsHubStore";
import { act, renderUi, screen, waitFor } from "./render";

const WS = "ws-skill-cards";
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
      diverged: false,
      ignoredRoots: [],
      team: "same",
      promoteBlocked: null,
    },
  ],
  team: [
    {
      name: "lint",
      codexName: null,
      description: "Lints the change.",
      plugin: "acme",
      claude: true,
      codex: true,
      repo: "absent",
      ignoredRoots: [],
      unknownRoots: [],
      dir: "/Users/someone/team/library/claude/acme/skills/lint",
    },
  ],
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

function link(state: SkillLinkRow["state"], upstreamMoved = false): SkillLinkRow {
  return {
    skill: "review-rules",
    originKind: "team",
    originWords: "the team library",
    source: "acme/team",
    plugin: "acme",
    versionCommit: "a3f9c21",
    state,
    upstreamMoved,
  };
}

function Host() {
  const data = useSkillsData(WS, true);
  return <SkillsPage workspaceId={WS} cwd={CWD} data={data} />;
}

function render(links: SkillLinkRow[], extra: Record<string, unknown> = {}) {
  return renderUi(<Host />, {
    fixtures: {
      project_skills_view: () => view,
      knowledge_project_state: () => ({ shared: false, pending: [], branchSkills: [], branchSkillRows: [], skipped: [] }),
      personal_skills_view: () => ({ skills: [], rootsPresent: [], errors: [] }),
      skills_hub_links: () => ({ links, unreadable: [] }),
      ply_skills_view: () => ({ skills: [], problem: null }),
      ...extra,
    },
  });
}

function rowOf(name: string): HTMLElement {
  return screen.getByRole("button", { name }).closest<HTMLElement>(".ux-row")!;
}

describe("Skills hub H3a: Install makes a skill card", () => {
  it("calls skills_hub_install and says which card carries it", async () => {
    const card = {
      id: "card-1",
      workspaceId: WS,
      title: "Skill: install lint from the team library",
      columnId: "complete",
      createdAt: 0,
      updatedAt: 0,
    };
    const { user, tauri } = render([], { skills_hub_install: () => ({ kind: "card", card }) });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "lint" });
    await user.click(within(rowOf("lint")).getByRole("button", { name: "Install" }));
    await waitFor(() =>
      expect(tauri.callsOf("skills_hub_install")).toEqual([
        { cmd: "skills_hub_install", args: { workspaceId: WS, plugin: "acme", skill: "lint", replace: false } },
      ]),
    );
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.title)).toContain(
        "Card made: Skill: install lint from the team library",
      ),
    );
    expect(tauri.callsOf("project_skill_install")).toHaveLength(0);
  });

  // Challenger (H3a): a skill whose scripts wait for this Mac's OK is never
  // put in a card; the refusal's toast opens the Needs your OK sheet.
  it("a skill whose scripts wait for an OK is refused, with Review", async () => {
    const { user, tauri } = render([], {
      skills_hub_install: () => {
        throw new Error(
          "lint brings a script you haven't said OK to on this Mac, so Plyloft won't put it in a card yet. Open it in the Library's team section and press Review; once you say OK, try again.",
        );
      },
    });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "lint" });
    await user.click(within(rowOf("lint")).getByRole("button", { name: "Install" }));
    await waitFor(() =>
      expect(useToasts.getState().toasts.some((t) => t.title === "Couldn't install the skill")).toBe(true),
    );
    const toast = useToasts.getState().toasts.find((t) => t.title === "Couldn't install the skill")!;
    expect(toast.body).toMatch(/haven't said OK to/);
    expect(toast.action?.label).toBe("Review");
    toast.action!.onClick();
    expect(useLibrary.getState().byWorkspace[WS]?.flow).toEqual({ kind: "scripts", key: "team:lint" });
  });
});

describe("Skills hub H3a: a linked copy", () => {
  it("with an update says so and offers Update", async () => {
    const { user, tauri } = render([link("updateAvailable")], {
      skills_hub_update: () => ({ id: "card-2", workspaceId: WS, title: "Skill: update review-rules from the team library", columnId: "complete", createdAt: 0, updatedAt: 0 }),
    });
    tauri.allowUnhandled();
    await screen.findByText(/Linked to the team library · update available/);
    const row = rowOf("review-rules");
    expect(within(row).getByText("Update available")).toBeTruthy();
    await user.click(within(row).getByRole("button", { name: /^Update/ }));
    await waitFor(() =>
      expect(tauri.callsOf("skills_hub_update")).toEqual([
        { cmd: "skills_hub_update", args: { workspaceId: WS, skill: "review-rules" } },
      ]),
    );
  });

  // Mac walk 2: right after the Update card shipped the row still said
  // "update available" until the next load — a skill card landing reloads it.
  it("reads the links again once a skill card of this board ships", async () => {
    let links = [link("updateAvailable")];
    const card = {
      id: "card-3",
      workspaceId: WS,
      title: "Skill: update review-rules from the team library",
      columnId: "complete",
      createdAt: 0,
      updatedAt: 0,
      kind: {
        type: "skill",
        verb: "update",
        skill: "review-rules",
        origin: { kind: "team", source: "acme/team", name: "review-rules", version: { commit: "b", contentId: "b" } },
      },
    } as KanbanCard;
    useKanban.setState({ byWorkspace: { [WS]: { cards: [card], loaded: true } } });
    const { tauri } = render([], { skills_hub_links: () => ({ links, unreadable: [] }) });
    tauri.allowUnhandled();
    await screen.findByText(/being updated by .* — ship the card to finish/);
    links = [link("upToDate")];
    act(() => {
      useKanban.setState({ byWorkspace: { [WS]: { cards: [{ ...card, shipStatus: "shipped" }], loaded: true } } });
    });
    expect(await screen.findByText(/Linked to the team library · up to date/)).toBeTruthy();
    expect(screen.queryByText(/update available/)).toBeNull();
  });

  // H6b Windows walk: an Update shipped as a pull request still open is on
  // its way — the row names it and its pull request, and offers no second
  // Update (a second press made a duplicate card).
  it("an Update card shipped as an open pull request is on its way, with no Update", async () => {
    const card = {
      id: "card-92",
      workspaceId: WS,
      title: "Skill: update review-rules from the team library",
      columnId: "complete",
      createdAt: 0,
      updatedAt: 0,
      ghIssueNumber: 94,
      reviewStatus: "merged",
      prUrl: "https://github.com/acme/web/pull/95",
      pr: { number: 95, state: "open", checks: "none", checksTotal: 0, checksPassed: 0, checksPending: 0, failingChecks: [], mergeable: "unknown" },
      kind: {
        type: "skill",
        verb: "update",
        skill: "review-rules",
        origin: { kind: "team", source: "acme/team", name: "review-rules", version: { commit: "b", contentId: "b" } },
      },
    } as unknown as KanbanCard;
    useKanban.setState({ byWorkspace: { [WS]: { cards: [card], loaded: true } } });
    const { tauri } = render([link("updateAvailable")]);
    tauri.allowUnhandled();
    await screen.findByText(/being updated by card #94 — merge its pull request #95 to finish/);
    const row = rowOf("review-rules");
    expect(within(row).queryByRole("button", { name: /^Update/ })).toBeNull();
    expect(within(row).queryByText("Update available")).toBeNull();
  });

  it("modified here offers Compare, 2-way, and never Update", async () => {
    // H4: a copy modified here whose library moved on too is `bothChanged`
    // (skillDecisions.test.tsx); this one changed here only.
    const { user, tauri } = render([link("modifiedHere")], {
      skills_hub_compare: () => ({
        left: { label: "When it was linked", meaning: "the team library, a3f9c21", place: "the linked version", text: "line one\n" },
        right: { label: "This repository", meaning: "your copy", place: "here", text: "line one\nmine\n" },
        otherFiles: ["scripts/check.sh"],
        note: null,
      }),
    });
    tauri.allowUnhandled();
    await screen.findByText(/Linked to the team library · modified here/);
    const row = rowOf("review-rules");
    expect(within(row).queryByRole("button", { name: /^Update/ })).toBeNull();
    await user.click(within(row).getByRole("button", { name: "Compare" }));
    await waitFor(() => expect(tauri.callsOf("skills_hub_compare")).toHaveLength(1));
    expect(await screen.findByText(/Other files that differ: scripts\/check\.sh/)).toBeTruthy();
    expect(screen.getByText(/When it was linked/)).toBeTruthy();
    expect(tauri.callsOf("skills_hub_update")).toHaveLength(0);
    // H4 (R3): the two ways on are offered under it, and neither runs by
    // itself. Propose waits for write access to the team library here.
    expect(screen.getByRole("button", { name: "Take theirs" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Propose mine to them" }) as HTMLButtonElement).disabled).toBe(true);
  });

  // H4 Mac walk: the 2-way Compare had no file list, so "only you" never
  // showed and a skill of many files couldn't be read; its headings carry
  // no commit code.
  it("the 2-way Compare lists each file with whose change it is", async () => {
    const { user, tauri } = render([link("modifiedHere")], {
      skills_hub_compare: () => ({
        left: { label: "The team library when linked", meaning: "where this copy started", place: "the version it started from", text: "line one\n" },
        right: { label: "This repository", meaning: "your copy", place: "here", text: "line one\nmine\n" },
        otherFiles: ["scripts/check.sh"],
        files: [
          { path: "SKILL.md", status: "here", left: "line one\n", right: "line one\nmine\n", notShown: false },
          { path: "scripts/check.sh", status: "here", left: "echo a\n", right: "echo mine\n", notShown: false },
        ],
        note: null,
      }),
    });
    tauri.allowUnhandled();
    await screen.findByText(/Linked to the team library · modified here/);
    await user.click(within(rowOf("review-rules")).getByRole("button", { name: "Compare" }));
    const list = await screen.findByRole("list", { name: "Files of review-rules that differ" });
    expect(within(list).getAllByText("only you")).toHaveLength(2);
    expect(screen.getByText("The two versions of SKILL.md")).toBeTruthy();
    await user.click(within(list).getByText("scripts/check.sh"));
    expect(await screen.findByText("The two versions of scripts/check.sh")).toBeTruthy();
    expect(screen.getByText("echo mine")).toBeTruthy();
    expect(document.querySelector(".ux-compare--pair")).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(/\b[0-9a-f]{7,40}\b/);
    // H4 Windows walk: a real Close, as the 3-way has; no "Hide".
    expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Files of review-rules that differ" })).toBeNull());
    expect(within(rowOf("review-rules")).getByRole("button", { name: "Compare" })).toBeTruthy();
  });

  // H4 Mac walk: after a change to the linked copy the row kept "up to
  // date" until a second return to the Library. A change under a skill
  // root re-reads the rows.
  it("a change to a skill's files re-reads the linked rows", async () => {
    let links = [link("upToDate")];
    const { tauri } = render([], { skills_hub_links: () => ({ links, unreadable: [] }) });
    tauri.allowUnhandled();
    await screen.findByText(/Linked to the team library · up to date/);
    const before = tauri.callsOf("skills_hub_links").length;
    links = [link("modifiedHere")];
    act(() => {
      tauri.emit("fs://changed", { workspaceId: WS, path: `${CWD}/README.md`, kind: "modified" });
      tauri.emit("fs://changed", { workspaceId: WS, path: `${CWD}/.claude/skills/review-rules/SKILL.md`, kind: "modified" });
    });
    expect(await screen.findByText(/Linked to the team library · modified here/, {}, { timeout: 3000 })).toBeTruthy();
    expect(tauri.callsOf("skills_hub_links").length).toBe(before + 1);
  });

  // H4 Windows re-walk: after Settings › Team › Read it again the open
  // Library kept the old state until a scope switch.
  it("a finished team read re-reads the linked rows", async () => {
    let links = [link("upToDate")];
    const { tauri } = render([], { skills_hub_links: () => ({ links, unreadable: [] }) });
    tauri.allowUnhandled();
    await screen.findByText(/Linked to the team library · up to date/);
    links = [{ ...link("renamed"), renamedTo: "team-rename" }];
    act(() => useSkillsHub.getState().noteTeamRead());
    await waitFor(() => expect(screen.queryByText(/Linked to the team library · up to date/)).toBeNull());
  });

  // H4 Windows re-walk 2: Update on team-tone looked like it did nothing —
  // the press waits on the team library's pull, then a script that waits for
  // this machine's OK refuses it. It says it is working, then says why.
  it("Update says it is working, and says why when a script waits for an OK", async () => {
    let refuse: (why: Error) => void = () => {};
    const { user, tauri } = render([link("updateAvailable", true)], {
      skills_hub_update: () => new Promise((_, reject) => (refuse = reject)),
    });
    tauri.allowUnhandled();
    await screen.findByText(/Linked to the team library · update available/);
    await user.click(within(rowOf("review-rules")).getByRole("button", { name: /^Update/ }));
    expect(await within(rowOf("review-rules")).findByRole("button", { name: "Making the card…" })).toBeTruthy();
    act(() =>
      refuse(
        new Error(
          "review-rules brings a script you haven't said OK to on this Mac, so Plyloft won't put it in a card yet. Open it in the Library's team section and press Review; once you say OK, try again.",
        ),
      ),
    );
    await waitFor(() => expect(useToasts.getState().toasts.some((t) => t.title === "Couldn't update the skill")).toBe(true));
    const toast = useToasts.getState().toasts.find((t) => t.title === "Couldn't update the skill")!;
    expect(toast.action?.label).toBe("Review");
    expect(within(rowOf("review-rules")).getByRole("button", { name: /^Update/ })).toBeTruthy();
  });

  // H4 Windows walk: a card's own copy of the repository is not the checkout.
  it("only the checkout's skill folders count as a skill file change", () => {
    expect(isSkillFilePath(`${CWD}/.claude/skills/review-rules/SKILL.md`)).toBe(true);
    expect(isSkillFilePath("C:\\Users\\a\\project\\.agents\\skills\\x\\SKILL.md")).toBe(true);
    expect(isSkillFilePath(`${CWD}/.plyloft-worktrees/card-1/.claude/skills/review-rules/SKILL.md`)).toBe(false);
    expect(isSkillFilePath("C:\\p\\.atelier-worktrees\\c\\.claude\\skills\\x\\SKILL.md")).toBe(false);
    expect(isSkillFilePath(`${CWD}/src/main.ts`)).toBe(false);
  });

  // H4 Mac walk (P-D2): a folder with no readable SKILL.md is said plainly;
  // the path and the OS error wait under Details.
  it("an unloadable skill folder is said in plain words, the raw error under Details", async () => {
    const reason = `${CWD}/.claude/skills/team-style/SKILL.md could not be read: No such file or directory (os error 2)`;
    const { tauri } = render([], {
      project_skills_view: () => ({ ...view, unloadable: [{ name: "team-style", root: ".claude/skills", reason }] }),
    });
    tauri.allowUnhandled();
    expect(
      await screen.findByText("team-style in .claude/skills has no SKILL.md Plyloft can read, so neither Claude nor Codex loads it."),
    ).toBeTruthy();
    const details = screen.getByText(reason).closest("details");
    expect(details).toBeTruthy();
    expect(details!.open).toBe(false);
  });
});
