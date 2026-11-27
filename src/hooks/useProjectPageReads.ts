import { useEffect, useRef, useState } from "react";
import {
  DEFINITION_PAGE_IDLE_MS,
  DEFINITION_PAGE_READ_EVERY_MS,
  definitionAnswerIsRecent,
  definitionReadDueIn,
  readDefinitionIfDue,
} from "../store/definitionReadStore";

/** The app is in front: not hidden, and its window has the focus. A press in the
 *  window says so too, whatever `document.hasFocus()` last answered. */
function useAppInFront(): boolean {
  const visible = () => document.visibilityState !== "hidden";
  const [inFront, setInFront] = useState(() => visible() && document.hasFocus());
  useEffect(() => {
    const onActive = () => setInFront(visible());
    const onBlur = () => setInFront(false);
    const onVisibility = () => setInFront(visible() && document.hasFocus());
    window.addEventListener("focus", onActive);
    window.addEventListener("pointerdown", onActive, true);
    window.addEventListener("keydown", onActive, true);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onActive);
      window.removeEventListener("pointerdown", onActive, true);
      window.removeEventListener("keydown", onActive, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return inFront;
}

const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown"] as const;

/**
 * Two-account walks, 2026-11-02: what Settings › Project says about a shared
 * project stays current while somebody is looking at it. Entering any of its
 * pages asks for a read if one is due, or when the 30 s guard ends. On a project
 * that shares its setup and a computer that isn't solo (`repeats`) it then reads
 * every 60 s; elsewhere a read can be an all-branch fetch and a scan, for nothing.
 *
 * Behind another app it waits, and coming back asks once. After 15 minutes with
 * no pointer or key in the window it stops (blur may not fire on a screen lock),
 * and the next input asks once.
 *
 * One timer, gone with the page or the workspace, and the store never overlaps
 * reads. All `pageRead`: the read itself publishes nothing; what it finds can
 * start the Board's existing automatic steps, as any read does. Only a real
 * arrival with no recent answer holds the page's presses. The others are quiet,
 * because every press that
 * moves a board reads for itself first (`BoardPage.readFirst`), and a read that
 * changed something holds them until its status lands.
 */
export function useProjectPageReads(
  workspaceId: string | null,
  onProjectPage: boolean,
  /** The page: entering another one of them asks again. */
  entry: string,
  repeats: boolean,
): void {
  const inFront = useAppInFront();
  const place = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const tickNow = useRef<(() => void) | null>(null);
  const repeating = useRef(repeats);
  repeating.current = repeats;

  useEffect(() => {
    if (!workspaceId || !onProjectPage) {
      place.current = null;
      return;
    }
    if (!inFront) return;
    const here = `${workspaceId}\n${entry}`;
    let arriving = place.current !== here;
    place.current = here;
    let lastInput = Date.now();
    let idle = false;
    const arm = (ms: number) => {
      timer.current = window.setTimeout(tick, ms);
    };
    const tick = () => {
      timer.current = undefined;
      if (Date.now() - lastInput >= DEFINITION_PAGE_IDLE_MS) {
        idle = true;
        return;
      }
      const wait = definitionReadDueIn(workspaceId);
      if (wait === 0) {
        readDefinitionIfDue(workspaceId, {
          quiet: !arriving || definitionAnswerIsRecent(workspaceId),
        });
      }
      arriving = false;
      if (wait > 0) arm(wait);
      else if (repeating.current) arm(DEFINITION_PAGE_READ_EVERY_MS);
    };
    const onInput = () => {
      lastInput = Date.now();
      if (idle) {
        idle = false;
        window.clearTimeout(timer.current);
        tick();
      }
    };
    for (const name of INPUT_EVENTS) window.addEventListener(name, onInput, true);
    tickNow.current = tick;
    tick();
    return () => {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      tickNow.current = null;
      for (const name of INPUT_EVENTS) window.removeEventListener(name, onInput, true);
    };
  }, [workspaceId, onProjectPage, entry, inFront]);

  // The status landing can say this project shares its setup after the arrival.
  useEffect(() => {
    if (repeats && timer.current === undefined && tickNow.current) {
      timer.current = window.setTimeout(tickNow.current, DEFINITION_PAGE_READ_EVERY_MS);
    }
  }, [repeats]);
}
