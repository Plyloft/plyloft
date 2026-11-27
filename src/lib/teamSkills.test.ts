import assert from "node:assert/strict";
import {
  SKILL_VENDORS,
  loadsSkill,
  qualifiedSkillName,
  removeConfirmBody,
  removeToastBody,
  summarizeTeamSkills,
  teamSkillsSummaryLabel,
} from "./teamSkills.ts";
import type { TeamSkill } from "../ipc.ts";

const skill = (
  name: string,
  claude: boolean,
  codex: boolean,
): TeamSkill => ({
  name,
  codexName: null,
  description: `What ${name} is for.`,
  plugin: "ply-team",
  claude,
  codex,
});

// ── The count that matters is "both", not "in the library" ────────────
//
// Rung 3 ships only when both vendors load the same skills. A library row
// that reaches one CLI is a half-delivered skill, and counting it as loaded
// would hide exactly the failure the rung exists to prevent.

{
  const summary = summarizeTeamSkills([
    skill("a", true, true),
    skill("b", true, false),
    skill("c", false, true),
  ]);
  assert.equal(summary.both, 1);
  assert.equal(summary.oneSided, 2);
  assert.equal(summary.total, 3);
}

{
  const empty = summarizeTeamSkills([]);
  assert.deepEqual(empty, { both: 0, oneSided: 0, total: 0 });
}

// ── The heading line ──────────────────────────────────────────────────

assert.equal(
  teamSkillsSummaryLabel([skill("a", true, true)], true),
  "1 in both CLIs",
);
assert.equal(
  teamSkillsSummaryLabel(
    [skill("a", true, true), skill("b", true, false)],
    true,
  ),
  "1 in both CLIs · 1 in one only",
);

// An empty library and an unfetched one are different states: one means
// nobody has shared a skill, the other means press Refresh.
assert.equal(teamSkillsSummaryLabel([], true), "none in the library yet");
assert.equal(teamSkillsSummaryLabel([], false), "not fetched yet");

// ── Badges ────────────────────────────────────────────────────────────

const oneSided = skill("claude-only", true, false);
assert.equal(loadsSkill(oneSided, "claude"), true);
assert.equal(loadsSkill(oneSided, "codex"), false);

// Both vendors always get a badge, so the *greyed* one is the signal. A
// missing badge would read as "no information yet".
assert.equal(SKILL_VENDORS.length, 2);

// ── Two plugins may each carry a skill of the same name ───────────────
//
// Both CLIs name a skill `<plugin>:<name>`, so that is the identity — and
// the React key, or the panel would collapse two unrelated skills into one
// row.

const claudeReview: TeamSkill = { ...skill("review", true, false), plugin: "a" };
const codexReview: TeamSkill = { ...skill("review", false, true), plugin: "b" };

assert.equal(qualifiedSkillName(claudeReview), "a:review");
assert.equal(qualifiedSkillName(codexReview), "b:review");
assert.notEqual(
  qualifiedSkillName(claudeReview),
  qualifiedSkillName(codexReview),
);

// Neither is loaded by both vendors, so the summary must not say one is.
const split = summarizeTeamSkills([claudeReview, codexReview]);
assert.equal(split.both, 0);
assert.equal(split.oneSided, 2);

// ── Remove from team says its reach, like Replace does ────────────────
//
// Found on the rung 3+4 walk: two smoke skills loaded in every session for
// every member with no way to retire them. The confirm is the only thing
// between a press and a push to the whole team, so it names the skill by the
// identity the CLIs use, says who it reaches, and says installed copies stay.

{
  const body = removeConfirmBody({ plugin: "ply-team", name: "team-hello" });
  assert.match(body, /ply-team:team-hello/);
  assert.match(body, /everyone on the team/);
  assert.match(body, /both halves/);
  assert.match(body, /installed in a repository stay/);
  // The place the pull really lives, by its nav group and page.
  assert.match(body, /Settings › Team › Members and library/);
}

assert.match(removeToastBody({ pushed: true }), /left alone/);
assert.match(removeToastBody({ pushed: false }), /nothing reached a teammate/);

console.log("teamSkills.test.ts ✓");
