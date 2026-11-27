/**
 * v1.78.0 (UX revamp Part 2, P2-0 hygiene): flatten a markdown-ish string to
 * plain inline text for one-line snippets. Card-driven swarm goals are built
 * from card title/notes/knowledge, so they routinely start with "## " or carry
 * emphasis markers — rendered literally in snippet contexts before this.
 * Lossy by design: snippets only. Full-fidelity views keep the raw string.
 */
export function stripMarkdownInline(src: string): string {
  return src
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/^[#>\s*-]+/, "") // leading heading/quote/list markers
    .replace(/[*_`~]+/g, "") // emphasis / code fences
    .replace(/\s+/g, " ")
    .trim();
}
