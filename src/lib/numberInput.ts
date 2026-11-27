/**
 * 1.176.2 (A5F-09, A5F-10): what a typed number means
 * before a settings field stores it. Pure, so node and vitest read it alike.
 *
 * A number is a whole number, written as the field's own hint writes it
 * (`100,000`, `50 000`, `30 days`). Anything else is refused with a sentence;
 * it is never turned into "no limit" or into the default behind the person's
 * back.
 */

export type NumberReading =
  | { ok: true; value: number | null }
  | { ok: false; message: string };

/** A whole number written with thousands separators or a unit word, or
 *  null when the text is not one. */
export function wholeNumberOf(raw: unknown, units: readonly string[] = []): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== "string") return null;
  let t = raw.replace(/[  ]/g, " ").trim();
  for (const u of units) {
    const m = new RegExp(`^(.*?)\\s*${u}$`, "i").exec(t);
    if (m && m[1].trim() !== "") {
      t = m[1].trim();
      break;
    }
  }
  if (/^\d+$/.test(t)) return Number(t);
  if (/^\d{1,3}([,. ]\d{3})+$/.test(t)) return Number(t.replace(/[,. ]/g, ""));
  return null;
}

/** A limit that may be left empty (empty = no limit) and is otherwise at
 *  least 1. `noun` is "days" or "runs". */
export function readLimit(raw: unknown, noun: "days" | "runs", emptyMeans: string): NumberReading {
  if (raw == null || (typeof raw === "string" && raw.trim() === "")) return { ok: true, value: null };
  const n = wholeNumberOf(raw, [noun, noun.replace(/s$/, "")]);
  if (n === null) {
    return { ok: false, message: `That isn't a number of ${noun}. Type a whole number such as 30, or leave it empty${emptyMeans}.` };
  }
  if (n < 1) {
    return { ok: false, message: `0 isn't a number of ${noun} to keep. Type 1 or more, or leave it empty${emptyMeans}.` };
  }
  return { ok: true, value: n };
}

/** A number the field clamps into `min`…`max`; text that is not a number is
 *  refused (an empty box is for the caller to read as its default). */
export function readClamped(
  raw: unknown,
  min: number,
  max: number,
  noun: string,
  units: readonly string[] = [],
): NumberReading {
  const n = wholeNumberOf(raw, units);
  if (n === null) {
    return { ok: false, message: `That isn't a number. Type a whole number of ${noun}, from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}.` };
  }
  return { ok: true, value: Math.max(min, Math.min(max, n)) };
}
