// 1.175.0 F8: the one quiet note under Now's primary — why a way isn't
// offered, or an offer beside it. Errors have no part in it: an error leads
// Now itself (`cardErrorNow.ts`).
//
// Several cards add a note here (F3: a project only on this computer; F7:
// the "Turn on" offer of Fix failing checks by itself). F8 round 2: each
// note is one entry of `NOW_NOTES` with its own rank, on its own lines, so
// the cards don't touch each other's: a card adds its id to `NowNoteId`, its
// entry with a rank no other note has, and its field in the input. At most
// one note shows: the lowest rank that applies.
//
// Pure: node runs `cardErrorNow.test.ts`.

/** The notes there are, by who says them. */
export type NowNoteId =
  /** 1.175.0 F3: a project only on this computer says so under Ship it,
   *  with Put it on GitHub… (`putOnGithub.ts`'s `putOnGithubNote`); right
   *  after, where it now is. */
  | "putOnGithub"
  /** 1.169.1 walk (R10): Ready to ship on a project that can't open pull
   *  requests says why under its Ship it. */
  | "noPullRequest"
  /** 1.175.0 F7 (I9): the "Turn on" offer of Fix failing checks by itself,
   *  under Fix with the Builder (`prAutoFixOffer.ts`'s `autoFixOffered`). */
  | "autoFixOffer";

/** Each note's rank: the lowest that applies is the one shown. Leave gaps
 *  so a new note can go between two. */
export const NOW_NOTES: Readonly<Record<NowNoteId, { rank: number }>> = {
  putOnGithub: { rank: 40 },
  noPullRequest: { rank: 50 },
  autoFixOffer: { rank: 60 },
};

/** What the card page knows, one field per note: its words, or null when
 *  it doesn't apply. */
export type NowNoteInput = Partial<Record<NowNoteId, string | null | undefined>>;

export interface NowNote {
  id: NowNoteId;
  text: string;
}

/** The note under Now's primary, or null. */
export function nowNote(input: NowNoteInput): NowNote | null {
  const id = nowNoteId(Object.fromEntries(Object.entries(input).map(([k, t]) => [k, !!t && !!t.trim()])));
  return id ? { id, text: input[id]! } : null;
}

/** Which note shows, for notes that draw their own line and presses (F3,
 *  F7): the lowest rank among those that apply, or null. */
export function nowNoteId(applies: Partial<Record<NowNoteId, boolean>>): NowNoteId | null {
  const ids = (Object.keys(NOW_NOTES) as NowNoteId[]).sort((a, b) => NOW_NOTES[a].rank - NOW_NOTES[b].rank);
  return ids.find((id) => applies[id]) ?? null;
}
