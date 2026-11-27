/**
 * GH #265: Ply's own editor theme — one extension for light, dark and void.
 *
 * Replaces stock One Dark (a grey-blue #282c34 slab, 3.9:1 comments and line
 * numbers, red Markdown headings) and the light CodeMirror default. Every
 * colour is a token: the chrome reads `--term-bg`, `--fg`, `--muted`,
 * `--hover`, `--selected`; the highlight style reads the `--syntax-*`
 * tokens (docs/ux-language/tokens.json, held to 4.5:1 by
 * lib/editorSyntax.test.ts). Because the values are CSS variables, the theme
 * follows the page's `data-theme` by itself — void's black canvas included,
 * which One Dark's own background used to override.
 *
 * Two EditorView.theme copies differ only in CodeMirror's `dark` flag (its
 * base styles for scrollbars and the like); the rules are the same.
 */
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import { syntaxVar as v } from "../lib/editorSyntax";

const CHROME = {
  "&": {
    color: "var(--fg)",
    backgroundColor: "var(--term-bg)",
  },
  ".cm-content": {
    caretColor: "var(--claude-accent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--claude-accent)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: "var(--selected)",
    },
  ".cm-activeLine": {
    backgroundColor: "var(--hover)",
  },
  ".cm-selectionMatch": {
    backgroundColor: "var(--selected)",
  },
  "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
    backgroundColor: "var(--selected)",
    outline: "1px solid var(--border-strong)",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--hover)",
    outline: "1px solid var(--border-strong)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--selected)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--term-bg)",
    color: "var(--muted)",
    border: "none",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--hover)",
    color: "var(--fg)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--hover)",
    border: "none",
    color: "var(--muted)",
  },
  ".cm-panels": {
    backgroundColor: "var(--panel-bg)",
    color: "var(--fg)",
  },
  ".cm-panels.cm-panels-top": {
    borderBottom: "1px solid var(--border)",
  },
  ".cm-panels.cm-panels-bottom": {
    borderTop: "1px solid var(--border)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--raised)",
    color: "var(--fg)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-md)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--selected)",
    color: "var(--fg)",
  },
};

const THEME_LIGHT = EditorView.theme(CHROME, { dark: false });
const THEME_DARK = EditorView.theme(CHROME, { dark: true });

/** Token names follow One Dark's grouping, onto Ply's ten syntax colours. */
export const PLY_HIGHLIGHT = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: v("keyword") },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.escape], color: v("string") },
  { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.name), t.standard(t.name)], color: v("number") },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: v("comment"), fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: v("function") },
  { tag: [t.typeName, t.className, t.namespace, t.annotation, t.self], color: v("type") },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: v("heading"), fontWeight: "600" },
  { tag: [t.link, t.url], color: v("link"), textDecoration: "underline" },
  { tag: [t.meta, t.processingInstruction, t.attributeName, t.documentMeta, t.labelName], color: v("meta") },
  { tag: t.invalid, color: v("invalid") },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
]);

/** The syntax colours: the same in every theme (the tokens change). */
export const PLY_SYNTAX: Extension = syntaxHighlighting(PLY_HIGHLIGHT);

/** The theme compartment's contents, by the app's theme. Module constants,
 *  so a stored state can be compared by identity (`Compartment.get`). */
export const EDITOR_THEME_LIGHT: Extension = [THEME_LIGHT];
export const EDITOR_THEME_DARK: Extension = [THEME_DARK];

export function editorTheme(theme: string): Extension {
  return theme === "dark" || theme === "void" ? EDITOR_THEME_DARK : EDITOR_THEME_LIGHT;
}
