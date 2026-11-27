import { marked } from "marked";
import DOMPurify from "dompurify";

// Configure once: synchronous parsing, GitHub-flavored, line breaks.
marked.setOptions({
  async: false,
  gfm: true,
  breaks: false,
});

/**
 * Renders Markdown source to a sanitized HTML string for preview.
 * Always synchronous; safe for `dangerouslySetInnerHTML`.
 */
export function renderMarkdown(source: string): string {
  const raw = marked.parse(source) as string;
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
  });
}

/**
 * SP-1 walk (Challenger): markdown an agent wrote — a review, a comparison,
 * an audit's report, a Codex answer — is untrusted. Stricter than
 * `renderMarkdown` (kept for the person's own files: the editor's preview,
 * a skill's text): nothing that fetches, overlays or asks for input. An
 * image is drawn as its alt text (no remote or data: fetch); forms and
 * their controls, media and inline `style` are dropped.
 */
const AGENT_FORBID_TAGS = ["form", "input", "button", "textarea", "select", "option", "video", "audio", "source", "picture", "iframe", "object", "embed"];
export function renderAgentMarkdown(source: string): string {
  const raw = marked.parse(source) as string;
  const fragment = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: AGENT_FORBID_TAGS,
    FORBID_ATTR: ["style"],
    RETURN_DOM_FRAGMENT: true,
  });
  // Images as their words, never fetched.
  for (const img of Array.from(fragment.querySelectorAll("img"))) {
    const alt = img.getAttribute("alt") ?? "";
    img.replaceWith(fragment.ownerDocument.createTextNode(alt));
  }
  const holder = fragment.ownerDocument.createElement("div");
  holder.appendChild(fragment);
  return holder.innerHTML;
}

/** Quick check for whether a path looks like a markdown file. */
export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".mdx")
  );
}
