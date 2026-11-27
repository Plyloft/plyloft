// G10 (1.170.0): the words a person may not know, defined where they
// appear: a help mark beside the sentence, whose hover says what the word
// means and whose press opens the guide's glossary ("Words you'll see",
// USER_GUIDE.md §4, published at /docs/guide/). Pure: node runs
// `glossary.test.ts`.

/** The guide's glossary on the site (github-slugger's anchor of "Words
 *  you'll see"). */
export const GLOSSARY_URL = "https://www.plyloft.com/docs/guide/#words-youll-see";

export type GlossaryWord = "pull request" | "round" | "Reviewer" | "second opinion";

/** Next improvement's own word (owner D11, 1.174.0 TX3), re-exported by
 *  `words.ts`: the separate pass that sets aside ideas that only add. It is
 *  never the Reviewer's name. */
export const SECOND_OPINION: GlossaryWord = "second opinion";

/** Each word's definition, in the glossary's own words. */
export const GLOSSARY: Record<GlossaryWord, string> = {
  "pull request": "A pull request is GitHub's request to add a change, where it can be read before it's merged.",
  round:
    "A round is one saved pass of the Builder's work: each Finish and check makes one, and the Reviewer reviews it.",
  // 1.171.0 C3 (CF9, CP-10; owner D1: the name stays, explained where a
  // new person first meets it — the card's facts line).
  Reviewer: "The Reviewer is a second AI that reviews the change; it can't edit.",
  // B3 (1.174.0, owner D11): Next improvement's own word for its separate
  // pass, kept there only (ux-check bans it elsewhere). Not shown by any
  // surface yet; the guide's "Words you'll see" has its row (TX3, no hover).
  "second opinion":
    "A second opinion is Next improvement's second pass, by the other AI or by the same one in a separate session, that sets aside ideas that only add. It isn't the Reviewer, which reads a card's work.",
};

/** The term's hover text: the definition, and what a press does. */
export function termTitle(word: GlossaryWord): string {
  return `${GLOSSARY[word]} Press for the glossary.`;
}

/** The help mark's name, read aloud ("What a pull request is"). */
export function termLabel(word: GlossaryWord): string {
  return word === "Reviewer" ? "What the Reviewer is" : `What a ${word} is`;
}

/** Which of `words` `text` uses, whole words in any case ("Pull requests"
 *  counts, "around" doesn't), in the order they first appear. */
export function glossaryWordsIn(text: string, words: readonly GlossaryWord[]): GlossaryWord[] {
  return words
    .map((word) => ({ word, at: new RegExp(`\\b${word.replace(/ /g, "\\s+")}s?\\b`, "i").exec(text)?.index ?? -1 }))
    .filter((hit) => hit.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((hit) => hit.word);
}
