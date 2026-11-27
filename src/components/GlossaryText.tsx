import { useId } from "react";
import { openWebLink } from "../ipc";
import { machineWords } from "../lib/platform";
import { GLOSSARY, GLOSSARY_URL, glossaryWordsIn, termLabel, termTitle, type GlossaryWord } from "../lib/glossary";
import { pushToast } from "../store/toastStore";
import { CIcon } from "./ux";
import { linkDidNotOpen } from "../lib/linkToast";

/** G10: the guide's glossary, in the browser. */
export function openGlossary(): void {
  void openWebLink(GLOSSARY_URL).catch((e: unknown) =>
    pushToast(linkDidNotOpen(GLOSSARY_URL, e)),
  );
}

/**
 * G10 (1.170.0): `text` as it is, then — for each of `words` it uses ("pull
 * request", "round") — a quiet help mark whose hover says what the word
 * means; pressed, it opens the guide's glossary. The sentence stays one
 * piece of text (read aloud and found as it was). The definition is the
 * mark's description too (Challenger 7): a screen reader reads it with the
 * mark, and it shows beside the mark while the keyboard is on it.
 */
export function GlossaryText({ text, words }: { text: string; words: readonly GlossaryWord[] }) {
  const used = glossaryWordsIn(text, words);
  return (
    <>
      {machineWords(text)}
      {used.map((word) => (
        <TermHelp key={word} word={word} />
      ))}
    </>
  );
}

/** 1.171.0 C3: the help mark alone, beside a word drawn elsewhere (the
 *  card's "Challenger" fact label). */
export function TermHelp({ word }: { word: GlossaryWord }) {
  const id = useId();
  return (
    <span className="ux-term">
      <CIcon
        icon="help"
        tone="quiet"
        className="ux-term-help"
        data-ply-term={word}
        title={termTitle(word)}
        aria-label={termLabel(word)}
        aria-describedby={id}
        onClick={openGlossary}
      />
      {/* Read once, as the mark's description (aria-describedby reaches a
          hidden node), not again as text in the sentence. */}
      <span id={id} className="ux-term-def" aria-hidden="true">
        {GLOSSARY[word]}
      </span>
    </span>
  );
}
