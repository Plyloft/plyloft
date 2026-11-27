// Skills hub H10: My library's words. Run with:
//
//     node --experimental-strip-types src/lib/myLibrary.test.ts

import assert from "node:assert/strict";
import type { MyLibraryCompare, MyLibraryView } from "../ipc.ts";
import {
  compareWords,
  createLede,
  emptyLede,
  foundLine,
  librarySectionNote,
  notSetUpWords,
  statusIsCurrent,
  goneNotice,
  grantElsewhere,
  isAlreadyALibrary,
  signInNotice,
  isGrantRefusal,
  publishedToast,
  statusLine,
  whatReachesWhere,
} from "./myLibrary.ts";

const NOW = 1_760_000_000_000;
const MIN = 60_000;

function view(over: Partial<MyLibraryView> = {}): MyLibraryView {
  return {
    repo: "matteo/plyloft-skills",
    account: "matteo",
    hasClone: true,
    lastPullAt: NOW - 4 * MIN,
    lastAttemptAt: NOW - 4 * MIN,
    lastError: null,
    goneAt: null,
    defaultName: "plyloft-skills",
    accounts: [],
    plugin: "mine",
    ...over,
  };
}

// The sheet (R6, mockup 6a).
assert.equal(
  createLede("matteo", "plyloft-skills"),
  "My library keeps your own skills in a private repository on your GitHub account, so they reach your sessions on every Mac you sign in to. Plyloft creates matteo/plyloft-skills (private).",
);
assert.equal(
  whatReachesWhere(["sql-style", "my-review"]),
  "Your sessions on this Mac get sql-style and my-review from the next session, as mine:sql-style and mine:my-review, for Claude and Codex. On another computer, choose “Use it on this Mac”. Nobody else can read it.",
);
assert.ok(whatReachesWhere([]).includes("as mine:<name>"));

// The line.
assert.equal(statusLine(view(), NOW), "Updated 4 minutes ago");
assert.equal(statusLine(view({ lastError: "offline" }), NOW), "Last updated 4 minutes ago · offline");
assert.equal(statusLine(view({ hasClone: false }), NOW), "Not on this Mac yet.");
assert.equal(statusLine(view({ repo: null }), NOW), null);

// Gone (R6 edge, mockup 6b): the last copy keeps serving.
assert.equal(goneNotice(view(), NOW), null);
assert.equal(
  goneNotice(view({ goneAt: NOW, lastError: "gone", lastPullAt: NOW - 3 * 24 * 60 * MIN }), NOW),
  "Your My library matteo/plyloft-skills isn't reachable with the GitHub account matteo any more. Your sessions still get the copy from 3 days ago.",
);
assert.equal(statusLine(view({ goneAt: NOW, lastError: "gone" }), NOW), "Last updated 4 minutes ago · not reachable");
// A signed-out account is a sign-in problem, never "gone".
assert.equal(statusLine(view({ lastError: "signIn" }), NOW), "Last updated 4 minutes ago · matteo isn't signed in on this Mac");
assert.equal(goneNotice(view({ lastError: "signIn" }), NOW), null);
assert.ok(signInNotice(view({ lastError: "signIn" }))?.startsWith("My library uses the GitHub account matteo, which isn't signed in on this Mac."));
assert.equal(signInNotice(view()), null);
// Grant it refreshes gh's active account only.
const two = view({ accounts: [{ login: "matteo", active: true }, { login: "test", active: false }] });
assert.equal(grantElsewhere(two, "matteo"), null);
assert.ok(grantElsewhere(two, "test")?.includes("gh auth switch -h github.com -u test, then gh auth refresh -h github.com -s repo, then gh auth switch -h github.com -u matteo"));

// The refusals the sheet answers with a button.
assert.ok(isGrantRefusal("GitHub needs one more permission to create a private repository — Grant it, then try again."));
assert.ok(isAlreadyALibrary("`matteo/plyloft-skills` is already a My library. Use it on this Mac instead."));
assert.ok(!isGrantRefusal("anything else"));

// After a publish.
assert.equal(
  publishedToast({ kind: "published", skill: "my-review", commit: "abc" }),
  "my-review is in My library. New sessions get it as mine:my-review.",
);
assert.equal(publishedToast({ kind: "alreadyThere", skill: "x" }), "My library already has this version of x.");
// H10 Windows walk: a skill waiting for this computer's OK says so.
assert.equal(
  publishedToast({ kind: "published", skill: "pubw-check", commit: "abc", needsOk: true }),
  "pubw-check is in My library. It brings a script, so new sessions on this Mac get it as mine:pubw-check once you say OK — Review it on its page.",
);
assert.equal(publishedToast({ kind: "compare", compare: {} as MyLibraryCompare }), null);
// 1.176.4: a commit kept after a push the time limit stopped — the
// backend's words, calm, with its OK as a publish's.
const keptWords = "GitHub didn't answer in time while Plyloft was adding `k` to My library. It is kept in My library on this Mac, and may not be on GitHub yet: it goes there only when you add a skill to My library again and that push goes through.";
assert.equal(publishedToast({ kind: "kept", skill: "k", words: keptWords }), keptWords);
assert.equal(
  publishedToast({ kind: "kept", skill: "k", words: keptWords, needsOk: true }),
  `${keptWords} It brings a script, so new sessions on this Mac get it as mine:k once you say OK — Review it on its page.`,
);

// The compare (§14 Q4).
const compare: MyLibraryCompare = { skill: "sql-style", otherId: "1", otherAuthor: "matteo", otherAt: NOW - 2 * MIN, twoWay: false, files: [] };
assert.equal(compareWords(compare, NOW).title, "sql-style changed on another computer and on this Mac");
assert.ok(compareWords(compare, NOW).lede.includes("after this Mac last did"));
assert.ok(compareWords({ ...compare, twoWay: true }, NOW).lede.includes("never published one before"));


// ── 1.174.0 (X3): My library in a project's Library ──────────────────────
assert.equal(
  emptyLede(),
  "Keep your own skills in a private repository on your GitHub account. They reach your sessions on every Mac you use, as mine:<name>.",
);
assert.equal(foundLine("matteo/plyloft-skills"), "Your My library matteo/plyloft-skills is on GitHub — use it on this Mac.");
assert.equal(notSetUpWords(), "not set up on this Mac");
assert.equal(
  librarySectionNote("matteo/plyloft-skills"),
  "Yours alone, from your private repository matteo/plyloft-skills. Sessions get them as mine:<name>. Add, change or remove them in All skills.",
);
assert.equal(
  librarySectionNote("matteo/plyloft-skills", "mine-matteo"),
  "Yours alone, from your private repository matteo/plyloft-skills. Sessions get them as mine-matteo:<name>. Add, change or remove them in All skills.",
);
// Green only for "Updated…" (the colour is on the dot).
assert.equal(statusIsCurrent(statusLine(view(), NOW)), true);
assert.equal(statusIsCurrent(statusLine(view({ lastError: "offline" }), NOW)), false);
assert.equal(statusIsCurrent(statusLine(view({ hasClone: false }), NOW)), false);
assert.equal(statusIsCurrent(null), false);

console.log("myLibrary contracts: ok");
