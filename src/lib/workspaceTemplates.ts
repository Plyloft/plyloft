/**
 * Tile-layout presets — optional sets of sessions opened inside an existing
 * workspace. Tiles are session-only and never resurrected across launches.
 */

export type TileSeedKind = "shell" | "claude";

export type TileSeed = {
  kind: TileSeedKind;
};

export type WorkspaceTemplate = {
  id: string;
  label: string;
  description?: string;
  tiles: TileSeed[];
};

const claudeN = (n: number): TileSeed[] => Array.from({ length: n }, () => ({ kind: "claude" as const }));
const shellN = (n: number): TileSeed[] => Array.from({ length: n }, () => ({ kind: "shell" as const }));

// GH #326: named in words — "1 shell and 3 Claude sessions", not
// "1 sh + 3 claude" — and described by what opens.
export const WORKSPACE_TEMPLATES: ReadonlyArray<WorkspaceTemplate> = [
  { id: "empty",          label: "Empty",                          description: "No sessions. Start one later from New.",       tiles: [] },
  { id: "shell-1",        label: "1 shell",                        description: "One login shell.",                              tiles: shellN(1) },
  { id: "shell-2",        label: "2 shells",                       description: "Two shells side by side.",                      tiles: shellN(2) },
  { id: "claude-1",       label: "1 Claude session",               description: "One Claude session.",                           tiles: claudeN(1) },
  { id: "claude-2",       label: "2 Claude sessions",              description: "Two Claude sessions side by side.",             tiles: claudeN(2) },
  { id: "claude-4",       label: "4 Claude sessions",              description: "Four Claude sessions in a grid.",               tiles: claudeN(4) },
  { id: "shell-claude-3", label: "1 shell and 3 Claude sessions",  description: "A shell to drive and three Claude sessions.",   tiles: [...shellN(1), ...claudeN(3)] },
  { id: "claude-6",       label: "6 Claude sessions",              description: "Six Claude sessions for work split six ways.",  tiles: claudeN(6) },
  { id: "claude-8",       label: "8 Claude sessions",              description: "Eight Claude sessions at once.",                tiles: claudeN(8) },
  { id: "shell-claude-6", label: "2 shells and 6 Claude sessions", description: "Two shells and six Claude sessions.",           tiles: [...shellN(2), ...claudeN(6)] },
];

export function findTemplate(id: string): WorkspaceTemplate | null {
  return WORKSPACE_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** Count tiles in a template that require claude (used for the "claude unavailable" warning). */
export function countClaudeTiles(template: WorkspaceTemplate): number {
  return template.tiles.filter((t) => t.kind === "claude").length;
}
