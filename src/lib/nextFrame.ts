// The next animation frame — or a timer, when frames do not come.
//
// 2026-09-30 walk (next11/skills-b): the workspace's staged mount advanced one
// stage per `requestAnimationFrame`. WebKit sends no frames to a page it is
// not painting — a locked screen, a screensaver, a window fully covered or not
// shown yet — so the stages stopped short of the last one and the card host
// (mounted only at the last stage) stayed empty: opening a card left the
// centre blank, with no error, until the window was painted again.
//
// Whichever comes first runs `run`, once: the frame, or the timer. Both are
// their own event-loop task, so the staging still never piles two commits
// into one block (the reason it exists — see NewWorkspaceShell).
export const FRAME_FALLBACK_MS = 100;

type FrameHost = Pick<
  typeof globalThis,
  "requestAnimationFrame" | "cancelAnimationFrame" | "setTimeout" | "clearTimeout"
>;

/** Schedules `run`; returns the cancel. */
export function nextFrameOrTimer(
  run: () => void,
  fallbackMs: number = FRAME_FALLBACK_MS,
  host: FrameHost = globalThis,
): () => void {
  let done = false;
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    done = true;
    if (frame != null) host.cancelAnimationFrame(frame);
    if (timer != null) host.clearTimeout(timer);
    frame = null;
    timer = null;
  };
  const fire = () => {
    if (done) return;
    cancel();
    run();
  };
  if (typeof host.requestAnimationFrame === "function") {
    frame = host.requestAnimationFrame(fire);
  }
  timer = host.setTimeout(fire, fallbackMs);
  return cancel;
}
