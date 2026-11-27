// OB-13 (ONBOARDING_SPEC §5 step 9): the words of Setup's "How Plyloft
// builds “lyra”" step, pure, so each fact and each "none yet" sentence is
// tested under node:
//
//     node --experimental-strip-types src/lib/projectSettingsStep.test.ts
//
// Rust reads the project (`project_setup_config.rs`, never a silent `main`);
// this file turns the config into plain words and builds what `Looks right`
// saves through the existing `project_config_set`.
import type { ProjectConfig, SetupConfigView, VerifyKind } from "../ipc.ts";

export function projectSettingsTitle(name: string | null): string {
  return name ? `How Plyloft builds “${name}”` : "How Plyloft builds your project";
}

export const LEDE_PROPOSAL = "Plyloft looked at your project. Check that this sounds right.";
export const LEDE_SHARED = "This project's settings come from its repository.";
export const SHARED_WAITING = "Plyloft is reading them from the repository…";
export const CHANGE_MORE = "More settings are in Settings › Cards › Building and checking after setup.";
export const NO_CHECKS = "None yet. Cards ship without checks; you can add them later in Settings.";
export const NO_VERSION = "No version file. Plyloft won't change a version.";
export const NOTHING_AFTER = "Nothing runs.";
export const NO_WORKSPACE = "Add a project first. Plyloft sets up how it builds a project once it's in.";

export function ledeExisting(name: string): string {
  return `These are the settings Plyloft has for “${name}”. Change them if something is wrong.`;
}

// ── The facts ────────────────────────────────────────────────────────────

/** "a", "a and b", "a, b and c". */
export function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Cards start from — "main. Each card gets its own copy of main, and its
 *  result is merged back into main." */
export function branchFact(branch: string): string {
  return `${branch}. Each card gets its own copy of ${branch}, and its result is merged back into ${branch}.`;
}

/** One verify step as the person would type it. */
export function verifyStepWords(step: VerifyKind): string {
  if (step.kind === "script") return step.path;
  const name = step.name.startsWith("/") ? step.name : `/${step.name}`;
  return [name, ...(step.args ?? [])].join(" ");
}

/** Checks before shipping — "scripts/verify.sh runs before a card can
 *  ship." / the "none yet" sentence for no pipeline or an empty one. */
export function checksFact(pipeline: readonly VerifyKind[] | null | undefined): string {
  const steps = (pipeline ?? []).map(verifyStepWords).filter((s) => s.trim() !== "");
  if (steps.length === 0) return NO_CHECKS;
  if (steps.length === 1) return `${steps[0]} runs before a card can ship.`;
  return `${steps.slice(0, -1).join(", ")}, then ${steps[steps.length - 1]} run before a card can ship.`;
}

/** Version number — "Kept in package.json (1.4.2). Plyloft raises it when
 *  you release." / "No version file. Plyloft won't change a version." */
export function versionFact(files: readonly { path: string }[], version: string | null): string {
  if (files.length === 0) return NO_VERSION;
  const where = joinWords(files.map((f) => f.path));
  return `Kept in ${where}${version ? ` (${version})` : ""}. Plyloft raises it when you release.`;
}

/** After shipping — "Nothing runs." / "scripts/install.sh runs on this Mac."
 *  (the overlay says it per platform through `machineWords`). */
export function afterShippingFact(installScript: string | null | undefined): string {
  const script = installScript?.trim();
  return script ? `${script} runs on this Mac.` : NOTHING_AFTER;
}

export interface Fact {
  label: string;
  value: string;
}

/** The four facts, in the spec's order. A config still waiting for its
 *  branch (the ask) says so instead of a branch. */
export function projectFacts(config: ProjectConfig, version: string | null): Fact[] {
  return [
    {
      label: "Cards start from",
      value: config.targetBranch ? branchFact(config.targetBranch) : "Choose a branch above.",
    },
    { label: "Checks before shipping", value: checksFact(config.verifyPipeline) },
    { label: "Version number", value: versionFact(config.versionFiles, version) },
    { label: "After shipping", value: afterShippingFact(config.installScript) },
  ];
}

/** Under Details: the config's own fields, as saved. */
export function detailLines(config: ProjectConfig): string[] {
  const pipeline = config.verifyPipeline ?? [];
  return [
    `Target branch: ${config.targetBranch || "(not chosen yet)"}`,
    `Version files: ${config.versionFiles.length ? config.versionFiles.map((f) => `${f.path} (${f.kind})`).join(", ") : "none"}`,
    // 1.174.0 (DS2): the Settings rows' names (T24; A1, owner).
    `Checks before shipping: ${pipeline.length ? pipeline.map(verifyStepWords).join(" → ") : "empty"}`,
    `After a release, run: ${config.installScript || "none"}`,
  ];
}

// ── What the step says for each reading ─────────────────────────────────

export type StepScreen =
  /** Facts, `Looks right` saves (a proposal). */
  | { kind: "confirm"; lede: string }
  /** Facts of a saved config; `Change` still offered. */
  | { kind: "existing"; lede: string }
  /** Facts shown read-only (or a waiting line until they are on this Mac). */
  | { kind: "shared"; lede: string; waiting: boolean }
  /** Which branch? — above the facts. */
  | { kind: "ask"; headline: string; sentence: string }
  /** Step 8 has to fix it first. */
  | { kind: "fixFirst"; sentence: string };

export const ASK_SENTENCE = "Cards start from a branch and are merged back into it. Which one?";

export function stepScreen(view: SetupConfigView, name: string): StepScreen {
  switch (view.state) {
    case "existing":
      return { kind: "existing", lede: ledeExisting(name) };
    case "shared":
      return { kind: "shared", lede: LEDE_SHARED, waiting: view.config === null };
    case "proposal":
      return { kind: "confirm", lede: LEDE_PROPOSAL };
    case "needsBranch":
      return {
        kind: "ask",
        headline:
          view.head === "unborn" && view.headBranch
            ? `“${name}” is on ${view.headBranch}, which has no saved version yet.`
            : `“${name}” isn't on a branch right now.`,
        sentence: ASK_SENTENCE,
      };
    case "noCommit":
      return {
        kind: "fixFirst",
        // A detached HEAD has a commit; it's the missing local branch that
        // leaves cards nothing to start from.
        sentence:
          view.head === "detached"
            ? `“${name}” isn't on a branch, and it has no local branch for cards to start from. Make one from this version (for example \`git switch -c main\`), then come back.`
            : `“${name}” has no saved version yet, so cards have nothing to start from. Save its first version in First project.`,
      };
    case "notRepo":
      return {
        kind: "fixFirst",
        sentence: `“${name}” isn't a Git project yet. Make it one in First project.`,
      };
  }
}

// ── The Change form and what is saved ───────────────────────────────────

export interface SettingsDraft {
  /** "" while the ask has no answer. */
  branch: string;
  checksOn: boolean;
}

/** The pipeline the `Checks` switch turns on: the config's own when it has
 *  one, else the script the scan found; null when there is none to offer. */
export function checksOffer(
  config: ProjectConfig,
  detected: readonly VerifyKind[] | null | undefined,
): VerifyKind[] | null {
  if (config.verifyPipeline && config.verifyPipeline.length > 0) return [...config.verifyPipeline];
  if (detected && detected.length > 0) return [...detected];
  return null;
}

/** The form's starting point: the config's branch (or the ask's suggestion)
 *  and whether it has checks. */
export function initialDraft(view: SetupConfigView): SettingsDraft {
  const config = view.config;
  return {
    branch: config?.targetBranch || (view.state === "needsBranch" ? (view.suggestedBranch ?? "") : ""),
    checksOn: Boolean(config?.verifyPipeline && config.verifyPipeline.length > 0),
  };
}

/** The config the facts show and `Looks right` / `Save` writes. */
export function draftConfig(
  config: ProjectConfig,
  draft: SettingsDraft,
  detected: readonly VerifyKind[] | null | undefined,
): ProjectConfig {
  const offer = checksOffer(config, detected);
  return {
    ...config,
    targetBranch: draft.branch,
    verifyPipeline: draft.checksOn && offer ? offer : null,
  };
}

/** N14 walk F9: what a folder added outside Setup (the sidebar `+`, the
 *  palette, the empty center) saves on its own — the config Setup's step 9
 *  would save on `Looks right`, only when the read is a plain proposal (a
 *  branch HEAD is on, or `main`). Anything to ask (no branch, no commit, not
 *  a repository) or already set (saved, shared) saves nothing: Start build
 *  then still offers Set up. Before, every such folder needed Settings ›
 *  Build and release › Re-detect before its first Start build. */
export function autoSetUpConfig(view: SetupConfigView): ProjectConfig | null {
  if (view.state !== "proposal" || !view.config || view.readOnly) return null;
  if (!view.config.targetBranch) return null;
  return draftConfig(view.config, initialDraft(view), view.detectedVerify);
}

/** Save a change to a saved config (the step's Change → Save): only the
 *  fields the person changed from what the step read are written, onto the
 *  config as it is on disk now — a change made in Settings meanwhile stays. */
export function patchSavedConfig(
  onDisk: ProjectConfig,
  read: ProjectConfig,
  draft: SettingsDraft,
  detected: readonly VerifyKind[] | null | undefined,
): ProjectConfig {
  const had = Boolean(read.verifyPipeline && read.verifyPipeline.length > 0);
  const offer = checksOffer(read, detected);
  return {
    ...onDisk,
    targetBranch: draft.branch !== read.targetBranch ? draft.branch : onDisk.targetBranch,
    verifyPipeline: draft.checksOn !== had ? (draft.checksOn && offer ? offer : null) : onDisk.verifyPipeline,
  };
}

/** Whether the draft differs from the saved config (an existing config's
 *  primary is `Save` then, else `Continue`). */
export function draftChanged(config: ProjectConfig, draft: SettingsDraft): boolean {
  const had = Boolean(config.verifyPipeline && config.verifyPipeline.length > 0);
  return draft.branch !== config.targetBranch || draft.checksOn !== had;
}

/** The branches the select offers: the local ones, with the draft's own
 *  first when it isn't among them (a saved branch deleted since). */
export function branchOptions(branches: readonly string[], current: string): string[] {
  const out = [...branches];
  if (current && !out.includes(current)) out.unshift(current);
  return out;
}

/** The switch's label: the script it runs. */
export function checksLabel(offer: readonly VerifyKind[] | null): string {
  return offer ? `Run ${offer.map(verifyStepWords).join(", then ")} before a card can ship` : "";
}

export const NO_CHECK_SCRIPT = "Plyloft found no check script in this project. You can add checks later in Settings.";

// ── The fast checklist's row ─────────────────────────────────────────────

/** The Project settings row's words (the approved mockup: "“lyra” isn't set
 *  up for builds yet"). */
export function checklistHint(name: string | null, configured: boolean | null): string | undefined {
  if (!name) return "Add a project first";
  if (configured === true) return `“${name}” is set up for builds`;
  if (configured === false) return `“${name}” isn't set up for builds yet`;
  return undefined;
}
