// Skills hub H1 (docs/plans/SKILLS_HUB.md R13): "Skill updated after this
// session started: <names>". A session's library skills are fixed snapshots
// taken at launch, so a pull reaches only the next session; this says so on
// the surfaces that show a live session (a tile's header, the card's Builder
// step). The backend answers from what the session was given at launch.
import { useEffect, useState } from "react";
import { sessionSkillDrift } from "../ipc";

/** How often a live session is asked: the spec's "within one index refresh
 * (≤ 10 s after the pull)". The backend reuses one `HEAD` answer for 3 s
 * (`library_snapshot::HEAD_TTL`), so 7 s here keeps the worst case at 10 s. */
export const SKILL_DRIFT_POLL_MS = 7_000;

/** The line's words, one place for every surface. */
export function skillDriftWords(names: readonly string[]): string {
  return `Skill updated after this session started: ${names.join(", ")}`;
}

/** The changed skills of the session in `ptyId`, asked now and every
 * {@link SKILL_DRIFT_POLL_MS} while the window is visible. The same array
 * is kept while the answer does not change, so a parent re-renders only
 * when the line does. */
export function useSkillDrift(ptyId: string | null | undefined): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    setNames([]);
    if (!ptyId) return;
    let cancelled = false;
    const ask = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      sessionSkillDrift(ptyId)
        .then((next) => {
          if (cancelled || !Array.isArray(next)) return;
          setNames((prev) => (prev.join("\n") === next.join("\n") ? prev : next));
        })
        .catch(() => {
          // A refused or failed answer says nothing about the skills; keep
          // whatever was shown.
        });
    };
    ask();
    const timer = window.setInterval(ask, SKILL_DRIFT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [ptyId]);
  return names;
}

/** The chip in a tile's header; the full sentence is its tooltip. */
export function SkillDriftChip({ ptyId }: { ptyId: string | null | undefined }) {
  const names = useSkillDrift(ptyId);
  if (names.length === 0) return null;
  const words = skillDriftWords(names);
  return (
    <span
      className="tile-chip tile-chip--warn"
      role="status"
      title={`${words}. Open a new tile to use the new version.`}
      aria-label={words}
    >
      <span className="tile-chip-dot" aria-hidden="true" />
      {/* 1.174.0 E4 (P21): the words give way with an ellipsis in a narrow tile. */}
      <span className="tile-chip-text">Skill updated</span>
    </span>
  );
}

/** The line on the card's Builder step. */
export function SkillDriftLine({ ptyId }: { ptyId: string | null | undefined }) {
  const names = useSkillDrift(ptyId);
  if (names.length === 0) return null;
  return (
    <p className="ux-card-muted" role="status">
      {skillDriftWords(names)}. A new session gets the new version.
    </p>
  );
}
