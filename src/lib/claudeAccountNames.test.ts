// 1.179.0 (C2): which Claude account a session runs on, in words. Run with:
//
//     node --experimental-strip-types src/lib/claudeAccountNames.test.ts

import assert from "node:assert/strict";
import type { ClaudeAccountRow } from "../ipc.ts";
import {
  ACCOUNT_REMOVED,
  SETUP_SECOND_ACCOUNT,
  accountName,
  accountNamesShown,
  accountRemoved,
  buildsOnWords,
  currentAccountId,
  inboxLimitWords,
  MAIN_ACCOUNT_ID,
  newSessionChoices,
  startFreshOnChoice,
  startFreshOnLabel,
  startFreshOnTitle,
  resumeNoteFor,
  shownAccountName,
  tileAccountTitle,
  tileAccountWords,
} from "./claudeAccountNames.ts";

const main: ClaudeAccountRow = { id: null, name: "Main", signedIn: "unknown", isCurrent: true, folder: null };
const work: ClaudeAccountRow = { id: "acct0001", name: "Work", signedIn: "yes", isCurrent: false, folder: "/Users/someone/work" };

// Main alone: nothing is named anywhere.
{
  const rows = [main];
  assert.equal(accountNamesShown(rows), false);
  assert.equal(shownAccountName(rows, null), null);
  assert.equal(shownAccountName(rows, undefined), null);
  assert.deepEqual(newSessionChoices(rows), []);
  assert.equal(resumeNoteFor(rows, null), null);
  // Not read yet: as Main alone.
  assert.equal(accountNamesShown(null), false);
  assert.equal(shownAccountName(null, "acct0001"), null);
  assert.equal(accountRemoved(null, "acct0001"), false);
}

// Two accounts: each id has its name; absent and null are Main.
{
  const rows = [main, work];
  assert.equal(accountNamesShown(rows), true);
  assert.equal(shownAccountName(rows, null), "Main");
  assert.equal(shownAccountName(rows, undefined), "Main");
  assert.equal(shownAccountName(rows, "acct0001"), "Work");
  assert.equal(accountName(rows, "acct0009"), null);
  assert.equal(currentAccountId(rows), null);
  assert.equal(accountRemoved(rows, "acct0009"), true);
  assert.equal(accountRemoved(rows, "acct0001"), false);
  assert.equal(accountRemoved(rows, null), false);
}

// The sentences, verbatim.
assert.equal(tileAccountWords("Work"), "Claude · Work");
assert.equal(
  tileAccountTitle("Work"),
  "This session runs on your Claude account Work. Its conversation is kept in that account's folder.",
);
assert.equal(buildsOnWords("Work", "opus"), "Builds on Claude (Work) with opus");
assert.equal(inboxLimitWords("Work", "6pm"), "Claude (Work) usage limit · resets 6pm");
assert.equal(ACCOUNT_REMOVED, "Its account was removed from Plyloft.");
assert.equal(SETUP_SECOND_ACCOUNT, "Have a second Claude subscription? Add it in Settings › Cards › AI and models.");

// The new-session menu: every account by its id, Main by MAIN_ACCOUNT_ID
// (C3), whichever is current.
assert.equal(MAIN_ACCOUNT_ID, "main");
assert.deepEqual(newSessionChoices([main, work]), [
  { label: "Claude on Main", account: "main" },
  { label: "Claude on Work", account: "acct0001" },
]);
assert.deepEqual(newSessionChoices([{ ...main, isCurrent: false }, { ...work, isCurrent: true }]), [
  { label: "Claude on Main", account: "main" },
  { label: "Claude on Work", account: "acct0001" },
]);
// A tile asked for Main by that id is named Main.
assert.equal(shownAccountName([main, work], MAIN_ACCOUNT_ID), "Main");
assert.equal(accountRemoved([main, work], MAIN_ACCOUNT_ID), false);

// C3: Start fresh on {name}, at a Claude usage limit.
{
  const second: ClaudeAccountRow = { id: "acct0002", name: "Second", signedIn: "yes", isCurrent: false, folder: null };
  // Main alone, or the list not read: nothing offered.
  assert.equal(startFreshOnChoice([main], null), null);
  assert.equal(startFreshOnChoice(null, null), null);
  // The current account when it isn't the Builder's.
  assert.deepEqual(startFreshOnChoice([main, { ...work, isCurrent: true }], null), { name: "Work", account: "acct0001" });
  assert.deepEqual(startFreshOnChoice([{ ...main, isCurrent: false }, work, { ...second, isCurrent: true }], "acct0001"), {
    name: "Second",
    account: "acct0002",
  });
  // Else the first other one: Main by its id for a Builder on Work.
  assert.deepEqual(startFreshOnChoice([{ ...main, isCurrent: false }, { ...work, isCurrent: true }], "acct0001"), {
    name: "Main",
    account: "main",
  });
  assert.deepEqual(startFreshOnChoice([main, work, second], undefined), { name: "Work", account: "acct0001" });
  assert.equal(startFreshOnLabel("Work"), "Start fresh on Work");
  assert.equal(
    startFreshOnTitle("Work"),
    "Ends this session and starts a new Builder on Work in the same copy. The files stay; the conversation starts again.",
  );
}

// Resume's note: only when the recorded account isn't the current one.
assert.equal(resumeNoteFor([main, work], "acct0001"), "Resumes on Work, where this conversation is kept.");
assert.equal(resumeNoteFor([main, work], null), null);
assert.equal(resumeNoteFor([{ ...main, isCurrent: false }, { ...work, isCurrent: true }], null), "Resumes on Main, where this conversation is kept.");
// A removed one says ACCOUNT_REMOVED instead, never a note.
assert.equal(resumeNoteFor([main, work], "acct0009"), null);

console.log("claudeAccountNames: ok");
