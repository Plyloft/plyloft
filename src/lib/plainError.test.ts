// QoL 1.168 block 8 (A5): plainError and terminalFailureLines.
import assert from "node:assert/strict";
import {
  endSentence,
  githubCause,
  githubRefusalLine,
  largeFileFact,
  namesGitHub,
  largeFilePaths,
  largeFileWay,
  causeSentence,
  joinSentences,
  lineCause,
  folderListCause,
  osErrorCause,
  knownCause,
  looksRaw,
  searchFailureLine,
  plainCause,
  plainError,
  plainFailure,
  shipBatchFailure,
  terminalFailureLines,
} from "./plainError.ts";

assert.equal(plainCause(new Error("Permission denied (os error 13)")), "The computer didn't let Plyloft read or change a file there.");
assert.equal(plainCause("No such file or directory (os error 2)"), "A file or folder it needed isn't there any more.");
assert.equal(plainCause("weird thing"), "Something went wrong; Details has the tool's own words.");

const e = plainError("The pull requests didn't load", new Error("gh: HTTP 401 Bad credentials"));
assert.equal(e.title, "The pull requests didn't load.");
assert.equal(e.happened, "GitHub didn't accept the sign-in.");
assert.equal(e.untouched, "Nothing was changed.");
assert.equal(e.details, "gh: HTTP 401 Bad credentials");
// The raw text is never a line of the block.
for (const line of [e.title, e.happened, e.untouched, e.todo]) assert.ok(!line.includes("401"), line);
assert.equal(plainError("x.", "").details, null);

const lines = terminalFailureLines("This session didn't start.", new Error("spawn claude ENOENT"), "Close the tile and open a new one.");
assert.equal(lines.length, 3);
assert.ok(lines[0].includes("This session didn't start.") && lines[0].includes("The program didn't start."));
assert.ok(lines[2].includes("spawn claude ENOENT"));
assert.ok(!lines[0].includes("ENOENT"));

// A refusal already in plain words stands as what happened.
const refused = plainError("No review was started", "This pull request is from a fork, so Plyloft can't review it here.");
assert.equal(refused.happened, "This pull request is from a fork, so Plyloft can't review it here.");
assert.equal(refused.details, null);
assert.equal(plainError("x", "Error: EACCES: permission denied, open '/a'").details, "Error: EACCES: permission denied, open '/a'");
assert.equal(plainError("x", "ship_batch blocked: card `X` has verify_status `Failed` (must be Passed/Legacy/Skipped)").details?.startsWith("ship_batch"), true);

// Block 8: "…then ship.." — never two full stops.
assert.equal(endSentence("Press Finish and check to test them, then ship."), "Press Finish and check to test them, then ship.");
assert.equal(endSentence("Ship is held"), "Ship is held.");

// M2: an underscore in a path and a long refusal in sentences are plain.
assert.equal(plainError("x", "There's already a folder called my_project in /Users/a/code_stuff.").details, null);
const long = "This skill brings a script that runs on every Mac. " + "Plyloft asks each teammate first. ".repeat(14) + "Nothing was changed.";
assert.ok(long.length > 400);
assert.equal(plainError("x", long).details, null);
assert.notEqual(plainError("x", "card_ship blocked: `X` has verify_status `Failed`").details, null);

// 1.169.1 (R11): what GitHub refused a push, a pull request or a merge
// for — git's and gh's own stderr, as they print it.
const GH001 = [
  "couldn't push the branch to the remote: git push origin card/x failed: remote: error: Trace: 8a1c0f3e2b",
  "remote: error: See https://gh.io/lfs for more information.",
  "remote: error: File assets/demo.mp4 is 123.45 MB; this exceeds GitHub's file size limit of 100.00 MB",
  "remote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.",
  "To github.com:o/lyra.git",
  " ! [remote rejected] card/x -> card/x (pre-receive hook declined)",
  "error: failed to push some refs to 'github.com:o/lyra.git'",
].join("\n");
const GH006 = [
  "remote: error: GH006: Protected branch update failed for refs/heads/main.",
  "remote: error: Changes must be made through a pull request.",
  "To https://github.com/o/lyra.git",
  " ! [remote rejected] main -> main (protected branch hook declined)",
  "error: failed to push some refs to 'https://github.com/o/lyra.git'",
].join("\n");
const GH013 = "remote: error: GH013: Repository rule violations found for refs/heads/card/x.\nremote: - Cannot update this protected ref.";
// GH013 is also secret scanning's push protection (GitHub's own text).
const GH013_SECRET = [
  "remote: error: GH013: Repository rule violations found for refs/heads/card/x.",
  "remote: ",
  "remote: - GITHUB PUSH PROTECTION",
  "remote:   —————————————————————————————————————————",
  "remote:     Resolve the following violations before pushing again",
  "remote: ",
  "remote:     - Push cannot contain secrets",
  "remote: ",
  "remote:      —— GitHub Personal Access Token ——————————————————————",
  "remote:        locations:",
  "remote:          - commit: 8a1c0f3e2b",
  "remote:            path: config/dev.env:3",
  "To https://github.com/o/lyra.git",
  " ! [remote rejected] card/x -> card/x (push declined due to repository rule violations)",
  "error: failed to push some refs to 'https://github.com/o/lyra.git'",
].join("\n");
const RATE_LIMIT = [
  "opening the pull request failed: HTTP 403: API rate limit exceeded for user ID 123. (https://api.github.com/graphql)",
  "remote: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)",
];
const NO_ACCESS = [
  "remote: Permission to o/lyra.git denied to bob.\nfatal: unable to access 'https://github.com/o/lyra.git/': The requested URL returned error: 403",
  "GraphQL: Resource not accessible by personal access token (createPullRequest) — gh pr create",
  "HTTP 403: Must have admin rights to Repository. (https://api.github.com/repos/o/lyra/pulls/9/merge)",
];
const NON_FF = [
  "To https://github.com/o/lyra.git",
  " ! [rejected]        card/x -> card/x (non-fast-forward)",
  "error: failed to push some refs to 'https://github.com/o/lyra.git'",
  "hint: Updates were rejected because the tip of your current branch is behind",
].join("\n");
const FETCH_FIRST = " ! [rejected]        card/x -> card/x (fetch first)\nerror: failed to push some refs to 'git@github.com:o/lyra.git'";
const STALE = "To github.com:o/lyra.git\n ! [rejected]        card/x -> card/x (stale info)\nerror: failed to push some refs";
// Without a GitHub name, a rejected push reads as GitHub's on a GitHub press only.
assert.equal(githubCause(" ! [rejected] card/x -> card/x (stale info)"), null);
assert.equal(githubCause(" ! [rejected] card/x -> card/x (stale info)", { github: true }), "moved");
const SIGN_IN = [
  "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/o/lyra.git/'",
  "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  "opening the pull request failed: HTTP 401: Bad credentials (https://api.github.com/graphql)",
  "To get started with GitHub CLI, please run:  gh auth login",
];
const table: [string, ReturnType<typeof githubCause>, string][] = [
  [GH001, "large-file", "GitHub refuses files over 100 MB: assets/demo.mp4. Take it out of the card's commits and add it to .gitignore."],
  [GH006, "protected", "This branch is protected on GitHub."],
  [GH013, "ruleset", "GitHub's rules for this repository refused the push."],
  [GH013_SECRET, "secret", "GitHub found a secret in the card's commits. Take it out of the card's commits."],
  [NON_FF, "moved", "The branch on GitHub has commits this card doesn't."],
  [FETCH_FIRST, "moved", "The branch on GitHub has commits this card doesn't."],
  [STALE, "moved", "The branch on GitHub has commits this card doesn't."],
  ["git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", "ssh-key", "GitHub didn't accept this Mac's SSH key."],
  ...RATE_LIMIT.map((raw): [string, ReturnType<typeof githubCause>, string] => [raw, "rate-limit", "GitHub is limiting requests right now; try again in a few minutes."]),
  ...NO_ACCESS.map((raw): [string, ReturnType<typeof githubCause>, string] => [raw, "no-access", "This GitHub account can't push to or merge in this repository."]),
  ...SIGN_IN.map((raw): [string, ReturnType<typeof githubCause>, string] => [raw, "sign-in", "GitHub didn't accept the sign-in."]),
];
for (const [raw, kind, words] of table) {
  assert.equal(githubCause(raw), kind, raw);
  assert.equal(plainCause(new Error(raw)), words, raw);
}
// Two files over the limit are both named.
const two = `${GH001}\nremote: error: File big two.bin is 210.00 MB; this exceeds GitHub's file size limit of 100.00 MB`;
assert.deepEqual(largeFilePaths(two), ["assets/demo.mp4", "big two.bin"]);
assert.equal(plainCause(two), "GitHub refuses files over 100 MB: assets/demo.mp4, big two.bin. Take them out of the card's commits and add them to .gitignore.");
// 1.169.1: the way on names the press, and the Builder when the card has one.
assert.equal(
  `${largeFileFact(GH001)} ${largeFileWay(GH001, { action: "Ship it", builder: true })}`,
  "GitHub refuses files over 100 MB: assets/demo.mp4. Ask the Builder to take it out of the card's commits and add it to .gitignore, then press Ship it again.",
);
assert.equal(
  largeFileWay(GH001, { action: "Ship it" }),
  "Take it out of the card's commits and add it to .gitignore, then press Ship it again.",
);
assert.deepEqual(githubRefusalLine("Not pushed", "Not pushed.", GH001, { action: "Send the fixes to GitHub", builder: true }), {
  line: "Not pushed. GitHub refuses files over 100 MB: assets/demo.mp4. The pull request is as it was. Ask the Builder to take it out of the card's commits and add it to .gitignore, then press Send the fixes to GitHub again.",
  signIn: false,
});
// R11 (Challenger): Claude's and Codex's own "not logged in" is not GitHub's —
// not without a GitHub press or text that names GitHub.
const CLAUDE_NOT_LOGGED_IN =
  "Claude is not logged in on this machine (Please run /login). Open Claude in a terminal tile, sign in, then try again.";
assert.equal(namesGitHub(CLAUDE_NOT_LOGGED_IN), false);
assert.equal(githubCause(CLAUDE_NOT_LOGGED_IN), null);
assert.notEqual(plainCause(CLAUDE_NOT_LOGGED_IN), "GitHub didn't accept the sign-in.");
assert.equal(githubCause("Codex: not logged in. Run codex login."), null);
// gh's own words without a GitHub host name count on a GitHub press only.
assert.equal(githubCause("HTTP 401: Bad credentials"), null);
assert.equal(githubCause("HTTP 401: Bad credentials", { github: true }), "sign-in");
for (const raw of [...SIGN_IN, GH001, GH006, GH013, GH013_SECRET, NON_FF, ...NO_ACCESS]) assert.ok(namesGitHub(raw), raw);
// Not GitHub's: the generic shapes stay as they were.
for (const raw of ["Permission denied (os error 13)", "spawn gh ENOENT", "weird thing", "fatal: unable to access: Could not resolve host: github.com"]) {
  assert.equal(githubCause(raw), null, raw);
}
// Push update / Merge: the backend's line stands unless GitHub's answer is
// one to act on; a branch that moved on keeps the backend's own words.
assert.deepEqual(githubRefusalLine("Not pushed", "Not pushed: git couldn't push the branch to GitHub; the pull request is as it was. Try again.", SIGN_IN[0]), {
  line: "Not pushed. GitHub didn't accept the sign-in. The pull request is as it was.",
  signIn: true,
});
// R11 (Challenger): another account may be able to — Sign in to GitHub stays.
assert.deepEqual(githubRefusalLine("Not merged", "Not merged: GitHub refused.", NO_ACCESS[2]), {
  line: "Not merged. This GitHub account can't push to or merge in this repository. The pull request is as it was.",
  signIn: true,
});
assert.deepEqual(githubRefusalLine("Not pushed", "Not pushed.", GH013_SECRET, { action: "Send the fixes to GitHub", builder: true }), {
  line: "Not pushed. GitHub found a secret in the card's commits. The pull request is as it was. Ask the Builder to take it out of the card's commits, then press Send the fixes to GitHub again.",
  signIn: false,
});
assert.deepEqual(githubRefusalLine("Not pushed", "Not pushed.", "git@github.com: Permission denied (publickey)."), {
  line: "Not pushed. GitHub didn't accept this Mac's SSH key. The pull request is as it was.",
  signIn: false,
});
assert.equal(githubRefusalLine("Not merged", "x", RATE_LIMIT[0]).signIn, false);
// Push update and Merge are GitHub presses: gh's bare words count.
assert.equal(githubRefusalLine("Not merged", "x", "HTTP 401: Bad credentials").signIn, true);
assert.deepEqual(githubRefusalLine("Not merged", "Not merged: GitHub refused. Its answer is below.", GH006), {
  line: "Not merged. This branch is protected on GitHub. The pull request is as it was.",
  signIn: false,
});
assert.deepEqual(githubRefusalLine("Not pushed", "Not pushed: someone else pushed to it.", NON_FF), { line: "Not pushed: someone else pushed to it.", signIn: false });
assert.deepEqual(githubRefusalLine("Not pushed", "Nothing to push.", null), { line: "Nothing to push.", signIn: false });

// R6: Ship batch's own refusals — the project folder's changes, and a card's
// conflict with the folder put back.
{
  const dirty = shipBatchFailure('PLY_TARGET_DIRTY_V1:{"totalCount":2,"paths":["README.md","b.txt"],"truncated":false}', ["Blog: RSS feed for posts"]);
  // TX5 round 1 (T31b): the Ship toast's words, pointing at Show them.
  assert.match(dirty.line, /^2 changed files in your project folder aren't saved in a commit, so Plyloft won't ship into it\. Show them opens them/);
  // DR3 round 1: what stays, by the ready cards the release had ticked.
  assert.ok(dirty.line.endsWith("The cards on main are as they were; Blog: RSS feed for posts is still ready."), dirty.line);
  assert.ok(
    shipBatchFailure('PLY_TARGET_DIRTY_V1:{"totalCount":1,"paths":["a"],"truncated":false}').line.endsWith("Nothing was released."),
  );
  assert.equal(dirty.details, "README.md\nb.txt");
  const raw =
    "Plyloft couldn't merge “Second” (plyloft/card-2) into main: it conflicts with main in README.md. " +
    "Nothing was released, and your project folder is as it was. Resolve it in the card's copy, then ship again. Git said: boom";
  const conflict = shipBatchFailure(raw, ["First", "Second"]);
  assert.equal(
    conflict.line,
    "Git couldn't merge “Second” into main: they conflict in README.md. Nothing was released, and your project folder is as it was. The cards on main are as they were; the ready cards are still ready. Resolve it in the card's copy, then release again.",
  );
  assert.equal(conflict.details, raw);
  const withBuilder = shipBatchFailure(
    raw.replace("Resolve it in the card's copy, then ship again.", "Open the card and press Fix with the Builder."),
    ["Second"],
  );
  assert.ok(
    withBuilder.line.endsWith("The cards on main are as they were; Second is still ready. Open the card and press Fix with the Builder."),
    withBuilder.line,
  );
}

// R7: two cards of one batch conflict with each other.
{
  const raw =
    "Plyloft couldn't ship these cards together: “Third” conflicts with “Second” in shared.txt; ship them separately. " +
    "Nothing was released, and your project folder is as it was. Git said: boom";
  const between = shipBatchFailure(raw, ["Second", "Third"]);
  assert.equal(
    between.line,
    "“Third” conflicts with “Second” in shared.txt; ship them separately. Nothing was released, and your project folder is as it was. The cards on main are as they were; the ready cards are still ready.",
  );
  assert.equal(between.details, raw);
}

// 1.176.2 (E1, A3-02): "The program didn't start." only for a real spawn
// failure, and it names git, gh or the shell when the text does.
assert.equal(plainCause("spawn git rev-parse --show-toplevel: No such file or directory (os error 2)"), "Git didn't start.");
assert.equal(plainCause("spawn gh ENOENT"), "The GitHub command didn't start.");
assert.equal(plainCause("spawn: Permission denied (os error 13)"), "The program didn't start.");
assert.equal(plainCause("spawn claude ENOENT"), "The program didn't start.");
// …and not for a word that merely contains it.
assert.equal(plainCause("the respawn queue is full"), "Something went wrong; Details has the tool's own words.");
assert.equal(plainCause("could not read src/spawn.rs"), "Something went wrong; Details has the tool's own words.");

// A3-97: a whole sentence that names something in backticks is not raw; a lone token is.
assert.equal(looksRaw("Plyloft can't use `my-skill`: it already exists and isn't a skills library."), false);
assert.equal(looksRaw("`my-skill`"), true);
assert.equal(plainFailure("“X” is already shipped in `main` so nothing was pushed.").details, "");
assert.equal(
  plainFailure("The skill `Release notes` already exists and isn't a skills library.").sentence,
  "The skill “Release notes” already exists and isn't a skills library.",
);

// A3-01: a release's own refusals say their reason in words, the text behind Details.
{
  const failed = "ship_batch blocked: card `Add login` has verify_status `Failed` (must be Passed/Legacy/Skipped)";
  const e1 = plainError("The release didn't go", failed);
  assert.equal(e1.happened, "“Add login” can't go in this release: its checks haven't passed.");
  assert.equal(e1.details, failed);
  assert.equal(
    plainCause("ship_batch blocked: card `Add login` is already shipped"),
    "“Add login” is already shipped.",
  );
  assert.equal(
    plainCause("ship_batch blocked: card `A` has a conflict with card/b; resolve it from its card (Fix with the Builder), then press Finish and check"),
    "“A” has a conflict with card/b. Resolve it from its card (Fix with the Builder), then press Finish and check.",
  );
  assert.equal(
    plainCause("ship_batch blocked: card `A` stopped on a conflict when it last shipped; ship it again from its card"),
    "“A” stopped on a conflict when it last shipped. Ship it again from its card.",
  );
  assert.equal(
    plainCause("ship aborted: current branch is `dev`. Ship lands on `main`. Switch first or cancel."),
    "Current branch is “dev”. Ship lands on “main”. Switch first or cancel.",
  );
  assert.equal(
    plainCause("ship aborted: Plyloft is quitting. Nothing was merged, committed or tagged."),
    "Plyloft is quitting. Nothing was merged, committed or tagged.",
  );
  // The batch alert shows it, not the catch-all.
  const alert = shipBatchFailure("ship aborted: Plyloft is quitting. Nothing was merged, committed or tagged.", []);
  assert.ok(alert.line.startsWith("Plyloft is quitting."), alert.line);
  assert.ok(!alert.line.includes("Something went wrong"));
  // A refusal that carries a tool's own text stays raw.
  assert.equal(plainCause("ship aborted: spawn git failed (os error 2)"), "Git didn't start.");
}

// 1.176.2 (E1, A3-91): discussion.rs's internal states, in words.
for (const [raw, said] of [
  ["discussion sealed envelope is missing", "One of the two AIs stopped before it finished. Start the discussion again."],
  ["analysis A completed without an artifact", "One of the two AIs stopped before it finished. Start the discussion again."],
  ["invalid-envelope: analysis JSON parse failed: eof", "One of the two AIs gave an answer Plyloft couldn't read. Start the discussion again."],
  ["synthesis artifact is missing disagreementResolutions", "One of the two AIs gave an answer Plyloft couldn't read. Start the discussion again."],
  ["discussion analysis worker panicked", "Plyloft stopped part-way. Nothing was lost. Start the discussion again."],
  ["discussion problem is required", "A discussion needs a question."],
] as const) {
  assert.equal(plainFailure(raw).sentence, said, raw);
  assert.equal(plainFailure(raw).details, raw, raw);
  assert.ok(!/envelope|artifact/.test(plainError("x", raw).happened), raw);
}

// 1.176.2 (E1, review): the typed "isn't there" is the tile's sentence, never the raw tool line.
{
  const gone =
    'PLY_CLI_UNAVAILABLE_V1:{"tool":"claude","was":"/Users/alice/.local/bin/claude"}\nclaude: not found in PATH. Plyloft looked for it again; it was at /Users/alice/.local/bin/claude.';
  assert.equal(looksRaw(gone), true);
  assert.equal(plainCause(gone), "Claude Code didn't start: Plyloft can't find it on this Mac any more.");
  assert.equal(plainFailure(gone).details, gone);
  assert.ok(!plainFailure(gone).sentence.includes("/Users/"));
  assert.equal(plainCause(`No eligible reviewer: ${gone}`), "Claude Code didn't start: Plyloft can't find it on this Mac any more.");
}
// A3-97 with the real my_library.rs sentence: a backticked name first.
{
  const lib = "`my-skills` already exists and isn't a skills library. Pick another name.";
  assert.equal(looksRaw(lib), false);
  assert.equal(plainFailure(lib).sentence, "“my-skills” already exists and isn't a skills library. Pick another name.");
  assert.equal(causeSentence(lib), "“my-skills” already exists and isn't a skills library. Pick another name.");
  assert.equal(looksRaw("`my-skills`"), true);
}
// M5/M6: lines with no Details, and sentences joined once.
assert.equal(lineCause("fatal: the thing broke"), "fatal: the thing broke");
assert.equal(lineCause("Permission denied (os error 13)"), "The computer didn't let Plyloft read or change a file there.");
assert.equal(lineCause(""), "Plyloft doesn't know why.");
// 1.176.3 (walk): a folder that couldn't be listed is not "a file".
assert.equal(folderListCause("Permission denied (os error 13)"), "The computer didn't let Plyloft read that folder.");
assert.equal(folderListCause("fatal: the thing broke"), "Plyloft couldn't read that folder.");
// 1.176.3 (Windows walk): causes by the OS error code, in any system language.
{
  const win = (raw: string) => osErrorCause(raw, true);
  assert.equal(win("read_dir: Accesso negato. (os error 5)"), "The computer didn't let Plyloft read or change a file there.");
  assert.equal(win("Impossibile trovare il percorso specificato. (os error 3)"), "A file or folder it needed isn't there any more.");
  assert.equal(win("x (os error 2)"), "A file or folder it needed isn't there any more.");
  assert.equal(win("x (os error 32)"), "Another program is using that file.");
  assert.equal(win("x (os error 267)"), "A folder it needed is a file instead.");
  assert.equal(win("x (os error 112)"), "The disk is full.");
  assert.equal(win("x (os error 206)"), "A file or folder name is too long.");
  assert.equal(win("x (os error 13)"), null, "13 is not a Windows code");
  const unix = (raw: string) => osErrorCause(raw, false);
  assert.equal(unix("x (os error 13)"), "The computer didn't let Plyloft read or change a file there.");
  assert.equal(unix("x (os error 20)"), "A folder it needed is a file instead.");
  assert.equal(unix("x (os error 28)"), "The disk is full.");
  assert.equal(unix("x (os error 63)"), "A file or folder name is too long.");
  assert.equal(unix("x (os error 36)"), "A file or folder name is too long.");
  assert.equal(unix("x (os error 5)"), null);
  assert.equal(knownCause("read_dir: Qualcosa di strano (os error 9999)"), null);
  assert.equal(folderListCause("read_dir: Qualcosa di strano (os error 9999)"), "Plyloft couldn't read that folder.");
  assert.equal(plainCause("Permission denied (os error 13)"), "The computer didn't let Plyloft read or change a file there.");
  assert.equal(plainCause("No such file or directory (os error 2)"), "A file or folder it needed isn't there any more.");
}
assert.ok(!lineCause("weird").includes("Details"));
assert.equal(joinSentences("Type at least two characters.", "Plyloft couldn't read them."), "Type at least two characters. Plyloft couldn't read them.");
assert.equal(joinSentences("Really?", "No"), "Really? No.");
assert.equal(joinSentences("No workspace is open — choose All.", "x."), "No workspace is open — choose All. x.");
assert.equal(joinSentences("a", null, "", false, "b!"), "a. b!");
// R4's own search sentences stand alone.
for (const said of [
  "That isn't a valid regular expression (unclosed group). Turn off “Regular expression” to search for the text exactly as typed.",
  "The files filter “src/[” isn't a pattern the search can read. Check its brackets and braces.",
  "The search failed: the search tool stopped.",
]) {
  assert.equal(searchFailureLine(said), said);
}
assert.equal(searchFailureLine("rg: boom"), "The search failed. rg: boom.");
assert.equal(searchFailureLine("Permission denied (os error 13)"), "The search failed. The computer didn't let Plyloft read or change a file there.");

console.log("plainError: all contracts passed");
