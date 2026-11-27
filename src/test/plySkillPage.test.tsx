// Skills hub H9 (R9): a skill that comes with Plyloft — its version on the row
// and the page, `Where it's on` with the three levels, the team default the
// owner alone may set, and Personalize.
//
// The real Skills page on its real data hook.
import { describe, expect, it } from "vitest";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import type { PlyPlace, PlySkillSwitch, ProjectSkillsView } from "../ipc";
import { useLibrary } from "../store/libraryStore";
import { useToasts } from "../store/toastStore";
import { act, renderUi, screen, waitFor, within } from "./render";

const WS = "ws-ply";
const CWD = "/Users/someone/code/web";

const view: ProjectSkillsView = {
  workspaceId: WS,
  workspaceName: "acme-web",
  cwd: CWD,
  skills: [],
  team: [],
  unloadable: [],
  rootsPresent: [],
  ignoredRoots: [],
  configured: true,
  hasClone: true,
  canPromote: false,
  promoteReason: null,
  promotePlugin: "ply-team",
  errors: [],
};

const PLACE: PlyPlace = {
  workspaceName: "acme-web",
  repository: "acme/web",
  shared: true,
  readOnly: false,
  team: { slug: "acme/team", name: "acme", owner: "matteo", youOwn: false },
};

function Host() {
  const data = useSkillsData(WS, true);
  return <SkillsPage workspaceId={WS} cwd={CWD} data={data} />;
}

function plyView(sw: PlySkillSwitch, place: PlyPlace = PLACE) {
  return {
    skills: [
      {
        name: "card-brief",
        title: "Write a good card brief",
        description: "Turns a rough idea into a brief an agent can work from. Use when opening a card.",
        dir: "/Applications/Plyloft.app/ply-skills/card-brief",
        claude: true,
        codex: true,
        on: sw.macOn,
        version: "1.167.0",
        changes: [
          { version: "1.167.0", contentId: "b", summary: "asks for the acceptance check first" },
          { version: "1.152.0", contentId: "a", summary: "first version" },
        ],
        switch: sw,
      },
    ],
    problem: null,
    place,
  };
}

const NO_CHOICE: PlySkillSwitch = { on: true, level: "default", workspace: null, fork: false, teamOff: false, macOn: true };

async function render(sw: PlySkillSwitch, extra: Record<string, (args: Record<string, unknown>) => unknown> = {}, place?: PlyPlace) {
  const ui = renderUi(<Host />, {
    fixtures: {
      project_skills_view: () => view,
      knowledge_project_state: () => {
        throw new Error("not shared");
      },
      personal_skills_view: () => ({ skills: [], rootsPresent: [], errors: [] }),
      skills_hub_links: () => ({ links: [], unreadable: [] }),
      skill_tree_digests: () => [],
      fs_list_dir: () => [],
      fs_read_text_file: () => "# Write a good card brief\n",
      ply_skills_view: ({ workspaceId }: Record<string, unknown>) => {
        // Read for this workspace, so the switch says which level decides here.
        expect(workspaceId).toBe(WS);
        return plyView(sw, place);
      },
      ...extra,
    },
  });
  ui.tauri.allowUnhandled();
  return ui;
}

describe("Skills hub H9: a Plyloft skill's version and switch", () => {
  it("shows the version on the row and the page, and the three levels", async () => {
    await render(NO_CHOICE);
    // R9 AC: the row hint.
    expect(await screen.findByText("v1.167.0 · Changed in 1.167.0: asks for the acceptance check first")).toBeTruthy();
    act(() => useLibrary.getState().openSkill(WS, "ply:card-brief"));
    expect(await screen.findByText("Changed in 1.167.0: asks for the acceptance check first.")).toBeTruthy();
    expect(screen.getByText("Earlier: 1.152.0 — first version.")).toBeTruthy();
    expect(screen.getByText("v1.167.0")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Where it's on" })).toBeTruthy();
    expect(screen.getByText("In acme-web: on")).toBeTruthy();
    // Q27: the team level has no "on" — no team choice follows this Mac.
    expect(
      screen.getByText("No team choice — follows this Mac. Only matteo can switch it off for the team."),
    ).toBeTruthy();
    expect(screen.getByRole("group", { name: "In acme-web" })).toBeTruthy();
  });

  it("says a fork in this repository is what switched it off", async () => {
    await render({ on: false, level: "fork", workspace: null, fork: true, teamOff: false, macOn: true });
    expect(
      await screen.findByText(/Off in this workspace: acme\/web has its own card-brief, personalized from Plyloft\./),
    ).toBeTruthy();
    // Mac re-walk: the row's toggle is this Mac's — still checked and live,
    // drawn quieter, and the row says what it is.
    expect(screen.getByText(/The switch is this Mac's own \(on\); in this workspace the line above decides\./)).toBeTruthy();
    const toggle = screen.getAllByRole("switch").find((s) => s.classList.contains("ux-toggle--overruled"));
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect((toggle as HTMLButtonElement | undefined)?.disabled).toBe(false);
    act(() => useLibrary.getState().openSkill(WS, "ply:card-brief"));
    expect(await screen.findByText("In acme-web: off")).toBeTruthy();
    expect(
      screen.getByText(/this repository has its own card-brief, so no tile, card or run here gets Plyloft's\./),
    ).toBeTruthy();
  });

  it("sets this workspace's choice through the backend", async () => {
    const { user, tauri } = await render(NO_CHOICE, { ply_skill_setting: () => null });
    act(() => useLibrary.getState().openSkill(WS, "ply:card-brief"));
    const group = await screen.findByRole("group", { name: "In acme-web" });
    await user.click(within(group).getByRole("button", { name: "Off" }));
    await waitFor(() => expect(tauri.callsOf("ply_skill_setting")).toHaveLength(1));
    expect(tauri.callsOf("ply_skill_setting")[0].args).toEqual({
      level: "workspace",
      workspaceId: WS,
      name: "card-brief",
      choice: false,
    });
  });

  it("answers a member's press on the team default with who decides", async () => {
    const { user, tauri } = await render(NO_CHOICE, {
      ply_skill_setting: () => {
        throw new Error("Only matteo can switch Plyloft's card-brief off for the team. You are signed in to GitHub as ana.");
      },
    });
    act(() => useLibrary.getState().openSkill(WS, "ply:card-brief"));
    await screen.findByRole("heading", { name: "Where it's on" });
    const team = screen.getAllByRole("switch")[0];
    await user.click(team);
    await waitFor(() => expect(tauri.callsOf("ply_skill_setting")).toHaveLength(1));
    expect(tauri.callsOf("ply_skill_setting")[0].args).toMatchObject({ level: "team", choice: false });
    await waitFor(() =>
      expect(
        useToasts.getState().toasts.some((t) => /Only matteo can switch Plyloft's card-brief off for the team/.test(t.body ?? "")),
      ).toBe(true),
    );
  });

  it("personalizes into the repository as a card", async () => {
    const card = {
      id: "c1",
      workspaceId: WS,
      title: "Skill: personalize card-brief from Plyloft",
      kind: { type: "skill", verb: "personalize", skill: "card-brief", origin: { kind: "plyloft", source: "plyloft", name: "card-brief", version: { commit: "1.167.0", contentId: "b" } } },
    };
    const { user, tauri } = await render(NO_CHOICE, {
      ply_skill_personalize: () => ({ card, plugin: null, pushed: false, pullRequest: null, teamSwitched: false, owner: null }),
    });
    act(() => useLibrary.getState().openSkill(WS, "ply:card-brief"));
    await user.click(await screen.findByRole("button", { name: "Personalize…" }));
    expect(await screen.findByText("Personalize · 1 step")).toBeTruthy();
    // A member: the team choice says who switches Plyloft's off for the team.
    expect(screen.getByText(/Only matteo can switch Plyloft's card-brief off for the team\. Your fork reaches sessions next to it until then\./)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Make the card" }));
    await waitFor(() => expect(tauri.callsOf("ply_skill_personalize")).toHaveLength(1));
    expect(tauri.callsOf("ply_skill_personalize")[0].args).toMatchObject({ name: "card-brief", target: "repository" });
    await waitFor(() =>
      expect(useToasts.getState().toasts.some((t) => t.title === "Card made: Skill: personalize card-brief from Plyloft")).toBe(true),
    );
  });

  it("tells a member who published a team fork to ask the owner", async () => {
    const { user } = await render(NO_CHOICE, {
      ply_skill_personalize: () => ({ card: null, plugin: "ply-team", pushed: true, pullRequest: null, teamSwitched: false, owner: "matteo" }),
    });
    act(() => useLibrary.getState().openSkill(WS, "ply:card-brief"));
    await user.click(await screen.findByRole("button", { name: "Personalize…" }));
    await user.click(await screen.findByRole("radio", { name: /The team library/ }));
    await user.click(screen.getByRole("button", { name: "Personalize" }));
    await waitFor(() => {
      const toast = useToasts.getState().toasts.find((t) => t.title === "Your card-brief is in acme's library");
      expect(toast?.action?.label).toBe("Ask matteo");
    });
  });

  // Challenger (H9): the owner whose team-default write failed after the
  // fork was shared hears why — never "Only <themselves> can switch it off".
  it("tells the owner why the team default didn't follow a team fork", async () => {
    const { user } = await render(NO_CHOICE, {
      ply_skill_personalize: () => ({
        card: null,
        plugin: "ply-team",
        pushed: true,
        pullRequest: null,
        teamSwitched: false,
        owner: null,
        teamSwitchProblem: "GitHub couldn't be reached.",
      }),
    });
    act(() => useLibrary.getState().openSkill(WS, "ply:card-brief"));
    await user.click(await screen.findByRole("button", { name: "Personalize…" }));
    await user.click(await screen.findByRole("radio", { name: /The team library/ }));
    await user.click(screen.getByRole("button", { name: "Personalize" }));
    await waitFor(() => {
      const toast = useToasts.getState().toasts.find((t) => t.title === "Your card-brief is in acme's library");
      expect(toast?.kind).toBe("warn");
      expect(toast?.body).toContain("still on for the team: GitHub couldn't be reached.");
      expect(toast?.body).not.toMatch(/Only /);
      expect(toast?.action).toBeUndefined();
    });
  });
});
