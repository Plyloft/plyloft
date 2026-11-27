/**
 * 1.173.0 (E3): what the Next improvement section above the Board says —
 * the slate of ideas a round left (E2, `next_improvement_round.rs`), its
 * in-progress phases, the first use, the Free ask and the offer after a card
 * from here shipped. Pure: no React, no store, no IPC, so
 * `nextImprovement.test.ts` runs it under plain node.
 * Mockup: ~/ply-build/next-1173/mockups/next-improvement.html, scenes 1, 3–6.
 *
 * Words (E-COMMON): "idea(s)", "second opinion", *Make it a card*, *Change
 * it…*, *Don't propose this…*, "Set aside by the second opinion". Never the
 * Reviewer's old name. No screenshots in 1.173: an idea says it read the
 * page's text and the code.
 */
import type { NiDirectionView, NiIdea, NiRound, NiRoundStatus, NiSetAside } from "../ipc.ts";
import { BASE_STEPS } from "./tutorial/manifest.ts";

export const NI_TITLE = "Next improvement";
export const NI_TOUR = "board-next-improvement";

export const MAKE_IT_A_CARD = "Make it a card";
export const CHANGE_IT = "Change it…";
export const DONT_PROPOSE = "Don't propose this…";
export const DONT_PROPOSE_CONFIRM = "Don't propose it";
export const DIRECTION_LABEL = "Direction…";
export const PREPARE_PROPOSALS = "Prepare proposals";
/** 1.174.0 (C7, P12; mockups/next-improvement.html §1): in the head whenever
 *  no round runs, and in the offer after a card from here shipped. C15
 *  (§2c): it opens the round's popover, and ideas still open stay in the new
 *  round's slate. */
export const PREPARE_NEW = "Prepare new proposals";
/** C7 (§3): a round with nothing worth doing starts again from its row. */
export const PREPARE_AGAIN = "Prepare proposals again";
export const NOT_NOW = "Not now";
export const HIDE = "Hide";
export const SHOW_NI = "Show Next improvement";
export const DETAILS = "Details";
export const HIDE_DETAILS = "Hide details";
export const REWRITE_IT = "Rewrite it";
export const HOW_SHOULD_IT_CHANGE = "How should it change?";
export const UNREADABLE_TITLE = "Couldn't read the ideas this time";
export const WAITING_FOR_CHOICE = "Waiting for your choice";
export const CHOOSE = "Choose…";
export const OPEN_THE_CARD = "Open the card";
export const WHICH_AREA_LEAD = "Next improvement works on one area at a time. Pick one:";

/** E2's refusal of a start without a direction (`NO_DIRECTION_WORDS`): the
 *  direction sheet opens instead. */
export function isNoDirectionRefusal(error: unknown): boolean {
  return String(error).includes("Write the direction first");
}

export function aiName(ai: string | null | undefined): string {
  return ai === "codex" ? "Codex" : "Claude";
}

const APPROACH_WORDS: Record<string, string> = { polish: "Polish", simplify: "Simplify", grow: "Grow", fix: "Fix" };

/** "Simplify, Fix". An approach a newer Plyloft knows is said as written. */
export function approachesWords(approaches: readonly string[]): string {
  return approaches.map((a) => APPROACH_WORDS[a] ?? a).join(", ");
}

/** "Small change · low risk" (C7, VC-11: muted words, never a pill). */
export function sizeRiskWords(size: string, risk: string): string {
  const s = size === "S" ? "Small change" : size === "M" ? "Medium change" : size === "L" ? "Large change" : size;
  const r = risk === "low" || risk === "some" || risk === "high" ? `${risk} risk` : risk;
  return [s, r].filter((w) => w && w.trim()).join(" · ");
}

/** "4 min", "less than a minute". */
export function minutesWords(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "less than a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

/** "12 min ago" from milliseconds. */
export function agoWords(nowMs: number, thenMs: number): string {
  const secs = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)} h ago`;
  const days = Math.floor(secs / 86_400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function ideasWords(n: number): string {
  return n === 1 ? "1 idea" : `${n} ideas`;
}

/** The ideas still waiting for an answer (not set aside by the person). */
export function openIdeas(round: Pick<NiRound, "ideas"> | null | undefined): NiIdea[] {
  return (round?.ideas ?? []).filter((i) => !i.dismissed);
}

/** The ideas the person hasn't answered yet: no card, not set aside. */
export function unansweredIdeas(round: Pick<NiRound, "ideas"> | null | undefined): NiIdea[] {
  return (round?.ideas ?? []).filter((i) => !i.dismissed && !i.cardId);
}

/** Where the words say the round is about: "Site", or "this project". */
function whereWords(areaName: string): string {
  return areaName.trim() || "this project";
}

/** Scene 1 → 1.174.0 (A6, P11, T50; mockups/board.html 5b): the first use,
 *  one line beside the title, with the true promise — real rounds took under
 *  a minute and left one idea or none. */
export function firstUseLine(proposer: string | null | undefined): string {
  const ai = aiName(proposer);
  return `${ai} reads the code and proposes only what it can show is worth doing — often one idea, sometimes none · a few minutes, uses your ${ai} plan`;
}

/** 1.174.0 (C11, P15; mockup next-improvement.html §5b): an area's first
 *  time when a direction was written before the project had areas. Never
 *  "default" on screen. */
export const BEFORE_AREAS_LINE = "You wrote a direction before this project had areas.";
export const CHECK_DIRECTION_FIRST = "Check the direction first…";
export function useItForArea(areaName: string): string {
  return `Use it for ${areaName.trim() || "this area"}`;
}

/** 1.174.0 (A6, D2c; mockups/board.html 5a): the Board's ⋯ item while Next
 *  improvement isn't shown by itself yet, and its hint. */
export const NI_EARLY_LABEL = "Next improvement…";
export const NI_EARLY_HINT = "Ideas for this project, one at a time. It opens above the Board by itself once a card has shipped.";

/** The tour's base chapter finished or fully skipped: every step of it
 *  (its interruptions aside, as *Skip chapter* leaves them) done or skipped.
 *  *End the tour* on an early step is neither. */
export function baseChapterClosed(
  tutorial: { done?: Record<string, string>; skipped?: Record<string, string> } | null | undefined,
): boolean {
  if (!tutorial) return false;
  // 1.175.0 F4: the tour's question isn't a step of the chapter to finish.
  return BASE_STEPS.filter((st) => st.kind !== "interrupt" && st.kind !== "question").every(
    (st) => tutorial.done?.[st.id] != null || tutorial.skipped?.[st.id] != null,
  );
}

/**
 * 1.174.0 (A6, D2c, owner: per person): Next improvement shows by itself once
 * this person shipped a card on this computer (`firstCardShippedAt`), or
 * finished or fully skipped the tour's base chapter — recorded once
 * (`opensSince`), so *Take the tour again* or Start over never hides it.
 * Before that, the Board's ⋯ offers it.
 */
export function niOpensByItself(
  ni: { firstCardShippedAt?: string | null; opensSince?: string | null } | null | undefined,
  tutorial: { done?: Record<string, string>; skipped?: Record<string, string> } | null | undefined,
): boolean {
  return !!ni?.firstCardShippedAt || !!ni?.opensSince || baseChapterClosed(tutorial);
}

/** The time of this computer's first shipped card among the Boards read
 *  (unix ms): the earliest ship of any card, or `now` for a shipped card
 *  with no ship recorded. Null while none shipped. */
export function firstShipAt(
  cards: readonly { shipStatus?: string | null; shipHistory?: readonly { shippedAt: number }[] | null }[],
  now: number,
): number | null {
  let first: number | null = null;
  for (const c of cards) {
    const times = (c.shipHistory ?? []).map((e) => e.shippedAt).filter((t) => Number.isFinite(t) && t > 0);
    const at = times.length ? Math.min(...times) : c.shipStatus === "shipped" ? now : null;
    if (at !== null && (first === null || at < first)) first = at;
  }
  return first;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Scene 3's title. */
export function runningTitle(areaName: string): string {
  return areaName.trim() ? `Preparing proposals for ${areaName.trim()}` : "Preparing proposals";
}

/** Scene 3's line: what is done and what is happening now; a phase skipped
 *  with words of its own says why (E4: "Plyloft's check set aside 5 ideas,
 *  so no second opinion was needed"). */
export function shownPhases(round: Pick<NiRound, "phases">): { label: string; words: string }[] {
  return round.phases
    .filter((p) => p.state === "done" || p.state === "now" || (p.state === "skipped" && p.words.trim() !== ""))
    .map((p) => ({ label: p.state === "done" ? "Done" : p.state === "now" ? "Now" : "Skipped", words: p.words }));
}

/** Scene 4's title: "Next improvement · 3 ideas"; 1.174.0 (A6, T51): once
 *  every idea has its answer, "Next improvement · answered" — never "0 ideas". */
export function slateTitle(open: number): string {
  return open > 0 ? `${NI_TITLE} · ${ideasWords(open)}` : NI_ANSWERED_TITLE;
}
export const NI_ANSWERED_TITLE = `${NI_TITLE} · answered`;

/** 1.174.0 (A6; mockups/board.html 5e): every idea answered — "1 made a card,
 *  1 not to propose again · Site · 2 h ago". */
export function answeredSub(
  round: Pick<NiRound, "ideas" | "areaName" | "endedAt" | "startedAt">,
  nowMs: number,
): string {
  const cards = round.ideas.filter((i) => i.cardId).length;
  const said = round.ideas.filter((i) => i.dismissed && !i.cardId).length;
  const answers = [
    cards > 0 ? `${cards} made ${cards === 1 ? "a card" : "cards"}` : "",
    said > 0 ? `${said} not to propose again` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const when = round.endedAt ?? round.startedAt;
  return [answers, round.areaName.trim(), when ? agoWords(nowMs, when) : ""].filter(Boolean).join(" · ");
}

/** Scene 4's sub-line, 1.174.0 (C7, NI-6): only "Site · 12 min ago"; the
 *  approaches and who proposed are under Details › How it looked. C15 (§2c):
 *  a round whose approach was chosen for it alone says so — "Site · Polish,
 *  this round · just now". */
export function slateSub(
  round: Pick<NiRound, "areaName" | "endedAt" | "startedAt"> & Partial<Pick<NiRound, "approachesOverride">>,
  nowMs: number,
): string {
  const when = round.endedAt ?? round.startedAt;
  const chosen = round.approachesOverride?.length ? `${approachesWords(round.approachesOverride)}, this round` : "";
  return [round.areaName.trim(), chosen, when ? agoWords(nowMs, when) : ""].filter(Boolean).join(" · ");
}

// ── 1.174.0 (C15, NIW-4, P12): another round, with an approach for it ──
// Mockup: ~/ply-build/next-1174/mockups/next-improvement.html §2, §2c, §3.

/** The ideas carried from the last round that still wait for an answer. */
export function carriedIdeas(round: Pick<NiRound, "ideas"> | null | undefined): NiIdea[] {
  return unansweredIdeas(round).filter((i) => i.carriedFrom != null);
}

/** A carried idea's mark in the slate. */
export const FROM_LAST_ROUND = "From the last round";

/** §2: under a round that runs, the ideas of the last round stay. */
export function carriedLine(n: number): string {
  return n === 1
    ? "The idea from the last round stays below until you answer it."
    : `The ${n} ideas from the last round stay below until you answer them.`;
}

/** §2c: the popover's title and its approaches, in the mockup's words. */
export const NEXT_ROUND = "Next round";
export const ROUND_APPROACHES = ["polish", "simplify", "grow", "fix"] as const;
export const ROUND_APPROACH_LINES: Record<(typeof ROUND_APPROACHES)[number], { name: string; line: string }> = {
  polish: { name: "Polish", line: "Finish what's there: words, spacing, states." },
  simplify: { name: "Simplify", line: "Take things away. Each idea must remove more than it adds." },
  grow: { name: "Grow", line: "Something new, one at a time." },
  fix: { name: "Fix", line: "What's broken or untrue." },
};

/** The popover's starting choice: the direction's approaches Plyloft knows,
 *  else Polish (what a round with none ticked does). */
export function roundApproachesFrom(direction: readonly string[] | null | undefined): string[] {
  const known = ROUND_APPROACHES.filter((a) => (direction ?? []).includes(a));
  return known.length ? [...known] : ["polish"];
}

/** "Claude proposes, Codex gives a second opinion". */
export function whoProposesWords(proposer: "claude" | "codex"): string {
  const other = proposer === "codex" ? "claude" : "codex";
  return `${aiName(proposer)} proposes, ${aiName(other)} gives a second opinion`;
}
export const CHANGE_WHO = "Change…";

/** §2c's promise: nothing is saved or shared; the open ideas stay. */
export function thisRoundOnlyWords(open: number): string {
  const lead = "Only for this round: the direction stays as it is, nothing is saved or shared.";
  if (open <= 0) return lead;
  return open === 1 ? `${lead} The open idea stays below.` : `${lead} The ${open} open ideas stay below.`;
}

/** How the round looked at the product, from the round's own facts
 *  (1.174.0, C7, texts.html T10): the pages it opened and the address it
 *  had — never from what it could do (`looked.web` only says it could go on
 *  the web). */
export function lookedWords(round: Pick<NiRound, "lookAt" | "looked">): string {
  if (round.looked.browser) return "Looked at the pages and read the code";
  const pages = round.looked.pages.length;
  if (pages > 0) return `Read ${pages === 1 ? "1 page" : `${pages} pages`} and the code`;
  return round.lookAt.trim() ? "Read the page's text and the code" : "Read the code (no address to look at)";
}

/** Details › How it looked (C7; mockups/next-improvement.html §1): "Simplify,
 *  Fix · read the page's text and the code · Claude proposed, Codex gave a
 *  second opinion". */
export function howItLookedWords(round: Pick<NiRound, "approaches" | "lookAt" | "looked">, byline: string | null): string {
  const looked = lookedWords(round);
  return [approachesWords(round.approaches), looked.charAt(0).toLowerCase() + looked.slice(1), byline?.trim() ?? ""]
    .filter(Boolean)
    .join(" · ");
}

/** Scene 6: why nothing is worth doing. E4: Plyloft's own check may have
 *  set every idea aside before any second opinion. 1.174.0 (A6, P11;
 *  mockups/board.html 5d): it opens with the guide's point — zero ideas is a
 *  good answer. */
export function nothingLine(round: Pick<NiRound, "nothing" | "looked" | "proposer" | "setAside" | "areaName">): string {
  const said = round.nothing?.trim();
  const pages = round.looked.pages.length;
  const looked = pages > 0 ? `${aiName(round.proposer)} looked at ${pages} page${pages === 1 ? "" : "s"} and the code` : `${aiName(round.proposer)} read the code`;
  const byCheck = round.setAside.filter((s) => s.by === "check").length;
  const bySecond = round.setAside.length - byCheck;
  const lead = `That's a good answer: nothing in ${whereWords(round.areaName ?? "")} is worth a card right now.`;
  // 1.174.0 (C7, texts.html T11): the AI's own sentence already says what
  // it read, so "Claude read the code" isn't said twice; what follows is
  // whole sentences.
  if (said && saysWhatItRead(said)) {
    const own = /[.!?]$/.test(said) ? said : `${said}.`;
    let after = "";
    if (round.setAside.length > 0 && bySecond === 0)
      after = ` Plyloft's check set aside ${byCheck === 1 ? "1 idea" : `${byCheck} ideas`}, under “Set aside”.`;
    else if (round.setAside.length > 0)
      after = ` The second opinion agreed: ${round.setAside.length === 1 ? "the one idea it had is" : `the ${round.setAside.length} ideas it had are`} under “Set aside”.`;
    return `${lead} ${own}${after}`;
  }
  let tail: string;
  if (round.setAside.length === 0) tail = ".";
  else if (bySecond === 0)
    tail = `. Plyloft's check set aside ${byCheck === 1 ? "1 idea" : `${byCheck} ideas`}, under “Set aside”.`;
  else
    tail = `; the second opinion agreed. ${round.setAside.length === 1 ? "The one idea it had is" : `The ${round.setAside.length} ideas it had are`} under “Set aside”.`;
  return said ? `${lead} ${said} ${looked}${tail}` : `${lead} ${looked}${tail}`;
}

/** The AI's sentence names the code or the pages it read. */
function saysWhatItRead(said: string): boolean {
  return /\b(code|pages?)\b/i.test(said);
}

/** C7 (§3): the title and the row of a round with nothing worth doing. */
export const NI_NOTHING_TITLE = `${NI_TITLE} · nothing this time`;
export const NOTHING_WORTH = "Nothing worth changing right now";

/** The set-aside list's heading: "Set aside by the second opinion (2)"
 *  while the second opinion set all of them aside; "Set aside (3)" once
 *  Plyloft's own check (E4) set some aside, each row then saying by whom. */
export function setAsideHeading(items: readonly Pick<NiSetAside, "by">[]): string {
  return onlySecondOpinion(items)
    ? `Set aside by the second opinion (${items.length})`
    : `Set aside (${items.length})`;
}

function onlySecondOpinion(items: readonly Pick<NiSetAside, "by">[]): boolean {
  return items.every((s) => s.by === "secondOpinion");
}

/** One set-aside idea: "“Exit-intent pop-up” — you said no pop-ups", with
 *  its source when the heading doesn't say it ("· by Plyloft's check"). */
export function setAsideLine(
  item: Pick<NiSetAside, "idea" | "reason" | "by">,
  all: readonly Pick<NiSetAside, "by">[] = [item],
): string {
  const reason = item.reason.trim();
  const base = reason ? `“${item.idea.title}” — ${reason}` : `“${item.idea.title}”`;
  if (onlySecondOpinion(all)) return base;
  const by = item.by === "check" ? "by Plyloft's check" : item.by === "secondOpinion" ? "by the second opinion" : null;
  return by ? `${base} · ${by}` : base;
}

/** 1.174.0 (C8, P13; mockups/next-improvement.html §2b): a set-aside line
 *  whose idea repeats a card, in three parts so the card's title can open
 *  it: "“Pricing page: add the viewport tag…” — already a card: " · the
 *  card's title · " · by Plyloft's check". Null for any other line. */
export function setAsideCardParts(
  item: Pick<NiSetAside, "idea" | "by" | "card">,
  all: readonly Pick<NiSetAside, "by">[] = [item],
): { before: string; card: { id: string; title: string }; after: string } | null {
  const card = item.card;
  if (!card?.id) return null;
  const by = onlySecondOpinion(all) ? "" : item.by === "check" ? " · by Plyloft's check" : item.by === "secondOpinion" ? " · by the second opinion" : "";
  return { before: `“${item.idea.title}” — already a card: `, card, after: by };
}

/** *Don't propose this…*'s question and hint (scene 5). */
export function rejectQuestion(title: string): string {
  return `Don't propose “${clip(title, 60)}” again?`;
}
export function rejectHint(areaName: string): string {
  return `Why, in one line. Next improvement won't propose this, or anything like it, in ${whereWords(areaName)}.`;
}

/** *Change it…* under way: "Claude is rewriting this idea…". */
export function rewritingWords(proposer: string): string {
  return `${aiName(proposer)} is rewriting this idea…`;
}

/** Scene 6: after a card from here shipped. */
export function shippedTitle(title: string): string {
  return `“${clip(title, 60)}” shipped`;
}
export const SHIPPED_SUB = "it came from Next improvement";

/** The idea made a card whose card shipped since, if any. */
export function shippedFromHere<C extends { id: string; shipStatus?: string | null }>(
  round: Pick<NiRound, "ideas"> | null | undefined,
  cards: readonly C[],
): { idea: NiIdea; card: C } | null {
  for (const idea of round?.ideas ?? []) {
    if (!idea.cardId) continue;
    const card = cards.find((c) => c.id === idea.cardId);
    if (card && card.shipStatus === "shipped") return { idea, card };
  }
  return null;
}

/** The status that ends a round without ideas to show, in words. */
export function endedTitle(status: NiRoundStatus): string | null {
  switch (status) {
    case "stopped":
      return "The round was stopped";
    case "timedOut":
      return "The round took too long and was stopped";
    case "failed":
      return "The round didn't finish";
    case "interrupted":
      return "The round didn't finish";
    default:
      return null;
  }
}

/** The Inbox row's id (`inbox.rs::derive_next_improvement_events`) → its
 *  workspace and area. */
export function niOfInboxId(id: string): { workspaceId: string; area: string } | null {
  const m = /^next-improvement:(.+):([^:]+):[^:]*$/.exec(id);
  return m ? { workspaceId: m[1], area: m[2] } : null;
}

/** The area a card made of an idea belongs to: the round's, or none for the
 *  implicit area of a repository without areas. */
export function cardAreaOfRound(area: string): string | null {
  return area === "default" ? null : area;
}

/**
 * *Make it a card*'s brief, in card-brief form (Expected · Tests · Manual
 * checks), with the evidence the idea came with in the notes below.
 */
export function ideaCardNotes(idea: NiIdea, round: Pick<NiRound, "lookAt" | "looked" | "codeNote" | "areaName">): string {
  const lines: string[] = [];
  const bullet = (text: string | null | undefined, lead = "") => {
    const t = text?.trim();
    if (t) lines.push(`- ${lead}${t}`);
  };
  lines.push("## Expected");
  bullet(idea.change);
  bullet(idea.better, "Better because: ");
  bullet(idea.removes, "Removes: ");
  lines.push("");
  lines.push("## Tests");
  bullet(idea.check, "How to check: ");
  if (!idea.check?.trim()) lines.push("- How to check: say what shows the change is done.");
  lines.push("");
  lines.push("## Manual checks");
  const at = round.lookAt.trim();
  lines.push(at ? `- Look at ${at} once it ships, as the idea describes.` : "- Look at the result once it ships, as the idea describes.");
  lines.push("");
  lines.push("## From Next improvement");
  bullet(idea.saw, "Saw: ");
  if (idea.where.length) lines.push(`- Where: ${idea.where.map((w) => `\`${w}\``).join(", ")}`);
  if (idea.sources.length) lines.push(`- Sources: ${idea.sources.join(" · ")}`);
  bullet(idea.secondOpinion, "Second opinion: ");
  const size = sizeRiskWords(idea.size, idea.risk);
  if (size) lines.push(`- Size: ${size}`);
  lines.push(`- ${lookedWords(round)}.`);
  bullet(round.codeNote);
  return lines.join("\n");
}

/** The round's own refusals are said in the app's words already (E2's
 *  `RUNS_WORDS`, `ROOM_WORDS`, `NONE_READY_WORDS`, E1's area questions):
 *  those are the line; anything else gets `fallback`, its text behind
 *  Details. */
const OWN_WORDS = [
  "Next improvement",
  "Plyloft",
  "Write the direction first",
  "Which area is this for",
  "That idea",
  "The direction",
  // E5 Challenger 2: E1's save and Remove refusals.
  "Where to look at it",
  "Someone else changed the direction",
  "An area keeps at most",
];
/** E1's "<area> keeps at most 500 ideas…" starts with the area's name. */
const OWN_ENDINGS = ["ideas not to propose again; remove some first."];
export function niProblemWords(raw: string, fallback: string): string {
  const text = raw.trim().replace(/^Error:\s*/, "");
  const own = OWN_WORDS.some((w) => text.startsWith(w)) || OWN_ENDINGS.some((w) => text.endsWith(w));
  return own && text.length <= 300 ? text : fallback;
}

/** E5 Challenger 2: "Where to look at it" takes a web address or nothing,
 *  by E1's rule (`areas::valid_web_address`, on the trimmed text): http://
 *  or https:// with something after it, and no spaces. */
export function isWebAddress(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  const lower = t.toLowerCase();
  return ["https://", "http://"].some((s) => lower.startsWith(s) && t.length > s.length) && !/\s/.test(t);
}

/** Challenger 3: the slate folds to its head, so a tall one doesn't push
 *  the Board down. 1.174.0 (C7, BCI-3, NI-6): the toggle is the chevron at
 *  the head's start, named for what it does; with no ideas under it (nothing
 *  worth doing, a round that ended early) it opens "Show Next improvement". */
export const NI_COLLAPSE_LABEL = "Collapse Next improvement";
export const NI_EXPAND_LABEL = "Show Next improvement's ideas";

/** C7 (§1c): Hide says where the section went. */
export const NI_HIDDEN_TOAST = "Next improvement is in the Board's ⋯ menu.";
export const SHOW_IT = "Show it";

/** Challenger 9: *Don't propose this…* and the direction can't be saved
 *  on a read-only Mac; said before the person types. E6: an unshared
 *  project saves on this computer, so it says nothing. */
export function cantSaveWords(
  view: Pick<NiDirectionView, "shared" | "readOnly" | "readOnlyReason"> | null | undefined,
): string | null {
  if (!view || !view.shared) return null;
  if (view.readOnly) return view.readOnlyReason?.trim() || "This computer can't save to this repository.";
  return null;
}

/** Challenger 6: the offer's line — "pull request #382 merged · it came
 *  from Next improvement" when the card shipped through one. */
export function shippedSub(card: { pr?: { number: number; state?: string } | null; prUrl?: string | null }): string {
  const number = card.pr?.number ?? (card.prUrl ? Number(/\/pull\/(\d+)/.exec(card.prUrl)?.[1]) || null : null);
  if (!number) return SHIPPED_SUB;
  const merged = card.pr?.state === "merged" ? " merged" : "";
  return `pull request #${number}${merged} · ${SHIPPED_SUB}`;
}

/** Challenger 11: the card is made but noting it on the idea failed; the
 *  next press notes it again and makes no second card. */
export const MARK_FAILED_WORDS =
  "The card is made, but Plyloft couldn't note it on the idea. Make it a card tries again without making another.";

/** The direction file's own fields (`NiDirection`): C3's question ids are
 *  `ni-<area>-<field>` with one of these. */
export const NI_DIRECTION_FIELDS = ["audience", "better", "avoid", "lookAt", "approaches", "proposer"] as const;
export function isDirectionField(field: string, area: string): boolean {
  return NI_DIRECTION_FIELDS.some((f) => field === `ni-${area}-${f}`);
}
