// GH #173: Settings › Diagnostics, Setup (OB-4 retired the welcome screen) and the
// missing-dependency notice say the same thing about a tool, because they draw
// it from the same row model — and only Diagnostics ever asks about sign-in.
// UX-3.8: the notice is the sidebar's status row, whose Fix opens Diagnostics.
// Run with:
//
//     node --experimental-strip-types src/lib/doctorSurfaces.test.ts
//
// The components import React and Tauri, which this runner cannot load, so the
// contract is held on their source, the way `tileCommand.test.ts` holds
// `runInTile.ts` to owning no spawn.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** A file's code without its comments: the docs name what the code must not do. */
function code(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const diagnostics = code("../components/settings/DiagnosticsPage.tsx");
const setupBodies = code("../components/SetupStepBodies.tsx");
const setupOverlay = code("../components/SetupOverlay.tsx");
const status = code("../components/SidebarStatus.tsx");
const app = code("../App.tsx");
const store = code("../store/doctorStore.ts");

// ── One row model ─────────────────────────────────────────────────────────

const ROW_MODEL = /from\s+"(\.\.\/)+lib\/diagnostics"/;
assert.match(diagnostics, ROW_MODEL, "Diagnostics draws from lib/diagnostics");
// 1.176.1 walk: with whether Program folders is set.
assert.match(diagnostics, /\bneedsRows\(report, override\)/);
// Setup's interim step bodies (DependencyDoctor's tool rows) are gone: every
// step is built (OB-5 to OB-13), each with its own reads; the status row
// draws none — it names what is missing and opens Diagnostics.
assert.doesNotMatch(setupBodies, /<DependencyDoctor\b/);
assert.match(status, /openSettingsSection\("diagnostics"\)/);
assert.doesNotMatch(status, /toolRow\(|needsRows\(/, "no second row model");

// ── Only Diagnostics asks ────────────────────────────────────────────────

// App launch, a workspace switch, definition events, Setup and
// the banner: none of them asks `gh` (or looks for claude's credential).
for (const [name, text] of [
  ["SetupStepBodies.tsx", setupBodies],
  ["SetupOverlay.tsx", setupOverlay],
  ["SidebarStatus.tsx", status],
  ["App.tsx", app],
] as const) {
  assert.doesNotMatch(text, /withAuth/, `${name} must not ask about sign-in`);
  assert.doesNotMatch(text, /dependencyDoctor\(/, `${name} reads through the store`);
}

// Diagnostics is the one surface that does ask, on open and on `Look again`.
assert.match(diagnostics, /refresh\(\{ withAuth: true \}\)/);
assert.match(diagnostics, /reprobe\(\{ withAuth: true \}\)/);

// And the store turns "not asked" into `withAuth: false, forceAuth: false` on
// every read, the re-probe included: both calls go through doctorReadArgs,
// whose table is tested in diagnostics.test.ts.
// GH #227 review 2: both go through `readReport`, which numbers each read so
// an older answer never overwrites a newer one, and is the one caller of
// `dependencyDoctor`.
const calls = store.match(/readReport\(\.\.\.[^)]*\)/g) ?? [];
assert.equal(calls.length, 2, "refresh and reprobe");
for (const call of calls) {
  assert.match(call, /readReport\(\.\.\.doctorReadArgs\(/, call);
}
assert.deepEqual(store.match(/dependencyDoctor\([^)]*\)/g), ["dependencyDoctor(...args)"]);
assert.match(store, /const withAuth = options\?\.withAuth === true;[\s\S]*doctorReadArgs\(withAuth, withAuth\)/);

// GH #169 review 1: a neutral row's secondary step is in its menu, and taking
// it does not start a watch (the row is already counted ready).
assert.match(diagnostics, /onSecondary=\{/);
assert.match(diagnostics, /\.\.\.steps,/);
// OB-2 (D6): nor does an update — the row is ready before and after it.
assert.match(diagnostics, /if \(!secondary && !update\) watch\(row\.id\)/);

console.log("doctorSurfaces: ok");
