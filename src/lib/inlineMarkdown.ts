// SP-6: the little markdown a Challenger writes inside a sentence — `code`,
// **bold** and [a link](https://…) — read into tokens, so the card draws
// them as React nodes (`<InlineMd>`), never as HTML. Everything else stays
// the text it was: an unclosed marker is literal, a link that isn't
// http(s) is its own words, and `<script>` is just characters.
//
// Pure — no React — so node runs it (`inlineMarkdown.test.ts`).

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; children: InlineToken[] }
  | { kind: "link"; text: string; href: string };

/** Only a web page is a link; `javascript:`, `file:`, `mailto:` are not. */
const WEB_URL = /^https?:\/\/[^\s<>()"'`]+$/i;
/** Round 2: Unicode format characters (category Cf — the bidi controls
 *  U+202A–U+202E and U+2066–U+2069, U+200E/F, zero-width marks) and
 *  control characters can make a link read as another; such a link is its
 *  own words. The backend refuses them too (`open_web_link`). */
const HIDDEN_CHARS = /[\p{Cf}\p{Cc}]/u;

export function isWebUrl(url: string): boolean {
  return WEB_URL.test(url) && !HIDDEN_CHARS.test(url);
}

function pushText(out: InlineToken[], text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === "text") last.text += text;
  else out.push({ kind: "text", text });
}

/** `[text](https://…)` at `i`: the token and where it ends, or null. */
function linkAt(src: string, i: number): { token: InlineToken; end: number } | null {
  const close = src.indexOf("]", i + 1);
  if (close < 0 || src[close + 1] !== "(") return null;
  const text = src.slice(i + 1, close);
  if (!text || text.includes("[") || text.includes("\n")) return null;
  const end = src.indexOf(")", close + 2);
  if (end < 0) return null;
  const href = src.slice(close + 2, end).trim();
  if (!isWebUrl(href)) return null;
  return { token: { kind: "link", text, href }, end: end + 1 };
}

function tokenize(src: string, allowBold: boolean): InlineToken[] {
  const out: InlineToken[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "`") {
      // A run of backticks closes on the same run (``a ` b``).
      let run = 1;
      while (src[i + run] === "`") run += 1;
      const fence = "`".repeat(run);
      const close = src.indexOf(fence, i + run);
      // Round 2: a code span never crosses a blank line (a new paragraph).
      if (close > i + run && !/\n[ \t]*\n/.test(src.slice(i + run, close))) {
        const raw = src.slice(i + run, close);
        const text = raw.length > 2 && raw.startsWith(" ") && raw.endsWith(" ") ? raw.slice(1, -1) : raw;
        out.push({ kind: "code", text });
        i = close + run;
        continue;
      }
      pushText(out, fence);
      i += run;
      continue;
    }
    if (allowBold && ch === "*" && src[i + 1] === "*") {
      const close = src.indexOf("**", i + 2);
      const inner = close > i + 2 ? src.slice(i + 2, close) : "";
      if (inner && inner.trim() === inner) {
        out.push({ kind: "bold", children: tokenize(inner, false) });
        i = close + 2;
        continue;
      }
      pushText(out, "**");
      i += 2;
      continue;
    }
    if (ch === "[") {
      const link = linkAt(src, i);
      if (link) {
        out.push(link.token);
        i = link.end;
        continue;
      }
    }
    // Plain text up to the next character that could open a marker.
    let next = i + 1;
    while (next < src.length && src[next] !== "`" && src[next] !== "*" && src[next] !== "[") next += 1;
    pushText(out, src.slice(i, next));
    i = next;
  }
  return out;
}

/** The tokens of one line or paragraph of a Challenger's text. */
export function inlineTokens(text: string | null | undefined): InlineToken[] {
  if (!text) return [];
  return tokenize(text, true);
}
