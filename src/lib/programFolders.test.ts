// 1.176.1: the Program folders row's words and save decision.
//
//     node --experimental-strip-types src/lib/programFolders.test.ts
import assert from "node:assert/strict";
import {
  fixedListLine,
  shellFoldersNow,
  shellHasThemLine,
  findsLine,
  foldersNotice,
  listWords,
  problemReason,
  saveDecision,
  type ProgramFoldersVerdict,
} from "./programFolders.ts";

const base: ProgramFoldersVerdict = {
  windows: false,
  entries: [],
  found: [],
  missing: [],
  basicsMissing: [],
  systemFoldersMissing: [],
  problems: [],
  saveAs: null,
  useFolders: null,
  expanded: null,
  pathVariableFirst: false,
  withShell: null,
  needsConfirmation: false,
  shellHasThem: false,
};

const all = ["claude", "codex", "git", "gh", "curl", "bash", "sh"].map((name) => ({ name, path: `/x/${name}` }));

// The owner's value, as `program_folders::read_list` reads it.
const owners: ProgramFoldersVerdict = {
  ...base,
  entries: [
    {
      text: "~/.local/bin/claude",
      raw: "~/.local/bin/claude",
      path: "/Users/ada/.local/bin/claude",
      tilde: true,
      variables: [],
      state: { kind: "file", folder: "/Users/ada/.local/bin" },
    },
  ],
  missing: ["claude", "codex", "git", "gh"],
  basicsMissing: ["curl", "bash", "sh"],
  systemFoldersMissing: ["/usr/bin", "/bin"],
  problems: ["namesAFile", "tilde"],
  useFolders: "/Users/ada/.local/bin",
};

assert.equal(listWords(["a"]), "a");
assert.equal(listWords(["a", "b", "c"], "or"), "a, b or c");

// Typed: never saved as is; its folder offered in one press.
assert.deepEqual(saveDecision(owners), { kind: "blocked" });
const typed = foldersNotice(owners, true)!;
assert.equal(typed.title, "Plyloft didn't save this.");
assert.deepEqual(typed.lines, ["It names a file, not a folder. Program folders holds folders, such as the one the file is in."]);
assert.deepEqual(
  typed.actions.map((a) => a.label),
  ["Use its folder", "Keep what was there"],
);
assert.equal((typed.actions[0] as { value: string }).value, "/Users/ada/.local/bin");

// Saved already (Diagnostics' button lands here): every problem named, and
// what it finds.
const saved = foldersNotice(owners, false)!;
assert.equal(saved.title, "These program folders can't work as written.");
assert.match(saved.lines.join(" "), /written with ~/);
assert.equal(findsLine(owners), "Finds none of claude, codex, git and gh. It leaves out /usr/bin and /bin, where everyday commands such as curl and bash live.");
assert.deepEqual(saved.actions.map((a) => a.id), ["useFolders", "empty"]);
assert.equal(problemReason(owners.problems, false), "it names a file, not a folder and it is written with ~");

// The folder alone: savable, but only after a confirmation naming what
// won't be found, with the shell's folders offered after it.
const folderOnly: ProgramFoldersVerdict = {
  ...base,
  found: all.filter((f) => f.name === "claude" || f.name === "codex"),
  missing: ["git", "gh"],
  basicsMissing: ["curl", "bash", "sh"],
  systemFoldersMissing: ["/usr/bin", "/bin"],
  saveAs: "/Users/ada/.local/bin",
  withShell: "/Users/ada/.local/bin:/usr/bin:/bin",
  needsConfirmation: true,
};
assert.deepEqual(saveDecision(folderOnly), { kind: "confirm", value: "/Users/ada/.local/bin" });
const confirm = foldersNotice(folderOnly, true)!;
assert.equal(confirm.title, "Save these program folders?");
assert.deepEqual(confirm.lines, [
  "Plyloft won't find git or gh there.",
  "It leaves out /usr/bin and /bin, where everyday commands such as curl and bash live.",
  "This list is fixed: it won't follow later changes in your shell.",
]);
assert.deepEqual(
  confirm.actions.map((a) => a.label),
  ["Add them in front of the folders your shell reports now", "Save it anyway", "Keep what was there"],
);
assert.ok(confirm.lines.includes("This list is fixed: it won't follow later changes in your shell."), "a fixed copy says it is one");

// Review 1: the owner's real case — his shell already reports ~/.local/bin.
// Emptying comes first, with why; no fixed copy of the shell's list.
const ownersShell = { ...owners, shellHasThem: true };
const first = foldersNotice(ownersShell, true)!;
assert.deepEqual(first.actions.map((a) => a.id), ["empty", "useFolders", "keep"]);
assert.ok(first.lines.includes("Your shell already reports this folder. Left empty, Plyloft follows your shell, also when it changes."));
const folderOnlyShell = foldersNotice({ ...folderOnly, shellHasThem: true }, true)!;
assert.deepEqual(folderOnlyShell.actions.map((a) => a.id), ["empty", "anyway", "keep"], "no explicit-list offer then");
assert.ok(!folderOnlyShell.lines.includes("This list is fixed: it won't follow later changes in your shell."));
assert.equal(findsLine(folderOnly), "Finds claude and codex. Doesn't find git or gh. It leaves out /usr/bin and /bin, where everyday commands such as curl and bash live.");
assert.doesNotMatch(findsLine(folderOnly), /[Tt]erminals/, "nothing claimed about shell tiles (1.176.1 walk)");

// 1.176.1 walk: a saved, well-formed list that leaves things out offers the
// way back; a folder that isn't there, alone, is offered removed.
const walk: ProgramFoldersVerdict = {
  ...folderOnly,
  entries: [
    { text: "/tmp/ply-walk-nothing-here", raw: "/tmp/ply-walk-nothing-here", path: "/tmp/ply-walk-nothing-here", tilde: false, variables: [], state: { kind: "missing" } },
    { text: "/Users/ada/.local/bin", raw: "/Users/ada/.local/bin", path: "/Users/ada/.local/bin", tilde: false, variables: [], state: { kind: "folder" } },
  ],
};
const walkSaved = foldersNotice(walk, false)!;
assert.equal(walkSaved.title, "These program folders leave things out.");
assert.deepEqual(walkSaved.actions.map((a) => a.label), ["Empty it"]);
const onlyGone = foldersNotice({ ...base, found: all, saveAs: "x", entries: walk.entries }, false)!;
assert.deepEqual(onlyGone.actions[0], { id: "tidy", label: "Remove /tmp/ply-walk-nothing-here", value: "/Users/ada/.local/bin" });
assert.deepEqual(onlyGone.actions.map((a) => a.label), ["Remove /tmp/ply-walk-nothing-here", "Empty it"]);
assert.equal(foldersNotice({ ...base, found: all, saveAs: "/a" }, false), null, "a list that finds everything says nothing more");

// A good list: saved at once, nothing more to say.
const good: ProgramFoldersVerdict = { ...base, found: all, saveAs: "/a:/usr/bin:/bin" };
assert.deepEqual(saveDecision(good), { kind: "save", value: "/a:/usr/bin:/bin" });
assert.equal(foldersNotice(good, true), null);
assert.equal(findsLine(good), "Finds claude, codex, git and gh.");

// $PATH: the explicit list, worded by where $PATH was.
const variable: ProgramFoldersVerdict = {
  ...base,
  entries: [
    { text: "$PATH", raw: "$PATH", path: null, tilde: false, variables: ["PATH"], state: { kind: "shellFolders" } },
    { text: "/x", raw: "/x", path: "/x", tilde: false, variables: [], state: { kind: "missing" } },
  ],
  problems: ["variable"],
  expanded: "/usr/bin:/bin:/x",
  pathVariableFirst: true,
};
const v = foldersNotice(variable, true)!;
assert.match(v.lines[0], /replaces what your shell reports/);
assert.deepEqual(v.actions.map((a) => a.label), ["Add them after the folders your shell reports now", "Keep what was there"]);
assert.ok(v.lines.includes("This list is fixed: it won't follow later changes in your shell."));
const front = foldersNotice({ ...variable, pathVariableFirst: false }, true)!;
assert.equal(front.actions[0].label, "Add them in front of the folders your shell reports now");
assert.match(foldersNotice({ ...variable, windows: true }, true)!.lines[0], /% signs.*what Windows reports/);

// Relative, Mac and Windows words.
const rel = foldersNotice({ ...base, problems: ["relative"] }, true)!;
assert.match(rel.lines[0], /doesn't start with \//);
assert.match(foldersNotice({ ...base, windows: true, problems: ["relative"] }, true)!.lines[0], /drive letter/);

// A saved value written only with ~: offered written out.
const tildeOnly = foldersNotice({ ...base, found: all, problems: ["tilde"], saveAs: "/Users/ada/bin" }, false)!;
assert.deepEqual(tildeOnly.actions.map((a) => a.label), ["Write ~ out as your home folder", "Empty it"]);
assert.deepEqual(tildeOnly.actions[0], { id: "tidy", label: "Write ~ out as your home folder", value: "/Users/ada/bin" });

// Review 1: a saved value with spaces, a trailing : or a folder twice.
const untidy = foldersNotice({ ...base, found: all, problems: ["untidy"], saveAs: "/usr/bin:/opt/x" }, false)!;
assert.deepEqual(untidy.actions[0], { id: "tidy", label: "Tidy it", value: "/usr/bin:/opt/x" });
assert.match(untidy.lines[0], /New tiles get it exactly as written/);
// Typed, it is tidied on save without a word.
assert.equal(foldersNotice({ ...base, found: all, problems: ["untidy"], saveAs: "/usr/bin" }, true), null);
assert.match(foldersNotice({ ...base, problems: ["colonInName"] }, true)!.lines[0], /holds a :/);
assert.match(foldersNotice({ ...base, problems: ["otherHome"] }, true)!.lines[0], /^It starts with ~ in a form Plyloft doesn't read as a folder/);

// Windows walk: no "your shell" on Windows.
for (const line of [shellHasThemLine(true), fixedListLine(true), shellFoldersNow(true)]) {
  assert.doesNotMatch(line, /your shell/);
  assert.match(line, /Windows/);
}
assert.match(shellHasThemLine(false), /Your shell already reports/);

console.log("programFolders: ok");
