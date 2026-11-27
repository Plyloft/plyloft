// Skills hub H7 (R4): All skills over the running app. Tier 1.5: opening
// and leaving it never unmounts a warmed workspace's hosts (a terminal that
// runs keeps its node), and the store's selectors hand out the same objects
// until the index changes (docs/PATTERNS.md). Then the page itself: the
// cache at once, the stream, the keyboard (filter focus, arrows, Enter, Esc
// back), Used in, a folder not found, and no workspace at all.
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { useTiles } from "../../store/tileStore";
import { useUi } from "../../store/uiStore";
import { stopAllSkillsSubscriptions, useAllSkills } from "../../store/allSkillsStore";
import { DEFAULT_SETTINGS, type Settings } from "../../store/settingsStore";
import { SETUP_VERSION } from "../../lib/settingsShape";
import { setSetupAutoOpenForTests } from "../../lib/setupSteps";
import type { AccountInfo, HubIndex, HubIndexRow, HubIndexView } from "../../ipc";
import type { Workspace } from "../../store/workspaceStore";
import { act, fireEvent, nextFrame, renderUi, screen, waitFor, within } from "../../test/render";

const life = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock("../Terminal", () => ({
  Terminal: ({ tileId }: { tileId: string }) => {
    useEffect(() => {
      life.mounts += 1;
      return () => {
        life.unmounts += 1;
      };
    }, []);
    return <div data-testid="terminal" data-tile={tileId} />;
  },
}));
vi.mock("../CodexSession", () => ({ CodexSession: () => <div data-testid="codex" /> }));

beforeEach(() => {
  life.mounts = 0;
  life.unmounts = 0;
  setSetupAutoOpenForTests(false);
  stopAllSkillsSubscriptions();
});

const lyra: Workspace = {
  id: "w1",
  name: "lyra",
  cwd: "/Users/someone/code/lyra",
  createdAt: 1,
  lastOpenedAt: 1,
  openFiles: [],
  activeFile: null,
};

const SIGNED_IN: AccountInfo = {
  signedIn: true,
  login: "octocat",
  sub: "1",
  plan: "free",
  teamRepo: null,
  teamRole: null,
  status: null,
  periodEnd: null,
  exp: Date.UTC(2099, 0, 1),
  comp: false,
  entitlementValid: true,
  lastCheckedAt: 1,
  offline: false,
  lastKnownPlan: "free",
  team: null,
  deviceName: "Test Mac",
};

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  onboarding: {
    ...DEFAULT_SETTINGS.onboarding,
    firstRunCompletedAt: "2026-01-01T00:00:00Z",
    setupVersion: SETUP_VERSION,
  },
};

function skill(name: string, over: Partial<HubIndexRow> = {}): HubIndexRow {
  return {
    name,
    description: `${name} does a thing.`,
    claude: true,
    codex: true,
    claudeId: `id-${name}`,
    codexId: `id-${name}`,
    twinsDiffer: false,
    legacyCodex: false,
    dir: `/x/${name}`,
    changedAt: null,
    tooManyFiles: false,
    needsOk: false,
    offHere: false,
    ...over,
  };
}

const INDEX: HubIndex = {
  schemaVersion: 1,
  builtAt: 1,
  workspaces: [
    {
      id: "w1",
      name: "lyra",
      path: lyra.cwd,
      state: "ok",
      source: "checkout",
      repo: "acme/lyra",
      readAt: 1,
      rows: [
        skill("review-rules", {
          link: {
            originKind: "team",
            originWords: "the team library",
            source: "acme/team",
            plugin: "acme",
            name: "review-rules",
            state: "updateAvailable",
          },
        }),
        skill("deploy-notes"),
      ],
    },
    {
      id: "cold",
      name: "astra",
      path: "/Volumes/Other/astra",
      state: "missing",
      source: "checkout",
      repo: "acme/astra",
      readAt: 1,
      rows: [],
    },
  ],
  team: { repo: "acme/team", readAt: 1, problem: null, rows: [skill("review-rules", { plugin: "acme" })] },
  thisMac: { repo: null, readAt: 1, problem: null, rows: [skill("sql-style", { codex: false, codexId: null })] },
  plyloft: null,
};

async function launch(workspaces: Workspace[] = [lyra]) {
  const tauri = renderUi(<div />).tauri;
  tauri.allowUnhandled();
  tauri.fixture("settings_get", settings);
  tauri.fixture("settings_set", ({ settings: next }: Record<string, unknown>) => next);
  tauri.fixture("workspace_list", { workspaces, activeWorkspaceId: workspaces[0]?.id ?? null });
  tauri.fixture("workspace_cwd_exists", true);
  tauri.fixture("drain_status", { draining: false, startedAt: null });
  tauri.fixture("ship_pending_count", 0);
  tauri.fixture("ship_unverified_count", 0);
  tauri.fixture("pty_spawn", "pty-1");
  tauri.fixture("agent_list", []);
  tauri.fixture("agent_run_list", []);
  tauri.fixture("kanban_load", []);
  tauri.fixture("swarm_list", []);
  tauri.fixture("inbox_feed", { generatedAt: 0, windowDays: 28, events: [], costRollup: [], eligibilityProof: {} });
  tauri.fixture("improvement_proposal_state", null);
  tauri.fixture("improvement_proposal_trust_stopped", null);
  tauri.fixture("onboarding_take_welcome", false);
  tauri.fixture("identity_get", null);
  tauri.fixture("account_get", SIGNED_IN);
  tauri.fixture("account_dev_skip_sign_in", false);
  tauri.fixture("project_config_list", []);
  const view: HubIndexView = { index: INDEX, refreshing: true, reading: ["w1"] };
  tauri.fixture("skills_hub_index", view);
  tauri.fixture("skills_hub_index_refresh", null);
  if (workspaces.length > 0) useUi.getState().setCenterMode(workspaces[0].id, "terminals");
  const r = renderUi(<App />);
  return { ...r, tauri };
}

async function withTerminal() {
  const app = await launch();
  await screen.findByRole("button", { name: /lyra, switch workspace/ });
  await act(async () => {
    useTiles.getState().addShellTile(lyra.id, lyra.cwd);
  });
  await waitFor(() => expect(screen.getByTestId("terminal")).toBeTruthy());
  return { ...app, running: screen.getByTestId("terminal") };
}

const openAllSkills = async () => {
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /^All skills/ })));
  await screen.findByRole("listbox", { name: "Skills" });
};

describe("All skills over a running app", () => {
  it("opens over the workspace hosts and leaves them mounted, then returns to the mode you were in", async () => {
    const { running, tauri } = await withTerminal();
    await openAllSkills();
    // The cache at once, and a read behind it.
    const asks = tauri.callsOf("skills_hub_index");
    expect(asks[asks.length - 1]?.args).toEqual({ refresh: true });
    const list = screen.getByRole("listbox", { name: "Skills" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("review-rules"), expect.stringContaining("sql-style")]),
    );
    // Hidden, never unmounted: the same terminal node.
    expect(screen.getByTestId("terminal")).toBe(running);
    const stage = document.querySelector(".center-stage")!;
    expect(stage.classList.contains("center-stage--app-page")).toBe(true);

    // Esc from the (empty) filter goes back to Terminals.
    const filter = screen.getByRole("searchbox");
    expect(document.activeElement).toBe(filter);
    await act(async () => fireEvent.keyDown(filter, { key: "Escape" }));
    expect(useUi.getState().allSkillsOpen).toBe(false);
    expect(useUi.getState().centerMode[lyra.id]).toBe("terminals");
    expect(screen.getByTestId("terminal")).toBe(running);

    // Open and leave by choosing a mode, several times: never a remount.
    for (let i = 0; i < 3; i++) {
      await openAllSkills();
      await act(async () => useUi.getState().setCenterMode(lyra.id, "board"));
      expect(useUi.getState().allSkillsOpen).toBe(false);
      await act(async () => useUi.getState().setCenterMode(lyra.id, "terminals"));
    }
    expect(screen.getByTestId("terminal")).toBe(running);
    expect(life.mounts).toBe(1);
    expect(life.unmounts).toBe(0);
    expect(tauri.callsOf("pty_kill")).toEqual([]);
  });

  it("walks the list by keyboard: ↓ from the filter, Enter opens, Esc back to the list, Esc out", async () => {
    await withTerminal();
    await openAllSkills();
    const filter = screen.getByRole("searchbox");
    await act(async () => fireEvent.keyDown(filter, { key: "ArrowDown" }));
    const list = screen.getByRole("listbox", { name: "Skills" });
    expect(document.activeElement).toBe(list);
    const first = list.getAttribute("aria-activedescendant")!;
    expect(document.getElementById(first)?.textContent).toContain("deploy-notes");
    await act(async () => fireEvent.keyDown(list, { key: "ArrowDown" }));
    const second = list.getAttribute("aria-activedescendant")!;
    expect(document.getElementById(second)?.textContent).toContain("review-rules");
    expect(document.getElementById(second)?.getAttribute("aria-selected")).toBe("true");

    // Enter opens it, read through the hub: Used in, and where it opens.
    await act(async () => fireEvent.keyDown(list, { key: "Enter" }));
    await screen.findByRole("heading", { name: "review-rules" });
    expect(screen.getByRole("button", { name: "Open in its workspace" })).toBeTruthy();
    expect(document.body.textContent).toContain("Linked to the team library · update available");

    // Esc: back to the list, on the row that was open.
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await screen.findByRole("listbox", { name: "Skills" });
    await nextFrame();
    expect(useAllSkills.getState().activeKey).toBe("repository:w1:review-rules");
    expect(useUi.getState().allSkillsOpen).toBe(true);
    // Esc again, from the list: out.
    await act(async () => fireEvent.keyDown(screen.getByRole("listbox", { name: "Skills" }), { key: "Escape" }));
    expect(useUi.getState().allSkillsOpen).toBe(false);
  });

  it("↓ from the filter starts at the first row again; Esc closes the Workspaces popover, not the page", async () => {
    await withTerminal();
    await openAllSkills();
    const filter = screen.getByRole("searchbox");
    await act(async () => useAllSkills.getState().setActiveKey("repository:w1:review-rules"));
    await act(async () => fireEvent.keyDown(filter, { key: "ArrowDown" }));
    const list = screen.getByRole("listbox", { name: "Skills" });
    expect(document.getElementById(list.getAttribute("aria-activedescendant")!)?.textContent).toContain("deploy-notes");

    const trigger = screen.getByRole("button", { name: /^Workspaces:/ });
    await act(async () => fireEvent.click(trigger));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Escape" }));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(useUi.getState().allSkillsOpen).toBe(true);

    // Every workspace: its button goes, the caret stays in the popover, and
    // Esc — even from the Reaches dropdown beside it — closes the popover
    // before the page.
    await act(async () => fireEvent.click(trigger));
    const pick = within(screen.getByRole("dialog", { name: "Workspaces" })).getAllByRole("checkbox")[0];
    await act(async () => fireEvent.click(pick));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Every workspace" })));
    await nextFrame();
    expect(screen.queryByRole("button", { name: "Every workspace" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Workspaces" }).contains(document.activeElement)).toBe(true);
    const reaches = screen.getByRole("combobox", { name: "Reaches" });
    reaches.focus();
    await act(async () => fireEvent.keyDown(reaches, { key: "Escape" }));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(useUi.getState().allSkillsOpen).toBe(true);
  });

  it("a team skill's Used in names its linked copies; a folder not found has its row", async () => {
    await withTerminal();
    await openAllSkills();
    const list = screen.getByRole("listbox", { name: "Skills" });
    const team = within(list).getAllByRole("option").find((o) => o.textContent?.includes("Team · acme"))!;
    expect(team.textContent).toContain("Used in 1: lyra (linked · update available)");
    expect(team.textContent).toContain("1 update");
    const missing = within(list).getAllByRole("option").find((o) => o.textContent?.includes("astra"))!;
    expect(missing.textContent).toContain("Folder not found · /Volumes/Other/astra");
    // The sidebar's muted count: the one update (never the accent count).
    const entry = screen.getByRole("button", { name: /^All skills/ });
    expect(entry.querySelector(".shell-count")?.textContent).toBe("1");
    expect(entry.querySelector(".shell-count--attention")).toBeNull();
  });

  it("streams: a workspace read again replaces its rows, and the reading mark goes", async () => {
    const { tauri } = await withTerminal();
    await openAllSkills();
    expect(document.body.textContent).toContain("Reading…");
    await act(async () =>
      tauri.emit("skills-hub://index", {
        kind: "workspace",
        workspace: { ...INDEX.workspaces[0], rows: [skill("brand-new")] },
      }),
    );
    await act(async () => tauri.emit("skills-hub://index", { kind: "done", builtAt: 2, workspaceIds: ["w1"] }));
    const list = screen.getByRole("listbox", { name: "Skills" });
    const text = within(list).getAllByRole("option").map((o) => o.textContent).join("\n");
    expect(text).toContain("brand-new");
    expect(text).not.toContain("deploy-notes");
    expect(document.body.textContent).not.toContain("Reading…");
  });

  it("filters by scope and text", async () => {
    await withTerminal();
    await openAllSkills();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^This Mac 1/ })));
    const list = screen.getByRole("listbox", { name: "Skills" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("sql-style")]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^All \d+/ })));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "deploy" } });
    await waitFor(() =>
      expect(within(screen.getByRole("listbox", { name: "Skills" })).getAllByRole("option")).toHaveLength(1),
    );
  });
});

describe("Copy to… (Skills hub H8)", () => {
  it("opens from a row over the running app and its Cancel returns to the list; the terminal stays", async () => {
    const { running, tauri } = await withTerminal();
    tauri.fixture("skills_hub_copy_targets", {
      skill: "deploy-notes",
      fromWords: "lyra",
      claude: true,
      codex: true,
      cardTitle: "Skill: copy deploy-notes from lyra",
      localReason: null,
      uncommittedNote: null,
      targets: [{ workspaceId: "cold", name: "astra", repo: "acme/astra", target: { kind: "refused", why: "astra's folder isn't on this Mac now." } }],
    });
    await openAllSkills();
    const list = screen.getByRole("listbox", { name: "Skills" });
    const row = within(list).getAllByRole("option").find((o) => o.textContent?.includes("deploy-notes"))!;
    // The row's own button, not the row: the skill's page doesn't open.
    await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Add to other projects…" })));
    await screen.findByRole("heading", { name: /Copy deploy-notes to/ });
    expect(tauri.callsOf("skills_hub_copy_targets")[0]?.args).toEqual({
      from: { kind: "workspace", workspaceId: "w1", skill: "deploy-notes" },
    });
    expect(useAllSkills.getState().openKey).toBe(null);
    expect(screen.getByTestId("terminal")).toBe(running);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    await screen.findByRole("listbox", { name: "Skills" });
    expect(useUi.getState().allSkillsOpen).toBe(true);
    // A Plyloft skill has no Copy to… (Personalize is H9); this Mac's has.
    const mac = within(screen.getByRole("listbox", { name: "Skills" }))
      .getAllByRole("option")
      .find((o) => o.textContent?.includes("sql-style"))!;
    expect(within(mac).getByRole("button", { name: "Add to other projects…" })).toBeTruthy();
    expect(life.unmounts).toBe(0);
    expect(tauri.callsOf("pty_kill")).toEqual([]);
  });
});

describe("All skills with no workspace open", () => {
  it("is app-level: the entry works and the page draws", async () => {
    await launch([]);
    const entry = await screen.findByRole("button", { name: /^All skills/ });
    expect((entry as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: /^Inbox/ }) as HTMLButtonElement).disabled).toBe(true);
    await openAllSkills();
    expect(screen.getByRole("listbox", { name: "Skills" })).toBeTruthy();
  });
});

describe("selector stability (docs/PATTERNS.md)", () => {
  it("hands out the same rows until the index changes", async () => {
    renderUi(<div />).tauri.fixture("skills_hub_index", { index: INDEX, refreshing: false, reading: [] });
    await act(async () => useAllSkills.getState().load());
    const { rows, names, reading } = useAllSkills.getState();
    useAllSkills.getState().setFilters({ text: "x" });
    useAllSkills.getState().setActiveKey("k");
    useAllSkills.getState().apply({ kind: "started", workspaceIds: [], whole: false });
    expect(useAllSkills.getState().rows).toBe(rows);
    expect(useAllSkills.getState().names).toBe(names);
    useAllSkills.getState().apply({ kind: "done", builtAt: null, workspaceIds: [] });
    expect(useAllSkills.getState().rows).toBe(rows);
    expect(useAllSkills.getState().reading).toBe(reading);
    useAllSkills.getState().apply({ kind: "thisMac", source: { repo: null, readAt: 2, problem: null, rows: [] } });
    expect(useAllSkills.getState().rows).not.toBe(rows);
  });
});
