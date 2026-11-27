#!/usr/bin/env node
// Tests for scripts/site-guide.mjs (D26). The transform, plus main() on
// throwaway files; nothing here reads or writes the site repository.
//
//     node scripts/site-guide.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITE_GUIDE_DESCRIPTION, SITE_GUIDE_PATH, main, siteGuide } from "./site-guide.mjs";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const GUIDE = [
  "# Getting started with Plyloft",
  "",
  "Intro.",
  "",
  "<!-- tour:base.one -->",
  "1. **One.**",
  "<!-- tour:base.two -->",
  "2. **Two.** <!-- check against TU-6/TU-8 build -->",
  "",
  "",
  "",
  "| a | b |   ",
  "",
].join("\n");

test("frontmatter: the guide's title and the fixed description", () => {
  const out = siteGuide(GUIDE);
  assert.match(out, /^---\n# Generated from docs\/onboarding\/USER_GUIDE\.md/);
  assert.match(out, /\ntitle: "Getting started with Plyloft"\n/);
  assert.ok(out.includes(`\ndescription: ${JSON.stringify(SITE_GUIDE_DESCRIPTION)}\n---\n\n`));
});

test("the body: no title, no comments, the marker lines blank, no runs of blank lines", () => {
  const body = siteGuide(GUIDE).split("\n---\n\n")[1];
  assert.equal(body, "Intro.\n\n1. **One.**\n\n2. **Two.**\n\n| a | b |\n");
  assert.doesNotMatch(siteGuide(GUIDE), /<!--/);
});

test("deterministic, and CRLF reads as LF", () => {
  assert.equal(siteGuide(GUIDE), siteGuide(GUIDE));
  assert.equal(siteGuide(GUIDE.replace(/\n/g, "\r\n")), siteGuide(GUIDE));
});

test("a guide without a title, or with a comment over several lines, is refused", () => {
  assert.throws(() => siteGuide("no title\n"), /no '# ' title/);
  assert.throws(() => siteGuide("# T\n\n<!-- one\ntwo -->\n"), /over several lines/);
});

test("the real guide converts, with every tour marker gone", () => {
  const real = readFileSync(new URL("../docs/onboarding/USER_GUIDE.md", import.meta.url), "utf8");
  assert.match(real, /<!-- tour:base\.how-it-works -->/);
  const out = siteGuide(real);
  assert.doesNotMatch(out, /<!--/);
  assert.match(out, /\n### The Getting started tour\n/);
  assert.equal(SITE_GUIDE_PATH, "src/content/docs/docs/guide.md");
});

test("main: --write then --check passes; a changed guide or a missing copy fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "site-guide-"));
  const silent = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  try {
    const guide = join(dir, "USER_GUIDE.md");
    const out = join(dir, "site", SITE_GUIDE_PATH);
    writeFileSync(guide, GUIDE);
    assert.equal(main(["--check", "--guide", guide, "--out", out]), 1, "missing copy");
    assert.equal(main(["--write", "--guide", guide, "--out", out]), 0);
    assert.equal(readFileSync(out, "utf8"), siteGuide(GUIDE));
    assert.equal(main(["--check", "--guide", guide, "--out", out]), 0);
    writeFileSync(guide, GUIDE + "More.\n");
    assert.equal(main(["--check", "--guide", guide, "--out", out]), 1, "stale copy");
    assert.equal(main(["--check", "--guide", join(dir, "none.md"), "--out", out]), 3, "no guide");
    writeFileSync(guide, "No title.\n");
    assert.equal(main(["--check", "--guide", guide, "--out", out]), 3, "a guide with no title");
    assert.equal(main(["--write", "--guide", guide, "--out", out]), 3, "nothing written from it");
    assert.equal(readFileSync(out, "utf8"), siteGuide(GUIDE), "the copy is left as it was");
    assert.equal(main(["--check"]), 2);
    assert.equal(main(["--write", "--check", "--out", out]), 2);
  } finally {
    Object.assign(console, silent);
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`site-guide: ${passed} passed`);
