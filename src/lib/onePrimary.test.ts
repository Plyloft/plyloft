// P32 / VC-2 (UX audit 1.173, Block B point 3): one filled primary per view.
// A screen or a component offers at most one filled (accent) button: the
// thing to do next. Everything else is a bordered button or a link. The
// render tests that guard this (boardEmpty, cardPage) count `.cbtn--accent`
// only, so the legacy filled classes — `ws-github-btn primary` (AreaNotice,
// AdoptionBanner, retired by A4 in 1.174.0) and its kin — escaped them. This guard reads the source.
// Run with Node 22+:  node --experimental-strip-types src/lib/onePrimary.test.ts
//
// In every .tsx under src/ (tests aside) it counts the places that can draw a
// filled primary:
//   - `<CBtn … tone="accent">`, or a `tone={…}` whose expression names
//     "accent" (a conditional primary counts once), or a local constant that
//     does (`tone={primaryTone}`);
//   - `<MenuButton …>` / `<SplitButton …>` with no tone (their default is
//     accent) or an accent one, as above;
//   - a class string that names `cbtn--accent` or `ux-danger-fill` (the
//     destructive dialog's filled --danger button);
//   - a className that names one of the legacy filled classes in FILLED
//     together with `primary`.
// One button counts once. A button inside a `.map(…)` is drawn on every row:
// it counts per row. An `<ErrorBlock>` (or an error block in
// components/errors/ that renders one) draws its own primary from data
// (`primary: true`): each call site is one possible primary, counted with
// its component's own (`possible` in the baseline) and in a VIEW. An
// `<ErrorBlock error={…} />` with no `onAction` has no way to act, so it has
// no possible primary and counts nothing.
// Each hit belongs to the top-level component that draws it (`file#Name`),
// and a component also carries the hits of the components it draws from the
// same file (per row when it draws them in a `.map`). A component with more
// than one, or with any per-row primary, fails unless BASELINE lists it with
// those counts; a VIEW (several components on one screen, such as the
// Board's header and its notices) fails above its counts, possible
// primaries included. The baseline is a ratchet: a component that drops
// must lower its counts, one at one or none leaves it, and nothing new
// joins it.
// The count is static: a primary in each of two branches that never show
// together counts as written. A component whose branches are exclusive and
// that still counts two is baselined with that reason until it is split.
//
// The CSS side stays honest too: every rule that fills a button with an
// accent, done or danger ink must be one of FILLED, so a new filled class
// can't appear without this guard counting it.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** The filled button classes, with the base class a component writes. */
const FILLED: { css: string; base: string; modifier: string }[] = [
  { css: ".cbtn--accent", base: "cbtn--accent", modifier: "" },
  { css: ".card-review-btn.primary", base: "card-review-btn", modifier: "primary" },
  { css: ".outcome-btn.primary", base: "outcome-btn", modifier: "primary" },
  // A destructive dialog's one filled --danger button (SHEET.md "ConfirmSheet").
  { css: ".cbtn--danger.ux-danger-fill", base: "ux-danger-fill", modifier: "" },
];

/** `count`: filled primaries shown once; `possible`: error blocks, each with
 *  its own `primary: true` way out; `perRow`: drawn on every row of a list
 *  (error blocks included). */
type Baseline = { file: string; component: string; count: number; possible?: number; perRow?: number; reason: string };

/** Components that drew more than one filled primary when the guard landed
 *  (1.174.0, B2). Each is fixed by a card with an approved mockup. */
const BASELINE: Baseline[] = [
  { file: "components/CompareBar.tsx", component: "CompareBars", count: 1, perRow: 1, reason: "Compare's relay bars (1.179.0 two pairs): one CompareBar with one pair, or one per pair in a .map with two — branches that never show together. The .map draws at most two bars, each its own view of its own pair (its own tiles, passes and composer) with its own Pass, as one pair's bar has today; at rest both Pass buttons can be on, and while one pair's composer is open the other's Pass is off (bar(), otherComposer)" },
  { file: "components/CardTroubles.tsx", component: "ShipRefusalBlocks", count: 0, possible: 2, reason: "the refused ship's two blocks (LocalBranchBlock, UnpublishedReleaseBlock), each with its own primary way out; each draws only for this card's refusal, so at most one shows (1.175.0 F8, drawn once by the card page)" },
  { file: "components/CardReviewPanel.tsx", component: "CardReviewPanel", count: 2, reason: "the conflict block's Ask the Builder / Retry merge: card-review-btn primary in branches that never show together (the class is a ternary)" },
  { file: "components/CardShipStep.tsx", component: "CardShipStep", count: 0, possible: 2, reason: "the Shipping section's LocalBranchBlock and UnpublishedReleaseBlock, error blocks, each with its own primary way out" },
  { file: "components/ChatPanel.tsx", component: "ChatPanel", count: 2, reason: "the terminal offer's primary and the composer's Send (accent once there is text) can show together" },
  { file: "components/CodexSession.tsx", component: "CodexSession", count: 3, reason: "Restart (stopped), the approval's Allow and Send (accent once there is a draft) can show together" },
  { file: "components/DiscussionModal.tsx", component: "DiscussionDetail", count: 0, perRow: 3, reason: "draws DiscussionSectionContent once per section: the action section's primary and each retry leg's Retry land on its rows" },
  { file: "components/DiscussionModal.tsx", component: "DiscussionModal", count: 1, perRow: 3, reason: "the modal's own primary, plus DiscussionDetail's per-section primaries" },
  { file: "components/DiscussionModal.tsx", component: "DiscussionSectionContent", count: 2, perRow: 1, reason: "the action section's primary per mode (preflight, active) are branches that never show together; a Retry on every failed leg" },
  { file: "components/EditorPanel.tsx", component: "EditorPanel", count: 0, possible: 2, reason: "the editor's load error and RefusedFilePage's: error blocks, each with its own primary way out, never shown together" },
  { file: "components/LegacyInstallPrompt.tsx", component: "LegacyInstallPrompt", count: 3, reason: "the old-install prompt's primary per case (all users or this user): branches that never show together" },
  { file: "components/PlanExchangePanel.tsx", component: "ExchangeView", count: 4, reason: "the paused exchange's primary and the awaiting step's Accept (editing, note or plain): mostly branches that never show together" },
  { file: "components/PlanExchangePanel.tsx", component: "PlanExchangePanel", count: 5, reason: "draws StartForm's primary and ExchangeView's (4): the start form and the exchange never show together" },
  { file: "components/RepositoryPage.tsx", component: "RepositoryPage", count: 3, possible: 3, reason: "the draft bar's primary, the review sheet's drawn over it, and LeaveSheet's: three views in one component; plus three error blocks, each with its own primary way out" },
  { file: "components/SetupAiStep.tsx", component: "AiToolsStep", count: 1, possible: 1, reason: "the AI step's ErrorBlock and ConsentSheet's primary drawn over it" },
  { file: "components/SetupOverlay.tsx", component: "SetupOverlay", count: 2, reason: "Setup's primary and LeaveSheet's, drawn over it: two views in one component" },
  { file: "components/UpdatePrompt.tsx", component: "UpdateDialog", count: 1, possible: 1, reason: "Install and restart, and the failed update's ErrorBlock (updateWords.ts) under it (see the Update dialog view)" },
  { file: "components/UpdatePrompt.tsx", component: "UpdatePrompt", count: 1, possible: 1, reason: "draws UpdatePromptView → UpdateDialog (see the Update dialog view)" },
  { file: "components/UpdatePrompt.tsx", component: "UpdatePromptView", count: 1, possible: 1, reason: "draws UpdateDialog (see the Update dialog view)" },
  { file: "components/allSkills/MyLibrary.tsx", component: "MyLibraryPanel", count: 2, reason: "draws CreateMyLibraryFlow or UseMyLibraryFlow: branches that never show together" },
  { file: "components/errors/LibraryErrorBlocks.tsx", component: "LibraryErrorBlocks", count: 0, possible: 2, reason: "LocalBranchBlock and PublishRefusedBlock, error blocks, each with its own primary way out" },
  { file: "components/errors/LocalBranchState.tsx", component: "LocalBranchState", count: 0, perRow: 1, reason: "Settings › Board and worktrees: its presses come from a list (p.primary): one is filled, drawn inside the .map — counted per row; on the Board the slot draws useLocalBranchNotice, all bordered (A4)" },
  { file: "components/library/LinkDecisionFlow.tsx", component: "LinkDecisionFlow", count: 2, reason: "the removed / renamed decision's primary: branches that never show together" },
  { file: "components/library/ProposalBlock.tsx", component: "ProposalBlock", count: 2, reason: "Approve and Promote can show together on a proposal on this Mac" },
  { file: "components/library/ScriptApprovalFlow.tsx", component: "ScriptApprovalFlow", count: 4, reason: "two steps of the flow, each with its install-or-not primary: branches that never show together" },
  { file: "components/library/SkillCompare.tsx", component: "SkillCompare", count: 0, perRow: 1, reason: "the compare actions from a list: only the first (i === 0) is filled, drawn inside the .map" },
  { file: "components/settings/TeamPage.tsx", component: "Members", count: 4, reason: "the remove member's danger fill and the three review sheets' primaries (everyone, invite, no seat): one sheet open at a time" },
  { file: "components/settings/TeamPage.tsx", component: "TeamPage", count: 8, possible: 1, reason: "the page draws Members (4), LeaveTeam's and the unlist danger fills, JoinFlow and CreateTeamFlow: sheets and flows, one at a time; plus the page's ErrorBlock" },
  { file: "components/setup/GitHubStep.tsx", component: "GitHubStep", count: 2, possible: 1, reason: "the update sheet's Update and the step's ErrorBlock: never on screen together (1.175.0 F1: the three consent sheets became one, a component of its own with one filled button)" },
  { file: "components/setup/GitStep.tsx", component: "GitStep", count: 1, possible: 1, reason: "the Git step's ErrorBlock beside its primary" },
  { file: "components/setup/ProjectFromGithub.tsx", component: "ProjectFromGithub", count: 2, reason: "two sheets (get the project, push the first commit), one open at a time: branches that never show together" },
  { file: "components/setup/TeamStep.tsx", component: "CreatePanel", count: 1, possible: 1, reason: "Create's ErrorBlock beside its primary" },
  { file: "components/setup/TeamStep.tsx", component: "JoinPanel", count: 2, possible: 2, reason: "Join's primary and ReplaceSheet's drawn over it: two views in one component; plus Join's two error blocks, each with its own primary way out" },
  { file: "components/setup/TeamStep.tsx", component: "JoinedPanel", count: 2, reason: "TeamProjects' primary and InvitePeople's can show together on the joined team" },
  { file: "components/setup/TeamStep.tsx", component: "TeamStep", count: 5, possible: 3, reason: "Setup's team step draws JoinPanel (2), CreatePanel and JoinedPanel (2): the panels are branches that never show together, but JoinedPanel's two can; plus the panels' error blocks, each with its own primary way out" },
  { file: "components/tutorial/GuidePanel.tsx", component: "GuidePanel", count: 0, perRow: 1, reason: "the guide's step rows: only the current step's row draws its Next, drawn inside the .map" },
  { file: "components/tutorial/HelpSheets.tsx", component: "HelpSheets", count: 2, reason: "draws WhatsNewSheet or GetHelpSheet: one sheet open at a time" },
  { file: "components/ux/ErrorBlock.tsx", component: "ErrorBlock", count: 0, perRow: 1, reason: "its ways out come from a list: only the one marked primary is filled, drawn inside the .map (each call site counts once in a view)" },
];

/** Views drawn by several components at once, where each part alone has one
 *  primary but together they show more (VC-2: the Board's notices under its
 *  header's New card). `count` is 1 for a clean view, else its baseline. */
type View = {
  name: string;
  parts: string[];
  count: number;
  perRow?: number;
  /** Parts whose filled primaries never show together, by a rule a render
   *  test pins (1.174.0 A4: the List's Ship N while a selection shows it,
   *  New card bordered meanwhile — boardList.test.tsx): the group counts as
   *  its largest part. */
  oneOf?: string[][];
  reason: string;
};
const VIEWS: View[] = [
  {
    name: "Board header and its notices",
    parts: [
      "components/KanbanBoard.tsx#KanbanBoard",
      "components/BoardList.tsx#BoardList",
      "components/BoardEmptyHero.tsx#BoardEmptyHero",
      "components/BoardNotices.tsx#BoardNotices",
      "components/NextImprovementSection.tsx#NextImprovementSection",
      "components/AdoptionBanner.tsx#useAdoptionNotice",
      "components/AreaNotice.tsx#useAreaNotice",
      "components/errors/LocalBranchState.tsx#useLocalBranchNotice",
    ],
    oneOf: [["components/KanbanBoard.tsx#KanbanBoard", "components/BoardList.tsx#BoardList", "components/BoardEmptyHero.tsx#BoardEmptyHero"]],
    count: 1,
    reason:
      "A4 (VC-2, owner): one filled button — New card, or the List's Ship N while a selection shows it (New card bordered then), or the empty Board's Make the card (New card bordered then; pinned by boardEmpty.test.tsx, 1.176.3); the notes' one slot (BoardNotices: the adoption banner, the areas, the project folder) and Next improvement are all bordered (mockups/board.html §1, §7)",
  },
  {
    name: "Card page: Now and the sync line",
    parts: ["components/CardStateHeader.tsx#CardStateHeader", "components/TargetSyncLine.tsx#TargetSyncLine"],
    oneOf: [["components/CardStateHeader.tsx#CardStateHeader", "components/TargetSyncLine.tsx#TargetSyncLine"]],
    count: 1,
    reason:
      "A7 (VC-2): one filled button — Now's primary (one SplitButton, the button alone without variants), or, only when Now has none, the sync line's Finish and check; every other press on the line is bordered (nowHasPrimary; mockups/card-done.html §1, §2; pinned by targetSync.test.tsx)",
  },
  {
    name: "Card page: the body",
    parts: [
      "components/CardDetailPanel.tsx#CardDetailPanel",
      "components/CardReviewPanel.tsx#CardReviewPanel",
      "components/CardShipStep.tsx#CardShipStep",
      "components/CardAreaLine.tsx#CardAreaValue",
      "components/IntakeHistorySection.tsx#IntakeHistorySection",
      "components/KanbanRunHistory.tsx#RunHistoryAccordion",
    ],
    count: 5,
    reason:
      "the card page's sections under Now: a review card's leading error (1.175.0 F8: elsewhere the card's errors lead Now itself, and the refused ship's blocks are CardTroubles's) and the review panel's primaries, Shipping's error blocks — each with its own primary way out (a failed intake or run row's ErrorBlock has none). 1.174.0 (C2, BCI-11): the area's Use this area moved under Change…, bordered",
  },
  {
    name: "Pull request review card",
    parts: ["components/PrReviewPanel.tsx#PrReviewPanel", "components/CardDetailPanel.tsx#CardDetailPanel"],
    count: 2,
    reason: "the review card's primary inside the card page with its leading error's block (1.175.0 F8: the card's other errors lead Now; the review card's two have no way out)",
  },
  {
    name: "Release sheet",
    // 1.174.0 (DR3): the one Release sheet (it replaced ReleaseFlow,
    // ShipBatchModal and ReleaseAreaSheet): one filled button, whose words
    // say what it does (Release site-v3.0.2, Continue, Wait for the work);
    // a failure is words, never an ErrorBlock with its own primary.
    parts: ["components/ReleaseSheet.tsx#ReleaseSheet"],
    count: 1,
    reason: "the foot's one filled button, with the real tag (mockups/release.html states 2–5)",
  },
  {
    name: "Update dialog",
    parts: ["components/UpdatePrompt.tsx#UpdateDialog"],
    count: 2,
    reason: "Install and restart, and the failed update's ErrorBlock (updateWords.ts) with its own primary way out under it",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** From `from` (just past `<Tag`), the index of the tag's closing `>`:
 *  braces and quotes are skipped, so `=>` and `a > b` inside them don't end it. */
function tagEnd(text: string, from: number): number {
  let depth = 0;
  let quote = "";
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return i;
  }
  return text.length;
}

/** An attribute's raw value inside a tag: `"…"` or the balanced `{…}`. */
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}=`).exec(tag);
  if (!m) return undefined;
  const at = m.index + m[0].length;
  if (tag[at] === '"' || tag[at] === "'") return tag.slice(at, tag.indexOf(tag[at], at + 1) + 1);
  if (tag[at] !== "{") return undefined;
  let depth = 0;
  for (let i = at; i < tag.length; i++) {
    if (tag[i] === "{") depth++;
    else if (tag[i] === "}" && --depth === 0) return tag.slice(at, i + 1);
  }
  return tag.slice(at);
}

const namesAccent = (value: string) => /["'`]accent["'`]/.test(value);

/** A tone that names accent, directly or through a local constant
 *  (`const primaryTone = tone === "accent" ? "accent" : "ghost"`). */
function toneIsAccent(tone: string, text: string): boolean {
  if (namesAccent(tone)) return true;
  const ident = tone.match(/^\{\s*([A-Za-z_$][\w$]*)\s*\}$/)?.[1];
  if (!ident) return false;
  const def = text.match(new RegExp(`\\b(?:const|let)\\s+${ident}\\b[^=]*=([^;]+);`));
  return !!def && namesAccent(def[1]);
}

type Hit = { line: number; what: string; component: string; perRow: boolean; possible: boolean };

/** Comments blanked, newlines kept: a `cbtn--accent` in a note is no button. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/^\s*\/\/.*$/gm, (m) => m.replace(/./g, " "));

type Decl = { name: string; start: number; end: number };

/** The top-level declarations (components and helpers) and the text each spans. */
function declarations(text: string): Decl[] {
  const starts = [
    ...text.matchAll(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+|const\s+)([A-Za-z_$][\w$]*)/gm),
  ];
  return starts.map((m, i) => ({ name: m[1], start: m.index!, end: starts[i + 1]?.index ?? text.length }));
}
const declAt = (decls: Decl[], index: number) => decls.find((d) => index >= d.start && index < d.end);

/** Where each `.map(` / `.flatMap(` call's arguments run: a button drawn in
 *  there is drawn once per row. */
function mapRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/\.(?:flatMap|map)\(/g)) {
    const from = m.index! + m[0].length;
    let depth = 1;
    let quote = "";
    let i = from;
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === quote && text[i - 1] !== "\\") quote = "";
        continue;
      }
      // Not `'`: JSX text inside a row ("don't") would open a quote that
      // never closes. A `(` in a single-quoted string is rare enough.
      if (ch === '"' || ch === "`") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    out.push([from, i]);
  }
  return out;
}
const inRanges = (ranges: [number, number][], i: number) => ranges.some(([a, b]) => i >= a && i < b);

/** Components that may draw a filled primary from their data (an action
 *  list with `primary: true`): the ErrorBlock, and the error blocks in
 *  components/errors/ that render one. Each call site counts as one
 *  possible primary, in its component's count and in a VIEW (per row
 *  inside a `.map`). */
const ERROR_TAGS = ["ErrorBlock"];

/** Every place in one file that can draw a filled primary, each with its
 *  top-level declaration. */
function primaries(source: string, possibleTags: readonly string[] = ERROR_TAGS): Hit[] {
  const text = stripComments(source);
  const decls = declarations(text);
  const maps = mapRanges(text);
  const out: Hit[] = [];
  const hit = (index: number, what: string, possible = false) =>
    out.push({
      line: lineOf(text, index),
      what,
      component: declAt(decls, index)?.name ?? "(module)",
      perRow: inRanges(maps, index),
      possible,
    });
  // One button counts once: a class inside a tag already counted adds nothing
  // (`<CBtn tone={d ? "danger" : "accent"} className={d ? "ux-danger-fill" : …}>`).
  const counted: [number, number][] = [];
  for (const m of text.matchAll(/<(CBtn|MenuButton|SplitButton)\b/g)) {
    const end = tagEnd(text, m.index! + m[0].length) + 1;
    const tag = text.slice(m.index!, end);
    const tone = attr(tag, "tone");
    const filled = tone === undefined ? m[1] !== "CBtn" : toneIsAccent(tone, text);
    if (filled) {
      hit(m.index!, `<${m[1]} tone=${tone ?? "(default accent)"}>`);
      counted.push([m.index!, end]);
    }
  }
  for (const f of FILLED) {
    if (f.modifier) continue;
    for (const m of text.matchAll(new RegExp(`(?<![\\w-])${f.base}(?![\\w-])`, "g"))) {
      if (!inRanges(counted, m.index!)) hit(m.index!, f.base);
    }
  }
  for (const m of text.matchAll(/\bclassName=/g)) {
    if (inRanges(counted, m.index!)) continue;
    const value = attr(text.slice(m.index! - 1, m.index! + 2000), "className") ?? "";
    for (const f of FILLED) {
      if (!f.modifier) continue;
      if (new RegExp(`\\b${f.base}\\b`).test(value) && new RegExp(`(?<![\\w-])${f.modifier}(?![\\w-])`).test(value)) {
        hit(m.index!, `${f.base} ${f.modifier}`);
      }
    }
  }
  for (const t of possibleTags) {
    for (const m of text.matchAll(new RegExp(`<${t}\\b`, "g"))) {
      // An ErrorBlock given no way to act (`<ErrorBlock error={…} />`, no
      // `onAction`) has no possible primary: a press would do nothing, so
      // its error is built with no ways out (Areas' refused save).
      if (t === "ErrorBlock" && !/\bonAction=/.test(text.slice(m.index!, tagEnd(text, m.index! + m[0].length) + 1))) continue;
      hit(m.index!, `<${t}> (its primary: true action)`, true);
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** A component's hits with those of the components it draws from the same
 *  file (`<Child` inside its own text; once per call site, per row when the
 *  call site is inside a `.map`). */
function composed(source: string, possibleTags: readonly string[] = ERROR_TAGS): Map<string, Hit[]> {
  const text = stripComments(source);
  const decls = declarations(text);
  const maps = mapRanges(text);
  const own = new Map<string, Hit[]>();
  for (const h of primaries(source, possibleTags)) own.set(h.component, [...(own.get(h.component) ?? []), h]);
  const memo = new Map<string, Hit[]>();
  const effective = (d: Decl, stack: Set<string>): Hit[] => {
    if (memo.has(d.name)) return memo.get(d.name)!;
    const out = [...(own.get(d.name) ?? [])];
    for (const child of decls) {
      if (child.name === d.name || stack.has(child.name) || !/^[A-Z]/.test(child.name)) continue;
      for (const m of text.slice(d.start, d.end).matchAll(new RegExp(`<${child.name}\\b`, "g"))) {
        const perRow = inRanges(maps, d.start + m.index!);
        for (const h of effective(child, new Set([...stack, d.name]))) {
          out.push({ ...h, perRow: h.perRow || perRow, what: `${child.name}: ${h.what}` });
        }
      }
    }
    memo.set(d.name, out);
    return out;
  };
  const result = new Map<string, Hit[]>();
  for (const d of decls) {
    const hits = effective(d, new Set([d.name]));
    if (hits.length) result.set(d.name, hits);
  }
  return result;
}

// The error blocks that render an ErrorBlock count as one too.
const files = walk(SRC);
const tsx = files.filter((f) => f.endsWith(".tsx") && !/\.test\.tsx$/.test(f));
const possibleTags = [...ERROR_TAGS];
for (const abs of tsx.filter((f) => relative(SRC, f).startsWith(join("components", "errors")))) {
  const text = stripComments(readFileSync(abs, "utf8"));
  for (const d of declarations(text)) {
    if (/^[A-Z]/.test(d.name) && /\bexport\s/.test(text.slice(d.start, d.start + 20)) && /<ErrorBlock\b/.test(text.slice(d.start, d.end))) {
      possibleTags.push(d.name);
    }
  }
}

// Per component: `file#Component` → its filled primaries (with the ones of
// the components it draws from its own file).
const units = new Map<string, Hit[]>();
for (const abs of tsx) {
  const file = relative(SRC, abs);
  for (const [name, hits] of composed(readFileSync(abs, "utf8"), possibleTags)) units.set(`${file}#${name}`, hits);
}
const tally = (hits: Hit[]) => ({
  flat: hits.filter((h) => !h.possible && !h.perRow).length,
  perRow: hits.filter((h) => h.perRow).length,
  possible: hits.filter((h) => h.possible && !h.perRow).length,
});
const tallyOf = (key: string) => tally(units.get(key) ?? []);
const describe = (hits: Hit[]) =>
  hits.map((h) => `line ${h.line} ${h.what}${h.perRow ? " [per row]" : ""}${h.possible ? " [possible]" : ""}`).join("; ");
const viewTally = (v: View) => {
  const grouped = new Set((v.oneOf ?? []).flat());
  const alone = v.parts
    .filter((k) => !grouped.has(k))
    .reduce(
      (t, k) => {
        const u = tallyOf(k);
        return { n: t.n + u.flat + u.possible, perRow: t.perRow + u.perRow };
      },
      { n: 0, perRow: 0 },
    );
  for (const group of v.oneOf ?? []) {
    const ts = group.map(tallyOf);
    alone.n += Math.max(0, ...ts.map((u) => u.flat + u.possible));
    alone.perRow += Math.max(0, ...ts.map((u) => u.perRow));
  }
  return alone;
};

if (process.env.ONE_PRIMARY_DUMP) {
  for (const [key, hits] of [...units].sort()) {
    const t = tally(hits);
    if (t.flat + t.possible > 1 || t.perRow > 0) console.log(`${key}\t${t.flat}\t${t.possible}\t${t.perRow}\t${describe(hits)}`);
  }
  for (const v of VIEWS) {
    const t = viewTally(v);
    console.log(`view ${v.name}\t${t.n}\t${t.perRow}\t${v.parts.map((k) => `${k}=${JSON.stringify(tallyOf(k))}`).join(" ")}`);
  }
}

const baselineOf = (key: string) => BASELINE.find((b) => `${b.file}#${b.component}` === key);
const over: string[] = [];
for (const [key, hits] of units) {
  const t = tally(hits);
  const b = baselineOf(key);
  const limit = b ? b.count + (b.possible ?? 0) : 1;
  if (t.flat + t.possible > limit) {
    over.push(`${key}: ${t.flat + t.possible} filled primaries (${describe(hits.filter((h) => !h.perRow))})`);
  }
  if (t.perRow > (b?.perRow ?? 0)) {
    over.push(`${key}: ${t.perRow} filled primar${t.perRow === 1 ? "y" : "ies"} on every row (${describe(hits.filter((h) => h.perRow))})`);
  }
}
for (const v of VIEWS) {
  const t = viewTally(v);
  if (t.n > v.count) over.push(`view "${v.name}": ${t.n} filled primaries`);
  if (t.perRow > (v.perRow ?? 0)) over.push(`view "${v.name}": ${t.perRow} filled primaries on every row`);
}
assert.deepEqual(
  over,
  [],
  "one filled primary per view: make the others bordered buttons (CBtn with no tone) or a link; a list's rows carry none (P32 / VC-2)",
);

// The ratchet: a baselined component keeps exactly its counts — fewer means
// the baseline comes down with them; one or none (and no row primary) means
// it leaves.
const seen = new Set<string>();
for (const b of BASELINE) {
  const key = `${b.file}#${b.component}`;
  assert.ok(!seen.has(key), `${key}: listed twice`);
  seen.add(key);
  assert.ok(b.reason.length > 10, `${key}: the baseline says why`);
  assert.ok(
    b.count + (b.possible ?? 0) > 1 || (b.perRow ?? 0) > 0,
    `${key}: a count of one or none, and no row primary, needs no baseline`,
  );
  const t = tallyOf(key);
  assert.equal(t.flat, b.count, `${key}: now ${t.flat} filled primaries, baselined ${b.count} — lower the baseline`);
  assert.equal(t.possible, b.possible ?? 0, `${key}: now ${t.possible} error blocks, baselined ${b.possible ?? 0} — lower the baseline`);
  assert.equal(t.perRow, b.perRow ?? 0, `${key}: now ${t.perRow} per row, baselined ${b.perRow ?? 0} — lower the baseline`);
}
for (const v of VIEWS) {
  assert.ok(v.reason.length > 10, `view "${v.name}": says what it is`);
  for (const k of v.parts) {
    const [file, component] = k.split("#");
    const text = readFileSync(join(SRC, file), "utf8");
    assert.match(text, new RegExp(`\\b(?:function|const)\\s+${component}\\b`), `view "${v.name}": ${k} is gone — update the view`);
  }
  for (const k of (v.oneOf ?? []).flat()) assert.ok(v.parts.includes(k), `view "${v.name}": ${k} in oneOf is one of its parts`);
  const t = viewTally(v);
  if (v.count > 1) assert.equal(t.n, v.count, `view "${v.name}": now ${t.n} filled primaries, baselined ${v.count} — lower it`);
  assert.equal(t.perRow, v.perRow ?? 0, `view "${v.name}": now ${t.perRow} per row, baselined ${v.perRow ?? 0} — lower it`);
}

// CSS: every rule that fills a button — a selector that names a button, or a
// rule that reads as one (`cursor: pointer`, or the ink drawn on a fill) —
// with an accent, done or danger ink is FILLED, so a new filled class can't
// appear without this guard counting it. A pressed-only state (`:active`)
// is feedback, not a fill; NOT_BUTTONS are fills that no one presses, or a
// toggle's on state. A class some rule makes `cursor: pointer` is pressable,
// so a fill on it (its `.is-on`) is checked too.
const FILL = /(?<![\w-])background(?:-color)?\s*:\s*var\(--(claude-accent|accent-[\w-]+|signal-[\w-]+-fg|ok|danger|warn)\)/;
const READS_AS_BUTTON = /cursor\s*:\s*pointer|(?<![\w-])color\s*:\s*var\(--(page-on-accent|on-accent|on-danger)\b/;
const NOT_BUTTONS: { file: string; selector: string; reason: string }[] = [
  { file: "App.css", selector: ".agent-run-provider-badge", reason: "a run's provider badge: a label, not pressed" },
  { file: "App.css", selector: ".ws-icon-chip-attn", reason: "the attention count on a project's icon: a badge, not pressed" },
  { file: "components/shell.css", selector: ".shell-toggle-count", reason: "the Inbox count on the sidebar toggle: a badge, not pressed" },
  {
    file: "App.css",
    selector: ".card-review-mini.is-on",
    reason: "a hunk's Accept toggle in its on state: a selection on every hunk row, not a primary (the mockup may make it calm too)",
  },
  {
    file: "App.css",
    selector: ".card-review-mini.reject.is-on",
    reason: "a hunk's Reject toggle in its on state: a selection on every hunk row, not a primary (the mockup may make it calm too)",
  },
  {
    file: "components/ux/ux.css",
    selector: '.ux-toggle[aria-checked="true"]',
    reason: "a switch in its on state: a setting's value, not a primary",
  },
];
const strays: string[] = [];
const filledSeen = new Set<string>();
const notButtonsSeen = new Set<string>();
/** The classes in a selector's last compound: the element it styles. */
const subjectClasses = (sel: string) => [...(sel.split(/[\s>+~]+/).pop() ?? "").matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
// Classes some rule makes pressable: a fill on one of them is a button's
// state (`.card-review-mini` is `cursor: pointer`, so `.card-review-mini.is-on`
// is a filled button).
const pressable = new Set<string>();
for (const abs of files.filter((f) => f.endsWith(".css"))) {
  const text = readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/cursor\s*:\s*pointer/.test(rule[2])) continue;
    for (const sel of rule[1].split(/,(?![^(]*\))/)) for (const c of subjectClasses(sel.trim())) pressable.add(c);
  }
}
for (const abs of files.filter((f) => f.endsWith(".css"))) {
  const file = relative(SRC, abs);
  const text = readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!FILL.test(rule[2])) continue;
    const readsAsButton = READS_AS_BUTTON.test(rule[2]);
    for (const sel of rule[1].split(/,(?![^(]*\))/).map((s) => s.replace(/\s+/g, " ").trim())) {
      if (sel.startsWith("@")) continue;
      if (!readsAsButton && !/btn|button/i.test(sel) && !subjectClasses(sel).some((c) => pressable.has(c))) continue;
      if (/:active\b/.test(sel)) continue;
      const f = FILLED.find((x) => sel.includes(x.css));
      if (f) {
        filledSeen.add(f.css);
        continue;
      }
      const n = NOT_BUTTONS.find((x) => x.file === file && x.selector === sel);
      if (n) notButtonsSeen.add(`${file} ${sel}`);
      else strays.push(`${file} ${sel}`);
    }
  }
}
if (process.env.ONE_PRIMARY_DUMP) for (const x of strays) console.log(`stray\t${x}`);
assert.deepEqual(strays, [], "a new filled button class: add it to FILLED so the count sees it (or to NOT_BUTTONS, saying why)");
for (const f of FILLED) assert.ok(filledSeen.has(f.css), `${f.css}: no longer filled — drop it from FILLED`);
for (const n of NOT_BUTTONS) {
  assert.ok(n.reason.length > 10, `${n.selector}: NOT_BUTTONS says why`);
  assert.ok(notButtonsSeen.has(`${n.file} ${n.selector}`), `${n.file} ${n.selector}: no longer filled — drop it from NOT_BUTTONS`);
}

// The counter itself counts what it is for.
assert.equal(primaries(`<CBtn tone="accent" onClick={() => a > b}>Go</CBtn>`).length, 1);
assert.equal(primaries(`<CBtn tone={ok ? "accent" : "ghost"}>Go</CBtn>`).length, 1);
assert.equal(primaries(`<CBtn tone="quiet">Go</CBtn><CBtn>Go</CBtn>`).length, 0);
assert.equal(primaries(`<MenuButton label="New" items={[]} />`).length, 1);
assert.equal(primaries(`<MenuButton label="New" tone="quiet" items={[]} />`).length, 0);
assert.equal(primaries(`<SplitButton label="Ship" tone={x ? "ghost" : "accent"} />`).length, 1);
assert.equal(primaries(`<button className="card-review-btn primary">Set up</button>`).length, 1);
assert.equal(primaries(`<button className={\`outcome-btn \${p ? "primary" : ""}\`}>Go</button>`).length, 1);
assert.equal(primaries(`<button className="card-review-btn">Set up</button>`).length, 0);
assert.equal(primaries(`<button className="cbtn cbtn--accent">Go</button>`).length, 1);
assert.equal(primaries(`<div className="ux-list-td--primary" />`).length, 0);
assert.equal(primaries(`const t = x ? "accent" : "ghost";\n<CBtn tone={t}>Go</CBtn>`).length, 1);
assert.equal(primaries(`<CBtn tone={tone}>Go</CBtn>`).length, 0, "a wrapper passing its own tone through is not a use");

assert.equal(primaries(`// <CBtn tone="accent">\n<CBtn>Go</CBtn>`).length, 0, "a comment is no button");
assert.deepEqual(
  primaries(`function A() {\n  return <CBtn tone="accent" />;\n}\nfunction B() {\n  return <CBtn tone="accent" />;\n}`).map((h) => h.component),
  ["A", "B"],
);

// Rows, possible primaries and same-file composition.
assert.deepEqual(
  primaries(`function L() {\n  return xs.map((x) => <CBtn tone="accent">{x}</CBtn>);\n}`).map((h) => h.perRow),
  [true],
);
assert.deepEqual(primaries(`<ErrorBlock error={e} onAction={go} />`).map((h) => h.possible), [true]);
assert.equal(primaries(`<ErrorBlock error={e} />`).length, 0, "an ErrorBlock with no onAction has no way out to fill");
assert.equal(primaries(`<ErrorBlock\n  error={e}\n  density="dense"\n  onAction={(id) => go(id)}\n/>`).length, 1, "onAction on its own line");
assert.equal(primaries(`<button className="cbtn cbtn--danger ux-danger-fill">Delete</button>`).length, 1, "a danger fill is filled");
assert.equal(primaries(`<CBtn tone={d ? "danger" : "accent"} className={d ? "ux-danger-fill" : undefined}>OK</CBtn>`).length, 1, "one button counts once");
assert.deepEqual(primaries(`xs.map((x) => <p>don't</p>);\n<CBtn tone="accent" />`).map((h) => h.perRow), [false], "an apostrophe in a row's words");
{
  const c = composed(
    `function Row() {\n  return <CBtn tone="accent" />;\n}\nfunction List() {\n  return <>{xs.map((x) => <Row key={x} />)}<CBtn tone="accent" /></>;\n}`,
  );
  assert.deepEqual(tally(c.get("List")!), { flat: 1, perRow: 1, possible: 0 }, "a same-file child drawn per row");
  const e = composed(`function E() {\n  return <>{xs.map((x) => <ErrorBlock error={x} onAction={go} />)}<ErrorBlock error={y} onAction={go} /></>;\n}`);
  assert.deepEqual(tally(e.get("E")!), { flat: 0, perRow: 1, possible: 1 }, "an error block per row counts per row");
  assert.deepEqual(tally(c.get("Row")!), { flat: 1, perRow: 0, possible: 0 });
}
assert.ok(possibleTags.includes("UnpublishedReleaseBlock"), "the error blocks that render an ErrorBlock are found");

const total = [...units.values()].reduce((n, h) => n + h.length, 0);
console.log(
  `onePrimary: ${total} filled or possible primaries (with same-file children) in ${units.size} components, ` +
    `${BASELINE.length} baselined, ${VIEWS.length} views, none over — ok`,
);
