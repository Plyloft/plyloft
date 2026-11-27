/**
 * v1.114.0 (team sharing rung 1): "only the newest answer may be shown".
 *
 * Settings → Team fires overlapping requests — a local read, then a
 * refresh that takes a `gh repo clone` worth of time, and another pair
 * whenever the key changes. Without a gate, a reply about the team a
 * *previous* key named can land after the current team's and repaint the
 * panel with someone else's team. Every request takes a ticket; only the
 * holder of the newest one may touch state.
 *
 * Extracted so the rule is testable on its own (`latestRequest.test.ts`) —
 * a race inside a React effect is otherwise only reproducible by luck.
 */
export class LatestRequest {
  #seq = 0;

  /** Take a ticket for a request that is about to start. */
  begin(): number {
    this.#seq += 1;
    return this.#seq;
  }

  /** May this ticket's response be applied? */
  isCurrent(ticket: number): boolean {
    return ticket === this.#seq;
  }

  /**
   * Retire everything in flight without starting anything: the key
   * changed, or the panel unmounted. Nothing outstanding may apply after
   * this.
   */
  retireAll(): void {
    this.#seq += 1;
  }
}
