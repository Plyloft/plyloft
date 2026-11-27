// Skills hub H3a: the skill card and linked copies, in words. Run with:
//
//     node --experimental-strip-types src/lib/skillCards.test.ts

import assert from "node:assert/strict";
import type { KanbanCard, SkillLinkOffer, SkillLinkRow } from "../ipc.ts";
import {
  alignMadeBody,
  busyActionLabel,
  twinsAlignedNotes,
  twinsApartNotes,
  LINK_LABEL,
  NOTHING_TO_INSTALL,
  NOT_NEEDED_LINE,
  cardCarries,
  isScriptsWait,
  isSkillCard,
  linkAllLine,
  reachWords,
  skillCardReach,
  linkChip,
  linkLine,
  linkOfferAction,
  linkOfferLine,
  linkMadeBody,
  linkReach,
  linkSkippedBody,
  openSkillCard,
  skillCardLine,
  onItsWayLine,
  choiceLines,
  removedChoiceLines,
  compare3StatusLabel,
  unloadableNotice,
  sentenceEnd,
  skillShipLine,
  verifyNotNeeded,
} from "./skillCards.ts";
import { LINK_HERE_NOTE, linkAll, linkedAction, repositoryRows, skillSections, type SkillsInput } from "./librarySkills.ts";
import { boardChecksLabel } from "./boardList.ts";
import { checksFact } from "./cardPage.ts";

const kind = {
  type: "skill" as const,
  verb: "install" as const,
  skill: "review-rules",
  origin: { kind: "team", source: "acme/team", plugin: "acme", name: "review-rules", version: { commit: "a3f9c21aa", contentId: "t1" } },
};

function card(over: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: "c1",
    workspaceId: "ws",
    title: "Skill: install review-rules from the team library",
    columnId: "complete",
    kind,
    verifyStatus: "passed",
    verifyHistory: [{ verifyRunId: "not-needed-1", status: "passed", endedAt: 1, steps: [], treeSha: "tree" }],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as KanbanCard;
}

function link(state: SkillLinkRow["state"], upstreamMoved = false): SkillLinkRow {
  return {
    skill: "review-rules",
    originKind: "team",
    originWords: "the team library",
    source: "acme/team",
    plugin: "acme",
    versionCommit: "a3f9c21",
    state,
    upstreamMoved,
  };
}

// ── What a skill card is ──────────────────────────────────────────────
assert.equal(isSkillCard(card()), true);
// §14 Q29: once a Builder or a swarm works on it, it is an ordinary card.
assert.equal(isSkillCard(card({ linkedSwarmId: "s1" })), false);
assert.equal(isSkillCard(card({ builder: {} as KanbanCard["builder"] })), false);
assert.equal(isSkillCard(card({ kind: null })), false);
// Challenger: every trace of work, as `KanbanCard::skill_card`.
assert.equal(isSkillCard(card({ linkedRunId: "r1" })), false);
assert.equal(isSkillCard(card({ runHistory: [{} as NonNullable<KanbanCard["runHistory"]>[number]] })), false);
assert.equal(isSkillCard(card({ buildBoth: {} as NonNullable<KanbanCard["buildBoth"]> })), false);
assert.equal(isSkillCard(card({ runHistory: [] })), true);

// ── Which CLIs the card writes for (R2 edge) ──────────────────────────
const claudeOnly = card();
claudeOnly.kind = { ...claudeOnly.kind!, content: { claude: "t1" } };
assert.equal(reachWords(claudeOnly.kind), "Claude");
assert.match(skillCardReach(claudeOnly), /gets it in Claude, from their next session/);
assert.equal(reachWords({ ...claudeOnly.kind!, content: { claude: "t", codex: "t" } }), "Claude and Codex");
assert.equal(reachWords({ ...claudeOnly.kind!, content: { codex: "t" } }), "Codex");
// A card from before `content` reached the front end: both, as written.
assert.equal(reachWords({ ...claudeOnly.kind!, content: undefined }), "Claude and Codex");

// ── A held script's refusal offers Review ─────────────────────────────
assert.equal(isScriptsWait("review-rules brings a script you haven't said OK to on this Mac, so …"), true);
assert.equal(isScriptsWait("git ignores .claude/skills"), false);

// ── Verify: Not needed, on the card and on the board ──────────────────
assert.equal(verifyNotNeeded(card().verifyHistory), true);
assert.equal(checksFact(card()).word, "Not needed");
assert.equal(boardChecksLabel(card()), "Not needed");
// An ordinary pass with no steps still says "None set up" (GH #333).
const ordinary = card({ verifyHistory: [{ verifyRunId: "v1", status: "passed", endedAt: 1, steps: [], treeSha: "t" }] });
assert.equal(checksFact(ordinary).word, "None set up");
assert.match(skillCardLine(card()), new RegExp(`installs review-rules from the team library\\. ${NOT_NEEDED_LINE}\\.$`));
assert.match(skillCardLine(ordinary), /anything else needs your checks\./);

// ── The row's link line and chip ──────────────────────────────────────
assert.equal(linkLine(link("upToDate"), null), "Linked to the team library · up to date");
assert.equal(linkLine(link("updateAvailable"), null), "Linked to the team library · update available");
assert.equal(linkChip(link("updateAvailable"), null), "Update available");
assert.equal(linkChip(link("modifiedHere"), null), "Modified here");
assert.equal(linkChip(link("upToDate"), null), null);
assert.equal(linkLine(link("modifiedHere"), null), "Linked to the team library · modified here");
// ── Skills hub H4: the decisions' lines and chips ─────────────────────
assert.equal(linkChip(link("bothChanged", true), null), "Both changed");
assert.match(linkLine(link("bothChanged", true), null), /changed here and in the team library\. Compare to choose/);
const proposed = { ...link("bothChanged", true), proposal: { number: 31, url: "https://github.com/a/t/pull/31" } };
assert.equal(linkLine(proposed, null), "Linked to the team library · modified here · Proposed to where it came from · pull request #31");
assert.equal(linkChip(proposed, null), "Modified here");
assert.equal(
  linkLine({ ...link("modifiedHere"), keptMine: true }, null),
  "Linked to the team library · modified here · you kept this version over the team library's version",
);
assert.equal(linkChip(link("removed"), null), "Removed from the team library");
assert.match(linkLine(link("removed"), null), /^The team library no longer has it\. Keep it here/);
assert.equal(linkChip({ ...link("renamed"), renamedTo: "lint-rules" }, null), "Renamed upstream to lint-rules");
assert.match(linkLine({ ...link("renamed"), renamedTo: "lint-rules" }, null), /renamed it to lint-rules\. Rename it here too/);
assert.match(linkLine(link("notAvailable"), null), /not available on this (Mac|PC)$/);
// Update on its way: named, and no second Update.
const open = card({ kind: { ...kind, verb: "update" }, title: "Skill: update review-rules from the team library" });
assert.equal(
  linkLine(link("updateAvailable"), open),
  "Linked to the team library · being updated by the card “Skill: update review-rules from the team library” — ship the card to finish",
);
assert.equal(linkLine(link("updateAvailable"), { ...open, ghIssueNumber: 142 }).endsWith("by card #142 — ship the card to finish"), true);
// Cold read 2026-10-19: what is happening, and the one thing left to do.
assert.equal(onItsWayLine(card({ ghIssueNumber: 84 })), "Being installed by card #84 — ship the card to finish");
assert.equal(linkChip(link("updateAvailable"), open), null);
assert.equal(openSkillCard([open], "review-rules")?.id, "c1");
assert.equal(openSkillCard([{ ...open, shipStatus: "shipped" }], "review-rules"), null);
assert.equal(openSkillCard([{ ...open, archived: true }], "review-rules"), null);
// H6b Windows walk: shipped as a pull request still open, the Update is on its
// way — named, with its pull request, and no second Update offered. Merged or
// closed, it is not.
const pr = (state: "open" | "merged" | "closed") =>
  ({ number: 95, state, checks: "none", checksTotal: 0, checksPassed: 0, checksPending: 0, failingChecks: [], mergeable: "unknown" }) as unknown as KanbanCard["pr"];
const viaPr: KanbanCard = { ...open, ghIssueNumber: 94, reviewStatus: "merged", prUrl: "https://github.com/acme/web/pull/95", pr: pr("open") };
assert.equal(openSkillCard([viaPr], "review-rules")?.id, "c1");
assert.equal(onItsWayLine(viaPr), "Being updated by card #94 — merge its pull request #95 to finish");
assert.equal(linkChip(link("updateAvailable"), openSkillCard([viaPr], "review-rules")), null);
assert.equal(openSkillCard([{ ...viaPr, pr: pr("merged") }], "review-rules"), null);
assert.equal(openSkillCard([{ ...viaPr, pr: pr("closed") }], "review-rules"), null);

// ── The row's one action: Update (Pro), Compare for Modified here ─────
assert.deepEqual(linkedAction(link("updateAvailable"), null), { id: "update", label: "Update" });
assert.equal(linkedAction(link("updateAvailable"), open), null);
// §12: Modified here never offers Update — only the 2-way Compare.
assert.deepEqual(linkedAction(link("modifiedHere"), null), { id: "compare-link", label: "Compare" });
// H4: Both changed opens the 3-way Compare (Pro); a removal or a rename
// upstream asks, free.
assert.deepEqual(linkedAction(link("bothChanged", true), null), { id: "compare3", label: "Compare" });
assert.deepEqual(linkedAction(link("removed"), null), { id: "removed-choice", label: "Keep or remove…" });
assert.deepEqual(linkedAction(link("renamed"), null), { id: "renamed-choice", label: "Rename…" });
assert.equal(linkedAction(link("removed"), open), null, "on its way: no second decision");
assert.equal(linkedAction(link("upToDate"), null), null);
assert.equal(linkedAction(link("notAvailable"), null), null);

// ── Through the repository rows ───────────────────────────────────────
function input(links: SkillLinkRow[], skillCards: KanbanCard[] = []): SkillsInput {
  return {
    repository: [
      { name: "review-rules", description: "Review rules.", claude: true, codex: true, roots: [".claude/skills", ".agents/skills"] },
    ],
    mirror: [],
    team: [],
    personal: [],
    ply: [],
    shared: false,
    branch: null,
    branchReadOnly: false,
    branchSkills: [],
    pending: [],
    removedUpstream: [],
    nowMs: 0,
    canPromote: false,
    links,
    skillCards,
  };
}
const [row] = repositoryRows(input([link("updateAvailable")]), new Map());
assert.equal(row.action?.id, "update");
assert.equal(row.linkChip, "Update available");
assert.equal(row.notes[0], "Linked to the team library · update available");
assert.ok(row.menu.some((e) => e !== "divider" && e.id === "compare-link"), "Compare is in the ⋯");
const [modified] = repositoryRows(input([link("modifiedHere")]), new Map());
assert.equal(modified.action?.id, "compare-link");
assert.ok(!modified.menu.some((e) => e !== "divider" && e.id === "compare-link"), "not twice");
const [onItsWay] = repositoryRows(input([link("updateAvailable")], [open]), new Map());
// QoL 13.4: while a card carries the update, the row's one action opens it.
assert.equal(onItsWay.action?.id, "open-card");
assert.match(onItsWay.notes[0], /being updated by the card/);
const [unlinked] = repositoryRows(input([]), new Map());
assert.equal(unlinked.action, null);
assert.equal(unlinked.linkChip ?? null, null);
assert.ok(skillSections(input([link("upToDate")])).length > 0);

// ── Owner, 2026-10-19: "isn't on <branch> yet" only where Promote is next ─
{
  const WAITS = "`review-rules` isn't on main on GitHub yet. Promote to Team shares the copy committed there, so publish it to main first.";
  const waiting = (links: SkillLinkRow[]): SkillsInput => {
    const base = input(links);
    return {
      ...base,
      canPromote: true,
      repository: base.repository.map((s) => ({ ...s, promoteBlocked: WAITS, promoteWaitsForBranch: true })),
    };
  };
  const menuPromote = (r: (typeof row)) =>
    r.menu.find((e) => e !== "divider" && e.id === "promote-to-team");
  // Not linked: the way to a Promote is said, and Promote is off with it.
  const [open1] = repositoryRows(waiting([]), new Map());
  assert.ok(open1.notes.includes(WAITS));
  const offPromote = menuPromote(open1);
  assert.ok(offPromote && offPromote !== "divider" && "disabled" in offPromote && offPromote.disabled);
  // Linked to the team's: neither the sentence nor a Promote is offered.
  const [linkedRow] = repositoryRows(waiting([link("upToDate")]), new Map());
  assert.ok(!linkedRow.notes.includes(WAITS), "a linked copy is past Promote");
  assert.equal(menuPromote(linkedRow), undefined);
  // Two copies that disagree are still said on a linked copy.
  const DIFFER = "The copies of `review-rules` in this repo are not the same file. Make them match first.";
  const differs = waiting([link("upToDate")]);
  const [linkedDiffer] = repositoryRows(
    { ...differs, repository: differs.repository.map((s) => ({ ...s, promoteBlocked: DIFFER, promoteWaitsForBranch: false })) },
    new Map(),
  );
  assert.ok(linkedDiffer.notes.includes(DIFFER));
  // Cold read (Challenger): not linked, and the team library holds another
  // copy — the wait is said, naming the action that waits (Replace / Complete),
  // and the `⋯` shows that action off with the same reason.
  const held = waiting([]);
  const REPLACE_WAITS = WAITS.replace("Promote to Team shares", "Replace in Team shares");
  const [inTeam] = repositoryRows(
    { ...held, repository: held.repository.map((s) => ({ ...s, team: "differs" as const })) },
    new Map(),
  );
  assert.ok(inTeam.notes.includes(REPLACE_WAITS), inTeam.notes.join(" | "));
  const replaceOff = inTeam.menu.find((e) => e !== "divider" && e.id === "promote-to-team") as
    | { label: string; disabled?: boolean; hint?: string }
    | undefined;
  assert.equal(replaceOff?.label, "Replace in Team…");
  assert.equal(replaceOff?.disabled, true);
  assert.equal(replaceOff?.hint, REPLACE_WAITS);
  const [partial] = repositoryRows(
    { ...held, repository: held.repository.map((s) => ({ ...s, team: "partial" as const })) },
    new Map(),
  );
  assert.ok(partial.notes.includes(WAITS.replace("Promote to Team shares", "Complete in Team shares")));
  // Another plugin's skill of the name: Promote is still the action.
  const [alsoInTeam] = repositoryRows(held, new Map([["review-rules", ["repository", "team"]]]));
  assert.ok(alsoInTeam.notes.includes(WAITS), "the Also in Team chip");
  // Not in the team at all: kept.
  const [notInTeam] = repositoryRows(
    { ...held, repository: held.repository.map((s) => ({ ...s, team: "absent" as const })) },
    new Map(),
  );
  assert.ok(notInTeam.notes.includes(WAITS));
  // Mac walk (cold read): the note a Promote would carry names the same
  // action as the `⋯` when the team library holds another copy.
  const NOTE = "main on GitHub has a newer `review-rules` than this checkout. Promote to Team shares the copy on GitHub.";
  const noted = (team: "differs" | "partial" | "absent") =>
    repositoryRows(
      {
        ...held,
        repository: held.repository.map((s) => ({
          ...s,
          team,
          promoteBlocked: null,
          promoteWaitsForBranch: false,
          promoteNote: NOTE,
        })),
      },
      new Map(),
    )[0].notes;
  assert.ok(noted("differs").includes(NOTE.replace("Promote to Team shares", "Replace in Team shares")));
  assert.ok(noted("partial").includes(NOTE.replace("Promote to Team shares", "Complete in Team shares")));
  assert.ok(noted("absent").includes(NOTE));
}

// ── Cold read 2026-10-19: a linked copy whose team skill waits for an OK ─
{
  const needsOk = { plugin: "acme", firstTime: true, approvedAt: null, bringsScript: true };
  const withOk: SkillsInput = {
    ...input([link("updateAvailable")]),
    team: [{ name: "review-rules", description: "Review rules.", plugin: "acme", claude: true, codex: true, repo: "differs", needsOk }],
  };
  const rows = skillSections(withOk).flatMap((s) => s.rows);
  const repo = rows.find((r) => r.key === "repository:review-rules")!;
  assert.equal(repo.action?.id, "review-scripts", "the same Review as the team row");
  assert.ok(
    repo.notes.includes(
      "Needs your OK · the team library's newer copy brings a script. Update waits until you say OK.",
    ),
  );
  assert.equal(rows.find((r) => r.key === "team:review-rules")!.action?.id, "review-scripts");
  // Another plugin's skill of the same name is not this link's.
  const other: SkillsInput = { ...withOk, team: [{ ...withOk.team[0], plugin: "other", needsOk: { ...needsOk, plugin: "other" } }] };
  const otherRepo = skillSections(other).flatMap((s) => s.rows).find((r) => r.key === "repository:review-rules")!;
  assert.notEqual(otherRepo.action?.id, "review-scripts");
  // (Challenger) Up to date: nothing of the team's waits to come here — no
  // line, no Review. Both changed: said, as for an Update.
  const current: SkillsInput = { ...withOk, links: [link("upToDate")] };
  const upToDate = skillSections(current).flatMap((s) => s.rows).find((r) => r.key === "repository:review-rules")!;
  assert.ok(!upToDate.notes.some((n) => n.startsWith("Needs your OK")));
  assert.notEqual(upToDate.action?.id, "review-scripts");
  const both = skillSections({ ...withOk, links: [link("bothChanged")] }).flatMap((s) => s.rows).find((r) => r.key === "repository:review-rules")!;
  assert.ok(both.notes.some((n) => n.startsWith("Needs your OK")));
  // No OK waiting: the row is as before.
  const [plain] = repositoryRows(input([link("upToDate")]), new Map());
  assert.ok(!plain.notes.some((n) => n.startsWith("Needs your OK")));
}

// ── Cold read 2026-10-19: the team row says how the linked copy stands ─
{
  const teamOf = (state: SkillLinkRow["state"]) =>
    skillSections({
      ...input([link(state)]),
      team: [{ name: "review-rules", description: "Review rules.", plugin: "acme", claude: true, codex: true, repo: "same" }],
    })
      .flatMap((s) => s.rows)
      .find((r) => r.key === "team:review-rules")!;
  assert.ok(teamOf("upToDate").notes.includes("Linked in this repository · up to date"));
  assert.ok(teamOf("modifiedHere").notes.includes("Linked in this repository · modified in this repository"));
  assert.ok(
    teamOf("bothChanged").notes.includes("Linked in this repository · changed in this repository and in the team library. Compare on its row."),
    teamOf("bothChanged").notes.join(" | "),
  );
  assert.ok(teamOf("updateAvailable").notes.includes("Linked in this repository · update available"));
}

// ── H3a walk: the linked copy and its team row share the name ──────────
// That pair is the link's origin, not a duplicate: Update stays the repository
// row's action, and the team row offers no Compare, Install, "Link and update…"
// or "Complete" of its own.
const pairInput: SkillsInput = {
  ...input([link("updateAvailable")]),
  team: [{ name: "review-rules", description: "Review rules.", plugin: "acme", claude: true, codex: false, repo: "differs" }],
};
const pairRows = skillSections(pairInput).flatMap((s) => s.rows);
const linkedRepo = pairRows.find((r) => r.key.startsWith("repository:") && r.name === "review-rules")!;
assert.equal(linkedRepo.action?.id, "update");
const linkedTeam = pairRows.find((r) => r.key === "team:review-rules")!;
assert.equal(linkedTeam.action, null);
assert.ok(!linkedTeam.menu.some((e) => e !== "divider" && e.id === "install"), "no Link and update… / Complete");
assert.match(linkedTeam.notes.join(" "), /Linked in this repository/);

// ── A team row whose Install is on its way offers no second Install ──
const teamInput: SkillsInput = {
  ...input([], [card({ kind: { ...kind, skill: "lint" }, title: "Skill: install lint from the team library" })]),
  repository: [],
  team: [{ name: "lint", description: "Lints.", plugin: "acme", claude: true, codex: true, repo: "absent" }],
};
const teamRow = skillSections(teamInput).flatMap((s) => s.rows).find((r) => r.key === "team:lint")!;
assert.equal(teamRow.action, null);
assert.equal(teamRow.notes[0], "Being installed by the card “Skill: install lint from the team library” — ship the card to finish");
assert.ok(!teamRow.menu.some((e) => e !== "divider" && e.id === "install"));

// ── What the Ship step says ───────────────────────────────────────────
assert.equal(skillShipLine({ kind: "local_merge", skillOnly: true }), NOTHING_TO_INSTALL);
assert.equal(skillShipLine({ kind: "local_merge", skillOnly: false }), null);
assert.equal(skillShipLine({ kind: "skill_up_to_date", skillNote: "Already up to date — x" }), "Already up to date — x");
assert.equal(skillShipLine({ kind: "pr", skillNote: "changed on main" }), "changed on main");
assert.equal(skillShipLine({ kind: "pr" }), null);

// ── Skills hub H3b (R-M): Link and Link all ───────────────────────────
function offer(over: Partial<SkillLinkOffer> = {}): SkillLinkOffer {
  return {
    skill: "review-rules",
    plugin: "acme",
    originWords: "the team library",
    versionCommit: "b7c1e09ffff",
    current: true,
    committed: true,
    ...over,
  };
}
function withOffers(offers: SkillLinkOffer[], skillCards: KanbanCard[] = [], names = ["review-rules"]): SkillsInput {
  const base = input([], skillCards);
  return {
    ...base,
    repository: names.map((name) => ({ ...base.repository[0], name })),
    linkOffers: offers,
  };
}
assert.equal(
  linkOfferLine(offer(), null),
  "Same as the team library's review-rules · not linked. Link records where it came from; nothing in it changes.",
);
assert.equal(
  linkOfferLine(offer({ current: false }), null),
  "Same as an older version of the team library's review-rules · not linked. Link records where it came from; nothing in it changes.",
  "owner 2026-10-17: no commit id in the row's words",
);
assert.match(linkOfferLine(offer({ committed: false }), null), /not committed here yet/);
assert.deepEqual(linkOfferAction(offer(), null), { id: "link", label: LINK_LABEL });
assert.equal(linkOfferAction(offer({ committed: false }), null), null, "nothing on the branch to link yet");
assert.equal(linkOfferAction(null, null), null, "§14 Q10: a copy equal to no version gets no offer");
const [offered] = repositoryRows(withOffers([offer()]), new Map());
assert.equal(offered.action?.id, "link");
assert.match(offered.notes[0], /^Same as the team library's review-rules/);
assert.equal(offered.linkChip ?? null, null);
// A linked copy is never offered Link, whatever an offer says.
const [already] = repositoryRows({ ...withOffers([offer()]), links: [link("upToDate")] }, new Map());
assert.equal(already.action, null);
assert.ok(!already.notes.some((n) => n.startsWith("Same as")));
// A Link card on its way: named, and no second Link — for a Link all card
// too, which carries several skills.
const linkCard = card({
  title: "Skill: link 2 skills to the team library",
  kind: {
    ...kind,
    verb: "link",
    skill: "other",
    links: [
      { skill: "other", origin: kind.origin },
      { skill: "review-rules", origin: kind.origin },
    ],
  },
});
assert.equal(cardCarries(linkCard, "review-rules"), true);
assert.equal(cardCarries(linkCard, "lint"), false);
assert.equal(openSkillCard([linkCard], "review-rules")?.id, "c1");
const [linking] = repositoryRows(withOffers([offer()], [linkCard]), new Map());
// QoL 13.4: no second Link; the row's one action opens the card on its way.
assert.equal(linking.action?.id, "open-card");
assert.equal(linking.notes[0], "Being linked by the card “Skill: link 2 skills to the team library” — ship the card to finish");
assert.match(skillCardLine(linkCard), /links other and review-rules to the team library, at the version each already is — no skill file changes\./);
// Link all: every row whose action is Link, only with two or more.
const both = skillSections(withOffers([offer(), offer({ skill: "other", current: false })], [], ["review-rules", "other"]))
  .find((s) => s.scope === "repository")!.rows;
assert.deepEqual(linkAll(both).sort(), ["other", "review-rules"]);
assert.deepEqual(linkAll(both.slice(0, 1)), [], "one copy: its row's Link is enough");
assert.equal(linkAllLine(2), "2 skills here are the same as a version in the team library and aren't linked yet.");
assert.equal(linkSkippedBody([["mine", "on main it isn't the same as any version of the team's mine"]]), "mine: on main it isn't the same as any version of the team's mine.");
assert.match(linkReach(linkCard), /^Nothing in the skills changes\. .* sees them linked/);
const oneLinkCard = card({ title: "Skill: link review-rules to the team library", kind: { ...kind, verb: "link" } });
assert.match(linkReach(oneLinkCard), /^Nothing in the skill changes\. .* sees it linked/);
// Challenger (H3b): one toast says the card and what it left out.
assert.equal(linkMadeBody(oneLinkCard, []), linkReach(oneLinkCard));
assert.equal(
  linkMadeBody(oneLinkCard, [["other", "already linked on main"]]),
  `${linkReach(oneLinkCard)} Not linked: other: already linked on main.`,
);
// The team row of a copy offered Link (an older version: "differs") offers
// no "Link and update…" / Compare of its own; Link stays the repository
// row's action and the team row points there. Uncommitted: as before.
const offerPair: SkillsInput = {
  ...withOffers([offer({ current: false })]),
  team: [{ name: "review-rules", description: "Review rules.", plugin: "acme", claude: true, codex: true, repo: "differs" }],
};
const offerRows = skillSections(offerPair).flatMap((s) => s.rows);
assert.equal(offerRows.find((r) => r.key.startsWith("repository:"))!.action?.id, "link");
const offerTeam = offerRows.find((r) => r.key === "team:review-rules")!;
assert.equal(offerTeam.action, null);
assert.ok(!offerTeam.menu.some((e) => e !== "divider" && e.id === "install"));
assert.ok(offerTeam.notes.includes(LINK_HERE_NOTE));
const uncommittedTeam = skillSections({ ...offerPair, linkOffers: [offer({ committed: false })] })
  .flatMap((s) => s.rows)
  .find((r) => r.key === "team:review-rules")!;
assert.ok(!uncommittedTeam.notes.includes(LINK_HERE_NOTE));
// Walk follow-ups 2026-10-19 (Windows): an uncommitted copy equal to an older
// team version, whose Replace note speaks for the row, states one way forward:
// the `⋯` has Replace in Team and no Link, and the link line only says what
// the copy is.
assert.equal(
  linkOfferLine(offer({ committed: false, current: false }), null, true),
  "Same as an older version of the team library's review-rules, but not committed here yet.",
);
{
  const REPLACE =
    "This checkout's review-rules has changes not on main. Promote to Team shares the copy committed on main; your local changes aren't included.";
  const base = withOffers([offer({ committed: false, current: false })]);
  const replacing: SkillsInput = {
    ...base,
    shared: true,
    branch: "main",
    canPromote: true,
    repository: [{ ...base.repository[0], team: "differs", promoteNote: REPLACE }],
    team: [{ name: "review-rules", description: "Review rules.", plugin: "acme", claude: true, codex: true, repo: "differs" }],
  };
  const row = skillSections(replacing).flatMap((s) => s.rows).find((r) => r.key === "repository:review-rules")!;
  const ids: string[] = row.menu.flatMap((e) => (e === "divider" ? [] : [e.id]));
  assert.ok(ids.includes("promote-to-team") && !ids.includes("link"), "Replace in Team, no Link");
  assert.equal(row.action?.id === "link", false);
  assert.ok(row.notes.includes("Same as an older version of the team library's review-rules, but not committed here yet."));
  assert.ok(row.notes.some((n) => n.includes("Replace in Team shares the copy committed on main")));
  assert.ok(!row.notes.some((n) => /then link it/.test(n)), "no second way forward");
  // With no Promote note (a member the team refuses), the link line keeps
  // the only way forward it has.
  const quiet = skillSections({ ...replacing, repository: [{ ...replacing.repository[0], promoteNote: null }] })
    .flatMap((s) => s.rows)
    .find((r) => r.key === "repository:review-rules")!;
  assert.ok(quiet.notes.some((n) => /Commit it and ship it, then link it\.$/.test(n)));
}

// ── Skills hub H4: the decision cards in words ────────────────────────
const keep = card({ kind: { ...kind, verb: "keepMine" }, title: "Skill: keep this repository's review-rules (linked to the team library)" });
assert.match(onItsWayLine(keep), /^Being kept as it is by /);
assert.match(skillCardLine(keep), /only the link record changes\./);
assert.match(skillCardReach(keep), /^Nothing in the skill changes\./);
const removal = card({ kind: { ...kind, verb: "remove" }, title: "Skill: remove review-rules (removed from the team library)" });
assert.match(onItsWayLine(removal), /^Being removed by /);
assert.match(skillCardReach(removal), /^Nobody who opens this repository gets it/);
const rename = card({ kind: { ...kind, verb: "rename", renamedTo: "lint-rules" }, title: "Skill: rename review-rules to lint-rules (renamed in the team library)" });
assert.match(skillCardLine(rename), /moves this repository's copies to lint-rules/);
assert.match(choiceLines("the team library").propose, /pull request in the team library/);
assert.match(removedChoiceLines("the team library", true).remove, /Your changes here go too\./);
assert.doesNotMatch(removedChoiceLines("the team library", false).remove, /Your changes/);
// H4 Windows walk: a skill with one copy says "its copy".
assert.match(removedChoiceLines("the team library", false, 1).remove, /^A card deletes its copy and the link record\./);
assert.match(removedChoiceLines("the team library", false).remove, /^A card deletes both copies/);
assert.equal(compare3StatusLabel("upstream", "the team library"), "only the team");
assert.equal(compare3StatusLabel("here", "the team library"), "only you");
// H4 Mac walk: Rename here takes the team's new name in; Keep mine says
// what was kept over; an unloadable folder is plain words, raw text under
// Details.
assert.match(skillCardLine(rename), /takes the new name into their SKILL\.md/);
assert.doesNotMatch(skillCardLine(rename), /as they are/);
assert.match(skillCardLine(keep), /you kept it over the team library's current version/);
const unreadable = unloadableNotice({
  name: "team-style",
  root: ".claude/skills",
  reason: "/Users/a/.claude/skills/team-style/SKILL.md could not be read: No such file or directory (os error 2)",
});
assert.equal(unreadable.sentence, "team-style in .claude/skills has no SKILL.md Plyloft can read, so neither Claude nor Codex loads it.");
assert.match(unreadable.details, /os error 2/);
assert.doesNotMatch(unreadable.sentence, /os error|\/Users\//);
assert.equal(
  unloadableNotice({ name: "x", root: ".claude/skills", reason: "skill `x` has no description in its frontmatter, so neither CLI loads it" }).details,
  "",
);

// H4 Windows re-walk: row notes end as sentences.
assert.equal(
  sentenceEnd("Linked to the team library · modified here · you kept this version over the team library's version"),
  "Linked to the team library · modified here · you kept this version over the team library's version.",
);
assert.equal(sentenceEnd("Compare to choose what this repository keeps."), "Compare to choose what this repository keeps.");

// Skills hub H5 (R12): the Align card and the Verify step's note.
{
  const align = {
    title: "Skill: align lint (Codex's copy follows Claude's)",
    kind: {
      type: "skill" as const,
      verb: "align" as const,
      skill: "lint",
      alignWinner: "claude" as const,
      origin: { kind: "", source: "", name: "", version: { commit: "", contentId: "" } },
    },
    verifyStatus: "passed" as const,
    verifyHistory: [{ verifyRunId: "not-needed-1", status: "passed" as const, endedAt: 1, summary: null, steps: [] }],
    ghIssueNumber: null,
  };
  assert.equal(onItsWayLine(align), "Being aligned by the card “Skill: align lint (Codex's copy follows Claude's)” — ship the card to finish");
  assert.match(skillCardLine(align as never), /replaces Codex's copy of lint with Claude's, file for file/);
  assert.match(skillCardReach(align), /the same lint in Claude and in Codex/);
  assert.equal(alignMadeBody(align, null), skillCardReach(align));
  assert.match(alignMadeBody(align, ".codex/skills/lint is an old copy from before Plyloft managed skills; Plyloft no longer updates it. Remove it in a card."), /old copy/);
  assert.equal(busyActionLabel("align"), "Making the card…");
  assert.deepEqual(
    twinsAlignedNotes({ twinsAligned: [{ skill: "x", winner: "claude" }, { skill: "y", winner: "codex" }] }),
    ["Codex's copy of x updated to match Claude's.", "Claude's copy of y updated to match Codex's."],
  );
  assert.deepEqual(twinsAlignedNotes({}), []);
  // Challenger (H5 Builder walk): copies left apart are said, not hidden.
  assert.deepEqual(twinsApartNotes({ twinsApart: ["team-mac2"] }), [
    "Claude's and Codex's copies of team-mac2 differ in this card, so Plyloft left them as they are. Once it ships, Align in the Library asks which one wins.",
  ]);
  assert.deepEqual(twinsApartNotes({}), []);
}

// ── Skills hub H8: copies of another workspace's skill ────────────────
{
  const copied: SkillLinkRow = { ...link("upToDate"), originKind: "workspace", originWords: "astra", source: "acme/astra", plugin: null };
  assert.equal(linkLine(copied, null), "Linked to astra · up to date");
  assert.equal(linkLine({ ...copied, state: "updateAvailable" }, null), "Linked to astra · update available");
  // R5 edge: a link kept on this Mac only says so.
  const local: SkillLinkRow = { ...copied, originWords: "notes", source: "", local: true };
  assert.match(linkLine(local, null), /^Linked on this (Mac|PC) to notes · up to date$/);
  assert.match(linkLine({ ...local, state: "notAvailable" }, null), /^Linked on this (Mac|PC) to notes — not available on this (Mac|PC)$/);
  const copyCard = card({
    title: "Skill: copy deploy-notes from astra",
    kind: {
      type: "skill",
      verb: "copy",
      skill: "deploy-notes",
      origin: { kind: "workspace", source: "acme/astra", name: "deploy-notes", version: { commit: "c", contentId: "v" } },
      fromWords: "astra",
    },
  });
  assert.equal(onItsWayLine(copyCard), "Being copied by the card “Skill: copy deploy-notes from astra” — ship the card to finish");
  assert.match(skillCardLine(copyCard), /its one commit copies deploy-notes from astra, with its link record\./);
  const localCard = card({ ...copyCard, kind: { ...copyCard.kind!, localLink: true } });
  assert.match(skillCardLine(localCard), /copies deploy-notes from astra, and its link is kept on this (Mac|PC) only\./);
  assert.match(skillCardReach(copyCard), /from their next session once “Skill: copy deploy-notes from astra” ships\.$/);
}

console.log("skillCards: all contracts passed");
