/**
 * 1.174.0 (DR3, D1(b)): the words and rules of the one Release sheet
 * (mockups/release.html states 1–5 and the refusals of state 9). A release
 * of an area takes everything on its branch since its last tag
 * (`release_scope`): the cards that got there with Ship it, the other
 * changes, and the ready cards not there yet that the person ticks.
 * Any number of ready cards goes into one release, on every plan.
 *
 * Pure: no React, no store, no IPC. "this Mac" is said here as on a Mac; the
 * sheet draws it through `machineWords` (this PC on Windows).
 */
import type {
  PrReleaseStep,
  ReleaseKind,
  ReleasePrRecord,
  ReleaseOtherChange,
  ReleaseScope,
  ReleaseScopeCard,
  ReleaseStopped,
  ReleaseVersionChoice,
} from "../ipc.ts";
import { agoWords } from "./copyWords.ts";
import { changesWords } from "./goLive.ts";

export const WHATS_IN_IT = "What’s in it";
export const ANOTHER_VERSION = "Another version…";
export const RELEASE_WITHOUT_CHECKS = "Release without checks";
export const STOP_THE_RELEASE = "Stop the release";
export const STOP_WORK_AND_RELEASE = "Stop the work and release now";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Also ready, not on main yet" on another branch. */
export function alsoReadyHeading(branch: string): string {
  return `Also ready, not on ${branch} yet`;
}

/** Cards and other changes on the branch since the last tag. */
export function scopeNews(scope: Pick<ReleaseScope, "cardsTotal" | "otherTotal">): number {
  return scope.cardsTotal + scope.otherTotal;
}

/** Something to release: what is on the branch since the last tag, or a
 *  ready card — and the area isn't refused. */
export function scopeHasSomething(scope: ReleaseScope): boolean {
  return scope.refusal === null && (scopeNews(scope) > 0 || scope.readyCardIds.length > 0);
}

/** "· 1 more card ready" after the counts. */
function moreReady(n: number): string {
  return n > 0 ? ` · ${plural(n, "more card")} ready` : "";
}

/** The release of nothing new: "Nothing new on main since site-v3.0.1,
 *  released yesterday." / "Nothing on main for Site yet." */
export function nothingNewWords(
  scope: Pick<ReleaseScope, "targetBranch" | "sinceTag" | "sinceAt">,
  name: string | null,
  now: number,
): string {
  const branch = scope.targetBranch;
  if (scope.sinceTag) {
    const when = scope.sinceAt != null ? `, released ${agoWords(scope.sinceAt, now)}` : "";
    return `Nothing new on ${branch} since ${scope.sinceTag}${when}.`;
  }
  return name ? `Nothing on ${branch} for ${name} yet.` : `Nothing on ${branch} yet.`;
}

/** What is new, as the ⋯ and ⌘K say it: "4 cards and 2 other changes on main
 *  since site-v3.0.1 · 1 more card ready". Empty with nothing new. */
export function newSinceWords(scope: ReleaseScope): string {
  const counts = changesWords(scope.cardsTotal, scope.otherTotal);
  if (!counts) return "";
  const since = scope.sinceTag ? ` since ${scope.sinceTag}` : "";
  return `${counts} on ${scope.targetBranch}${since}${moreReady(scope.readyCardIds.length)}`;
}

/** What one opener of the release says, and whether it is off. */
export interface ReleaseOpener {
  hint: string;
  off: boolean;
}

/** Release Site… in the Board's ⋯ (state 1): on as soon as something new is
 *  on the branch, with or without ready cards; off with the true reason. A
 *  release on its way opens the sheet too. */
export function releaseOpener(scope: ReleaseScope, name: string | null, now: number): ReleaseOpener {
  if (scope.inFlight) return { hint: `${scope.inFlight.tag} is on its way`, off: false };
  if (scope.refusal) return { hint: scope.refusal, off: true };
  const news = newSinceWords(scope);
  if (news) return { hint: news, off: false };
  const ready = scope.readyCardIds.length;
  if (ready > 0) return { hint: `${plural(ready, "card")} ready, not on ${scope.targetBranch} yet`, off: false };
  if (scope.countProblem) return { hint: scope.countProblem, off: true };
  return { hint: nothingNewWords(scope, name, now), off: true };
}

/** The sheet's lede (state 2, 3). */
export function releaseLede(scope: ReleaseScope, name: string, now: number, ready = 0): string {
  const branch = scope.targetBranch;
  // Walk fix (DR3 early walk): with nothing new on the branch, the ⋯'s true
  // sentence — and, with ready cards, what a version can still carry.
  if (scopeNews(scope) === 0) {
    const nothing = nothingNewWords(scope, name, now);
    return ready > 0 ? `${nothing} A new version can still carry the ready ${ready === 1 ? "card" : "cards"} below.` : nothing;
  }
  if (scope.sinceTag) {
    const when = scope.sinceAt != null ? `, released ${agoWords(scope.sinceAt, now)}` : "";
    return `A new version of ${name} with everything on ${branch} since ${scope.sinceTag}${when}.`;
  }
  return `${name} hasn't been released yet. Its first version has everything on ${branch} so far.`;
}

/** "4 cards · 2 other changes" beside What's in it. */
export function whatsInCount(scope: Pick<ReleaseScope, "cardsTotal" | "otherTotal">): string {
  const parts = [
    ...(scope.cardsTotal > 0 ? [plural(scope.cardsTotal, "card")] : []),
    ...(scope.otherTotal > 0 ? [plural(scope.otherTotal, "other change")] : []),
  ];
  return parts.join(" · ");
}

/** A card on the branch: "Pull request #382 · merged 3 days ago". */
export function scopeCardHint(card: Pick<ReleaseScopeCard, "prNumber" | "at">, now: number): string {
  const ago = agoWords(card.at, now);
  return card.prNumber != null ? `Pull request #${card.prNumber} · merged ${ago}` : `Merged ${ago}`;
}

/** Another change: "Pull request #386 by dependabot · merged 5 days ago",
 *  "Change by test-owner · 4 days ago". */
export function otherChangeHint(change: Pick<ReleaseOtherChange, "prNumber" | "author" | "at">, now: number): string {
  const ago = agoWords(change.at, now);
  const by = change.author.trim();
  if (change.prNumber != null) return `Pull request #${change.prNumber}${by ? ` by ${by}` : ""} · merged ${ago}`;
  return by ? `Change by ${by} · ${ago}` : `Change · ${ago}`;
}

/** How many cards What's in it lists before it folds the rest. */
export const CARDS_SHOWN = 4;

/** What's in it: the cards listed at once, and the fold under them. With
 *  more cards than `CARDS_SHOWN`, two are listed and the fold holds the
 *  rest with the other changes ("7 more cards and 14 other changes"); else
 *  every card, and the fold holds the other changes ("2 other changes on
 *  main · not from a card"). */
export function whatsInFold(scope: ReleaseScope): { shown: ReleaseScopeCard[]; fold: string | null; foldHasCards: boolean } {
  if (scope.cardsTotal > CARDS_SHOWN) {
    const shown = scope.cards.slice(0, 2);
    const more = scope.cardsTotal - shown.length;
    const others = scope.otherTotal > 0 ? ` and ${plural(scope.otherTotal, "other change")}` : "";
    return { shown, fold: `${plural(more, "more card")}${others}`, foldHasCards: true };
  }
  const fold =
    scope.otherTotal > 0
      ? `${plural(scope.otherTotal, "other change")} on ${scope.targetBranch} · not from a card`
      : null;
  return { shown: scope.cards, fold, foldHasCards: false };
}

/** A ready card's row: "Checked and approved · goes into the release as its
 *  own change". */
export function readyCardHint(checksSkipped: boolean): string {
  return `${checksSkipped ? "Checks skipped" : "Checked and approved"} · goes into the release as its own change`;
}

// ── Ticks ─────────────────────────────────────────────────────────────────

/** The ready cards ticked when the sheet opens: the ones asked for (a card's
 *  own Release…, Release N…, the List's selection) that are ready, else every
 *  ready card — "Also ready" is ticked by default (owner). */
export function initialTicks(ready: readonly string[], asked: readonly string[] | undefined): string[] {
  return asked && asked.length > 0 ? ready.filter((id) => asked.includes(id)) : [...ready];
}

// ── Version (patch by default, minor and major a click away) ──────────────

/** A version choice's hint. */
export function versionHint(
  choice: ReleaseVersionChoice,
  scope: Pick<ReleaseScope, "versionSource" | "throughGithub"> & Partial<Pick<ReleaseScope, "inFlight">>,
): string {
  // G2 walk (Mac): its release branch is on GitHub already — this
  // project's own release on its way, or one left there.
  if (choice.onItsWay) {
    return scope.inFlight?.tag === choice.tag
      ? `A release of ${choice.tag} is already on its way on GitHub.`
      : `GitHub already has a release branch for ${choice.tag}: a release of it is open or left over there. Choose another version.`;
  }
  if (choice.taken) return `${choice.tag} is already a tag${scope.throughGithub ? " on GitHub" : ""}.`;
  switch (choice.kind) {
    case "patch":
      return "Fixes and small changes";
    case "minor":
      return "Something new";
    case "major":
      return "A change that breaks something people rely on";
    case "asIs":
      return scope.versionSource && scope.versionSource !== "tag"
        ? `What ${scope.versionSource} says now`
        : "The version as it is now";
    case "first":
      return "A first version that isn't final yet";
  }
}

/** Under the versions: where the current version was read. "Site’s version
 *  file, site/package.json, says 3.0.1 on GitHub; the latest tag is
 *  site-v3.0.1." Null when there is nothing to say. */
export function versionSourceLine(scope: ReleaseScope, name: string | null): string | null {
  const tag = scope.sinceTag ? `the latest tag is ${scope.sinceTag}` : null;
  const source = scope.versionSource;
  if (source && source !== "tag" && scope.fileVersion) {
    const owner = name ? `${name}’s` : "The project’s";
    const where = scope.versionOnGithub ? " on GitHub" : "";
    return `${owner} version file, ${source}, says ${scope.fileVersion}${where}${tag ? `; ${tag}` : ""}.`;
  }
  return tag ? `The latest tag is ${scope.sinceTag}.` : null;
}

/** The tag a typed version would make: "site-v3.0.2". */
export function tagOf(prefix: string, version: string): string {
  const v = version.trim().replace(/^v/i, "");
  return `${prefix}v${v}`;
}

/** A typed version whose tag is one of the scope's taken ones. */
export function takenTag(scope: Pick<ReleaseScope, "versions">, tag: string): boolean {
  return scope.versions.some((v) => v.taken && v.tag === tag);
}

// ── How far it goes ────────────────────────────────────────────────────────

/** A kind's hint in the sheet (state 2, 3). `owner` names whose default it
 *  is ("Site", or null for the project) when it is the one chosen in
 *  Settings › Cards › Shipping. */
export function kindHint(
  kind: ReleaseKind,
  input: {
    throughGithub: boolean;
    branch: string;
    installScript?: string | null;
    /** 1.175.0 B2 (round 2): the install step waits for this Mac's OK, so
     *  the release doesn't run it — it asks. */
    installWaits?: boolean;
    chosenDefault: boolean;
    owner: string | null;
  },
): string {
  const { throughGithub, branch, installScript, chosenDefault, owner } = input;
  const install = !installScript
    ? ""
    : input.installWaits
      ? `, then asks before it runs the install step (${installScript}), which this Mac hasn't allowed yet`
      : `, and runs the install step (${installScript})`;
  const base =
    kind === "local"
      ? `Makes the new version on this Mac, from this Mac’s ${branch}${install}. ${throughGithub ? "Nothing goes to GitHub." : "Nothing is pushed."}`
      : kind === "push_only"
        ? throughGithub
          ? "A release pull request on GitHub, merged when its checks pass, then tagged."
          : "Also pushes the release and its tag, for anything that deploys from a push."
        : throughGithub
          ? "The same, then a release page on GitHub with what’s in it."
          : "Pushes the release and its tag; the release page on GitHub is created by your own workflow, if you have one.";
  if (!chosenDefault) return base;
  return `${owner ? `${owner}’s` : "The project’s"} default (Settings › Cards › Shipping). ${base}`;
}

/** "On this Mac only" on a GitHub project whose target here is behind. */
export function behindLine(branch: string, behind: number): string {
  return `This Mac’s ${branch} is ${plural(behind, "change")} behind ${branch} on GitHub. Plyloft brings it up to date first; nothing is sent to GitHub.`;
}

/** "On this Mac only" off: both moved on. */
export function divergedLine(branch: string): string {
  return `This Mac’s ${branch} and GitHub’s both have changes the other doesn’t. Release on GitHub instead, or bring them together in Code first.`;
}

/** Whether a kind goes through a release pull request on GitHub. */
export function throughPr(kind: ReleaseKind, throughGithub: boolean): boolean {
  return throughGithub && kind !== "local";
}

/** The one line that says what the press will do. */
export function pressSummary(input: {
  tag: string;
  branch: string;
  kind: ReleaseKind;
  throughGithub: boolean;
  ticked: number;
  skipVerify: boolean;
}): string {
  const { tag, branch, kind, throughGithub, ticked, skipVerify } = input;
  const more = ticked > 0 ? ` with ${plural(ticked, "more card")}` : "";
  const checks = skipVerify ? "" : ", runs your checks on it,";
  if (throughPr(kind, throughGithub)) {
    const page = kind === "github" ? " and makes its release page" : "";
    return `Plyloft makes ${tag} from ${branch} on GitHub${more}${checks} and opens a release pull request. GitHub merges it when its checks pass; then Plyloft tags it${page}.`;
  }
  if (kind === "local") {
    const nothing = throughGithub ? " Nothing goes to GitHub." : "";
    return `Plyloft makes ${tag} on this Mac from this Mac’s ${branch}${more}${checks} and tags it.${nothing}`;
  }
  return `Plyloft makes ${tag} on this Mac from this Mac’s ${branch}${more}${checks} tags it and pushes it.`;
}

/** The foot's note: "Cards go to main · 6 changes, 1 more card". */
export function footWords(scope: Pick<ReleaseScope, "targetBranch" | "cardsTotal" | "otherTotal">, ticked: number): string {
  const news = scopeNews(scope);
  const parts = [
    ...(news > 0 ? [plural(news, "change")] : []),
    ...(ticked > 0 ? [plural(ticked, "more card")] : []),
  ];
  return `Cards go to ${scope.targetBranch}${parts.length ? ` · ${parts.join(", ")}` : ""}`;
}

/** Technical details (state 2b): where it is made, its branch, its tag. */
export function technicalLines(scope: ReleaseScope, tag: string, kind: ReleaseKind, checks: string | null = null): string[] {
  const branch = scope.targetBranch;
  const pr = throughPr(kind, scope.throughGithub);
  const head = scope.head ? `, at ${scope.head.slice(0, 7)}` : "";
  const since = scope.sinceTag
    ? `Since ${scope.sinceTag}${scope.folder ? ` · only changes in the ${scope.folder} folder` : ""}`
    : `Everything on ${branch} so far${scope.folder ? ` · only changes in the ${scope.folder} folder` : ""}`;
  return [
    pr ? `Made from ${branch} on GitHub${head} · cards go to ${branch}` : `Made from this Mac’s ${branch} · cards go to ${branch}`,
    ...(pr ? [`Release branch plyloft/release-${tag}`] : []),
    pr ? `Tag ${tag}, on the merge` : `Tag ${tag}`,
    since,
    // DR3 round 1: the GitHub checks a release pull request to the branch
    // runs (`deploy_map`'s workflows): "Checks site and test, from site.yml".
    ...(pr && checks ? [`Checks ${checks}`] : []),
  ];
}

/** Release without checks: what becomes of the tag. */
export function withoutChecksLine(tag: string, _kind?: ReleaseKind): string {
  // G2 walk (Mac): one sentence whatever the kind (it read as if it changed
  // once the release started).
  return `The tag becomes ${tag}-unverified, and it’s never put on GitHub with a release page.`;
}

// ── Refusals before the press (state 9) ───────────────────────────────────

/** A version whose tag exists already. */
export function takenWords(tag: string, throughGithub: boolean): string {
  return `${tag} is already a tag${throughGithub ? " on GitHub" : ""}. Choose another version.`;
}

/** Another release of the area on its way. */
export function onItsWayWords(inFlight: NonNullable<ReleaseScope["inFlight"]>, name: string | null): string {
  const pr = inFlight.prNumber != null ? ` (release pull request #${inFlight.prNumber})` : "";
  return `${inFlight.tag} is on its way${pr}. Only one release of ${name ?? "this project"} at a time.`;
}

export const ANOTHER_RUNNING = "Another release or land of this project is still running. Wait for it to finish.";

// ── Which area (state 4) ───────────────────────────────────────────────────

export const WHICH_AREA_TITLE = "Release which area?";
export const WHICH_AREA_LEDE = "A release is of one area, with its own version and tag.";

/** One area's line in the chooser. `act`: it can be released. */
export function areaChoiceWords(scope: ReleaseScope, name: string, now: number): { words: string; act: boolean } {
  if (scope.inFlight) return { words: onItsWayWords(scope.inFlight, name), act: true };
  if (scope.refusal) return { words: scope.refusal, act: false };
  const news = newSinceWords(scope);
  if (news) return { words: news, act: true };
  const ready = scope.readyCardIds.length;
  if (ready > 0) return { words: `${plural(ready, "card")} ready, not on ${scope.targetBranch} yet`, act: true };
  return {
    words: scope.sinceTag ? `Nothing new for ${name} since ${scope.sinceTag}.` : nothingNewWords(scope, name, now),
    act: false,
  };
}

/** State 4: a refused area whose fix is in Settings › Project › Areas (its
 *  version file, or a refusal that names Areas) carries Open Areas; any
 *  other refusal is words alone. */
export const OPEN_AREAS = "Open Areas";
export function areaRefusalFix(refusal: string | null): "areas" | null {
  return refusal && (/no version file/i.test(refusal) || /Settings \u203A (Project \u203A )?Areas/.test(refusal)) ? "areas" : null;
}

/** The area to open at once: the only one with something to release (or a
 *  release on its way); null when the person has to choose. */
export function onlyAreaWithSomething(scopes: readonly ReleaseScope[]): ReleaseScope | null {
  const live = scopes.filter((s) => s.inFlight !== null || scopeHasSomething(s));
  return live.length === 1 ? live[0] : null;
}

// ── Stop the release (DR2) ────────────────────────────────────────────────

/** `ShipError::Stopped` from releaseTheArea, shipBatch or shipCard. */
export function decodeStopped(e: unknown): ReleaseStopped["stopped"] | null {
  if (!e || typeof e !== "object" || !("stopped" in e)) return null;
  const s = (e as ReleaseStopped).stopped;
  return s && typeof s === "object" && typeof s.tag === "string" ? s : null;
}

/** The person's own stop, said once (a toast, or the sheet). */
export function stoppedWords(stopped: ReleaseStopped["stopped"]): { title: string; body: string } {
  const there = stopped.onGithub
    ? stopped.onGithub
    : stopped.github
      ? "Nothing went to GitHub, and the release was taken back."
      : "The release was taken back.";
  return { title: `${stopped.tag} is stopped`, body: stopped.here ? `${there} ${stopped.here}` : there };
}

// ── The Board's ⋯ › Release Site… (state 1) ───────────────────────────────

/** The off item's hint while the scopes are read the first time. */
export const RELEASE_MENU_READING = "Reading…";
/** On All areas, two or more areas have something: the sheet asks. */
export const RELEASE_MENU_ASKS = "Asks which area to release";
/** On All areas, no area has anything new. */
export const RELEASE_MENU_NOTHING = "Nothing new to release in any area yet.";

export interface BoardReleaseItem {
  label: string;
  hint: string | undefined;
  off: boolean;
  /** The area the sheet opens on; undefined: it asks (or decides). */
  areaId: string | null | undefined;
}

/** The Board's ⋯ › Release Site… from the last reading of the scopes: the
 *  current area's, the project's without two areas, or — on All areas — the
 *  one area with something, or a question when several have. Before the
 *  first reading, off ("Reading…"); a reading that failed leaves it on (the
 *  sheet says what it can't read). */
export function boardReleaseItem(
  reading: { scopes: readonly ReleaseScope[] | null; failed: boolean },
  areas: readonly { id: string; name: string }[],
  current: { id: string; name: string } | null,
  now: number,
): BoardReleaseItem {
  const named = (name: string | null | undefined) => (name ?? "").trim() || null;
  const label = (name: string | null) => (name ? `Release ${name}…` : "Release…");
  const many = areas.length >= 2;
  const currentName = current ? named(current.name) ?? current.id : null;
  const { scopes, failed } = reading;
  if (scopes === null) {
    return { label: label(currentName), hint: failed ? undefined : RELEASE_MENU_READING, off: !failed, areaId: current?.id ?? (many ? undefined : null) };
  }
  const one = (sc: ReleaseScope | undefined, name: string | null): BoardReleaseItem => {
    if (!sc) return { label: label(name), hint: undefined, off: false, areaId: current?.id ?? (many ? undefined : null) };
    const opener = releaseOpener(sc, name, now);
    return { label: label(name), hint: opener.hint, off: opener.off, areaId: sc.area };
  };
  if (!many) return one(scopes[0], null);
  if (current) return one(scopes.find((sc) => sc.area === current.id), currentName);
  const live = scopes.filter((sc) => sc.inFlight !== null || scopeHasSomething(sc));
  if (live.length === 1) return one(live[0], named(live[0].name) ?? live[0].area);
  if (live.length > 1) return { label: label(null), hint: RELEASE_MENU_ASKS, off: false, areaId: undefined };
  return { label: label(null), hint: RELEASE_MENU_NOTHING, off: true, areaId: undefined };
}

// ── DR4: on its way, Stop, done, errors (release.html states 6–9, 11) ────

export type ProgressState = "done" | "running" | "todo" | "warn" | "failed";

/** One step of a release on its way: a dot (or a ring for a step to come)
 *  and its words, with a muted line under some. */
export interface ProgressStep {
  key: string;
  state: ProgressState;
  label: string;
  sub?: string | null;
}

const PR_ORDER: readonly PrReleaseStep[] = ["building", "built", "pushed", "open", "merging", "merged", "tagged"];

/** The steps of a release, from its record (`PrReleaseStep`; null before
 *  the record is written, or for a release kept on this Mac). `done`: every
 *  step is behind it. */
export function progressSteps(input: {
  tag: string;
  branch: string;
  kind: ReleaseKind;
  throughPr: boolean;
  step: PrReleaseStep | null;
  pr?: Pick<ReleasePrRecord, "number" | "waiting" | "outdated" | "plyloftMerges" | "checksFailed"> | null;
  /** It stopped while it was being made (a quit, a crash). */
  stopped?: boolean;
  done?: boolean;
  /** DR4 round 1: no record yet — even "made" is still under way. */
  making?: boolean;
}): ProgressStep[] {
  const { tag, branch, kind, throughPr, pr, stopped, done } = input;
  if (!throughPr) {
    return done
      ? [
          { key: "made", state: "done", label: `Made on this Mac from this Mac’s ${branch}` },
          { key: "tag", state: "done", label: `Tagged ${tag}` },
        ]
      : [
          { key: "made", state: "running", label: `Making it on this Mac from this Mac’s ${branch}`, sub: "Your checks run on it first" },
          { key: "tag", state: "todo", label: `Tag it ${tag}` },
        ];
  }
  const at = done ? PR_ORDER.length - 1 : Math.max(0, PR_ORDER.indexOf(input.step ?? "building"));
  const n = pr?.number != null ? ` #${pr.number}` : "";
  const page = kind === "github" ? " · release page made" : "";
  const checks: ProgressStep =
    at === 0
      ? stopped
        ? { key: "checks", state: "failed", label: "Stopped while it was being made", sub: pr?.waiting ?? null }
        : { key: "checks", state: "running", label: "Running your checks on it" }
      : { key: "checks", state: "done", label: "Your checks passed on it" };
  const open: ProgressStep =
    at === 0
      ? { key: "open", state: "todo", label: "Open the release pull request on GitHub" }
      : at < 3
        ? { key: "open", state: "running", label: "Opening the release pull request on GitHub" }
        : { key: "open", state: "done", label: `Release pull request${n} opened on GitHub` };
  const merge: ProgressStep =
    at < 3
      ? { key: "merge", state: "todo", label: "Merge it when GitHub’s checks pass" }
      : at < 5
        ? pr?.checksFailed
          ? { key: "merge", state: "warn", label: "GitHub’s checks failed", sub: pr.waiting ?? null }
          : pr?.outdated
          ? { key: "merge", state: "warn", label: `Behind ${branch} on GitHub`, sub: `GitHub won’t merge it until it has ${branch}’s new changes` }
          : {
              key: "merge",
              state: "running",
              label: "Waiting for GitHub’s checks",
              sub: pr?.waiting ?? (pr?.plyloftMerges ? "Plyloft merges it when they pass" : "GitHub merges it when they pass"),
            }
        : { key: "merge", state: "done", label: `Release pull request${n} merged` };
  const tagStep: ProgressStep =
    at < 5
      ? { key: "tag", state: "todo", label: `Tag it ${tag}` }
      : at === 5
        ? { key: "tag", state: "running", label: `Tagging it ${tag}` }
        : { key: "tag", state: "done", label: `Tagged ${tag}${page}` };
  if (input.making) {
    return [
      { key: "made", state: "running", label: `Making it on this Mac from ${branch} on GitHub` },
      { ...checks, state: "todo", label: "Run your checks on it" },
      open,
      merge,
      tagStep,
    ];
  }
  return [
    { key: "made", state: "done", label: `Made on this Mac from ${branch} on GitHub` },
    checks,
    open,
    merge,
    tagStep,
  ];
}

/** The sentence under the steps: what Stop does now, or what happens if
 *  the person closes the sheet. Null when there is nothing to add. */
export function progressNote(input: {
  tag: string;
  branch: string;
  throughPr: boolean;
  step: PrReleaseStep | null;
  pr?: Pick<ReleasePrRecord, "outdated" | "plyloftMerges"> | null;
}): string | null {
  const { tag, branch, throughPr, pr } = input;
  if (!throughPr) return null;
  const at = Math.max(0, PR_ORDER.indexOf(input.step ?? "building"));
  if (at <= 1) return "Nothing is on GitHub yet. Stop takes it back.";
  if (at >= 5) return null;
  if (pr?.outdated) {
    return `Update the release brings ${branch}’s new changes into it, checks it again and sends it. They’ll be in ${tag} too.`;
  }
  return pr?.plyloftMerges
    ? "Plyloft merges it once the checks pass, only while Plyloft is open on this Mac."
    : "You can close this and quit Plyloft: GitHub merges it by itself, and Plyloft tags it the next time it’s open.";
}

/** Whether Stop is still offered: until the pull request is merged. */
export function stopOffered(step: PrReleaseStep | null): boolean {
  return step === null || PR_ORDER.indexOf(step) < PR_ORDER.indexOf("merged");
}

/** Stop asks first once the release is on GitHub (its pull request may be
 *  open): only its merging by itself is turned off. */
export function stopAsks(step: PrReleaseStep | null): boolean {
  return step !== null && PR_ORDER.indexOf(step) >= PR_ORDER.indexOf("pushed") && stopOffered(step);
}

/** State 7: Stop's question. */
export function stopConfirmWords(tag: string, prNumber: number | null, branch?: string): { title: string; body: string } {
  // DR4 round 1: pushed, no pull request opened yet — its branch is what
  // stays on GitHub.
  if (prNumber == null && branch) {
    return {
      title: `Stop ${tag}?`,
      body: `Plyloft forgets the release here. Its branch ${branch} stays on GitHub; no pull request was opened. Nothing was tagged.`,
    };
  }
  const pr = prNumber != null ? `Release pull request #${prNumber}` : "Its release pull request";
  return {
    title: `Stop ${tag}?`,
    body: `Plyloft turns off its merging by itself and forgets the release here. ${pr} stays open on GitHub: close it there if you don’t want it. Nothing was tagged.`,
  };
}
export const KEEP_IT_GOING = "Keep it going";

/** "4 cards and 2 other changes from main, and Blog: RSS feed for posts." —
 *  what a release on its way carries. */
export function progressLede(input: {
  branch: string;
  mergedCards: number;
  otherChanges: number;
  ticked: readonly string[];
}): string {
  const counts = changesWords(input.mergedCards, input.otherChanges);
  const t = input.ticked;
  const more = t.length === 0 ? "" : t.length === 1 ? t[0].trim() || "1 more card" : `${t.length} more cards`;
  if (counts && more) return `${counts} from ${input.branch}, and ${more}.`;
  if (counts) return `${counts} from ${input.branch}.`;
  if (more) return `${more}, on ${input.branch}.`;
  return `Everything on ${input.branch} since its last release.`;
}

/** State 8: done. */
export function releasedWords(input: {
  tag: string;
  cards: number;
  otherChanges: number;
  prNumber: number | null;
  page: boolean;
  throughPr: boolean;
}): { title: string; lede: string } {
  const what = changesWords(input.cards, input.otherChanges) || "Its version";
  // G2 walk (Mac): "release pull request #N", or "its release pull request".
  const pr = input.prNumber != null ? `release pull request #${input.prNumber}` : "its release pull request";
  const lede = input.throughPr
    ? `${what}, merged as ${pr} and tagged ${input.tag}.${input.page ? " The release page is on GitHub." : ""}`
    : `${what}, made and tagged on this Mac.`;
  return { title: `${input.tag} is released`, lede: lede.charAt(0).toUpperCase() + lede.slice(1) };
}

/** The release page of a tag, from its pull request's address. */
export function releasePageUrl(prUrl: string | null | undefined, tag: string): string | null {
  const m = prUrl ? /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/.exec(prUrl) : null;
  return m ? `${m[1]}/releases/tag/${encodeURIComponent(tag)}` : null;
}

/** State 9: a release that can't go on by itself. */
export function stoppedReleaseWords(
  tag: string,
  problem: string,
  branch: string,
  readyCards = 0,
): { title: string; lede: string } {
  // DR4 round 1: with cards of its own, they are still ready.
  const ready = readyCards > 0 ? ", and the ready cards are still ready" : "";
  return {
    title: `${tag} can't go on by itself`,
    lede: `${problem.trim()} Nothing was tagged, and nothing in it is lost: the changes are still on ${branch}${ready}.`,
  };
}

/** The sidebar's row (state 11): "Releasing site-v3.0.2 · checks running". */
export function releasingRowWords(
  tag: string,
  step: PrReleaseStep | null,
  problem: string | null,
  checksFailed = false,
): string {
  if (problem) return `${tag} stopped`;
  if (checksFailed) return `${tag} is waiting · GitHub's checks failed`;
  if (step === null) return `${tag} isn't published yet`;
  if (step === "building" || step === "built") return `Releasing ${tag} · checks running`;
  if (step === "merged") return `Releasing ${tag} · tagging it`;
  if (step === "tagged") return `Releasing ${tag}`;
  return `Releasing ${tag} · waiting for GitHub's checks`;
}

/** The area whose tags start like this one ("site-v3.0.2" → the area with
 *  the prefix "site-"); null for the first area's plain vX.Y.Z, or none. */
export function areaOfTag(areas: readonly { id: string; tagPrefix?: string | null }[], tag: string): string | null {
  let best: { id: string; len: number } | null = null;
  for (const a of areas) {
    const p = a.tagPrefix ?? "";
    if (p && tag.startsWith(`${p}v`) && (!best || p.length > best.len)) best = { id: a.id, len: p.length };
  }
  return best?.id ?? null;
}
