// U25: the question left by Ship's draft keeps its mark only while it stays on
// screen and nothing is sent to the session.
import { describe, expect, it } from "vitest";
import { useBuilder } from "../store/builderStore";
import { act } from "./render";

const rt = () => useBuilder.getState().byCard.c1;

function seed() {
  act(() =>
    useBuilder.setState({
      byCard: { c1: { workspaceId: "ws", ptyId: "p", vendor: "codex", pending: [], questionInView: true, draftQuestion: true } as never },
    }),
  );
}

describe("draftQuestion", () => {
  it("goes when the question leaves the screen", () => {
    seed();
    act(() => useBuilder.getState().markPromptBox("c1", false, false, true));
    expect(rt().draftQuestion).toBe(true);
    act(() => useBuilder.getState().markPromptBox("c1", false, false, false));
    expect(rt().draftQuestion).toBe(false);
  });

  it("goes when anything is sent to the session", () => {
    seed();
    act(() => useBuilder.getState().inject("c1", "x"));
    expect(rt().draftQuestion).toBe(false);
  });
});
