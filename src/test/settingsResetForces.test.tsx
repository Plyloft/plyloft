// 1.176.3 (owner, 2026-11-23): a reset puts back every setting it covers,
// whatever wrote it — Program folders Plyloft wrote after this window last
// heard included. A reset is its own call, `settings_reset`, naming the paths
// it covers; what was stored before comes back from the backend, and a page's
// Undo puts that back. The real store, queue and hook; the IPC is a stub.
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import type { Settings } from "../lib/settingsShape";
import { pageResetPaths, resetAllPaths } from "../lib/settingsFields";
import { useMacSettings } from "../components/settings/useMacSettings";
import { ResetThisMac } from "../components/settings/ResetPage";
import { latestToast } from "../store/toastStore";
import { renderUi, screen, tauri, waitFor, within } from "./render";

type ResetArgs = { settings: Settings; base: Settings; paths: string[] };

const withFolders = (s: Settings, folders: string | null): Settings => ({
  ...s,
  shell: { ...s.shell, pathOverride: folders },
});

describe("a page's reset (1.176.3)", () => {
  it("names its paths, clears Program folders Plyloft wrote, and its Undo puts them back", async () => {
    // The window's copy: Program folders empty, a tab size of 8.
    const copy: Settings = { ...DEFAULT_SETTINGS, editor: { ...DEFAULT_SETTINGS.editor, tabSize: 8 } };
    // The backend's: Repair has since written Program folders.
    const stored = withFolders(copy, "/from/repair");
    const saved: Settings = { ...withFolders(copy, null), editor: DEFAULT_SETTINGS.editor };
    tauri().fixture("settings_reset", () => ({ before: stored, saved }));
    tauri().fixture("settings_set", ({ settings }: Record<string, unknown>) => settings);
    useSettings.setState({ settings: copy, loaded: true } as never);

    const { result } = renderHook(() => useMacSettings());
    await act(async () => {
      await result.current.reset("editor-terminals");
    });

    const [call] = tauri().callsOf("settings_reset").map((c) => c.args as unknown as ResetArgs);
    expect(call.paths).toEqual(pageResetPaths("editor-terminals"));
    expect(call.paths).toContain("shell.pathOverride");
    expect(call.base).toBe(copy);
    expect(useSettings.getState().settings.shell.pathOverride).toBeNull();

    // The page moved (the backend's before differs), so it offers Undo.
    const toast = latestToast();
    expect(toast?.title).toBe("This page is back to how Plyloft ships, on this Mac.");
    await act(async () => {
      toast?.action?.onClick();
    });
    await waitFor(() => expect(tauri().callsOf("settings_set")).toHaveLength(1));
    const undo = tauri().callsOf("settings_set")[0].args as unknown as { settings: Settings };
    expect(undo.settings.shell.pathOverride).toBe("/from/repair");
    expect(undo.settings.editor.tabSize).toBe(8);
  });

  it("its Undo puts back what was stored, not a field's read replayed (review M1)", async () => {
    // Who builds new cards reads `lastBuilderVendor ?? builderVendor`, and
    // its write clears `lastBuilderVendor`: replaying "codex" would make
    // `builderVendor` codex for every card with no pick of its own.
    const copy: Settings = {
      ...DEFAULT_SETTINGS,
      behavior: { ...DEFAULT_SETTINGS.behavior, builderVendor: "claude", lastBuilderVendor: "codex" },
    };
    const saved: Settings = {
      ...copy,
      behavior: { ...copy.behavior, builderVendor: "claude", lastBuilderVendor: null },
    };
    tauri().fixture("settings_reset", () => ({ before: copy, saved }));
    tauri().fixture("settings_set", ({ settings }: Record<string, unknown>) => settings);
    useSettings.setState({ settings: copy, loaded: true } as never);
    const { result } = renderHook(() => useMacSettings());
    await act(async () => {
      await result.current.reset("claude-codex");
    });
    const toast = latestToast();
    expect(toast?.title).toBe("This page is back to how Plyloft ships, on this Mac.");
    await act(async () => {
      toast?.action?.onClick();
    });
    await waitFor(() => expect(tauri().callsOf("settings_set")).toHaveLength(1));
    const undo = tauri().callsOf("settings_set")[0].args as unknown as { settings: Settings };
    expect(undo.settings.behavior.builderVendor).toBe("claude");
    expect(undo.settings.behavior.lastBuilderVendor).toBe("codex");
  });

  it("says nothing changed only when the backend's own copy was already the defaults", async () => {
    tauri().fixture("settings_reset", () => ({ before: DEFAULT_SETTINGS, saved: DEFAULT_SETTINGS }));
    useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true } as never);
    const { result } = renderHook(() => useMacSettings());
    await act(async () => {
      await result.current.reset("editor-terminals");
    });
    // Sent even though this window's copy already read as the defaults.
    expect(tauri().callsOf("settings_reset")).toHaveLength(1);
    expect(latestToast()?.title).toBe("This page is already how Plyloft ships. Nothing was changed.");
  });
});

describe("Reset all settings on this Mac (1.176.3)", () => {
  it("names every block it puts back", async () => {
    tauri().fixture("settings_reset", ({ settings }: Record<string, unknown>) => ({
      before: withFolders(DEFAULT_SETTINGS, "/from/repair"),
      saved: settings,
    }));
    useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true } as never);
    const { user } = renderUi(<ResetThisMac />);
    await user.click(screen.getByRole("button", { name: "Reset" }));
    const sheet = screen.getByRole("dialog", { name: "Reset every setting on this Mac?" });
    await user.click(within(sheet).getByRole("button", { name: "Reset this Mac" }));
    await waitFor(() => expect(tauri().callsOf("settings_reset")).toHaveLength(1));
    const call = tauri().callsOf("settings_reset")[0].args as unknown as ResetArgs;
    expect([...call.paths].sort()).toEqual([...resetAllPaths()].sort());
    expect(call.paths).toContain("shell");
    expect(tauri().callsOf("settings_set")).toHaveLength(0);
  });
});
