/**
 * GH #205 (review 1, m2): how a file indents, read once from its bytes when its
 * editor state is created.
 *
 * Settings › Code › Tab size says "N spaces", and a file that indents with
 * spaces (or with nothing yet) gets N spaces per indent step. A file whose
 * indented lines mostly start with a tab — a Makefile, Go — keeps indenting
 * with tabs: a Makefile recipe indented with spaces does not run, and a Go
 * file is tab-indented by `gofmt`. The rule is a majority of the indented
 * lines; a tie, or no indented line, is spaces. Only the first `SCAN_LINES`
 * lines are read, so a large file costs no more than a small one.
 */
export const SCAN_LINES = 2000;

export function indentsWithTabs(text: string): boolean {
  let tabs = 0;
  let spaces = 0;
  let start = 0;
  for (let line = 0; line < SCAN_LINES && start <= text.length; line += 1) {
    const first = text.charCodeAt(start);
    if (first === 9) tabs += 1; // "\t"
    else if (first === 32) spaces += 1; // " "
    const end = text.indexOf("\n", start);
    if (end === -1) break;
    start = end + 1;
  }
  return tabs > spaces;
}
