// 1.173.0 (B5): Settings › This repository › Areas (mockup areas.html scene
// 3) — the edits of the list, the words of each row, and what is saved.
//
// Pure: no React, no store, no IPC. Every edit goes through `withPrefixes`,
// so what is published names each area's tag prefix explicitly (B1): moving
// an area never retags its releases.

import type { AreaCheck, AreaDef, AreaRelease, AreasView, ResolvedArea, VersionFileEntry, VersionFileKind } from "../ipc";

export const AREAS_TITLE = "Areas";
// 1.174.0 (DS6, settings.html scenes 9–10): the project's words, the nav's.
export const AREAS_LEDE = "Parts of this project that ship on their own. Each card belongs to one area.";
export const SUGGEST_AREAS = "Suggest areas from this project";
/** DS6 (SL-13): the list's section, and the sub-page's way back. */
export const AREAS_SECTION = "Areas";
export const EDIT_AREA = "Edit…";
export const OPEN_SHIPPING = "Open Shipping";
export const ADD_AREA = "Add an area";
// 1.174.0 (C10, D6; mockup areas.html §1, §1b, §3, §4, the rule table):
// on a project whose setup isn't shared, the page works and saves here; the
// areas decide on this Mac until the person shares the setup. Raw "this
// Mac": callers pass these through `machineWords`.
/** The status line where Share is offered (with *Share it…*). */
export const KEPT_UNTIL_SHARED = "Kept on this Mac until you share this project's setup.";
/** Solo, or without GitHub: there is nowhere to share. */
export const KEPT_HERE_ONLY = "Kept on this Mac only.";
export const SAVE_HERE = "Save";
/** C10 round 0 (owner): leaving the page with an unsaved draft. */
export const LEAVE_UNSAVED_AREAS = "Leave without saving your areas?";
/** Beside Share the setup while a draft is unsaved (C10 round 1). */
export const SAVE_AREAS_FIRST = "Save your areas first.";
/** The bar's detail after a refused save: the error block above says it. */
export const NOT_SAVED_SEE_ABOVE = "Not saved; see above.";
export const SAVING_HERE = "Saving…";

/** The bar under a draft of a project that shares nothing (§1b). */
export function keptBarSentence(count: number, shareable: boolean): string {
  const n = `${count} ${count === 1 ? "change" : "changes"}`;
  return shareable ? `${n} · stays on this Mac until you share this project's setup` : `${n} · stays on this Mac only`;
}

/** §3: the two-products notice's extra sentence where nothing is shared. */
export function noticeKeptLine(shareable: boolean): string {
  return shareable ? "They're kept on this Mac until you share this project's setup." : "They're kept on this Mac only.";
}

/** "A", "A and B", "A, B and C". */
function andWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** §4a: the Share question's extra line — the areas kept here go with it. */
export function sharesAreasLine(view: AreasView | null | undefined): string | null {
  if (!view || view.shared || !view.keptHere || view.areas.length === 0) return null;
  return `Also shares the areas kept on this Mac: ${view.areas.map((a) => areaTitle(a)).join(", ")}.`;
}

/** §4b: the sheet when the repository already has areas. */
export const AREAS_CHOICE_TITLE = "The repository already has areas";

/** Round 1 (owner): what the repository's setup came in with — other areas,
 *  none, or a list that can't be used. */
export type AreasChoiceKind = "different" | "empty" | "broken";

export function areasChoiceKind(view: Pick<AreasView, "areas" | "problem">): AreasChoiceKind {
  if (view.problem) return "broken";
  return view.areas.length ? "different" : "empty";
}

export function areasChoiceTitle(kind: AreasChoiceKind): string {
  switch (kind) {
    case "empty":
      return "The repository's setup has no areas";
    case "broken":
      return "The repository's areas can't be used";
    default:
      return AREAS_CHOICE_TITLE;
  }
}
export const USE_THE_REPOSITORY_S = "Use the repository's";
export const PUBLISH_MINE = "Publish mine";

/** "App (cards go to staging)", "Web (web/)", "App": the folder of an area
 *  in its own folder, the branch of a root area that has its own. */
function choiceArea(area: ResolvedArea): string {
  const name = areaTitle(area);
  if (!area.root && area.path) return `${name} (${area.path.replace(/\\/g, "/").replace(/\/+$/, "")}/)`;
  if (area.targetBranch) return `${name} (cards go to ${area.targetBranch})`;
  return name;
}

/** "On GitHub: App (cards go to staging) and Web (web/). Kept on this Mac:
 *  App and Site (site/)." */
export function areasChoiceLede(
  theirs: readonly ResolvedArea[],
  mine: readonly ResolvedArea[],
  kind: AreasChoiceKind = theirs.length ? "different" : "empty",
): string {
  const kept = `Kept on this Mac: ${andWords(mine.map(choiceArea))}.`;
  if (kind === "broken") return `On GitHub the areas list can't be read. ${kept}`;
  if (kind === "empty") return `On GitHub: no areas. ${kept}`;
  return `On GitHub: ${andWords(theirs.map(choiceArea))}. ${kept}`;
}

/** What each answer does; a computer that can't publish is offered only
 *  the first (round 1). With no areas in the repository's setup there is
 *  nothing to follow: this Mac works without areas. */
export function areasChoiceBody(
  mine: readonly ResolvedArea[],
  canPublish = true,
  kind: AreasChoiceKind = "different",
): string {
  const yours = `your ${andWords(mine.map((a) => areaTitle(a)))} ${mine.length === 1 ? "is" : "are"} set aside on this Mac, not deleted.`;
  const theirs =
    kind === "empty"
      ? `Use the repository's: this Mac works without areas; ${yours}`
      : `Use the repository's: this Mac follows them; ${yours}`;
  return canPublish
    ? `${theirs} Publish mine: your list replaces theirs for everyone, as a change you can see on GitHub.`
    : theirs;
}
export const NO_AREAS =
  "This project ships as one product. Add an area for each part that ships on its own, or let Plyloft suggest them.";
export const NOTHING_TO_SUGGEST =
  "Plyloft found one product in this repository: nothing to suggest. Add areas yourself if parts of it ship on their own.";
export const NOTHING_NEW_TO_SUGGEST =
  "Every product Plyloft found already has its area here: nothing to add.";
export const CHOOSE_FOLDER = "Choose the folder this product lives in.";

/** Why a new area's id isn't its name's: an area removed in this draft had
 *  it, and its cards keep it. */
export function reservedIdWords(wanted: string, id: string): string {
  return `“${wanted}” belonged to an area removed here, and its cards still carry it, so this one is “${id}”.`;
}

/** An area's id from its name: lowercase letters, digits and dashes. */
export function slugId(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** B1's default: "" for the first area (vX.Y.Z), `<id>-` for the others. */
export function autoPrefix(index: number, id: string): string {
  return index === 0 ? "" : `${id}-`;
}

/**
 * Every area with its tag prefix written out: its own when it has one, the
 * one the repository resolved for a published area (its tags so far), else
 * B1's default for its place now.
 */
export function withPrefixes(list: readonly AreaDef[], published: readonly ResolvedArea[]): AreaDef[] {
  return list.map((area, index) => {
    if (area.tagPrefix != null) return area;
    const known = published.find((p) => p.id === area.id);
    return { ...area, tagPrefix: known ? known.tagPrefix : autoPrefix(index, area.id) };
  });
}

function uniqueId(
  base: string,
  list: readonly AreaDef[],
  except: number,
  reserved: ReadonlySet<string> = new Set(),
): string {
  const taken = new Set([...list.filter((_, i) => i !== except).map((a) => a.id), ...reserved]);
  const start = base || "area";
  let id = start;
  for (let n = 2; taken.has(id); n++) id = `${start}-${n}`;
  return id;
}

/** *Add an area*: a new one at the end, named for the person to change. Its
 *  id is never one the repository published (`reserved`): cards of a
 *  removed area keep theirs. Its folder is "" until chosen (the page says
 *  so rather than reading it as the whole repository). */
export function addArea(list: readonly AreaDef[], reserved: ReadonlySet<string> = new Set()): AreaDef[] {
  const id = uniqueId("new-area", list, -1, reserved);
  const area: AreaDef = { id, name: "New area", path: "", label: `area:${id}`, tagPrefix: autoPrefix(list.length, id) };
  return [...list, area];
}

export function removeArea(list: readonly AreaDef[], index: number): AreaDef[] {
  return list.filter((_, i) => i !== index);
}

/** One field of one area. */
export function setField(list: readonly AreaDef[], index: number, patch: Partial<AreaDef>): AreaDef[] {
  return list.map((a, i) => (i === index ? { ...a, ...patch } : a));
}

/**
 * A new name. An area not yet published takes its id from it (and its
 * default label and tag prefix with it, while they are still the defaults);
 * a published one keeps its id — cards carry it.
 */
export function renameArea(
  list: readonly AreaDef[],
  index: number,
  name: string,
  publishedIds: ReadonlySet<string>,
): AreaDef[] {
  const area = list[index];
  if (!area) return [...list];
  if (publishedIds.has(area.id)) return setField(list, index, { name });
  const id = uniqueId(slugId(name), list, index, publishedIds);
  const label = followsDefaultLabel(area.label, area.id) ? defaultAreaLabel(id) : area.label;
  const tagPrefix =
    area.tagPrefix == null || area.tagPrefix === autoPrefix(index, area.id) ? autoPrefix(index, id) : area.tagPrefix;
  return setField(list, index, { name, id, label, tagPrefix });
}

/** An area's default board label, `area:<id>` (`areas::default_label`). */
function defaultAreaLabel(id: string): string {
  return `area:${id}`;
}

/** The area's label is its id's default (or unset), so it follows a new id.
 *  A label is the area's data, never a card's visible state. */
function followsDefaultLabel(label: string | null | undefined, id: string): boolean {
  return label == null || label === defaultAreaLabel(id);
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").map((p) => p.trim()).filter((p) => p && p !== ".").join("/");
}

/**
 * *Suggest areas from this repository* (and the Board's *Set up areas…*):
 * the suggested areas whose folder no area here has yet, added after the
 * list as it is — the areas already here are left exactly as they are. An
 * added area's id is unique against the list and the published ids, its
 * default label and tag prefix follow it.
 */
export function mergeSuggestion(
  list: readonly AreaDef[],
  suggestion: readonly AreaDef[],
  reserved: ReadonlySet<string> = new Set(),
): { list: AreaDef[]; added: number } {
  const next = [...list];
  let added = 0;
  for (const s of suggestion) {
    const folder = normalizedPath(s.path ?? "");
    if (next.some((a) => normalizedPath(a.path ?? "") === folder)) continue;
    const index = next.length;
    const id = uniqueId(s.id, next, -1, reserved);
    const label = followsDefaultLabel(s.label, s.id) ? defaultAreaLabel(id) : s.label;
    const wasDefault = s.tagPrefix == null || s.tagPrefix === "" || s.tagPrefix === `${s.id}-`;
    const tagPrefix = wasDefault ? autoPrefix(index, id) : s.tagPrefix;
    next.push({ ...s, id, label, tagPrefix });
    added += 1;
  }
  return { list: next, added };
}

/** The kind of a version file, from its name. */
export function versionKind(path: string): VersionFileKind {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name === "cargo.toml") return "cargo_toml";
  if (name === "pyproject.toml") return "py_project_toml";
  if (name === "tauri.conf.json") return "tauri_conf_json";
  if (name.endsWith(".py")) return "python_module_var";
  return "package_json";
}

export function versionFilesText(files: readonly VersionFileEntry[] | null | undefined): string {
  return (files ?? []).map((f) => f.path).join(", ");
}

/** "frontend/package.json, main.py" → entries; a file already listed keeps
 *  its entry (a Python file's variable). Empty → none of its own. */
export function parseVersionFiles(
  text: string,
  existing: readonly VersionFileEntry[] | null | undefined,
): VersionFileEntry[] | null {
  const paths = text
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paths.length === 0) return null;
  return paths.map((path) => {
    const known = existing?.find((f) => f.path === path);
    if (known) return known;
    const kind = versionKind(path);
    return kind === "python_module_var" ? { path, kind, variableName: "version" } : { path, kind };
  });
}

/** The messages of the check about one field of one area (`field` as B1's
 *  `areas::check` names it). */
export function problemsFor(check: AreaCheck | null, id: string, fields: readonly string[]): { errors: string[]; warnings: string[] } {
  const match = (p: { area: string | null; field: string }) => p.area === id && fields.includes(p.field);
  return {
    errors: (check?.errors ?? []).filter(match).map((p) => p.message),
    warnings: (check?.warnings ?? []).filter(match).map((p) => p.message),
  };
}

/** What the check says about the list as a whole. */
export function listProblems(check: AreaCheck | null): { errors: string[]; warnings: string[] } {
  return {
    errors: (check?.errors ?? []).filter((p) => p.area == null).map((p) => p.message),
    warnings: (check?.warnings ?? []).filter((p) => p.area == null).map((p) => p.message),
  };
}

export function areaTitle(area: Pick<AreaDef, "id" | "name">): string {
  return area.name?.trim() || area.id;
}

/** 1.174.0 (C12, AR-4; areas.html §2, §5): an area's tags in true words —
 *  "releases tagged v1.300.1 (last)", the area's latest real tag read from
 *  the repository (`areasReleases`, `ship::tag_version`) while its prefix is
 *  unchanged here; else "no release tagged yet; its tags will start with
 *  site-v" (never "vX.Y.Z"). */
export function tagWords(prefix: string, release?: Pick<AreaRelease, "tagPrefix" | "latestTag"> | null): string {
  const latest = release?.latestTag && release.tagPrefix === prefix ? release.latestTag : null;
  return latest ? `releases tagged ${latest} (last)` : `no release tagged yet; its tags will start with ${prefix}v`;
}

/** 1.173.0 (B4 follow-up): " · now 3.0.1" beside an area's version files —
 *  only for a published area whose files are the ones published (not while
 *  they are being changed in this draft) and whose version was read. */
export function versionNowWords(
  release: Pick<AreaRelease, "version"> | null | undefined,
  draftFiles: readonly VersionFileEntry[] | null | undefined,
  publishedFiles: readonly VersionFileEntry[] | null | undefined,
): string {
  if (!release?.version) return "";
  return versionFilesText(draftFiles) === versionFilesText(publishedFiles) ? ` · now ${release.version}` : "";
}

export function folderWords(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return p ? `${p}/` : "the whole project, except the other areas' folders";
}

// One line under each row (scene 3).
// 1.174.0 (DS6, scene 10): the area's sub-page.
export const HINT = {
  name: "What the area picker and the cards call it.",
  path: "From the top of the project. Empty: the whole project, except the other areas' folders.",
  targetBranch: "The branch this area's cards go to.",
  versionFiles: "The files whose version this area's releases change. Empty: the project's own.",
  label: "The label its cards carry on a board of GitHub issues.",
  /** "Its releases are tagged site-v1.2.3." */
  tagPrefix: (prefix: string) => `Its releases are tagged ${prefix}v1.2.3.`,
  lookAt: "The address the area's change shows up at.",
  /** "Put the version on GitHub — set in Shipping." */
  releaseKind: (kind: string) => `${kind} — set in Shipping.`,
} as const;

/** An address as a row says it: no scheme, no trailing slash. */
function addressWords(url: string): string {
  return url.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/**
 * DS6 (scene 9) with C12's tag words: the one line under an area's name in
 * the list — "whole project · cards go to staging · releases tagged v1.300.1
 * (last)", "site/ · cards go to main · no release tagged yet; its tags will
 * start with site-v · www.lyrappc.com".
 */
export function areaSummary(
  area: Pick<AreaDef, "path" | "targetBranch" | "lookAt">,
  prefix: string,
  workspaceBranch: string,
  release?: Pick<AreaRelease, "tagPrefix" | "latestTag"> | null | "reading",
): string {
  const path = normalizedPath(area.path ?? "");
  const parts = [
    path ? `${path}/` : "whole project",
    `cards go to ${area.targetBranch?.trim() || workspaceBranch || "the project's branch"}`,
  ];
  // C12 (AR-4): the real tag, or that there is none yet — said once the
  // tags are read (G2 walk: never "no release tagged yet" before).
  if (release !== "reading") parts.push(tagWords(prefix, release));
  if (area.lookAt?.trim()) parts.push(addressWords(area.lookAt));
  return parts.join(" · ");
}

/** DS6 with C10 (areas.html §1b): on a project whose setup isn't shared,
 *  the row of an area changed in the draft says so — "Changed here, not
 *  saved yet — there was no Site before." for a new one. `null`: unchanged.
 *  `saved` has its tag prefixes written out, as every edit writes them. */
export function keptRowChange(area: AreaDef, saved: readonly AreaDef[]): string | null {
  const was = saved.find((a) => a.id === area.id);
  if (!was) return `Changed here, not saved yet — there was no ${areaTitle(area)} before.`;
  return JSON.stringify(was) === JSON.stringify(area) ? null : "Changed here, not saved yet.";
}

/** DS6 (scene 10): the area's sub-page head — "Site", "site/ · one of 2
 *  areas", back to Areas. */
export function areaSubPage(list: readonly AreaDef[], index: number): { title: string; lede: string; back: string } {
  const area = list[index];
  const path = normalizedPath(area?.path ?? "");
  return {
    title: area ? areaTitle(area) : AREAS_SECTION,
    lede: `${path ? `${path}/` : "whole project"} · one of ${list.length} ${list.length === 1 ? "area" : "areas"}`,
    back: AREAS_SECTION,
  };
}

/** The sub-page id of the area at `index` (`area-0`), and back. */
export function areaSubId(index: number): string {
  return `area-${index}`;
}
export function areaSubIndex(sub: string | null | undefined): number | null {
  const m = /^area-(\d+)$/.exec(sub ?? "");
  return m ? Number(m[1]) : null;
}

/** The page's line when the repository's areas can't be used (B1's
 *  `problem`): held — nothing can start, ship or release — or kept. */
export function pageProblem(view: AreasView | null | undefined): { held: boolean; text: string } | null {
  if (!view?.problem) return null;
  const problem = view.problem.trim().replace(/[.\s]+$/, "");
  return view.held
    ? {
        held: true,
        text: `This repository's areas can't be used: ${problem}. No card can start, ship or release until a list that keeps the rules is published here.`,
      }
    : {
        held: false,
        text: `The areas published last can't be used: ${problem}. This Mac keeps using the ones it had until they're fixed here.`,
      };
}

/** The areas the page edits: the draft's, else the repository's (a list
 *  that isn't one reads as none). */
export function areaList(value: unknown): AreaDef[] {
  return Array.isArray(value) ? (value as AreaDef[]).filter((a) => a && typeof a === "object") : [];
}

// ── 1.174.0 (C11, P15; mockup next-improvement.html §5) ───────────────
// The sheet at the first save of two or more areas, when a direction was
// written for the whole project before it had areas.

/** The first words of an answer, quoted in the lede ("Italian and English
 *  PPC agencies…"): whole when short, else cut at a word with "…". */
export function directionQuote(text: string, max = 40): string {
  const line = text.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 4);
  const at = cut.lastIndexOf(" ");
  return `${(at > 10 ? cut.slice(0, at) : cut).replace(/[,;:\s]+$/, "")}…`;
}

/** "Use the project's direction for App and Site?" */
export function adoptDirectionTitle(names: readonly string[]): string {
  return `Use the project's direction for ${andWords(names)}?`;
}

/** "You wrote a direction for the whole project before it had areas:
 *  “Italian and English PPC agencies…”, with 5 ideas not to propose again." */
export function adoptDirectionLede(direction: { audience: string; better: string; rejected: readonly unknown[] }): string {
  const said = direction.audience.trim() || direction.better.trim();
  const quote = said ? `: “${directionQuote(said)}”` : "";
  const n = direction.rejected.length;
  const list = n === 0 ? "" : `, with ${n === 1 ? "1 idea" : `${n} ideas`} not to propose again`;
  return `You wrote a direction for the whole project before it had areas${quote}${list}.`;
}

export const ADOPT_DIRECTION_HINT =
  "Each area gets its own copy, which you can change on its own. Start fresh: each area asks for its direction the first time.";
export const START_FRESH = "Start fresh";

/** "Use it for both"; one area: "Use it for Site"; more: "Use it for all 3". */
export function useItForAreas(names: readonly string[]): string {
  if (names.length === 1) return `Use it for ${names[0]}`;
  if (names.length === 2) return "Use it for both";
  return `Use it for all ${names.length}`;
}

/** The save reached two or more areas from fewer: the sheet's moment. */
export function firstSaveOfAreas(before: number, after: number): boolean {
  return before < 2 && after >= 2;
}
