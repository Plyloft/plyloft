/**
 * Skills hub H3a (`docs/plans/SKILLS_HUB.md` R2, §4.2): the skill card and
 * linked copies, in the app's words.
 *
 * A skill card is a card Plyloft made whose worktree already holds one skill
 * change (Install, Update). It opens at Ship; Ship decides on the commit it
 * publishes that only skill files changed, and then Verify is *Not needed*.
 * It never holds the Free slot. Once a Builder or a swarm works on it, it is
 * an ordinary card (§14 Q29) — `isSkillCard` says so, as the backend's
 * `KanbanCard::skill_card` does.
 */
import type {
  KanbanCard,
  ShipOutcome,
  SkillCardKind,
  SkillLinkOffer,
  SkillLinkRow,
  VerifyEntry,
} from "../ipc.ts";
import { machineWords } from "./platform.ts";
import { prOpen } from "./prStatus.ts";

/** The verify entry a skill-only commit gets (`skill_card::NOT_NEEDED_*`). */
export const NOT_NEEDED_RUN_PREFIX = "not-needed-";
export const NOT_NEEDED_LINE = "Only skill files changed — nothing to verify";
/** §14 Q23: a skill-only merge runs no install script. */
export const NOTHING_TO_INSTALL = "Nothing to install — skills reach new sessions directly.";

/** As `KanbanCard::skill_card`: every trace of work — a Builder, a swarm, an
 *  agent run linked or recorded, a Build with both — makes it ordinary. */
export function isSkillCard(
  card: Pick<KanbanCard, "kind" | "builder" | "linkedSwarmId"> &
    Partial<Pick<KanbanCard, "linkedRunId" | "runHistory" | "buildBoth">>,
): boolean {
  return (
    card.kind?.type === "skill" &&
    !card.builder &&
    !card.linkedSwarmId &&
    !card.linkedRunId &&
    !(card.runHistory?.length) &&
    !card.buildBoth
  );
}

/** Challenger (block 13): Ship it with a card refused because `<branch>`
 *  has a newer copy (`skills_hub_carry::NEWER_ON_TARGET_MARKER`). The branch
 *  it names, or null for any other refusal. */
export function carryNewerOn(message: string): string | null {
  const match = /^(.+?) has a newer \S+\. Ask the Builder to bring it here first/.exec(message.trim());
  return match ? match[1] : null;
}

/** The words every scripts refusal carries (`skill_card::SCRIPTS_WAIT_MARKER`):
 *  the toast then offers Review. */
export const SCRIPTS_WAIT_MARKER = "you haven't said OK to";

/** Windows walk (H6b step 9): Refresh card's refusal of a newer version that
 *  brings a new or changed script or file that is not text
 *  (`commands::refresh_scripts_words`) — a sentence the toast says itself. */
export const REFRESH_SHOW_FIRST_MARKER = "won't put it in this card without showing it to you";
export function isRefreshShowFirst(message: string): boolean {
  return message.includes(REFRESH_SHOW_FIRST_MARKER);
}

export function isScriptsWait(message: string): boolean {
  return message.includes(SCRIPTS_WAIT_MARKER);
}

/** The last verify entry is Ship's (or Plyloft's) *Not needed*. */
export function verifyNotNeeded(history: readonly VerifyEntry[] | null | undefined): boolean {
  const last = history?.[history.length - 1];
  return last?.verifyRunId.startsWith(NOT_NEEDED_RUN_PREFIX) ?? false;
}

/** The skill card of `skill` this board still has open — what the row's
 *  *on its way* line names. H6b (Windows walk): a card shipped as a pull
 *  request still open is on its way too (as `commands::open_skill_card`). */
export function openSkillCard(
  cards: readonly KanbanCard[],
  skill: string,
): KanbanCard | null {
  return (
    cards.find(
      (card) =>
        !card.archived &&
        ((card.shipStatus !== "shipped" && card.reviewStatus !== "merged") || prOpen(card)) &&
        isSkillCard(card) &&
        cardCarries(card, skill),
    ) ?? null
  );
}

/** Skills hub H3b: the card changes `skill` — its one skill, or one of a
 *  Link card's (*Link all* carries several). */
export function cardCarries(card: Pick<KanbanCard, "kind">, skill: string): boolean {
  const kind = card.kind;
  if (!kind) return false;
  return kind.links && kind.links.length > 0
    ? kind.links.some((item) => item.skill === skill)
    : kind.skill === skill;
}

/** How a row names the card that carries its change: `#142` on a board
 *  backed by GitHub Issues, the title otherwise. */
export function cardRef(card: Pick<KanbanCard, "title" | "ghIssueNumber">): string {
  return card.ghIssueNumber != null ? `card #${card.ghIssueNumber}` : `the card “${card.title}”`;
}

/** What a linked repository row says about its link (R2, R3 as far as H3
 *  goes): one sentence, with the card when one is on its way. */
/** `Being installed by card #84 — ship the card to finish` — a skill card
 *  still carries it (cold read 2026-10-19: what is happening, and the one
 *  thing left to do). */
export function onItsWayLine(
  card: Pick<KanbanCard, "kind" | "title" | "ghIssueNumber"> &
    Partial<Pick<KanbanCard, "pr" | "prUrl" | "shipStatus" | "reviewStatus">>,
): string {
  const verb = card.kind?.verb;
  const what =
    verb === "update"
      ? "Being updated"
      : verb === "link" || verb === "relink"
        ? "Being linked"
        : verb === "keepMine"
          ? "Being kept as it is"
          : verb === "detach"
            ? "Being unlinked"
            : verb === "remove"
              ? "Being removed"
              : verb === "rename"
                ? "Being renamed"
                : verb === "align"
                  ? "Being aligned"
                  : verb === "copy"
                    ? "Being copied"
                  : verb === "personalize"
                    ? "Being personalized"
                    : verb === "carry"
                      ? "Being shipped"
                      : "Being installed";
  // H6b (Windows walk): shipped as a pull request, it finishes on GitHub.
  if (prOpen(card)) {
    return `${what} by ${cardRef(card)} — merge its pull request #${card.pr!.number} to finish`;
  }
  return `${what} by ${cardRef(card)} — ship the card to finish`;
}

/** Skills hub H4 (R3): `Proposed upstream · pull request #31`. */
export function proposedLine(proposal: NonNullable<SkillLinkRow["proposal"]>): string {
  return proposal.number != null
    ? `Proposed to where it came from · pull request #${proposal.number}`
    : "Proposed to where it came from · pull request open";
}

/** Skills hub H8 (R5 edge): how a row starts — `Linked to astra`, or
 *  `Linked on this Mac to notes` for a link kept on this Mac only. */
export function linkedTo(link: Pick<SkillLinkRow, "originWords" | "local">): string {
  return link.local ? machineWords(`Linked on this Mac to ${link.originWords}`) : `Linked to ${link.originWords}`;
}

export function linkLine(link: SkillLinkRow, onItsWay: KanbanCard | null): string {
  const origin = link.originWords;
  const linked = linkedTo(link);
  if (onItsWay) {
    const line = onItsWayLine(onItsWay);
    return `${linked} · ${line[0].toLowerCase()}${line.slice(1)}`;
  }
  const proposed = link.proposal ? ` · ${proposedLine(link.proposal)}` : "";
  switch (link.state) {
    case "upToDate":
      return `${linked} · up to date`;
    case "updateAvailable":
      // Skills hub H9: a fork of a Plyloft skill names the version waiting.
      return link.originKind === "plyloft" && link.upstreamVersion
        ? `${linked} · update available · Plyloft ${link.upstreamVersion}`
        : `${linked} · update available`;
    case "modifiedHere":
      // Update never writes over the edit; Compare offers what to do.
      return link.keptMine && !proposed
        ? `${linked} · modified here · you kept this version over ${origin}'s version`
        : `${linked} · modified here${proposed}`;
    case "bothChanged":
      // H4 (R3): both sides moved; nothing is lost either way.
      return proposed
        ? `${linked} · modified here${proposed}`
        : `${linked} · changed here and in ${origin}. Compare to choose what this repository keeps.`;
    case "notAvailable":
      return machineWords(`${linked} — not available on this Mac`);
    case "removed":
      // H4 (R8): Keep is the default; the files stay until a card removes them.
      return `${capitalized(origin)} no longer has it. Keep it here as an ordinary skill, or remove it with a card.`;
    case "renamed":
      return `${capitalized(origin)} renamed it to ${link.renamedTo ?? "a new name"}. Rename it here too, or keep this name and stay linked.`;
  }
}

function capitalized(words: string): string {
  return words.length > 0 ? words[0].toUpperCase() + words.slice(1) : words;
}

/** The row's chip for a link state that asks for attention, or null. */
export function linkChip(link: SkillLinkRow, onItsWay: KanbanCard | null): string | null {
  if (onItsWay) return null;
  if (link.state === "updateAvailable") return "Update available";
  if (link.state === "modifiedHere") return "Modified here";
  if (link.state === "bothChanged") return link.proposal ? "Modified here" : "Both changed";
  if (link.state === "removed") return `Removed from ${link.originWords}`;
  if (link.state === "renamed") return `Renamed upstream to ${link.renamedTo ?? "a new name"}`;
  return null;
}

/** What the Ship step says after a skill card's Ship (§4.2). */
export function skillShipLine(outcome: Pick<ShipOutcome, "kind" | "skillOnly" | "skillNote">): string | null {
  if (outcome.kind === "skill_up_to_date" || outcome.kind === "skill_refresh") {
    return outcome.skillNote ?? null;
  }
  if (outcome.kind === "pr" && outcome.skillNote) return outcome.skillNote;
  if (outcome.skillOnly && (outcome.kind === "local_merge" || outcome.kind === "merged_live")) {
    return NOTHING_TO_INSTALL;
  }
  return null;
}

/** The card's own line on its result: what Plyloft wrote, and why Verify is
 *  not needed (or, once it changed beyond its skill, that it is). */
export function skillCardLine(
  card: Pick<KanbanCard, "kind" | "verifyStatus" | "verifyHistory">,
): string {
  const kind = card.kind;
  if (!kind) return "";
  const from =
    kind.fromWords ??
    (kind.origin.kind === "team" ? "the team library" : kind.origin.kind === "plyloft" ? "Plyloft" : kind.origin.source);
  const made =
    kind.verb === "link"
      ? `Plyloft made this card: its one commit links ${linkedNames(kind)} to ${from}, at the version each already is — no skill file changes.`
      : kind.verb === "keepMine"
        ? `Plyloft made this card: its one commit keeps this repository's ${kind.skill} as it is and records that you kept it over ${from}'s current version — only the link record changes.`
        : kind.verb === "detach"
          ? `Plyloft made this card: ${from} no longer has ${kind.skill}; its one commit removes only the link record, and the skill stays.`
          : kind.verb === "remove"
            ? `Plyloft made this card: ${from} no longer has ${kind.skill}; its one commit removes both copies and the link record.`
            : kind.verb === "rename"
              ? `Plyloft made this card: ${from} renamed ${kind.skill}; its one commit moves this repository's copies to ${kind.renamedTo ?? kind.origin.name} and takes the new name into their SKILL.md; every other change here stays.`
              : kind.verb === "relink"
                ? `Plyloft made this card: ${from} renamed ${kind.skill} to ${kind.origin.name}; its one commit keeps the name here and points the link record at it.`
                : kind.verb === "align"
                  ? `Plyloft made this card: its one commit replaces ${alignLoser(kind)}'s copy of ${kind.skill} with ${alignWinner(kind)}'s, file for file; nothing else changes.`
                  : kind.verb === "copy"
                    ? `Plyloft made this card: its one commit copies ${kind.skill} from ${from}${kind.localLink ? machineWords(", and its link is kept on this Mac only") : ", with its link record"}.`
                  : kind.verb === "personalize"
                    ? `Plyloft made this card: its one commit copies the ${kind.skill} that comes with Plyloft ${kind.origin.version.commit} into this repository, linked to it. Wherever it is checked out, sessions get it instead of Plyloft's.`
                  : kind.verb === "carry"
                    ? `Plyloft made this card: its one commit carries ${kind.skill} as it is in your project folder; nothing else changes.`
                    : `Plyloft made this card: its one commit ${kind.verb === "update" ? "updates" : "installs"} ${kind.skill} from ${from}.`;
  return card.verifyStatus === "passed" && verifyNotNeeded(card.verifyHistory)
    ? `${made} ${NOT_NEEDED_LINE}.`
    : `${made} Ship checks again that only skill files changed; anything else needs your checks.`;
}

/** R18.4: who gets it, which CLIs, when — the sentence the Install toast and
 *  the card end with. */
export function skillCardReach(card: Pick<KanbanCard, "title" | "kind">): string {
  switch (card.kind?.verb) {
    // Skills hub H4: the decisions say what reaches whom.
    case "keepMine":
    case "relink":
    case "detach":
      return `Nothing in the skill changes. Everyone who opens this repository sees the new link once “${card.title}” ships.`;
    case "remove":
      return `Nobody who opens this repository gets it, from their next session once “${card.title}” ships.`;
    case "rename":
      return `Everyone who opens this repository gets it under its new name, from their next session once “${card.title}” ships.`;
    // Skills hub H5 (R12).
    case "align":
      return `Everyone who opens this repository gets the same ${card.kind.skill} in Claude and in Codex, from their next session once “${card.title}” ships.`;
    // Skills hub H9 (R9).
    case "personalize":
      return `Everyone who opens this repository gets this repository's ${card.kind.skill} instead of ply:${card.kind.skill}, in Claude and Codex, from their next session once “${card.title}” ships. Other workspaces keep Plyloft's.`;
    default:
      return `Everyone who opens this repository gets it in ${reachWords(card.kind)}, from their next session once “${card.title}” ships.`;
  }
}

// ── Skills hub H5 (R12): the two copies ──────────────────────────────────

/** "Claude" or "Codex": the copy an Align card copies over the other. */
export function alignWinner(kind: Pick<SkillCardKind, "alignWinner">): string {
  return kind.alignWinner === "codex" ? "Codex" : "Claude";
}

/** The copy an Align card replaces. */
export function alignLoser(kind: Pick<SkillCardKind, "alignWinner">): string {
  return kind.alignWinner === "codex" ? "Claude" : "Codex";
}

/** R12 AC: the Verify step's note for every copy Plyloft brought in line
 *  with the one the Builder edited — "Codex's copy of x updated to match
 *  Claude's." */
export function twinsAlignedNotes(card: Pick<KanbanCard, "twinsAligned">): string[] {
  return (card.twinsAligned ?? []).map((done) =>
    done.winner === "codex"
      ? `Claude's copy of ${done.skill} updated to match Codex's.`
      : `Codex's copy of ${done.skill} updated to match Claude's.`,
  );
}

/** H5 (Challenger, Builder walk): the Verify step's note for every skill
 *  whose two copies stay apart on the card — Plyloft left them, rather than
 *  write over an edit, and the Library's Align asks which wins. */
export function twinsApartNotes(card: Pick<KanbanCard, "twinsApart">): string[] {
  return (card.twinsApart ?? []).map(
    (skill) =>
      `Claude's and Codex's copies of ${skill} differ in this card, so Plyloft left them as they are. Once it ships, Align in the Library asks which one wins.`,
  );
}

/** The toast after Align made its card: the card's reach, and the legacy
 *  copy it leaves as it is. */
export function alignMadeBody(card: Pick<KanbanCard, "title" | "kind">, legacyNote: string | null): string {
  return legacyNote ? `${skillCardReach(card)} ${legacyNote}` : skillCardReach(card);
}

// ── Skills hub H4 (R3, R8): the decisions ────────────────────────────────

/** The three choices of the 3-way Compare, word for word (mockup 4). */
export const KEEP_MINE_LABEL = "Keep mine";
export const TAKE_UPSTREAM_LABEL = "Take theirs";
export const PROPOSE_UPSTREAM_LABEL = "Propose mine to them";

/** What each choice does, under it (mockup 4, R18.4). */
export function choiceLines(originWords: string): { keepMine: string; takeUpstream: string; propose: string } {
  return {
    keepMine: `This repository keeps its text and stays linked. The starting point moves to ${originWords}'s current version, so only a later change there asks again. A card changes only the link record.`,
    takeUpstream: `A card replaces this repository's copy with ${originWords}'s, for both Claude and Codex.`,
    propose: `Opens a pull request in ${originWords} with this repository's text. It stays “Modified here” until that merges; then it is up to date by itself.`,
  };
}

/** A 3-way file's status in words (mockup 4's chips). */
export function compare3StatusLabel(status: string, originWords: string): string {
  switch (status) {
    case "both":
      return "both";
    case "here":
      return "only you";
    case "upstream":
      return originWords === "the team library" ? "only the team" : "only where it came from";
    case "same":
      return "same change on both";
    default:
      return "differs";
  }
}

/** The toast after *Propose mine upstream*. */
export function proposedToastBody(done: { number: number | null; addedToOpen: boolean }, originWords: string): string {
  const pr = done.number != null ? `pull request #${done.number}` : "the pull request";
  return done.addedToOpen
    ? `Added this version to ${pr} in ${originWords}. This repository keeps its copy; once ${pr} merges it is up to date by itself.`
    : `Opened ${pr} in ${originWords}. This repository keeps its copy; once it merges it is up to date by itself.`;
}

/** The removed and renamed choices, word for word. */
export const KEEP_LABEL = "Keep";
export const REMOVE_LABEL = "Remove";
export const RENAME_HERE_LABEL = "Rename here";
export const KEEP_OLD_NAME_LABEL = "Keep the old name";

/** R8: what Keep and Remove do; Remove warns when the copy was changed here. */
export function removedChoiceLines(
  originWords: string,
  modified: boolean,
  /** How many copies the skill has here (H4 Windows walk: a Claude-only
   *  skill read "both copies"). */
  copies = 2,
): { keep: string; remove: string } {
  const what = copies === 1 ? "its copy" : "both copies";
  return {
    keep: `A card removes only the link record: the skill stays in this repository as an ordinary skill, and ${originWords} no longer asks about it.`,
    remove: modified
      ? `A card deletes ${what} and the link record. Your changes here go too.`
      : `A card deletes ${what} and the link record. Sessions keep using it until the card ships.`,
  };
}

/** R8 edge: what Rename here and Keep the old name do. */
export function renamedChoiceLines(newName: string): { rename: string; keepName: string } {
  return {
    rename: `A card moves this repository's copies to ${newName} with their link record, and takes the team's new name into their SKILL.md; every other change here stays. Sessions then use the new name.`,
    keepName: `A card points the link record at ${newName} and keeps this name here; nothing in the skill changes.`,
  };
}

/** Which CLIs the card's commit writes for: "Claude", "Codex" or both. */
export function reachWords(kind: KanbanCard["kind"]): string {
  const content = kind?.content;
  if (!content) return "Claude and Codex";
  const claude = !!content.claude;
  const codex = !!content.codex;
  if (claude && !codex) return "Claude";
  if (codex && !claude) return "Codex";
  return "Claude and Codex";
}

// ── Skills hub H3b (R-M): Link and Link all ──────────────────────────────

/** The row's button and the section's, word for word. */
export const LINK_LABEL = "Link";
export const LINK_ALL_LABEL = "Link all";

/** `a`, `a and b`, `a, b and c` — the copies a Link card links. */
function linkedNames(kind: SkillCardKind): string {
  const names = kind.links && kind.links.length > 0 ? kind.links.map((item) => item.skill) : [kind.skill];
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What an unlinked copy's row says about the team version it equals
 * (`skills_hub_links` → `offers`). Linking records where it came from and
 * changes nothing in it; at an older version, the row then offers Update.
 *
 * Walk follow-ups 2026-10-19: an uncommitted copy has no Link in its `⋯`, and
 * when the row's own note already names the way forward (*Replace in Team
 * shares the copy committed on …*, `promoteSpeaks`) "commit it, then link it"
 * was a second one. The line then only says what the copy is.
 */
export function linkOfferLine(offer: SkillLinkOffer, onItsWay: KanbanCard | null, promoteSpeaks = false): string {
  if (onItsWay) return onItsWayLine(onItsWay);
  // Owner, 2026-10-17: no commit id in the row's words (the link record and
  // the card's commit keep the version).
  const same = offer.current
    ? `Same as ${offer.originWords}'s ${offer.skill}`
    : `Same as an older version of ${offer.originWords}'s ${offer.skill}`;
  if (!offer.committed) {
    if (promoteSpeaks) return `${same}, but not committed here yet.`;
    return `${same}, but not committed here yet. Commit it and ship it, then link it.`;
  }
  return `${same} · not linked. Link records where it came from; nothing in it changes.`;
}

/** The row's action for an unlinked copy that equals a team version. */
export function linkOfferAction(
  offer: SkillLinkOffer | null,
  onItsWay: KanbanCard | null,
): { id: "link"; label: string } | null {
  if (!offer || onItsWay || !offer.committed) return null;
  return { id: "link", label: LINK_LABEL };
}

/** The repository section's line above **Link all**. */
export function linkAllLine(count: number): string {
  return `${count} skills here are the same as a version in the team library and aren't linked yet.`;
}

/** R18.4 for a Link card: who sees what, and when. */
export function linkReach(card: Pick<KanbanCard, "title" | "kind">): string {
  const many = (card.kind?.links?.length ?? 1) > 1;
  return many
    ? `Nothing in the skills changes. Everyone who opens this repository sees them linked once “${card.title}” ships.`
    : `Nothing in the skill changes. Everyone who opens this repository sees it linked once “${card.title}” ships.`;
}

/** What a Link left out, and why. */
export function linkSkippedBody(skipped: readonly [string, string][]): string {
  return skipped.map(([skill, why]) => `${skill}: ${why}.`).join(" ");
}

/**
 * Challenger (H3b): the one toast a Link makes — the card, who sees it, and
 * what it left out. Toasts show one at a time (GH #296), so a second toast
 * for the skipped skills would hide the card's own.
 */
export function linkMadeBody(card: Pick<KanbanCard, "title" | "kind">, skipped: readonly [string, string][]): string {
  if (skipped.length === 0) return linkReach(card);
  const left = skipped.length === 1 ? "Not linked:" : `Not linked (${skipped.length}):`;
  return `${linkReach(card)} ${left} ${linkSkippedBody(skipped)}`;
}

/**
 * H4 Mac walk (P-D2): a skill folder neither CLI loads, in plain words — the
 * path and the OS error go under Details. A folder with no readable
 * `SKILL.md` (after a rename left only what the OS drops there) said "…
 * could not be read: No such file or directory (os error 2)" inline.
 */
export function unloadableNotice(skill: { name: string; root: string; reason: string }): {
  sentence: string;
  details: string;
} {
  const where = `${skill.name} in ${skill.root}`;
  if (/could not be read/.test(skill.reason)) {
    return {
      sentence: `${where} has no SKILL.md Plyloft can read, so neither Claude nor Codex loads it.`,
      details: skill.reason,
    };
  }
  return { sentence: `${where} is loaded by neither Claude nor Codex — ${skill.reason}.`, details: "" };
}

/** H4 Windows re-walk: a row note as a sentence — a full stop added when it
 *  ends without one, so notes shown one per line never run together when
 *  read aloud or copied. */
export function sentenceEnd(note: string): string {
  const trimmed = note.trimEnd();
  return /[.!?…:)]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** H4 Windows re-walk 2: a row action's label while it works. */
export function busyActionLabel(id: string): string {
  return id === "install" || id === "update" || id === "link" || id === "align" ? "Making the card…" : "Working…";
}
