import { pushErrorToast } from "../../lib/errorToast";
import { useEffect, type ReactNode } from "react";
import {
  CBtn,
  Details,
  EmptyState,
  Group,
  PageHeader,
  Row,
  Section,
  StatusLine,
} from "../ux";
import { InstructionsFlow } from "./InstructionsFlow";
import { PublishRefusedBlock } from "../errors/PublishRefusedBlock";
import type { InstructionsData } from "./useInstructionsData";
import {
  INSTRUCTIONS_LEDE,
  REPOSITORY_MEANING,
  REPOSITORY_SECTION,
  THIS_MAC_EMPTY,
  THIS_MAC_MEANING,
  THIS_MAC_NOTE,
  THIS_MAC_SECTION,
  fileAskBuilder,
  fileHint,
  instructionNotes,
  instructionRow,
  instructionTransient,
  instructionsStatus,
  personalDetails,
  personalHint,
} from "../../lib/libraryInstructions";
import { useLibrary } from "../../store/libraryStore";
// GH #104: the Challenger's one suggested change, when its target is one of
// these two files.
import { ProposalBlock } from "./ProposalBlock";
import { proposalIsFor } from "../../lib/proposals";
import { useProposal } from "../../store/proposalStore";
import { pushToast } from "../../store/toastStore";
import { machineWords, platformWord } from "../../lib/platform";
import { ASK_BUILDER } from "../../lib/askBuilder";
import { useWorkspaces } from "../../store/workspaceStore";
import { askTheBuilder } from "./askTheBuilder";

/**
 * UX language card 6 (GH #101; BOARDS.md §5 "A procedure"): the Library's
 * Instructions page.
 *
 * Title, lede, then `In this repository` — a Value row per instruction file the
 * CLIs read, and the `Agent instructions` Procedure row whose words come from the
 * existing instruction doctor — and `On this Mac`, read-only, with both CLIs' own
 * files, each of which opens in Code as a reading view (GH #174).
 *
 * **What it says, it does not decide.** Every sentence comes from
 * `lib/libraryInstructions.ts` or from the doctor behind it: this file reads that
 * and draws. The row's one step opens `InstructionsFlow`, which replaces the page
 * while it is open (PATTERNS.md §6, "no navigation").
 *
 * The page is a `Page` and nothing inside it scrolls on its own. `Open in Code`
 * is offered **only** where `openInCode` is a path — never for a personal file,
 * which Ply must not write, and never for a copy that only the branch has; both
 * of those open read-only instead.
 */
export function InstructionsPage({
  workspaceId,
  data,
  controls,
}: {
  workspaceId: string;
  data: InstructionsData;
  /** The narrow centre's page choices, which sit under the lede. */
  controls?: ReactNode;
}) {
  const { view, library, loading, busy, openInCode, openReadOnly, setUp, reveal } =
    data;
  const inFlow = useLibrary((s) => s.byWorkspace[workspaceId]?.flow?.kind) === "instructions";
  // QoL 13.2: where Ask the Builder opens its session.
  const cwd = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.cwd) ?? null;
  const ask = (prompt: string | null | undefined) =>
    prompt && cwd ? (
      <CBtn onClick={() => askTheBuilder(workspaceId, cwd, prompt)} disabled={busy}>
        {ASK_BUILDER}
      </CBtn>
    ) : null;
  // GH #104: read as one slice, never derived in the selector (PATTERNS.md).
  const stored = useProposal((s) => s.byWorkspace[workspaceId]?.view) ?? null;
  const proposalBusy = useProposal((s) => s.byWorkspace[workspaceId]?.loading) ?? false;

  const transient = instructionTransient(library, view?.branch ?? null);
  const row = view
    ? instructionRow(view.procedure, view.files, transient, {
        readOnly: view.shared && view.readOnly,
        branch: view.branch,
      })
    : null;
  const status = instructionsStatus(view);
  const notes = instructionNotes(view, library);

  // A flow the page cannot draw must not be left open: the host takes the inner
  // column away for as long as the store says a flow is open, so a step that
  // stopped existing under the member — a teammate's Sync made the repository
  // compliant, or the publish landed — would strand them on a page with no
  // navigation. Closing it puts the column back and shows the new state.
  const nothingToSetUp = view != null && view.plan === null;
  useEffect(() => {
    if (inFlow && nothingToSetUp) useLibrary.getState().setFlow(workspaceId, null);
  }, [inFlow, nothingToSetUp, workspaceId]);

  // GH #104: only a proposal about one of **these** files, and only one of them
  // — `view.files` is what this page carries, so a proposal about a file this
  // repository does not have is not drawn as though it did.
  const proposal = view?.files.some((file) =>
    proposalIsFor(stored, { page: "instructions", file: file.name }),
  )
    ? stored
    : null;

  async function approveProposal() {
    const done = await useProposal.getState().approve(workspaceId);
    if (!done) {
      pushErrorToast("Couldn\u2019t approve the change", useProposal.getState().byWorkspace[workspaceId]?.error ?? "");
      return;
    }
    // The row's transient state is what says a publish is in flight, and it is
    // read from the library state, so this page reads it again (GH #101).
    data.reload();
    // SP-5: without a shared definition the change was committed (or published)
    // already, and the backend says what happened.
    const approved = useProposal.getState().byWorkspace[workspaceId]?.approved;
    pushToast(
      approved
        ? { kind: "info", title: approved.title, body: approved.body }
        : {
            kind: "info",
            title: "The change to the instructions is queued",
            body: `Everyone who opens this repository gets it once it lands; the row says when. Your project folder is untouched \u2014 once it has landed, ${ASK_BUILDER} to bring it here, and the agents here read it too.`,
          },
    );
  }

  async function dismissProposal() {
    const done = await useProposal.getState().dismiss(workspaceId);
    if (!done) {
      pushErrorToast("Couldn\u2019t dismiss the suggested skill change", useProposal.getState().byWorkspace[workspaceId]?.error ?? "");
    }
  }

  // The flow replaces the page, as the board draws it: a surface of its own with
  // nothing else on it. The host has already taken the inner column away, because
  // the flow is in the store (GH #96 review 1).
  if (inFlow && view?.plan) {
    return (
      <InstructionsFlow
        plan={view.plan}
        busy={busy}
        onCancel={() => useLibrary.getState().setFlow(workspaceId, null)}
        onSetUp={() => void setUp(view.plan!)}
      />
    );
  }

  return (
    <>
      {/* GH #313: no badge — the page holds this repository's files and this
          Mac's, and one on the header would claim it belonged to a single
          scope (the Skills page leaves it out for the same reason). */}
      <PageHeader
        title="Instructions"
        lede={INSTRUCTIONS_LEDE}
        status={status && <StatusLine state={status.state}>{status.text}</StatusLine>}
      />
      {controls}
      {/* GH #101 review 1 (MAJOR): the read-only refusal, on the page it is
          about. `errorBlockStore` holds one per workspace and routes `Show` by
          the kinds still queued, so this draws only an instructions refusal and
          the Skills page keeps its own. */}
      <PublishRefusedBlock workspaceId={workspaceId} on="instructions" />
      {/* GH #104 (BOARDS.md §4 state C): the Challenger's change to one of the
          two instruction files, on the page those two live on. */}
      {proposal && (
        <ProposalBlock
          view={proposal}
          busy={proposalBusy || busy}
          onApprove={() => void approveProposal()}
          onDismiss={() => void dismissProposal()}
          nowMs={Date.now()}
        />
      )}
      {loading && !view && (
        <EmptyState>Reading this repository and this Mac…</EmptyState>
      )}
      {view && (
        <Section title={REPOSITORY_SECTION} count={REPOSITORY_MEANING}>
          <Group label={REPOSITORY_SECTION}>
            {view.files.map((file) => (
              <Row
                key={file.name}
                kind="value"
                label={file.name}
                mono
                // GH #161: with the transient, so a copy only the queue has says
                // where the change waits rather than `On staging only`.
                hint={fileHint(file, view, transient)}
                action={ask(fileAskBuilder(file, view.branch))}
                // GH #142: the board's `›` for both copies — the checkout's,
                // which opens as an editor, and the one only the branch has,
                // which opens from Ply's mirror as a reading view. Never both:
                // `file_rows` sets one path or the other.
                onOpen={
                  file.openInCode
                    ? () => void openInCode(file.openInCode!)
                    : file.readOnlyPath
                      ? () => void openReadOnly(file.readOnlyPath!, "branch")
                      : undefined
                }
              />
            ))}
            {row && (
              <Row
                kind="procedure"
                label={row.label}
                hint={
                  row.transient ? (
                    <span
                      /* The board (§3): a publish in flight pulses, and one
                         waiting or refused carries the aborted dot. Never the
                         dot alone — the sentence is beside it. */
                      className={
                        row.transient.kind === "publishing"
                          ? "ux-row-signal ux-row-signal--running"
                          : "ux-row-signal ux-row-signal--aborted"
                      }
                    >
                      <span className="ux-row-signal-dot" aria-hidden />
                      {row.transient.sentence}
                    </span>
                  ) : (
                    row.sentence
                  )
                }
                state={
                  row.transient?.kind === "publishing"
                    ? "publishing"
                    : row.transient?.kind === "pullRequest" ||
                        row.transient?.kind === "blocked"
                      ? "waiting"
                      : undefined
                }
                onOpen={row.opens ? () => void openInCode(row.opens!) : undefined}
                action={
                  row.action ? (
                    // A plain button, like Diagnostics' `Sign in` and `Choose
                    // zsh`: the step's primary is the `Set up` inside the flow,
                    // and a row does not hold the surface's primary action.
                    <CBtn
                      onClick={() =>
                        useLibrary
                          .getState()
                          .setFlow(workspaceId, { kind: "instructions", key: "instructions" })
                      }
                      disabled={busy || view.plan === null}
                    >
                      {row.action}
                    </CBtn>
                  ) : row.pullRequest != null ? (
                    <CBtn
                      onClick={() => void data.openPullRequest(row.pullRequest!)}
                      disabled={busy}
                    >
                      Open pull request
                    </CBtn>
                  ) : row.askBuilder ? (
                    // QoL 13.2 (D4): the project folder is behind the branch.
                    ask(row.askBuilder)
                  ) : // Nothing to do: the row shows its sentence and, when the
                  // shared file is in this checkout, the board's `›`. Never a
                  // button that would do nothing (PATTERNS.md §3).
                  null
                }
              />
            )}
          </Group>
        </Section>
      )}
      {view && (
        <Section title={THIS_MAC_SECTION} count={THIS_MAC_MEANING}>
          <p className="ux-section-note">{machineWords(THIS_MAC_NOTE)}</p>
          {view.personal.length === 0 ? (
            <EmptyState>{THIS_MAC_EMPTY}</EmptyState>
          ) : (
            <Group label={THIS_MAC_SECTION}>
              {view.personal.map((file) => (
                <Row
                  key={file.rel}
                  kind="value"
                  label={file.rel}
                  mono
                  hint={personalHint(file)}
                  // GH #174: the board's `›`, as a reading view only — the
                  // path Rust listed, read through `listed_instruction_file`,
                  // into a tab that cannot be saved (place `this-mac`).
                  onOpen={() => void openReadOnly(file.path, "this-mac")}
                >
                  {/* Never the writable `Open in Code`, because Plyloft must never
                      write there. `Details` holds the path and Finder. */}
                  <Details>
                    {personalDetails(file).map((line) => (
                      <div key={line} className="ux-details-line">
                        {line}
                      </div>
                    ))}
                    <div className="ux-details-action">
                      <CBtn tone="quiet" size="sm" onClick={() => void reveal(file.path)}>
                        {platformWord("reveal")}
                      </CBtn>
                    </div>
                  </Details>
                </Row>
              ))}
            </Group>
          )}
        </Section>
      )}
      {notes.map((note) => (
        <StatusLine key={note} state="empty">
          {note}
        </StatusLine>
      ))}
    </>
  );
}
