// 1.173.0 (G1): Settings › Shipping's rules and words.
//     node --experimental-strip-types src/lib/shippingPage.test.ts
import assert from "node:assert/strict";
import type { AreasView, DeployMap, RailwayService, ResolvedArea } from "../ipc.ts";
import { RELEASE_KINDS } from "./cardPage.ts";
import {
  GO_LIVE_SUMMARY_NOTHING,
  RELEASE_KIND_LABEL,
  asReleaseKind,
  chosenReleaseKind,
  FOLLOW_VALUE,
  chosenDefaultKind,
  defaultReleaseChoices,
  defaultReleaseKind,
  followedReleaseKind,
  goLiveSummary,
  followChoiceLabel,
  releaseRowHint,
  areasCardsGoHint,
  keptBranchesHint,
  showKeptLabel,
  SHIPPING_LEDE,
  WHERE_CARDS_GO,
  SHIP_IT_SECTION,
  AFTER_SHIPPING,
  CARD_BRANCHES,
  RELEASES,
  withAreaReleaseKind,
} from "./shippingPage.ts";
import { GO_LIVE_NOTHING, GO_LIVE_READING, RAILWAY_NO_CLI } from "./goLive.ts";
import { machineWords, setPlatformForTests } from "./platform.ts";
import { changes, consequenceOf, releaseKindOnlyChanges, releaseKindWords } from "./repositoryPage.ts";

const area = (id: string, releaseKind: ResolvedArea["releaseKind"] = null): ResolvedArea => ({
  id,
  name: id,
  path: id === "app" ? "" : id,
  root: id === "app",
  first: id === "app",
  targetBranch: null,
  branch: "main",
  versionFiles: null,
  tagPrefix: "",
  label: `area:${id}`,
  lookAt: null,
  releaseKind,
});
const view = (areas: ResolvedArea[], releaseKind: AreasView["releaseKind"] = null) => ({ areas, releaseKind });

// The labels Release… and Ship batch list are these.
for (const k of RELEASE_KINDS) assert.equal(k.label, RELEASE_KIND_LABEL[k.value]);
assert.equal(asReleaseKind("push_only"), "push_only");
assert.equal(asReleaseKind("deploy"), null, "a later build's kind is none");
assert.equal(asReleaseKind(undefined), null);

// ── Where Release… starts ──
// Chosen: the choice, whatever How Ship it ships says.
assert.equal(defaultReleaseKind(view([], "github"), null, "local", false), "github", "the repository's, without areas");
assert.equal(defaultReleaseKind(view([], "github"), "default", "github", true), "github", "B3's implicit stamp is no area");
assert.equal(defaultReleaseKind(view([], "local"), null, "github", true), "local", "On this Mac only chosen stays");
const two = view([area("app"), area("site", "push_only")], "github");
assert.equal(defaultReleaseKind(two, "site", "local", false), "push_only");
assert.equal(defaultReleaseKind(view([area("site", "push_only")]), null, "local", false), "push_only", "the one area is the whole repository's");
// 1.174.0 (A1, SL-1c): not chosen, it follows How Ship it ships.
for (const [via, onGitHub, kind, why] of [
  ["github", true, "push_only", "Ship it on GitHub: Put the version on GitHub"],
  [undefined, true, "push_only", "no shipVia saved is GitHub, as in Rust"],
  ["later", true, "push_only", "a later build's shipVia reads as the default"],
  ["local", true, "local", "Ship it only on this Mac"],
  ["github", false, "local", "a project that can't take a pull request"],
  ["github", null, "local", "not read yet"],
] as const) {
  assert.equal(followedReleaseKind(via, onGitHub), kind, why);
  assert.equal(defaultReleaseKind(view([]), null, via, onGitHub), kind, `nothing chosen: ${why}`);
  assert.equal(defaultReleaseKind(undefined, null, via, onGitHub), kind, `not read yet: ${why}`);
  assert.equal(defaultReleaseKind(two, "app", via, onGitHub), kind, `an area with none chosen: ${why}`);
  assert.equal(defaultReleaseKind(two, null, via, onGitHub), kind, `no area of two, never the top-level one: ${why}`);
  assert.equal(defaultReleaseKind(two, "gone", via, onGitHub), kind, `a removed area: ${why}`);
}
// Owner: the menu starts with "Same as Ship it", so picking any kind saves;
// the row's line doesn't repeat it (round 1).
assert.deepEqual(
  defaultReleaseChoices("push_only").map((c) => c.label),
  ["Same as Ship it (Put the version on GitHub)", "On this Mac only", "Put the version on GitHub", "Put the version on GitHub, with a release page"],
);
assert.equal(defaultReleaseChoices("local")[0].label, "Same as Ship it (On this Mac only)");
assert.equal(defaultReleaseChoices("local")[0].value, FOLLOW_VALUE);
assert.equal(asReleaseKind(FOLLOW_VALUE), null, "Same as Ship it is no kind");
assert.equal(releaseRowHint({ latestTag: "site-v1.2.0" }, "main"), "site-v1.2.0 · cards go to main", "scene 4a");
// Round 1: what was chosen, or null — the hook waits for the reading on null.
assert.equal(chosenDefaultKind(undefined, null), null);
assert.equal(chosenDefaultKind(view([]), null), null);
assert.equal(chosenDefaultKind(view([], "github"), null), "github");
assert.equal(chosenDefaultKind(two, "site"), "push_only");
assert.equal(chosenDefaultKind(two, "app"), null);
assert.equal(chosenDefaultKind(two, null), null);
assert.equal(releaseKindWords(null), "Same as Ship it", "as a value: change lines, toasts, search");
assert.equal(consequenceOf("releaseKind", null), "Release… follows How Ship it ships; each release can still choose.");
assert.equal(chosenReleaseKind(two, area("site")), "push_only");
assert.equal(chosenReleaseKind(two, area("app")), null);
assert.equal(chosenReleaseKind(two, null), null);
assert.equal(chosenReleaseKind(view([], "local"), null), "local");
assert.equal(chosenReleaseKind(view([area("site", "github")]), null), "github");

// ── The rows ──
const list = [{ id: "app", name: "App", path: "", later: 1 }, { id: "site", name: "Site", path: "web", releaseKind: "push_only" as const }];
const set = withAreaReleaseKind(list, "app", "github");
assert.deepEqual(set[0], { id: "app", name: "App", path: "", later: 1, releaseKind: "github" }, "unknown keys stay");
assert.equal(set[1], list[1], "the other areas are untouched");
assert.equal("releaseKind" in withAreaReleaseKind(list, "site", null)[1], false, "not chosen: not written");
assert.equal(releaseRowHint({ latestTag: "site-v3.0.1" }, "main"), "site-v3.0.1 · cards go to main");
// 1.174.0 (DR6, P37, release.html table 12): when, once it is read.
assert.equal(
  releaseRowHint({ latestTag: "site-v3.0.1" }, "main", Date.UTC(2026, 9, 19), Date.UTC(2026, 9, 31)),
  "site-v3.0.1, 12 days ago · cards go to main",
);
assert.equal(releaseRowHint(undefined, "staging"), "no tag yet · cards go to staging");
// G2 walk: before the tags are read, nothing is said about them.
assert.equal(releaseRowHint("reading", "staging"), "cards go to staging");
assert.equal(releaseRowHint("reading", ""), "Reading…");

// ── 1.174.0 (DS2): the page in the order things happen (scene 3) ──
assert.equal(SHIPPING_LEDE, "Where a card's change goes, how it leaves this Mac, and how it goes live.");
assert.deepEqual(
  [WHERE_CARDS_GO, SHIP_IT_SECTION, AFTER_SHIPPING, CARD_BRANCHES, RELEASES],
  ["Where cards go", "Ship it", "After shipping", "Card branches", "Releases"],
);
assert.equal(
  areasCardsGoHint([
    { name: "App", branch: "staging" },
    { name: "Site", branch: "main" },
  ]),
  "Each area has its own: App → staging · Site → main.",
);
assert.equal(
  keptBranchesHint([{ afterShip: true }, { afterShip: true }]),
  "2 branches with commits made after they shipped. On GitHub, Plyloft deletes only a card's own branch, once its pull request merged.",
);
assert.equal(
  keptBranchesHint([{ afterShip: true }]),
  "1 branch with commits made after it shipped. On GitHub, Plyloft deletes only a card's own branch, once its pull request merged.",
);
assert.match(keptBranchesHint([{ afterShip: true }, { afterShip: false }]), /^2 branches kept\. On GitHub/);
assert.equal(showKeptLabel(2), "Show 2");

// Review: a change of the areas' default release kinds alone is said as that.
assert.deepEqual(
  releaseKindOnlyChanges(
    [{ id: "app", name: "App", path: "" }, { id: "site", name: "Site", path: "web" }],
    withAreaReleaseKind([{ id: "app", name: "App", path: "" }, { id: "site", name: "Site", path: "web" }], "site", "push_only"),
  ),
  [{ name: "Site", fromWords: "Same as Ship it", toWords: "Put the version on GitHub" }],
);
assert.equal(
  releaseKindOnlyChanges([{ id: "site", name: "Site", path: "web" }], [{ id: "site", name: "Site", path: "site", releaseKind: "github" }]),
  null,
  "a folder changed too: an areas change",
);
const [change] = changes(["areas"], { areas: [{ id: "site", name: "Site", path: "web" }] }, { areas: [{ id: "site", name: "Site", path: "web", releaseKind: "push_only" }] });
assert.equal(change.label, "Default release");
assert.equal(change.consequence, "Site's default release: Put the version on GitHub. Each release can still choose.");
assert.equal(consequenceOf("releaseKind", "push_only"), "Release… starts with “Put the version on GitHub” for everyone who opens this repository; each release can still choose.");

// ── How this goes live's line ──
const service = (over: Partial<RailwayService>): RailwayService => ({
  environment: "production",
  name: "svc",
  repo: "acme/lyra",
  branch: "main",
  rootDirectory: null,
  watchPatterns: [],
  domains: [],
  thisRepository: true,
  ...over,
} as RailwayService);
const map = (services: RailwayService[], files: string[] = []): DeployMap => ({
  repo: "acme/lyra",
  railway: { state: "ok", project: "lyra", services, message: null, readAt: 0 },
  workflows: files.map((file) => ({ file, name: file, push: null, pullRequest: null, pullRequestTarget: null, jobs: [] })),
});
assert.equal(goLiveSummary({ kind: "reading" }, 0), GO_LIVE_READING);
assert.equal(
  goLiveSummary({ kind: "read", map: map([service({ domains: ["www.lyrappc.com"] }), service({ name: "app", domains: ["app.lyrappc.com"] }), service({ name: "other", thisRepository: false, domains: ["x.com"] })]) }, 3 * 60_000),
  "www.lyrappc.com and app.lyrappc.com · read from Railway 3 min ago",
);
assert.equal(goLiveSummary({ kind: "read", map: map([service({ name: "worker" })]) }, 0), "The worker service · read from Railway just now");
assert.equal(goLiveSummary({ kind: "read", map: map([], ["ci.yml"]) }, 0), "GitHub runs checks from ci.yml");
assert.equal(goLiveSummary({ kind: "read", map: map([]) }, 0), GO_LIVE_SUMMARY_NOTHING);
assert.ok(GO_LIVE_NOTHING.startsWith(GO_LIVE_SUMMARY_NOTHING), "the sheet's calm line, its first sentence");
// Challenger 4: no railway program in a project that uses Railway — the
// sheet's line, in this machine's words; without the sign, the calm line.
const noCli = (railwayFiles: boolean): DeployMap => ({
  ...map([], ["ci.yml"]),
  railway: { state: "noCli", project: null, services: [], message: null, readAt: null },
  railwayFiles,
});
setPlatformForTests("windows");
assert.equal(
  goLiveSummary({ kind: "read", map: noCli(true) }, 0),
  "Plyloft can't read Railway on this PC: the railway program isn't installed.",
);
// Scene 5: the menu's first choice through machineWords, as the row draws it.
assert.equal(machineWords(followChoiceLabel("local")), "Same as Ship it (On this PC only)");
// Round 1: Review and the change lines say "this PC" too.
assert.equal(releaseKindWords("local"), "On this PC only");
assert.equal(consequenceOf("releaseKind", "local").includes("“On this PC only”"), true);
assert.equal(machineWords(RELEASE_KIND_LABEL[followedReleaseKind("local", true)]), "On this PC only");
setPlatformForTests("mac");
assert.equal(goLiveSummary({ kind: "read", map: noCli(true) }, 0), RAILWAY_NO_CLI);
assert.equal(goLiveSummary({ kind: "read", map: noCli(false) }, 0), "GitHub runs checks from ci.yml");
setPlatformForTests(null);

console.log("shippingPage ok");

// Two-instance walk (B2): Re-detect on a shared project says the checks are the team's.
{
  const { RE_DETECT_SHARED_HINT, reDetectChangesSharedToast } = await import("./shippingPage.ts");
  if (!RE_DETECT_SHARED_HINT.startsWith("The checks come from the shared setup.")) throw new Error("hint");
  // The page draws it as one literal (the settings search matches it): the same words.
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../components/RepositorySettings.tsx", import.meta.url), "utf8");
  if (!page.includes(JSON.stringify(RE_DETECT_SHARED_HINT))) throw new Error("the page's hint differs from RE_DETECT_SHARED_HINT");
  const t = reDetectChangesSharedToast("w1175-int");
  if (t.title !== "Re-detect proposes a change to the shared checks") throw new Error(t.title);
  if (!t.body.includes("on w1175-int") || !t.body.includes("may be behind")) throw new Error(t.body);
  console.log("shippingPage B2 re-detect: ok");
}
