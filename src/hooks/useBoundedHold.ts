import { useEffect, useState } from "react";
import { DEFINITION_READ_HOLD_MS } from "../store/definitionReadStore";

/**
 * Two-account walk, 2026-11-02: `on`, for at most `DEFINITION_READ_HOLD_MS`. A
 * page holds its presses while it reads; on a network that hangs, what it knows
 * is still the last answer, and the person gets the page back. A new `key` (the
 * workspace), or `on` going off and on again, starts a new hold.
 */
export function useBoundedHold(on: boolean, key: string | null = null): boolean {
  const [expired, setExpired] = useState<{ key: string | null } | null>(null);
  useEffect(() => {
    if (!on) {
      setExpired(null);
      return;
    }
    const timer = window.setTimeout(() => setExpired({ key }), DEFINITION_READ_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [on, key]);
  return on && !(expired && expired.key === key);
}
