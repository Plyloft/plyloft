// UX language card 4 (GH #96, ADR 0005; docs/ux-language/boards/BOARDS.md §3):
// the Library › Skills page, as a view model.
//
// Here rather than in JSX for the reason `projectSkills.ts` and `teamSkills.ts`
// are: which scope a skill belongs to, which CLIs it reaches, whether another
// scope carries the same name, what is happening to it right now and what its
// `⋯` may offer are rules about the product, and rules get tests.
//
// Two flags, deliberately not one:
//
// - **`readOnly`** — the skill's own files are not Ply's to change. True for
//   every personal skill (ADR 0005: "Ply never writes them") and for a Ply
//   skill. Promote is still offered: it writes somewhere else.
// - **`writable`** — the branch or the team library accepts a write from this
//   Mac. False for a read-only collaborator, which is the case the board's
//   "no writing entries" describes.
//
// Confusing the two would either take Promote away from a personal skill —
// its one action — or offer `Remove from staging` to somebody who cannot push.

import { asksNeedsOkLine, linkedAsksLine, type StrongestAsk } from "./skillAsks.ts";
import { copyAction, gitignoredLine, unknownRootsLine } from "./projectSkills.ts";
import {
  contentId,
  isSilenced,
  scopePairKey,
  type SilencedDuplicate,
} from "./libraryMute.ts";
import type {
  CopyState,
  KanbanCard,
  PlyPlace,
  PlySkillChange,
  PlySkillSwitch,
  SkillLinkOffer,
  SkillLinkRow,
  SkillTwinRow,
} from "../ipc.ts";
import { plyMacSwitchNote, plyRowHint, plyRowNote, plyStatusFor, versionWord } from "./plySkillSwitch.ts";
import {
  linkChip,
  linkLine,
  linkOfferAction,
  linkOfferLine,
  onItsWayLine,
  openSkillCard,
} from "./skillCards.ts";
import {
  agoWords,
  BRANCH_MISSING_MARKER,
  GIT_SIGN_IN_MARKER,
  REFUSED_MARKER,
  SKILL_NEVER_OVERRIDE_MARKER,
  type BranchCodexDelivery,
  type ItemKind,
} from "./sharedLibrary.ts";
import type { Scope } from "./uxScope.ts";
import { ASK_BUILDER, bringBranchPrompt, folderBehindLine } from "./askBuilder.ts";
import { isAbsolutePath, joinPath } from "./paths.ts";
import { machineWords, platformWord } from "./platform.ts";

/** The pages of the Library's inner column, in the board's order. UX-9.5
 *  retired Notes: the notes stay on disk, and no page shows them. */
export type LibraryPage = "instructions" | "skills";
export const LIBRARY_PAGES = ["instructions", "skills"] as const satisfies readonly LibraryPage[];
export const LIBRARY_PAGE_LABEL: Record<LibraryPage, string> = {
  instructions: "Instructions",
  skills: "Skills",
};

/** The scope choices of the inner column: the four scopes, My library
 *  (1.174.0, X3: the person's own skills, read-only here; not a `Scope`, as
 *  nothing on this page writes it) and all of them. */
export type ScopeFilter = "all" | Scope | "my-library";
/** The order the sections are listed in (BOARDS.md §3 "Sections, in this
 *  order"). `all` is the filter, not a section. */
export const SKILL_SCOPES: Scope[] = ["repository", "team", "ply", "this-mac"];

/**
 * The order the inner column and the narrow select list the scopes
 * (BOARDS.md §3: `All` · `Repository` · `Team` · `This Mac` · `Ply`).
 *
 * Not `SKILL_SCOPES`, which is the order the **sections** are stacked in
 * (`Comes with Ply` third, between the team library and this Mac). GH #96
 * review 1: one constant served both and the nav listed Ply before This Mac.
 */
export const SCOPE_NAV_ORDER: Exclude<ScopeFilter, "all">[] = ["repository", "team", "my-library", "this-mac", "ply"];

export const SCOPE_NAV_LABEL: Record<ScopeFilter, string> = {
  all: "All",
  repository: "Repository",
  team: "Team",
  "my-library": "My library",
  ply: "Plyloft",
  "this-mac": platformWord("thisMachine"),
};

/** A section's heading, and the `count · scope meaning` on its right. */
export const SECTION_TITLE: Record<Scope, string> = {
  repository: "In this repository",
  team: "In the team library",
  ply: "Comes with Plyloft",
  "this-mac": machineWords("On this Mac"),
};
export const SECTION_MEANING: Record<Scope, string> = {
  repository: "everyone who opens this repository",
  team: "every team workspace",
  ply: "in sessions Plyloft starts",
  "this-mac": "only here",
};

/** Cold read 2026-10-19: `6 skills · everyone who opens this repository`. */
export function sectionCount(count: number, scope: Scope): string {
  return `${count} ${count === 1 ? "skill" : "skills"} · ${SECTION_MEANING[scope]}`;
}

/**
 * Cold read 2026-10-19 (Challenger): the backend's "… Promote to Team shares
 * the copy committed there …" for a skill the team library holds differently:
 * the action that waits is Replace in Team (or Complete in Team), the label the
 * row's `⋯` gives it.
 */
export function waitsWithAction(line: string, team: "differs" | "partial"): string {
  return line.replace("Promote to Team shares", team === "partial" ? "Complete in Team shares" : "Replace in Team shares");
}

/** Cold read 2026-10-19: a personal skill's action when there is a team. */
export const SHARE_WITH_TEAM_LABEL = "Share with Team…";
/** ...when this Mac can't write the team library: the flow offers the repository. */
export const SHARE_LABEL = "Share…";
/** A personal row's Share when the team's copy of it differs: the press ends in
 *  the same Replace question (`copy_into` refuses one nobody asked for). */
export const REPLACE_IN_TEAM_LABEL = "Replace in Team…";
/** A personal row's Share when the team has only one half of it. */
export const COMPLETE_IN_TEAM_LABEL = "Complete in Team…";
/** Why the flow's Team choice is off: a share would write nothing. */
export const ALREADY_IN_TEAM_REASON = "Already in the team library, with the same files.";

/** The line under `On this Mac`, once. */
export const THIS_MAC_NOTE =
  "Yours alone. Plyloft reads them but does not change them — share one with your team from its row.";

/** The same line in solo mode (OB-9): no team to share with, so as before. */
export const THIS_MAC_NOTE_SOLO =
  "Yours alone. Plyloft reads them but does not change them — promote one to share it.";

export const SKILLS_LEDE = machineWords(
  "What the agents know how to do. Each one lives somewhere — in this " +
    "repository, in the team library, in My library, on this Mac, or in Plyloft itself.",
);

export function filterPlaceholder(total: number): string {
  return `Filter ${total} ${total === 1 ? "skill" : "skills"} by name or description`;
}

// ── What a row can be doing right now ────────────────────────────────────

export type SkillTransient =
  /** Queued on this Mac, not on the branch yet. */
  | { kind: "publishing"; line: string }
  /** The change waits in a PR: the branch refused a direct push, or somebody
   *  changed the skill there since the change began (group B §2). */
  | { kind: "pullRequest"; line: string; number: number; url: string }
  /** Skills group B §2: somebody changed it on the branch since this change
   *  began, so it was not committed, and no pull request could carry it. */
  | { kind: "blocked"; line: string }
  /** A teammate removed it; the copy here is the last one. */
  | { kind: "removedUpstream"; line: string }
  /** Skills hub H6a (R15): a team skill's scripts wait for an OK on this Mac.
   *  `plugin` is its directory in the library, which the sheet asks about. */
  | { kind: "needsOk"; line: string; plugin: string }
  /** F3/F9 review: the last attempt met an error Ply has no words for. It is
   *  retried on the next Sync; git's own text is only in `details`. */
  | { kind: "retrying"; line: string; details: string };

/** One action, named by its outcome. `null` means the row is at rest. */
export type SkillAction = {
  id:
    | "compare"
    /** GH #105: the two copies **on the branch** side by side, Claude's and
     *  Codex's. A different question from `compare`, which is one name at two
     *  scopes, so it is a different action and says so. */
    | "compare-reach"
    | "open-pull-request"
    | "keep-on-this-mac"
    | "promote"
    | "install"
    /** Skills hub H6a: open the *Needs your OK* sheet. */
    | "review-scripts"
    /** Skills hub H3a: a linked copy whose origin moved on — a skill card. */
    | "update"
    /** Skills hub H3a: a linked copy against its origin, 2-way. */
    | "compare-link"
    /** Skills hub H4 (R3): changed here and upstream — the 3-way
     *  Compare with Keep mine / Take upstream / Propose mine upstream. */
    | "compare3"
    /** Skills hub H4 (R8): the library removed it — Keep or Remove. */
    | "removed-choice"
    /** Skills hub H4 (R8 edge): the library renamed it — Rename here or
     *  Keep the old name. */
    | "renamed-choice"
    /** Skills hub H3b (R-M): an unlinked copy equal to a team version — a
     *  Link card (link records only). */
    | "link"
    /** Skills hub H5 (R12): the two copies both changed — Align asks which
     *  wins, and makes a card. */
    | "align"
    /** QoL 13.1: a skill written into the project folder and not committed —
     *  a skill card carrying it as it is there (`skillsHubCarry`). */
    | "ship-with-card"
    /** QoL 13.2 (D4): the project folder is behind the branch — a Builder
     *  session in the folder, asked `prompt` (`askBuilder.ts`). */
    | "ask-builder"
    /** QoL 13.4: a skill card already carries it — open that card. */
    | "open-card";
  label: string;
  /** `ask-builder`: what the Builder is asked. */
  prompt?: string;
  /** `open-card`: the card. */
  cardId?: string;
  /**
   * The destination holds different bytes, so going ahead overwrites somebody's
   * work: ask before it runs, and only then pass `replace`. `copy_into` refuses
   * outright without it, which left the member a toast telling them to do
   * something they had no way to do (GH #96 review 1).
   */
  confirm?: true;
};

/** A `⋯` entry. `divider` is the board's `—`. */
export type SkillMenuEntry =
  | { id: "open-in-code" | "compare" | "compare-reach"; label: string }
  | { id: "publish-to-branch"; label: string }
  /** GH #105: create the missing copy on the branch, and choose which of two
   *  copies that disagree wins. Both are writes, so both are absent for a
   *  read-only collaborator. */
  | { id: "make-available-to-both" | "align"; label: string }
  /** H4 Challenger step 13: `hint` — Promote offered, with the backend's
   *  caveat under it (GitHub couldn't be asked about write access). */
  | { id: "promote-to-team" | "install"; label: string; confirm?: true; hint?: string }
  /** Team walk 2026-10-01 (F4): `Promote to Team` shown but off, with the
   *  reason under it — the two copies in the checkout disagree, and a missing
   *  entry said nothing about why. Skills hub H4 step 8 c: also when GitHub
   *  lets this member read the team repo and not write it. Never pressed. */
  | { id: "promote-to-team"; label: string; disabled: true; hint: string }
  | { id: "remove-from-branch"; label: string; danger: true }
  /** UX-9.5: take a skill out of the team library, for everyone. It moved
   *  here from the list Settings › Team used to draw. */
  | { id: "remove-from-team"; label: string; danger: true }
  /** Skills hub H4 step 8 c: the same, off, for a member GitHub lets read
   *  the team repo and not write it — with GitHub's refusal. Never pressed. */
  | { id: "remove-from-team"; label: string; danger: true; disabled: true; hint: string }
  /** Skills hub H3a: a linked copy's Compare with its origin, in the `⋯`
   *  when the row's action is something else. */
  | { id: "compare-link"; label: string }
  /** Owner-fixes walk: a *Both changed* copy's Compare with the library is
   *  the 3-way one, whose choices are the way out — in the `⋯` when
   *  something else (Align, drift, a transient) has the row's action. */
  | { id: "compare3"; label: string }
  /** Skills hub H8 (R5): Copy to… other workspaces, through All skills. */
  | { id: "copy-to"; label: string }
  /** QoL 13.1, 13.2 and 13.4: the ways out, in the `⋯` when the row's own
   *  action is something else. */
  | { id: "ship-with-card"; label: string }
  | { id: "ask-builder"; label: string; prompt: string }
  | { id: "open-card"; label: string; cardId: string }
  | "divider";

export interface SkillRow {
  /** `<scope>:<name>`: the identity a key and a selection use. Two scopes may
   *  carry one name, and they are not one row. */
  key: string;
  name: string;
  scope: Scope;
  /** The whole description, for the detail sub-page. */
  description: string;
  /** Its first sentence: the row's hint. */
  hint: string;
  /**
   * What else this row has to say, one sentence each, under the hint: the two
   * copies in the repository disagree, a root git ignores, the name Codex uses.
   * The states the Project skills panel reported, which a page that replaces it
   * must not quietly drop.
   */
  notes: string[];
  /** Walk follow-ups 2026-10-19: this checkout's copy isn't the one Promote
   *  (Replace, Complete) in Team shares — the row's note saying which one it
   *  shares. The Compare names its side "your project folder's copy" and says it. */
  promoteShares?: string | null;
  /** 1.175.0 B1: a repository skill whose text asks to run things — Promote
   *  to Team goes through the Share page (`ShareAskingFlow`). */
  asks?: StrongestAsk | null;
  /** Round 2 (G3): the id of the text the page shows, sent with its press. */
  asksId?: string | null;
  /** Round 2 (G6): why that page's press would be refused (a name Windows
   *  can't have), in the backend's words. */
  shareRefusal?: string | null;
  /** Only the CLIs it reaches are drawn, so both may be false for a skill
   *  Ply lists from the branch alone. */
  claude: boolean;
  codex: boolean;
  /** The skill's own files are not Ply's to change (ADR 0005). */
  readOnly: boolean;
  /** Another scope carries this name: the outline chip and `Compare`. */
  duplicate: { chip: string; other: Scope } | null;
  /**
   * GH #105: the branch carries **both** copies of this skill and they are not
   * the same files — somebody edited one of them by hand.
   *
   * The two directories come with it, because the comparison reads them: the
   * mirror's own copies, which is where the disagreement is. `null` when the
   * two agree, when only one of them is there, and for every scope but the
   * repository.
   */
  drift: { chip: string; claudeDir: string; codexDir: string } | null;
  transient: SkillTransient | null;
  action: SkillAction | null;
  menu: SkillMenuEntry[];
  /**
   * Code may open its files **and save them**. True only for a repository skill
   * whose copy is in the checkout — the one tree Ply may write. The page's
   * `Edit in Code` and the writable half of the sub-page's file rows both read
   * **this** field, so they cannot drift apart: GH #96 review 1 found the
   * sub-page deriving it a second way and offering to save into the team clone.
   *
   * GH #142: a row where this is false may still open in Code, as a reading
   * view — `readOnlyFile.ts::skillFileMode` is the rule, and it is the only
   * other thing allowed to decide.
   */
  openInCode: boolean;
  /** The directory holding its `SKILL.md`, when Ply can read one. */
  dir: string | null;
  /** Ply reads it out of the mirror, not the checkout: Code opens it
   *  read-only (GH #142, `skillFileMode`). */
  fromMirror: boolean;
  /** The team plugin it lives in, for `<plugin>:<name>`. */
  plugin: string | null;
  /** A personal row: how the team's copy a share would write over stands. */
  teamCopy?: PersonalTeamCopy;
  /** A personal row: the other scopes that have its name, in the repository
   *  or the team. */
  alsoIn?: readonly Scope[];
  /** A personal row: a share could still put it in the team. */
  shareToTeam?: boolean;
  /**
   * GH #106: a skill that comes with Ply, and its switch.
   *
   * `null` at every other scope, which is what makes the switch impossible to
   * draw where there is nothing to switch. `title` is the plain name the board
   * gives these rows (`Write a good card brief`) — the `SKILL.md`'s own first
   * heading — while `name` stays the directory, so one field never means two
   * things and the CLI's `ply:card-brief` is still reachable from the row.
   */
  ply: {
    title: string;
    on: boolean;
    /** Skills hub H9 (R9): its versions, newest first (`CHANGES.json`). */
    changes?: PlySkillChange[];
    /** The switch at every level in this workspace, this Mac's from the
     *  live settings (`plySkillSwitch.liveSwitch`). */
    switch?: PlySkillSwitch | null;
    /** Where it was read: the workspace, its repository and team. */
    place?: PlyPlace | null;
  } | null;
  /**
   * Skills hub H3a: an outline chip a linked copy's state asks for —
   * `Update available`, `Modified here` — or absent. H4 adds `Both
   * changed`, `Removed from …`, `Renamed upstream to …`.
   */
  linkChip?: string | null;
  /** Skills hub H4: the linked copy's state, when it has one — a removed
   *  one draws its name struck through, as a removal upstream does. */
  linkState?: SkillLinkRow["state"] | null;
  /** Skills hub H5 (R12): how the two copies stand, when Align is offered
   *  by card (a workspace with no shared channel). */
  twins?: SkillTwinRow["twins"] | null;
  /** Cold read 2026-10-19: the action shows on hover or focus only (it is
   *  on every row of its section). */
  actionOnHover?: boolean;
}

// ── The input, structurally typed so a test needs no IPC object ──────────

export interface RepositorySkillInput {
  name: string;
  description: string;
  /** 1.175.0 B1: the strongest thing its `SKILL.md` asks for (`ProjectSkill.asks`). */
  asks?: StrongestAsk | null;
  /** Round 2 (G3): the id of the bytes that was read from (`ProjectSkill.asksId`). */
  asksId?: string | null;
  /** Round 2 (G6): `ProjectSkill.shareRefusal`. */
  shareRefusal?: string | null;
  claude: boolean;
  codex: boolean;
  /** Repo-relative roots it was found in. */
  roots: string[];
  promoteBlocked?: string | null;
  /** `promoteBlocked` is "isn't on <branch> yet": about Promote alone. */
  promoteWaitsForBranch?: boolean;
  /** N14 item 2: Promote shares the branch's copy; this checkout's two copies
   *  differ, so the local changes aren't included. */
  promoteNote?: string | null;
  /** Two roots hold it with different bytes: both CLIs load it, and not the
   *  same instructions. */
  diverged?: boolean;
  /** Its roots whose copy git ignores here: a card never carries them. */
  ignoredRoots?: string[];
  /** What Codex calls it, when the frontmatter `name` disagrees. */
  codexName?: string | null;
  /** The team library's copy, compared with this repository's: what a Promote
   *  would do, and whether it would overwrite somebody's work. */
  team?: CopyState;
}

export interface MirrorSkillInput {
  name: string;
  description: string;
  /** The copy the description was read from: the Claude one when the branch has
   *  it, the Codex one otherwise. */
  dir: string;
  /** GH #105: which CLIs the branch's copies reach. Absent from a state written
   *  by an older build, and then the branch copy counts as Claude's — which is
   *  what it was before this card. */
  claude?: boolean;
  codex?: boolean;
  /** Both copies are on the branch and they disagree. */
  differs?: boolean;
  /** The Codex copy's directory in the mirror, when the branch has one. */
  codexDir?: string | null;
  /** Group B §2 review 1: the skill's id on the branch in this build. */
  id?: string | null;
}

export interface TeamSkillInput {
  name: string;
  description: string;
  plugin: string;
  claude: boolean;
  codex: boolean;
  /** This repository's copies, compared with the library's. */
  repo: "absent" | "same" | "partial" | "differs";
  /** The roots an Install would write that git ignores here — said before the
   *  press, not only in the toast after. */
  ignoredRoots?: string[];
  /** GH #227: the roots an Install would write that git gave no answer for. */
  unknownRoots?: { path: string; reason: string }[];
  codexName?: string | null;
  /** The library directory it is read from, absolute: what `Compare` reads the
   *  team's `SKILL.md` out of. */
  dir?: string | null;
  /** Every half the library holds, absolute: "the same files" holds for all. */
  halves?: string[];
  /** Skills hub H6a: its scripts wait for an OK on this Mac. */
  needsOk?: {
    plugin: string;
    firstTime: boolean;
    approvedAt: number | null;
    /** A script is among what asks; false when only extra files do (an
     *  image). Absent from an older backend: read as a script. */
    bringsScript?: boolean;
    /** 1.175.0 B1: the strongest thing its text asks for, when its
     *  `SKILL.md` is what is new or changed (`skillAsks.ts`). */
    asks?: StrongestAsk | null;
  } | null;
  /** Skills hub H6b walk (R15): the team's plugins holding it that Plyloft
   *  refuses, one per CLI. No OK lifts it. A skill with both CLIs off is held
   *  only by refused plugins. */
  refused?: { plugin: string; vendor: "claude" | "codex"; reason: string }[];
}

/**
 * Skills hub H6b walk (R15): why a CLI doesn't get a team skill whose plugin
 * Plyloft refuses — said on the row, not only in Settings › Team. The reason
 * is the backend's, already worded for this machine.
 */
export function refusedNotes(refused: TeamSkillInput["refused"]): string[] {
  return (refused ?? []).map((r) => {
    const cli = r.vendor === "claude" ? "Claude" : "Codex";
    const why = r.reason.trim().replace(/\.$/, "");
    return `${cli} doesn't get it: Plyloft refuses the team's ${cli} plugin ${r.plugin} (${why}). Only the team owner can change that.`;
  });
}

export interface PersonalSkillInput {
  name: string;
  description: string;
  claude: boolean;
  codex: boolean;
  dir: string;
  codexName?: string | null;
}

/**
 * GH #106: one skill that ships inside the app (`commands::PlySkillRow`).
 *
 * `name` is its directory, which is its identity in both CLIs (`ply:card-brief`);
 * `title` is the `SKILL.md`'s own first heading, which is the plain name the
 * board's row and page show. `on` is this Mac's switch, out of
 * `settings.library.plySkillsOff`.
 */
export interface PlySkillInput {
  name: string;
  title: string;
  description: string;
  dir: string;
  claude: boolean;
  codex: boolean;
  on: boolean;
  /** Skills hub H9: the Plyloft version that last changed it, and every one. */
  version?: string | null;
  changes?: PlySkillChange[];
  /** Its switch at every level in this workspace. */
  switch?: PlySkillSwitch | null;
}

export interface PendingInput {
  /** GH #101: `instructions` travels on the same channel. This page looks only
   *  at `skill` entries, so a kind it does not know is simply not a skill. */
  kind: ItemKind;
  name: string;
  removed: boolean;
  pullRequest: { number: number; url: string } | null;
  /** The last attempt's error, when it had one — how a never-override dead end
   *  (group B §2) reaches the row. */
  lastError?: string | null;
  /** F3/F9: the last attempt could not reach origin at all, so `lastError` is a
   *  wait rather than something to fix. Absent or null: not known (an entry
   *  queued before this was recorded), read as it always was. */
  offline?: boolean | null;
}

/**
 * A skill the branch lost since this session began, from a refresh report.
 *
 * GH #144: `changedAt` is the commit time the report carried (epoch **seconds**),
 * kept as the number and **not** as words. Review 1 (MAJOR): the words were
 * rendered once, when the report arrived, and this record lives for the whole
 * session while the removal is announced only once — so a row read at 18:00
 * still said `2 minutes ago` about a change from 16:00. The age is said from
 * [`SkillsInput.nowMs`] at the moment the row is built instead.
 *
 * `null` when the report carried no time: a build older than #144 sent none, and
 * git may have no commit for the item's paths, and an age Ply has not read is
 * left unsaid rather than guessed at.
 */
export interface RemovedUpstreamInput {
  name: string;
  author: string | null;
  changedAt: number | null;
}

export interface SkillsInput {
  /** Skills hub H8: the rows offer `Copy to…` (the Library page sets it). */
  copyTo?: boolean;
  /** The checkout's own skills, as the Project skills panel knows them. */
  repository: RepositorySkillInput[];
  /** The integration branch's, off the mirror. Merged with the checkout's. */
  mirror: MirrorSkillInput[];
  team: TeamSkillInput[];
  personal: PersonalSkillInput[];
  /** GH #106: the skills that ship inside the app, from `ply_skills_view`. Empty
   *  on a Mac whose build carries no bundle, and the section is then absent. */
  ply: PlySkillInput[];
  /** Skills hub H9: where the Plyloft switch was read (absent: this Mac only). */
  plyPlace?: PlyPlace | null;
  /** The shared channel: the branch, whether this Mac may write it, the queue. */
  shared: boolean;
  branch: string | null;
  branchReadOnly: boolean;
  branchSkills: string[];
  /**
   * GH #156: whether Ply hands the branch's Codex copies to every Codex session
   * it starts here (`LibraryState.branchCodex`). Absent — a state from an older
   * build, and every test that has no reason to care — is "not delivered", which
   * is what it was before.
   */
  branchCodex?: BranchCodexDelivery;
  /**
   * Group B §2 walks: the skills whose checkout copy for one CLI only lags
   * behind what the branch carries aligned — an Update let it follow the edited
   * copy (`LibraryState.checkoutBehind`). Not a divergence: the row says so.
   */
  checkoutBehind?: { name: string; copy: "claude" | "codex" }[];
  /**
   * Whether Codex sessions here get the team library's Codex half
   * (`ProjectSkillsView.teamCodex`). Absent or null — an older backend, a library
   * with no Codex half — leaves the chip to the library's own badge.
   */
  teamCodex?: BranchCodexDelivery | null;
  pending: PendingInput[];
  removedUpstream: RemovedUpstreamInput[];
  /**
   * Now, in ms, for the ages the rows say (GH #144 review 1).
   *
   * Read where the input is built, on every render, the same way
   * [`SkillDetailInput.nowMs`] is — so a row's age is as fresh as the paint, and
   * `skillTransient` stays a pure function of what it is handed.
   */
  nowMs: number;
  /** A key *and* GitHub write access to the team repo. */
  canPromote: boolean;
  /** OB-9: solo mode, no Team scope. A personal skill keeps `Promote`. */
  solo?: boolean;
  /**
   * Skills hub H4 step 8 c: the team repo's own refusal of this member's
   * Promote (GitHub says read, not write), in the backend's words.
   * Null when Promote is offered, and when it is off for any other reason (no
   * team, the team gate) — those rows offer no Promote at all.
   */
  promoteRefusal?: string | null;
  /**
   * Skills hub H4 Challenger step 13: the backend's caveat while Promote is
   * offered — GitHub couldn't be asked about write access (not signed in, or
   * not reachable). Shown under the enabled entry; null otherwise.
   */
  promoteCaveat?: string | null;
  /**
   * GH #100: duplicate pairs `Keep both` has silenced on this Mac, as
   * [`duplicatePairKey`] spells them.
   *
   * The card: "The list's `Also in …` chip stays; only the notice and its row
   * action go quiet." So the chip is untouched here — it is the fact, and the
   * fact has not changed — and the row's one action goes back to what it would be
   * without the duplicate (nothing, for a repository skill at rest; `Install`,
   * for a team one). `Compare` moves into the `⋯`, where the chip always has
   * something behind it (GH #96 review 1).
   */
  silencedPairs?: string[];
  /** Pairs whose two copies are the same whole tree. */
  identicalPairs?: readonly string[];
  /** A personal skill against the team's copy a share would write over, by
   *  name ({@link shareComparisons}). A name not here is unknown. */
  teamCopyCompared?: Readonly<Record<string, "same" | "differs">>;
  /** The plugin a share writes into (`ProjectSkillsView.promotePlugin`). */
  promotePlugin?: string;
  /** Skills hub H3a: the checkout's linked copies (`skills_hub_links`).
   *  Absent: none, or an older backend. */
  links?: SkillLinkRow[];
  /** Skills hub H3b: the checkout's unlinked copies that equal a version of
   *  the team's same-named skill (`skills_hub_links` → `offers`). */
  linkOffers?: SkillLinkOffer[];
  /** Skills hub H5 (R12): the checkout's skills whose two copies aren't
   *  aligned, or whose legacy `.codex/skills` copy disagrees
   *  (`skills_hub_links` → `twins`). Read where the workspace has no shared
   *  channel; a shared one aligns on its branch (GH #105). */
  twins?: SkillTwinRow[];
  /** Skills hub H3a: this board's skill cards still open — the row says
   *  its change is on its way, and offers no second Update. */
  skillCards?: KanbanCard[];
  /** QoL 13.1: checkout skills written into the project folder and not
   *  committed (`skills_hub_links` → `uncommitted`). */
  uncommitted?: string[];
}

/**
 * The key of one silenced duplicate: the two scopes, sorted, and the name.
 *
 * Sorted by [`scopePairKey`], so both rows of a pair read the same key and one
 * `Keep both` quietens both of them — which is what "for that pair of scopes and
 * name" means.
 */
export function duplicatePairKey(a: Scope, b: Scope, name: string): string {
  return `${scopePairKey(a, b)}\u0000${name}`;
}

/**
 * The pairs whose notice is silenced, out of the two copies' texts.
 *
 * `texts` is keyed by row key (`<scope>:<name>`) and holds only what Ply has
 * read. A pair with a text missing is **not** silenced: the mute is keyed by both
 * content ids, so without one of them there is nothing to compare the record to,
 * and guessing would hide a difference.
 */
/**
 * Every pair of scopes that carries a duplicated name right now, as
 * [`duplicatePairKey`] spells them.
 */
export function livePairKeys(duplicates: ReadonlyMap<string, Scope[]>): Set<string> {
  const out = new Set<string>();
  for (const [name, scopes] of duplicates) {
    for (let i = 0; i < scopes.length; i++) {
      for (let j = i + 1; j < scopes.length; j++) {
        out.add(duplicatePairKey(scopes[i], scopes[j], name));
      }
    }
  }
  return out;
}

/**
 * The scopes a caller is entitled to judge dead, for [`pruneSilencedDuplicates`].
 *
 * A scope belongs here only when the list of duplicates handed in is the **whole**
 * truth about it. Two ways it is not, and both cost a member their decision:
 *
 * - **`repository` never qualifies.** `settings.json` is app-global
 *   (`SettingsStore` sits on the config dir, no workspace in the path) while a
 *   duplicate set is one workspace's, and only the *visible* workspace's Library
 *   loads at all (`useSkillsData(workspaceId, visible)`). A repository-side record
 *   looks dead from every workspace but the one holding the skill, so pruning it
 *   would un-silence notices on every workspace switch — the one thing the card
 *   says must survive until a copy changes.
 * - **`team` qualifies only when the team library is really there.** A Mac with no
 *   team key, or a clone not synced yet, reads an empty library
 *   (`ProjectSkillsView.configured` / `hasClone`) — and then every `team|this-mac`
 *   pair looks dead for a reason that has nothing to do with the duplicate
 *   (review 2).
 *
 * `this-mac` and `ply` always qualify: the member's own folders and the app's own
 * skills are read whole, and the same from every workspace.
 */
export type JudgeableScopes = readonly Scope[];

/**
 * `silenced` without the dead records the caller is entitled to drop, or `null`
 * when there is nothing to drop.
 *
 * A pair whose name no longer exists at both its scopes can never match again, so
 * its record is dead weight in `settings.json` — and would silence the notice
 * again for nothing if that name came back with the same bytes (review 1).
 *
 * A record is only ever dropped when **every** scope of its pair is in
 * `judgeable`: absence is evidence of nothing when the caller could not see the
 * place in the first place. See [`JudgeableScopes`] for the two cases that cost a
 * member their decision.
 *
 * A stale record left behind is harmless meanwhile: a record matches only while
 * **both** content ids still match, so it cannot quieten a different skill unless
 * both copies are byte-identical to the pair that was silenced.
 *
 * `null` rather than a copy, so a caller writes the file only when the list has
 * actually changed. The caller also decides when it is safe to ask at all: a read
 * that failed makes every pair look dead, so `useSkillsData` prunes only once all
 * three scopes have answered.
 */
export function pruneSilencedDuplicates(
  silenced: readonly SilencedDuplicate[],
  duplicates: ReadonlyMap<string, Scope[]>,
  judgeable: JudgeableScopes,
): SilencedDuplicate[] | null {
  if (silenced.length === 0) return null;
  const live = livePairKeys(duplicates);
  const kept = silenced.filter((record) => {
    const pair = record.scopes.split("|") as Scope[];
    // A pair with a scope this caller cannot vouch for is kept, whatever the
    // duplicates it was handed say.
    if (!pair.every((scope) => judgeable.includes(scope))) return true;
    // The record's own key, rebuilt the way it was written: `scopes` is already
    // sorted and joined, so the pair key is `<scopes>\0<name>`.
    return live.has(`${record.scopes}\u0000${record.name}`);
  });
  return kept.length === silenced.length ? null : kept;
}

/**
 * The settings mutation that prunes — applied to the settings **as they are when
 * the queue runs it**, not to a snapshot taken before.
 *
 * Review 2: the prune was computed outside `update` and the result written inside,
 * so `latest.library.silencedDuplicates` was discarded — a `Keep both` that landed
 * while the prune was queued was silently undone. The queue serialises the writes;
 * it cannot know that the value being written was stale.
 *
 * Returns `latest` **by reference** when there is nothing to prune, so a caller can
 * tell a no-op apart from a change.
 *
 * Typed structurally rather than against `Settings`, so a test can drive it with
 * two fields and no IPC.
 */
export function prunedSilencedIn<
  T extends { library: { silencedDuplicates: SilencedDuplicate[] } },
>(
  latest: T,
  duplicates: ReadonlyMap<string, Scope[]>,
  judgeable: JudgeableScopes,
): T {
  const pruned = pruneSilencedDuplicates(
    latest.library.silencedDuplicates,
    duplicates,
    judgeable,
  );
  if (!pruned) return latest;
  return { ...latest, library: { ...latest.library, silencedDuplicates: pruned } };
}

export function silencedPairKeys(
  duplicates: ReadonlyMap<string, Scope[]>,
  texts: Readonly<Record<string, string>>,
  silenced: readonly SilencedDuplicate[],
): string[] {
  const out: string[] = [];
  for (const [name, scopes] of duplicates) {
    for (let i = 0; i < scopes.length; i++) {
      for (let j = i + 1; j < scopes.length; j++) {
        const here = texts[`${scopes[i]}:${name}`];
        const there = texts[`${scopes[j]}:${name}`];
        if (here == null || there == null) continue;
        const quiet = isSilenced(silenced, {
          here: scopes[i],
          there: scopes[j],
          name,
          hereContent: contentId(here),
          thereContent: contentId(there),
        });
        if (quiet) out.push(duplicatePairKey(scopes[i], scopes[j], name));
      }
    }
  }
  return out;
}

/**
 * Decision §6 (group B): the duplicate pairs whose two copies are the same
 * **whole tree**, as [`duplicatePairKey`] spells them.
 *
 * A Promote leaves the member's own copy where it was and an Install leaves the
 * team's, so the moment either finishes the name is at two scopes with the same
 * bytes. There is nothing to compare and nothing to choose, so such a pair is
 * quiet exactly like one `Keep both` silenced: the `Also in …` chip stays (it is
 * the fact), the notice and `Compare` as the row action do not. It speaks up
 * again as soon as either copy changes, because the digests then differ.
 *
 * `digests` is keyed by row key and holds one digest per copy
 * (`skill_tree_digests`: every file, path and mode, over every directory the copy
 * lives in). A copy with no digest — unread, or a repository copy whose two roots
 * disagree — is never identical to anything.
 */
export function identicalPairKeys(
  duplicates: ReadonlyMap<string, Scope[]>,
  digests: Readonly<Record<string, string | null>>,
): string[] {
  const out: string[] = [];
  for (const [name, scopes] of duplicates) {
    for (let i = 0; i < scopes.length; i++) {
      for (let j = i + 1; j < scopes.length; j++) {
        const here = digests[`${scopes[i]}:${name}`];
        const there = digests[`${scopes[j]}:${name}`];
        if (here && there && here === there) {
          out.push(duplicatePairKey(scopes[i], scopes[j], name));
        }
      }
    }
  }
  return out;
}

/** The digest key of the team's copy a share would write over: the row key
 *  `team:<name>` can be another plugin's. */
export function shareTargetKey(name: string): string {
  return `team-share:${name}`;
}

/** The team row a personal skill's share would write over, if any. */
export function shareTarget<T extends Pick<TeamSkillInput, "name" | "plugin">>(
  team: readonly T[],
  name: string,
  promotePlugin: string | undefined,
): T | undefined {
  return team.find((skill) => skill.name === name && (promotePlugin === undefined || skill.plugin === promotePlugin));
}

/** Both digests read: same or different. A team copy whose two halves disagree
 *  has no digest, so it is neither: only the press can say what it holds. */
export function shareComparisons(
  names: readonly string[],
  digests: Readonly<Record<string, string | null>>,
): Record<string, "same" | "differs"> {
  const out: Record<string, "same" | "differs"> = {};
  for (const name of names) {
    const mine = digests[`this-mac:${name}`];
    const theirs = digests[shareTargetKey(name)];
    if (mine && theirs) out[name] = mine === theirs ? "same" : "differs";
  }
  return out;
}

// ── Words ────────────────────────────────────────────────────────────────

/**
 * The first sentence of a description, for the row's hint.
 *
 * A folded or literal YAML scalar (GH #91) arrives as one string with its own
 * newlines, and a row is one line: the first sentence is the unit an author
 * writes, so `Turns a rough idea into a brief. Use it before…` gives
 * `Turns a rough idea into a brief.` A description with no full stop is used
 * whole, on one line.
 */
export function firstSentence(description: string): string {
  const flat = description.trim().replace(/\s+/g, " ");
  // A full stop that ends a sentence: followed by a space, and not part of an
  // abbreviation Ply would cut in half ("e.g. ", "i.e. ").
  const match = /^(.*?[.!?])\s+(?=[^\s])/.exec(flat);
  if (!match) return flat;
  const head = match[1];
  if (/(^|\s)(e\.g|i\.e|etc|vs|Mr|Dr)\.$/.test(head)) return flat;
  return head;
}

/** `Also in Team` / `Also in this repository` — the other scope, in words. */
export function duplicateChip(other: Scope): string {
  switch (other) {
    case "repository":
      return "Also in this repository";
    case "team":
      return "Also in Team";
    case "ply":
      return "Also in Plyloft";
    case "this-mac":
      return machineWords("Also on this Mac");
  }
}

const BRANCH_FALLBACK = "the integration branch";

/**
 * Walk F6: the checkout's two copies differ, but the branch already carries
 * them aligned (an `Align` landed there). `promote_blocker` reads the checkout
 * only, so its "make them match" would ask for work that is already done; this
 * says where the aligned copies are and how they get here. Promote stays
 * refused until the checkout's copies match.
 */
export function alignedOnBranchLine(name: string, branch: string | null): string {
  const where = branch ?? BRANCH_FALLBACK;
  return (
    `Claude's and Codex's copies of \`${name}\` are aligned on ${where}, but the two in ` +
    `your project folder still differ, so it can't be promoted yet. ${folderBehindLine(branch)} ` +
    `${ASK_BUILDER} to bring the aligned copies here.`
  );
}

/**
 * Skills hub H4 step 8 c (Challenger): [`alignedOnBranchLine`] for a member the
 * team repo refuses — the pull still brings the aligned copies here; Promote,
 * which that member cannot reach, goes unsaid.
 */
export function alignedOnBranchPullLine(name: string, branch: string | null): string {
  const where = branch ?? BRANCH_FALLBACK;
  return (
    `Claude's and Codex's copies of \`${name}\` are aligned on ${where}, but the two in ` +
    `your project folder still differ. ${folderBehindLine(branch)} ${ASK_BUILDER} to bring ` +
    `the aligned copies here.`
  );
}

/**
 * Walk F6: whether a pull really is the way to bring the aligned copies here.
 * Only when the checkout's copies live in the two roots the branch carries (a
 * legacy `.codex/skills` copy is never on the branch, so no pull changes it) and
 * nothing for this skill is queued (a queued Align or publish is not on the
 * branch yet — the mirror shows it ahead of time). Otherwise the checkout's own
 * "make them match" stands.
 */
/** The checkout copy of `name` that lags behind the branch, if that is all. */
function checkoutBehindOf(
  name: string,
  input: Pick<SkillsInput, "checkoutBehind">,
): "claude" | "codex" | null {
  return input.checkoutBehind?.find((b) => b.name === name)?.copy ?? null;
}

/**
 * Group B §2 walks: the row's one line when the only difference is a checkout
 * copy behind the branch — after an Update published the edit for both CLIs.
 */
export function checkoutBehindLine(copy: "claude" | "codex", branch: string | null): string {
  const where = branch ?? BRANCH_FALLBACK;
  const which = copy === "codex" ? "Codex" : "Claude";
  return `Published to ${where} for Claude and Codex. Your project folder's ${which} copy is behind ${where} — ${ASK_BUILDER} to bring it here.`;
}

function behindNotes(name: string, input: Pick<SkillsInput, "checkoutBehind" | "branch">): string[] {
  const copy = checkoutBehindOf(name, input);
  return copy ? [checkoutBehindLine(copy, input.branch)] : [];
}

/** A publish of `name` (not a removal) is queued or waiting. */
function publishInFlight(name: string, input: Pick<SkillsInput, "pending">): boolean {
  return input.pending.some((p) => p.kind === "skill" && p.name === name && !p.removed);
}

function alignedOnBranch(
  skill: { name: string; roots: string[]; promoteBlocked?: string | null },
  branch: BranchFacts | null,
  input: Pick<SkillsInput, "pending">,
): boolean {
  return (
    !!skill.promoteBlocked &&
    !!branch?.claude &&
    branch.codex &&
    !branch.differs &&
    skill.roots.every((root) => PUBLISHABLE_ROOTS.includes(root)) &&
    !input.pending.some((p) => p.kind === "skill" && p.name === skill.name)
  );
}

/**
 * The sentences a row adds under its hint.
 *
 * `promoteBlocked` carries the backend's own words for two copies that
 * disagree, which is the one fault a chip pair cannot show; the gitignored line
 * is `projectSkills.gitignoredLine`, so the row, the toast and the doctor say
 * the same thing; and a frontmatter `name` that differs from the directory is
 * reported rather than silently preferred, because both names are real.
 */
export function skillNotes(skill: {
  promoteBlocked?: string | null;
  promoteNote?: string | null;
  ignoredRoots?: string[];
  unknownRoots?: { path: string; reason: string }[];
  codexName?: string | null;
}): string[] {
  const notes: string[] = [];
  if (skill.promoteBlocked) notes.push(skill.promoteBlocked);
  else if (skill.promoteNote) notes.push(skill.promoteNote);
  const ignored = gitignoredLine(skill.ignoredRoots ?? []);
  if (ignored) notes.push(ignored);
  const unknown = unknownRootsLine(skill.unknownRoots ?? []);
  if (unknown) notes.push(unknown);
  if (skill.codexName) notes.push(`Codex calls it ${skill.codexName}.`);
  return notes;
}

/**
 * GH #215 on the Skills page: the roots git ignores under this repository's
 * skills, once each, in the order they are first met — what the section's
 * `Un-ignore` is about. Empty when no row carries the gitignored note.
 */
export function ignoredSkillRoots(skills: { ignoredRoots?: string[] }[]): string[] {
  const out: string[] = [];
  for (const skill of skills) {
    for (const root of skill.ignoredRoots ?? []) {
      if (!out.includes(root)) out.push(root);
    }
  }
  return out;
}

/** The sentence above that `Un-ignore`; each row's note says the rest. */
export function ignoredRootsLine(roots: string[]): string {
  const one = roots.length === 1;
  return (
    `Git ignores ${roots.join(" and ")} here, so a card can't carry the copies ` +
    `in ${one ? "it" : "them"}. Let Git see it shows the lines it would add first.`
  );
}

// ── Transient states ─────────────────────────────────────────────────────

/**
 * What is happening to `name` right now, from the library queue and the refresh
 * reports. `null` when the row is at rest.
 *
 * Order, and why (GH #96 review 1 found the old one said "Removed" forever):
 *
 * 1. **The queue wins.** Something the member has asked for and Ply has not
 *    finished is the freshest fact about this skill, and it is the one they are
 *    waiting on. A publish in flight outranks a removal somebody else made.
 * 2. **A removal the branch took back is not a removal.** `removedUpstream` is a
 *    record of a report, and reports do not un-happen; the branch carrying the
 *    name again is the evidence that it came back, whoever put it there.
 * 3. Otherwise: at rest.
 */
export function skillTransient(
  name: string,
  input: Pick<
    SkillsInput,
    "branch" | "pending" | "removedUpstream" | "branchSkills" | "nowMs"
  >,
): SkillTransient | null {
  const branch = input.branch ?? BRANCH_FALLBACK;
  const queued = input.pending.find((p) => p.kind === "skill" && p.name === name);
  if (queued) {
    if (queued.pullRequest) {
      return {
        kind: "pullRequest",
        line: queued.removed
          ? `Its removal is waiting in pull request #${queued.pullRequest.number} — it reaches everyone once that is merged.`
          : `Waiting in pull request #${queued.pullRequest.number} — it reaches everyone once that is merged.`,
        number: queued.pullRequest.number,
        url: queued.pullRequest.url,
      };
    }
    // Group B §2: the backend's sentence is the whole answer — which skill moved,
    // who moved it, and why nothing could wait in a pull request. "Publishing…"
    // would be a promise: the base it was built on is not coming back.
    if (queued.lastError?.includes(SKILL_NEVER_OVERRIDE_MARKER)) {
      return { kind: "blocked", line: queued.lastError };
    }
    // F3/F9 (team walk): an error the last attempt met while origin answered
    // is not "Publishing…". Offline is (the change is on its way), and so is an
    // entry queued before Ply recorded which it was (`offline` absent): that is
    // how it always read.
    if (queued.lastError && queued.offline === false) {
      const error = queued.lastError.trim();
      // A branch origin lacks: the backend's sentence says what to do.
      if (error.includes(BRANCH_MISSING_MARKER) || error.includes(GIT_SIGN_IN_MARKER)) {
        return { kind: "blocked", line: `${error} It waits here until then.` };
      }
      if (error.includes(REFUSED_MARKER)) {
        return {
          kind: "blocked",
          line: `Not published: ${branch} refused the push. Plyloft tries again on the next Sync.`,
        };
      }
      return {
        kind: "retrying",
        line: "Not published yet: Plyloft will try again on the next Sync.",
        details: error,
      };
    }
    return {
      kind: "publishing",
      line: queued.removed
        ? `Removing from ${branch}…`
        : `Publishing to ${branch}…`,
    };
  }
  if (input.branchSkills.includes(name)) return null;
  const gone = input.removedUpstream.find((r) => r.name === name);
  if (!gone) return null;
  const by = gone.author ? ` by ${gone.author}` : "";
  // GH #144: and when, when the report said so. BOARDS.md §3 writes the age into
  // the same clause as the author — `Removed on staging by MatteoB-adv 2 hours
  // ago.` — and each half drops on its own, so a removal with no author still
  // reads (`Removed on staging 2 hours ago.`).
  //
  // Said from `nowMs` here and not stored as words (review 1, MAJOR): this record
  // outlives the one report that announced the removal, so words fixed at arrival
  // would still read `2 minutes ago` hours later.
  const when =
    gone.changedAt != null
      ? ` ${agoWords(Math.floor(input.nowMs / 1000) - gone.changedAt)}`
      : "";
  return {
    kind: "removedUpstream",
    line: `Removed on ${branch}${by}${when}. Your copy here is the last one.`,
  };
}

// ── The `⋯` menu ─────────────────────────────────────────────────────────

/** UX-9.5: the entry that takes a skill out of the team library. */
export const REMOVE_FROM_TEAM_LABEL = "Remove from Team…";

/** Which CLIs the branch's copies of a skill reach, off the mirror; null when
 *  the mirror has no row for it (the name is all Ply knows). */
export type BranchReach = { claude: boolean; codex: boolean } | null;

/** Walk F2: the branch's reach for `name`, as the rows read it. */
/** Group B §2 review 1: the skill's id on the branch as the row shows it
 *  (`MirrorSkill.id`), or null when unknown. */
export function branchIdOf(input: Pick<SkillsInput, "mirror"> | null, name: string): string | null {
  return input?.mirror.find((s) => s.name === name)?.id ?? null;
}

/**
 * Group B §2 review 2: which branch version each open dialog was showing.
 *
 * `Compare` records the skill's id **when it opens**; an `Align` or a `Remove`
 * started while that comparison is open takes the comparison's id, not the one
 * a refresh has brought since — the member judged the version they compared.
 */
export class ShownBranchIds {
  #ids = new Map<string, string | null>();

  compareOpened(key: string, id: string | null): void {
    this.#ids.set(`compare:${key}`, id);
  }

  compareClosed(key: string | null): void {
    if (key === null) {
      for (const k of [...this.#ids.keys()]) if (k.startsWith("compare:")) this.#ids.delete(k);
    } else {
      this.#ids.delete(`compare:${key}`);
    }
  }

  /** `Align` or `Remove` opened on `key`, with the id the row shows now. */
  opened(kind: "align" | "remove", key: string, now: string | null): void {
    const compared = this.#ids.get(`compare:${key}`);
    this.#ids.set(`${kind}:${key}`, compared !== undefined ? compared : now);
  }

  /** The id to send with the press; forgotten once taken. */
  take(kind: "align" | "remove", key: string): string | null {
    const id = this.#ids.get(`${kind}:${key}`) ?? null;
    this.#ids.delete(`${kind}:${key}`);
    return id;
  }
}

export function branchReachOf(
  input: Pick<SkillsInput, "mirror"> | null,
  name: string,
): BranchReach {
  const skill = input?.mirror.find((s) => s.name === name);
  if (!skill) return null;
  const facts = branchFacts(skill);
  return { claude: facts.claude, codex: facts.codex };
}

/** The copies a removal takes, in words: `its Claude and Codex copies`, `its
 *  Claude copy`, `its Codex copy` — or `it` when Ply does not know. */
function removedCopies(reach: BranchReach): string {
  if (reach?.claude && reach.codex) return "its Claude and Codex copies";
  if (reach?.claude) return "its Claude copy";
  if (reach?.codex) return "its Codex copy";
  return "it";
}

/**
 * The question `Remove from <branch>…` asks. It says who it reaches — every
 * colleague, like the team's Remove — and what it leaves: the checkout, whose
 * copy is not Ply's to delete. Every copy the branch has goes (GH #105), and it
 * names only the ones there are (walk F2: a Claude-only skill has no Codex copy
 * to take).
 */
export function unpublishConfirmBody(
  name: string,
  branch: string,
  reach: BranchReach = null,
): string {
  return (
    `Removing ${name} takes ${removedCopies(reach)} off ${branch} in one ` +
    `commit: everyone who opens this repository stops getting it after their ` +
    `next refresh. Your project folder's copy is untouched.`
  );
}

/**
 * Walk F4 (review): `Update on <branch>` is always offered — the rows are a
 * snapshot, and an edit made outside the page since then must still publish.
 * The press reads the library state again, and when the checkout's copies are
 * already the branch's this is the toast, and nothing is published.
 */
export function alreadyCurrentToast(name: string, branch: string): { title: string; body: string } {
  return {
    title: `${name} is already the same on ${branch}`,
    body: "Every copy your project folder has matches the branch, so there was nothing to publish.",
  };
}

/** The toast after `Remove from <branch>`, naming the CLIs that stop loading it. */
/**
 * Group B §2 walk: the toast after `Update on <branch>`. When only one copy of a
 * skill both CLIs read was edited, the other follows it on the branch, and the
 * toast says so — the checkout's unedited copy is left as it is.
 */
export function publishToastBody(follows: "claude" | "codex" | null | undefined): string {
  if (follows === "codex" || follows === "claude") {
    const [edited, other] = follows === "codex" ? ["Claude's", "Codex's"] : ["Codex's", "Claude's"];
    return (
      `Only ${edited} copy was edited, so ${other} copy on the branch follows it: Claude and Codex ` +
      `both get the new version in one commit. Claude and Codex on other Macs load it after their next refresh. ` +
      `Your project folder is untouched — its ${other} copy changes when you pull.`
    );
  }
  return "Claude and Codex on other Macs load it after their next refresh — every copy your project folder has of it travels together. Your project folder is untouched.";
}

export function unpublishToastBody(reach: BranchReach = null): string {
  const clis =
    reach?.claude && reach.codex
      ? ", for Claude and for Codex"
      : reach?.claude
        ? ", for Claude"
        : reach?.codex
          ? ", for Codex"
          : "";
  return machineWords(
    `New tiles on other Macs stop loading it after their next refresh${clis}. Your project folder is untouched.`,
  );
}

export interface MenuFacts {
  scope: Scope;
  /** The skill's own files are not Ply's to change. */
  readOnly: boolean;
  /**
   * Code may open its files.
   *
   * GH #142: no longer the same value as `openInCode`. The editor has a
   * read-only mode now, so `Open in Code` returns for the copies Ply may read
   * and may not write — the mirror's, the team library's, this Mac's — while
   * `openInCode` goes on being the one fact for **writable**, which is what the
   * page's `Edit in Code` is offered from. Whether a given press opens a reading
   * view is `readOnlyFile.ts::skillFileMode`, decided once where the path is
   * turned into a tab.
   *
   * False only where there is no file to open at all: a team row whose library
   * directory Ply has not read.
   */
  hasFile: boolean;
  /** Another scope carries this name, and the row's one action is not already
   *  `Compare` — so the chip has something behind it (review 1). */
  compare?: boolean;
  /** GH #105: the branch's two copies disagree, and the row's one action is not
   *  already the comparison of them. */
  compareReach?: boolean;
  /** Skills hub H3a: a linked copy whose origin is here to compare with, and
   *  the row's action is not already that Compare. */
  compareLink?: boolean;
  /** That link reads *Both changed*: its Compare is the 3-way one. */
  compareLinkThree?: boolean;
  /** Skills hub H8 (Mac re-walk): what the link's origin is called, when it
   *  isn't the team library ("astra", "your own skills", "Plyloft"). */
  compareLinkWords?: string | null;
  /** GH #105: the branch's two copies disagree. `Align` asks which one wins. */
  differs?: boolean;
  /** Skills hub H5 (R12): the checkout's two copies aren't aligned and a
   *  card can carry the Align (no shared channel). */
  alignByCard?: boolean;
  /** GH #105: the branch already carries a copy for every CLI, so there is
   *  nothing to make available. */
  reachesBoth?: boolean;
  /** What copying it into the team library would do, when that is offered. */
  teamState?: CopyState;
  /** What installing it here would do, when the row's action is taken by
   *  something else (a duplicate's `Compare`). */
  installState?: CopyState;
  /** The workspace publishes through the shared channel. */
  shared: boolean;
  branch: string | null;
  /** This Mac may write the branch. */
  branchWritable: boolean;
  /** The checkout holds the Claude copy a publish reads. */
  inCheckout: boolean;
  /** The branch already carries it. */
  onBranch: boolean;
  /** A key and GitHub write access to the team repo. */
  canPromote: boolean;
  /** F4: why Promote is off although this Mac could promote — the backend's
   *  words for two copies that disagree. Shown as a disabled entry. */
  promoteBlocked?: string | null;
  /** Skills hub H4 step 8 c: why the team repo refuses this member's writes
   *  (GitHub says read, not write). Shown as a disabled `Promote to Team` on a
   *  repository row and a disabled `Remove from Team…` on a team row. */
  promoteRefusal?: string | null;
  /** H4 Challenger step 13: the caveat under an offered Promote. */
  promoteCaveat?: string | null;
  /** UX-9.5: a team row this Mac may take out of the team library. */
  removeFromTeam?: boolean;
}

/**
 * The `⋯` of a row (BOARDS.md §3 "Row menu"): `Open in Code`,
 * `Update on <branch>`, `Promote to Team`, `—`, `Remove from <branch>`.
 *
 * Entries that do not apply are absent rather than disabled: the board draws
 * only the entries that mean something. Two kinds are shown off instead, each
 * with its reason as the entry's hint, because there the missing entry was the
 * question: `Promote to Team` when the two copies disagree (`promoteBlocked`,
 * F4), and `Promote to Team` / `Remove from Team…` when GitHub lets this member
 * read the team repo and not write it (`promoteRefusal`, H4 step 8 c).
 *
 * GH #105 adds the two entries #96 left for it: `Make available to both`, when
 * the branch carries this skill for one CLI and not the other, and `Align`, when
 * it carries both and they disagree. Both write the branch, so both sit behind
 * the same `writes` gate as `Update on <branch>` — a read-only collaborator sees
 * the property on the row and none of the actions.
 */
export function skillMenu(facts: MenuFacts): SkillMenuEntry[] {
  const entries: SkillMenuEntry[] = [];
  // One label for both, because it is one press with one outcome: the file
  // opens in Code. Whether that tab can be saved is said where it matters — on
  // the tab, and in the line above the document (GH #142).
  if (facts.hasFile) entries.push({ id: "open-in-code", label: "Open in Code" });
  // Reading two copies is not writing either of them, so it survives read-only.
  if (facts.compare) entries.push({ id: "compare", label: "Compare" });
  // Named apart from the duplicate's `Compare`: one menu cannot hold two
  // entries called the same thing and mean two different pairs of files.
  if (facts.compareReach) {
    entries.push({ id: "compare-reach", label: COMPARE_REACH_LABEL });
  }
  if (facts.compareLink) {
    entries.push({ id: facts.compareLinkThree ? "compare3" : "compare-link", label: compareLinkLabel(facts.compareLinkWords) });
  }
  if (facts.installState && facts.installState !== "same") {
    const copy = copyAction("install", facts.installState, "");
    entries.push({
      id: "install",
      label: copy.label,
      ...(copy.confirm ? { confirm: true as const } : {}),
    });
  }
  const branch = facts.branch ?? BRANCH_FALLBACK;
  const writes = facts.scope === "repository" && facts.shared && facts.branchWritable;
  if (writes && facts.inCheckout) {
    entries.push({
      id: "publish-to-branch",
      // The board draws the skill that is already there; a new one has never
      // been published, and saying "Update" would be a lie about both.
      label: facts.onBranch ? `Update on ${branch}` : `Publish to ${branch}`,
    });
  }
  // The board's order: `Open in Code · Update on <branch> · Make available to
  // both · Promote to Team · — · Remove from <branch>` (review 1, MINOR: this
  // sat above the publish).
  //
  // Only with a copy on the branch to carry over: the copy is made there, from
  // what is there. A skill the branch does not have yet is published first, which
  // is the entry above. `Align` takes the same place when the two copies on the
  // branch disagree — the two are never offered together, because a copy is never
  // made over a disagreement.
  if (writes && facts.onBranch && !facts.reachesBoth && !facts.differs) {
    entries.push({ id: "make-available-to-both", label: MAKE_BOTH_LABEL });
  }
  if ((writes && facts.differs) || (facts.scope === "repository" && facts.alignByCard)) {
    entries.push({ id: "align", label: ALIGN_LABEL });
  }
  if (
    facts.canPromote &&
    !facts.readOnly &&
    (facts.scope === "repository" || facts.scope === "this-mac") &&
    facts.teamState !== "same"
  ) {
    // Named by what it would do, as the old panel's button was: the team
    // library holding a different copy is a Replace, and `copy_into` refuses
    // one that was not asked for.
    // H4 Challenger step 13: offered, with the caveat under it when GitHub
    // couldn't be asked whether this member may write.
    const caveat = facts.promoteCaveat ? { hint: facts.promoteCaveat } : {};
    entries.push(
      facts.teamState === "partial"
        ? { id: "promote-to-team", label: "Complete in Team", ...caveat }
        : facts.teamState === "differs"
          ? { id: "promote-to-team", label: "Replace in Team…", confirm: true, ...caveat }
          : { id: "promote-to-team", label: "Promote to Team", ...caveat },
    );
  } else if (
    facts.promoteRefusal &&
    !facts.readOnly &&
    (facts.scope === "repository" || facts.scope === "this-mac") &&
    facts.teamState !== "same"
  ) {
    // Skills hub H4 step 8 c walk: a member GitHub lets read and not write
    // was shown no Promote at all, and no word why — the reason lived only in
    // a flow this row never opens. Said here, as `promoteBlocked` is.
    entries.push({
      id: "promote-to-team",
      label: "Promote to Team",
      disabled: true,
      hint: facts.promoteRefusal,
    });
  } else if (
    facts.promoteBlocked &&
    !facts.readOnly &&
    facts.scope === "repository" &&
    facts.teamState !== "same"
  ) {
    // Cold read (Challenger): off under the label it would have when on.
    entries.push({
      id: "promote-to-team",
      label:
        facts.teamState === "partial"
          ? "Complete in Team"
          : facts.teamState === "differs"
            ? "Replace in Team…"
            : "Promote to Team",
      disabled: true,
      hint: facts.promoteBlocked,
    });
  }
  if (writes && facts.onBranch) {
    // `…`: it asks first (SkillsPage), because it reaches every colleague.
    entries.push("divider", {
      id: "remove-from-branch",
      label: `Remove from ${branch}…`,
      danger: true,
    });
  }
  // UX-9.5: the Team page no longer lists the team's skills; the Library does,
  // and removing one for everyone is its row's last entry. It always asks.
  if (facts.scope === "team" && facts.removeFromTeam) {
    entries.push("divider", { id: "remove-from-team", label: REMOVE_FROM_TEAM_LABEL, danger: true });
  } else if (facts.scope === "team" && facts.promoteRefusal) {
    // H4 step 8 c (Challenger): GitHub lets this member read and not write;
    // the entry says so rather than going missing.
    entries.push("divider", {
      id: "remove-from-team",
      label: REMOVE_FROM_TEAM_LABEL,
      danger: true,
      disabled: true,
      hint: facts.promoteRefusal,
    });
  }
  return entries;
}

// ── The rows, by scope ───────────────────────────────────────────────────

/** Names that exist at more than one scope, and where. */
export function crossScopeDuplicates(
  input: Pick<SkillsInput, "repository" | "mirror" | "team" | "personal" | "ply">,
): Map<string, Scope[]> {
  const at = new Map<string, Set<Scope>>();
  const note = (name: string, scope: Scope) => {
    const set = at.get(name) ?? new Set<Scope>();
    set.add(scope);
    at.set(name, set);
  };
  for (const s of input.repository) note(s.name, "repository");
  for (const s of input.mirror) note(s.name, "repository");
  for (const s of input.team) note(s.name, "team");
  for (const s of input.personal) note(s.name, "this-mac");
  for (const s of input.ply) note(s.name, "ply");
  const out = new Map<string, Scope[]>();
  for (const [name, scopes] of at) {
    if (scopes.size > 1) out.set(name, SKILL_SCOPES.filter((s) => scopes.has(s)));
  }
  return out;
}

/**
 * Skills hub H9 (walk, 2026-10-20): the duplicates that really reach the
 * agents here. A Plyloft skill switched off for this workspace's sessions —
 * by a fork in the repository, the workspace, the team or this Mac — reaches
 * none of them, so it is no duplicate of anything here and no row says
 * "Both reach the agents". `crossScopeDuplicates` stays the whole list: the
 * `Keep both` prune judges by it, and a switch flicked back on must find the
 * member's decision still there.
 */
export function reachingDuplicates(
  duplicates: Map<string, Scope[]>,
  ply: readonly Pick<PlySkillInput, "name" | "on" | "switch">[],
): Map<string, Scope[]> {
  const offHere = new Set(ply.filter((s) => !(s.switch ? s.switch.on : s.on)).map((s) => s.name));
  if (offHere.size === 0) return duplicates;
  const out = new Map<string, Scope[]>();
  for (const [name, scopes] of duplicates) {
    const reaching = offHere.has(name) ? scopes.filter((s) => s !== "ply") : scopes;
    if (reaching.length > 1) out.set(name, reaching);
  }
  return out;
}

function duplicateOf(
  duplicates: Map<string, Scope[]>,
  name: string,
  scope: Scope,
): { chip: string; other: Scope } | null {
  // Mac re-walk, 2026-10-20: a copy that reaches nothing here (a Plyloft
  // skill switched off, `reachingDuplicates`) is no duplicate itself, even
  // while two other scopes still share its name.
  const scopes = duplicates.get(name);
  if (!scopes?.includes(scope)) return null;
  const others = scopes.filter((s) => s !== scope);
  const other = others[0];
  return other ? { chip: duplicateChip(other), other } : null;
}

/**
 * Is this duplicate still speaking up? (GH #100.)
 *
 * `Keep both` silences the pair on this Mac, and a silenced duplicate keeps its
 * chip and loses its row action. `null` for a row with no duplicate at all.
 */
function duplicateIsLive(
  duplicate: { other: Scope } | null,
  scope: Scope,
  name: string,
  silencedPairs: readonly string[],
): boolean {
  if (!duplicate) return false;
  return !silencedPairs.includes(duplicatePairKey(scope, duplicate.other, name));
}

/** `Compare`, as a row's one action. */
const COMPARE_ACTION: SkillAction = { id: "compare", label: "Compare" };

/**
 * A row's directory as an absolute path: a repository row's is repo-relative,
 * every other scope's is already absolute (the mirror build, the team clone, the
 * member's home).
 *
 * One definition, because three callers ask: the page, the `⋯`'s `Open in Code`,
 * and the read of the duplicate pairs' files.
 */
export function absoluteSkillDir(
  row: Pick<SkillRow, "dir">,
  cwd: string,
): string | null {
  if (!row.dir) return null;
  return isAbsolutePath(row.dir) ? row.dir : joinPath(cwd, row.dir);
}

/** The Claude root a publish reads, mirroring `projectSkills.CLAUDE_SKILL_ROOT`. */
const CLAUDE_ROOT = ".claude/skills";
/** The Codex root Ply writes, mirroring `project_skills::CODEX_ROOT`. */
const CODEX_ROOT = ".agents/skills";
/**
 * The roots the shared channel carries.
 *
 * `.codex/skills` is deliberately absent: Ply reads it (a repository that uses it
 * is listed) and never writes it, so a skill that lives only there has nothing to
 * publish (review 1, MINOR).
 */
const PUBLISHABLE_ROOTS: readonly string[] = [CLAUDE_ROOT, CODEX_ROOT];

/**
 * `In this repository`: the checkout's skills merged with the mirror's.
 *
 * Merged and not concatenated, because they are the same skills seen from two
 * places — a teammate's skill is on the branch before this checkout has it,
 * and this checkout's may not be on the branch yet. One row per name, so the
 * section counts skills rather than copies.
 */
export function repositoryRows(input: SkillsInput, duplicates: Map<string, Scope[]>): SkillRow[] {
  const byName = new Map<string, SkillRow>();
  const branchWritable = input.shared && !input.branchReadOnly;
  const silencedPairs = input.silencedPairs ?? [];
  // GH #105: the branch's facts, looked up while each row is built rather than
  // patched onto it afterwards. Reach, drift and what the `⋯` may offer are one
  // set of facts about one skill, and the menu is decided once.
  const onBranch = new Map(input.mirror.map((skill) => [skill.name, branchFacts(skill)]));
  for (const listed of input.repository) {
    // Owner, 2026-10-19: "isn't on <branch> yet, publish it first" is the way
    // to a Promote, and a copy linked to the team's is past Promote — its
    // link says how it stands. The backend already leaves it off a copy the
    // team library holds; the link is the window's to know. Promote itself
    // stays off (below, from `listed`), just not explained as a next step.
    //
    // Cold read 2026-10-19 (Challenger): an unlinked copy the team library
    // holds differently is past Promote too, but its next step is Replace (or
    // Complete) in Team, which waits for the same publish — the sentence
    // stays and names that action, so the `⋯` entry is never off unexplained.
    const linked = input.links?.some((l) => l.skill === listed.name) ?? false;
    let skill = linked && listed.promoteWaitsForBranch
      ? { ...listed, promoteBlocked: null }
      : listed.promoteWaitsForBranch && listed.promoteBlocked && (listed.team === "differs" || listed.team === "partial")
        ? { ...listed, promoteBlocked: waitsWithAction(listed.promoteBlocked, listed.team) }
        : listed;
    // Mac walk (cold read): the same for the note a Promote would carry ("…
    // Promote to Team shares the copy on GitHub") — the `⋯` names it Replace
    // (or Complete) in Team, and the row says the same word.
    if (!linked && skill.promoteNote && (skill.team === "differs" || skill.team === "partial")) {
      skill = { ...skill, promoteNote: waitsWithAction(skill.promoteNote, skill.team) };
    }
    const transient = skillTransient(skill.name, input);
    const duplicate = duplicateOf(duplicates, skill.name, "repository");
    const branch = onBranch.get(skill.name) ?? null;
    const drift = driftOf(branch);
    // Skills hub H3a: a linked copy says where it came from and how it stands;
    // what is happening right now (a transient, drift, a duplicate) keeps the
    // row's one action, and the link's goes in the `⋯` then.
    const link = input.links?.find((l) => l.skill === skill.name) ?? null;
    // Skills hub H3b (R-M): an unlinked copy that equals a version of the
    // team's same-named skill is offered **Link**.
    const offer = link ? null : (input.linkOffers?.find((o) => o.skill === skill.name) ?? null);
    const onItsWay = link || offer ? openSkillCard(input.skillCards ?? [], skill.name) : null;
    // Cold read 2026-10-19: the team skill this copy is linked to waits for
    // this Mac's OK. The team row says so; this row says it too and offers
    // the same Review — only while the team has a newer copy to take
    // (Challenger): an Update is what waits for that OK.
    const teamWaits = link && (link.state === "updateAvailable" || link.state === "bothChanged")
      ? (input.team.find(
          (t) => t.name === skill.name && t.needsOk && (link.plugin == null || link.plugin === t.plugin),
        )?.needsOk ?? null)
      : null;
    // Skills hub H5 (R12): the two copies, where a card carries an Align. A
    // shared workspace aligns a skill its branch carries there (GH #105);
    // one the branch doesn't carry yet is the checkout's alone, and aligns
    // by card like anywhere else (Challenger, H5 Mac walk: it said nothing).
    const sharedOnBranch = input.shared && (branch !== null || input.branchSkills.includes(skill.name));
    const twin = sharedOnBranch ? null : (input.twins?.find((t) => t.skill === skill.name) ?? null);
    const twinCard = twin ? openSkillCard(input.skillCards ?? [], skill.name) : null;
    const alignByCard = twinAlignable(twin, skill.ignoredRoots ?? [], twinCard);
    // H3a walk: a linked copy always shares its name with the team row it
    // came from — that is its origin, not a duplicate to compare, so it must
    // not take the row's action from Update (the link's own Compare is in
    // the `⋯`). Any other duplicate still speaks up. H3b: the same for a copy
    // offered Link — its team twin is the version it equals, and Link is
    // the row's action.
    const ownOrigin = (link !== null || offer !== null) && duplicate?.other === "team";
    const action =
      repositoryAction(
        transient,
        !ownOrigin && duplicateIsLive(duplicate, "repository", skill.name, silencedPairs),
        drift !== null,
      ) ??
      (alignByCard && twin?.twins.state === "differ" ? ALIGN_ACTION : null) ??
      (teamWaits && !onItsWay ? REVIEW_SCRIPTS_ACTION : null) ??
      (link ? linkedAction(link, onItsWay) : linkOfferAction(offer, onItsWay));
    // Reach is what a CLI **gets**, not what exists somewhere (review 1, MINOR):
    // the checkout's copy ∪ the branch's. Claude's copy on the branch counts,
    // because Ply hands it to every Claude session it starts through the
    // `project` plugin; GH #156 hands Codex's to every Codex session the same way
    // (`project:<name>`, the `ply-project` marketplace in the `CODEX_HOME`
    // overlay) — **when** that overlay can carry it on this Mac. When it cannot,
    // the chip stays dark and `branchOnlyNotes` says why.
    const claude = skill.claude || (branch?.claude ?? false);
    const codex = skill.codex || ((branch?.codex ?? false) && codexDelivered(input));
    const refused = !input.canPromote && !!input.promoteRefusal;
    // Group B §2 walks: one copy lagging behind what the branch has aligned is
    // not a divergence, and while an Update of this skill is on its way "make
    // them match" reads as a refusal of that very Update. In both the note
    // waits; the line above or the row's transient speaks. Skills hub H4 step
    // 8 c: a member the team repo refuses is not told what Promote would share
    // — the `⋯` says why it is off. The pull that brings the aligned copies
    // here still helps them.
    // QoL 13.1 (walk): a skill only the project folder has says one thing —
    // "Only in your project folder · Ship it with a card" — never also that
    // it isn't on the branch yet.
    const folderOnly =
      (input.uncommitted ?? []).includes(skill.name) &&
      skill.roots.some((root) => PUBLISHABLE_ROOTS.includes(root) && !(skill.ignoredRoots ?? []).includes(root));
    const noted =
      checkoutBehindOf(skill.name, input) || publishInFlight(skill.name, input)
        ? { ...skill, promoteBlocked: null, promoteNote: null }
        : folderOnly && skill.promoteWaitsForBranch
          ? { ...skill, promoteBlocked: null }
        : refused
          ? {
              ...skill,
              promoteBlocked: alignedOnBranch(skill, branch, input)
                ? alignedOnBranchPullLine(skill.name, input.branch)
                : null,
              promoteNote: null,
            }
          : alignedOnBranch(skill, branch, input)
            ? { ...skill, promoteBlocked: alignedOnBranchLine(skill.name, input.branch) }
            : skill;
    // Walk follow-ups 2026-10-19: the row states one way forward — when its
    // Promote / Replace / Complete note speaks, the link offer only says what
    // the uncommitted copy is.
    const promoteSpeaks = !!(noted.promoteBlocked || noted.promoteNote);
    // ...and the copy a Promote here shares isn't this checkout's (Compare
    // shows the working copy): the note says which one it shares.
    // Challenger: only where the `⋯` has that Promote — not for a copy the
    // team library already holds (no entry to press).
    const promoteShares =
      !noted.promoteBlocked &&
      noted.promoteNote &&
      input.canPromote &&
      !listed.promoteBlocked &&
      skill.team !== "same"
        ? noted.promoteNote
        : null;
    // QoL 13.1, 13.2 and 13.4: the ways out a row's own words name.
    const ways: WaysOut = {
      behind: !!checkoutBehindOf(skill.name, input) || alignedOnBranch(skill, branch, input),
      inFolderOnly: folderOnly,
      carriedBy: openSkillCard(input.skillCards ?? [], skill.name),
      // A link's line and the twins' already name the card on its way.
      cardNamed: onItsWay !== null || twinCard !== null,
    };
    byName.set(skill.name, withWaysOut(ways, input.branch, {
      key: `repository:${skill.name}`,
      name: skill.name,
      scope: "repository",
      description: skill.description,
      hint: firstSentence(skill.description),
      linkChip: link ? linkChip(link, onItsWay) : null,
      linkState: link && !onItsWay ? link.state : null,
      notes: [
        ...(link ? [linkLine(link, onItsWay)] : []),
        ...(teamWaits ? [linkedNeedsOkLine(teamWaits)] : []),
        ...(offer ? [linkOfferLine(offer, onItsWay, promoteSpeaks)] : []),
        ...behindNotes(skill.name, input),
        ...skillNotes(noted),
        ...branchOnlyNotes(skill, branch, input.branch, input.branchCodex),
        ...twinNotes(twin, skill.name, skill.ignoredRoots ?? [], twinCard),
      ],
      promoteShares,
      asks: skill.asks ?? null,
      asksId: skill.asksId ?? null,
      shareRefusal: skill.shareRefusal ?? null,
      claude,
      codex,
      readOnly: false,
      duplicate,
      drift,
      twins: alignByCard ? (twin?.twins ?? null) : null,
      transient,
      action,
      menu: skillMenu({
        scope: "repository",
        readOnly: false,
        hasFile: true,
        // The chip always has something behind it: `Compare` sits in the `⋯`
        // whenever the row's own action is not it — a transient took the action,
        // or `Keep both` silenced the duplicate.
        compare: duplicate !== null && action?.id !== "compare",
        compareReach: drift !== null && action?.id !== "compare-reach",
        compareLink: link !== null && link.state !== "notAvailable" && action?.id !== "compare-link",
        // Owner-fixes walk: H5 put Align before the link's own action, and a
        // *Both changed* copy then had only the 2-way Compare (the start vs
        // here, Close) — no upstream version, no choices. While something
        // else has the row's action, its `⋯` Compare is the 3-way one; where
        // the 3-way is the action, the `⋯` keeps the 2-way as before.
        compareLinkThree: link?.state === "bothChanged" && onItsWay === null && action?.id !== "compare3",
        compareLinkWords: link && (link.originKind ?? "team") !== "team" ? link.originWords : null,
        differs: drift !== null,
        alignByCard,
        reachesBoth: (branch?.claude ?? false) && (branch?.codex ?? false),
        teamState: skill.team,
        shared: input.shared,
        branch: input.branch,
        branchWritable,
        // Either root **the channel carries** (review 1, MINOR): a skill that
        // lives only in the legacy `.codex/skills` is loaded by Codex here and
        // cannot be published, because Ply never writes that root and
        // `skill_files_both` would find nothing to send.
        inCheckout: skill.roots.some((root) => PUBLISHABLE_ROOTS.includes(root)),
        onBranch: branch !== null || input.branchSkills.includes(skill.name),
        // A skill whose two copies disagree is not Ply's to choose between.
        canPromote: input.canPromote && !listed.promoteBlocked,
        // F4: the reason the row's notes give — after `Align` landed on the
        // branch, that is the "pull it" line, not "make them match".
        promoteBlocked:
          input.canPromote && skill.promoteBlocked
            ? alignedOnBranch(skill, branch, input)
              ? alignedOnBranchLine(skill.name, input.branch)
              : skill.promoteBlocked
            : null,
        promoteRefusal: refused ? input.promoteRefusal : null,
        promoteCaveat: input.canPromote && !listed.promoteBlocked ? (input.promoteCaveat ?? null) : null,
      }),
      // Its files are in the checkout: the one tree Ply may write.
      openInCode: true,
      dir: joinPath(skill.roots[0] ?? CLAUDE_ROOT, skill.name),
      fromMirror: false,
      plugin: null,
      ply: null,
    }));
  }
  for (const skill of input.mirror) {
    if (byName.has(skill.name)) continue;
    const transient = skillTransient(skill.name, input);
    const duplicate = duplicateOf(duplicates, skill.name, "repository");
    const branch = branchFacts(skill);
    const drift = driftOf(branch);
    const action = repositoryAction(
      transient,
      duplicateIsLive(duplicate, "repository", skill.name, silencedPairs),
      drift !== null,
    );
    const branchNotes = branchOnlyNotes({ claude: false, codex: false }, branch, input.branch, input.branchCodex);
    const mirrorWays: WaysOut = {
      // Only on the branch: the folder lacks it, which only a pull mends.
      behind: branchNotes.length > 0,
      inFolderOnly: false,
      carriedBy: openSkillCard(input.skillCards ?? [], skill.name),
      cardNamed: false,
    };
    byName.set(skill.name, withWaysOut(mirrorWays, input.branch, {
      key: `repository:${skill.name}`,
      name: skill.name,
      scope: "repository",
      description: skill.description,
      hint: firstSentence(skill.description),
      notes: branchNotes,
      // On the branch and nowhere here: Ply hands both copies to every session
      // it starts — Claude's as the `project` plugin, Codex's (GH #156) as the
      // same plugin in the `CODEX_HOME` overlay, when this Mac's Codex home can
      // take it. A chip never claims a reach nothing delivers (review 1, MINOR).
      claude: branch.claude,
      codex: branch.codex && codexDelivered(input),
      readOnly: false,
      duplicate,
      drift,
      transient,
      action,
      menu: skillMenu({
        scope: "repository",
        readOnly: false,
        // GH #142: its only copy is inside Ply's own mirror of the branch, and
        // that is now something Code can open — as a reading view, which is what
        // #96 wanted here and could not have. The save it must never offer is
        // gone rather than the editor.
        hasFile: true,
        compare: duplicate !== null && action?.id !== "compare",
        compareReach: drift !== null && action?.id !== "compare-reach",
        differs: drift !== null,
        reachesBoth: branch.claude && branch.codex,
        shared: input.shared,
        branch: input.branch,
        branchWritable,
        // Not in the checkout: there is nothing here to publish, only
        // something on the branch to remove — or a copy to carry over.
        inCheckout: false,
        onBranch: true,
        canPromote: false,
      }),
      openInCode: false,
      dir: skill.dir,
      fromMirror: true,
      plugin: null,
      ply: null,
    }));
  }
  return [...byName.values()].sort(byNameAsc);
}

// ── QoL block 13: the ways out of a git step ─────────────────────────────

/** 13.1: the row's action for a skill written into the project folder. */
export const SHIP_WITH_CARD_LABEL = "Ship it with a card";
/** 13.4: the row's action while a skill card carries it. */
export const OPEN_CARD_LABEL = "Open card";
/** 13.1: what the row says about a skill only the project folder has. */
export const IN_FOLDER_ONLY_LINE =
  "Only in your project folder: it works in your sessions here, and teammates get it once a card ships it.";

/** What a repository row's ways out hang on. */
interface WaysOut {
  /** The project folder is behind the branch for this skill (13.2). */
  behind: boolean;
  /** Written into the project folder and not committed, in a root a card
   *  may carry (13.1). */
  inFolderOnly: boolean;
  /** The skill card on its way with it (13.4). */
  carriedBy: KanbanCard | null;
  /** The row's notes already name that card. */
  cardNamed: boolean;
}

/**
 * QoL block 13 (D4: no new git exception): a row whose words used to send the
 * member to a git step Plyloft doesn't take gets a way out inside Plyloft —
 * **Ask the Builder** when the project folder is behind the branch, **Ship it
 * with a card** for a skill only the folder has, **Open card** while a card
 * carries it. The row's own action, when it has one, stays; the others go in
 * the `⋯`, before its dangerous entries.
 */
function withWaysOut(ways: WaysOut, branch: string | null, row: SkillRow): SkillRow {
  const card = ways.carriedBy;
  const offered: SkillAction[] = [];
  if (ways.behind) offered.push({ id: "ask-builder", label: ASK_BUILDER, prompt: bringBranchPrompt(branch, row.name) });
  if (ways.inFolderOnly && !card) offered.push({ id: "ship-with-card", label: SHIP_WITH_CARD_LABEL });
  if (card) offered.push({ id: "open-card", label: OPEN_CARD_LABEL, cardId: card.id });
  const notes = [
    ...row.notes,
    ...(ways.inFolderOnly && !card ? [IN_FOLDER_ONLY_LINE] : []),
    ...(card && !ways.cardNamed ? [onItsWayLine(card)] : []),
  ];
  if (offered.length === 0) return notes.length === row.notes.length ? row : { ...row, notes };
  const action = row.action ?? offered[0];
  const entries: SkillMenuEntry[] = offered
    .filter((way) => way.id !== action.id)
    .map((way): SkillMenuEntry =>
      way.id === "ask-builder"
        ? { id: "ask-builder", label: way.label, prompt: way.prompt ?? "" }
        : way.id === "open-card"
          ? { id: "open-card", label: way.label, cardId: way.cardId ?? "" }
          : { id: "ship-with-card", label: way.label },
    );
  const at = row.menu.findIndex((e) => e === "divider" || "danger" in e);
  const menu = at < 0 ? [...row.menu, ...entries] : [...row.menu.slice(0, at), ...entries, ...row.menu.slice(at)];
  return { ...row, notes, action, menu };
}

/** What the branch carries for one skill. */
interface BranchFacts {
  claude: boolean;
  codex: boolean;
  differs: boolean;
  dir: string;
  codexDir: string | null;
}

/**
 * The mirror row's facts, with the pre-#105 default.
 *
 * A `LibraryState` written by an older build has no reach on its mirror rows, and
 * what it meant by "on the branch" was the Claude copy — so a row with neither
 * flag set counts as Claude's, which is exactly what #96 drew.
 */
function branchFacts(skill: MirrorSkillInput): BranchFacts {
  const claude = skill.claude ?? !skill.codex;
  return {
    claude,
    codex: skill.codex ?? false,
    differs: skill.differs ?? false,
    dir: skill.dir,
    codexDir: skill.codexDir ?? null,
  };
}

/**
 * The row's drift, when the branch's two copies disagree **and** Ply knows where
 * both of them are.
 *
 * Without the second copy's directory there is nothing to compare and nothing to
 * align from, and a chip with nothing behind it is worse than no chip (GH #96
 * review 1, GH #100's `duplicateUnknown`).
 */
function driftOf(branch: BranchFacts | null): SkillRow["drift"] {
  if (!branch?.differs || !branch.codexDir) return null;
  return { chip: DIFFERS_CHIP, claudeDir: branch.dir, codexDir: branch.codexDir };
}

/**
 * GH #156: Ply hands the branch's Codex copies to Codex sessions on this Mac.
 * Absent is "no" — a state from an older build, before there was a delivery.
 */
function codexDelivered(input: Pick<SkillsInput, "branchCodex">): boolean {
  return input.branchCodex?.reaches ?? false;
}

/**
 * What a copy that is on the branch and not in this checkout means, in words.
 *
 * Claude's needs no sentence: Ply hands the branch's copy to every Claude session
 * it starts, through the `project` plugin. GH #156 gives Codex the same delivery,
 * so in the ordinary case Codex's needs none either — the chip says it.
 *
 * Two cases are left, and each says what is true:
 *
 * - the overlay **refuses** the layer on this Mac (the member has a `ply-project`
 *   marketplace of their own, a config Ply cannot parse): the chip is dark and
 *   the row says why, and that Codex reads the copy once the checkout has it;
 * - a state from an older build, with no answer at all: the sentence #105 wrote.
 *
 * A Mac with no Codex home says nothing: the chip is dark, and a member who does
 * not use Codex has nothing to fix (the rule `Comes with Ply` follows).
 */
function branchOnlyNotes(
  checkout: { claude: boolean; codex: boolean },
  branch: BranchFacts | null,
  branchName: string | null,
  delivery: BranchCodexDelivery | undefined,
): string[] {
  if (!branch?.codex || checkout.codex) return [];
  const where = `Codex's copy is on ${branchName ?? BRANCH_FALLBACK} and not in your project folder yet`;
  if (delivery === undefined) {
    return [`${where}; Codex reads it here once the folder has it. ${ASK_BUILDER} to bring it here.`];
  }
  if (delivery.reaches || delivery.refused === null) return [];
  return [
    `${where}, and Plyloft could not hand it to Codex on ${machineWords("this Mac")}: ` +
      `${delivery.refused.trim().replace(/\.$/, "")}. ` +
      `Codex reads it here once the folder has it. ${ASK_BUILDER} to bring it here.`,
  ];
}

/**
 * A repository skill at rest has no primary action; each transient has one, drift
 * between the branch's two copies has `Compare`, and a duplicate still speaking
 * up has `Compare`.
 *
 * In that order: what is happening right now outranks a fact that has been true
 * for weeks. GH #100 adds the last case's condition — a pair `Keep both` has
 * silenced is at rest again, and `Compare` moves into the `⋯`.
 *
 * GH #105 puts drift above the duplicate: the repository's **own** shared copies
 * saying two different things is a fault in this repository, while one name at
 * two scopes is a state the boards call normal ("nothing wins"). Whichever
 * comparison does not get the action is in the `⋯`, so neither chip is left with
 * nothing behind it.
 */
function repositoryAction(
  transient: SkillTransient | null,
  liveDuplicate: boolean,
  drift: boolean,
): SkillAction | null {
  if (transient?.kind === "pullRequest") {
    return { id: "open-pull-request", label: "Open pull request" };
  }
  if (transient?.kind === "removedUpstream") {
    return { id: "keep-on-this-mac", label: machineWords("Keep on this Mac") };
  }
  if (drift) return { id: "compare-reach", label: "Compare" };
  return liveDuplicate ? COMPARE_ACTION : null;
}

/** Skills hub H3a: the `⋯` entry that compares a linked copy with its origin. */
export const COMPARE_LINK_LABEL = "Compare with the library";
/** H8 (Mac re-walk): a copy of a workspace's skill (or this Mac's, or
 *  Plyloft's) compares with that origin, named as it is. */
export function compareLinkLabel(originWords: string | null | undefined): string {
  return originWords ? `Compare with ${originWords}` : COMPARE_LINK_LABEL;
}

/** Skills hub H3b: a team row whose repository copy is offered Link there. */
export const LINK_HERE_NOTE = "Same as a version in this repository · Link it from its row there.";

/**
 * Skills hub H3a: a linked copy's own action, when nothing else has the row.
 *
 * *Update available* → **Update** (§9), unless a skill card already
 * carries the change; *Modified here* → **Compare**, 2-way, and never Update —
 * H3 does not overwrite a local edit (§12); H4 brings the choices.
 */
export function linkedAction(link: SkillLinkRow, onItsWay: KanbanCard | null): SkillAction | null {
  if (onItsWay) return null;
  if (link.state === "updateAvailable") {
    return { id: "update", label: "Update" };
  }
  if (link.state === "modifiedHere") return { id: "compare-link", label: "Compare" };
  // Skills hub H4 (R3): the 3-way Compare holds the three choices.
  if (link.state === "bothChanged") return { id: "compare3", label: "Compare" };
  // H4 (R8).
  if (link.state === "removed") return { id: "removed-choice", label: "Keep or remove…" };
  if (link.state === "renamed") return { id: "renamed-choice", label: "Rename…" };
  return null;
}

const byNameAsc = (a: SkillRow, b: SkillRow) => a.name.localeCompare(b.name);

/**
 * Why a team skill's Codex chip is dark when the library has a Codex copy: the
 * overlay that hands it to Codex is refused here. Silent when it reaches, and on
 * a Mac with no Codex home (`refused` null) — the rule `branchOnlyNotes` and the
 * `Comes with Plyloft` section follow.
 */
export function teamCodexNotes(
  hasCodexCopy: boolean,
  delivery: BranchCodexDelivery | null | undefined,
): string[] {
  if (!hasCodexCopy || !delivery || delivery.reaches || delivery.refused === null) return [];
  return [
    `Plyloft could not hand it to Codex on ${machineWords("this Mac")}: ` +
      `${delivery.refused.trim().replace(/\.$/, "")}.`,
  ];
}

export function teamRows(input: SkillsInput, duplicates: Map<string, Scope[]>): SkillRow[] {
  return input.team
    .map((skill): SkillRow => {
      const duplicate = duplicateOf(duplicates, skill.name, "team");
      const live = duplicateIsLive(
        duplicate,
        "team",
        skill.name,
        input.silencedPairs ?? [],
      );
      // A duplicate still speaking up takes the action (the board); silenced, the
      // copy has it back. Whichever does not have it is in the `⋯`, so neither
      // the chip nor the copy is left with nothing behind it.
      // Skills hub H6a: a decision waiting outranks both (R14).
      const needsOk = skill.needsOk ?? null;
      // Skills hub H3a: an Install already on its way in a skill card is not
      // offered twice; the row names the card.
      const carried = openSkillCard(input.skillCards ?? [], skill.name);
      // H3a walk: this repository's copy is linked to this team skill. The
      // repository row says how it stands and offers Update; here neither the
      // pair's Compare nor Install / "Link and update…" / "Complete" (which
      // would write the CLI the team skill does not reach) is offered.
      const hereLink =
        // H8: a copy of another workspace's skill of the same name is not
        // linked to this team skill.
        input.links?.find(
          (l) => l.skill === skill.name && (l.originKind ?? "team") === "team" && (l.plugin == null || l.plugin === skill.plugin),
        ) ?? null;
      const linkedHere = hereLink !== null;
      // H3b: this repository's committed copy equals a version of this team
      // skill and is offered Link on its own row. Here, no Install, "Link and
      // update…" or Compare competes with it; the row points there.
      const offeredHere =
        !linkedHere &&
        (input.linkOffers?.some((o) => o.skill === skill.name && o.plugin === skill.plugin && o.committed) ?? false);
      // H6b walk: held only by refused plugins, it reaches no CLI and the
      // library won't install it — the row only says why.
      const unreachable = !skill.claude && !skill.codex && (skill.refused?.length ?? 0) > 0;
      const action = unreachable
        ? null
        : needsOk
        ? REVIEW_SCRIPTS_ACTION
        : linkedHere || offeredHere
          ? null
          : live
            ? COMPARE_ACTION
            : carried
              ? null
              : installAction(skill.repo, skill.name);
      return {
        key: `team:${skill.name}`,
        name: skill.name,
        scope: "team",
        description: skill.description,
        hint: firstSentence(skill.description),
        notes: [
          ...(carried ? [onItsWayLine(carried)] : []),
          ...(hereLink && !carried ? [linkedHereLine(hereLink)] : []),
          ...(offeredHere && !carried ? [LINK_HERE_NOTE] : []),
          ...refusedNotes(skill.refused),
          ...skillNotes(skill),
          ...teamCodexNotes(skill.codex, input.teamCodex),
        ],
        claude: skill.claude,
        // Lit only when a Codex session really gets it: the library holding a
        // Codex half is not enough when the overlay that carries it is refused.
        codex: skill.codex && (input.teamCodex?.reaches ?? true),
        readOnly: false,
        duplicate,
        // Drift is about the repository's two copies on the branch; the team
        // library and this Mac have one copy each of each root, and the channel
        // does not carry them.
        drift: null,
        transient: needsOk
          ? { kind: "needsOk", line: needsOkLine(needsOk), plugin: needsOk.plugin }
          : null,
        action,
        menu: skillMenu({
          scope: "team",
          readOnly: false,
          // GH #142: the library is a clone Ply keeps in step with the team repo
          // — `TeamStore::sync` pulls it `--ff-only`, so one ⌘S there stops every
          // later refresh (GH #96 review 1). It opens read-only, and only when
          // Ply has read the directory the copy is in.
          hasFile: skill.dir != null,
          compare: duplicate !== null && action?.id !== "compare",
          installState:
            !carried && !linkedHere && !offeredHere && (action?.id === "compare" || action?.id === "review-scripts")
              ? skill.repo
              : undefined,
          shared: input.shared,
          branch: input.branch,
          branchWritable: false,
          inCheckout: false,
          onBranch: false,
          canPromote: false,
          removeFromTeam: input.canPromote,
          promoteRefusal: input.canPromote ? null : (input.promoteRefusal ?? null),
        }),
        openInCode: false,
        dir: skill.dir ?? null,
        fromMirror: false,
        plugin: skill.plugin,
        ply: null,
      };
    })
    .sort(byNameAsc);
}

/** Skills hub H6a: the row's one action while a team skill waits for an OK. */
export const REVIEW_SCRIPTS_ACTION: SkillAction = { id: "review-scripts", label: "Review" };

/** `3 Oct` — how the sheet and the row name the day an OK was given. */
export function approvedDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * Skills hub H6a (R14, R15): the words on a team row whose scripts wait for an
 * OK — what is waiting, and what new sessions get meanwhile.
 */
export function needsOkLine(needsOk: {
  firstTime: boolean;
  approvedAt: number | null;
  bringsScript?: boolean;
  asks?: StrongestAsk | null;
}): string {
  // 1.175.0 B1: no script is new and its text asks — said in the text's words.
  const text = asksNeedsOkLine(needsOk, approvedDay);
  if (text) return text;
  // (Challenger) True in each state: an image is not "a script", and a script
  // added to a skill that was all text did not "change".
  const script = needsOk.bringsScript !== false;
  const noun = script ? "a script" : "a file that is not text";
  if (needsOk.firstTime) {
    return `Needs your OK · it brings ${noun}. New sessions don't get it until you say OK.`;
  }
  if (needsOk.approvedAt == null) {
    const before = script ? "the script" : "that file";
    return `Needs your OK · it now brings ${noun}. New sessions keep the version from before ${before}.`;
  }
  return `Needs your OK · ${noun} changed. New sessions keep the version you approved on ${approvedDay(needsOk.approvedAt)}.`;
}

/**
 * Cold read 2026-10-19: the same wait, said on the repository row linked to
 * that team skill while the team has a newer copy. This repository's
 * committed copy is what its sessions read, so the row does not say they go
 * without it — it says what waits: the Update.
 */
export function linkedNeedsOkLine(needsOk: { bringsScript?: boolean; asks?: StrongestAsk | null }): string {
  if (needsOk.asks && needsOk.bringsScript !== true) return linkedAsksLine(needsOk.asks);
  const noun = needsOk.bringsScript !== false ? "a script" : "a file that is not text";
  return `Needs your OK · the team library's newer copy brings ${noun}. Update waits until you say OK.`;
}

/** Cold read 2026-10-19: a team row whose repository copy is linked says how
 *  that copy stands, in the repository row's own words. */
export function linkedHereLine(link: SkillLinkRow): string {
  // Read from the team row, "here" is the team library's row: the words name
  // the repository, and the choice is on the repository row (Challenger).
  const own = linkLine(link, null)
    .replace("· modified here", "· modified in this repository")
    .replace("· changed here and in", "· changed in this repository and in")
    .replace("Compare to choose what this repository keeps.", "Compare on its row.");
  const prefix = `Linked to ${link.originWords}`;
  return own.startsWith(prefix) ? `Linked in this repository${own.slice(prefix.length)}` : `Linked in this repository · ${own}`;
}

/** What a share to the team would do, against the copy it would write over.
 *  `null`: there is none (a same-named skill of another plugin isn't one). */
export type PersonalTeamCopy = "same" | "partial" | "differs" | "unknown" | null;

function personalTeamCopy(input: SkillsInput, name: string): PersonalTeamCopy {
  const team = shareTarget(input.team, name, input.promotePlugin);
  if (!team) return null;
  const compared = input.teamCopyCompared?.[name];
  if (compared === undefined) return "unknown";
  if (compared === "differs") return "differs";
  return team.claude && team.codex ? "same" : "partial";
}

/**
 * A personal row's one action. With a team it names what the press really does
 * to a copy the team already has; `null` when it could do nothing at all: the
 * team has these very files, and so does this repository.
 */
function personalAction(input: SkillsInput, name: string, teamCopy: PersonalTeamCopy, alsoIn: readonly Scope[]): SkillAction | null {
  if (input.solo) return { id: "promote", label: "Promote" };
  if (!input.canPromote) return { id: "promote", label: SHARE_LABEL };
  switch (teamCopy) {
    case "same": {
      const here = input.identicalPairs?.includes(duplicatePairKey("this-mac", "repository", name));
      return alsoIn.includes("repository") && here ? null : { id: "promote", label: SHARE_LABEL };
    }
    case "unknown":
      return { id: "promote", label: SHARE_LABEL };
    case "partial":
      return { id: "promote", label: COMPLETE_IN_TEAM_LABEL };
    case "differs":
      return { id: "promote", label: REPLACE_IN_TEAM_LABEL };
    case null:
      return { id: "promote", label: SHARE_WITH_TEAM_LABEL };
  }
}

export function personalRows(input: SkillsInput, duplicates: Map<string, Scope[]>): SkillRow[] {
  return input.personal
    .map((skill): SkillRow => {
      const duplicate = duplicateOf(duplicates, skill.name, "this-mac");
      const alsoIn = (duplicates.get(skill.name) ?? []).filter((scope) => scope === "repository" || scope === "team");
      const teamCopy = input.solo ? null : personalTeamCopy(input, skill.name);
      return {
      key: `this-mac:${skill.name}`,
      name: skill.name,
      scope: "this-mac",
      description: skill.description,
      hint: firstSentence(skill.description),
      notes: skillNotes(skill),
      claude: skill.claude,
      codex: skill.codex,
      // ADR 0005: Ply lists and opens them, and never writes there.
      readOnly: true,
      duplicate,
      drift: null,
      transient: null,
      // The one action, whichever else is true: Promote asks where in its flow.
      // Cold read 2026-10-19: with a team it is `Share with Team…`, drawn on
      // hover or focus only — the section's lead says where it is.
      // (Challenger) A team this Mac can't write: `Share…`, its flow offers
      // the repository and says why Team is off. So does a team that already
      // has these files, and a copy that differs is named for what it'd do.
      action: personalAction(input, skill.name, teamCopy, alsoIn),
      teamCopy,
      alsoIn,
      shareToTeam: !input.solo && input.canPromote && teamCopy !== "same",
      actionOnHover: !input.solo,
      menu: skillMenu({
        scope: "this-mac",
        readOnly: true,
        // Its action is Promote, so a duplicate's chip would have nothing
        // behind it without this (review 1).
        compare: duplicate !== null,
        // GH #142: it opens in Code, and Code cannot save it. A save here would
        // write under `~/.claude/skills`, which ADR 0005 forbids — so what was
        // taken away is the save, not the reading.
        hasFile: true,
        shared: input.shared,
        branch: input.branch,
        branchWritable: false,
        inCheckout: false,
        onBranch: false,
        canPromote: input.canPromote,
      }),
      openInCode: false,
      dir: skill.dir,
      fromMirror: false,
      plugin: null,
      ply: null,
      };
    })
    .sort(byNameAsc);
}

/** The copy button of a team row, in the Project panel's own words. */
function installAction(state: CopyState, name: string): SkillAction | null {
  const copy = copyAction("install", state, name);
  if (copy.done) return null;
  return {
    id: "install",
    label: copy.label,
    ...(copy.confirm ? { confirm: true as const } : {}),
  };
}

export function plyRows(input: SkillsInput, duplicates: Map<string, Scope[]>): SkillRow[] {
  return input.ply
    .map((skill): SkillRow => ({
      key: `ply:${skill.name}`,
      name: skill.name,
      scope: "ply",
      description: skill.description,
      // Skills hub H9 (R9 AC): `v1.167.0 · Changed in 1.167.0: …`.
      hint: plyRowHint(firstSentence(skill.description), skill.changes),
      // …and, when a level above this Mac decides, which one.
      notes: [plyRowNote(skill.name, skill.switch ?? null, input.plyPlace), plyMacSwitchNote(skill.switch)].filter(
        (n): n is string => n !== null,
      ),
      claude: skill.claude,
      codex: skill.codex,
      readOnly: true,
      duplicate: duplicateOf(duplicates, skill.name, "ply"),
      drift: null,
      transient: null,
      action: null,
      menu: [],
      // The bundle is the app's; Code would offer to save into it (ADR 0005).
      // The page reads the text out of `dir` and says it cannot be edited.
      //
      // GH #142 leaves it there deliberately: BOARDS.md §6 gives a Ply skill's
      // page the switch, the rendered text and `Details` and no file list at all
      // ("there is nothing to open — the one file is the app's"), so there is no
      // row here for a reading view to hang off. `skillFileMode` answers for the
      // scope all the same, because the rule is about scopes and not about which
      // of them happens to draw a row today.
      openInCode: false,
      dir: skill.dir,
      fromMirror: false,
      // The plugin these skills arrive inside, so a duplicate's sentence can say
      // what a session really calls this copy — `ply:card-brief`, not
      // `card-brief` (review 1). `skill_history` answers `ply` with every field
      // empty whatever it is passed, so this gives it nothing new to read.
      plugin: PLY_PLUGIN,
      ply: {
        title: skill.title,
        on: skill.on,
        changes: skill.changes ?? [],
        switch: skill.switch ?? null,
        place: input.plyPlace ?? null,
      },
    }))
    .sort(byNameAsc);
}

/** Every row, grouped by scope, in the board's section order. */
export function skillSections(input: SkillsInput): { scope: Scope; rows: SkillRow[] }[] {
  const duplicates = reachingDuplicates(crossScopeDuplicates(input), input.ply);
  const rows: Record<Scope, SkillRow[]> = {
    repository: repositoryRows(input, duplicates),
    team: teamRows(input, duplicates),
    ply: plyRows(input, duplicates),
    "this-mac": personalRows(input, duplicates),
  };
  const offer = (list: SkillRow[]) => (input.copyTo ? list.map(withCopyTo) : list);
  return SKILL_SCOPES.map((scope) => ({ scope, rows: offer(rows[scope]) }));
}

/** Skills hub H8: `Copy to…` on the rows it can copy — a repository copy in
 *  this checkout (not one only the branch has), a team skill whose files are
 *  read, and this Mac's own — before the menu's dangerous entries. Plyloft's
 *  own skills are Personalize's (H9). */
// 1.174.0 E11 (P42, G11): named for what it does, not "Copy to…".
export const COPY_TO_LABEL = "Add to other projects…";
export function copyToOffered(row: Pick<SkillRow, "scope" | "dir" | "fromMirror" | "name">): boolean {
  if (!row.dir) return false;
  if (row.scope === "repository") return !row.fromMirror;
  return row.scope === "team" || row.scope === "this-mac";
}

export function withCopyTo(row: SkillRow): SkillRow {
  if (!copyToOffered(row) || row.menu.some((e) => e !== "divider" && e.id === "copy-to")) return row;
  const entry: SkillMenuEntry = { id: "copy-to", label: COPY_TO_LABEL };
  const at = row.menu.findIndex((e) => e === "divider" || "danger" in e);
  const menu = at < 0 ? [...row.menu, entry] : [...row.menu.slice(0, at), entry, ...row.menu.slice(at)];
  return { ...row, menu };
}

// ── The filter ───────────────────────────────────────────────────────────

/**
 * Name or description, across every scope (the board's field says so).
 *
 * Case-insensitive, matched on the whole description rather than the first
 * sentence: a member who remembers a word from the second sentence of a skill
 * should find it, and the hint is a shortening for reading, not the content.
 */
export function filterSkillRows(rows: readonly SkillRow[], query: string): SkillRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter(
    (row) =>
      row.name.toLowerCase().includes(q) ||
      row.description.toLowerCase().includes(q) ||
      // GH #106: a Ply skill's row shows its plain name, so that is the name a
      // member types. Its directory still matches too — the field says "by name
      // or description", and a skill has both names.
      (row.ply?.title.toLowerCase().includes(q) ?? false),
  );
}

/** The count a scope's nav entry and the narrow select show. `mine` is My
 *  library's (X3), which is read from All skills' index, not the sections. */
export function scopeCounts(
  sections: { scope: Scope; rows: SkillRow[] }[],
  mine = 0,
): Record<ScopeFilter, number> {
  const counts = {
    all: mine,
    repository: 0,
    team: 0,
    "my-library": mine,
    ply: 0,
    "this-mac": 0,
  } as Record<ScopeFilter, number>;
  for (const section of sections) {
    counts[section.scope] = section.rows.length;
    counts.all += section.rows.length;
  }
  return counts;
}

// ── GH #105: reaching both CLIs, and keeping the two copies aligned ──────

/** The row's `⋯` and the skill's page (BOARDS.md §3–§4), word for word. */
export const MAKE_BOTH_LABEL = "Make available to both";
/** The section line's button, which #96 left for this card. */
export const MAKE_ALL_BOTH_LABEL = "Make all available to both";
/** Choose which of two copies that disagree wins. */
export const ALIGN_LABEL = "Align";
/**
 * The comparison of the branch's two copies.
 *
 * Not `Compare`: a duplicated name's `Compare` may be in the same `⋯`, and two
 * entries reading `Compare` would be two different pairs of files under one word.
 */
export const COMPARE_REACH_LABEL = "Compare Claude and Codex";
/** The row's chip when the branch's two copies are not the same files. */
export const DIFFERS_CHIP = "Differs between Claude and Codex";

// ── Skills hub H5 (R12): the two copies, by card ─────────────────────────

/** The row's action when both copies changed: Align asks which wins. */
const ALIGN_ACTION: SkillAction = { id: "align", label: ALIGN_LABEL };

/** R12: the row's words when both copies changed (or there is no record). */
export const TWINS_DIFFER_LINE = "Claude and Codex copies differ";

/** The row's words while one copy waits to follow the other. */
export function twinsFollowLine(winner: "claude" | "codex"): string {
  return winner === "claude"
    ? "The Codex copy gets the Claude copy's changes when the next card ships"
    : "The Claude copy gets the Codex copy's changes when the next card ships";
}

/** R12 AC: the legacy Codex folder disagrees; Plyloft never writes it. */
export function legacyTwinLine(name: string): string {
  return `.codex/skills/${name} is an old copy from before Plyloft managed skills; Plyloft no longer updates it. Remove it in a card.`;
}

/** The two copies differ only in the checkout: no card can carry an Align. */
export const UNCOMMITTED_TWINS_LINE =
  "The two copies differ only in your project folder. Ship it with a card first, then Align.";

/** A card already carries the skill (one card per skill): the Align waits
 *  for it — or is that card. */
export function twinsWaitLine(name: string, card: Pick<KanbanCard, "title" | "kind">): string {
  return card.kind?.verb === "align"
    ? `The two copies are aligned once the card "${card.title}" ships.`
    : `The card "${card.title}" already changes ${name}. Ship it or delete it, then Align.`;
}

/** The words of a refusal that waits for an Align
 *  (`skills_hub_decisions::ALIGN_FIRST_MARKER`): its toast offers Align. */
export const ALIGN_FIRST_MARKER = "Align them first";

/** Skills hub H4 Challenger step 13: the words a share git couldn't sign in
 *  for begins its cause with (`team::SIGN_IN_MARKER`); its toast offers
 *  "Sign in to GitHub". Git over SSH says otherwise and gets no such action:
 *  signing gh in doesn't fix an SSH key. */
export const SIGN_IN_MARKER = "GitHub isn't signed in on ";

export function isSignInRefusal(message: string): boolean {
  return message.includes(SIGN_IN_MARKER);
}

export function isAlignFirst(message: string): boolean {
  return message.includes(ALIGN_FIRST_MARKER);
}

/**
 * Align is offered by card (R12): the two copies follow or differ, the
 * difference is committed (a card is cut from the branch), git carries both
 * copies (GH #215: a folder git ignores says so instead), and no card already
 * carries this skill.
 */
export function twinAlignable(
  twin: SkillTwinRow | null,
  ignoredRoots: string[],
  onItsWay: KanbanCard | null,
): boolean {
  if (!twin || onItsWay || !twin.committed || ignoredRoots.length > 0) return false;
  return twin.twins.state === "follows" || twin.twins.state === "differ";
}

/** The sentences a row adds about its two copies. */
export function twinNotes(
  twin: SkillTwinRow | null,
  name: string,
  ignoredRoots: string[],
  onItsWay: KanbanCard | null,
): string[] {
  if (!twin) return [];
  const notes: string[] = [];
  const state = twin.twins;
  if (state.state === "follows") notes.push(twin.line || twinsFollowLine(state.winner));
  else if (state.state === "differ") notes.push(twin.line || TWINS_DIFFER_LINE);
  if (
    (state.state === "follows" || state.state === "differ") &&
    !twin.committed &&
    !onItsWay &&
    ignoredRoots.length === 0
  ) {
    notes.push(UNCOMMITTED_TWINS_LINE);
  }
  // Challenger (H5 Mac re-walk): one card per skill, so a card already
  // carrying this one holds the Align back — said, never left silent.
  if ((state.state === "follows" || state.state === "differ") && onItsWay) {
    notes.push(twinsWaitLine(name, onItsWay));
  }
  if (twin.legacy) notes.push(legacyTwinLine(name));
  return notes;
}

/** What the drift is, in one sentence, for the page's notice. */
export function driftSentence(name: string, branch: string | null): string {
  const where = branch ?? BRANCH_FALLBACK;
  return (
    `Claude's copy of ${name} on ${where} and Codex's are not the same file. ` +
    "Both reach the agents, and they say different things — Align makes one of " +
    "them the copy Claude and Codex both get."
  );
}

/**
 * The skills the section's `Make all available to both` sends — **all** of them.
 *
 * Review 1 (MINOR): this used to send only the rows whose own `⋯` offers the
 * copy, so a button that said `all` quietly left out the ones that are not on the
 * branch yet. Every name goes, and the backend's own reason for each ("`x` is not
 * on staging yet — publish it there first", a disagreement, a copy no CLI loads)
 * comes back and is named in the toast.
 *
 * `[]` — no button at all — when **no** row offers the copy: that is what a
 * read-only collaborator sees, and what a section whose skills already reach both
 * sees. The gate is still the rows' own menus, so there is one rule about who may
 * write the branch and not a second copy of it here.
 */
/**
 * Skills hub H3b (R-M): the skills the repository section's **Link all**
 * sends — every row whose own action is **Link**. `[]` with fewer than two:
 * one copy's Link is its row's button, and a second button doing the same
 * press would be noise.
 */
export function linkAll(rows: readonly SkillRow[]): string[] {
  const names = rows.filter((row) => row.action?.id === "link").map((row) => row.name);
  return names.length >= 2 ? names : [];
}

export function makeAllBoth(rows: readonly SkillRow[]): string[] {
  const offered = rows.some((row) =>
    row.menu.some((entry) => entry !== "divider" && entry.id === "make-available-to-both"),
  );
  return offered ? rows.map((row) => row.name) : [];
}

/**
 * The line under `In this repository`, once: `All 34 reach Claude only.`
 *
 * Only when every one of them reaches exactly one CLI and it is the same CLI —
 * which is the state the sentence describes, and the state `Make all available to
 * both` offers to fix. `null` for a mixed section, which needs per-row chips
 * rather than a sentence, and for an empty one.
 */
export function oneCliLine(rows: readonly SkillRow[]): string | null {
  if (rows.length === 0) return null;
  const claudeOnly = rows.every((r) => r.claude && !r.codex);
  if (claudeOnly) return `All ${rows.length} reach Claude only.`;
  const codexOnly = rows.every((r) => r.codex && !r.claude);
  if (codexOnly) return `All ${rows.length} reach Codex only.`;
  return null;
}

// ── Compare: the two SKILL.md, side by side ──────────────────────────────

/** One column's mark. `""` is an identical line: the column has nothing to say. */
export type CompareMark = "≠" | "+" | "−" | "";

/**
 * What a column draws. A column never draws `−`: the side that lacks a line is
 * a neutral blank, not a removed line (owner, 2026-10-20).
 */
export type ColumnMark = Exclude<CompareMark, "−">;

/**
 * What each mark a column draws means, for a reader who cannot see the bar or
 * the shading.
 *
 * Here rather than in the component because it is half of a contract: the glyph
 * and the word have to agree, and the test that they do reads this. There is no
 * `−` entry because no column draws one: the blank opposite a one-sided line is
 * left out of the reading altogether.
 */
export const MARK_LABEL: Record<Exclude<ColumnMark, "">, string> = {
  "≠": "changed",
  "+": "only here",
};

/** One line of a side-by-side comparison, with the mark each column draws. */
export interface ComparedLine {
  /** 1-based, or null where that side has nothing. */
  leftNo: number | null;
  rightNo: number | null;
  left: string | null;
  right: string | null;
  /**
   * The pair's own mark, for counting the differences: `≠` changed · `+` only on
   * the left · `−` only on the right · `""` the same. **Not** what a column draws.
   */
  mark: CompareMark;
  /**
   * What each column draws, which is not the same glyph on both sides.
   *
   * BOARDS.md §4: "`≠` changed, `+` only here; the other side of a one-sided
   * line is a neutral blank." A line that exists on one side only is therefore
   * `+` where the text is and `""` on the other side — no `−`, no
   * `(nothing here)`, no shading: a pure addition opposite a phantom "removed"
   * row read as a deletion that never happened (owner, 2026-10-20). One mark
   * rendered in both columns made the empty column announce "only here"
   * (review 1, MAJOR), so the marks stay per column.
   */
  leftMark: ColumnMark;
  rightMark: ColumnMark;
}

/**
 * The two texts lined up, one row per line, with the mark the board draws.
 *
 * A plain positional walk, not a diff: the two copies of one skill are a
 * version and its edit, so line *n* against line *n* is what a reader
 * compares, and an alignment algorithm would move lines around for no gain
 * that Board 3's redesign will not revisit.
 */
export function compareSkillText(left: string, right: string): ComparedLine[] {
  const a = left.replace(/\n$/, "").split("\n");
  const b = right.replace(/\n$/, "").split("\n");
  const out: ComparedLine[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const l = i < a.length ? a[i] : null;
    const r = i < b.length ? b[i] : null;
    // The pair's mark counts the difference; each column's mark describes what
    // that column is showing. They differ for a one-sided line, and that is the
    // whole point: `+` sits with the text, the other column is blank.
    const mark: CompareMark = l === null ? "−" : r === null ? "+" : l === r ? "" : "≠";
    const column: ColumnMark = mark === "≠" ? "≠" : "";
    out.push({
      leftNo: l === null ? null : i + 1,
      rightNo: r === null ? null : i + 1,
      left: l,
      right: r,
      mark,
      leftMark: l === null ? "" : r === null ? "+" : column,
      rightMark: r === null ? "" : l === null ? "+" : column,
    });
  }
  return out;
}

/**
 * The `SKILL.md` as reading text: its frontmatter taken off.
 *
 * BOARDS.md §4: `What it tells the agent` is "the `SKILL.md` **rendered as
 * reading text**, frontmatter hidden, never a code block". The frontmatter is
 * the CLIs' own metadata — the name and the description the page has already
 * said in its header — and rendered as markdown it comes out as a horizontal
 * rule with a stray `description:` line under it.
 *
 * Only a block that opens on the **first** line is taken: a `---` further down
 * is a horizontal rule the author wrote, and a file whose block never closes is
 * left whole rather than swallowed to nothing.
 */
export function skillBody(text: string): string {
  // A leading BOM or blank line still counts as the top of the file: both CLIs'
  // readers tolerate them, so a body Ply showed with its frontmatter visible
  // would disagree with what the agent is given.
  const start = text.replace(/^﻿/, "").replace(/^[ \t]*\r?\n/, "");
  if (!/^---[ \t]*\r?\n/.test(start)) return text;
  const close = /\r?\n---[ \t]*(\r?\n|$)/.exec(start);
  if (!close) return text;
  return start.slice(close.index + close[0].length).replace(/^\s*\r?\n/, "");
}

/**
 * The sentence under a comparison, saying the differences in words.
 *
 * The two sides are named by **where they live**, not "left" and "right": under
 * 760 px of column the groups stack, so there is no left and no right, and
 * "only on the left" beside a column of "only here" marks was two vocabularies
 * for one fact (review 1). `here` and `there` are `SCOPE_PLACE` phrases — `in this
 * repository`, `in the team library`, `on this Mac` — so the preposition comes
 * with the place.
 */
export function compareSummary(
  lines: readonly ComparedLine[],
  here: string,
  there: string,
): string {
  const changed = lines.filter((l) => l.mark === "≠").length;
  const onlyHere = lines.filter((l) => l.mark === "+").length;
  const onlyThere = lines.filter((l) => l.mark === "−").length;
  if (changed === 0 && onlyHere === 0 && onlyThere === 0) {
    return "The two are the same file.";
  }
  const parts: string[] = [];
  const n = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
  if (changed) {
    parts.push(`${n(changed, "line", "lines")} ${changed === 1 ? "says" : "say"} something different`);
  }
  if (onlyHere) parts.push(`${n(onlyHere, "line", "lines")} only ${here}`);
  if (onlyThere) parts.push(`${n(onlyThere, "line", "lines")} only ${there}`);
  return `${parts.join(", ")}.`;
}

// ── A skill's own page (Board 3, GH #100) ────────────────────────────────
//
// The page is Board 3 as corrected: the header's fact line, one primary action
// and the `⋯`, the duplicate notice with no winner, Compare underneath, the
// files, the rendered text and `Details`. All of it decided here, for the reason
// the list's rows are: which action a scope offers, what may be said about a
// skill and what must be left unsaid are rules about the product.
//
// The rule that shapes most of it: **nothing is invented**. A fact Ply has not
// read is absent from the line rather than guessed at — `Last changed by …`
// needs the branch history, and a scope with no repository behind it has none.

/** Which CLIs a skill reaches, as the fact line's chip. `null` for neither. */
export function reachWords(claude: boolean, codex: boolean): string | null {
  if (claude && codex) return "Reaches Claude and Codex";
  if (claude) return "Reaches Claude only";
  if (codex) return "Reaches Codex only";
  // Ply lists it off the branch and neither CLI root here holds it: the page
  // says nothing rather than claiming it reaches nobody.
  return null;
}

/** `1 file` · `3 files` — the fact line's last item. */
export function fileCountWords(files: number): string {
  return files === 1 ? "1 file" : `${files} files`;
}

// ── A skill's files, as far as its page lists them ────────────────────────

/** How deep under the skill's own folder the list goes (`scripts/lib/x.sh` is 2). */
export const LISTED_DEPTH = 4;
/** How many files the list holds before it says there are more. */
export const LISTED_FILES = 200;
/** How many folders under the skill it opens. */
export const LISTED_FOLDERS = 50;

/** What kept a skill page's file list from being the whole tree. */
export interface FileListCut {
  /** It reached `LISTED_FILES`. */
  files: boolean;
  /** A folder sat deeper than `LISTED_DEPTH`. */
  depth: boolean;
  /** There were more than `LISTED_FOLDERS` folders. */
  folders: boolean;
  /** Folders Plyloft could not list. */
  unreadable: number;
  /** Symlinks left out: `project_skills::read_tree` refuses them, so they are
   *  not files a copy carries — and one makes the copy refuse. */
  links: number;
}

export const NO_CUT: FileListCut = { files: false, depth: false, folders: false, unreadable: 0, links: 0 };

/** The count is a floor: files exist that the list did not reach. A symlink
 *  does not make it one — it is not a file that travels. */
export function fileListShort(cut: FileListCut): boolean {
  return cut.files || cut.depth || cut.folders || cut.unreadable > 0;
}

/** The line above `Its files`, naming only what applied; `null` for a whole list. */
export function fileListCutLine(cut: FileListCut): string | null {
  const why: string[] = [];
  if (cut.files) why.push(`the list stops at ${LISTED_FILES} files`);
  if (cut.depth) why.push(`it goes ${LISTED_DEPTH} folders deep`);
  if (cut.folders) why.push(`it opens at most ${LISTED_FOLDERS} folders`);
  if (cut.unreadable > 0) {
    why.push(`Plyloft couldn't read ${cut.unreadable === 1 ? "1 folder" : `${cut.unreadable} folders`}`);
  }
  const parts: string[] = [];
  if (why.length > 0) parts.push(`Not every file is listed: ${why.join("; ")}.`);
  if (cut.links > 0) {
    const one = cut.links === 1;
    parts.push(
      `${one ? "1 symlink is" : `${cut.links} symlinks are`} left out — Plyloft won't ` +
        `copy a skill that holds ${one ? "one" : "them"}.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/** …and `200+ files` when the listing stopped before the end of the tree. */
function filesWords(files: number, more: boolean | undefined): string {
  return more ? `${files}+ files` : fileCountWords(files);
}

/**
 * How long ago a change landed, in the board's words (`7 weeks ago`).
 *
 * Not `definitionRefresh.ago`, which mirrors `shared_config::ago` word for word
 * and stops at days: a skill's last change is routinely months old (the owner's
 * repository had skills last touched in July), and `52 days ago` is a number a
 * reader has to divide. Weeks up to eight, then months, then years.
 *
 * Not `sharedLibrary.agoWords` either (GH #144), which says the near units in
 * full because §3 puts the age inside a sentence. See its own comment.
 */
export function changedAgo(nowMs: number, atSecs: number): string {
  const secs = Math.max(0, Math.floor(nowMs / 1000 - atSecs));
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)} h ago`;
  const days = Math.floor(secs / 86_400);
  if (days < 7) return plural(days, "day");
  if (days < 56) return plural(Math.floor(days / 7), "week");
  if (days < 365) return plural(Math.floor(days / 30), "month");
  return plural(Math.floor(days / 365), "year");
}

/** The last change to a skill, as `skill_history::SkillHistory` reports it. */
export interface SkillHistoryFacts {
  /** The branch it was read from, for `Details`. */
  gitRef: string | null;
  author: string | null;
  /** Epoch **seconds** (git's own unit). */
  at: number | null;
  /** The abbreviated commit id. */
  commit: string | null;
}

/**
 * `Last changed by MatteoB-adv 7 weeks ago` — or the half of it Ply has, or
 * nothing.
 *
 * Each part is dropped on its own: a commit git has no author name for still
 * has a date, and a skill that has never been committed has neither. `null`
 * takes the item out of the fact line rather than leaving `Last changed by  `.
 */
export function lastChangedWords(
  history: SkillHistoryFacts | null,
  nowMs: number,
): string | null {
  if (!history) return null;
  const { author, at } = history;
  if (author && at != null) return `Last changed by ${author} ${changedAgo(nowMs, at)}`;
  if (author) return `Last changed by ${author}`;
  if (at != null) return `Last changed ${changedAgo(nowMs, at)}`;
  return null;
}

/** `2026-07-30 14:12`, local — the last item of the `Details` line. */
export function detailsStamp(atSecs: number): string {
  const at = new Date(atSecs * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/**
 * `staging · a3f9c21 · MatteoB-adv · 2026-07-30 14:12` (BOARDS.md §4).
 *
 * The parts Ply has, in that order; `null` when it has none. The branch alone is
 * worth printing: it says where Ply looked, which is the first thing to check
 * when the rest is empty.
 */
export function detailsHistoryLine(history: SkillHistoryFacts | null): string | null {
  if (!history) return null;
  const parts = [
    history.gitRef,
    history.commit,
    history.author,
    history.at != null ? detailsStamp(history.at) : null,
  ].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Where a scope's copy lives, in the words a sentence can hold. */
export const SCOPE_PLACE: Record<Scope, string> = {
  repository: "in this repository",
  team: "in the team library",
  ply: "in Plyloft",
  "this-mac": machineWords("on this Mac"),
};

/** Whose copy it is, for the duplicate sentence. */
const SCOPE_POSSESSIVE: Record<Scope, string> = {
  repository: "the repository's",
  team: "the team's",
  ply: "Plyloft's",
  "this-mac": machineWords("this Mac's"),
};

/**
 * The true sentence under the duplicate notice.
 *
 * BOARDS.md §4, corrected 2026-09-17: **nothing wins**, so the sentence states
 * how each copy reaches the agents rather than which one is used. The board
 * draws the Team case and gives its words exactly — `Both reach the agents: this
 * one as deploy, the team's as team:deploy.` — because a team skill arrives
 * inside a plugin and is called `<plugin>:<name>` there.
 *
 * The other pairs (a repository skill and a personal one of the same name) are
 * not drawn. Both copies are called `<name>`, so the sentence says that and
 * where each lives, and claims nothing about which one a CLI picks: that is the
 * CLI's own order, and Ply asserting it would be Ply guessing.
 *
 * GH #106 review 1: the qualified branches are about **whichever side arrives
 * inside a plugin**, not about Team. A skill that comes with Ply arrives inside
 * the `ply` plugin and a session really calls it `ply:card-brief`, so the generic
 * sentence — "both are called card-brief" — was false for a repository/Ply pair.
 * Both sides may arrive in a plugin (a team skill and a Ply skill of one name),
 * and then both names are qualified.
 */
export function duplicateSentence(
  name: string,
  here: Scope,
  there: Scope,
  /**
   * The plugin each side arrives inside, when Ply knows it. `null` for a side
   * that arrives in no plugin at all (a repository or personal copy) *and* for a
   * side that does but whose plugin Ply could not read — the branch is chosen by
   * the scope, so an unknown plugin says the name plainly rather than guessing a
   * prefix.
   */
  plugins: { here: string | null; there: string | null },
): string {
  const qualify = (plugin: string | null) => (plugin ? `${plugin}:${name}` : name);
  const hereInPlugin = SCOPES_IN_A_PLUGIN.includes(here);
  const thereInPlugin = SCOPES_IN_A_PLUGIN.includes(there);
  if (thereInPlugin && !hereInPlugin) {
    return (
      `Both reach the agents: this one as ${name}, ` +
      `${SCOPE_POSSESSIVE[there]} as ${qualify(plugins.there)}.`
    );
  }
  if (hereInPlugin && !thereInPlugin) {
    return (
      `Both reach the agents: this one as ${qualify(plugins.here)}, ` +
      `${SCOPE_POSSESSIVE[there]} as ${name}.`
    );
  }
  if (hereInPlugin && thereInPlugin) {
    return (
      `Both reach the agents: this one as ${qualify(plugins.here)}, ` +
      `${SCOPE_POSSESSIVE[there]} as ${qualify(plugins.there)}.`
    );
  }
  return (
    `Both reach the agents, and both are called ${name}: this one ` +
    `${SCOPE_PLACE[here]}, the other ${SCOPE_PLACE[there]}.`
  );
}

/**
 * The scopes whose skills arrive inside a plugin, so the CLIs call them
 * `<plugin>:<name>`: the team library's (`team_skills`) and Ply's own
 * (`ply_skills`). A repository copy and a personal one are read from a skills
 * root and keep their bare name.
 */
const SCOPES_IN_A_PLUGIN: readonly Scope[] = ["team", "ply"];

/**
 * The one primary action of a skill's page.
 *
 * `open-pull-request` and `keep-on-this-mac` come from a transient state, and
 * they outrank `Edit in Code`: what is happening to a skill right now, and the
 * one decision it is waiting on, is not something to bury in a `⋯` under a button
 * about editing (review 1). `Open in Code` stays in the menu in that case.
 */
export type SkillPageAction =
  | { id: "edit-in-code"; label: string }
  | { id: "open-pull-request"; label: string }
  | { id: "keep-on-this-mac"; label: string }
  | { id: "promote"; label: string }
  | { id: "install"; label: string; confirm?: true }
  | { id: "review-scripts"; label: string }
  /** H8 (Mac re-walk): a linked copy's Update, on its page as on its row. */
  | { id: "update"; label: string };

/** The words the board gives the group of the copy whose page this is. */
export const COMPARE_THIS_SIDE = "in use here";
/** Walk follow-ups 2026-10-19: the same side when it isn't what Promote
 *  shares (`SkillRow.promoteShares`): the working copy, as the file is. */
export const COMPARE_CHECKOUT_SIDE = "your project folder's copy";

/** One action under Compare (BOARDS.md §4). */
export type CompareAction =
  | { id: "keep-both"; label: string }
  /** GH #105: under the comparison of the branch's two copies — choose which
   *  one wins. It opens a flow, because the choice is the question. */
  | { id: "align"; label: string }
  | { id: "remove-from-branch"; label: string; danger: true }
  | { id: "promote-to-team"; label: string; confirm?: true }
  | { id: "promote"; label: string }
  | { id: "install"; label: string; confirm?: true };

/** What the page knows beyond the row. Each part is absent until Ply has it. */
export interface SkillPageInput {
  row: SkillRow;
  /** A personal skill: All skills' *Used in* line, when a repository has it. */
  usedIn?: string | null;
  /** Files in its directory, every folder under it included (a copy carries
   *  the whole tree); `null` while unread or unreadable. */
  files: number | null;
  /** The listing stopped at its bound, so `files` is a lower bound. */
  filesMore?: boolean;
  /** Its last change on the branch; `null` for a scope with no history. */
  history: SkillHistoryFacts | null;
  /**
   * The plugin the **other** side of a duplicate arrives inside, when Ply knows
   * it. This side's own is on the row (`row.plugin`), so each side's name is
   * qualified from its own fact rather than from one field standing in for two
   * (review 1).
   */
  plugin: string | null;
  /** `Keep both` has silenced the duplicate notice on this Mac. */
  silenced: boolean;
  /** GH #105: the integration branch, for the drift notice's sentence. */
  branch?: string | null;
  /**
   * The two copies of a duplicated name, as far as Ply has got with them:
   * `pending` while it has not answered, `read` once both are in hand, `missing`
   * when it has answered and one of them cannot be read.
   *
   * It gates the notice, because the notice's own action needs both: the mute is
   * keyed by the two content ids, so with one copy missing Ply cannot tell whether
   * `Keep both` still holds. Showing the notice then offered a `Compare` with
   * nothing behind it and a `Keep both` that could not be pressed (review 1);
   * `duplicateUnknown` says so in words instead. Irrelevant, and ignored, for a
   * row with no duplicate.
   */
  copies: "pending" | "read" | "missing";
  /** Now, in ms, for the age. */
  nowMs: number;
  /** Walk F5: solo mode — no team library, so no sentence names one. */
  solo?: boolean;
}

export interface SkillPageModel {
  /** The fact line's chip: which CLIs it reaches. */
  reach: string | null;
  /** The rest of the fact line, in the board's order. Only facts Ply has. */
  facts: string[];
  /** One sentence under the header, with an empty dot. */
  status: string | null;
  /**
   * What is happening to it right now, as the row's hint says it, with the state
   * its dot takes (BOARDS.md §3 "Transient states"). The page said nothing about
   * this at all before review 1.
   */
  transient: { line: string; state: "running" | "aborted" | "empty" } | null;
  /** The one primary action, or none. */
  primary: SkillPageAction | null;
  /** The sentence beside it (state D). */
  beside: string | null;
  /** The `⋯`: the row's menu, less what the page shows as a button. */
  menu: SkillMenuEntry[];
  /** The duplicate notice: absent with no duplicate, when silenced here, and
   *  when Ply could not read both copies (`duplicateUnknown` says so instead). */
  notice: { chip: string; sentence: string } | null;
  /** Why there is no notice although the name exists at two scopes. */
  duplicateUnknown: string | null;
  /**
   * GH #105: the branch's own two copies disagree. Its `Compare` is a different
   * pair of files from the duplicate notice's, and both notices can be on one
   * page — a duplicated name whose repository copies have also drifted is two
   * facts, and each says its own thing.
   */
  reachNotice: { chip: string; sentence: string } | null;
  /** The last line of the rendered text (state D). */
  readingFooter: string | null;
  /** The `Details` line, under the path. */
  detailsLine: string | null;
  /** `Details` offers `Reveal in Finder` (a personal skill, whose file is
   *  reached the way the board reaches it — from this Mac). */
  reveal: boolean;
}

/** The board's state-D status line, word for word. */
export const PERSONAL_STATUS =
  "Plyloft reads it but does not change it. Share it to put it in the team " +
  "library or in this repository, where others get it too.";

/** Walk F5: the same line in solo mode, which has no team library to name
 *  (§10: no team surface is drawn). */
export const PERSONAL_STATUS_SOLO =
  "Plyloft reads it but does not change it. Promote it to put it in this " +
  "repository, where others get it too.";

/** Already in the team library, with the same files. */
const PERSONAL_STATUS_TO_REPOSITORY =
  "Plyloft reads it but does not change it. Share it to put it in this " +
  "repository, where others get it too.";
/** Already in this repository. */
const PERSONAL_STATUS_TO_TEAM =
  "Plyloft reads it but does not change it. Share it to put it in the team " +
  "library, where others get it too.";
/** Everywhere a share could put it. */
const PERSONAL_STATUS_NOWHERE = "Plyloft reads it but does not change it.";

/**
 * A personal skill's status line, naming only the places a share could still
 * put it: the team only for someone who can write it (not solo, not Free or
 * read-only) and while it hasn't these very files.
 */
export function personalStatus(row: Pick<SkillRow, "alsoIn" | "shareToTeam">, solo: boolean | undefined): string {
  const repository = row.alsoIn?.includes("repository") ?? false;
  const team = row.shareToTeam ?? false;
  if (repository) return team ? PERSONAL_STATUS_TO_TEAM : PERSONAL_STATUS_NOWHERE;
  if (solo) return PERSONAL_STATUS_SOLO;
  return team ? PERSONAL_STATUS : PERSONAL_STATUS_TO_REPOSITORY;
}

/**
 * The sentence beside a personal skill's one action (state D, **as corrected**).
 *
 * The board's "Nothing else can be done from here" predates GH #142, which gave
 * the `⋯` an `Open in Code` — as a reading view, because a save would write
 * under `~/.claude/skills` (ADR 0005). The sentence says that instead.
 */
export const PERSONAL_BESIDE =
  "Code opens it read-only — Plyloft never changes your own skills folder.";

/**
 * The last line of a personal skill's rendered text (state D, as corrected):
 * "open the file on this Mac" read as "Open in Code", which cannot save it. The
 * way to change it is outside Plyloft, and `Details` holds the way there.
 */
export const PERSONAL_READING_FOOTER =
  `Read-only in Plyloft: to change it, edit the file in your own editor — ` +
  `${platformWord("reveal")} is under Details.`;

/** What the page says about a copy Ply reads out of its own mirror. */
export const MIRROR_STATUS =
  "This copy is the one on the integration branch. Your project folder has none, so " +
  "there is nothing here to edit — read it below.";

/**
 * Ply's own skills are the app's. Cold read 2026-10-19: what a session gets,
 * not "switched on per Mac" — a launch hands the switched-on ones to Claude
 * (`--plugin-dir`) and to Codex (the `CODEX_HOME` overlay), `ply_skills.rs`.
 */
export const PLY_STATUS = "Comes with Plyloft · every Claude and Codex tile, card and run Plyloft opens gets it.";

/** The status of one Ply skill: by the CLIs it reaches, or switched off here. */
export function plyStatus(claude: boolean, codex: boolean, on: boolean): string {
  if (!on) return machineWords("Comes with Plyloft · switched off on this Mac, so no tile, card or run gets it.");
  if (claude && codex) return PLY_STATUS;
  if (claude) return "Comes with Plyloft · every Claude tile, card and run Plyloft opens gets it.";
  if (codex) return "Comes with Plyloft · every Codex tile, card and run Plyloft opens gets it.";
  return "Comes with Plyloft.";
}

/**
 * GH #106 (BOARDS.md §6, **as corrected**): the last line of a Ply skill's
 * rendered text.
 *
 * Word for word, and the correction is the point: the drawing promised that a
 * copy of your own "will be used instead", and no copy wins over another
 * (ADR 0005). Switching this one off is how to be sure yours is the only one,
 * and that is what the sentence says instead.
 */
export const PLY_READING_FOOTER =
  "This skill comes with Plyloft and can't be edited. To change how it works here, " +
  "Personalize it: your own copy switches this one off where it applies.";

/** The fact beside a Ply skill's two chips (BOARDS.md §6). */
export const PLY_FACT = "Ships with Plyloft";

/**
 * The plugin both CLIs load Ply's own skills as, so a session calls them
 * `ply:card-brief` (`ply_skills::PLUGIN_NAME`).
 *
 * Deliberately not the *marketplace* name Codex registers, which is `ply-app`:
 * the namespace comes from the plugin, and the marketplace is only how Codex is
 * pointed at it (review 1).
 */
export const PLY_PLUGIN = "ply";

/**
 * GH #106 review 1: what the `Comes with Ply` section says when the skills it
 * lists reach no session.
 *
 * The error shape's own order (BOARDS.md §5): what happened, what was left
 * untouched, what to do. Ply's own skills failing to build is a fault in the
 * app, not something a member mis-set, so the last part is honest about that —
 * and the first part matters because every row above it is still drawn and would
 * otherwise imply a delivery that is not happening.
 *
 * Review 2: "what to do" is **reading the section again**, not reopening Ply.
 * The section is re-read every time the page reads its facts, and that read is
 * the retry; telling a member to restart the app would ask for more than the fix
 * needs. The section offers it as its own `Try again` (`PLY_RETRY_LABEL`), so
 * the sentence names the button rather than a walk away from the page and back.
 */
export function plySectionProblem(reason: string): string {
  // The reason comes from Rust, where some are sentences and some are fragments
  // (`… is a symlink`). Ended here, once, so the next sentence never runs into it.
  const said = /[.!?]$/.test(reason.trim()) ? reason.trim() : `${reason.trim()}.`;
  return (
    // 1.174.0 (TX1, T2; WALK 16): the switches stay on — the person's
    // choice — so the sentence names them instead of contradicting them.
    `Your sessions aren't getting these skills right now, even though they're switched on: ${said} ` +
    `Your switches are kept, and your own skills and your team's are unaffected. ` +
    `${PLY_RETRY_LABEL} reads them again; if it keeps happening, it's a bug in Plyloft.`
  );
}

/** The `Comes with Plyloft` section's retry, under its fault. */
export const PLY_RETRY_LABEL = "Try again";


/** Its `On this Mac` group, and the row that holds the switch (BOARDS.md §6). */
export const PLY_SWITCH_GROUP = machineWords("On this Mac");
export const PLY_SWITCH_LABEL = "Use this skill";
export const PLY_SWITCH_HINT = machineWords(
  "Switched on for every workspace on this Mac. Other Macs decide for themselves.",
);

/** Drop a divider that has nothing on one side of it any more. */
function trimDividers(menu: SkillMenuEntry[]): SkillMenuEntry[] {
  const out: SkillMenuEntry[] = [];
  for (const entry of menu) {
    if (entry === "divider" && (out.length === 0 || out[out.length - 1] === "divider")) {
      continue;
    }
    out.push(entry);
  }
  while (out.length > 0 && out[out.length - 1] === "divider") out.pop();
  return out;
}

/** The entry of `menu` with `id`, or null. */
function entryWith(menu: readonly SkillMenuEntry[], id: string): SkillMenuEntry | null {
  for (const entry of menu) {
    if (entry !== "divider" && entry.id === id) return entry;
  }
  return null;
}

/**
 * Board 3's page, for one row.
 *
 * `openInCode` is the **only** thing that decides whether the editor is offered
 * — here as in the `⋯` and in the file rows. GH #96 review 1 found a second
 * derivation on the old sub-page that let `Edit in Code` open the team clone,
 * which `TeamStore::sync` pulls `--ff-only`: one ⌘S there stops every later
 * refresh. One field, three places.
 */
export function skillPage(input: SkillPageInput): SkillPageModel {
  const { row } = input;
  const facts: string[] = [];
  if (row.ply) {
    // GH #106, BOARDS.md §6's fact line: the two chips, then `Ships with Ply`
    // and nothing else. No author, no age and no file count — a skill that comes
    // with the app was not changed by anybody on this Mac, and how many files
    // the app keeps it in is not a fact about the skill.
    facts.push(PLY_FACT);
    // Skills hub H9 (R9): the Plyloft version that last changed it.
    const latest = row.ply.changes?.[0];
    if (latest) facts.push(versionWord(latest.version));
  } else if (row.scope === "this-mac") {
    // State D's fact line: `Reaches Claude only · Yours · not shared with
    // anyone · 1 file`. No author and no age — a personal folder is not a
    // repository, and the board asks for neither.
    // 1.174.2: once a copy of its name is somewhere others get it, that fact
    // instead: All skills' own line, or until the index has read it the row's
    // chip. A copy that comes with Plyloft shares nothing of yours.
    facts.push("Yours");
    const also = [
      ...(row.alsoIn?.includes("repository") && !input.usedIn ? [duplicateChip("repository")] : []),
      ...(row.alsoIn?.includes("team") ? [duplicateChip("team")] : []),
    ];
    if (input.usedIn) facts.push(input.usedIn);
    facts.push(...also);
    if (!input.usedIn && also.length === 0) facts.push("not shared with anyone");
    if (input.files != null) facts.push(filesWords(input.files, input.filesMore));
  } else {
    const changed = lastChangedWords(input.history, input.nowMs);
    if (changed) facts.push(changed);
    if (input.files != null) facts.push(filesWords(input.files, input.filesMore));
  }

  // A transient state's action comes first, exactly as it does on the row: the
  // pull request a change is waiting in, and the copy that is about to be the last
  // one, are what the member is here to decide. `Edit in Code` then keeps its
  // place in the `⋯` under its menu name, so nothing is lost.
  const transientAction =
    row.action?.id === "open-pull-request" ||
    row.action?.id === "keep-on-this-mac" ||
    row.action?.id === "review-scripts" ||
    // H8 (Mac re-walk): a linked copy's Update is the page's action too.
    row.action?.id === "update"
      ? ({ id: row.action.id, label: row.action.label } as SkillPageAction)
      : null;
  const primary: SkillPageAction | null =
    transientAction ??
    (row.openInCode
      ? { id: "edit-in-code", label: "Edit in Code" }
      : row.action?.id === "promote"
        ? { id: "promote", label: row.action.label }
        : row.action?.id === "install"
          ? {
              id: "install",
              label: row.action.label,
              ...(row.action.confirm ? { confirm: true as const } : {}),
            }
          : null);

  // The notice needs both copies: its `Keep both` is keyed by the two content
  // ids, so with one of them missing Ply cannot say whether the pair is still
  // silenced — and a notice whose one action cannot be pressed is worse than a
  // sentence saying why (review 1).
  const notice =
    row.duplicate && !input.silenced && input.copies === "read"
      ? {
          chip: row.duplicate.chip,
          sentence: duplicateSentence(row.name, row.scope, row.duplicate.other, {
            here: row.plugin,
            there: input.plugin,
          }),
        }
      : null;

  const reachNotice = row.drift
    ? { chip: row.drift.chip, sentence: driftSentence(row.name, input.branch ?? null) }
    : null;

  return {
    reach: reachWords(row.claude, row.codex),
    // A notice speaking up carries its own chip: said once.
    facts: notice ? facts.filter((fact) => fact !== notice.chip) : facts,
    status:
      row.scope === "this-mac"
        ? personalStatus(row, input.solo)
        : row.scope === "ply"
          ? plyStatusFor(row.claude, row.codex, row.ply?.switch ?? null, row.ply?.on ?? true, row.name, row.ply?.place)
          : row.fromMirror
            ? MIRROR_STATUS
            : null,
    transient: row.transient
      ? {
          line: row.transient.line,
          state:
            row.transient.kind === "publishing"
              ? "running"
              : row.transient.kind === "pullRequest" ||
                  row.transient.kind === "blocked" ||
                  row.transient.kind === "needsOk"
                ? "aborted"
                : "empty",
        }
      : null,
    primary,
    beside: row.scope === "this-mac" ? PERSONAL_BESIDE : null,
    notice,
    duplicateUnknown:
      row.duplicate && input.copies === "missing"
        ? `The same name is ${SCOPE_PLACE[row.duplicate.other]}, and Plyloft cannot ` +
          "read both copies from here — so it cannot say whether they still match."
        : null,
    // `Open in Code` is dropped only when the page shows `Edit in Code`: it would
    // be the same press twice (PATTERNS.md §3, "one place for actions"). When a
    // transient took the primary, the entry is the only way to the editor and
    // stays.
    //
    // `Compare` is dropped only **while the notice is showing**, because the
    // notice is where it lives. Once `Keep both` has silenced the notice, the
    // `⋯` is the only way left to the comparison — and the row's menu carries it
    // for exactly the same reason.
    reachNotice,
    menu: trimDividers(
      row.menu.filter(
        (entry) =>
          entry === "divider" ||
          ((entry.id !== "open-in-code" || primary?.id !== "edit-in-code") &&
            (entry.id !== "compare" || notice === null) &&
            // Same rule for the drift comparison: while its notice is showing,
            // the notice is where `Compare` lives. `Align` stays in the `⋯`
            // either way — it is a write, not the notice's own action, and the
            // comparison offers it too.
            (entry.id !== "compare-reach" || reachNotice === null)),
      ),
    ),
    readingFooter: row.ply
      ? PLY_READING_FOOTER
      : row.scope === "this-mac"
        ? PERSONAL_READING_FOOTER
        : null,
    detailsLine: detailsHistoryLine(input.history),
    reveal: row.scope === "this-mac" && row.dir !== null,
  };
}

/**
 * The actions under Compare: `Keep both` · `Remove from <branch>` ·
 * `Promote this one to Team` (BOARDS.md §4).
 *
 * Read out of the row's own menu and action rather than decided again, so a
 * scope that may not remove from the branch cannot be offered it here. `Keep
 * both` is always there: it writes nothing but this Mac's own settings.
 *
 * For a **personal** skill the third action is `Promote this one`, not
 * `Promote this one to Team` — its Promote asks where in a flow (this repository
 * or the team library), and naming the destination on the button would name the
 * wrong one half the time.
 */
export function compareActions(row: SkillRow): CompareAction[] {
  const out: CompareAction[] = [{ id: "keep-both", label: "Keep both" }];
  const remove = entryWith(row.menu, "remove-from-branch");
  if (remove && remove !== "divider") {
    out.push({ id: "remove-from-branch", label: remove.label, danger: true });
  }
  const promote = entryWith(row.menu, "promote-to-team");
  // Challenger (H4 step 8 c fix): an entry the `⋯` shows off — the team repo
  // refuses this member, or the two copies disagree — is no action here
  // either; the `⋯` says why.
  const promoteOff = !!promote && promote !== "divider" && "disabled" in promote && promote.disabled;
  if (promoteOff) {
    // Off in the `⋯`, absent here.
  } else if (promote && promote !== "divider") {
    out.push({
      id: "promote-to-team",
      // Walk follow-ups 2026-10-19: "this one" is the side shown — unless the
      // copy it shares is the branch's (`promoteShares`); then the `⋯`'s own
      // label, and the Compare says which copy goes.
      label: row.promoteShares ? promote.label : "Promote this one to Team",
      ...("confirm" in promote && promote.confirm ? { confirm: true as const } : {}),
    });
  } else if (row.action?.id === "promote") {
    out.push({ id: "promote", label: "Promote this one" });
  }
  const install = entryWith(row.menu, "install");
  if (install && install !== "divider") {
    out.push({
      id: "install",
      label: install.label,
      ...("confirm" in install && install.confirm ? { confirm: true as const } : {}),
    });
  }
  return out;
}

/**
 * The one action under the comparison of the branch's two copies (GH #105).
 *
 * Read out of the row's own menu, like [`compareActions`]: a read-only
 * collaborator sees both copies side by side and no way to change either, which
 * is the same rule every other action on this page follows.
 */
export function reachCompareActions(row: SkillRow): CompareAction[] {
  const align = entryWith(row.menu, "align");
  return align && align !== "divider" ? [{ id: "align", label: align.label }] : [];
}
