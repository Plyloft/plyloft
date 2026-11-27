// Skills hub H6b (R15 AC 1): the Install-time sheet.
//
// Before Install or Update writes a library skill's files into the
// repository, a skill that brings a script or an extra file the repository
// doesn't hold yet shows every file — scripts first — and makes the card only
// on **OK, install** / **OK, update**, sending the scripts it showed. A
// text-only skill goes straight to its card.
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, within } from "@testing-library/react";
import {
  ScriptApprovalFlow,
  installBringsWords,
  installFileHint,
  installLedeOf,
  type InstallSheet,
} from "../components/library/ScriptApprovalFlow";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import type { ProjectSkillsView, ScriptsReview, SkillLinkRow } from "../ipc";
import { useLibrary } from "../store/libraryStore";
import { useToasts } from "../store/toastStore";
import { renderUi, screen, waitFor } from "./render";

const SHEET: ScriptsReview = {
  skill: "lint",
  plugin: "acme",
  commit: "b".repeat(40),
  scriptsIds: ["s-lint"],
  firstTime: true,
  approvedAt: null,
  author: "Ana",
  files: [
    {
      path: "scripts/check.sh",
      kind: "script",
      executable: true,
      size: 40,
      change: "new",
      text: "#!/bin/sh\necho lint\n",
      tooLarge: false,
      copies: [],
    },
    {
      path: "SKILL.md",
      kind: "text",
      executable: false,
      size: 120,
      change: "new",
      text: "---\ndescription: Lints.\n---\n",
      tooLarge: false,
      copies: [],
    },
  ],
};

function sheet(onConfirm: InstallSheet["onConfirm"], verb: InstallSheet["verb"] = "install"): InstallSheet {
  return { workspaceId: "ws", verb, onConfirm };
}

describe("the Install-time sheet", () => {
  it("lists every file, the script first, and installs on OK with the scripts it showed", async () => {
    const onConfirm = vi.fn(async () => {});
    const onDone = vi.fn();
    const { tauri } = renderUi(
      <ScriptApprovalFlow plugin="acme" skill="lint" install={sheet(onConfirm)} onDone={onDone} onCancel={() => {}} />,
      { fixtures: { skills_hub_install_review: () => SHEET } },
    );
    expect(await screen.findByText("brings a script", { exact: false })).toBeTruthy();
    expect(tauri.callsOf("skills_hub_install_review")[0]?.args).toEqual({
      workspaceId: "ws",
      plugin: "acme",
      skill: "lint",
      verb: "install",
    });
    expect(tauri.callsOf("skills_hub_scripts_review")).toHaveLength(0);
    const labels = screen.getAllByText(/^(scripts\/check\.sh|SKILL\.md)$/).map((n) => n.textContent);
    expect(labels).toEqual(["scripts/check.sh", "SKILL.md"]);
    expect(screen.getByText("Script")).toBeTruthy();
    expect(screen.getByText("executable")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Show" })[0]);
    expect(screen.getByLabelText("scripts/check.sh text").textContent).toContain("echo lint");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "OK, install" }));
    await act(async () => {});
    expect(onConfirm).toHaveBeenCalledWith(["s-lint"]);
    expect(onDone).toHaveBeenCalledWith(true);
    // The OK goes with the card, never through the H6a approval alone.
    expect(tauri.callsOf("skills_hub_approve")).toHaveLength(0);
  });

  it("reads the files again when the pull before the card brought other scripts", async () => {
    let reads = 0;
    const onDone = vi.fn();
    const onConfirm = vi.fn(async () => {
      throw new Error(
        "lint changed in the team library while you were reading it, so you haven't said OK to what it brings now. Look at its files again.",
      );
    });
    renderUi(
      <ScriptApprovalFlow plugin="acme" skill="lint" install={sheet(onConfirm)} onDone={onDone} onCancel={() => {}} />,
      {
        fixtures: {
          skills_hub_install_review: () => {
            reads += 1;
            return SHEET;
          },
        },
      },
    );
    fireEvent.click(await screen.findByRole("button", { name: "OK, install" }));
    await act(async () => {});
    await act(async () => {});
    expect(onDone).not.toHaveBeenCalled();
    expect(reads).toBe(2);
    expect(await screen.findByText(/while you were reading it/)).toBeTruthy();
  });

  it("Cancel writes nothing", async () => {
    const onConfirm = vi.fn(async () => {});
    const onCancel = vi.fn();
    renderUi(
      <ScriptApprovalFlow plugin="acme" skill="lint" install={sheet(onConfirm)} onDone={() => {}} onCancel={onCancel} />,
      { fixtures: { skills_hub_install_review: () => SHEET } },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("goes ahead without an OK once nothing asks any more", async () => {
    const onConfirm = vi.fn(async () => {});
    renderUi(
      <ScriptApprovalFlow plugin="acme" skill="lint" install={sheet(onConfirm, "update")} onDone={() => {}} onCancel={() => {}} />,
      { fixtures: { skills_hub_install_review: () => null } },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    await act(async () => {});
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it("an update says OK, update and what changed", async () => {
    renderUi(
      <ScriptApprovalFlow
        plugin="acme"
        skill="lint"
        install={sheet(async () => {}, "update")}
        onDone={() => {}}
        onCancel={() => {}}
      />,
      {
        fixtures: {
          skills_hub_install_review: () => ({
            ...SHEET,
            firstTime: false,
            files: SHEET.files.map((f) => ({ ...f, change: f.kind === "script" ? "changed" : "unchanged" })),
          }),
        },
      },
    );
    expect(await screen.findByRole("button", { name: "OK, update" })).toBeTruthy();
    expect(screen.getByText("40 B · changed")).toBeTruthy();
  });

  it("words what the card does, and an earlier OK for sessions", () => {
    expect(installLedeOf(SHEET, "install")).toBe(
      "Installing puts these files in this repository through a card, a script among them. Everyone who works on this repository gets them once the card ships. Agents may run the script when they use the skill.",
    );
    expect(installLedeOf({ ...SHEET, approvedAt: Date.UTC(2026, 9, 3, 12) }, "update")).toBe(
      "This update puts a new or changed script in this repository through a card. Everyone who works on this repository gets them once the card ships. Agents may run the script when they use the skill. You said OK to this version for sessions on this Mac on 3 Oct.",
    );
    expect(installFileHint(SHEET.files[0])).toBe("40 B");
    expect(installFileHint({ ...SHEET.files[0], text: null, tooLarge: true })).toBe("40 B · too large to show here");
  });

  it("an update whose only new file is an image doesn't say it brings a script (Reviewer)", () => {
    const update: ScriptsReview = {
      ...SHEET,
      firstTime: false,
      files: [
        { ...SHEET.files[0], change: "unchanged" },
        { path: "diagram.png", kind: "extra", executable: false, size: 10, change: "new", text: null, tooLarge: false, copies: [] },
        SHEET.files[1],
      ],
    };
    expect(installBringsWords(update, "update")).toBe("brings a new or changed file that is not text");
    expect(installLedeOf(update, "update")).toMatch(/^This update puts a new or changed file that is not text /);
    // Install brings every file, the script among them.
    expect(installBringsWords(update, "install")).toBe("brings a script");
  });
});

// ── On the Skills page ───────────────────────────────────────────────

const WS = "ws-install-sheet";
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

function Host() {
  const data = useSkillsData(WS, true);
  return <SkillsPage workspaceId={WS} cwd={CWD} data={data} />;
}

function render(links: SkillLinkRow[], extra: Record<string, unknown>) {
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

const CARD = {
  id: "card-1",
  workspaceId: WS,
  title: "Skill: install lint from the team library",
  columnId: "complete",
  createdAt: 0,
  updatedAt: 0,
};

describe("Install on the Skills page", () => {
  it("opens the sheet first and makes the card only on OK, with the scripts shown", async () => {
    const { user, tauri } = render([], {
      skills_hub_install_review: () => SHEET,
      skills_hub_install: () => ({ kind: "card", card: CARD }),
    });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "lint" });
    await user.click(within(rowOf("lint")).getByRole("button", { name: "Install" }));
    expect(await screen.findByRole("button", { name: "OK, install" })).toBeTruthy();
    expect(useLibrary.getState().byWorkspace[WS]?.flow).toEqual({ kind: "scripts", key: "team:lint" });
    expect(tauri.callsOf("skills_hub_install")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "OK, install" }));
    await waitFor(() =>
      expect(tauri.callsOf("skills_hub_install")).toEqual([
        {
          cmd: "skills_hub_install",
          args: { workspaceId: WS, plugin: "acme", skill: "lint", replace: false, scriptsOk: ["s-lint"] },
        },
      ]),
    );
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.title)).toContain(
        "Card made: Skill: install lint from the team library",
      ),
    );
    expect(useLibrary.getState().byWorkspace[WS]?.flow ?? null).toBeNull();
  });

  it("a text-only skill goes straight to its card", async () => {
    const { user, tauri } = render([], {
      skills_hub_install_review: () => null,
      skills_hub_install: () => ({ kind: "card", card: CARD }),
    });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "lint" });
    await user.click(within(rowOf("lint")).getByRole("button", { name: "Install" }));
    await waitFor(() =>
      expect(tauri.callsOf("skills_hub_install")).toEqual([
        { cmd: "skills_hub_install", args: { workspaceId: WS, plugin: "acme", skill: "lint", replace: false } },
      ]),
    );
    expect(screen.queryByRole("button", { name: "OK, install" })).toBeNull();
  });

  it("Update of a linked copy whose script changed asks first", async () => {
    const link: SkillLinkRow = {
      skill: "review-rules",
      originKind: "team",
      originWords: "the team library",
      source: "acme/team",
      plugin: "acme",
      versionCommit: "a3f9c21",
      state: "updateAvailable",
      upstreamMoved: true,
    };
    const { user, tauri } = render([link], {
      skills_hub_install_review: () => ({ ...SHEET, skill: "review-rules", firstTime: false }),
      skills_hub_update: () => ({ ...CARD, title: "Skill: update review-rules from the team library" }),
    });
    tauri.allowUnhandled();
    await screen.findByText(/Linked to the team library · update available/);
    await user.click(within(rowOf("review-rules")).getByRole("button", { name: /^Update/ }));
    expect(await screen.findByRole("button", { name: "OK, update" })).toBeTruthy();
    expect(tauri.callsOf("skills_hub_install_review")[0]?.args).toEqual({
      workspaceId: WS,
      plugin: "acme",
      skill: "review-rules",
      verb: "update",
    });
    expect(tauri.callsOf("skills_hub_update")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "OK, update" }));
    await waitFor(() =>
      expect(tauri.callsOf("skills_hub_update")).toEqual([
        { cmd: "skills_hub_update", args: { workspaceId: WS, skill: "review-rules", scriptsOk: ["s-lint"] } },
      ]),
    );
  });
});
