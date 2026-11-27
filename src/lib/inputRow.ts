/**
 * The CLI's input row as xterm draws it, cell by cell: what tells the member's
 * own typing from the CLI's placeholder (`attention::inputRowHasDraft`).
 */
import type { Terminal as XTerm } from "@xterm/xterm";
import { faintFg, type InputCell } from "./attention";

/** QoL 1.168: the cells of the CLI's input row — the last visible row that
 *  starts with its chevron — as `inputRowHasDraft` reads them; null when the
 *  buffer cannot say (no such row, no cell API). */
export function inputRowCells(term: XTerm, vendor: "claude" | "codex"): InputCell[] | null {
  const buf = term.buffer.active;
  const chevron = vendor === "claude" ? /^[\s│|]*[>❯]/ : /^[\s│|]*›/;
  for (let i = buf.baseY + term.rows - 1; i >= buf.baseY; i--) {
    const line = buf.getLine(i);
    if (!line || !chevron.test(line.translateToString(true))) continue;
    if (typeof line.getCell !== "function") return null;
    const cells: InputCell[] = [];
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      cells.push({
        ch: cell.getChars(),
        plain:
          !cell.isDim() &&
          !cell.isInverse() &&
          !faintFg(
            cell.isFgDefault()
              ? { kind: "default" }
              : cell.isFgRGB()
                ? { kind: "rgb", rgb: cell.getFgColor() }
                : { kind: "palette", index: cell.getFgColor() },
          ),
      });
    }
    return cells;
  }
  return null;
}
