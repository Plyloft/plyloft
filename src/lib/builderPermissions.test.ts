// 1.171.0 (D1): the Builder permissions choice — which choice a card shows
// (its own, the tour card's, Settings'), the honest line per AI and per
// machine, the session's words. Run with:
//   node --experimental-strip-types src/lib/builderPermissions.test.ts
import assert from "node:assert/strict";
import { setPlatformForTests } from "./platform.ts";
import {
  BUILDER_PERMISSIONS,
  CLAUDE_OWN_SETTING_LABEL,
  DEFAULT_BUILDER_PERMISSIONS,
  USE_EDITS_COPY_LABEL,
  autoFixDefaultAsksHint,
  builderPermissionsHelper,
  builderPermissionsLabel,
  bothPermissionsLabel,
  cardPermissionsChoice,
  effectiveBuilderPermissions,
  readBuilderPermissions,
  restartPermissionsNote,
  sessionAsksBeforeChanges,
  sessionPermissionsWords,
  unattendedAsksNote,
} from "./builderPermissions.ts";

// The three choices, in order, with the owner's words; D3's default.
assert.deepEqual(BUILDER_PERMISSIONS, ["editsCopy", "asks", "neverAsks"]);
// 1.175.0 F9 (owner I1): one name per AI for "asks" — Plyloft passes
// Claude no permission mode, so Claude follows its own setting; Codex
// really asks. The saved value stays "asks".
assert.deepEqual(BUILDER_PERMISSIONS.map((p) => builderPermissionsLabel(p, "codex")), [
  "Edits its copy without asking",
  "Asks before every change",
  "Never asks (risky)",
]);
assert.deepEqual(BUILDER_PERMISSIONS.map((p) => builderPermissionsLabel(p, "claude")), [
  "Edits its copy without asking",
  "Uses Claude's own setting",
  "Never asks (risky)",
]);
assert.equal(CLAUDE_OWN_SETTING_LABEL, "Uses Claude's own setting");
// A card saved by 1.174.5 with "asks" reads the new name for each AI.
const saved = readBuilderPermissions("asks")!;
assert.equal(builderPermissionsLabel(saved, "claude"), "Uses Claude's own setting");
assert.equal(builderPermissionsLabel(saved, "codex"), "Asks before every change");
// A card built by both AIs: each name when they differ.
assert.equal(bothPermissionsLabel("asks"), "Claude: Uses Claude's own setting · Codex: Asks before every change");
assert.equal(bothPermissionsLabel("editsCopy"), "Edits its copy without asking");
assert.equal(DEFAULT_BUILDER_PERMISSIONS, "asks");

// A value this Plyloft doesn't know is no choice.
assert.equal(readBuilderPermissions("askLater"), null);
assert.equal(readBuilderPermissions(undefined), null);
assert.equal(readBuilderPermissions("neverAsks"), "neverAsks");

// The card's own choice first, then the tour card's mode, then Settings —
// as Rust's `builder::start_mode`.
assert.equal(effectiveBuilderPermissions("asks", "neverAsks", true), "asks");
assert.equal(effectiveBuilderPermissions(null, "neverAsks", true), "editsCopy");
assert.equal(effectiveBuilderPermissions(null, "neverAsks", false), "neverAsks");
assert.equal(effectiveBuilderPermissions(undefined, undefined, false), "asks");
assert.equal(effectiveBuilderPermissions("bogus", "bogus", false), "asks");

// Honest lines: commands may still ask; the project changes only at Ship it;
// Claude's "Never asks" reaches outside the copy, Codex's doesn't.
for (const p of BUILDER_PERMISSIONS) {
  for (const v of ["claude", "codex"] as const) {
    const line = builderPermissionsHelper(p, v);
    if (p === "asks" && v === "claude") continue;
    assert.ok(line.startsWith(v === "codex" ? "Codex" : "Claude"), line);
  }
}
setPlatformForTests("mac");
assert.equal(
  builderPermissionsHelper("asks", "claude"),
  "Plyloft adds nothing: Claude follows its own permission setting on this Mac. Unless you changed it, Claude asks before it changes a file or runs a command. Your project itself changes only when you press Ship it.",
);
setPlatformForTests("windows");
assert.match(builderPermissionsHelper("asks", "claude"), /own permission setting on this PC\./);
setPlatformForTests(null);
assert.equal(
  builderPermissionsHelper("asks", "codex"),
  "Codex asks you before it changes a file or runs a command that changes anything. Your project itself changes only when you press Ship it.",
);
assert.match(builderPermissionsHelper("editsCopy", "claude"), /Commands \(npm test, git\) may still ask/);
assert.match(builderPermissionsHelper("editsCopy", "claude"), /only when you press Ship it/);
assert.match(builderPermissionsHelper("asks", "codex"), /asks you before it changes a file/);
assert.match(builderPermissionsHelper("neverAsks", "codex"), /still changes files only in this card's copy/);
setPlatformForTests("mac");
assert.match(builderPermissionsHelper("neverAsks", "claude"), /anywhere on this Mac, not only in this card's copy/);
setPlatformForTests("windows");
assert.match(builderPermissionsHelper("neverAsks", "claude"), /anywhere on this PC, not only in this card's copy/);
setPlatformForTests(null);

// The session line and the card's Permissions line; none before 1.171.0.
assert.deepEqual(sessionPermissionsWords("editsCopy", "claude"), {
  words: "edits its copy without asking",
  title: "Started as Edits its copy without asking",
});
assert.deepEqual(sessionPermissionsWords("asks", "codex"), {
  words: "asks before every change",
  title: "Started as Asks before every change",
});
assert.deepEqual(sessionPermissionsWords("asks", "claude"), {
  words: "Claude's own permission setting",
  title: "Started as Uses Claude's own setting",
});
assert.equal(sessionPermissionsWords("neverAsks", "codex")?.words, "without asking");
assert.equal(sessionPermissionsWords(null, "claude"), null);
assert.equal(sessionPermissionsWords(undefined, "codex"), null);

// 1.172.0 (A2): a new start after a session — Start fresh, Session closed,
// Move back to Ready to start — as Rust's `card_choice` + `start_mode`:
// the card's own choice, else the closed session's on the same AI (a
// pre-1.171 bypass is Never asks), else the tour card's mode, else Settings.
const closedAsks = { vendor: "codex" as const, permissions: "asks", bypass: false };
assert.equal(cardPermissionsChoice({ builderPermissions: "editsCopy", builder: closedAsks }, "codex", "neverAsks", false), "editsCopy");
assert.equal(cardPermissionsChoice({ builder: closedAsks }, "codex", "neverAsks", false), "asks");
// Another AI keeps nothing of the closed session.
assert.equal(cardPermissionsChoice({ builder: closedAsks }, "claude", "neverAsks", false), "neverAsks");
assert.equal(cardPermissionsChoice({ builder: closedAsks }, "claude", null, true), "editsCopy");
assert.equal(cardPermissionsChoice({ builder: { vendor: "claude", bypass: true } }, "claude", "asks", false), "neverAsks");
assert.equal(cardPermissionsChoice({ builder: { vendor: "claude", bypass: false } }, "claude", "editsCopy", false), "editsCopy");
// No session: the same as before Start build.
assert.equal(cardPermissionsChoice({ builder: null }, "claude", undefined, false), effectiveBuilderPermissions(null, undefined, false));

// Which sessions ask before a change: the choice, or Claude's own default
// before 1.171.0; Codex then edited its copy.
assert.equal(sessionAsksBeforeChanges({ vendor: "codex", permissions: "asks" }), true);
assert.equal(sessionAsksBeforeChanges({ vendor: "claude", permissions: "asks" }), true);
assert.equal(sessionAsksBeforeChanges({ vendor: "codex", permissions: "editsCopy" }), false);
assert.equal(sessionAsksBeforeChanges({ vendor: "claude", permissions: "neverAsks", bypass: true }), false);
assert.equal(sessionAsksBeforeChanges({ vendor: "claude", bypass: false, permissionMode: null }), true);
assert.equal(sessionAsksBeforeChanges({ vendor: "claude", bypass: false, permissionMode: "acceptEdits" }), false);
assert.equal(sessionAsksBeforeChanges({ vendor: "claude", bypass: true }), false);
assert.equal(sessionAsksBeforeChanges({ vendor: "codex", bypass: false }), false);
assert.equal(sessionAsksBeforeChanges(null), false);

// Under the choice where Resume is offered: Resume isn't changed by it.
assert.equal(
  restartPermissionsNote(closedAsks),
  "Start fresh starts in this choice. Resume goes on as the closed session began: Asks before every change.",
);
assert.equal(
  restartPermissionsNote({ vendor: "claude", permissions: "asks" }),
  "Start fresh starts in this choice. Resume goes on as the closed session began: Uses Claude's own setting.",
);
assert.match(restartPermissionsNote({ vendor: "claude", bypass: true }), /began: without asking\.$/);
assert.equal(
  restartPermissionsNote({ vendor: "claude", bypass: false }),
  "Start fresh starts in this choice. Resume goes on as the closed session began.",
);

// Codex (or Claude) in Asks before every change, with a fix meant to run
// without the person: the card says so and offers Edits its copy, saved for
// the next fresh start — never the open session.
assert.equal(USE_EDITS_COPY_LABEL, "Use Edits its copy without asking for this card");
const codexOpen = { vendor: "codex" as const, permissions: "asks" };
const autoFix = unattendedAsksNote({ session: codexOpen, sessionOpen: true, nextChoice: "asks", kind: "autoFix" });
assert.deepEqual(autoFix, {
  line: "Codex asks before every change in this card, so its automatic fixes wait for your OK in the Builder's session.",
  offer: true,
  offerTitle: "Saved on this card for the Builder's next fresh start. The open session keeps asking.",
  after: null,
});
const chosen = unattendedAsksNote({ session: codexOpen, sessionOpen: true, nextChoice: "editsCopy", kind: "round" });
assert.equal(chosen?.offer, false);
assert.match(chosen!.line, /^Codex asks before every change in this card, so this fix waits for your OK/);
assert.equal(chosen?.after, "The Builder's next fresh start uses Edits its copy without asking. The open session keeps asking.");
// 1.175.0 F9 (I1): with Claude, the fix waits only when Claude asks.
const claudeClosed = unattendedAsksNote({ session: { vendor: "claude", permissions: "asks" }, sessionOpen: false, nextChoice: "asks", kind: "autoFix" })!;
assert.equal(
  claudeClosed.line,
  "Claude uses its own permission setting in this card: if it asks before a change, its automatic fixes wait for your OK in the Builder's session.",
);
assert.equal(
  unattendedAsksNote({ session: { vendor: "claude", permissions: "asks" }, sessionOpen: true, nextChoice: "asks", kind: "round" })!.line,
  "Claude uses its own permission setting in this card: if it asks before a change, this fix waits for your OK in the Builder's session.",
);
assert.match(claudeClosed.offerTitle, /Resume goes on as the closed session began\.$/);
assert.equal(
  unattendedAsksNote({ session: { vendor: "codex", permissions: "asks" }, sessionOpen: false, nextChoice: "asks", kind: "autoFix" })!.offerTitle,
  "Saved on this card for the Builder's next fresh start. Resume goes on as the closed session began, asking.",
);
// A2 Challenger: Claude's Edits its copy still lets commands ask; said so.
assert.equal(
  unattendedAsksNote({ session: { vendor: "claude", permissions: "asks" }, sessionOpen: true, nextChoice: "asks", kind: "autoFix" })!.offerTitle,
  "Saved on this card for the Builder's next fresh start. Commands like npm test may still ask. The open session goes on as it started.",
);
assert.equal(unattendedAsksNote({ session: { vendor: "codex", permissions: "editsCopy" }, sessionOpen: true, nextChoice: "editsCopy", kind: "autoFix" }), null);
assert.equal(unattendedAsksNote({ session: null, sessionOpen: false, nextChoice: "asks", kind: "autoFix" }), null);

// Settings' Fix failing checks by itself, while new cards ask (the default).
assert.equal(
  autoFixDefaultAsksHint(undefined, "codex"),
  "New cards' Builder starts as Asks before every change, so its automatic fixes wait for your OK in its session. A card can choose Edits its copy without asking instead.",
);
assert.equal(
  autoFixDefaultAsksHint("asks", "claude"),
  "New cards' Builder starts as Uses Claude's own setting, so its automatic fixes wait for your OK whenever Claude asks. A card can choose Edits its copy without asking instead.",
);
assert.equal(autoFixDefaultAsksHint("editsCopy", "claude"), null);
assert.equal(autoFixDefaultAsksHint("neverAsks", "codex"), null);

console.log("builderPermissions: ok");
