import type { CliTool } from "./cliHealthIpc.ts";

/** The Diagnostics row of Claude Code or Codex (`tool:claude`, `tool:codex`),
 *  else null: Git, the GitHub command and the rest keep their own steps. */
export function aiToolOfRow(rowId: string): CliTool | null {
  if (rowId === "tool:claude") return "claude";
  if (rowId === "tool:codex") return "codex";
  return null;
}

/** 1.176.0 seams: the words beside a row whose Update would be refused. */
export const UPDATE_BLOCKED_HINT = "Its updater can't change its own folders, so Update can't work: Repair puts that right.";

/**
 * 1.176.0 seams: a Claude Code or Codex row that offers Update while the
 * copy Plyloft runs can't be updated by its own updater (the quick repair
 * read's `updateBlocked`, the same test Setup's Update refuses by) offers
 * Repair instead, and says why. Any other row comes back as it was.
 */
export function repairWhenUpdateBlocked<
  R extends { id: string; hint: string; fix: { kind: string; action?: string } },
>(row: R, blocked: Partial<Record<CliTool, boolean>>): R {
  const tool = aiToolOfRow(row.id);
  if (!tool || !blocked[tool] || row.fix.kind !== "person" || row.fix.action !== "Update") return row;
  return { ...row, hint: `${row.hint} ${UPDATE_BLOCKED_HINT}`, fix: { ...row.fix, action: "Repair" } };
}
