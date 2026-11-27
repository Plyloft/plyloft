// QoL 1.168 (block 10, A7; Challenger item 3): ⌘= / ⌘− / ⌘0 in a terminal or
// the editor. The size follows at once (`pending`), and a burst of presses is
// one settings write, of the last size, 150 ms after the last press
// (`lib/textSize.createZoomCoalescer`). What every view draws is
// `useTextSize(kind)`: the size asked for, else the saved setting.

import { create } from "zustand";
import { useSettings } from "./settingsStore";
import {
  createZoomCoalescer,
  storedTextSize,
  textSizeOf,
  type ZoomAction,
  type ZoomCoalescer,
} from "../lib/textSize";

export type TextKind = "terminals" | "editor";

export const useTextZoom = create<Record<TextKind, number | null>>(() => ({
  terminals: null,
  editor: null,
}));

const coalescers = {} as Record<TextKind, ZoomCoalescer>;
for (const kind of ["terminals", "editor"] as const) {
  coalescers[kind] = createZoomCoalescer({
    read: () => textSizeOf(useSettings.getState().settings[kind].textSize),
    write: (size) =>
      useSettings.getState().update((latest) => {
        const next = storedTextSize(size);
        if ((latest[kind].textSize ?? null) === next) return latest;
        return { ...latest, [kind]: { ...latest[kind], textSize: next } };
      }),
    changed: () => useTextZoom.setState({ [kind]: coalescers[kind].pending() }),
  });
}

/** One step of that kind's text size: drawn now, saved once the keys rest. */
export function zoomText(kind: TextKind, action: ZoomAction): void {
  coalescers[kind].step(action);
}

/** The size a view of `kind` draws now. */
export function textSizeNow(kind: TextKind): number {
  return useTextZoom.getState()[kind] ?? textSizeOf(useSettings.getState().settings[kind].textSize);
}

export function useTextSize(kind: TextKind): number {
  const pending = useTextZoom((s) => s[kind]);
  const saved = useSettings((s) => s.settings[kind].textSize);
  return pending ?? textSizeOf(saved);
}
