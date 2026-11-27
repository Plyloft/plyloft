// QoL block 13 on the real Skills page and its data hook, through the
// stubbed Tauri layer:
//
// - 13.1: a skill only the project folder has offers Ship it with a card,
//   which makes a skill card (`skills_hub_carry`) and opens it at Ship;
// - 13.2: a folder behind the branch offers Ask the Builder, which opens a
//   Builder tile in the folder with the request as its first turn;
// - 13.4: Install makes its card and stays in the Library — the toast's
//   Open card opens it.
import { beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import type { ProjectSkillsView } from "../ipc";
import { useToasts } from "../store/toastStore";
import { useTiles } from "../store/tileStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { renderUi, screen, waitFor } from "./render";

const WS = "ws-ways-out";
const CWD = "/Users/someone/code/project";

const view: ProjectSkillsView = {
  workspaceId: WS,
  workspaceName: "project",
  cwd: CWD,
  skills: [
    {
      name: "fresh",
      codexName: null,
      description: "A skill just written.",
      claude: true,
      codex: true,
      roots: [".claude/skills", ".agents/skills"],
      diverged: false,
      ignoredRoots: [],
      team: "absent",
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

function card(id: string, title: string, verb: string, skill: string) {
  return {
    id,
    workspaceId: WS,
    title,
    columnId: "complete",
    createdAt: 0,
    updatedAt: 0,
    kind: { type: "skill", verb, skill, origin: { kind: "", source: "", name: skill, version: { commit: "", contentId: "" } } },
  };
}

function render(extra: Record<string, unknown> = {}, library: Record<string, unknown> = {}) {
  return renderUi(<Host />, {
    fixtures: {
      project_skills_view: () => view,
      knowledge_project_state: () => ({ shared: false, pending: [], branchSkills: [], branchSkillRows: [], skipped: [], ...library }),
      personal_skills_view: () => ({ skills: [], rootsPresent: [], errors: [] }),
      skills_hub_links: () => ({ links: [], unreadable: [], uncommitted: ["fresh"] }),
      ply_skills_view: () => ({ skills: [], problem: null }),
      ...extra,
    },
  });
}

function rowOf(name: string): HTMLElement {
  return screen.getByRole("button", { name }).closest<HTMLElement>(".ux-row")!;
}

beforeEach(() => {
  useWorkspaces.setState({
    workspaces: [{ id: WS, name: "project", cwd: CWD } as never],
    activeId: WS,
  });
  useUi.setState({ selectedCardId: {}, cardStep: {} });
  useTiles.setState({ byWorkspace: {} });
});

describe("QoL 13.1: Ship it with a card", () => {
  it("says the skill is only in the folder and makes a card carrying it, opened at Ship", async () => {
    const made = card("card-carry", "Skill: ship fresh from your project folder", "carry", "fresh");
    const { user, tauri } = render({ skills_hub_carry: () => made });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "fresh" });
    const row = rowOf("fresh");
    expect(row.textContent).toContain("Only in your project folder");
    await user.click(within(row).getByRole("button", { name: "Ship it with a card" }));
    await waitFor(() =>
      expect(tauri.callsOf("skills_hub_carry")).toEqual([
        { cmd: "skills_hub_carry", args: { workspaceId: WS, skill: "fresh" } },
      ]),
    );
    await waitFor(() => expect(useUi.getState().selectedCardId[WS]).toBe("card-carry"));
    expect(useUi.getState().cardStep["card-carry"]).toBe("outcome");
    expect(useToasts.getState().toasts.map((t) => t.title)).toContain("Card made: Skill: ship fresh from your project folder");
  });
});

describe("QoL 13.1 (Reviewer): a newer copy on the target", () => {
  it("makes no card and offers Ask the Builder to bring it here first", async () => {
    const { user, tauri } = render({
      skills_hub_carry: () => {
        throw new Error("main has a newer fresh. Ask the Builder to bring it here first, then ship it with a card.");
      },
    });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "fresh" });
    await user.click(within(rowOf("fresh")).getByRole("button", { name: "Ship it with a card" }));
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.title)).toContain("fresh wasn't put in a card"));
    expect(useUi.getState().selectedCardId[WS] ?? null).toBeNull();
    const toast = useToasts.getState().toasts.find((t) => t.title === "fresh wasn't put in a card")!;
    expect(toast.action?.label).toBe("Ask the Builder");
    toast.action!.onClick();
    const tiles = useTiles.getState().byWorkspace[WS]?.tiles ?? [];
    expect(tiles[0]?.args?.[0]).toMatch(/^My project folder is behind main\. I need it for fresh\./);
  });
});

describe("QoL 13.4: Install stays in the Library", () => {
  it("makes the card without opening it; the toast's Open card does", async () => {
    const made = card("card-1", "Skill: install lint from the team library", "install", "lint");
    const { user, tauri } = render({ skills_hub_install: () => ({ kind: "card", card: made }) });
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "lint" });
    await user.click(within(rowOf("lint")).getByRole("button", { name: "Install" }));
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.title)).toContain("Card made: Skill: install lint from the team library"),
    );
    expect(useUi.getState().selectedCardId[WS] ?? null).toBeNull();
    const toast = useToasts.getState().toasts.find((t) => t.title.startsWith("Card made:"))!;
    expect(toast.action?.label).toBe("Open card");
    toast.action!.onClick();
    expect(useUi.getState().selectedCardId[WS]).toBe("card-1");
    expect(useUi.getState().cardStep["card-1"]).toBe("outcome");
  });
});

describe("QoL 13.2: Ask the Builder", () => {
  it("opens a Builder tile in the project folder with the request as its first turn", async () => {
    const { user, tauri } = render(
      { skills_hub_links: () => ({ links: [], unreadable: [], uncommitted: [] }) },
      {
        shared: true,
        branch: "staging",
        branchSkills: ["fresh"],
        branchSkillRows: [{ name: "fresh", description: "A skill just written.", dir: "/m/c", codexDir: "/m/x", claude: true, codex: true, differs: false }],
        checkoutBehind: [{ name: "fresh", copy: "codex" }],
      },
    );
    tauri.allowUnhandled();
    await screen.findByRole("button", { name: "fresh" });
    const row = rowOf("fresh");
    expect(row.textContent).toContain("Your project folder's Codex copy is behind staging");
    await user.click(within(row).getByRole("button", { name: "Ask the Builder" }));
    const tiles = useTiles.getState().byWorkspace[WS]?.tiles ?? [];
    expect(tiles).toHaveLength(1);
    expect(tiles[0].kind).toBe("claude");
    expect(tiles[0].cwd).toBe(CWD);
    expect(tiles[0].args?.[0]).toMatch(/^My project folder is behind staging\. I need it for fresh\./);
    expect(tiles[0].args?.[0]).toMatch(/Don't discard, stash, reset or commit any of my changes/);
  });
});
