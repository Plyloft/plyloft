import { fieldById, type MacField } from "../../lib/settingsFields";

/**
 * A settings field by its path, for the pages to bind a control to.
 *
 * It throws on an unknown path rather than returning undefined: a page asking
 * for a field that is not in the map is a page editing a setting with no home,
 * which is exactly what `settingsFields.test.ts` exists to stop — so it fails
 * loudly the first time the page renders, not silently for ever.
 */
export function field(id: string): MacField {
  const f = fieldById(id);
  if (!f) throw new Error(`settings field "${id}" is not in the field → page map`);
  return f;
}
