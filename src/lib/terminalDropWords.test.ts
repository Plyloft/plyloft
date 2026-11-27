// D4 (1.172.2): a terminal's words for a file dragged over it and on its way.
// Run with Node 22+:  node --experimental-strip-types src/lib/terminalDropWords.test.ts
import assert from "node:assert/strict";
import { addingWords, codexChatRefusalWords, dragFileCount, dropHintWords, dropRefusalWords } from "./terminalDropWords.ts";

assert.equal(dropHintWords("claude", 1), "Drop to give Claude this file");
assert.equal(dropHintWords("claude", 3), "Drop to give Claude these files");
assert.equal(dropHintWords("codex", 1), "Drop to give Codex this file");
assert.equal(dropHintWords("codex", 2), "Drop to give Codex these files");
assert.equal(dropHintWords("shell", 1), "Drop to type this file's path");
assert.equal(dropHintWords("shell", 2), "Drop to type these files' paths");
assert.equal(dropHintWords(undefined, 1), "Drop to type this file's path", "no kind: the shell's words");

assert.equal(addingWords(["Screenshot 2026-10-28 at 15.35.12.png"]), "Adding Screenshot 2026-10-28 at 15.35.12.png…");
assert.equal(addingWords(["a.png", "b.png", "c.pdf"]), "Adding 3 files…");

const file = { kind: "file" };
const text = { kind: "string" };
assert.equal(dragFileCount({ items: [file, file, text] }), 2, "only file items count");
assert.equal(dragFileCount({ items: [text], files: [{}, {}, {}] }), 3, "files, when items name none");
assert.equal(dragFileCount({ items: [], files: [] }), 1, "unknown counts as one");
assert.equal(dragFileCount(null), 1);

// 1.174.0 E6 (P23): Codex chat's own words, singular and plural.
assert.equal(
  codexChatRefusalWords(1),
  "Codex chat can't take files. Drop it on a Claude or Codex terminal, or on a card.",
);
assert.equal(
  codexChatRefusalWords(4),
  "Codex chat can't take files. Drop them on a Claude or Codex terminal, or on a card.",
);
assert.equal(dropRefusalWords("codex-chat", 2), codexChatRefusalWords(2));

console.log("terminalDropWords: ok");
