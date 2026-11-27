// Tier 3 pure-function test (OB-4, ONBOARDING_SPEC §3–§5). Run with Node 22+:
//   node --experimental-strip-types src/lib/setupSteps.test.ts
import assert from "node:assert/strict";
import {
  TEAM_STEP_LINK,
  deduceWorkMode,
  deductionSaves,
  modeAskedWhy,
  teamStepLinkShown,
  workModeInList,
  REQUIRED_IDS,
  SETUP_AUTO_OPEN,
  SETUP_STEPS,
  setSetupAutoOpenForTests,
  setupAutoOpens,
  applicableOrNext,
  applicableSteps,
  closedOnboarding,
  deriveSteps,
  detectedTeamLine,
  doctorFacts,
  finishRow,
  resumePoint,
  firstMissingRequiredStep,
  firstOpenStep,
  headerCopy,
  knownStepId,
  launchCase,
  stampsWithoutOpening,
  levelSwitch,
  missingRequired,
  neighbours,
  nextOpenStep,
  passedOverSteps,
  foundAlreadyLine,
  progress,
  progressCaption,
  requiredComplete,
  requiredItems,
  readyUnfinished,
  skipConsequence,
  tourOffered,
  setupFactsFrom,
  setupSummary,
  setupWorkspaceCount,
  soloRefusal,
  stillToDo,
  startStep,
  stateWord,
  stepLine,
  stepState,
  withAiObserved,
  withGithubObserved,
  guardedRun,
  stepOfAction,
  type SetupFacts,
} from "./setupSteps.ts";
import { SETUP_STEP_IDS, SETUP_VERSION } from "./settingsShape.ts";

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

/** A Mac with nothing on it and nothing answered. */
const blank: SetupFacts = {
  gitWorks: false,
  gitIdentity: false,
  aiReady: false,
  githubSignedIn: null,
  level: null,
  workMode: "solo",
  workModeChosen: false,
  teamJoined: false,
  projectsFolderChosen: false,
  workspaceCount: 0,
  configuredWorkspaceCount: 0,
};
/** A Mac where every step is detected done. */
const complete: SetupFacts = {
  gitWorks: true,
  gitIdentity: true,
  aiReady: true,
  githubSignedIn: true,
  level: "guided",
  workMode: "team",
  workModeChosen: true,
  teamJoined: true,
  projectsFolderChosen: true,
  workspaceCount: 2,
  configuredWorkspaceCount: 1,
  plyloftSignedIn: true,
};
const f = (over: Partial<SetupFacts>): SetupFacts => ({ ...blank, ...over });
const ids = (steps: { id: string }[]) => steps.map((s) => s.id);

// ── The table ────────────────────────────────────────────────────────────

test("the steps follow the stable ids, and only Welcome, the question and Ready cannot be skipped", () => {
  assert.deepEqual(ids([...SETUP_STEPS]), [...SETUP_STEP_IDS]);
  // Launch A2: the Plyloft account is step 2, right after Welcome.
  // 1.178.0 (A3): optional — "Only for teams".
  assert.equal(SETUP_STEPS[1].id, "account");
  assert.deepEqual(
    SETUP_STEPS.filter((s) => !s.skippable).map((s) => s.id),
    ["welcome", "mode", "ready"],
  );
  assert.deepEqual(SETUP_STEPS.filter((s) => s.teamOnly).map((s) => s.id), ["team"]);
});

test("the required set is git, identity, ai and project, and each has a step", () => {
  assert.deepEqual([...REQUIRED_IDS], ["git", "identity", "ai", "project"]);
  for (const r of REQUIRED_IDS) {
    assert.ok(SETUP_STEPS.some((s) => s.required.includes(r)), r);
  }
  // GitHub, team, projects folder are optional (§4).
  for (const id of ["github", "team", "folder", "welcome", "account", "mode", "ready"]) {
    assert.deepEqual(SETUP_STEPS.find((s) => s.id === id)!.required, [], id);
  }
});

test("knownStepId keeps this build's ids and drops anything else", () => {
  assert.equal(knownStepId("git"), "git");
  assert.equal(knownStepId("dropped-in-v2"), null);
  assert.equal(knownStepId(null), null);
  assert.equal(knownStepId(3), null);
});

// ── Numbering ────────────────────────────────────────────────────────────

// 1.175.0 F2 (UX-3): "Solo or team" and "Where your projects live" are not
// in the list — nine screens for a team, eight solo (mockup §2a's count).
test("team mode numbers nine steps; solo hides Team and renumbers to eight", () => {
  const team = deriveSteps(f({ workMode: "team" }), {});
  assert.equal(team.length, 9);
  assert.equal(team.find((s) => s.id === "account")!.number, 2);
  assert.equal(team.find((s) => s.id === "team")!.number, 6);
  assert.equal(team.find((s) => s.id === "ready")!.number, 9);
  // 1.175.0 F1: GitHub is step 3, so the AI is step 4.
  assert.equal(stepLine(team, "github"), "Step 3 of 9");
  assert.equal(stepLine(team, "ai"), "Step 4 of 9");

  const solo = deriveSteps(f({ workMode: "solo" }), {});
  assert.equal(solo.length, 8);
  assert.ok(!solo.some((s) => s.id === "team"));
  assert.ok(!solo.some((s) => s.id === "mode"), "the question isn't asked by itself");
  assert.ok(!solo.some((s) => s.id === "folder"), "the folder is a row of Your first project");
  assert.equal(solo.find((s) => s.id === "project")!.number, 6);
  assert.equal(solo.find((s) => s.id === "ready")!.number, 8);
  assert.equal(stepLine(solo, "ready"), "Step 8 of 8");
  assert.deepEqual(ids(applicableSteps("solo")), ids(solo));
  // Asked for (the link under the list), the question takes its place after
  // GitHub, and nothing else moves.
  const asked = deriveSteps(f({ workMode: "solo" }), {}, true);
  assert.deepEqual(ids(asked), ["welcome", "account", "github", "mode", "ai", "git", "project", "config", "ready"]);
  assert.deepEqual(ids(applicableSteps("team", true)), ["welcome", "account", "github", "mode", "ai", "git", "team", "project", "config", "ready"]);
  assert.ok(!asked.some((s) => s.id === "folder"), "the folder never re-enters");
});

// 1.175.0 F1 (UX-2): the order. The same eleven ids; `github` moved from
// after `git` to right after `account`, so the second GitHub code follows
// the first.
test("F1: GitHub comes right after the account, and the ids are the same eleven", () => {
  assert.deepEqual(
    SETUP_STEPS.map((s) => s.id),
    ["welcome", "account", "github", "mode", "ai", "git", "team", "folder", "project", "config", "ready"],
  );
  assert.deepEqual(SETUP_STEPS.map((s) => s.id), [...SETUP_STEP_IDS]);
  assert.deepEqual(
    [...SETUP_STEP_IDS].sort(),
    ["welcome", "account", "mode", "ai", "git", "github", "team", "folder", "project", "config", "ready"].sort(),
    "no id added, dropped or renamed",
  );
  const solo = deriveSteps(f({}), {});
  // F2: `mode` and `folder` are in the ids, not in the list.
  assert.deepEqual(
    solo.map((s) => [s.number, s.id]),
    [[1, "welcome"], [2, "account"], [3, "github"], [4, "ai"], [5, "git"], [6, "project"], [7, "config"], [8, "ready"]],
  );
  // The step still asks for no required item, and can be skipped.
  const github = SETUP_STEPS.find((s) => s.id === "github")!;
  assert.deepEqual([github.required, github.skippable, github.teamOnly], [[], true, false]);
});

// F1 and F2 (the migration the cards name): a resume point written by
// 1.174.5 names a step by id. Each of the steps whose place moved reopens
// Setup on that same step, wherever it now stands in the list — for someone
// solo and for a team; `team`, which a solo person doesn't see, lands on the
// step after it, as before. F2: `mode`, which 1.174.5 asked everyone, lands
// on the first step not settled after the account (the deduction answers
// it); `folder` lands on "Your first project", where its row now is.
test("F1/F2: a resume point saved by 1.174.5 reopens Setup on the same step in the new order", () => {
  const solo = deriveSteps(f({ plyloftSignedIn: true }), {});
  const team = deriveSteps(f({ plyloftSignedIn: true, workMode: "team", workModeChosen: true }), {});
  for (const setupCase of ["firstRun", "existing"] as const) {
    for (const [stored, soloAt, teamAt] of [
      ["github", "github", "github"],
      ["mode", "github", "github"],
      ["folder", "project", "project"],
      ["git", "git", "git"],
      ["team", "project", "team"],
    ] as const) {
      assert.equal(startStep(setupCase, stored, solo), soloAt, `${setupCase} solo ${stored}`);
      assert.equal(startStep(setupCase, stored, team), teamAt, `${setupCase} team ${stored}`);
      assert.equal(knownStepId(stored), stored, "an id this build knows");
    }
  }
  // `mode` stored with GitHub already behind: the next step not settled.
  const connected = deriveSteps(f({ plyloftSignedIn: true, githubSignedIn: true, aiReady: true }), {});
  assert.equal(startStep("existing", "mode", connected), "git");
  // Where they stand now.
  assert.equal(stepLine(solo, "github"), "Step 3 of 8");
  assert.equal(stepLine(solo, "git"), "Step 5 of 8");
  assert.equal(stepLine(solo, "project"), "Step 6 of 8");
  assert.equal(stepLine(team, "team"), "Step 6 of 9");
  // A rerun after Setup was finished (Ready): the first step not settled.
  assert.equal(startStep("rerun", "ready", deriveSteps(complete, {})), "ready");
});

test("Back and Next skip the hidden Team step", () => {
  const solo = deriveSteps(f({}), {});
  assert.deepEqual(neighbours(solo, "git"), { prev: "ai", next: "project" });
  assert.deepEqual(neighbours(solo, "welcome"), { prev: null, next: "account" });
  // 1.175.0 F1: the GitHub step sits between the account and the AI (F2:
  // Solo or team isn't asked).
  assert.deepEqual(neighbours(solo, "account"), { prev: "welcome", next: "github" });
  assert.deepEqual(neighbours(solo, "github"), { prev: "account", next: "ai" });
  assert.deepEqual(neighbours(solo, "ready"), { prev: "config", next: null });
  const team = deriveSteps(f({ workMode: "team" }), {});
  assert.deepEqual(neighbours(team, "git"), { prev: "ai", next: "team" });
});

test("QoL 7.1: Continue goes to the next step not done or skipped", () => {
  // Signed in, Git and the name and the AI already fine: Welcome's Continue
  // lands on GitHub (1.175.0 F1: right after the account), and that one's on
  // the first project, past AI and Git (F2: no Solo or team, no folder step).
  const mac = f({ plyloftSignedIn: true, gitWorks: true, gitIdentity: true, aiReady: true });
  const steps = deriveSteps(mac, {});
  assert.equal(nextOpenStep(steps, "welcome"), "github");
  assert.equal(nextOpenStep(steps, "github"), "project");
  assert.deepEqual(passedOverSteps(steps, "github", "project"), ["ai", "git"]);
  assert.equal(
    foundAlreadyLine(steps, ["ai", "git"]),
    "Plyloft found your AI and Git and your name already set up, so Setup didn't stop there.",
  );
  assert.equal(foundAlreadyLine(steps, []), null);
  // (Windows walk) Never the account, and never a step not done now.
  assert.equal(foundAlreadyLine(steps, ["account"]), null);
  const signedOut = deriveSteps({ ...mac, plyloftSignedIn: false, gitIdentity: false }, {});
  assert.equal(
    foundAlreadyLine(signedOut, ["account", "ai", "git"]),
    "Plyloft found your AI already set up, so Setup didn't stop there.",
  );
  // A skipped step is passed over too, and is not named as found.
  const skipped = deriveSteps(mac, { github: "t" });
  assert.equal(nextOpenStep(skipped, "welcome"), "project");
  assert.deepEqual(passedOverSteps(skipped, "account", "project"), ["ai", "git"], "skipped is not found done");
  // F1: GitHub already connected on this Mac — the step is passed over and
  // Ready names it; while Git doesn't use that sign-in yet (the overlay
  // lists it as unsure) it is shown, and never named as found.
  const connected = deriveSteps({ ...mac, githubSignedIn: true }, {});
  assert.equal(nextOpenStep(connected, "account"), "project");
  assert.deepEqual(passedOverSteps(connected, "account", "project"), ["github", "ai", "git"]);
  assert.equal(
    foundAlreadyLine(connected, ["github"]),
    "Plyloft found GitHub already set up, so Setup didn't stop there.",
  );
  assert.equal(nextOpenStep(connected, "account", ["github"]), "github");
  assert.deepEqual(passedOverSteps(connected, "account", "github", ["github"]), []);
  // Everything later settled: Ready. Ready itself has no next.
  const all = deriveSteps(complete, {});
  assert.equal(nextOpenStep(all, "welcome"), "ready");
  assert.equal(nextOpenStep(all, "ready"), null);
  // (Challenger) The AI step's "done" from a guess is shown; a definite one
  // passes it over. Ready never names a guess.
  assert.equal(nextOpenStep(steps, "github", ["ai"]), "ai");
  assert.deepEqual(passedOverSteps(steps, "ai", "project", ["ai"]), ["git"]);
  assert.deepEqual(passedOverSteps(steps, "github", "ai", ["ai"]), []);
  // A fact not known yet is not settled: the step is shown.
  const unknown = deriveSteps(f({ plyloftSignedIn: true, aiReady: null }), {});
  assert.equal(nextOpenStep(unknown, "github"), "ai");
  // The team step shows for a team (walked with the mode just chosen).
  const team = deriveSteps({ ...mac, workMode: "team", workModeChosen: true, githubSignedIn: true }, {});
  assert.equal(nextOpenStep(team, "github"), "team");
  // F2: the question asked for, answered With a team: Continue walks the
  // list with Your team in it.
  const askedTeam = deriveSteps({ ...mac, workMode: "team", githubSignedIn: true }, {}, true);
  assert.equal(nextOpenStep(askedTeam, "mode"), "team");
});

test("QoL 7.1: the list names the steps as their screens do", () => {
  const title = (id: string) => SETUP_STEPS.find((s) => s.id === id)!.title;
  assert.equal(title("ai"), "Your AI");
  assert.equal(title("git"), "Git and your name");
  assert.equal(title("github"), "GitHub for your projects");
  assert.equal(title("team"), "Your team");
  assert.equal(title("project"), "Your first project");
});

// ── Every state ──────────────────────────────────────────────────────────

test("welcome is done once a level is set, and never needs you", () => {
  assert.equal(stepState("welcome", f({}), {}), "empty");
  assert.equal(stepState("welcome", f({ level: "fast" }), {}), "done");
  // Not skippable: a stray skipped entry is ignored.
  assert.equal(stepState("welcome", f({}), { welcome: "t" }), "empty");
});

test("mode is done only when a choice is stored, not when derived", () => {
  assert.equal(stepState("mode", f({ workMode: "team" }), {}), "empty");
  assert.equal(stepState("mode", f({ workModeChosen: true }), {}), "done");
  assert.equal(stepState("mode", f({}), { mode: "t" }), "empty");
});

test("a required step: done when detected, else skipped, else needs you", () => {
  assert.equal(stepState("ai", f({ aiReady: true }), {}), "done");
  assert.equal(stepState("ai", f({ aiReady: false }), {}), "needs");
  assert.equal(stepState("ai", f({ aiReady: false }), { ai: "2026-09-27T10:00:00Z" }), "skipped");
  // Detected wins over a skip made earlier: done is never remembered, and
  // never forgotten either.
  assert.equal(stepState("ai", f({ aiReady: true }), { ai: "t" }), "done");
  // Not known yet: nothing to say — not done, not "needs you".
  assert.equal(stepState("ai", f({ aiReady: null }), {}), "empty");
});

test("git needs both git and the identity", () => {
  assert.equal(stepState("git", f({ gitWorks: true, gitIdentity: true }), {}), "done");
  assert.equal(stepState("git", f({ gitWorks: true, gitIdentity: false }), {}), "needs");
  assert.equal(stepState("git", f({ gitWorks: false, gitIdentity: true }), {}), "needs");
  assert.equal(stepState("git", f({ gitWorks: true, gitIdentity: null }), {}), "empty");
  assert.equal(stepState("git", f({ gitWorks: false, gitIdentity: null }), {}), "needs");
});

test("optional steps are done, skipped or empty — never needs you", () => {
  assert.equal(stepState("github", f({ githubSignedIn: true }), {}), "done");
  assert.equal(stepState("github", f({ githubSignedIn: false }), {}), "empty");
  assert.equal(stepState("github", f({ githubSignedIn: false }), { github: "t" }), "skipped");
  assert.equal(stepState("team", f({ teamJoined: true }), {}), "done");
  assert.equal(stepState("team", f({}), { team: "t" }), "skipped");
  assert.equal(stepState("folder", f({ projectsFolderChosen: true }), {}), "done");
  assert.equal(stepState("folder", f({}), {}), "empty");
});

test("first project and project settings", () => {
  assert.equal(stepState("project", f({}), {}), "needs");
  assert.equal(stepState("project", f({ workspaceCount: 1 }), {}), "done");
  assert.equal(stepState("config", f({ workspaceCount: 1, configuredWorkspaceCount: 0 }), {}), "needs");
  assert.equal(stepState("config", f({ workspaceCount: 1, configuredWorkspaceCount: 1 }), {}), "done");
  assert.equal(stepState("config", f({ configuredWorkspaceCount: null }), {}), "empty");
});

test("ready is done when every required item is seen, else empty", () => {
  assert.equal(stepState("ready", complete, {}), "done");
  assert.equal(stepState("ready", { ...complete, aiReady: false }, {}), "empty");
  assert.equal(stepState("ready", blank, { ready: "t" }), "empty");
});

test("state words: never colour alone", () => {
  assert.equal(stateWord("done"), "Done");
  assert.equal(stateWord("skipped"), "Skipped");
  assert.equal(stateWord("needs"), "Needs you");
  assert.equal(stateWord("empty"), null);
});

// ── Required set ─────────────────────────────────────────────────────────

// 1.175.0 Y3: no projects because the list couldn't be used this launch is
// "not known", never "none yet" — for both kinds, and while the launch is
// still asking. With a project in the list, and on a real first run, the
// count is the count.
test("an empty project list in trouble this launch is an unknown count", () => {
  for (const trouble of ["pending", "setAside", "refused"] as const) {
    assert.equal(setupWorkspaceCount(true, 0, trouble), null, trouble);
    assert.equal(setupWorkspaceCount(true, 2, trouble), 2, trouble);
    assert.equal(setupWorkspaceCount(false, 0, trouble), null, trouble);
  }
  assert.equal(setupWorkspaceCount(true, 0, null), 0, "a real first run");
  assert.equal(setupWorkspaceCount(true, 3, null), 3);
  assert.equal(setupWorkspaceCount(false, 3, null), null, "not read yet");
  // What the unknown count does: no Finish row, and "project" isn't missing.
  const troubled = { ...blank, gitWorks: true, gitIdentity: true, aiReady: true, workspaceCount: setupWorkspaceCount(true, 0, "refused") };
  assert.deepEqual(missingRequired(troubled), []);
  assert.equal(finishRow(troubled, {}, false, { aiInstalled: true }), null);
  const firstRun = { ...troubled, workspaceCount: setupWorkspaceCount(true, 0, null) };
  assert.deepEqual(missingRequired(firstRun), ["project"]);
  assert.equal(finishRow(firstRun, {}, false, { aiInstalled: true })?.text, "Setup isn't finished");
  // With something else missing too, the row still waits: the list's own
  // notice speaks first, and Finish would open on a project that can't be added.
  assert.equal(finishRow({ ...troubled, aiReady: false }, {}, false, { aiInstalled: false }), null);
});

test("missingRequired names what is seen missing, never what is unknown", () => {
  assert.deepEqual(missingRequired(blank), ["git", "identity", "ai", "project"]);
  assert.deepEqual(missingRequired(complete), []);
  assert.deepEqual(
    missingRequired(f({ gitWorks: null, gitIdentity: null, aiReady: null, workspaceCount: 1, configuredWorkspaceCount: 1 })),
    [],
  );
  // A workspace without a config is not a project yet.
  assert.deepEqual(
    missingRequired({ ...complete, configuredWorkspaceCount: 0 }),
    ["project"],
  );
  assert.equal(requiredComplete(complete), true);
  assert.equal(requiredComplete({ ...complete, gitIdentity: null }), false);
});

test("the Finish row's step is the first required one not done", () => {
  assert.equal(firstMissingRequiredStep(deriveSteps(blank, {})), "ai");
  assert.equal(firstMissingRequiredStep(deriveSteps({ ...complete, aiReady: true, gitWorks: false }, {})), "git");
  assert.equal(firstMissingRequiredStep(deriveSteps(complete, {})), null);
  // A skipped required step still counts as missing.
  assert.equal(firstMissingRequiredStep(deriveSteps(blank, { ai: "t" })), "ai");
});

// ── OB-15: the required set outside Setup (§4, §9) ──────────────────────

test("a project is unknown, not missing, while the config list is unread", () => {
  assert.deepEqual(missingRequired({ ...complete, configuredWorkspaceCount: null }), []);
  assert.equal(requiredComplete({ ...complete, configuredWorkspaceCount: null }), false);
  // No workspace at all is known missing, list or no list.
  assert.deepEqual(missingRequired({ ...complete, workspaceCount: 0, configuredWorkspaceCount: null }), ["project"]);
});

test("the required set is exactly git, identity, ai and project", () => {
  assert.deepEqual([...REQUIRED_IDS], ["git", "identity", "ai", "project"]);
  const required = new Set(SETUP_STEPS.flatMap((s) => s.required));
  assert.deepEqual([...required].sort(), ["ai", "git", "identity", "project"]);
  // GitHub, team, the folder: optional (§4 "Everything else … is optional").
  for (const id of ["github", "team", "folder", "welcome", "mode", "ready"] as const) {
    assert.deepEqual(SETUP_STEPS.find((s) => s.id === id)!.required, [], id);
  }
  // Optional facts missing never make anything required missing.
  assert.deepEqual(
    missingRequired({ ...complete, githubSignedIn: false, teamJoined: false, projectsFolderChosen: false, level: null }),
    [],
  );
});

test("Finish lands on the first step with something known missing", () => {
  // AI unknown, the project missing: not the AI step.
  const steps = deriveSteps({ ...complete, aiReady: null, workspaceCount: 0, configuredWorkspaceCount: 0 }, {});
  assert.equal(firstMissingRequiredStep(steps, ["project"]), "project");
  // A workspace without a config: Project settings, not First project.
  const cfg = deriveSteps({ ...complete, configuredWorkspaceCount: 0 }, {});
  assert.equal(firstMissingRequiredStep(cfg, ["project"]), "config");
  // Identity is the Git step's.
  assert.equal(firstMissingRequiredStep(deriveSteps({ ...complete, gitIdentity: false }, {}), ["identity"]), "git");
});

const noWords = { aiInstalled: false };

test("the Finish row shows while something required is missing and Setup is closed", () => {
  assert.equal(finishRow(complete, {}, false, noWords), null);
  const row = finishRow(f({ gitWorks: true, gitIdentity: true, aiReady: false }), { ai: "t" }, false, noWords)!;
  assert.equal(row.text, "Setup isn't finished");
  assert.equal(row.action, "Finish");
  assert.equal(row.step, "ai");
  assert.equal(row.title, "Still to do: install an AI tool, add a first project.");
  // Setup open: the row waits.
  assert.equal(finishRow(blank, {}, true, noWords), null);
  // Configs not read yet: whether Setup was finished can't be told, so the
  // doctor's rows speak (no Finish row even with a tool missing).
  assert.equal(finishRow({ ...complete, aiReady: false, configuredWorkspaceCount: null }, { ai: "t" }, false, noWords), null);
  // The workspace list not read yet (launch, or a failed read): an empty
  // list is not "no project", so nothing is said.
  const unread = { ...complete, workspaceCount: null, configuredWorkspaceCount: null };
  assert.deepEqual(missingRequired(unread), []);
  assert.deepEqual(missingRequired({ ...unread, configuredWorkspaceCount: 0 }), []);
  assert.equal(finishRow(unread, {}, false, noWords), null);
  assert.equal(finishRow({ ...unread, gitIdentity: false }, {}, false, noWords), null);
  assert.equal(requiredItems(unread, noWords)[3].state, "unknown");
  assert.equal(stepState("project", unread, {}), "empty");
  // Nothing known yet: nothing said.
  assert.equal(
    finishRow({ ...complete, gitWorks: null, gitIdentity: null, aiReady: null, configuredWorkspaceCount: null }, {}, false, noWords),
    null,
  );
});

test("the Finish row names what is left in words", () => {
  const facts = { ...complete, aiReady: false, workspaceCount: 0, configuredWorkspaceCount: 0 };
  assert.equal(
    finishRow(facts, { ai: "t" }, false, { aiInstalled: true })!.title,
    "Still to do: sign in to an AI tool, add a first project.",
  );
  assert.equal(
    finishRow({ ...complete, gitWorks: false, gitIdentity: false }, { git: "t" }, false, noWords)!.title,
    "Still to do: install Git, give Git your name and email.",
  );
  assert.equal(
    finishRow({ ...complete, configuredWorkspaceCount: 0 }, {}, false, noWords)!.title,
    "Still to do: set up your project's builds.",
  );
});

test("after Setup was finished, a lost tool is the doctor's row, not Finish", () => {
  // A set-up project, git uninstalled later, its step never skipped.
  assert.equal(finishRow({ ...complete, gitWorks: false }, {}, false, noWords), null);
  assert.equal(finishRow({ ...complete, aiReady: false }, {}, false, noWords), null);
  // …but a skipped AI step is Setup not finished.
  assert.equal(finishRow({ ...complete, aiReady: false }, { ai: "t" }, false, noWords)!.step, "ai");
  // A name and email is never the doctor's row: always Finish.
  assert.equal(finishRow({ ...complete, gitIdentity: false }, {}, false, noWords)!.step, "git");
  // No project yet: Finish folds the doctor's facts in.
  assert.equal(finishRow({ ...complete, gitWorks: false, workspaceCount: 0 }, {}, false, noWords)!.step, "git");
});

test("the Setup page's items and summary", () => {
  const items = requiredItems(f({ gitWorks: true, gitIdentity: false, aiReady: null, workspaceCount: 1, configuredWorkspaceCount: 0 }), noWords);
  assert.deepEqual(
    items.map((i) => [i.id, i.label, i.state, i.words, i.step]),
    [
      ["git", "Git", "done", "Works", "git"],
      ["identity", "Your name and email", "missing", "Not set", "git"],
      ["ai", "An AI tool", "unknown", "Not checked yet", "ai"],
      ["project", "A first project", "missing", "Not set up for builds", "config"],
    ],
  );
  assert.equal(stillToDo(items), "Still to do: give Git your name and email, set up your project's builds.");
  assert.equal(stillToDo(requiredItems(complete, noWords)), "");
  assert.equal(setupSummary(deriveSteps(complete, {}), complete), "Done.");
  const partial = f({ level: "guided", workModeChosen: true, gitWorks: true, gitIdentity: true });
  // F2: Solo or team is not in the list, so its answer is not a step done.
  assert.equal(setupSummary(deriveSteps(partial, {}), partial), "2 of 8 steps done.");
  assert.equal(requiredItems(f({ aiReady: false }), { aiInstalled: true })[2].words, "Not signed in");
});

test("setupFactsFrom builds the same facts Setup builds", () => {
  const facts = setupFactsFrom({
    report: { tools: [{ id: "git", found: true }], aiReady: true, gitIdentity: { name: "A", email: "a@b" } },
    userEmail: null,
    level: "fast",
    chosenMode: null,
    followedMode: "team",
    teamJoined: true,
    projectsFolder: "~/Projects",
    workspaceCount: 2,
    configuredWorkspaceCount: 1,
  });
  assert.deepEqual(facts, {
    gitWorks: true,
    gitIdentity: true,
    aiReady: true,
    githubSignedIn: null,
    level: "fast",
    workMode: "team",
    workModeChosen: false,
    teamJoined: true,
    projectsFolderChosen: true,
    workspaceCount: 2,
    configuredWorkspaceCount: 1,
  });
  assert.equal(setupFactsFrom({ ...{ report: null, userEmail: null, level: null, chosenMode: "solo", followedMode: "team", teamJoined: false, projectsFolder: null, workspaceCount: 0, configuredWorkspaceCount: null } }).workMode, "team", "U6: forced by a GitHub Issues board: what is in force");
});

// ── Progress ─────────────────────────────────────────────────────────────

test("progress counts done and skipped over the applicable steps", () => {
  assert.deepEqual(progress(deriveSteps(complete, {})), { settled: 9, total: 9, percent: 100 });
  const solo = deriveSteps(f({ level: "guided", workModeChosen: true }), { ai: "t" });
  // F2: Solo or team and the folder are not in the list.
  assert.deepEqual(progress(solo), { settled: 2, total: 8, percent: 25 });
  assert.deepEqual(progress([]), { settled: 0, total: 0, percent: 0 });
});

// SP-7: the bar has its count in words beside it.
test("the caption beside the bar says how many are done", () => {
  assert.equal(progressCaption(deriveSteps(complete, {})), "9 of 9 done");
  const solo = deriveSteps(f({ level: "guided", workModeChosen: true }), { ai: "t" });
  assert.equal(progressCaption(solo), "2 of 8 done or skipped");
  assert.equal(progressCaption(deriveSteps(f({ level: "guided", workModeChosen: true }), {})), `${progress(deriveSteps(f({ level: "guided", workModeChosen: true }), {})).settled} of 8 done`);
});

// ── When Setup opens, and where ──────────────────────────────────────────

test("a fresh install opens as a first run", () => {
  assert.equal(launchCase({ firstRunCompletedAt: null }), "firstRun");
  assert.equal(launchCase(undefined), "firstRun");
});

test("an existing user without setupVersion sees it once", () => {
  assert.equal(launchCase({ firstRunCompletedAt: "2026-01-01T00:00:00Z" }), "existing");
  assert.equal(launchCase({ firstRunCompletedAt: "2026-01-01T00:00:00Z", setupVersion: null }), "existing");
});

test("closed (stamped) never reopens on launch, even with required missing", () => {
  assert.equal(launchCase({ firstRunCompletedAt: null, setupVersion: SETUP_VERSION }), null);
  assert.equal(launchCase({ firstRunCompletedAt: "x", setupVersion: SETUP_VERSION + 1 }), null);
  // 1.178.0 (A3, D6): an older stamp (Setup 1) doesn't reopen Setup either —
  // its only new step, the Plyloft account, is optional.
  assert.equal(launchCase({ firstRunCompletedAt: "x", setupVersion: SETUP_VERSION - 1 }), null);
  assert.equal(launchCase({ firstRunCompletedAt: null, setupVersion: 1 }), null);
  // A malformed 0 reads as never seen.
  assert.equal(launchCase({ firstRunCompletedAt: "x", setupVersion: 0 }), "existing");
});

test("A3 (D6): a Mac that saw Setup 1 is stamped without opening; SETUP_VERSION stays 2", () => {
  assert.equal(SETUP_VERSION, 2);
  assert.equal(stampsWithoutOpening({ firstRunCompletedAt: "x", setupVersion: 1 }), true);
  assert.equal(stampsWithoutOpening({ firstRunCompletedAt: null, setupVersion: SETUP_VERSION - 1 }), true);
  // Already this Setup's stamp, a later one, or none at all: nothing to stamp.
  assert.equal(stampsWithoutOpening({ firstRunCompletedAt: "x", setupVersion: SETUP_VERSION }), false);
  assert.equal(stampsWithoutOpening({ firstRunCompletedAt: "x", setupVersion: SETUP_VERSION + 1 }), false);
  assert.equal(stampsWithoutOpening({ firstRunCompletedAt: "x" }), false);
  assert.equal(stampsWithoutOpening({ firstRunCompletedAt: "x", setupVersion: 0 }), false);
  assert.equal(stampsWithoutOpening(undefined), false);
  // The three cases left have their own header; none names a new step.
  for (const c of ["firstRun", "existing", "rerun"] as const) {
    assert.doesNotMatch(headerCopy(c).title, /new step/i);
  }
});

test("A3: the account step is done when signed in, never needs you, skipped when passed, quiet while unread", () => {
  assert.equal(stepState("account", f({ plyloftSignedIn: true }), {}), "done");
  // Optional: signed out is nothing to say, never "Needs you".
  assert.equal(stepState("account", f({ plyloftSignedIn: false }), {}), "empty");
  assert.equal(stepState("account", f({ plyloftSignedIn: null }), {}), "empty");
  assert.equal(stepState("account", f({}), {}), "empty");
  // Continue without an account records the skip: Skipped.
  assert.equal(stepState("account", f({ plyloftSignedIn: false }), { account: "t" }), "skipped");
  // Signed in later: done wins over the old skip.
  assert.equal(stepState("account", f({ plyloftSignedIn: true }), { account: "t" }), "done");
  // Not a §4 item: the Finish row and the required set are unchanged.
  assert.deepEqual(missingRequired(f({ plyloftSignedIn: false, gitWorks: true, gitIdentity: true, aiReady: true, workspaceCount: 1, configuredWorkspaceCount: 1 })), []);
  // An existing user signed out is offered it first (after a done Welcome)…
  const steps = deriveSteps(f({ level: "fast", plyloftSignedIn: false }), {});
  assert.equal(firstOpenStep(steps), "account");
  // …and once passed with Continue it is settled: Setup can finish without it.
  const passed = deriveSteps(f({ level: "fast", plyloftSignedIn: false }), { account: "t" });
  assert.notEqual(firstOpenStep(passed), "account");
  assert.equal(requiredComplete(f({ plyloftSignedIn: false })), requiredComplete(f({ plyloftSignedIn: true })));
  // setupFactsFrom carries it only when the surface read it.
  const src = { report: null, userEmail: null, level: null, chosenMode: null, followedMode: null, teamJoined: false, projectsFolder: null, workspaceCount: 0, configuredWorkspaceCount: null };
  assert.equal(setupFactsFrom(src).plyloftSignedIn, undefined);
  assert.equal(setupFactsFrom({ ...src, plyloftSignedIn: true }).plyloftSignedIn, true);
});

test("the automatic open is on (OB-17), and tests can force it", () => {
  assert.equal(SETUP_AUTO_OPEN, true);
  assert.equal(setupAutoOpens(), true);
  setSetupAutoOpenForTests(false);
  assert.equal(setupAutoOpens(), false);
  setSetupAutoOpenForTests(null);
  assert.equal(setupAutoOpens(), SETUP_AUTO_OPEN);
});

test("first run starts at step 1", () => {
  assert.equal(startStep("firstRun", null, deriveSteps(blank, {})), "welcome");
  // …even when the doctor already sees git and an AI.
  assert.equal(startStep("firstRun", undefined, deriveSteps(f({ gitWorks: true, aiReady: true }), {})), "welcome");
});

test("quit mid-setup resumes on currentStep", () => {
  assert.equal(startStep("firstRun", "github", deriveSteps(blank, {})), "github");
  assert.equal(startStep("existing", "config", deriveSteps(complete, {})), "config");
  // An unknown id is ignored.
  assert.equal(startStep("firstRun", "gone", deriveSteps(blank, {})), "welcome");
  // A solo person stored on Team resumes on the next shown step.
  assert.equal(startStep("firstRun", "team", deriveSteps(blank, {})), "project");
  assert.equal(applicableOrNext(deriveSteps(blank, {}), "ready"), "ready");
});

test("existing user, first time: detected steps done, the first not-done selected", () => {
  const existing = f({
    gitWorks: true,
    gitIdentity: true,
    aiReady: true,
    level: "fast",
    workModeChosen: true,
    workspaceCount: 3,
    configuredWorkspaceCount: 2,
    plyloftSignedIn: true,
  });
  const steps = deriveSteps(existing, {});
  assert.deepEqual(
    steps.map((s) => [s.id, s.state]),
    [
      ["welcome", "done"],
      ["account", "done"],
      ["github", "empty"],
      ["ai", "done"],
      ["git", "done"],
      ["project", "done"],
      ["config", "done"],
      ["ready", "done"],
    ],
  );
  assert.equal(startStep("existing", null, steps), "github");
  // With no level yet, step 1 is the first shown (§5 step 1, edge case).
  assert.equal(startStep("existing", null, deriveSteps({ ...existing, level: null }, {})), "welcome");
  // Everything settled: Ready.
  assert.equal(firstOpenStep(deriveSteps(complete, {})), "ready");
});

test("a rerun after a finished Setup re-detects; one closed before Ready resumes where it stopped", () => {
  // Finished (closed on Ready), or nothing stored: the first step not settled.
  assert.equal(startStep("rerun", "ready", deriveSteps(complete, {})), "ready");
  assert.equal(startStep("rerun", null, deriveSteps({ ...complete, aiReady: false }, {})), "ai");
  assert.equal(startStep("rerun", "ready", deriveSteps({ ...complete, aiReady: false }, {})), "ai");
  // Walk 1.4 / 2.7 (immediacy, 2026-11-10): closed at step 4, reopened from
  // ⌘K "Open setup" — it opens where it was closed, done or not.
  const steps = deriveSteps(f({ plyloftSignedIn: true, githubSignedIn: true, aiReady: true }), {});
  assert.equal(startStep("rerun", "ai", steps), "ai");
  assert.equal(startStep("rerun", "github", steps), "github");
  assert.equal(resumePoint("ai", steps), "ai");
  assert.equal(resumePoint("ready", steps), null);
  assert.equal(resumePoint("no-such-step", steps), null);
  // A stored step this list no longer shows: the next one it does.
  assert.equal(startStep("rerun", "team", steps), applicableOrNext(steps, "team"));
});

test("Finish opens Setup where it stopped while Setup was closed before Ready", () => {
  const facts = f({ plyloftSignedIn: true, githubSignedIn: true, aiReady: true });
  const noWords = { aiInstalled: true };
  const first = finishRow(facts, {}, false, noWords)!;
  // Nothing stored, or Setup finished: the first step with something missing.
  assert.equal(finishRow(facts, {}, false, noWords, "ready")!.step, first.step);
  // Closed at "Your AI": Finish goes back there (its title: "Open Setup where it stopped").
  assert.equal(finishRow(facts, {}, false, noWords, "ai")!.step, "ai");
  // Review: a required step missing *before* the stored one comes first —
  // closed at the project step while Git is missing, Finish opens on Git.
  const noGit = f({ plyloftSignedIn: true, githubSignedIn: true, aiReady: true, gitWorks: false });
  const firstMissing = finishRow(noGit, {}, false, noWords)!.step;
  assert.equal(firstMissing, "git");
  assert.equal(finishRow(noGit, {}, false, noWords, "project")!.step, "git");
  // The stored step before the first missing one: the stored step.
  assert.equal(finishRow(noGit, {}, false, noWords, "ai")!.step, "ai");
});

test("closing stamps setupVersion and keeps the resume point and the first-run stamp", () => {
  const out = closedOnboarding({ firstRunCompletedAt: null, level: "guided" }, "ai", "2026-09-27T12:00:00Z");
  assert.deepEqual(out, {
    firstRunCompletedAt: "2026-09-27T12:00:00Z",
    level: "guided",
    setupVersion: SETUP_VERSION,
    currentStep: "ai",
  });
  const kept = closedOnboarding({ firstRunCompletedAt: "2026-01-01T00:00:00Z" }, "ready", "now");
  assert.equal(kept.firstRunCompletedAt, "2026-01-01T00:00:00Z");
  assert.equal(launchCase(kept), null);
});

// ── Copy ─────────────────────────────────────────────────────────────────

test("the header says Plyloft for each case (§5.0)", () => {
  assert.equal(headerCopy("firstRun").title, "Set up Plyloft");
  assert.equal(headerCopy("existing").title, "Plyloft can now set itself up");
  assert.equal(headerCopy("rerun").title, "Setup");
  assert.match(headerCopy("rerun").sentence, /Plyloft needs/);
  for (const c of ["firstRun", "existing", "rerun"] as const) {
    const { title, sentence } = headerCopy(c);
    assert.doesNotMatch(`${title} ${sentence}`, /\bPly\b|!/);
  }
});

test("the level link offers the other path", () => {
  assert.deepEqual(levelSwitch("guided"), { label: "Switch to just the essentials", to: "fast" });
  assert.deepEqual(levelSwitch(null), { label: "Switch to just the essentials", to: "fast" });
  assert.deepEqual(levelSwitch("fast"), { label: "Switch to step by step", to: "guided" });
});

test("solo is refused while a workspace uses a GitHub Issues board", () => {
  assert.equal(soloRefusal([{ id: "a", name: "lyra", kanbanSyncMode: "local" }, { id: "b", name: "x" }]), null);
  const r = soloRefusal([
    { id: "a", name: "lyra", kanbanSyncMode: "local" },
    { id: "b", name: "Atelier", kanbanSyncMode: "githubIssues" },
  ]);
  assert.deepEqual(r, {
    workspaceId: "b",
    name: "Atelier",
    sentence:
      "“Atelier” uses a GitHub Issues board, which is a team feature. Switch its board to Local first, or keep team on.",
  });
});

test("the detected-team line names the team", () => {
  assert.equal(detectedTeamLine("MB Adv"), "Plyloft found a team on this Mac: “MB Adv”.");
  assert.equal(detectedTeamLine("  "), null);
  assert.equal(detectedTeamLine(null), null);
});

// ── Doctor facts (today's report, and OB-2's fields when they land) ──────

const tool = (id: string, found: boolean, extra: Record<string, unknown> = {}) => ({ id, found, versionOk: found, ...extra });

test("today's report: git found, an AI installed, identity from the cached email", () => {
  const report = { tools: [tool("git", true), tool("claude", false), tool("codex", true), tool("gh", true)] };
  assert.deepEqual(doctorFacts(report, "me@example.com"), {
    gitWorks: true,
    gitIdentity: true,
    aiReady: true,
    githubSignedIn: null,
  });
  // Codex-only counts: one AI is enough.
  assert.equal(doctorFacts({ tools: [tool("claude", false), tool("codex", true)] }, null).aiReady, true);
  // A too-old Claude alone is not ready.
  assert.equal(
    doctorFacts({ tools: [tool("claude", true, { versionOk: false }), tool("codex", false)] }, null).aiReady,
    false,
  );
  // Nothing installed.
  const none = doctorFacts({ tools: [tool("git", false), tool("claude", false), tool("codex", false)] }, null);
  assert.equal(none.gitWorks, false);
  assert.equal(none.aiReady, false);
  // No email cached: the identity is not known yet (not "missing").
  assert.equal(none.gitIdentity, null);
});

test("no report yet: nothing is known but the cached email", () => {
  assert.deepEqual(doctorFacts(null, null), { gitWorks: null, gitIdentity: null, aiReady: null, githubSignedIn: null });
  assert.equal(doctorFacts(null, "me@example.com").gitIdentity, true);
});

test("gh's sign-in is read only when the report carries it", () => {
  assert.equal(doctorFacts({ tools: [tool("gh", true, { auth: { signedIn: true } })] }, null).githubSignedIn, true);
  assert.equal(doctorFacts({ tools: [tool("gh", true, { auth: { signedIn: false } })] }, null).githubSignedIn, false);
  assert.equal(doctorFacts({ tools: [tool("gh", true, { auth: { signedIn: null } })] }, null).githubSignedIn, null);
});

test("OB-2's fields win over today's fallbacks when present", () => {
  const report = {
    tools: [tool("git", true), tool("claude", true)],
    aiReady: false,
    gitWorks: false,
    gitIdentity: { name: "Ada", email: null },
  };
  assert.deepEqual(doctorFacts(report, "me@example.com"), {
    gitWorks: false,
    gitIdentity: false,
    aiReady: false,
    githubSignedIn: null,
  });
  assert.equal(doctorFacts({ tools: [], gitIdentity: true }, null).gitIdentity, true);
  assert.equal(doctorFacts({ tools: [], gitIdentity: { name: "Ada", email: "a@b" } }, null).gitIdentity, true);
});

test("OB-5: inside the AI step its own reads decide the step (D2, D4)", () => {
  // The doctor saw a Claude credential; the step's `claude auth status`
  // says signed out: the step needs you.
  const doctorSaid = f({ aiReady: true });
  assert.equal(stepState("ai", withAiObserved(doctorSaid, false), {}), "needs");
  // Signed in, seen by the step, over a doctor that saw no credential.
  assert.equal(stepState("ai", withAiObserved(f({ aiReady: false }), true), {}), "done");
  // No answer from the step yet: the doctor's stands.
  assert.equal(withAiObserved(doctorSaid, null), doctorSaid);
  assert.equal(stepState("ai", withAiObserved(doctorSaid, null), {}), "done");
});

test("OB-7a: the GitHub step's read decides step 5; skipped otherwise", () => {
  assert.equal(stepState("github", withGithubObserved(f({}), true), {}), "done");
  // Not signed in: optional, so nothing to say — or Skipped.
  assert.equal(stepState("github", withGithubObserved(f({}), false), {}), "empty");
  assert.equal(stepState("github", withGithubObserved(f({}), false), { github: "2026-09-28T00:00:00Z" }), "skipped");
  // Done wins over an earlier skip.
  assert.equal(stepState("github", withGithubObserved(f({}), true), { github: "2026-09-28T00:00:00Z" }), "done");
  const doctorSaid = f({ githubSignedIn: true });
  assert.equal(withGithubObserved(doctorSaid, null), doctorSaid);
});

test("OB-7a: leaving the step that started a run asks; any other step doesn't", () => {
  // Seen starting: the step it started from.
  assert.equal(guardedRun("install.git", "ai", "ai"), "install.git");
  assert.equal(guardedRun("install.git", "ai", "git"), null);
  assert.equal(guardedRun("install.git", "git", "git"), "install.git");
  assert.equal(guardedRun("login.gh", "github", "github"), "login.gh");
  assert.equal(guardedRun("login.gh", "github", "ai"), null);
  // Under way when Setup opened: the action's own step.
  assert.equal(guardedRun("add-account.gh", null, "github"), "add-account.gh");
  assert.equal(guardedRun("install.git", null, "git"), "install.git");
  assert.equal(guardedRun("install.claude", null, "ai"), "install.claude");
  assert.equal(guardedRun("install.claude", null, "github"), null);
  // Nothing running, or the checklist on screen.
  assert.equal(guardedRun(null, "ai", "ai"), null);
  assert.equal(guardedRun("login.gh", "github", null), null);
  for (const id of ["install.gh", "update.gh", "login.gh", "add-account.gh", "setupgit.gh", "refresh.gh"]) {
    assert.equal(stepOfAction(id), "github", id);
  }
  assert.equal(stepOfAction("login.codex"), "ai");
});


// ── OB-12: step 8's success is a repo with a commit on its target branch ──

test("first project: a workspace counts only once Setup sees a commit on its target branch", () => {
  // Setup's own read (project_inspect) decides where it was made.
  assert.equal(stepState("project", f({ workspaceCount: 1, projectRepoReady: true }), {}), "done");
  assert.equal(stepState("project", f({ workspaceCount: 1, projectRepoReady: false }), {}), "needs");
  // Still reading: nothing to say yet.
  assert.equal(stepState("project", f({ workspaceCount: 1, projectRepoReady: null }), {}), "empty");
  // Not read (the sidebar, Settings): a workspace counts as before.
  assert.equal(stepState("project", f({ workspaceCount: 1 }), {}), "done");
  assert.equal(stepState("project", f({ workspaceCount: 0, projectRepoReady: true }), {}), "needs");
});

test("a workspace with no commit is missing `project`, and its Fix is First project", () => {
  const noCommit: SetupFacts = { ...complete, projectRepoReady: false };
  assert.deepEqual(missingRequired(noCommit), ["project"]);
  assert.equal(requiredComplete(noCommit), false);
  assert.equal(requiredComplete({ ...complete, projectRepoReady: true }), true);
  assert.equal(requiredComplete({ ...complete, projectRepoReady: null }), false);
  // Unknown is not missing.
  assert.deepEqual(missingRequired({ ...complete, projectRepoReady: null }), []);
  const item = requiredItems(noCommit, { aiInstalled: true }).find((i) => i.id === "project")!;
  assert.equal(item.state, "missing");
  assert.equal(item.words, "No saved version yet");
  assert.equal(item.step, "project");
  assert.equal(item.todo, "save your project's first version");
  // With a commit seen, the config decides as before.
  const ready = requiredItems({ ...complete, projectRepoReady: true }, { aiInstalled: true }).find(
    (i) => i.id === "project",
  )!;
  assert.equal(ready.words, "Ready");
});

test("a clone under way is guarded on First project", () => {
  assert.equal(stepOfAction("project.clone"), "project");
  assert.equal(guardedRun("project.clone", null, "project"), "project.clone");
  assert.equal(guardedRun("project.clone", "project", "config"), null);
});

test("OB-13: step 9 is done for Setup's own workspace when it is known", () => {
  // Other projects set up, the one just added not: step 9 still asks.
  const others = f({ workspaceCount: 2, configuredWorkspaceCount: 1, activeConfigured: false });
  assert.equal(stepState("config", others, {}), "needs");
  // …while the required `project` item counts any workspace (§4).
  assert.equal(missingRequired({ ...complete, configuredWorkspaceCount: 1, activeConfigured: false }).includes("project"), false);
  assert.equal(stepState("config", f({ workspaceCount: 1, configuredWorkspaceCount: 1, activeConfigured: true }), {}), "done");
  assert.equal(stepState("config", f({ workspaceCount: 1, configuredWorkspaceCount: null, activeConfigured: null }), {}), "empty");
  // Absent (the sidebar, Settings): any configured workspace, as before.
  assert.equal(stepState("config", f({ workspaceCount: 1, configuredWorkspaceCount: 1 }), {}), "done");
});

console.log(`setupSteps: ${passed} passed`);

test("OB-6: on Windows, step 4's git includes Git Bash", () => {
  // A git without Git Bash (MinGit, Scoop) is not done; with it, it is.
  const noBash = doctorFacts({ tools: [tool("git", true), tool("git-bash", false)] }, null);
  assert.equal(noBash.gitWorks, false);
  const both = doctorFacts({ tools: [tool("git", true), tool("git-bash", true)] }, null);
  assert.equal(both.gitWorks, true);
  // The Mac has no Git Bash row.
  assert.equal(doctorFacts({ tools: [tool("git", true)] }, null).gitWorks, true);
  assert.equal(stepState("git", f({ gitWorks: noBash.gitWorks, gitIdentity: true }), {}), "needs");
});

// 1.175.0 F2 (UX-3, I4): solo or team is deduced, not asked — one case per
// row of mockup §2a's table.
test("F2: the deduction follows §2a's table, row by row", () => {
  const none = { read: true, teams: [], invitations: 0 };
  const base = { chosen: null, effective: "solo" as const, account: null, boardOnGithub: false, hint: none };
  // The account's plan is Team (owned, or a seat): team, without asking.
  assert.deepEqual(deduceWorkMode({ ...base, account: { plan: "team", teamRole: "owner" } }), { mode: "team", reason: "plan" });
  assert.deepEqual(deduceWorkMode({ ...base, account: { plan: "team", teamRole: "member" } }), { mode: "team", reason: "plan" });
  assert.equal(deduceWorkMode({ ...base, account: { plan: "team", teamRole: null } })?.mode, "solo", "Team, no role: listed by nobody");
  assert.equal(deduceWorkMode({ ...base, account: { plan: "free", teamRole: "member" } })?.mode, "solo");
  // A Plyloft team lists this GitHub account: team ("Your team" opens on Join).
  assert.deepEqual(deduceWorkMode({ ...base, hint: { read: true, teams: ["lyra/team"], invitations: 0 } }), { mode: "team", reason: "team" });
  // An invitation waits on GitHub (an invited member nobody lists yet, UX-20).
  assert.deepEqual(deduceWorkMode({ ...base, hint: { read: true, teams: [], invitations: 1 } }), { mode: "team", reason: "invitation" });
  // A project on this computer uses a GitHub Issues board: team (soloRefusal).
  assert.deepEqual(deduceWorkMode({ ...base, boardOnGithub: true }), { mode: "team", reason: "board" });
  // The mode in force is team (a team joined on this computer).
  assert.deepEqual(deduceWorkMode({ ...base, effective: "team" }), { mode: "team", reason: "team" });
  // The person already chose on this computer: what they chose stays.
  assert.deepEqual(deduceWorkMode({ ...base, chosen: "solo", effective: "team", account: { plan: "team", teamRole: "owner" } }), { mode: "solo", reason: "chosen" });
  assert.deepEqual(deduceWorkMode({ ...base, chosen: "team" }), { mode: "team", reason: "chosen" });
  // None of this: solo, without asking.
  assert.deepEqual(deduceWorkMode(base), { mode: "solo", reason: "none" });
  // GitHub couldn't be read (offline, skipped, signed out): solo as well.
  assert.deepEqual(deduceWorkMode({ ...base, hint: { read: false, teams: ["lyra/team"], invitations: 2 } }), { mode: "solo", reason: "none" });
  // GitHub's answer not in yet, and nothing else decides: no answer, nothing saved.
  assert.equal(deduceWorkMode({ ...base, hint: null }), null);
  assert.deepEqual(deduceWorkMode({ ...base, hint: null, account: { plan: "team", teamRole: "owner" } }), { mode: "team", reason: "plan" }, "the plan doesn't wait for GitHub");
});

// F2 round 2 (review): only a team is saved, and not from an invitation
// alone; solo is never saved by the deduction.
test("F2 round 2: which deductions are saved", () => {
  assert.equal(deductionSaves({ mode: "solo", reason: "none" }), false, "a saved solo would outrank a later team");
  assert.equal(deductionSaves({ mode: "team", reason: "plan" }), true);
  assert.equal(deductionSaves({ mode: "team", reason: "team" }), true);
  assert.equal(deductionSaves({ mode: "team", reason: "board" }), true);
  assert.equal(deductionSaves({ mode: "team", reason: "invitation" }), false, "saved when the person joins");
  assert.equal(deductionSaves({ mode: "solo", reason: "chosen" }), false, "a choice is saved already");
  assert.equal(deductionSaves(null), false);
});

test("F2: the link under the list, and the question's sentence when asked for", () => {
  assert.deepEqual(TEAM_STEP_LINK, { lead: "Joining a team?", label: "Add the team step" });
  assert.equal(teamStepLinkShown("solo", false), true);
  assert.equal(teamStepLinkShown("solo", true), false, "the question is in the list already");
  assert.equal(teamStepLinkShown("team", false), false, "Your team is in the list");
  assert.equal(
    modeAskedWhy("octocat"),
    "Plyloft found no team for octocat, so it set you up on your own. You can change this later in Settings.",
  );
  assert.equal(
    modeAskedWhy(null),
    "Plyloft found no team for this account, so it set you up on your own. You can change this later in Settings.",
  );
});

// The question, when asked for: With a team puts Your team in the list.
{
  // 1.174.3: the list follows With a team while no mode has been chosen.
  assert.equal(workModeInList("solo", "mode", "team", false, false), "team");
  assert.equal(workModeInList("solo", "team", "team", false, false), "team", "the row stays while they stand on it");
  assert.equal(workModeInList("solo", "ai", "team", false, false), "team", "a later row doesn't shift the count");
  assert.equal(workModeInList("solo", "mode", null, false, false), "solo");
  assert.equal(workModeInList("solo", "mode", "solo", false, false), "solo");
  // A saved solo with With a team pressed: step 3, Your team and the save only.
  assert.equal(workModeInList("solo", "mode", "team", false, true), "team");
  assert.equal(workModeInList("solo", "team", "team", false, true), "team");
  assert.equal(workModeInList("solo", "ai", "team", false, true), "solo", "left without Continue");
  assert.equal(workModeInList("solo", "ai", "team", true, true), "team", "Continue's save is under way");
  assert.equal(workModeInList("team", "mode", "solo", false, true), "team", "Your team stays until Continue saves solo");
}

// 1.176.1 walk: with Program folders set, Setup's rows say where the tool
// wasn't found, never "Not installed".
{
  const items = requiredItems(f({ gitWorks: false, aiReady: false }), { aiInstalled: false, programFolders: true });
  assert.equal(items.find((i) => i.id === "git")?.words, "Not in your Program folders");
  assert.equal(items.find((i) => i.id === "ai")?.words, "Not in your Program folders");
}

// 1.176.4 (setup lane, item 1): Ready's last screen with something left.
{
  const done = requiredItems(
    f({ gitWorks: true, gitIdentity: true, aiReady: true, workspaceCount: 1, configuredWorkspaceCount: 1, projectRepoReady: true }),
    { aiInstalled: true },
  );
  assert.equal(readyUnfinished(done), null, "nothing missing: the screen stays as it was");
  const none = requiredItems(f({ gitWorks: false, gitIdentity: false, aiReady: false, workspaceCount: 0 }), { aiInstalled: false });
  const view = readyUnfinished(none);
  assert.equal(view?.title, "Setup isn't finished");
  assert.match(view?.text ?? "", /AI tool/);
  assert.match(view?.text ?? "", /Git/);
  assert.match(view?.text ?? "", /project/);
  const onlyAi = readyUnfinished(
    requiredItems(f({ gitWorks: true, gitIdentity: true, aiReady: false, workspaceCount: 1, configuredWorkspaceCount: 1, projectRepoReady: true }), { aiInstalled: false }),
  );
  assert.doesNotMatch(onlyAi?.text ?? "", /Git|project/);
  const ready = { aiReady: true, gitWorks: true, gitIdentity: true, workspaceCount: 1, configuredWorkspaceCount: 1, projectRepoReady: true } as const;
  const tour = (over: Partial<SetupFacts>) => {
    const facts = f({ ...ready, ...over });
    return tourOffered(facts, requiredItems(facts, { aiInstalled: true }));
  };
  assert.equal(tour({}), true);
  assert.equal(tour({ aiReady: false }), false, "no AI tool");
  assert.equal(tour({ aiReady: null }), false, "AI not known");
  assert.equal(tour({ workspaceCount: 0 }), false, "no project");
  assert.equal(tour({ projectRepoReady: false }), false, "a workspace with no saved version is no project");
  assert.equal(tour({ configuredWorkspaceCount: 0 }), true, "only its settings are missing: the press saves them");
}

// 1.176.4 (e): skipping AI or Git says what won't work.
{
  assert.match(skipConsequence("ai", null) ?? "", /AI tool/);
  assert.match(skipConsequence("git", false) ?? "", /own copy/);
  assert.match(skipConsequence("git", true) ?? "", /name and email/);
  assert.equal(skipConsequence("project", null), null);
}

// 1.176.4 (R2-S1): a project whose only gap is its build settings isn't "no project ready".
{
  const only = requiredItems(
    f({ gitWorks: true, gitIdentity: true, aiReady: true, workspaceCount: 1, configuredWorkspaceCount: 0, projectRepoReady: true }),
    { aiInstalled: true },
  );
  assert.equal(readyUnfinished(only), null, "the normal Ready");
  const withAi = requiredItems(
    f({ gitWorks: true, gitIdentity: true, aiReady: false, workspaceCount: 1, configuredWorkspaceCount: 0, projectRepoReady: true }),
    { aiInstalled: false },
  );
  assert.doesNotMatch(readyUnfinished(withAi)?.text ?? "", /project/);
}
