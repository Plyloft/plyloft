// UX-2.5 (UX-0.7): one keyboard focus ring app-wide.
// Run with Node 22+:  node --experimental-strip-types src/lib/focusRing.test.ts
//
// App.css may reset `outline` on a control only because a low-specificity
// :focus-visible ring (declared after the resets) puts it back; the only
// controls allowed to stay ringless are the full-surface text editors, whose
// caret shows focus. A new `outline: none` on a :focus-visible selector fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../App.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const RING =
  /:where\(button, \[role="button"\], a\[href\], input, select, textarea, summary, \[tabindex\]\):focus-visible\s*\{\s*outline: var\(--focus-w\) solid var\(--claude-accent\);\s*outline-offset: var\(--focus-offset\);\s*\}/;
const ring = RING.exec(css);
assert.ok(ring, "App.css declares the one focus ring");

// Every `outline: none|0` reset sits before the ring, so the ring wins ties.
const resets = [...css.matchAll(/outline:\s*(none|0)\s*;/g)];
const ringAt = ring!.index;
const EXEMPT = [
  ".palette-input:focus-visible",
  ".prompt-editor-body textarea:focus-visible",
  ".memory-editor-body textarea:focus-visible",
  ".codex-composer textarea:focus-visible",
];
for (const m of resets) {
  const open = css.lastIndexOf("{", m.index);
  const selector = css.slice(css.lastIndexOf("}", open) + 1, open).trim();
  if (m.index < ringAt) continue;
  // After the ring only the exempt editors may drop it.
  for (const part of selector.split(",").map((p) => p.trim())) {
    assert.ok(EXEMPT.includes(part), `"${part}" drops the focus ring after it is declared`);
  }
}

// A reset on a :focus-visible selector before the ring would win on
// specificity — none may exist outside the exempt editors.
for (const m of resets) {
  const open = css.lastIndexOf("{", m.index);
  const selector = css.slice(css.lastIndexOf("}", open) + 1, open).trim();
  if (!selector.includes(":focus-visible")) continue;
  for (const part of selector.split(",").map((p) => p.trim())) {
    assert.ok(EXEMPT.includes(part), `"${part}" hides keyboard focus`);
  }
}

console.log("focusRing: all contracts passed");
