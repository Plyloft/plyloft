// GH #205 (review 1, m2): the indentation rule the editor reads a file with.
import assert from "node:assert/strict";

import { indentsWithTabs, SCAN_LINES } from "./indentStyle.ts";

// A Makefile recipe and a gofmt'd function: tabs.
assert.equal(indentsWithTabs("all:\n\tcc -o x x.c\n\tstrip x\n"), true);
assert.equal(indentsWithTabs("func main() {\n\tif x {\n\t\ty()\n\t}\n}\n"), true);
// Spaces, and nothing indented at all: spaces.
assert.equal(indentsWithTabs("function f() {\n  return 1;\n}\n"), false);
assert.equal(indentsWithTabs("one\ntwo\n"), false);
assert.equal(indentsWithTabs(""), false);
// The majority decides; a tie is spaces.
assert.equal(indentsWithTabs("a\n\tb\n\tc\n  d\n"), true);
assert.equal(indentsWithTabs("a\n\tb\n  c\n"), false);
// Go's block comments (" *") are outvoted by the tab-indented code.
assert.equal(indentsWithTabs("/*\n * doc\n */\nfunc f() {\n\ta()\n\tb()\n\tc()\n}\n"), true);
// Only the head of a large file is read.
const head = "x\n".repeat(SCAN_LINES);
assert.equal(indentsWithTabs(head + "\tlate\n".repeat(10)), false);

console.log("indentStyle.test.ts: all assertions passed");
