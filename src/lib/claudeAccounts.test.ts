// 1.179.0 (C1): the words and decisions of Settings › AI and models ›
// Claude accounts. Run with:
//
//     node --experimental-strip-types src/lib/claudeAccounts.test.ts

import assert from "node:assert/strict";
import type { ClaudeAccountRow } from "../ipc.ts";
import {
  ADD_BODY,
  ADD_BUTTON,
  ADD_CONFIRM,
  ADD_NOTE,
  ADD_TITLE,
  CURRENT_MARK,
  MAIN_DETAIL,
  MENU,
  NAME_LABEL,
  NAME_PLACEHOLDER,
  REMOVE_BODY,
  REMOVE_ONLY,
  REMOVE_SIGN_OUT,
  SECTION_TITLE,
  introLine,
  refusal,
  removeTitle,
  removedLine,
  replaceRow,
  rowActions,
  signInEnd,
  signInTitle,
  stateDot,
  stateWords,
} from "./claudeAccounts.ts";

const main: ClaudeAccountRow = { id: null, name: "Main", signedIn: "unknown", isCurrent: true, folder: null };
const work: ClaudeAccountRow = {
  id: "acct01",
  name: "Work",
  signedIn: "yes",
  isCurrent: false,
  folder: "/Users/someone/Library/Application Support/com.mbadv.ply/ai-accounts/claude/acct01",
};

// The approved words, verbatim.
assert.equal(SECTION_TITLE, "Claude accounts");
assert.equal(
  introLine("mac"),
  "Use more than one Claude subscription on this Mac. Each account signs in with Claude's own login and keeps its own folder. New sessions start on the account you choose; a running session keeps its account.",
);
assert.equal(
  introLine("windows"),
  "Use more than one Claude subscription on this PC. Each account signs in with Claude's own login and keeps its own folder. New sessions start on the account you choose; a running session keeps its account.",
);
assert.equal(MAIN_DETAIL, "The account Claude uses on its own.");
assert.equal(CURRENT_MARK, "New sessions");
assert.deepEqual(MENU, {
  use: "Use for new sessions",
  rename: "Rename…",
  signIn: "Sign in again",
  show: "Show folder",
  remove: "Remove…",
});
assert.equal(ADD_BUTTON, "Add a Claude account…");
assert.equal(ADD_TITLE, "Add a Claude account");
assert.equal(NAME_LABEL, "Name");
assert.equal(NAME_PLACEHOLDER, "Work");
assert.equal(
  ADD_BODY,
  "Plyloft makes a folder for this account and opens Claude's own sign-in. Sign in with the subscription you want this account to use. Plyloft never sees your password or your login.",
);
assert.equal(
  ADD_NOTE,
  "This account has its own settings, skills and folder trust. Your Main skills and settings aren't used here.",
);
assert.equal(ADD_CONFIRM, "Make the folder and sign in");
assert.equal(signInTitle("Work"), "Sign in to Claude account Work");
assert.equal(removeTitle("Work"), "Remove Work?");
assert.equal(
  REMOVE_BODY,
  "Plyloft deletes this account's folder. Conversations kept only there go with it. Signing out first lets Claude remove its own login for this account.",
);
assert.equal(REMOVE_SIGN_OUT, "Sign out and remove");
assert.equal(REMOVE_ONLY, "Remove without signing out");
assert.equal(removedLine("Work", "mac"), "Work is removed. Claude's own login for it is still saved on this Mac.");
assert.equal(removedLine("Work", "windows"), "Work is removed. Claude's own login for it is still saved on this PC.");
// The name is never turned into another machine's word.
assert.equal(
  removedLine("This Mac", "windows"),
  "This Mac is removed. Claude's own login for it is still saved on this PC.",
);

// The three states; "unknown" is never "Not signed in", and only a seen
// sign-in gets the filled dot.
assert.equal(stateWords("yes"), "Signed in");
assert.equal(stateWords("no"), "Not signed in");
assert.equal(stateWords("unknown"), "Plyloft can't tell whether this account is signed in.");
assert.equal(stateDot("yes"), "done");
assert.equal(stateDot("no"), "empty");
assert.equal(stateDot("unknown"), "empty");

// The sign-in's end in the section's words; the terminal's own otherwise.
assert.equal(signInEnd("Work", "running", null), null);
assert.equal(signInEnd("Work", "waiting-long", null), null);
assert.deepEqual(signInEnd("Work", "done", "succeeded"), { state: "done", text: "Work is signed in." });
assert.deepEqual(signInEnd("Work", "done", "not-observed"), {
  state: "empty",
  text: "Plyloft didn't see a sign-in for Work. Try again, or close the window if you signed in elsewhere.",
});
assert.equal(signInEnd("Work", "done", "cancelled"), null);
assert.equal(signInEnd("Work", "done", "could-not-tell"), null);

// Main: no Remove and no Sign in again (it has no id); the current row is
// not offered to itself; a row without a folder still lists Show folder
// (the section disables it).
assert.deepEqual(rowActions(main), ["rename", "show"]);
assert.deepEqual(rowActions({ ...main, isCurrent: false }), ["use", "rename", "show"]);
assert.deepEqual(rowActions(work), ["use", "rename", "signIn", "show", "remove"]);
assert.deepEqual(rowActions({ ...work, isCurrent: true }), ["rename", "signIn", "show", "remove"]);

// A rename replaces the row of its id only, Main by its null id.
const renamed = replaceRow([main, work], { ...main, name: "Personal" });
assert.deepEqual(
  renamed.map((r) => r.name),
  ["Personal", "Work"],
);
assert.deepEqual(
  replaceRow([main, work], { ...work, name: "Team" }).map((r) => r.name),
  ["Main", "Team"],
);

// Rust's refusals are shown as returned.
assert.equal(refusal("You already have an account named Work."), "You already have an account named Work.");
assert.equal(refusal(new Error("open: denied")), "open: denied");

console.log("claudeAccounts: ok");
