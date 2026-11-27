/**
 * Team walk 2026-10-01 (F10): the empty Board's "What do you want to build?"
 * box takes a sentence or a paragraph. A card's title is a name on the Board,
 * so it gets the first sentence, kept short on a word boundary; the whole
 * text goes to What you want whenever the title does not already say it all.
 */

/** About as long as a Board card shows on one or two lines. */
export const HERO_TITLE_MAX = 60;

const HAS_WORD = /[\p{L}\p{N}]/u;
/** Punctuation and spaces before the first letter or digit ("... fix it"). */
const LEADING_MARKS = /^[^\p{L}\p{N}]+/u;
/**
 * Where the first sentence ends: a line break; `!` or `?` before a space or
 * the end; a full stop only before a space and a capital, or at the end — so
 * "the U.S. map" and "sum.js" stay inside the sentence.
 */
const SENTENCE_END = /\n|[!?](?=\s|$)|\.(?=\s+\p{Lu}|\s*$)/u;

function withoutEndMark(text: string): string {
  return text.replace(/[.!?]+$/, "").trim();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `text` cut to `max` code points (an emoji is never split), on a word
 *  boundary when there is one, with "…". */
function capped(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  const cut = points.slice(0, max + 1).join("");
  const space = cut.lastIndexOf(" ");
  const kept = space > 0 ? cut.slice(0, space) : points.slice(0, max).join("");
  return `${kept.replace(/[\s,;:–-]+$/, "")}…`;
}

/** The card the hero starts from `text`, or null when there is nothing to
 *  name one by (empty, or no letter or digit at all). */
export function cardFromHeroText(text: string): { title: string; notes?: string } | null {
  const full = text.trim();
  if (!HAS_WORD.test(full)) return null;
  const body = full.replace(LEADING_MARKS, "");
  const end = body.search(SENTENCE_END);
  let title = capped(
    withoutEndMark(oneLine(end === -1 ? body : body.slice(0, end))),
    HERO_TITLE_MAX,
  );
  if (!title) title = capped(oneLine(body), HERO_TITLE_MAX);
  // The title is the whole thing (give or take a final full stop): no notes.
  if (title === withoutEndMark(oneLine(body))) return { title };
  return { title, notes: full };
}
