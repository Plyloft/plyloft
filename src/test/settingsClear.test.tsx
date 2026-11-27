// QoL 1.168 G9, G11, G16: Claude and Codex offers the fix for a tool that
// isn't ready (Setup's AI step), its paired model and effort fields carry a
// caption each, and a repository page names the project it edits.
import { beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { SettingsApp } from "../components/SettingsApp";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { useDoctor } from "../store/doctorStore";
import { useSetup } from "../store/setupStore";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import type { DoctorReport, ToolStatus } from "../ipc";
import { act, renderUi, screen, tauri } from "./render";

function tool(id: string, found: boolean): ToolStatus {
  return {
    id,
    name: id,
    required: id === "git",
    found,
    path: found ? `/usr/bin/${id}` : null,
    version: null,
    versionOk: found,
    detail: "",
    installCmd: "",
    docsUrl: "",
  } as unknown as ToolStatus;
}

function report(codex: boolean): DoctorReport {
  return { tools: [tool("git", true), tool("claude", true), tool("codex", codex)] } as unknown as DoctorReport;
}

const FIX = {
  settings_get: () => DEFAULT_SETTINGS,
  settings_set: ({ settings }: Record<string, unknown>) => settings,
};

beforeEach(() => {
  tauri().allowUnhandled();
  act(() => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true } as never);
    useSetup.setState({ open: false, step: null });
    useWorkspaces.setState({
      loaded: true,
      activeId: "ws-1",
      workspaces: [
        { id: "ws-1", name: "notes-app", cwd: "/tmp/notes-app", createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null } as Workspace,
      ],
    });
  });
});

describe("clear Settings (QoL 1.168)", () => {
  it("Codex isn't installed: Install Codex opens Setup's AI step", async () => {
    act(() => useDoctor.setState({ report: report(false) }));
    const { user } = renderUi(<SettingsApp entry="claude-codex" />, { fixtures: FIX });
    // 1.174.0 (DS4 round 0): the line stands in Who builds new cards' row.
    expect(await screen.findByText(/^Codex isn't installed on this Mac\. /)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Install Codex" }));
    expect(useSetup.getState()).toMatchObject({ open: true, setupCase: "rerun", step: "ai" });
  });

  it("no fix when both are ready; model and effort are captioned", async () => {
    act(() => useDoctor.setState({ report: report(true) }));
    const { user } = renderUi(<SettingsApp entry="claude-codex" />, { fixtures: FIX });
    await screen.findByRole("heading", { level: 1, name: "AI and models" });
    expect(screen.queryByRole("button", { name: "Install Codex" })).toBeNull();
    // 1.174.0 (DS4, scene 7): the controls are on the AI's sub-page.
    await user.click(screen.getAllByRole("button", { name: "Change…" })[0]!);
    await screen.findByRole("heading", { level: 1, name: "Claude models" });
    const captions = [...document.querySelectorAll(".ux-caption")].map((n) => n.textContent);
    expect(captions.filter((c) => c === "Model").length).toBeGreaterThanOrEqual(4);
    expect(captions.filter((c) => c === "Effort").length).toBeGreaterThanOrEqual(2);
  });

  it("a repository page names its project; a This Mac page doesn't", async () => {
    const view = renderUi(<SettingsApp entry="build-release" />, { fixtures: FIX });
    const badge = await within(view.container).findByText("Cards · notes-app");
    expect(badge.closest(".ux-scope-badge")).not.toBeNull();
    view.unmount();
    renderUi(<SettingsApp entry="appearance" />, { fixtures: FIX });
    await screen.findByRole("heading", { level: 1, name: "Appearance" });
    expect(screen.queryByText(/· notes-app/)).toBeNull();
    expect(screen.getByText("Accent colour on this Mac")).toBeTruthy();
  });
});
