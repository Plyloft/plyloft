// UX language card 5 (GH #100; BOARDS.md §4 "Duplicate (state B)", ADR 0005):
// `Keep both` — the duplicate notice, silenced on This Mac.
//
// ADR 0005 fixed the rule: "A duplicate skill has no winner; its notice can be
// silenced per Mac **until either copy changes**." Two consequences shape
// everything here.
//
// - **Per Mac**, so the record lives in `settings.json`
//   (`settings::LibrarySettings`) and never in `.atelier/workspace.json`. The
//   two copies are the same fact for everyone who opens the repository; one
//   member having read the comparison is not.
// - **Until either copy changes**, so the record carries the content id of each
//   copy instead of a date. Nothing expires on a clock: the record simply stops
//   matching the moment either file hashes to something else, which is exactly
//   what "either copy changed" means. No watcher, no invalidation pass, and no
//   way for a silenced notice to hide an edit.
//
// Pure, so node can test it: the ids are computed from the two `SKILL.md` texts
// the page has already read to draw Compare.

import type { Scope } from "./uxScope.ts";

/** One silenced notice. Mirrors `settings::SilencedDuplicate`. */
export interface SilencedDuplicate {
  /** The two scopes, sorted and joined with `|`. */
  scopes: string;
  /** The skill's directory name — the name both copies carry. */
  name: string;
  /** The content id of each copy, in the same order as `scopes`. */
  contents: string[];
}

/**
 * A stable id for one copy's bytes.
 *
 * Two 32-bit FNV-1a passes over the text with different offset bases, plus its
 * length: a `SKILL.md` is a document a person edits, not an adversary's input,
 * and what this has to survive is an edit — a changed word, a reordered line, a
 * trailing newline. It is not a cryptographic digest and is never treated as
 * one; the only question asked of it is "are these the same bytes we hashed
 * before?", and a difference is what it has to report.
 *
 * Written by hand rather than imported: no hashing dependency is in the tree,
 * and the card forbids adding one. `crypto.subtle` is async and would make every
 * caller — including the render path that decides whether the notice shows — a
 * promise.
 */
export function contentId(text: string): string {
  const pass = (basis: number) => {
    let hash = basis;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      // FNV prime, in 32-bit arithmetic that stays exact under Math.imul.
      hash = Math.imul(hash, 0x0100_0193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  return `${pass(0x811c_9dc5)}-${pass(0x0100_0193)}-${text.length.toString(16)}`;
}

/**
 * The key of a pair of scopes: sorted, so the notice silenced from the
 * repository's page is the same record as the one silenced from the team's.
 *
 * Alphabetical and not `SKILL_SCOPES`' order: the order a list happens to stack
 * its sections in is presentation, and this is an identity that has to hold
 * across versions of that list.
 */
export function scopePairKey(a: Scope, b: Scope): string {
  return [a, b].sort().join("|");
}

/** The two content ids in the same order `scopePairKey` sorted the scopes. */
export function orderedContents(
  a: Scope,
  aContent: string,
  b: Scope,
  bContent: string,
): string[] {
  return a <= b ? [aContent, bContent] : [bContent, aContent];
}

/** What identifies one duplicate notice: the pair, the name, both copies' ids. */
export interface DuplicateIdentity {
  here: Scope;
  there: Scope;
  name: string;
  /** The `SKILL.md` content id of the copy at `here`. */
  hereContent: string;
  /** …and of the copy at `there`. */
  thereContent: string;
}

/** The record `Keep both` writes for `identity`. */
export function silencedRecord(identity: DuplicateIdentity): SilencedDuplicate {
  return {
    scopes: scopePairKey(identity.here, identity.there),
    name: identity.name,
    contents: orderedContents(
      identity.here,
      identity.hereContent,
      identity.there,
      identity.thereContent,
    ),
  };
}

/**
 * Is this notice silenced on this Mac?
 *
 * A record matches only when the pair, the name **and both content ids** agree.
 * That last clause is the expiry: an edit to either copy changes its id, no
 * record matches, and the notice is back — with no stored date to compare and
 * nothing to clean up.
 */
export function isSilenced(
  silenced: readonly SilencedDuplicate[],
  identity: DuplicateIdentity,
): boolean {
  const wanted = silencedRecord(identity);
  return silenced.some(
    (record) =>
      record.scopes === wanted.scopes &&
      record.name === wanted.name &&
      record.contents.length === wanted.contents.length &&
      record.contents.every((id, i) => id === wanted.contents[i]),
  );
}

/**
 * `silenced` with `identity` silenced.
 *
 * The record for this pair and name is **replaced where it stands**, not dropped
 * and appended: a member who edits a skill and presses `Keep both` again means the
 * same thing they meant the first time, and the diff in `settings.json` should be
 * the one line that changed rather than a row moving to the end of the list
 * (review 1 — the doc claimed the order was kept and the code did not keep it). A
 * pair with no record yet is appended.
 */
export function withSilenced(
  silenced: readonly SilencedDuplicate[],
  identity: DuplicateIdentity,
): SilencedDuplicate[] {
  const record = silencedRecord(identity);
  const at = silenced.findIndex(
    (kept) => kept.scopes === record.scopes && kept.name === record.name,
  );
  if (at < 0) return [...silenced, record];
  const next = [...silenced];
  next[at] = record;
  return next;
}
