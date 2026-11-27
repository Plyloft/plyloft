/**
 * 1.173.0 (G1): Settings › Shipping — the words and the rules of the page.
 * 1.174.0 (DS2, P26; settings.html scenes 3, 4, 15) gathers the whole path
 * of a card after the build, in the order things happen:
 *
 * - **Where cards go**: Cards go to (`integrationBranch`); with two or more
 *   areas, each area's own, changed in Areas.
 * - **Ship it**: How Ship it ships (`Workspace.shipVia`) and Fix failing
 *   checks by itself (`fixFailingChecks`) — this Mac's own (`workspaces.json`).
 * - **After shipping**: After a release, run (`installScript`).
 * - **Card branches**: Delete card branches when their trash expires
 *   (`keepCardBranches`, this Mac's) and the branches it kept.
 * - **Releases**: the default release kind of each area
 *   (`AreaDef.releaseKind`), or of the repository without areas (the
 *   definition's `releaseKind`; this Mac's own where it shares none), and the
 *   version files. Release… and Ship batch start from it
 *   (`defaultReleaseKind`); not chosen, it follows How Ship it ships.
 * - **How this goes live**: one summary line and Open (D2's sheet).
 *
 * "this Mac" is the caller's `machineWords`. Pure: node runs
 * `shippingPage.test.ts`.
 */
import type { AreaDef, AreaRelease, AreasView, DeployMap, ReleaseKind, ResolvedArea } from "../ipc.ts";
import { GO_LIVE_READ_FAILED, GO_LIVE_READING, listWords, railwayLine, readAgoWords, serviceAddress } from "./goLive.ts";
import { machineWords } from "./platform.ts";
import { agoWords } from "./copyWords.ts";
import { shipItGoesToGitHub } from "./shipVia.ts";

/** The settings section id (`settingsNav`), for every link to the page. */
export const SHIPPING_SETTINGS_SECTION = "shipping";
export const SHIPPING_TITLE = "Shipping";
export const SHIPPING_LEDE = "Where a card's change goes, how it leaves this Mac, and how it goes live.";

// ── The sections, in the order things happen (1.174.0, DS2) ─────────────
export const WHERE_CARDS_GO = "Where cards go";
export const SHIP_IT_SECTION = "Ship it";
export const AFTER_SHIPPING = "After shipping";
export const CARD_BRANCHES = "Card branches";
export const RELEASES = "Releases";

// ── The release kinds ───────────────────────────────────────────────────

/** Each kind's name, as Release… and Ship batch list it (`RELEASE_KINDS`,
 *  cardPage.ts, takes its labels from here). */
export const RELEASE_KIND_LABEL: Readonly<Record<ReleaseKind, string>> = {
  local: "On this Mac only",
  // 1.174.0 (DR6, P38/SL-12/G6, release.html table 12): the outcome, not
  // git's words; the saved ids stay.
  push_only: "Put the version on GitHub",
  github: "Put the version on GitHub, with a release page",
};

export const RELEASE_KIND_ORDER: readonly ReleaseKind[] = ["local", "push_only", "github"];

/** A kind as saved, or null for anything else (absent, a later build's). */
export function asReleaseKind(value: unknown): ReleaseKind | null {
  return value === "local" || value === "push_only" || value === "github" ? value : null;
}

/**
 * 1.174.0 (A1, SL-1c): the kind a release starts from where none was
 * chosen — it follows How Ship it ships: Ship it on GitHub → Tag and push,
 * Ship it only on this Mac (or a project that can't take a pull request) →
 * On this Mac only. Nothing is saved: the person's own choice still wins.
 * `onGitHub` is the card's reading (`workspaceShipOffersPr`); null while it
 * is read, which reads as this Mac.
 */
export function followedReleaseKind(
  shipVia: string | null | undefined,
  onGitHub: boolean | null | undefined,
): ReleaseKind {
  return shipItGoesToGitHub(shipVia, onGitHub) ? "push_only" : "local";
}

/** 1.174.0 (A1, owner): the Default release menu's first choice — not
 *  chosen, saved as none — so picking any kind always saves it. As a value
 *  (change lines, toasts, search) it reads "Same as Ship it". */
export const FOLLOW_SHIP_IT = "Same as Ship it";
/** The menu's value for it (a kind is never this). */
export const FOLLOW_VALUE = "follow";
/** Its label, with the kind it gives now: "Same as Ship it (Tag and push)"
 *  ("this Mac" is the caller's `machineWords`). */
export function followChoiceLabel(followed: ReleaseKind): string {
  return `${FOLLOW_SHIP_IT} (${RELEASE_KIND_LABEL[followed]})`;
}
/** The menu: Follow first, then the three kinds. */
export function defaultReleaseChoices(followed: ReleaseKind): { value: string; label: string }[] {
  return [
    { value: FOLLOW_VALUE, label: followChoiceLabel(followed) },
    ...RELEASE_KIND_ORDER.map((k) => ({ value: k as string, label: RELEASE_KIND_LABEL[k] })),
  ];
}

/**
 * Where Release… and Ship batch start: the area's default (`areaId`, in a
 * repository with areas), else the repository's (without areas), else —
 * nothing chosen — what How Ship it ships says (`followedReleaseKind`,
 * 1.174.0). An id the list doesn't have (B3's "default" stamp, a removed
 * area) is read as no area.
 */
export function defaultReleaseKind(
  view: Pick<AreasView, "areas" | "releaseKind"> | null | undefined,
  areaId: string | null | undefined,
  shipVia: string | null | undefined,
  onGitHub: boolean | null | undefined,
): ReleaseKind {
  return chosenDefaultKind(view, areaId) ?? followedReleaseKind(shipVia, onGitHub);
}

/** The Default release chosen for `areaId` (or the repository), else null. */
export function chosenDefaultKind(
  view: Pick<AreasView, "areas" | "releaseKind"> | null | undefined,
  areaId: string | null | undefined,
): ReleaseKind | null {
  if (!view) return null;
  if (view.areas.length > 0) {
    // The one area a project may list is the whole repository's.
    const area = areaId
      ? view.areas.find((a) => a.id === areaId)
      : view.areas.length === 1
        ? view.areas[0]
        : undefined;
    return asReleaseKind(area?.releaseKind);
  }
  return asReleaseKind(view.releaseKind);
}

/** The chosen kind where one was chosen (How this goes live's Releases
 *  line names it before the last release's), else null. */
export function chosenReleaseKind(
  view: Pick<AreasView, "areas" | "releaseKind"> | null | undefined,
  area: Pick<ResolvedArea, "id"> | null,
): ReleaseKind | null {
  if (!view) return null;
  if (area) return asReleaseKind(view.areas.find((a) => a.id === area.id)?.releaseKind);
  if (view.areas.length === 1) return asReleaseKind(view.areas[0].releaseKind);
  return view.areas.length > 0 ? null : asReleaseKind(view.releaseKind);
}

/** The areas list with one area's default kind set (null: not chosen). */
export function withAreaReleaseKind(list: readonly AreaDef[], id: string, kind: ReleaseKind | null): AreaDef[] {
  return list.map((a) => {
    if (a.id !== id) return a;
    const next: AreaDef = { ...a };
    if (kind) next.releaseKind = kind;
    else delete next.releaseKind;
    return next;
  });
}

/** A Releases row's line: "site-v3.0.1, 12 days ago · cards go to main"
 *  (1.174.0, DR6, P37: when, once `latestAt` is read). A kind not chosen
 *  says itself in the menu ("Same as Ship it (…)"), so the line doesn't
 *  repeat it (1.174.0, A1 round 1). */
export function releaseRowHint(
  release: Pick<AreaRelease, "latestTag"> | undefined | "reading",
  branch: string,
  latestAt: number | null = null,
  now: number = Date.now(),
): string {
  // G2 walk: the tags not read yet say nothing about them ("no tag yet"
  // was untrue until they were).
  if (release === "reading") return branch ? `cards go to ${branch}` : "Reading…";
  const tag = release?.latestTag
    ? `${release.latestTag}${latestAt != null ? `, ${agoWords(latestAt, now)}` : ""}`
    : "no tag yet";
  return branch ? `${tag} · cards go to ${branch}` : tag;
}

/** The repository's row without areas. */
export const DEFAULT_RELEASE_LABEL = "Default release";

/** 1.174.0 (DS2, scene 3): the line under Releases with two or more areas. */
export const RELEASES_PER_AREA_NOTE = "Where Release… starts for each area; each release can still choose.";

// ── What a Re-detect found for Shipping (1.174.0, DS2 round 1) ─────────

/** Shipping's two rows a scan of the repository fills: the version files
 *  and what runs after a release. */
export interface ShippingFind {
  versionFiles: unknown;
  installScript: string | null;
}

/** Building and checking's Re-detect on a shared project (the Set up flow
 *  lands there) drafts only its own checks: what it found for Shipping is
 *  handed over here, and Shipping puts it in its own draft when it opens —
 *  so each page's Review carries only its rows, and nothing found is lost. */
const shippingFinds = new Map<string, ShippingFind>();
export function handOffToShipping(workspaceId: string, find: ShippingFind): void {
  shippingFinds.set(workspaceId, find);
}
export function takeShippingFind(workspaceId: string): ShippingFind | null {
  const find = shippingFinds.get(workspaceId) ?? null;
  shippingFinds.delete(workspaceId);
  return find;
}

/** The toast after that Re-detect when it found something for Shipping. */
export const FOUND_FOR_SHIPPING = {
  title: "Version files and After a release, run were read too",
  body: "They're Shipping's rows: open it to see them and publish them from there.",
  action: "Open Shipping",
} as const;

/** Two-instance walk (B2): Re-detect on a shared project reads this folder,
 *  which may be behind the branch the team's checks live on — what it
 *  finds is a change to the shared setup, said before the press. */
export const RE_DETECT_SHARED_HINT =
  "The checks come from the shared setup. Re-detect reads this folder as it is, which may be behind the branch the setup is on; what it finds is a change to the shared checks, and nothing reaches anyone until you publish. The version files and After a release, run it finds wait in Shipping.";

/** …and after it, when what it found differs from the team's checks. */
export function reDetectChangesSharedToast(branch: string): { title: string; body: string } {
  return {
    title: "Re-detect proposes a change to the shared checks",
    body: `The checks come from the team's shared setup on ${branch}. This folder may be behind it: look at the change before you publish it.`,
  };
}

/** Version files' line with two or more areas: each can list its own. */
export const VERSION_FILES_AREAS_NOTE = "An area can list its own in Areas.";

/** Why the per-area rows can't change now: the areas break a rule. */
export const AREAS_BROKEN_HINT = "The areas break a rule; fix them in Settings › Project › Areas first.";

// ── Where cards go ──────────────────────────────────────────────────────

/** Cards go to with two or more areas: a summary, changed in Areas. */
export const CHANGE_IN_AREAS = "Change in Areas";

/** "Each area has its own: App → staging · Site → main." */
export function areasCardsGoHint(areas: readonly { name: string; branch: string }[]): string {
  return `Each area has its own: ${areas.map((a) => `${a.name} → ${a.branch}`).join(" · ")}.`;
}

// ── Ship it ─────────────────────────────────────────────────────────────

/** Fix failing checks by itself's line here (one line; the card's own switch
 *  and the guide say the rest). */
export const FIX_FAILING_CHECKS_HINT =
  "If GitHub's checks fail on a card's pull request, the Builder fixes them and the Reviewer checks the fix; up to 3 tries. The default for new cards; each card can turn it on or off.";

export const DELETE_CARD_BRANCHES = "Delete card branches when their trash expires";
export const DELETE_CARD_BRANCHES_HINT =
  "7 days after a card's copy goes to the trash, its branch on this Mac goes too — never one with commits made after it shipped, and never one checked out. Archived cards' branches are asked about in the Inbox first.";

// ── Card branches ───────────────────────────────────────────────────────

/** 1.174.0 (DS2, SL-3): the branches the cleanup kept, moved here from
 *  Cards' copies — a row with "Show N" that opens them. */
export const KEPT_AFTER_SHIPPING = "Kept after shipping";
/** Its sub-page's id (`RepositoryPage` `subPages`). */
export const KEPT_BRANCHES_SUB = "kept-branches";
/** The GitHub half of the row's line, and of the sub-page's lede. */
export const GITHUB_DELETES_OWN_BRANCH = "On GitHub, Plyloft deletes only a card's own branch, once its pull request merged.";
export const GITHUB_DELETE_HEAD_BRANCHES =
  "To have GitHub delete other merged branches too, turn on “Automatically delete head branches” in the repository's settings.";

/** "2 branches with commits made after they shipped. On GitHub, …" — said
 *  by why they were kept: after they shipped, else simply kept. */
export function keptBranchesHint(kept: readonly { afterShip: boolean }[]): string {
  const n = kept.length;
  const what = n === 1 ? "1 branch" : `${n} branches`;
  const why = kept.every((k) => k.afterShip)
    ? `${what} with commits made after ${n === 1 ? "it" : "they"} shipped.`
    : `${what} kept.`;
  return `${why} ${GITHUB_DELETES_OWN_BRANCH}`;
}

export function showKeptLabel(n: number): string {
  return `Show ${n}`;
}

// ── How this goes live ──────────────────────────────────────────────────

export const GO_LIVE_OPEN = "Open";
/** Nothing to read: the first sentence of the sheet's calm line. */
export const GO_LIVE_SUMMARY_NOTHING = "Plyloft doesn't see where this project goes online.";

export type GoLiveReading = { kind: "reading" } | { kind: "read"; map: DeployMap } | { kind: "failed" };

/**
 * The section's one line: the addresses that go online and when Railway was
 * read ("www.lyrappc.com and app.lyrappc.com · read from Railway 3 min
 * ago"), else the GitHub checks' files, else the calm line.
 */
export function goLiveSummary(reading: GoLiveReading, now: number): string {
  if (reading.kind === "reading") return GO_LIVE_READING;
  if (reading.kind === "failed") return GO_LIVE_READ_FAILED;
  const { map } = reading;
  const services = map.railway.services.filter((s) => s.thisRepository);
  if (services.length > 0) {
    const addresses = [...new Set(services.map(serviceAddress))];
    const ago = readAgoWords(map.railway.readAt ?? null, now);
    // "The worker service" starts the line; an address is as it is written.
    const where = listWords(addresses).replace(/^the /, "The ");
    return ago ? `${where} · ${ago}` : where;
  }
  // The sheet's line when a project that uses Railway can't be read here.
  const noCli = map.railway.state === "noCli" ? railwayLine(map.railway, map.railwayFiles ?? false) : null;
  if (noCli) return machineWords(noCli.text);
  const files = [...new Set(map.workflows.map((w) => w.file))];
  if (files.length > 0) return `GitHub runs checks from ${listWords(files)}`;
  return GO_LIVE_SUMMARY_NOTHING;
}

/** The way to the page from another (an area's Default release, DS6). */
export const OPEN_SHIPPING = "Open Shipping";
