// 1.176.0 R3: the backend's "this CLI isn't there, even after looking
// again" (`cli_fresh::unavailable`), read by its shape so a later card can
// put a Repair button beside it. Pure: node runs it
// (`src/lib/cliUnavailable.test.ts`).
import type { TileCli } from "./ptySpawnIpc.ts";

export const CLI_UNAVAILABLE_PREFIX = "PLY_CLI_UNAVAILABLE_V1:";

export interface CliUnavailable {
  tool: TileCli;
  /** Where the snapshot had it before the look, if anywhere. */
  was: string | null;
  /** The backend's own words, after the shape (the raw text to show). */
  message: string;
}

export function decodeCliUnavailable(error: unknown): CliUnavailable | null {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (!raw.startsWith(CLI_UNAVAILABLE_PREFIX)) return null;
  const rest = raw.slice(CLI_UNAVAILABLE_PREFIX.length);
  const newline = rest.indexOf("\n");
  const json = newline < 0 ? rest : rest.slice(0, newline);
  try {
    const parsed = JSON.parse(json) as { tool?: unknown; was?: unknown };
    if (parsed.tool !== "claude" && parsed.tool !== "codex") return null;
    if (parsed.was != null && typeof parsed.was !== "string") return null;
    return {
      tool: parsed.tool,
      was: parsed.was ?? null,
      message: newline < 0 ? "" : rest.slice(newline + 1),
    };
  } catch {
    return null;
  }
}
