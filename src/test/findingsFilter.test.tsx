// Findings filter — less noise from the Challenger. On the card: a finding
// below the workspace's threshold stays listed, marked "Small note · nothing to do"; "Not a
// real issue" dismisses an open one (with an optional one-line reason) through
// `review_finding_dismiss`, and a dismissed one is listed apart, never with
// the action again. In Settings › Build and release: "Findings that block
// approval" shows this Mac's choice and saves a new one through
// `project_config_set_blocking_findings`.
import { describe, expect, it } from "vitest";
import { ChallengerFindings } from "../components/ChallengerFindings";
import { RepositoryBuildRelease } from "../components/RepositorySettings";
import type { BuilderReview, KanbanCard, LedgerFinding, ProjectConfig, ReviewSettings } from "../ipc";
import { renderUi, screen, waitFor, within } from "./render";

const card: KanbanCard = {
  id: "card-1",
  workspaceId: "ws-1",
  title: "Filter",
  columnId: "in_progress",
  createdAt: 1,
  updatedAt: 1,
};

const finding = (id: string, severity: string, extra: Partial<LedgerFinding> = {}): LedgerFinding => ({
  id,
  severity,
  preExisting: false,
  location: null,
  reason: null,
  title: `Finding ${id}`,
  body: "Body.",
  reviewId: "rev-1",
  round: 1,
  state: "open",
  updatedRound: 1,
  ...extra,
});

const review = (ledger: LedgerFinding[]): BuilderReview => ({
  snapshotN: 2,
  provider: "codex",
  degraded: false,
  status: "done",
  verdict: "changes_requested",
  reviewId: "rev-2",
  at: 1,
  ledger,
});

const item = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-ply-finding-id="${id}"]`) as HTMLElement;

describe("the card's findings", () => {
  it("marks a finding below the threshold as a small note, and a blocking one not at all", () => {
    const { container } = renderUi(
      <ChallengerFindings
        card={card}
        review={review([finding("F1", "P1"), finding("F2", "P2", { blocking: false }), finding("F3", "P3")])}
      />,
    );
    expect(item(container, "F1").querySelector("summary")!.textContent).not.toContain("Small note");
    expect(item(container, "F2").querySelector("summary")!.textContent).toContain("F2 · Should fix — Finding F2 · Small note · nothing to do");
    expect(item(container, "F3").querySelector("summary")!.textContent).toContain("· Small note · nothing to do");
  });

  it("dismisses an open finding with the member's reason", async () => {
    const { container, user, tauri } = renderUi(
      <ChallengerFindings card={card} review={review([finding("F1", "P1"), finding("F2", "P2")])} />,
      { fixtures: { review_finding_dismiss: null } },
    );
    await user.click(within(item(container, "F2")).getByRole("button", { name: "F2 is not a real issue" }));
    const reason = within(item(container, "F2")).getByRole("textbox", { name: "Why F2 is not a real issue (optional)" });
    await user.type(reason, "The lock guards it");
    await user.click(within(item(container, "F2")).getByRole("button", { name: "Dismiss F2" }));
    await waitFor(() => expect(tauri.callsOf("review_finding_dismiss")).toHaveLength(1));
    expect(tauri.callsOf("review_finding_dismiss")[0].args).toEqual({
      workspaceId: "ws-1",
      cardId: "card-1",
      findingId: "F2",
      reason: "The lock guards it",
    });
    // The other finding never asked anything.
    expect(within(item(container, "F1")).queryByRole("textbox")).toBeNull();
  });

  it("sends no reason when none is typed, and Keep it asks nothing", async () => {
    const { container, user, tauri } = renderUi(
      <ChallengerFindings card={card} review={review([finding("F2", "P2")])} />,
      { fixtures: { review_finding_dismiss: null } },
    );
    const row = item(container, "F2");
    await user.click(within(row).getByRole("button", { name: "F2 is not a real issue" }));
    await user.click(within(row).getByRole("button", { name: "Keep it" }));
    expect(tauri.callsOf("review_finding_dismiss")).toHaveLength(0);
    await user.click(within(row).getByRole("button", { name: "F2 is not a real issue" }));
    await user.type(within(row).getByRole("textbox"), "   {Enter}");
    await waitFor(() => expect(tauri.callsOf("review_finding_dismiss")).toHaveLength(1));
    expect(tauri.callsOf("review_finding_dismiss")[0].args.reason).toBeNull();
  });

  it("lists a dismissed finding apart, marked Dismissed, with its reason and no action", () => {
    const dismissed = finding("F2", "P2", { dismissal: { reason: "Intended", at: 5, round: 1 } });
    const { container } = renderUi(
      <ChallengerFindings card={card} review={review([finding("F1", "P1"), dismissed])} />,
    );
    expect(screen.getByText("1 open finding")).toBeTruthy();
    expect(screen.getByText("1 dismissed as not a real issue")).toBeTruthy();
    const row = item(container, "F2");
    expect(row.querySelector("summary")!.textContent).toContain("· Dismissed");
    expect(row.textContent).toContain("dismissed as not a real issue: Intended");
    expect(within(row).queryByRole("button", { name: /not a real issue/ })).toBeNull();
    // A closed finding offers no dismissal either.
    const closed = renderUi(
      <ChallengerFindings card={card} review={review([finding("F7", "P2", { state: "closed" })])} />,
    );
    expect(within(closed.container).queryByRole("button", { name: "F7 is not a real issue" })).toBeNull();
  });
});

const config: ProjectConfig = {
  schemaVersion: 2,
  targetBranch: "main",
  versionFiles: [],
  installScript: null,
  verifyPipeline: null,
  createdAt: 0,
  updatedAt: 0,
};

function openSettings(initial: ReviewSettings) {
  let settings = initial;
  const view = renderUi(<RepositoryBuildRelease workspaceId="ws" cwd="/r" />, {
    withToasts: true,
    fixtures: {
      workspace_definition_get: null,
      project_config_get: config,
      project_review_get: () => settings,
      project_config_detect: { config, hasClaudeMd: false, notes: [] },
      workspace_definition_branches: { branches: ["main"], defaultBranch: "main", error: null, hasOrigin: true },
      worktree_settings_get: {},
      project_config_set_blocking_findings: (args: Record<string, unknown>) => {
        settings = { ...settings, blockingFindings: args.threshold as ReviewSettings["blockingFindings"] };
        return settings;
      },
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

describe("Findings that block approval", () => {
  it("reads P1 and P2 from a backend that predates the setting, and saves P1 only", async () => {
    const { user, tauri } = openSettings({ selfCheck: true, reviewChecklist: [] });
    const select = (await screen.findByRole("combobox", { name: "Findings that block approval" })) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("p1-p2"));
    expect(screen.getByText(/Minor ones stay on the card as small notes, with nothing to do/)).toBeTruthy();
    await user.selectOptions(select, "p1");
    await waitFor(() => expect(tauri.callsOf("project_config_set_blocking_findings")).toHaveLength(1));
    expect(tauri.callsOf("project_config_set_blocking_findings")[0].args).toEqual({ workspaceId: "ws", threshold: "p1" });
    await waitFor(() => expect(screen.getByText(/^Only serious findings keep a card in changes requested/)).toBeTruthy());
    expect(select.value).toBe("p1");
  });
});
