/**
 * GH #265: the syntax colours of the Code editor, each a `--syntax-<name>`
 * token in docs/ux-language/tokens.json (light, dark and void). The highlight
 * style (components/editorTheme.ts) names only these; editorSyntax.test.ts
 * holds each to 4.5:1 on the editor's canvas in every theme.
 */
export const SYNTAX_TOKENS = [
  "keyword",
  "string",
  "number",
  "comment",
  "function",
  "type",
  "heading",
  "link",
  "meta",
  "invalid",
] as const;

export type SyntaxToken = (typeof SYNTAX_TOKENS)[number];

/** The CSS custom property a syntax colour is drawn with. */
export const syntaxVar = (name: SyntaxToken): string => `var(--syntax-${name})`;
