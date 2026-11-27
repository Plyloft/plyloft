import { useMemo } from "react";
import type { KanbanCard } from "../ipc";
import { effectiveBuilderVendor } from "../lib/cardPage";
import { intakeVendorFor, vendorReadiness } from "../lib/vendorReadiness";
import { useBuilder } from "../store/builderStore";
import { useDoctor } from "../store/doctorStore";
import { useSettings } from "../store/settingsStore";

/** OB-14 (§13.3): the vendor that plans `card` — its Builder vendor when
 *  ready on this machine, else the other one (the backend's rule). */
export function usePlanner(card: Pick<KanbanCard, "id" | "builderVendorPref">): "claude" | "codex" {
  const settingsDefault = useSettings((s) => s.settings.behavior.builderVendor);
  const pick = useBuilder((s) => s.vendorPref[card.id]);
  const report = useDoctor((s) => s.report);
  return intakeVendorFor(effectiveBuilderVendor(pick, card, settingsDefault), vendorReadiness(report));
}

/** The same for many cards at once (the board's list). */
export function usePlannerOf(): (card: KanbanCard) => "claude" | "codex" {
  const settingsDefault = useSettings((s) => s.settings.behavior.builderVendor);
  const picks = useBuilder((s) => s.vendorPref);
  const report = useDoctor((s) => s.report);
  return useMemo(() => {
    const readiness = vendorReadiness(report);
    return (card: KanbanCard) =>
      intakeVendorFor(effectiveBuilderVendor(picks[card.id], card, settingsDefault), readiness);
  }, [settingsDefault, picks, report]);
}
