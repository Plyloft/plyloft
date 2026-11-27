// 1.173.0 (B5): Settings › Areas' edits and words. Run with:
//
//     node --experimental-strip-types src/lib/areasPage.test.ts

import assert from "node:assert/strict";
import type { AreaDef, AreasView, ResolvedArea } from "../ipc";
import {
  KEPT_HERE_ONLY,
  areaSubIndex,
  areaSubPage,
  areaSummary,
  keptRowChange,
  KEPT_UNTIL_SHARED,
  areasChoiceBody,
  areasChoiceKind,
  areasChoiceLede,
  areasChoiceTitle,
  keptBarSentence,
  noticeKeptLine,
  sharesAreasLine,
  addArea,
  versionNowWords,
  tagWords,
  autoPrefix,
  folderWords,
  mergeSuggestion,
  reservedIdWords,
  pageProblem,
  parseVersionFiles,
  problemsFor,
  renameArea,
  slugId,
  versionKind,
  withPrefixes,
} from "./areasPage.ts";

assert.equal(slugId("Docs site"), "docs-site");
assert.equal(slugId("  Ünïcode & Co!  "), "unicode-co");
assert.equal(slugId("---"), "");
assert.equal(autoPrefix(0, "app"), "");
assert.equal(autoPrefix(2, "site"), "site-");

// Every prefix written out: its own, the one it was published with, else
// the default for its place.
const published = [{ id: "site", tagPrefix: "site-" }] as ResolvedArea[];
const list: AreaDef[] = [
  { id: "site", name: "Site", path: "site" },
  { id: "app", name: "App", path: "" },
  { id: "docs", name: "Docs", path: "docs", tagPrefix: "handbook-" },
];
assert.deepEqual(
  withPrefixes(list, published).map((a) => a.tagPrefix),
  ["site-", "app-", "handbook-"],
  "Site moved first keeps site-; nothing is retagged",
);

// Add, and a new area's id follows its name; a published one's doesn't.
const added = addArea([{ id: "app", name: "App", path: "" }]);
assert.deepEqual(added[1], { id: "new-area", name: "New area", path: "", label: "area:new-area", tagPrefix: "new-area-" });
const renamed = renameArea(added, 1, "Site", new Set(["app"]));
assert.deepEqual([renamed[1].id, renamed[1].label, renamed[1].tagPrefix], ["site", "area:site", "site-"]);
const custom = renameArea([{ ...added[1], label: "web" }, added[0]], 0, "Web", new Set());
assert.equal(custom[0].label, "web", "a label the person typed stays");
assert.equal(renameArea(renamed, 0, "Product", new Set(["app"]))[0].id, "app", "cards keep a published id");
assert.equal(renameArea([...renamed, { id: "site-2", name: "x", path: "" }], 2, "Site", new Set()) [2].id, "site-2");

// A removed published area's id is never taken by a new one.
assert.equal(addArea([], new Set(["new-area"]))[0].id, "new-area-2");
assert.equal(renameArea(addArea([]), 0, "Site", new Set(["site"]))[0].id, "site-2", "site belonged to a removed area");
assert.match(reservedIdWords("site", "site-2"), /“site” belonged to an area removed here.*“site-2”/);

// A suggestion merged in: the areas here are left as they are; only folders
// no area has yet are added, with ids unique against the list.
const here: AreaDef[] = [
  { id: "app", name: "App", path: "", tagPrefix: "" },
  { id: "site", name: "Website", path: "lyrappc-astro/", tagPrefix: "web-" },
];
const suggested: AreaDef[] = [
  { id: "app", name: "App", path: "", label: "area:app", tagPrefix: "" },
  { id: "site", name: "Site", path: "lyrappc-astro", label: "area:site", tagPrefix: "site-" },
  { id: "site", name: "Site", path: "docs-site", label: "area:site", tagPrefix: "site-" },
];
const merged = mergeSuggestion(here, suggested, new Set(["app", "site"]));
assert.equal(merged.added, 1);
assert.deepEqual(merged.list.slice(0, 2), here, "both areas here untouched");
assert.deepEqual(
  [merged.list[2].id, merged.list[2].path, merged.list[2].label, merged.list[2].tagPrefix],
  ["site-2", "docs-site", "area:site-2", "site-2-"],
);
assert.deepEqual(mergeSuggestion(here, suggested.slice(0, 2)), { list: here, added: 0 }, "nothing new");
const onlyApp = mergeSuggestion([here[0]], suggested.slice(0, 2));
assert.deepEqual(onlyApp.list.map((a) => [a.id, a.tagPrefix]), [["app", ""], ["site", "site-"]]);
const intoEmpty = mergeSuggestion([], suggested.slice(0, 2));
assert.deepEqual(intoEmpty.list.map((a) => [a.id, a.tagPrefix]), [["app", ""], ["site", "site-"]]);

// Version files typed as text.
assert.equal(versionKind("x/Cargo.toml"), "cargo_toml");
assert.equal(versionKind("pyproject.toml"), "py_project_toml");
assert.equal(versionKind("main.py"), "python_module_var");
assert.equal(versionKind("src-tauri/tauri.conf.json"), "tauri_conf_json");
assert.deepEqual(parseVersionFiles(" frontend/package.json, main.py ", [{ path: "main.py", kind: "python_module_var", variableName: "VERSION" }]), [
  { path: "frontend/package.json", kind: "package_json" },
  { path: "main.py", kind: "python_module_var", variableName: "VERSION" },
]);
assert.deepEqual(parseVersionFiles("app.py", null), [{ path: "app.py", kind: "python_module_var", variableName: "version" }]);
assert.equal(parseVersionFiles(" , ", null), null);

// The check's words, by area and field.
const check = {
  errors: [{ area: "site", field: "label", message: "bad label" }],
  warnings: [{ area: "site", field: "versionFiles", message: "outside" }, { area: null, field: "tagPrefix", message: "none bare" }],
};
assert.deepEqual(problemsFor(check, "site", ["label"]), { errors: ["bad label"], warnings: [] });
assert.deepEqual(problemsFor(check, "site", ["versionFiles"]), { errors: [], warnings: ["outside"] });
assert.deepEqual(problemsFor(check, "app", ["label"]), { errors: [], warnings: [] });

// Words.
// C12 (AR-4): true words, never vX.Y.Z; the latest real tag when read, for
// the same prefix.
assert.equal(tagWords("site-"), "no release tagged yet; its tags will start with site-v");
assert.equal(tagWords("site-", { tagPrefix: "site-", latestTag: "site-v3.0.2" }), "releases tagged site-v3.0.2 (last)");
assert.equal(tagWords("web-", { tagPrefix: "site-", latestTag: "site-v3.0.2" }), "no release tagged yet; its tags will start with web-v", "prefix changed in the draft");
const files = [{ path: "site/package.json", kind: "package_json" as const }];
assert.equal(versionNowWords({ version: "3.0.1" }, files, files), " · now 3.0.1");
assert.equal(versionNowWords({ version: "3.0.1" }, [{ path: "x.json", kind: "package_json" as const }], files), "");
assert.equal(versionNowWords({ version: null }, files, files), "");
assert.equal(versionNowWords(null, files, files), "");
assert.equal(folderWords(""), "the whole project, except the other areas' folders");
assert.equal(folderWords("/lyrappc-astro/"), "lyrappc-astro/");
const v = (extra: Partial<AreasView>) => ({ problem: null, held: false, ...extra }) as AreasView;
assert.equal(pageProblem(v({})), null);
assert.match(pageProblem(v({ problem: "Two areas use site/.", held: true }))!.text, /^This repository's areas can't be used: Two areas use site\/\. No card can start/);
assert.match(pageProblem(v({ problem: "x" }))!.text, /This Mac keeps using the ones it had/);


// ── 1.174.0 (C10, D6): kept on this Mac until the setup is shared ─────
{
  const r = (id: string, name: string, path: string, targetBranch: string | null = null, i = 0): ResolvedArea => ({
    id,
    name,
    path,
    root: path === "",
    first: i === 0,
    targetBranch,
    branch: targetBranch ?? "main",
    versionFiles: null,
    tagPrefix: i === 0 ? "" : `${id}-`,
    label: `area:${id}`,
    lookAt: null,
  });
  assert.equal(KEPT_UNTIL_SHARED, "Kept on this Mac until you share this project's setup.");
  assert.equal(KEPT_HERE_ONLY, "Kept on this Mac only.");
  assert.equal(keptBarSentence(1, true), "1 change · stays on this Mac until you share this project's setup");
  assert.equal(keptBarSentence(2, false), "2 changes · stays on this Mac only");
  assert.equal(noticeKeptLine(true), "They're kept on this Mac until you share this project's setup.");
  assert.equal(noticeKeptLine(false), "They're kept on this Mac only.");
  const kept: AreasView = {
    shared: false,
    readOnly: false,
    defined: [],
    areas: [r("app", "App", ""), r("site", "Site", "site", null, 1)],
    workspaceBranch: "main",
    check: { errors: [], warnings: [] },
    problem: null,
    held: false,
    keptHere: true,
  };
  assert.equal(sharesAreasLine(kept), "Also shares the areas kept on this Mac: App, Site.");
  assert.equal(sharesAreasLine({ ...kept, keptHere: false, areas: [] }), null, "none kept: no line");
  assert.equal(sharesAreasLine({ ...kept, shared: true }), null, "shared: no Share");
  assert.equal(sharesAreasLine(null), null);
  const theirs = [r("app", "App", "", "staging"), r("web", "Web", "web", null, 1)];
  const mine = [r("app", "App", ""), r("site", "Site", "site/", null, 1)];
  assert.equal(
    areasChoiceLede(theirs, mine),
    "On GitHub: App (cards go to staging) and Web (web/). Kept on this Mac: App and Site (site/).",
  );
  assert.equal(areasChoiceLede([], mine), "On GitHub: no areas. Kept on this Mac: App and Site (site/).");
  assert.equal(
    areasChoiceBody(mine),
    "Use the repository's: this Mac follows them; your App and Site are set aside on this Mac, not deleted. Publish mine: your list replaces theirs for everyone, as a change you can see on GitHub.",
  );
  assert.match(areasChoiceBody([mine[1]]), /your Site is set aside/);
  // Round 1 (owner): the empty and broken cases have their own title and lede.
  assert.equal(areasChoiceKind({ areas: theirs, problem: null }), "different");
  assert.equal(areasChoiceKind({ areas: [], problem: null }), "empty");
  assert.equal(areasChoiceKind({ areas: [], problem: "Two areas are called “app”" }), "broken");
  assert.equal(areasChoiceKind({ areas: theirs, problem: "x" }), "broken", "a kept good copy is still a broken list");
  assert.equal(areasChoiceTitle("different"), "The repository already has areas");
  assert.equal(areasChoiceTitle("empty"), "The repository's setup has no areas");
  assert.equal(areasChoiceTitle("broken"), "The repository's areas can't be used");
  assert.equal(areasChoiceLede([], mine, "empty"), "On GitHub: no areas. Kept on this Mac: App and Site (site/).");
  assert.equal(
    areasChoiceLede([], mine, "broken"),
    "On GitHub the areas list can't be read. Kept on this Mac: App and Site (site/).",
  );
  // Read-only: only the answer it has.
  assert.equal(
    areasChoiceBody(mine, false),
    "Use the repository's: this Mac follows them; your App and Site are set aside on this Mac, not deleted.",
  );
  // C10 round 1: with no areas on GitHub there is nothing to follow.
  assert.equal(
    areasChoiceBody(mine, true, "empty"),
    "Use the repository's: this Mac works without areas; your App and Site are set aside on this Mac, not deleted. Publish mine: your list replaces theirs for everyone, as a change you can see on GitHub.",
  );
  assert.equal(
    areasChoiceBody([mine[1]], false, "empty"),
    "Use the repository's: this Mac works without areas; your Site is set aside on this Mac, not deleted.",
  );
}

// ── 1.174.0 (DS6, settings.html scenes 9–10) ──────────────────────────
{
  const site: AreaDef = { id: "site", name: "Site", path: "site", targetBranch: "main", lookAt: "https://www.lyrappc.com/", tagPrefix: "site-" };
  const app: AreaDef = { id: "app", name: "App", path: "", tagPrefix: "" };
  assert.equal(areaSummary(app, "", "staging"), "whole project · cards go to staging · no release tagged yet; its tags will start with v");
  // G2 walk: before the tags are read, nothing is said about them.
  assert.equal(areaSummary(app, "", "staging", "reading"), "whole project · cards go to staging");
  assert.equal(
    areaSummary(site, "site-", "staging"),
    "site/ · cards go to main · no release tagged yet; its tags will start with site-v · www.lyrappc.com",
  );
  assert.equal(
    areaSummary(app, "", "staging", { tagPrefix: "", latestTag: "v1.300.1" }),
    "whole project · cards go to staging · releases tagged v1.300.1 (last)",
    "the latest real tag",
  );
  assert.equal(
    areaSummary(site, "web-", "staging", { tagPrefix: "site-", latestTag: "site-v3.0.2" }),
    "site/ · cards go to main · no release tagged yet; its tags will start with web-v · www.lyrappc.com",
    "a prefix changed here",
  );
  assert.deepEqual(areaSubPage([app, site], 1), { title: "Site", lede: "site/ · one of 2 areas", back: "Areas" });
  assert.deepEqual(areaSubPage([app], 0), { title: "App", lede: "whole project · one of 1 area", back: "Areas" });
  assert.equal(areaSubIndex("area-3"), 3);
  assert.equal(areaSubIndex("cache-paths"), null);
  assert.equal(areaSubIndex(null), null);
  // C10 §1b: a kept-here row that changed.
  assert.equal(keptRowChange(site, [app]), "Changed here, not saved yet — there was no Site before.");
  assert.equal(keptRowChange(site, [app, site]), null);
  assert.equal(keptRowChange({ ...site, targetBranch: "staging" }, [app, site]), "Changed here, not saved yet.");
}

// ── 1.174.0 (C11): the direction written before the areas ──
{
  const { adoptDirectionTitle, adoptDirectionLede, ADOPT_DIRECTION_HINT, START_FRESH, useItForAreas, firstSaveOfAreas, directionQuote } =
    await import("./areasPage.ts");
  assert.equal(adoptDirectionTitle(["App", "Site"]), "Use the project's direction for App and Site?");
  assert.equal(adoptDirectionTitle(["App", "Site", "Docs"]), "Use the project's direction for App, Site and Docs?");
  const five = [1, 2, 3, 4, 5];
  assert.equal(
    adoptDirectionLede({ audience: "Italian and English PPC agencies that run Google Ads for clients.", better: "", rejected: five }),
    "You wrote a direction for the whole project before it had areas: “Italian and English PPC agencies…”, with 5 ideas not to propose again.",
  );
  assert.equal(
    adoptDirectionLede({ audience: "", better: "They start a trial.", rejected: [1] }),
    "You wrote a direction for the whole project before it had areas: “They start a trial”, with 1 idea not to propose again.",
  );
  assert.equal(
    adoptDirectionLede({ audience: "", better: "", rejected: [] }),
    "You wrote a direction for the whole project before it had areas.",
  );
  assert.equal(directionQuote("Short one."), "Short one");
  assert.equal(
    ADOPT_DIRECTION_HINT,
    "Each area gets its own copy, which you can change on its own. Start fresh: each area asks for its direction the first time.",
  );
  assert.equal(START_FRESH, "Start fresh");
  assert.equal(useItForAreas(["App", "Site"]), "Use it for both");
  assert.equal(useItForAreas(["Site"]), "Use it for Site");
  assert.equal(useItForAreas(["App", "Site", "Docs"]), "Use it for all 3");
  assert.equal(firstSaveOfAreas(0, 2), true);
  assert.equal(firstSaveOfAreas(1, 2), true);
  assert.equal(firstSaveOfAreas(2, 3), false, "only the first save with two or more");
  assert.equal(firstSaveOfAreas(0, 1), false);
  for (const s of [adoptDirectionTitle(["A", "B"]), ADOPT_DIRECTION_HINT]) assert.ok(!/default/i.test(s));
}
console.log("areasPage: ok");
