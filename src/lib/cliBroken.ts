// 1.176.0 R7: a CLI that is installed but certainly doesn't start, read from
// the doctor report, and which of them the sidebar names ("Codex doesn't
// start · Repair"). Pure (node runs it: `src/lib/cliBroken.test.ts`).
import type { DoctorReport, ToolStatus } from "../ipc.ts";
import type { TileCli } from "./ptySpawnIpc.ts";

/**
 * Found, and its `--version` failed — R3's "failure", never its "didn't
 * answer in time". The report's own fields say it: Codex's `versionOk` is
 * `codex_healthy` (a slow answer counts as starting); Claude's `versionOk`
 * is "stream-json, or a version that didn't answer in time", so a Claude
 * found with no version and not ok is one whose `--version` failed
 * (`doctor.rs`, the `claude_starts` row).
 */
export function toolDoesNotStart(row: Pick<ToolStatus, "id" | "found" | "version" | "versionOk"> | null | undefined): boolean {
  // Strict: a row that says nothing (a partial one) is not a failure.
  if (!row || row.found !== true) return false;
  if (row.id === "codex") return row.versionOk === false;
  if (row.id === "claude") return row.version === null && row.versionOk === false;
  return false;
}

export interface BrokenCliInput {
  report: DoctorReport | null;
  /** The person's AI (Setup's choice, `behavior.builderVendor`). */
  chosen: TileCli | null | undefined;
  /** Kinds of the tiles open now (any workspace). */
  tileKinds: readonly string[];
  /** Tools a tile found gone even after looking again (`startFailed` "gone"). */
  gone: readonly TileCli[];
  /** R5's automatic Codex update is under way: Codex may not start meanwhile. */
  codexUpdating: boolean;
}

/**
 * The tools the sidebar says don't start. Only once the doctor has answered
 * (never during launch), only for a tool the person uses — their chosen AI,
 * or one they have a tile of — and never for Codex while its own update
 * runs. A tool the report finds and that starts is never named, whatever a
 * tile said before: the row goes by itself at the next read (the doctor
 * reads again on `shell-env://changed`).
 */
export function brokenClis(input: BrokenCliInput): TileCli[] {
  const { report } = input;
  if (!report) return [];
  const out: TileCli[] = [];
  for (const tool of ["claude", "codex"] as const) {
    if (tool === "codex" && input.codexUpdating) continue;
    const used =
      input.chosen === tool ||
      input.tileKinds.some((k) => k === tool || (tool === "codex" && k === "codex-chat"));
    if (!used) continue;
    const row = report.tools.find((t) => t.id === tool);
    const broken = toolDoesNotStart(row) || (input.gone.includes(tool) && !!row && !row.found);
    if (broken) out.push(tool);
  }
  return out;
}

/** The sidebar row's words. */
export function brokenCliRowText(tool: TileCli): string {
  return `${tool === "claude" ? "Claude Code" : "Codex"} doesn't start`;
}
