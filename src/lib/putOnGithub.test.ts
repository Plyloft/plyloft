// 1.175.0 F3: every state of "Put it on GitHub…" and its words.
// Run: node --experimental-strip-types src/lib/putOnGithub.test.ts
import assert from "node:assert/strict";
import {
  ADD_NOT_CONNECTED,
  CONNECT_GITHUB_FIRST,
  ONLY_ON_THIS_MAC,
  PUT_ON_GITHUB,
  addCopyFailedToast,
  addSheetWords,
  doneToast,
  keepCopyTick,
  onGithubNowLine,
  outcomeWords,
  putOnGithubNote,
  runningWords,
  sheetWords,
} from "./putOnGithub.ts";

// The card's line and button.
assert.deepEqual(putOnGithubNote({ noRemote: true, githubConnected: true }), { text: ONLY_ON_THIS_MAC, action: PUT_ON_GITHUB });
assert.deepEqual(putOnGithubNote({ noRemote: true, githubConnected: false }), { text: ONLY_ON_THIS_MAC, action: CONNECT_GITHUB_FIRST });
assert.equal(putOnGithubNote({ noRemote: false, githubConnected: true }), null, "a project with a remote: not this case");
assert.deepEqual(putOnGithubNote({ noRemote: false, githubConnected: true, justPut: "octocat/lyra" }), {
  text: "This project is on GitHub now, at octocat/lyra. Ship it opens a pull request and merges it when the checks pass.",
  action: null,
});
assert.equal(onGithubNowLine("octocat/lyra").startsWith("This project is on GitHub now"), true);
assert.equal(
  ONLY_ON_THIS_MAC,
  "This project is only on this Mac, so Ship it merges the card here. Put it on GitHub to ship cards as pull requests.",
);

// The sheet.
const sheet = sheetWords("lyra", "octocat", "lyra", { branch: "main", commits: 42, unsavedFiles: 3, name: "lyra" });
assert.equal(sheet.title, "Put “lyra” on GitHub?");
assert.equal(sheet.lede, "Plyloft creates a private repository in your GitHub account and sends it this project's saved history. From then on, Ship it opens a pull request for each card.");
assert.deepEqual(sheet.rows, [
  { id: "account", label: "GitHub account", value: "octocat" },
  { id: "name", label: "Name on GitHub", value: "lyra", hint: "github.com/octocat/lyra" },
  { id: "private", label: "Who can see it", value: "Only you. It's private; you can change that on GitHub." },
  { id: "sent", label: "What is sent", value: "main, with its 42 commits. Changes not saved in Git stay on this Mac (3 files)." },
]);
assert.deepEqual([sheet.cancel, sheet.confirm], ["Cancel", "Put it on GitHub"]);
assert.equal(sheetWords("lyra", "octocat", "lyra", { branch: "main", commits: 1, unsavedFiles: 0, name: "lyra" }).rows[3].value, "main, with its 1 commit.");

// While it runs.
assert.deepEqual(runningWords({ workspaceId: "w", repo: "octocat/lyra", branch: "main", commits: 42 }), {
  created: "Created octocat/lyra on GitHub.",
  sending: "Sending main to GitHub… 42 commits",
  stop: "Stop",
});

// After the press.
assert.equal(outcomeWords({ kind: "done", repo: "octocat/lyra", branch: "main" }), null);
assert.deepEqual(outcomeWords({ kind: "nameTaken", name: "lyra" })?.lines, [
  "You already have a repository called lyra on GitHub. Nothing was sent. Choose another name.",
]);
assert.deepEqual(outcomeWords({ kind: "stopped", repo: "octocat/lyra", branch: "main" }), {
  title: "You stopped it.",
  // F3 walk: `gh repo create --remote origin` already pointed the folder at
  // it — said, and the title isn't repeated as the line's first sentence.
  lines: ["octocat/lyra exists on GitHub but doesn't have your project yet, and this folder now points to it. Its branches and commits are as they were. Send it again finishes it."],
  again: { id: "send", label: "Send it again" },
  signIn: false,
});
assert.deepEqual(
  outcomeWords({ kind: "notSent", repo: "octocat/lyra", branch: "main", words: "GH001", large: { path: "assets/intro.mov", bytes: 212 * 1024 * 1024 } }),
  {
    title: "The project wasn't sent to GitHub.",
    lines: [
      "GitHub refuses files over 100 MB, and main has one: assets/intro.mov (212 MB).",
      "octocat/lyra was created on GitHub and is empty, and this folder now points to it. Its branches and commits are as they were.",
      "Take that file out of Git, then send it again.",
    ],
    again: { id: "send", label: "Send it again" },
    signIn: false,
  },
);
assert.deepEqual(
  outcomeWords({ kind: "notCreated", words: "Plyloft couldn't reach GitHub:\nHTTP 401", large: null, signIn: true }),
  {
  title: "The project wasn't put on GitHub.",
  // Rust's reason, its first line only; GitHub's own output stays off.
  lines: ["Plyloft couldn't reach GitHub.", "Nothing was created, and nothing changed on this Mac."],
  again: { id: "retry", label: "Try again" },
  signIn: true,
  },
);
assert.deepEqual(outcomeWords({ kind: "notCreated", words: "", large: null, signIn: false })?.lines, [
  "Nothing was created, and nothing changed on this Mac.",
]);
assert.deepEqual(
  outcomeWords({ kind: "notCreated", words: "", large: { path: "intro.mov", bytes: 150 * 1024 * 1024 }, signIn: false })?.lines[0],
  "GitHub refuses files over 100 MB, and this project has one: intro.mov (150 MB).",
);

// The toast.
assert.deepEqual(doneToast("lyra", "octocat/lyra"), {
  title: "“lyra” is on GitHub",
  body: "A private copy is at octocat/lyra. Ship it now opens a pull request.",
  action: "Open on GitHub",
});

// Add a project's tick: off by default, only without a remote and with GitHub connected.
assert.deepEqual(keepCopyTick({ hasRemote: false, githubConnected: true, login: "octocat", name: "lyra", branch: "main" }), {
  label: "Also keep a private copy on GitHub",
  hint: "This project is only on this Mac. Creates the private repository octocat/lyra and sends it main, so cards ship as pull requests.",
  defaultOn: false,
});
assert.equal(keepCopyTick({ hasRemote: true, githubConnected: true, login: "octocat", name: "lyra", branch: "main" }), null);
assert.equal(keepCopyTick({ hasRemote: false, githubConnected: false, login: null, name: "lyra", branch: "main" }), null);
assert.match(ADD_NOT_CONNECTED, /connect GitHub in Settings › Setup and account › Setup/);
assert.equal(addSheetWords("lyra").title, "Add “lyra” and put it on GitHub?");
assert.equal(addSheetWords("lyra").confirm, "Add and put it on GitHub");
assert.equal(addCopyFailedToast("lyra").title, "“lyra” was added");

console.log("putOnGithub.test.ts: ok");
