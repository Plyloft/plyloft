// Unit tests for read-only collaborators and the shared library words
// (src/lib/sharedLibrary.ts, GH #82).
//
// Run: node --experimental-strip-types src/lib/sharedLibrary.test.ts

import assert from "node:assert/strict";
import {
  agoWords,
  claudeFromBranch,
  definitionEditable,
  formatDay,
  libraryToasts,
  deletionToast,
  pendingChip,
  pendingRemovals,
  projectNoteInput,
  promotionInvalidations,
  readOnlyLine,
  sharedProjectNote,
  skillShareAction,
  skippedLines,
  SKILL_NEVER_OVERRIDE_MARKER,
  type LibraryReportLike,
  type LibraryStateLike,
} from "./sharedLibrary.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  void name;
}

const SEP_16 = Date.UTC(2026, 8, 16, 10, 0, 0) / 1000;

test("permission read → fields read-only with the explanation line", () => {
  const view = {
    readOnly: true,
    effective: { name: "LYRA" },
    provenance: { verifyPipeline: { author: "test-owner", changedAt: SEP_16 } },
    cache: { author: "someone-else" },
  };
  assert.equal(definitionEditable(view), false);
  assert.equal(
    readOnlyLine(view, "verifyPipeline"),
    "Set in the project by test-owner on 16 Sep 2026; ask for write access to change it.",
  );
  // A field older than the history Ply reads falls back to the file's author.
  assert.equal(
    readOnlyLine(view, "name"),
    "Set in the project by someone-else; ask for write access to change it.",
  );
});

test("permission write → editable, no line", () => {
  const view = { readOnly: false, effective: { name: "LYRA" }, provenance: {}, cache: { author: "a" } };
  assert.equal(definitionEditable(view), true);
  assert.equal(readOnlyLine(view, "name"), null);
  assert.equal(formatDay(SEP_16), "16 Sep 2026");
});

const state = (over: Partial<LibraryStateLike> = {}): LibraryStateLike => ({
  shared: true,
  branch: "staging",
  readOnly: false,
  repository: "o/lyra",
  pending: [],
  branchSkills: [],
  ...over,
});

test("Shared · Project explains write access to a read-only collaborator", () => {
  const ro = sharedProjectNote(state({ readOnly: true }));
  assert.equal(ro.canWrite, false);
  assert.match(ro.line!, /needs write access to o\/lyra/);
  const rw = sharedProjectNote(state());
  assert.equal(rw.canWrite, true);
  assert.match(rw.line!, /committed to staging/);
  // Not shared: the checkout, no line.
  assert.deepEqual(sharedProjectNote(state({ shared: false })), { canWrite: true, line: null });
  assert.deepEqual(sharedProjectNote(null), { canWrite: true, line: null });
});

test("pending chips", () => {
  const s = state({
    pending: [
      { kind: "knowledge", name: "auth", title: "Auth", removed: false, lastError: null, pullRequest: null },
      { kind: "skill", name: "deploy", title: "deploy", removed: false, lastError: null, pullRequest: { number: 7, url: "u" } },
    ],
  });
  assert.equal(pendingChip(s, "knowledge", "auth"), "Pending sync");
  assert.equal(pendingChip(s, "skill", "deploy"), "Waiting for PR #7 to merge");
  assert.equal(pendingChip(s, "knowledge", "deploy"), null);
});

test("a queued deletion stays visible until it is published", () => {
  const s = state({
    pending: [
      { kind: "knowledge", name: "auth", title: "Auth", removed: true, lastError: "offline", pullRequest: null },
      { kind: "knowledge", name: "kept", title: "Kept", removed: true, lastError: null, pullRequest: { number: 3, url: "u" } },
      { kind: "knowledge", name: "edit", title: "Edit", removed: false, lastError: null, pullRequest: null },
      { kind: "skill", name: "deploy", title: "deploy", removed: true, lastError: null, pullRequest: null },
    ],
  });
  assert.deepEqual(pendingRemovals(s, "knowledge", ["edit"]), [
    { name: "auth", title: "Auth", label: "Removal pending sync", lastError: "offline" },
    { name: "kept", title: "Kept", label: "Removal waiting for PR #3 to merge", lastError: null },
  ]);
  // A listed item carries its chip on its own row instead.
  assert.equal(pendingRemovals(s, "knowledge", ["auth", "kept"]).length, 0);
  assert.equal(pendingChip(s, "skill", "deploy"), "Removal pending sync");
  assert.equal(pendingRemovals(s, "skill", []).length, 1);
  assert.equal(pendingRemovals(state({ shared: false }), "knowledge", []).length, 0);
  // Not "deleted": teammates still have it.
  const toast = deletionToast(s, "Auth");
  assert.equal(toast.title, "Deleting shared note");
  assert.match(toast.body, /being removed from staging/);
  assert.equal(deletionToast(state({ shared: false }), "Auth").title, "Shared note deleted");
});

const report = (over: Partial<LibraryReportLike> = {}): LibraryReportLike => ({
  branch: "staging",
  updates: [],
  published: [],
  pullRequests: [],
  closed: [],
  pending: [],
  error: null,
  offline: false,
  refused: null,
  ...over,
});

test("the age words: just now, minutes, hours, days, weeks (GH #144)", () => {
  // BOARDS.md §3's own number, and every boundary on the way to it. Pure: it
  // takes a number of seconds, so there is no clock in here to make it flake.
  const MINUTE = 60;
  const HOUR = 3600;
  const DAY = 86_400;
  const WEEK = 7 * DAY;
  assert.equal(agoWords(0), "just now");
  assert.equal(agoWords(30), "just now");
  assert.equal(agoWords(MINUTE - 1), "just now", "under a minute is not `0 minutes ago`");
  assert.equal(agoWords(MINUTE), "1 minute ago");
  assert.equal(agoWords(119), "1 minute ago");
  assert.equal(agoWords(2 * MINUTE), "2 minutes ago");
  assert.equal(agoWords(HOUR - 1), "59 minutes ago");
  assert.equal(agoWords(HOUR), "1 hour ago");
  // The board's line.
  assert.equal(agoWords(2 * HOUR), "2 hours ago");
  assert.equal(agoWords(DAY - 1), "23 hours ago");
  assert.equal(agoWords(DAY), "1 day ago");
  assert.equal(agoWords(3 * DAY), "3 days ago");
  assert.equal(agoWords(WEEK - 1), "6 days ago");
  assert.equal(agoWords(WEEK), "1 week ago");
  assert.equal(agoWords(5 * WEEK), "5 weeks ago");
  // A branch clock ahead of this Mac's is not a minus sign.
  assert.equal(agoWords(-600), "just now");
});

test("refresh picks up a note added upstream: toast with the author", () => {
  const toasts = libraryToasts({
    moment: "periodic",
    library: report({
      updates: [
        { kind: "knowledge", name: "auth-flow", title: "Auth flow", action: "added", author: "other-mac" },
        { kind: "skill", name: "deploy", title: "deploy", action: "added", author: "other-mac" },
      ],
    }),
  });
  assert.equal(toasts.length, 2);
  assert.equal(toasts[0].title, "other-mac added the note “Auth flow”");
  assert.match(toasts[0].body!, /From staging/);
  assert.equal(toasts[1].title, "other-mac added the skill deploy");
  // Many at once: one toast.
  const many = libraryToasts({
    moment: "periodic",
    library: report({
      updates: [1, 2, 3, 4].map((n) => ({
        kind: "knowledge" as const, name: `n${n}`, title: `N${n}`, action: "changed", author: "other-mac",
      })),
    }),
  });
  assert.equal(many.length, 1);
  assert.equal(many[0].title, "other-mac changed 4 shared notes and skills");
});

test("an upstream change says when it landed, and reads without one (GH #144)", () => {
  const NOW_MS = Date.UTC(2026, 8, 22, 12, 0, 0);
  const secsAgo = (secs: number) => Math.floor(NOW_MS / 1000) - secs;
  const withAge = libraryToasts(
    {
      moment: "periodic",
      library: report({
        updates: [
          { kind: "skill", name: "deploy", title: "deploy", action: "removed", author: "MatteoB-adv", changedAt: secsAgo(2 * 3600) },
          { kind: "knowledge", name: "auth-flow", title: "Auth flow", action: "added", author: "other-mac", changedAt: secsAgo(3 * 86_400) },
          { kind: "instructions", name: "AGENTS.md", title: "AGENTS.md", action: "changed", author: "other-mac", changedAt: secsAgo(45 * 60) },
        ],
      }),
    },
    NOW_MS,
  );
  assert.equal(
    withAge[0].body,
    "From staging, 2 hours ago. New Claude tiles no longer load it from the branch.",
  );
  assert.equal(
    withAge[1].body,
    "From staging, 3 days ago. It is in Knowledge › Shared · Project.",
  );
  assert.equal(
    withAge[2].body,
    "From staging, 45 minutes ago. Once your project folder has it, the agents here read it too — Ask the Builder to bring it here.",
  );
  // A report from a build that predates the field, or a commit git had no time
  // for: the body is exactly what it was before this card.
  const without = libraryToasts(
    {
      moment: "periodic",
      library: report({
        updates: [
          { kind: "skill", name: "deploy", title: "deploy", action: "removed", author: "MatteoB-adv" },
          { kind: "knowledge", name: "a", title: "A", action: "added", author: "x", changedAt: null },
        ],
      }),
    },
    NOW_MS,
  );
  assert.equal(
    without[0].body,
    "From staging. New Claude tiles no longer load it from the branch.",
  );
  assert.equal(without[1].body, "From staging. It is in Knowledge › Shared · Project.");
});

test("publish, override, PR, closed, refused and offline toasts", () => {
  const published = libraryToasts({
    moment: "publish",
    library: report({
      published: [{ kind: "knowledge", name: "a", title: "Auth", removed: false, over: { author: "other-mac", changedAt: 1 } }],
    }),
  });
  assert.equal(published[0].title, "Published the note “Auth” to staging");
  assert.match(published[0].body!, /Replaced other-mac’s version/);
  assert.equal(published[0].kind, "warn");
  const removed = libraryToasts({
    moment: "publish",
    library: report({ published: [{ kind: "skill", name: "d", title: "d", removed: true, over: null }] }),
  });
  assert.equal(removed[0].title, "Removed the skill d from staging");
  // GH #101: an instructions publish says what it published, not its subject as
  // a name; an upstream change to one names the file that changed.
  const instructions = libraryToasts({
    moment: "publish",
    library: report({
      published: [
        { kind: "instructions", name: "AGENTS.md", title: "both CLIs read AGENTS.md", removed: false, over: null },
      ],
    }),
  });
  assert.equal(instructions[0].title, "Published the instructions to staging");
  const upstream = libraryToasts({
    moment: "periodic",
    library: report({
      updates: [
        { kind: "instructions", name: "AGENTS.md", title: "AGENTS.md", action: "changed", author: "other-mac" },
      ],
    }),
  });
  assert.equal(upstream[0].title, "other-mac changed AGENTS.md");
  assert.match(upstream[0].body!, /Once your project folder has it, the agents here read it too — Ask the Builder to bring it here\./);
  assert.ok(!/next Sync/.test(upstream[0].body!), "a Sync does not deliver it");
  // GH #101 review 2 (MAJOR): a blocked instructions publish is its own toast.
  // It used to fall through to `Shared note or skill not published yet` with
  // "It stays pending and is retried on the next Sync" — the wrong noun, and the
  // retry promise the row had already dropped.
  const BLOCKED =
    "AGENTS.md changed on staging since this edit began (other-mac changed it 2 min ago). " +
    "Plyloft doesn't commit over an instruction file, and the GitHub CLI isn't available to open a " +
    "pull request instead — nothing was changed, on staging or here.";
  const blocked = libraryToasts({
    moment: "publish",
    library: report({ blocked: BLOCKED, error: BLOCKED, pendingKinds: ["instructions"] }),
  });
  assert.equal(blocked.length, 1, JSON.stringify(blocked));
  assert.equal(blocked[0].title, "The instructions weren’t published");
  assert.equal(blocked[0].body, BLOCKED, "the backend's sentence, whole");
  assert.ok(!/retried on the next Sync/.test(blocked[0].body!));
  assert.ok(!/note or skill/.test(blocked[0].title));
  // Off the publish moment it says nothing: the row carries the state.
  assert.equal(
    libraryToasts({ moment: "periodic", library: report({ blocked: BLOCKED, error: BLOCKED }) }).length,
    0,
  );
  // An ordinary error is untouched, and still promises the retry it really gets.
  const ordinary = libraryToasts({
    moment: "publish",
    library: report({ error: "the tree could not be written" }),
  });
  assert.equal(ordinary[0].title, "Shared note or skill not published yet");
  assert.match(ordinary[0].body!, /retried on the next Sync/);
  // F3/F9 (team walk): a branch origin lacks is said as such, never as offline
  // and never as success.
  const MISSING =
    "staging isn't on GitHub any more. Choose where cards go in Settings › Cards › Shipping.";
  const missing = libraryToasts({
    moment: "publish",
    library: report({ error: MISSING, offline: false }),
  });
  assert.equal(missing.length, 1, JSON.stringify(missing));
  assert.equal(missing[0].kind, "warn");
  assert.equal(missing[0].title, "Not published — staging isn't on GitHub");
  assert.ok(missing[0].body!.startsWith(MISSING), missing[0].body);
  const pr = libraryToasts({
    moment: "sync",
    library: report({
      pullRequests: [
        {
          kind: "knowledge",
          title: "Auth",
          pullRequest: { number: 9, url: "u" },
          reason: "staging refused the push",
        },
      ],
    }),
  });
  assert.equal(pr[0].title, "Waiting for PR #9 to merge");
  const closed = libraryToasts({ moment: "sync", library: report({ closed: ["Auth"] }) });
  assert.match(closed[0].body!, /dropped/);
  // GH #102: the read-only refusal is a block on the Library page now
  // (`publishRefusedError`, announced once by `announceError`), so nothing is
  // toasted here — not even the `error` that came with it, which is the same
  // sentence said twice.
  const refused = libraryToasts({ moment: "publish", library: report({ refused: "staging refused the push", error: "x" }) });
  assert.deepEqual(refused, []);
  assert.equal(libraryToasts({ moment: "publish", library: report({ error: "offline", offline: true }) }).length, 0);
  assert.equal(libraryToasts({ moment: "periodic", library: null }).length, 0);
});

// GH #160: a pull-request outcome for the instructions raises one toast that
// names them, says where the change waits in the backend's own words, and carries
// the pull request the caller turns into `Open pull request`. The direct commit's
// half of the pair is `Published the instructions to staging`, above.
test("a pull request the instructions wait in is announced, once, with its reason", () => {
  const waiting = (
    kind: LibraryReportLike["pullRequests"][number]["kind"],
    over = true,
  ) =>
    libraryToasts({
      moment: "publish",
      library: report({
        pullRequests: [
          {
            kind,
            title: kind === "instructions" ? "both CLIs read AGENTS.md" : "deploy",
            pullRequest: { number: 375, url: "https://github.com/o/r/pull/375" },
            reason: over
              ? "AGENTS.md changed on staging since this edit began (MatteoB-adv changed it 2 hours ago)."
              : "remote: error: GH006 Protected branch update failed for refs/heads/staging",
            neverOverride: over,
          },
        ],
      }),
    });

  const instructions = waiting("instructions");
  assert.equal(instructions.length, 1, "one toast for one outcome");
  assert.equal(
    instructions[0].title,
    "The instructions wait in pull request #375",
  );
  // The backend's sentence, not a reason the window made up: the never-override
  // case is not "the branch refused a direct push" — the branch was never asked.
  assert.match(instructions[0].body!, /^AGENTS\.md changed on staging since this edit began/);
  assert.ok(!/refused a direct push/.test(instructions[0].body!));
  assert.match(instructions[0].body!, /your project folder is untouched/);
  assert.deepEqual(instructions[0].pullRequest, {
    number: 375,
    url: "https://github.com/o/r/pull/375",
  });

  // Review 1 (MAJOR): `reason` is a sentence only for the never-override outcome.
  // A refused push — a protected `staging`, the common team setup — puts git's
  // stderr in it, and that belongs in the pull request's body and the log.
  const refused = waiting("instructions", false);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].title, "The instructions wait in pull request #375");
  assert.equal(
    refused[0].body,
    "staging refused a direct push, so the instructions wait in a pull request. They reach everyone once that is merged; your project folder is untouched.",
  );
  assert.ok(!/GH006|remote:/.test(refused[0].body!), refused[0].body);
  assert.deepEqual(refused[0].pullRequest, {
    number: 375,
    url: "https://github.com/o/r/pull/375",
  });

  // A skill's toast is exactly as it was, and carries no action of its own.
  const skill = waiting("skill", false);
  assert.equal(skill.length, 1);
  assert.equal(skill[0].title, "Waiting for PR #375 to merge");
  assert.equal(
    skill[0].body,
    "staging refused a direct push, so \u201cdeploy\u201d waits in a pull request.",
  );
  assert.equal(skill[0].pullRequest, undefined);

  // Skills group B §2: a skill somebody changed upstream waits in a pull request
  // the branch was never asked about — its toast says so in the backend's words,
  // and offers the pull request.
  const moved = libraryToasts({
    moment: "publish",
    library: report({
      pullRequests: [
        {
          kind: "skill",
          title: "deploy",
          pullRequest: { number: 376, url: "https://github.com/o/r/pull/376" },
          reason: "deploy changed on staging since this change began (`.claude/skills/deploy`; other-mac changed it 2 min ago).",
          neverOverride: true,
        },
      ],
    }),
  });
  assert.equal(moved.length, 1);
  assert.equal(moved[0].title, "“deploy” waits in pull request #376");
  assert.match(moved[0].body!, /^deploy changed on staging since this change began/);
  assert.ok(!/refused a direct push/.test(moved[0].body!));
  assert.deepEqual(moved[0].pullRequest, { number: 376, url: "https://github.com/o/r/pull/376" });

  // …and its dead end has its own noun.
  const SKILL_BLOCKED =
    "deploy changed on staging since this change began (other-mac changed it 2 min ago). " +
    `${SKILL_NEVER_OVERRIDE_MARKER}, and the GitHub CLI isn't available to open a pull request instead — nothing was changed, on staging or here.`;
  const blocked = libraryToasts({
    moment: "publish",
    library: report({ blocked: SKILL_BLOCKED, error: SKILL_BLOCKED, pendingKinds: ["skill"] }),
  });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].title, "The skill wasn’t published");
  assert.equal(blocked[0].body, SKILL_BLOCKED);
});

test("skill row actions", () => {
  assert.deepEqual(skillShareAction(null, "x", true), {
    publish: false, remove: false, onBranch: false, disabledReason: null,
  });
  const s = state({ branchSkills: ["deploy"] });
  assert.deepEqual(skillShareAction(s, "deploy", true), {
    publish: true, remove: true, onBranch: true, disabledReason: null,
  });
  assert.equal(skillShareAction(s, "local", true).remove, false);
  assert.match(
    skillShareAction(state({ readOnly: true }), "local", true).disabledReason!,
    /write access to o\/lyra/,
  );
});

test("a new Shared · Project note is sent without an id", () => {
  // The editor's blank draft (EMPTY_DRAFT) has id "".
  assert.deepEqual(projectNoteInput({ id: "", title: " Auth ", body: "b", tags: [" x ", ""] }), {
    id: null,
    title: "Auth",
    body: "b",
    tags: ["x"],
  });
  assert.equal(projectNoteInput({ title: "A", body: "", tags: [] }).id, null);
  assert.equal(projectNoteInput({ id: "n1", title: "A", body: "", tags: [] }).id, "n1");
});

test("a symlink the branch carries is said, per panel", () => {
  const s = state({
    skipped: [
      ".claude/skills/linked contains a symlink",
      // GH #105: a skill is one item in two roots, and either half can be the
      // one with the symlink in it.
      ".agents/skills/linked-codex contains a symlink",
      ".atelier/library/knowledge/link.md is a symlink",
    ],
  });
  assert.deepEqual(skippedLines(s, "skill"), [
    "Not loaded from staging: .claude/skills/linked contains a symlink — Plyloft doesn’t copy symlinks.",
    "Not loaded from staging: .agents/skills/linked-codex contains a symlink — Plyloft doesn’t copy symlinks.",
  ]);
  assert.equal(skippedLines(s, "knowledge").length, 1);
  assert.equal(skippedLines(state(), "skill").length, 0);
});

test("copies the branch would not take are one toast that counts them", () => {
  // GH #105 review 2: one per reason meant 34 toasts for one bulk copy.
  const one = libraryToasts({
    moment: "publish",
    library: report({ notCopied: ["`deploy` is not on staging yet."] }),
  });
  assert.equal(one.length, 1);
  assert.equal(one[0].title, "One skill was left as it is");
  assert.equal(one[0].kind, "warn");
  assert.match(one[0].body!, /deploy/);
  const many = libraryToasts({
    moment: "publish",
    library: report({
      notCopied: ["`a` is not on staging yet.", "`b` is not the same file.", "`c` holds a symlink."],
    }),
  });
  assert.equal(many.length, 1);
  assert.equal(many[0].title, "3 skills were left as they are");
  for (const name of ["`a`", "`b`", "`c`"]) {
    assert.ok(many[0].body!.includes(name), many[0].body);
  }
});

test("one commit that carried several skills is one toast that counts them", () => {
  // GH #105: a bulk `Make all available to both` is one commit, and its title is
  // already a count — "the skill 34 skills for Claude and Codex" would say the
  // opposite of what happened.
  const bulk = libraryToasts({
    moment: "publish",
    library: report({
      published: [
        {
          kind: "skill",
          name: "deploy",
          title: "34 skills for Claude and Codex",
          count: 34,
          removed: false,
          over: null,
        },
      ],
    }),
  });
  assert.equal(bulk[0].title, "Published 34 skills to staging");
  // One skill still reads as one skill, with or without the count.
  const one = libraryToasts({
    moment: "publish",
    library: report({
      published: [
        { kind: "skill", name: "deploy", title: "deploy for Claude and Codex", count: 1, removed: false, over: null },
      ],
    }),
  });
  assert.equal(one[0].title, "Published the skill deploy for Claude and Codex to staging");

  // GH #105 review 2: a group of 34 that carried **one** has count 1, so the
  // title must be that skill's name and not the group's own counted title —
  // "Published the skill 34 skills for Claude and Codex" said two numbers at once.
  const partial = libraryToasts({
    moment: "publish",
    library: report({
      published: [
        { kind: "skill", name: "deploy", title: "deploy", count: 1, removed: false, over: null },
      ],
    }),
  });
  assert.equal(partial[0].title, "Published the skill deploy to staging");
});

test("settled promotions reload the personal slices they came from", () => {
  assert.deepEqual(
    promotionInvalidations({
      library: report({
        promoted: [
          { workspaceId: null, id: "a", updatedAt: "t" },
          { workspaceId: "ws-1", id: "b", updatedAt: "t" },
          { workspaceId: null, id: "c", updatedAt: "t" },
        ],
      }),
    }),
    [
      { scope: "global", workspaceId: null },
      { scope: "workspace", workspaceId: "ws-1" },
    ],
  );
  assert.deepEqual(promotionInvalidations({ library: report() }), []);
  assert.deepEqual(promotionInvalidations({}), []);
});

test("an upstream removal says the item is gone, not that it loads", () => {
  const toasts = libraryToasts({
    moment: "periodic",
    library: report({
      updates: [
        { kind: "knowledge", name: "auth", title: "Auth", action: "removed", author: "other-mac" },
        { kind: "skill", name: "deploy", title: "deploy", action: "removed", author: "other-mac" },
        { kind: "skill", name: "lint", title: "lint", action: "changed", author: "other-mac" },
      ],
    }),
  });
  assert.equal(toasts[0].title, "other-mac removed the note “Auth”");
  assert.equal(toasts[0].body, "From staging. It is no longer in Knowledge › Shared · Project.");
  assert.equal(toasts[1].body, "From staging. New Claude tiles no longer load it from the branch.");
  assert.doesNotMatch(toasts[0].body!, /It is in/);
  assert.equal(toasts[2].body, "From staging. New Claude tiles load it.");
});

test("a branch skill lights Claude for a row with only a Codex copy", () => {
  const s = state({ branchSkills: ["deploy"], suppliedToCheckout: ["deploy"] });
  assert.equal(
    claudeFromBranch(s, "deploy", false),
    "Claude loads this skill from staging through Plyloft, as project:deploy",
  );
  assert.equal(claudeFromBranch(s, "other", false), null);
  assert.equal(
    claudeFromBranch(state({ shared: false, branchSkills: ["deploy"], suppliedToCheckout: ["deploy"] }), "deploy", false),
    null,
  );
  // Publishing stays tied to the checkout's Claude copy.
  assert.equal(skillShareAction(s, "deploy", false).publish, false);
});

test("an updated branch skill is shown beside an older checkout copy", () => {
  // A teammate updated `deploy`: the checkout's copy differs, and Ply
  // supplies the branch's as project:deploy.
  const updated = state({ branchSkills: ["deploy"], suppliedToCheckout: ["deploy"] });
  assert.equal(
    claudeFromBranch(updated, "deploy", true),
    "staging's version differs from your project folder's copy: Claude also gets it through Plyloft, as project:deploy",
  );
  // The same copy: the checkout's own speaks for itself.
  const same = state({ branchSkills: ["deploy"], suppliedToCheckout: [] });
  assert.equal(claudeFromBranch(same, "deploy", true), null);
});

console.log(`sharedLibrary: ${passed}/19 passed`);
