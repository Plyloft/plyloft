import assert from "node:assert/strict";

import type { ShellEnvInfo } from "../ipc.ts";
import { decideCodexLaunch } from "./codexTileLaunch.ts";

function env(overrides: Partial<ShellEnvInfo> = {}): ShellEnvInfo {
  return {
    path: "/usr/bin",
    shell: "/bin/zsh",
    claudePath: "/usr/local/bin/claude",
    claudeVersion: "2.1.232",
    codexPath: "/usr/local/bin/codex",
    codexVersion: "0.151.0",
    codexHealthy: true,
    gitPath: "/usr/bin/git",
    gitVersion: "2.50.1",
    ghPath: null,
    ghVersion: null,
    supportsStreamJson: true,
    probeError: null,
    ...overrides,
  };
}

// No Codex, no action — the toolbar hides both buttons entirely.
for (const tile of ["codex", "codex-chat"] as const) {
  assert.deepEqual(decideCodexLaunch(tile, null), { kind: "unavailable" });
  assert.deepEqual(decideCodexLaunch(tile, env({ codexPath: null })), { kind: "unavailable" });
}

// v1.103.0 (D3): the health probe gates the structured session only.
// Opening an App Server that never answers leaves a box with nothing in it.
assert.deepEqual(decideCodexLaunch("codex-chat", env({ codexHealthy: false })), { kind: "broken" });
// ...while the CLI tile still opens: its PTY is what shows the crash, and
// that output is the fastest route to fixing the install.
assert.deepEqual(decideCodexLaunch("codex", env({ codexHealthy: false })), { kind: "open" });

// 1.176.0 R5: opening a tile carries no update errand at all — the backend
// runs the automatic update only while Codex is idle, never at a spawn.
for (const tile of ["codex", "codex-chat"] as const) {
  const decision = decideCodexLaunch(tile, env());
  assert.deepEqual(decision, { kind: "open" });
  assert.equal("checkUpdate" in decision, false);
}

console.log("codexTileLaunch.test.ts ✓");
