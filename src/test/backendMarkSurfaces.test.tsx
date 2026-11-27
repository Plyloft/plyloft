// 1.176.0 seams: the backend's typed marks never show on the shared surfaces,
// and a surface with room for a press offers Repair for the tool they name.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Callout, ErrorBlock, FailureText, StatusLine } from "../components/ux";
import { VerifyStepOutput } from "../components/errors/VerifyStepLogs";
import { pushToast, resetToastsForTests, useToasts } from "../store/toastStore";
import { refusalError } from "../lib/aiTools";
import { renderUi, screen } from "./render";

const openRepair = vi.fn();
vi.mock("../lib/openRepair", () => ({ openRepair: (tool: string) => openRepair(tool) }));
afterEach(() => {
  openRepair.mockClear();
  resetToastsForTests();
});

const NOT_STARTING = 'PLY_CLI_NOT_STARTING_V1:{"tool":"claude"}\nClaude Code is installed at /x but doesn\'t start.';
const GONE = 'PLY_CLI_UNAVAILABLE_V1:{"tool":"codex","was":null}\ncodex: not found in PATH.';
const REFUSED = 'PLY_CLI_UPDATE_REFUSED_V1:{"tool":"codex"}\nPlyloft can\'t update this Codex: the folders its updater writes aren\'t yours to change.';
const noMark = () => expect(document.body.textContent).not.toMatch(/PLY_CLI_/);

describe("backend marks on the shared surfaces", () => {
  it("Callout and StatusLine show the sentence, not the mark", () => {
    renderUi(
      <>
        <Callout kind="warn" title="Claude stopped" text={NOT_STARTING} />
        <StatusLine state="aborted">{GONE}</StatusLine>
      </>,
    );
    expect(screen.getByText("Claude Code is installed at /x but doesn't start.")).toBeTruthy();
    expect(screen.getByText("codex: not found in PATH.")).toBeTruthy();
    noMark();
  });

  it("a Verify step that couldn't start Claude: its output stripped, and Repair", async () => {
    const view = renderUi(
      <VerifyStepOutput steps={[{ kind: "slash:review", passed: false, elapsedMs: 1, reason: NOT_STARTING } as never]} onOpenLog={null} />,
    );
    noMark();
    await view.user.click(screen.getByRole("button", { name: "Repair Claude Code" }));
    expect(openRepair).toHaveBeenCalledWith("claude");
  });

  it("FailureText offers Repair for any mark", async () => {
    const view = renderUi(<FailureText failure={{ sentence: "Codex couldn't start.", details: GONE }} />);
    noMark();
    await view.user.click(screen.getByRole("button", { name: "Repair Codex" }));
    expect(openRepair).toHaveBeenCalledWith("codex");
  });

  it("Setup's Update refused on a copy it can't update: the block's Repair opens the sheet", async () => {
    const view = renderUi(<ErrorBlock error={refusalError(REFUSED)!} onAction={() => {}} />);
    expect(screen.getByText("Codex wasn't updated.")).toBeTruthy();
    noMark();
    await view.user.click(screen.getByRole("button", { name: "Repair Codex" }));
    expect(openRepair).toHaveBeenCalledWith("codex");
  });

  it("a toast never shows a mark of any kind", () => {
    pushToast({ kind: "error", title: GONE, body: REFUSED, details: GONE });
    const t = useToasts.getState().toasts.slice(-1)[0];
    expect([t.title, t.body, t.details].join(" ")).not.toMatch(/PLY_CLI_/);
  });
});
