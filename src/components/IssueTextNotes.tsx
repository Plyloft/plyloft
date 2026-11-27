// 1.175.0 (B3; review SEC-8, mockup consents.html#b3): what the card page
// says of an issue's text — the parts GitHub hides, listed under the brief,
// and Now's sentence when somebody outside the repository wrote the issue.
import { useMemo, type ReactNode } from "react";
import { Icon } from "./ux";
import { machineWords } from "../lib/platform";
import {
  hiddenPartLabel,
  hiddenParts,
  hiddenPartsHeading,
  hiddenPartsNote,
  outsideSentence,
} from "../lib/issueText";

/** Under the brief of a card of an issue: each HTML comment in it, which
 *  GitHub doesn't show to who reads the issue there. For every such card,
 *  whoever wrote it. Nothing when the text has none. */
export function HiddenParts({ text }: { text: string }) {
  const parts = useMemo(() => hiddenParts(text), [text]);
  if (parts.length === 0) return null;
  const one = parts.length === 1;
  return (
    <div className="ux-card-hidden" data-ply-card-hidden="">
      {!one && (
        <p className="ux-card-hidden-head">
          <Icon name="hiddenText" size="sm" />
          {hiddenPartsHeading(parts)}
        </p>
      )}
      {parts.map((part, i) => (
        <div key={`${part.line}-${i}`} className="ux-card-hidden-part" data-ply-card-hidden-part="">
          <p className="ux-card-hidden-head">
            {one && <Icon name="hiddenText" size="sm" />}
            {one ? hiddenPartsHeading(parts) : hiddenPartLabel(part)}
          </p>
          <code>{part.text}</code>
        </div>
      ))}
      <p className="ux-card-muted">{hiddenPartsNote(parts.length)}</p>
    </div>
  );
}

/** Now's helper with, under it, the sentence for an issue written outside
 *  the repository (`login`); the helper as it is when there is none. */
export function withOutsideNote(helper: ReactNode, login: string | null, repo: string | null | undefined): ReactNode {
  if (!login) return helper;
  return (
    <>
      {typeof helper === "string" ? machineWords(helper) : helper}
      <span className="ux-now-outside" data-ply-now-outside="">
        <Icon name="outside" size="sm" />
        <span>{outsideSentence(login, repo)}</span>
      </span>
    </>
  );
}
