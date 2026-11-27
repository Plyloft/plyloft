// QoL 1.168 (D3): what ⌘T opens — Settings › Terminals › What a new tile
// opens. Pure, so node can test it.
//
// `newTileKind` holds the choice (Codex included); `defaultNewPaneKind`, the
// field 1.167 and earlier read, keeps "shell" or "claude" beside it, so an
// older Plyloft on the same settings file still reads it (an unknown value
// there would make it set the whole file aside).

export type NewTileKind = "shell" | "claude" | "codex";

export interface TerminalsChoice {
  defaultNewPaneKind: "shell" | "claude";
  newTileKind?: NewTileKind | null;
}

/** The kind the setting chooses. */
export function chosenNewTileKind(t: TerminalsChoice): NewTileKind {
  const k = t.newTileKind;
  if (k === "shell" || k === "claude" || k === "codex") return k;
  return t.defaultNewPaneKind === "claude" ? "claude" : "shell";
}

/** What ⌘T opens on this computer: the chosen kind when it is installed,
 *  else a shell — the key always opens something. */
export function newTileKindFor(t: TerminalsChoice, installed: { claude: boolean; codex: boolean }): NewTileKind {
  const k = chosenNewTileKind(t);
  if (k === "claude" && !installed.claude) return "shell";
  if (k === "codex" && !installed.codex) return "shell";
  return k;
}

/** The pair a choice writes: what an older Plyloft reads, and the new
 *  field only for Codex, which that one cannot hold (cleared otherwise). */
export function writeNewTileKind(k: NewTileKind): TerminalsChoice {
  return { newTileKind: k === "codex" ? "codex" : null, defaultNewPaneKind: k === "claude" ? "claude" : "shell" };
}
