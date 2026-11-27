// Tier 3 pure-function test (OB-6, ONBOARDING_SPEC §5 step 4). Run with Node 22+:
//   node --experimental-strip-types src/lib/gitStep.test.ts
import assert from "node:assert/strict";
import {
  INSTALL_GIT_WINDOWS_LINE,
  EMPTY_NAME,
  INVALID_EMAIL,
  MAC_INSTALL_COMMAND,
  chosenEmail,
  configCommands,
  gitRow,
  identityErrors,
  installFailure,
  identityLine,
  installSheet,
  isValidEmail,
  quoted,
  shortVersion,
} from "./gitStep.ts";

const WINGET = "winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements";
const FORCE = `${WINGET} --force`;

// The Mac.
assert.equal(gitRow(null, false).state, "unknown");
assert.deepEqual(
  gitRow({ tools: [{ id: "git", found: true, version: "2.39.5 (Apple Git-154)" }] }, false),
  { state: "ready", label: "Git", hint: "Installed (git 2.39.5).", install: null, command: null },
);
// Without the CLT the shim resolves but Git is not installed.
const noClt = gitRow(
  { tools: [{ id: "git", found: false, path: "/usr/bin/git", installCmd: MAC_INSTALL_COMMAND }] },
  false,
);
assert.equal(noClt.state, "missing");
assert.equal(noClt.hint, "Not installed.");
assert.equal(noClt.install, "Install");
assert.equal(noClt.command, "xcode-select --install");
// Homebrew git without the CLT works: it's ready.
assert.equal(gitRow({ tools: [{ id: "git", found: true, path: "/opt/homebrew/bin/git", version: "2.51.0" }] }, false).state, "ready");

// Windows: Git for Windows, with Git Bash.
const winReady = gitRow({ tools: [{ id: "git", found: true, version: "2.51.0.windows.1" }, { id: "git-bash", found: true }] }, true);
assert.equal(winReady.label, "Git for Windows");
assert.equal(winReady.hint, "Installed, with Git Bash.");
const winMissing = gitRow({ tools: [{ id: "git", found: false, installCmd: WINGET }, { id: "git-bash", found: false, installCmd: WINGET }] }, true);
assert.equal(winMissing.state, "missing");
assert.equal(winMissing.install, "Install Git for Windows");
assert.equal(winMissing.command, WINGET);
const noBash = gitRow({ tools: [{ id: "git", found: true, installCmd: WINGET }, { id: "git-bash", found: false, installCmd: FORCE }] }, true);
assert.equal(noBash.state, "no-bash");
assert.equal(noBash.hint, "Git works, but Git Bash wasn't found. Plyloft needs it to run project checks.");
assert.equal(noBash.install, "Install Git for Windows");
assert.equal(noBash.command, FORCE, "over a git without Git Bash, winget is forced");

// Review P3-6: a git that resolves but doesn't start is reinstalled with the
// doctor's forced command.
const broken = gitRow({ tools: [{ id: "git", found: false, path: "C:\\Git\\cmd\\git.exe", installCmd: FORCE }, { id: "git-bash", found: false, installCmd: WINGET }] }, true);
assert.equal(broken.state, "broken");
assert.equal(broken.command, FORCE);
assert.equal(broken.install, "Install Git for Windows");

assert.equal(installSheet(false).title, "Install Apple's developer tools?");
assert.equal(
  installSheet(false).lede,
  "macOS installs Git with its Command Line Tools. A macOS window will ask you to confirm; it can take a few minutes.",
);
assert.equal(installSheet(true).title, "Install Git for Windows?");

assert.equal(shortVersion("git version 2.39.5 (Apple Git-154)"), "2.39.5");
assert.equal(shortVersion(null), null);

// Email: the x@y shape only.
for (const good of ["a@b", "m@example.com", "1+x@users.noreply.github.com", " a@b "]) assert.ok(isValidEmail(good), good);
for (const bad of ["", "ab", "@b", "a@", "a@b@c", "a b@c", "a@b\nc"]) assert.ok(!isValidEmail(bad), bad);
assert.equal(identityErrors("Matteo", "m@x"), null);
assert.deepEqual(identityErrors("Matteo", "nope"), { name: null, email: INVALID_EMAIL });
assert.deepEqual(identityErrors(" ", "m@x"), { name: EMPTY_NAME, email: null });

// Details: the two commands, the values quoted for reading only.
assert.deepEqual(configCommands("Matteo Braghetta", "m@example.com"), [
  'git config --global user.name "Matteo Braghetta"',
  'git config --global user.email "m@example.com"',
]);
assert.equal(quoted('a "b" $(c) `d`'), '"a \\"b\\" \\$(c) \\`d\\`"');
assert.equal(identityLine("Matteo", "m@x"), "Git knows you as Matteo <m@x>.");

// The private-address choice.
assert.equal(chosenEmail("1+m@users.noreply.github.com", "private", "typed@x"), "1+m@users.noreply.github.com");
assert.equal(chosenEmail("1+m@users.noreply.github.com", "other", "typed@x"), "typed@x");
assert.equal(chosenEmail(null, "private", "typed@x"), "typed@x");

// An install that ended without Git.
const closed = installFailure("installer-closed", false, "xcode-select --install", [])!;
assert.equal(closed.title, "The macOS installer was closed before Git was installed.");
assert.match(closed.todo, /macOS needs an administrator to install the developer tools/);
assert.deepEqual(closed.actions.map((a) => a.label), ["Install", "Do it yourself"]);
assert.equal(closed.details, "xcode-select --install");
assert.equal(installFailure("timed-out", false, null, [])!.title, "The macOS installer didn't finish within 30 minutes.");
// 1.176.0 R2: winget stopped at the time limit didn't "stop with an error".
assert.equal(installFailure("timed-out", true, null, [])!.title, "Git for Windows' installer took too long and was stopped.");
assert.equal(installFailure("timed-out", true, null, [])!.untouched, "Part of it may have been installed.");
const winFailed = installFailure("failed", true, WINGET, ["0x80070005"])!;
assert.equal(winFailed.title, "Git for Windows' installer stopped with an error.");
assert.equal(winFailed.details, `${WINGET}\n0x80070005`);
assert.deepEqual(winFailed.actions.map((a) => a.label), ["Install Git for Windows", "Do it yourself"]);
for (const o of ["succeeded", "cancelled", "not-observed", "could-not-tell", null]) {
  assert.equal(installFailure(o, false, null, []), null, String(o));
}

// 1.176.1: a command the installer needed wasn't found.
{
  const e = installFailure("failed", true, "winget install Git.Git", [], { cause: "command-not-found", causePath: "winget" }, true)!;
  assert.equal(e.happened, "Git's installer needed the winget command and couldn't find it.");
  assert.match(e.todo, /Program folders/);
}
// 1.176.1 walk: missing while Program folders is set — no install offered.
{
  const row = gitRow({ tools: [{ id: "git", found: false }] }, false, true);
  assert.deepEqual([row.state, row.hint, row.install, row.command, row.programFolders], ["missing", "Not in your Program folders.", null, null, true]);
}
assert.match(INSTALL_GIT_WINDOWS_LINE, /winget/);
assert.match(INSTALL_GIT_WINDOWS_LINE, /Windows may ask/);
console.log("gitStep: ok");
