// Unit tests for workspaceAccentColor (src/lib/workspaceColor.ts).
//
// Atelier has no JS test runner (see docs/PPVP.md Tier 3): this file is a
// self-contained, dependency-free test module — it type-checks under
// `tsc --noEmit` and runs standalone:
//
//     node --experimental-strip-types src/lib/workspaceColor.test.ts
//
// Exits non-zero on the first failed assertion. Same shape as
// `src/lib/attention.test.ts`. Migrating to vitest later is mechanical.

import { readFileSync } from "node:fs";
import { ACCENT_CHOICES } from "./repositoryAccent.ts";
import {
  CHIP_INKS,
  contrastRatio,
  monogramInk,
  parseColor,
  workspaceAccentColor,
} from "./workspaceColor.ts";

// --- minimal harness -------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];
let currentSuite = "";

function describe(name: string, fn: () => void): void {
  currentSuite = name;
  fn();
  currentSuite = "";
}

function it(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${currentSuite} > ${name}: ${(e as Error).message}`);
  }
}

function eq<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    throw new Error(
      msg ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function ne<T>(actual: T, expected: T, msg?: string): void {
  if (actual === expected) {
    throw new Error(
      msg ?? `expected NOT to equal ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function truthy(actual: unknown, msg?: string): void {
  if (!actual) {
    throw new Error(msg ?? `expected truthy, got ${JSON.stringify(actual)}`);
  }
}

// --- tests -----------------------------------------------------------------

describe("workspaceAccentColor", () => {
  it("paints the preset an explicit colour is, or a custom one verbatim", () => {
    eq(workspaceAccentColor("#7c3aed", "atelier"), "#7c3aed");
    // GH #272: an older picker's red reads as Sunset, and paints it.
    eq(workspaceAccentColor("#dc2626", "anything"), "#d12953");
    // QoL 1.168 (block 10): the Sunset stored before it moved reads as Sunset.
    eq(workspaceAccentColor("#c0263e", "anything"), "#d12953");
    eq(workspaceAccentColor("#c2264f", "anything"), "#d12953");
    eq(workspaceAccentColor("#123456", "anything"), "#123456");
  });

  it("treats empty / whitespace accent as un-set and falls back to hash", () => {
    truthy(workspaceAccentColor("", "atelier").startsWith("hsl("));
    truthy(workspaceAccentColor("   ", "atelier").startsWith("hsl("));
  });

  it("returns a stable hsl for an identical name across calls", () => {
    const a = workspaceAccentColor(null, "atelier");
    const b = workspaceAccentColor(null, "atelier");
    const c = workspaceAccentColor(undefined, "atelier");
    eq(a, b);
    eq(a, c);
    truthy(a.startsWith("hsl("));
  });

  it("produces different hues for different names", () => {
    const a = workspaceAccentColor(null, "atelier");
    const b = workspaceAccentColor(null, "claudeclaw");
    const c = workspaceAccentColor(null, "mbadv");
    ne(a, b);
    ne(a, c);
    ne(b, c);
  });

  it("returns the same color after rename-then-rename-back", () => {
    const original = workspaceAccentColor(null, "atelier");
    const renamed = workspaceAccentColor(null, "atelier-renamed");
    const restored = workspaceAccentColor(null, "atelier");
    ne(original, renamed);
    eq(original, restored);
  });

  it("keeps fixed saturation + lightness in the fallback output", () => {
    const out = workspaceAccentColor(null, "atelier");
    truthy(/^hsl\(\d+, 42%, 66%\)$/.test(out), `bad shape: ${out}`);
  });
});

// GH #288: the monogram is AA on every colour the chip is painted with.
describe("monogramInk", () => {
  it("reads at 4.5:1 or more on every preset and every hashed hue", () => {
    const colours = [
      ...ACCENT_CHOICES.map((c) => c.value),
      ...Array.from({ length: 360 }, (_, h) => `hsl(${h}, 42%, 66%)`),
    ];
    for (const c of colours) {
      const ink = CHIP_INKS[monogramInk(c)];
      const rgb = parseColor(c);
      truthy(rgb, `unparsed ${c}`);
      const ratio = contrastRatio(rgb!, ink);
      truthy(ratio >= 4.5, `${c}: ${monogramInk(c)} ink at ${ratio.toFixed(2)}:1`);
    }
  });

  it("takes dark ink on the hashed hues and white on the presets", () => {
    eq(monogramInk(workspaceAccentColor(null, "Climbr")), "dark");
    for (const c of ACCENT_CHOICES) eq(monogramInk(c.value), "light", c.name);
  });

  it("keeps App.css's chip inks in step with the ones it measures", () => {
    const css = readFileSync(new URL("../App.css", import.meta.url), "utf8");
    const hex = (name: string) =>
      new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(css)?.[1] ?? "";
    eq(JSON.stringify(parseColor(hex("chip-ink-dark"))), JSON.stringify(CHIP_INKS.dark));
    eq(JSON.stringify(parseColor(hex("chip-ink-light"))), JSON.stringify(CHIP_INKS.light));
  });
});

// --- summary ---------------------------------------------------------------

if (failed > 0) {
  console.error(`✗ ${failed} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
} else {
  console.log(`✓ ${passed} passed`);
}
