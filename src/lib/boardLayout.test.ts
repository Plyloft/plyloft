// 1.172.0 B3 (walk 2026-10-27, Mac and Windows): the Board's five columns fit
// a 1280 px window with the sidebar at its widest — Done is never cut off nor
// behind a sideways scroll. jsdom lays nothing out, so this adds up the
// widths board.css asks for: the columns' minimums, the gaps between them,
// the row's side padding, and the sidebar.
//
//     node --experimental-strip-types src/lib/boardLayout.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ATTENTION_COLUMNS } from "./boardSemantics.ts";
import { SIDEBAR_MAX_WIDTH } from "./sidebarLayout.ts";

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const board = strip(readFileSync(new URL("../components/board.css", import.meta.url), "utf8"));
const app = strip(readFileSync(new URL("../App.css", import.meta.url), "utf8"));

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.search(new RegExp(`(^|\\})\\s*${selector.replace(/[.\-[\]>]/g, (c) => `\\${c}`)}\\s*\\{`));
  assert.ok(at >= 0, `board.css has ${selector}`);
  const open = css.indexOf("{", at + 1);
  return css.slice(open + 1, css.indexOf("}", open));
}

function prop(body: string, name: string): string {
  const m = new RegExp(`(?:^|;|\\s)${name}\\s*:\\s*([^;]+);`).exec(body);
  assert.ok(m, `has ${name}`);
  return m![1].trim();
}

/** px of a length: `220px` or `var(--space-md)` (App.css's token, which
 *  may itself name another: `--board-inset: var(--space-2xl)`). */
function px(value: string): number {
  const v = /^var\((--[\w-]+)\)$/.exec(value);
  if (v) {
    const m = new RegExp(`${v[1]}\\s*:\\s*([^;]+);`).exec(app);
    assert.ok(m, `App.css defines ${v[1]}`);
    return px(m![1].trim());
  }
  const m = /^(\d+)px$/.exec(value);
  assert.ok(m, `a px length: ${value}`);
  return Number(m![1]);
}

const row = rule(board, ".board-columns");
const gap = px(prop(row, "gap"));
// `padding: 0 <sides> <bottom>`.
const sides = px(prop(row, "padding").split(/\s+/)[1]!);
const column = px(prop(rule(board, ".board-column"), "min-width"));
const empty = px(prop(rule(board, ".board-column--empty"), "min-width"));

const n = ATTENTION_COLUMNS.length;
assert.equal(n, 5);
const need = (minimums: number) => minimums + (n - 1) * gap + 2 * sides;

// Windows draws a frame inside the 1280: keep 16 px for it.
const STAGE = 1280 - 16 - SIDEBAR_MAX_WIDTH;
assert.ok(need(n * column) <= STAGE, `five columns with cards need ${need(n * column)} px; the stage has ${STAGE}`);
// An empty column is narrower than one with cards (1.171.0 E3).
assert.ok(empty < column);
// A column with cards still has room for a tile's words.
assert.ok(column >= 150, `a column is at least 150 px (${column})`);

// 1.172.2 (D6, owner walk 2026-10-28): the adoption banner sits with the
// page — the Board's inset left and right, the one its columns, list, status
// line and archive use — and its padding is even on both sides.
const BOARD_INSET = "var(--board-inset)";
assert.equal(prop(row, "padding").split(/\s+/)[1], BOARD_INSET);
assert.equal(prop(rule(board, ".board-list"), "padding").split(/\s+/)[1], BOARD_INSET);
assert.equal(prop(rule(board, ".board-status-line"), "padding").split(/\s+/)[1], BOARD_INSET);
assert.equal(prop(rule(board, ".board-archive"), "margin").split(/\s+/)[1], BOARD_INSET);
assert.equal(prop(rule(board, ".board-filter-empty"), "padding").split(/\s+/)[1], BOARD_INSET);
// 1.174.0 (A4): the notes' one slot (the adoption banner, the areas and
// the project folder inside it) sits in the Board's inset; a note inside
// draws no box of its own.
const ux = strip(readFileSync(new URL("../components/ux/ux.css", import.meta.url), "utf8"));
assert.equal(prop(rule(ux, ".ux-notes"), "margin").split(/\s+/)[1], BOARD_INSET);
assert.equal(prop(rule(board, ".ux-notes-item > .adoption-banner"), "margin"), "0");
assert.equal(prop(rule(board, ".ux-notes-item > [data-ply-folder-state] .ux-callout"), "max-width"), "none");
const banner = rule(app, ".adoption-banner");
const [, bannerSides] = prop(banner, "margin").split(/\s+/);
assert.equal(bannerSides, BOARD_INSET, "the banner's left and right margin is the Board's inset");
const bannerPadding = prop(banner, "padding").split(/\s+/);
assert.equal(bannerPadding.length, 2, `even padding: \`<block> <inline>\` (${bannerPadding.join(" ")})`);
assert.equal(prop(banner, "align-items"), "center");
assert.equal(prop(banner, "flex-wrap"), "wrap");
// Calm surface: no coloured left bar.
assert.ok(!/border-left/.test(banner), "no left bar on the banner");
assert.equal(px(BOARD_INSET), 32);

// 1.174.0 (A4, P3 BCI-2): Next improvement's box has a height — 40vh,
// about 290 px at 820 — and scrolls inside, so the Board stays in view.
// The whole box, its head staying while the ideas scroll.
const niBoxes = [...app.matchAll(/(?:^|\})\s*\.ni\s*\{([^}]*)\}/g)].map((m) => m[1]);
assert.ok(niBoxes.some((b) => /max-height:\s*40vh/.test(b) && /overflow-y:\s*auto/.test(b)), ".ni has max-height 40vh and scrolls");
const head = rule(app, ".ni > .ni-head");
assert.equal(prop(head, "position"), "sticky");
assert.equal(prop(head, "top"), "0");

console.log("boardLayout.test.ts: ok");
