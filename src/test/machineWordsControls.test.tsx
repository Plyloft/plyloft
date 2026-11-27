// 1.176.2 (A5F-15, A5F-16): the words a button, a chip, a select option, a
// segment and the History sheet's own lines say about "this Mac" are this
// machine's words — "this PC" on Windows, unchanged on the Mac.
import { describe, expect, it } from "vitest";
import { CBtn, PChip } from "../components/ux";
import { Segmented, Select } from "../components/ux/controls";
import { HistoryItemSheet } from "../components/HistoryItemSheet";
import { useUi } from "../store/uiStore";
import { setPlatformForTests } from "../lib/platform";
import { act, renderUi, screen } from "./render";

// People's own text goes through the primitives untouched, on Windows too.
function Data() {
  return (
    <>
      <PChip>macOS client</PChip>
      <CBtn>Test on this Mac</CBtn>
      <Select label="Branch" value="a" onChange={() => {}} options={[{ value: "a", label: "release/macOS" }]} />
      <Segmented label="Where" value="a" onChange={() => {}} options={[{ value: "a", label: "acme/macOS-app" }]} />
    </>
  );
}

describe("this Mac, this PC", () => {
  it("leaves what people wrote alone on Windows", () => {
    setPlatformForTests("windows");
    renderUi(<Data />);
    expect(screen.getByText("macOS client")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test on this Mac" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "release/macOS" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "acme/macOS-app" })).toBeTruthy();
  });

  it("History's lines for a run that isn't here say it in the machine's words", async () => {
    for (const [p, word] of [["mac", "Mac"], ["windows", "PC"]] as const) {
      setPlatformForTests(p);
      const r = renderUi(<HistoryItemSheet />, { fixtures: { agent_run_get: () => { throw new Error("gone"); } } });
      act(() => useUi.getState().openHistorySheet({ kind: "run", workspaceId: "w", runId: "r" }));
      expect(await screen.findByText(new RegExp(`isn't on this ${word} any more`))).toBeTruthy();
      act(() => useUi.getState().openHistorySheet(null));
      r.unmount();
    }
  });
});
