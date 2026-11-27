/**
 * UX language card 2 (ADR 0004; docs/ux-language/boards/BOARDS.md §2 and §6):
 * the view model of Settings › Repository — Build & release and General.
 *
 * One page, two scopes (PATTERNS.md §2): with a shared definition the page
 * edits `.atelier/workspace.json` and publishes; without one it edits this
 * Mac's own project config and saves as it changes. The layout is the same
 * either way — only the badge, the status line and the publish bar differ.
 *
 * Editing never reaches anyone, this Mac included, until Publish: the draft
 * lives here, and one `workspace_definition_save` carries every changed
 * field so the channel makes one commit (BOARDS.md §2 "Publish bar").
 *
 * Pure — no React, no Tauri — so `repositoryPage.test.ts` runs it under node.
 */

import type {
  AreaDef,
  ProjectConfig,
  ReviewChecklistClass,
  VerifyKind,
  VersionFileEntry,
  WorkspaceDefinition,
} from "../ipc";
import type { FieldProvenanceLike } from "./sharedLibrary.ts";
import { BRANCH_MISSING_MARKER, formatDay } from "./sharedLibrary.ts";
import { ago, areaChangeWords, fieldLabel, quotedLabel } from "./definitionRefresh.ts";
import { accentName } from "./repositoryAccent.ts";
import { basename, isAbsolutePath } from "./paths.ts";
import { isWindows, machineWords, type Platform } from "./platform.ts";
import { FOLLOW_SHIP_IT, RELEASE_KIND_LABEL, asReleaseKind } from "./shippingPage.ts";
import { publishConsequences } from "./checksConsent.ts";
import { removedStatusLine, sharingWaitsLine, unreadableSetupLine, type SetupUnreadable } from "./sharedSetup.ts";

// ── The fields each page owns, in the order they are drawn ─────────────

/** Building and checking: the checks, the review, the build cache and each
 *  card's copy. 1.174.0 (DS2): where cards go, what runs after a release and
 *  the version files moved to Shipping (`SHIPPING_FIELDS`). */
export const BUILD_FIELDS = [
  "verifyPipeline",
  "selfCheck",
  "reviewChecklist",
  "sharedBuildCache",
  "cachePaths",
  "worktreeCopy",
  "worktreeSetup",
] as const;

/** BOARDS.md §6 "Settings › Repository › General". `board` has no control. */
export const GENERAL_FIELDS = ["name", "accentColor"] as const;

/** 1.173.0 (B1): Settings › This repository › Areas (B5). Shared on its own,
 *  like the review settings: never part of the build settings, and only in
 *  a repository that shares its settings. */
export const AREA_FIELDS = ["areas"] as const;

/** 1.173.0 (G1): Settings › Shipping — the repository's default release
 *  kind (without areas; each area's is part of `areas`). Shared like the
 *  review settings where the repository shares its settings, this Mac's own
 *  (`areas.json`, `release_kind_set`) where not.
 *  1.174.0 (DS2, P26): the whole path after the build — where cards go
 *  (`integrationBranch`), what runs after a release (`installScript`) and the
 *  version files, which are `config.json`'s where nothing is shared. In the
 *  order the page draws them; the areas (`AREA_FIELDS`) sit between the
 *  default release and the version files (`SHIPPING_ORDER`). */
export const SHIPPING_FIELDS = ["integrationBranch", "installScript", "releaseKind", "versionFiles"] as const;

/** The Shipping page's draft, numbered as it is drawn: Cards go to, After a
 *  release, run, the releases (the repository's, or each area's), Version
 *  files. One page, one draft: its Review and its Publish carry only these. */
export const SHIPPING_ORDER = ["integrationBranch", "installScript", "releaseKind", "areas", "versionFiles"] as const;

/** The words each row is drawn with. `fieldLabel` keeps the shared
 *  definition's own labels, which the commit message uses
 *  (`workspace_definition::FIELDS`); the page says `Workspace colour`
 *  (`accentColorRowLabel`) and `Checklist classes` (BOARDS.md §2 and §6; QoL
 *  1.168 G10). 1.174.0 (DS2, P37, T24, SL-2): the rows say what happens, and
 *  the shared labels say the same. */
export const ROW_LABELS: Record<string, string> = {
  integrationBranch: "Cards go to",
  verifyPipeline: "Checks before shipping",
  // 1.174.0 (A1, owner): it runs after a release, not after every ship.
  installScript: "After a release, run",
  versionFiles: "Version files",
  selfCheck: "The Builder checks its own work first",
  reviewChecklist: "Checklist classes",
  sharedBuildCache: "Shared build cache",
  cachePaths: "Extra cache paths",
  worktreeCopy: "Files copied in",
  worktreeSetup: "Before the Builder starts, run",
  name: "Name",
  // QoL 1.168 G10: not the Mac's own accent colour — the workspace chip,
  // which everyone who opens the repository sees.
  accentColor: "Workspace colour",
  areas: "Areas",
  releaseKind: "Default release",
};

/** QoL 1.168 G10 (Windows walk): the workspace colour's row says it is
 *  shared only when the repository shares its settings — a repository that
 *  shares nothing says so in its scope line, and the row must not contradict
 *  it. Searched and landed on as `rowLabel("accentColor")` (`Row.findAs`). */
export function accentColorRowLabel(shared: boolean): string {
  return shared ? "Workspace colour (shared with everyone who opens this repository)" : "Workspace colour";
}

export function rowLabel(key: FieldKey): string {
  return ROW_LABELS[key] ?? fieldLabel(key);
}

export type BuildField = (typeof BUILD_FIELDS)[number];
export type GeneralField = (typeof GENERAL_FIELDS)[number];
export type AreaField = (typeof AREA_FIELDS)[number];
export type ShippingField = (typeof SHIPPING_FIELDS)[number];
export type FieldKey = BuildField | GeneralField | AreaField | ShippingField;

/** What the page holds and has not published. Absent = untouched. */
export type Draft = Partial<Record<FieldKey, unknown>>;

/** The definition as this Mac runs it, or the local config mapped onto the
 *  same field names when the repository shares none. */
export type Values = Partial<Record<FieldKey, unknown>>;

// ── Values ─────────────────────────────────────────────────────────────

/** A switch with no value is on (`sharedBuildCache`, `selfCheck`). */
const ON_BY_DEFAULT = new Set<FieldKey>(["sharedBuildCache", "selfCheck"]);

/** `undefined` and an empty list both mean "none", so neither reads as a
 *  change against the other. */
export function normalise(key: FieldKey, value: unknown): unknown {
  if (ON_BY_DEFAULT.has(key)) return value == null ? true : value;
  if (value === undefined) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  if (value === "") return null;
  return value;
}

export function readField(key: FieldKey, from: Values | null): unknown {
  return normalise(key, from ? (from as Record<string, unknown>)[key] : undefined);
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The value a row shows: the draft's when the row was touched, else the
 *  one this Mac runs with. */
export function currentValue(key: FieldKey, base: Values | null, draft: Draft): unknown {
  return key in draft ? normalise(key, draft[key]) : readField(key, base);
}

/**
 * The draft with every key that no longer differs from the baseline taken
 * out (F6). A key left behind — a field focused and blurred unchanged, or
 * toggled and toggled back — is invisible while the baseline agrees with
 * it, and becomes a change the moment someone else changes that field and a
 * refresh arrives. It would then be published back over their change.
 */
export function pruneDraft(base: Values | null, draft: Draft): Draft {
  const out: Draft = {};
  for (const key of Object.keys(draft) as FieldKey[]) {
    if (!sameValue(normalise(key, draft[key]), readField(key, base))) out[key] = draft[key];
  }
  return out;
}

/** The changed fields, in page order. A value put back as it was is not a
 *  change, so the row loses its mark and the bar its jump. */
export function changedFields(
  order: readonly FieldKey[],
  base: Values | null,
  draft: Draft,
): FieldKey[] {
  return order.filter(
    (key) => key in draft && !sameValue(normalise(key, draft[key]), readField(key, base)),
  );
}

// ── Words ──────────────────────────────────────────────────────────────

export function verifyStepText(step: VerifyKind): string {
  return step.kind === "script"
    ? step.path
    : `/${step.name.replace(/^\//, "")}${step.args.length ? ` ${step.args.join(" ")}` : ""}`;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** 1.173.0 (B1): an area's name, else its id (`AreaDef::display_name`). */
export function areaName(area: AreaDef): string {
  return area.name?.trim() || area.id;
}

/** "lyrappc-astro/", or the root's words (`areas::folder_words`). */
export function areaFolderWords(path: string): string {
  const p = path
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== ".")
    .join("/");
  return p ? `${p}/` : "the whole repository";
}

export function fileWord(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

/** "a", "a and 1 more", "a and 4 more". */
export function andMore(items: string[]): string {
  if (items.length === 0) return "none";
  if (items.length === 1) return items[0];
  return `${items[0]} and ${items.length - 1} more`;
}

/** "A", "A and B", "A, B and C". */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The value as the row's right side says it (SHEET.md "Fields"). */
export function valueText(key: FieldKey, value: unknown): string {
  switch (key) {
    case "integrationBranch":
      return typeof value === "string" && value ? value : "The default branch";
    case "verifyPipeline": {
      const steps = asArray<VerifyKind>(value).map(verifyStepText);
      return steps.length ? steps.join(" → ") : "None";
    }
    case "installScript":
      // W6 (1.174.0): the menu's empty choice is "Nothing".
      return typeof value === "string" && value ? value : NOTHING_AFTER;
    case "versionFiles": {
      const files = asArray<VersionFileEntry>(value);
      return files.length ? `${fileWord(files.length)}` : "None";
    }
    case "cachePaths": {
      const paths = asArray<string>(value);
      return paths.length ? `${paths.length} ${paths.length === 1 ? "path" : "paths"}` : "None";
    }
    case "reviewChecklist": {
      const classes = asArray<ReviewChecklistClass>(value);
      return classes.length
        ? `${classes.length} ${classes.length === 1 ? "class" : "classes"}`
        : "None";
    }
    case "worktreeCopy": {
      const paths = asArray<string>(value);
      return paths.length ? `${paths.length} ${paths.length === 1 ? "path" : "paths"}` : "None";
    }
    case "worktreeSetup":
      return typeof value === "string" && value ? value : "None";
    case "sharedBuildCache":
    case "selfCheck":
      return value === false ? "Off" : "On";
    case "name":
      return typeof value === "string" ? value : "";
    case "accentColor":
      // GH #272: the colour by name, never its hex.
      return typeof value === "string" && value ? accentName(value) : "None";
    case "areas": {
      const areas = asArray<AreaDef>(value);
      return areas.length ? `${areas.length} ${areas.length === 1 ? "area" : "areas"}` : "None";
    }
    case "releaseKind":
      return releaseKindWords(value);
  }
}

/** 1.173.0 (G1): a default release kind in words; none chosen follows How
 *  Ship it ships (1.174.0, A1). */
export function releaseKindWords(value: unknown): string {
  const kind = asReleaseKind(value);
  // A1 round 1: "On this Mac only" says "this PC" on Windows.
  return kind ? machineWords(RELEASE_KIND_LABEL[kind]) : FOLLOW_SHIP_IT;
}

/**
 * What a sheet says a value is. A row says `2 files`, because a row is a
 * glance; Review and the leaving question say what those files are, because
 * nothing else shows the person what they are about to publish (F8, F21).
 */
export function detailText(key: FieldKey, value: unknown): string {
  switch (key) {
    case "versionFiles": {
      const files = asArray<VersionFileEntry>(value);
      return files.length ? files.map((f) => f.path).join(", ") : "None";
    }
    case "cachePaths":
    case "worktreeCopy": {
      const paths = asArray<string>(value);
      return paths.length ? paths.join(", ") : "None";
    }
    case "reviewChecklist": {
      const classes = asArray<ReviewChecklistClass>(value);
      return classes.length
        ? classes.map((c) => `${c.name} — ${c.sentence}`).join(" · ")
        : "None";
    }
    case "areas": {
      const areas = asArray<AreaDef>(value);
      return areas.length
        ? areas
            .map((a) => {
              // G1: the default release kind, where one is chosen.
              const kind = asReleaseKind(a.releaseKind);
              return `${areaName(a)} (${areaFolderWords(a.path ?? "")}${kind ? ` · ${RELEASE_KIND_LABEL[kind]}` : ""})`;
            })
            .join(" · ")
        : "None";
    }
    default:
      return valueText(key, value);
  }
}

/** W6 (1.174.0, settings.html scene 3): After a release, run's empty choice. */
export const NOTHING_AFTER = "Nothing";

/** Worktree ports: how the setup command (bash on both platforms) names
 *  the card worktree's own ports. */
export const WORKTREE_PORTS_HINT =
  "Each card's copy has its own 10 ports from $PLYLOFT_PORT_BASE, e.g. PORT=$PLYLOFT_PORT_BASE npm run dev.";

/** 1.174.1 P2 (T2): the ports hint, with PowerShell's form on Windows — as
 *  `portHint` in worktreeSetup.ts says it. */
export function worktreePortsHint(windows: boolean = isWindows()): string {
  return windows ? `${WORKTREE_PORTS_HINT} In PowerShell: $env:PLYLOFT_PORT_BASE.` : WORKTREE_PORTS_HINT;
}

/** The hint a row rests on: what is true now, in words (BOARDS.md §2). */
export function restingHint(key: FieldKey, value: unknown): string {
  switch (key) {
    case "integrationBranch":
      // 1.174.0 (DS2, P37).
      return "The branch every card's change goes to, and new cards start from.";
    case "verifyPipeline": {
      const steps = asArray<VerifyKind>(value).map(verifyStepText);
      // 1.174.0 (T25).
      return steps.length
        ? `${steps.join(" → ")} runs before anything ships.`
        : "None — nothing checks a card before it ships.";
    }
    case "installScript":
      // 1.174.0 (A1, W6/T7, owner): when it really runs — after a release
      // (ship.rs, release_pr.rs) and after a land on this Mac (card_ship's
      // merge_live), never after Ship it's pull request.
      return typeof value === "string" && value
        ? machineWords(`${value} runs after a release, or after Ship it on this Mac — not when Ship it opens a pull request.`)
        : "None — nothing is built or installed after a release.";
    case "versionFiles": {
      const files = asArray<VersionFileEntry>(value);
      return files.length
        ? `Bumped together on every release — ${andMore(files.map((f) => f.path))}.`
        : "None — no file's version is bumped on a release.";
    }
    case "cachePaths": {
      const paths = asArray<string>(value);
      return paths.length
        ? `Shared as well as the dependency folders — ${andMore(paths)}.`
        : "None — only the dependency folders are shared.";
    }
    case "sharedBuildCache":
      return "Agents reuse one install of the dependencies for this repository.";
    case "worktreeCopy": {
      const paths = asArray<string>(value);
      return paths.length
        ? `Copied from your project folder into every new card's copy — ${andMore(paths)}.`
        : "None — a card's copy starts with the repository's tracked files only.";
    }
    case "worktreeSetup":
      return (
        (typeof value === "string" && value
          ? `${value} runs in every new card's copy before its Builder starts.`
          : "None — the Builder starts as soon as the card's copy is made.") + ` ${worktreePortsHint()}`
      );
    case "selfCheck":
      return "Finish and check first asks the Builder to go over its change against the risk checklist.";
    case "reviewChecklist": {
      const classes = asArray<ReviewChecklistClass>(value);
      return classes.length
        ? `This repository's own classes, after the ones Plyloft ships — ${andMore(
            classes.map((c) => c.name),
          )}.`
        : "None of its own — reviews use the classes Plyloft ships.";
    }
    // 1.174.0 (DS5, scene 8).
    case "name":
      return "What everyone sees in the sidebar.";
    case "accentColor":
      return "The color of this project's chip in the sidebar.";
    case "areas": {
      const areas = asArray<AreaDef>(value);
      return areas.length
        ? `Parts of this repository that ship on their own — ${listWords(areas.map(areaName))}.`
        : "None — the whole repository ships as one.";
    }
    case "releaseKind":
      return "Where Release… starts, for everyone who opens this repository.";
  }
}

/** Owner, 2026-10-20: the Name row's hint. On a shared workspace whose
 *  person named it (`nameChosen`), the row holds the shared Name, which never
 *  renames this one, and says so — with this Mac's own name when it differs. */
export function nameHint(
  shared: boolean,
  own: { name: string; chosen: boolean } | null,
  sharedName: string,
): string {
  if (!shared || !own?.chosen) return restingHint("name", sharedName);
  const base = "What everyone sees in the sidebar, unless they named the workspace themselves.";
  return own.name !== sharedName ? `${base} You named it “${own.name}” on this Mac.` : base;
}

/** What publishing this change does, in words (the Review sheet). */
export function consequenceOf(key: FieldKey, value: unknown): string {
  switch (key) {
    case "integrationBranch":
      return `Shared changes go to ${valueText(key, value)} from now on.`;
    case "verifyPipeline":
      // 1.174.0 (T25).
      // 1.175.0 B2: the other computers ask before they run them.
      return asArray<VerifyKind>(value).length
        ? `These checks will run before anything ships. ${publishConsequences(["verifyPipeline"])[0]}`
        : "Nothing will check a card before it ships.";
    case "installScript":
      return typeof value === "string" && value
        ? `${machineWords("It will run after a release, or after Ship it on this Mac.")} ${publishConsequences(["installScript"])[0]}`
        : "Nothing will run after a release.";
    case "versionFiles":
      return asArray<VersionFileEntry>(value).length
        ? "Every release bumps these files together."
        : "No file's version is bumped on a release.";
    case "cachePaths":
      return asArray<string>(value).length
        ? "These paths are shared between card builds too."
        : "Only the dependency folders are shared.";
    case "sharedBuildCache":
      return value === false
        ? "Every agent will install the dependencies itself. First runs get slower."
        : "Agents reuse one install of the dependencies for this repository.";
    case "worktreeCopy":
      return asArray<string>(value).length
        ? "Every new card's copy gets these files from the project folder of whoever starts the card."
        : "New card worktrees get no files copied in.";
    case "worktreeSetup":
      return typeof value === "string" && value
        ? "It runs in every new card's copy, on the Mac that starts the card, before the Builder starts. If it fails, the card waits."
        : "Nothing runs in a new card's copy before the Builder starts.";
    case "selfCheck":
      return value === false
        ? "Finish and check goes straight to the checks and the Reviewer."
        : "Finish and check asks the Builder to go over its own change first.";
    case "reviewChecklist":
      return asArray<ReviewChecklistClass>(value).length
        ? "Every review looks for these as well as the classes Plyloft ships."
        : "Reviews use the classes Plyloft ships and nothing else.";
    case "name":
      // Owner, 2026-10-20: a workspace someone named themselves keeps its name.
      return "Everyone who opens this repository sees this name, unless they named the workspace themselves.";
    case "accentColor":
      return "This workspace's chip in the sidebar takes this colour, for everyone who opens it.";
    case "areas":
      return asArray<AreaDef>(value).length
        ? "Each card belongs to one area and goes where that area's cards go, for everyone who opens this repository."
        : "The whole repository ships as one again, for everyone who opens it.";
    case "releaseKind":
      return asReleaseKind(value)
        ? `Release… starts with “${releaseKindWords(value)}” for everyone who opens this repository; each release can still choose.`
        : "Release… follows How Ship it ships; each release can still choose.";
  }
}

// ── The changed mark, the jumps and the review ─────────────────────────

/** One change of the draft, numbered as the row and its jump show it. */
export interface Change {
  key: FieldKey;
  /** 1-based; the ChangedMark's badge and the PublishBar's jump. */
  n: number;
  label: string;
  from: unknown;
  to: unknown;
  /** For a row's mark: `2 files`. */
  fromText: string;
  toText: string;
  /** For Review and the leaving question: what those files are. */
  fromDetail: string;
  toDetail: string;
  consequence: string;
}

export function changes(
  order: readonly FieldKey[],
  base: Values | null,
  draft: Draft,
): Change[] {
  return changedFields(order, base, draft).map((key, i) => {
    const from = readField(key, base);
    const to = normalise(key, draft[key]);
    // 1.173.0 (G1 Challenger 4): Settings › Shipping changed only the areas'
    // default release kinds — said as that, never as "2 areas → 2 areas".
    const kinds = key === "areas" ? releaseKindOnlyChanges(from, to) : null;
    if (kinds) {
      return {
        key,
        n: i + 1,
        label: "Default release",
        from,
        to,
        fromText: kinds.map((k) => `${k.name}: ${k.fromWords}`).join(" · "),
        toText: kinds.map((k) => `${k.name}: ${k.toWords}`).join(" · "),
        fromDetail: kinds.map((k) => `${k.name}: ${k.fromWords}`).join(" · "),
        toDetail: kinds.map((k) => `${k.name}: ${k.toWords}`).join(" · "),
        consequence: `${kinds.map((k) => `${k.name}'s default release: ${k.toWords}`).join("; ")}. Each release can still choose.`,
      };
    }
    return {
      key,
      n: i + 1,
      label: rowLabel(key),
      from,
      to,
      fromText: valueText(key, from),
      toText: valueText(key, to),
      // G2 walk: a change inside an area (its address, its branch) is said
      // as that area's field, both sides — never the same list twice.
      ...(key === "areas" ? areasChangeDetail(from, to) : null) ?? {
        fromDetail: detailText(key, from),
        toDetail: detailText(key, to),
      },
      consequence: consequenceOf(key, to),
    };
  });
}

/** An area's fields as its sub-page names them, for a change between two
 *  lists. */
const AREA_FIELD_WORDS: [keyof AreaDef, string][] = [
  ["name", "Name"],
  ["path", "Folder"],
  ["targetBranch", "Cards go to"],
  ["versionFiles", "Version files"],
  ["tagPrefix", "Release tags start with"],
  ["lookAt", "Where to look at it"],
  ["label", "Board label"],
  ["releaseKind", "Default release"],
];

function areaFieldValue(field: keyof AreaDef, area: AreaDef): string {
  const v = area[field];
  switch (field) {
    case "path":
      return areaFolderWords(typeof v === "string" ? v : "");
    case "targetBranch":
      return typeof v === "string" && v.trim() ? v.trim() : "the project's branch";
    case "versionFiles":
      return detailText("versionFiles", v ?? []);
    case "releaseKind":
      return releaseKindWords(v);
    default:
      return typeof v === "string" && v.trim() ? v.trim() : "nothing";
  }
}

/**
 * G2 walk: what changed in a list of areas, as both sides of Review and the
 * leaving question — an area added ("Site: not an area yet" → "Site
 * (site/), added") or removed ("Site (site/)" → "Site: no longer an area"),
 * each one changed by the fields that changed ("Site — Where to look at it:
 * nothing" → "Site — Where to look at it: https://www.lyrappc.com"). Null
 * when nothing can be said area by area (both sides empty).
 */
export function areasChangeDetail(from: unknown, to: unknown): { fromDetail: string; toDetail: string } | null {
  const a = asArray<AreaDef>(from);
  const b = asArray<AreaDef>(to);
  if (a.length === 0 && b.length === 0) return null;
  const before: string[] = [];
  const after: string[] = [];
  const whole = (x: AreaDef) => `${areaName(x)} (${areaFolderWords(x.path ?? "")})`;
  for (const old of a) {
    const now = b.find((x) => x.id === old.id);
    if (!now) {
      before.push(whole(old));
      after.push(`${areaName(old)}: no longer an area`);
      continue;
    }
    const fields = AREA_FIELD_WORDS.filter(([f]) => !sameValue(old[f] ?? null, now[f] ?? null));
    if (fields.length === 0) continue;
    before.push(`${areaName(old)} — ${fields.map(([f, w]) => `${w}: ${areaFieldValue(f, old)}`).join("; ")}`);
    after.push(`${areaName(now)} — ${fields.map(([f, w]) => `${w}: ${areaFieldValue(f, now)}`).join("; ")}`);
  }
  for (const added of b) {
    if (a.some((x) => x.id === added.id)) continue;
    before.push(`${areaName(added)}: not an area yet`);
    after.push(`${whole(added)}, added`);
  }
  // Only the order moved: the lists as they read.
  if (before.length === 0 && after.length === 0) return null;
  return { fromDetail: before.join(" · "), toDetail: after.join(" · ") };
}

/**
 * The areas whose default release kind is all that changed between two
 * lists (same areas, same order, every other key equal), with their names
 * and both kinds in words; null when anything else changed too.
 */
export function releaseKindOnlyChanges(
  from: unknown,
  to: unknown,
): { name: string; fromWords: string; toWords: string }[] | null {
  const a = asArray<AreaDef>(from);
  const b = asArray<AreaDef>(to);
  if (a.length === 0 || a.length !== b.length) return null;
  const without = (x: AreaDef) => {
    const { releaseKind: _kind, ...rest } = x;
    void _kind;
    return rest;
  };
  const out: { name: string; fromWords: string; toWords: string }[] = [];
  for (let i = 0; i < a.length; i++) {
    if (!sameValue(without(a[i]), without(b[i]))) return null;
    if ((a[i].releaseKind ?? null) !== (b[i].releaseKind ?? null)) {
      out.push({ name: areaName(b[i]), fromWords: releaseKindWords(a[i].releaseKind), toWords: releaseKindWords(b[i].releaseKind) });
    }
  }
  return out.length ? out : null;
}

/** How a row is marked. `draft` is this page's, not published anywhere;
 *  `queued` and `pullRequest` are saved here and on their way (GH #80). */
export type RowMark =
  | { kind: "rest" }
  | { kind: "draft"; n: number; was: string }
  | { kind: "queued"; was: string }
  | { kind: "pullRequest"; was: string; number: number }
  /** 1.173.0 (C3 Challenger 3): changed here and in the repository too;
   *  waits for the person's choice. */
  | { kind: "choosing"; was: string }
  /** 1.175.0 (C3, SC-3): drafted here, and the repository changed the same
   *  field meanwhile — `now` is its value there; Publish will ask. */
  | { kind: "draftMoved"; n: number; was: string; now: string; who: string | null }
  /** C5 (SC-8): waiting, and this account can't write to `repository`;
   *  `was` is the team's value. */
  | { kind: "cantWrite"; was: string; repository: string };

export interface PendingLike {
  /** The repository's value per field not published yet (`cache.pending`). */
  fields: Partial<Record<string, unknown>>;
  /** The pull request a field waits in, by field. */
  pullRequests: Partial<Record<string, number>>;
  /** What the repository itself holds, for the "was" of a queued change. */
  repository: Values | null;
  /** C3 Challenger 3: fields waiting for the person's choice. */
  choosing?: string[];
  /** C5 (SC-8): this account can't write to this repository. */
  cantWrite?: string | null;
}

export function rowMark(
  key: FieldKey,
  base: Values | null,
  draft: Draft,
  pending: PendingLike | null,
  order: readonly FieldKey[],
  /** C3: what each drafted field was changed from, and who last changed
   *  the repository's file — for a field the repository moved meanwhile. */
  edited?: { bases: Draft; author: string | null },
): RowMark {
  const drafted = changes(order, base, draft).find((c) => c.key === key);
  if (drafted) {
    const moved = movedSince(key, base, edited);
    if (moved !== null) {
      return { kind: "draftMoved", n: drafted.n, was: moved, now: drafted.fromText, who: edited?.author ?? null };
    }
    return { kind: "draft", n: drafted.n, was: drafted.fromText };
  }
  if (pending && key in pending.fields) {
    const was = valueText(key, readField(key, pending.repository));
    if (pending.choosing?.includes(key)) return { kind: "choosing", was };
    if (pending.cantWrite) return { kind: "cantWrite", was, repository: pending.cantWrite };
    const pr = pending.pullRequests[key];
    return pr ? { kind: "pullRequest", was, number: pr } : { kind: "queued", was };
  }
  return { kind: "rest" };
}

/** The sentence under a marked row. A draft is applied nowhere — this Mac
 *  included — until Publish (BOARDS.md §6 "Leaving a draft"); a queued
 *  change already works here (§5 "Offline"). */
/** 1.174.0 (C12, AR-4; areas.html §2, §5): what a changed row was, in a
 *  sentence — "was 2 files", "was nothing" (never "was None"), and for the
 *  areas "there were no areas before". */
export function wasWords(key: FieldKey | null, was: string): string {
  const none = was === "None";
  if (key === "areas" && none) return "there were no areas before";
  return `was ${none ? "nothing" : was}`;
}

/** C3: the value a drafted field was changed from, as text, when the
 *  repository holds another value now; null while it holds the same. */
export function movedSince(
  key: FieldKey,
  values: Values | null,
  edited: { bases: Draft } | undefined,
): string | null {
  if (!edited || !(key in edited.bases)) return null;
  const was = normalise(key, edited.bases[key]);
  if (sameValue(was, readField(key, values))) return null;
  return valueText(key, was);
}

/** C3: the Review sheet's line under a drafted field the repository moved
 *  meanwhile — "{who} set it to {value} {4 min ago}; Publish asks which to
 *  keep." — or null while it holds what the draft was changed from. */
export function reviewMovedNote(
  key: FieldKey,
  values: Values | null,
  edited: { bases: Draft; author: string | null; changedAt: number | null } | undefined,
  nowSecs: number,
): string | null {
  if (movedSince(key, values, edited) === null) return null;
  const who = edited?.author ?? "Someone";
  const when = edited?.changedAt != null ? ` ${ago(nowSecs, edited.changedAt)}` : "";
  return `${who} set it to ${valueText(key, readField(key, values))}${when}; Publish asks which to keep.`;
}

export function markHint(mark: RowMark, key: FieldKey | null = null): string | null {
  switch (mark.kind) {
    case "rest":
      return null;
    case "draft":
      return `Changed here, not published yet — ${wasWords(key, mark.was)}.`;
    case "draftMoved":
      return `Changed here, and ${mark.who ?? "someone"} changed it in the repository meanwhile: it is ${mark.now} there now. Publish asks which to keep.`;
    case "queued":
      return `Changed here, not published yet — ${wasWords(key, mark.was)}. It works on this Mac already.`;
    case "cantWrite":
      return `Changed here, not published — you can't write to ${mark.repository}. The team has ${mark.was === "None" ? "nothing" : mark.was}.`;
    case "pullRequest":
      return `Changed here, waiting in pull request #${mark.number} — ${wasWords(key, mark.was)}. It works on this Mac already.`;
    case "choosing":
      return `Changed here and in the repository too — waiting for your choice. It works on this Mac already.`;
  }
}

// ── The publish bar ────────────────────────────────────────────────────

export type PublishBarView =
  | {
      kind: "draft";
      count: number;
      sentence: string;
      jumps: { n: number; key: FieldKey; label: string }[];
      publishLabel: string;
    }
  | { kind: "waiting"; sentence: string; detail: string }
  /** 1.175.0 (C4, SC-7): git or the GitHub command couldn't sign in, or an
   *  organization's single sign-on isn't authorized — with the press that
   *  fixes it. */
  | { kind: "trouble"; sentence: string; detail: string; action: TroubleAction }
  /** C4 round 2: a recorded pull request address, opened as it is. */
  | { kind: "openUrl"; sentence: string; detail: string; url: string }
  /** C5 (SC-5): the branch was renamed on GitHub — "Move to {to}". */
  | { kind: "moveTo"; sentence: string; detail: string; to: string }
  /** C5 (SC-8): this account can't write here — "Use the team's values…". */
  | { kind: "cantWrite"; sentence: string; detail: string }
  | { kind: "pullRequest"; sentence: string; detail: string; number: number }
  | { kind: "publishing"; sentence: string; detail: string }
  /** C3 Challenger 3: a field both sides changed waits for the person. */
  | { kind: "choosing"; sentence: string; detail: string; field: string };

/** Mirrors `shared_config::PublishTrouble` (the queue's `lastErrorKind`). */
export type PublishTrouble =
  | { kind: "network" }
  | { kind: "gitSignIn" }
  | { kind: "ghSignedOut" }
  | { kind: "sso"; org: string | null }
  | { kind: "other" };

/** Windows walk (C4): why "Cards go to" can't read the branches, by the
 *  failure's kind — a sign-in trouble is never "offline" (C4's sentences,
 *  as the status line says them). */
export function branchesUnreadWhy(
  trouble: { kind: string; org?: string | null } | null | undefined,
  /** F3 walk: the host of an `origin` that isn't on GitHub ("gitlab.com"):
   *  the words name it, never GitHub. */
  host?: string | null,
): string {
  if (host) {
    switch (trouble?.kind) {
      case "gitSignIn":
      case "ghSignedOut":
      case "sso":
        return `Can't be changed: Git couldn't sign in to ${host}, so Plyloft can't read the branches.`;
      case "other":
        return `Can't be changed: Plyloft couldn't read the branches from ${host}.`;
    }
  }
  switch (trouble?.kind) {
    case "gitSignIn":
      return "Can't be changed: Git couldn't sign in to GitHub, so Plyloft can't read the branches.";
    case "ghSignedOut":
      return "Can't be changed: GitHub isn't signed in on this Mac, so Plyloft can't read the branches.";
    case "sso":
      return `Can't be changed: ${trouble.org ? `“${trouble.org}”` : "your organization"} needs you to authorize single sign-on, so Plyloft can't read the branches.`;
    case "other":
      return "Can't be changed: Plyloft couldn't read the branches from GitHub.";
    default:
      return "Can't be changed while offline — Plyloft needs the repository to read the branches.";
  }
}

/** C4: the press under a sign-in trouble. */
export type TroubleAction =
  | { id: "githubSetup"; label: "Open GitHub setup" }
  | { id: "signIn"; label: "Sign in to GitHub" }
  | { id: "authorize"; label: "Authorize"; org: string | null };

/** What the channel is still carrying, from the durable queue. A page that
 *  opens long after the attempt has no refresh report to read, so the
 *  queue's own error is what says it is waiting rather than running (F19). */
export interface PendingPublish {
  /** The queued fields, and the whole definition when it is being created. */
  queued: string[];
  /** The definition itself has never reached the branch (F20). */
  creating: boolean;
  pullRequest: number | null;
  /** Ply knows it is offline: from the attempt it watched, or from the
   *  queue's own record of the last one (F19). */
  offline: boolean;
  /** What the last attempt said, kept in the queue across launches. */
  lastError: string | null;
  /** C3 Challenger 3: fields both sides changed, waiting for a choice. */
  choosing?: { field: string; label: string }[];
  /** C4 (SC-7): what kind of trouble `lastError` is. Absent from older
   *  backends and queues: read as "other" (or "offline" with `offline`). */
  trouble?: PublishTrouble | null;
  /** C4 (SC-4): the pull request waited on is this computer's creation one,
   *  and the setup arrived from another computer — `who` shared it. Plyloft
   *  couldn't close it. Absent otherwise. */
  sharedFirst?: { who: string | null } | null;
  /** C5 (SC-5): the shared setup's branch is gone from GitHub. */
  branchGone?: { branch: string; renamedTo: string | null } | null;
  /** C4 round 2: the creation pull request left open (GitHub refused the
   *  close) or no longer followed (not ours here now). */
  sharedFirstLeft?: { number: number; url: string; who: string | null; outcome: string } | null;
  /** C5 (SC-8): GitHub says this account can't push, with changes waiting
   *  (their labels); `repository` and `author` for the words. */
  cantWrite?: { labels: string[]; repository: string; author: string | null } | null;
}

/** F3/F9 (team walk): the last attempt found origin without the integration
 *  branch — not offline, and not on its way either. */
export function isBranchMissing(
  pending: Pick<PendingPublish, "offline" | "lastError"> | null | undefined,
): boolean {
  return !!pending && !pending.offline && !!pending.lastError?.includes(BRANCH_MISSING_MARKER);
}

export function changeWord(n: number): string {
  return `${n} ${n === 1 ? "change" : "changes"}`;
}

/** C5: where a draft's publish moves the shared setup — the branch "Cards
 *  go to" names now, while the one the setup lived on is gone; else
 *  undefined (`workspace_definition::publish_branch`). */
function movesTo(list: Change[], pending: PendingPublish | null): string | undefined {
  return pending?.branchGone ? (list.find((c) => c.key === "integrationBranch")?.to as string | undefined) : undefined;
}

/** WALKFIX-3 (re-run, item 2): the branch a draft's Publish really commits
 *  to — the bar, the Review sheet's lede, its button and its details all say
 *  this one, never the gone branch. */
export function publishTarget(list: Change[], branch: string, pending: PendingPublish | null): string {
  return movesTo(list, pending) ?? branch;
}

/** Windows walk (C5): the same, from the draft a Publish sends — the
 *  "Publishing to {branch}" toast names it, never the gone branch. */
export function publishTargetOfDraft(
  draft: Readonly<Record<string, unknown>>,
  branch: string,
  pending: PendingPublish | null,
): string {
  const to = draft.integrationBranch;
  return pending?.branchGone && typeof to === "string" && to.trim() ? to : branch;
}

/** The bar at the bottom of the page, or null when there is nothing to say.
 *  A draft takes precedence: it is the only thing with actions. */
export function publishBar(
  list: Change[],
  branch: string,
  pending: PendingPublish | null,
  /** C3: the fields the last Publish of this page carried (the bar says
   *  how many went out beside the ones waiting for a choice). */
  publishedNow: readonly string[] | null = null,
): PublishBarView | null {
  if (list.length > 0) {
    // C5 (SC-5): the branch is gone and "Cards go to" names another: the
    // publish moves the shared setup there.
    const moveTo = movesTo(list, pending);
    return {
      kind: "draft",
      count: list.length,
      sentence: moveTo
        ? `${changeWord(list.length)} · moves the shared setup to ${moveTo} · reaches everyone who opens this repository`
        : `${changeWord(list.length)} · reaches everyone who opens this repository`,
      jumps: list.map((c) => ({ n: c.n, key: c.key, label: c.label })),
      publishLabel: `Publish to ${moveTo ?? branch}`,
    };
  }
  if (!pending) return null;
  // C3 Challenger 3: nothing goes out for a field both sides changed until
  // the person chooses — never "Publishing…" for it.
  if (pending.choosing?.length) {
    const labels = listWords(pending.choosing.map((c) => c.label));
    // C3 (SC-3): the other fields of that Publish went out.
    // C3 round 2: from the queue — sent, minus those waiting for the
    // choice, minus those still queued or waiting in a pull request.
    const sent = publishedNow ?? [];
    const choosing = new Set(pending.choosing.map((c) => c.field));
    const others = sent.filter((k) => !choosing.has(k));
    const landed = others.filter((k) => !pending.queued.includes(k)).length;
    const waiting = others.filter((k) => pending.queued.includes(k)).length;
    const went =
      (landed === 0 ? "" : landed === 1 ? " Your other change was published." : ` Your other ${landed} changes were published.`) +
      (waiting === 0 || pending.pullRequest == null
        ? ""
        : waiting === 1
          ? ` Your other change waits in pull request #${pending.pullRequest}.`
          : ` Your other ${waiting} changes wait in pull request #${pending.pullRequest}.`);
    return {
      kind: "choosing",
      sentence: `Waiting for your choice: ${labels}`,
      detail: `It changed here and in the repository too. Plyloft publishes it once you choose.${went}`,
      field: pending.choosing[0].field,
    };
  }
  // C4 round 2: what was left of an unneeded creation pull request, named
  // until a later publish lands. Only a refused one is "close it there";
  // one that isn't ours here opens its own recorded address.
  if (pending.sharedFirstLeft && pending.queued.length === 0 && !pending.creating) {
    const left = pending.sharedFirstLeft;
    const who = left.who ?? "Someone";
    return left.outcome === "notOurs"
      ? {
          kind: "openUrl",
          sentence: `Pull request #${left.number} is no longer followed`,
          detail: `${who} shared this project's setup first, and this Mac follows it. Pull request #${left.number}, which Plyloft had opened from this Mac, isn't in this repository as Plyloft left it.`,
          url: left.url,
        }
      : {
          kind: "pullRequest",
          sentence: `Pull request #${left.number} is still open, and isn't needed`,
          detail: `${who} shared this project's setup first, and this Mac follows it. Plyloft couldn't close its own pull request; close it on GitHub.`,
          number: left.number,
        };
  }
  if (pending.pullRequest != null && pending.sharedFirst) {
    // C4 (SC-4): nothing to wait for. WALKFIX-3 (item 4): Plyloft hasn't
    // tried to close it yet (a page read closes nothing) — "couldn't close"
    // is said only after a refused close (`sharedFirstLeft` above).
    const who = pending.sharedFirst.who ?? "Someone";
    return {
      kind: "pullRequest",
      sentence: `Pull request #${pending.pullRequest} is still open, and isn't needed`,
      detail: `${who} shared this project's setup first, and this Mac follows it. Plyloft closes its own pull request at the next Sync.`,
      number: pending.pullRequest,
    };
  }
  if (pending.pullRequest != null) {
    return {
      kind: "pullRequest",
      sentence: `Waiting in pull request #${pending.pullRequest}`,
      detail: `${branch} refused a direct push. Your changes work on this Mac and reach everyone once that pull request merges.`,
      number: pending.pullRequest,
    };
  }
  const count = pending.queued.length;
  if (count === 0 && !pending.creating) return null;
  // What is kept here, and whether it is on its way or held up.
  const what = pending.creating
    ? "This repository's settings are"
    : `${changeWord(count)} ${count === 1 ? "is" : "are"}`;
  const them = pending.creating || count > 1 ? "them" : "it";
  const works = pending.creating || count > 1 ? "work" : "works";
  // C5 (SC-8): GitHub says this account can't write here: nothing is tried
  // until it can, and the way out is the team's values.
  if (pending.cantWrite) {
    const labels = listWords(pending.cantWrite.labels);
    const n = pending.cantWrite.labels.length;
    return {
      kind: "cantWrite",
      sentence: `Not published — you can't write to ${pending.cantWrite.repository}`,
      detail: `${changeWord(n)} ${n === 1 ? "is" : "are"} kept here and ${n === 1 ? "works" : "work"} on this Mac only: ${labels}. Your team has other values. Ask ${pending.cantWrite.author ?? "someone with write access"} for write access to publish ${n === 1 ? "it" : "them"}, or use the team's values.`,
    };
  }
  // C5 (SC-5): the branch was renamed on GitHub: the move publishes it.
  if (pending.branchGone?.renamedTo) {
    const { branch: old, renamedTo } = pending.branchGone;
    return {
      kind: "moveTo",
      sentence: `Not published — ${old} is called ${renamedTo} on GitHub now`,
      detail: `${what} kept here and ${works} on this Mac. Move the shared setup to ${renamedTo} to publish ${them}.`,
      to: renamedTo,
    };
  }
  // C4 (SC-7): a sign-in is no network: said as what it is, with its press.
  const trouble = pending.offline ? null : pending.trouble;
  if (trouble?.kind === "gitSignIn") {
    return {
      kind: "trouble",
      sentence: "Not published — Git couldn't sign in to GitHub",
      detail: `${what} kept here and ${works} on this Mac. In Settings › Setup and account › Setup › GitHub, turn on "Git uses your GitHub sign-in"; Plyloft publishes ${them} at the next Sync.`,
      action: { id: "githubSetup", label: "Open GitHub setup" },
    };
  }
  if (trouble?.kind === "ghSignedOut") {
    return {
      kind: "trouble",
      sentence: "Not published — GitHub isn't signed in on this Mac",
      detail: `${what} kept here and ${works} on this Mac. Publishing ${them} to ${branch} needs the GitHub command signed in. Sign in to GitHub with the account this project uses; Plyloft publishes ${them} at the next Sync.`,
      action: { id: "signIn", label: "Sign in to GitHub" },
    };
  }
  if (trouble?.kind === "sso") {
    const org = trouble.org;
    return {
      kind: "trouble",
      sentence: org
        ? `Not published — “${org}” needs you to authorize single sign-on`
        : "Not published — your organization needs you to authorize single sign-on",
      detail: `${what} kept here and ${works} on this Mac. ${org ? `Your organization “${org}”` : "Your organization"} needs you to authorize the GitHub command for single sign-on; Plyloft publishes ${them} at the next Sync.`,
      action: { id: "authorize", label: "Authorize", org },
    };
  }
  if (pending.offline) {
    return {
      kind: "waiting",
      sentence: "Waiting to publish — you're offline",
      detail: `${what} kept here and ${works} on this Mac. Plyloft will publish ${them} to ${branch} when the connection is back.`,
    };
  }
  if (isBranchMissing(pending)) {
    return {
      kind: "waiting",
      sentence: `Not published — ${branch} isn't on GitHub any more`,
      detail: `${what} kept here and ${works} on this Mac. ${pending.lastError}`,
    };
  }
  if (pending.lastError) {
    return {
      kind: "waiting",
      sentence: `Waiting to publish to ${branch}`,
      detail: `${what} kept here and ${works} on this Mac. The last attempt didn't land: ${pending.lastError} Plyloft tries again on the next Sync.`,
    };
  }
  return {
    kind: "publishing",
    sentence: `Publishing to ${branch}…`,
    detail: "The rows keep their mark until it lands.",
  };
}

// ── The review sheet and the leave confirmation ────────────────────────

/**
 * The shared definition carries no build settings yet, and this change is
 * one: publishing it brings the rest of this Mac's build settings with it,
 * because a repository cannot hold half a project (the channel fills them
 * from here — `shared_config::prepare`). Review says so before it happens
 * (F25). `null` when nothing else travels.
 */
export function firstSharedProjectNote(
  sharedProject: boolean,
  values: Values | null,
  list: Change[],
): string | null {
  if (sharedProject || !list.some((c) => CONFIG_FIELDS.includes(c.key))) return null;
  const changed = new Set(list.map((c) => c.key));
  const rest = CONFIG_FIELDS.filter(
    (key) => !changed.has(key) && readField(key, values) != null,
  );
  if (rest.length === 0) return null;
  return `This repository shares no build settings yet, so publishing brings the rest of this Mac's with it: ${listWords(
    rest.map((key) => `${quotedLabel(rowLabel(key))} (${valueText(key, readField(key, values))})`),
  )}.`;
}

export function reviewTitle(n: number): string {
  return `Review ${changeWord(n)}`;
}

export function reviewLede(branch: string): string {
  return `Publishing makes one commit on ${branch}. Everyone who opens this repository gets them.`;
}

/** The commit message the channel will write, as
 *  `shared_config::message_line` builds it (`commit_message::config_line`). */
export function commitMessage(list: Change[]): string[] {
  const lines = list.map((c) => {
    // 1.173.0 (B1): `shared_config::message_line` names the changed areas.
    const what =
      (c.key === "areas" && areaChangeWords(c.from, c.to)) || `${describe(c.from)} → ${describe(c.to)}`;
    // 1.174.0 (DS2 round 1): the row's name in quotes, as Rust writes it;
    // `lowerFirst` leaves a quoted name as it is.
    return `chore(config): ${lowerFirst(oneLine(`${quotedLabel(fieldLabel(c.key))} — ${what}`))}`;
  });
  // `commit_message::config_message`: a subject past 100 characters is cut,
  // and every line follows in full.
  const runes = [...(lines[0] ?? "")];
  if (runes.length <= MAX_HEADER) return lines;
  return [`${runes.slice(0, MAX_HEADER - 1).join("").trimEnd()}…`, "", ...lines];
}

/** commitlint's `header-max-length` (`commit_message::MAX_HEADER`). */
const MAX_HEADER = 100;

/** `commit_message::one_line`: whitespace runs collapsed to one space. */
function oneLine(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** `commit_message::lower_first`: an ordinary capitalised first word
 *  ("Verify") is lowered; one with a capital inside ("GitHub", "API") is kept. */
function lowerFirst(text: string): string {
  const first = text.split(/\s+/)[0] ?? "";
  const [head, ...rest] = [...first];
  if (!head || head.toUpperCase() !== head || head.toLowerCase() === head) return text;
  if (rest.some((ch) => ch.toUpperCase() === ch && ch.toLowerCase() !== ch)) return text;
  return head.toLowerCase() + text.slice(head.length);
}

/** `shared_config::describe`: what one field's value reads as in a commit. */
export function describe(value: unknown): string {
  let text: string;
  if (value == null) text = "none";
  else if (typeof value === "string") text = value;
  else if (Array.isArray(value)) {
    text = value.length
      ? value
          .map((item) => {
            if (item && typeof item === "object") {
              const o = item as Record<string, unknown>;
              // 1.173.0 (B1): an area by its name, else its id.
              if (typeof o.id === "string" && typeof o.name === "string") return o.name.trim() || o.id;
              if (typeof o.path === "string") return o.path;
              if (typeof o.name === "string") return `/${o.name.replace(/^\//, "")}`;
            }
            return typeof item === "string" ? item : JSON.stringify(item);
          })
          .join(", ")
      : "none";
  } else text = JSON.stringify(value);
  text = text.replace(/\n/g, " ");
  const runes = [...text];
  return runes.length > 80 ? `${runes.slice(0, 79).join("")}…` : text;
}

export function leaveQuestion(n: number): string {
  return `Leave with ${changeWord(n)} nobody else has?`;
}

/** BOARDS.md §6, as corrected: a draft is applied nowhere until Publish.
 *  1.174.0 G2 Windows walk: "this PC included" on Windows (`machineWords`). */
export function leaveBody(list: Change[], p?: Platform): string {
  const labels = listWords(list.map((c) => c.label));
  const verb = list.length === 1 ? "is" : "are";
  return machineWords(
    `${labels} ${verb} changed on this page only. Nobody gets ${
      list.length === 1 ? "it" : "them"
    } — this Mac included — until you publish.`,
    p,
  );
}

// ── The header's status line ───────────────────────────────────────────

export type StatusView =
  | { state: "done"; kind: "shared"; branch: string; tail: string }
  | { state: "empty"; kind: "offline"; branch: string; tail: string }
  | { state: "empty"; kind: "branchMissing"; branch: string; tail: string }
  | { state: "empty"; kind: "readOnly"; text: string }
  | { state: "empty"; kind: "local"; text: string };

export interface StatusInput {
  branch: string;
  author: string | null;
  /** Seconds; the commit that last changed the shared definition. */
  changedAt: number | null;
  readOnly: boolean;
  repository: string | null;
  offline: boolean;
  /** F3/F9: origin answered and the branch isn't there. Absent: false. */
  branchMissing?: boolean;
  /** C4 (SC-7): the last publish's sign-in trouble. Absent: none. */
  trouble?: PublishTrouble | null;
  /** No shared definition: the page edits this Mac's own config. */
  local: boolean;
  /** 1.175.0 (C1): with `local`, the branch the shared setup was removed
   *  from, while the person hasn't chosen. Absent: none. */
  removedFrom?: string | null;
  /** WALKFIX-1: the shared file on the branch can't be used now. */
  unreadable?: SetupUnreadable | null;
  /** WALKFIX-3: Share waits in this pull request; nothing is shared yet. */
  sharingWaits?: number | null;
}

export function statusLine(input: StatusInput, nowSecs: number): StatusView {
  // WALKFIX-3 (item 3): never "Rows shared … come from" before Share merged.
  if (!input.local && input.sharingWaits != null) {
    return {
      state: "empty",
      kind: "local",
      text: `${sharingWaitsLine(input.sharingWaits)} Until it merges, these rows are this Mac's own.`,
    };
  }
  // WALKFIX-1 (walk): never "Rows shared … come from" a file that can't be read.
  if (!input.local && input.unreadable) {
    return { state: "empty", kind: "local", text: unreadableSetupLine(input.unreadable, input.branch, true) };
  }
  if (input.local && input.removedFrom) {
    return { state: "empty", kind: "local", text: removedStatusLine(input.removedFrom) };
  }
  if (input.local) {
    return {
      state: "empty",
      kind: "local",
      text: "This repository shares no settings, so these are this Mac's own. Saved as you change them.",
    };
  }
  if (input.readOnly) {
    const where = input.repository ?? "this repository";
    const who = input.author ? ` Ask ${input.author}.` : "";
    return {
      state: "empty",
      kind: "readOnly",
      text: `You can read this page. Changing it needs write access to ${where}.${who}`,
    };
  }
  const by = input.author ? `, last changed by ${input.author}` : "";
  const when = input.changedAt != null ? ` ${ago(nowSecs, input.changedAt)}` : "";
  if (input.branchMissing && !input.offline) {
    return {
      state: "empty",
      kind: "branchMissing",
      branch: input.branch,
      tail: ` isn't on GitHub any more, so Plyloft can't publish to it. Choose where cards go in Settings › Cards › Shipping.`,
    };
  }
  // C4 (SC-7): the three sign-in causes, each said as itself.
  const signIn =
    input.trouble?.kind === "gitSignIn"
      ? "Git couldn't sign in to GitHub"
      : input.trouble?.kind === "ghSignedOut"
        ? "GitHub isn't signed in on this Mac"
        : input.trouble?.kind === "sso"
          ? `${input.trouble.org ? `“${input.trouble.org}”` : "Your organization"} needs you to authorize single sign-on`
          : null;
  if (signIn && !input.offline) {
    return { state: "empty", kind: "offline", branch: input.branch, tail: `. ${signIn}, so Plyloft can't write it right now.` };
  }
  if (input.offline) {
    return {
      state: "empty",
      kind: "offline",
      branch: input.branch,
      tail: `. You're offline, so Plyloft can't read or write it right now.`,
    };
  }
  return { state: "done", kind: "shared", branch: input.branch, tail: `${by}${when}.` };
}

/** BOARDS.md §2 "Read-only": one line under the last group when every field
 *  has the same author and day, and `null` when they differ — the rows then
 *  carry their own hints. */
export function readOnlyFooter(
  order: readonly FieldKey[],
  provenance: Record<string, FieldProvenanceLike> | undefined,
  fallbackAuthor: string | null,
): string | null {
  const seen = order.map((key) => provenance?.[key]).filter(Boolean) as FieldProvenanceLike[];
  if (seen.length === 0) {
    return fallbackAuthor ? `Every setting on this page was set by ${fallbackAuthor}.` : null;
  }
  const authors = new Set(seen.map((p) => p.author));
  const days = new Set(seen.map((p) => formatDay(p.changedAt)));
  if (authors.size !== 1 || days.size !== 1) return null;
  return `Every setting on this page was set by ${[...authors][0]} on ${[...days][0]}.`;
}

/** The hint a read-only row carries when the page's one footer line cannot
 *  speak for every field: who set this one, and when (PATTERNS.md §5). */
export function readOnlyRowLine(set: FieldProvenanceLike | undefined): string | null {
  if (!set) return null;
  return `Set by ${set.author} on ${formatDay(set.changedAt)}.`;
}

// ── The sub-pages ──────────────────────────────────────────────────────

/** A row of the Version files sub-page. A file removed in the draft keeps
 *  its place, struck through, until the change is published (BOARDS.md §6). */
export interface VersionFileRow {
  file: VersionFileEntry;
  removed: boolean;
  /** Its place in the published list, so the order never jumps. */
  index: number;
}

export function versionFileRows(
  published: VersionFileEntry[],
  draft: VersionFileEntry[] | null,
): VersionFileRow[] {
  if (draft == null) return published.map((file, index) => ({ file, removed: false, index }));
  const kept = new Set(draft.map((f) => f.path));
  const rows: VersionFileRow[] = published.map((file, index) => ({
    file,
    removed: !kept.has(file.path),
    index,
  }));
  // Files the draft adds sit after the published ones, in the order added.
  for (const file of draft) {
    if (!published.some((p) => p.path === file.path)) {
      rows.push({ file, removed: false, index: rows.length });
    }
  }
  return rows;
}

/** PATTERNS.md §3: a list gets a filter field above the group once it
 *  passes twelve rows. */
export const FILTER_FROM = 12;

export function needsFilter(rows: number): boolean {
  return rows > FILTER_FROM;
}

/** Rows whose text holds `query`, case and spacing ignored. An empty
 *  query keeps them all, so the filter never hides the list by accident. */
export function matchesFilter(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || text.toLowerCase().includes(needle);
}

/** `npm package · the React app` — the file's kind in words. */
export function versionFileKindWords(file: VersionFileEntry): string {
  switch (file.kind) {
    case "package_json":
      return "npm package";
    case "cargo_toml":
      return "Rust crate";
    case "tauri_conf_json":
      return "Tauri app";
    case "py_project_toml":
      return "Python project";
    case "python_module_var":
      return file.variableName
        ? `Python module · ${file.variableName}`
        : "Python module";
    default:
      return "version file";
  }
}

/**
 * What Ply makes of a path a person chose, by its name alone. `null` when
 * nothing here carries a version Ply can bump from the name.
 *
 * A Python source file is deliberately not one of them (F22): which variable
 * carries the version can only be told by reading the file, and a guess of
 * `version` would publish a file Ship then cannot bump. `Re-detect` adds
 * those, with the name the repository really uses.
 */
export function versionFileFor(path: string): VersionFileEntry | null {
  const name = basename(path);
  if (name === "package.json") return { path, kind: "package_json" };
  if (name === "Cargo.toml") return { path, kind: "cargo_toml" };
  if (name === "tauri.conf.json") return { path, kind: "tauri_conf_json" };
  if (name === "pyproject.toml") return { path, kind: "py_project_toml" };
  return null;
}

/** Why Ply refused a chosen file, in words the row can say. */
export function whyNotAVersionFile(path: string): string {
  const name = basename(path);
  if (name.endsWith(".py")) {
    return `${name} may carry a version in a variable, but only the repository can say which one. Press Re-detect: Plyloft reads the file and adds it with the right name.`;
  }
  return `${name} carries no version number Plyloft knows how to change. Plyloft bumps package.json, Cargo.toml, tauri.conf.json and pyproject.toml, and the Python variables Re-detect finds.`;
}

/**
 * Why Ply would not use this cache path, or `null`. `worktrees.rs`'s
 * `cache_rel_paths` keeps only plain relative paths and drops the rest
 * without a word, so the row refuses them here instead of publishing a
 * value that quietly does nothing.
 */
export function cachePathProblem(path: string): string | null {
  const win = isWindows();
  const clean = path.trim().replace(win ? /[\\/]+$/ : /\/+$/, "");
  if (!clean) return "A path is needed.";
  if (win ? isAbsolutePath(clean) : clean.startsWith("/")) {
    return win
      ? "A cache path is relative to a card's copy, so it can't start with a drive, \\\\ or /."
      : "A cache path is relative to a card's copy, so it can't start with /.";
  }
  // Published for every platform: `/` between its folders, on Windows too.
  if (win && clean.includes("\\")) {
    return "A cache path is shared with every platform, so its folders are separated by /, not \\.";
  }
  if (clean.split("/").some((part) => part === "." || part === ".." || part === "")) {
    return "A cache path names a folder inside a card's copy: no . or .. in it.";
  }
  return null;
}

/** The draft the sub-page writes back: `null` puts the field back as it was. */
export function withoutFile(files: VersionFileEntry[], path: string): VersionFileEntry[] {
  return files.filter((f) => f.path !== path);
}

/**
 * `Put back` (F15): the file returns where the published list has it, so a
 * removal taken back leaves no change behind — appending it would publish an
 * invisible reorder. Files added since keep their place after the published
 * ones.
 */
export function restoreFile(
  current: VersionFileEntry[],
  published: VersionFileEntry[],
  path: string,
): VersionFileEntry[] {
  const back = published.find((f) => f.path === path);
  if (!back || current.some((f) => f.path === path)) return current;
  const place = new Map(published.map((f, i) => [f.path, i]));
  const kept = current.filter((f) => place.has(f.path));
  const added = current.filter((f) => !place.has(f.path));
  const order = [...kept, back].sort(
    (a, b) => (place.get(a.path) ?? 0) - (place.get(b.path) ?? 0),
  );
  return [...order, ...added];
}

// ── The definition a save carries ──────────────────────────────────────

/** The fields this Mac keeps in `config.json`. The rest have homes of their
 *  own: the name and the accent colour are the workspace record's, the
 *  self-check and the checklist classes are `review.json`'s. */
export const CONFIG_FIELDS: FieldKey[] = [
  "integrationBranch",
  "versionFiles",
  "installScript",
  "verifyPipeline",
  "cachePaths",
  "sharedBuildCache",
];

export function isConfigField(key: FieldKey): boolean {
  return CONFIG_FIELDS.includes(key);
}

/** This Mac's config with `next` written onto it — the whole thing, because
 *  `project_config_set` takes a whole config. Fields it does not own are
 *  ignored here and saved by their own owner. */
export function patchConfig(
  config: ProjectConfig,
  next: Partial<Record<FieldKey, unknown>>,
): ProjectConfig {
  const out: ProjectConfig = { ...config };
  for (const key of Object.keys(next) as FieldKey[]) {
    const to = next[key];
    switch (key) {
      case "integrationBranch":
        out.targetBranch = typeof to === "string" && to ? to : config.targetBranch;
        break;
      case "versionFiles":
        out.versionFiles = (to as VersionFileEntry[]) ?? [];
        break;
      case "installScript":
        out.installScript = typeof to === "string" && to ? to : null;
        break;
      case "verifyPipeline":
        out.verifyPipeline = Array.isArray(to) && to.length ? (to as VerifyKind[]) : null;
        break;
      case "cachePaths":
        out.cachePaths = (to as string[]) ?? [];
        break;
      case "sharedBuildCache":
        out.sharedBuildCache = to !== false;
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * The draft after a publish has landed: the keys that call carried go, and
 * anything edited while it was in flight stays. Clearing the whole draft
 * would drop an edit that was never sent (card #94 review, F1, F3).
 */
export function clearSent(draft: Draft, sent: Draft): Draft {
  const kept: Draft = { ...draft };
  for (const key of Object.keys(sent) as FieldKey[]) {
    // Only when the row still holds what was published: edited again since,
    // it is a change of its own and keeps its place.
    if (sameValue(normalise(key, kept[key]), normalise(key, sent[key]))) delete kept[key];
  }
  return kept;
}

/** The draft as `workspace_definition_save` takes it: the definition the
 *  page opened on, plus every changed field. One call, one commit. */
export function savePayload(
  base: WorkspaceDefinition,
  order: readonly FieldKey[],
  values: Values | null,
  draft: Draft,
  /** The repository shares no build settings yet, and this Mac's are what
   *  the page has been showing. */
  firstShare?: {
    fillProject: boolean;
    branch: string;
    /** Try it: this Mac's start command, which travels with the build
     *  settings but has no field on this page (its row saves on its own). */
    tryCommand?: string | null;
  },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  const changed = changedFields(order, values, draft);
  for (const key of changed) {
    out[key] = normalise(key, draft[key]);
  }
  // A definition cannot hold half a project: the backend normalises a
  // partial one with *defaults* and applies it here, which would wipe this
  // Mac's version files and scripts and move its branch. So the first build
  // field published carries the rest of this Mac's with it — the values the
  // page showed and Review named (F36).
  if (firstShare?.fillProject && changed.some((key) => CONFIG_FIELDS.includes(key))) {
    for (const key of CONFIG_FIELDS) {
      if (!changed.includes(key)) out[key] = readField(key, values);
    }
    // One field has to be concrete, or the project part reads as absent and
    // the change is applied nowhere.
    if (out.integrationBranch == null) out.integrationBranch = firstShare.branch;
    // Left out, the first share would apply "no start command" here.
    if (out.tryCommand == null && firstShare.tryCommand) out.tryCommand = firstShare.tryCommand;
  }
  return out;
}

// ── The page's state, derived from what Ply read ──────────────────────

/** The shape `workspace_definition_get` answers with, as much of it as the
 *  derivation reads. Written out so node can build one. */
export interface DefinitionViewLike {
  cache: {
    definition: WorkspaceDefinition | null;
    branch: string | null;
    author: string | null;
    changedAt?: number | null;
    pending: Record<string, unknown>;
    /** C4: where the definition came from (`repo` once read from the
     *  branch). Absent from older test views. */
    source?: string;
    /** C5: the shared setup's branch is gone from GitHub. */
    branchGone?: { branch: string; renamedTo: string | null } | null;
    /** WALKFIX-1: the file on the branch can't be used now. */
    unreadable?: SetupUnreadable | null;
    /** C5: what GitHub said of this account's write access. */
    writeAccess?: { canPush?: boolean | null };
    /** 1.175.0 (C1): the shared setup is gone from this branch and the
     *  person hasn't chosen yet. Absent from older backends. */
    removed?: { branch: string } | null;
  };
  effective: WorkspaceDefinition | null;
  defaultBranch: string;
  queue: {
    createDefinition: boolean;
    fields: Record<string, { pullRequest: { number: number } | null }>;
    createPullRequest: { number: number } | null;
    /** Two-instance walk (C4): GitHub said, at the last read that asked,
     *  that the creation pull request (this number) is open. */
    creationOpen?: number | null;
    lastError: string | null;
    lastOffline?: boolean;
    /** C4: absent from older backends and queues. */
    lastErrorKind?: PublishTrouble | null;
    /** C4 round 2. */
    sharedFirstLeft?: { number: number; url: string; who: string | null; outcome: string } | null;
  };
  readOnly?: boolean;
  provenance?: Record<string, FieldProvenanceLike>;
  /** 1.173.0 (C3): fields both sides changed, waiting for a choice. */
  conflicts?: { field: string; label: string }[];
}

export interface ProjectConfigLike {
  targetBranch: string;
  versionFiles: VersionFileEntry[];
  installScript?: string | null;
  verifyPipeline?: VerifyKind[] | null;
  cachePaths?: string[];
  sharedBuildCache?: boolean;
}

export interface WorkspaceLike {
  name: string;
  accentColor?: string | null;
  kanbanSyncMode?: "local" | "githubIssues";
  githubOwnerRepo?: string | null;
}

export interface DerivedRepository {
  /** 1.175.0 (C1): the branch the shared setup was removed from, until the
   *  person chooses in Project › General; null otherwise. */
  removedFrom: string | null;
  /** WALKFIX-1: the shared file can't be used now (the status line says so). */
  unreadable: SetupUnreadable | null;
  /** WALKFIX-3: Share waits in this pull request (number); null otherwise. */
  sharingWaits: number | null;
  shared: boolean;
  /** The shared definition carries build settings of its own. */
  sharedProject: boolean;
  readOnly: boolean;
  branch: string;
  repository: string | null;
  author: string | null;
  changedAt: number | null;
  board: "local" | "githubIssues";
  boardRepository: string | null;
  values: Values;
  repositoryValues: Values | null;
  pending: PendingLike | null;
  publishing: PendingPublish | null;
  provenance: Record<string, FieldProvenanceLike> | undefined;
  definition: WorkspaceDefinition | null;
}

/** Every field the page knows about, in the order it numbers them. */
const ALL_FIELDS: FieldKey[] = [...BUILD_FIELDS, ...GENERAL_FIELDS, ...AREA_FIELDS, ...SHIPPING_FIELDS];

/** Shared fields the page draws as rows of their own, saved through their
 *  own call rather than the draft (Try it's `tryCommand`): never numbered or
 *  published from here, but a queued change of one is still on its way. */
export const OWN_ROW_FIELDS = ["tryCommand"] as const;

function fromDefinition(def: WorkspaceDefinition | null): Values {
  if (!def) return {};
  const out: Values = {};
  for (const key of ALL_FIELDS) out[key] = (def as Record<string, unknown>)[key] ?? null;
  return out;
}

/** `WorkspaceDefinition::has_project`: it carries build settings, rather
 *  than only a name, a board and a review. */
export function hasProject(def: WorkspaceDefinition | null): boolean {
  if (!def) return false;
  return CONFIG_FIELDS.some((key) => (def as Record<string, unknown>)[key] != null);
}

/** This Mac's own settings under the shared definition's field names. */
export function fromLocal(
  config: ProjectConfigLike | null,
  review: { selfCheck: boolean; reviewChecklist: ReviewChecklistClass[] } | null,
  workspace: WorkspaceLike | null,
  worktree: WorktreeLike | null = null,
  /** 1.173.0 (G1): this Mac's own default release kind (`areas.json`). */
  releaseKind: string | null = null,
): Values {
  return {
    integrationBranch: config?.targetBranch ?? null,
    verifyPipeline: config?.verifyPipeline ?? null,
    installScript: config?.installScript ?? null,
    versionFiles: config?.versionFiles ?? null,
    cachePaths: config?.cachePaths ?? null,
    sharedBuildCache: config?.sharedBuildCache ?? true,
    selfCheck: review?.selfCheck ?? true,
    reviewChecklist: review?.reviewChecklist ?? null,
    worktreeCopy: worktree?.worktreeCopy ?? null,
    worktreeSetup: worktree?.worktreeSetup ?? null,
    name: workspace?.name ?? "",
    accentColor: workspace?.accentColor ?? null,
    // 1.173.0 (B1): areas live only in the repository's definition.
    areas: null,
    releaseKind: asReleaseKind(releaseKind),
  };
}

/** SL-4: the worktree settings this Mac runs with (`worktree_setup.json`). */
export interface WorktreeLike {
  worktreeCopy?: string[] | null;
  worktreeSetup?: string | null;
  /** The setup command this Mac agreed to run; never shared. */
  approvedSetup?: string | null;
}

/** F7 (SL-4 walk): the Setup command row's hint when the command in use —
 *  a teammate's, or one this Mac never saw — hasn't been allowed here: it
 *  doesn't run until a card's Allow and run. `shown` is the command the row
 *  shows; `null` when there is nothing to add. */
export function setupApprovalNote(worktree: WorktreeLike | null | undefined, shown: string): string | null {
  const inUse = worktree?.worktreeSetup?.trim();
  if (!inUse || shown.trim() !== inUse) return null;
  if (worktree?.approvedSetup?.trim() === inUse) return null;
  return "It hasn't been allowed on this Mac yet: the first card that needs it asks you (Allow and run) before it runs.";
}

/** The fields that are the definition's whatever else it carries. */
function generalOf(def: WorkspaceDefinition | null): Values {
  return {
    selfCheck: def?.selfCheck ?? null,
    reviewChecklist: def?.reviewChecklist ?? null,
    worktreeCopy: def?.worktreeCopy ?? null,
    worktreeSetup: def?.worktreeSetup ?? null,
    name: def?.name ?? "",
    accentColor: def?.accentColor ?? null,
    areas: def?.areas ?? null,
    releaseKind: def?.releaseKind ?? null,
  };
}

/**
 * What the two Repository pages show, from what Ply read. Pure, so the
 * cases that only happen once in a while — a queue left offline since a
 * previous launch, a board the licence gate holds local, a definition with
 * no build settings — are tested rather than hoped for (F38).
 */
export function deriveRepository(input: {
  view: DefinitionViewLike | null;
  config: ProjectConfigLike | null;
  review: { selfCheck: boolean; reviewChecklist: ReviewChecklistClass[] } | null;
  workspace: WorkspaceLike | null;
  /** SL-4: this Mac's worktree settings; absent reads as none. */
  worktree?: WorktreeLike | null;
  /** 1.173.0 (G1): this Mac's own default release kind; absent reads as none. */
  releaseKind?: string | null;
  /** What the refresh Ply watched said, when it watched one. */
  offlineNow?: boolean | null;
}): DerivedRepository {
  const { view, config, review, workspace } = input;
  const worktree = input.worktree ?? null;
  const shared = !!view && view.effective != null;
  const definition = shared ? view!.effective : null;
  const sharedProject = hasProject(definition);
  const queue = view?.queue ?? null;
  const queued = shared
    ? [...ALL_FIELDS, ...OWN_ROW_FIELDS].filter((key) => key in view!.cache.pending)
    : [];
  const waitingPr =
    (queue && Object.values(queue.fields).find((f) => f.pullRequest)?.pullRequest) ??
    queue?.createPullRequest ??
    null;
  // C5 (SC-8): GitHub said this account can't push here.
  const repoName = definition?.githubOwnerRepo ?? workspace?.githubOwnerRepo ?? "this repository";
  // Two-instance walk: the page's own rule (`WriteAccess::read_only`: GitHub
  // said no push, or a push was refused with no pull request to carry it) —
  // the bar offers "Use the team's values…" whenever the page says read-only.
  const cantPush =
    shared && (view!.cache.writeAccess?.canPush === false || !!view!.readOnly) && queued.length > 0;

  return {
    removedFrom: shared ? null : view?.cache.removed?.branch ?? null,
    unreadable: shared ? view!.cache.unreadable ?? null : null,
    sharingWaits: shared && view!.cache.source === "seeded" ? (queue?.createPullRequest?.number ?? null) : null,
    shared,
    sharedProject,
    readOnly: shared && !!view!.readOnly,
    // Shared: the branch the definition was read from. Local: the branch
    // this Mac's config already ships to, else the repository's default.
    branch:
      (shared ? view!.cache.branch : config?.targetBranch) ?? view?.defaultBranch ?? "main",
    repository: definition?.githubOwnerRepo ?? workspace?.githubOwnerRepo ?? null,
    author: shared ? view!.cache.author : null,
    changedAt: shared ? view!.cache.changedAt ?? null : null,
    // The backing this Mac really applied, not the one the repository asks
    // for: a licence gate can hold the board local.
    board: workspace?.kanbanSyncMode === "githubIssues" ? "githubIssues" : "local",
    boardRepository: workspace?.githubOwnerRepo ?? null,
    // The definition's build settings, or — when it carries none — this
    // Mac's own, which are what it runs and what publishing one of them
    // would share.
    values: shared
      ? sharedProject
        ? fromDefinition(definition)
        : { ...fromLocal(config, review, workspace, worktree, input.releaseKind ?? null), ...generalOf(definition) }
      : fromLocal(config, review, workspace, worktree, input.releaseKind ?? null),
    repositoryValues: shared ? fromDefinition(view!.cache.definition) : null,
    pending: shared
      ? {
          fields: view!.cache.pending,
          pullRequests: Object.fromEntries(
            Object.entries(view!.queue.fields)
              .filter(([, f]) => f.pullRequest)
              .map(([key, f]) => [key, f.pullRequest!.number]),
          ),
          repository: fromDefinition(view!.cache.definition),
          choosing: (view!.conflicts ?? []).map((c) => c.field),
          cantWrite: cantPush ? repoName : null,
        }
      : null,
    publishing: queue
      ? {
          queued,
          creating: queue.createDefinition,
          pullRequest: waitingPr?.number ?? null,
          // A refresh Ply watched knows best; without one, the queue
          // remembers how the last attempt went (F19).
          offline: input.offlineNow ?? queue.lastOffline ?? false,
          lastError: queue.lastError,
          choosing: (view?.conflicts ?? []).map((c) => ({ field: c.field, label: c.label })),
          trouble: queue.lastErrorKind ?? null,
          // C4 (SC-4): the creation pull request waited on, with the setup
          // already read from the branch — someone else's share came first.
          // Two-instance walk: only while GitHub said this computer's own
          // creation pull request is still open — the setup on the branch is
          // then somebody else's; never its own pull request that merged.
          sharedFirst:
            queue.createPullRequest &&
            waitingPr?.number === queue.createPullRequest.number &&
            queue.creationOpen === queue.createPullRequest.number &&
            view?.cache.source === "repo"
              ? { who: view.cache.author ?? null }
              : null,
          branchGone: view?.cache.branchGone ?? null,
          sharedFirstLeft: queue.sharedFirstLeft ?? null,
          cantWrite: cantPush
            ? { labels: queued.map((k) => rowLabel(k as FieldKey)), repository: repoName, author: view!.cache.author ?? null }
            : null,
        }
      : null,
    provenance: view?.provenance,
    definition,
  };
}

// ── 1.175.0 (C5, SC-8): "Use the team's values…" ───────────────────────

/** The sheet: focus on "Not now"; one line per change, this Mac's value
 *  beside the team's. */
export function teamValuesSheet(
  keys: readonly string[],
  mine: Values | null,
  team: Values | null,
  repository: string,
): { title: string; body: string; items: string[]; confirmLabel: string; cancelLabel: string; focusCancel: true } {
  const n = keys.length;
  return {
    title: "Use the team's values on this Mac?",
    body: `Your ${changeWord(n)} can't be published without write access to ${repository}. Using the team's values drops ${n === 1 ? "it" : "them"} from this Mac.`,
    items: keys.map((key) => {
      const k = key as FieldKey;
      return `${rowLabel(k)} — ${valueText(k, readField(k, mine))} on this Mac · ${valueText(k, readField(k, team))} for the team`;
    }),
    confirmLabel: "Use the team's values",
    cancelLabel: "Not now",
    focusCancel: true,
  };
}

/** The toast after it. */
export function teamValuesToast(dropped: readonly string[]): { title: string; body: string } {
  const quoted = dropped.map((label) => quotedLabel(label));
  return {
    title: "This Mac uses the team's values",
    body:
      quoted.length === 1
        ? `Your change to ${quoted[0]} was dropped.`
        : `Your changes to ${listWords(quoted)} were dropped.`,
  };
}
