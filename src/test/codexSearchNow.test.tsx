// 1.172.0 E3 (Windows walk): with Codex's transcript search open, Now said
// "Codex hasn't printed anything for a while…" and the self-check waited its
// full ten minutes. The Builder's scan records the search as open (beside
// `markPromptBox`'s other facts), the card's live facts carry it, and Now
// says how to close it (cardPresentation.test.ts holds the words).
import { afterEach, describe, expect, it } from "vitest";
import { builderSessionsKey, builderSessionsMap } from "../hooks/useCardLive";
import { useBuilder } from "../store/builderStore";

afterEach(() => {
  useBuilder.getState().detach("c1", "pty1");
});

describe("Codex's search open is a fact of the card's session", () => {
  it("is set by the scan and cleared when it closes", () => {
    useBuilder.getState().attach("c1", "ws", "pty1", "codex");
    const open = () => builderSessionsMap(builderSessionsKey(useBuilder.getState())).get("c1")?.codexSearchOpen ?? false;
    expect(open()).toBe(false);
    useBuilder.getState().markPromptBox("c1", false, false, false, true, null, true);
    expect(useBuilder.getState().byCard.c1?.codexOverlayOpen).toBe(true);
    expect(open()).toBe(true);
    useBuilder.getState().markPromptBox("c1", true, true, false, true, false, false);
    expect(open()).toBe(false);
  });
});

describe("1.174.3: a turn Resume brought back cut off", () => {
  const scan = (interrupted: boolean) =>
    useBuilder.getState().markPromptBox("c1", true, true, false, true, false, false, false, interrupted);
  const fact = () => builderSessionsMap(builderSessionsKey(useBuilder.getState())).get("c1")?.turnInterrupted ?? false;

  afterEach(() => useBuilder.setState({ submittedAt: {} }));

  it("is a fact only after a Resume, and a submit ends it", () => {
    useBuilder.getState().attach("c1", "ws", "pty1", "codex");
    scan(true);
    expect(fact()).toBe(false); // the person's own Esc: no Resume behind it
    useBuilder.setState((s) => ({ byCard: { c1: { ...s.byCard.c1!, resumedAt: Date.now() - 1_000 } } }));
    scan(true);
    expect(fact()).toBe(true);
    useBuilder.getState().noteSubmitted("c1");
    expect(fact()).toBe(false);
    scan(true);
    expect(fact()).toBe(false); // cut off after that submit: their own
  });

  it("ends when the screen no longer shows it", () => {
    useBuilder.getState().attach("c1", "ws", "pty1", "codex");
    useBuilder.setState((s) => ({ byCard: { c1: { ...s.byCard.c1!, resumedAt: Date.now() - 1_000 } } }));
    scan(true);
    expect(fact()).toBe(true);
    scan(false);
    expect(fact()).toBe(false);
  });
});
