// Tier 3 pure-function test (OB-15, onboarding §9.2, §8.2, the OB-1 review's
// clone-root safeguard). Run with Node 22+:
//   node --experimental-strip-types src/lib/projectsFolder.test.ts
import assert from "node:assert/strict";
import { LEGACY_CLONE_ROOT, cloneRootToKeep, reportedCloneRoot, teamClonesFrom, tildeForm } from "./projectsFolder.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
  passed += 1;
}

test("a folder in the home folder is stored in tilde form", () => {
  assert.equal(tildeForm("/Users/ann/Projects", "/Users/ann"), "~/Projects");
  assert.equal(tildeForm("/Users/ann/Projects/", "/Users/ann/"), "~/Projects");
  assert.equal(tildeForm("/Users/ann/code/work stuff", "/Users/ann"), "~/code/work stuff");
  assert.equal(tildeForm("/Users/ann", "/Users/ann"), "~");
  // Not a prefix at a path boundary: /Users/anna is not inside /Users/ann.
  assert.equal(tildeForm("/Users/anna/Projects", "/Users/ann"), "/Users/anna/Projects");
  // Outside the home folder: kept as picked.
  assert.equal(tildeForm("/Volumes/Work/Projects", "/Users/ann"), "/Volumes/Work/Projects");
  // No home known: kept as picked.
  assert.equal(tildeForm("/Users/ann/Projects", null), "/Users/ann/Projects");
});

test("on Windows the tilde form uses forward slashes (team::expand_tilde reads ~/)", () => {
  assert.equal(tildeForm("C:\\Users\\Ann\\Projects", "C:\\Users\\Ann"), "~/Projects");
  assert.equal(tildeForm("c:\\users\\ann\\Projects\\Work", "C:\\Users\\Ann"), "~/Projects/Work");
  assert.equal(tildeForm("D:\\Projects", "C:\\Users\\Ann"), "D:\\Projects");
});

const cloned = { teamRepo: "acme/team", workspaces: [{ cloned: true, registered: false }] };
const opened = { teamRepo: "acme/team", workspaces: [{ cloned: false, registered: true }] };
const none = { teamRepo: "acme/team", workspaces: [{ cloned: false, registered: false }] };

test("team workspaces under ~/code keep ~/code as the clone root", () => {
  const base = { cloneRoot: null, currentFolder: null, nextFolder: "~/Projects", teamMode: true };
  assert.equal(cloneRootToKeep({ ...base, team: cloned }), LEGACY_CLONE_ROOT);
  assert.equal(cloneRootToKeep({ ...base, team: opened }), "~/code");
  // Nothing cloned or open there: the team's clones follow the new folder.
  assert.equal(cloneRootToKeep({ ...base, team: none }), null);
  // No team at all.
  assert.equal(cloneRootToKeep({ ...base, team: { teamRepo: null, workspaces: [] } }), null);
});

test("a clone root already set is never touched", () => {
  assert.equal(
    cloneRootToKeep({ cloneRoot: "~/work", currentFolder: null, nextFolder: "~/Projects", team: cloned, teamMode: true }),
    null,
  );
  // Blank reads as unset (team::clone_root_setting does the same).
  assert.equal(
    cloneRootToKeep({ cloneRoot: "  ", currentFolder: null, nextFolder: "~/Projects", team: cloned, teamMode: true }),
    "~/code",
  );
});

test("a projects folder already chosen is where the clones are now", () => {
  assert.equal(
    cloneRootToKeep({ cloneRoot: null, currentFolder: "~/Projects", nextFolder: "~/Work", team: cloned, teamMode: true }),
    "~/Projects",
  );
  // Picking the place they already are changes nothing.
  assert.equal(
    cloneRootToKeep({ cloneRoot: null, currentFolder: null, nextFolder: "~/code", team: cloned, teamMode: true }),
    null,
  );
});

test("1.168.1: the root the team status reports is where the clones are now", () => {
  const base = { cloneRoot: null, currentFolder: null, teamMode: true, home: "/Users/ann" };
  // Nothing chosen and no checkouts in ~/code: the team resolves under the
  // projects default, so choosing it changes nothing…
  const atDefault = { ...base, team: cloned, reportedRoot: "/Users/ann/Projects" };
  assert.equal(cloneRootToKeep({ ...atDefault, nextFolder: "~/Projects" }), null);
  // …and choosing another folder keeps ~/Projects for the ones cloned there.
  assert.equal(cloneRootToKeep({ ...atDefault, nextFolder: "~/Work" }), "~/Projects");
  // Checkouts still in the legacy ~/code: kept there.
  assert.equal(
    cloneRootToKeep({ ...base, team: cloned, reportedRoot: "/Users/ann/code", nextFolder: "~/Projects" }),
    "~/code",
  );
  // Offline (GitHub unreachable) the root still comes from the local
  // manifest: nothing pinned to ~/code when the clones resolve under ~/Projects.
  const offline = { teamRepo: "acme/team", hasClone: true, error: "GitHub unreachable", workspaces: [], cloneRoot: "/Users/ann/Projects" };
  assert.equal(reportedCloneRoot(offline), "/Users/ann/Projects");
  assert.equal(
    cloneRootToKeep({ ...base, team: teamClonesFrom(offline), reportedRoot: reportedCloneRoot(offline), nextFolder: "~/Projects" }),
    null,
  );
  // No clone of the team repo: no manifest said where, so no reported root.
  assert.equal(reportedCloneRoot({ ...offline, hasClone: false }), null);
  assert.equal(reportedCloneRoot({ teamRepo: null, hasClone: false, cloneRoot: "/Users/ann/Projects" }), "/Users/ann/Projects");
  assert.equal(reportedCloneRoot(null), null);
});

test("a team that couldn't be read keeps the clone root in team mode only", () => {
  const base = { cloneRoot: null, currentFolder: null, nextFolder: "~/Projects", team: null };
  assert.equal(cloneRootToKeep({ ...base, teamMode: true }), "~/code");
  assert.equal(cloneRootToKeep({ ...base, teamMode: false }), null);
});

test("a team status that couldn't read the manifest counts as unread", () => {
  const read = { teamRepo: "acme/team", hasClone: true, error: null, workspaces: [{ cloned: false, registered: false }] };
  assert.deepEqual(teamClonesFrom(read), { teamRepo: "acme/team", workspaces: read.workspaces });
  // An error, or no clone of the team repo to list workspaces from: unread.
  assert.equal(teamClonesFrom({ ...read, error: "GitHub unreachable" }), null);
  assert.equal(teamClonesFrom({ ...read, hasClone: false, workspaces: [] }), null);
  assert.equal(teamClonesFrom(null), null);
  // No team at all: read, and nothing to keep.
  assert.deepEqual(teamClonesFrom({ teamRepo: null, hasClone: false, error: null, workspaces: [] }), {
    teamRepo: null,
    workspaces: [],
  });
  // So in team mode, with no root the status can vouch for (none reported,
  // or no clone of the team repo), ~/code is kept; the old reading of "[]"
  // would have lost it.
  const base = { cloneRoot: null, currentFolder: null, nextFolder: "~/Projects", teamMode: true };
  assert.equal(cloneRootToKeep({ ...base, team: teamClonesFrom({ ...read, error: "x", workspaces: [] }) }), "~/code");
  assert.equal(cloneRootToKeep({ ...base, team: teamClonesFrom({ ...read, hasClone: false, workspaces: [] }) }), "~/code");
});

console.log(`projectsFolder: ${passed} passed`);
