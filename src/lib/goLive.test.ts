// 1.173.0 (D2): the words of "When it merges" and How this goes live.
//     node --experimental-strip-types src/lib/goLive.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DeployMap, RailwayService, ReleaseScope, ResolvedArea, WhatRedeploys } from "../ipc.ts";
import {
  GO_LIVE_GUIDE_URL,
  GO_LIVE_NOTHING,
  WATCH_PATHS_GUIDE_URL,
  areaOfService,
  changesWords,
  checksFor,
  releasesRow,
  deployStateWords,
  readAgainForUnderWay,
  rightNowLabel,
  THEN_NOTHING,
  githubFilter,
  goLiveBlocks,
  goLiveNothing,
  listWords,
  railwayLine,
  readAgoWords,
  releasesWords,
  whenItMerges,
} from "./goLive.ts";

const service = (over: Partial<RailwayService>): RailwayService => ({
  environment: "production",
  name: "svc",
  repo: "acme/monorepo",
  branch: "main",
  rootDirectory: null,
  watchPatterns: [],
  domains: [],
  cron: null,
  thisRepository: true,
  ...over,
});
const area = (over: Partial<ResolvedArea>): ResolvedArea => ({
  id: "app",
  name: "App",
  path: "",
  root: true,
  first: true,
  targetBranch: null,
  branch: "main",
  versionFiles: null,
  tagPrefix: "",
  label: "app",
  lookAt: null,
  ...over,
});
const APP = area({});
const SITE = area({ id: "site", name: "Site", path: "site", root: false, first: false, tagPrefix: "site-", label: "site" });
const AREAS = [APP, SITE];
const siteProd = service({ name: "site-production", rootDirectory: "site", domains: ["www.example.com"] });
const appProd = service({ name: "app-production", domains: ["app.example.com", "app-production.up.railway.app"] });
const siteStaging = service({ name: "site-staging", rootDirectory: "site", branch: "staging", environment: "staging", domains: ["site-staging.up.railway.app"] });
const NOW = 1_000_000_000;

// ── Small words ──
assert.equal(listWords([]), "");
assert.equal(listWords(["a"]), "a");
assert.equal(listWords(["a", "b"]), "a and b");
assert.equal(listWords(["backend", "frontend", "site"]), "backend, frontend and site");
assert.equal(readAgoWords(null, NOW), null);
assert.equal(readAgoWords(NOW - 10_000, NOW), "read from Railway just now");
assert.equal(readAgoWords(NOW - 3 * 60_000, NOW), "read from Railway 3 min ago");
assert.equal(readAgoWords(NOW - 125 * 60_000, NOW), "read from Railway 2 h ago");

// ── Which area a service builds ──
assert.equal(areaOfService(siteProd, AREAS)?.id, "site");
assert.equal(areaOfService(appProd, AREAS)?.id, "app", "the whole repository is the root area's");
assert.equal(areaOfService(service({ rootDirectory: "site/docs" }), AREAS)?.id, "site");
assert.equal(areaOfService(appProd, [SITE]), null);

// ── When it merges (scene 1): addresses first, the reason in plain words ──
const what: WhatRedeploys = {
  targetBranch: "main",
  services: [
    { service: siteProd, reason: "inRoot", rebuildsOnAnyChange: true, domains: siteProd.domains },
    { service: appProd, reason: "anyChange", rebuildsOnAnyChange: true, domains: appProd.domains },
  ],
  checks: [{ file: "ci.yml", name: "CI", jobs: ["backend", "frontend", "site"] }],
  project: "acme-project",
  railwayReadAt: NOW - 3 * 60_000,
  changed: 4,
};
const view = whenItMerges(what, AREAS, NOW)!;
assert.equal(view.readAgo, "read from Railway 3 min ago");
assert.deepEqual(
  view.rows.map((r) => [r.kind, r.title, r.detail]),
  [
    ["updates", "www.example.com updates", "Railway service site-production · built from site/"],
    ["too", "app.example.com restarts too", "Its service rebuilds on any change in the repository, even outside the app."],
    ["checks", "GitHub runs 3 checks first", "backend, frontend and site, from ci.yml"],
  ],
);
assert.deepEqual(view.rows[1].guide, { label: "How to make it rebuild only for app changes", url: WATCH_PATHS_GUIDE_URL });
// Without areas: the reason names no area.
const plain = whenItMerges(what, [], NOW)!;
assert.equal(plain.rows[1].detail, "Its service rebuilds on any change in the repository, even in files it doesn't use.");
assert.equal(plain.rows[1].guide?.label, "How to make it rebuild only for its own changes");
// A service with no address is named.
const worker = whenItMerges(
  { ...what, services: [{ service: service({ name: "worker" }), reason: "watched", rebuildsOnAnyChange: false, domains: [] }], checks: [] },
  [],
  NOW,
)!;
assert.equal(worker.rows[0].title, "The worker service updates");
// Checks only: no Railway line; one check.
const ci = whenItMerges({ ...what, services: [], checks: [{ file: "site.yml", name: "site", jobs: ["Site"] }] }, AREAS, NOW)!;
assert.equal(ci.readAgo, null);
assert.deepEqual(ci.rows.map((r) => r.title), ["GitHub runs 1 check first"]);
// Nothing: nothing shown.
assert.equal(whenItMerges(null, AREAS, NOW), null);
assert.equal(whenItMerges({ ...what, services: [], checks: [] }, AREAS, NOW), null);
// The words never say PR, CLI or "into main".
for (const r of view.rows) for (const w of [/\bPR\b/, /\bCLI\b/, /into main/]) assert.doesNotMatch(`${r.title} ${r.detail}`, w);

// ── GitHub filters ──
assert.ok(githubFilter(["main"], "main"));
assert.ok(!githubFilter(["main"], "staging"));
assert.ok(githubFilter(["releases/**"], "releases/v1/x"));
assert.ok(!githubFilter(["releases/*"], "releases/v1/x"));
assert.ok(!githubFilter(["**", "!staging"], "staging"));
const wf = (file: string, pr: Partial<{ branches: string[] | null; branchesIgnore: string[] | null }> | null, target = false) => ({
  file,
  name: file,
  push: null,
  pullRequest: target ? null : pr && { branches: null, branchesIgnore: null, paths: null, pathsIgnore: null, ...pr },
  pullRequestTarget: target ? pr && { branches: null, branchesIgnore: null, paths: null, pathsIgnore: null, ...pr } : null,
  jobs: ["x"],
});
assert.deepEqual(
  checksFor([wf("a.yml", {}), wf("b.yml", { branches: ["staging"] }), wf("c.yml", null), wf("d.yml", { branches: ["main"] }, true)], "main").map((w) => w.file),
  ["a.yml", "d.yml"],
);

// ── The Railway line, every state ──
const read = (state: DeployMap["railway"]["state"], services: RailwayService[] = []) => ({
  state,
  project: "acme-project",
  services,
  message: null,
  readAt: NOW,
});
assert.equal(railwayLine(read("noCli")), null);
// 1.173.0 Windows walk: a project with Railway's config says why it isn't read.
assert.deepEqual(railwayLine(read("noCli"), true), {
  text: "Plyloft can't read Railway on this Mac: the railway program isn't installed.",
  readAgain: true,
});
assert.equal(railwayLine(read("notLinked"), true), null, "not linked: the calm footnote");
assert.equal(railwayLine(read("notLinked")), null);
assert.equal(
  railwayLine(read("otherProject"))?.text,
  "Railway: the link Plyloft sees is on a folder above this project, so it's another project's",
);
assert.equal(railwayLine(read("ok", [siteProd]))?.text, "Railway: signed in · project acme-project");
assert.equal(railwayLine(read("ok", [{ ...siteProd, thisRepository: false }]))?.text, "Railway: signed in", "another repository's project isn't named");
assert.match(railwayLine(read("signedOut"))!.text, /`railway login`/);
assert.equal(railwayLine(read("timedOut"))?.text, "Railway didn't answer. Ship works the same");
assert.equal(railwayLine(read("failed"))?.readAgain, true);

// ── How this goes live (scene 2): one block per area ──
const map: DeployMap = {
  repo: "acme/monorepo",
  railway: read("ok", [siteProd, appProd, siteStaging, service({ name: "other", repo: "acme/other", thisRepository: false, domains: ["x.example.com"] })]),
  workflows: [wf("ci.yml", { branches: ["main"] })],
};
const blocks = goLiveBlocks({
  map,
  areas: AREAS,
  branch: "main",
  releasesFor: (a) => (a?.id === "site" ? "Tag and push · latest site-v3.0.1" : "On this Mac only · no tag yet"),
});
assert.deepEqual(
  blocks.map((b) => [b.name, b.cardsGo, b.then, b.earlier, b.checks, b.releases]),
  [
    ["App", "main, as pull requests", "app.example.com updates · www.example.com restarts too", [], "x, from ci.yml", "On this Mac only · no tag yet"],
    [
      "Site",
      "main, as pull requests",
      "www.example.com updates · app.example.com restarts too",
      [{ label: "Earlier, on staging", addresses: "site-staging.up.railway.app" }],
      "x, from ci.yml",
      "Tag and push · latest site-v3.0.1",
    ],
  ],
);
// Another branch: known names are earlier or later, any other is "Also".
const odd = goLiveBlocks({
  map: { ...map, railway: read("ok", [siteProd, service({ name: "beta", branch: "beta-2", domains: ["beta.example.com"] })]) },
  areas: [],
  branch: "main",
  releasesFor: () => "",
});
assert.deepEqual(odd[0].earlier, [{ label: "Also, on beta-2", addresses: "beta.example.com" }]);
// Several areas, nothing to read: the calm line once (the page), "Nothing
// Plyloft can see" in each block.
const noneMany = goLiveBlocks({
  map: { repo: "acme/monorepo", railway: read("noCli"), workflows: [] },
  areas: AREAS,
  branch: "main",
  releasesFor: () => "",
});
assert.deepEqual(noneMany.map((b) => b.then), [THEN_NOTHING, THEN_NOTHING]);
assert.ok(goLiveNothing({ repo: "acme/monorepo", railway: read("noCli"), workflows: [] }));
assert.ok(!goLiveNothing(map));
// A workflow whose jobs can't be named is named itself.
const unnamed = whenItMerges({ ...what, services: [], checks: [{ file: "lint.yml", name: "Lint", jobs: [] }] }, [], NOW)!;
assert.deepEqual(unnamed.rows.map((r) => [r.title, r.detail]), [["GitHub runs 1 check first", "Lint, from lint.yml"]]);

// One area or none: one block for the workspace, no tag words.
const one = goLiveBlocks({ map, areas: [APP], branch: "main", releasesFor: (a) => (a ? "area" : "Tag and push") });
assert.equal(one.length, 1);
assert.equal(one[0].name, null);
assert.equal(one[0].then, "www.example.com updates · app.example.com updates");
assert.equal(one[0].releases, "Tag and push");
// A later branch.
const toStaging = goLiveBlocks({ map, areas: [], branch: "staging", releasesFor: () => "On this Mac only" });
assert.equal(toStaging[0].then, "site-staging.up.railway.app updates");
assert.deepEqual(toStaging[0].earlier, [{ label: "Later, on main", addresses: "www.example.com · app.example.com" }]);
assert.equal(toStaging[0].checks, null);

// ── Right now: each service's latest deploy, in words beside a dot ──
assert.deepEqual(deployStateWords("SUCCESS"), { words: "Live", dot: "done" });
assert.deepEqual(deployStateWords("FAILED"), { words: "Last deploy failed", dot: "aborted" });
assert.deepEqual(deployStateWords("deploying"), { words: "Deploying…", dot: "running" });
assert.equal(deployStateWords("BUILDING")?.words, "Building…");
assert.equal(deployStateWords("CRASHED")?.dot, "aborted");
assert.equal(deployStateWords("SLEEPING")?.dot, "empty");
assert.equal(deployStateWords("REMOVED")?.words, "Removed");
assert.equal(deployStateWords(null), null);
assert.equal(deployStateWords("SOMETHING_NEW"), null, "an unknown state says nothing");
assert.deepEqual(blocks.map((b) => b.now), [[], []], "no state from Railway: no Right now line");
// The walk's project (deploy_fixtures/railway_status_live.json): the app's
// latest deploy failed, the site is live; each area hears its own.
const walk = goLiveBlocks({
  map: {
    repo: "acme/sandbox",
    railway: read("ok", [
      service({ name: "app", deployStatus: "FAILED" }),
      service({ name: "site", rootDirectory: "site", deployStatus: "SUCCESS" }),
    ]),
    workflows: [],
  },
  areas: AREAS,
  branch: "main",
  releasesFor: () => "",
});
assert.deepEqual(walk.map((b) => b.now), [
  [{ key: "production/app", address: "The app service", words: "Last deploy failed", dot: "aborted" }],
  [{ key: "production/site", address: "The site service", words: "Live", dot: "done" }],
]);
// The same name in two environments: two rows, the other branch's said.
const twice = goLiveBlocks({
  map: {
    repo: "acme/sandbox",
    railway: read("ok", [
      service({ name: "app", deployStatus: "SUCCESS" }),
      service({ name: "app", environment: "staging", branch: "staging", deployStatus: "FAILED" }),
    ]),
    workflows: [],
  },
  areas: [],
  branch: "main",
  releasesFor: () => "",
});
assert.deepEqual(twice[0].now.map((n) => [n.key, n.address, n.words]), [
  ["production/app", "The app service", "Live"],
  ["staging/app", "The app service (on staging)", "Last deploy failed"],
]);
// Its age, and when to read again as the sheet opens.
assert.equal(rightNowLabel(NOW - 4 * 60_000, NOW), "Right now · read 4 min ago");
assert.equal(rightNowLabel(NOW, NOW), "Right now · read just now");
assert.equal(rightNowLabel(null, NOW), "Right now");
const underWay = (status: string, readAt: number): DeployMap => ({
  repo: "acme/sandbox",
  railway: { ...read("ok", [service({ name: "app", deployStatus: status })]), readAt },
  workflows: [],
});
assert.ok(readAgainForUnderWay(underWay("DEPLOYING", NOW - 31_000), NOW));
assert.ok(readAgainForUnderWay(underWay("BUILDING", NOW - 5 * 60_000), NOW));
assert.ok(readAgainForUnderWay(underWay("WAITING", NOW - 60_000), NOW));
assert.ok(!readAgainForUnderWay(underWay("DEPLOYING", NOW - 10_000), NOW), "fresh enough");
assert.ok(!readAgainForUnderWay(underWay("SUCCESS", NOW - 5 * 60_000), NOW), "nothing under way");
assert.ok(!readAgainForUnderWay(null, NOW));

// ── Scene 3: nothing to read — the calm line ──
const empty = goLiveBlocks({
  map: { repo: "acme/site", railway: read("noCli"), workflows: [] },
  areas: [],
  branch: "main",
  releasesFor: () => "On this Mac only",
});
assert.deepEqual(empty.map((b) => [b.cardsGo, b.then, b.releases]), [["main, as pull requests", GO_LIVE_NOTHING, "On this Mac only"]]);
assert.equal(goLiveBlocks({ map: null, areas: [], branch: "main", releasesFor: () => "x" })[0].cardsGo, "main", "no GitHub: no pull requests");

// ── Releases: the last release's kind and the latest tag ──
const label = (k: string) => ({ local: "On this Mac only", push_only: "Tag and push", github: "Publish a GitHub release" })[k] ?? k;
const entry = (tag: string | null, kind: "local" | "push_only" | "github", at: number) => ({
  commitSha: "c",
  shippedVersion: "1.0.0",
  releaseKind: kind,
  shippedAt: at,
  tag,
});
const entries = [entry("v1.2.0", "local", 1), entry("site-v3.0.1", "push_only", 3), entry(null, "github", 2)];
assert.equal(releasesWords({ entries, area: null, release: undefined, kindLabel: label }), "Tag and push · latest site-v3.0.1");
assert.equal(
  releasesWords({ entries, area: SITE, release: { id: "site", tagPrefix: "site-", latestTag: "site-v3.0.1", version: "3.0.1" }, kindLabel: label }),
  "Tag and push · latest site-v3.0.1",
);
// The app's own releases are its `vX` tags; an entry without a tag (a Land,
// a merged pull request, an older release) is no release.
assert.equal(
  releasesWords({ entries, area: APP, release: { id: "app", tagPrefix: "", latestTag: "v1.2.0", version: null }, kindLabel: label }),
  "On this Mac only · latest v1.2.0",
);
const landAndPr = [entry(null, "github", 5), entry(null, "push_only", 6)];
assert.equal(releasesWords({ entries: landAndPr, area: null, release: undefined, kindLabel: label }), "Not released yet");
assert.equal(
  releasesWords({ entries: landAndPr, area: null, release: { id: "app", tagPrefix: "", latestTag: "v0.9.0", version: null }, kindLabel: label }),
  "latest v0.9.0",
  "one area: B4's tag",
);
// One area listed: its prefix decides, from B4's reading.
assert.equal(
  releasesWords({ entries, area: null, release: { id: "site", tagPrefix: "site-", latestTag: "site-v3.0.1", version: null }, kindLabel: label }),
  "Tag and push · latest site-v3.0.1",
);
assert.equal(releasesWords({ entries: [], area: null, release: undefined, kindLabel: label }), "Not released yet");
assert.equal(releasesWords({ entries: [], area: SITE, release: { id: "site", tagPrefix: "site-", latestTag: "site-v1.0.0", version: null }, kindLabel: label }), "latest site-v1.0.0");

// 1.173.0 (G1): the kind chosen in Settings › Shipping comes before the last
// release's; the implicit area's strict tag (from before 1.173) still counts.
const implicit = { id: "default", tagPrefix: "", latestTag: "v1.4.0", version: "1.4.0" };
assert.equal(
  releasesWords({ entries, area: SITE, release: { id: "site", tagPrefix: "site-", latestTag: "site-v3.0.1", version: "3.0.1" }, kindLabel: label, chosen: "github" }),
  "Publish a GitHub release by default · latest site-v3.0.1 (tag and push)",
);
assert.equal(
  releasesWords({ entries, area: SITE, release: { id: "site", tagPrefix: "site-", latestTag: "site-v3.0.1", version: "3.0.1" }, kindLabel: label, chosen: "push_only" }),
  "Tag and push · latest site-v3.0.1",
  "the default is how the last release went: said once",
);
assert.equal(releasesWords({ entries: [], area: null, release: implicit, kindLabel: label }), "latest v1.4.0", "the D2 leftover: pre-1.173 tags");
assert.equal(releasesWords({ entries: [], area: null, release: implicit, kindLabel: label, chosen: "push_only" }), "Tag and push by default · latest v1.4.0");
assert.equal(releasesWords({ entries: [], area: null, release: undefined, kindLabel: label, chosen: "push_only" }), "Tag and push by default · not released yet");
assert.equal(
  releasesWords({ entries: [entry("v1.2.0", "local", 1)], area: null, release: undefined, kindLabel: label, chosen: "push_only" }),
  "Tag and push by default · latest v1.2.0 (on this Mac only)",
);
assert.equal(releasesWords({ entries, area: null, release: undefined, kindLabel: label, chosen: null }), "Tag and push · latest site-v3.0.1", "none chosen: the last release's");

// ── 1.174.0 (DR5, state 10): the Releases row ──
{
  const now = Date.UTC(2026, 9, 31, 12);
  const day = 24 * 3600_000;
  const scope = (over: Partial<ReleaseScope>): ReleaseScope =>
    ({
      area: "site",
      name: "Site",
      targetBranch: "main",
      sinceTag: "site-v3.0.1",
      sinceAt: now - 12 * day,
      cardsTotal: 4,
      otherTotal: 2,
      readyCardIds: [],
      refusal: null,
      inFlight: null,
      ...over,
    }) as ReleaseScope;
  assert.equal(changesWords(4, 2), "4 cards and 2 other changes");
  assert.equal(changesWords(1, 0), "1 card");
  assert.equal(changesWords(0, 1), "1 other change");
  assert.equal(changesWords(0, 0), "");
  assert.deepEqual(releasesRow(scope({}), 0, now, "x"), {
    words: "site-v3.0.1, 12 days ago · 4 cards and 2 other changes since",
    act: "release",
    running: false,
  });
  assert.deepEqual(releasesRow(scope({ targetBranch: "staging", sinceTag: "app-v1.4.0", sinceAt: now - day, cardsTotal: 0, otherTotal: 0 }), 0, now, "x"), {
    words: "app-v1.4.0, yesterday · nothing new on staging since",
    act: null,
    running: false,
  }, "nothing new: no button");
  assert.equal(releasesRow(scope({}), 1, now, "x").words, "site-v3.0.1, 12 days ago · 4 cards and 2 other changes since · 1 more card ready");
  assert.equal(releasesRow(scope({ cardsTotal: 0, otherTotal: 0 }), 2, now, "x").act, "release", "a ready card is something to release");
  assert.deepEqual(
    releasesRow(scope({ inFlight: { tag: "blog-v0.4.0", version: "0.4.0", prNumber: 3, prUrl: null, step: "merging", problem: null } }), 0, now, "x"),
    { words: "blog-v0.4.0 on its way · waiting for GitHub's checks", act: "show", running: true },
  );
  assert.equal(
    releasesRow(scope({ inFlight: { tag: "v1.0.1", version: "1.0.1", prNumber: null, prUrl: null, step: "building", problem: null } }), 0, now, "x").words,
    "v1.0.1 on its way · checks running",
  );
  const why = "Docs has no version file of its own. Add one in Settings › Areas.";
  assert.deepEqual(releasesRow(scope({ refusal: why }), 3, now, "x"), { words: why, act: null, running: false });
  assert.equal(releasesRow(scope({ sinceTag: null, sinceAt: null, cardsTotal: 9, otherTotal: 14 }), 0, now, "x").words, "Not released yet · 9 cards and 14 other changes on main");
  assert.deepEqual(releasesRow(scope({ sinceTag: null, sinceAt: null, cardsTotal: 0, otherTotal: 0 }), 0, now, "x"), {
    words: "Not released yet · nothing on main yet",
    act: null,
    running: false,
  });
  // Not read yet: B4's words, and Release… only with a ready card.
  assert.deepEqual(releasesRow(undefined, 0, now, "Tag and push · latest v1.0.0"), { words: "Tag and push · latest v1.0.0", act: null, running: false });
  assert.equal(releasesRow(undefined, 1, now, "x").act, "release");
}

// ── The guide's sections the links open ──
const guide = readFileSync("docs/onboarding/USER_GUIDE.md", "utf8");
const slugs = new Set(
  [...guide.matchAll(/^#{2,4} (.+)$/gm)].map((m) =>
    m[1].toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-"),
  ),
);
for (const url of [GO_LIVE_GUIDE_URL, WATCH_PATHS_GUIDE_URL]) {
  assert.ok(slugs.has(url.split("#")[1]), `the guide has ${url}`);
}
assert.ok(guide.replace(/\s+/g, " ").includes(GO_LIVE_NOTHING), "the guide quotes the calm line");

console.log("goLive ok");
