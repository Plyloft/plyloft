import { test } from "node:test";
import assert from "node:assert/strict";
import { utf16Columns } from "./matchColumns.ts";

test("an ASCII line: bytes and columns agree", () => {
  assert.deepEqual(utf16Columns("const login = 1;", 6, 11), { from: 6, to: 11 });
});

test("accents and emoji before the match move it by their extra bytes", () => {
  // "é" is 2 bytes, "🙂" is 4 bytes and 2 UTF-16 units.
  const line = "é 🙂 login";
  const start = new TextEncoder().encode("é 🙂 ").length;
  assert.deepEqual(utf16Columns(line, start, start + 5), { from: 5, to: 10 });
  assert.equal(line.slice(5, 10), "login");
});

test("out-of-range offsets are clamped to the line", () => {
  assert.deepEqual(utf16Columns("abc", -4, 99), { from: 0, to: 3 });
  assert.deepEqual(utf16Columns("abc", 2, 1), { from: 2, to: 2 });
});
