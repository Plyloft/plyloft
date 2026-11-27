import { useEffect, useRef, useState, type ReactNode } from "react";
import { openDialog } from "../lib/nativeDialog";
import {
  projectConfigDelete,
  projectConfigDetect,
  projectConfigSetBlockingFindings,
  projectTryCommandGet,
  projectTryCommandSave,
  workspaceDefinitionBranches,
  type BlockingThreshold,
  type TryCommandView,
  type BranchChoices,
  type ReviewChecklistClass,
  type VerifyKind,
  type VersionFileEntry,
  workspaceAdoptionSetupElsewhere,
} from "../ipc";
import {
  BUILD_FIELDS,
  GENERAL_FIELDS,
  branchesUnreadWhy,
  cachePathProblem,
  matchesFilter,
  nameHint,
  needsFilter,
  restingHint,
  NOTHING_AFTER,
  setupApprovalNote,
  restoreFile,
  rowLabel,
  valueText,
  verifyStepText,
  versionFileFor,
  versionFileKindWords,
  versionFileRows,
  whyNotAVersionFile,
  withoutFile,
} from "../lib/repositoryPage";
import {
  CLASS_MAX_CHARS,
  MAX_CLASSES,
  checklistError,
  classChars,
  classLetter,
  indexOfClass,
  withClass,
} from "../lib/reviewChecklist";
import { ACCENT_CHOICES, accentChoice, accentName } from "../lib/repositoryAccent";
import { BLOCKING_CHOICES, blockingFindingsHint } from "../lib/challengerReview";
import { reDetectProblem, resetProblem } from "../lib/publishDraft";
import { FOUND_FOR_SHIPPING, handOffToShipping, reDetectChangesSharedToast, type ShippingFind } from "../lib/shippingPage";
import { worktreeCopyProblem } from "../lib/worktreeSetup";
import { tryCommandProblem, tryPendingMark, tryRowHint, tryRowState } from "../lib/tryCommand";
import { pushToast } from "../store/toastStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useChecksConsent } from "../store/checksConsentStore";
import { checksApprovalNote, installApprovalNote } from "../lib/checksConsent";
import { RepositoryPage, type RepositoryDraft } from "./RepositoryPage";
import {
  keepSetupLocal,
  openSetupPullRequest,
  proposeConversionAgain,
  shareSetupAgain,
  stopSharingSetup,
  useAdoptionStatus,
} from "./AdoptionBanner";
import { keptOwnSetupRow } from "../lib/adoption";
import {
  KEEP_ON_THIS_MAC,
  OPEN_PULL_REQUEST,
  PROPOSE_AGAIN,
  SHARE_AGAIN,
  STOP_SHARING,
  sharedSetupRow,
} from "../lib/sharedSetup";
import type { Scope } from "../lib/uxScope";
import { entryWords } from "../lib/settingsNav";
import { PartsOf, useEntryFlow } from "./settings/rows";
import { useCommandLine } from "./settings/CheckedField";
import { TEAM_MODELS_NOTE, TEAM_MODELS_TITLE, TeamModelsPage, TeamModelsSection } from "./settings/WorkspaceModelsSection";
import {
  CBtn,
  DangerZone,
  Details,
  Group,
  Sheet,
  MoreMenu,
  Row,
  RowValue,
  Section,
  SearchField,
  Select,
  Swatches,
  TextField,
  Toggle,
  type SelectOption,
} from "./ux";
import { isAbsolutePath, relativeTo, toPosix } from "../lib/paths";
import { machineWords, platformWord } from "../lib/platform";
import { usePutOnGithub } from "../store/putOnGithubStore";
import { pushErrorToast } from "../lib/errorToast";

/**
 * UX language card 2 (BOARDS.md §2 and §6): Settings › Repository — the two
 * pages, drawn as the boards fixed them. Their shell, the draft and the
 * publish bar are `RepositoryPage`'s; what is here is the rows.
 *
 * The old `SharedDefinitionPanel` (a JSON textarea) and `ProjectConfigPanel`
 * (a read-only dump with Detect and Reset) are gone: one page edits both,
 * and the local config's `Reset` is the This-Mac page's danger zone.
 */


// ── Settings › Repository › Build & release ───────────────────────────

export function RepositoryBuildRelease({
  workspaceId,
  hiddenNote = null,
  scope,
}: {
  workspaceId: string;
  /** The project folder. Unread since 1.174.0 (DS2): its one user, the
   *  version files' picker, is Shipping's. */
  cwd?: string;
  hiddenNote?: string | null;
  scope?: Scope;
}) {
  // What origin really offered, why it could not be read, and the branch a
  // workspace with none of its own falls back to.
  const [discovery, setDiscovery] = useState<BranchChoices | null>(null);
  const [detected, setDetected] = useState<{
    installScript: string | null;
    verifyPipeline: VerifyKind[] | null;
  } | null>(null);
  const [detecting, setDetecting] = useState(false);
  // 1.176.1: the folder the project's commands are read against.
  const projectFolder = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.cwd ?? null);
  // `Add a checklist class` on a card opens Settings here with the class in
  // hand; the sub-page that edits it is what should be open.
  const drafted = useUi((s) => s.checklistDraft);
  const openAt = drafted && drafted.workspaceId === workspaceId ? "checklist" : null;

  // A scan of the repository on open fills the two script rows with what
  // is actually there: a select never offers a script that does not exist.
  // It reads the filesystem and writes nothing; `Re-detect` is what puts a
  // finding into the page.
  useEffect(() => {
    let live = true;
    projectConfigDetect(workspaceId)
      .then((proposal) => {
        if (!live) return;
        setDetected({
          installScript: proposal.config.installScript ?? null,
          verifyPipeline: proposal.config.verifyPipeline ?? null,
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [workspaceId]);

  // 1.175.0 F3 walk: read again once the project was put on GitHub.
  const putCount = usePutOnGithub((s) => s.puts[workspaceId] ?? 0);
  useEffect(() => {
    let live = true;
    workspaceDefinitionBranches(workspaceId)
      .then((choices) => {
        if (live) setDiscovery(choices);
      })
      .catch((e) => {
        // The row says why rather than offering a list Ply cannot stand
        // behind.
        if (live) {
          setDiscovery({ branches: [], defaultBranch: "", error: String(e), hasOrigin: false });
        }
      });
    return () => {
      live = false;
    };
  }, [workspaceId, putCount]);

  return (
    <RepositoryPage
      workspaceId={workspaceId}
      order={BUILD_FIELDS}
      title={entryWords("build-release").label}
      lede={entryWords("build-release").lede}
      subPages={{
        "cache-paths": {
          title: "Extra cache paths",
          lede: "Folders card builds share as well as the dependency folders. Only git-ignored, untracked folders are ever reused.",
          back: entryWords("build-release").label,
        },
        "worktree-copy": {
          title: "Files copied in",
          lede: "Git-ignored files a card's copy needs and git leaves out, like a .env. Plyloft copies them from the project folder of whoever starts the card, before the Builder starts. Only the names are kept here, never what the files hold.",
          back: entryWords("build-release").label,
        },
        checklist: {
          title: "Checklist classes",
          lede: "This repository's own risk classes. Classes A to I ship with Plyloft; these follow as J, K… in the Reviewer's sweep and in the Builder's self-check.",
          back: entryWords("build-release").label,
        },
      }}
      openAt={openAt}
      hiddenNote={hiddenNote}
      scope={scope}
      fallbackBranch={discovery?.defaultBranch || null}
      danger={(d) =>
        d.repo.shared ? null : <LocalReset workspaceId={workspaceId} draft={d} />
      }
    >
      {(d) => {
        if (d.sub === "cache-paths") return <CachePathsPage draft={d} />;
        if (d.sub === "worktree-copy") return <WorktreeCopyPage draft={d} />;
        if (d.sub === "checklist")
          return <ChecklistPage draft={d} workspaceId={workspaceId} />;
        return (
          <>
            {/* 1.174.0 (DS3, scene 5): only building and checking, in the
                order a card meets them; each section says where it's kept.
                Cards go to, After a release, run and Version files are in
                Settings › Shipping (DS2). */}
            <Section title="Checks" scope="repository" shared={d.repo.shared}>
              <Group label="Checks">
                <VerifyRow draft={d} detected={detected?.verifyPipeline ?? null} />
                <ToggleRow draft={d} field="selfCheck" />
                <ListRow draft={d} field="reviewChecklist" sub="checklist" />
              </Group>
            </Section>
            <Section title="Review" scope="this-mac">
              <Group label="Review">
                <BlockingFindingsRow draft={d} workspaceId={workspaceId} />
              </Group>
            </Section>
            <Section title="Each card's copy" scope="repository" shared={d.repo.shared}>
              <Group label="Each card's copy">
                <ListRow draft={d} field="worktreeCopy" sub="worktree-copy" />
                <SetupCommandRow draft={d} project={projectFolder} />
              </Group>
            </Section>
            <Section title="Build cache" scope="repository" shared={d.repo.shared}>
              <Group label="Build cache">
                <ToggleRow draft={d} field="sharedBuildCache" />
                <ListRow draft={d} field="cachePaths" sub="cache-paths" />
              </Group>
            </Section>
            <Section title="Try it" scope="repository" shared={d.repo.shared}>
              <Group label="Try it">
                <TryCommandRow workspaceId={workspaceId} draft={d} project={projectFolder} />
              </Group>
            </Section>
            <Section title="Read the project again" scope="repository" shared={d.repo.shared}>
              <Group label="Read the project again">
                <Row
                  kind="procedure"
                  label="Read the repository again"
                  hint={
                    d.readOnly
                      ? "Needs write access — the result would have to be published."
                      : d.repo.shared
                        ? "The checks come from the shared setup. Re-detect reads this folder as it is, which may be behind the branch the setup is on; what it finds is a change to the shared checks, and nothing reaches anyone until you publish. The version files and After a release, run it finds wait in Shipping."
                        : "Looks for the checks, the version files and what runs after a release as they are today. Saved on this Mac at once."
                  }
                  action={
                    d.readOnly ? undefined : (
                      <CBtn
                        tone="strong"
                        disabled={detecting || d.frozen}
                        onClick={() => {
                          setDetecting(true);
                          // The scan reads the filesystem and writes
                          // nothing, so it runs on its own; what it finds
                          // then goes in through the ordinary change, which
                          // is what the write queue is for. Running the
                          // scan *inside* a queued job would deadlock: the
                          // change it makes waits for the job that is
                          // waiting for it.
                          void projectConfigDetect(workspaceId)
                            .then(async (proposal) => {
                              setDetected({
                                installScript: proposal.config.installScript ?? null,
                                verifyPipeline: proposal.config.verifyPipeline ?? null,
                              });
                              // 1.174.0 (DS2): each page publishes its own
                              // rows. Kept here, the three save at once; shared,
                              // this page drafts only its checks — the version
                              // files and what runs after a release belong
                              // to the Shipping draft, never to this Review.
                              const found = {
                                versionFiles: proposal.config.versionFiles,
                                installScript: proposal.config.installScript ?? null,
                                verifyPipeline: proposal.config.verifyPipeline ?? null,
                              };
                              const ok = await d.setMany(
                                d.repo.shared ? { verifyPipeline: found.verifyPipeline } : found,
                              );
                              if (ok) d.fail(null);
                              // Two-instance walk (B2): the shared checks,
                              // read from a folder that may be behind — said.
                              if (ok) sayIfSharedChecksChange(d, found.verifyPipeline);
                              // DS2 round 1: what it found for Shipping goes
                              // into the Shipping draft when that page opens.
                              if (ok && d.repo.shared && shippingFindDiffers(d, found)) {
                                handOffToShipping(workspaceId, found);
                                pushToast({
                                  kind: "info",
                                  title: FOUND_FOR_SHIPPING.title,
                                  body: FOUND_FOR_SHIPPING.body,
                                  action: {
                                    label: FOUND_FOR_SHIPPING.action,
                                    onClick: () =>
                                      useUi.getState().openSettingsSection("shipping", { workspaceId }),
                                  },
                                });
                              }
                            })
                            .catch((e) => d.fail(reDetectProblem(String(e))))
                            .finally(() => setDetecting(false));
                        }}
                      >
                        {detecting ? "Reading…" : "Re-detect"}
                      </CBtn>
                    )
                  }
                >
                  {/* Tidy tables: a value sits in the value column, never in action. */}
                  {d.readOnly && <RowValue>Re-detect</RowValue>}
                </Row>
              </Group>
            </Section>
          </>
        );
      }}
    </RepositoryPage>
  );
}

// ── Settings › Repository › General ───────────────────────────────────

/** X2 (1.171.0): after "Keep this folder's setup" on the board, the way
 *  back to the shared setup found on another branch. */
export function KeptOwnSetupRow({ workspaceId }: { workspaceId: string }) {
  const { status, reload } = useAdoptionStatus(workspaceId);
  const refreshWorkspaces = useWorkspaces((s) => s.refresh);
  // B1: which of the setups is being set up (several branches: one each).
  const [busy, setBusy] = useState<string | null>(null);
  const row = keptOwnSetupRow(status);
  if (!row) return null;
  async function use(branch: string | null) {
    setBusy(branch ?? "");
    try {
      await workspaceAdoptionSetupElsewhere(workspaceId, true, branch);
      await refreshWorkspaces();
    } catch (e) {
      pushErrorToast("Couldn't use that setup", e);
    } finally {
      setBusy(null);
      reload();
    }
  }
  return (
    <Row
      kind="procedure"
      label="Shared setup"
      hint={row.hint}
      action={
        <>
          {row.uses.map((u) => (
            <CBtn
              key={u.branch ?? ""}
              tone="strong"
              disabled={busy !== null}
              onClick={() => void use(u.branch ?? null)}
            >
              {busy === (u.branch ?? "") ? "Setting up…" : u.label}
            </CBtn>
          ))}
        </>
      }
    />
  );
}

/** 1.175.0 (C1, SC-2): whether this project's setup is shared, and the way
 *  out or back — *Stop sharing…* while it is, the removed-setup notice's two
 *  answers while that waits, *Share it again…* once it is kept here. Drawn
 *  only for a project that shares or shared its setup. One bordered button
 *  (two for the notice's choice); the red one is in the sheet. */
/** Two-instance walk (B2): Re-detect found other checks than the team's
 *  shared ones — a change to the shared setup, said before it is published. */
function sayIfSharedChecksChange(d: RepositoryDraft, found: unknown) {
  const same = JSON.stringify(found ?? null) === JSON.stringify(d.repo.values.verifyPipeline ?? null);
  if (d.repo.shared && !same) pushToast({ kind: "warn", ...reDetectChangesSharedToast(d.repo.branch) });
}

export function SharedSetupRow({ workspaceId, offline }: { workspaceId: string; offline: boolean }) {
  const { status, reload } = useAdoptionStatus(workspaceId);
  const [busy, setBusy] = useState<"stop" | "keep" | "again" | "propose" | null>(null);
  const setup = status?.sharedSetup ?? null;
  const row = sharedSetupRow(setup, status?.githubRepo ?? null, { offline, nowSecs: Date.now() / 1000 });
  if (!row || !setup) return null;
  // WALKFIX-1: a press behind a sheet says "Stopping…" / "Sharing…" only
  // once the sheet's own press said yes, never while it is open.
  async function run(what: "stop" | "keep" | "again" | "propose", press: (started: () => void) => Promise<boolean>) {
    try {
      await press(() => setBusy(what));
    } finally {
      setBusy(null);
      reload();
    }
  }
  const again = (
    <CBtn disabled={busy !== null} onClick={() => void run("again", (started) => shareSetupAgain(workspaceId, status, started))}>
      {busy === "again" ? "Sharing…" : SHARE_AGAIN}
    </CBtn>
  );
  return (
    <Row
      kind="procedure"
      label="Shared setup"
      hint={machineWords(row.hint)}
      action={
        row.action === "stop" && setup.state === "shared" ? (
          <CBtn
            disabled={busy !== null || row.disabled}
            onClick={() => void run("stop", (started) => stopSharingSetup(workspaceId, setup, started))}
          >
            {busy === "stop" ? "Stopping…" : STOP_SHARING}
          </CBtn>
        ) : row.action === "openPullRequest" && row.pullRequest != null ? (
          <CBtn onClick={() => openSetupPullRequest(workspaceId, row.pullRequest!)}>{OPEN_PULL_REQUEST}</CBtn>
        ) : row.action === "propose" ? (
          // C2: the same sentence and the same button as the notice on the Board.
          <CBtn disabled={busy !== null} onClick={() => void run("propose", (started) => (started(), proposeConversionAgain(workspaceId)))}>
            {busy === "propose" ? "Proposing…" : (row.label ?? PROPOSE_AGAIN)}
          </CBtn>
        ) : row.action === "shareAgain" ? (
          again
        ) : row.action === "choose" ? (
          <>
            <CBtn disabled={busy !== null} onClick={() => void run("keep", (started) => (started(), keepSetupLocal(workspaceId)))}>
              {machineWords(KEEP_ON_THIS_MAC)}
            </CBtn>
            {again}
          </>
        ) : undefined
      }
    />
  );
}

/** General's sub-page of the team's suggested models (1.174.0, DS4). */
const TEAM_MODELS_SUB = "team-models";

export function RepositoryGeneral({
  workspaceId,
  hiddenNote = null,
  scope,
  board = null,
  boardUnread = false,
}: {
  workspaceId: string;
  hiddenNote?: string | null;
  scope?: Scope;
  /** 1.174.0 (DS1): the Board part (`BoardPage`), drawn under the rows. */
  board?: ReactNode;
  /** The Board part hasn't drawn its rows yet: it is still being read. */
  boardUnread?: boolean;
}) {
  // While the Board's flow is up it is the page (PATTERNS.md §6).
  const boardFlow = useEntryFlow("general") !== null;
  return (
    <RepositoryPage
      workspaceId={workspaceId}
      order={GENERAL_FIELDS}
      title="General"
      lede={entryWords("general").lede}
      hiddenNote={hiddenNote}
      scope={scope}
      after={board && <PartsOf entry="general">{board}</PartsOf>}
      afterReading={boardUnread}
      flowUp={boardFlow}
      // 1.174.0 (DS4, scene 8): the team's suggested models, under where the
      // cards live; Change… opens their sub-page.
      subPages={{
        [TEAM_MODELS_SUB]: { title: TEAM_MODELS_TITLE, lede: TEAM_MODELS_NOTE, back: entryWords("general").label },
      }}
      below={(d) => <TeamModelsSection workspaceId={workspaceId} onOpen={() => d.openSub(TEAM_MODELS_SUB)} />}
    >
      {(d) => d.sub === TEAM_MODELS_SUB ? (
        <TeamModelsPage workspaceId={workspaceId} />
      ) : (
        // 1.174.0 (DS5, scene 8): the project's own rows; where the cards
        // live is the Board part's section, under these.
        <Section title="This project" scope="repository" shared={d.repo.shared}>
          <Group label="This project">
            <NameRow draft={d} workspaceId={workspaceId} />
            <Row
              kind="choice"
              // 1.174.0 (DS5 round 1): the section's mark says whether it's shared.
              label={rowLabel("accentColor")}
              {...d.rowProps("accentColor", restingHint("accentColor", null))}
            >
              <Swatches
                value={
                  accentChoice(d.value("accentColor"))?.value ??
                  ((d.value("accentColor") as string) || null)
                }
                options={ACCENT_CHOICES}
                name={accentName(d.value("accentColor"))}
                onChange={(next) => void d.set("accentColor", next)}
                label="Workspace colour"
              />
            </Row>
            <KeptOwnSetupRow workspaceId={workspaceId} />
            <SharedSetupRow workspaceId={workspaceId} offline={d.repo.publishing?.offline ?? false} />
          </Group>
        </Section>
      )}
    </RepositoryPage>
  );
}

// ── The rows ──────────────────────────────────────────────────────────
// Every row takes its label from the shared vocabulary and its mark, its
// anchor and its hint from the page's draft.

/** Cards go to (`integrationBranch`): a Select of the branches origin
 *  really offers. Drawn by Settings › Shipping (1.174.0, DS2). */
export function IntegrationBranchRow({
  draft,
  discovery,
}: {
  draft: RepositoryDraft;
  discovery: BranchChoices | null;
}) {
  const value = (draft.value("integrationBranch") as string) ?? "";
  const inUse = value || draft.repo.branch;
  // Only a read that went through and found branches lets the row choose:
  // a list padded after a failed fetch would let someone pick a branch
  // nobody read (F7).
  const known = !!discovery && !discovery.error && discovery.branches.length > 0;
  const offered = known ? discovery!.branches : [inUse];
  const options: SelectOption[] = (
    offered.includes(inUse) ? offered : [inUse, ...offered]
  ).map((b) => ({ value: b, label: b }));
  const why = !discovery
    ? "Plyloft is reading this repository's branches."
    : discovery.error
      ? machineWords(branchesUnreadWhy(discovery.trouble, discovery.originHost))
      : discovery.hasOrigin
        ? "Can't be changed: this project has no branches on GitHub to choose from."
        : "Can't be changed: this project isn't online, so there is nowhere to publish to.";
  return (
    <Row
      kind="choice"
      label={rowLabel("integrationBranch")}
      {...draft.rowProps(
        "integrationBranch",
        known ? restingHint("integrationBranch", value) : why,
      )}
      disabled={draft.frozen || (!known && !draft.readOnly)}
    >
      <Select
        value={inUse}
        options={options}
        mono
        onChange={(next) => void draft.set("integrationBranch", next)}
        label={rowLabel("integrationBranch")}
      />
    </Row>
  );
}

/** `None`, the value the repository runs today, the one the page holds, and
 *  what a scan of the repository found: Ply offers what it can stand behind,
 *  never a free-text command. The value in use stays offered after a change
 *  to `None`, so the change can be taken back one row at a time. */
function scriptOptions(
  inUse: string | null,
  drafted: string | null,
  detected: string | null,
): SelectOption[] {
  // W6 (1.174.0): the empty choice is "Nothing".
  const out: SelectOption[] = [{ value: "", label: NOTHING_AFTER }];
  for (const path of [inUse, drafted, detected]) {
    if (path && !out.some((o) => o.value === path)) out.push({ value: path, label: path });
  }
  return out;
}

/** 1.175.0 B2 (SEC-4): the notes under "Checks before shipping" and "After a
 *  release, run" while the value in use came from the branch and isn't
 *  allowed on this Mac yet. Only on the value in use: a draft of the
 *  person's own is theirs. */
function useAllowedNotes(draft: RepositoryDraft): { checks: string | null; install: string | null } {
  const workspaceId = useWorkspaces((s) => s.activeId);
  const view = useChecksConsent((s) => (workspaceId ? s.byWorkspace[workspaceId] : undefined));
  const load = useChecksConsent((s) => s.load);
  const reads = draft.repo.reads;
  useEffect(() => {
    if (workspaceId) void load(workspaceId);
  }, [workspaceId, load, reads]);
  const inUse = (key: "verifyPipeline" | "installScript") =>
    JSON.stringify(draft.value(key) ?? null) === JSON.stringify(draft.repo.values[key] ?? null);
  return {
    checks: inUse("verifyPipeline") ? checksApprovalNote(view?.checks) : null,
    install: inUse("installScript") ? installApprovalNote(view?.install) : null,
  };
}

function VerifyRow({ draft, detected }: { draft: RepositoryDraft; detected: VerifyKind[] | null }) {
  const allowedNote = useAllowedNotes(draft);
  const value = (draft.value("verifyPipeline") as VerifyKind[] | null) ?? null;
  const inUse = (draft.repo.values.verifyPipeline as VerifyKind[] | null) ?? null;
  const text = (steps: VerifyKind[] | null) =>
    steps && steps.length ? steps.map(verifyStepText).join(" → ") : "";
  const known = new Map<string, VerifyKind[] | null>([["", null]]);
  for (const steps of [inUse, value, detected]) {
    if (steps?.length) known.set(text(steps), steps);
  }
  const options: SelectOption[] = [...known.keys()].map((k) => ({
    value: k,
    label: k || "None",
  }));
  return (
    <Row
      kind="choice"
      label={rowLabel("verifyPipeline")}
      {...draft.rowProps("verifyPipeline", [restingHint("verifyPipeline", value), allowedNote.checks].filter(Boolean).join(" "))}
    >
      <Select
        value={text(value)}
        options={options}
        mono
        onChange={(next) => void draft.set("verifyPipeline", known.get(next) ?? null)}
        label={rowLabel("verifyPipeline")}
      />
    </Row>
  );
}

/** After a release, run (`installScript`). Drawn by Settings › Shipping
 *  (1.174.0, DS2); its empty choice is "Nothing" (W6). */
export function InstallRow({ draft, detected }: { draft: RepositoryDraft; detected: string | null }) {
  const allowedNote = useAllowedNotes(draft);
  const value = (draft.value("installScript") as string | null) ?? null;
  return (
    <Row
      kind="choice"
      label={rowLabel("installScript")}
      {...draft.rowProps("installScript", [restingHint("installScript", value), allowedNote.install].filter(Boolean).join(" "))}
    >
      <Select
        value={value ?? ""}
        options={scriptOptions(
          (draft.repo.values.installScript as string | null) ?? null,
          value,
          detected,
        )}
        // G1 walk: "Nothing" reads in the ordinary font; a command in mono.
        mono={!!value}
        onChange={(next) => void draft.set("installScript", next || null)}
        label={rowLabel("installScript")}
      />
    </Row>
  );
}

/** Findings filter: `Findings that block approval`. This Mac's own (it
 *  never reaches the shared definition), so it saves at once, with or
 *  without write access to the repository. */
function BlockingFindingsRow({ draft, workspaceId }: { draft: RepositoryDraft; workspaceId: string }) {
  const saved: BlockingThreshold = draft.repo.review?.blockingFindings ?? "p1-p2";
  const [value, setValue] = useState<BlockingThreshold>(saved);
  useEffect(() => setValue(saved), [saved]);
  return (
    <Row kind="choice" label="Findings that block approval" hint={blockingFindingsHint(value)}>
      <Select
        value={value}
        options={BLOCKING_CHOICES}
        label="Findings that block approval"
        onChange={(next) => {
          const threshold = next as BlockingThreshold;
          setValue(threshold);
          void projectConfigSetBlockingFindings(workspaceId, threshold)
            .then(() => draft.repo.reload())
            .catch((e) => {
              setValue(saved);
              pushErrorToast("Couldn't change which findings block approval", e);
            });
        }}
      />
    </Row>
  );
}

function ToggleRow({
  draft,
  field,
}: {
  draft: RepositoryDraft;
  field: "selfCheck" | "sharedBuildCache";
}) {
  const on = draft.value(field) !== false;
  return (
    <Row kind="toggle" label={rowLabel(field)} {...draft.rowProps(field, restingHint(field, on))}>
      <Toggle checked={on} onChange={(next) => void draft.set(field, next)} />
    </Row>
  );
}

/** A list that opens as a sub-page of the same page, never as a panel.
 *  `hint` replaces the resting hint (Shipping's Version files with areas). */
export function ListRow({
  draft,
  field,
  sub,
  hint,
}: {
  draft: RepositoryDraft;
  field: "versionFiles" | "cachePaths" | "reviewChecklist" | "worktreeCopy";
  sub: string;
  hint?: (resting: string) => ReactNode;
}) {
  const value = draft.value(field);
  const resting = restingHint(field, value);
  return (
    <Row
      kind="value"
      label={rowLabel(field)}
      {...draft.rowProps(field, hint ? hint(resting) : resting)}
      onOpen={draft.readOnly ? undefined : () => draft.openSub(sub)}
    >
      <RowValue>{valueText(field, value)}</RowValue>
    </Row>
  );
}

/** A text row's words: they follow the page's value unless the person has typed
 *  something else, so a read landing doesn't take the field from them. */
function useFollowedText(committed: string) {
  const [text, setText] = useState(committed);
  const followed = useRef(committed);
  const typed = useRef(text);
  typed.current = text;
  useEffect(() => {
    if (typed.current === followed.current) setText(committed);
    followed.current = committed;
  }, [committed]);
  return [text, setText] as const;
}

/** SL-4: the command every new card worktree runs before its Builder. Free
 *  text, like a terminal line: it is the repository's own command, run in
 *  the worktree with bash (Git Bash on Windows). */
function SetupCommandRow({ draft, project }: { draft: RepositoryDraft; project: string | null }) {
  const committed = (draft.value("worktreeSetup") as string | null) ?? "";
  const [text, setText] = useFollowedText(committed);
  const shared = draft.repo.shared;
  // 1.176.1: what this computer can't find, said before a card runs it.
  const check = useCommandLine("command", committed, project);
  return (
    <Row
      kind="text"
      label={rowLabel("worktreeSetup")}
      {...draft.rowProps(
        "worktreeSetup",
        [restingHint("worktreeSetup", committed), setupApprovalNote(draft.repo.worktree, committed)]
          .filter(Boolean)
          .join(" "),
      )}
      disabled={draft.frozen}
    >
      <TextField
        value={text}
        mono
        wide
        placeholder="npm ci"
        onChange={(next) => {
          setText(next);
          // Shared: the draft follows the typing, as the name does (F12).
          if (shared) void draft.set("worktreeSetup", next.trim() || null);
        }}
        onCommit={(next) => {
          const settled = next.trim();
          setText(settled);
          check.read(settled);
          void draft.set("worktreeSetup", settled || null);
        }}
        label={rowLabel("worktreeSetup")}
      />
      {check.line && <RowValue>{check.line}</RowValue>}
    </Row>
  );
}

/** Try it (TRY_IT_SPEC §3.3, §5): how the app starts. Saved at once through
 *  its own call, like the findings filter: saved here counts as allowed
 *  here, and in a repository that shares its build settings it is published
 *  like them. The scope line says which. */
export function TryCommandRow({
  workspaceId,
  draft,
  project,
}: {
  workspaceId: string;
  draft: RepositoryDraft;
  project: string | null;
}) {
  const [view, setView] = useState<TryCommandView | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  // 1.176.2 (E1, A3-06): a read that failed isn't "still reading".
  const [readFailed, setReadFailed] = useState(false);
  const [readAgain, setReadAgain] = useState(0);

  useEffect(() => {
    let live = true;
    projectTryCommandGet(workspaceId)
      .then((v) => {
        if (!live) return;
        setReadFailed(false);
        setView(v);
      })
      .catch(() => live && setReadFailed(true));
    return () => {
      live = false;
    };
  }, [workspaceId, readAgain]);

  const state = tryRowState(view);
  // 1.176.1: what this computer can't find in the saved command, said before
  // a card's Try it runs it (read when the row appears and on each save).
  // Typed into the tile's own shell: a word not found is a hint.
  const check = useCommandLine("command", state.kind === "saved" ? state.command : "", project, true);
  // No config on this Mac yet is no reason to wait: the command is kept here
  // until the first config takes it over.
  const locked = !view || view.readOnly || draft.frozen || saving;
  // Saved here and still on its way to the repository (or a pull request).
  const mark = tryPendingMark(draft.repo.pending);
  const problem = editing ? tryCommandProblem(text) : null;

  async function save(command: string | null) {
    setSaving(true);
    setErrorDetails(null);
    try {
      const next = await projectTryCommandSave(workspaceId, command);
      setView(next);
      check.read(command ?? "");
      setEditing(false);
      void draft.repo.reload();
    } catch (e) {
      setErrorDetails(String(e));
    } finally {
      setSaving(false);
    }
  }

  function startEditing() {
    setText(state.kind === "saved" || state.kind === "suggested" ? state.command : "");
    setErrorDetails(null);
    setEditing(true);
  }

  const resting = !view
    ? readFailed
      ? "Plyloft couldn't read this repository."
      : "Plyloft is reading this repository."
    : view.readOnly
      ? `${tryRowHint(view)} Set in the repository; ask for write access to change it.`
      : tryRowHint(view);
  const hint = check.line && state.kind === "saved" && !editing ? `${resting} ${check.line}` : resting;

  // Outside the row's tag, so the settings index's scan reads the tag whole.
  const failure = errorDetails ? (
    <>
      Plyloft couldn't save how your app starts. Nothing was changed.
      <Details>
        <pre className="ux-output">{errorDetails}</pre>
      </Details>
    </>
  ) : undefined;

  return (
    <>
      <Row
        kind="value"
        label="How to start your app"
        hint={hint}
        error={failure}
        state={mark?.state}
        changed={mark ? { hint: mark.hint } : undefined}
        disabled={!view && !readFailed}
        action={
          !view && readFailed ? (
            <CBtn
              tone="quiet"
              onClick={() => {
                setReadFailed(false);
                setReadAgain((n) => n + 1);
              }}
            >
              Try again
            </CBtn>
          ) : locked || editing ? undefined : state.kind === "suggested" ? (
            <CBtn tone="strong" onClick={() => void save(state.command)}>
              Use this
            </CBtn>
          ) : (
            <CBtn tone="quiet" onClick={startEditing}>
              Change
            </CBtn>
          )
        }
        more={
          locked || editing ? undefined : state.kind === "suggested" ? (
            <MoreMenu label="More for How to start your app" items={[{ label: "Change", onSelect: startEditing }]} />
          ) : state.kind === "saved" ? (
            <MoreMenu
              label="More for How to start your app"
              items={[{ label: "Forget this command", onSelect: () => void save(null) }]}
            />
          ) : undefined
        }
      >
        {state.kind === "saved" || state.kind === "suggested" ? (
          <RowValue mono>{state.command}</RowValue>
        ) : (
          <RowValue>{state.kind === "staticSite" ? "A plain website" : "Not set"}</RowValue>
        )}
      </Row>
      {editing && (
        <Row
          kind="text"
          label="Start command"
          hint={problem ?? "The command you'd type in a terminal to start the app, from the project folder."}
          error={problem ?? undefined}
          action={
            <CBtn tone="strong" disabled={saving || !!problem} onClick={() => void save(text.trim() || null)}>
              {saving ? "Saving…" : "Save"}
            </CBtn>
          }
          more={
            <MoreMenu label="More for Start command" items={[{ label: "Cancel", onSelect: () => setEditing(false) }]} />
          }
        >
          <TextField
            value={text}
            mono
            wide
            autoFocus
            placeholder="npm run dev"
            onChange={setText}
            onEnter={(next) => {
              if (!tryCommandProblem(next)) void save(next.trim() || null);
            }}
            onCancel={() => setEditing(false)}
            label="Start command"
          />
        </Row>
      )}
    </>
  );
}

function NameRow({ draft, workspaceId }: { draft: RepositoryDraft; workspaceId: string }) {
  const committed = (draft.value("name") as string) ?? "";
  const [text, setText] = useFollowedText(committed);
  const shared = draft.repo.shared;
  // Owner, 2026-10-20: this Mac's own name, which the shared Name never renames.
  const ownName = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? null);
  const chosen = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.nameChosen === true);
  const hint = nameHint(shared, ownName === null ? null : { name: ownName, chosen }, committed);
  return (
    <Row kind="text" label="Name" {...draft.rowProps("name", hint)}>
      <TextField
        value={text}
        onChange={(next) => {
          setText(next);
          // Shared: the draft follows the typing, so leaving the page (or
          // pressing Escape) sees the name and asks about it (F12). This
          // Mac saves on blur or Enter, as a Text row does.
          if (shared) void draft.set("name", next);
        }}
        onCommit={(next) => {
          const settled = next.trim() || committed;
          setText(settled);
          void draft.set("name", settled);
        }}
        label="Name"
      />
    </Row>
  );
}

// ── Version files (a sub-page of Shipping since 1.174.0) ─────────────

/** DS2 round 1: a shared Re-detect's find differs from what Shipping holds. */
function shippingFindDiffers(d: RepositoryDraft, find: ShippingFind): boolean {
  return (
    JSON.stringify(d.value("versionFiles") ?? null) !== JSON.stringify(find.versionFiles ?? null) ||
    (d.value("installScript") ?? null) !== (find.installScript ?? null)
  );
}

/** The version files' own sub-page — Settings › Shipping › Version files
 *  since 1.174.0 (DS2). DS2 round 1: with its own Read the repository again,
 *  which puts what it finds (the version files and After a release, run)
 *  into Shipping's draft — or saves it here, where nothing is shared. */
export function VersionFilesPage({
  draft,
  cwd,
  workspaceId,
  onDetected,
}: {
  draft: RepositoryDraft;
  cwd: string;
  workspaceId: string;
  /** The script the scan found, for After a release, run's menu. */
  onDetected?: (installScript: string | null) => void;
}) {
  // What the repository itself holds, not what this Mac already runs: a
  // removal already saved here is in the effective list's absence, and its
  // struck-through row must stay until the branch has it too (F26).
  const inRepo =
    (draft.repo.repositoryValues?.versionFiles as VersionFileEntry[] | null) ??
    (draft.repo.values.versionFiles as VersionFileEntry[] | null) ??
    [];
  const applied = (draft.repo.values.versionFiles as VersionFileEntry[] | null) ?? [];
  const current = (draft.value("versionFiles") as VersionFileEntry[] | null) ?? applied;
  // A file removed on the This-Mac page is saved as it goes: it leaves the
  // list rather than waiting, struck through, for a publish that never
  // comes. Only a shared repository keeps a removal in view.
  const rows = draft.repo.shared
    ? versionFileRows(inRepo, current)
    : current.map((file, index) => ({ file, removed: false, index }));
  const kept = rows.filter((r) => !r.removed).length;
  const n = draft.changeNumber("versionFiles");
  const [filter, setFilter] = useState("");
  const filtered = rows.filter((r) => matchesFilter(r.file.path, filter));
  // The field stays while it holds something back: a list that drops under
  // the threshold with a filter still on would hide rows with no way to
  // bring them back (F39).
  const showFilter = needsFilter(rows.length) || filter.trim() !== "";

  // DS2 round 1: Shipping's own Re-detect — only its rows, into its draft.
  const [detecting, setDetecting] = useState(false);
  async function redetect() {
    setDetecting(true);
    try {
      const proposal = await projectConfigDetect(workspaceId);
      onDetected?.(proposal.config.installScript ?? null);
      const ok = await draft.setMany({
        versionFiles: proposal.config.versionFiles,
        installScript: proposal.config.installScript ?? null,
      });
      if (ok) draft.fail(null);
    } catch (e) {
      draft.fail(reDetectProblem(String(e)));
    } finally {
      setDetecting(false);
    }
  }

  async function choose() {
    const picked = await openDialog({ multiple: false, directory: false, defaultPath: cwd });
    if (typeof picked !== "string") return;
    // Published for every platform, so `/` between its parts.
    const inside = relativeTo(picked, cwd);
    const relative = inside === null ? picked : toPosix(inside);
    if (isAbsolutePath(relative)) {
      pushToast({
        kind: "warn",
        title: "That file is outside this repository",
        body: "Plyloft bumps files inside the repository everyone opens.",
      });
      return;
    }
    const entry = versionFileFor(relative);
    if (!entry) {
      pushToast({
        kind: "warn",
        title: "Plyloft can't bump that file",
        body: whyNotAVersionFile(relative),
      });
      return;
    }
    // The picker can stand open while a Sync moves the list: the addition
    // is made against the list as it is when the choice comes back (F29).
    await draft.update("versionFiles", (now) => {
      const list = (now as VersionFileEntry[] | null) ?? [];
      return list.some((f) => f.path === entry.path) ? list : [...list, entry];
    });
  }

  return (
    <Section
      title="Bumped on every release"
      count={`${kept} of ${rows.length} kept`}
      scope="repository"
      shared={draft.repo.shared}
    >
      {showFilter && (
        <div className="ux-section-filter">
          <SearchField
            value={filter}
            onChange={setFilter}
            placeholder={`Filter ${rows.length} files by path`}
          />
        </div>
      )}
      <Group label="Version files">
        {rows.length === 0 && (
          <Row
            kind="value"
            label="No version files"
            hint="Nothing's version number is bumped when this repository ships."
          />
        )}
        {rows.length > 0 && filtered.length === 0 && (
          <Row
            kind="value"
            label="No file matches"
            hint={`None of the ${rows.length} files has ${filter.trim()} in its path. The list itself is untouched.`}
          />
        )}
        {filtered.map((r) => {
          // A removal this page holds is a draft, numbered like every other
          // change (F16); one already saved here is on its way and carries
          // the pending mark instead.
          const queued = r.removed && !applied.some((f) => f.path === r.file.path);
          return (
            <Row
              key={r.file.path}
              kind="value"
              mono
              label={r.file.path}
              struck={r.removed}
              disabled={draft.frozen}
              hint={versionFileKindWords(r.file)}
              changed={
                r.removed
                  ? queued
                    ? {
                        hint: "Removed here, not published yet. It goes from the repository once this lands.",
                      }
                    : {
                        n,
                        hint: "Removed here, not published yet — it keeps its place until you publish, then it goes.",
                      }
                  : undefined
              }
              action={
                r.removed && !queued && !draft.readOnly ? (
                  <CBtn
                    tone="strong"
                    onClick={() =>
                      void draft.update("versionFiles", (now) =>
                        restoreFile((now as VersionFileEntry[] | null) ?? [], inRepo, r.file.path),
                      )
                    }
                  >
                    Put back
                  </CBtn>
                ) : undefined
              }
              more={
                !r.removed && !draft.readOnly ? (
                  <MoreMenu
                    label={`More for ${r.file.path}`}
                    items={[
                      {
                        label: "Remove",
                        onSelect: () =>
                          void draft.update("versionFiles", (now) =>
                            withoutFile((now as VersionFileEntry[] | null) ?? [], r.file.path),
                          ),
                      },
                    ]}
                  />
                ) : undefined
              }
            />
          );
        })}
      </Group>
      {!draft.readOnly && (
        <Group label="Add a version file">
          <Row
            kind="procedure"
            label="Add a file"
            disabled={draft.frozen}
            hint="Anything with a version number Plyloft should keep in step. Python files come from Re-detect below, which reads the variable's real name."
            action={
              <CBtn
                tone="strong"
                onClick={() =>
                  void choose().catch((e) =>
                    pushErrorToast("Couldn't open the file picker", e),
                  )
                }
              >
                Choose a file
              </CBtn>
            }
          />
        </Group>
      )}
      <Group label="Read the repository again">
        <Row
          kind="procedure"
          label="Read the repository again"
          hint={
            draft.readOnly
              ? "Needs write access — the result would have to be published."
              : draft.repo.shared
                ? "Looks for the version files and what runs after a release as they are today. Nothing reaches anyone until you publish."
                : "Looks for the version files and what runs after a release as they are today. Saved on this Mac at once."
          }
          action={
            draft.readOnly ? undefined : (
              <CBtn tone="strong" disabled={detecting || draft.frozen} onClick={() => void redetect()}>
                {detecting ? "Reading…" : "Re-detect"}
              </CBtn>
            )
          }
        >
          {/* Tidy tables: a value sits in the value column, never in action. */}
          {draft.readOnly && <RowValue>Re-detect</RowValue>}
        </Row>
      </Group>
    </Section>
  );
}

// ── Extra cache paths (a sub-page of Build & release) ─────────────────

function CachePathsPage({ draft }: { draft: RepositoryDraft }) {
  const paths = (draft.value("cachePaths") as string[] | null) ?? [];
  const [text, setText] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const shown = paths.filter((path) => matchesFilter(path, filter));
  const showFilter = needsFilter(paths.length) || filter.trim() !== "";
  return (
    <Section
      title="Shared between card builds"
      count={`${paths.length} ${paths.length === 1 ? "path" : "paths"}`}
      scope="repository"
      shared={draft.repo.shared}
    >
      {showFilter && (
        <div className="ux-section-filter">
          <SearchField
            value={filter}
            onChange={setFilter}
            placeholder={`Filter ${paths.length} paths`}
          />
        </div>
      )}
      <Group label="Extra cache paths">
        {paths.length === 0 && (
          <Row
            kind="value"
            label="None"
            hint="Only the dependency folders are shared between card builds."
          />
        )}
        {paths.length > 0 && shown.length === 0 && (
          <Row
            kind="value"
            label="No path matches"
            hint={`None of the ${paths.length} paths has ${filter.trim()} in it. The list itself is untouched.`}
          />
        )}
        {shown.map((path) => (
          <Row
            key={path}
            kind="value"
            mono
            label={path}
            disabled={draft.frozen}
            hint="Reused between card builds, and removed when a finished card's copy is cleaned up."
            more={
              draft.readOnly ? undefined : (
                <MoreMenu
                  label={`More for ${path}`}
                  items={[
                    {
                      label: "Remove",
                      onSelect: () =>
                        void draft.update("cachePaths", (now) =>
                          ((now as string[] | null) ?? []).filter((p) => p !== path),
                        ),
                    },
                  ]}
                />
              )
            }
          />
        ))}
      </Group>
      {!draft.readOnly && (
        <Group label="Add a cache path">
          <Row
            kind="text"
            label="Add a path"
            disabled={draft.frozen}
            hint="Relative to a card's copy. Only git-ignored, untracked folders are ever reused."
            error={refused ?? undefined}
          >
            <TextField
              value={text}
              onChange={(next) => {
                setText(next);
                setRefused(null);
              }}
              mono
              wide
              placeholder="frontend/node_modules"
              label="Add a path"
              onCommit={(next) => {
                const path = next.trim().replace(/\/+$/, "");
                if (!path) return;
                // Ply's pruning keeps plain relative paths and drops the
                // rest silently, so the row refuses them here.
                const problem = cachePathProblem(path);
                if (problem) {
                  setRefused(problem);
                  return;
                }
                if (paths.includes(path)) {
                  setRefused("This repository already shares that folder.");
                  return;
                }
                void draft
                  .update("cachePaths", (now) => {
                    const list = (now as string[] | null) ?? [];
                    return list.includes(path) ? list : [...list, path];
                  })
                  .then((ok) => {
                    // The field is cleared only once the path is really
                    // kept, and never over something typed since (F31).
                    if (ok) setText((typed) => (typed === next ? "" : typed));
                    else setRefused(`${platformWord("thisMachine")} refused it — the reason is above the list.`);
                  });
              }}
            />
          </Row>
        </Group>
      )}
    </Section>
  );
}

// ── Files copied in (a sub-page of Build & release, SL-4) ─────────────

function WorktreeCopyPage({ draft }: { draft: RepositoryDraft }) {
  const paths = (draft.value("worktreeCopy") as string[] | null) ?? [];
  const [text, setText] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  return (
    <Section
      title="Copied into every new card's copy"
      count={`${paths.length} ${paths.length === 1 ? "path" : "paths"}`}
      scope="repository"
      shared={draft.repo.shared}
    >
      <Group label="Files copied in">
        {paths.length === 0 && (
          <Row
            kind="value"
            label="None"
            hint="A card's copy starts with the repository's tracked files only."
          />
        )}
        {paths.map((path) => (
          <Row
            key={path}
            kind="value"
            mono
            label={path}
            disabled={draft.frozen}
            hint="Copied when it is git-ignored in your project folder, and never over a file already in the card's copy."
            more={
              draft.readOnly ? undefined : (
                <MoreMenu
                  label={`More for ${path}`}
                  items={[
                    {
                      label: "Remove",
                      onSelect: () =>
                        void draft.update("worktreeCopy", (now) =>
                          ((now as string[] | null) ?? []).filter((p) => p !== path),
                        ),
                    },
                  ]}
                />
              )
            }
          />
        ))}
      </Group>
      {!draft.readOnly && (
        <Group label="Add a path">
          <Row
            kind="text"
            label="Add a path"
            disabled={draft.frozen}
            hint="Relative to the repository. A pattern works too, like apps/*/.env.local."
            error={refused ?? undefined}
          >
            <TextField
              value={text}
              onChange={(next) => {
                setText(next);
                setRefused(null);
              }}
              mono
              wide
              placeholder=".env"
              label="Add a path"
              onCommit={(next) => {
                const path = next.trim().replace(/\/+$/, "");
                if (!path) return;
                const problem = worktreeCopyProblem(path);
                if (problem) {
                  setRefused(problem);
                  return;
                }
                if (paths.includes(path)) {
                  setRefused("That path is already copied in.");
                  return;
                }
                void draft
                  .update("worktreeCopy", (now) => {
                    const list = (now as string[] | null) ?? [];
                    return list.includes(path) ? list : [...list, path];
                  })
                  .then((ok) => {
                    if (ok) setText((typed) => (typed === next ? "" : typed));
                    else setRefused(`${platformWord("thisMachine")} refused it — the reason is above the list.`);
                  });
              }}
            />
          </Row>
        </Group>
      )}
    </Section>
  );
}

// ── Checklist classes (a sub-page of Build & release, GH #111) ────────

function ChecklistPage({
  draft,
  workspaceId,
}: {
  draft: RepositoryDraft;
  workspaceId: string;
}) {
  const classes = (draft.value("reviewChecklist") as ReviewChecklistClass[] | null) ?? [];
  // The class the editor opened on, not its place in the list: a removal or
  // a Sync moves every index after it, and saving by index would write the
  // edit over a different class (F2).
  const [editing, setEditing] = useState<{
    original: ReviewChecklistClass | null;
    from?: string;
  } | null>(null);
  const [name, setName] = useState("");
  const [sentence, setSentence] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useUi((s) => s.checklistDraft);
  const consume = useUi((s) => s.consumeChecklistDraft);

  // A class drafted from a late finding on a card opens the editor with it;
  // nothing is added until Save.
  useEffect(() => {
    if (!pending || pending.workspaceId !== workspaceId) return;
    setEditing({ original: null, from: pending.findingId });
    setName(pending.name);
    setSentence(pending.sentence);
    setRefused(null);
    consume();
  }, [pending, consume, workspaceId]);

  const chars = classChars({ name, sentence });
  const stored = checklistError(classes);
  const full = classes.length >= MAX_CLASSES;
  // A class drafted from a finding arrives whatever the list holds, so the
  // limit is checked here as well as on the Add button (F17).
  const adding = editing != null && editing.original == null;
  const overLimit = adding && full;

  function edit(original: ReviewChecklistClass | null) {
    setEditing({ original });
    setName(original?.name ?? "");
    setSentence(original?.sentence ?? "");
    setRefused(null);
  }

  async function saveClass() {
    if (!editing) return;
    const original = editing.original;
    let refusal: string | null = null;
    setSaving(true);
    // Against the list as it is when Save is pressed, not as the render
    // that opened the editor saw it (F2).
    const ok = await draft.update("reviewChecklist", (now) => {
      const list = (now as ReviewChecklistClass[] | null) ?? [];
      const index = original ? indexOfClass(list, original) : null;
      if (original && (index == null || index < 0)) {
        refusal =
          "This class changed in the repository meanwhile, or was removed. The list here is the current one — cancel, then edit it again.";
        return list;
      }
      const next = withClass(list, index, { name, sentence });
      refusal = checklistError(next);
      return refusal ? list : next;
    });
    setSaving(false);
    if (refusal) {
      setRefused(refusal);
      return;
    }
    if (ok) setEditing(null);
    else setRefused(`${platformWord("thisMachine")} refused the change — the reason is in the error above the list.`);
  }

  return (
    <>
      <Section
        title="This repository's classes"
        count={`${classes.length} of ${MAX_CLASSES}`}
        scope="repository"
        shared={draft.repo.shared}
      >
        <Group label="Checklist classes">
          {classes.length === 0 && (
            <Row
              kind="value"
              label="None of its own"
              hint="Reviews use the classes Plyloft ships, A to I."
            />
          )}
          {classes.map((c, i) => (
            <Row
              key={`${c.name}-${i}`}
              kind="value"
              label={`${classLetter(i)}. ${c.name}`}
              hint={c.sentence}
              // While one class is being edited the others hold still: a
              // removal underneath the editor is what F2 is about.
              disabled={editing != null || draft.frozen}
              more={
                draft.readOnly ? undefined : (
                  <MoreMenu
                    label={`More for ${c.name}`}
                    items={[
                      { label: "Edit", onSelect: () => edit(c) },
                      {
                        label: "Remove",
                        onSelect: () =>
                          // By what the class is, not where it sits: the
                          // list can have moved since this row was drawn.
                          void draft.update("reviewChecklist", (now) => {
                            const list = (now as ReviewChecklistClass[] | null) ?? [];
                            const at = indexOfClass(list, c);
                            return at < 0 ? list : list.filter((_, j) => j !== at);
                          }),
                      },
                    ]}
                  />
                )
              }
            />
          ))}
        </Group>
        {stored && (
          <Row
            kind="value"
            label="This list is over the limit"
            error={`${stored} Remove or shorten classes until it fits.`}
          />
        )}
      </Section>
      {!draft.readOnly && (
        <Section title={editing ? "The class" : "Add a class"} scope="repository" shared={draft.repo.shared}>
          <Group label="Class editor">
            {editing ? (
              <>
                {editing.from && (
                  <Row
                    kind="value"
                    label="Drafted from a finding"
                    hint={`From finding ${editing.from}. Edit it, then Save; nothing is added until you do.`}
                  />
                )}
                <Row
                  kind="text"
                  label="Name"
                  disabled={draft.frozen}
                  hint="What this class of risk is called."
                >
                  <TextField
                    value={name}
                    onChange={setName}
                    wide
                    placeholder="Branch discovery"
                    label="Class name"
                  />
                </Row>
                <Row
                  kind="text"
                  label="What to look for"
                  disabled={draft.frozen}
                  hint={`One sentence a review can act on. ${chars} of ${CLASS_MAX_CHARS} characters.`}
                  error={chars > CLASS_MAX_CHARS ? "Too long — shorten it to save." : undefined}
                >
                  <TextField
                    value={sentence}
                    onChange={setSentence}
                    wide
                    placeholder="Names the branch it reads."
                    label="What to look for"
                  />
                </Row>
                <Row
                  kind="procedure"
                  disabled={draft.frozen}
                  label={editing.original ? "Save this class" : "Add this class"}
                  hint={
                    overLimit
                      ? `This repository already has ${MAX_CLASSES} classes, which is all it may add. Remove one first; nothing here is lost meanwhile.`
                      : "It joins the sweep, the follow-ups and the Builder's self-check."
                  }
                  error={refused ?? undefined}
                  action={
                    <CBtn
                      tone="accent"
                      disabled={
                        saving ||
                        overLimit ||
                        !name.trim() ||
                        !sentence.trim() ||
                        chars > CLASS_MAX_CHARS
                      }
                      onClick={() => void saveClass()}
                    >
                      {saving ? "Saving…" : editing.original ? "Save" : "Add"}
                    </CBtn>
                  }
                />
                <Row
                  kind="procedure"
                  disabled={draft.frozen}
                  label="Leave it as it was"
                  hint="Nothing is added or changed."
                  action={
                    <CBtn tone="quiet" disabled={saving} onClick={() => setEditing(null)}>
                      Cancel
                    </CBtn>
                  }
                />
              </>
            ) : (
              <Row
                kind="procedure"
                label="Add a class"
                hint={
                  full
                    ? `A repository adds at most ${MAX_CLASSES} classes. Remove one to add another.`
                    : "One risk this repository wants every review to look for."
                }
                disabled={full || draft.frozen}
                action={
                  <CBtn tone="strong" onClick={() => edit(null)}>
                    Add a class
                  </CBtn>
                }
              />
            )}
          </Group>
        </Section>
      )}
    </>
  );
}

// ── The This-Mac danger zone ──────────────────────────────────────────

function LocalReset({ workspaceId, draft }: { workspaceId: string; draft: RepositoryDraft }) {
  const [asking, setAsking] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const review = draft.repo.review;
  const hasSomething =
    !!draft.repo.config || !!review?.reviewChecklist.length || review?.selfCheck === false;
  if (!hasSomething) return null;
  return (
    <>
      <Section title="Reset" scope="this-mac">
        <DangerZone>
          <Row
            kind="procedure"
            label="Reset this repository's settings on this Mac"
            hint="The branch, version files, scripts, caches, the self-check and this repository's checklist classes go back to how Plyloft ships. Your workspaces, cards and skills are untouched."
            error={refused ?? undefined}
            action={
              // A write on its way would land after the delete and put the
              // config back, so the row waits for the queue to drain.
              <CBtn
                tone="danger"
                disabled={draft.busy}
                onClick={() => {
                  setRefused(null);
                  setAsking(true);
                }}
              >
                Reset
              </CBtn>
            }
          />
        </DangerZone>
      </Section>
      {asking && (
        <Sheet
          size="confirm"
          title="Reset this repository's settings on this Mac?"
          lede="Plyloft forgets Cards go to, the version files, After a release, run, Checks before shipping, the cache paths, The Builder checks its own work first, this repository's checklist classes and any planning prompt written for this workspace. Cards can't ship from here until they are set up again."
          onClose={() => setAsking(false)}
          initialFocusRef={cancelRef}
          actions={
            <>
              <CBtn
                ref={cancelRef}
                tone="strong"
                disabled={draft.busy}
                onClick={() => setAsking(false)}
              >
                Cancel
              </CBtn>
              <CBtn
                tone="danger"
                disabled={draft.busy}
                onClick={() => {
                  // In the same queue as every other local write, so it
                  // cannot land between one's read and its write.
                  void draft
                    .runLocal(
                      () => projectConfigDelete(workspaceId),
                      (e) => resetProblem(String(e)),
                    )
                    .then((ok) => {
                      if (!ok) {
                        setRefused("It couldn't be reset — the reason is on the page above.");
                        setAsking(false);
                        return;
                      }
                      setAsking(false);
                      pushToast({
                        kind: "info",
                        title: "Settings reset on this Mac",
                        body: "This repository needs setting up again before a card can ship.",
                      });
                    });
                }}
              >
                {machineWords("Reset this Mac")}
              </CBtn>
            </>
          }
        />
      )}
    </>
  );
}
