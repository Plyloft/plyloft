// QoL 14.1 (C19): the Board's refresh schedule and its source line's words. Run with
// `node --experimental-strip-types src/lib/boardFreshness.test.ts`.
import assert from "node:assert/strict";
import {
  FAILED_BACKOFF_MS,
  FOCUS_GAP_MS,
  NO_FRESHNESS,
  REFRESH_EVERY_MS,
  refreshDue,
  readWords,
  announcedWords,
  noRepositoryAccess,
} from "./boardFreshness.ts";

const t0 = 1_000_000_000;
const ok = { at: t0, triedAt: t0, failed: false };

// Never read: due on both.
assert.equal(refreshDue(NO_FRESHNESS, t0, "timer"), true);
assert.equal(refreshDue(NO_FRESHNESS, t0, "focus"), true);
// The timer waits the full interval; focus only the short gap.
assert.equal(refreshDue(ok, t0 + REFRESH_EVERY_MS - 1, "timer"), false);
assert.equal(refreshDue(ok, t0 + REFRESH_EVERY_MS, "timer"), true);
assert.equal(refreshDue(ok, t0 + FOCUS_GAP_MS - 1, "focus"), false);
assert.equal(refreshDue(ok, t0 + FOCUS_GAP_MS, "focus"), true);
// A failure (offline, rate limit) backs both off.
const failed = { at: null, triedAt: t0, failed: true };
assert.equal(refreshDue(failed, t0 + REFRESH_EVERY_MS, "timer"), false);
assert.equal(refreshDue(failed, t0 + FOCUS_GAP_MS, "focus"), false);
assert.equal(refreshDue(failed, t0 + FAILED_BACKOFF_MS, "focus"), true);

// Words (1.172.1 F2: mid-sentence, after "Cards come from the GitHub issues of o/r ·").
assert.equal(readWords(NO_FRESHNESS, t0), "not read yet");
assert.equal(readWords(ok, t0 + 30_000), "read just now");
assert.equal(readWords(ok, t0 + 4 * 60_000), "read 4 min ago");
assert.equal(readWords(ok, t0 + 3 * 3_600_000), "read 3 h ago");
assert.equal(readWords(failed, t0), "couldn't read GitHub");
// U21: the member was removed; GitHub's answer says so.
assert.equal(noRepositoryAccess(new Error("GraphQL: Could not resolve to a Repository with the name 'o/r'. (repository)")), true);
assert.equal(noRepositoryAccess("remote: Repository not found."), true);
assert.equal(noRepositoryAccess("dial tcp: i/o timeout"), false);
assert.equal(readWords({ ...failed, noAccess: true }, t0), "no access on GitHub");
assert.equal(readWords({ ...failed, noAccess: true, at: t0 - 5 * 60_000 }, t0), "no access on GitHub, last read 5 min ago");
assert.equal(
  readWords({ at: t0, triedAt: t0 + 60_000, failed: true }, t0 + 5 * 60_000),
  "couldn't read GitHub, last read 5 min ago",
);
// Block C: the announcement never says less fresh or more fresh than the line.
assert.equal(announcedWords(NO_FRESHNESS, t0), "");
assert.equal(announcedWords(ok, t0 + 30_000), "read just now");
assert.equal(announcedWords(ok, t0 + 2 * 60_000), "", "read 2 min ago: the line says it, unannounced");
assert.equal(announcedWords({ at: t0, triedAt: t0, failed: true }, t0 + 5 * 60_000), "couldn't read GitHub");
assert.equal(announcedWords({ at: t0, triedAt: t0, failed: true, noAccess: true }, t0 + 5 * 60_000), "no access on GitHub");
console.log("boardFreshness: ok");
