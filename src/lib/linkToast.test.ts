import assert from "node:assert/strict";
import { test } from "node:test";
import { COPY_THE_ADDRESS, LINK_DID_NOT_OPEN_TITLE, linkDidNotOpen } from "./linkToast.ts";

test("E10: a link that didn't open is a warn whose body is the address", () => {
  const t = linkDidNotOpen("https://github.com/o/r/pull/7", new Error("no browser"));
  assert.equal(t.kind, "warn");
  assert.equal(t.title, LINK_DID_NOT_OPEN_TITLE);
  assert.equal(t.title, "The link didn't open");
  assert.equal(t.body, "https://github.com/o/r/pull/7");
  assert.equal(t.details, "no browser");
});

test("E10: its one action copies the address", async () => {
  const writes: string[] = [];
  const t = linkDidNotOpen("https://example.com/a", "denied", {
    writeText: async (s: string) => void writes.push(s),
  });
  assert.equal(t.action.label, COPY_THE_ADDRESS);
  assert.equal(t.action.label, "Copy the address");
  t.action.onClick();
  await Promise.resolve();
  assert.deepEqual(writes, ["https://example.com/a"]);
  assert.equal(t.details, "denied");
});

test("E10: a refused clipboard doesn't throw", () => {
  const t = linkDidNotOpen("https://example.com", null, {
    writeText: () => Promise.reject(new Error("no")),
  });
  assert.doesNotThrow(() => t.action.onClick());
  assert.doesNotThrow(() => linkDidNotOpen("https://example.com", null, undefined).action.onClick());
});
