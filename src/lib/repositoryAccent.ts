/**
 * UX language card 2 (BOARDS.md §6 "Settings › Repository › General"): the
 * colours a workspace can carry, named so the choice never rests on seeing
 * the colour.
 *
 * GH #272: this is the one palette for the field. Settings › General and the
 * switcher's "Icon and colour" both draw these circles with the value they
 * store, and the chip paints that same value. The values are the light
 * accent presets (`--accent-*`), deep enough for the chip's white monogram.
 * Colours stored by the older pickers (the switcher's seven, General's first
 * four) are read as the preset nearest in hue, so a workspace set before is
 * shown chosen; a colour from anywhere else is "Custom colour".
 *
 * Pure, so node reads it.
 */

export type AccentId = "violet" | "cyan" | "magenta" | "sunset";

export interface AccentChoice {
  /** The token name, and the class the swatch is drawn with. */
  id: AccentId;
  name: string;
  value: string;
  /** What the circle is painted with: the value itself. */
  color: string;
}

const choice = (id: AccentId, name: string, value: string): AccentChoice => ({
  id,
  name,
  value,
  color: value,
});

export const ACCENT_CHOICES: AccentChoice[] = [
  choice("violet", "Violet", "#7c3aed"),
  choice("cyan", "Cyan", "#0e7490"),
  choice("magenta", "Magenta", "#be185d"),
  choice("sunset", "Sunset", "#d12953"),
];

/** What the older pickers stored, and the preset each now reads as. Lookup
 *  keys, never painted: the hex digits without their "#". */
export const LEGACY_ACCENTS: Record<string, AccentId> = {
  // Settings › General before GH #272.
  "8b5cf6": "violet",
  "22d3ee": "cyan",
  "f472b6": "magenta",
  ffa647: "sunset",
  // The switcher's icon picker before GH #272 (7c3aed is Violet itself).
  "2563eb": "cyan",
  "0d9488": "cyan",
  "16a34a": "cyan",
  ca8a04: "sunset",
  dc2626: "sunset",
  // QoL 1.168 (block 10): Sunset before it moved off the crash red.
  c0263e: "sunset",
  // 1.169.0: Sunset before it moved warmer and lighter, off Magenta.
  c2264f: "sunset",
  db2777: "magenta",
};

/** The preset a stored colour is, or reads as; null for none or a custom one. */
export function accentChoice(value: unknown): AccentChoice | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim().toLowerCase();
  const own = ACCENT_CHOICES.find((c) => c.value.toLowerCase() === v);
  if (own) return own;
  const legacy = LEGACY_ACCENTS[v.replace(/^#/, "")];
  return legacy ? ACCENT_CHOICES.find((c) => c.id === legacy) ?? null : null;
}

/** The chosen colour's name — never its hex. */
export function accentName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "None — the theme's own";
  return accentChoice(value)?.name ?? "Custom colour";
}

/** The colour to paint: a preset's own value, or a custom colour as stored. */
export function resolveAccent(value: string | null | undefined): string | null {
  if (!value || !value.trim()) return null;
  return accentChoice(value)?.value ?? value;
}
