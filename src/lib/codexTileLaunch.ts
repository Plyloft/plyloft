import type { ShellEnvInfo } from "../ipc";

/**
 * What clicking a Codex button should do.
 *
 * 1.176.0 R5: opening a tile never starts an update any more. The backend
 * runs the automatic update only while Codex is idle
 * (`codex_auto_update.rs`); a tile that starts while one runs waits for it
 * in its own check, saying so (`codexStartWaitText`).
 *
 * v1.103.0 (D3): the two tiles gate differently. A `codex-chat` tile needs a
 * CLI that answers `--version`, because an App Server that never speaks
 * leaves an empty box with nothing to read. A `codex` tile only needs the
 * path: when the wrapper is broken, its PTY *shows* the crash, and that
 * output is the fastest route to a fix. A disabled button teaches nothing.
 */
export type CodexTileKind = "codex" | "codex-chat";

export type CodexLaunchDecision =
  | { kind: "unavailable" }
  | { kind: "broken" }
  | { kind: "open" };

export function decideCodexLaunch(tile: CodexTileKind, env: ShellEnvInfo | null): CodexLaunchDecision {
  if (!env?.codexPath) return { kind: "unavailable" };
  // A resolved path that doesn't run: the structured session would produce a
  // tile that dies instantly with nothing on screen to explain it.
  if (tile === "codex-chat" && !env.codexHealthy) return { kind: "broken" };
  return { kind: "open" };
}
