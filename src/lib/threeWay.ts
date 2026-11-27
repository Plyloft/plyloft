/**
 * Skills hub H4 (R3): the line marks of the 3-way Compare. A line of the
 * library's version now, or of this repository's, that the version before
 * doesn't have (counted, so a repeated line added once more is marked once)
 * is marked as changed. Line endings never count.
 */
export interface MarkedLine {
  text: string;
  changed: boolean;
}

function split(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // A final newline is not a line of its own.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function markedLines(base: string | null, text: string | null, marked: boolean): MarkedLine[] {
  if (text == null) return [];
  const lines = split(text);
  if (!marked || base == null) return lines.map((line) => ({ text: line, changed: false }));
  const left = new Map<string, number>();
  for (const line of split(base)) left.set(line, (left.get(line) ?? 0) + 1);
  return lines.map((line) => {
    const count = left.get(line) ?? 0;
    if (count > 0) {
      left.set(line, count - 1);
      return { text: line, changed: false };
    }
    return { text: line, changed: true };
  });
}
