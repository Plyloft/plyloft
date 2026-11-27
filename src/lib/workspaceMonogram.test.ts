// Unit tests for workspaceMonogram (src/lib/workspaceMonogram.ts).
//
// Same self-contained harness as workspaceColor.test.ts. Run with:
//
//     node --experimental-strip-types src/lib/workspaceMonogram.test.ts

import { workspaceMonogram } from "./workspaceMonogram.ts";

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

describe("workspaceMonogram", () => {
  it("single-segment names yield first letter uppercased", () => {
    eq(workspaceMonogram("atelier"), "A");
    eq(workspaceMonogram("supercalifragilistic"), "S");
  });

  it("hyphen/underscore/dot splits to the first segment's initial", () => {
    eq(workspaceMonogram("recon-fork"), "R");
    eq(workspaceMonogram("recon_fork"), "R");
    eq(workspaceMonogram("recon.fork"), "R");
    eq(workspaceMonogram("my workspace 2025"), "M");
  });

  it("takes one letter only (GH #288)", () => {
    eq(workspaceMonogram("alpha-beta-gamma-delta"), "A");
  });

  it("uppercases regardless of input case", () => {
    eq(workspaceMonogram("Atelier"), "A");
    eq(workspaceMonogram("recon-FORK"), "R");
    eq(workspaceMonogram("aBc"), "A");
  });

  it("skips leading emoji and falls back to the first real letter", () => {
    eq(workspaceMonogram("🎨 design"), "D");
    eq(workspaceMonogram("🚀-launchpad"), "L");
    // Emoji segment in front, letter segment behind → take from the second.
    eq(workspaceMonogram("✨ dev workspace"), "D");
  });

  it("handles digit-only and digit-led names", () => {
    eq(workspaceMonogram("2025-Q1"), "2");
    eq(workspaceMonogram("42"), "4");
    eq(workspaceMonogram("v1-roadmap"), "V");
  });

  it("handles unicode letters (CJK / Cyrillic) without breaking surrogates", () => {
    // Single CJK ideograph — should not return `undefined` or half a codepoint.
    eq(workspaceMonogram("日本語"), "日");
    eq(workspaceMonogram("проект"), "П");
  });

  it("falls back to · for pathological names (empty / all-emoji / all-symbol)", () => {
    eq(workspaceMonogram(""), "·");
    eq(workspaceMonogram("🎨"), "·");
    eq(workspaceMonogram("🎨 🚀 ✨"), "·");
    eq(workspaceMonogram("---___..."), "·");
  });
});

if (failed > 0) {
  console.error(`✗ ${failed} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
} else {
  console.log(`✓ ${passed} passed`);
}
