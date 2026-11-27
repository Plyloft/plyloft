import assert from "node:assert/strict";
import { adjacentTile } from "./tileNav.ts";

assert.equal(adjacentTile([], null, 1), null);
assert.equal(adjacentTile(["a"], "a", 1), "a");
assert.equal(adjacentTile(["a", "b", "c"], "a", 1), "b");
assert.equal(adjacentTile(["a", "b", "c"], "c", 1), "a", "wraps forward");
assert.equal(adjacentTile(["a", "b", "c"], "a", -1), "c", "wraps back");
assert.equal(adjacentTile(["a", "b", "c"], "x", 1), "a");
assert.equal(adjacentTile(["a", "b", "c"], null, -1), "c");
console.log("tileNav: all assertions passed");
