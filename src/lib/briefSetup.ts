/**
 * 1.172.0 (C1; CP-11, CP-12, CF B4): the card page of a card not built yet
 * leads with its brief. Under What you want, one sentence says who builds it,
 * how it asks, and who reviews it, with Change… beside it (the card's own
 * pickers). The names follow the card's Builder and Challenger; the way it
 * asks follows the card's Permissions choice (`cardPermissionsChoice`).
 *
 * Pure — no React, no zustand — so node runs the test.
 */

import type { BuilderPermissions } from "./builderPermissions.ts";

type Vendor = "claude" | "codex";

const NAME: Record<Vendor, string> = { claude: "Claude", codex: "Codex" };

/** How the Builder works in its copy, as a clause of the sentence. */
const HOW: Record<BuilderPermissions, string> = {
  editsCopy: "changing files there without asking",
  asks: "asking you before every change",
  neverAsks: "never stopping to ask (risky)",
};

/** "Claude builds it in a copy of your project, asking you before every
 *  change; Codex reviews it." With one AI for both roles, the review is a
 *  second session of the same one. */
export function briefSetupLine(input: {
  builder: Vendor;
  challenger: Vendor;
  permissions: BuilderPermissions;
  /** 1.175.0 F10: the card's area, said only where there are two or more —
   *  the one fact the sentence didn't say (the facts line waits for the
   *  first build). */
  area?: { name: string; areas: number } | null;
}): string {
  const { builder, challenger, permissions, area } = input;
  const goes = area && area.areas >= 2 && area.name.trim() ? ` It goes to ${area.name.trim()}.` : "";
  const reviewer = challenger === builder ? `a second ${NAME[challenger]} session` : NAME[challenger];
  // 1.175.0 F9 (owner I1): with "asks", Claude follows its own setting.
  const how = permissions === "asks" && builder === "claude" ? "with its own permission setting" : HOW[permissions];
  return `${NAME[builder]} builds it in a copy of your project, ${how}; ${reviewer} reviews it.${goes}`;
}

/** 1.176.3 (first ten minutes): the two sentences after it, always shown
 *  before the build — whose plans it uses, and that it can be undone. The
 *  plans are the Builder's and the Reviewer's own (Claude, ChatGPT), never
 *  an API key of Plyloft's; one AI for both roles names one plan. */
export function briefSetupMore(builder: Vendor, challenger: Vendor = builder): string {
  const plan = (v: Vendor) => (v === "codex" ? "ChatGPT" : "Claude");
  const uses =
    builder === challenger
      ? `your own ${plan(builder)} plan, the same allowance as when you use ${builder === "codex" ? "Codex" : "Claude"} yourself`
      : `your own ${plan(builder)} and ${plan(challenger)} plans, the same allowance as when you use them yourself`;
  return `It uses ${uses}. Your project does not change until you ship the result. You can delete the card, and its copy once it has one, from its ⋯ menu.`;
}

/** The press beside the sentence, and what it does. */
export const BRIEF_SETUP_CHANGE_LABEL = "Change…";
// 1.175.0 F10: one Change…, under the sentence before the build.
export const BRIEF_SETUP_CHANGE_TITLE = "Choose the Builder, how it works and the models.";

/** 1.175.0 F10 (UX-10): the facts a card not built yet still shows in its
 *  line — every one but those the sentence under What you want says: who
 *  builds it, how, who reviews it. Its other facts stay — its area with
 *  where its cards go (the sentence names only the area), what it waits
 *  for (each card a link with its state's dot), a follow-up's link, a
 *  teammate's issue, what waits for it. */
export function factsBeforeBuild<T extends { label: string }>(facts: readonly T[]): T[] {
  const said = new Set(["Builder", "Permissions", "Reviewer"]);
  return facts.filter((f) => !said.has(f.label));
}


/** 1.172.0 (C1, CP-13): the brief's plan heading — the text Start build
 *  sends, once a planning conversation wrote it. */
export const BRIEF_PLAN_LABEL = "The plan (what the Builder follows)";
/** The old "Notes for the Builder" (the card's `knowledge`), in the brief. */
export const BRIEF_MORE_DETAIL_LABEL = "More detail (optional)";

/** The card's Now offers planning before Start build: "Plan it first ▾". */
export const PLAN_FIRST_MENU_LABEL = "Plan it first";
