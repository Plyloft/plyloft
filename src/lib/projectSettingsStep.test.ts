// OB-13: Setup's step 9 words, pure (ONBOARDING_SPEC §5 step 9). Run with:
//
//     node --experimental-strip-types src/lib/projectSettingsStep.test.ts
import assert from "node:assert/strict";
import type { ProjectConfig, SetupConfigView } from "../ipc.ts";
import {
  CHANGE_MORE,
  LEDE_PROPOSAL,
  LEDE_SHARED,
  NOTHING_AFTER,
  NO_CHECKS,
  NO_VERSION,
  afterShippingFact,
  autoSetUpConfig,
  branchFact,
  branchOptions,
  checklistHint,
  checksFact,
  checksLabel,
  checksOffer,
  detailLines,
  draftChanged,
  draftConfig,
  patchSavedConfig,
  initialDraft,
  joinWords,
  projectFacts,
  projectSettingsTitle,
  stepScreen,
  versionFact,
} from "./projectSettingsStep.ts";

const config = (over: Partial<ProjectConfig> = {}): ProjectConfig => ({
  schemaVersion: 2,
  targetBranch: "main",
  versionFiles: [],
  installScript: null,
  verifyPipeline: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const view = (over: Partial<SetupConfigView> = {}): SetupConfigView => ({
  state: "proposal",
  config: config(),
  branches: ["main"],
  suggestedBranch: null,
  branchFrom: "head",
  head: "branch",
  headBranch: "main",
  detectedVerify: null,
  version: null,
  readOnly: false,
  ...over,
});

// ── Title and the plain words ───────────────────────────────────────────

assert.equal(projectSettingsTitle("lyra"), "How Plyloft builds “lyra”");
assert.equal(projectSettingsTitle(null), "How Plyloft builds your project");
assert.equal(joinWords([]), "");
assert.equal(joinWords(["a"]), "a");
assert.equal(joinWords(["a", "b"]), "a and b");
assert.equal(joinWords(["a", "b", "c"]), "a, b and c");

// Cards start from.
assert.equal(
  branchFact("main"),
  "main. Each card gets its own copy of main, and its result is merged back into main.",
);

// Checks before shipping: each shape, and the "none yet" sentence for none
// and for an empty pipeline (the owner's "an empty project starts with no
// checks").
assert.equal(checksFact(null), NO_CHECKS);
assert.equal(checksFact(undefined), NO_CHECKS);
assert.equal(checksFact([]), NO_CHECKS);
assert.equal(NO_CHECKS, "None yet. Cards ship without checks; you can add them later in Settings.");
assert.equal(
  checksFact([{ kind: "script", path: "scripts/verify.sh" }]),
  "scripts/verify.sh runs before a card can ship.",
);
assert.equal(
  checksFact([{ kind: "slash_command", name: "/ppvp", args: ["--staging"] }]),
  "/ppvp --staging runs before a card can ship.",
);
assert.equal(
  checksFact([{ kind: "slash_command", name: "ppvp", args: [] }]),
  "/ppvp runs before a card can ship.",
);
assert.equal(
  checksFact([
    { kind: "script", path: "scripts/test.sh" },
    { kind: "slash_command", name: "/ppvp", args: [] },
  ]),
  "scripts/test.sh, then /ppvp run before a card can ship.",
);

// Version number.
assert.equal(versionFact([], null), NO_VERSION);
assert.equal(NO_VERSION, "No version file. Plyloft won't change a version.");
assert.equal(
  versionFact([{ path: "package.json" }], "1.4.2"),
  "Kept in package.json (1.4.2). Plyloft raises it when you release.",
);
assert.equal(
  versionFact([{ path: "package.json" }, { path: "src-tauri/Cargo.toml" }], null),
  "Kept in package.json and src-tauri/Cargo.toml. Plyloft raises it when you release.",
);

// After shipping.
assert.equal(afterShippingFact(null), NOTHING_AFTER);
assert.equal(afterShippingFact("  "), NOTHING_AFTER);
assert.equal(NOTHING_AFTER, "Nothing runs.");
assert.equal(afterShippingFact("scripts/install.sh"), "scripts/install.sh runs on this Mac.");

// The four facts in order — an empty new project reads as the "none yet"
// sentences.
assert.deepEqual(projectFacts(config(), null), [
  { label: "Cards start from", value: branchFact("main") },
  { label: "Checks before shipping", value: NO_CHECKS },
  { label: "Version number", value: NO_VERSION },
  { label: "After shipping", value: NOTHING_AFTER },
]);
assert.equal(projectFacts(config({ targetBranch: "" }), null)[0].value, "Choose a branch above.");
assert.deepEqual(
  projectFacts(
    config({
      versionFiles: [{ path: "package.json", kind: "package_json" }],
      verifyPipeline: [{ kind: "script", path: "scripts/verify.sh" }],
      installScript: "scripts/install.sh",
    }),
    "1.4.2",
  ).map((f) => f.value),
  [
    branchFact("main"),
    "scripts/verify.sh runs before a card can ship.",
    "Kept in package.json (1.4.2). Plyloft raises it when you release.",
    "scripts/install.sh runs on this Mac.",
  ],
);

// Details: the fields as saved.
assert.deepEqual(detailLines(config()), [
  "Target branch: main",
  "Version files: none",
  "Checks before shipping: empty",
  "After a release, run: none",
]);

// ── Each reading's screen ───────────────────────────────────────────────

assert.deepEqual(stepScreen(view(), "lyra"), { kind: "confirm", lede: LEDE_PROPOSAL });
assert.equal(stepScreen(view({ state: "existing" }), "lyra").kind, "existing");
assert.deepEqual(stepScreen(view({ state: "shared", readOnly: true }), "lyra"), {
  kind: "shared",
  lede: LEDE_SHARED,
  waiting: false,
});
assert.equal(LEDE_SHARED, "This project's settings come from its repository.");
assert.deepEqual(stepScreen(view({ state: "shared", config: null }), "lyra"), {
  kind: "shared",
  lede: LEDE_SHARED,
  waiting: true,
});
const detachedAsk = stepScreen(view({ state: "needsBranch", head: "detached", headBranch: null }), "lyra");
assert.equal(detachedAsk.kind, "ask");
assert.equal(detachedAsk.kind === "ask" && detachedAsk.headline, "“lyra” isn't on a branch right now.");
assert.equal(
  detachedAsk.kind === "ask" && detachedAsk.sentence,
  "Cards start from a branch and are merged back into it. Which one?",
);
const unbornAsk = stepScreen(view({ state: "needsBranch", head: "unborn", headBranch: "main" }), "lyra");
assert.equal(unbornAsk.kind === "ask" && unbornAsk.headline, "“lyra” is on main, which has no saved version yet.");
assert.equal(stepScreen(view({ state: "noCommit", config: null }), "lyra").kind, "fixFirst");
assert.equal(stepScreen(view({ state: "notRepo", config: null }), "lyra").kind, "fixFirst");

// ── The Change form ─────────────────────────────────────────────────────

// Checks: the config's own pipeline first, else the detected script, else none.
const script = [{ kind: "script" as const, path: "scripts/verify.sh" }];
const slash = [{ kind: "slash_command" as const, name: "/ppvp", args: [] }];
assert.deepEqual(checksOffer(config({ verifyPipeline: slash }), script), slash);
assert.deepEqual(checksOffer(config(), script), script);
assert.equal(checksOffer(config({ verifyPipeline: [] }), null), null);
assert.equal(checksLabel(script), "Run scripts/verify.sh before a card can ship");
assert.equal(checksLabel(null), "");

// The draft starts from the config, or the ask's suggestion.
assert.deepEqual(initialDraft(view()), { branch: "main", checksOn: false });
assert.deepEqual(initialDraft(view({ config: config({ verifyPipeline: script }) })), {
  branch: "main",
  checksOn: true,
});
assert.deepEqual(
  initialDraft(view({ state: "needsBranch", config: config({ targetBranch: "" }), suggestedBranch: "master" })),
  { branch: "master", checksOn: false },
);

// What is saved: the branch and the checks the form chose, the rest as read.
const withFiles = config({
  versionFiles: [{ path: "package.json", kind: "package_json" }],
  installScript: "scripts/install.sh",
});
assert.deepEqual(draftConfig(withFiles, { branch: "dev", checksOn: true }, script), {
  ...withFiles,
  targetBranch: "dev",
  verifyPipeline: script,
});
assert.deepEqual(
  draftConfig(config({ verifyPipeline: script }), { branch: "main", checksOn: false }, script).verifyPipeline,
  null,
);
// A switch with nothing to turn on saves no checks (an empty project).
assert.equal(draftConfig(config(), { branch: "main", checksOn: true }, null).verifyPipeline, null);

assert.equal(draftChanged(config(), { branch: "main", checksOn: false }), false);
assert.equal(draftChanged(config(), { branch: "dev", checksOn: false }), true);
assert.equal(draftChanged(config(), { branch: "main", checksOn: true }), true);

assert.deepEqual(branchOptions(["main", "dev"], "main"), ["main", "dev"]);
assert.deepEqual(branchOptions(["main"], "gone"), ["gone", "main"]);
assert.deepEqual(branchOptions(["main"], ""), ["main"]);

assert.equal(CHANGE_MORE, "More settings are in Settings › Cards › Building and checking after setup.");

// ── The checklist row ───────────────────────────────────────────────────

assert.equal(checklistHint("lyra", false), "“lyra” isn't set up for builds yet");
assert.equal(checklistHint("lyra", true), "“lyra” is set up for builds");
assert.equal(checklistHint("lyra", null), undefined);
assert.equal(checklistHint(null, null), "Add a project first");

console.log("projectSettingsStep: ok");

// Challenger P3: Save writes only what the person changed, onto the config
// as it is on disk (a branch changed in Settings meanwhile stays).
{
  const read = { targetBranch: "main", verifyPipeline: null } as unknown as ProjectConfig;
  const onDisk = { ...read, targetBranch: "develop", installScript: "npm ci" } as typeof read;
  const out = patchSavedConfig(onDisk, read, { branch: "main", checksOn: false }, []);
  assert.equal(out.targetBranch, "develop");
  assert.equal((out as { installScript?: string }).installScript, "npm ci");
  const moved = patchSavedConfig(onDisk, read, { branch: "release", checksOn: false }, []);
  assert.equal(moved.targetBranch, "release");
}
// Challenger P3: a detached HEAD with no local branch isn't "no saved version".
{
  const s = stepScreen({ state: "noCommit", head: "detached" } as unknown as SetupConfigView, "lyra");
  assert.ok(s.kind === "fixFirst" && s.sentence.includes("isn't on a branch"));
}

// N14 walk F9: a folder added outside Setup saves the plain proposal on its
// own — what step 9's `Looks right` saves — and nothing when there is
// something to ask or something already set.
{
  const withChecks = view({ config: config({ verifyPipeline: [{ kind: "script", path: "scripts/check.sh" }] }) });
  assert.deepEqual(autoSetUpConfig(withChecks), draftConfig(withChecks.config!, initialDraft(withChecks), null));
  assert.equal(autoSetUpConfig(view())?.targetBranch, "main");
  assert.equal(autoSetUpConfig(view({ config: config({ targetBranch: "trunk" }) }))?.targetBranch, "trunk");
  for (const state of ["existing", "shared", "needsBranch", "noCommit", "notRepo"] as const) {
    assert.equal(autoSetUpConfig(view({ state })), null, state);
  }
  assert.equal(autoSetUpConfig(view({ config: null })), null);
  assert.equal(autoSetUpConfig(view({ config: config({ targetBranch: "" }) })), null);
  assert.equal(autoSetUpConfig(view({ readOnly: true })), null);
}
