export interface IntakeGridSize {
  cols: number;
  rows: number;
}

export interface IntakeResizeState {
  lastRequested: IntakeGridSize | null;
  resizeEpoch: number | null;
}

export interface IntakeResizeDecision {
  request: boolean;
  state: IntakeResizeState;
}

function sameGrid(left: IntakeGridSize | null, right: IntakeGridSize): boolean {
  return left?.cols === right.cols && left.rows === right.rows;
}

/** Establishes epoch zero only after the initial PTY negotiation succeeds. */
export function negotiatedIntakeGrid(
  grid: IntakeGridSize,
): IntakeResizeState {
  return { lastRequested: grid, resizeEpoch: 0 };
}

/** Decides whether a ResizeObserver result represents a real PTY request.
 *
 * A missing epoch stays missing after an initial negotiation failure, so a
 * later observation cannot manufacture continuity authority. The caller
 * publishes the returned epoch before issuing IPC.
 */
export function nextIntakeResize(
  state: IntakeResizeState,
  grid: IntakeGridSize,
): IntakeResizeDecision {
  if (sameGrid(state.lastRequested, grid)) {
    return { request: false, state };
  }
  return {
    request: true,
    state: {
      lastRequested: grid,
      resizeEpoch:
        state.resizeEpoch == null ? null : state.resizeEpoch + 1,
    },
  };
}
