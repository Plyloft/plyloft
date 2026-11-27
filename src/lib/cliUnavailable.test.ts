// 1.176.0 R3: the backend's typed "CLI not there" error, read by its shape.
// Run: node --experimental-strip-types src/lib/cliUnavailable.test.ts
import assert from "node:assert/strict";
import { CLI_UNAVAILABLE_PREFIX, decodeCliUnavailable } from "./cliUnavailable.ts";
import { plainCause } from "./plainError.ts";

// As `cli_fresh::unavailable` writes it (cli_fresh_tests.rs holds the Rust side).
const raw =
  'PLY_CLI_UNAVAILABLE_V1:{"tool":"claude","was":"/Users/me/.local/bin/claude"}\n' +
  "claude: not found in PATH. Plyloft looked for it again; it was at /Users/me/.local/bin/claude.";
const decoded = decodeCliUnavailable(raw);
assert.deepEqual(decoded, {
  tool: "claude",
  was: "/Users/me/.local/bin/claude",
  message: "claude: not found in PATH. Plyloft looked for it again; it was at /Users/me/.local/bin/claude.",
});
// Through invoke a refusal arrives as the string, or wrapped in an Error.
assert.deepEqual(decodeCliUnavailable(new Error(raw)), decoded);

const never = decodeCliUnavailable(`${CLI_UNAVAILABLE_PREFIX}{"tool":"codex","was":null}\ncodex: not found in PATH. Plyloft looked for it again.`);
assert.equal(never?.tool, "codex");
assert.equal(never?.was, null);

// Not this shape: anything else a spawn refuses with.
assert.equal(decodeCliUnavailable("spawn: No such file or directory (os error 2)"), null);
assert.equal(decodeCliUnavailable(`${CLI_UNAVAILABLE_PREFIX}{"tool":"zsh"}\nx`), null);
assert.equal(decodeCliUnavailable(`${CLI_UNAVAILABLE_PREFIX}not json\nx`), null);
assert.equal(decodeCliUnavailable(null), null);
assert.equal(decodeCliUnavailable({ tool: "claude" }), null);

// The tile's sentence stays what it was (R7 adds the Repair button).
assert.equal(plainCause(decoded!.message), "The program didn't start.");

console.log("cliUnavailable: all contracts passed");
