import { useEffect, useState, type MouseEvent } from "react";
import { openWebLink } from "../ipc";
import { pushToast } from "../store/toastStore";
import { linkDidNotOpen } from "../lib/linkToast";

/**
 * A reviewer's own words in full markdown — headings, lists, code — as the
 * result's "Why?" and Build with both's "The Challenger's answer" show them
 * (Windows parity walk: both showed "## Verdict" and backticks raw).
 *
 * `lib/markdown` (marked + DOMPurify) is imported lazily, as the audit's
 * report and the Library's skills do, so its chunk stays out of the main
 * bundle; DOMPurify sanitises the HTML before it is set. Until it is ready
 * (or if it cannot load) the text is shown as it was written. A link never
 * navigates the page: the backend hands it to the browser.
 */
export function MarkdownText({ text }: { text: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    import("../lib/markdown")
      .then(({ renderAgentMarkdown }) => {
        if (!cancelled) setHtml(renderAgentMarkdown(text));
      })
      .catch(() => {
        // The text as written stays: still readable.
      });
    return () => {
      cancelled = true;
    };
  }, [text]);

  if (html == null) return <p className="ux-card-critique">{text}</p>;
  return (
    <div
      className="ux-card-report"
      data-ply-markdown=""
      onClick={openLink}
      onAuxClick={openLink}
      // Sanitized via DOMPurify in renderAgentMarkdown.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function openLink(e: MouseEvent<HTMLElement>) {
  const a = (e.target as Element | null)?.closest?.("a");
  if (!a || !e.currentTarget.contains(a)) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  if (!/^https?:\/\//i.test(href)) return;
  void openWebLink(href).catch((err: unknown) =>
    pushToast(linkDidNotOpen(href, err)),
  );
}
