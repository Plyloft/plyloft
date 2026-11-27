// 1.174.0 (A6, D2c): the record that this person shipped a card on this Mac
// (`settings.nextImprovement.firstCardShippedAt`), so Next improvement shows
// by itself from then on, in every project. Written once, from the Boards
// this Mac has read: at the first ship (the card's Board turns it shipped),
// and at start for cards shipped before 1.174 — people who shipped keep
// Next improvement. The tour's base chapter finished or fully skipped is
// recorded the same way (`opensSince`). Never cleared: Reset all settings on
// this Mac keeps both, and the backend keeps them over a stale save. Rust
// also backfills `firstCardShippedAt` at launch from every board file
// (`lib.rs`, `kanban::earliest_ship_ms`).
import { baseChapterClosed, firstShipAt } from "../lib/nextImprovement";
import { useKanban } from "./kanbanStore";
import { useSettings } from "./settingsStore";

let writing = false;

function check(): void {
  const settings = useSettings.getState();
  const ni = settings.settings.nextImprovement;
  if (!settings.loaded || writing || ni?.firstCardShippedAt || ni?.opensSince) return;
  const cards = Object.values(useKanban.getState().byWorkspace).flatMap((ws) => ws?.cards ?? []);
  const at = firstShipAt(cards, Date.now());
  // Round 1: the tour's base chapter finished or fully skipped, recorded once
  // so Take the tour again or Start over never hides Next improvement.
  const tour = at === null && baseChapterClosed(settings.settings.onboarding?.tutorial);
  if (at === null && !tour) return;
  writing = true;
  void settings
    .update((latest) => {
      const cur = latest.nextImprovement;
      if (cur?.firstCardShippedAt || (tour && cur?.opensSince)) return latest;
      const next = at !== null ? { firstCardShippedAt: new Date(at).toISOString() } : { opensSince: new Date().toISOString() };
      return { ...latest, nextImprovement: { ...cur, ...next } };
    })
    .catch(() => {
      // Tried again on the next change of a Board or of settings.
    })
    .finally(() => {
      writing = false;
    });
}

let stop: (() => void) | null = null;

export function startFirstShipWatch(): () => void {
  if (stop) return stop;
  const offKanban = useKanban.subscribe((s, prev) => {
    if (s.byWorkspace !== prev.byWorkspace) check();
  });
  const offSettings = useSettings.subscribe((s, prev) => {
    if (s.loaded !== prev.loaded || s.settings !== prev.settings) check();
  });
  check();
  stop = () => {
    offKanban();
    offSettings();
    stop = null;
  };
  return stop;
}
