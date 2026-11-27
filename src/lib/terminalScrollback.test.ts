// QoL 1.168 (D3): Settings › Scrollback reaches xterm.
import assert from "node:assert/strict";
import { shellTileTerminalOptions, terminalScrollback } from "./commandBlocks.ts";

assert.equal(terminalScrollback(20000), 20000);
assert.equal(terminalScrollback(10), 500);
assert.equal(terminalScrollback(1e9), 100_000);
assert.equal(terminalScrollback("x"), 5000);
assert.equal(terminalScrollback(undefined), 5000);
assert.equal(shellTileTerminalOptions({}, 12000).scrollback, 12000);
assert.equal(shellTileTerminalOptions({}).scrollback, 5000);
// QoL 1.168 (block 10, A7): Text size and Screen reader support.
assert.equal(shellTileTerminalOptions({}).fontSize, 13);
assert.equal(shellTileTerminalOptions({}).screenReaderMode, false);
assert.equal(shellTileTerminalOptions({}, 5000, { textSize: 17, screenReader: true }).fontSize, 17);
assert.equal(shellTileTerminalOptions({}, 5000, { textSize: 17, screenReader: true }).screenReaderMode, true);
assert.equal(shellTileTerminalOptions({}, 5000, { textSize: null }).fontSize, 13);
console.log("terminalScrollback: all assertions passed");
