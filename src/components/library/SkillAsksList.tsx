// 1.175.0 B1 (SEC-1): "What it asks to be allowed to do" — the sheet's list
// for a skill whose text asks: a command run when it loads, commands or file
// changes without a question, hooks. Each item says the line of SKILL.md it
// comes from; on a changed text, how it stands against the version approved
// and, where it differs, the two versions side by side.
import { PChip } from "../ux";
import { ASKS_HEADING, askItems, unreadableWords, type SkillAsks } from "../../lib/skillAsks";

/** One asking text of the skill: its path, which CLI's copy it is when the
 *  two copies differ, what it asks, and what the version kept asked. */
export interface AskingTextView {
  path: string;
  copy?: "claude" | "codex" | null;
  asks: SkillAsks;
  before?: SkillAsks | null;
}

export function SkillAsksList({
  texts,
  approvedDay,
  publish = false,
}: {
  /** Every text that asks. With more than one (a nested `SKILL.md`, two
   *  copies that differ) each list is led by its file's path, as the files
   *  below are; with one, the list stands alone as before. */
  texts: AskingTextView[];
  /** `3 Oct`, when the version sessions keep was approved. */
  approvedDay?: string | null;
  /** Publish speaks of everyone's agents: "without asking". */
  publish?: boolean;
}) {
  const several = texts.length > 1;
  return (
    <section className="ux-asks" aria-label={ASKS_HEADING}>
      <h3 className="ux-asks-heading">{ASKS_HEADING}</h3>
      {texts.map((text) => {
        const items = askItems(text.asks, text.before ?? null, publish);
        return (
          <div key={`${text.path}:${text.copy ?? ""}`} className="ux-asks-text" data-ply-asks-of={text.path}>
            {several && (
              <p className="ux-asks-path">
                <span className="ux-mono-fg">{text.path}</span>
                {text.copy && <PChip tone="outline">{text.copy === "claude" ? "Claude copy" : "Codex copy"}</PChip>}
              </p>
            )}
            {text.asks.unreadable != null && <p className="ux-asks-unreadable">{unreadableWords(text.asks.unreadable)}</p>}
            {items.length > 0 && (
              <ul className="ux-asks-list">
                {items.map((item) => (
                  <li key={item.key} data-ply-ask={item.key}>
                    <span className="ux-asks-title">
                      <b>{item.title}</b>
                      {item.chip && <PChip tone="outline">{item.chip}</PChip>}
                    </span>
                    <span className="ux-asks-detail">{item.detail}</span>
                    {item.before ? (
                      <span className="ux-versions">
                        <span>
                          <span className="ux-versions-key">{approvedDay ? `You approved on ${approvedDay}` : "Before"}</span>
                          <Box lines={item.before} was />
                        </span>
                        <span>
                          <span className="ux-versions-key">Now</span>
                          <Box lines={item.now} marked={new Set(item.now.filter((line) => !item.before!.includes(line)))} />
                        </span>
                      </span>
                    ) : (
                      item.now.length > 0 && <Box lines={item.now} />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Box({ lines, was, marked }: { lines: string[]; was?: boolean; marked?: Set<string> }) {
  return (
    <span className={was ? "ux-versions-value ux-versions-value--was ux-asks-box" : "ux-versions-value ux-asks-box"}>
      {lines.map((line, i) => (
        <span key={`${i}:${line}`} className="ux-asks-line">
          {marked?.has(line) ? <mark>{line}</mark> : line}
        </span>
      ))}
    </span>
  );
}
