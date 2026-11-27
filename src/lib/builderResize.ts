/**
 * Windows port: the Builder terminal's resizes. ConPTY repaints the whole
 * screen on every resize, even to the size it already has, and that repaint
 * is output (it restarts the self-check's silence in the backend's stamp),
 * so a box that moved without changing the grid sends nothing. On the Mac a
 * same-size resize was a no-op anyway.
 *
 * A size is remembered only once the PTY took it: a resize that failed is
 * sent again the next time, not skipped as if it had landed. Of two resizes
 * in flight, the later request is the one remembered.
 * Pure — no Tauri import — so it is unit-tested under node.
 */
export interface GridSize {
  cols: number;
  rows: number;
}

export interface GridSender {
  /** Send this grid unless the PTY already has it. Resolves true when it
   *  was sent and taken, false when skipped; rejects when the send failed. */
  (cols: number, rows: number): Promise<boolean>;
  /** The grid the PTY last took, or null before any. */
  sent(): GridSize | null;
}

export function gridSender(send: (cols: number, rows: number) => Promise<unknown>): GridSender {
  let sent: GridSize | null = null;
  let requests = 0;
  const sender = ((cols: number, rows: number) => {
    if (sent && sent.cols === cols && sent.rows === rows) return Promise.resolve(false);
    const mine = ++requests;
    return send(cols, rows).then(() => {
      if (mine === requests) sent = { cols, rows };
      return true;
    });
  }) as GridSender;
  sender.sent = () => sent;
  return sender;
}
