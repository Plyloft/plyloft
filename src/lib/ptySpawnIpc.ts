import { invoke } from "@tauri-apps/api/core";
import type { TryTargetArg } from "../ipc";

// The PTY spawn's backend calls (`commands::pty_spawn`, `cli_fresh.rs`),
// moved out of `ipc.ts` (1.176.0 R3, to make room under its cap) with R3's
// own beside them.

/** A tile that runs Claude or Codex, by its kind (`cli_fresh::tile_cli`). */
export type TileCli = "claude" | "codex";

export function ptySpawn(opts: {
  cmd: string;
  args?: string[];
  cwd?: string | null;
  workspaceId?: string | null;
  cols: number;
  rows: number;
  /** Try it (TI-2): this shell tile is the Try session of that card copy
   *  (`PORT`/`BROWSER=none` in its environment; never makes the card busy). */
  tryTarget?: TryTargetArg | null;
  /** 1.176.0 R3: a Claude or Codex tile says so, and the backend runs its own
   *  path for that CLI, checked on disk (`cmd` is then only a name). Never
   *  set for a shell, whatever it runs. */
  cli?: TileCli | null;
  /** 1.176.0 R7: the id the tile already listens under (a lowercase UUID,
   *  `pty_tile_id.rs`), so the first output and an instant exit reach it. */
  id?: string | null;
}) {
  return invoke<string>("pty_spawn", {
    cmd: opts.cmd,
    args: opts.args ?? [],
    cwd: opts.cwd ?? null,
    workspaceId: opts.workspaceId ?? null,
    cols: opts.cols,
    rows: opts.rows,
    tryTarget: opts.tryTarget ?? null,
    cli: opts.cli ?? null,
    id: opts.id ?? null,
  });
}

/** 1.176.0 R3: before a Claude or Codex tile spawns — its path checked on
 *  disk, looked for again once when it fails (the window is then sent the
 *  fresh snapshot). Rejects with the typed error `lib/cliUnavailable.ts`
 *  reads when the CLI isn't there even after that. */
export function cliFreshCheck(tool: TileCli) {
  return invoke<void>("cli_fresh_check", { tool });
}

/** 1.176.0 R7: a tile's CLI ended at once — does the tool start? The
 *  backend asks its `--version` again (`cli_fresh::cli_start_verdict`);
 *  only "fails" is a certain failure. */
export function cliStartVerdict(tool: TileCli) {
  return invoke<"starts" | "fails" | "unknown">("cli_start_verdict", { tool });
}
