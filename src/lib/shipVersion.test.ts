// 1.173.0 (B4): a release's tag and version line, per area; without areas
// the words are the ones from before.
import assert from "node:assert/strict";
import { auditVersionLine, latestTaggedEntry, ownShipEntry, releaseTag, shipEntryWords, shippedWords } from "./shipVersion.ts";

assert.equal(releaseTag("", "1.2.3"), "v1.2.3");
assert.equal(releaseTag(undefined, "v1.2.3"), "v1.2.3");
assert.equal(releaseTag("site-", " 3.0.2 "), "site-v3.0.2");
assert.equal(shippedWords("1.2.3"), "v1.2.3");

const base = { versionSource: "package.json", versionOnGithub: false, currentVersion: "1.0.0", targetBranch: "main" };
// No areas (an older backend, or an empty area): the old sentences.
assert.equal(auditVersionLine(base, "This repository"), "This repository is at v1.0.0; the next one is suggested.");
assert.equal(
  auditVersionLine({ ...base, area: { name: null, tagPrefix: "" } }, "This project"),
  "This project is at v1.0.0; the next one is suggested.",
);
assert.equal(
  auditVersionLine({ ...base, versionSource: null }, "This repository"),
  "This repository has no version yet; the first one is suggested.",
);
assert.equal(
  auditVersionLine({ ...base, versionOnGithub: true }, "This repository"),
  "On GitHub, main is at v1.0.0; the next one is suggested.",
);
// An area: its name and its own tag.
const site = { ...base, currentVersion: "3.0.1", area: { name: "Site", tagPrefix: "site-" } };
assert.equal(auditVersionLine(site, "This repository"), "Site is at site-v3.0.1; the next one is suggested.");
assert.equal(
  auditVersionLine({ ...site, versionOnGithub: true }, "This project"),
  "On GitHub, main is at site-v3.0.1; the next one is suggested.",
);
assert.equal(
  auditVersionLine({ ...site, versionSource: null }, "This project"),
  "Site has no version yet; the first one is suggested.",
);
// A ship entry: its own tag, else its version as before (an older entry).
assert.equal(shipEntryWords({ shippedVersion: "3.0.2", tag: "site-v3.0.2" }), "site-v3.0.2");
assert.equal(shipEntryWords({ shippedVersion: "3.0.2" }), "v3.0.2");
assert.equal(shipEntryWords({ shippedVersion: "unknown", tag: null }), null);
// 1.174.0 (DR2 round 1): a card's own ship, never the release that carried
// it later; the newest release it is in, apart.
{
  const own = { commitSha: "m1", shippedVersion: "1.0.0", shippedAt: 1, releaseKind: "local" };
  const release = { commitSha: "r9", shippedVersion: "3.0.2", shippedAt: 5, releaseKind: "github", tag: "site-v3.0.2" };
  const merged = { prUrl: "https://github.com/o/r/pull/1", pr: { mergeCommit: "m1" }, shipHistory: [own, release] };
  assert.equal(ownShipEntry(merged), own, "its pull request's merge");
  assert.equal(ownShipEntry({ commitSha: "m1", shipHistory: [own, release] }), own, "its commit");
  assert.equal(ownShipEntry({ commitSha: "r9", shipHistory: [own, release] }), release, "ticked into the release");
  assert.equal(ownShipEntry({ shipHistory: [own, release] }), release, "nothing to tell: the last, as before");
  assert.equal(ownShipEntry({ shipHistory: [] }), null);
  assert.equal(latestTaggedEntry(merged), release);
  assert.equal(latestTaggedEntry({ shipHistory: [own] }), null);
}

console.log("shipVersion ok");
