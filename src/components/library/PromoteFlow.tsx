import { useCallback, useEffect, useRef, useState } from "react";
import { CBtn, ChoiceList, StatusLine } from "../ux";
import { shareAsksLine } from "../../lib/skillAsks";
import { machineWords } from "../../lib/platform";
import {
  personalSkillSharePreview,
  shareRefusalWords,
  shareStatusWords,
  type SharePreview,
} from "../../lib/shareSkillPreview";

/** Where a personal skill can go. */
export type PromoteChoice = "repository" | "team";

/** While the page refuses, how long after each answer it reads the folder
 *  again: the way out may be in a terminal tile, which moves no focus. */
export const PAGE_READ_MS = 3000;

/**
 * UX language card 4 (GH #96; BOARDS.md §6 "Promote"): the one step a personal
 * skill's `Promote` opens.
 *
 * A surface of its own in the centre, with **no navigation around it**
 * (PATTERNS.md §6): the Library's inner column is taken away while a flow is
 * open — the host reads the flow out of the store to do that (review 1).
 * Eyebrow, the question, what stays where either way, the two places as a radio
 * group, then whom it reaches and one confirming action. The member's own copy is
 * never moved: the flow says so before the button, and the backend only reads it.
 * Going to the team, the page names the repository and every file that goes.
 * A folder either place would refuse says so here, and the button stays off.
 */
export function PromoteFlow({
  name,
  repository,
  teamReason,
  teamShown = true,
  visible = true,
  busy,
  onCancel,
  onPromote,
}: {
  name: string;
  /** `owner/repo`, for the sentence that says whom a repository promote reaches. */
  repository: string | null;
  /** Why the team library cannot be written from this Mac, when it cannot. */
  teamReason: string | null;
  /** OB-9 (onboarding §10 row 5): false in solo mode — the Team choice is not
   *  drawn, and the repository is the one place it can go. */
  teamShown?: boolean;
  /** This Library is what its window shows; a hidden one reads nothing. */
  visible?: boolean;
  busy: boolean;
  onCancel: () => void;
  onPromote: (choice: PromoteChoice) => void;
}) {
  // Cold read 2026-10-19 (Challenger): the row's button says `Share with
  // Team…`, so the team is chosen when it can be; solo mode (no Team) and a
  // team this Mac can't write keep the repository.
  const teamOpen = teamShown && teamReason === null;
  const [choice, setChoice] = useState<PromoteChoice>(teamOpen ? "team" : "repository");
  // `undefined` while it's read: a press to the team waits for the list. A
  // read that failed (null) doesn't hold the press; the backend still checks.
  // Read for either place: the repository refuses the same folders.
  const [preview, setPreview] = useState<SharePreview | null | undefined>(undefined);
  // Only the newest read may answer: an older one mustn't undo a newer one.
  const newest = useRef(0);
  const read = useCallback(async () => {
    const ticket = ++newest.current;
    let answer: SharePreview | null;
    try {
      answer = await personalSkillSharePreview(name);
    } catch {
      answer = null;
    }
    if (ticket === newest.current) setPreview(answer);
  }, [name]);
  useEffect(() => {
    setPreview(undefined);
    void read();
    return () => {
      newest.current += 1;
    };
  }, [read]);
  const refusal = shareRefusalWords(preview);
  const refused = refusal !== null;
  // The page says what the folder holds, so it keeps reading while it's on
  // screen: the button comes back once a file is moved out, and goes off when one
  // arrives (the walk of 2026-11-03: it stayed on with a .env added; the press
  // still refuses). The next read waits for this one's answer, and none runs out
  // of sight (the Library behind another mode, or a hidden window, as All skills'
  // sweep).
  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(async () => {
        if (document.visibilityState === "visible") await read();
        if (!stopped) next();
      }, PAGE_READ_MS);
    };
    next();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [visible, read]);
  // Coming back reads at once, not at the next tick.
  const wasVisible = useRef(visible);
  useEffect(() => {
    const back = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (back) void read();
    if (!visible) return;
    const onFocus = () => void read();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [visible, read]);
  const toTeam = choice === "team";
  const teamRepo = preview?.teamRepo ?? null;
  const repo = repository ?? "this repository";
  // Solo mode keeps its words; with a team, the flow says Share like its row.
  const verb = teamShown ? "Share" : "Promote";
  return (
    <div className="ux-flow">
      <p className="ux-flow-eyebrow">{verb} · 1 step</p>
      <h2 className="ux-flow-title">
        Where should <span className="ux-mono-fg">{name}</span> go?
      </h2>
      <p className="ux-page-lede">
        {machineWords(
          "It lives on this Mac today, so only you can use it. Your copy stays where it is either way.",
        )}
      </p>
      <ChoiceList
        value={choice}
        onChange={setChoice}
        label={`Where ${name} goes`}
        options={[
          {
            value: "repository",
            label: "This repository",
            hint: `Everyone who opens ${repo} gets it. Plyloft writes the skill where Claude and Codex both read it, in your project folder; nothing is committed, so you ship it with a card.`,
          },
          ...(teamShown
            ? [
                {
                  value: "team" as const,
                  label: "Team",
                  // A disabled choice says why in its own sentence, not in a
                  // tooltip (PATTERNS.md §3).
                  hint:
                    teamReason ??
                    machineWords(
                      `Goes to ${teamRepo ?? "your team's repository"} on GitHub. Everyone on your team can read it, and every Mac gets it at its next refresh.`,
                    ),
                  disabled: teamReason !== null,
                },
              ]
            : []),
        ]}
      />
      <StatusLine state={refused ? "aborted" : "empty"}>
        {refusal ??
          (toTeam
            ? shareStatusWords(preview ?? null)
            : `Reaches everyone who opens ${repo}, after you ship the change.`)}
      </StatusLine>
      {/* 1.175.0 B1: what its text asks for, and whose OK sharing it is. */}
      {toTeam && !refused && preview?.asks && <StatusLine state="empty">{machineWords(shareAsksLine(preview.asks))}</StatusLine>}
      <div className="ux-flow-actions">
        <CBtn tone="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </CBtn>
        <CBtn tone="accent" onClick={() => onPromote(choice)} disabled={busy || refused || (toTeam && preview === undefined)}>
          {busy ? (teamShown ? "Sharing…" : "Promoting…") : toTeam && teamRepo ? `Share with ${teamRepo}` : verb}
        </CBtn>
      </div>
    </div>
  );
}
