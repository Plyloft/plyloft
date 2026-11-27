import type { MouseEvent, ReactNode } from "react";
import { openWebLink } from "../ipc";
import { inlineTokens, type InlineToken } from "../lib/inlineMarkdown";
import { pushToast } from "../store/toastStore";
import { linkDidNotOpen } from "../lib/linkToast";

/**
 * SP-6: a Challenger's sentence with its inline markdown drawn — `code` in
 * mono, **bold** in 600, an http(s) link that opens in the browser. React
 * nodes only: no HTML is ever parsed, so `<script>` is shown as text.
 * Inside a control (a finding's title in its `<summary>` or toggle) pass
 * `links={false}`: a link there would be a control in a control, so it is
 * drawn as its words.
 */
export function InlineMd({ text, links = true }: { text: string | null | undefined; links?: boolean }) {
  return <>{nodes(inlineTokens(text), "", links)}</>;
}

function nodes(tokens: InlineToken[], prefix: string, links: boolean): ReactNode[] {
  return tokens.map((t, i) => {
    const key = `${prefix}${i}`;
    switch (t.kind) {
      case "text":
        // A bare string: the sentence stays one run of text where it has
        // no markers, as it was before.
        return t.text;
      case "code":
        return (
          <code key={key} className="ux-md-code">
            {t.text}
          </code>
        );
      case "bold":
        return (
          <strong key={key} className="ux-md-bold">
            {nodes(t.children, `${key}.`, links)}
          </strong>
        );
      case "link":
        if (!links) return t.text;
        return (
          <a
            key={key}
            className="ux-md-link"
            href={t.href}
            title={t.href}
            onClick={(e) => openLink(e, t.href)}
            onAuxClick={(e) => openLink(e, t.href)}
          >
            {t.text}
          </a>
        );
    }
  });
}

/** The page never navigates: the backend hands the link to the browser. */
function openLink(e: MouseEvent, href: string) {
  e.preventDefault();
  void openWebLink(href).catch((err: unknown) =>
    pushToast(linkDidNotOpen(href, err)),
  );
}
