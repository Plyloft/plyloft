// 1.177.0 Compare: the kind glyph and a sentence, as the relay bar's lines
// begin. Colour only on the glyph.
import type { ReactNode } from "react";
import type { CompareVendor } from "../lib/compareWords";

const GLYPH: Record<CompareVendor, string> = { claude: "✦", codex: "◆" };
const GLYPH_CLASS: Record<CompareVendor, string> = {
  claude: "ux-relay-glyph ux-relay-glyph--claude",
  codex: "ux-relay-glyph ux-relay-glyph--codex",
};

export function RelayWho({ vendor, children }: { vendor: CompareVendor; children: ReactNode }) {
  return (
    <span className="ux-relay-who">
      <span className={GLYPH_CLASS[vendor]} aria-hidden="true">
        {GLYPH[vendor]}
      </span>
      <span>{children}</span>
    </span>
  );
}
