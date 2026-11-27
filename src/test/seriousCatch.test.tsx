// CL-3: a review that asks for changes with a P1 open names the most serious
// finding first — an info callout, words and weight only; nothing without one.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SeriousCatch } from "../components/ChallengerFindings";
import type { BuilderReview } from "../ipc";
import { renderUi } from "./render";

const review = (extra: Partial<BuilderReview>): BuilderReview => ({
  snapshotN: 1,
  provider: "codex",
  degraded: false,
  status: "done",
  verdict: "changes_requested",
  at: 1,
  ...extra,
});

const finding = (severity: string, title: string, location: string | null = null) => ({
  severity,
  title,
  body: "",
  preExisting: false,
  pass: null,
  location,
});

describe("the serious catch (CL-3)", () => {
  it("names the first open P1, its place, and how many more", () => {
    const { container } = renderUi(
      <SeriousCatch
        review={review({
          findings: [
            finding("P1", "Migration deletes user data", "src/migrate.rs:40"),
            finding("P1", "Token logged"),
            finding("P2", "Slow query"),
          ],
        })}
      />,
    );
    const callout = container.querySelector("[data-ply-serious-catch] .ux-callout")!;
    expect(callout.className).toContain("ux-callout--info");
    expect(callout.getAttribute("role")).toBeNull();
    expect(callout.querySelector(".ux-callout-title")!.textContent).toBe("Serious issue · Migration deletes user data");
    expect(callout.querySelector(".ux-callout-body")!.textContent).toBe("src/migrate.rs:40 · 1 more serious issue below");
  });

  it("says the last review's issue as the last review's, and counts in words", () => {
    const { container } = renderUi(
      <SeriousCatch
        fromLastReview
        review={review({ findings: [finding("P1", "A"), finding("P1", "B"), finding("P1", "C")] })}
      />,
    );
    expect(container.querySelector(".ux-callout-title")!.textContent).toBe("From the last review · Serious issue · A");
    expect(container.querySelector(".ux-callout-body")!.textContent).toBe("2 more serious issues below");
  });

  it("reads the ledger once there is one: a closed P1 is not a catch", () => {
    const { container } = renderUi(
      <SeriousCatch
        review={review({
          findings: [finding("P1", "Old")],
          ledger: [
            { id: "F1", severity: "P1", preExisting: false, location: null, title: "Old", body: "", reviewId: "r", round: 1, state: "closed", reason: null, updatedRound: 2 },
          ],
        })}
      />,
    );
    expect(container.querySelector("[data-ply-serious-catch]")).toBeNull();
  });

  it("draws nothing for P2s only", () => {
    const { container } = renderUi(<SeriousCatch review={review({ findings: [finding("P2", "Slow query")] })} />);
    expect(container.querySelector("[data-ply-serious-catch]")).toBeNull();
  });

  it("the Inbox's weight is ink and weight, never a colour", () => {
    const css = readFileSync("src/components/ux/ux.css", "utf8");
    const rule = /\.ux-inbox-detail--serious \{([^}]*)\}/.exec(css)![1];
    expect(rule).toContain("font-weight: 600");
    expect(rule).not.toMatch(/--signal-|--ok|--warn|--danger/);
  });
});
