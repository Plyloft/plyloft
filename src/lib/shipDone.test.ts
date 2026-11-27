// QoL 1.168 S1-4: the success toast says what happened, and only Plyloft's
// own repository says Plyloft will quit and relaunch.
import assert from "node:assert/strict";
import { NOTHING_RUNS_AFTER_SHIPPING, goLiveWords, releasedByPollerWords, shipDoneWords } from "./shipDone.ts";

const base = { commitSha: "0123456789abcdef", shippedVersion: "1.4.0" };

const other = shipDoneWords({ ...base, releaseKind: "local", installScript: null, relaunches: false });
assert.equal(other.title, "Shipped as v1.4.0");
assert.equal(other.body, "Committed and tagged on this Mac. Commit 01234567.");
assert.doesNotMatch(other.body, /quit|relaunch/);

const pushed = shipDoneWords({ ...base, releaseKind: "push_only", installScript: "scripts/deploy.sh", relaunches: false }, 3);
assert.equal(pushed.title, "Shipped 3 cards as v1.4.0");
assert.equal(
  pushed.body,
  "Committed, tagged and pushed. Its install step (scripts/deploy.sh) is running in the background. Commit 01234567.",
);

const self = shipDoneWords({ ...base, releaseKind: "github", installScript: "scripts/install-local.sh", relaunches: true });
assert.equal(
  self.body,
  "Committed, tagged and pushed. The release page on GitHub is created by your own workflow, if you have one. Plyloft is building it, then quits and relaunches as v1.4.0. Commit 01234567.",
);
// 1.169.1 (R13): a GitHub release never claims a release page Plyloft made.
assert.doesNotMatch(self.body, /published as a GitHub release/);

// An older backend (no fields): never claims a relaunch.
const old = shipDoneWords({ ...base, releaseKind: "local" });
assert.doesNotMatch(old.body, /relaunch/);

// G8 (1.170.0): a release through a pull request says where it is.
const opened = shipDoneWords({
  ...base,
  releaseKind: "github",
  releasePr: { step: "merging", number: 12, url: "https://github.com/o/r/pull/12", waiting: null, released: false },
});
assert.equal(opened.title, "Release pull request #12 opened");
assert.equal(
  opened.body,
  "v1.4.0 goes in when its checks on GitHub pass: Plyloft merges it, then tags it and publishes the release. The card is marked shipped then.",
);
const merged = shipDoneWords(
  { ...base, releaseKind: "push_only", releasePr: { step: "tagged", number: 12, url: null, waiting: null, released: true } },
  2,
);
assert.equal(merged.title, "Released 2 cards as v1.4.0");
assert.equal(merged.body, "Merged through its pull request #12, tagged on the merge. Commit 01234567.");
const page = shipDoneWords({ ...base, releaseKind: "github", releasePr: { step: "tagged", number: 3, url: null, waiting: null, released: true } });
assert.match(page.body, /its release page on GitHub is published/);
const stuck = shipDoneWords({ ...base, releaseKind: "push_only", releasePr: { step: "built", number: null, url: null, waiting: "Plyloft couldn't push it yet.", released: false } });
assert.equal(stuck.title, "Release made, not on GitHub yet");
assert.equal(stuck.body, "Plyloft couldn't push it yet.");

// G8 fixes (m2): the poller finished it; the install step waits for the press.
const polled = { ...base, installLog: "", releaseKind: "push_only" as const, releasePr: { step: "tagged" as const, number: 12, url: null, waiting: null, released: true } };
const noStep = releasedByPollerWords({ cardCount: 1, result: polled, installScript: null, relaunches: false });
assert.equal(noStep.title, "v1.4.0 is released");
assert.equal(noStep.body, "Merged through its pull request #12, tagged on the merge. Commit 01234567.");
const withStep = releasedByPollerWords({ cardCount: 2, result: polled, installScript: "scripts/deploy.sh", relaunches: false });
assert.equal(withStep.title, "v1.4.0 is released");
assert.match(withStep.body, /Its install step \(scripts\/deploy\.sh\) hasn't run: Run the install step starts it\.$/);
assert.doesNotMatch(withStep.body, /is running in the background/);
const own = releasedByPollerWords({ cardCount: 1, result: polled, installScript: "scripts/install-local.sh", relaunches: true });
assert.match(own.body, /Run the install step builds it; Plyloft quits and relaunches then\.$/);

// 1.175.0 B2 (SEC-4): the install step waits for this Mac's OK — the
// release is done, the step hasn't run, and nothing relaunches.
{
  const held = shipDoneWords({ ...base, releaseKind: "local", installScript: "scripts/deploy-all.sh", relaunches: false }, 1, { who: "example-teammate" });
  assert.equal(held.title, "Shipped as v1.4.0");
  assert.equal(
    held.body,
    "Committed and tagged on this Mac. Its install step hasn't run: example-teammate changed it, so it needs your OK on this Mac. Commit 01234567.",
  );
  const selfHeld = shipDoneWords({ ...base, releaseKind: "local", installScript: "scripts/install-local.sh", relaunches: true }, 1, { who: "Someone" });
  assert.doesNotMatch(selfHeld.body, /quits|relaunch|running in the background/);
  const polledHeld = releasedByPollerWords({ cardCount: 1, result: polled, installScript: "scripts/deploy.sh", relaunches: false }, { who: "example-teammate" });
  assert.match(polledHeld.body, / Its install step hasn't run: example-teammate changed it, so it needs your OK on this Mac\.$/);
  assert.doesNotMatch(polledHeld.body, /Run the install step/);
}

// 1.171.0 A3 (DL-30): a land's go-live step relaunches only Plyloft.
assert.equal(goLiveWords({ fellBack: false }, false, "x"), "Merged — its install step is running in the background.");
assert.equal(goLiveWords({ fellBack: false, relaunches: true }, false, "x"), "Merged — rebuilding your app; it'll relaunch shortly.");
assert.equal(goLiveWords({ fellBack: true }, true, "x"), "No git remote — merged locally; its install step is running in the background.");
assert.equal(
  goLiveWords({ fellBack: false }, true, "Shipped to main on this Mac — not on GitHub yet."),
  "Shipped to main on this Mac — not on GitHub yet. Its install step is running in the background.",
);

console.log("shipDone.test.ts: ok");

// 1.173.0 (B4): an area's release says its own tag; without one, as before.
const site = shipDoneWords({ ...base, releaseKind: "local", installScript: null, relaunches: false, tag: "site-v1.4.0" });
assert.equal(site.title, "Shipped as site-v1.4.0");
const plainTag = shipDoneWords({ ...base, releaseKind: "local", installScript: null, relaunches: false, tag: "v1.4.0" });
assert.deepEqual(plainTag, other);

// TX5 (T29): a ship that runs nothing after it names the row that sets one.
// DS2 updates this pin: the path is the one its Shipping page gives the row
// (Settings › Shipping › After a release, run); keep it equal to that label.
assert.equal(
  NOTHING_RUNS_AFTER_SHIPPING,
  "Nothing runs after shipping in this project; Settings › Cards › Shipping › “After a release, run” sets one.",
);
assert.doesNotMatch(NOTHING_RUNS_AFTER_SHIPPING, /go-live/);
