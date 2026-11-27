// UX language card 5 (GH #100): `Keep both` — the mute key and its expiry. Run:
//
//     node --experimental-strip-types src/lib/libraryMute.test.ts

import assert from "node:assert/strict";
import {
  contentId,
  isSilenced,
  orderedContents,
  scopePairKey,
  silencedRecord,
  withSilenced,
  type DuplicateIdentity,
  type SilencedDuplicate,
} from "./libraryMute.ts";

const HERE = "---\ndescription: Ships a release.\n---\n\nRun the tests.\n";
const THERE = "---\ndescription: Ships a release.\n---\n\nRun the tests twice.\n";

const identity = (over: Partial<DuplicateIdentity> = {}): DuplicateIdentity => ({
  here: "repository",
  there: "team",
  name: "deploy",
  hereContent: contentId(HERE),
  thereContent: contentId(THERE),
  ...over,
});

// ── The content id ───────────────────────────────────────────────────────

assert.equal(contentId(HERE), contentId(HERE), "the same bytes give the same id");
assert.notEqual(contentId(HERE), contentId(THERE), "different bytes differ");
// The edits a skill actually receives, each of which must change the id — this
// is the whole expiry mechanism.
assert.notEqual(contentId("a\nb\n"), contentId("a\nb"), "a trailing newline is a change");
assert.notEqual(contentId("a\nb\n"), contentId("b\na\n"), "reordered lines are a change");
assert.notEqual(contentId("deploy"), contentId("Deploy"), "case is a change");
assert.notEqual(contentId("a"), contentId("a "), "trailing space is a change");
assert.equal(contentId(""), contentId(""), "an empty file has an id of its own");
assert.notEqual(contentId(""), contentId(" "));
// An id is a short printable string: it goes into settings.json as a key part.
assert.match(contentId(HERE), /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]+$/);

// ── The pair key: one record, whichever side silenced it ─────────────────

assert.equal(scopePairKey("repository", "team"), "repository|team");
assert.equal(
  scopePairKey("team", "repository"),
  scopePairKey("repository", "team"),
  "the pair is the same pair from either side",
);
assert.equal(scopePairKey("repository", "this-mac"), "repository|this-mac");
assert.equal(scopePairKey("ply", "this-mac"), "ply|this-mac");

// And the two ids follow the sorted order, so the same two copies produce the
// same record from either page.
assert.deepEqual(orderedContents("repository", "L", "team", "R"), ["L", "R"]);
assert.deepEqual(orderedContents("team", "R", "repository", "L"), ["L", "R"]);
assert.deepEqual(
  silencedRecord(identity()),
  silencedRecord(
    identity({
      here: "team",
      there: "repository",
      hereContent: contentId(THERE),
      thereContent: contentId(HERE),
    }),
  ),
  "silencing from the team's page is the same record as from the repository's",
);
assert.deepEqual(silencedRecord(identity()), {
  scopes: "repository|team",
  name: "deploy",
  contents: [contentId(HERE), contentId(THERE)],
});

// ── Silenced, and not ────────────────────────────────────────────────────

assert.equal(isSilenced([], identity()), false, "nothing silenced to begin with");

const after = withSilenced([], identity());
assert.equal(after.length, 1);
assert.equal(isSilenced(after, identity()), true, "the notice is quiet");
// From the other side too — it is one notice about one pair.
assert.equal(
  isSilenced(
    after,
    identity({
      here: "team",
      there: "repository",
      hereContent: contentId(THERE),
      thereContent: contentId(HERE),
    }),
  ),
  true,
);

// Another name, and another pair, are other notices.
assert.equal(isSilenced(after, identity({ name: "verify" })), false);
assert.equal(
  isSilenced(after, identity({ there: "this-mac" })),
  false,
  "the repository/this-mac notice is not the repository/team one",
);

// ── The expiry: either copy changing brings it back ──────────────────────

assert.equal(
  isSilenced(after, identity({ hereContent: contentId(`${HERE}One more line.\n`) })),
  false,
  "this copy changed, so the notice returns",
);
assert.equal(
  isSilenced(after, identity({ thereContent: contentId(`${THERE}One more line.\n`) })),
  false,
  "the other copy changed, so the notice returns",
);
assert.equal(
  isSilenced(
    after,
    identity({
      hereContent: contentId(`${HERE}x`),
      thereContent: contentId(`${THERE}x`),
    }),
  ),
  false,
  "both changed",
);
// A record whose contents were truncated by a hand-edited settings.json does
// not silence anything: a half-record is not a match.
assert.equal(
  isSilenced(
    [{ scopes: "repository|team", name: "deploy", contents: [contentId(HERE)] }],
    identity(),
  ),
  false,
);
assert.equal(
  isSilenced([{ scopes: "repository|team", name: "deploy", contents: [] }], identity()),
  false,
  "an empty contents list is not a silence-everything wildcard",
);

// Silencing again after an edit replaces the pair's record rather than adding a
// second one, and the new ids are the ones that count.
{
  const edited = identity({ hereContent: contentId(`${HERE}Now with a step.\n`) });
  const again = withSilenced(after, edited);
  assert.equal(again.length, 1, "one record per pair and name");
  assert.equal(isSilenced(again, edited), true);
  assert.equal(isSilenced(again, identity()), false, "the old bytes are not silenced");
}

// Other pairs and other names are left exactly as they were, in order.
{
  const others: SilencedDuplicate[] = [
    { scopes: "repository|this-mac", name: "captions", contents: ["a", "b"] },
    { scopes: "repository|team", name: "verify", contents: ["c", "d"] },
  ];
  const next = withSilenced(others, identity());
  assert.deepEqual(next.slice(0, 2), others, "the rest keeps its order and its bytes");
  assert.equal(next.length, 3);
  assert.equal(isSilenced(next, identity()), true);
  for (const kept of others) {
    assert.ok(
      next.some((record) => record.name === kept.name && record.scopes === kept.scopes),
    );
  }
}

// A pair already in the list is replaced **where it stands**, not moved to the
// end: the diff in settings.json should be the one line that changed (review 1 —
// the doc said the order was kept and the code appended).
{
  const before: SilencedDuplicate[] = [
    { scopes: "repository|this-mac", name: "captions", contents: ["a", "b"] },
    { scopes: "repository|team", name: "deploy", contents: ["stale", "bytes"] },
    { scopes: "repository|team", name: "verify", contents: ["c", "d"] },
  ];
  const next = withSilenced(before, identity());
  assert.deepEqual(
    next.map((record) => `${record.scopes}/${record.name}`),
    before.map((record) => `${record.scopes}/${record.name}`),
    "the order is exactly the order it was",
  );
  assert.equal(next.length, 3, "and no row was added");
  assert.deepEqual(next[1].contents, [contentId(HERE), contentId(THERE)]);
  assert.deepEqual(next[0], before[0]);
  assert.deepEqual(next[2], before[2]);
  assert.equal(isSilenced(next, identity()), true);
}

// The input is never mutated: it is the settings snapshot the store holds.
{
  const before: SilencedDuplicate[] = [
    { scopes: "repository|team", name: "deploy", contents: ["a", "b"] },
  ];
  const copy = JSON.parse(JSON.stringify(before));
  withSilenced(before, identity());
  assert.deepEqual(before, copy);
}

console.log("libraryMute: ok");
