// Terminals block P2: when Plyloft may type a member's `/rename` into a
// tile — only at an input line that holds nothing (never a draft, never
// Claude's placeholder). Run by scripts/ppvp-pure-contracts.sh.
import assert from "node:assert/strict";
import { promptInputEmpty } from "./attention.ts";

const claudeBox = (input: string) => ["─".repeat(40), `❯ ${input}`, "─".repeat(40), "  ? for shortcuts"].join("\n");
assert.equal(promptInputEmpty("/usr/local/bin/claude", claudeBox("")), true, "an empty Claude input line");
assert.equal(promptInputEmpty("/usr/local/bin/claude", claudeBox("half a sentence")), false, "a draft is never typed over");
assert.equal(promptInputEmpty("/usr/local/bin/claude", claudeBox('Try "fix lint errors"')), false, "the placeholder reads as text: not empty");
assert.equal(promptInputEmpty("/usr/local/bin/claude", "│ ❯ │"), true, "a boxed empty line");
assert.equal(promptInputEmpty("/opt/codex", ["", "› ", "  ⏎ send"].join("\n")), true, "an empty Codex composer");
assert.equal(promptInputEmpty("/opt/codex", "› refactor this"), false);
assert.equal(promptInputEmpty("/opt/codex", "› Ask Codex to do anything"), true, "Codex's own placeholder is an empty composer");
assert.equal(promptInputEmpty("/usr/local/bin/claude", claudeBox("Ask Codex to do anything")), false, "only Codex's");
assert.equal(promptInputEmpty("/bin/zsh", "% "), false, "a shell: never");
assert.equal(promptInputEmpty("/usr/local/bin/claude", ""), false);
console.log("tileNames.test.ts: the /rename rule");
