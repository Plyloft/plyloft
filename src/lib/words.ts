import { stripCliMarks } from "./cliNotStarting.ts";
// G2 (1.173.0, owner decisions 1 and 6): the one module for the words the
// app shares across surfaces. It starts from the glossary and the *Words.ts
// modules, which stay where they are (their importers keep working) and are
// re-exported from here; new shared words go here.
//
// The role names: the second AI that reviews a card is the **Reviewer** on
// screen, in the guide and on GitHub. Its saved ids keep the old name — the
// `challenger` role, the `challenger-reviewing` state, `reviewerSource:
// "challenger"` — and are mapped here, for display only (PATTERNS.md:
// persisted ids never change).
//     node --experimental-strip-types src/lib/words.test.ts

export * from "./glossary.ts";
export * from "./checksWords.ts";
export * from "./compareWords.ts";
export * from "./copyWords.ts";
export * from "./deliveryWords.ts";
export * from "./historyWords.ts";
export * from "./niDirectionWords.ts";
export * from "./notificationAccessWords.ts";
export * from "./terminalDropWords.ts";
export * from "./updateWords.ts";

/** The reviewing AI's name, wherever a person reads it. */
export const REVIEWER = "Reviewer";
/** The building AI's name. */
export const BUILDER = "Builder";

/** A role's saved id (`"builder"`, `"challenger"`) → the word on screen. */
export const ROLE_WORDS: Readonly<Record<"builder" | "challenger", string>> = {
  builder: BUILDER,
  challenger: REVIEWER,
};

/** The role's word for a saved id; an unknown id reads as itself. */
export function roleWord(role: string): string {
  return (ROLE_WORDS as Record<string, string>)[role] ?? role;
}

/** Text saved before 1.173.0 — a review's failure reason, a shipped
 *  card's "Last commit not reviewed by the Challenger" line, an override
 *  note — names the Reviewer by its old name. Shown, it reads the new one;
 *  the saved text is left as it is. */
export function reviewerWords<T extends string | null | undefined>(text: T): T {
  if (typeof text !== "string") return text;
  // 1.176.0 R7: a saved "No eligible reviewer: …" may carry the mark of a
  // CLI that doesn't start (`lib/cliNotStarting`): never shown.
  return stripCliMarks(text)
    .replace(/\bChallenger(s?)\b/g, "Reviewer$1")
    // TX3 round 1 (1.174.0): the menu item's old name in a skipped-review
    // line saved before the rename (`builder.rs` `reviewer_words`).
    .replace(/Check without the second AI['\u2019]s review/g, "Check without the Reviewer") as T;
}

/** The old improvement proposal (GH #104, `proposals.rs`): a change the
 *  Reviewer suggests to a skill or an instruction file after a card met
 *  friction. "Next improvement" is the product's own, and keeps its name. */
export const SUGGESTED_SKILL_CHANGE = "Suggested skill change";
export const SUGGESTED_SKILL_CHANGES = "Suggested skill changes";
