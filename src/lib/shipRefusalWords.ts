// 1.176.2 (E1, A3-01): `ship.rs` refuses a release in a sentence of its own
// behind a lowercase prefix — "ship_batch blocked: card `X` …" and
// "ship aborted: …". The reason is already in the text; this puts it in
// words. Pure: node runs it (`plainError.test.ts`).

const BATCH = /^ship_batch blocked:\s*card `(.+?)`\s*(.*)$/s;
const ABORTED = /^ship aborted(?: before pushing)?:\s*(.+)$/s;

function curly(text: string): string {
  return text.replace(/`([^`]+)`/g, "“$1”");
}

function sentence(text: string): string {
  const t = text.trim();
  if (t.length === 0) return t;
  const cap = t[0].toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(cap) ? cap : `${cap}.`;
}

/** What a release refused for, in plain words — or null when `raw` isn't
 *  one of the two refusals, or its reason is itself a tool's own text. */
export function decodeShipRefusal(raw: string): string | null {
  const text = raw.trim();
  const batch = BATCH.exec(text);
  if (batch) {
    const title = batch[1];
    const rest = batch[2].trim().replace(/^:\s*/, "");
    const quoted = `“${title}”`;
    if (/^has verify_status\b/.test(rest)) return `${quoted} can't go in this release: its checks haven't passed.`;
    if (/^is already shipped\b/.test(rest)) return `${quoted} is already shipped.`;
    if (/^already landed as a merged pull request\b/.test(rest)) return `${quoted} already landed as a merged pull request.`;
    const conflict = /^has a conflict with (.+?);\s*resolve it from its card \(Fix with the Builder\), then press Finish and check\b/.exec(rest);
    if (conflict) {
      return `${quoted} has a conflict with ${conflict[1]}. Resolve it from its card (Fix with the Builder), then press Finish and check.`;
    }
    if (/^stopped on a conflict when it last shipped\b/.test(rest)) {
      return `${quoted} stopped on a conflict when it last shipped. Ship it again from its card.`;
    }
    const already = /^is already in (.+?) — nothing to ship\b/.exec(rest);
    if (already) return `${quoted} is already in ${already[1]}, so there is nothing to ship.`;
    if (/^has no changes in its copy to ship\b/.test(rest)) return `${quoted} has no changes in its copy to ship.`;
    // "card `X`: {why}" — the why is the backend's own sentence when it is one.
    const why = curly(rest);
    if (/^[A-Z][^`]*\s\S+\s\S+.*[.!?]$/.test(why) && !/os error \d|\bE[A-Z]{3,}\b/.test(why)) {
      return `${quoted} can't go in this release. ${why}`;
    }
    return `${quoted} can't go in this release.`;
  }
  const aborted = ABORTED.exec(text);
  if (aborted) {
    const body = sentence(curly(aborted[1]));
    // A refusal that carries a tool's own text (an OS error, a spawn) stays
    // raw: Details has it.
    if (/os error \d|\bE[A-Z]{3,}\b|\bspawn\b/.test(body)) return null;
    return body;
  }
  return null;
}

/** 1.176.2 (E1, A3-91): `discussion.rs`'s own state words ("sealed
 *  envelope", "invalid-envelope", "artifact") are names a person has never
 *  met. The Rust strings stay (they are the log's); this says them in words. */
export function decodeDiscussionInternal(raw: string): string | null {
  const t = raw.trim();
  const again = "Start the discussion again.";
  if (/^invalid-envelope\b|synthesis artifact is missing disagreementResolutions/i.test(t))
    return `One of the two AIs gave an answer Plyloft couldn't read. ${again}`;
  if (/^discussion sealed envelope is missing|^analysis [A-Z] completed without an artifact/i.test(t))
    return `One of the two AIs stopped before it finished. ${again}`;
  if (/^discussion analysis worker panicked/i.test(t)) return `Plyloft stopped part-way. Nothing was lost. ${again}`;
  if (/^discussion problem is required/i.test(t)) return "A discussion needs a question.";
  if (/^discussion synthesizer must be Claude or Codex/i.test(t))
    return `A discussion needs Claude or Codex to put the answers together. ${again}`;
  return null;
}

/** What `plainError` puts in words before it asks whether text is raw: a
 *  release's refusal, or a discussion's internal state. */
export function decodeBackendRefusal(raw: string): string | null {
  return decodeShipRefusal(raw) ?? decodeDiscussionInternal(raw);
}
