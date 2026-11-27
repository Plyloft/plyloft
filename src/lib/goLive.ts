/**
 * 1.173.0 (D2): what changes online, in the app's words — the Ship step's
 * "When it merges" and the Board's *How this goes live*. Read from D1's
 * `deploy_map` (Railway and the repository's GitHub checks, read only).
 * Addresses first, Railway's service names second. Never blocks a Ship.
 *
 * Pure: no React, no IPC.
 */
import type {
  AreaRelease,
  ShipEntry,
  DeployMap,
  DeployWorkflow,
  RailwayRead,
  RailwayService,
  ReleaseInFlight,
  ReleaseScope,
  ResolvedArea,
  WhatRedeploys,
  WorkflowTrigger,
} from "../ipc.ts";
import { agoWords } from "./copyWords.ts";

/** The guide's sections (docs/onboarding/USER_GUIDE.md). */
export const GO_LIVE_GUIDE_URL = "https://www.plyloft.com/docs/guide/#how-a-change-goes-live";
export const WATCH_PATHS_GUIDE_URL =
  "https://www.plyloft.com/docs/guide/#make-a-service-rebuild-only-for-its-own-changes";

export const GO_LIVE_TITLE = "How this goes live";
/** 1.174.0 (C1, BCI-16): the quiet press at the end of a card's When it
 *  merges that opens the sheet. */
export const GO_LIVE_LINK = `${GO_LIVE_TITLE}…`;
export const GO_LIVE_LEDE =
  "What happens after a card ships, for each area. Read from Railway and from the repository's GitHub checks.";
export const GO_LIVE_LEDE_ONE =
  "What happens after a card ships. Read from Railway and from the repository's GitHub checks.";
/** Scene 3: nothing to read — one calm line, no warning, no setup asked. */
export const GO_LIVE_NOTHING =
  "Plyloft doesn't see where this project goes online. That's fine: Ship still opens the pull request, and your host takes it from there.";
export const GO_LIVE_READS_WHEN =
  "Plyloft reads Railway and GitHub checks when a project uses them.";
/** No `railway` program, in a project with Railway's config file. */
export const RAILWAY_NO_CLI = "Plyloft can't read Railway on this Mac: the railway program isn't installed.";
export const GO_LIVE_READING = "Reading where this project goes online…";
export const GO_LIVE_READ_FAILED =
  "Plyloft couldn't read where this project goes online. Ship works the same.";
export const READ_AGAIN = "Read again";
export const WHEN_IT_MERGES = "When it merges";

/** "a", "a and b", "a, b and c". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "read from Railway 3 min ago". */
export function readAgoWords(readAt: number | null | undefined, now: number): string | null {
  if (readAt == null) return null;
  const min = Math.max(0, Math.floor((now - readAt) / 60_000));
  if (min < 1) return "read from Railway just now";
  if (min < 60) return `read from Railway ${min} min ago`;
  const h = Math.floor(min / 60);
  return `read from Railway ${h} h ago`;
}

/** Where a service is: its first address, else its name. */
export function serviceAddress(s: RailwayService): string {
  return s.domains[0] ?? `the ${s.name} service`;
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The area a service builds: the deepest area whose folder holds its root
 *  directory; a service of the whole repository is the root area's. */
export function areaOfService(s: RailwayService, areas: readonly ResolvedArea[]): ResolvedArea | null {
  const root = s.rootDirectory ?? "";
  let best: ResolvedArea | null = null;
  for (const a of areas) {
    const holds = a.path === "" ? true : root === a.path || root.startsWith(`${a.path}/`);
    if (!holds) continue;
    if (!best || a.path.length > best.path.length) best = a;
  }
  return best;
}

/** "the app": an area named in a sentence. */
function areaInSentence(area: ResolvedArea): string {
  return `the ${area.name.toLowerCase()}`;
}

export interface GoLiveRow {
  kind: "updates" | "too" | "checks";
  title: string;
  detail: string;
  /** The guide's watch paths section, for a service that restarts too. */
  guide?: { label: string; url: string };
}

export interface WhenItMergesView {
  /** "read from Railway 3 min ago"; null without a Railway service. */
  readAgo: string | null;
  rows: GoLiveRow[];
}

/** The jobs and files of the checks: "backend, frontend and site, from ci.yml". */
export function checksDetail(checks: readonly { file: string; name: string; jobs: string[] }[]): string {
  // A workflow whose jobs can't be named is named itself.
  const jobs = checks.flatMap((c) => (c.jobs.length ? c.jobs : [c.name]));
  const files = [...new Set(checks.map((c) => c.file))];
  return `${listWords(jobs)}, from ${listWords(files)}`;
}

function checksRow(checks: readonly { file: string; name: string; jobs: string[] }[]): GoLiveRow | null {
  const n = checks.reduce((sum, c) => sum + Math.max(1, c.jobs.length), 0);
  if (n === 0) return null;
  return {
    kind: "checks",
    title: `GitHub runs ${n} check${n === 1 ? "" : "s"} first`,
    detail: checksDetail(checks),
  };
}

/**
 * The Ship step's "When it merges" (scene 1): the addresses that update,
 * those that restart too and why, and the GitHub checks. `null` with
 * nothing to say — the step then shows nothing.
 */
export function whenItMerges(
  what: WhatRedeploys | null | undefined,
  areas: readonly ResolvedArea[],
  now: number,
): WhenItMergesView | null {
  if (!what) return null;
  const rows: GoLiveRow[] = [];
  for (const r of what.services) {
    const s = r.service;
    // An address as it is written; "The worker service" starts a sentence.
    const where = r.domains[0] ?? capital(serviceAddress(s));
    if (r.reason === "anyChange") {
      const area = areas.length >= 2 ? areaOfService(s, areas) : null;
      const scope = area ? areaInSentence(area) : s.rootDirectory ? `${s.rootDirectory}/` : null;
      rows.push({
        kind: "too",
        title: `${where} restarts too`,
        detail: scope
          ? `Its service rebuilds on any change in the repository, even outside ${scope}.`
          : "Its service rebuilds on any change in the repository, even in files it doesn't use.",
        guide: {
          label: `How to make it rebuild only for ${area ? `${area.name.toLowerCase()} ` : "its own "}changes`,
          url: WATCH_PATHS_GUIDE_URL,
        },
      });
    } else {
      rows.push({
        kind: "updates",
        title: `${where} updates`,
        detail: `Railway service ${s.name}${s.rootDirectory ? ` · built from ${s.rootDirectory}/` : ""}`,
      });
    }
  }
  const checks = checksRow(what.checks);
  if (checks) rows.push(checks);
  if (rows.length === 0) return null;
  return { readAgo: what.services.length > 0 ? readAgoWords(what.railwayReadAt, now) : null, rows };
}

// ── GitHub's filters, for the page (D1 reads them the same way) ─────────

function globRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?" || c === "+") out += c;
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end > i) {
        out += pattern.slice(i, end + 1);
        i = end;
      } else out += "\\[";
    } else out += c.replace(/[.^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** A GitHub filter list over one value: in order, `!` takes back. */
export function githubFilter(patterns: readonly string[], value: string): boolean {
  let matched = false;
  for (const p of patterns) {
    if (p.startsWith("!")) {
      if (matched && globRegex(p.slice(1)).test(value)) matched = false;
    } else if (!matched && globRegex(p).test(value)) matched = true;
  }
  return matched;
}

function runsOnPullRequestTo(t: WorkflowTrigger | null, branch: string): boolean {
  if (!t) return false;
  if (t.branches && !githubFilter(t.branches, branch)) return false;
  if (t.branchesIgnore && githubFilter(t.branchesIgnore, branch)) return false;
  return true;
}

/** The workflows a pull request to `branch` may run (their path filters
 *  are the card's to decide). */
export function checksFor(workflows: readonly DeployWorkflow[], branch: string): DeployWorkflow[] {
  return workflows.filter(
    (w) => runsOnPullRequestTo(w.pullRequest, branch) || runsOnPullRequestTo(w.pullRequestTarget, branch),
  );
}

// ── The Railway line ───────────────────────────────────────────────────

/**
 * The page's Railway line, in every state D1 reads: `null` when there is
 * nothing to say about Railway (it isn't installed, or this folder isn't
 * linked — the calm footnote says the rest). `readAgain` says whether
 * *Read again* fits.
 */
export function railwayLine(
  railway: RailwayRead,
  /** The repository has Railway's config file (`DeployMap.railwayFiles`). */
  railwayFiles = false,
): { text: string; readAgain: boolean } | null {
  switch (railway.state) {
    case "noCli":
      // 1.173.0 Windows walk: a project that uses Railway says why it
      // wasn't read; any other keeps the calm footnote. "this Mac" goes
      // through machineWords where it is shown.
      return railwayFiles ? { text: RAILWAY_NO_CLI, readAgain: true } : null;
    case "notLinked":
      return null;
    case "otherProject":
      return {
        text: "Railway: the link Plyloft sees is on a folder above this project, so it's another project's",
        readAgain: true,
      };
    case "ok": {
      const ours = railway.services.some((s) => s.thisRepository);
      return {
        text: ours && railway.project ? `Railway: signed in · project ${railway.project}` : "Railway: signed in",
        readAgain: true,
      };
    }
    case "signedOut":
      return { text: "Railway: signed out. Run `railway login` in a terminal, then Read again", readAgain: true };
    case "timedOut":
    case "failed":
      return { text: "Railway didn't answer. Ship works the same", readAgain: true };
  }
}

// ── A service's state right now ────────────────────────────────────────

/** The run-state dot beside a state's words (the same names as the ux
 *  StatusLine's). Colour is on the dot only. */
export type DeployDot = "done" | "aborted" | "running" | "empty";

/**
 * A service's latest deploy in plain words, from Railway's status (1.173.0
 * walk: the page showed the services but not whether they were up). `null`
 * for no status, or one Plyloft doesn't know: then nothing is said.
 */
export function deployStateWords(status: string | null | undefined): { words: string; dot: DeployDot } | null {
  switch ((status ?? "").toUpperCase()) {
    case "SUCCESS":
      return { words: "Live", dot: "done" };
    case "FAILED":
      return { words: "Last deploy failed", dot: "aborted" };
    case "CRASHED":
      return { words: "Crashed", dot: "aborted" };
    case "BUILDING":
      return { words: "Building…", dot: "running" };
    case "DEPLOYING":
      return { words: "Deploying…", dot: "running" };
    case "INITIALIZING":
    case "QUEUED":
    case "WAITING":
      return { words: "Waiting to deploy", dot: "running" };
    case "NEEDS_APPROVAL":
      return { words: "Waiting for approval on Railway", dot: "empty" };
    case "REMOVING":
      return { words: "Being removed", dot: "empty" };
    case "REMOVED":
      return { words: "Removed", dot: "empty" };
    case "SLEEPING":
      return { words: "Asleep until someone visits", dot: "empty" };
    case "SKIPPED":
      return { words: "Last deploy skipped", dot: "empty" };
    default:
      return null;
  }
}

/** The Right now label with its age: "Right now · read 4 min ago". */
export function rightNowLabel(readAt: number | null | undefined, now: number): string {
  const ago = readAgoWords(readAt, now);
  return ago ? `Right now · ${ago.replace(/^read from Railway /, "read ")}` : "Right now";
}

/** A reading older than this, with a deploy under way, is read again when
 *  the sheet opens (Plyloft keeps a reading up to ten minutes). */
export const UNDER_WAY_FRESH_MS = 30_000;

/** Whether the sheet should ask Railway again as it opens: the reading is
 *  over 30 s old and a service of this repository was still building,
 *  deploying or waiting then. */
export function readAgainForUnderWay(map: DeployMap | null, now: number): boolean {
  const at = map?.railway.readAt;
  if (map == null || at == null || now - at <= UNDER_WAY_FRESH_MS) return false;
  return map.railway.services.some((s) => s.thisRepository && deployStateWords(s.deployStatus)?.dot === "running");
}

// ── How this goes live (scene 2, 3) ────────────────────────────────────

export interface GoLiveBlock {
  /** The area's id; null for the workspace's one block. */
  areaId: string | null;
  /** The area's name; null without areas. */
  name: string | null;
  /** "main, as pull requests". */
  cardsGo: string;
  /** "www.x.com updates · app.x.com restarts too", or the calm line. */
  then: string;
  /** "Earlier, on staging" with its addresses. */
  earlier: { label: string; addresses: string }[];
  /** "backend, frontend and site, from ci.yml", when checks run first. */
  checks: string | null;
  /** "Tag and push · latest site-v3.0.1". */
  releases: string;
  /** Right now: each of the block's own services with a state Railway
   *  gave, "www.x.com · Live" (every branch, in Railway's order). */
  now: { key: string; address: string; words: string; dot: DeployDot }[];
}

/**
 * "Tag and push · latest site-v3.0.1". Only real releases count: entries
 * with a `tag` (a Land and a merged pull request have none, and neither do
 * entries older than 1.173.0). The kind is the last release's; a default
 * chosen in Settings › Shipping (G1, `chosen`) that differs from it is said
 * as the default ("Tag and push by default · latest v1.2.0 (on this Mac
 * only)"). The
 * latest tag is B4's reading of the area (`areas_releases`, also for the
 * implicit area: the latest strict vX.Y.Z tag, so releases from before
 * 1.173 count), else the last release's. With no release and no kind,
 * "Not released yet", or the tag alone. An area's releases are the tags
 * with its prefix.
 */
export function releasesWords(input: {
  entries: readonly ShipEntry[];
  area: ResolvedArea | null;
  release: AreaRelease | undefined;
  kindLabel: (kind: string) => string;
  /** G1: the default release kind chosen for this area (or the repository). */
  chosen?: string | null;
}): string {
  const { entries, area, release, kindLabel, chosen } = input;
  const prefix = area?.tagPrefix ?? release?.tagPrefix ?? "";
  const ofArea = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}v\\d+\\.\\d+\\.\\d+`);
  const mine = entries
    .filter((e) => e.tag && e.releaseKind)
    .filter((e) => !(area || release) || ofArea.test(e.tag!))
    .sort((a, b) => b.shippedAt - a.shippedAt);
  const last = mine[0];
  const tag = release?.latestTag ?? last?.tag ?? null;
  const latest = tag ? `latest ${tag}` : last ? "no tag yet" : "not released yet";
  // G1 Challenger 8: a default that isn't how the last release went is
  // said as the default, with how the last one went beside its tag.
  if (chosen && chosen !== last?.releaseKind) {
    return `${kindLabel(chosen)} by default · ${latest}${last ? ` (${lowerFirst(kindLabel(last.releaseKind))})` : ""}`;
  }
  const kind = last?.releaseKind ?? null;
  if (!kind) return tag ? `latest ${tag}` : "Not released yet";
  return `${kindLabel(kind)} · ${latest}`;
}

// ── 1.174.0 (DR5, D1(b)): the Releases row (release.html state 10) ─────

/** What the Releases row of a block says and offers. */
export interface ReleasesRow {
  words: string;
  /** "release": Release <Area>… beside it; "show": Show it (a release of
   *  the area on its way); null: no button — never one that is off. */
  act: "release" | "show" | null;
  /** A release on its way: the running dot beside its words. */
  running: boolean;
}

/** "4 cards and 2 other changes", "1 card", "2 other changes"; "" for none. */
export function changesWords(cards: number, others: number): string {
  const c = cards === 1 ? "1 card" : `${cards} cards`;
  const o = others === 1 ? "1 other change" : `${others} other changes`;
  if (cards > 0 && others > 0) return `${c} and ${o}`;
  if (cards > 0) return c;
  if (others > 0) return o;
  return "";
}

/** A release on its way, in the sidebar's and the sheet's words. */
function onItsWayWords(step: ReleaseInFlight["step"]): string {
  if (step === "open" || step === "merging") return " · waiting for GitHub's checks";
  if (step === "building" || step === "built") return " · checks running";
  return "";
}

/**
 * The Releases row from the area's scope (`release_scopes`): the last tag
 * and when, then what is on the target since — "site-v3.0.1, 12 days ago ·
 * 4 cards and 2 other changes since" with Release <Area>… beside it, or
 * "app-v1.4.0, yesterday · nothing new on staging since" with no button. A
 * release on its way says so: "blog-v0.4.0 on its way · waiting for
 * GitHub's checks" with Show it. A refused area says why, with no button.
 * `ready`: the area's cards ready but not on the target yet ("· 1 more card
 * ready"). Before the scope is read (or when it can't be), `fallback` (B4's
 * words) and Release… only with a ready card.
 */
export function releasesRow(
  scope: ReleaseScope | undefined,
  ready: number,
  now: number,
  fallback: string,
): ReleasesRow {
  const more = ready > 0 ? ` · ${ready} more card${ready === 1 ? "" : "s"} ready` : "";
  if (!scope) return { words: fallback, act: ready > 0 ? "release" : null, running: false };
  if (scope.inFlight) {
    return { words: `${scope.inFlight.tag} on its way${onItsWayWords(scope.inFlight.step)}`, act: "show", running: true };
  }
  if (scope.refusal) return { words: scope.refusal, act: null, running: false };
  const branch = scope.targetBranch;
  const counts = changesWords(scope.cardsTotal, scope.otherTotal);
  const act = counts || ready > 0 ? "release" : null;
  if (!scope.sinceTag) {
    const what = counts ? `${counts} on ${branch}` : `nothing on ${branch} yet`;
    return { words: `Not released yet · ${what}${more}`, act, running: false };
  }
  const when = scope.sinceAt != null ? `, ${agoWords(scope.sinceAt, now)}` : "";
  const since = counts ? `${counts} since` : `nothing new on ${branch} since`;
  return { words: `${scope.sinceTag}${when} · ${since}${more}`, act, running: false };
}

/** "On this Mac only" → "on this Mac only": only the first letter, so
 *  `machineWords` still finds "this Mac". */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Branches that usually come before the cards' branch, and after it;
 *  any other name is "Also, on X". */
const EARLIER_BRANCHES = new Set(["staging", "develop", "dev", "preview", "qa", "test"]);
const LATER_BRANCHES = new Set(["main", "master", "production", "prod", "release", "live"]);

function otherBranchLabel(branch: string): string {
  if (EARLIER_BRANCHES.has(branch)) return `Earlier, on ${branch}`;
  if (LATER_BRANCHES.has(branch)) return `Later, on ${branch}`;
  return `Also, on ${branch}`;
}

/** Nothing to read at all: the page says GO_LIVE_NOTHING once. */
export function goLiveNothing(map: DeployMap | null): boolean {
  return !(map?.railway.services ?? []).some((s) => s.thisRepository) && (map?.workflows ?? []).length === 0;
}

/** Each area's Then, with nothing to read on a page of several areas. */
export const THEN_NOTHING = "Nothing Plyloft can see";

/**
 * One block per area (two or more), else one for the workspace. `areas` is
 * `AreasView.areas`; `branch` the workspace's branch.
 */
export function goLiveBlocks(input: {
  map: DeployMap | null;
  areas: readonly ResolvedArea[];
  branch: string;
  /** The Releases line of an area (null: the workspace's). */
  releasesFor: (area: ResolvedArea | null) => string;
}): GoLiveBlock[] {
  const { map, branch, releasesFor } = input;
  const areas = input.areas.length >= 2 ? input.areas : [];
  const services = (map?.railway.services ?? []).filter((s) => s.thisRepository);
  const workflows = map?.workflows ?? [];
  const nothing = services.length === 0 && workflows.length === 0;
  const scopes: (ResolvedArea | null)[] = areas.length ? [...areas] : [null];
  return scopes.map((area) => {
    const target = area?.branch ?? branch;
    const own = (s: RailwayService) => !area || areaOfService(s, areas)?.id === area.id;
    const onTarget = services.filter((s) => s.branch === target);
    const parts = [
      ...onTarget.filter(own).map((s) => `${serviceAddress(s)} updates`),
      ...onTarget.filter((s) => !own(s) && s.watchPatterns.length === 0).map((s) => `${serviceAddress(s)} restarts too`),
    ];
    const elsewhere = new Map<string, string[]>();
    for (const s of services.filter((x) => own(x) && x.branch && x.branch !== target)) {
      const list = elsewhere.get(s.branch!) ?? [];
      list.push(serviceAddress(s));
      elsewhere.set(s.branch!, list);
    }
    const earlier = [...elsewhere.entries()].map(([b, addresses]) => ({
      label: otherBranchLabel(b),
      addresses: addresses.join(" · "),
    }));
    const runs = checksFor(workflows, target);
    const now = services.filter(own).flatMap((s) => {
      const state = deployStateWords(s.deployStatus);
      if (!state) return [];
      // An address as it is written; "The app service" starts a line. One
      // that builds from another branch says which ("(on staging)"): the
      // same service name can be in several environments.
      const address = s.domains[0] ?? capital(serviceAddress(s));
      const elsewhere = s.branch && s.branch !== target ? ` (on ${s.branch})` : "";
      return [{ key: `${s.environment}/${s.name}`, address: `${address}${elsewhere}`, ...state }];
    });
    return {
      areaId: area?.id ?? null,
      name: area?.name ?? null,
      // A pull request needs the repository on GitHub.
      cardsGo: map?.repo ? `${target}, as pull requests` : target,
      then: nothing
        ? areas.length
          ? THEN_NOTHING
          : GO_LIVE_NOTHING
        : parts.length
          ? parts.join(" · ")
          : `Nothing Plyloft can see goes online from ${target}.`,
      earlier,
      checks: runs.length ? checksDetail(runs) : null,
      releases: releasesFor(area),
      now,
    };
  });
}
