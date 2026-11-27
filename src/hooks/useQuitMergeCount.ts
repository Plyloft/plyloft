import { useEffect, useState } from "react";
import { quitPlyloftMerges } from "../ipc";
import { plyloftMergesPending, quitMergeCount } from "../lib/deliveryStage";
import { useKanban } from "../store/kanbanStore";

/**
 * 1.172.0 B2: how many pull requests wait for Plyloft's own merge, for the
 * quit note — read from the backend once when the sheet shows (every
 * workspace's board, not only the warmed ones, and the releases through a
 * pull request Plyloft merges itself). Until it answers, or when it can't,
 * the warmed boards' own count stands.
 */
export function useQuitMergeCount(): number {
  const warmed = useKanban((s) => plyloftMergesPending(Object.values(s.byWorkspace).flatMap((b) => b?.cards ?? [])));
  const [backend, setBackend] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    quitPlyloftMerges()
      .then((n) => {
        if (live && typeof n === "number") setBackend(n);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return quitMergeCount(backend, warmed);
}
