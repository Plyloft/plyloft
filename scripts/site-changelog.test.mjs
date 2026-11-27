#!/usr/bin/env node
// Tests for scripts/site-changelog.mjs (W5). Pure transforms, plus main() on
// throwaway files; nothing here reads or writes the site repository.
//
//     node scripts/site-changelog.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  topEntry,
  plainText,
  firstSentence,
  noteOf,
  titleOf,
  areasOf,
  tsString,
  releaseSource,
  insertRelease,
  draftRelease,
  main,
} from "./site-changelog.mjs";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const STATUS = `# Atelier — Status

## Current shared-workspace decision — 2026-09-09

- not a release bullet

## v2.0.0 — the big one: sign in, plans and seats

**Why.** Because.

- a bullet in Why is not a note

**What, by what a person notices.**
- *Sign in to Plyloft (A1, A2).* Everyone signs in once, Free included. GitHub's
  code asks for no scopes.
- *Teams with seats (T1–T3).* Members shows "N of M seats" on the
  [Team page](docs/x.md). More words.
  - a nested detail
    that continues
- *Smaller fixes (CL-10, fixes a 1.155.0 defect).* Dates read \`4 Oct 2026\`.

- *After a blank line.* Still a bullet (GH #216).

**Limits.** One device.

- a limit bullet

## v1.9.0 — older

**What.**
- older note
`;

const RELEASES = `export type Area = 'Review' | 'Fixes';

export const RELEASES: Release[] = [
\t{
\t\tv: '1.9.0', date: '2026-01-01', title: 'Older',
\t\tareas: ['Fixes'],
\t\tnotes: ['older note'],
\t},
];

export const SINCE = { count: 43, from: '11 September' };
`;

test("topEntry: the first version entry, its headline and its What bullets only", () => {
  const e = topEntry(STATUS);
  assert.equal(e.version, "2.0.0");
  assert.equal(e.headline, "the big one: sign in, plans and seats");
  assert.equal(e.bullets.length, 4);
  assert.match(e.bullets[0], /^\*Sign in to Plyloft \(A1, A2\)\.\* Everyone signs in once, Free included\. GitHub's code asks/);
  assert.ok(!e.bullets.some((b) => b.includes("nested") || b.includes("continues")), "nested bullets left out");
  assert.ok(!e.bullets.some((b) => b.includes("Why") || b.includes("limit")), "only the What part");
  assert.equal(e.bullets[3], "*After a blank line.* Still a bullet (GH #216).");
});

test("topEntry: without a What part, every top-level bullet; none without an entry", () => {
  const e = topEntry("## v1.0.0 — plain\n\n- one\n- two\n  more\n");
  assert.deepEqual(e.bullets, ["one", "two more"]);
  assert.equal(topEntry("# Status\n\nno releases\n"), null);
});

test("plainText: markdown, links and card numbers out; other parentheses kept", () => {
  assert.equal(plainText("**Bold** and `code` and [a link](x.md)"), "Bold and code and a link");
  assert.equal(plainText("Sign in (A1, A2)."), "Sign in.");
  assert.equal(plainText("Plans (G1–G3) and (SP-7) and (GH #216) and (N14 1–9) and (F1–F15)"), "Plans and and and and");
  assert.equal(plainText("seats (2–50, the owner counts)"), "seats (2–50, the owner counts)");
  assert.equal(plainText("Skills (CL-10, fixes a 1.155.0 defect)"), "Skills (CL-10, fixes a 1.155.0 defect)");
  assert.equal(plainText("an *italic* word, a ✓ * star"), "an italic word, a ✓ * star");
});

test("firstSentence stops at the first sentence end before a capital", () => {
  assert.equal(firstSentence("One thing. Two things."), "One thing.");
  assert.equal(firstSentence("Version 1.2.3 is out. Next."), "Version 1.2.3 is out.");
  assert.equal(firstSentence("no end"), "no end");
});

test("noteOf: a label becomes 'Label: first sentence'", () => {
  const [a, b, c, d] = topEntry(STATUS).bullets.map(noteOf);
  assert.equal(a, "Sign in to Plyloft: Everyone signs in once, Free included.");
  assert.equal(b, 'Teams with seats: Members shows "N of M seats" on the Team page.');
  assert.equal(c, "Smaller fixes (CL-10, fixes a 1.155.0 defect): Dates read 4 Oct 2026.");
  assert.equal(d, "After a blank line: Still a bullet.");
  assert.equal(noteOf("No label here. Second."), "No label here.");
});

test("titleOf: up to the first colon, capitalised", () => {
  assert.equal(titleOf("the big one: sign in"), "The big one");
  assert.equal(titleOf("`code` title"), "Code title");
  assert.equal(titleOf(""), "");
});

test("areasOf: the site's areas in the site's order; Fixes when nothing matches", () => {
  assert.deepEqual(areasOf("Team seats and the Board, on Windows; sign in"), ["Board", "Windows", "Team", "Setup"]);
  assert.deepEqual(areasOf("nothing here"), ["Fixes"]);
});

test("tsString escapes quotes and backslashes", () => {
  assert.equal(tsString("it's a \\ path"), "'it\\'s a \\\\ path'");
});

test("releaseSource matches the file's layout", () => {
  const src = releaseSource({ version: "2.0.0", date: "2026-10-30", title: "T", areas: ["Team", "Fixes"], notes: ["a", "b's"] });
  assert.equal(
    src,
    "\t{\n\t\tv: '2.0.0', date: '2026-10-30', title: 'T',\n\t\tareas: ['Team', 'Fixes'],\n\t\tnotes: [\n\t\t\t'a',\n\t\t\t'b\\'s',\n\t\t],\n\t},\n",
  );
});

test("insertRelease: first in RELEASES, SINCE.count +1; idempotent by version", () => {
  const release = { version: "2.0.0", date: "2026-10-30", title: "T", areas: ["Fixes"], notes: ["a"] };
  const out = insertRelease(RELEASES, release);
  assert.equal(out.changed, true);
  assert.equal(out.sinceBumped, true);
  assert.ok(out.text.indexOf("v: '2.0.0'") < out.text.indexOf("v: '1.9.0'"));
  assert.match(out.text, /export const SINCE = \{ count: 44, from: '11 September' \};/);
  const again = insertRelease(out.text, release);
  assert.equal(again.changed, false);
  assert.match(again.reason, /already/);
  assert.equal(again.text, out.text);
  // 1.9.0 must not match 1.9.01 or 109.0 by accident.
  assert.equal(insertRelease(RELEASES, { ...release, version: "1.9.01" }).changed, true);
});

test("insertRelease refuses a file of another shape", () => {
  const out = insertRelease("export const OTHER = [];\n", { version: "2.0.0", date: "d", title: "t", areas: [], notes: [] });
  assert.equal(out.changed, false);
  assert.match(out.reason, /RELEASES/);
});

test("draftRelease refuses a STATUS whose top entry is another version", () => {
  assert.match(draftRelease(STATUS, "2.0.1", "2026-10-30").error, /top entry is v2\.0\.0, not v2\.0\.1/);
  assert.match(draftRelease("# none\n", "2.0.0", "2026-10-30").error, /no `## vX\.Y\.Z` entry/);
  const d = draftRelease(STATUS, "2.0.0", "2026-10-30").release;
  assert.equal(d.title, "The big one");
  assert.equal(d.notes.length, 4);
});

test("main writes the file once, then leaves it; errors write nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "site-changelog-test."));
  try {
    const status = join(dir, "STATUS.md");
    const releases = join(dir, "releases.ts");
    writeFileSync(status, STATUS);
    writeFileSync(releases, RELEASES);
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      assert.equal(main(["--status", status, "--releases", releases, "--version", "2.0.0", "--date", "2026-10-30"]), 0);
      const once = readFileSync(releases, "utf8");
      assert.match(once, /v: '2\.0\.0', date: '2026-10-30', title: 'The big one'/);
      assert.equal(main(["--status", status, "--releases", releases, "--version", "2.0.0", "--date", "2026-10-31"]), 0);
      assert.equal(readFileSync(releases, "utf8"), once, "a second run changes nothing");
      writeFileSync(releases, RELEASES);
      assert.equal(main(["--status", status, "--releases", releases, "--version", "3.0.0"]), 1);
      assert.equal(readFileSync(releases, "utf8"), RELEASES, "a wrong version writes nothing");
      assert.equal(main(["--status", status, "--releases", join(dir, "missing.ts"), "--version", "2.0.0"]), 1);
      assert.equal(main(["--status", status, "--releases", releases, "--version", "2.0.0", "--date", "30/10"]), 1);
      assert.equal(main(["--status", status]), 2);
      assert.equal(main(["--status", status, "--releases", releases, "--version", "2.0.0"], "2026-11-02"), 0);
      assert.match(readFileSync(releases, "utf8"), /date: '2026-11-02'/);
    } finally {
      console.log = log;
      console.error = err;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`site-changelog: ${passed} tests passed`);
