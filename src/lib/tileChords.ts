// QoL 1.168 (D8, M5): what App's key handler does with a tile chord
// (⌘⇧] ⌘⇧[ ⌘⇧Enter ⌘⇧W ⌘⇧R): whether it acts, and whether the key is
// swallowed. Pure, so node can test it.

import type { ShortcutId } from "./shortcuts.ts";

export const TILE_CHORDS: ReadonlySet<ShortcutId> = new Set<ShortcutId>([
  "nextTile",
  "previousTile",
  "nextTilePage",
  "previousTilePage",
  "expandTile",
  "closeTile",
  "resume",
]);

export interface TileChordWhere {
  /** Terminals is on screen, with no sheet or Settings over it. */
  onTerminals: boolean;
  windows: boolean;
  /** Focus is in a terminal (a tile's, or a card session's). */
  inTerminal: boolean;
}

/**
 * - On Terminals each one acts (⌘⇧R anywhere).
 * - ⌘⇧W off Terminals does nothing and is still swallowed, as ⌘W is, so it
 *   never closes the window — except, on Windows, inside a terminal, whose
 *   shell gets it.
 * - The others, unanswered, are not swallowed: on Windows a card's terminal
 *   gets them, as a shell gets any key Plyloft does not answer.
 */
export function tileChordAction(id: ShortcutId, where: TileChordWhere): { act: boolean; swallow: boolean } {
  if (id === "resume") return { act: true, swallow: true };
  if (where.onTerminals) return { act: true, swallow: true };
  if (id === "closeTile") return { act: false, swallow: !(where.windows && where.inTerminal) };
  return { act: false, swallow: false };
}

/**
 * 1.179.0 Compare with two pairs: the pair ⌘⇧Y (Ctrl+Shift+Y) acts on, from
 * the place the keyboard is in (`focusPlace`: the focused tile's place, or
 * the bar's; null anywhere else). One pair: its one bar (`""`), from
 * anywhere in Terminals, as before. Two: only the pair the keyboard is in;
 * elsewhere nothing, and the key is not Plyloft's — on Windows a terminal's
 * program gets it, as any key Plyloft does not answer.
 */
export function comparePassTarget(
  mode: "single" | "two",
  focusPlace: string | null,
  places: readonly string[],
): { place: string | null; swallow: boolean } {
  if (mode === "single") return { place: "", swallow: true };
  const place = focusPlace !== null && places.includes(focusPlace) ? focusPlace : null;
  return { place, swallow: place !== null };
}
