import { confirmChoice } from "../store/confirmStore";
import type { AgentVendor } from "./roleModels";
import { isUnknownModel, unknownModelQuestion } from "./unknownModel";

/** The questions open now, by field and value. */
const open = new Set<string>();

/**
 * 1.176.3: asks whether `value` may be saved. Resolves true for a name the
 * lists hold, an empty one, or one the person confirmed in the sheet — never
 * refuses, "Save it anyway" saves a model the list doesn't have yet. Any
 * other answer (Keep, Esc, the backdrop) is false, as in Program folders.
 * Resolves null when the same field already has a question open for this very
 * value (Enter, then the blur the sheet's focus causes; a pick, then its
 * blur): the open question's own caller decides. Reads and asks; it writes
 * nothing, and the caller saves.
 */
export async function confirmUnknownModel(
  value: string,
  opts: { known: readonly string[] | undefined; vendor: AgentVendor; where: string; extra?: readonly string[] },
): Promise<boolean | null> {
  if (!opts.known || !isUnknownModel(value, opts.known, opts.vendor, opts.extra)) return true;
  const key = `${opts.where}\u0000${value.trim()}`;
  if (open.has(key)) return null;
  open.add(key);
  try {
    const q = unknownModelQuestion(value, opts.where);
    const answer = await confirmChoice({
      title: q.title,
      body: q.body,
      confirmLabel: "Save it anyway",
      cancelLabel: "Keep what was there",
      strongCancel: true,
      cautious: true,
      stacked: true,
    });
    return answer === "confirm";
  } finally {
    open.delete(key);
  }
}
