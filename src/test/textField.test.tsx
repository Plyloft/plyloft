// GH #172, converting GH #103 review 1's BLOCKER from a source contract into
// behaviour. `onCommit` is a setting (saved on blur or Enter); `onEnter` is a
// procedure (Enter only) — blurring a half-typed value must never start
// something that cannot be undone. And `onCancel` answers Esc before the sheet
// around the field does. `undoable.test.ts` still holds the source shape; this
// is the field, rendered, doing it.
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Sheet, TextField } from "../components/ux";
import { nextFrame, renderUi, screen } from "./render";

/** Render, then let the sheet take focus as it does on open (one frame), so
 *  the typing below happens after it, as a person's would. */
async function open(ui: Parameters<typeof renderUi>[0]) {
  const r = renderUi(ui);
  await nextFrame();
  expect(document.activeElement).toBe(screen.getByRole("dialog"));
  return r;
}

function Invite({
  onEnter,
  onCommit,
  onCancel,
  onClose,
}: {
  onEnter?: (v: string) => void;
  onCommit?: (v: string) => void;
  onCancel?: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <Sheet title="Invite someone" onClose={onClose} actions={<button type="button">Done</button>}>
      <TextField
        label="Email"
        value={value}
        onChange={setValue}
        onEnter={onEnter}
        onCommit={onCommit}
        onCancel={onCancel}
      />
      <button type="button">Somewhere else</button>
    </Sheet>
  );
}

describe("TextField", () => {
  it("never runs onEnter on blur; Enter runs it once", async () => {
    const onEnter = vi.fn();
    const { user } = await open(<Invite onEnter={onEnter} onClose={vi.fn()} />);
    const field = screen.getByRole("textbox", { name: "Email" });

    await user.click(field);
    await user.type(field, "ada@example");
    // Looking away: by pointer, and by keyboard.
    await user.click(screen.getByRole("button", { name: "Somewhere else" }));
    await user.click(field);
    await user.tab();
    expect(field).not.toBe(document.activeElement);
    expect(onEnter).not.toHaveBeenCalled();

    await user.click(field);
    await user.keyboard("{Enter}");
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onEnter).toHaveBeenCalledWith("ada@example");
  });

  it("commits a setting on blur as well as on Enter (the contrast)", async () => {
    const onCommit = vi.fn();
    const { user } = await open(<Invite onCommit={onCommit} onClose={vi.fn()} />);
    const field = screen.getByRole("textbox", { name: "Email" });

    await user.click(field);
    await user.type(field, "4");
    await user.click(screen.getByRole("button", { name: "Somewhere else" }));
    expect(onCommit).toHaveBeenCalledWith("4");
  });

  it("Esc in the field calls onCancel, and the sheet stays open", async () => {
    const onCancel = vi.fn();
    const onClose = vi.fn();
    const { user } = await open(
      <Invite onEnter={vi.fn()} onCancel={onCancel} onClose={onClose} />,
    );
    const field = screen.getByRole("textbox", { name: "Email" });

    await user.click(field);
    await user.type(field, "half-typ");
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    // The sheet's own Esc is live — from anywhere else in it, Esc closes it —
    // so the field answering first is what kept it open above.
    await user.click(screen.getByRole("button", { name: "Somewhere else" }));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
