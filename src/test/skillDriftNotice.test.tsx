// Skills hub H1 (R13): "Skill updated after this session started: <names>".
//
// The notice asks the backend about one live session (by PTY id) and shows
// the line only when a skill that session was given changed upstream; it asks
// again within 10 s, so a pull reaches a running session's surface without a
// reload, and says nothing for a session whose skills did not move.
import { describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import {
  SKILL_DRIFT_POLL_MS,
  SkillDriftChip,
  SkillDriftLine,
} from "../components/SkillDriftNotice";
import { renderUi, screen } from "./render";

describe("SkillDriftNotice", () => {
  it("shows the line for the skills that changed, and nothing before", async () => {
    let answer: string[] = [];
    const { tauri } = renderUi(<SkillDriftLine ptyId="pty-1" />, {
      fakeTimers: true,
      fixtures: { session_skill_drift: () => answer },
    });
    await act(async () => {});
    expect(screen.queryByRole("status")).toBeNull();
    expect(tauri.callsOf("session_skill_drift")[0]?.args).toEqual({ ptyId: "pty-1" });

    // A pull lands upstream: the next ask, within 10 s, shows it.
    answer = ["review-rules", "style"];
    await act(async () => {
      vi.advanceTimersByTime(SKILL_DRIFT_POLL_MS);
    });
    expect(screen.getByRole("status").textContent).toBe(
      "Skill updated after this session started: review-rules, style. A new session gets the new version.",
    );
    vi.useRealTimers();
  });

  it("puts a chip in a tile header with the sentence as its tooltip", async () => {
    renderUi(<SkillDriftChip ptyId="pty-2" />, {
      fixtures: { session_skill_drift: () => ["review-rules"] },
    });
    const chip = await screen.findByRole("status");
    expect(chip.textContent).toBe("Skill updated");
    expect(chip.getAttribute("title")).toBe(
      "Skill updated after this session started: review-rules. Open a new tile to use the new version.",
    );
  });

  it("asks nothing and shows nothing without a session", async () => {
    const { tauri } = renderUi(<SkillDriftChip ptyId={null} />);
    await act(async () => {});
    expect(tauri.callsOf("session_skill_drift")).toHaveLength(0);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps quiet when the answer is refused", async () => {
    renderUi(<SkillDriftLine ptyId="pty-3" />, {
      fixtures: {
        session_skill_drift: () => {
          throw new Error("no such session");
        },
      },
    });
    await act(async () => {});
    expect(screen.queryByRole("status")).toBeNull();
  });
});
