// Skills hub H4 (R3, R7, R8) on the real Skills page and its data hook,
// through the stubbed Tauri layer:
//
// - a copy changed here and in the team library says *Both changed* and
//   opens the 3-way Compare, whose three choices call Keep mine, Take
//   upstream (Update with `takeUpstream`) and Propose mine upstream;
// - a proposal standing says *Proposed to where it came from · pull request #31*;
// - a skill removed upstream offers Keep or Remove, one renamed offers
//   Rename here or Keep the old name — each a card;
// - Promote that became a pull request says why and links it.
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import type { Compare3, ProjectSkillsView, SkillLinkRow } from "../ipc";
import { useToasts } from "../store/toastStore";
import { useSetup } from "../store/setupStore";
import { useSettings } from "../store/settingsStore";
import { act, renderUi, screen, waitFor } from "./render";
import { decisionSkillOf } from "../lib/inboxView";
import { markedLines } from "../lib/threeWay";

const WS = "ws-skill-decisions";
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
      team: "differs",
      promoteBlocked: null,
    },
  ],
  team: [],
  unloadable: [],
  rootsPresent: [".claude/skills", ".agents/skills"],
  ignoredRoots: [],
  configured: true,
  hasClone: true,
  canPromote: true,
  promoteReason: null,
  promotePlugin: "acme",
  errors: [],
};

function link(state: SkillLinkRow["state"], extra: Partial<SkillLinkRow> = {}): SkillLinkRow {
  return {
    skill: "review-rules",
    originKind: "team",
    originWords: "the team library",
    source: "acme/team",
    plugin: "acme",
    versionCommit: "a3f9c21",
    state,
    upstreamMoved: state === "bothChanged" || state === "updateAvailable",
    ...extra,
  };
}

const compare3: Compare3 = {
  skill: "review-rules",
  originWords: "the team library",
  baseLabel: "The team library when linked",
  upstreamLabel: "The team library now",
  hereLabel: "This repository",
  files: [
    { path: "SKILL.md", status: "both", base: "a\nb\n", upstream: "a\nb\nteam\n", here: "a\nmine\nb\n", notShown: false },
    { path: "checklist.md", status: "here", base: "c\n", upstream: "c\n", here: "c mine\n", notShown: false },
  ],
  note: null,
  state: "bothChanged",
  proposeBlocked: null,
};

const card = (title: string) => ({ id: "card-9", workspaceId: WS, title, columnId: "complete", createdAt: 0, updatedAt: 0 });

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

describe("Skills hub H4: changed here and in the team library", () => {
  it.each([
    ["Keep mine", "skills_hub_keep_mine"],
    ["Take theirs", "skills_hub_update"],
    ["Propose mine to them", "skills_hub_propose_upstream"],
  ] as const)("says Both changed, and the 3-way Compare's %s calls %s", async (choice, command) => {
    {
      const { user, tauri } = render([link("bothChanged")], {
        skills_hub_compare3: () => compare3,
        skills_hub_keep_mine: () => card("Skill: keep this repository's review-rules (linked to the team library)"),
        skills_hub_update: () => card("Skill: take the team library's review-rules"),
        skills_hub_propose_upstream: () => ({ skill: "review-rules", url: "https://github.com/acme/team/pull/31", number: 31, addedToOpen: false }),
      });
      tauri.allowUnhandled();
      await screen.findByText(/changed here and in the team library\. Compare to choose/);
      const row = rowOf("review-rules");
      expect(within(row).getByText("Both changed")).toBeTruthy();
      expect(within(row).queryByRole("button", { name: /^Update/ })).toBeNull();
      await user.click(within(row).getByRole("button", { name: /^Compare/ }));
      await waitFor(() => expect(tauri.callsOf("skills_hub_compare3")).toHaveLength(1));
      // Every file with whose change it is; the three versions side by side.
      expect(await screen.findByText("only you")).toBeTruthy();
      expect(screen.getByText(/Before · The team library when linked/)).toBeTruthy();
      expect(screen.getByText(/The team library now ·/)).toBeTruthy();
      await user.click(screen.getByRole("radio", { name: new RegExp(`^${choice}`) }));
      await user.click(screen.getByRole("button", { name: choice }));
      await waitFor(() => expect(tauri.callsOf(command)).toHaveLength(1));
      if (command === "skills_hub_update") {
        expect(tauri.callsOf(command)[0].args).toEqual({ workspaceId: WS, skill: "review-rules", takeUpstream: true });
      }
      if (command === "skills_hub_propose_upstream") {
        await waitFor(() =>
          expect(useToasts.getState().toasts.some((t) => t.title === "review-rules: proposed to where it came from")).toBe(true),
        );
        const toast = useToasts.getState().toasts.find((t) => t.title === "review-rules: proposed to where it came from")!;
        expect(toast.body).toMatch(/Opened pull request #31 in the team library/);
        expect(toast.action?.label).toBe("Open pull request");
      } else {
        await waitFor(() =>
          expect(useToasts.getState().toasts.some((t) => t.title.startsWith("Card made: Skill:"))).toBe(true),
        );
      }
    }
  });

  // H4 Windows re-walk V5: Propose took 44 s with nothing to show it was
  // working, and the row didn't say the pull request opened.
  it("Propose looks busy at once, and the row names the pull request as soon as it opens", async () => {
    let finish: (value: unknown) => void = () => {};
    let proposed = false;
    const { user, tauri } = render([link("bothChanged")], {
      skills_hub_compare3: () => compare3,
      skills_hub_propose_upstream: () =>
        new Promise((resolve) => {
          finish = (value) => {
            proposed = true;
            resolve(value);
          };
        }),
      // The re-read after the proposal is slow (it was, on Windows): the row
      // must say so before it answers.
      skills_hub_links: () => (proposed ? new Promise(() => {}) : { links: [link("bothChanged")], unreadable: [] }),
    });
    tauri.allowUnhandled();
    await screen.findByText(/Compare to choose/);
    await user.click(within(rowOf("review-rules")).getByRole("button", { name: /^Compare/ }));
    await user.click(await screen.findByRole("radio", { name: /^Propose mine to them/ }));
    await user.click(screen.getByRole("button", { name: "Propose mine to them" }));
    expect(await screen.findByRole("button", { name: "Proposing…" })).toBeTruthy();
    expect(screen.getByText(/Opening a pull request in the team library… This can take a minute\./)).toBeTruthy();
    act(() => finish({ skill: "review-rules", url: "https://github.com/acme/team/pull/45", number: 45, addedToOpen: false }));
    expect(await screen.findByText(/Proposed to where it came from · pull request #45/)).toBeTruthy();
  });

  it("a proposal that stands says so on the row", async () => {
    const { tauri } = render([link("bothChanged", { proposal: { number: 31, url: "https://github.com/acme/team/pull/31" } })]);
    tauri.allowUnhandled();
    expect(await screen.findByText(/Proposed to where it came from · pull request #31/)).toBeTruthy();
    expect(within(rowOf("review-rules")).getByText("Modified here")).toBeTruthy();
  });

  it("Propose waits, with the reason, when the team library can't be changed from here", async () => {
    const { user, tauri } = render([link("bothChanged")], {
      skills_hub_compare3: () => ({ ...compare3, proposeBlocked: "You can read the team library but not change it. Ask matteo for write access, or open a pull request from a fork on GitHub." }),
    });
    tauri.allowUnhandled();
    await screen.findByText(/Compare to choose/);
    await user.click(within(rowOf("review-rules")).getByRole("button", { name: /^Compare/ }));
    expect(await screen.findByText(/Ask matteo for write access/)).toBeTruthy();
    expect((screen.getByRole("radio", { name: /^Propose mine to them/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

// R7, Tier 4 step 8 c walk: the toast said "opened" twice ("pull request
// opened in the team library" over "… opened pull request #63 instead.").
// The title says what happened to the share; the body keeps the spec's why.
describe("Skills hub H4: a Promote that became a pull request", () => {
  it("titles the toast as shared as a pull request, with the why and the link", async () => {
    const why = "Ana changed it meanwhile — opened pull request #63 instead.";
    const { user, tauri } = render([], {
      project_skill_promote: () => ({
        pullRequest: { url: "https://github.com/acme/team/pull/63", number: 63, why },
      }),
    });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "review-rules" });
    await user.click(screen.getByRole("button", { name: "More for review-rules" }));
    await user.click(await screen.findByRole("menuitem", { name: /Replace in Team/ }));
    await user.click(await screen.findByRole("button", { name: "Replace" }));
    await waitFor(() => expect(tauri.callsOf("project_skill_promote")).toHaveLength(1));
    await waitFor(() =>
      expect(useToasts.getState().toasts.some((t) => t.title === "review-rules: shared as a pull request")).toBe(true),
    );
    const toast = useToasts.getState().toasts.find((t) => t.title === "review-rules: shared as a pull request")!;
    expect(toast.body).toBe(why);
    expect(toast.action?.label).toBe("Open pull request");
  });
});

// H4 Challenger step 13 (Windows walk): with gh signed out, a Replace in
// Team failed as "the team library changed on GitHub" and its error toast
// went after 12 s. Now the share says the sign-in, offers the sign-in row's
// way out, and — an action toast — stays until dismissed. The row's ⋯ says
// beforehand that GitHub couldn't be asked.
// Walk follow-ups 2026-10-19 (Challenger): the row's Replace shares the copy
// committed on the branch, not this checkout's edits — the confirm said
// "pushes your version". It now says which copy goes.
describe("the Replace confirm names the copy it shares", () => {
  it("says the branch's copy goes and the local edits stay", async () => {
    const NOTE =
      "This checkout's `review-rules` has changes not on main. Promote to Team shares the copy committed on main; your local changes aren't included.";
    const { user, tauri } = render([], {
      project_skills_view: () => ({
        ...view,
        skills: [{ ...view.skills[0], promoteNote: NOTE }],
      }),
    });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "review-rules" });
    await user.click(screen.getByRole("button", { name: "More for review-rules" }));
    await user.click(await screen.findByRole("menuitem", { name: /Replace in Team/ }));
    const sheet = await screen.findByRole("dialog", { name: "Replace review-rules?" });
    expect(sheet.textContent).toContain(
      "This checkout's review-rules has changes not on main. Replace in Team shares the copy committed on main; your local changes aren't included. Replacing it pushes that copy to everyone on the team.",
    );
    expect(sheet.textContent).not.toContain("your version");
  });
});

describe("Skills hub H4: a share git couldn't sign in for", () => {
  const SIGNED_OUT =
    "Plyloft couldn't share review-rules: GitHub isn't signed in on this Mac, so the push was refused. Nothing reached GitHub and the team library is as it was. Sign in to GitHub in Settings › Team › Members and library, then try again.";

  it("says the sign-in, stays, and offers Sign in to GitHub as the team's account", async () => {
    const { user, tauri } = render([], {
      project_skill_promote: () => {
        throw SIGNED_OUT;
      },
    });
    tauri.allowUnhandled();
    act(() => {
      useSettings.setState((s) => ({
        settings: { ...s.settings, team: { ...(s.settings.team ?? {}), account: "ana-team" } as typeof s.settings.team },
      }));
    });
    await screen.findByRole("button", { name: "review-rules" });
    await user.click(screen.getByRole("button", { name: "More for review-rules" }));
    await user.click(await screen.findByRole("menuitem", { name: /Replace in Team/ }));
    await user.click(await screen.findByRole("button", { name: "Replace" }));
    await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
    const toast = useToasts.getState().toasts[0];
    expect(toast.kind).toBe("error");
    expect(toast.body).toBe(SIGNED_OUT);
    expect(toast.body).not.toMatch(/changed on GitHub|Reapply/);
    expect(toast.action?.label).toBe("Sign in to GitHub");
    expect(toast.action?.ttlMs).toBeUndefined();
    act(() => toast.action!.onClick());
    expect(useSetup.getState()).toMatchObject({ open: true, setupCase: "rerun", step: "github", githubAccount: "ana-team" });
  });

  it("over SSH offers no Sign in to GitHub: the key is the fix", async () => {
    const { user, tauri } = render([], {
      project_skill_promote: () => {
        throw "Plyloft couldn't share review-rules: Git couldn't sign in to GitHub over SSH, so the push was refused. Nothing reached GitHub and the team library is as it was. Check your SSH key, or use HTTPS with the GitHub CLI's sign-in, then try again.";
      },
    });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "review-rules" });
    await user.click(screen.getByRole("button", { name: "More for review-rules" }));
    await user.click(await screen.findByRole("menuitem", { name: /Replace in Team/ }));
    await user.click(await screen.findByRole("button", { name: "Replace" }));
    await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
    expect(useToasts.getState().toasts[0].action).toBeUndefined();
  });

  it("the ⋯ says GitHub couldn't be asked, and keeps Replace in Team on", async () => {
    const caveat =
      "GitHub isn't signed in on this Mac, so Plyloft has not been able to check your write access to the team repo. Sharing will be refused until you sign in to GitHub in Settings › Team › Members and library.";
    const { user, tauri } = render([], {
      project_skills_view: () => ({ ...view, canPromote: true, promoteReason: caveat }),
    });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "review-rules" });
    await user.click(screen.getByRole("button", { name: "More for review-rules" }));
    const entry = (await screen.findByRole("menuitem", { name: /Replace in Team/ })) as HTMLButtonElement;
    expect(entry.disabled).toBe(false);
    expect(screen.getByRole(entry.getAttribute("role")!, { description: caveat })).toBe(entry);
  });
});

describe("Skills hub H4: removed or renamed upstream", () => {
  it.each([
    ["Keep", "keep"],
    ["Remove", "remove"],
  ] as const)("removed offers Keep or Remove, each a card: %s", async (choice, sent) => {
    {
      const { user, tauri } = render([link("removed", { modifiedHere: true })], {
        skills_hub_removed_choice: () => card(`Skill: ${sent === "keep" ? "unlink" : "remove"} review-rules (removed from the team library)`),
      });
      tauri.allowUnhandled();
      await screen.findByText(/The team library no longer has it/);
      const row = rowOf("review-rules");
      expect(within(row).getByText("Removed from the team library")).toBeTruthy();
      await user.click(within(row).getByRole("button", { name: "Keep or remove…" }));
      // Modified here and removed upstream: Remove says the change goes too.
      expect(screen.getByText(/Your changes here go too/)).toBeTruthy();
      if (sent === "remove") await user.click(screen.getByRole("radio", { name: /^Remove/ }));
      await user.click(screen.getByRole("button", { name: choice }));
      await waitFor(() =>
        expect(tauri.callsOf("skills_hub_removed_choice")).toEqual([
          { cmd: "skills_hub_removed_choice", args: { workspaceId: WS, skill: "review-rules", choice: sent } },
        ]),
      );
    }
  });

  // H4 Mac walk: after Keep mine, the 3-way's Before is the team's version
  // kept over (never "when linked", never a commit code), and it says why
  // this repository's untouched lines are marked; its three columns are one
  // row that stacks together.
  it("after Keep mine the 3-way names the version kept over and says why lines are marked", async () => {
    const kept: Compare3 = {
      ...compare3,
      baseLabel: "The team library's version you kept yours over",
      keptNote:
        "You kept this repository's copy over this version, so the lines where you kept yours over the team library's change are marked too, even where nobody edited them in this repository.",
    };
    const { user, tauri } = render([link("bothChanged", { keptMine: true })], { skills_hub_compare3: () => kept });
    tauri.allowUnhandled();
    await screen.findByText(/changed here and in the team library\. Compare to choose/);
    await user.click(within(rowOf("review-rules")).getByRole("button", { name: /^Compare/ }));
    expect(await screen.findByText(/Before · The team library's version you kept yours over/)).toBeTruthy();
    expect(screen.getByText(/even where nobody edited them in this repository/)).toBeTruthy();
    expect(screen.queryByText(/when linked/)).toBeNull();
    expect(document.querySelector(".ux-compare--three")?.children).toHaveLength(3);
  });

  it("renamed offers Rename here or Keep the old name", async () => {
    const { user, tauri } = render([link("renamed", { renamedTo: "lint-rules" })], {
      skills_hub_renamed_choice: () => card("Skill: rename review-rules to lint-rules (renamed in the team library)"),
    });
    tauri.allowUnhandled();
    await screen.findByText(/renamed it to lint-rules/);
    const row = rowOf("review-rules");
    expect(within(row).getByText("Renamed upstream to lint-rules")).toBeTruthy();
    await user.click(within(row).getByRole("button", { name: "Rename…" }));
    await user.click(screen.getByRole("button", { name: "Rename here" }));
    await waitFor(() =>
      expect(tauri.callsOf("skills_hub_renamed_choice")).toEqual([
        { cmd: "skills_hub_renamed_choice", args: { workspaceId: WS, skill: "review-rules", choice: "rename" } },
      ]),
    );
  });
});

describe("Skills hub H4: pieces", () => {
  it("reads the skill out of a decision row's id", () => {
    expect(decisionSkillOf("skill-decision:ws-1:review-rules:both:abc")).toBe("review-rules");
    expect(decisionSkillOf("skill-decision:ws-1:old-lint:renamed:lint-rules")).toBe("old-lint");
    expect(decisionSkillOf("skill:team:a/b/acme/x:needs-ok:1")).toBeNull();
  });

  it("marks the lines a side added since before, counted", () => {
    const rows = markedLines("a\nb\n", "a\nx\nb\nb\r\n", true);
    expect(rows.map((r) => [r.text, r.changed])).toEqual([
      ["a", false],
      ["x", true],
      ["b", false],
      ["b", true],
    ]);
    expect(markedLines(null, "a\n", true)).toEqual([{ text: "a", changed: false }]);
  });
});
