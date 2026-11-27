// GH #171 (ADR 0001): Agents, Role bindings and Swarm templates are retired
// from Settings › Advanced. Rendered on the real Settings shell, the real
// stores and the real navigation, from an old settings.json with
// `"advancedSwarms": true` — the switch that used to show two of the three,
// itself gone since G4 (launch D8):
//
//  1. Account lists Setup, Plan, Profile and Diagnostics, and nothing else
//     (UX-9.3: Advanced is gone; Reset is Diagnostics' danger zone; launch
//     A3: the Licence part is retired).
//  2. A link to any id the three pages answered to — theirs, and the sectioned
//     Settings' `agents` and `templates` — opens Claude and Codex, whose status
//     line says what was retired. G4: no swarm switch, swarm notification or
//     card-swarm cap is drawn there, whatever the old file said.
//  3. Choosing a page from the navigation takes that line away.
//
// GH #175: `Who writes up a discussion` had a page and no control; the Board's
// discussion dialog still reads it, so Claude and Codex draws it, and pressing it
// saves the vendor.
import { beforeEach, describe, expect, it } from "vitest";
import { tauri as tauriStub } from "./tauri";

// QoL 1.168 (F4): Claude and Codex › Notifications reads the permission.
beforeEach(() => tauriStub().fixture("notification_access", "allowed"));
import { within } from "@testing-library/react";
import { SettingsOverlay } from "../components/SettingsOverlay";
import { BuildsRunsPage } from "../components/settings/BuildsRunsPage";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { useUi } from "../store/uiStore";
import { useDoctor } from "../store/doctorStore";
import type { DoctorReport } from "../ipc";
import { RETIRED_NOTE } from "../lib/settingsNav";
import type { Settings } from "../lib/settingsShape";
import { act, renderUi, screen, waitFor } from "./render";

/** What an old settings.json decodes to: the frontend shape plus the keys G4
 *  took out of it, as the backend still sends what it owns. */
const SWARMS_ON = {
  ...DEFAULT_SETTINGS,
  behavior: {
    ...DEFAULT_SETTINGS.behavior,
    advancedSwarms: true,
    notifyOnSwarmDone: true,
    notifySwarmRoleBoundary: true,
    maxConcurrentCardSwarms: 3,
  },
} as unknown as Settings;

/** What the shell and its first pages ask the backend for, answered empty. */
const fixtures = {
  settings_get: () => SWARMS_ON,
  settings_set: ({ settings }: Record<string, unknown>) => settings,
};

function openSettings() {
  useSettings.setState({ settings: SWARMS_ON, loaded: true } as never);
  const r = renderUi(<SettingsOverlay />, { fixtures });
  act(() => useUi.getState().setSettingsOverlayOpen(true));
  return r;
}

describe("Settings › Account after GH #171 and UX-9.3", () => {
  it("lists no retired page, from an old file with advanced swarms on", async () => {
    openSettings();
    const nav = await screen.findByRole("navigation");
    for (const gone of ["Agents", "Role bindings", "Swarm templates", "Reset", "Advanced"]) {
      expect(within(nav).queryByText(gone)).toBeNull();
    }
    // Launch A3: Plan, and Profile without the retired Licence part.
    expect(within(nav).getByText("Plan")).toBeTruthy();
    expect(within(nav).getByText("Profile")).toBeTruthy();
    expect(within(nav).queryByText("Profile and licence")).toBeNull();
    expect(within(nav).getByText("Diagnostics")).toBeTruthy();
  });

  for (const id of ["agents", "role-bindings", "swarm-templates", "templates"]) {
    it(`a link to "${id}" lands on AI and models and says why`, async () => {
      openSettings();
      await screen.findByRole("navigation");
      act(() => useUi.getState().openSettingsSection(id));
      expect(await screen.findByRole("heading", { name: "AI and models" })).toBeTruthy();
      expect(screen.getByText(RETIRED_NOTE)).toBeTruthy();
      // G4: nothing of the swarm UI is drawn, whatever the old file said.
      for (const gone of [
        "Advanced: role-chain swarms",
        "Tell me when a card's swarm finishes",
        "Tell me at every role handoff",
        "Cards running at once",
      ]) {
        expect(screen.queryByText(gone)).toBeNull();
      }
    });
  }

  it("choosing a page from the navigation takes the line away", async () => {
    const { user } = openSettings();
    const nav = await screen.findByRole("navigation");
    act(() => useUi.getState().openSettingsSection("swarm-templates"));
    await screen.findByText(RETIRED_NOTE);
    await user.click(within(nav).getByText("Editor and terminals"));
    await screen.findByRole("heading", { name: "Editor and terminals" });
    expect(screen.queryByText(RETIRED_NOTE)).toBeNull();
    // And back on AI and models by its own entry, nothing is said.
    await user.click(within(nav).getByText("AI and models"));
    await screen.findByRole("heading", { name: "AI and models" });
    expect(screen.queryByText(RETIRED_NOTE)).toBeNull();
  });

  it("a link to a live page says nothing about the retired ones", async () => {
    openSettings();
    await screen.findByRole("navigation");
    act(() => useUi.getState().openSettingsSection("builds-runs"));
    await screen.findByRole("heading", { name: "AI and models" });
    await waitFor(() => expect(screen.queryByText(RETIRED_NOTE)).toBeNull());
  });
});

describe("Claude and Codex after GH #175", () => {
  it("draws who writes up a discussion, and a press saves it", async () => {
    useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true } as never);
    const { user, tauri } = renderUi(<BuildsRunsPage scope="this-mac" />, { fixtures });
    const group = screen.getByRole("group", { name: "Who writes up a discussion" });
    expect(within(group).getByRole("button", { name: "Claude" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(within(group).getByRole("button", { name: "Codex" }));
    await waitFor(() =>
      expect(useSettings.getState().settings.behavior.discussionSynthesizer).toBe("codex"),
    );
    const calls = tauri.callsOf("settings_set");
    const last = calls[calls.length - 1].args.settings as Settings;
    expect(last.behavior.discussionSynthesizer).toBe("codex");
    // The shape it sends carries neither key #175 took out of it.
    expect("experimentalLayout" in last.behavior).toBe(false);
    expect("swarmArtifactRetentionDays" in last.behavior).toBe(false);
    // G4: nor the swarm keys; the backend keeps the ones it still reads.
    for (const key of ["advancedSwarms", "notifyOnSwarmDone", "notifySwarmRoleBoundary", "maxConcurrentCardSwarms"]) {
      expect(key in last.behavior).toBe(false);
    }
  });
});

// OB-14 (§13.2): a vendor that isn't installed is shown disabled with its
// reason — never hidden — and the page says reviews use separate sessions.
describe("Claude and Codex with one AI (OB-14)", () => {
  it("draws Codex disabled with why when only Claude is installed", async () => {
    useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true } as never);
    const row = (id: string, found: boolean) => ({
      id, name: id, required: false, found, path: found ? "/x" : null, version: found ? "1" : null,
      versionOk: found, detail: "", installCmd: "", docsUrl: "", reviewer: null,
    });
    useDoctor.setState({
      report: {
        tools: [row("claude", true), row("codex", false)],
        teamSkills: null, projectSkills: null, microphone: null, whisperModel: null,
        dictationShell: null, sharedDefinition: null, probeError: null, allRequiredOk: true, aiReady: true,
      } as DoctorReport,
    });
    renderUi(<BuildsRunsPage scope="this-mac" />, { fixtures });
    // 1.174.0 (DS4 round 0): one line, with the way to set the other up,
    // stands where the two buttons were.
    expect(screen.queryByRole("group", { name: "Who builds new cards" })).toBeNull();
    const whoRow = screen.getByText("Who builds new cards").closest(".ux-row") as HTMLElement;
    expect(
      within(whoRow).getByText("Codex isn't installed on this Mac. Reviews and discussions use separate Claude sessions."),
    ).toBeTruthy();
    expect(within(whoRow).getByRole("button", { name: "Install Codex" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Install Codex" })).toHaveLength(1);
    // 1.174.0 (DS4): one AI does both, and its Models row says the other isn't set up.
    expect(screen.getByText("New cards: Claude builds, Claude reviews.")).toBeTruthy();
    expect(screen.getByText("Not set up")).toBeTruthy();
    const writer = screen.getByRole("group", { name: "Who writes up a discussion" });
    expect((within(writer).getByRole("button", { name: "Codex — Codex isn't installed" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
