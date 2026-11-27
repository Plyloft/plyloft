// UX P1 point 2 (P-A), test 4: the guard. What a card says is decided in
// `cardPresentation.ts` only:
//
// - no other file assigns a state presentation or a state label
//   (`statePresentation = {`, `label: TRUST_LABEL`, `label: "Needs you"`);
// - no other file derives a card's word from `deriveBoardCardState`, and
//   `deriveCardState` is called only where a state (not a word) is wanted;
// - no file decides on a visible word: a `label`, `headline` or `words`
//   compared to a string literal (`needsYou.ts` and `sessionActor.ts`
//   compared "Build done" before P-A; point 3 renames it).
//
// Run with Node 22+:
//   node --experimental-strip-types src/lib/cardPresentation.guard.test.ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "test" || name === "node_modules") continue;
      out.push(...sources(path));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith(".fixtures.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** The code of a file without its comments, so a comment that names the
 *  old pattern is no violation. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const files = sources(SRC).map((path) => ({ rel: relative(SRC, path), text: code(readFileSync(path, "utf8")) }));
assert.ok(files.length > 100, "the guard reads the source tree");

const HOME = "lib/cardPresentation.ts";

// 1. State presentations and labels are assigned in one place.
for (const { rel, text } of files) {
  if (rel === HOME) continue;
  assert.doesNotMatch(text, /\bstatePresentation\s*=\s*\{/, `${rel}: assigns a state presentation`);
  assert.doesNotMatch(text, /\blabel:\s*TRUST_LABEL\b/, `${rel}: assigns the trust word as a state label`);
  // "Needs you" is the name of a column and of an Inbox group, only.
  assert.doesNotMatch(
    text,
    /(?<!(?:id|key):\s*"needs[-_]you",\s*)\blabel:\s*"Needs you"/,
    `${rel}: says "Needs you" as a state`,
  );
}

// 2. Words come from `presentCard`, not from the state machine directly.
const DERIVE_CARD_STATE_ALLOWED: Record<string, string> = {
  "lib/cardLifecycle.ts": "the canonical state machine itself",
  [HOME]: "the first step of presentCard",
  "lib/intakeStopped.ts": "a state check (is the card planning?), no word",
  "lib/boardSemantics.ts": "the column of the drag's default and the legacy attention helpers, no word",
};
for (const { rel, text } of files) {
  if (rel !== HOME) {
    assert.doesNotMatch(text, /\bderiveBoardCardState\s*\(/, `${rel}: derives a word outside presentCard`);
  }
  if (!(rel in DERIVE_CARD_STATE_ALLOWED)) {
    assert.doesNotMatch(text, /\bderiveCardState\s*\(/, `${rel}: calls deriveCardState for a word`);
  }
}
// The callers the spec names in particular.
for (const rel of [
  "components/CardDependencies.tsx",
  "lib/boardList.ts",
  "components/CardDetailPanel.tsx",
  "components/KanbanBoard.tsx",
  "components/BoardList.tsx",
  "components/InboxPanel.tsx",
]) {
  const file = files.find((f) => f.rel === rel);
  assert.ok(file, `${rel} exists`);
  assert.doesNotMatch(file!.text, /\bderive(Board)?CardState\s*\(/, `${rel}: words from presentCard only`);
}

// 3. No decision on a visible word.
const LITERAL_COMPARE = /\.(label|headline|words)\s*[!=]==\s*["'`]/;
// The guard catches what it is for (main had both of these).
assert.match('liveBuilderSessionState(a, b).label === "Build done"', LITERAL_COMPARE);
assert.match('if (state.label === "Build done") return', LITERAL_COMPARE);
assert.match("statePresentation = { ...x }", /\bstatePresentation\s*=\s*\{/);
const NOT_A_CARD_STATE: Record<string, string> = {
  "components/CommandPalette.tsx": "a palette entry's own name, not a card's state",
  "components/ToastStack.tsx": "a toast's Undo button gets its icon, not a card's state",
};
for (const { rel, text } of files) {
  if (rel in NOT_A_CARD_STATE) continue;
  assert.doesNotMatch(text, LITERAL_COMPARE, `${rel}: compares a visible word to a literal`);
}
// The two places P-A moved to the state id stay on it.
const needsYou = files.find((f) => f.rel === "lib/needsYou.ts")!.text;
const actor = files.find((f) => f.rel === "lib/sessionActor.ts")!.text;
assert.match(needsYou, /\.id === "saved"/);
assert.match(actor, /state\.id === "saved"/);
assert.doesNotMatch(needsYou + actor, /"Build done"/, "no logic on the word Build done");

console.log(`cardPresentation.guard: ${files.length} source files`);
