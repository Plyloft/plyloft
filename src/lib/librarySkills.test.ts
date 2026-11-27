// UX language card 4 (GH #96): the Library › Skills view model. Run with:
//
//     node --experimental-strip-types src/lib/librarySkills.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  IN_FOLDER_ONLY_LINE,
  OPEN_CARD_LABEL,
  SHIP_WITH_CARD_LABEL,
  COPY_TO_LABEL,
  compareLinkLabel,
  copyToOffered,
  withCopyTo,
  ALIGN_LABEL,
  TWINS_DIFFER_LINE,
  UNCOMMITTED_TWINS_LINE,
  isAlignFirst,
  isSignInRefusal,
  SIGN_IN_MARKER,
  legacyTwinLine,
  twinsFollowLine,
  COMPARE_REACH_LABEL,
  COMPARE_THIS_SIDE,
  DIFFERS_CHIP,
  MAKE_ALL_BOTH_LABEL,
  MAKE_BOTH_LABEL,
  MARK_LABEL,
  MIRROR_STATUS,
  PERSONAL_BESIDE,
  PERSONAL_READING_FOOTER,
  PERSONAL_STATUS,
  PERSONAL_STATUS_SOLO,
  PLY_FACT,
  PLY_PLUGIN,
  PLY_STATUS,
  PLY_SWITCH_GROUP,
  PLY_SWITCH_HINT,
  PLY_SWITCH_LABEL,
  SCOPE_PLACE,
  SECTION_MEANING,
  SECTION_TITLE,
  SKILLS_LEDE,
  SCOPE_NAV_ORDER,
  SKILL_SCOPES,
  THIS_MAC_NOTE,
  THIS_MAC_NOTE_SOLO,
  SHARE_WITH_TEAM_LABEL,
  sectionCount,
  plyStatus,
  compareSkillText,
  compareSummary,
  crossScopeDuplicates,
  duplicateChip,
  filterPlaceholder,
  filterSkillRows,
  plySectionProblem,
  fileListCutLine,
  fileListShort,
  NO_CUT,
  ignoredSkillRoots,
  ignoredRootsLine,
  PLY_RETRY_LABEL,
  firstSentence,
  oneCliLine,
  scopeCounts,
  skillMenu,
  unpublishConfirmBody,
  unpublishToastBody,
  alreadyCurrentToast,
  alignedOnBranchLine,
  checkoutBehindLine,
  branchIdOf,
  publishToastBody,
  ShownBranchIds,
  branchReachOf,
  skillNotes,
  teamCodexNotes,
  teamRows,
  needsOkLine,
  linkedNeedsOkLine,
  refusedNotes,
  REVIEW_SCRIPTS_ACTION,
  skillSections,
  reachingDuplicates,
  skillTransient,
  changedAgo,
  duplicatePairKey,
  shareComparisons,
  shareTarget,
  shareTargetKey,
  COMPLETE_IN_TEAM_LABEL,
  REPLACE_IN_TEAM_LABEL,
  SHARE_LABEL,
  personalStatus,
  type TeamSkillInput,
  livePairKeys,
  pruneSilencedDuplicates,
  prunedSilencedIn,
  silencedPairKeys,
  identicalPairKeys,
  compareActions,
  driftSentence,
  makeAllBoth,
  reachCompareActions,
  detailsHistoryLine,
  detailsStamp,
  fileCountWords,
  duplicateSentence,
  lastChangedWords,
  reachWords,
  skillBody,
  skillPage,
  type MenuFacts,
  type SkillMenuEntry,
  type SkillPageInput,
  type SkillPageModel,
  type SkillRow as SkillRowModel,
  type PlySkillInput,
  type SkillsInput,
  type RepositorySkillInput,
} from "./librarySkills.ts";
import {
  contentId,
  withSilenced,
  type DuplicateIdentity,
  type SilencedDuplicate,
} from "./libraryMute.ts";
import { createMutationQueue } from "./settingsQueue.ts";
import type { Scope } from "./uxScope.ts";
import type { KanbanCard } from "../ipc.ts";
// GH #142: the rule deciding whether a row that opens in Code opens as an
// editor or as a reading view. Tested on its own in `readOnlyFile.test.ts`;
// used here to hold it against the rows the sections really build.
import { skillFileMode } from "./readOnlyFile.ts";
import { setPlatformForTests } from "./platform.ts";

/** A record's identity again, for driving `withSilenced` in the race below. */
const identityOf = (record: SilencedDuplicate): DuplicateIdentity => {
  const [here, there] = record.scopes.split("|") as [Scope, Scope];
  return {
    here,
    there,
    name: record.name,
    hereContent: record.contents[0],
    thereContent: record.contents[1],
  };
};

/** A fixed clock, so every age these tests assert is a number, not a moment. */
const NOW_MS = Date.UTC(2026, 8, 22, 12, 0, 0);
/** `n` seconds before [`NOW_MS`], in epoch seconds — git's own unit. */
const SECS_AGO = (secs: number) => Math.floor(NOW_MS / 1000) - secs;

const EMPTY: SkillsInput = {
  repository: [],
  mirror: [],
  team: [],
  personal: [],
  ply: [],
  shared: false,
  branch: null,
  branchReadOnly: false,
  branchSkills: [],
  pending: [],
  removedUpstream: [],
  nowMs: NOW_MS,
  canPromote: false,
};

const input = (over: Partial<SkillsInput>): SkillsInput => ({ ...EMPTY, ...over });

const repoSkill = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  description: `What ${name} does. And a second sentence.`,
  claude: true,
  codex: false,
  roots: [".claude/skills"],
  ...over,
});

// ── The strings are the board's ───────────────────────────────────────────

assert.equal(
  SKILLS_LEDE,
  "What the agents know how to do. Each one lives somewhere — in this repository, in the team library, in My library, on this Mac, or in Plyloft itself.",
);
assert.equal(filterPlaceholder(104), "Filter 104 skills by name or description");
assert.equal(filterPlaceholder(1), "Filter 1 skill by name or description");
assert.deepEqual(
  SKILL_SCOPES.map((s) => `${SECTION_TITLE[s]} · ${SECTION_MEANING[s]}`),
  [
    "In this repository · everyone who opens this repository",
    "In the team library · every team workspace",
    "Comes with Plyloft · in sessions Plyloft starts",
    "On this Mac · only here",
  ],
);
assert.equal(
  THIS_MAC_NOTE,
  "Yours alone. Plyloft reads them but does not change them — share one with your team from its row.",
);
// Cold read 2026-10-19: the count names what it counts; one is singular.
assert.equal(sectionCount(6, "repository"), "6 skills · everyone who opens this repository");
assert.equal(sectionCount(8, "team"), "8 skills · every team workspace");
assert.equal(sectionCount(24, "this-mac"), "24 skills · only here");
assert.equal(sectionCount(4, "ply"), "4 skills · in sessions Plyloft starts");
assert.equal(sectionCount(1, "ply"), "1 skill · in sessions Plyloft starts");
assert.equal(
  THIS_MAC_NOTE_SOLO,
  "Yours alone. Plyloft reads them but does not change them — promote one to share it.",
);
// The nav lists the scopes in the board's order, which is NOT the order the
// sections are stacked in (`Comes with Ply` sits third among the sections).
// 1.174.0 (X3): My library after Team, as in All skills.
assert.deepEqual(SCOPE_NAV_ORDER, ["repository", "team", "my-library", "this-mac", "ply"]);
assert.deepEqual(SKILL_SCOPES, ["repository", "team", "ply", "this-mac"]);

// ── The hint is the description's first sentence ──────────────────────────
//
// GH #91 made a folded or literal YAML description read in full; a row is one
// line, so the first sentence is what it shows and the whole text belongs to
// the detail sub-page.

assert.equal(firstSentence("Ships a release. Then tags it."), "Ships a release.");
assert.equal(
  firstSentence("Burns captions\ninto a vertical cut\n"),
  "Burns captions into a vertical cut",
  "a description with no full stop is used whole, on one line",
);
assert.equal(
  firstSentence("Use it e.g. before a ship. Not after."),
  "Use it e.g. before a ship. Not after.",
  "an abbreviation is not a sentence end — cutting there would leave a fragment",
);
assert.equal(firstSentence("  Trims.  "), "Trims.");

// ── What else a row has to say ───────────────────────────────────────────
//
// The states the Project skills panel reported: two copies that disagree, a
// root git ignores, and the name Codex uses. A page that replaces that panel
// must not drop them.

assert.deepEqual(skillNotes({}), []);
assert.deepEqual(
  skillNotes({ promoteBlocked: "The copies are not the same file." }),
  ["The copies are not the same file."],
);
{
  const notes = skillNotes({ ignoredRoots: [".claude/skills"] });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /gitignored in this repo/);
  assert.match(notes[0], /\.claude\/\* then !\.claude\/skills\//);
}
assert.deepEqual(skillNotes({ codexName: "plug-frontname" }), [
  "Codex calls it plug-frontname.",
]);

// N14 item 2: the checkout's two copies differ, the branch's are aligned —
// Promote goes ahead, and the row says the local changes aren't included.
{
  const note =
    "The copies of `deploy` in this checkout aren't the same. Promote to Team shares the copy committed on main; your local changes aren't included.";
  assert.deepEqual(skillNotes({ promoteNote: note }), [note]);
  // A refusal says more than the note: never both.
  assert.deepEqual(skillNotes({ promoteBlocked: "Blocked.", promoteNote: note }), ["Blocked."]);
  const row = skillSections(
    input({
      canPromote: true,
      repository: [repoSkill("deploy", { diverged: true, promoteBlocked: null, promoteNote: note })],
    }),
  )[0].rows[0];
  assert.deepEqual(row.notes, [note]);
  assert.ok(
    row.menu.some((entry) => entry !== "divider" && entry.id === "promote-to-team" && !("disabled" in entry)),
    "Promote is offered",
  );
}

// They reach the row.
{
  const row = skillSections(
    input({
      repository: [
        repoSkill("deploy", {
          diverged: true,
          promoteBlocked: "The copies are not the same file.",
          codexName: "deploy-v2",
        }),
      ],
    }),
  )[0].rows[0];
  assert.deepEqual(row.notes, [
    "The copies are not the same file.",
    "Codex calls it deploy-v2.",
  ]);
}

// ── Scope grouping ───────────────────────────────────────────────────────
//
// Four sections in the board's order, always, and the checkout's skills merged
// with the mirror's into one repository section.

{
  const sections = skillSections(
    input({
      repository: [repoSkill("deploy"), repoSkill("verify")],
      mirror: [
        { name: "deploy", description: "The branch's copy.", dir: "/mirror/deploy" },
        { name: "rollback", description: "Only on the branch.", dir: "/mirror/rollback" },
      ],
      team: [
        {
          name: "brief",
          description: "Writes a brief.",
          plugin: "ply",
          claude: true,
          codex: true,
          repo: "absent",
        },
      ],
      personal: [
        {
          name: "captions",
          description: "Burns captions.",
          claude: true,
          codex: false,
          dir: "/Users/x/.claude/skills/captions",
        },
      ],
      shared: true,
      branch: "staging",
      branchSkills: ["deploy", "rollback"],
    }),
  );
  assert.deepEqual(
    sections.map((s) => s.scope),
    ["repository", "team", "ply", "this-mac"],
  );
  const repository = sections[0].rows;
  assert.deepEqual(
    repository.map((r) => r.name),
    ["deploy", "rollback", "verify"],
    "the checkout and the mirror are one section, one row per name",
  );
  assert.equal(repository[1].fromMirror, true, "rollback lives only on the branch");
  assert.equal(repository[1].dir, "/mirror/rollback");
  // GH #142: its only copy is inside Ply's own mirror, and the editor has a
  // read-only mode now — so it opens, and what is missing is the save.
  assert.ok(
    repository[1].menu.some((e) => e !== "divider" && e.id === "open-in-code"),
    "a branch-only skill opens from the mirror, read-only",
  );
  assert.equal(repository[1].openInCode, false, "…and is never saved there");
  assert.ok(
    repository[0].menu.some((e) => e !== "divider" && e.id === "open-in-code"),
    "a checkout copy opens in Code",
  );
  assert.equal(repository[0].fromMirror, false, "deploy is in the checkout");
  assert.equal(sections[2].rows.length, 0, "no Plyloft skills yet, so no Plyloft section");
  assert.deepEqual(scopeCounts(sections), {
    all: 5,
    repository: 3,
    team: 1,
    "my-library": 0,
    ply: 0,
    "this-mac": 1,
  });
  // X3: My library's count joins All.
  assert.equal(scopeCounts(sections, 3).all, 8);
  assert.equal(scopeCounts(sections, 3)["my-library"], 3);
}

// ── Availability: only the CLIs it reaches ───────────────────────────────

{
  const sections = skillSections(
    input({
      repository: [
        repoSkill("both", { claude: true, codex: true }),
        repoSkill("codex-only", { claude: false, codex: true, roots: [".agents/skills"] }),
      ],
      mirror: [{ name: "codex-only", description: "On the branch too.", dir: "/m/c" }],
      shared: true,
      branch: "staging",
      branchSkills: ["codex-only"],
    }),
  );
  const rows = sections[0].rows;
  const both = rows.find((r) => r.name === "both")!;
  assert.equal(both.claude && both.codex, true);
  const codexOnly = rows.find((r) => r.name === "codex-only")!;
  assert.equal(
    codexOnly.claude,
    true,
    "the branch's copy is what Plyloft hands every Claude session, so the chip lights",
  );
  assert.equal(codexOnly.codex, true);
}

// A section that reaches one CLI says so once; a mixed one does not.
{
  const sections = skillSections(
    input({ repository: [repoSkill("a"), repoSkill("b")] }),
  );
  assert.equal(oneCliLine(sections[0].rows), "All 2 reach Claude only.");
}
assert.equal(
  oneCliLine(
    skillSections(
      input({ repository: [repoSkill("a"), repoSkill("b", { codex: true })] }),
    )[0].rows,
  ),
  null,
  "a mixed section needs the rows' own chips, not a sentence",
);
assert.equal(oneCliLine([]), null, "an empty section says nothing");

// ── Duplicates across scopes ─────────────────────────────────────────────

{
  const shared = input({
    repository: [repoSkill("deploy")],
    team: [
      {
        name: "deploy",
        description: "The team's.",
        plugin: "ply",
        claude: true,
        codex: true,
        repo: "differs",
      },
    ],
    personal: [
      {
        name: "captions",
        description: "Mine.",
        claude: true,
        codex: false,
        dir: "/h/.claude/skills/captions",
      },
    ],
  });
  const duplicates = crossScopeDuplicates(shared);
  assert.deepEqual([...duplicates.keys()], ["deploy"]);
  assert.deepEqual(duplicates.get("deploy"), ["repository", "team"]);

  const sections = skillSections(shared);
  const repoRow = sections[0].rows[0];
  assert.deepEqual(repoRow.duplicate, { chip: "Also in Team", other: "team" });
  assert.deepEqual(
    repoRow.action,
    { id: "compare", label: "Compare" },
    "nothing wins (ADR 0005): the action is Compare, not a choice",
  );
  const teamRow = sections[1].rows[0];
  assert.deepEqual(teamRow.duplicate, {
    chip: "Also in this repository",
    other: "repository",
  });
  assert.deepEqual(teamRow.action, { id: "compare", label: "Compare" });
  assert.equal(
    sections[3].rows[0].duplicate,
    null,
    "one name at one scope is not a duplicate",
  );
}
assert.equal(duplicateChip("this-mac"), "Also on this Mac");
// n15: the chip is drawn raw, so it names the machine as Windows does.
setPlatformForTests("windows");
assert.equal(duplicateChip("this-mac"), "Also on this PC");
setPlatformForTests(null);
assert.equal(duplicateChip("ply"), "Also in Plyloft");

// ── Each transient state ─────────────────────────────────────────────────

const branchState = {
  branch: "staging",
  branchSkills: [] as string[],
  pending: [] as SkillsInput["pending"],
  removedUpstream: [] as SkillsInput["removedUpstream"],
  nowMs: NOW_MS,
};

assert.equal(skillTransient("deploy", branchState), null, "at rest");

assert.deepEqual(
  skillTransient("deploy", {
    ...branchState,
    pending: [{ kind: "skill", name: "deploy", removed: false, pullRequest: null }],
  }),
  { kind: "publishing", line: "Publishing to staging…" },
);

// F3/F9 (team walk): a branch origin lacks is held up, never "Publishing…"
// forever; offline alone keeps the on-its-way line.
{
  const missing =
    "walk-base isn't on GitHub any more. Choose where cards go in Settings › Cards › Shipping.";
  const blocked = skillTransient("deploy", {
    ...branchState,
    branch: "walk-base",
    pending: [
      { kind: "skill", name: "deploy", removed: false, pullRequest: null, lastError: missing, offline: false },
    ],
  });
  assert.equal(blocked?.kind, "blocked");
  assert.ok(blocked!.line.startsWith(missing), blocked!.line);
  assert.ok(!/Publishing/.test(blocked!.line), blocked!.line);
  // T5: git couldn't sign in — held up on Setup › GitHub, in the backend's words.
  const signIn =
    "Git couldn't sign in to GitHub. In Settings › Setup and account › Setup › GitHub, turn on \"Git uses your GitHub sign-in\", then try again.";
  const signedOut = skillTransient("deploy", {
    ...branchState,
    pending: [{ kind: "skill", name: "deploy", removed: false, pullRequest: null, lastError: signIn, offline: false }],
  });
  assert.equal(signedOut?.kind, "blocked");
  assert.ok(signedOut!.line.startsWith(signIn), signedOut!.line);
  // A refused push is held up, in Plyloft's words, not git's.
  const refused = skillTransient("deploy", {
    ...branchState,
    pending: [
      { kind: "skill", name: "deploy", removed: false, pullRequest: null, lastError: "staging refused the push (remote: GH006) and no pull request", offline: false },
    ],
  });
  assert.equal(refused?.kind, "blocked");
  assert.ok(!/GH006/.test(refused!.line), refused!.line);
  // Any other error origin answered with is retried, git's text only in details.
  assert.deepEqual(
    skillTransient("deploy", {
      ...branchState,
      pending: [
        { kind: "skill", name: "deploy", removed: false, pullRequest: null, lastError: "fatal: no git identity", offline: false },
      ],
    }),
    {
      kind: "retrying",
      line: "Not published yet: Plyloft will try again on the next Sync.",
      details: "fatal: no git identity",
    },
  );
  // An entry queued before Ply recorded `offline` reads as it always did.
  for (const offline of [undefined, null]) {
    assert.equal(
      skillTransient("deploy", {
        ...branchState,
        pending: [
          { kind: "skill", name: "deploy", removed: false, pullRequest: null, lastError: "git fetch origin staging failed: Could not resolve host", offline },
        ],
      })?.kind,
      "publishing",
    );
  }
  // Offline: still on its way.
  assert.deepEqual(
    skillTransient("deploy", {
      ...branchState,
      pending: [
        {
          kind: "skill",
          name: "deploy",
          removed: false,
          pullRequest: null,
          lastError: "git fetch origin staging failed: Could not resolve host: github.com",
          offline: true,
        },
      ],
    }),
    { kind: "publishing", line: "Publishing to staging…" },
  );
}

// A queued removal is its own sentence: calling it "Publishing" would say the
// opposite of what is happening.
assert.deepEqual(
  skillTransient("deploy", {
    ...branchState,
    pending: [{ kind: "skill", name: "deploy", removed: true, pullRequest: null }],
  }),
  { kind: "publishing", line: "Removing from staging…" },
);

assert.deepEqual(
  skillTransient("deploy", {
    ...branchState,
    pending: [
      {
        kind: "skill",
        name: "deploy",
        removed: false,
        pullRequest: { number: 412, url: "https://example.invalid/412" },
      },
    ],
  }),
  {
    kind: "pullRequest",
    line: "Waiting in pull request #412 — it reaches everyone once that is merged.",
    number: 412,
    url: "https://example.invalid/412",
  },
);
assert.match(
  skillTransient("deploy", {
    ...branchState,
    pending: [
      { kind: "skill", name: "deploy", removed: true, pullRequest: { number: 7, url: "u" } },
    ],
  })!.line,
  /^Its removal is waiting in pull request #7 /,
);

// Skills group B §2: somebody changed it upstream and no pull request could carry
// the change — the backend's sentence, not "Publishing…", which would promise a
// retry that cannot succeed. Offline is still "publishing" (F3/F9: and only
// offline — any other error is held up, tested above).
const SKILL_BLOCKED =
  "deploy changed on staging since this change began (`.claude/skills/deploy`; other-mac changed it 2 min ago). " +
  "Plyloft doesn't commit over a skill, and the GitHub CLI isn't available to open a pull request instead — nothing was changed, on staging or here.";
assert.deepEqual(
  skillTransient("deploy", {
    ...branchState,
    pending: [
      { kind: "skill", name: "deploy", removed: false, pullRequest: null, lastError: SKILL_BLOCKED },
    ],
  }),
  { kind: "blocked", line: SKILL_BLOCKED },
);
assert.equal(
  skillTransient("deploy", {
    ...branchState,
    pending: [
      { kind: "skill", name: "deploy", removed: false, pullRequest: null, lastError: "offline", offline: true },
    ],
  })!.kind,
  "publishing",
);

assert.deepEqual(
  skillTransient("deploy", {
    ...branchState,
    removedUpstream: [{ name: "deploy", author: "MatteoB-adv", changedAt: null }],
  }),
  {
    kind: "removedUpstream",
    line: "Removed on staging by MatteoB-adv. Your copy here is the last one.",
  },
);
// No author named: the sentence still reads.
assert.equal(
  skillTransient("deploy", {
    ...branchState,
    removedUpstream: [{ name: "deploy", author: null, changedAt: null }],
  })?.line,
  "Removed on staging. Your copy here is the last one.",
);

// GH #144: with the age the report carried — BOARDS.md §3's own row.
assert.deepEqual(
  skillTransient("deploy", {
    ...branchState,
    removedUpstream: [
      { name: "deploy", author: "MatteoB-adv", changedAt: SECS_AGO(2 * 3600) },
    ],
  }),
  {
    kind: "removedUpstream",
    line: "Removed on staging by MatteoB-adv 2 hours ago. Your copy here is the last one.",
  },
);
// Review 1 (MAJOR): the age is said from `nowMs` at the moment the row is built,
// **not** fixed when the report arrived. One record, read at three clocks: a
// removal announced once stops being "2 minutes ago" for the rest of the session.
{
  const removedAt = SECS_AGO(0);
  const record = {
    ...branchState,
    removedUpstream: [{ name: "deploy", author: "MatteoB-adv", changedAt: removedAt }],
  };
  const lineAt = (secsLater: number) =>
    skillTransient("deploy", { ...record, nowMs: (removedAt + secsLater) * 1000 })?.line;
  assert.equal(
    lineAt(2 * 60),
    "Removed on staging by MatteoB-adv 2 minutes ago. Your copy here is the last one.",
  );
  assert.equal(
    lineAt(2 * 3600),
    "Removed on staging by MatteoB-adv 2 hours ago. Your copy here is the last one.",
    "the same record two hours later says two hours, not two minutes",
  );
  assert.equal(
    lineAt(3 * 86_400),
    "Removed on staging by MatteoB-adv 3 days ago. Your copy here is the last one.",
  );
}
// Each half drops on its own: an age with no author, and neither.
assert.equal(
  skillTransient("deploy", {
    ...branchState,
    removedUpstream: [{ name: "deploy", author: null, changedAt: SECS_AGO(3 * 86_400) }],
  })?.line,
  "Removed on staging 3 days ago. Your copy here is the last one.",
);
assert.equal(
  skillTransient("deploy", {
    ...branchState,
    removedUpstream: [{ name: "deploy", author: "MatteoB-adv", changedAt: null }],
  })?.line,
  "Removed on staging by MatteoB-adv. Your copy here is the last one.",
  "a report with no time reads exactly as it did before this card",
);

// ── A removal does not outlive the branch giving it back (review 1) ───────

assert.equal(
  skillTransient("deploy", {
    ...branchState,
    branchSkills: ["deploy"],
    removedUpstream: [{ name: "deploy", author: "MatteoB-adv", changedAt: null }],
  }),
  null,
  "the branch carries the name again, whoever put it back",
);

// The member's own publish is in flight: that is what they are waiting on, and
// it outranks a removal somebody else made.
assert.deepEqual(
  skillTransient("deploy", {
    ...branchState,
    pending: [{ kind: "skill", name: "deploy", removed: false, pullRequest: null }],
    removedUpstream: [{ name: "deploy", author: "X", changedAt: null }],
  }),
  { kind: "publishing", line: "Publishing to staging…" },
);

// A queued *note* of the same name is not this skill.
assert.equal(
  skillTransient("deploy", {
    ...branchState,
    pending: [{ kind: "knowledge", name: "deploy", removed: false, pullRequest: null }],
  }),
  null,
);

// With no branch named, the words still read.
assert.equal(
  skillTransient("deploy", {
    branch: null,
    branchSkills: [],
    pending: [{ kind: "skill", name: "deploy", removed: false, pullRequest: null }],
    removedUpstream: [],
    nowMs: NOW_MS,
  })?.line,
  "Publishing to the integration branch…",
);

// Each transient carries its own action.
{
  const withPr = skillSections(
    input({
      repository: [repoSkill("deploy")],
      shared: true,
      branch: "staging",
      branchSkills: ["deploy"],
      pending: [
        {
          kind: "skill",
          name: "deploy",
          removed: false,
          pullRequest: { number: 412, url: "u" },
        },
      ],
    }),
  )[0].rows[0];
  assert.deepEqual(withPr.action, { id: "open-pull-request", label: "Open pull request" });

  const gone = skillSections(
    input({
      repository: [repoSkill("deploy")],
      shared: true,
      branch: "staging",
      removedUpstream: [{ name: "deploy", author: "X", changedAt: null }],
    }),
  )[0].rows[0];
  assert.deepEqual(gone.action, { id: "keep-on-this-mac", label: "Keep on this Mac" });

  const atRest = skillSections(input({ repository: [repoSkill("deploy")] }))[0].rows[0];
  assert.equal(atRest.action, null, "a repository skill at rest has no primary action");
}

// ── The menu, per scope and per read-only ────────────────────────────────

const facts = (over: Partial<MenuFacts>): MenuFacts => ({
  scope: "repository",
  readOnly: false,
  hasFile: true,
  shared: true,
  branch: "staging",
  branchWritable: true,
  inCheckout: true,
  onBranch: true,
  canPromote: true,
  ...over,
});

// GH #105: a skill on the branch that reaches one CLI can be carried over, so the
// entry #96 left for this card is here — in the board's own place for it, after
// `Update on <branch>` and before `Promote to Team` (review 1, MINOR).
assert.deepEqual(skillMenu(facts({})), [
  { id: "open-in-code", label: "Open in Code" },
  { id: "publish-to-branch", label: "Update on staging" },
  { id: "make-available-to-both", label: "Make available to both" },
  { id: "promote-to-team", label: "Promote to Team" },
  "divider",
  { id: "remove-from-branch", label: "Remove from staging…", danger: true },
]);
// …and `Align` takes that same place when the two copies on the branch disagree.
assert.deepEqual(skillMenu(facts({ differs: true })), [
  { id: "open-in-code", label: "Open in Code" },
  { id: "publish-to-branch", label: "Update on staging" },
  { id: "align", label: "Align" },
  { id: "promote-to-team", label: "Promote to Team" },
  "divider",
  { id: "remove-from-branch", label: "Remove from staging…", danger: true },
]);

// Walk F4 (review): `Update on <branch>` is always offered; the press checks.
{
  const t = alreadyCurrentToast("newone", "main");
  assert.equal(t.title, "newone is already the same on main");
  assert.match(t.body, /nothing to publish/);
}

// `Remove from <branch>…` asks first, and the question says who it reaches.
{
  const body = unpublishConfirmBody("deploy", "staging");
  assert.match(body, /off staging/);
  assert.match(body, /everyone who opens this repository/);
  assert.match(body, /project folder's copy is untouched/);
}
// Walk F2: it names the copies the branch actually has.
assert.match(
  unpublishConfirmBody("deploy", "staging", { claude: true, codex: true }),
  /takes its Claude and Codex copies off staging/,
);
{
  const claudeOnly = unpublishConfirmBody("newone", "main", { claude: true, codex: false });
  assert.match(claudeOnly, /takes its Claude copy off main/);
  assert.doesNotMatch(claudeOnly, /Codex/);
  assert.match(unpublishConfirmBody("c", "main", { claude: false, codex: true }), /its Codex copy off/);
  assert.doesNotMatch(unpublishToastBody({ claude: true, codex: false }), /Codex/);
  assert.match(unpublishToastBody({ claude: true, codex: true }), /for Claude and for Codex\./);
  assert.deepEqual(
    branchReachOf(input({ mirror: [{ name: "newone", description: "x", dir: "/m" }] }), "newone"),
    { claude: true, codex: false },
    "an older mirror row with no reach counts as Claude's",
  );
  assert.equal(branchReachOf(input({}), "newone"), null);
}

/** The label of the entry with `id`, or null. */
const labelOf = (menu: SkillMenuEntry[], id: string): string | null => {
  for (const entry of menu) {
    if (entry !== "divider" && entry.id === id) return entry.label;
  }
  return null;
};
assert.equal(
  labelOf(skillMenu(facts({ onBranch: false })), "publish-to-branch"),
  "Publish to staging",
  "a skill that was never published is not being updated",
);
assert.ok(
  !skillMenu(facts({ onBranch: false })).includes("divider"),
  "nothing to remove, so no divider and no removal",
);

// GH #105: and not when there is nothing to carry over.
assert.equal(
  labelOf(skillMenu(facts({ reachesBoth: true })), "make-available-to-both"),
  null,
  "both copies are already on the branch",
);
assert.equal(
  labelOf(skillMenu(facts({ onBranch: false })), "make-available-to-both"),
  null,
  "nothing on the branch to copy from: it is published first",
);
assert.equal(
  labelOf(skillMenu(facts({ differs: true })), "make-available-to-both"),
  null,
  "two copies that disagree are aligned, never copied over",
);
assert.equal(labelOf(skillMenu(facts({ differs: true })), "align"), "Align");

// UX-9.5: the Team page no longer lists the team's skills, so a team row offers
// `Remove from Team…` — last, behind a divider, danger — to whoever may write the
// team library, and to nobody else; no other scope ever has it.
const teamFacts = (over: Partial<MenuFacts>) =>
  facts({
    scope: "team",
    branchWritable: false,
    inCheckout: false,
    onBranch: false,
    canPromote: false,
    ...over,
  });
assert.deepEqual(skillMenu(teamFacts({ removeFromTeam: true })), [
  { id: "open-in-code", label: "Open in Code" },
  "divider",
  { id: "remove-from-team", label: "Remove from Team…", danger: true },
]);
assert.equal(labelOf(skillMenu(teamFacts({})), "remove-from-team"), null, "no write access, no entry");

// Skills hub H4 step 8 c (Windows walk): a member GitHub lets read the team
// library and not change it saw no Promote at all and no word why. The entry is
// there, off, with the backend's own refusal as its hint.
{
  const READ_ONLY =
    "You can read the team library but not change it. Ask matteo for write access, or open a pull request from a fork on GitHub.";
  const promote = (menu: ReturnType<typeof skillMenu>) =>
    menu.find((e) => e !== "divider" && e.id === "promote-to-team");
  assert.deepEqual(promote(skillMenu(facts({ canPromote: false, promoteRefusal: READ_ONLY }))), {
    id: "promote-to-team",
    label: "Promote to Team",
    disabled: true,
    hint: READ_ONLY,
  });
  // Off as a Replace or a Complete would be too: one label, the refusal's.
  assert.equal(
    labelOf(skillMenu(facts({ canPromote: false, promoteRefusal: READ_ONLY, teamState: "differs" })), "promote-to-team"),
    "Promote to Team",
  );
  // Nothing to say where the team already holds this copy, or for a read-only row.
  assert.equal(promote(skillMenu(facts({ canPromote: false, promoteRefusal: READ_ONLY, teamState: "same" }))), undefined);
  assert.equal(promote(skillMenu(facts({ canPromote: false, promoteRefusal: READ_ONLY, readOnly: true }))), undefined);
  // Solo, or the team gate's refusal: no Promote at all, as before.
  assert.equal(promote(skillMenu(facts({ canPromote: false }))), undefined);

  // Through the rows: the caveat while Promote is offered keeps it on (the view
  // carries it as `promoteReason`, never as a refusal) …
  const note =
    "This checkout's `deploy` has changes not on walk-1014. Promote to Team shares the copy committed on walk-1014; your local changes aren't included.";
  const offered = skillSections(input({ canPromote: true, repository: [repoSkill("deploy", { promoteNote: note })] }))[0].rows[0];
  assert.deepEqual(promote(offered.menu), { id: "promote-to-team", label: "Promote to Team" });
  assert.ok(offered.notes.includes(note));
  // … the refusal turns it off, and the notes stop telling the member what a
  // Promote would share …
  const refused = skillSections(
    input({
      canPromote: false,
      promoteRefusal: READ_ONLY,
      repository: [
        repoSkill("deploy", { promoteNote: note }),
        repoSkill("lint", {
          promoteBlocked:
            "`lint` isn't on GitHub's walk-1014 yet. Promote to Team shares the copy committed there, so publish it to walk-1014 first.",
        }),
      ],
    }),
  )[0].rows;
  assert.equal(refused.length, 2);
  for (const row of refused) {
    assert.deepEqual(promote(row.menu), {
      id: "promote-to-team",
      label: "Promote to Team",
      disabled: true,
      hint: READ_ONLY,
    });
    assert.ok(!row.notes.some((n) => n.includes("Promote to Team shares")), row.notes.join(" | "));
  }
  // … and with no refusal (solo, no team) a row offers none and keeps its notes.
  const solo = skillSections(input({ canPromote: false, repository: [repoSkill("deploy", { promoteNote: note })] }))[0].rows[0];
  assert.equal(promote(solo.menu), undefined);
}
for (const scope of ["repository", "this-mac", "ply"] as const) {
  assert.equal(
    labelOf(skillMenu(facts({ scope, removeFromTeam: true })), "remove-from-team"),
    null,
    `a ${scope} row is not the team's to remove`,
  );
}
assert.equal(labelOf(skillMenu(facts({})), "align"), null);
// Both are writes, so a read-only collaborator has neither.
for (const entry of ["make-available-to-both", "align"]) {
  assert.equal(
    labelOf(skillMenu(facts({ branchWritable: false, differs: true })), entry),
    null,
    `${entry} needs write access to the branch`,
  );
  assert.equal(
    labelOf(skillMenu(facts({ shared: false, differs: true })), entry),
    null,
    `${entry} needs the shared channel`,
  );
}
// …and reading the two copies survives read-only, as the duplicate's Compare does.
assert.equal(
  labelOf(
    skillMenu(facts({ branchWritable: false, differs: true, compareReach: true })),
    "compare-reach",
  ),
  "Compare Claude and Codex",
);

// Read-only repository: no writing entries at all, and Open in Code stays.
assert.deepEqual(skillMenu(facts({ branchWritable: false })), [
  { id: "open-in-code", label: "Open in Code" },
  { id: "promote-to-team", label: "Promote to Team" },
]);
assert.deepEqual(skillMenu(facts({ branchWritable: false, canPromote: false })), [
  { id: "open-in-code", label: "Open in Code" },
]);

// A workspace off the shared channel has no branch entries; its skills travel
// with cards.
assert.deepEqual(skillMenu(facts({ shared: false })), [
  { id: "open-in-code", label: "Open in Code" },
  { id: "promote-to-team", label: "Promote to Team" },
]);

// This Mac: read-only, so nothing that writes the file — and, since GH #142,
// `Open in Code` all the same, because reading it is not writing it. That is the
// whole of what this card changed about the menu.
assert.deepEqual(
  skillMenu(facts({ scope: "this-mac", readOnly: true, hasFile: true })),
  [{ id: "open-in-code", label: "Open in Code" }],
);
// …and nothing at all where Ply has no directory to open: a team row whose
// library path it has not read (`hasFile` is the only thing that decides).
assert.deepEqual(
  skillMenu(facts({ scope: "this-mac", readOnly: true, hasFile: false })),
  [],
);

// Team: the library's copy opens read-only, and the branch entries are not about
// it. A row Ply has no directory for opens nothing.
assert.deepEqual(
  skillMenu(facts({ scope: "team", hasFile: true, branchWritable: false, canPromote: false })),
  [{ id: "open-in-code", label: "Open in Code" }],
);
assert.deepEqual(
  skillMenu(facts({ scope: "team", hasFile: false, branchWritable: false, canPromote: false })),
  [],
);

// ── Nothing is refused for wanting a Replace nobody could ask for ────────
//
// `copy_into` hard-errors when a destination holds different bytes and
// `replace` was not passed, so an action that cannot say "replace" can only end
// in a toast telling the member to do something they have no way to do
// (review 1). The name says which it is, in the Project panel's own words.

assert.equal(labelOf(skillMenu(facts({ teamState: "absent" })), "promote-to-team"), "Promote to Team");
assert.equal(labelOf(skillMenu(facts({ teamState: "partial" })), "promote-to-team"), "Complete in Team");
assert.equal(labelOf(skillMenu(facts({ teamState: "differs" })), "promote-to-team"), "Replace in Team…");
assert.equal(
  labelOf(skillMenu(facts({ teamState: "same" })), "promote-to-team"),
  null,
  "the library already holds these exact bytes: nothing to do",
);
{
  const entry = skillMenu(facts({ teamState: "differs" })).find(
    (e) => e !== "divider" && e.id === "promote-to-team",
  );
  assert.equal(entry !== "divider" && entry && "confirm" in entry ? entry.confirm : null, true);
  const plain = skillMenu(facts({ teamState: "absent" })).find(
    (e) => e !== "divider" && e.id === "promote-to-team",
  );
  assert.ok(!(plain !== "divider" && plain && "confirm" in plain), "a plain copy asks nothing");
}
// The Install of a duplicate team row, whose action Compare has taken.
assert.equal(labelOf(skillMenu(facts({ installState: "absent" })), "install"), "Install");
assert.equal(labelOf(skillMenu(facts({ installState: "partial" })), "install"), "Complete");
assert.equal(labelOf(skillMenu(facts({ installState: "differs" })), "install"), "Link and update…");
assert.equal(labelOf(skillMenu(facts({ installState: "same" })), "install"), null);

// A duplicate whose one action is not Compare puts Compare in the `⋯`, so the
// "Also in …" chip has something behind it (review 1).
assert.equal(labelOf(skillMenu(facts({ compare: true })), "compare"), "Compare");
assert.equal(labelOf(skillMenu(facts({})), "compare"), null);
assert.equal(
  labelOf(skillMenu(facts({ scope: "this-mac", readOnly: true, hasFile: false, compare: true, canPromote: false })), "compare"),
  "Compare",
  "reading two copies is not writing either of them",
);

// Ply skills are the app's; nothing in the menu applies.
{
  const sections = skillSections(
    input({ ply: [{
        name: "brief",
        title: "Write a good brief",
        description: "Writes a brief.",
        dir: "/Ply.app/Contents/Resources/ply-skills/brief",
        claude: true,
        codex: true,
        on: true,
      }] }),
  );
  assert.deepEqual(sections[2].rows[0].menu, []);
  assert.equal(sections[2].rows[0].readOnly, true);
  assert.equal(sections[2].rows[0].action, null);
}

// A personal row's one action is Promote, and it is read-only.
{
  const row = skillSections(
    input({
      personal: [
        {
          name: "captions",
          description: "Burns captions.",
          claude: true,
          codex: false,
          dir: "/h/.claude/skills/captions",
        },
      ],
      canPromote: true,
    }),
  )[3].rows[0];
  assert.equal(row.readOnly, true);
  assert.deepEqual(row.action, { id: "promote", label: "Share with Team…" });
  assert.equal(SHARE_WITH_TEAM_LABEL, "Share with Team…");
  // Cold read 2026-10-19: on hover or focus only — and as before in solo mode.
  assert.equal(row.actionOnHover, true);
  const soloRow = skillSections(
    input({
      personal: [
        { name: "captions", description: "Burns captions.", claude: true, codex: false, dir: "/h/.claude/skills/captions" },
      ],
      solo: true,
    }),
  )[3].rows[0];
  assert.deepEqual(soloRow.action, { id: "promote", label: "Promote" });
  assert.equal(soloRow.actionOnHover, false);
  assert.equal(row.dir, "/h/.claude/skills/captions");
  assert.equal(row.openInCode, false, "nothing Plyloft may write");
  // GH #142: and one thing it may do — open it to be read. `Promote` is still
  // the row's own action, so the entry and the action are not the same press.
  assert.deepEqual(row.menu, [{ id: "open-in-code", label: "Open in Code" }]);
}

// A personal skill the repository also carries: the chip has Compare behind it.
{
  const sections = skillSections(
    input({
      repository: [repoSkill("captions")],
      personal: [
        {
          name: "captions",
          description: "Mine.",
          claude: true,
          codex: false,
          dir: "/h/.claude/skills/captions",
        },
      ],
    }),
  );
  const mine = sections[3].rows[0];
  assert.deepEqual(mine.duplicate, {
    chip: "Also in this repository",
    other: "repository",
  });
  assert.deepEqual(mine.action, { id: "promote", label: "Share…" });
  // The board's order: the reading view first, then the comparison (GH #142).
  assert.deepEqual(mine.menu, [
    { id: "open-in-code", label: "Open in Code" },
    { id: "compare", label: "Compare" },
  ]);
}

// A skill whose two copies in the repo disagree cannot be promoted: Ply does
// not get to choose which version the team receives. Team walk 2026-10-01
// (F4): the entry is shown off, with the reason under it, rather than missing
// with nothing to say why.
{
  const promote = (canPromote: boolean) =>
    skillSections(
      input({
        repository: [repoSkill("deploy", { promoteBlocked: "The copies are not the same file." })],
        canPromote,
      }),
    )[0].rows[0].menu.filter((e) => e !== "divider" && e.id === "promote-to-team");
  assert.deepEqual(promote(true), [
    {
      id: "promote-to-team",
      label: "Promote to Team",
      disabled: true,
      hint: "The copies are not the same file.",
    },
  ]);
  // A Mac that could not promote anyway is not shown a reason about copies.
  assert.deepEqual(promote(false), []);
}

// ── A team row's action, named by what it would do ───────────────────────

{
  const team = (repo: "absent" | "same" | "partial" | "differs") =>
    skillSections(
      input({
        team: [
          {
            name: "brief",
            description: "Writes a brief.",
            plugin: "ply",
            claude: true,
            codex: true,
            repo,
            dir: "/clone/library/claude/ply/skills/brief",
          },
        ],
      }),
    )[1].rows[0];
  assert.deepEqual(team("absent").action, { id: "install", label: "Install" });
  assert.deepEqual(team("partial").action, { id: "install", label: "Complete" });
  assert.deepEqual(team("differs").action, {
    id: "install",
    label: "Link and update…",
    confirm: true,
  });
  assert.equal(team("same").action, null, "already here: nothing to do");
  assert.equal(team("absent").plugin, "ply");
  assert.equal(
    team("absent").dir,
    "/clone/library/claude/ply/skills/brief",
    "Compare reads the library's copy from here",
  );
}

// ── Only a checkout repository row may be SAVED (review 1, BLOCKER) ───────
//
// The team library is a clone `TeamStore::sync` pulls `--ff-only`, the mirror is
// Ply's own state, and `~/.claude/skills` is the member's. A ⌘S in any of them
// is a fault Ply caused, so one field decides it for the `⋯` and for the
// sub-page's file rows alike.
//
// GH #142 splits the question in two and keeps `openInCode` as the answer to the
// half it always answered: **may Code write this copy**. Whether Code may open it
// at all is `readOnlyFile.ts::skillFileMode`, and the answer there is yes
// everywhere Ply has a directory — read-only for the three places above.

{
  const every = skillSections(
    input({
      repository: [repoSkill("checkout")],
      mirror: [{ name: "branch-only", description: "On the branch.", dir: "/mirror/b" }],
      team: [
        {
          name: "team-one",
          description: "The team's.",
          plugin: "ply",
          claude: true,
          codex: true,
          repo: "absent",
          dir: "/clone/team-one",
        },
      ],
      personal: [
        {
          name: "mine",
          description: "Mine.",
          claude: true,
          codex: false,
          dir: "/h/.claude/skills/mine",
        },
      ],
      ply: [{
        name: "brief",
        title: "Write a good brief",
        description: "Writes a brief.",
        dir: "/Ply.app/Contents/Resources/ply-skills/brief",
        claude: true,
        codex: true,
        on: true,
      }],
      shared: true,
      branch: "staging",
      branchSkills: ["branch-only"],
      canPromote: true,
    }),
  ).flatMap((section) => section.rows);
  assert.deepEqual(
    every.filter((r) => r.openInCode).map((r) => r.key),
    ["repository:checkout"],
  );
  // And the `⋯` agrees with the rule, everywhere: an entry wherever Ply has a
  // directory to open, and a tab that can be saved only where `openInCode` says
  // so. The one exception is a Ply skill, whose page has no file list at all
  // (BOARDS.md §6) and whose menu is empty by construction.
  for (const row of every) {
    const opens = row.menu.some((e) => e !== "divider" && e.id === "open-in-code");
    assert.equal(
      opens,
      row.dir !== null && row.scope !== "ply",
      `${row.key}: the menu and the rule must not drift apart`,
    );
    if (opens) {
      assert.equal(
        !skillFileMode(row).readOnly,
        row.openInCode,
        `${row.key}: what the tab may do must not drift from openInCode`,
      );
    }
  }
}

// ── The filter: name or description, every scope ─────────────────────────

{
  const sections = skillSections(
    input({
      repository: [
        { ...repoSkill("deploy"), description: "Ships a release. Tags it." },
      ],
      personal: [
        {
          name: "captions",
          description: "Burns subtitles into a vertical cut.",
          claude: true,
          codex: false,
          dir: "/h/c",
        },
      ],
    }),
  );
  const all = sections.flatMap((s) => s.rows);
  assert.deepEqual(filterSkillRows(all, "").map((r) => r.name), ["deploy", "captions"]);
  assert.deepEqual(filterSkillRows(all, "DEP").map((r) => r.name), ["deploy"]);
  assert.deepEqual(
    filterSkillRows(all, "subtitles").map((r) => r.name),
    ["captions"],
    "the description is searched, not only the name",
  );
  assert.deepEqual(
    filterSkillRows(all, "tags it").map((r) => r.name),
    ["deploy"],
    "the whole description, not the first sentence the row shows",
  );
  assert.deepEqual(filterSkillRows(all, "   ").map((r) => r.name), ["deploy", "captions"]);
  assert.deepEqual(filterSkillRows(all, "nothing"), []);
}

// ── Compare, and the words under it ─────────────────────────────────────

{
  const lines = compareSkillText("a\nb\nc\n", "a\nB\n");
  assert.deepEqual(
    lines.map((l) => l.mark),
    ["", "≠", "+"],
  );
  assert.deepEqual(lines[2], {
    leftNo: 3,
    rightNo: null,
    left: "c",
    right: null,
    mark: "+",
    // Per column, not per pair: the side with the text says "only here", the side
    // with nothing is a neutral blank (review 1, MAJOR; owner, 2026-10-20).
    leftMark: "+",
    rightMark: "",
  });
  // The two sides are named by where they live, not by which column they are in:
  // under 760 px of column there is no left (review 1).
  const HERE = SCOPE_PLACE.repository;
  const THERE = SCOPE_PLACE.team;
  assert.equal(
    compareSummary(lines, HERE, THERE),
    "1 line says something different, 1 line only in this repository.",
  );
  assert.equal(
    compareSummary(compareSkillText("a\n", "a\n"), HERE, THERE),
    "The two are the same file.",
  );
  assert.equal(
    compareSummary(compareSkillText("a\n", "a\nb\nc\n"), HERE, THERE),
    "2 lines only in the team library.",
  );
  assert.equal(
    compareSummary(compareSkillText("x\nb\nc\n", "y\n"), HERE, SCOPE_PLACE["this-mac"]),
    "1 line says something different, 2 lines only in this repository.",
  );
  // Walk F3: the verb agrees with the count.
  assert.equal(
    compareSummary(compareSkillText("a\nb\nc\n", "x\ny\nz\n"), HERE, THERE),
    "3 lines say something different.",
  );
  assert.doesNotMatch(
    compareSummary(lines, HERE, THERE),
    /left|right/,
    "no left and no right anywhere in the sentence",
  );
}



// The line diff is a pure function with its own tests (GH #100): changed,
// only-here, only-there, identical, trailing newline.
{
  // Identical, to the byte.
  assert.deepEqual(
    compareSkillText("a\nb\n", "a\nb\n").map((l) => l.mark),
    ["", ""],
  );
  // Only here.
  const onlyHere = compareSkillText("a\nb\n", "a\n");
  assert.deepEqual(onlyHere.map((l) => l.mark), ["", "+"]);
  assert.equal(onlyHere[1].right, null);
  assert.equal(onlyHere[1].rightNo, null, "the other side numbers nothing");
  // Only there.
  const onlyThere = compareSkillText("a\n", "a\nb\n");
  assert.deepEqual(onlyThere.map((l) => l.mark), ["", "−"]);
  assert.equal(onlyThere[1].left, null);
  assert.equal(onlyThere[1].leftNo, null);
  // Changed, and the numbers run down each side independently of the marks.
  const changed = compareSkillText("a\nb\nc\n", "a\nB\nc\n");
  assert.deepEqual(changed.map((l) => l.mark), ["", "≠", ""]);
  assert.deepEqual(changed.map((l) => l.leftNo), [1, 2, 3]);
  assert.deepEqual(changed.map((l) => l.rightNo), [1, 2, 3]);
  // The trailing newline is not a line of its own, on either side or neither:
  // every file a CLI writes ends with one, and counting it would make every
  // comparison end in a phantom `≠`.
  assert.equal(compareSkillText("a\n", "a").length, 1);
  assert.equal(compareSkillText("a", "a\n")[0].mark, "");
  assert.equal(compareSkillText("a\n", "a\n").length, 1);
  assert.deepEqual(
    compareSkillText("a\n\n", "a\n").map((l) => l.mark),
    ["", "+"],
    "a blank line before the last newline is a line",
  );
  // An empty file against a written one.
  assert.deepEqual(compareSkillText("", "").map((l) => l.mark), [""]);
  assert.equal(
    compareSummary(compareSkillText("", ""), SCOPE_PLACE.repository, SCOPE_PLACE.team),
    "The two are the same file.",
  );
}

// ── The SKILL.md as reading text: frontmatter hidden (GH #100) ───────────

assert.equal(
  skillBody("---\nname: deploy\ndescription: Ships.\n---\n\n# Deploy\n\nRun it.\n"),
  "# Deploy\n\nRun it.\n",
);
assert.equal(
  skillBody("---\ndescription: Ships.\n---\nRun it.\n"),
  "Run it.\n",
  "no blank line after the block is still the end of the block",
);
assert.equal(
  skillBody("# Deploy\n\nRun it.\n"),
  "# Deploy\n\nRun it.\n",
  "a file with no frontmatter is left alone",
);
assert.equal(
  skillBody("# Deploy\n\n---\n\nRun it.\n"),
  "# Deploy\n\n---\n\nRun it.\n",
  "a rule the author wrote is not frontmatter",
);
assert.equal(
  skillBody("---\ndescription: Ships.\n\nRun it.\n"),
  "---\ndescription: Ships.\n\nRun it.\n",
  "a block that never closes is shown whole rather than swallowed",
);
assert.equal(
  skillBody("﻿---\ndescription: Ships.\n---\nRun it.\n"),
  "Run it.\n",
  "a BOM does not hide the block",
);
assert.equal(
  skillBody("---\r\ndescription: Ships.\r\n---\r\nRun it.\r\n"),
  "Run it.\r\n",
  "CRLF",
);
assert.equal(skillBody("---\ndescription: Ships.\n---\n"), "", "a body of nothing");

// ── The fact line (Board 3) ─────────────────────────────────────────────

assert.equal(reachWords(true, false), "Reaches Claude only");
assert.equal(reachWords(false, true), "Reaches Codex only");
assert.equal(reachWords(true, true), "Reaches Claude and Codex");
assert.equal(
  reachWords(false, false),
  null,
  "no chip rather than a chip saying it reaches nobody",
);
assert.equal(fileCountWords(1), "1 file");
assert.equal(fileCountWords(0), "0 files");
assert.equal(fileCountWords(3), "3 files");

{
  const now = Date.UTC(2026, 8, 22, 12, 0, 0);
  const secsAgo = (secs: number) => Math.floor(now / 1000) - secs;
  const HOUR = 3600;
  const DAY = 86_400;
  assert.equal(changedAgo(now, secsAgo(5)), "just now");
  assert.equal(changedAgo(now, secsAgo(60)), "1 min ago");
  assert.equal(changedAgo(now, secsAgo(45 * 60)), "45 min ago");
  assert.equal(changedAgo(now, secsAgo(2 * HOUR)), "2 h ago");
  assert.equal(changedAgo(now, secsAgo(DAY)), "1 day ago");
  assert.equal(changedAgo(now, secsAgo(6 * DAY)), "6 days ago");
  assert.equal(changedAgo(now, secsAgo(7 * DAY)), "1 week ago");
  // The board's own number.
  assert.equal(changedAgo(now, secsAgo(49 * DAY)), "7 weeks ago");
  assert.equal(changedAgo(now, secsAgo(60 * DAY)), "2 months ago");
  assert.equal(changedAgo(now, secsAgo(400 * DAY)), "1 year ago");
  assert.equal(
    changedAgo(now, Math.floor(now / 1000) + 600),
    "just now",
    "a commit dated in the future is not negative time",
  );
}

// `Last changed by …`, and each half of it on its own.
{
  const now = Date.UTC(2026, 8, 22, 12, 0, 0);
  const at = Math.floor(now / 1000) - 49 * 86_400;
  assert.equal(
    lastChangedWords({ gitRef: "staging", author: "MatteoB-adv", at, commit: "a3f9c21" }, now),
    "Last changed by MatteoB-adv 7 weeks ago",
  );
  assert.equal(
    lastChangedWords({ gitRef: "staging", author: "MatteoB-adv", at: null, commit: null }, now),
    "Last changed by MatteoB-adv",
  );
  assert.equal(
    lastChangedWords({ gitRef: "staging", author: null, at, commit: null }, now),
    "Last changed 7 weeks ago",
  );
  assert.equal(
    lastChangedWords({ gitRef: "staging", author: null, at: null, commit: null }, now),
    null,
    "a branch Plyloft looked at with nothing to report says nothing here",
  );
  assert.equal(lastChangedWords(null, now), null);
}

// The `Details` line drops what is missing and keeps the board's order.
{
  const at = 1_753_879_920;
  const line = detailsHistoryLine({
    gitRef: "staging",
    commit: "a3f9c21",
    author: "MatteoB-adv",
    at,
  });
  assert.match(line!, /^staging · a3f9c21 · MatteoB-adv · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(
    detailsHistoryLine({ gitRef: "staging", commit: null, author: null, at: null }),
    "staging",
    "the branch alone says where Plyloft looked",
  );
  assert.equal(
    detailsHistoryLine({ gitRef: null, commit: null, author: null, at: null }),
    null,
  );
  assert.equal(detailsHistoryLine(null), null);
  assert.match(detailsStamp(at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(detailsStamp(at), detailsStamp(at), "the stamp is stable");
}

// ── The duplicate sentence: nothing wins ────────────────────────────────

assert.equal(
  duplicateSentence("deploy", "repository", "team", { here: null, there: "team" }),
  "Both reach the agents: this one as deploy, the team's as team:deploy.",
  "the board's words, exactly",
);
assert.equal(
  duplicateSentence("deploy", "team", "repository", { here: "team", there: null }),
  "Both reach the agents: this one as team:deploy, the repository's as deploy.",
);
assert.equal(
  duplicateSentence("deploy", "team", "this-mac", { here: "ply", there: null }),
  "Both reach the agents: this one as ply:deploy, this Mac's as deploy.",
);
assert.equal(
  duplicateSentence("captions", "repository", "this-mac", { here: null, there: null }),
  "Both reach the agents, and both are called captions: this one in this repository, the other on this Mac.",
  "a pair the board does not draw claims nothing about which one a CLI picks",
);
assert.equal(
  duplicateSentence("deploy", "repository", "team", { here: null, there: null }),
  "Both reach the agents: this one as deploy, the team's as deploy.",
  "no plugin known: the name is said plainly rather than a guessed prefix",
);
// GH #106 review 1: a skill that comes with Ply arrives inside the `ply` plugin,
// so a session calls it `ply:card-brief` — "both are called card-brief" was false.
assert.equal(
  duplicateSentence("card-brief", "repository", "ply", { here: null, there: "ply" }),
  "Both reach the agents: this one as card-brief, Plyloft's as ply:card-brief.",
);
assert.equal(
  duplicateSentence("card-brief", "ply", "repository", { here: "ply", there: null }),
  "Both reach the agents: this one as ply:card-brief, the repository's as card-brief.",
);
// Both sides may arrive inside a plugin, and then both names are qualified.
assert.equal(
  duplicateSentence("card-brief", "ply", "team", { here: "ply", there: "ply-team" }),
  "Both reach the agents: this one as ply:card-brief, the team's as ply-team:card-brief.",
);

// ── The page, per scope and per read-only ───────────────────────────────

const pageOf = (row: SkillRowModel, over: Partial<SkillPageInput> = {}): SkillPageModel =>
  skillPage({
    row,
    files: 1,
    history: null,
    plugin: null,
    silenced: false,
    copies: "read",
    nowMs: Date.UTC(2026, 8, 22, 12, 0, 0),
    ...over,
  });

const rowsOf = (over: Partial<SkillsInput>): SkillRowModel[] =>
  skillSections(input(over)).flatMap((s) => s.rows);

// A repository skill in the checkout: `Edit in Code` is the primary, and the
// `⋯` has neither `Open in Code` (it is the primary) nor `Compare`.
{
  const at = Math.floor(Date.UTC(2026, 8, 22, 12, 0, 0) / 1000) - 49 * 86_400;
  const row = rowsOf({
    repository: [repoSkill("deploy")],
    shared: true,
    branch: "staging",
    branchSkills: ["deploy"],
    canPromote: true,
  })[0];
  const page = pageOf(row, {
    history: { gitRef: "staging", author: "MatteoB-adv", at, commit: "a3f9c21" },
  });
  assert.equal(page.reach, "Reaches Claude only");
  assert.deepEqual(page.facts, ["Last changed by MatteoB-adv 7 weeks ago", "1 file"]);
  // A listing that stopped at its bound says the count is a floor.
  const cut = pageOf(row, { files: 200, filesMore: true }).facts;
  assert.equal(cut[cut.length - 1], "200+ files");
  assert.deepEqual(page.primary, { id: "edit-in-code", label: "Edit in Code" });
  assert.equal(page.beside, null);
  assert.equal(page.status, null);
  assert.equal(page.notice, null);
  assert.equal(page.readingFooter, null);
  assert.equal(page.reveal, false);
  assert.match(page.detailsLine!, /^staging · a3f9c21 · MatteoB-adv /);
  assert.deepEqual(page.menu, [
    { id: "publish-to-branch", label: "Update on staging" },
    // GH #105: the skill is on the branch for Claude alone, so the page offers
    // to carry it over, exactly as the row's own `⋯` does.
    { id: "make-available-to-both", label: "Make available to both" },
    { id: "promote-to-team", label: "Promote to Team" },
    "divider",
    { id: "remove-from-branch", label: "Remove from staging…", danger: true },
  ]);
  assert.equal(page.reachNotice, null, "the two copies do not disagree");
}

// A file count Ply has not read yet is absent from the line, not `0 files`.
{
  const row = rowsOf({ repository: [repoSkill("deploy")] })[0];
  assert.deepEqual(pageOf(row, { files: null }).facts, []);
  assert.deepEqual(pageOf(row, { files: 2 }).facts, ["2 files"]);
}

// A skill that lives only on the branch: no primary at all — Ply's mirror is not
// the editor's to write — and the page says where the copy is. GH #142: the `⋯`
// opens it from the mirror all the same, as a reading view, which is the card
// #96 could not finish.
{
  const row = rowsOf({
    mirror: [{ name: "rollback", description: "On the branch.", dir: "/mirror/rollback" }],
    shared: true,
    branch: "staging",
    branchSkills: ["rollback"],
  })[0];
  assert.equal(row.openInCode, false);
  const page = pageOf(row);
  assert.equal(page.primary, null, "nothing in the checkout to edit");
  assert.equal(page.status, MIRROR_STATUS);
  assert.ok(page.menu.some((e) => e !== "divider" && e.id === "open-in-code"));
  assert.deepEqual(skillFileMode(row), { readOnly: true, place: "mirror" });
}

// A team skill: the page's primary is the copy, named by what it would do, and
// the clone is never **saved** — it opens read-only (GH #142).
{
  const teamRow = (repo: "absent" | "differs") =>
    rowsOf({
      team: [
        {
          name: "brief",
          description: "Writes a brief.",
          plugin: "ply",
          claude: true,
          codex: true,
          repo,
          dir: "/clone/brief",
        },
      ],
    })[0];
  assert.deepEqual(pageOf(teamRow("absent")).primary, {
    id: "install",
    label: "Install",
  });
  assert.deepEqual(pageOf(teamRow("differs")).primary, {
    id: "install",
    label: "Link and update…",
    confirm: true,
  });
  assert.equal(teamRow("absent").openInCode, false);
  assert.deepEqual(skillFileMode(teamRow("absent")), { readOnly: true, place: "team" });
  assert.ok(
    pageOf(teamRow("absent")).menu.some(
      (e) => e !== "divider" && e.id === "open-in-code",
    ),
    "`Install` is the primary, so the reading view stays in the `⋯`",
  );
}

// A personal skill (state D): the board's fact line, its status, its one action
// with the sentence beside it, the reading footer and `Reveal in Finder`.
{
  const row = rowsOf({
    personal: [
      {
        name: "captions",
        description: "Burns captions into a vertical cut. And more.",
        claude: true,
        codex: false,
        dir: "/h/.claude/skills/captions",
      },
    ],
    canPromote: true,
  })[0];
  const page = pageOf(row, {
    // Even handed a history, a personal folder is not a repository: the page
    // says `Yours · not shared with anyone`, which is what the board draws.
    history: { gitRef: "main", author: "Somebody", at: 1, commit: "abc1234" },
  });
  assert.equal(page.reach, "Reaches Claude only");
  assert.deepEqual(page.facts, ["Yours", "not shared with anyone", "1 file"]);
  assert.equal(page.status, PERSONAL_STATUS);
  // Walk F5: solo mode has no team library, so the line does not name one.
  assert.equal(pageOf(row, { solo: true }).status, PERSONAL_STATUS_SOLO);
  assert.doesNotMatch(PERSONAL_STATUS_SOLO, /team/);
  assert.match(PERSONAL_STATUS_SOLO, /this repository/);
  assert.deepEqual(page.primary, { id: "promote", label: "Share with Team…" });
  assert.equal(page.beside, PERSONAL_BESIDE);
  assert.equal(page.readingFooter, PERSONAL_READING_FOOTER);
  // The `⋯` still opens it (GH #142), so the sentence beside Promote may not
  // say nothing else can be done — it says the open is a reading view, and the
  // footer does not send the member to Code to change it.
  assert.doesNotMatch(PERSONAL_BESIDE, /Nothing else/);
  assert.match(PERSONAL_BESIDE, /read-only/);
  assert.match(PERSONAL_READING_FOOTER, /your own editor/);
  assert.equal(page.reveal, true);
  // GH #142: the one entry that is not an action — the copy opens to be read,
  // from the folder Ply never writes. `Promote` is still the page's primary.
  assert.deepEqual(page.menu, [{ id: "open-in-code", label: "Open in Code" }]);
  assert.deepEqual(skillFileMode(row), { readOnly: true, place: "this-mac" });
  // A personal skill with no directory has nothing to reveal.
  assert.equal(pageOf({ ...row, dir: null }).reveal, false);
}

// The duplicate notice, and `Keep both` silencing it.
{
  const rows = rowsOf({
    // The team library holds a different copy, so `Promote this one to Team`
    // would overwrite somebody's work and must ask first.
    repository: [repoSkill("deploy", { team: "differs" })],
    team: [
      {
        name: "deploy",
        description: "The team's.",
        plugin: "ply",
        claude: true,
        codex: true,
        repo: "differs",
        dir: "/clone/deploy",
      },
    ],
    shared: true,
    branch: "staging",
    branchSkills: ["deploy"],
    canPromote: true,
  });
  const repoRow = rows.find((r) => r.scope === "repository")!;
  const notice = pageOf(repoRow, { plugin: "ply" }).notice;
  assert.deepEqual(notice, {
    chip: "Also in Team",
    sentence: "Both reach the agents: this one as deploy, the team's as ply:deploy.",
  });
  assert.equal(
    pageOf(repoRow, { plugin: "ply", silenced: true }).notice,
    null,
    "`Keep both` takes the notice away; the list's chip is not this",
  );
  // The chip on the row is untouched by the silence — only the notice and its
  // row action go quiet (the card).
  assert.deepEqual(repoRow.duplicate, { chip: "Also in Team", other: "team" });

  // Compare's actions, read out of the row's own menu.
  assert.deepEqual(compareActions(repoRow), [
    { id: "keep-both", label: "Keep both" },
    { id: "remove-from-branch", label: "Remove from staging…", danger: true },
    { id: "promote-to-team", label: "Promote this one to Team", confirm: true },
  ]);
  const teamRow = rows.find((r) => r.scope === "team")!;
  assert.deepEqual(compareActions(teamRow), [
    { id: "keep-both", label: "Keep both" },
    { id: "install", label: "Link and update…", confirm: true },
  ]);
}

// Compare on a read-only workspace offers only what it may do, and `Keep both`
// is always among them: it writes nothing but this Mac's own settings.
{
  const readOnly = rowsOf({
    repository: [repoSkill("deploy")],
    team: [
      {
        name: "deploy",
        description: "The team's.",
        plugin: "ply",
        claude: true,
        codex: true,
        repo: "same",
      },
    ],
    shared: true,
    branch: "staging",
    branchReadOnly: true,
    branchSkills: ["deploy"],
  }).find((r) => r.scope === "repository")!;
  assert.deepEqual(compareActions(readOnly), [{ id: "keep-both", label: "Keep both" }]);

  // A personal skill's third action asks where, so it is not named after Team.
  const mine = rowsOf({
    repository: [repoSkill("captions")],
    personal: [
      {
        name: "captions",
        description: "Mine.",
        claude: true,
        codex: false,
        dir: "/h/.claude/skills/captions",
      },
    ],
    canPromote: true,
  }).find((r) => r.scope === "this-mac")!;
  assert.deepEqual(compareActions(mine), [
    { id: "keep-both", label: "Keep both" },
    { id: "promote", label: "Promote this one" },
  ]);
}

// The page's editor offer is the row's one field, for every scope at once — the
// same invariant the list's `⋯` is held to.
{
  const every = rowsOf({
    repository: [repoSkill("checkout")],
    mirror: [{ name: "branch-only", description: "On the branch.", dir: "/mirror/b" }],
    team: [
      {
        name: "team-one",
        description: "The team's.",
        plugin: "ply",
        claude: true,
        codex: true,
        repo: "absent",
        dir: "/clone/team-one",
      },
    ],
    personal: [
      {
        name: "mine",
        description: "Mine.",
        claude: true,
        codex: false,
        dir: "/h/.claude/skills/mine",
      },
    ],
    ply: [{
        name: "brief",
        title: "Write a good brief",
        description: "Writes a brief.",
        dir: "/Ply.app/Contents/Resources/ply-skills/brief",
        claude: true,
        codex: true,
        on: true,
      }],
    shared: true,
    branch: "staging",
    branchSkills: ["branch-only"],
    canPromote: true,
  });
  for (const row of every) {
    assert.equal(
      pageOf(row).primary?.id === "edit-in-code",
      row.openInCode,
      `${row.key}: only a checkout repository row may reach the editor`,
    );
  }
  // And Ply's own skills offer nothing at all.
  const ply = every.find((r) => r.scope === "ply")!;
  assert.deepEqual(pageOf(ply).menu, []);
  assert.equal(pageOf(ply).primary, null);
  assert.equal(pageOf(ply).status, PLY_STATUS);
}


// ── `Keep both` quietens the list row too (GH #100) ─────────────────────
//
// The card: "The list's `Also in …` chip stays; only the notice and its row
// action go quiet." So the chip survives, the row's `Compare` action goes, and
// `Compare` moves into the `⋯` — the chip never has nothing behind it.

{
  const HERE = "---\ndescription: Ships.\n---\n\nRun it.\n";
  const THERE = "---\ndescription: Ships.\n---\n\nRun it twice.\n";
  const raw = {
    repository: [repoSkill("deploy", { team: "differs" })],
    team: [
      {
        name: "deploy",
        description: "The team's.",
        plugin: "ply",
        claude: true,
        codex: true,
        repo: "differs" as const,
        dir: "/clone/deploy",
      },
    ],
    shared: true,
    branch: "staging",
    branchSkills: ["deploy"],
    canPromote: true,
  };
  const texts = {
    "repository:deploy": HERE,
    "team:deploy": THERE,
  };
  const duplicates = crossScopeDuplicates(input(raw));
  const quiet = withSilenced([], {
    here: "repository",
    there: "team",
    name: "deploy",
    hereContent: contentId(HERE),
    thereContent: contentId(THERE),
  });

  // Nothing silenced: both rows' one action is `Compare`.
  assert.deepEqual(silencedPairKeys(duplicates, texts, []), []);
  const loud = skillSections(input(raw));
  assert.deepEqual(loud[0].rows[0].action, { id: "compare", label: "Compare" });
  assert.deepEqual(loud[1].rows[0].action, { id: "compare", label: "Compare" });
  // …and the copy each one could still make sits in the `⋯`.
  assert.equal(labelOf(loud[1].rows[0].menu, "install"), "Link and update…");
  assert.equal(labelOf(loud[0].rows[0].menu, "compare"), null, "it is the action");

  // Silenced: one key, and it is the same key from either side.
  const keys = silencedPairKeys(duplicates, texts, quiet);
  assert.deepEqual(keys, [duplicatePairKey("team", "repository", "deploy")]);
  const hushed = skillSections(input({ ...raw, silencedPairs: keys }));
  const repoRow = hushed[0].rows[0];
  const teamRow = hushed[1].rows[0];
  // The chip stays — the fact has not changed.
  assert.deepEqual(repoRow.duplicate, { chip: "Also in Team", other: "team" });
  assert.deepEqual(teamRow.duplicate, { chip: "Also in this repository", other: "repository" });
  // The row action goes quiet: a repository skill at rest has none again, and the
  // team row has its copy back.
  assert.equal(repoRow.action, null);
  assert.deepEqual(teamRow.action, { id: "install", label: "Link and update…", confirm: true });
  // And `Compare` is in both `⋯`, so the chip still has something behind it.
  assert.equal(labelOf(repoRow.menu, "compare"), "Compare");
  assert.equal(labelOf(teamRow.menu, "compare"), "Compare");
  assert.equal(
    labelOf(teamRow.menu, "install"),
    null,
    "the copy is the action now; offering it twice would be two places for one press",
  );
  // The page agrees: no notice, and `Compare` reachable from the `⋯` there too.
  const page = skillPage({
    row: repoRow,
    files: 1,
    history: null,
    plugin: "ply",
    silenced: true,
    copies: "read",
    nowMs: Date.UTC(2026, 8, 22, 12, 0, 0),
  });
  assert.equal(page.notice, null);
  assert.equal(labelOf(page.menu, "compare"), "Compare");
  // Live again, and the page's `⋯` gives Compare back to the notice.
  const loudPage = skillPage({
    row: loud[0].rows[0],
    files: 1,
    history: null,
    plugin: "ply",
    silenced: false,
    copies: "read",
    nowMs: Date.UTC(2026, 8, 22, 12, 0, 0),
  });
  assert.ok(loudPage.notice);
  assert.equal(labelOf(loudPage.menu, "compare"), null);

  // A transient still outranks a duplicate, silenced or not: what is happening
  // now is the freshest fact about the row.
  const publishing = skillSections(
    input({
      ...raw,
      silencedPairs: keys,
      pending: [{ kind: "skill", name: "deploy", removed: false, pullRequest: { number: 9, url: "u" } }],
    }),
  )[0].rows[0];
  assert.deepEqual(publishing.action, { id: "open-pull-request", label: "Open pull request" });
  assert.equal(labelOf(publishing.menu, "compare"), "Compare");

  // A pair Ply could not read both halves of is NOT silenced: the mute is keyed
  // by both content ids, and guessing would hide a difference.
  assert.deepEqual(
    silencedPairKeys(duplicates, { "repository:deploy": HERE }, quiet),
    [],
  );
  // An edit to either copy ends the silence with no clock involved.
  assert.deepEqual(
    silencedPairKeys(duplicates, { ...texts, "team:deploy": `${THERE}More.\n` }, quiet),
    [],
  );
  assert.deepEqual(
    silencedPairKeys(duplicates, { ...texts, "repository:deploy": `${HERE}More.\n` }, quiet),
    [],
  );
}

// A personal duplicate silenced: its one action is still `Promote` (it was never
// `Compare`), and `Compare` stays in the `⋯`.
{
  const MINE = "---\ndescription: Mine.\n---\n";
  const THEIRS = "---\ndescription: Theirs.\n---\n";
  const raw = {
    repository: [repoSkill("captions")],
    personal: [
      {
        name: "captions",
        description: "Mine.",
        claude: true,
        codex: false,
        dir: "/h/.claude/skills/captions",
      },
    ],
    canPromote: true,
  };
  const keys = silencedPairKeys(
    crossScopeDuplicates(input(raw)),
    { "repository:captions": THEIRS, "this-mac:captions": MINE },
    withSilenced([], {
      here: "this-mac",
      there: "repository",
      name: "captions",
      hereContent: contentId(MINE),
      thereContent: contentId(THEIRS),
    }),
  );
  assert.equal(keys.length, 1);
  const rows = skillSections(input({ ...raw, silencedPairs: keys }));
  const mine = rows[3].rows[0];
  assert.deepEqual(mine.action, { id: "promote", label: "Share with Team…" });
  assert.deepEqual(mine.duplicate, { chip: "Also in this repository", other: "repository" });
  assert.equal(labelOf(mine.menu, "compare"), "Compare", "read-only, so still readable");
  // The repository side of the same pair is at rest.
  assert.equal(rows[0].rows[0].action, null);
}


// ── Review 1 (MAJOR): a mark belongs to a column, not to a pair ─────────
//
// BOARDS.md §4: "`≠` changed, `+` only here; the other side of a one-sided line
// is a neutral blank." One `mark` drawn in both columns made the empty column
// announce "only here" (review 1). And a `−` `(nothing here)` row opposite a pure
// addition read as a removed line that never existed (owner, 2026-10-20): the
// side that lacks the line draws nothing at all.

{
  const onlyHere = compareSkillText("a\nb\n", "a\n")[1];
  assert.equal(onlyHere.mark, "+", "the pair's mark still counts it as only-left");
  assert.equal(onlyHere.leftMark, "+", "the side with the text: only here");
  assert.equal(onlyHere.rightMark, "", "the side with nothing: a neutral blank");

  const onlyThere = compareSkillText("a\n", "a\nb\n")[1];
  assert.equal(onlyThere.mark, "−", "the pair's mark still counts it as only-right");
  assert.equal(onlyThere.leftMark, "", "a pure removal is blank on the side without it");
  assert.equal(onlyThere.rightMark, "+");

  // A changed line is `≠` on both sides: both are showing something.
  const changed = compareSkillText("a\n", "b\n")[0];
  assert.equal(changed.leftMark, "≠");
  assert.equal(changed.rightMark, "≠");
  // An identical line says nothing on either side.
  const same = compareSkillText("a\n", "a\n")[0];
  assert.equal(same.leftMark, "");
  assert.equal(same.rightMark, "");

  // The invariant, over every shape: no column ever draws `−`; an empty column
  // draws nothing; a one-sided line is `+` exactly where its text is.
  for (const [a, b] of [
    ["a\nb\nc\n", "a\n"],
    ["a\n", "a\nb\nc\n"],
    ["a\nb\n", "x\ny\n"],
    ["", "a\nb\n"],
    ["a\nb\n", ""],
  ] as const) {
    for (const line of compareSkillText(a, b)) {
      for (const side of ["left", "right"] as const) {
        const text = side === "left" ? line.left : line.right;
        const other = side === "left" ? line.right : line.left;
        const mark: string = side === "left" ? line.leftMark : line.rightMark;
        assert.notEqual(mark, "−", `no column draws a removed line: ${JSON.stringify(line)}`);
        if (text === null) assert.equal(mark, "", "an empty column is blank");
        else if (other === null) assert.equal(mark, "+", "the one side with text: only here");
      }
    }
  }
  // And the glyph/word pairing the component reads is the board's.
  assert.deepEqual(MARK_LABEL, {
    "≠": "changed",
    "+": "only here",
  });
}

// The compare heading's words are the board's for the copy whose page it is.
assert.equal(COMPARE_THIS_SIDE, "in use here");

// ── Review 1: the page says what is happening to the skill ──────────────
//
// It said nothing at all: a skill a teammate had removed showed `Edit in Code`
// and not one word about the removal, and the decision the row offered —
// `Keep on this Mac` — was nowhere.

{
  const shared = {
    repository: [repoSkill("deploy")],
    shared: true,
    branch: "staging",
    branchSkills: ["deploy"],
  };
  // Publishing: the line, a running dot, and `Edit in Code` still the primary
  // (nothing is waiting on the member).
  const publishing = pageOf(
    rowsOf({
      ...shared,
      pending: [{ kind: "skill", name: "deploy", removed: false, pullRequest: null }],
    })[0],
  );
  assert.deepEqual(publishing.transient, {
    line: "Publishing to staging…",
    state: "running",
  });
  assert.deepEqual(publishing.primary, { id: "edit-in-code", label: "Edit in Code" });

  // In a pull request: the line, the aborted dot, and the pull request as the
  // primary — `Open in Code` keeps its place in the `⋯`, so nothing is lost.
  const waiting = pageOf(
    rowsOf({
      ...shared,
      pending: [
        {
          kind: "skill",
          name: "deploy",
          removed: false,
          pullRequest: { number: 412, url: "u" },
        },
      ],
    })[0],
  );
  assert.deepEqual(waiting.transient, {
    line: "Waiting in pull request #412 — it reaches everyone once that is merged.",
    state: "aborted",
  });
  assert.deepEqual(waiting.primary, {
    id: "open-pull-request",
    label: "Open pull request",
  });
  assert.equal(labelOf(waiting.menu, "open-in-code"), "Open in Code");

  // Removed upstream: the line, an empty dot, and the one decision it asks for.
  // No `branchSkills` — the branch carrying the name again is what un-does a
  // removal (#96), so the two states cannot be asserted from one input.
  const gone = pageOf(
    rowsOf({
      ...shared,
      branchSkills: [],
      removedUpstream: [{ name: "deploy", author: "X", changedAt: null }],
    })[0],
  );
  assert.deepEqual(gone.transient, {
    line: "Removed on staging by X. Your copy here is the last one.",
    state: "empty",
  });
  assert.deepEqual(gone.primary, { id: "keep-on-this-mac", label: "Keep on this Mac" });
  assert.equal(labelOf(gone.menu, "open-in-code"), "Open in Code");

  // At rest: nothing to say, and `Open in Code` is the primary's own name, so it
  // is not offered twice.
  const atRest = pageOf(rowsOf(shared)[0]);
  assert.equal(atRest.transient, null);
  assert.deepEqual(atRest.primary, { id: "edit-in-code", label: "Edit in Code" });
  assert.equal(labelOf(atRest.menu, "open-in-code"), null);

  // Skills hub H8 (Mac re-walk): a linked copy's Update is its page's action
  // too, Edit in Code back in the ⋯ under its menu name.
  const linkedRow = { ...rowsOf(shared)[0], action: { id: "update" as const, label: "Update" } };
  const updating = pageOf(linkedRow);
  assert.deepEqual(updating.primary, { id: "update", label: "Update" });
  assert.equal(labelOf(updating.menu, "open-in-code"), "Open in Code");
  // And the ⋯'s Compare names a workspace origin as it is.
  assert.equal(compareLinkLabel("astra"), "Compare with astra");
  assert.equal(compareLinkLabel(null), "Compare with the library");
}

// ── Review 1: one copy unreadable — quiet, and say why ──────────────────
//
// The notice's one action is keyed by both content ids, so with one copy missing
// `Keep both` cannot be pressed. It showed anyway, with an action that did
// nothing.

{
  const row = rowsOf({
    repository: [repoSkill("deploy")],
    team: [
      {
        name: "deploy",
        description: "The team's.",
        plugin: "ply",
        claude: true,
        codex: true,
        repo: "differs",
        dir: "/clone/deploy",
      },
    ],
  }).find((r) => r.scope === "repository")!;

  const read = pageOf(row, { plugin: "ply", copies: "read" });
  assert.ok(read.notice, "both copies in hand: the notice speaks");
  assert.equal(read.duplicateUnknown, null);

  const pending = pageOf(row, { plugin: "ply", copies: "pending" });
  assert.equal(pending.notice, null, "not yet known: nothing is claimed");
  assert.equal(pending.duplicateUnknown, null, "and nothing is explained yet either");

  const missing = pageOf(row, { plugin: "ply", copies: "missing" });
  assert.equal(missing.notice, null, "no notice whose action cannot be pressed");
  assert.equal(
    missing.duplicateUnknown,
    "The same name is in the team library, and Plyloft cannot read both copies from " +
      "here — so it cannot say whether they still match.",
  );
  // And no `Compare` anywhere: the row's own action is still Compare (the pair is
  // not silenced — it cannot be, with a copy missing), so the menu never had the
  // entry, and a button that could only land on "Ply could not read one of the
  // two" is not worth offering. The sentence is what the member gets.
  assert.equal(labelOf(missing.menu, "compare"), null);
  assert.deepEqual(row.action, { id: "compare", label: "Compare" });
  // A row with no duplicate never says any of this.
  const alone = pageOf(rowsOf({ repository: [repoSkill("solo")] })[0], {
    copies: "missing",
  });
  assert.equal(alone.duplicateUnknown, null);
  assert.equal(alone.notice, null);
}

// ── A mute record whose pair is gone is pruned (review 1, tightened in 2) ──

{
  const record = (scopes: string, name: string): SilencedDuplicate => ({
    scopes,
    name,
    contents: ["a", "b"],
  });
  /** Everything this Mac can vouch for, plus the team library. */
  const WITH_TEAM = ["this-mac", "ply", "team"] as const;
  /** A Mac with no team key, or a clone not synced yet. */
  const NO_TEAM = ["this-mac", "ply"] as const;

  const live = crossScopeDuplicates(
    input({
      repository: [repoSkill("deploy")],
      team: [
        {
          name: "deploy",
          description: "The team's.",
          plugin: "ply",
          claude: true,
          codex: true,
          repo: "differs",
        },
      ],
    }),
  );
  assert.deepEqual([...livePairKeys(live)], [duplicatePairKey("repository", "team", "deploy")]);

  assert.equal(
    pruneSilencedDuplicates([record("repository|team", "deploy")], live, WITH_TEAM),
    null,
    "nothing to drop, so nothing is written",
  );
  assert.equal(
    pruneSilencedDuplicates([], live, WITH_TEAM),
    null,
    "an empty list is never rewritten",
  );

  // A pair of scopes the caller can vouch for, whose name is gone: dropped.
  assert.deepEqual(
    pruneSilencedDuplicates([record("team|this-mac", "captions")], live, WITH_TEAM),
    [],
  );
  assert.deepEqual(
    pruneSilencedDuplicates(
      [record("team|this-mac", "captions"), record("ply|this-mac", "brief")],
      live,
      WITH_TEAM,
    ),
    [],
  );

  // A record naming the **repository** is kept, however dead it looks from here:
  // settings.json is app-global and only the visible workspace's Library loads, so
  // another workspace's `deploy` is invisible to this call. Dropping it would
  // un-silence a notice on every workspace switch.
  assert.equal(
    pruneSilencedDuplicates(
      [record("repository|team", "gone-from-here"), record("repository|this-mac", "also-gone")],
      new Map(),
      WITH_TEAM,
    ),
    null,
    "no repository-side record is ever pruned from another workspace's list",
  );
  assert.ok(
    !WITH_TEAM.includes("repository" as never),
    "`repository` is never judgeable, so the rule above needs no special case",
  );

  // REVIEW 2 — a team library that read empty for a reason of its own must not
  // condemn a `team|this-mac` pair. Same list, same duplicates, one difference:
  // whether the caller could vouch for the team library.
  const teamPair = [record("team|this-mac", "captions")];
  assert.deepEqual(
    pruneSilencedDuplicates(teamPair, new Map(), WITH_TEAM),
    [],
    "the library is there and the name is not: the record is dead",
  );
  assert.equal(
    pruneSilencedDuplicates(teamPair, new Map(), NO_TEAM),
    null,
    "no key or no clone: the library read empty, which is evidence of nothing",
  );
  // A pair of this Mac's own scopes is still judged in that state — those folders
  // are read whole either way.
  assert.deepEqual(
    pruneSilencedDuplicates([record("ply|this-mac", "brief")], new Map(), NO_TEAM),
    [],
  );

  // Mixed: the judgeable dead one goes, the repository ones stay, the live one
  // stays.
  assert.deepEqual(
    pruneSilencedDuplicates(
      [
        record("team|this-mac", "captions"),
        record("repository|team", "deploy"),
        record("repository|team", "gone-from-here"),
      ],
      live,
      WITH_TEAM,
    ),
    [record("repository|team", "deploy"), record("repository|team", "gone-from-here")],
  );

  // ── REVIEW 2 — the prune is a mutation, not a snapshot ─────────────────
  //
  // It was computed from a snapshot read before the write and the result written
  // inside `update`, so `latest` was discarded: a `Keep both` that landed while the
  // prune was queued was silently undone. The queue serialises the writes; it
  // cannot know the value being written was stale.

  type Settingsish = {
    theme: string;
    library: { silencedDuplicates: SilencedDuplicate[] };
  };
  const dead = record("team|this-mac", "captions");
  const fresh = record("team|this-mac", "titles");

  // The no-op case returns the very same object, so a caller can tell.
  {
    const latest: Settingsish = { theme: "dark", library: { silencedDuplicates: [] } };
    assert.equal(prunedSilencedIn(latest, live, WITH_TEAM), latest);
  }
  // And it prunes from `latest`, leaving everything else alone.
  {
    const latest: Settingsish = {
      theme: "dark",
      library: { silencedDuplicates: [dead, record("repository|team", "deploy")] },
    };
    const next = prunedSilencedIn(latest, live, WITH_TEAM);
    assert.deepEqual(next.library.silencedDuplicates, [record("repository|team", "deploy")]);
    assert.equal(next.theme, "dark");
    assert.deepEqual(
      latest.library.silencedDuplicates,
      [dead, record("repository|team", "deploy")],
      "the input is never mutated",
    );
  }

  // The race, through the real queue: a slow `Keep both` is in flight when the
  // prune is queued behind it. The prune must drop the dead record and **keep**
  // the one the press added — which the old code could not, because its `pruned`
  // was computed before the press existed.
  {
    // `titles` really is a live `team|this-mac` duplicate, so the prune has no
    // business dropping it; `captions` is not, so it has every business dropping
    // that. The test is whether it reads the list it is actually writing.
    const liveWithTitles = crossScopeDuplicates(
      input({
        team: [
          {
            name: "titles",
            description: "The team's.",
            plugin: "ply",
            claude: true,
            codex: true,
            repo: "absent",
          },
        ],
        personal: [
          {
            name: "titles",
            description: "Mine.",
            claude: true,
            codex: false,
            dir: "/h/.claude/skills/titles",
          },
        ],
      }),
    );
    assert.deepEqual(
      [...livePairKeys(liveWithTitles)],
      [duplicatePairKey("team", "this-mac", "titles")],
    );
    let committed: Settingsish = {
      theme: "dark",
      library: { silencedDuplicates: [dead] },
    };
    const disk: Settingsish[] = [];
    const delays = [40, 1];
    let call = 0;
    const mutate = createMutationQueue<Settingsish>({
      read: () => committed,
      send: (next) =>
        new Promise((resolve) =>
          setTimeout(() => {
            disk.push(next);
            resolve(next);
          }, delays[call++] ?? 0),
        ),
      commit: (saved) => {
        committed = saved;
      },
    });
    // The snapshot the prune's "anything to do?" guard was taken from: `fresh` is
    // not in it, because the press has not landed yet.
    const snapshot = committed.library.silencedDuplicates;
    assert.ok(!snapshot.includes(fresh));

    const press = mutate((latest) => ({
      ...latest,
      library: { ...latest.library, silencedDuplicates: withSilenced(latest.library.silencedDuplicates, identityOf(fresh)) },
    }));
    const prune = mutate((latest) => prunedSilencedIn(latest, liveWithTitles, WITH_TEAM));
    await Promise.all([press, prune]);

    const names = committed.library.silencedDuplicates.map((r) => r.name);
    assert.ok(names.includes("titles"), "the `Keep both` that landed mid-prune survives");
    assert.ok(!names.includes("captions"), "and the dead record is still pruned");
    assert.equal(disk.length, 2, "both writes reached disk, in order");
  }
}

// ── GH #105: reach, the two copies on the branch, and keeping them aligned ──
//
// Reach is a property of the skill: the roots this checkout has, and the roots
// the repository's shared copy on the branch has. Claude's branch-only copy is
// handed to every session Ply starts (the `project` plugin); Codex has no such
// delivery, so a Codex copy that is only on the branch says so in words rather
// than letting the chip imply more than Ply does.

const mirrorRow = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  description: `What ${name} does on the branch.`,
  dir: `/mirror/.claude/skills/${name}`,
  claude: true,
  codex: false,
  differs: false,
  codexDir: null,
  ...over,
});

const branchInput = (over: Partial<SkillsInput>): Partial<SkillsInput> => ({
  shared: true,
  branch: "staging",
  branchSkills: ["deploy"],
  ...over,
});

// The words are the card's and the board's.
assert.equal(MAKE_BOTH_LABEL, "Make available to both");
assert.equal(MAKE_ALL_BOTH_LABEL, "Make all available to both");
assert.equal(ALIGN_LABEL, "Align");
assert.equal(DIFFERS_CHIP, "Differs between Claude and Codex");
assert.equal(COMPARE_REACH_LABEL, "Compare Claude and Codex");

// A copy on the branch for each CLI: one item, and the Codex chip **only** once
// this checkout has the copy Codex reads (review 1, MINOR). Ply hands Claude the
// branch's copy through its `project` plugin and has no such delivery for Codex,
// so the branch-only Codex copy is a sentence, not a chip.
{
  const rows = rowsOf(
    branchInput({
      repository: [repoSkill("deploy")],
      mirror: [mirrorRow("deploy", { codex: true, codexDir: "/mirror/.agents/skills/deploy" })],
    }),
  );
  assert.equal(rows.length, 1, "present for both is one item in the Library");
  assert.ok(rows[0].claude);
  assert.equal(rows[0].codex, false, "nothing delivers it to Codex here yet");
  assert.deepEqual(rows[0].notes, [
    "Codex's copy is on staging and not in your project folder yet; Codex reads it here once the folder has it. Ask the Builder to bring it here.",
  ]);
  // Nothing left to carry over: the branch has both, so no row offers the copy
  // and the section has no button — whatever the line still says about reach.
  assert.deepEqual(makeAllBoth(rows), []);
  assert.equal(labelOf(rows[0].menu, "make-available-to-both"), null);

  // Once the checkout has it too, both chips are lit and the line goes quiet.
  const pulled = rowsOf(
    branchInput({
      repository: [repoSkill("deploy", { codex: true, roots: [".claude/skills", ".agents/skills"] })],
      mirror: [mirrorRow("deploy", { codex: true, codexDir: "/mirror/.agents/skills/deploy" })],
    }),
  );
  assert.ok(pulled[0].claude && pulled[0].codex);
  assert.equal(oneCliLine(pulled), null, "nothing reaches one CLI only any more");
  assert.deepEqual(pulled[0].notes, [], "the sentence has nothing left to say");
}

// Claude only, on the branch: the section line, the button's targets and the
// row's own entry all say the same thing.
{
  const rows = rowsOf(
    branchInput({ repository: [repoSkill("deploy")], mirror: [mirrorRow("deploy")] }),
  );
  assert.equal(rows[0].codex, false);
  assert.equal(oneCliLine(rows), "All 1 reach Claude only.");
  assert.deepEqual(makeAllBoth(rows), ["deploy"]);
  assert.deepEqual(rows[0].notes, [], "Claude's own copy needs no sentence");
}

// A read-only collaborator sees the property and none of the actions — and the
// section's button offers nothing, because it offers exactly what the rows do.
{
  const rows = rowsOf(
    branchInput({
      repository: [repoSkill("deploy")],
      mirror: [mirrorRow("deploy")],
      branchReadOnly: true,
    }),
  );
  assert.equal(rows[0].claude, true, "the property is still shown");
  assert.equal(oneCliLine(rows), "All 1 reach Claude only.");
  assert.deepEqual(makeAllBoth(rows), []);
  assert.deepEqual(rows[0].menu, [{ id: "open-in-code", label: "Open in Code" }]);
}

// A skill in the checkout that is not on the branch yet: published first.
{
  const rows = rowsOf(branchInput({ repository: [repoSkill("deploy")], branchSkills: [] }));
  assert.deepEqual(makeAllBoth(rows), []);
  assert.equal(
    labelOf(rows[0].menu, "publish-to-branch"),
    "Publish to staging",
    "there is nothing on the branch to carry over from",
  );
}

// Drift: the row says so, its one action is the comparison, and `Align` is in
// the `⋯` — one action per row, as the board draws it.
{
  const rows = rowsOf(
    branchInput({
      // The checkout has both copies (it pulled them), so the chips are lit and
      // the two copies **on the branch** are the ones that disagree.
      repository: [repoSkill("deploy", { codex: true, roots: [".claude/skills", ".agents/skills"] })],
      mirror: [
        mirrorRow("deploy", {
          codex: true,
          differs: true,
          codexDir: "/mirror/.agents/skills/deploy",
        }),
      ],
    }),
  );
  const row = rows[0];
  assert.deepEqual(row.drift, {
    chip: DIFFERS_CHIP,
    claudeDir: "/mirror/.claude/skills/deploy",
    codexDir: "/mirror/.agents/skills/deploy",
  });
  assert.deepEqual(row.action, { id: "compare-reach", label: "Compare" });
  assert.equal(labelOf(row.menu, "align"), "Align");
  assert.equal(
    labelOf(row.menu, "compare-reach"),
    null,
    "the row's own action is the comparison, so the `⋯` does not repeat it",
  );
  assert.equal(labelOf(row.menu, "make-available-to-both"), null);
  assert.deepEqual(makeAllBoth(rows), [], "a disagreement is aligned, not copied over");

  // The page carries the same fact as its own notice, with `Compare` on it, and
  // `Align` under the comparison.
  const page = pageOf(row, { branch: "staging" });
  assert.equal(page.reach, "Reaches Claude and Codex");
  assert.deepEqual(page.reachNotice, {
    chip: DIFFERS_CHIP,
    sentence: driftSentence("deploy", "staging"),
  });
  assert.ok(
    page.reachNotice!.sentence.includes("are not the same file"),
    page.reachNotice!.sentence,
  );
  assert.equal(
    labelOf(page.menu as SkillMenuEntry[], "compare-reach"),
    null,
    "while the notice is showing, the notice is where Compare lives",
  );
  assert.equal(labelOf(page.menu as SkillMenuEntry[], "align"), "Align");
  assert.deepEqual(reachCompareActions(row), [{ id: "align", label: "Align" }]);
}

// Drift Ply cannot act on: without the second copy's directory there is nothing
// to compare and nothing to align from, so there is no chip either.
{
  const rows = rowsOf(
    branchInput({
      repository: [repoSkill("deploy")],
      mirror: [mirrorRow("deploy", { codex: true, differs: true, codexDir: null })],
    }),
  );
  assert.equal(rows[0].drift, null);
  assert.equal(rows[0].action, null);
  assert.deepEqual(reachCompareActions(rows[0]), []);
}

// What is happening right now still outranks both facts (GH #96's order).
{
  const rows = rowsOf(
    branchInput({
      repository: [repoSkill("deploy")],
      mirror: [
        mirrorRow("deploy", {
          codex: true,
          differs: true,
          codexDir: "/mirror/.agents/skills/deploy",
        }),
      ],
      pending: [
        {
          kind: "skill",
          name: "deploy",
          removed: false,
          pullRequest: { number: 412, url: "https://github.com/o/r/pull/412" },
        },
      ],
    }),
  );
  assert.deepEqual(rows[0].action, { id: "open-pull-request", label: "Open pull request" });
  assert.equal(
    labelOf(rows[0].menu, "compare-reach"),
    COMPARE_REACH_LABEL,
    "the chip keeps something behind it when a transient takes the action",
  );
}

// A branch-only skill: the mirror's own reach, and the Codex sentence.
{
  const rows = rowsOf(
    branchInput({
      mirror: [
        mirrorRow("shipped", { codex: true, codexDir: "/mirror/.agents/skills/shipped" }),
      ],
      branchSkills: ["shipped"],
    }),
  );
  // Claude's chip is lit because Ply hands it to every Claude session; Codex's is
  // not, because nothing hands it to Codex from here (review 1, MINOR).
  assert.ok(rows[0].claude && rows[0].fromMirror);
  assert.equal(rows[0].codex, false);
  assert.equal(rows[0].openInCode, false, "the mirror is not the tree Plyloft may write");
  assert.deepEqual(rows[0].notes, [
    "Codex's copy is on staging and not in your project folder yet; Codex reads it here once the folder has it. Ask the Builder to bring it here.",
  ]);
}

// GH #156: Ply hands the branch's Codex copies to every Codex session it starts
// (the `ply-project` marketplace in the `CODEX_HOME` overlay), so the Codex chip is
// reach again — checkout ∪ branch, like Claude's — and the sentence goes. Each case
// the delivery can answer, for both shapes of row: a skill the checkout has for
// Claude only, and one that is only on the branch.
{
  const codexOnBranch = mirrorRow("deploy", {
    codex: true,
    codexDir: "/mirror/.agents/skills/deploy",
  });
  const shapes = {
    checkoutClaudeOnly: { repository: [repoSkill("deploy")], mirror: [codexOnBranch] },
    branchOnly: { mirror: [codexOnBranch] },
  };
  for (const [shape, over] of Object.entries(shapes)) {
    // Delivered: the chip is lit and nothing needs saying.
    const delivered = rowsOf(
      branchInput({ ...over, branchCodex: { reaches: true, refused: null } }),
    );
    assert.equal(delivered.length, 1, shape);
    assert.ok(delivered[0].claude, `${shape}: Claude's chip, as before`);
    assert.equal(delivered[0].codex, true, `${shape}: Plyloft hands it to Codex now`);
    assert.deepEqual(delivered[0].notes, [], `${shape}: the sentence goes`);
    assert.equal(oneCliLine(delivered), null, `${shape}: it reaches both`);

    // Refused on this Mac: dark, and the row says why in the overlay's own words.
    const refused = rowsOf(
      branchInput({
        ...over,
        branchCodex: {
          reaches: false,
          refused:
            "you already have a Codex marketplace named `ply-project`, so Plyloft did not add " +
            "the branch's project skills marketplace",
        },
      }),
    );
    assert.equal(refused[0].codex, false, `${shape}: no chip for a reach refused`);
    assert.deepEqual(
      refused[0].notes,
      [
        "Codex's copy is on staging and not in your project folder yet, and Plyloft could not hand " +
          "it to Codex on this Mac: you already have a Codex marketplace named " +
          "`ply-project`, so Plyloft did not add the branch's project skills marketplace. " +
          "Codex reads it here once the folder has it. Ask the Builder to bring it here.",
      ],
      shape,
    );

    // No Codex home: dark, and quiet — a member who does not use Codex has
    // nothing to fix.
    const noCodex = rowsOf(
      branchInput({ ...over, branchCodex: { reaches: false, refused: null } }),
    );
    assert.equal(noCodex[0].codex, false, shape);
    assert.deepEqual(noCodex[0].notes, [], shape);
  }

  // A refusal that already ends in a full stop is not given a second one.
  const dotted = rowsOf(
    branchInput({
      mirror: [codexOnBranch],
      branchCodex: { reaches: false, refused: "your Codex config.toml could not be parsed." },
    }),
  );
  assert.ok(dotted[0].notes[0].includes("could not be parsed. Codex reads it"), dotted[0].notes[0]);

  // The delivery lights nothing the branch does not carry: a Claude-only branch
  // copy stays Claude only, whatever Codex could take.
  const claudeOnly = rowsOf(
    branchInput({ mirror: [mirrorRow("deploy")], branchCodex: { reaches: true, refused: null } }),
  );
  assert.ok(claudeOnly[0].claude && !claudeOnly[0].codex);
  // And the checkout's own Codex copy lights the chip whatever the delivery says.
  const local = rowsOf(
    branchInput({
      repository: [repoSkill("deploy", { codex: true, roots: [".claude/skills", ".agents/skills"] })],
      mirror: [codexOnBranch],
      branchCodex: { reaches: false, refused: "refused" },
    }),
  );
  assert.ok(local[0].codex);
  assert.deepEqual(local[0].notes, []);
}

// A state written by an older build has no reach on its mirror rows, and what it
// meant by "on the branch" was the Claude copy — which is what #96 drew.
{
  const rows = rowsOf(
    branchInput({
      mirror: [{ name: "deploy", description: "What deploy does.", dir: "/mirror/d" }],
    }),
  );
  assert.ok(rows[0].claude && !rows[0].codex && rows[0].drift === null);
  assert.deepEqual(makeAllBoth(rows), ["deploy"]);
}

// A skill the checkout has only for Codex can still be published: both copies
// travel together, and `inCheckout` is about either root **the channel carries**.
{
  const rows = rowsOf(
    branchInput({
      repository: [repoSkill("codexy", { claude: false, codex: true, roots: [".agents/skills"] })],
      branchSkills: [],
    }),
  );
  assert.equal(labelOf(rows[0].menu, "publish-to-branch"), "Publish to staging");
}

// Walk F6: after `Align` lands, the branch's copies agree while this checkout's
// (behind) still differ. The note says the branch has them aligned and a pull
// brings them — not "make them match" — and Promote stays refused.
{
  const BLOCKED = "The copies of `lint` in this repo are not the same file. Make them match first.";
  const lint = (mirror: Record<string, unknown>) =>
    rowsOf(
      branchInput({
        repository: [
          repoSkill("lint", {
            codex: true,
            roots: [".claude/skills", ".agents/skills"],
            promoteBlocked: BLOCKED,
          }),
        ],
        mirror: [{ name: "lint", description: "Lints.", dir: "/m/c", codexDir: "/m/x", ...mirror }],
        branchSkills: ["lint"],
        canPromote: true,
      }),
    )[0];
  const aligned = lint({ claude: true, codex: true, differs: false });
  assert.ok(!aligned.notes.includes(BLOCKED));
  assert.ok(aligned.notes.includes(alignedOnBranchLine("lint", "staging")));
  assert.match(alignedOnBranchLine("lint", "staging"), /aligned on staging.*Your project folder is behind staging\. Ask the Builder/);
  // Still refused — shown off (F4), with the same line the notes give.
  assert.deepEqual(
    aligned.menu.find((e) => e !== "divider" && e.id === "promote-to-team"),
    {
      id: "promote-to-team",
      label: "Promote to Team",
      disabled: true,
      hint: alignedOnBranchLine("lint", "staging"),
    },
    "still refused",
  );
  // Still disagreeing on the branch too: the checkout's own words stay.
  assert.ok(lint({ claude: true, codex: true, differs: true }).notes.includes(BLOCKED));
  // One copy on the branch: nothing aligned there to point at.
  assert.ok(lint({ claude: true, codex: false }).notes.includes(BLOCKED));
  // Review: a legacy `.codex/skills` copy is never on the branch, so no pull
  // fixes it — the checkout's own words stay.
  const legacy = rowsOf(
    branchInput({
      repository: [
        repoSkill("lint", {
          codex: true,
          roots: [".claude/skills", ".codex/skills"],
          promoteBlocked: BLOCKED,
        }),
      ],
      mirror: [{ name: "lint", description: "Lints.", dir: "/m/c", codexDir: "/m/x", claude: true, codex: true }],
      branchSkills: ["lint"],
    }),
  )[0];
  assert.ok(legacy.notes.includes(BLOCKED));
  // Review: an Align still queued is not on the branch yet (the mirror shows it
  // ahead), so a pull would bring nothing — and group B §2's Windows walk: while
  // a publish of the skill is on its way, "make them match" read as a refusal of
  // it. Neither note is shown; the row's transient says what is happening.
  const queued = rowsOf(
    branchInput({
      repository: [
        repoSkill("lint", {
          codex: true,
          roots: [".claude/skills", ".agents/skills"],
          promoteBlocked: BLOCKED,
        }),
      ],
      mirror: [{ name: "lint", description: "Lints.", dir: "/m/c", codexDir: "/m/x", claude: true, codex: true }],
      branchSkills: ["lint"],
      pending: [{ kind: "skill", name: "lint", removed: false, pullRequest: null }],
    }),
  )[0];
  assert.ok(!queued.notes.includes(BLOCKED), "not while the publish is on its way");
  assert.ok(!queued.notes.includes(alignedOnBranchLine("lint", "staging")));
  assert.equal(queued.transient?.kind, "publishing");
  // Once it has landed (nothing pending), the checkout's own state speaks again.
}

// Group B §2 walks: after an Update let the branch's Codex copy follow the
// edited Claude copy, the checkout's Codex copy only lags behind. One plain
// line says so — no "make them match", no "aligned… cannot be promoted yet".
{
  const BLOCKED = "The copies of `walk-rule` in this repo are not the same file. Make them match first.";
  const row = rowsOf(
    branchInput({
      repository: [
        repoSkill("walk-rule", {
          codex: true,
          roots: [".claude/skills", ".agents/skills"],
          promoteBlocked: BLOCKED,
        }),
      ],
      mirror: [{ name: "walk-rule", description: "Walks.", dir: "/m/c", codexDir: "/m/x", claude: true, codex: true, differs: false }],
      branchSkills: ["walk-rule"],
      checkoutBehind: [{ name: "walk-rule", copy: "codex" }],
    }),
  )[0];
  assert.deepEqual(row.notes.filter((n) => /behind|match|aligned/.test(n)), [
    "Published to staging for Claude and Codex. Your project folder's Codex copy is behind staging — Ask the Builder to bring it here.",
  ]);
  assert.equal(row.drift, null, "no Differs chip");
  assert.equal(checkoutBehindLine("claude", null), "Published to the integration branch for Claude and Codex. Your project folder's Claude copy is behind the integration branch — Ask the Builder to bring it here.");
}

// …but a skill that lives only in the legacy `.codex/skills` has nothing to
// publish: Codex loads it here, Ply never writes that root, and the channel would
// find no files to send (review 1, MINOR).
{
  const rows = rowsOf(
    branchInput({
      repository: [repoSkill("legacy", { claude: false, codex: true, roots: [".codex/skills"] })],
      branchSkills: [],
    }),
  );
  assert.equal(rows[0].codex, true, "Codex does load it, and the chip says so");
  assert.equal(
    labelOf(rows[0].menu, "publish-to-branch"),
    null,
    "there is nothing the channel could carry",
  );
}

// Review 1 (MINOR): the section's button sends **every** name, so a skill that
// cannot travel is reported by the backend rather than silently left out — and
// there is no button at all when no row offers the copy.
{
  const rows = rowsOf(
    branchInput({
      repository: [repoSkill("onbranch"), repoSkill("fresh")],
      mirror: [mirrorRow("onbranch")],
      branchSkills: ["onbranch"],
    }),
  );
  assert.deepEqual(
    makeAllBoth(rows),
    ["fresh", "onbranch"],
    "the button said all of them, so all of them are sent",
  );
  assert.equal(labelOf(rows.find((r) => r.name === "fresh")!.menu, "make-available-to-both"), null);
  // Read-only: no row offers it, so there is nothing to press.
  const readOnly = rowsOf(
    branchInput({
      repository: [repoSkill("onbranch"), repoSkill("fresh")],
      mirror: [mirrorRow("onbranch")],
      branchSkills: ["onbranch"],
      branchReadOnly: true,
    }),
  );
  assert.deepEqual(makeAllBoth(readOnly), []);
}

// ── The skills that come with Ply (GH #106) ─────────────────────────────

// The row carries its plain name and this Mac's switch, and the section is the
// third one, headed `Comes with Ply · switched on per Mac`.
{
  const ply = (over: Partial<PlySkillInput> = {}): PlySkillInput => ({
    name: "card-brief",
    title: "Write a good card brief",
    description: "Turns a rough idea into a brief an agent can work from. More.",
    dir: "/Ply.app/Contents/Resources/ply-skills/card-brief",
    claude: true,
    codex: true,
    on: true,
    ...over,
  });
  const sections = skillSections(input({ ply: [ply()] }));
  const row = sections[2].rows[0];
  assert.equal(sections[2].scope, "ply");
  assert.equal(row.key, "ply:card-brief");
  // `name` stays the directory — the identity both CLIs use (`ply:card-brief`) —
  // and the plain name the row shows is its own field, so neither ever stands in
  // for the other.
  assert.equal(row.name, "card-brief");
  assert.deepEqual(row.ply, { title: "Write a good card brief", on: true, changes: [], switch: null, place: null });
  assert.equal(row.hint, "Turns a rough idea into a brief an agent can work from.");
  // Its text is readable, and it is never opened in the editor: the bundle is
  // the app's (ADR 0005).
  assert.equal(row.dir, "/Ply.app/Contents/Resources/ply-skills/card-brief");
  assert.equal(row.openInCode, false);
  // The plugin a session loads it as, so a duplicate's sentence can say
  // `ply:card-brief` rather than claiming both copies share a bare name.
  assert.equal(row.plugin, PLY_PLUGIN);
  // A switched-off skill is still a row, with its switch off: the section is how
  // it is switched back on.
  const off = skillSections(input({ ply: [ply({ on: false })] }))[2].rows[0];
  assert.deepEqual(off.ply, { title: "Write a good card brief", on: false, changes: [], switch: null, place: null });
  // Every other scope's row says it is not Ply's, so the switch cannot be drawn
  // where there is nothing to switch.
  for (const other of rowsOf({
    repository: [
      { name: "deploy", description: "Deploys.", claude: true, codex: false, roots: [".claude/skills"] },
    ],
    personal: [
      { name: "mine", description: "Mine.", claude: true, codex: false, dir: "/h/mine" },
    ],
  })) {
    if (other.scope !== "ply") assert.equal(other.ply, null, other.key);
  }

  // The filter finds it by the name it shows, by its directory, and by its
  // description — a skill has both names, and the field says "name or
  // description".
  for (const query of ["good card", "card-brief", "rough idea"]) {
    assert.equal(filterSkillRows([row], query).length, 1, query);
  }
  assert.equal(filterSkillRows([row], "nothing like it").length, 0);

  // The page (BOARDS.md §6): the plain title, both chips, `Ships with Ply` and
  // nothing else in the fact line — no author, no age and no file count — the
  // status sentence, and the closing line word for word.
  const page = pageOf(row);
  assert.equal(page.status, PLY_STATUS);
  // Cold read 2026-10-19: what a session gets, not "switched on per Mac".
  // (Challenger) A shell tile where you type `claude` doesn't get them.
  assert.equal(PLY_STATUS, "Comes with Plyloft · every Claude and Codex tile, card and run Plyloft opens gets it.");
  assert.equal(plyStatus(true, false, true), "Comes with Plyloft · every Claude tile, card and run Plyloft opens gets it.");
  assert.equal(plyStatus(false, true, true), "Comes with Plyloft · every Codex tile, card and run Plyloft opens gets it.");
  assert.match(plyStatus(true, true, false), /^Comes with Plyloft · switched off on this (Mac|PC), so no tile, card or run gets it\.$/);
  assert.deepEqual(page.facts, [PLY_FACT]);
  assert.equal(page.reach, "Reaches Claude and Codex");
  assert.equal(page.primary, null);
  assert.deepEqual(page.menu, []);
  assert.equal(page.beside, null);
  assert.equal(page.reveal, false);
  assert.equal(
    page.readingFooter,
    "This skill comes with Plyloft and can't be edited. To change how it works here, " +
      "Personalize it: your own copy switches this one off where it applies.",
  );
  // A file count would be a fact about the app, not about the skill.
  assert.deepEqual(pageOf(row, { files: 3 }).facts, [PLY_FACT]);
  // And the words of the switch's own row.
  assert.equal(PLY_SWITCH_GROUP, "On this Mac");
  assert.equal(PLY_SWITCH_LABEL, "Use this skill");
  assert.equal(
    PLY_SWITCH_HINT,
    "Switched on for every workspace on this Mac. Other Macs decide for themselves.",
  );

  // A repository skill of the same name (review 1: the path STATUS claimed and
  // nothing tested). Neither copy wins, both rows carry the chip, and each
  // page's sentence names each copy the way a session names it.
  const paired = skillSections(
    input({
      ply: [ply()],
      repository: [
        {
          name: "card-brief",
          description: "Ours.",
          claude: true,
          codex: false,
          roots: [".claude/skills"],
        },
      ],
    }),
  );
  const plyHalf = paired[2].rows[0];
  const repoHalf = paired[0].rows[0];
  assert.equal(plyHalf.duplicate?.chip, "Also in this repository");
  assert.equal(repoHalf.duplicate?.chip, "Also in Plyloft");
  assert.equal(
    pageOf(plyHalf, { plugin: null }).notice?.sentence,
    "Both reach the agents: this one as ply:card-brief, the repository's as card-brief.",
    "the Plyloft copy is what a session calls it",
  );
  assert.equal(
    pageOf(repoHalf, { plugin: PLY_PLUGIN }).notice?.sentence,
    "Both reach the agents: this one as card-brief, Plyloft's as ply:card-brief.",
  );
  // Nothing wins, so neither page offers a way to make one win: the Ply page has
  // no action at all, and the repository page's own actions are unchanged.
  assert.equal(pageOf(plyHalf, { plugin: null }).primary, null);
  assert.deepEqual(pageOf(plyHalf, { plugin: null }).menu, []);
  // And a silenced pair says nothing, on either side.
  assert.equal(pageOf(plyHalf, { plugin: null, silenced: true }).notice, null);
}

// The section says it once when these skills reach nothing (review 1): what
// happened, what was left alone, what to do — and a reason that arrives as a
// fragment is still ended, so the next sentence does not run into it.
assert.equal(
  plySectionProblem("/Ply.app/.../alpha/linked.md is a symlink"),
  "Your sessions aren't getting these skills right now, even though they're switched on: " +
    "/Ply.app/.../alpha/linked.md is a symlink. Your switches are kept, and your own " +
    "skills and your team's are unaffected. Try again reads them again; if it keeps " +
    "happening, it's a bug in Plyloft.",
);
assert.ok(
  !plySectionProblem("Something broke.").includes(".."),
  "a reason that already ends in a full stop is not given a second one",
);
// Review 2: the retry is a re-read of the section, which is what really re-reads
// it — not a restart of the app, which would ask for more than the fix needs. It
// names the section's own button, not a walk away from the page and back.
assert.ok(!plySectionProblem("Broke.").includes("Reopening Plyloft"));
assert.match(plySectionProblem("Broke."), new RegExp(`${PLY_RETRY_LABEL} reads them again`));


// GH #215 on the Skills page: the section's Un-ignore is about every root a row
// says git ignores, each once.
assert.deepEqual(
  ignoredSkillRoots([
    { ignoredRoots: [".claude/skills"] },
    { ignoredRoots: [] },
    { ignoredRoots: [".claude/skills", ".agents/skills"] },
    {},
  ]),
  [".claude/skills", ".agents/skills"],
);
assert.match(ignoredRootsLine([".claude/skills"]), /^Git ignores \.claude\/skills here/);
assert.match(ignoredRootsLine([".claude/skills", ".agents/skills"]), /copies in them/);

// A skill page's file list names only what kept it short.
assert.equal(fileListCutLine(NO_CUT), null);
assert.equal(fileListShort(NO_CUT), false);
assert.equal(
  fileListCutLine({ ...NO_CUT, unreadable: 1 }),
  "Not every file is listed: Plyloft couldn't read 1 folder.",
);
assert.equal(
  fileListCutLine({ ...NO_CUT, files: true, folders: true }),
  "Not every file is listed: the list stops at 200 files; it opens at most 50 folders.",
);
// A symlink is not a file that travels, so it is said but does not make the
// count a floor.
assert.equal(
  fileListCutLine({ ...NO_CUT, links: 2 }),
  "2 symlinks are left out — Plyloft won't copy a skill that holds them.",
);
assert.equal(fileListShort({ ...NO_CUT, links: 2 }), false);
assert.equal(fileListShort({ ...NO_CUT, depth: true }), true);


// 2026-09-30 (Windows parity): a team skill's Codex chip is what a Codex session
// here really gets. The library holding a Codex copy is not enough when the
// overlay that carries it is refused; the row then says why, once.
{
  const team = [
    { name: "brief", description: "Writes a brief.", plugin: "ply", claude: true, codex: true, repo: "absent" as const },
    { name: "claude-only", description: "Only Claude.", plugin: "ply", claude: true, codex: false, repo: "absent" as const },
  ];
  const refused = {
    reaches: false,
    refused: "link auth.json into the Codex overlay: your Codex home is on a different drive.",
  };
  const rows = teamRows(input({ team, teamCodex: refused }), new Map());
  const brief = rows.find((r) => r.name === "brief")!;
  assert.equal(brief.codex, false, "a refused overlay lights no Codex chip");
  assert.equal(brief.claude, true, "Claude is unaffected");
  assert.deepEqual(brief.notes, [
    "Plyloft could not hand it to Codex on this Mac: link auth.json into the Codex overlay: your Codex home is on a different drive.",
  ]);
  const claudeOnly = rows.find((r) => r.name === "claude-only")!;
  assert.deepEqual(claudeOnly.notes, [], "no Codex copy, nothing to explain");

  // Delivered, and an older backend with no answer: the library's own badge.
  for (const teamCodex of [{ reaches: true, refused: null }, undefined, null]) {
    const row = teamRows(input({ team, teamCodex }), new Map()).find((r) => r.name === "brief")!;
    assert.equal(row.codex, true, JSON.stringify(teamCodex));
    assert.deepEqual(row.notes, []);
  }
  // No Codex home: dark and quiet, like the other layers.
  const quiet = teamRows(input({ team, teamCodex: { reaches: false, refused: null } }), new Map());
  assert.equal(quiet[0].codex, false);
  assert.deepEqual(teamCodexNotes(true, { reaches: false, refused: null }), []);
}

// Skills hub H6a (R14, R15): a team skill whose scripts wait for an OK says so
// on its row, in words, and its one action opens the sheet; Install and a
// duplicate's Compare move to the `⋯`. A skill with no OK pending is unchanged.
{
  const team = [
    {
      name: "check",
      description: "Checks migrations.",
      plugin: "ply-team",
      claude: true,
      codex: true,
      repo: "absent" as const,
      needsOk: { plugin: "ply-team", firstTime: false, approvedAt: Date.UTC(2026, 9, 3, 12) },
    },
    {
      name: "fresh",
      description: "New.",
      plugin: "ply-team",
      claude: true,
      codex: true,
      repo: "absent" as const,
      needsOk: { plugin: "ply-team", firstTime: true, approvedAt: null },
    },
    { name: "plain", description: "Text only.", plugin: "ply-team", claude: true, codex: true, repo: "absent" as const },
  ];
  const rows = teamRows(input({ team }), new Map());
  const check = rows.find((r) => r.name === "check")!;
  assert.deepEqual(check.action, REVIEW_SCRIPTS_ACTION);
  assert.deepEqual(check.transient, {
    kind: "needsOk",
    line: "Needs your OK · a script changed. New sessions keep the version you approved on 3 Oct.",
    plugin: "ply-team",
  });
  assert.ok(
    check.menu.some((e) => e !== "divider" && e.id === "install"),
    "Install is still reachable from the ⋯",
  );
  const fresh = rows.find((r) => r.name === "fresh")!;
  assert.equal(
    fresh.transient?.line,
    "Needs your OK · it brings a script. New sessions don't get it until you say OK.",
  );
  const plain = rows.find((r) => r.name === "plain")!;
  assert.equal(plain.transient, null);
  assert.equal(plain.action?.id, "install");
  // (Challenger) True in each state: a script added to a skill that was all
  // text did not "change", and an image is not "a script".
  assert.equal(
    needsOkLine({ firstTime: false, approvedAt: null }),
    "Needs your OK · it now brings a script. New sessions keep the version from before the script.",
  );
  assert.equal(
    needsOkLine({ firstTime: false, approvedAt: null, bringsScript: false }),
    "Needs your OK · it now brings a file that is not text. New sessions keep the version from before that file.",
  );
  assert.equal(
    needsOkLine({ firstTime: true, approvedAt: null, bringsScript: false }),
    "Needs your OK · it brings a file that is not text. New sessions don't get it until you say OK.",
  );
  // Windows walk (H6b): an image added beside unchanged scripts — the
  // backend's `bringsScript` is false — says so on the team row and on the
  // repository row linked to it.
  const approvedAt = Date.UTC(2026, 9, 17, 12);
  assert.equal(
    needsOkLine({ firstTime: false, approvedAt, bringsScript: false }),
    "Needs your OK · a file that is not text changed. New sessions keep the version you approved on 17 Oct.",
  );
  assert.equal(
    linkedNeedsOkLine({ bringsScript: false }),
    "Needs your OK · the team library's newer copy brings a file that is not text. Update waits until you say OK.",
  );
  assert.equal(
    linkedNeedsOkLine({ bringsScript: true }),
    "Needs your OK · the team library's newer copy brings a script. Update waits until you say OK.",
  );
}

// Skills hub H6b walk (R15): the team's Claude plugin carries hooks. Its
// skills' rows say why Claude doesn't get them; one held only by that plugin
// is still listed, reaching no CLI, with no Install.
{
  const refused = [
    { plugin: "ply-team", vendor: "claude" as const, reason: "it carries hooks, which run commands on your Mac" },
  ];
  const team = [
    { name: "shared", description: "Both.", plugin: "ply-team", claude: false, codex: true, repo: "absent" as const, refused },
    { name: "mine", description: "", plugin: "ply-team", claude: false, codex: false, repo: "absent" as const, refused },
  ];
  const rows = teamRows(input({ team }), new Map());
  const line =
    "Claude doesn't get it: Plyloft refuses the team's Claude plugin ply-team (it carries hooks, which run commands on your Mac). Only the team owner can change that.";
  const shared = rows.find((r) => r.name === "shared")!;
  assert.ok(shared.notes.includes(line), shared.notes.join(" | "));
  assert.equal(shared.action?.id, "install", "Codex still gets it");
  const mine = rows.find((r) => r.name === "mine")!;
  assert.ok(mine.notes.includes(line));
  assert.equal(mine.action, null, "nothing to install: no CLI gets it");
  assert.equal(mine.claude, false);
  assert.equal(mine.codex, false);
  assert.deepEqual(refusedNotes(undefined), []);
}

// Decision §6 (group B): two copies that are the same whole tree — what a
// Promote or an Install leaves — are quiet like a `Keep both`: the chip stays,
// no `Compare` as the row action. A change to either brings it back.
{
  const raw = {
    repository: [repoSkill("deploy", { team: "same" })],
    team: [
      {
        name: "deploy",
        description: "The team's.",
        plugin: "ply",
        claude: true,
        codex: true,
        repo: "same" as const,
        dir: "/clone/deploy",
      },
    ],
    shared: true,
    branch: "staging",
    branchSkills: ["deploy"],
    canPromote: true,
  };
  const duplicates = crossScopeDuplicates(input(raw));
  const same = { "repository:deploy": "d1", "team:deploy": "d1" };
  const keys = identicalPairKeys(duplicates, same);
  assert.deepEqual(keys, [duplicatePairKey("team", "repository", "deploy")]);
  const quiet = skillSections(input({ ...raw, silencedPairs: keys }));
  const repoRow = quiet[0].rows[0];
  assert.deepEqual(repoRow.duplicate, { chip: "Also in Team", other: "team" });
  assert.equal(repoRow.action, null);
  assert.equal(labelOf(repoRow.menu, "compare"), "Compare");

  // Either copy changes: no longer identical, and Compare is the action again.
  assert.deepEqual(identicalPairKeys(duplicates, { ...same, "team:deploy": "d2" }), []);
  // A copy with no digest (unread, or two repository roots that disagree) is
  // never identical — even to another copy with no digest.
  assert.deepEqual(identicalPairKeys(duplicates, { "repository:deploy": null, "team:deploy": null }), []);
  assert.deepEqual(identicalPairKeys(duplicates, { "repository:deploy": "d1" }), []);
  const loud = skillSections(input(raw));
  assert.deepEqual(loud[0].rows[0].action, { id: "compare", label: "Compare" });
}


// Group B §2 review 1: the id a row shows is what Remove and Align send back.
assert.equal(
  branchIdOf({ mirror: [{ name: "deploy", description: "", dir: "/m", id: "abc+def" }] }, "deploy"),
  "abc+def",
);
assert.equal(branchIdOf({ mirror: [] }, "deploy"), null);
assert.equal(branchIdOf(null, "deploy"), null);

// Group B §2 review 2: Compare records the version when it opens; an Align or a
// Remove from inside it sends that one, even after a refresh changed the row.
{
  const ids = new ShownBranchIds();
  ids.compareOpened("repository:deploy", "old+old");
  // …a refresh brings a teammate's edit: the row now shows "new+new".
  ids.opened("align", "repository:deploy", "new+new");
  assert.equal(ids.take("align", "repository:deploy"), "old+old");
  assert.equal(ids.take("align", "repository:deploy"), null, "forgotten once taken");
  ids.opened("remove", "repository:deploy", "new+new");
  assert.equal(ids.take("remove", "repository:deploy"), "old+old");
  // With no comparison open, the row's own id at the moment the dialog opened.
  ids.compareClosed(null);
  ids.opened("remove", "repository:deploy", "new+new");
  assert.equal(ids.take("remove", "repository:deploy"), "new+new");
}

// Group B §2 walk: Update says when the unedited copy followed the edited one.
assert.match(publishToastBody("codex"), /^Only Claude's copy was edited, so Codex's copy on the branch follows it/);
assert.match(publishToastBody("claude"), /^Only Codex's copy was edited, so Claude's copy/);
assert.match(publishToastBody(null), /every copy your project folder has of it travels together/);

// ── Skills hub H5 (R12): the two copies, by card ─────────────────────────
{
  const both = repoSkill("lint", { codex: true, roots: [".claude/skills", ".agents/skills"], diverged: true });
  type Twins = { state: "follows"; winner: "claude" | "codex" } | { state: "differ" } | { state: "aligned" };
  const twin = (twins: Twins, over = {}) => ({
    skill: "lint",
    twins,
    line: "",
    legacy: false,
    committed: true,
    ...over,
  });
  const rowWith = (t: ReturnType<typeof twin>, over: Partial<SkillsInput> = {}, skill: RepositorySkillInput = both) =>
    skillSections(input({ repository: [skill], twins: [t], ...over }))[0].rows[0];
  const menuIds = (row: { menu: SkillMenuEntry[] }) =>
    row.menu.filter((e) => e !== "divider").map((e) => (e as { id: string }).id);

  // One copy changed alone: the line, Align in the menu, no question as the action.
  const follows = rowWith(twin({ state: "follows", winner: "claude" }));
  assert.ok(follows.notes.includes(twinsFollowLine("claude")));
  assert.equal(twinsFollowLine("claude"), "The Codex copy gets the Claude copy's changes when the next card ships");
  assert.equal(twinsFollowLine("codex"), "The Claude copy gets the Codex copy's changes when the next card ships");
  assert.ok(menuIds(follows).includes("align"));
  assert.equal(follows.action, null);
  assert.deepEqual(follows.twins, { state: "follows", winner: "claude" });

  // Both changed: the line and Align as the row's action.
  const differ = rowWith(twin({ state: "differ" }));
  assert.ok(differ.notes.includes(TWINS_DIFFER_LINE));
  assert.equal(TWINS_DIFFER_LINE, "Claude and Codex copies differ");
  assert.equal(differ.action?.id, "align");
  assert.equal(differ.action?.label, ALIGN_LABEL);

  // Only in the checkout: said, and nothing to press.
  const loose = rowWith(twin({ state: "differ" }, { committed: false }));
  assert.ok(loose.notes.includes(UNCOMMITTED_TWINS_LINE));
  assert.equal(loose.action, null);
  assert.ok(!menuIds(loose).includes("align"));

  // GH #215: an ignored copy says so instead of Align.
  const ignored = rowWith(twin({ state: "differ" }), {}, { ...both, ignoredRoots: [".agents/skills"] });
  assert.equal(ignored.action, null);
  assert.ok(!menuIds(ignored).includes("align"));

  // The legacy root: said, never aligned.
  const legacy = rowWith(twin({ state: "aligned" }, { legacy: true }));
  assert.ok(legacy.notes.includes(legacyTwinLine("lint")));
  assert.equal(legacyTwinLine("lint"), ".codex/skills/lint is an old copy from before Plyloft managed skills; Plyloft no longer updates it. Remove it in a card.");
  assert.ok(!menuIds(legacy).includes("align"));

  // A shared workspace aligns a skill its branch carries on that branch
  // (GH #105), never by card.
  const shared = rowWith(twin({ state: "differ" }), { shared: true, branch: "staging", branchSkills: ["lint"] });
  assert.ok(!shared.notes.includes(TWINS_DIFFER_LINE));
  assert.equal(shared.twins, null);
  // Challenger (H5 Mac walk): one the branch doesn't carry yet is the
  // checkout's alone — said, and aligned by card as anywhere else.
  const notOnBranch = rowWith(twin({ state: "follows", winner: "codex" }), { shared: true, branch: "staging" });
  assert.ok(notOnBranch.notes.includes(twinsFollowLine("codex")));
  assert.deepEqual(notOnBranch.twins, { state: "follows", winner: "codex" });
  assert.ok(menuIds(notOnBranch).includes("align"));

  assert.ok(isAlignFirst("…which one is yours. Align them first, then keep yours."));
}

// H4 Challenger step 13: the share git couldn't sign in for is told by the
// backend's own phrase (`team::SIGN_IN_MARKER`), on a Mac and on a PC.
{
  const teamRs = readFileSync(new URL("../../src-tauri/src/team.rs", import.meta.url), "utf8");
  assert.ok(
    teamRs.includes(`pub const SIGN_IN_MARKER: &str = "${SIGN_IN_MARKER}";`),
    "team.rs's SIGN_IN_MARKER is this one",
  );
  assert.ok(isSignInRefusal("Plyloft couldn't share mine: GitHub isn't signed in on this PC, so the push was refused."));
  assert.ok(isSignInRefusal("Plyloft couldn't share mine: GitHub isn't signed in on this Mac, so the push was refused."));
  assert.ok(!isSignInRefusal("Plyloft couldn't share mine: Git couldn't sign in to GitHub over SSH, so the push was refused."));
  assert.ok(!isSignInRefusal("The team library changed on GitHub while Plyloft was writing mine."));
}

// Skills hub H8 (R5): Copy to… on the rows it can copy, once the page asks
// for it; a Plyloft skill has none (Personalize, H9).
{
  const mine = { name: "captions", description: "Burns captions.", claude: true, codex: false, dir: "/h/.claude/skills/captions" };
  const without = skillSections(input({ personal: [mine] }))[3].rows[0];
  assert.ok(!without.menu.some((e) => e !== "divider" && e.id === "copy-to"), "absent unless the page offers it");
  const offered = skillSections(input({ personal: [mine], copyTo: true }))[3].rows[0];
  assert.deepEqual(offered.menu, [
    { id: "open-in-code", label: "Open in Code" },
    { id: "copy-to", label: COPY_TO_LABEL },
  ]);
  assert.equal(COPY_TO_LABEL, "Add to other projects…");
  // Before the dangerous entries, once.
  const row = {
    ...offered,
    scope: "repository" as const,
    fromMirror: false,
    menu: [{ id: "open-in-code", label: "Open in Code" } as const, "divider" as const, { id: "remove-from-branch", label: "Remove…", danger: true } as const],
  };
  const withIt = withCopyTo(row);
  assert.deepEqual(withIt.menu.map((e) => (e === "divider" ? "—" : e.id)), ["open-in-code", "copy-to", "—", "remove-from-branch"]);
  assert.equal(withCopyTo(withIt), withIt);
  // A copy only the branch has, and a row with no folder, offer none.
  assert.equal(copyToOffered({ ...row, fromMirror: true }), false);
  assert.equal(copyToOffered({ ...row, dir: null }), false);
  assert.equal(copyToOffered({ ...row, scope: "ply" }), false);
}

// Skills hub H9 (walk, 2026-10-20): a Plyloft skill switched off here — by a
// fork in the repository, the workspace, the team or this Mac — reaches no
// agent, so neither row says "Both reach the agents".
{
  const plyBrief = (on: boolean, sw: { on: boolean; level: "fork" | "default" | "team" } | null) => ({
    name: "card-brief",
    title: "Write a good brief",
    description: "Writes a brief.",
    dir: "/Ply.app/Contents/Resources/ply-skills/card-brief",
    claude: true,
    codex: true,
    on,
    switch: sw ? { ...sw, workspace: null, fork: sw.level === "fork", teamOff: sw.level === "team", macOn: on } : null,
  });
  const rowsWith = (ply: ReturnType<typeof plyBrief>) =>
    skillSections(input({ repository: [repoSkill("card-brief")], ply: [ply] })).flatMap((s) => s.rows);
  const both = rowsWith(plyBrief(true, { on: true, level: "default" }));
  assert.equal(both.find((r) => r.scope === "ply")?.duplicate?.other, "repository", "on here: a real duplicate");
  assert.equal(both.find((r) => r.scope === "repository")?.duplicate?.chip, "Also in Plyloft");
  for (const off of [
    plyBrief(true, { on: false, level: "fork" }),
    plyBrief(true, { on: false, level: "team" }),
    plyBrief(false, null),
  ]) {
    const rows = rowsWith(off);
    assert.equal(rows.find((r) => r.scope === "ply")?.duplicate, null, `${off.switch?.level ?? "mac"}: Plyloft's reaches nothing here`);
    assert.equal(rows.find((r) => r.scope === "repository")?.duplicate, null);
  }
  // Mac re-walk: a third copy of the name (the team's fork) keeps the
  // repository/team pair, but Plyloft's off copy is still no duplicate, and
  // its row says what its toggle is.
  const three = skillSections(
    input({
      repository: [repoSkill("card-brief")],
      team: [{ name: "card-brief", description: "Ours.", plugin: "ply-team", claude: true, codex: true, repo: "absent" }],
      ply: [plyBrief(true, { on: false, level: "fork" })],
    }),
  ).flatMap((s) => s.rows);
  const plyRow = three.find((r) => r.scope === "ply")!;
  assert.equal(plyRow.duplicate, null, "no 'Also in this repository' on Plyloft's off copy");
  assert.ok(plyRow.notes?.some((n) => n.startsWith("The switch is this Mac's own (on)")), JSON.stringify(plyRow.notes));
  assert.equal(three.find((r) => r.scope === "repository")?.duplicate?.other, "team");
  // The whole list is untouched (the Keep both prune judges by it).
  const all = crossScopeDuplicates(input({ repository: [repoSkill("card-brief")], ply: [plyBrief(false, null)] }));
  assert.deepEqual(all.get("card-brief"), ["repository", "ply"]);
  assert.equal(reachingDuplicates(all, [plyBrief(false, null)]).has("card-brief"), false);
}

// ── QoL block 13: the ways out of a git step ─────────────────────────────
{
  // 13.1: a skill only the project folder has says so and offers Ship it
  // with a card as its action.
  const row = rowsOf({ repository: [repoSkill("fresh", { codex: true, roots: [".claude/skills", ".agents/skills"] })], uncommitted: ["fresh"] })[0];
  assert.equal(row.action?.id, "ship-with-card");
  assert.equal(row.action?.label, SHIP_WITH_CARD_LABEL);
  assert.ok(row.notes.includes(IN_FOLDER_ONLY_LINE), JSON.stringify(row.notes));
  // …never for a copy git ignores in every root it is in (no card can carry it).
  const ignored = rowsOf({
    repository: [repoSkill("fresh", { ignoredRoots: [".claude/skills"] })],
    uncommitted: ["fresh"],
  })[0];
  assert.equal(ignored.action, null);
  assert.ok(!ignored.notes.includes(IN_FOLDER_ONLY_LINE));
  // 13.4: while a skill card carries it, the row opens that card instead.
  const card = {
    id: "c1",
    title: "Skill: ship fresh from your project folder",
    archived: false,
    shipStatus: "none",
    kind: { type: "skill", verb: "carry", skill: "fresh", origin: { kind: "", source: "", name: "", version: { commit: "", contentId: "" } } },
  } as unknown as KanbanCard;
  const carried = rowsOf({ repository: [repoSkill("fresh")], uncommitted: ["fresh"], skillCards: [card] })[0];
  assert.deepEqual(
    { id: carried.action?.id, label: carried.action?.label, cardId: carried.action?.cardId },
    { id: "open-card", label: OPEN_CARD_LABEL, cardId: "c1" },
  );
  assert.ok(carried.notes.some((n) => n.startsWith("Being shipped by")), JSON.stringify(carried.notes));
  assert.ok(!carried.notes.includes(IN_FOLDER_ONLY_LINE));
  // 13.2: a folder behind the branch offers Ask the Builder, with the request.
  const behind = rowsOf(
    branchInput({
      repository: [repoSkill("walk-rule", { codex: true, roots: [".claude/skills", ".agents/skills"] })],
      mirror: [{ name: "walk-rule", description: "Walks.", dir: "/m/c", codexDir: "/m/x", claude: true, codex: true, differs: false }],
      branchSkills: ["walk-rule"],
      checkoutBehind: [{ name: "walk-rule", copy: "codex" }],
    }),
  )[0];
  assert.equal(behind.action?.id, "ask-builder");
  assert.match(behind.action?.prompt ?? "", /^My project folder is behind staging\. I need it for walk-rule\./);
  // A row whose action is something else keeps it, and the way out goes in
  // the `⋯`, before the dangerous entries.
  const both = rowsOf({
    repository: [repoSkill("fresh")],
    uncommitted: ["fresh"],
    twins: [{ skill: "fresh", twins: { state: "differ" }, line: "Claude and Codex copies differ", legacy: false, committed: true }],
  })[0];
  if (both.action && both.action.id !== "ship-with-card") {
    assert.ok(both.menu.some((e) => e !== "divider" && e.id === "ship-with-card"), JSON.stringify(both.menu));
  }
  // Walk (lane 2, step 7): a new skill only the folder has says one thing,
  // never also "isn't on main yet… first".
  const waiting = rowsOf({
    repository: [
      repoSkill("walk-lane2-skill", {
        codex: true,
        roots: [".claude/skills", ".agents/skills"],
        promoteBlocked: "`walk-lane2-skill` isn't on main yet. Promote to Team shares the copy committed on main, so ship it with a card first.",
        promoteWaitsForBranch: true,
      }),
    ],
    uncommitted: ["walk-lane2-skill"],
    canPromote: true,
  })[0];
  assert.ok(waiting.notes.includes(IN_FOLDER_ONLY_LINE), JSON.stringify(waiting.notes));
  assert.ok(!waiting.notes.some((n) => /isn't on main|commit it to/.test(n)), JSON.stringify(waiting.notes));
  assert.equal(waiting.action?.id, "ship-with-card");
  // The words no longer send anyone to git.
  assert.equal(UNCOMMITTED_TWINS_LINE, "The two copies differ only in your project folder. Ship it with a card first, then Align.");
}

console.log("librarySkills: ok");

// ── 1.174.2 block A: a personal row names what its Share does to the team's copy ──
{
  const mine = (name: string) => ({ name, description: "x", claude: true, codex: false, dir: `/h/.claude/skills/${name}` });
  const team = (name: string, over: Partial<TeamSkillInput> = {}): TeamSkillInput => ({
    name,
    description: "x",
    plugin: "ply-team",
    claude: true,
    codex: true,
    repo: "absent",
    ...over,
  });
  const row = (over: Partial<SkillsInput>) =>
    skillSections(input({ personal: [mine("deploy")], canPromote: true, promotePlugin: "ply-team", ...over }))[3].rows[0];

  // None in the team: as before.
  assert.deepEqual(row({}).action, { id: "promote", label: "Share with Team…" });
  assert.equal(row({}).teamCopy, null);
  // A same-named skill of another plugin: a share adds its own, overwriting nothing.
  const other = row({ team: [team("deploy", { plugin: "someone-else" })], teamCopyCompared: { deploy: "differs" } });
  assert.deepEqual(other.action, { id: "promote", label: "Share with Team…" });
  assert.equal(other.teamCopy, null);
  // Different files: the press ends in the Replace question.
  const differs = row({ team: [team("deploy")], teamCopyCompared: { deploy: "differs" } });
  assert.deepEqual(differs.action, { id: "promote", label: REPLACE_IN_TEAM_LABEL });
  assert.equal(REPLACE_IN_TEAM_LABEL, "Replace in Team…");
  // One half only: the press writes the other one, without a question.
  const partial = row({ team: [team("deploy", { codex: false })], teamCopyCompared: { deploy: "same" } });
  assert.deepEqual(partial.action, { id: "promote", label: COMPLETE_IN_TEAM_LABEL });
  assert.equal(COMPLETE_IN_TEAM_LABEL, "Complete in Team…");
  // Same files, this repository still open: `Share…`, its flow says why Team is off.
  const same = row({ team: [team("deploy")], teamCopyCompared: { deploy: "same" } });
  assert.deepEqual(same.action, { id: "promote", label: SHARE_LABEL });
  assert.equal(same.teamCopy, "same");
  // Not read yet, or unreadable: nothing is promised either way.
  const unknown = row({ team: [team("deploy")] });
  assert.deepEqual(unknown.action, { id: "promote", label: SHARE_LABEL });
  assert.equal(unknown.teamCopy, "unknown");
  // Same files in the team and here: the press could do nothing, so no press.
  const repository = { name: "deploy", description: "x", claude: true, codex: true, roots: [".claude/skills"], dir: ".claude/skills/deploy", team: "same" } as unknown as SkillsInput["repository"][number];
  const nothing = row({
    team: [team("deploy")],
    repository: [repository],
    teamCopyCompared: { deploy: "same" },
    identicalPairs: [duplicatePairKey("this-mac", "repository", "deploy")],
  });
  assert.equal(nothing.action, null);
  assert.deepEqual(nothing.alsoIn, ["repository", "team"]);
  // The repository's copy differs: the flow can still replace that one.
  assert.deepEqual(
    row({ team: [team("deploy")], repository: [repository], teamCopyCompared: { deploy: "same" } }).action,
    { id: "promote", label: SHARE_LABEL },
  );
  // A team this Mac can't write, and solo mode, keep their own words.
  assert.deepEqual(row({ team: [team("deploy")], canPromote: false, teamCopyCompared: { deploy: "differs" } }).action, { id: "promote", label: SHARE_LABEL });
  assert.deepEqual(row({ solo: true, canPromote: false }).action, { id: "promote", label: "Promote" });
  // Compared against the digest of the copy a share writes over: both read.
  assert.deepEqual(shareComparisons(["deploy"], { "this-mac:deploy": "a", [shareTargetKey("deploy")]: "b" }), { deploy: "differs" });
  assert.deepEqual(shareComparisons(["deploy"], { "this-mac:deploy": "a", [shareTargetKey("deploy")]: "a" }), { deploy: "same" });
  // The team's two halves disagree: no digest, so neither, and Team stays on.
  assert.deepEqual(shareComparisons(["deploy"], { "this-mac:deploy": "a", [shareTargetKey("deploy")]: null }), {});
  // The row `team:deploy` may be another plugin's: never what is compared.
  assert.deepEqual(shareComparisons(["deploy"], { "this-mac:deploy": "a", "team:deploy": "a" }), {});
  // With two plugins, the target is the plugin a share writes into.
  const both = [team("deploy", { plugin: "someone-else" }), team("deploy")];
  assert.equal(shareTarget(both, "deploy", "ply-team"), both[1]);
}

// ── 1.174.2 block A: a personal skill's page says where its copies are ──
{
  const mine = { name: "deploy", description: "x", claude: true, codex: false, dir: "/h/.claude/skills/deploy" };
  const team: TeamSkillInput = { name: "deploy", description: "x", plugin: "ply-team", claude: true, codex: true, repo: "absent" };
  const repository = { name: "deploy", description: "x", claude: true, codex: true, roots: [".claude/skills"], dir: ".claude/skills/deploy" } as unknown as SkillsInput["repository"][number];
  const row = (over: Partial<SkillsInput>) =>
    skillSections(input({ personal: [mine], canPromote: true, promotePlugin: "ply-team", ...over }))[3].rows[0];
  const USED = "Used in 1: project (same content, not linked)";
  const SHORT = "Plyloft reads it but does not change it.";
  const toTeam = `${SHORT} Share it to put it in the team library, where others get it too.`;
  const toRepository = `${SHORT} Share it to put it in this repository, where others get it too.`;

  // Nowhere else: as before.
  assert.deepEqual(pageOf(row({})).facts, ["Yours", "not shared with anyone", "1 file"]);
  assert.equal(pageOf(row({})).status, PERSONAL_STATUS);

  // All skills' line, word for word, in place of "not shared with anyone".
  const here = row({ repository: [repository] });
  assert.deepEqual(pageOf(here, { usedIn: USED }).facts, ["Yours", USED, "1 file"]);
  assert.equal(pageOf(here, { usedIn: USED }).status, toTeam);
  // The index hasn't read it yet: the row's chip, never the old sentence.
  assert.deepEqual(pageOf(here, { silenced: true }).facts, ["Yours", "Also in this repository", "1 file"]);
  // A notice speaking up carries the same chip: said once, and still not the old sentence.
  assert.deepEqual(pageOf(here).facts, ["Yours", "1 file"]);
  assert.equal(pageOf(here).notice?.chip, "Also in this repository");
  // Solo mode: this repository was all it could go to.
  const soloHere = row({ repository: [repository], solo: true, canPromote: false });
  assert.equal(pageOf(soloHere, { solo: true }).status, SHORT);
  assert.deepEqual(pageOf(soloHere, { solo: true, silenced: true }).facts, ["Yours", "Also in this repository", "1 file"]);

  // Used in another repository only: this one is still somewhere to put it.
  const elsewhere = pageOf(row({}), { usedIn: USED });
  assert.deepEqual(elsewhere.facts, ["Yours", USED, "1 file"]);
  assert.equal(elsewhere.status, PERSONAL_STATUS);

  // In the team.
  const inTeam = row({ team: [team], teamCopyCompared: { deploy: "same" } });
  assert.deepEqual(pageOf(inTeam, { silenced: true }).facts, ["Yours", "Also in Team", "1 file"]);
  assert.equal(pageOf(inTeam).status, toRepository);
  // A team copy that differs can still be replaced, so the line still names it.
  assert.equal(pageOf(row({ team: [team], teamCopyCompared: { deploy: "differs" } })).status, PERSONAL_STATUS);
  // In both, with the same files: nowhere left.
  const both = row({ team: [team], repository: [repository], teamCopyCompared: { deploy: "same" } });
  assert.equal(pageOf(both, { usedIn: USED }).status, SHORT);
  assert.deepEqual(pageOf(both, { usedIn: USED, silenced: true }).facts, ["Yours", USED, "Also in Team", "1 file"]);

  // A same-named skill of Plyloft's own shares nothing of yours.
  assert.deepEqual(
    pageOf(row({ ply: [{ name: "deploy", title: "Deploy", description: "x", dir: "/a", claude: true, codex: true, on: true } as never] })).facts,
    ["Yours", "not shared with anyone", "1 file"],
  );
  assert.equal(personalStatus({ shareToTeam: true }, false), PERSONAL_STATUS);
  assert.equal(personalStatus({}, true), PERSONAL_STATUS_SOLO);
  // Free or read-only: the team isn't somewhere they can put it.
  assert.equal(pageOf(row({ canPromote: false })).status, toRepository);
  assert.equal(pageOf(row({ canPromote: false, repository: [repository] })).status, SHORT);
}
