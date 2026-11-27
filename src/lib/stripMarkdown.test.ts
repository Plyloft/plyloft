// Unit tests for the snippet markdown-flattener (src/lib/stripMarkdown.ts).
//
// Atelier has no JS test runner (see docs/PPVP.md Tier 3): this file is a
// self-contained, dependency-free test module — it type-checks under
// `tsc --noEmit` and runs standalone:
//
//     node --experimental-strip-types src/lib/stripMarkdown.test.ts
//
// It exits non-zero on the first failed assertion (an uncaught throw).

import { stripMarkdownInline } from "./stripMarkdown.ts";

let passed = 0;

function eq(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    console.error(`FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
    process.exit(1);
  }
  passed++;
}

// The v1.77 bug on screen: card-driven goals start with "## ".
eq(
  stripMarkdownInline("## Relevant prior learnings - Resolve card runId via x"),
  "Relevant prior learnings - Resolve card runId via x",
  "leading heading marker",
);
eq(stripMarkdownInline("# Bug: archived cards"), "Bug: archived cards", "h1");
eq(
  stripMarkdownInline("**Goal** Simplify the `Kanban` view"),
  "Goal Simplify the Kanban view",
  "emphasis + inline code",
);
eq(
  stripMarkdownInline("> quoted\n\nsecond  line"),
  "quoted second line",
  "quote marker + whitespace collapse",
);
eq(
  stripMarkdownInline("- list item with [a link](https://x.dev) inside"),
  "list item with a link inside",
  "list marker + link text",
);
eq(stripMarkdownInline("plain text stays"), "plain text stays", "no-op");
eq(stripMarkdownInline("   "), "", "whitespace only");

console.log(`stripMarkdown: ${passed} passed`);
