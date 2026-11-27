// 1.176.1: a checked free-text setting (the shared `useCheckedField` and
// `CheckNotice`), through the Tile shell row, and a saved broken value
// reaching Diagnostics. The real settings store and confirm sheet;
// `setting_check` scripted as the backend reads each value
// (`setting_check.rs`, tested there on a fake disk).
import { describe, expect, it } from "vitest";
import { TileShellGroup } from "../components/settings/ThisMacPages";
import { FoundRow } from "../components/ux";
import { DiagnosticsPage } from "../components/settings/DiagnosticsPage";
import { useMacSettings } from "../components/settings/useMacSettings";
import type { Reading } from "../lib/settingCheck";
import type { DoctorReport } from "../ipc";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { act, renderUi, screen, tauri, waitFor } from "./render";
import { resetSettingProblemsForTests, settingProblemsStore, watchSettingProblems } from "../store/settingProblemsStore";

const ok = (value: string, resolved: string): Reading => ({
  kind: "tileShell",
  windows: false,
  level: "ok",
  findings: [],
  resolved,
  saveAs: value,
  fix: null,
  broken: false,
});

const READINGS: Record<string, Reading> = {
  "/bin/zsh": ok("/bin/zsh", "/bin/zsh"),
  zsh: ok("zsh", "/bin/zsh"),
  "zsh -i": {
    ...ok("zsh -i", ""),
    level: "blocked",
    findings: [{ kind: "hasArguments", program: "zsh" }],
    resolved: null,
    saveAs: null,
    fix: "zsh",
    broken: true,
  },
  "~/bin/zsh": {
    ...ok("/Users/me/bin/zsh", "/Users/me/bin/zsh"),
    level: "hint",
    findings: [{ kind: "tilde", written: "/Users/me/bin/zsh" }],
    fix: "/Users/me/bin/zsh",
    broken: true,
  },
  "/Users/me/bin/zsh": ok("/Users/me/bin/zsh", "/Users/me/bin/zsh"),
  "/opt/homebrew/bin": {
    ...ok("", ""),
    level: "blocked",
    findings: [{ kind: "isFolder", path: "/opt/homebrew/bin" }],
    resolved: null,
    saveAs: null,
    broken: true,
  },
  "/Volumes/Tools/zsh": {
    ...ok("/Volumes/Tools/zsh", ""),
    level: "confirm",
    findings: [{ kind: "diskAbsent", disk: "/Volumes/Tools" }],
    resolved: null,
    broken: true,
  },
};

function load(tileShell: string | null) {
  tauri().fixture("settings_set", ({ settings }: Record<string, unknown>) => settings);
  tauri().fixture("setting_check", ({ value }: Record<string, unknown>) => {
    const r = READINGS[String(value)];
    if (!r) throw new Error(`no reading for ${String(value)}`);
    return r;
  });
  tauri().fixture("dependency_doctor", () => null);
  act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, shell: { ...DEFAULT_SETTINGS.shell, tileShell } }, loaded: true }));
}

function Host() {
  const mac = useMacSettings();
  return <TileShellGroup mac={mac} loginShell="/bin/zsh" onSaved={() => {}} />;
}

const saved = () => useSettings.getState().settings.shell.tileShell;
const box = () => screen.getByRole("textbox", { name: "Tile shell" }) as HTMLInputElement;

async function enter(user: ReturnType<typeof renderUi>["user"], value: string) {
  await user.click(box());
  await user.clear(box());
  await user.paste(value);
  await user.keyboard("{Enter}");
}

describe("a checked setting: the Tile shell", () => {
  it("a good value is saved and the line says what runs", async () => {
    load(null);
    const { user } = renderUi(<Host />, { withToasts: true });
    await enter(user, "/bin/zsh");
    await waitFor(() => expect(saved()).toBe("/bin/zsh"));
    expect(await screen.findByText("New shell tiles run /bin/zsh.")).toBeTruthy();
  });

  it("a ~ is written out on save, and the field says what was saved", async () => {
    load(null);
    const { user } = renderUi(<Host />, { withToasts: true });
    await enter(user, "~/bin/zsh");
    await waitFor(() => expect(saved()).toBe("/Users/me/bin/zsh"));
    expect(await screen.findByText("Saved as /Users/me/bin/zsh.")).toBeTruthy();
    expect(box().value).toBe("/Users/me/bin/zsh");
  });

  it("walk 3: after the toast's Undo, the focus is back on the field it restored", async () => {
    load("/bin/zsh");
    const { user } = renderUi(<Host />, { withToasts: true });
    await enter(user, "zsh");
    await waitFor(() => expect(saved()).toBe("zsh"));
    await new Promise((r) => setTimeout(r, 80));
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(saved()).toBe("/bin/zsh"));
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it("is read on save, never per keystroke", async () => {
    load(null);
    const { user } = renderUi(<Host />, { withToasts: true });
    await user.click(box());
    await user.paste("/bin/zsh");
    expect(tauri().callsOf("setting_check")).toHaveLength(0);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(saved()).toBe("/bin/zsh"));
  });

  it("zsh -i is not saved; Use zsh is one press, and the focus stays on the field", async () => {
    load(null);
    const { user } = renderUi(<Host />, { withToasts: true });
    await enter(user, "zsh -i");
    expect(await screen.findByText("Plyloft didn't save this.")).toBeTruthy();
    expect(saved()).toBeNull();
    expect(tauri().callsOf("settings_set")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Use zsh" }));
    await waitFor(() => expect(saved()).toBe("zsh"));
    await waitFor(() => expect(document.activeElement).toBe(box()));
    expect(screen.queryByText("Plyloft didn't save this.")).toBeNull();
  });

  it("Keep what was there puts back what is saved, and saves nothing", async () => {
    load("/bin/zsh");
    const { user } = renderUi(<Host />, { withToasts: true });
    await enter(user, "/opt/homebrew/bin");
    expect(await screen.findByText(/\/opt\/homebrew\/bin is a folder, not a program\./)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep what was there" }));
    expect(box().value).toBe("/bin/zsh");
    expect(saved()).toBe("/bin/zsh");
    expect(tauri().callsOf("settings_set")).toHaveLength(0);
  });

  it("a disk that isn't connected is asked first, naming what happens", async () => {
    load(null);
    const { user } = renderUi(<Host />, { withToasts: true });
    await enter(user, "/Volumes/Tools/zsh");
    const sheet = await screen.findByRole("dialog", { name: "Save this tile shell?" });
    // 1.176.1 walk 2: one column; the safe answer is the one filled primary.
    expect(sheet.querySelectorAll(".cbtn--accent")).toHaveLength(1);
    expect(sheet.querySelector(".cbtn--accent")?.textContent).toBe("Keep what was there");
    expect(sheet.querySelector(".ux-confirm-stack")).toBeTruthy();
    expect(sheet.textContent).toMatch(/the disk Tools, which isn't connected\. New shell tiles won't start until it is connected again\./);
    expect(saved()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save it anyway" }));
    await waitFor(() => expect(saved()).toBe("/Volumes/Tools/zsh"));
  });

  it("a saved broken value is reported when the page opens, never changed without a press", async () => {
    load("zsh -i");
    const { user } = renderUi(<Host />, { withToasts: true });
    expect(await screen.findByText("This tile shell can't work as written.")).toBeTruthy();
    expect(saved()).toBe("zsh -i");
    // Walk 4: the notice is marked as its field's, so a toast keeps off both.
    await waitFor(() => expect(document.querySelector(`[data-notice-for="${box().id}"]`)).toBeTruthy());
    expect(tauri().callsOf("settings_set")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Use your login shell" }));
    await waitFor(() => expect(saved()).toBeNull());
  });
});

function report(): DoctorReport {
  return {
    tools: [],
    teamSkills: null,
    projectSkills: null,
    microphone: null,
    whisperModel: null,
    dictationShell: null,
    sharedDefinition: null,
    probeError: null,
    allRequiredOk: true,
    aiReady: true,
    gitIdentity: null,
  };
}

describe("focus: a Fix landing and Tab reach the field and its offers", () => {
  function Landed({ focus }: { focus: boolean }) {
    const mac = useMacSettings();
    return (
      <FoundRow token="Tile shell" nonce={1} marked focus={focus}>
        <TileShellGroup mac={mac} loginShell="/bin/zsh" onSaved={() => {}} />
      </FoundRow>
    );
  }

  it("a landing from Open the setting focuses the field", async () => {
    load("/bin/zsh");
    renderUi(<Landed focus />, { withToasts: true });
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it("with a notice showing, the landing focuses its first offer", async () => {
    load("zsh -i");
    renderUi(<Landed focus />, { withToasts: true });
    await screen.findByText("This tile shell can't work as written.");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Use zsh" })));
  });

  it("a search landing leaves the focus where it is", async () => {
    load("/bin/zsh");
    renderUi(<Landed focus={false} />, { withToasts: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(document.activeElement).not.toBe(box());
  });

  it("Tab from the field goes to the notice's first offer, also when the Tab's save raised it", async () => {
    load("zsh -i");
    const { user } = renderUi(<Host />, { withToasts: true });
    await screen.findByText("This tile shell can't work as written.");
    await user.click(box());
    await user.tab();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Use zsh" })));

    load(null);
  });

  it("Tab after typing a refused value lands on its first offer", async () => {
    load(null);
    const { user } = renderUi(<Host />, { withToasts: true });
    await user.click(box());
    await user.paste("zsh -i");
    await user.tab();
    await screen.findByText("Plyloft didn't save this.");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Use zsh" })));
  });
});

describe("Diagnostics names a saved setting that can't work", () => {
  it("a row with the reason, and a button that opens the field", async () => {
    load("zsh -i");
    const { user } = renderUi(<DiagnosticsPage scope="this-mac" />, {
      fixtures: { dependency_doctor: () => report(), build_cache_status: () => null },
    });
    expect(await screen.findByText("Settings that can't work as written")).toBeTruthy();
    expect(screen.getByText(/It has options after the program\./)).toBeTruthy();
    const { useUi } = await import("../store/uiStore");
    const opened: unknown[] = [];
    const real = useUi.getState().openSettingsSection;
    act(() => useUi.setState({ openSettingsSection: (...args: unknown[]) => void opened.push(args) } as never));
    await user.click(screen.getByRole("button", { name: "Open the setting" }));
    expect(opened).toEqual([["editor-terminals", { row: "Tile shell", focus: true }]]);
    act(() => useUi.setState({ openSettingsSection: real }));
    expect(saved()).toBe("zsh -i");
  });

  it("no row while every saved setting works", async () => {
    load("/bin/zsh");
    renderUi(<DiagnosticsPage scope="this-mac" />, {
      fixtures: { dependency_doctor: () => report(), build_cache_status: () => null },
    });
    await waitFor(() => expect(tauri().callsOf("setting_check").length).toBeGreaterThan(0));
    expect(screen.queryByText("Settings that can't work as written")).toBeNull();
  });
});

describe("the sidebar's list of settings that can't work", () => {
  it("holds only the certain failures, and reads again when the setting is saved", async () => {
    load("zsh -i");
    resetSettingProblemsForTests();
    watchSettingProblems();
    await waitFor(() => expect(settingProblemsStore.getState().problems.map((p) => p.needsYou)).toEqual(["Tile shell can't start"]));
    const before = tauri().callsOf("setting_check").length;
    act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, shell: { ...DEFAULT_SETTINGS.shell, tileShell: "/bin/zsh" } } }));
    await waitFor(() => expect(settingProblemsStore.getState().problems).toEqual([]));
    expect(tauri().callsOf("setting_check").length).toBe(before + 1);
    resetSettingProblemsForTests();
  });
});
