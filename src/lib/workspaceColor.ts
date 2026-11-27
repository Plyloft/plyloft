/**
 * v1.41.0: stable per-workspace accent color.
 *
 * The sidebar's accent dot used to fall back to a muted grey when no
 * `accentColor` was set on a workspace, which collapsed the identity
 * signal for every un-customized workspace into the same neutral. The
 * UX audit (card `mpfhmhzg`) flagged this as the #1 readability issue
 * after row separation. This module returns a stable, muted hue per
 * workspace name so default workspaces still carry identity color
 * without the user having to pick one.
 *
 * Hash strategy: djb2 → mod 360 for the HSL hue. Fixed `s=42%, l=66%`
 * keeps the palette muted enough to read on every existing theme
 * background (verified against light `#fafafa`, dark `#1a1a1a`, void
 * near-black, synthwave `#241544`, neon-tokyo). Stable per name —
 * rename-then-rename-back returns the same hue.
 *
 * GH #288: the lightness is 66% (was 58%) so the chip's dark ink clears
 * 4.5:1 on every hue; at 58% neither ink did on some of them.
 *
 * Pure function. Trivially unit-testable in Node (no DOM, no React).
 */

import { resolveAccent } from "./repositoryAccent.ts";

const FALLBACK_SATURATION = 42;
const FALLBACK_LIGHTNESS = 66;

/**
 * Return a CSS color string for a workspace's accent.
 *
 * - If `accentColor` is a non-empty string (e.g. `"#7c3aed"`), paint the
 *   preset it is (or, from an older picker, reads as — GH #272), or a
 *   custom colour as stored.
 * - Otherwise, derive a stable HSL hue from `name` via djb2 hash so
 *   the workspace still has identity color in the sidebar.
 */
export function workspaceAccentColor(
  accentColor: string | null | undefined,
  name: string,
): string {
  const picked = resolveAccent(accentColor);
  if (picked) return picked;
  const hue = djb2Hue(name);
  return `hsl(${hue}, ${FALLBACK_SATURATION}%, ${FALLBACK_LIGHTNESS}%)`;
}

function djb2Hue(s: string): number {
  // djb2 is a tiny, well-known string hash. We only need 9 bits of
  // entropy (360 hues) so the unsigned 32-bit wraparound is fine.
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    // `hash * 33 + char` — the canonical djb2 step.
    hash = (hash << 5) + hash + s.charCodeAt(i);
    // Coerce back to unsigned 32-bit so subsequent shifts stay sane.
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

// ── GH #288: the monogram's ink ─────────────────────────────────────────

type Rgb = [number, number, number];

/** The chip's two inks, as `--chip-ink-dark` / `--chip-ink-light` hold them
 *  in App.css (workspaceColor.test.ts keeps the two in step). */
export const CHIP_INKS: Record<"dark" | "light", Rgb> = {
  dark: [28, 28, 30],
  light: [255, 255, 255],
};

/** A colour the chip can be painted with — `#rgb`, `#rrggbb`, `rgb()` or
 *  `hsl()` — as 0–255 channels; null for anything else. */
export function parseColor(css: string): Rgb | null {
  const v = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(v);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(v);
  if (hsl) {
    const h = Number(hsl[1]) % 360;
    const s = Number(hsl[2]) / 100;
    const l = Number(hsl[3]) / 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
    };
    return [f(0), f(8), f(4)];
  }
  return null;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The ink a monogram takes on `color`: whichever of the two reads better —
 *  white on the presets, dark on the hashed hues. Light for a colour it
 *  cannot read. */
export function monogramInk(color: string): "dark" | "light" {
  const c = parseColor(color);
  if (!c) return "light";
  return contrastRatio(c, CHIP_INKS.dark) > contrastRatio(c, CHIP_INKS.light) ? "dark" : "light";
}
