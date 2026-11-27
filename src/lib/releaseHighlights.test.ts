// Help › New in this version as each release's highlights (owner,
// 2026-10-21), Tier 3: every version from 1.167.0 on has an entry (a build
// whose package.json version has none fails here, so a release can't ship
// without one), 3–5 plain points, the installed version always shown, the
// versions since the member last looked below it, the dot until opened.
// Run by scripts/ppvp-pure-contracts.sh under node --experimental-strip-types.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CHANGELOG_URL,
  FIRST_HIGHLIGHTS,
  RELEASE_HIGHLIGHTS,
  highlightsFor,
  highlightsToShow,
  highlightsUnseen,
  type ReleaseHighlights,
} from "./releaseHighlights.ts";
import { compareVersions } from "./tutorial/whatsNew.ts";
import { HISTORY_TABS } from "./historyView.ts";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

// ── The data ─────────────────────────────────────────────────────────────

// A minor release (x.y.0) has its own entry; a patch release shows its
// minor's unless it has one.
{
  const [maj, min] = pkg.version.split(".");
  const minor = `${maj}.${min}.0`;
  assert.ok(
    RELEASE_HIGHLIGHTS.some((r) => r.version === minor),
    `package.json is ${pkg.version}: write ${minor}'s highlights in src/lib/releaseHighlights.ts (from its STATUS entry)`,
  );
  assert.ok(highlightsFor(pkg.version) != null);
}
assert.equal(RELEASE_HIGHLIGHTS[RELEASE_HIGHLIGHTS.length - 1].version, FIRST_HIGHLIGHTS);
for (let i = 1; i < RELEASE_HIGHLIGHTS.length; i += 1) {
  assert.ok(compareVersions(RELEASE_HIGHLIGHTS[i - 1].version, RELEASE_HIGHLIGHTS[i].version) > 0, "newest first, no repeats");
}
const INTERNAL = /\b(?:H\d+[ab]?|TU-\d|UX P-|P-[A-F]\d?|GH #\d+|part \d+|D\d{1,2}\b|#\d{3})\b/;
for (const r of RELEASE_HIGHLIGHTS) {
  const patch = !r.version.endsWith(".0");
  assert.ok(r.points.length >= (patch ? 1 : 3) && r.points.length <= 5, `${r.version}: ${patch ? "one" : "three"} to five points`);
  for (const p of r.points) {
    if (p.action && "nav" in p.action) {
      const nav = p.action.nav as Record<string, unknown>;
      assert.ok(!("card" in nav) && !("workspace" in nav) && !("setup" in nav), `${r.version}: a point opens a place, never the tour's card`);
    }
  }
  assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(r.title.length > 0 && r.title.length <= 80, `${r.version}: a one-line title`);
  for (const p of r.points) {
    assert.doesNotMatch(p.text, INTERNAL, `${r.version}: no card numbers in "${p.text.slice(0, 40)}…"`);
    assert.doesNotMatch(p.text, /worktree|snapshot|\bCLI\b|sandbox/i, `${r.version}: plain words`);
  }
}
assert.equal(CHANGELOG_URL, "https://www.plyloft.com/changelog");
{
  // 1.168.1: the 1.168.0 History point names every tab History always shows
  // (Cleanup appears only when it has rows), Discussions included.
  const point = highlightsFor("1.168.0")?.points.find((p) => p.text.startsWith("History in tabs"));
  assert.ok(point, "1.168.0 has its History point");
  for (const t of HISTORY_TABS.filter((t) => t.id !== "cleanup")) {
    assert.ok(point.text.includes(t.label), `the History point names ${t.label}`);
  }
}

{
  // 1.174.0 (TX7, D10): the point that announces the Challenger → Reviewer
  // rename, the 1.173.0 point that now says it too, and no button that
  // names a Settings page by its 1.173 name.
  const r174 = RELEASE_HIGHLIGHTS.find((r) => r.version === "1.174.0");
  assert.ok(r174, "1.174.0 has its highlights");
  assert.ok(r174.points.some((p) => p.text.startsWith("The Challenger is now called the Reviewer, everywhere")));
  assert.ok(highlightsFor("1.173.0")!.points.some((p) => p.text.startsWith("The Challenger is now called the Reviewer")));
  const labels = RELEASE_HIGHLIGHTS.flatMap((r) => r.points.flatMap((p) => (p.action && "nav" in p.action ? [p.action.label ?? ""] : [])));
  assert.ok(!labels.some((l) => /Claude and Codex|Build and release/.test(l)), "buttons use the 1.174 page names");
  assert.ok(!RELEASE_HIGHLIGHTS.some((r) => r.points.some((p) => /Ship as a PR/.test(p.text))), "no retired Ship as a PR");
}

// ── What shows ───────────────────────────────────────────────────────────

const fake = (version: string): ReleaseHighlights => ({ version, date: "2026-11-01", title: version, points: [] });
{
  const now = RELEASE_HIGHLIGHTS[0];
  // The installed version is always shown, looked at or not.
  assert.equal(highlightsToShow({ seenVersion: now.version }, now.version).current, now);
  assert.equal(highlightsToShow(null, now.version).current, now);
  // A patch release with no entry shows its minor's.
  const [maj, min] = now.version.split(".");
  assert.equal(highlightsFor(`${maj}.${min}.9`), now);
  // A build before the first entry has nothing (the sheet says the changelog has it).
  assert.equal(highlightsFor("1.166.0"), null);
  assert.deepEqual(highlightsToShow(null, "1.166.0"), { current: null, earlier: [] });
}
{
  // The dot: until this version is looked at.
  const v = RELEASE_HIGHLIGHTS[0].version;
  assert.equal(highlightsUnseen(null, v), true, "nothing recorded (an old user upgrading)");
  assert.equal(highlightsUnseen({ seenVersion: v }, v), false, "opened (or a new install, stamped)");
  assert.equal(highlightsUnseen({ seenVersion: "1.166.0" }, v), true);
  assert.equal(highlightsUnseen({ seenVersion: "1.200.0" }, v), false, "an older build after a newer one");
  assert.equal(highlightsUnseen(null, "1.166.0"), false, "no entry, no dot");
}
{
  // Earlier versions: those after the one last looked at, before this one,
  // newest first; nothing recorded shows them all.
  const list = [fake("1.170.0"), fake("1.169.0"), fake("1.168.0"), fake("1.167.0")];
  const shown = highlightsToShow({ seenVersion: "1.168.0" }, "1.170.0", list);
  assert.equal(shown.current?.version, "1.170.0");
  assert.deepEqual(shown.earlier.map((r) => r.version), ["1.169.0"]);
  assert.deepEqual(highlightsToShow(null, "1.170.0", list).earlier.map((r) => r.version), ["1.169.0", "1.168.0", "1.167.0"]);
  assert.deepEqual(highlightsToShow({ seenVersion: "1.170.0" }, "1.170.0", list).earlier, [], "looked at: only this one");
  const long = ["1.175.0", "1.174.0", "1.173.0", "1.172.0", "1.171.0"].map(fake);
  assert.deepEqual(highlightsToShow(null, "1.175.0", long).earlier.map((r) => r.version), ["1.174.0", "1.173.0", "1.172.0"], "at most three; the rest is the full changelog");
}

console.log(`releaseHighlights.test.ts: ${RELEASE_HIGHLIGHTS.length} release(s), package.json ${pkg.version} has highlights`);
