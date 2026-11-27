// 1.176.0 R5: opening a Codex tile no longer starts an update — the backend
// runs it while Codex is idle — and the window follows the update's events:
// the toolbar's "updating" state (which a tile's start reads to say why it
// waits) and the one notice the backend asks for.
import { afterEach, describe, expect, it } from "vitest";
import type { ShellEnvInfo } from "../ipc";
import type { CodexUpdateDone } from "../lib/codexUpdateIpc";
import { startCodexUpdateSubscription } from "../lib/codexUpdate";
import { useDoctor } from "../store/doctorStore";
import { openCodexTile } from "../store/openCodexTile";
import { useToasts } from "../store/toastStore";
import { tauri } from "./tauri";

const env = {
  path: "/usr/bin",
  shell: "/bin/zsh",
  claudePath: null,
  claudeVersion: null,
  codexPath: "/Users/u/.local/bin/codex",
  codexVersion: "0.170.0",
  codexHealthy: true,
  gitPath: "/usr/bin/git",
  gitVersion: "2.50.1",
  ghPath: null,
  ghVersion: null,
  supportsStreamJson: false,
  probeError: null,
} as ShellEnvInfo;

afterEach(() => {
  useDoctor.setState({ codexUpdating: false });
});

describe("automatic Codex update", () => {
  it("opening a Codex tile, even with no attempt ever kept, starts no update", () => {
    localStorage.removeItem("atelier:codex-update:last-at");
    const tile = openCodexTile("ws1", "/tmp/project", env, "codex");
    expect(tile).not.toBeNull();
    const chat = openCodexTile("ws1", "/tmp/project", env, "codex-chat");
    expect(chat).not.toBeNull();
    expect(tauri().callsOf("codex_update")).toHaveLength(0);
    expect(useToasts.getState().toasts.map((t) => t.title)).not.toContain("Updating Codex in the background");
  });

  it("follows the backend's update and shows the notice it asks for", async () => {
    localStorage.setItem("atelier:codex-update:last-at", "1700000000000");
    startCodexUpdateSubscription();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The window's old record of the last attempt is dropped.
    expect(localStorage.getItem("atelier:codex-update:last-at")).toBeNull();

    tauri().emit("codex-update://state", { running: true });
    expect(useDoctor.getState().codexUpdating).toBe(true);

    const done: CodexUpdateDone = {
      outcome: "still-on-old-version",
      cause: "network",
      causePath: null,
      versionBefore: "0.170.0",
      versionAfter: "0.170.0",
      exitCode: 6,
      starts: true,
      notice: "still-works",
      command: "codex update",
      tail: ["curl: (6) Could not resolve host: chatgpt.com"],
    };
    tauri().emit("codex-update://state", { running: false });
    tauri().emit("codex-update://done", done);
    expect(useDoctor.getState().codexUpdating).toBe(false);
    const shown = useToasts.getState().toasts.slice(-1)[0];
    expect(shown?.title).toBe("Codex wasn't updated");
    expect(shown?.kind).toBe("warn");
    expect(shown?.action?.label).toBe("Open Diagnostics");

    // Said once: the backend sends no notice for the same failure again.
    const before = useToasts.getState().toasts.length;
    tauri().emit("codex-update://done", { ...done, notice: null });
    expect(useToasts.getState().toasts.length).toBe(before);
  });
});
