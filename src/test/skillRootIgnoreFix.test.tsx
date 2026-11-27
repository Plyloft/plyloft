// GH #215: a gitignored skill root gets a fix, with a confirmation. The real
// DiagnosticsPage, the real doctor store, the report
// through the stubbed `dependency_doctor`:
//
//  - the warning offers `Un-ignore`; pressing it only asks for the plan;
//  - the confirmation shows the exact lines and the file they go into;
//  - Cancel closes it and invokes no write;
//  - Confirm sends back exactly the edits shown, re-reads the doctor, and the
//    row says what happened — the button goes once the root is carried;
//  - a root Ply can't fix (the member's own excludes file) is explained, with
//    no way to write anything.
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { DiagnosticsPage } from "../components/settings/DiagnosticsPage";
import type { DoctorReport, IgnoreFixOutcome, IgnorePlan } from "../ipc";
import { useWorkspaces } from "../store/workspaceStore";
import type { Workspace } from "../store/workspaceStore";
import { act, renderUi, screen, waitFor } from "./render";
import { useDoctor } from "../store/doctorStore";

const DETAIL_IGNORED =
  "1 project skill loaded from atelier into every Claude and Codex session Plyloft starts there. " +
  ".claude/skills is gitignored in this repo — a card will not carry it.";
const DETAIL_CLEAN =
  "1 project skill loaded from atelier into every Claude and Codex session Plyloft starts there.";

const LINES = [
  "# Plyloft: un-ignore .claude/skills so commits carry the skills",
  "!/.claude/",
  "/.claude/*",
  "!/.claude/skills/",
];

const PLAN: IgnorePlan = {
  roots: [".claude/skills"],
  edits: [
    {
      file: ".gitignore",
      reach: "repository",
      roots: [".claude/skills"],
      lines: LINES,
      rules: [".gitignore:2: .claude/"],
    },
  ],
  refused: [],
};

const OUTCOME: IgnoreFixOutcome = {
  written: PLAN.edits,
  stillIgnored: [],
  sentence:
    "Added 4 lines to .gitignore. Git no longer ignores .claude/skills. Commit .gitignore with the skills so card worktrees and teammates get them.",
};

function report(gitignored: string[]): DoctorReport {
  return {
    tools: [],
    teamSkills: null,
    projectSkills: {
      loaded: 1,
      claudeOnly: 0,
      codexOnly: 0,
      unloadable: 0,
      diverged: 0,
      gitignored,
      ignoredLinks: [],
      unanswered: [],
      gitDetails: [],
      workspace: "atelier",
      detail: gitignored.length ? DETAIL_IGNORED : DETAIL_CLEAN,
    },
    microphone: null,
    whisperModel: null,
    dictationShell: null,
    sharedDefinition: null,
    probeError: null,
    allRequiredOk: true,
  } as DoctorReport;
}

function seedWorkspace() {
  useWorkspaces.setState({
    workspaces: [{ id: "ws-1", name: "atelier", cwd: "/repo/atelier" } as Workspace],
    activeId: "ws-1",
  });
}

/** The doctor answers "ignored" until the fix has been written. */
function doctorFixtures(plan: IgnorePlan = PLAN) {
  let fixed = false;
  return {
    dependency_doctor: () => report(fixed ? [] : [".claude/skills"]),
    build_cache_status: () => null, project_try_command_get: () => null, worktree_settings_get: () => ({}),
    skill_root_ignore_plan: () => plan,
    skill_root_ignore_fix: () => {
      fixed = true;
      return OUTCOME;
    },
  };
}

async function openDiagnostics(plan?: IgnorePlan) {
  seedWorkspace();
  const r = renderUi(<DiagnosticsPage scope="this-mac" />, { fixtures: doctorFixtures(plan) });
  const hint = await screen.findByText(DETAIL_IGNORED);
  const row = hint.closest(".ux-row") as HTMLElement | null;
  expect(row, "the project skills row").not.toBeNull();
  return { ...r, row: row as HTMLElement };
}

describe("Diagnostics: Un-ignore a gitignored skill root (GH #215)", () => {
  it("the warning offers the fix, and pressing it only reads the plan", async () => {
    const { user, row, tauri } = await openDiagnostics();
    const button = within(row).getByRole("button", { name: "Let Git see it" });
    await user.click(button);
    await screen.findByRole("dialog", { name: "Let Git see .claude/skills?" });
    expect(tauri.callsOf("skill_root_ignore_plan")).toEqual([
      { cmd: "skill_root_ignore_plan", args: { workspaceId: "ws-1" } },
    ]);
    expect(tauri.callsOf("skill_root_ignore_fix")).toHaveLength(0);
  });

  it("the confirmation shows the exact lines and the file they go into", async () => {
    const { user, row } = await openDiagnostics();
    await user.click(within(row).getByRole("button", { name: "Let Git see it" }));
    const dialog = await screen.findByRole("dialog", { name: "Let Git see .claude/skills?" });
    expect(within(dialog).getByText(".gitignore", { selector: "span" })).toBeTruthy();
    const lines = within(dialog).getByLabelText("Lines added to .gitignore");
    expect(lines.textContent).toBe(LINES.join("\n"));
    expect(within(dialog).getByRole("button", { name: "Add 4 lines" })).toBeTruthy();
    expect(dialog.textContent).toContain("Nothing already in it changes.");
    expect(dialog.textContent).toContain("Plyloft doesn't commit.");
  });

  it("Cancel closes the confirmation and invokes no write", async () => {
    const { user, row, tauri } = await openDiagnostics();
    await user.click(within(row).getByRole("button", { name: "Let Git see it" }));
    const dialog = await screen.findByRole("dialog", { name: "Let Git see .claude/skills?" });
    const reads = tauri.callsOf("dependency_doctor").length;
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tauri.callsOf("skill_root_ignore_fix")).toHaveLength(0);
    expect(tauri.callsOf("dependency_doctor")).toHaveLength(reads);
    expect(within(row).getByRole("button", { name: "Let Git see it" })).toBeTruthy();
  });

  it("Confirm writes exactly the edits shown, then the row checks again", async () => {
    const { user, row, tauri } = await openDiagnostics();
    await user.click(within(row).getByRole("button", { name: "Let Git see it" }));
    const dialog = await screen.findByRole("dialog", { name: "Let Git see .claude/skills?" });
    const reads = tauri.callsOf("dependency_doctor").length;
    await user.click(within(dialog).getByRole("button", { name: "Add 4 lines" }));
    await waitFor(() => expect(tauri.callsOf("dependency_doctor").length).toBe(reads + 1));
    expect(tauri.callsOf("skill_root_ignore_fix")).toEqual([
      { cmd: "skill_root_ignore_fix", args: { workspaceId: "ws-1", edits: PLAN.edits } },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    // The re-read says the root is carried: the step is gone and the row
    // says what happened.
    const note = await screen.findByText((text) => text.includes(OUTCOME.sentence));
    const after = note.closest(".ux-row") as HTMLElement;
    expect(within(after).queryByRole("button", { name: "Let Git see it" })).toBeNull();
    expect(after.textContent).toContain("Git no longer ignores .claude/skills.");

    // A later read (Look again, a workspace switch) is about the repo as it
    // is then: the outcome sentence goes with it.
    await act(async () => {
      await useDoctor.getState().refresh();
    });
    await waitFor(() =>
      expect(screen.queryByText((text) => text.includes(OUTCOME.sentence))).toBeNull(),
    );
  });

  it("two files: the lede says each file, and a file git ignores itself is said to stay local", async () => {
    const two: IgnorePlan = {
      roots: [".claude/skills", ".agents/skills"],
      edits: [
        { ...PLAN.edits[0] },
        {
          file: ".claude/.gitignore",
          reach: "checkout",
          roots: [".claude/skills"],
          lines: ["# Plyloft: un-ignore .claude/skills so commits carry the skills", "!/skills/"],
          rules: [".claude/.gitignore:1: *"],
        },
      ],
      refused: [],
    };
    const { user, row } = await openDiagnostics(two);
    await user.click(within(row).getByRole("button", { name: "Let Git see it" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("to the end of each file");
    expect(dialog.textContent).toContain("Git ignores this file itself, so it is never committed");
    expect(within(dialog).getByRole("button", { name: "Add 6 lines" })).toBeTruthy();
  });

  it("a rule in the member's own excludes file is explained, with nothing to write", async () => {
    const refused: IgnorePlan = {
      roots: [".claude/skills"],
      edits: [],
      refused: [
        {
          root: ".claude/skills",
          reason:
            ".claude/skills is ignored by your own git settings, not by this repository. Remove or narrow the rule Details names, then look again.",
          suggestion: null,
          rule: "/Users/me/.config/git/ignore:1: .claude/",
        },
      ],
    };
    const { user, row, tauri } = await openDiagnostics(refused);
    await user.click(within(row).getByRole("button", { name: "Let Git see it" }));
    const dialog = await screen.findByRole("dialog", { name: "Plyloft can't let Git see .claude/skills" });
    expect(dialog.textContent).toContain("your own git settings");
    // No edit to suggest, so the lede doesn't promise one.
    expect(dialog.textContent).toContain("and why Plyloft won't add a line for it.");
    expect(dialog.textContent).not.toContain("the edit to make by hand");
    expect(within(dialog).queryByRole("button", { name: /^Add/ })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(tauri.callsOf("skill_root_ignore_fix")).toHaveLength(0);
  });

  it("a rule that reaches inside the skills is explained with the edit to make, and Close only", async () => {
    const refused: IgnorePlan = {
      roots: [".claude/skills"],
      edits: [],
      refused: [
        {
          root: ".claude/skills",
          reason:
            "A rule in .gitignore also ignores the files inside .claude/skills. Un-ignoring them from here would also un-ignore .env files, keys and whatever each teammate's own git settings ignore there, so Plyloft leaves this one to you. Edit .gitignore by hand instead, then look again.",
          suggestion: "Replace the line .claude/** with:\n.claude/*\n!/.claude/skills/",
          rule: ".gitignore:4: .claude/**",
        },
      ],
    };
    const { user, row, tauri } = await openDiagnostics(refused);
    await user.click(within(row).getByRole("button", { name: "Let Git see it" }));
    const dialog = await screen.findByRole("dialog", { name: "Plyloft can't let Git see .claude/skills" });
    // Words first; the edit in mono; the raw rule only under Details.
    expect(dialog.textContent).toContain("each teammate's own git settings");
    expect(dialog.textContent).toContain("and the edit to make by hand.");
    expect(within(dialog).getByLabelText("Edit to make for .claude/skills").textContent).toBe(
      "Replace the line .claude/** with:\n.claude/*\n!/.claude/skills/",
    );
    const details = dialog.querySelector("details");
    expect(details?.textContent).toContain(".gitignore:4: .claude/**");
    expect(details?.open).toBe(false);
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual(["Close"]);
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(tauri.callsOf("skill_root_ignore_fix")).toHaveLength(0);
  });

  it("a clean root offers no fix", async () => {
    seedWorkspace();
    renderUi(<DiagnosticsPage scope="this-mac" />, {
      fixtures: {
        dependency_doctor: () => report([]),
        build_cache_status: () => null, project_try_command_get: () => null, worktree_settings_get: () => ({}),
      },
    });
    const hint = await screen.findByText(DETAIL_CLEAN);
    const row = hint.closest(".ux-row") as HTMLElement;
    expect(within(row).queryByRole("button", { name: "Let Git see it" })).toBeNull();
  });
});

// GH #227: a link among the skills. The row explains it and warns; Un-ignore
// isn't offered for a link; and a plan that couldn't get git's answer says
// so instead of "Git no longer ignores any skill root here".
describe("Project skills: links and unanswered roots (GH #227)", () => {
  const DETAIL_LINK =
    "1 project skill loaded from atelier into every Claude and Codex session Plyloft starts there. " +
    ".claude/skills (to ../shared/skills) is a link, and git ignores the link itself — a card carries neither it nor the skills behind it.";

  function linkReport(): DoctorReport {
    const base = report([]);
    return {
      ...base,
      projectSkills: {
        ...base.projectSkills!,
        ignoredLinks: [".claude/skills"],
        detail: DETAIL_LINK,
      },
    } as DoctorReport;
  }

  it("an ignored link is explained in Diagnostics, with no Un-ignore", async () => {
    seedWorkspace();
    renderUi(<DiagnosticsPage scope="this-mac" />, {
      fixtures: { dependency_doctor: () => linkReport(), build_cache_status: () => null, project_try_command_get: () => null, worktree_settings_get: () => ({}) },
    });
    const detail = await screen.findByText(DETAIL_LINK);
    const row = detail.closest(".ux-row") as HTMLElement;
    expect(within(row).queryByRole("button", { name: "Let Git see it" })).toBeNull();
  });

  it("a plan git couldn't answer for is refused in words, never 'no root is ignored'", async () => {
    const reason =
      "Plyloft couldn't ask git whether .agents/skills/s4 is ignored (it is inside a submodule), so it can't tell what to add.";
    seedWorkspace();
    const { user, tauri } = renderUi(<DiagnosticsPage scope="this-mac" />, {
      fixtures: {
        ...doctorFixtures(),
        skill_root_ignore_plan: () => {
          throw reason;
        },
      },
    });
    const hint = await screen.findByText(DETAIL_IGNORED);
    const row = hint.closest(".ux-row") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Let Git see it" }));
    const note = await screen.findByText((text) => text.includes(reason));
    expect(note.textContent).toContain("nothing was changed");
    expect(note.textContent).not.toContain("Git no longer ignores any skill root here");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tauri.callsOf("skill_root_ignore_fix")).toHaveLength(0);
  });

  it("git's own words are in Details, not in the row", async () => {
    const detail =
      "1 project skill loaded from atelier into every Claude and Codex session Plyloft starts there. " +
      "Plyloft couldn't ask git whether .agents/skills/s4 is ignored — it is inside a submodule — so the row doesn't say either way.";
    const raw = "git check-ignore failed: fatal: Pathspec '.agents/skills/s4/SKILL.md' is in submodule '.agents/skills/s4'";
    seedWorkspace();
    renderUi(<DiagnosticsPage scope="this-mac" />, {
      fixtures: {
        dependency_doctor: () => {
          const base = report([]);
          return {
            ...base,
            projectSkills: {
              ...base.projectSkills!,
              unanswered: [".agents/skills/s4"],
              gitDetails: [raw],
              detail,
            },
          } as DoctorReport;
        },
        build_cache_status: () => null, project_try_command_get: () => null, worktree_settings_get: () => ({}),
      },
    });
    const hint = await screen.findByText(detail);
    expect(hint.textContent).not.toContain("fatal");
    const details = document.querySelector("details pre") as HTMLElement;
    expect(details.textContent).toContain(`atelier skills, git: ${raw}`);
  });
});
