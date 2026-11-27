// UX-2.1 (ADR 0007): the app's token block is the Ply Design System's.
// Run with Node 22+:  node --experimental-strip-types src/lib/designTokens.test.ts
//
// 1. App.css holds exactly the block scripts/tokens-css.mjs generates from
//    docs/ux-language/tokens.json (regenerate with --write after a change).
// 2. Every colour token of the design system is defined for every theme.
// 3. Legacy names still read by the app resolve to a defined token.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error — a plain .mjs script, no types
import { CSS_FILE, TOKENS_FILE, currentBlock, generate } from "../../scripts/tokens-css.mjs";

const tokens = JSON.parse(readFileSync(TOKENS_FILE, "utf8"));
const css = readFileSync(CSS_FILE, "utf8");
const block = currentBlock(css);

assert.ok(block, "App.css has the @tokens markers");
assert.equal(block, generate(tokens), "App.css token block is stale — run node scripts/tokens-css.mjs --write");

const themes: string[] = tokens.color.themes.map((t: { id: string }) => t.id);
for (const t of tokens.color.tokens) {
  for (const theme of themes) {
    const v = typeof t.value === "string" ? t.value : t.value[theme] ?? t.value[themes[0]];
    assert.ok(v, `${t.name} has a value for ${theme}`);
  }
}

// The generated block defines each design-system name once per scope.
for (const fam of ["spacing", "radius", "size", "duration", "easing"]) {
  for (const t of tokens[fam].tokens) {
    assert.ok(block.includes(`--${t.name}: ${t.value};`), `--${t.name} is generated`);
  }
}

// Legacy aliases point at names the block defines.
for (const [legacy, target] of [
  ["--tab-active-bg", "--selected"],
  ["--page-on-accent", "--on-accent"],
  ["--page-shadow-surface", "--shadow-sheet"],
  ["--page-shadow-menu", "--shadow-popover"],
  ["--page-backdrop", "--scrim"],
]) {
  assert.ok(css.includes(`${legacy}: var(${target});`), `${legacy} aliases ${target}`);
  assert.ok(block.includes(`${target}:`), `${target} is defined`);
}

console.log("designTokens: all contracts passed");
