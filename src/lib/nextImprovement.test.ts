// 1.173.0 (E3): what the Next improvement section says. Run with
// `node --experimental-strip-types src/lib/nextImprovement.test.ts`.
import assert from "node:assert/strict";
import type { NiIdea, NiRound } from "../ipc.ts";
import {
  answeredSub,
  approachesWords,
  cardAreaOfRound,
  firstShipAt,
  firstUseLine,
  NI_EARLY_HINT,
  NI_EARLY_LABEL,
  niOpensByItself,
  baseChapterClosed,
  ideaCardNotes,
  isNoDirectionRefusal,
  lookedWords,
  howItLookedWords,
  NI_NOTHING_TITLE,
  minutesWords,
  niOfInboxId,
  niProblemWords,
  isWebAddress,
  nothingLine,
  openIdeas,
  rejectHint,
  rejectQuestion,
  setAsideHeading,
  setAsideLine,
  setAsideCardParts,
  shippedFromHere,
  shownPhases,
  sizeRiskWords,
  slateSub,
  carriedIdeas,
  carriedLine,
  FROM_LAST_ROUND,
  NEXT_ROUND,
  ROUND_APPROACH_LINES,
  roundApproachesFrom,
  thisRoundOnlyWords,
  whoProposesWords,
  slateTitle,
  unansweredIdeas,
} from "./nextImprovement.ts";
import {
  directionLede,
  directionTitle,
  lookAtHintWords,
  oneAiWords,
  audiencePlaceholder,
  audienceSuggestion,
  lookAtSuggestion,
  KEPT_HERE,
  savesToWords,
  proposerNote,
  rejectedLine,
  rejectedLink,
  savedPendingWords,
} from "./niDirectionWords.ts";
import { BASE_STEPS, STEP } from "./tutorial/manifest.ts";
import { skipChapter } from "./tutorial/tutorialEngine.ts";

function idea(id: string, patch: Partial<NiIdea> = {}): NiIdea {
  return {
    id,
    title: `Idea ${id}`,
    saw: "the same 14 rows twice",
    change: "One table, plans as columns.",
    better: "Price and button on the first screen on a phone.",
    removes: "the three cards, about 170 lines",
    check: "Every price still there; links unchanged.",
    size: "S",
    risk: "low",
    sources: ["https://baymard.com/blog/pricing"],
    where: ["src/pages/pricing.astro:40-212"],
    dismissed: false,
    ...patch,
  };
}

function round(patch: Partial<NiRound> = {}): NiRound {
  return {
    id: "r1",
    number: 1,
    status: "ready",
    startedAt: 1_000_000,
    endedAt: 1_000_000 + 10 * 60_000,
    areaName: "Site",
    approaches: ["simplify", "fix"],
    lookAt: "https://www.lyrappc.com",
    proposer: "claude",
    second: "codex",
    oneAi: false,
    folder: "site",
    rejectedCount: 0,
    branch: "main",
    revision: "abc",
    phases: [],
    looked: { pages: ["a", "b"], files: 3, browser: false, web: true },
    ideas: [idea("a"), idea("b")],
    setAside: [],
    ...patch,
  };
}

// The approaches, size and risk in the app's words.
assert.equal(approachesWords(["simplify", "fix"]), "Simplify, Fix");
assert.equal(approachesWords(["later"]), "later");
// C7 (VC-11): muted words, "Small change · low risk".
assert.equal(sizeRiskWords("S", "low"), "Small change · low risk");
assert.equal(sizeRiskWords("M", "some"), "Medium change · some risk");
assert.equal(sizeRiskWords("L", "high"), "Large change · high risk");
assert.equal(minutesWords(4 * 60_000 + 5_000), "4 min");
assert.equal(minutesWords(10_000), "less than a minute");

// Scene 1 → 1.174.0 (A6, P11, T50; mockups/board.html 5b): one line, the
// true promise, the plan it uses; the site only with an address.
assert.equal(
  firstUseLine(null),
  "Claude reads the code and proposes only what it can show is worth doing — often one idea, sometimes none · a few minutes, uses your Claude plan",
);
// Round 1 (NIW-5): one sentence, whatever the direction says about where to look.
assert.equal(
  firstUseLine("codex"),
  "Codex reads the code and proposes only what it can show is worth doing — often one idea, sometimes none · a few minutes, uses your Codex plan",
);
assert.doesNotMatch(firstUseLine(null), /up to five|10 minutes|looks at the site/);

// A6 (D2c, owner: per person): it shows by itself after the first shipped
// card on this Mac, or once the tour's base chapter is finished or fully
// skipped — recorded once (`opensSince`). End the tour early is neither.
const baseIds = BASE_STEPS.filter((st) => st.kind !== "interrupt").map((st) => st.id);
const all = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, "t"]));
assert.equal(niOpensByItself(null, null), false);
assert.equal(niOpensByItself({ firstCardShippedAt: "2026-10-31T09:00:00Z" }, null), true);
assert.equal(niOpensByItself({ opensSince: "2026-10-31T09:00:00Z" }, null), true);
assert.equal(niOpensByItself(null, { done: { "base.ship": "t" }, skipped: { "base.second-card": "t" } }), false);
assert.equal(niOpensByItself(null, { endedAt: "2026-10-31T09:00:00Z", done: { "base.how-it-works": "t" } } as never), false);
assert.equal(niOpensByItself(null, { skipped: all(baseIds) }), true);
assert.equal(niOpensByItself(null, { done: all(baseIds.slice(0, 4)), skipped: all(baseIds.slice(4)) }), true);
assert.equal(baseChapterClosed({ done: all(baseIds.slice(1)) }), false);
assert.equal(baseChapterClosed(skipChapter(null, "base", "2026-10-31T09:00:00Z")), true);
assert.equal(STEP.ship, "base.ship");
assert.equal(STEP.secondCard, "base.second-card");
assert.equal(NI_EARLY_LABEL, "Next improvement…");
assert.equal(NI_EARLY_HINT, "Ideas for this project, one at a time. It opens above the Board by itself once a card has shipped.");
// The first ship among the Boards read: the earliest, a shipped card with no
// entry is now, none is null.
assert.equal(firstShipAt([], 99), null);
assert.equal(firstShipAt([{ shipStatus: "unshipped" }], 99), null);
assert.equal(firstShipAt([{ shipStatus: "shipped" }], 99), 99);
assert.equal(
  firstShipAt([{ shipStatus: "shipped", shipHistory: [{ shippedAt: 50 }, { shippedAt: 30 }] }, { shipHistory: [{ shippedAt: 40 }] }], 99),
  30,
);

// Scene 3: only what is done and what happens now.
assert.deepEqual(
  shownPhases({
    phases: [
      { id: "look", state: "done", words: "Claude looked at 9 pages" },
      { id: "read", state: "now", words: "reading the code" },
      { id: "second", state: "todo", words: "a second opinion" },
    ],
  }),
  [
    { label: "Done", words: "Claude looked at 9 pages" },
    { label: "Now", words: "reading the code" },
  ],
);

// Scene 4.
assert.equal(slateTitle(3), "Next improvement · 3 ideas");
assert.equal(slateTitle(1), "Next improvement · 1 idea");
// A6 (T51; 5e): every idea answered — never "0 ideas".
assert.equal(slateTitle(0), "Next improvement · answered");
assert.equal(
  answeredSub(
    round({ ideas: [idea("a", { cardId: "c1" }), idea("b", { dismissed: true })], endedAt: 1_000_000 }),
    1_000_000 + 2 * 3_600_000,
  ),
  "1 made a card, 1 not to propose again · Site · 2 h ago",
);
assert.equal(
  answeredSub(round({ areaName: "", ideas: [idea("a", { cardId: "c1" }), idea("b", { cardId: "c2" })], endedAt: 1_000_000 }), 1_000_000),
  "2 made cards · just now",
);
// C7 (NI-6): the sub-line is only the area and when; the rest is under
// Details › How it looked.
assert.equal(slateSub(round(), 1_000_000 + 22 * 60_000), "Site · 12 min ago");
assert.equal(slateSub(round({ areaName: "" }), 1_000_000 + 22 * 60_000), "12 min ago");
// T10: from the round's facts, never from what it could do.
const noPages = { pages: [], files: 3, browser: false, web: true };
assert.equal(lookedWords(round()), "Read 2 pages and the code");
assert.equal(lookedWords(round({ looked: { ...noPages, pages: ["a"] } })), "Read 1 page and the code");
assert.equal(lookedWords(round({ looked: { ...noPages, browser: true } })), "Looked at the pages and read the code");
assert.equal(lookedWords(round({ looked: noPages })), "Read the page's text and the code");
assert.equal(lookedWords(round({ lookAt: "", looked: noPages })), "Read the code (no address to look at)");
assert.equal(
  howItLookedWords(round({ looked: noPages }), "Claude proposed, Codex gave a second opinion"),
  "Simplify, Fix · read the page's text and the code · Claude proposed, Codex gave a second opinion",
);
assert.equal(howItLookedWords(round({ approaches: [], lookAt: "", looked: noPages }), null), "read the code (no address to look at)");
assert.equal(setAsideHeading([{ by: "secondOpinion" }, { by: "secondOpinion" }]), "Set aside by the second opinion (2)");
// E4: Plyloft's own check sets ideas aside too: one plain heading, each row
// says by whom.
const mixed = [
  { idea: idea("p", { title: "Exit-intent pop-up" }), reason: "you said no pop-ups", by: "secondOpinion" as const },
  { idea: idea("q", { title: "Countdown" }), reason: "pressure words", by: "check" as const },
];
assert.equal(setAsideHeading(mixed), "Set aside (2)");
assert.equal(setAsideLine(mixed[1], mixed), "“Countdown” — pressure words · by Plyloft's check");
assert.equal(setAsideLine(mixed[0], mixed), "“Exit-intent pop-up” — you said no pop-ups · by the second opinion");
assert.equal(
  nothingLine(round({ nothing: null, setAside: [mixed[1], { ...mixed[1], idea: idea("r") }] })),
  "That's a good answer: nothing in Site is worth a card right now. Claude looked at 2 pages and the code. Plyloft's check set aside 2 ideas, under “Set aside”.",
);
assert.deepEqual(
  shownPhases({ phases: [{ id: "second", state: "skipped", words: "Plyloft's check set aside 5 ideas, so no second opinion was needed" }] }),
  [{ label: "Skipped", words: "Plyloft's check set aside 5 ideas, so no second opinion was needed" }],
);
assert.deepEqual(shownPhases({ phases: [{ id: "look", state: "skipped", words: "" }] }), []);
assert.equal(
  setAsideLine({ idea: idea("p", { title: "Exit-intent pop-up" }), reason: "you said no pop-ups", by: "secondOpinion" }),
  "“Exit-intent pop-up” — you said no pop-ups",
);

// What counts: an idea set aside by the person is gone; one made a card
// stays on the slate but isn't waiting.
const marked = round({ ideas: [idea("a", { cardId: "c1" }), idea("b", { dismissed: true }), idea("c")] });
assert.deepEqual(openIdeas(marked).map((i) => i.id), ["a", "c"]);
assert.deepEqual(unansweredIdeas(marked).map((i) => i.id), ["c"]);

// Scene 5.
assert.equal(rejectQuestion("Exit-intent pop-up"), "Don't propose “Exit-intent pop-up” again?");
assert.equal(
  rejectHint("Site"),
  "Why, in one line. Next improvement won't propose this, or anything like it, in Site.",
);
assert.match(rejectHint(""), /in this project\.$/);

// Scene 6 → A6 (5d): zero ideas is a good answer, said first.
assert.equal(
  nothingLine(round({ nothing: null, areaName: "", setAside: [], looked: { pages: [], files: 2, browser: false, web: true } })),
  "That's a good answer: nothing in this project is worth a card right now. Claude read the code.",
);
assert.match(nothingLine(round({ nothing: "All good here.", setAside: [{ idea: idea("x"), reason: "adds", by: "secondOpinion" }] })), /All good here\. Claude looked at 2 pages and the code; the second opinion agreed\. The one idea it had is under “Set aside”\./);
// T11: the AI's own sentence already says what it read — no second tail;
// what follows is whole sentences.
const onlyCode = "There is no address, so I read only the code.";
assert.equal(
  nothingLine(round({ nothing: onlyCode, setAside: [] })),
  `That's a good answer: nothing in Site is worth a card right now. ${onlyCode}`,
);
assert.equal(
  nothingLine(round({ nothing: onlyCode, setAside: [mixed[1]] })),
  `That's a good answer: nothing in Site is worth a card right now. ${onlyCode} Plyloft's check set aside 1 idea, under “Set aside”.`,
);
assert.equal(
  nothingLine(round({ nothing: onlyCode, setAside: [mixed[0]] })),
  `That's a good answer: nothing in Site is worth a card right now. ${onlyCode} The second opinion agreed: the one idea it had is under “Set aside”.`,
);
assert.equal(
  nothingLine(round({ nothing: "I looked at the pricing pages", setAside: [mixed[0], mixed[0]] })),
  "That's a good answer: nothing in Site is worth a card right now. I looked at the pricing pages. The second opinion agreed: the 2 ideas it had are under “Set aside”.",
);
assert.equal(NI_NOTHING_TITLE, "Next improvement · nothing this time");
const shipped = shippedFromHere(round({ ideas: [idea("a", { cardId: "c1" })] }), [
  { id: "c1", shipStatus: "shipped" },
]);
assert.equal(shipped?.idea.id, "a");
assert.equal(shippedFromHere(round({ ideas: [idea("a", { cardId: "c1" })] }), [{ id: "c1", shipStatus: "unshipped" }]), null);

// The start refused for a missing direction opens the direction.
assert.equal(isNoDirectionRefusal("Write the direction first: who it is for and what better means here."), true);
assert.equal(isNoDirectionRefusal("Plyloft runs at most 3 AI chats"), false);
assert.equal(niProblemWords("Plyloft runs at most 3 AI chats at once", "x"), "Plyloft runs at most 3 AI chats at once");
assert.equal(niProblemWords("io error: os error 2", "Next improvement couldn't start the round."), "Next improvement couldn't start the round.");
// E5 Challenger 2: E1's save and Remove refusals are their own words.
for (const own of [
  "Where to look at it must be a web address (https://…), not “x”.",
  "Someone else changed the direction for Site too: choose which answer to keep first.",
  "An area keeps at most 500 ideas not to propose again; remove some first.",
  "Site keeps at most 500 ideas not to propose again; remove some first.",
]) {
  assert.equal(niProblemWords(own, "fallback"), own);
}
assert.equal(isWebAddress(""), true);
assert.equal(isWebAddress("https://www.lyrappc.com"), true);
assert.equal(isWebAddress(" HTTP://a.b "), true);
assert.equal(isWebAddress("https://"), false);
assert.equal(isWebAddress("lyrappc.com"), false);
assert.equal(isWebAddress("https://a b.com"), false);

// The Inbox row's id and the card's area.
assert.deepEqual(niOfInboxId("next-improvement:ws-1:site:r-7"), { workspaceId: "ws-1", area: "site" });
assert.equal(niOfInboxId("setting-conflict:ws-1:x:1"), null);
assert.equal(cardAreaOfRound("default"), null);
assert.equal(cardAreaOfRound("site"), "site");

// Make it a card: card-brief form, the evidence in the notes.
const notes = ideaCardNotes(idea("a", { secondOpinion: "Keeps every price." }), round({ codeNote: "Read the code as of 28 Oct 2026." }));
assert.match(notes, /^## Expected\n- One table, plans as columns\.\n- Better because: Price and button/);
assert.match(notes, /\n## Tests\n- How to check: Every price still there; links unchanged\.\n/);
assert.match(notes, /\n## Manual checks\n- Look at https:\/\/www\.lyrappc\.com once it ships/);
assert.match(notes, /\n## From Next improvement\n- Saw: the same 14 rows twice\n- Where: `src\/pages\/pricing\.astro:40-212`\n- Sources: https:\/\/baymard\.com\/blog\/pricing\n- Second opinion: Keeps every price\.\n- Size: Small change · low risk\n- Read 2 pages and the code\.\n- Read the code as of 28 Oct 2026\.$/);

// The direction editor's words (E5).
assert.equal(directionTitle("Site"), "Direction for Site");
assert.equal(directionTitle(""), "Direction for this project");
assert.equal(
  lookAtHintWords({ url: "https://www.lyrappc.com", source: "railway" }, "https://www.lyrappc.com"),
  "Found in Railway. Empty: it reads only the code and the web, and says so.",
);
assert.equal(lookAtHintWords({ url: "https://a.com", source: "railway" }, "https://b.com"), null);
assert.equal(directionLede(null), "Next improvement proposes only what serves this.");
// C9 (P14): Plyloft read it to help; it suggests, it doesn't write.
assert.equal(
  directionLede(["readme", "packageJson"]),
  "Next improvement proposes only what serves this. Plyloft read your README to help with the direction.",
);
assert.match(directionLede(["packageJson"]), /Plyloft read package\.json to help with the direction\.$/);
// T19.
assert.equal(oneAiWords("claude"), "Claude · then Claude again, in a separate session");
assert.equal(audiencePlaceholder("Site"), "Who uses Site, in a few words");
assert.equal(audiencePlaceholder(""), "Who uses it, in a few words");
assert.equal(audienceSuggestion({ text: "Private sandbox for walks.", source: "readme" }), "Your README starts: “Private sandbox for walks.”");
assert.equal(lookAtSuggestion({ url: "https://plyloft.com", source: "readme" }), "Your README links: https://plyloft.com");
assert.equal(lookAtSuggestion({ url: "https://lyra.up.railway.app", source: "railway" }), "Found in Railway: https://lyra.up.railway.app");
// NIW-1, D6: where a save goes, before the press.
assert.equal(KEPT_HERE, "Kept on this Mac until you share this project's setup.");
assert.equal(
  savesToWords("launch", false),
  "Saved in this project's shared setup: a small commit to launch on GitHub, so your other computers and your team see it.",
);
assert.match(savesToWords("launch", true), /a small commit as a pull request to launch on GitHub/);
assert.equal(proposerNote("claude", true), null);
assert.match(proposerNote("codex", true)!, /^Codex reads the code only; Claude also reads/);
assert.equal(rejectedLink(5), "Not to propose again (5)");
assert.equal(rejectedLine({ reason: "no pop-ups", by: "matteo" }), "no pop-ups · matteo");
assert.equal(rejectedLine({ reason: "", by: null }), "");
const pend = (state: "waiting" | "pullRequest", message: string | null) =>
  ({ state, message, technical: null, pullRequest: null, conflicts: [] });
assert.equal(savedPendingWords(null), null);
assert.equal(savedPendingWords(pend("waiting", null)), null);
assert.equal(savedPendingWords(pend("pullRequest", "Waiting in a pull request until it merges.")), "Waiting in a pull request until it merges.");

// 1.174.0 (C15, NIW-4; mockups/next-improvement.html §2, §2c).
assert.equal(
  slateSub(round({ approachesOverride: ["polish"] }), 1_000_000 + 22 * 60_000),
  "Site · Polish, this round · 12 min ago",
);
assert.equal(slateSub(round({ approachesOverride: null }), 1_000_000 + 22 * 60_000), "Site · 12 min ago");
{
  const r = round({
    ideas: [
      { ...round().ideas[0], id: "own" },
      { ...round().ideas[0], id: "kept", carriedFrom: 1 },
      { ...round().ideas[0], id: "made", carriedFrom: 1, cardId: "c" },
    ],
  });
  assert.deepEqual(carriedIdeas(r).map((i) => i.id), ["kept"]);
}
assert.equal(carriedLine(2), "The 2 ideas from the last round stay below until you answer them.");
assert.equal(carriedLine(1), "The idea from the last round stays below until you answer it.");
assert.equal(FROM_LAST_ROUND, "From the last round");
assert.equal(NEXT_ROUND, "Next round");
assert.equal(ROUND_APPROACH_LINES.polish.line, "Finish what's there: words, spacing, states.");
assert.equal(ROUND_APPROACH_LINES.simplify.line, "Take things away. Each idea must remove more than it adds.");
assert.equal(ROUND_APPROACH_LINES.grow.line, "Something new, one at a time.");
assert.equal(ROUND_APPROACH_LINES.fix.line, "What's broken or untrue.");
assert.deepEqual(roundApproachesFrom(["fix", "simplify", "later"]), ["simplify", "fix"]);
assert.deepEqual(roundApproachesFrom([]), ["polish"]);
assert.equal(whoProposesWords("claude"), "Claude proposes, Codex gives a second opinion");
assert.equal(whoProposesWords("codex"), "Codex proposes, Claude gives a second opinion");
assert.equal(
  thisRoundOnlyWords(1),
  "Only for this round: the direction stays as it is, nothing is saved or shared. The open idea stays below.",
);
assert.equal(thisRoundOnlyWords(0), "Only for this round: the direction stays as it is, nothing is saved or shared.");
assert.match(thisRoundOnlyWords(3), /The 3 open ideas stay below\.$/);

// 1.174.0 (C8, P13; mockups/next-improvement.html §2, §2b).
{
  const repeat = {
    idea: idea("v", { title: "Pricing page: add the viewport tag the home page already has" }),
    reason: "already a card: Pricing page: add the viewport line the home page already has",
    by: "check" as const,
    card: { id: "c7", title: "Pricing page: add the viewport line the home page already has" },
  };
  const both = [repeat, mixed[0]];
  assert.equal(setAsideHeading(both), "Set aside (2)");
  assert.equal(
    setAsideLine(repeat, both),
    "“Pricing page: add the viewport tag the home page already has” — already a card: Pricing page: add the viewport line the home page already has · by Plyloft's check",
  );
  assert.deepEqual(setAsideCardParts(repeat, both), {
    before: "“Pricing page: add the viewport tag the home page already has” — already a card: ",
    card: repeat.card,
    after: " · by Plyloft's check",
  });
  assert.equal(setAsideCardParts(mixed[0], both), null);
  assert.deepEqual(
    shownPhases({ phases: [{ id: "planned", state: "done", words: "read the 3 cards already planned for Site, so it won't propose them again" }] }),
    [{ label: "Done", words: "read the 3 cards already planned for Site, so it won't propose them again" }],
  );
}


// 1.174.0 (C11, §5b): the area's first time after a direction written before areas.
{
  const { BEFORE_AREAS_LINE, CHECK_DIRECTION_FIRST, useItForArea } = await import("./nextImprovement.ts");
  assert.equal(BEFORE_AREAS_LINE, "You wrote a direction before this project had areas.");
  assert.equal(CHECK_DIRECTION_FIRST, "Check the direction first…");
  assert.equal(useItForArea("Site"), "Use it for Site");
  for (const s of [BEFORE_AREAS_LINE, useItForArea("Site")]) assert.ok(!/default/i.test(s));
}
console.log("nextImprovement.test.ts: ok");
