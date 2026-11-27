// 1.176.1: the checked settings' words and save decision.
//
//     node --experimental-strip-types src/lib/settingCheck.test.ts
import assert from "node:assert/strict";
import {
  checkDecision,
  checkLine,
  checkNotice,
  diskWords,
  findingSentence,
  needsAttention,
  savedAsLine,
  type Reading,
} from "./settingCheck.ts";
import { needsYouProblems, savedSettingProblems } from "./savedSettingChecks.ts";
import { diagnosticsReport } from "./diagnosticsReport.ts";

const ok: Reading = {
  kind: "tileShell",
  windows: false,
  level: "ok",
  findings: [],
  resolved: "/bin/zsh",
  saveAs: "/bin/zsh",
  fix: null,
  broken: false,
};

// A good shell: saved as is, and the line says what runs.
assert.deepEqual(checkDecision(ok), { kind: "save", value: "/bin/zsh" });
assert.equal(checkNotice(ok, true), null);
assert.equal(checkNotice(ok, false), null);
assert.equal(checkLine(ok), "New shell tiles run /bin/zsh.");

// `zsh -i`: not saved; the one-press correction is the program alone.
const args: Reading = {
  ...ok,
  level: "blocked",
  findings: [{ kind: "hasArguments", program: "zsh" }],
  resolved: null,
  saveAs: null,
  fix: "zsh",
  broken: true,
};
assert.deepEqual(checkDecision(args), { kind: "blocked" });
{
  const n = checkNotice(args, true)!;
  assert.equal(n.title, "Plyloft didn't save this.");
  assert.deepEqual(
    n.actions.map((a) => a.label),
    ["Use zsh", "Keep what was there"],
  );
  assert.match(n.lines[0], /without options: zsh\./);
}
// Saved like that: reported, with the correction and the login shell.
{
  const n = checkNotice(args, false)!;
  assert.equal(n.title, "This tile shell can't work as written.");
  assert.deepEqual(
    n.actions.map((a) => a.id),
    ["fix", "default"],
  );
  assert.equal(n.actions[1].label, "Use your login shell");
  assert.equal(checkNotice({ ...args, windows: true }, false)!.actions[1].label, "Use your default shell");
}
assert.equal(checkLine(args), null, "a broken value says it in its notice");

// A disk that isn't connected: asked, naming the consequence.
const away: Reading = {
  ...ok,
  level: "confirm",
  findings: [{ kind: "diskAbsent", disk: "/Volumes/Tools" }],
  resolved: null,
  saveAs: "/Volumes/Tools/bin/zsh",
  broken: true,
};
assert.deepEqual(checkDecision(away), { kind: "confirm", value: "/Volumes/Tools/bin/zsh" });
{
  const n = checkNotice(away, true)!;
  assert.equal(n.title, "Save this tile shell?");
  assert.equal(n.lines.join(" "), "It is on the disk Tools, which isn't connected. New shell tiles won't start until it is connected again.");
  assert.deepEqual(
    n.actions.map((a) => a.id),
    ["anyway", "keep"],
  );
}
assert.equal(needsAttention(away), true);

// A `~` typed: written out on save, no question, no notice.
const tilde: Reading = {
  ...ok,
  level: "hint",
  findings: [{ kind: "tilde", written: "/Users/ada/bin/fish" }],
  resolved: "/Users/ada/bin/fish",
  saveAs: "/Users/ada/bin/fish",
  fix: "/Users/ada/bin/fish",
  broken: true,
};
assert.deepEqual(checkDecision(tilde), { kind: "save", value: "/Users/ada/bin/fish" });
assert.equal(checkNotice(tilde, true), null);
// Review 1: the correction names what it saves.
assert.equal(checkNotice(tilde, false)!.actions[0].label, "Use /Users/ada/bin/fish");
// And a save that stored something else than typed says so once.
assert.equal(savedAsLine("~/bin/fish", "/Users/ada/bin/fish"), "Saved as /Users/ada/bin/fish.");
assert.equal(savedAsLine('"C:\\x\\pwsh.exe"', "C:\\x\\pwsh.exe"), "Saved as C:\\x\\pwsh.exe.");
assert.equal(savedAsLine("  /bin/zsh ", "/bin/zsh"), null, "trimmed spaces aren't news");
assert.equal(savedAsLine("/bin/zsh", "/bin/zsh"), null);

// An unusual shell somebody confirmed is theirs: a line, no notice, no row.
const tmux: Reading = { ...ok, level: "confirm", findings: [{ kind: "notAShell", name: "tmux" }], resolved: "/opt/homebrew/bin/tmux", saveAs: "tmux" };
assert.equal(checkNotice(tmux, false), null);
assert.equal(checkLine(tmux), "Plyloft doesn't know tmux as a shell. New shell tiles will run it in place of one.");
assert.equal(needsAttention(tmux), false);

// A command is never refused or asked about: saved, with a line.
const cargo: Reading = {
  kind: "command",
  windows: false,
  level: "warn",
  findings: [{ kind: "commandNotFound", word: "cargo" }],
  resolved: null,
  saveAs: "cargo build",
  fix: null,
  broken: false,
};
assert.deepEqual(checkDecision(cargo), { kind: "save", value: "cargo build" });
assert.equal(checkNotice(cargo, true), null);
assert.equal(checkLine(cargo), "Plyloft can't find cargo in the program folders new tiles get.");
assert.equal(needsAttention(cargo), true);
assert.equal(checkLine({ ...cargo, level: "ok", findings: [] }), null);

// Try it: a word its own shell may add is a hint, never attention.
const nvm: Reading = { ...cargo, level: "hint", findings: [{ kind: "notFoundHere", word: "nvm" }] };
assert.equal(checkLine(nvm), "Plyloft didn't find nvm in the folders it knows. If your shell adds it, this is fine.");
assert.equal(needsAttention(nvm), false);

// A link whose target is away.
assert.equal(
  findingSentence({ kind: "linkAway", link: "/Users/ada/ply-build", target: "/Volumes/Fast/x" }, "folder", false),
  "/Users/ada/ply-build is a link to /Volumes/Fast/x, which isn't there.",
);

// Folders.
assert.equal(
  findingSentence({ kind: "willBeCreated", path: "/Users/ada/Team" }, "folder", false),
  "/Users/ada/Team isn't there yet. Plyloft creates it with the first project it puts there.",
);
assert.equal(findingSentence({ kind: "relative" }, "folder", true), "It isn't written in full. Write the whole folder, such as C:\\Users\\you\\Team.");
assert.equal(
  checkNotice({ ...ok, kind: "folder", level: "blocked", findings: [{ kind: "notAFolder", path: "/a/f.txt" }], saveAs: null, fix: "/a", broken: true }, true)!
    .actions[0].label,
  "Use /a",
);
assert.equal(diskWords("E:\\"), "drive E:");
assert.equal(diskWords("\\\\nas\\share"), "\\\\nas\\share");

// No word the product refuses in visible copy.
for (const f of [
  { kind: "programNotFound", name: "x" },
  { kind: "commandNotFound", word: "x" },
  { kind: "variable", name: "PATH" },
] as const) {
  assert.doesNotMatch(findingSentence(f, "tileShell", false).replace("(PATH)", ""), /\bPATH\b/);
}

// The saved list for Diagnostics: only what can't work, in row order, each
// with the field it opens; a reading that fails is left out.
{
  const readings: Record<string, Reading> = {
    "zsh -i": args,
    "/x/team": { ...ok, kind: "folder", level: "ok", findings: [], broken: false },
    "cargo build": cargo,
  };
  const contexts: unknown[] = [];
  const list = await savedSettingProblems(
    { tileShell: "zsh -i", teamCloneRoot: "/x/team", project: { folder: "/p", setupCommand: "cargo build", tryCommand: "boom" } },
    async (_kind, value, context) => {
      contexts.push([value, context]);
      const r = readings[value];
      if (!r) throw new Error("no reading");
      return r;
    },
  );
  assert.deepEqual(
    list.map((p) => [p.id, p.signal, p.open.section, p.open.row]),
    [
      ["tileShell", "error", "editor-terminals", "Tile shell"],
      ["setupCommand", "warn", "build-release", "Before the Builder starts, run"],
    ],
  );
  // The sidebar: only the certain failures of this computer's settings.
  assert.deepEqual(
    needsYouProblems(list).map((p) => p.needsYou),
    ["Tile shell can't start"],
  );
  assert.match(list[0].reason, /without options: zsh\./);
  assert.deepEqual(
    contexts.find((c) => (c as unknown[])[0] === "boom"),
    ["boom", { project: "/p", interactive: true }],
    "Try it's command is read as typed into the person's shell",
  );
  assert.deepEqual(await savedSettingProblems({ tileShell: "  " }, async () => args), []);
}

// Try it's hint never reaches the sidebar or the report's broken section;
// a certain failure does, scrubbed like a path.
{
  const hint: Reading = { ...cargo, level: "hint", findings: [{ kind: "notFoundHere", word: "nvm" }] };
  const brokenShell: Reading = { ...args };
  const list = await savedSettingProblems(
    { tileShell: "/Users/ada/bin/zsh -i", project: { folder: "/Users/ada/p", tryCommand: "nvm use && npm run dev" } },
    async (kind) => (kind === "tileShell" ? brokenShell : hint),
  );
  assert.deepEqual(
    list.map((p) => p.id),
    ["tileShell"],
  );
  assert.deepEqual(
    needsYouProblems(list).map((p) => p.id),
    ["tileShell"],
  );
  const text = diagnosticsReport({
    version: "1.176.1",
    platform: "Mac",
    needs: [],
    probeError: null,
    other: [],
    reviewers: [],
    buildCache: "",
    folders: { setting: "", reading: null, source: "your login shell", dirs: [] },
    tools: [],
    settings: list.map((x) => ({ label: x.label, value: x.value, reason: x.reason })),
  });
  assert.match(text, /Settings that can't work as written\n- Tile shell: ~\/bin\/zsh -i\. It has options after the program/);
  assert.doesNotMatch(text, /nvm|ada/);
}

console.log("settingCheck: ok");
