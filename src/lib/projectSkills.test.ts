import assert from "node:assert/strict";
import {
  asNotTheSameSkill,
  CLAUDE_SKILL_ROOT,
  CODEX_SKILL_ROOT,
  copyAction,
  gitignoredLine,
  installToastBody,
  promoteToastBody,
  replaceConfirmBody,
} from "./projectSkills.ts";

// ── Only a *different* destination asks before it is overwritten ──────
//
// `partial` means some destination has these exact bytes and the rest have
// nothing, so finishing the copy loses nobody's work. Asking there would
// train the member to click through the one prompt that matters.

assert.equal(copyAction("promote", "absent", "x").label, "Promote");
assert.equal(copyAction("install", "absent", "x").label, "Install");
assert.equal(copyAction("install", "absent", "x").confirm, false);
assert.equal(copyAction("promote", "partial", "x").label, "Complete");
assert.equal(copyAction("promote", "partial", "x").confirm, false);
assert.equal(copyAction("promote", "differs", "x").confirm, true);
assert.equal(copyAction("install", "differs", "x").label, "Link and update…");

// Nothing to do is a chip, not a button: a pressable "Install" on a skill
// already installed is a promise of a change that will not happen.
assert.equal(copyAction("promote", "same", "x").done, true);
assert.equal(copyAction("promote", "same", "x").label, "Shared");
assert.equal(copyAction("install", "same", "x").label, "Installed");

// ── The confirm says who pays for the overwrite ───────────────────────
//
// A Promote reaches every teammate; an Install stays in the member's working
// tree, where git can still undo it. Those are different stakes and the
// sentence says which one it is.

assert.match(replaceConfirmBody("promote", "x"), /everyone on the team/);
assert.match(replaceConfirmBody("install", "x"), /nothing is committed/);
// Walk follow-ups 2026-10-19 (Challenger): Replace shares the branch's copy,
// not this checkout's — the confirm says so instead of "your version".
{
  const shares =
    "This checkout's `mine` has changes not on walk-1014. Replace in Team shares the copy committed on walk-1014; your local changes aren't included.";
  const body = replaceConfirmBody("promote", "mine", shares);
  assert.equal(
    body,
    "The team library already has a skill called mine, and it is not the same file. This checkout's mine has changes not on walk-1014. Replace in Team shares the copy committed on walk-1014; your local changes aren't included. Replacing it pushes that copy to everyone on the team.",
  );
  assert.doesNotMatch(body, /your version/);
  assert.equal(replaceConfirmBody("promote", "x", null), replaceConfirmBody("promote", "x"));
}

// ── A root git ignores is said, with its fix ──────────────────────────
//
// Found on the rung 4 walk: `.claude/` ignored wholesale, Install wrote both
// copies and the toast promised a card would ship them. A card could only
// ever carry the Codex half.

assert.equal(gitignoredLine([]), null);
assert.match(
  gitignoredLine([CLAUDE_SKILL_ROOT]) ?? "",
  /^\.claude\/skills is gitignored in this repo — a card will not carry it/,
);
assert.match(
  gitignoredLine([CLAUDE_SKILL_ROOT]) ?? "",
  /\.claude\/\* then !\.claude\/skills\//,
);
assert.match(
  gitignoredLine([CLAUDE_SKILL_ROOT, CODEX_SKILL_ROOT]) ?? "",
  /\.claude\/skills and \.agents\/skills are gitignored .* will not carry them/,
);

// The toast stops promising a card will ship what git ignores…
{
  const body = installToastBody({
    written: [".claude/skills/x", ".agents/skills/x"],
    ignored: [CLAUDE_SKILL_ROOT],
  });
  assert.match(body, /^Written to /);
  assert.match(body, /\.claude\/skills is gitignored/);
  assert.doesNotMatch(body, /ship them with a card/);
}
// QoL 13.1: only a plain folder is written straight into, so no card is
// promised — the skill reaches the sessions there.
assert.equal(
  installToastBody({ written: [".claude/skills/x"], ignored: [] }),
  "Written to .claude/skills/x. This folder isn't a git repository, so they reach the sessions here and nothing else.",
);
// …and still says it when nothing needed writing.
assert.match(
  installToastBody({ written: [], ignored: [CLAUDE_SKILL_ROOT] }),
  /already held this exact skill\. \.claude\/skills is gitignored/,
);

// GH #227: a root git gave no answer for is never promised to a card.
{
  const body = installToastBody({
    written: [".claude/skills/x", ".agents/skills/x"],
    ignored: [],
    unknown: [{ path: CLAUDE_SKILL_ROOT, reason: "git took too long to answer" }],
  });
  assert.match(body, /Plyloft couldn't ask git whether \.claude\/skills is ignored \(git took too long to answer\)/);
  assert.doesNotMatch(body, /behind a link/);
  assert.match(body, /check git status before you ship that copy with a card/);
  assert.doesNotMatch(body, /ship them with a card so teammates/);
}

// ── The Replace refusal is read as a value, never as a sentence ────────
//
// `project_skills::CopyError::NotTheSameSkill` on the wire. Anything else a
// rejection can be is not it — including a string that says the same words.
{
  const wire = {
    notTheSameSkill: "/repo/.claude/skills/deploy",
    message: "/repo/.claude/skills/deploy already exists and is not the same skill.",
  };
  assert.deepEqual(asNotTheSameSkill(wire), wire);
  assert.deepEqual(asNotTheSameSkill({ ...wire, message: "Reworded entirely." }), {
    ...wire,
    message: "Reworded entirely.",
  });
  for (const other of [
    wire.message,
    new Error(wire.message),
    null,
    undefined,
    42,
    { notTheSameSkill: wire.notTheSameSkill },
    { message: wire.message },
    { notTheSameSkill: 7, message: wire.message },
  ]) {
    assert.equal(asNotTheSameSkill(other), null, String(other));
  }
}

console.log("projectSkills.test.ts ✓");

// ── N14 item 2: Promote shares the branch's copy, and says what it left out ──

assert.equal(
  promoteToastBody({ pushed: true, plugin: "ply-team", leftOut: null }),
  "Both CLIs load it from the team library now, in the ply-team plugin.",
);
assert.equal(
  promoteToastBody({
    pushed: true,
    plugin: "ply-team",
    leftOut: "Your local changes to `deploy` aren't included: Plyloft shared the copy committed on main.",
  }),
  "Both CLIs load it from the team library now, in the ply-team plugin. Your local changes to `deploy` aren't included: Plyloft shared the copy committed on main.",
);
