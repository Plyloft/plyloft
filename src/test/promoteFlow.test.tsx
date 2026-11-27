// Share with Team… on a personal skill: the page names the repository and every
// file that goes, and the press to the team waits for that list.
import { describe, expect, it, vi } from "vitest";
import { PromoteFlow, PAGE_READ_MS } from "../components/library/PromoteFlow";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import type { ProjectSkillsView } from "../ipc";
import { shareRefusalWords, shareStatusWords, type SharePreview } from "../lib/shareSkillPreview";
import { EMPTY_INDEX, flattenIndex, nameIndex } from "../lib/allSkills";
import { useAllSkills } from "../store/allSkillsStore";
import { plainFailure } from "../lib/plainError";
import { useLibrary } from "../store/libraryStore";
import { act, renderUi, screen } from "./render";

const CLOSING = "Check there are no passwords or keys in them. Removing it later doesn't remove it from the repository's history.";

function preview(over: Partial<SharePreview> = {}): SharePreview {
  return { teamRepo: "owner/team-repo", files: ["SKILL.md", "run.sh", "notes.txt"], totalBytes: 12 * 1024, ...over };
}

function flow(answer: () => unknown, onPromote = vi.fn(), teamReason: string | null = null, visible = true) {
  return {
    onPromote,
    ...renderUi(
      <PromoteFlow
        name="deploy"
        repository="owner/app"
        teamReason={teamReason}
        visible={visible}
        busy={false}
        onCancel={() => {}}
        onPromote={onPromote}
      />,
      { fixtures: { personal_skill_share_preview: answer } },
    ),
  };
}

describe("the status line's words", () => {
  it("says the approved sentence with the real list and size", () => {
    expect(shareStatusWords(preview())).toBe(
      `Plyloft sends every file in this folder: SKILL.md, run.sh, notes.txt (3 files, 12 KB). ${CLOSING}`,
    );
  });

  it("shortens a long list, and counts one file and small sizes", () => {
    const files = ["SKILL.md", "a", "b", "c", "d", "e", "f"];
    expect(shareStatusWords(preview({ files, totalBytes: 3 * 1024 * 1024 }))).toBe(
      `Plyloft sends every file in this folder: SKILL.md, a, b, c, d and 2 more (7 files, 3.0 MB). ${CLOSING}`,
    );
    expect(shareStatusWords(preview({ files: ["SKILL.md"], totalBytes: 512 }))).toBe(
      `Plyloft sends every file in this folder: SKILL.md (1 file, 512 B). ${CLOSING}`,
    );
  });

  it("still warns when the folder couldn't be listed", () => {
    for (const unread of [null, preview({ files: null }), preview({ files: [] })]) {
      expect(shareStatusWords(unread)).toBe(`Plyloft sends every file in this folder. ${CLOSING}`);
    }
  });
});

describe("the flow", () => {
  it("names the repository on the option and the button, with Team preselected", async () => {
    const { user, onPromote } = flow(() => preview());
    const press = await screen.findByRole("button", { name: "Share with owner/team-repo" });
    expect(screen.getByRole("radio", { name: /^Team/, checked: true })).toBeTruthy();
    expect(
      screen.getByText(
        "Goes to owner/team-repo on GitHub. Everyone on your team can read it, and every Mac gets it at its next refresh.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/SKILL\.md, run\.sh, notes\.txt \(3 files, 12 KB\)/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await user.click(press);
    expect(onPromote).toHaveBeenCalledWith("team");
  });

  it("holds the press to the team until the list is read, not the one to the repository", async () => {
    let answer: (value: SharePreview) => void = () => {};
    const { user, onPromote } = flow(() => new Promise<SharePreview>((resolve) => (answer = resolve)));
    expect((screen.getByRole("button", { name: "Share" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("radio", { name: /This repository/ }));
    expect(screen.getByText("Reaches everyone who opens owner/app, after you ship the change.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Share" }));
    expect(onPromote).toHaveBeenCalledWith("repository");
    answer(preview());
    expect(await screen.findByRole("button", { name: "Share" })).toBeTruthy();
  });

  it("doesn't hold the press when the read fails: the backend still checks", async () => {
    const { user, onPromote } = flow(() => {
      throw new Error("no");
    });
    await vi.waitFor(() =>
      expect((screen.getByRole("button", { name: "Share" }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getByText(`Plyloft sends every file in this folder. ${CLOSING}`)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Share" }));
    expect(onPromote).toHaveBeenCalledWith("team");
  });

  it("reads the folder even while the team can't be chosen: the repository refuses too", async () => {
    const { tauri } = flow(() => preview(), vi.fn(), "No team on this Mac.");
    expect(screen.getByRole("radio", { name: /This repository/, checked: true })).toBeTruthy();
    expect(screen.getByText("No team on this Mac.")).toBeTruthy();
    await vi.waitFor(() => expect(tauri.callsOf("personal_skill_share_preview")).toHaveLength(1));
  });
});

// 1.175.0 B1 (scene 1.7): a personal skill whose text asks — the page's
// second status line, on a share to the team only.
describe("a skill whose text asks to run things", () => {
  const LINE =
    "Its text lets agents run commands without asking. Every other computer asks its person for an OK before its sessions get it; on this Mac, sharing it is your OK.";

  it("says what its text asks for under the list of files, and keeps its one button", async () => {
    const { user } = flow(() => preview({ files: ["SKILL.md"], totalBytes: 2150, asks: "commands" }));
    expect(await screen.findByText(LINE)).toBeTruthy();
    expect(screen.getByText(/Plyloft sends every file in this folder: SKILL\.md \(1 file, 2\.1 KB\)/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Share with owner/team-repo" }) as HTMLButtonElement).disabled).toBe(false);
    // To the repository it goes through a card: nothing to say here.
    await user.click(screen.getByRole("radio", { name: /This repository/ }));
    expect(screen.queryByText(LINE)).toBeNull();
  });

  it("says nothing more for plain text, and each kind in its own words", async () => {
    const plain = flow(() => preview());
    await screen.findByText(/Plyloft sends every file/);
    expect(screen.queryByText(/Every other computer asks its person/)).toBeNull();
    plain.unmount();
    for (const [asks, words] of [
      ["files", "Its text lets agents change files without asking."],
      ["inline", "Its text runs a command when the skill loads."],
    ] as const) {
      const r = flow(() => preview({ asks }));
      expect(await screen.findByText(new RegExp(`^${words.replace(/\./g, "\\.")} Every other computer asks`))).toBeTruthy();
      r.unmount();
    }
  });
});

describe("a folder a press would refuse", () => {
  const PRIVATE =
    "deploy holds config/.env, which looks private, so Plyloft won't share it. Move it out of the skill's folder.";
  const GIT =
    "deploy is a git repository of its own, so its files wouldn't reach your team. Copy the skill without its .git folder.";
  const refused = (refusal: string) => preview({ files: null, totalBytes: 0, refusal });
  const off = (name: string) => (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;

  // 1.175.0 D4 (TM-7): a name a teammate's Windows computer can't hold.
  const WINDOWS =
    "meeting-notes holds \u201cnotes: v2.md\u201d, a name Windows can't have, so Plyloft won't share it. Rename the file in the skill's folder.";

  it("says the backend's words in place of the status line, with the press off for both places", async () => {
    for (const words of [PRIVATE, GIT, WINDOWS]) {
      const { user, onPromote, unmount } = flow(() => refused(words));
      expect(await screen.findByText(words)).toBeTruthy();
      expect(screen.queryByText(/Plyloft sends every file/)).toBeNull();
      expect(off("Share with owner/team-repo")).toBe(true);
      await user.click(screen.getByRole("radio", { name: /This repository/ }));
      expect(screen.getByText(words)).toBeTruthy();
      expect(screen.queryByText(/Reaches everyone who opens/)).toBeNull();
      expect(off("Share")).toBe(true);
      await user.click(screen.getByRole("button", { name: "Share" }));
      expect(onPromote).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("refuses on the repository alone, when the team can't be chosen", async () => {
    flow(() => refused(PRIVATE), vi.fn(), "No team on this Mac.");
    expect(await screen.findByText(PRIVATE)).toBeTruthy();
    expect(off("Share")).toBe(true);
  });

  it("gives the press back once the folder no longer holds the file", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let answer = refused(PRIVATE);
      flow(() => answer);
      await screen.findByText(PRIVATE);
      answer = preview();
      await vi.advanceTimersByTimeAsync(PAGE_READ_MS);
      expect(await screen.findByText(/SKILL\.md, run\.sh, notes\.txt \(3 files, 12 KB\)/)).toBeTruthy();
      expect(off("Share with owner/team-repo")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for each answer before the next read, and a late answer can't undo a newer one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const tick = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
    try {
      const answers: ((value: SharePreview) => void)[] = [];
      const { tauri } = flow(() => new Promise<SharePreview>((resolve) => answers.push(resolve)));
      const reads = () => tauri.callsOf("personal_skill_share_preview").length;
      await tick();
      answers[0](refused(PRIVATE));
      await tick();
      await tick(PAGE_READ_MS);
      expect(reads()).toBe(2);
      // Unanswered: no third read, however long it takes.
      await tick(PAGE_READ_MS * 5);
      expect(reads()).toBe(2);
      // A focus read overtakes it, and answers first.
      act(() => void window.dispatchEvent(new Event("focus")));
      await tick();
      expect(reads()).toBe(3);
      answers[2](preview());
      await tick();
      expect(off("Share with owner/team-repo")).toBe(false);
      // The overtaken one says it's refused: too late to count.
      answers[1](refused(PRIVATE));
      await tick();
      expect(off("Share with owner/team-repo")).toBe(false);
      expect(screen.queryByText(PRIVATE)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads nothing while the Library is out of sight, nor on focus", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { tauri } = flow(() => refused(PRIVATE), vi.fn(), null, false);
      await screen.findByText(PRIVATE);
      await vi.advanceTimersByTimeAsync(PAGE_READ_MS * 3);
      act(() => void window.dispatchEvent(new Event("focus")));
      expect(tauri.callsOf("personal_skill_share_preview")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads nothing while the window is hidden, and again once it's back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state = vi.spyOn(document, "visibilityState", "get");
    try {
      const { tauri } = flow(() => refused(PRIVATE));
      await screen.findByText(PRIVATE);
      state.mockReturnValue("hidden");
      await vi.advanceTimersByTimeAsync(PAGE_READ_MS * 3);
      expect(tauri.callsOf("personal_skill_share_preview")).toHaveLength(1);
      state.mockReturnValue("visible");
      await vi.advanceTimersByTimeAsync(PAGE_READ_MS * 2);
      expect(tauri.callsOf("personal_skill_share_preview").length).toBeGreaterThan(1);
    } finally {
      state.mockRestore();
      vi.useRealTimers();
    }
  });

  it("finds out on focus that a folder went while nothing was refused", async () => {
    let answer = preview();
    const { user, onPromote } = flow(() => answer);
    const press = await screen.findByRole("button", { name: "Share with owner/team-repo" });
    const GONE = "deploy isn't in your own skills folders on this Mac.";
    answer = refused(GONE);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(await screen.findByText(GONE)).toBeTruthy();
    expect((press as HTMLButtonElement).disabled).toBe(true);
    await user.click(press);
    expect(onPromote).not.toHaveBeenCalled();
  });

  it("keeps reading while it's on screen: a file that arrives turns the press off", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let answer = preview();
      flow(() => answer);
      await screen.findByText(/SKILL\.md, run\.sh, notes\.txt \(3 files, 12 KB\)/);
      expect(off("Share with owner/team-repo")).toBe(false);
      answer = refused(PRIVATE);
      await vi.advanceTimersByTimeAsync(PAGE_READ_MS);
      expect(await screen.findByText(PRIVATE)).toBeTruthy();
      expect(off("Share with owner/team-repo")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts a folder it couldn't read in plain words, on Mac and on Windows", () => {
    expect(shareRefusalWords(preview({ refusal: "Plyloft could not read deploy: /Users/a/.claude/skills/deploy: Permission denied (os error 13)" }))).toBe(
      "The computer didn't let Plyloft read or change a file there.",
    );
    expect(shareRefusalWords(preview({ refusal: "Plyloft could not read deploy: C:\\Users\\a\\deploy: Access is denied. (os error 5)" }))).toBe(
      "The computer didn't let Plyloft read or change a file there.",
    );
    expect(shareRefusalWords(preview({ refusal: "Plyloft could not read deploy: /gone: No such file or directory (os error 2)" }))).toBe(
      "A file or folder it needed isn't there any more.",
    );
  });

  it("shows a project skill's refusal whole, in a toast's plain words", () => {
    for (const words of [
      "deploy holds config/.env, which looks private, so nothing was shared. It's committed on main, so take it out with a commit, then try again; it stays in that branch's history.",
      "deploy holds config/.env, which looks private, so nothing was shared. It's committed on main, so take it out with a commit and get that commit to main on GitHub, then try again; it stays in that branch's history.",
      "deploy holds config/.env, which looks private, so nothing was shared. Move it out of the skill's folder, then try again. If it's committed, take it out with a commit; it stays in the history of any branch that has it.",
      "meeting-notes holds \u201cnotes: v2.md\u201d, a name Windows can't have, so nothing was shared. Rename the file, then try again.",
      "meeting-notes holds \u201cnotes: v2.md\u201d, a name Windows can't have, so nothing was shared. It's committed on staging, so rename it with a commit, then try again.",
      "meeting-notes holds \u201caux.md\u201d, a name Windows keeps for itself, so nothing was shared. Rename the file, then try again.",
      "meeting-notes holds \u201cREADME.md\u201d and \u201creadme.md\u201d, which Windows can't tell apart, so nothing was shared. Rename one of them, then try again.",
      "meeting-notes holds \u201cnotes: v2.md\u201d and 2 more files with names Windows can't have, so nothing was shared. Rename them, then try again.",
    ]) {
      expect(plainFailure(words)).toEqual({ sentence: words, details: "" });
    }
  });

  it("keeps a refusal's own words whatever the file is called", () => {
    const words = "deploy holds ENCRYPTION.KEY, which looks private, so nothing was shared. Move it out of the skill's folder, then try again.";
    expect(shareRefusalWords(preview({ refusal: words }))).toBe(words);
    expect(shareRefusalWords(preview())).toBeNull();
    expect(shareRefusalWords(null)).toBeNull();
    expect(shareRefusalWords(undefined)).toBeNull();
  });
});

describe("on the real Skills page", () => {
  const WS = "ws-share";
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
    configured: true,
    hasClone: true,
    canPromote: true,
    promoteReason: null,
    promotePlugin: "ply-team",
    errors: [],
  };

  function Host() {
    const data = useSkillsData(WS, true);
    return <SkillsPage workspaceId={WS} cwd={CWD} data={data} />;
  }

  async function open(promote: () => unknown) {
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
        personal_skill_share_preview: () => preview(),
        personal_skill_promote: promote,
      },
    });
    r.tauri.allowUnhandled();
    await r.user.click(await screen.findByRole("button", { name: "Share with Team…" }));
    return r;
  }

  async function share(promote: () => unknown) {
    const r = await open(promote);
    await r.user.click(await screen.findByRole("button", { name: "Share with owner/team-repo" }));
    return r;
  }

  it("ends on the approved message", async () => {
    await share(() => ({
      skill: "deploy",
      plugin: "ply-team",
      copied: { written: [], unchanged: [], ignored: [], unknown: [] },
      committed: true,
      pushed: true,
    }));
    expect(
      await screen.findByText(
        "Your team can read it now. Your copy on this Mac is untouched. To take it back, use Remove from Team…; it stays in the repository's history.",
      ),
    ).toBeTruthy();
  });

  it("reads All skills' libraries after a share to the team", async () => {
    const landed = await share(() => ({
      skill: "deploy",
      plugin: "ply-team",
      copied: { written: [], unchanged: [], ignored: [], unknown: [] },
      committed: true,
      pushed: true,
    }));
    await screen.findByText(/shared with the team/);
    expect(landed.tauri.callsOf("skills_hub_index_refresh").slice(-1)[0]?.args).toMatchObject({ workspaceIds: [], libraries: true });
  });

  it("reads no libraries for a pull request: the library hasn't changed", async () => {
    const opened = await share(() => ({
      skill: "deploy",
      plugin: "ply-team",
      copied: { written: [], unchanged: [], ignored: [], unknown: [] },
      committed: false,
      pushed: false,
      pullRequest: { url: "https://x/1", number: 1, why: "A teammate changed it." },
    }));
    await screen.findAllByText(/A teammate changed it/);
    expect(opened.tauri.callsOf("skills_hub_index_refresh")).toHaveLength(0);
  });

  it("shows the backend's refusal, word for word", async () => {
    const said =
      "deploy holds .env, which looks private, so nothing was shared. Move it out of the skill's folder, then try again.";
    await share(() => {
      throw said;
    });
    expect(await screen.findByText(said)).toBeTruthy();
    expect(screen.getByText(/^Couldn't share the skill\.?$/)).toBeTruthy();
    expect(screen.queryByText(/^Couldn't promote/)).toBeNull();
  });

  it("says Share in the title for the repository too, as its button does", async () => {
    const r = await open(() => {
      throw "The disk said no.";
    });
    await r.user.click(await screen.findByRole("radio", { name: /This repository/ }));
    await r.user.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByText(/^Couldn't share the skill\.?$/)).toBeTruthy();
  });

  describe("a skill the team already has", () => {
    const TEAM_DIR = "/config/team/o__t/library/claude/ply-team/skills/deploy";
    const CODEX_DIR = "/config/team/o__t/library/codex/plugins/ply-team/skills/deploy";
    const teamRow = {
      name: "deploy",
      description: "Ships it.",
      plugin: "ply-team",
      claude: true,
      codex: true,
      repo: "absent",
      dir: TEAM_DIR,
      halves: [TEAM_DIR, CODEX_DIR],
    };

    async function teamPage(digests: { mine: string; team: string; codex?: string }, promote: () => unknown = () => null) {
      const r = renderUi(<Host />, {
        withToasts: true,
        fixtures: {
          project_skills_view: () => ({ ...view, team: [teamRow] }),
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
          skill_tree_digests: ({ groups }: Record<string, unknown>) =>
            // As `tree_digest`: a group whose trees disagree has no digest.
            (groups as string[][]).map((dirs) => {
              const each = dirs.map((dir) => (dir === TEAM_DIR ? digests.team : dir === CODEX_DIR ? (digests.codex ?? digests.team) : digests.mine));
              return each.every((one) => one === each[0]) ? each[0] : null;
            }),
          fs_list_dir: ({ path }: Record<string, unknown>) => [
            { name: "SKILL.md", path: `${String(path)}/SKILL.md`, isDir: false },
          ],
          fs_read_text_file: () => "# Deploy\nShips it.\n",
          skills_hub_links: () => ({ links: [], unreadable: [] }),
          ply_skills_view: () => ({ skills: [], problem: null }),
          personal_skill_share_preview: () => preview(),
          personal_skill_promote: promote,
        },
      });
      r.tauri.allowUnhandled();
      return r;
    }

    it("names a different copy for what the press does, and still asks before replacing it", async () => {
      const r = await teamPage({ mine: "a", team: "b" }, () => {
        throw { notTheSameSkill: TEAM_DIR, message: "different" };
      });
      await r.user.click(await screen.findByRole("button", { name: "Replace in Team…" }));
      await r.user.click(await screen.findByRole("button", { name: "Share with owner/team-repo" }));
      expect(await screen.findByRole("button", { name: "Replace" })).toBeTruthy();
      expect(
        screen.getByText(/The team library already has a skill called deploy, and it is not the same file/),
      ).toBeTruthy();
    });

    it("turns the Team choice off for the same files, saying why", async () => {
      const r = await teamPage({ mine: "a", team: "a" });
      await r.user.click(await screen.findByRole("button", { name: "Share…" }));
      expect(await screen.findByText("Already in the team library, with the same files.")).toBeTruthy();
      expect((screen.getByRole("radio", { name: /^Team/ }) as HTMLInputElement).disabled).toBe(true);
      expect(screen.getByRole("radio", { name: /This repository/, checked: true })).toBeTruthy();
    });

    it("keeps Team on when the team's Codex half differs: the press is the way to fix it", async () => {
      const r = await teamPage({ mine: "a", team: "a", codex: "b" }, () => {
        throw { notTheSameSkill: CODEX_DIR, message: "different" };
      });
      await vi.waitFor(() => expect(r.tauri.callsOf("skill_tree_digests").length).toBeGreaterThan(0));
      const asked = r.tauri.callsOf("skill_tree_digests").slice(-1)[0].args.groups as string[][];
      expect(asked).toContainEqual([TEAM_DIR, CODEX_DIR]);
      await r.user.click(await screen.findByRole("button", { name: "Share…" }));
      expect(screen.queryByText("Already in the team library, with the same files.")).toBeNull();
      expect((screen.getByRole("radio", { name: /^Team/, checked: true }) as HTMLInputElement).disabled).toBe(false);
      await r.user.click(await screen.findByRole("button", { name: "Share with owner/team-repo" }));
      expect(await screen.findByRole("button", { name: "Replace" })).toBeTruthy();
    });

    it("doesn't go quiet over a pair whose team halves differ", async () => {
      await teamPage({ mine: "a", team: "a", codex: "b" });
      await screen.findByRole("button", { name: "Share…" });
      act(() => useLibrary.getState().openSkill(WS, "this-mac:deploy"));
      try {
        await screen.findByRole("button", { name: "Reveal in Finder" });
        await vi.waitFor(() => expect(document.querySelector(".ux-notice")).not.toBeNull());
      } finally {
        act(() => useLibrary.getState().openSkill(WS, null));
      }
    });
  });

  describe("after a promote to the repository", () => {
    const repositoryRow = {
      name: "deploy",
      description: "Ships it.",
      claude: true,
      codex: true,
      roots: [".claude/skills", ".agents/skills"],
      dir: ".claude/skills/deploy",
      team: "absent",
    };

    function usedInProject() {
      const id = "same-tree";
      const row = (name: string) => ({
        name,
        description: "Ships it.",
        claude: true,
        codex: false,
        claudeId: id,
        codexId: null,
        twinsDiffer: false,
        legacyCodex: false,
        dir: "/somewhere",
        changedAt: null,
        tooManyFiles: false,
        needsOk: false,
        offHere: false,
      });
      useAllSkills.setState({
        rows: flattenIndex({
          ...EMPTY_INDEX,
          workspaces: [
            { id: WS, name: "project", path: CWD, repo: "owner/app", state: "ok", source: "checkout", rows: [row("deploy")] } as never,
          ],
          thisMac: { rows: [row("deploy")] } as never,
        }),
      });
      useAllSkills.setState((s) => ({ names: nameIndex(s.rows) }));
    }

    it("says on the skill's page what All skills says, and reads All skills again at once", async () => {
      let promoted = false;
      const r = renderUi(<Host />, {
        withToasts: true,
        fixtures: {
          project_skills_view: () => (promoted ? { ...view, skills: [repositoryRow] } : view),
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
          fs_read_text_file: () => "# Deploy\nShips it.\n",
          skills_hub_links: () => ({ links: [], unreadable: [] }),
          ply_skills_view: () => ({ skills: [], problem: null }),
          personal_skill_share_preview: () => preview(),
          personal_skill_promote: () => {
            promoted = true;
            return { skill: "deploy", plugin: null, copied: { written: [], unchanged: [], ignored: [], unknown: [] }, committed: false, pushed: false };
          },
        },
      });
      r.tauri.allowUnhandled();
      try {
        await r.user.click(await screen.findByRole("button", { name: "Share with Team…" }));
        await r.user.click(await screen.findByRole("radio", { name: /This repository/ }));
        await r.user.click(screen.getByRole("button", { name: "Share" }));
        await screen.findByText(/^deploy is in this repository/);
        await vi.waitFor(() =>
          expect(r.tauri.callsOf("skills_hub_index_refresh").slice(-1)[0]?.args).toMatchObject({ workspaceIds: [WS] }),
        );

        act(() => useLibrary.getState().openSkill(WS, "this-mac:deploy"));
        // Before the index has it, the chip; never "not shared with anyone".
        await screen.findByRole("button", { name: "Reveal in Finder" });
        expect(screen.queryByText("not shared with anyone")).toBeNull();
        expect(screen.getAllByText("Also in this repository")).toHaveLength(1);

        act(() => usedInProject());
        expect(await screen.findByText("Used in 1: project (same content, not linked)")).toBeTruthy();
        expect(screen.queryByText("not shared with anyone")).toBeNull();
        expect(screen.queryByText(/Share it to put it in the team library or in this repository/)).toBeNull();
        expect(screen.getByText(/Share it to put it in the team library, where others get it too/)).toBeTruthy();
      } finally {
        act(() => useLibrary.getState().openSkill(WS, null));
        useAllSkills.setState({ rows: [], names: new Map() });
      }
    });
  });

  describe("after Remove from Team", () => {
    const teamRow = { name: "lint", description: "Lints.", plugin: "ply-team", claude: true, codex: true, repo: "absent", dir: "/c/lint" };

    function page(remove: () => unknown) {
      const r = renderUi(<Host />, {
        withToasts: true,
        fixtures: {
          project_skills_view: () => ({ ...view, team: [teamRow] }),
          knowledge_project_state: () => {
            throw new Error("not shared");
          },
          personal_skills_view: () => ({ skills: [], rootsPresent: [], errors: [] }),
          skills_hub_links: () => ({ links: [], unreadable: [] }),
          ply_skills_view: () => ({ skills: [], problem: null }),
          inbox_feed: () => ({ generatedAt: 0, windowDays: 28, events: [] }),
          team_skill_remove: remove,
        },
      });
      r.tauri.allowUnhandled();
      return r;
    }

    async function removeIt(r: ReturnType<typeof page>) {
      act(() => useLibrary.getState().openSkill(WS, "team:lint"));
      await r.user.click(await screen.findByRole("button", { name: /more|⋯|actions/i }));
      await r.user.click(await screen.findByRole("menuitem", { name: /Remove from Team/ }));
      await r.user.click(await screen.findByRole("button", { name: /^Remove/ }));
    }

    it("reads the Inbox and All skills' libraries at once, and no workspace", async () => {
      const r = page(() => ({ skill: "lint", plugin: "ply-team", removed: [], committed: true, pushed: true }));
      try {
        await removeIt(r);
        await screen.findByText(/removed from the team library/);
        expect(r.tauri.callsOf("skills_hub_index_refresh").slice(-1)[0]?.args).toMatchObject({ workspaceIds: [], libraries: true });
        await vi.waitFor(() => expect(r.tauri.callsOf("inbox_feed").length).toBeGreaterThan(0));
      } finally {
        act(() => useLibrary.getState().openSkill(WS, null));
      }
    });

    it("reads nothing again when the removal failed", async () => {
      const r = page(() => {
        throw "GitHub refused.";
      });
      try {
        await removeIt(r);
        await screen.findByText("GitHub refused.");
        expect(r.tauri.callsOf("skills_hub_index_refresh")).toHaveLength(0);
        expect(r.tauri.callsOf("inbox_feed")).toHaveLength(0);
      } finally {
        act(() => useLibrary.getState().openSkill(WS, null));
      }
    });
  });
});
