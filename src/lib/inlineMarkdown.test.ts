// Tier 3 pure-function test (SP-6). Run with Node 22+:
//   node --experimental-strip-types src/lib/inlineMarkdown.test.ts
import assert from "node:assert/strict";
import { inlineTokens, isWebUrl } from "./inlineMarkdown.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

test("plain text is one text token; nothing is none", () => {
  assert.deepEqual(inlineTokens("Saves the theme."), [{ kind: "text", text: "Saves the theme." }]);
  assert.deepEqual(inlineTokens(""), []);
  assert.deepEqual(inlineTokens(null), []);
});

test("code, bold and an http(s) link", () => {
  assert.deepEqual(inlineTokens("`settings.ts` never **saves** it, see [the PR](https://github.com/o/r/pull/7)."), [
    { kind: "code", text: "settings.ts" },
    { kind: "text", text: " never " },
    { kind: "bold", children: [{ kind: "text", text: "saves" }] },
    { kind: "text", text: " it, see " },
    { kind: "link", text: "the PR", href: "https://github.com/o/r/pull/7" },
    { kind: "text", text: "." },
  ]);
  assert.deepEqual(inlineTokens("[docs](http://example.com/a)"), [{ kind: "link", text: "docs", href: "http://example.com/a" }]);
});

test("code inside bold, and a double-backtick span holding a backtick", () => {
  assert.deepEqual(inlineTokens("**use `fit()`**"), [
    { kind: "bold", children: [{ kind: "text", text: "use " }, { kind: "code", text: "fit()" }] },
  ]);
  assert.deepEqual(inlineTokens("`` a ` b ``"), [{ kind: "code", text: "a ` b" }]);
});

test("markers inside code are literal", () => {
  assert.deepEqual(inlineTokens("`**not bold** [x](https://a.b)`"), [{ kind: "code", text: "**not bold** [x](https://a.b)" }]);
});

test("<script> stays text", () => {
  const tokens = inlineTokens("<script>alert(1)</script> and `<b>`");
  assert.deepEqual(tokens, [
    { kind: "text", text: "<script>alert(1)</script> and " },
    { kind: "code", text: "<b>" },
  ]);
});

test("javascript:, file:, mailto: and data: are not links — their words stay as written", () => {
  for (const href of ["javascript:alert(1)", "file:///etc/passwd", "mailto:a@b.c", "data:text/html,x", "JaVaScRiPt:x", "//evil.com"]) {
    const src = `[click](${href})`;
    assert.deepEqual(inlineTokens(src), [{ kind: "text", text: src }], href);
  }
  assert.equal(isWebUrl("https://ok.example/x"), true);
  assert.equal(isWebUrl("https://ok.example/x y"), false);
  assert.equal(isWebUrl("https://a.b/\"onmouseover=x"), false);
});

test("unclosed or empty markers are literal", () => {
  assert.deepEqual(inlineTokens("a `b"), [{ kind: "text", text: "a `b" }]);
  assert.deepEqual(inlineTokens("**open"), [{ kind: "text", text: "**open" }]);
  assert.deepEqual(inlineTokens("****"), [{ kind: "text", text: "****" }]);
  assert.deepEqual(inlineTokens("2 * 3 ** 2"), [{ kind: "text", text: "2 * 3 ** 2" }]);
  assert.deepEqual(inlineTokens("[text](https://a.b"), [{ kind: "text", text: "[text](https://a.b" }]);
  assert.deepEqual(inlineTokens("[text] (https://a.b)"), [{ kind: "text", text: "[text] (https://a.b)" }]);
  assert.deepEqual(inlineTokens("``"), [{ kind: "text", text: "``" }]);
  assert.deepEqual(inlineTokens("arr[0] * 2"), [{ kind: "text", text: "arr[0] * 2" }]);
});

test("a link with a hidden format or control character is its words (round 2)", () => {
  for (const ch of ["\u202E", "\u202A", "\u2066", "\u2069", "\u200E", "\u200F", "\u200B", "\uFEFF", "\u0007"]) {
    const href = `https://github.com/o/r${ch}/pull/7`;
    assert.equal(isWebUrl(href), false, JSON.stringify(ch));
    const src = `[the PR](${href})`;
    assert.deepEqual(inlineTokens(src), [{ kind: "text", text: src }], JSON.stringify(ch));
  }
  // A plain non-ASCII host is still a link.
  assert.equal(isWebUrl("https://例え.jp/a"), true);
});

test("a code span never crosses a blank line (round 2)", () => {
  assert.deepEqual(inlineTokens("`a\n\nb`"), [{ kind: "text", text: "`a\n\nb`" }]);
  assert.deepEqual(inlineTokens("`a\n  \nb`"), [{ kind: "text", text: "`a\n  \nb`" }]);
  // One line break inside is fine.
  assert.deepEqual(inlineTokens("`a\nb`"), [{ kind: "code", text: "a\nb" }]);
});

console.log(`inlineMarkdown: ${passed}/${passed} passed`);
