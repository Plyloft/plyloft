// Getting started TU-8 (docs/tutorial/TUTORIAL_SPEC.md §12.2, §13, §3.3):
// when New in this version was looked at, the tutorial report and Get
// help's email, Tier 3. The
// report never carries a project name, a card title, a brief, a path or an
// id. Run by scripts/ppvp-pure-contracts.sh under node --experimental-strip-types.
import assert from "node:assert/strict";
import type { TutorialProgress } from "./settingsShape.ts";
import { STEP } from "./tutorial/manifest.ts";
import {
  SUPPORT_EMAIL,
  compareVersions,
  needsNewInstallStamp,
  parseVersion,
  shouldAnnounceUpdate,
  updatedToastTitle,
  supportMailto,
  tutorialReport,
  withSeenVersion,
} from "./tutorial/whatsNew.ts";

// ── Versions ─────────────────────────────────────────────────────────────

assert.deepEqual(parseVersion("1.167.0"), [1, 167, 0]);
assert.equal(parseVersion("soon"), null);
assert.equal(parseVersion(null), null);
assert.ok(compareVersions("1.168.0", "1.167.9") > 0);
assert.ok(compareVersions("1.9.0", "1.10.0") < 0, "numbers, not text");
assert.equal(compareVersions("1.167.0", "1.167.0"), 0);

// ── New in this version (§12.2): the new-install stamp ──────────────────
// What the sheet shows is releaseHighlights.test.ts's (owner, 2026-10-21).

assert.equal(needsNewInstallStamp(null, null), true, "a new install, before Setup's first run");
assert.equal(needsNewInstallStamp(null, "2026-01-01T00:00:00Z"), false, "an install that ran Setup: an old user");
assert.equal(needsNewInstallStamp({ seenVersion: "1.167.0" }, null), false, "stamped once");

{
  // Never moved back by an older build; a bad value is replaced.
  const r: TutorialProgress = { seenVersion: "1.170.0", done: { "future.step": "x" } };
  assert.equal(withSeenVersion(r, "1.168.0"), r);
  assert.equal(withSeenVersion({ seenVersion: "soon" }, "1.168.0").seenVersion, "1.168.0");
  assert.deepEqual(withSeenVersion(r, "1.171.0").done, r.done, "spread, never rebuilt");
}

// ── The report (§13) ─────────────────────────────────────────────────────

{
  const T0 = "2026-10-21T09:00:00.000Z";
  const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
  const record: TutorialProgress = {
    startedAt: T0,
    startedVersion: "1.167.0",
    path: "full",
    workspaceId: "ws-secret-1234",
    cardId: "card-secret-5678",
    done: { [STEP.howItWorks]: at(0), [STEP.newCard]: at(3), [STEP.ship]: at(42), "future.step-name": at(50) },
    skipped: { [STEP.watchTerminals]: at(10) },
    seenSections: ["code"],
  };
  const text = tutorialReport(record, {
    version: "1.167.0",
    platform: "mac",
    level: "guided",
    workMode: "solo",
    plan: "Free",
    ai: { claude: true, codex: false },
  }, { where: "4 of 10 done, on base.brief" });
  assert.match(text, /App 1\.167\.0 · macOS · step by step · solo mode · plan Free/);
  assert.match(text, /Claude ready · Codex not ready/);
  assert.match(text, /base\.new-card: done at 3 min/);
  assert.match(text, /base\.watch-terminals: skipped at 10 min/);
  assert.match(text, /First card shipped at 42 min/);
  assert.match(text, /and 1 from a newer version/);
  assert.match(text, /Where the tour is: 4 of 10 done, on base\.brief/);
  // Never an id, a step id this build doesn't know, a name or a path.
  for (const secret of ["ws-secret", "card-secret", "future.step-name", "/Users", "Lyra"]) {
    assert.ok(!text.includes(secret), `no ${secret} in the report`);
  }
  const win = tutorialReport(null, { version: "1.167.0", platform: "windows", level: null, workMode: null, plan: null });
  assert.match(win, /Windows · level not chosen · solo or team unknown · plan unknown/);
  assert.match(win, /Full tour not started/);
  assert.match(win, /Steps: none yet/);
  assert.ok(!win.includes("Claude"), "Copy tutorial report leaves out the AIs; Get help adds them");
  const unchecked = tutorialReport(null, { version: "1.167.0", platform: "mac", level: null, workMode: null, plan: null, ai: null });
  assert.match(unchecked, /Claude and Codex not checked yet/, "never 'not ready' before the check");
  const short = tutorialReport(record, { version: "1.167.0", platform: "mac", level: "guided", workMode: "solo", plan: "Free" }, { short: true });
  assert.match(short, /Steps: 3 done, 1 skipped/, "the email's: counts, not each step");
  assert.ok(!short.includes("base.new-card"));
}

// ── Get help (§3.3) ──────────────────────────────────────────────────────

{
  const link = supportMailto("Plyloft tutorial report\nApp 1.167.0 & more");
  assert.ok(link.startsWith(`mailto:${SUPPORT_EMAIL}?subject=`));
  assert.equal(SUPPORT_EMAIL, "support@plyloft.com", "D28");
  const body = decodeURIComponent(link.split("&body=")[1]);
  assert.ok(body.includes("App 1.167.0 & more"), "the report in the body, encoded");
  assert.ok(!link.slice(link.indexOf("?")).includes(" "), "no bare space in the link");
}

// ── QoL 1.168 S3: "Updated to 1.168.0 · What's new", once ────────────────
{
  const base = { version: "1.168.0", firstRunCompletedAt: "2026-10-01T00:00:00Z", unseen: true, announced: null };
  assert.equal(shouldAnnounceUpdate(base), true, "an install that updated, highlights unseen");
  assert.equal(shouldAnnounceUpdate({ ...base, announced: "1.168.0" }), false, "once per version");
  assert.equal(shouldAnnounceUpdate({ ...base, announced: "1.167.0" }), true, "the next version again");
  assert.equal(shouldAnnounceUpdate({ ...base, unseen: false }), false, "already opened: nothing to say");
  assert.equal(shouldAnnounceUpdate({ ...base, firstRunCompletedAt: null }), false, "never on a new install");
  assert.equal(shouldAnnounceUpdate({ ...base, version: null }), false);
  assert.equal(updatedToastTitle("1.168.0"), "Updated to 1.168.0");
}

console.log("tutorialWhatsNew.test.ts: the stamp, the report and Get help");
