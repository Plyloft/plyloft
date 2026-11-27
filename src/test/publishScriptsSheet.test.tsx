// Owner, 2026-10-19 (R15): in a shared workspace, Publish to <branch> of a
// member's own repository copy commits it straight onto the branch, where
// teammates get it with no card. So a publish that brings a new or changed
// script (or a file that is not text) shows the scripts sheet first and
// publishes only on **OK, publish**, sending the ids it showed; a text-only
// publish goes as before.
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent } from "@testing-library/react";
import { ScriptApprovalFlow, publishLedeOf, type InstallSheet } from "../components/library/ScriptApprovalFlow";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import type { ProjectSkillsView, ScriptsReview } from "../ipc";
import type { LibraryStateLike } from "../lib/sharedLibrary";
import { useLibrary } from "../store/libraryStore";
import { useToasts } from "../store/toastStore";
import { renderUi, screen, waitFor } from "./render";

const SHEET: ScriptsReview = {
  skill: "deploy",
  plugin: "",
  commit: "c".repeat(40),
  scriptsIds: ["publish:abc"],
  firstTime: false,
  approvedAt: null,
  author: null,
  files: [
    {
      path: "scripts/ship.sh",
      kind: "script",
      executable: true,
      size: 30,
      change: "new",
      text: "#!/bin/sh\necho ship\n",
      tooLarge: false,
      copies: [],
    },
    {
      path: "SKILL.md",
      kind: "text",
      executable: false,
      size: 90,
      change: "changed",
      text: "---\ndescription: Ships.\n---\n",
      tooLarge: false,
      copies: [],
    },
  ],
};

function sheet(onConfirm: InstallSheet["onConfirm"]): InstallSheet {
  return { workspaceId: "ws", verb: "publish", branch: "staging", onConfirm };
}

describe("the publish sheet", () => {
  it("reads the publish's files, script first, and publishes on OK with the ids it showed", async () => {
    const onConfirm = vi.fn(async () => {});
    const onDone = vi.fn();
    const { tauri } = renderUi(
      <ScriptApprovalFlow plugin="" skill="deploy" install={sheet(onConfirm)} onDone={onDone} onCancel={() => {}} />,
      { fixtures: { project_skill_publish_review: () => SHEET } },
    );
    expect((await screen.findAllByText("brings a new or changed script", { exact: false })).length).toBeGreaterThan(0);
    expect(tauri.callsOf("project_skill_publish_review")[0]?.args).toEqual({ workspaceId: "ws", skill: "deploy" });
    expect(tauri.callsOf("skills_hub_install_review")).toHaveLength(0);
    expect(screen.getByText("Publish")).toBeTruthy();
    const labels = screen.getAllByText(/^(scripts\/ship\.sh|SKILL\.md)$/).map((n) => n.textContent);
    expect(labels).toEqual(["scripts/ship.sh", "SKILL.md"]);
    expect(screen.getByText("30 B · new")).toBeTruthy();
    expect(screen.getByText(/on staging at once, with no card to review it/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Show" })[0]);
    expect(screen.getByLabelText("scripts/ship.sh text").textContent).toContain("echo ship");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "OK, publish" }));
    await act(async () => {});
    expect(onConfirm).toHaveBeenCalledWith(["publish:abc"]);
    expect(onDone).toHaveBeenCalled();
    // Nothing is approved for sessions: a repository skill is never held.
    expect(tauri.callsOf("skills_hub_approve")).toHaveLength(0);
  });

  it("reads again when the copy or the branch changed while it was open", async () => {
    let reads = 0;
    const onDone = vi.fn();
    const onConfirm = vi.fn(async () => {
      throw new Error(
        "deploy changed while you were reading it, here or on staging, so you haven't said OK to what it brings now. Look at its files again.",
      );
    });
    renderUi(
      <ScriptApprovalFlow plugin="" skill="deploy" install={sheet(onConfirm)} onDone={onDone} onCancel={() => {}} />,
      {
        fixtures: {
          project_skill_publish_review: () => {
            reads += 1;
            return SHEET;
          },
        },
      },
    );
    fireEvent.click(await screen.findByRole("button", { name: "OK, publish" }));
    await act(async () => {});
    await act(async () => {});
    expect(onDone).not.toHaveBeenCalled();
    expect(reads).toBe(2);
    expect(await screen.findByText(/while you were reading it/)).toBeTruthy();
  });

  it("words an image as a file that is not text", () => {
    const image: ScriptsReview = {
      ...SHEET,
      files: [
        { ...SHEET.files[0], change: "unchanged" },
        { path: "diagram.png", kind: "extra", executable: false, size: 8, change: "new", text: null, tooLarge: false, copies: [] },
      ],
    };
    expect(publishLedeOf(image, "staging")).toBe(
      "Publishing puts a new or changed file that is not text on staging at once, with no card to review it. Everyone who works on this repository gets it. Agents get the file when they use the skill.",
    );
  });
});

// ── On the Skills page ───────────────────────────────────────────────

const WS = "ws-publish-sheet";
const CWD = "/Users/someone/code/project";

const view: ProjectSkillsView = {
  workspaceId: WS,
  workspaceName: "project",
  cwd: CWD,
  skills: [
    {
      name: "deploy",
      codexName: null,
      description: "Ships the app to staging.",
      claude: true,
      codex: false,
      roots: [".claude/skills"],
      diverged: false,
      ignoredRoots: [],
      team: "absent",
      promoteBlocked: null,
    },
  ],
  team: [],
  unloadable: [],
  rootsPresent: [".claude/skills"],
  ignoredRoots: [],
  configured: false,
  hasClone: false,
  canPromote: false,
  promoteReason: null,
  promotePlugin: null,
  errors: [],
} as unknown as ProjectSkillsView;

const library = {
  shared: true,
  branch: "staging",
  readOnly: false,
  repository: "someone/project",
  pending: [],
  branchSkills: [],
  branchSkillRows: [],
  skipped: [],
  currentInCheckout: [],
} as unknown as LibraryStateLike;

function Host() {
  const data = useSkillsData(WS, true);
  return <SkillsPage workspaceId={WS} cwd={CWD} data={data} />;
}

function render(extra: Record<string, unknown>) {
  return renderUi(<Host />, {
    fixtures: {
      project_skills_view: () => view,
      knowledge_project_state: () => library,
      personal_skills_view: () => ({ skills: [], rootsPresent: [], errors: [] }),
      skills_hub_links: () => ({ links: [], unreadable: [] }),
      ply_skills_view: () => ({ skills: [], problem: null }),
      ...extra,
    },
  });
}

async function pressPublish(user: { click: (el: Element) => Promise<void> }) {
  await screen.findByRole("button", { name: "deploy" });
  await user.click(screen.getByRole("button", { name: "More for deploy" }));
  await user.click(await screen.findByRole("menuitem", { name: "Publish to staging" }));
}

describe("Publish to <branch> on the Skills page", () => {
  it("shows the scripts first and publishes only on OK, with the ids shown", async () => {
    useToasts.setState({ toasts: [] });
    const { user, tauri } = render({
      project_skill_publish_review: () => SHEET,
      project_skill_publish: () => ({ follows: null, outcome: "published" }),
    });
    tauri.allowUnhandled();
    await pressPublish(user);
    expect(await screen.findByRole("button", { name: "OK, publish" })).toBeTruthy();
    expect(useLibrary.getState().byWorkspace[WS]?.flow).toEqual({ kind: "publish", key: "repository:deploy" });
    expect(tauri.callsOf("project_skill_publish")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "OK, publish" }));
    await waitFor(() =>
      expect(tauri.callsOf("project_skill_publish")).toEqual([
        { cmd: "project_skill_publish", args: { workspaceId: WS, skill: "deploy", scriptsOk: ["publish:abc"] } },
      ]),
    );
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.title)).toContain("Published deploy to staging"),
    );
    expect(useLibrary.getState().byWorkspace[WS]?.flow ?? null).toBeNull();
  });

  it("Cancel publishes nothing", async () => {
    const { user, tauri } = render({
      project_skill_publish_review: () => SHEET,
      project_skill_publish: () => ({ follows: null, outcome: "published" }),
    });
    tauri.allowUnhandled();
    await pressPublish(user);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(tauri.callsOf("project_skill_publish")).toHaveLength(0);
    expect(useLibrary.getState().byWorkspace[WS]?.flow ?? null).toBeNull();
  });

  it("a text-only publish goes straight away, as before", async () => {
    const { user, tauri } = render({
      project_skill_publish_review: () => null,
      project_skill_publish: () => ({ follows: null, outcome: "published" }),
    });
    tauri.allowUnhandled();
    await pressPublish(user);
    await waitFor(() =>
      expect(tauri.callsOf("project_skill_publish")).toEqual([
        { cmd: "project_skill_publish", args: { workspaceId: WS, skill: "deploy", scriptsOk: null } },
      ]),
    );
    expect(screen.queryByRole("button", { name: "OK, publish" })).toBeNull();
  });

  it("a publish the backend refused for a script opens the sheet", async () => {
    let reviewed = 0;
    const { user, tauri } = render({
      // Text only at the first read; a script by the time the publish ran.
      project_skill_publish_review: () => (reviewed++ === 0 ? null : SHEET),
      project_skill_publish: () => {
        throw new Error(
          "deploy brings a new or changed script you haven't said OK to publishing to staging. Look at its files first.",
        );
      },
    });
    tauri.allowUnhandled();
    await pressPublish(user);
    expect(await screen.findByRole("button", { name: "OK, publish" })).toBeTruthy();
    expect(useLibrary.getState().byWorkspace[WS]?.flow).toEqual({ kind: "publish", key: "repository:deploy" });
  });

  // Publish-sheet walk: a press from the `⋯` says what it is doing on the
  // row while it reads and while it publishes, then the words go.
  it("the row says it is reading, then publishing, while the press works", async () => {
    let readDone: (value: null) => void = () => {};
    let publishDone: (value: unknown) => void = () => {};
    const { user, tauri } = render({
      project_skill_publish_review: () => new Promise((resolve) => (readDone = resolve)),
      project_skill_publish: () => new Promise((resolve) => (publishDone = resolve)),
    });
    tauri.allowUnhandled();
    await pressPublish(user);
    expect(await screen.findByText("Reading its files…")).toBeTruthy();
    await act(async () => readDone(null));
    expect(await screen.findByText("Publishing…")).toBeTruthy();
    await act(async () => publishDone({ follows: null, outcome: "published" }));
    await waitFor(() => expect(screen.queryByText("Publishing…")).toBeNull());
    expect(screen.queryByText("Reading its files…")).toBeNull();
  });

  it("the sheet's footnote names a file that is not text too", async () => {
    const { user, tauri } = render({
      project_skill_publish_review: () => SHEET,
      project_skill_publish: () => ({ follows: null, outcome: "published" }),
    });
    tauri.allowUnhandled();
    await pressPublish(user);
    expect(
      await screen.findByText(/a later one that brings a new or changed script or file that is not text asks again/),
    ).toBeTruthy();
  });
});
