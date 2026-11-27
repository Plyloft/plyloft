import { useEffect, useRef, useState } from "react";
import { cliRepairPlan, type RepairPlan } from "../../lib/cliRepairIpc";
import type { CliTool } from "../../lib/cliHealthIpc";
import { TOOL_NAME, repairRow, words, type RepairRow } from "../../lib/repairView";
import { useRepair } from "../../store/repairStore";
import { useQuickRepair } from "../../store/quickRepairStore";
import { CBtn, Group, Row, Section } from "../ux";

const TOOLS: readonly CliTool[] = ["claude", "codex"];

type Read = { kind: "reading" } | { kind: "failed" } | { kind: "plan"; row: RepairRow };

/**
 * 1.176.0 R6: Settings › Setup and account › Diagnostics, Repair. One row per
 * AI tool: what a fresh, read-only look says, and the button that opens the
 * guided Repair, from a quick read (no network, no slow retries). It reads when
 * the page opens and at each Look again; it never runs anything by itself.
 */
export function RepairGroup({ lookKey }: { lookKey: number }) {
  const [reads, setReads] = useState<Record<CliTool, Read>>({
    claude: { kind: "reading" },
    codex: { kind: "reading" },
  });
  const seq = useRef(0);
  // After a repair ends the sheet's own plan is the newer one.
  // Never when a step starts: a `--version` then could hold a file in use.
  const ended = useRepair((s) => s.phase === "end");
  const repairOpen = useRepair((s) => s.open);

  useEffect(() => {
    if (repairOpen && !ended) return;
    const mine = ++seq.current;
    setReads({ claude: { kind: "reading" }, codex: { kind: "reading" } });
    for (const tool of TOOLS) {
      cliRepairPlan(tool, { quick: true }).then(
        (plan: RepairPlan) => {
          if (seq.current !== mine) return;
          // 1.176.0 seams: the tool rows offer Repair for a blocked Update.
          useQuickRepair.getState().setUpdateBlocked(tool, plan.updateBlocked === true);
          // An answer that can't be read is "can't tell", never a throw.
          let row: ReturnType<typeof repairRow> | null = null;
          try {
            row = repairRow(plan);
          } catch {
            row = null;
          }
          setReads((r) => ({ ...r, [tool]: row ? { kind: "plan", row } : { kind: "failed" } }));
        },
        () => {
          if (seq.current === mine) setReads((r) => ({ ...r, [tool]: { kind: "failed" } }));
        },
      );
    }
    // Read when the page opens and at each Look again (`lookKey`), and once
    // more when a repair's sheet closes; the full plan loads in the sheet.
  }, [lookKey, repairOpen, ended]);

  return (
    <Section title="Repair" scope="this-mac">
      <Group>
        {TOOLS.map((tool) => {
          const read = reads[tool];
          const hint =
            read.kind === "reading"
              ? "Looking…"
              : read.kind === "failed"
                ? "Plyloft couldn't look. Try Look again."
                : words(read.row.text);
          const needs = read.kind === "plan" && read.row.state === "needs";
          return (
            <Row
              key={tool}
              kind="procedure"
              label={TOOL_NAME[tool]}
              hint={hint}
              action={
                <CBtn tone={needs ? "strong" : "ghost"} onClick={() => useRepair.getState().show(tool)}>
                  Repair
                </CBtn>
              }
            />
          );
        })}
      </Group>
    </Section>
  );
}
