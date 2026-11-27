// The refusal of a start or a Ship in a workspace that was never set up, and
// the page its `Set up` opens.
//   node --experimental-strip-types src/lib/projectSetup.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SET_UP_NEEDS_WRITE,
  SET_UP_PAGE,
  SET_UP_ROW,
  SET_UP_TODO,
  SET_UP_TODO_1173,
  autoSetUpBranchIsSafe,
  canSetUpOnStart,
  needsSetUp,
  needsSetUpByWriter,
  projectFolderGone,
  projectFolderWords,
  setUpOnStartNotice,
  startSettingUpOnce,
} from "./projectSetup.ts";
import { SETTINGS_NAV } from "./settingsNav.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// The backend says it in these words, so the frontend can find it.
const projectConfigRs = read("../../src-tauri/src/project_config.rs");
assert.ok(projectConfigRs.includes(`"${SET_UP_TODO}"`), "project_config.rs has SET_UP_TODO");

const refusal =
  "Atelier isn't set up for Plyloft's builds yet, so Plyloft doesn't know which branch to work from. " +
  `Nothing was started. ${SET_UP_TODO}, then start the card again.`;
assert.equal(needsSetUp(refusal), true);
// DS9: a refusal already on a card, in the 1.173 words, is still found.
assert.ok(projectConfigRs.includes(`"${SET_UP_TODO_1173}"`), "project_config.rs keeps the 1.173 words");
assert.equal(needsSetUp(refusal.replace(SET_UP_TODO, SET_UP_TODO_1173)), true);
assert.equal(needsSetUp(new Error(refusal)), true);
assert.equal(needsSetUp("Assign yourself the GitHub issue first (use the Claim button)."), false);
assert.equal(needsSetUp(null), false);
assert.equal(needsSetUpByWriter(refusal), false);
// OB-15 (onboarding §9.1): while Setup isn't finished the backend adds
// "or finish setup" after the phrase, which still finds it.
assert.ok(projectConfigRs.includes('pub const OR_FINISH_SETUP: &str = ", or finish setup";'));
const unfinished =
  "Atelier isn't set up for Ply's builds yet, so Ply doesn't know which branch to work from. " +
  `Nothing was started. ${SET_UP_TODO}, or finish setup, then start the card again.`;
assert.equal(needsSetUp(unfinished), true);

// Read-only shared settings: no Re-detect button, so no `Set up`.
assert.ok(projectConfigRs.includes(SET_UP_NEEDS_WRITE), "project_config.rs says who can");
const readOnly =
  "Atelier isn't set up for Plyloft's builds yet, so Plyloft doesn't know which branch to work from. " +
  "Nothing was started. Its settings are shared and this account can't write to the repository: " +
  `${SET_UP_NEEDS_WRITE} in Settings › Cards › Building and checking and publish; then start the card again.`;
assert.equal(needsSetUp(readOnly), false);
assert.equal(needsSetUpByWriter(readOnly), true);

// The sentence names the page as the navigation does (1.174.0 DS1 grouped
// Settings by task; DS9 says it in the refusal on both sides).
const cards = SETTINGS_NAV.find((g) => g.entries.some((e) => e.id === SET_UP_PAGE));
assert.ok(cards, "the Set up page is in the navigation");
const setUpEntry = cards!.entries.find((e) => e.id === SET_UP_PAGE)!;
assert.equal(SET_UP_TODO, `Open Settings › ${cards!.label} › ${setUpEntry.label} and press Re-detect`);

// …and the button and row as the page draws them.
const repositorySettings = read("../components/RepositorySettings.tsx");
assert.ok(repositorySettings.includes('{detecting ? "Reading…" : "Re-detect"}'));
assert.ok(repositorySettings.includes(`label="${SET_UP_ROW}"`));

// n16: a start refused for no config sets the repository up once and tries
// once more — only on the writable refusal.
assert.equal(canSetUpOnStart(refusal), true);
assert.equal(canSetUpOnStart(unfinished), true);
assert.equal(canSetUpOnStart(readOnly), false, "shared settings this account can't write keep their words");
assert.equal(canSetUpOnStart("Assign yourself the GitHub issue first"), false);
assert.deepEqual(setUpOnStartNotice("lyra", "main"), {
  title: "“lyra” is set up for builds",
  // DS9: the row is Cards › Shipping › Cards go to (DS2).
  body: "Plyloft builds from main. Change it in Settings › Cards › Shipping.",
});
// Only a branch that is plainly the one to build from.
const withOrigin = (defaultBranch: string) => ({ hasOrigin: true, defaultBranch });
const noOrigin = { hasOrigin: false, defaultBranch: null };
assert.equal(autoSetUpBranchIsSafe("main", ["main", "feature"], withOrigin("main")), true);
assert.equal(autoSetUpBranchIsSafe("trunk", ["trunk"], withOrigin("trunk")), true);
assert.equal(autoSetUpBranchIsSafe("feature", ["feature", "main"], withOrigin("main")), false, "a feature branch checked out");
assert.equal(autoSetUpBranchIsSafe("main", ["main"], withOrigin("develop")), false, "origin builds from develop");
assert.equal(autoSetUpBranchIsSafe("main", ["main", "x"], noOrigin), true);
assert.equal(autoSetUpBranchIsSafe("master", ["master", "x"], noOrigin), true);
assert.equal(autoSetUpBranchIsSafe("trunk", ["trunk"], noOrigin), true, "the only branch");
assert.equal(autoSetUpBranchIsSafe("feature", ["feature", "main"], noOrigin), false);
assert.equal(autoSetUpBranchIsSafe("", [], noOrigin), false);
// Pushed, not cloned: an origin with no origin/HEAD names no default, and a
// branch checked out there is never taken for it.
const noOriginHead = { hasOrigin: true, defaultBranch: null };
assert.equal(autoSetUpBranchIsSafe("feature", ["feature"], noOriginHead), false);
// 1.171.0 walk fix: a folder just added (Add a project) is set up from the
// branch it is on when it has no origin — the branch its work was saved on.
assert.equal(autoSetUpBranchIsSafe("feature", ["feature", "main"], noOrigin, true), true, "just added, no origin");
assert.equal(autoSetUpBranchIsSafe("gone", ["feature", "main"], noOrigin, true), false, "a branch it doesn't have");
// Pushed, not cloned, just added: main, master or the only branch.
assert.equal(autoSetUpBranchIsSafe("main", ["main", "x"], noOriginHead, true), true);
assert.equal(autoSetUpBranchIsSafe("feature", ["feature"], noOriginHead, true), true, "the only branch");
assert.equal(autoSetUpBranchIsSafe("feature", ["feature", "main"], noOriginHead, true), false);
// Origin's own default still decides.
assert.equal(autoSetUpBranchIsSafe("feature", ["feature", "main"], withOrigin("main"), true), false);
assert.equal(autoSetUpBranchIsSafe("main", ["main"], noOriginHead), false);
{
  // Refused, set up, retried once: the retry's result is the start's, and
  // the set-up is said only after the retry went through.
  let runs = 0;
  let setUps = 0;
  const said: string[] = [];
  const result = await startSettingUpOnce(
    async () => {
      runs += 1;
      if (runs === 1) throw refusal;
      said.push("started");
      return "started";
    },
    async () => {
      setUps += 1;
      return () => said.push("set up");
    },
  );
  assert.deepEqual([result, runs, setUps], ["started", 2, 1]);
  assert.deepEqual(said, ["started", "set up"]);
}
const firstRefusal = async (setUp: () => Promise<(() => void) | null>, error: unknown = refusal) => {
  let runs = 0;
  let setUps = 0;
  let said = 0;
  let thrown: unknown = null;
  try {
    await startSettingUpOnce(
      async () => {
        runs += 1;
        throw error;
      },
      async () => {
        setUps += 1;
        const announce = await setUp();
        return announce && (() => (said += 1));
      },
    );
  } catch (e) {
    thrown = e;
  }
  return { runs, setUps, said, thrown };
};
const saidNothing = () => {};
// Read-only: no set-up, the refusal as it was.
assert.deepEqual(await firstRefusal(async () => saidNothing, readOnly), { runs: 1, setUps: 0, said: 0, thrown: readOnly });
// Nothing to propose, or the save failed: the first refusal, no retry.
assert.deepEqual(await firstRefusal(async () => null), { runs: 1, setUps: 1, said: 0, thrown: refusal });
assert.deepEqual(
  await firstRefusal(async () => {
    throw "save failed";
  }),
  { runs: 1, setUps: 1, said: 0, thrown: refusal },
);
// Refused again after the set-up: thrown, never a second set-up or retry,
// and the set-up is not announced for a start that didn't go through.
assert.deepEqual(await firstRefusal(async () => saidNothing), { runs: 2, setUps: 1, said: 0, thrown: refusal });

console.log("projectSetup.test.ts ok");

// The folder refusal: a claim is named only where the backend names one, which
// is a GitHub Issues board. A local board has none.
{
  const MOVED = "This project's folder isn't where Plyloft left it";
  const MOVED_TAIL = "Put the folder back; a team's project can be cloned again from Settings › Team › Members and library.";
  const PLAIN = "This project's folder isn't a git repository";
  const PLAIN_TAIL = "Put its repository back, or move the folder aside.";
  assert.equal(projectFolderWords(`${MOVED}. ${MOVED_TAIL}`), `${MOVED}. ${MOVED_TAIL}`);
  assert.equal(projectFolderWords(`${PLAIN}. ${PLAIN_TAIL}`), `${PLAIN}. ${PLAIN_TAIL}`);
  const movedClaim = `${MOVED}, so nothing was claimed. ${MOVED_TAIL}`;
  const plainClaim = `${PLAIN}, so nothing was claimed. ${PLAIN_TAIL}`;
  assert.equal(projectFolderWords(movedClaim), movedClaim);
  assert.equal(projectFolderWords(plainClaim), plainClaim);
  assert.equal(projectFolderWords(new Error(movedClaim)), movedClaim);
  // Both forms are still known as this refusal.
  for (const words of [`${MOVED}. ${MOVED_TAIL}`, `${PLAIN}. ${PLAIN_TAIL}`, movedClaim, plainClaim]) {
    assert.equal(projectFolderGone(words), true);
  }
}
