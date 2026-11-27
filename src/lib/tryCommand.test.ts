// Tier 3 pure-function test. Run with Node 22+:
//   node --experimental-strip-types src/lib/tryCommand.test.ts
import assert from "node:assert/strict";
import type { TryCommandView, TryDetection } from "../ipc.ts";
import {
  detectedCommand,
  foundWords,
  setupTryLine,
  setupTryToSave,
  tryCommandProblem,
  tryPendingMark,
  tryRowHint,
  tryRowState,
  tryScopeLine,
  willStartLine,
} from "./tryCommand.ts";
import { SETTINGS_INDEX } from "./settingsIndex.ts";
import { searchSettings } from "./settingsSearch.ts";

const npm: TryDetection = { kind: "packageScript", command: "npm run dev", script: "dev", packageManager: "npm" };
const view = (over: Partial<TryCommandView> = {}): TryCommandView => ({
  command: null,
  approved: true,
  shared: false,
  readOnly: false,
  hasConfig: true,
  detection: { kind: "none" },
  ...over,
});

// Detection words
assert.equal(detectedCommand(npm), "npm run dev");
// The backend's strings: python3 on Mac and Linux, py on Windows.
assert.equal(detectedCommand({ kind: "django", command: "python3 manage.py runserver" }), "python3 manage.py runserver");
assert.equal(detectedCommand({ kind: "django", command: "py manage.py runserver" }), "py manage.py runserver");
assert.equal(detectedCommand({ kind: "rails", command: "ruby bin/rails server" }), "ruby bin/rails server");
assert.equal(detectedCommand({ kind: "rails", command: "bundle exec rackup" }), "bundle exec rackup");
assert.equal(foundWords({ kind: "rails", command: "ruby bin/rails server" }), "Found a Gemfile: this looks like a Rails app.");
assert.equal(foundWords({ kind: "rails", command: "bundle exec rackup" }), "Found a Gemfile: this looks like a Ruby web app.");
assert.equal(detectedCommand({ kind: "staticSite", file: "index.html" }), null);
assert.equal(detectedCommand({ kind: "none" }), null);
assert.equal(detectedCommand(null), null);
assert.equal(foundWords(npm), 'Found in package.json: the "dev" script, run with npm.');
assert.equal(
  foundWords({ kind: "packageScript", command: "pnpm start", script: "start", packageManager: "pnpm" }),
  'Found in package.json: the "start" script, run with pnpm.',
);
assert.equal(foundWords({ kind: "none" }), null);

// Scope (PRINCIPLES 1), with this PC on Windows
assert.equal(tryScopeLine(false, "mac"), "Saved for this repository on this Mac");
assert.equal(tryScopeLine(false, "windows"), "Saved for this repository on this PC");
assert.equal(tryScopeLine(true, "windows"), "Shared with everyone who opens the repository");

// The row: saved first, then the suggestion, then a static site, then nothing
assert.deepEqual(tryRowState(view({ command: " yarn start ", detection: npm })), { kind: "saved", command: "yarn start" });
assert.deepEqual(tryRowState(view({ detection: npm })), {
  kind: "suggested",
  command: "npm run dev",
  found: 'Found in package.json: the "dev" script, run with npm.',
});
assert.deepEqual(tryRowState(view({ detection: { kind: "staticSite", file: "index.html" } })), { kind: "staticSite" });
assert.deepEqual(tryRowState(view()), { kind: "notSet" });
assert.deepEqual(tryRowState(null), { kind: "notSet" });

assert.match(tryRowHint(view({ command: "npm run dev" }), "mac"), /Saved for this repository on this Mac\.$/);
assert.match(
  tryRowHint(view({ command: "npm run dev", shared: true, approved: false }), "windows"),
  /Shared with everyone who opens the repository\. It hasn't run on this PC yet/,
);
assert.match(tryRowHint(view({ detection: npm }), "mac"), /^Found in package\.json/);
assert.match(tryRowHint(view(), "mac"), /couldn't tell how this app starts/);
for (const v of [view({ command: "x" }), view({ detection: npm }), view(), view({ detection: { kind: "staticSite", file: "index.html" } })]) {
  const hint = tryRowHint(v, "windows");
  assert.doesNotMatch(hint, /\bworktree|\bPATH\b|\bCLI\b|\bMac\b/, hint);
}

// Typed commands
assert.equal(tryCommandProblem("npm run dev"), null);
assert.equal(tryCommandProblem("   "), null);
assert.match(tryCommandProblem("npm ci\nnpm run dev")!, /one line/);
assert.match(tryCommandProblem("x".repeat(2001))!, /at most 2000/);

// Setup step 9
assert.equal(willStartLine("npm run dev"), 'Plyloft will start your app with "npm run dev".');
assert.deepEqual(setupTryLine(view({ detection: npm }), null), {
  sentence: 'Plyloft will start your app with "npm run dev".',
  command: "npm run dev",
});
assert.equal(setupTryLine(view({ command: "yarn start", detection: npm }), null)!.command, "yarn start");
assert.equal(setupTryLine(view({ command: "yarn start" }), " bun run dev ")!.command, "bun run dev");
assert.equal(setupTryLine(view(), null)!.command, null);
assert.equal(setupTryLine(view({ detection: { kind: "staticSite", file: "index.html" } }), null)!.command, null);
assert.equal(setupTryLine(null, "x"), null);
// What step 9's save keeps: the shown command when it isn't saved yet.
assert.deepEqual(setupTryToSave(view({ detection: npm }), null), { command: "npm run dev" });
assert.equal(setupTryToSave(view({ command: "npm run dev", detection: npm }), null), null, "already saved");
assert.deepEqual(setupTryToSave(view({ command: "npm run dev" }), "npm start"), { command: "npm start" });
assert.equal(setupTryToSave(view(), null), null, "nothing to keep");
assert.equal(setupTryToSave(view({ detection: npm, readOnly: true }), null), null, "read-only keeps nothing");
// An empty Done clears: it never falls back to the suggestion.
assert.deepEqual(setupTryLine(view({ detection: npm }), ""), {
  sentence: "No start command: Try it will ask how your app starts.",
  command: null,
});
assert.equal(setupTryToSave(view({ detection: npm }), ""), null, "nothing saved, nothing to clear");
assert.deepEqual(setupTryToSave(view({ command: "npm run dev", detection: npm }), "  "), { command: null }, "clears the saved one");

// A change saved here and still on its way is marked on the row.
assert.equal(tryPendingMark(null), null);
assert.equal(tryPendingMark({ fields: { name: "x" }, pullRequests: {}, repository: null }), null);
assert.deepEqual(tryPendingMark({ fields: { tryCommand: null }, pullRequests: {}, repository: null }), {
  state: "publishing",
  hint: "Changed here, not published yet. It works on this Mac already.",
});
assert.equal(
  tryPendingMark({ fields: { tryCommand: "npm start" }, pullRequests: { tryCommand: 412 }, repository: null })!.hint,
  "Changed here, waiting in pull request #412. It works on this Mac already.",
);

// Settings search finds the row by the words a person would type.
for (const query of ["try it", "start your app", "dev server", "run"]) {
  const hits = searchSettings(query, SETTINGS_INDEX);
  assert.ok(
    hits.some((h) => h.entry.label === "How to start your app" && h.entry.page === "build-release"),
    `"${query}" finds How to start your app`,
  );
}

console.log("tryCommand.test.ts: ok");
