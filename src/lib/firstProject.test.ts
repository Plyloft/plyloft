// OB-12: Setup's steps 7 and 8, pure (ONBOARDING_SPEC §5). Run with:
//
//     node --experimental-strip-types src/lib/firstProject.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ProjectInspection, ProjectRepoEntry, ProjectCloneResult, ProjectNewPreview } from "../ipc.ts";
import {
  PROJECTS_FOLDER_HINT,
  previewParent,
  FILTER_AFTER,
  IGNORE_HEADER,
  NAME_NEEDS_LATIN,
  accountChoices,
  cloneFailureView,
  cloneNext,
  cloneSheet,
  cloneSizeLine,
  count,
  defaultBranch,
  existingLine,
  folderShown,
  folderView,
  foundProjectsLine,
  githubCopyHint,
  githubCopyLine,
  hasFilesOffer,
  inFolder,
  initialLeaveOut,
  nameProblem,
  newNameLine,
  newSheet,
  probeRepoReady,
  repoGroups,
  repoReadyOf,
  saveLine,
  BUILD_INTRO,
  SAVE_WORK_COMMIT,
  SECRETS_INTRO,
  WORK_TOO_BIG,
  DEFAULT_WORK_WAY,
  splitDetails,
  untrackedLeaveOut,
  UNSAVED_HINT,
  WORK_IGNORE_LINE,
  saveSheet,
  saveWorkSheet,
  workFilesLine,
  size,
  unsavedSkippedNote,
  syncedBy,
  syncedWarning,
  updatedLine,
  wayOptions,
} from "./firstProject.ts";

let passed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  const done = (e?: unknown) => {
    if (e) {
      console.error(`FAIL ${name}`);
      throw e;
    }
    passed += 1;
  };
  try {
    const r = fn();
    if (r instanceof Promise) return r.then(() => done(), done);
    done();
  } catch (e) {
    done(e);
  }
  return undefined;
}

const insp = (over: Partial<ProjectInspection>): ProjectInspection => ({
  path: "/Users/me/code/lyra",
  name: "lyra",
  outcome: "ready",
  refused: null,
  refusedWords: null,
  git: { kind: "branch", branch: "main", commit: "abc" },
  branches: ["main"],
  suggestedBranch: "main",
  uncommittedChanges: false,
  uncommittedFiles: 0,
  toSave: null,
  largeFiles: [],
  secrets: [],
  ignoreLines: [],
  existingWorkspace: null,
  sharedDefinition: false,
  identityReady: true,
  needsIdentity: false,
  githubOrigin: null,
  ignoreProblem: null,
  foundTruncated: false,
  unnameable: [],
  scanWarning: null,
  partialDownload: false,
  ...over,
});
const summary = { files: 1240, bytes: 18 * 1024 * 1024, complete: true, huge: false, topLevel: [] };

// ── Numbers ──────────────────────────────────────────────────────────────

test("counts and sizes read as the spec writes them", () => {
  assert.equal(count(1240), "1 240");
  assert.equal(count(50000), "50 000");
  assert.equal(count(12), "12");
  assert.equal(size(18 * 1024 * 1024), "18 MB");
  assert.equal(size(2.4 * 1024 * 1024 * 1024), "2.4 GB");
  assert.equal(size(512 * 1024), "512 KB");
});

// ── Step 7 ───────────────────────────────────────────────────────────────

test("step 7: the folder is ~/Projects on the Mac and %USERPROFILE%\\Projects on Windows", () => {
  assert.equal(folderShown("~/Projects", false), "~/Projects");
  assert.equal(folderShown("~/Projects", true), "%USERPROFILE%\\Projects");
  assert.equal(folderShown("~/dev/work", true), "%USERPROFILE%\\dev\\work");
  assert.equal(folderShown("D:\\code", true), "D:\\code");
  assert.equal(inFolder("~/Projects", "lyra", false), "~/Projects/lyra");
  assert.equal(inFolder("~/Projects", "lyra", true), "%USERPROFILE%\\Projects\\lyra");
  assert.equal(inFolder("D:\\code\\", "lyra", true), "D:\\code\\lyra");
});

test("step 7: iCloud Drive and OneDrive get the warning; other folders don't", () => {
  assert.equal(syncedBy("~/Library/Mobile Documents/com~apple~CloudDocs/Projects"), "icloud");
  assert.equal(syncedBy("/Users/me/Library/Mobile Documents/com~apple~CloudDocs"), "icloud");
  assert.equal(syncedBy("C:\\Users\\me\\OneDrive\\Projects"), "onedrive");
  assert.equal(syncedBy("C:\\Users\\me\\OneDrive - MB Adv\\Projects"), "onedrive");
  assert.equal(syncedBy("~/Library/CloudStorage/OneDrive-Personal/Projects"), "onedrive");
  assert.equal(syncedBy("~/Projects"), null);
  assert.equal(syncedBy("~/code/onedrive-sync-tool"), null);
  assert.equal(
    syncedWarning("icloud"),
    "Folders synced by iCloud Drive can corrupt Git projects. Choose a folder outside it.",
  );
  assert.equal(syncedWarning("onedrive"), "Folders synced by OneDrive can corrupt Git projects. Choose a folder outside it.");
});

test("step 7: the found-projects hint only when there are some", () => {
  assert.equal(foundProjectsLine(0), null);
  assert.equal(foundProjectsLine(1), "Plyloft found 1 project here.");
  assert.equal(foundProjectsLine(6), "Plyloft found 6 projects here.");
});

// ── Step 8 ───────────────────────────────────────────────────────────────

test("step 8: three ways; From GitHub waits for GitHub", () => {
  const off = wayOptions(false, "Mac");
  assert.deepEqual(
    off.map((o) => o.label),
    ["A folder on this Mac", "From GitHub", "A new, empty project"],
  );
  assert.equal(off[1].disabled, true);
  assert.equal(off[1].hint, "Connect GitHub first.");
  const on = wayOptions(true, "PC");
  assert.equal(on[0].label, "A folder on this PC");
  assert.equal(on[1].disabled, false);
  assert.equal(on[1].hint, "One of your repositories, or your team's.");
  assert.equal(existingLine(0), null);
  assert.equal(existingLine(4), "You already have 4 projects in Plyloft.");
});

// ── 8a: every row of the outcome table ───────────────────────────────────

test("8a ready: a Git project on its branch → Add to Plyloft", () => {
  const v = folderView(insp({}));
  assert.equal(v.title, "“lyra” is a Git project on branch main.");
  assert.deepEqual(v.primary, { label: "Add to Plyloft", action: "add" });
  assert.deepEqual(v.notes, []);
});

// 1.171.0 D3 (FR-5): changes not saved in Git are asked about, not hinted.
test("8a ready with changes not saved in Git: leave them (the default, C16) or save them as a commit first", () => {
  const v = folderView(insp({ uncommittedChanges: true, uncommittedFiles: 12, git: { kind: "branch", branch: "my-work", commit: "abc" } }));
  assert.deepEqual(v.notes, []);
  assert.deepEqual(v.primary, { label: "Add to Plyloft", action: "add" });
  assert.equal(
    v.unsavedWork?.text,
    "This folder has changes that aren't saved in Git yet (12 files or folders). Cards only see what's saved.",
  );
  assert.deepEqual(
    v.unsavedWork?.options.map((o) => [o.value, o.label, o.hint]),
    [
      ["skip", "Leave my changes in the folder", "They stay as they are; cards start from the last saved version and won't have them."],
      ["save", "Save them as a commit on my-work first", "One commit in this folder only. Nothing is uploaded."],
    ],
  );
  // 1.174.0 C16 (NIW-6): preselected, since it writes nothing.
  assert.equal(DEFAULT_WORK_WAY, "skip");
  assert.equal(folderView(insp({ uncommittedChanges: true, uncommittedFiles: 1 })).unsavedWork?.text.includes("(1 file or folder)"), true);
  assert.equal(folderView(insp({})).unsavedWork, null);
  // The declined path says it once the project is in.
  assert.equal(
    unsavedSkippedNote(12),
    "Cards start from the last saved version. The changes in 12 files or folders stay in the folder, and cards won't have them.",
  );
  // Git mid-way combining changes: only the second way, and why.
  const blocked = folderView(insp({ uncommittedChanges: true, uncommittedFiles: 2, workBlocked: "Git is in the middle of combining changes in this folder, so Plyloft won't save them now. Finish that first, or start from the last saved version." }));
  assert.deepEqual(blocked.unsavedWork?.options.map((o) => o.value), ["skip"]);
  assert.match(blocked.unsavedWork?.text ?? "", /in the middle of combining changes/);
});

test("8a detached or unborn with changes: no branch to save on, the hint only", () => {
  const v = folderView(insp({ outcome: "choose-branch", git: { kind: "detached", commit: "abc" }, uncommittedChanges: true, uncommittedFiles: 3 }));
  assert.equal(v.unsavedWork, null);
  assert.ok(v.notes.includes(UNSAVED_HINT));
});

test("8a save-work sheet: one commit on the folder's branch, here only, no default ignore lines", () => {
  const work = insp({
    uncommittedChanges: true,
    uncommittedFiles: 3,
    git: { kind: "branch", branch: "my-work", commit: "abc" },
    toSave: { ...summary, files: 3, bytes: 3 * 1024 },
    secrets: [{ path: ".env", bytes: 10 }, { path: "certs/tls.key", bytes: 5 }],
    workTracked: ["certs/tls.key"],
    buildFolders: [{ path: "node_modules/", files: 812 }],
    nestedProjects: ["vendor/lib"],
  });
  // Ticked to leave out at first: the secrets and the package folder.
  assert.deepEqual(initialLeaveOut(work), [".env", "certs/tls.key", "node_modules/"]);
  // Only the new ones get a .gitignore line; Git's own keep their version.
  assert.deepEqual(untrackedLeaveOut(work, initialLeaveOut(work)), [".env", "node_modules/"]);
  const sheet = saveWorkSheet(work, ["/.env", "/node_modules/"], [".env", "node_modules/"]);
  assert.equal(sheet.title, "Save your current work in “lyra”?");
  assert.equal(
    sheet.lede,
    "Plyloft saves the folder's changes in Git as one commit on my-work, in this folder only. Your files stay as they are, the branch stays my-work, and nothing is uploaded.",
  );
  assert.equal(WORK_IGNORE_LINE, "Plyloft adds a line to .gitignore for each new file you leave out.");
  assert.equal(sheet.list, `3 files, 3 KB. ${WORK_IGNORE_LINE}`);
  assert.equal(sheet.confirm, "Save and add");
  assert.equal(sheet.secretsIntro, SECRETS_INTRO);
  assert.equal(sheet.buildIntro, BUILD_INTRO);
  assert.equal(sheet.nestedLine, "“vendor/lib” is a Git project of its own, so Plyloft leaves it as it is.");
  assert.equal(sheet.refused, null);
  // 1.171.0 walk fix: it names the files it saves — here only the key the
  // sheet keeps (not left out), with the 3 counted files it doesn't name.
  assert.equal(sheet.filesLine, "It saves certs/tls.key and 3 more.");
  assert.equal(saveWorkSheet(work, [], initialLeaveOut(work)).filesLine, null, "none named: no line");
  assert.equal(saveWorkSheet({ ...work, workFiles: ["math.js", "todo.md", "src/a.js"] }, [], initialLeaveOut(work)).filesLine, "It saves math.js, src/a.js, todo.md.");
  assert.equal(workFilesLine(["a.js", "b.js"], 25), "It saves a.js, b.js and 23 more.");
  // Challenger 6: a secret the person chose to save is named and counted.
  const named = { ...work, workFiles: ["math.js"], toSave: { ...summary, files: 1, bytes: 10 } };
  assert.equal(saveWorkSheet(named, [], ["certs/tls.key", "node_modules/"]).filesLine, "It saves .env, math.js.");
  assert.equal(saveWorkSheet(named, [], [".env", "certs/tls.key", "node_modules/"]).filesLine, "It saves math.js.");
  assert.deepEqual(sheet.commands, [
    ".gitignore, lines added:\n  # Added by Plyloft\n  /.env\n  /node_modules/",
    "git add -A",
    "git reset -q -- .env node_modules vendor/lib",
    `git commit -m "${SAVE_WORK_COMMIT}"`,
  ]);
  // Never a push: no command reaches GitHub.
  assert.ok(sheet.commands.every((c) => !/push|gh /.test(c)));
  // No lines to add: the .gitignore sentence isn't said.
  assert.equal(saveWorkSheet({ ...work, nestedProjects: [] }, [], []).list, "3 files, 3 KB.");
  // A count that stopped: refused, never "save it anyway".
  const big = saveWorkSheet({ ...work, toSave: { ...summary, complete: false } }, [], []);
  assert.equal(big.incomplete, null);
  assert.equal(big.refused, WORK_TOO_BIG);
  // A refusal's words, and Git's output apart.
  assert.deepEqual(splitDetails("Refused.\n\nhook said no"), { text: "Refused.", details: "hook said no" });
  assert.deepEqual(splitDetails("Plain."), { text: "Plain.", details: null });
});

test("8a shared definition: says it brings its own settings", () => {
  assert.ok(folderView(insp({ sharedDefinition: true })).notes.includes("This project brings its own Plyloft settings."));
});

test("8a already in Plyloft → Open it", () => {
  const v = folderView(
    insp({ outcome: "already-in-ply", existingWorkspace: { id: "w1", name: "lyra", cwd: "/x" } }),
  );
  assert.equal(v.title, "“lyra” is already in Plyloft.");
  assert.deepEqual(v.primary, { label: "Open it", action: "open" });
});

test("8a not a repo → Make it a Git project, the list, the sheet with git init", () => {
  const i = insp({ outcome: "not-a-repo", git: { kind: "not-repo" }, branches: [], toSave: summary, ignoreLines: ["node_modules/", ".env"] });
  const v = folderView(i);
  assert.equal(v.title, "Make “lyra” a Git project?");
  assert.equal(
    v.text,
    "Plyloft will start Git here and save everything in the folder as the first version. Nothing is uploaded.",
  );
  assert.deepEqual(v.primary, { label: "Start Git and add", action: "save" });
  const sheet = saveSheet(i, ["node_modules/", ".env"]);
  assert.equal(sheet.list, "1 240 files, 18 MB. Plyloft adds a .gitignore that leaves out node_modules, build output and .env files.");
  assert.deepEqual(sheet.commands, [
    "git init -b main",
    ".gitignore, lines added:\n  # Added by Plyloft\n  node_modules/\n  .env",
    "git add -A",
    'git commit -m "chore: first commit"',
  ]);
  assert.equal(sheet.confirm, "Start Git and add");
  assert.equal(sheet.hugeWarning, null);
});

test("8a no commits → the same list and sheet, without git init", () => {
  const i = insp({ outcome: "no-commits", git: { kind: "unborn", branch: "main" }, branches: [], toSave: summary });
  const v = folderView(i);
  assert.equal(v.title, "“lyra” has no saved version yet.");
  assert.equal(v.text, "Plyloft will save everything in the folder as the first commit.");
  assert.deepEqual(v.primary, { label: "Save and add", action: "save" });
  const sheet = saveSheet(i, []);
  assert.ok(!sheet.commands.includes("git init -b main"));
  assert.equal(sheet.title, "Save “lyra”'s first version?");
});

test("8a detached HEAD → which branch, main preselected, the folder not switched", () => {
  const i = insp({
    outcome: "choose-branch",
    git: { kind: "detached", commit: "abc" },
    branches: ["feature", "main", "master"],
    suggestedBranch: "main",
  });
  const v = folderView(i);
  assert.equal(v.title, "“lyra” isn't on a branch right now.");
  assert.equal(v.text, "Cards start from a branch and are merged back into it. Which one?");
  assert.ok(v.asksBranch);
  assert.ok(v.notes.includes("Plyloft doesn't switch your folder's branch."));
  assert.equal(defaultBranch(i), "main");
  assert.equal(defaultBranch(insp({ suggestedBranch: null, branches: ["dev"] })), "dev");
});

test("8a inside another repo → Use “monorepo” instead · Choose another folder", () => {
  const v = folderView(
    insp({
      outcome: "inside-another-repo",
      git: { kind: "inside-another", topLevel: "/Users/me/code/monorepo", name: "monorepo", inPly: null },
    }),
  );
  assert.equal(v.title, "This folder is inside another Git project, “monorepo”.");
  assert.equal(v.text, "Plyloft works with a whole Git project.");
  assert.deepEqual(v.primary, { label: "Use “monorepo” instead", action: "use-top" });
  assert.deepEqual(v.secondary, { label: "Choose another folder", action: "choose-again" });
});

test("8a refused (home, /, a system folder, the projects folder) → Rust's words, choose again", () => {
  const v = folderView(
    insp({ outcome: "refused", refused: "home", refusedWords: "Choose a project folder, not your whole home folder." }),
  );
  assert.equal(v.title, "Choose a project folder, not your whole home folder.");
  assert.deepEqual(v.primary, { label: "Choose another folder", action: "choose-again" });
});

test("8a huge: the sheet warns and lists what will be saved", () => {
  const i = insp({
    outcome: "not-a-repo",
    git: { kind: "not-repo" },
    toSave: { ...summary, files: 25000, huge: true },
  });
  assert.equal(
    saveSheet(i, []).hugeWarning,
    "That's a lot to save in one go. Check the list of what's left out before continuing.",
  );
});

test("8a large files and secrets: listed, ticked, each a .gitignore line", () => {
  const i = insp({
    outcome: "not-a-repo",
    git: { kind: "not-repo" },
    toSave: summary,
    largeFiles: [{ path: "media/intro.mov", bytes: 80 * 1024 * 1024 }],
    secrets: [{ path: ".env", bytes: 20 }],
  });
  assert.deepEqual(initialLeaveOut(i), ["media/intro.mov", ".env"]);
  // Rust's plan for "intro.mov left out, .env unticked" (project_ignore_plan).
  const sheet = saveSheet(i, ["node_modules/", "/media/intro.mov", "!/.env"]);
  assert.equal(sheet.largeIntro, "These files are over 50 MB. GitHub refuses files over 100 MB, so Plyloft leaves them out:");
  assert.equal(sheet.secretsIntro, "These look like passwords or keys. Plyloft leaves them out of Git:");
  // The Details show exactly Rust's planned lines, the keep line included.
  assert.equal(sheet.commands[1], ".gitignore, lines added:\n  # Added by Plyloft\n  node_modules/\n  /media/intro.mov\n  !/.env");
  // While the plan is read, the sheet says so rather than guess.
  assert.equal(saveSheet(i, null).commands[1], ".gitignore: reading what will be added…");
  // Nothing to add: no .gitignore line at all.
  assert.ok(!saveSheet(i, []).commands.some((c) => c.startsWith(".gitignore")));
});

test("8a a count that stopped early: the sheet asks to go on", () => {
  const warn = "Plyloft stopped counting at 50 000 files or 5 seconds, so files past that weren't checked for keys or size.";
  const i = insp({
    outcome: "not-a-repo",
    git: { kind: "not-repo" },
    toSave: { ...summary, files: 50000, complete: false, huge: true },
    scanWarning: warn,
  });
  assert.equal(folderView(i).blocked, null);
  assert.equal(saveSheet(i, []).incomplete, warn);
  assert.equal(saveLine(i.toSave!), "At least 50 000 files, 18 MB.");
});

test("8a unnameable, found-truncated, .gitignore problem, partial download: blocked in words", () => {
  const base = { outcome: "not-a-repo" as const, git: { kind: "not-repo" as const }, toSave: summary };
  const unnameable = folderView(insp({ ...base, unnameable: ["a\nb.key"], scanWarning: "Some files … Rename them, then look again." }));
  assert.equal(unnameable.blocked, "Some files … Rename them, then look again.");
  assert.deepEqual(unnameable.primary, { label: "Choose another folder", action: "choose-again" });
  const truncated = folderView(insp({ ...base, foundTruncated: true, scanWarning: "There are more than 200 …" }));
  assert.equal(truncated.blocked, "There are more than 200 …");
  const ignore = folderView(insp({ ...base, ignoreProblem: ".gitignore is a link. Plyloft doesn't change it." }));
  assert.equal(ignore.blocked, ".gitignore is a link. Plyloft doesn't change it.");
  const partial = folderView(insp({ ...base, partialDownload: true }));
  assert.equal(
    partial.blocked,
    "This folder holds a download from GitHub that didn't finish. Remove the folder and get the project again.",
  );
});

test("8a no git identity: the first commit is blocked with Go to Git and your name", () => {
  const v = folderView(insp({ outcome: "not-a-repo", git: { kind: "not-repo" }, toSave: summary, needsIdentity: true }));
  assert.equal(v.needsIdentity, true);
  // A repo that already has commits needs no identity to be added.
  assert.equal(folderView(insp({ needsIdentity: false })).needsIdentity, false);
});

// ── 8b ───────────────────────────────────────────────────────────────────

const repo = (over: Partial<ProjectRepoEntry>): ProjectRepoEntry => ({
  nameWithOwner: "me/lyra",
  owner: "me",
  name: "lyra",
  description: null,
  isPrivate: true,
  isEmpty: false,
  updatedAt: null,
  diskUsageKb: 18432,
  defaultBranch: "main",
  group: "yours",
  groupOwner: "me",
  inPly: null,
  ...over,
});

test("8b the picker groups Yours · each organisation · Shared with you · Your team, and filters", () => {
  const repos = [
    repo({ nameWithOwner: "team/app", owner: "team", name: "app", group: "team", groupOwner: "team" }),
    repo({ nameWithOwner: "zeta/x", owner: "zeta", name: "x", group: "org", groupOwner: "zeta" }),
    repo({ nameWithOwner: "acme/api", owner: "acme", name: "api", group: "org", groupOwner: "acme", description: "The billing API" }),
    repo({}),
    repo({ nameWithOwner: "friend/notes", owner: "friend", name: "notes", group: "shared", groupOwner: "friend" }),
  ];
  assert.deepEqual(
    repoGroups(repos).map((g) => g.label),
    ["Yours", "acme", "zeta", "Shared with you", "Your team"],
  );
  assert.deepEqual(
    repoGroups(repos, "billing").map((g) => [g.label, g.repos.map((r) => r.nameWithOwner)]),
    [["acme", ["acme/api"]]],
  );
  assert.deepEqual(repoGroups(repos, "LYRA")[0].repos.map((r) => r.name), ["lyra"]);
  assert.equal(FILTER_AFTER, 12);
});

test("8b the size line: empty, small, about, and over 1 GB", () => {
  assert.equal(cloneSizeLine({ isEmpty: true, diskUsageKb: 0 }), "It's empty on GitHub.");
  assert.equal(cloneSizeLine({ isEmpty: false, diskUsageKb: 0 }), "It's small.");
  assert.equal(cloneSizeLine({ isEmpty: false, diskUsageKb: 18432 }), "It's about 18 MB.");
  assert.equal(
    cloneSizeLine({ isEmpty: false, diskUsageKb: Math.round(2.4 * 1024 * 1024) }),
    "It's 2.4 GB, so this may take a while.",
  );
  assert.equal(cloneSizeLine({ isEmpty: null, diskUsageKb: null }), null);
  const sheet = cloneSheet(repo({}), "~/Projects/lyra");
  assert.equal(sheet.title, "Get “lyra”?");
  assert.equal(sheet.lede, "Plyloft will download it into ~/Projects/lyra.");
  assert.equal(sheet.command, "gh repo clone me/lyra ~/Projects/lyra -- --progress");
});

test("8b updated line", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  assert.equal(updatedLine("2026-09-28T08:00:00Z", now), "Updated today");
  assert.equal(updatedLine("2026-09-25T08:00:00Z", now), "Updated 3 days ago");
  assert.equal(updatedLine(null, now), null);
});

const result = (over: Partial<ProjectCloneResult>): ProjectCloneResult => ({
  path: "/Users/me/Projects/lyra",
  repo: "me/lyra",
  cloned: true,
  empty: false,
  branch: "main",
  remoteBranches: [],
  failure: null,
  removedPartial: false,
  ...over,
});

test("8b a clone's end: add, empty, the branch question, failed", () => {
  assert.equal(cloneNext(result({})), "add");
  assert.equal(cloneNext(result({ empty: true })), "empty");
  assert.equal(cloneNext(result({ empty: true, remoteBranches: ["dev"] })), "branch");
  assert.equal(
    cloneNext(result({ cloned: false, failure: { kind: "offline", words: "x", ssoOrg: null } })),
    "failed",
  );
});

test("8b failures: auth (one account → Fix sign-in; several → another account), SSO, offline, cancelled", () => {
  const auth = result({ cloned: false, failure: { kind: "auth", words: "GitHub didn't let this account download lyra.", ssoOrg: null } });
  assert.deepEqual(cloneFailureView(auth, false), {
    text: "GitHub didn't let this account download lyra.",
    action: { id: "fix-sign-in", label: "Fix sign-in" },
  });
  assert.deepEqual(cloneFailureView(auth, true), {
    text: "GitHub didn't let this account download lyra. Try with another account.",
    action: null,
  });
  const sso = result({ cloned: false, failure: { kind: "sso", words: "Your organization …", ssoOrg: "acme" } });
  assert.deepEqual(cloneFailureView(sso, false)?.action, { id: "authorise", label: "Authorize" });
  const offline = result({ cloned: false, removedPartial: true, failure: { kind: "offline", words: "The download stopped. Nothing was added to Plyloft.", ssoOrg: null } });
  assert.deepEqual(cloneFailureView(offline, false), {
    text: "The download stopped. Nothing was added to Plyloft.",
    action: { id: "retry", label: "Try again" },
  });
  const cancelled = result({ cloned: false, failure: { kind: "cancelled", words: "Stopped. Nothing was added to Plyloft.", ssoOrg: null } });
  assert.equal(cloneFailureView(cancelled, false)?.action, null);
  assert.equal(cloneFailureView(result({}), false), null);
});

test("8b the account: several → the active one preselected; signed-out ones left out", () => {
  const status = {
    ghFound: true,
    helper: "gh" as const,
    githubEmail: null,
    githubNoreply: null,
    sso: null,
    accounts: [
      { login: "work", active: false, state: "signed-in" as const, scopes: null },
      { login: "me", active: true, state: "signed-in" as const, scopes: null },
      { login: "old", active: false, state: "refused" as const, scopes: null },
    ],
  };
  assert.deepEqual(accountChoices(status), { logins: ["work", "me"], preselected: "me" });
  assert.deepEqual(accountChoices(null), { logins: [], preselected: null });
});

// ── 8c ───────────────────────────────────────────────────────────────────

const preview = (over: Partial<ProjectNewPreview>): ProjectNewPreview => ({
  name: "My app",
  slug: "my-app",
  path: "/Users/me/Projects/my-app",
  displayPath: "~/Projects/my-app",
  folder: "missing",
  insideRepo: null,
  problem: null,
  placeRefused: false,
  ...over,
});

test("8c the live slug line, and a stale preview says nothing", () => {
  assert.deepEqual(newNameLine("My app", preview({})), { text: "It goes in ~/Projects/my-app.", problem: false });
  assert.equal(newNameLine("My ap", preview({})), null);
  assert.equal(newNameLine("", null), null);
});

test("8c symbols-only and reserved names: Rust's words; CJK-only names: the Latin-letters wording", () => {
  const needs = "Choose a name with letters or numbers.";
  assert.equal(nameProblem("!!!", needs), needs);
  assert.equal(nameProblem("con", needs), needs);
  assert.equal(nameProblem("日本語", needs), NAME_NEEDS_LATIN);
  assert.equal(nameProblem("مشروع", needs), NAME_NEEDS_LATIN);
  assert.equal(nameProblem("My app", null), null);
  assert.deepEqual(newNameLine("日本語", preview({ name: "日本語", slug: null, displayPath: null, problem: needs })), {
    text: NAME_NEEDS_LATIN,
    problem: true,
  });
});

test("8c a folder with files offers Add that folder instead; an empty one is used", () => {
  assert.equal(hasFilesOffer(preview({ folder: "has-files", problem: "There's already a folder called “my-app” with files in it." })), true);
  assert.equal(hasFilesOffer(preview({ folder: "empty" })), false);
  assert.equal(hasFilesOffer(preview({ folder: "has-files", placeRefused: true })), false);
});

test("8c the Create sheet names every command; the GitHub copy only when ticked", () => {
  const local = newSheet("My app", "~/Projects/my-app", "my-app", null);
  assert.equal(local.title, "Create “My app”?");
  assert.equal(local.lede, "Plyloft will make the folder, start Git in it and save a first version with a README.");
  assert.deepEqual(local.commands, [
    "mkdir ~/Projects/my-app",
    "git init -b main",
    "README.md: # My app",
    ".gitignore: .DS_Store, Thumbs.db, Desktop.ini (system files only)",
    "git add README.md .gitignore",
    'git commit -m "Start My app"',
  ]);
  const copy = newSheet("My app", "~/Projects/my-app", "my-app", "me");
  assert.ok(copy.lede.endsWith("Then it creates the private repository me/my-app on GitHub and sends that version."));
  assert.equal(copy.commands[copy.commands.length - 1], "gh repo create me/my-app --private --source . --push");
  assert.equal(githubCopyHint("me", "my-app"), "Creates the private repository me/my-app and sends the first version.");
});

test("8c the GitHub copy's result: made, name taken (kept locally), failed", () => {
  assert.equal(githubCopyLine(null, "my-app"), null);
  assert.equal(githubCopyLine({ state: "created", repo: "me/my-app", words: null }, "my-app"), "A private copy is on GitHub at me/my-app.");
  assert.equal(
    githubCopyLine({ state: "name-taken", repo: "me/my-app", words: null }, "my-app"),
    "You already have a repository called my-app on GitHub. The project was made on this computer; no copy was sent.",
  );
  assert.equal(githubCopyLine({ state: "failed", repo: "me/my-app", words: "gh said no." }, "my-app"), "gh said no.");
});

// ── Success: a repo with a commit on its target branch ───────────────────

test("repoReadyOf: the target branch must have a commit; without a config, the branch it's on", () => {
  const onMain = { git: { kind: "branch" as const, branch: "main", commit: "a" }, branches: ["main"] };
  assert.equal(repoReadyOf(onMain, null), true);
  assert.equal(repoReadyOf(onMain, "main"), true);
  assert.equal(repoReadyOf(onMain, "develop"), false);
  assert.equal(repoReadyOf({ git: { kind: "unborn" as const, branch: "main" }, branches: [] }, null), false);
  assert.equal(repoReadyOf({ git: { kind: "unborn" as const, branch: "main" }, branches: ["dev"] }, "dev"), true);
  assert.equal(repoReadyOf({ git: { kind: "detached" as const, commit: "a" }, branches: ["main"] }, null), true);
  assert.equal(repoReadyOf({ git: { kind: "not-repo" as const }, branches: [] }, null), false);
  assert.equal(
    repoReadyOf({ git: { kind: "inside-another" as const, topLevel: "/m", name: "m", inPly: null }, branches: [] }, null),
    true,
  );
});

await test("probeRepoReady stops at the first ready one; unknown when a look fails", async () => {
  const seen: string[] = [];
  const looks: Record<string, () => Promise<Pick<ProjectInspection, "git" | "branches">>> = {
    "/a": async () => ({ git: { kind: "not-repo" }, branches: [] }),
    "/b": async () => ({ git: { kind: "branch", branch: "main", commit: "x" }, branches: ["main"] }),
    "/c": async () => {
      throw new Error("git missing");
    },
  };
  const inspect = (cwd: string) => {
    seen.push(cwd);
    return looks[cwd]();
  };
  const ws = (id: string) => ({ id, cwd: `/${id}` });
  assert.equal(await probeRepoReady([ws("a"), ws("b"), ws("c")], new Map(), inspect), true);
  assert.deepEqual(seen, ["/a", "/b"]);
  assert.equal(await probeRepoReady([ws("a")], new Map(), inspect), false);
  assert.equal(await probeRepoReady([ws("a"), ws("c")], new Map(), inspect), null);
  assert.equal(await probeRepoReady([], new Map(), inspect), false);
  // A config's target branch without a commit.
  assert.equal(await probeRepoReady([ws("b")], new Map([["b", "develop"]]), inspect), false);
});

// 1.172 A3: the comment Details names is the one Rust writes.
assert.ok(
  readFileSync(new URL("../../src-tauri/src/project_setup.rs", import.meta.url), "utf8").includes(
    `pub const IGNORE_HEADER: &str = "${IGNORE_HEADER}";`,
  ),
  "IGNORE_HEADER matches project_setup.rs",
);

// 1.175.0 F2 (§2b): "It goes in …" follows the Projects folder row. The
// preview is asked in the row's folder; Rust's own folder needs no parent.
test("F2: the new project's place follows the folder chosen in the row", () => {
  assert.equal(PROJECTS_FOLDER_HINT, "New projects and the ones you get from GitHub go here.");
  // Nothing changed: Rust's folder (the saved one, else ~/Projects) applies.
  assert.equal(previewParent(null, "~/Projects", "/Users/me"), null);
  assert.equal(previewParent("~/code", "~/code", "/Users/me"), null);
  // Changed in the row, not saved yet: the preview is asked there.
  assert.equal(previewParent(null, "~/dev/work", "/Users/me"), "/Users/me/dev/work");
  assert.equal(previewParent("~/Projects", "/Volumes/Work/apps", "/Users/me"), "/Volumes/Work/apps");
  assert.equal(previewParent(null, "~", "/Users/me"), "/Users/me");
  // Windows: tilde form with forward slashes, the home with backslashes.
  assert.equal(previewParent(null, "~/Code/apps", "C:\\Users\\octo"), "C:\\Users\\octo\\Code\\apps");
  // The home not known: Rust's folder, rather than a guess.
  assert.equal(previewParent(null, "~/dev", null), null);
  // And the line under Name says what the preview answered.
  assert.deepEqual(newNameLine("My app", preview({ displayPath: "~/dev/work/my-app" })), {
    text: "It goes in ~/dev/work/my-app.",
    problem: false,
  });
});

console.log(`firstProject: ${passed} passed`);
