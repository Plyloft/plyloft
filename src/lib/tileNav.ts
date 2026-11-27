// QoL 1.168 (D8): moving between tiles by keyboard (⌘⇧] / ⌘⇧[), in the
// grid's own order, round the end. Pure, so node can test it.

/** The tile after (`dir` 1) or before (-1) `current` in `ids`, wrapping;
 *  the first (or last) when `current` is not among them; null with none. */
export function adjacentTile(ids: readonly string[], current: string | null, dir: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = current ? ids.indexOf(current) : -1;
  if (at < 0) return dir === 1 ? ids[0] : ids[ids.length - 1];
  return ids[(at + dir + ids.length) % ids.length];
}
