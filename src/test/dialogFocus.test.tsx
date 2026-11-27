// 1.174.0 X1 (gate fix): a Sheet's first frame puts focus on its
// `initialFocusRef` unless focus already moved inside it since it opened
// (Resume…'s list taking focus once loaded). An `autoFocus` inside the
// sheet is not such a move: the safe action still wins.
import { useEffect, useRef } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Sheet } from "../components/ux";
import { renderUi, screen, waitFor } from "./render";

/** Resolves after the next animation frame and one after it. */
const frames = () =>
  new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));

function MovedBeforeTheFrame() {
  const cancel = useRef<HTMLButtonElement>(null);
  const second = useRef<HTMLButtonElement>(null);
  // The parent's effect runs after the Sheet's, before its first frame.
  useEffect(() => {
    second.current?.focus();
  }, []);
  return (
    <Sheet
      title="Moved"
      onClose={() => {}}
      initialFocusRef={cancel}
      actions={
        <button type="button" ref={cancel}>
          Cancel
        </button>
      }
    >
      <button type="button">First</button>
      <button type="button" ref={second}>
        Second
      </button>
    </Sheet>
  );
}

function AutoFocused() {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Sheet
      title="Auto"
      onClose={() => {}}
      initialFocusRef={cancel}
      actions={
        <button type="button" ref={cancel}>
          Cancel
        </button>
      }
    >
      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
      <button type="button" autoFocus>
        Go
      </button>
    </Sheet>
  );
}

describe("a Sheet's first frame", () => {
  it("keeps focus a parent moved inside the sheet before the frame", async () => {
    renderUi(<MovedBeforeTheFrame />);
    const second = screen.getByRole("button", { name: "Second" });
    expect(document.activeElement).toBe(second);
    await frames();
    expect(document.activeElement).toBe(second);
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("puts focus on initialFocusRef over an autoFocus inside the sheet", async () => {
    renderUi(<AutoFocused />);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await frames();
    await waitFor(() => expect(document.activeElement).toBe(cancel));
  });
});

describe("a Sheet that closes", () => {
  function Opened({ open }: { open: boolean }) {
    return (
      <>
        <button type="button" data-testid="opener">
          Open
        </button>
        <input aria-label="Elsewhere" />
        {open && <Sheet title="Closing" onClose={() => {}} />}
      </>
    );
  }

  it("gives focus back to what opened it", async () => {
    const { rerender } = render(<Opened open={false} />);
    const opener = screen.getByTestId("opener");
    opener.focus();
    rerender(<Opened open />);
    await frames();
    rerender(<Opened open={false} />);
    await frames();
    expect(document.activeElement).toBe(opener);
  });

  it("leaves it with somebody who is already in a field when its frame comes", async () => {
    const { rerender } = render(<Opened open={false} />);
    screen.getByTestId("opener").focus();
    rerender(<Opened open />);
    await frames();
    rerender(<Opened open={false} />);
    const field = screen.getByRole("textbox", { name: "Elsewhere" });
    field.focus();
    await frames();
    expect(document.activeElement).toBe(field);
  });
});

