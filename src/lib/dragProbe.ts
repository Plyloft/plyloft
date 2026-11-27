// 1.172.2 D1: what a drag from another app carries, logged for the walk.
//
// Measured (ux-1722/measure.md): a fresh screenshot dragged from its floating
// thumbnail through Universal Control never reached the terminal's `drop` at
// all. The probe then logged only in that handler, so what the drag carried
// while it was over the window was not seen. This logs it, in the capture
// phase on `window` — before the shell's drop guard or any target can stop
// it — once per gesture and again whenever what it carries or where it is
// changes, as `[drag-probe]` lines in the app's log.
//
// Dev and test-bridge builds only: `main.tsx` imports it behind
// dev builds or the test bridge (the guard is in main.tsx), so a release build drops the
// chunk. It never cancels, claims or changes an event.
import { info as logInfo } from "@tauri-apps/plugin-log";
import { DROP_ZONE_ATTR, DROP_ZONE_SELECTOR } from "./dropGuard";

const PROBED = ["dragenter", "dragover", "dragleave", "drop"] as const;

/** The parts of a drag event the probe reads. */
export type ProbedDrag = {
  type: string;
  target: EventTarget | null;
  dataTransfer: {
    types?: readonly string[];
    items?: ArrayLike<{ kind: string; type: string }>;
    files?: { length: number };
  } | null;
};

/** The nearest marked drop zone over which the drag is, or "none". */
function zoneOf(target: EventTarget | null): string {
  const el = target as { closest?: (s: string) => { getAttribute(n: string): string | null } | null } | null;
  if (!el || typeof el.closest !== "function") return "none";
  return el.closest(DROP_ZONE_SELECTOR)?.getAttribute(DROP_ZONE_ATTR) ?? "none";
}

/** What the drag carries, as one line: its `types`, each item's kind and
 *  type, how many files, and the zone under it. */
export function describeDrag(e: ProbedDrag): { signature: string; line: string } {
  const dt = e.dataTransfer;
  const types = Array.from(dt?.types ?? []);
  const items = Array.from(dt?.items ?? []).map((it) => `${it.kind}:${it.type || "?"}`);
  const files = dt?.files?.length ?? 0;
  const zone = zoneOf(e.target);
  const signature = JSON.stringify([types, items, files, zone]);
  const line =
    `[drag-probe] ${e.type} zone=${zone} types=${JSON.stringify(types)} ` +
    `items=${JSON.stringify(items)} files=${files}`;
  return { signature, line };
}

/** Which events to log: every one but a `dragover` that repeats the last
 *  line, so a hover is a handful of lines, not twenty a second. */
export function makeDragFilter(): (e: ProbedDrag) => string | null {
  let last: string | null = null;
  return (e) => {
    const { signature, line } = describeDrag(e);
    if (e.type === "dragover" && signature === last) return null;
    last = e.type === "drop" || e.type === "dragleave" ? null : signature;
    return line;
  };
}

/** Install the probe. Returns the uninstaller. */
export function installDragProbe(
  win: Pick<Window, "addEventListener" | "removeEventListener">,
  log: (line: string) => void = (line) => {
    console.debug(line);
    logInfo(line).catch(() => {});
  },
): () => void {
  const pass = makeDragFilter();
  const onDrag = (event: Event) => {
    const line = pass(event as unknown as ProbedDrag);
    if (line !== null) log(line);
  };
  for (const type of PROBED) win.addEventListener(type, onDrag, true);
  return () => {
    for (const type of PROBED) win.removeEventListener(type, onDrag, true);
  };
}
