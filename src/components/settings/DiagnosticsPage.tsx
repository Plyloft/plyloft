import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import {
  CBtn,
  Details,
  ErrorBlock,
  Group,
  MoreMenu,
  PChip,
  Row,
  RowValue,
  Section,
  StatusLine,
  usePageReading,
} from "../ux";
import { SettingsPage } from "./rows";
import { ResetThisMac } from "./ResetPage";
import {
  preferredTileShell,
  allDetails,
  needsRows,
  isNoAiProbeError,
  probeFailedError,
  hasPathOverride,
  lookAgainHint,
  checkingHint,
  readyLine,
  reviewerRows,
  diagnosticsHint,
  diagnosticsTitle,
  type DiagnosticFix,
  type DiagnosticRow,
} from "../../lib/diagnostics";
import { runInShellTile } from "../../lib/runInTile";
import { useDoctor } from "../../store/doctorStore";
import { useMacSettings } from "./useMacSettings";
import { field } from "./fields";
import { findsLine, problemReason, programFoldersCheck } from "../../lib/programFolders";
import { settingCheck } from "../../lib/settingCheck";
import { savedSettingProblems, type SavedSettingProblem } from "../../lib/savedSettingChecks";
import { tryRowState } from "../../lib/tryCommand";
import { buildCacheLine, diagnosticsReport, otherLines, projectLabeller } from "../../lib/diagnosticsReport";
import { cliRepairReport } from "../../lib/cliRepairIpc";
import { CopyButton } from "../CopyButton";
import { useWorkspaces } from "../../store/workspaceStore";
import { useUi } from "../../store/uiStore";
import {
  buildCacheClear,
  buildCacheStatus,
  shellEnvInfo,
  microphoneOpenSettings,
  projectTryCommandGet,
  worktreeSettingsGet,
  microphoneRequestAccess,
  reviewerCapabilityProbe,
  watchdogStatus,
  type BuildCacheRow as BuildCacheRowData,
  type ProjectSkillsStatus,
} from "../../ipc";
import { useSkillRootIgnoreFix } from "../SkillRootIgnoreFix";
import { confirmSheet } from "../../store/confirmStore";
import { formatDiskBytes } from "../../lib/worktreeBase";
import { pushToast } from "../../store/toastStore";
import type { Scope } from "../../lib/settingsNav";
import { isWindows, platformWord } from "../../lib/platform";
import { useSetup } from "../../store/setupStore";
import { useRepair } from "../../store/repairStore";
import { RepairGroup } from "./RepairGroup";
import { aiToolOfRow, repairWhenUpdateBlocked } from "../../lib/repairRows";
import { useQuickRepair } from "../../store/quickRepairStore";
import { useLicense } from "../../store/licenseStore";
import { ClaudeReviewTrustStep } from "../ClaudeReviewTrust";
import { isFolderTrustRefusal } from "../../lib/claudeReviewTrust";
import { tutorialReportNow, useHelp } from "../../store/helpStore";
import { BacktickCode } from "../BacktickCode";
import {
  responsivenessDetails,
  responsivenessLine,
  type ResponsivenessStatus,
} from "../../lib/responsiveness";
import { pushErrorToast } from "../../lib/errorToast";

/** How often an open Diagnostics page reads the watchdog's record again. */
const RESPONSIVENESS_POLL_MS = 5_000;

/**
 * UX language card 8 (GH #103; BOARDS.md §5 "Settings › Advanced ›
 * Diagnostics"): what Ply needs on this Mac, and whether it is there.
 *
 * Each line offers **the one step that fixes it** (PATTERNS.md §6). Where that
 * step is Ply's, Ply takes it: `Choose zsh` writes the tile shell rather than
 * telling the reader to go and type it somewhere else. Where it is a command
 * only the person can run — `gh auth login` opens a browser and asks
 * questions, `brew install` writes outside Ply — Diagnostics opens a shell
 * tile in the active workspace with that command already running, and then
 * keeps re-asking the doctor until the row turns good, so the row answers on
 * its own instead of waiting for a `Look again`.
 *
 * The rows' words are the doctor's own (`doctor.rs` has unit tests on them);
 * `lib/diagnostics.ts` decides only who takes the step, and is tested state by
 * state.
 */

export function DiagnosticsPage({
  scope,
  hiddenNote,
}: {
  scope: Scope;
  hiddenNote?: string | null;
}) {
  const licenceKeyStatus = useLicense((st) => st.info?.status ?? "none");
  const licenceKeyTeam = useLicense((st) => st.info?.teamRepo ?? null);
  const report = useDoctor((s) => s.report);
  const loading = useDoctor((s) => s.loading);
  const refresh = useDoctor((s) => s.refresh);
  const reprobe = useDoctor((s) => s.reprobe);
  // Which rows Ply is waiting on lives in the store, not here: pressing a step
  // that needs the person closes Settings, and the wait has to carry on.
  const watching = useDoctor((s) => s.watching);
  const watch = useDoctor((s) => s.watch);
  // GH #107 (review 2, F2): this page's rows are the doctor's report, so a
  // search that landed on one of them says nothing until the probe has
  // answered — `Team skills` is not missing while Ply is still looking.
  usePageReading(report == null || loading);
  const mac = useMacSettings();
  const override = hasPathOverride(mac.value(field("shell.pathOverride")));
  // 1.176.1: why a saved Program folders value can't work, read when the
  // page opens and when the value changes (never per keystroke).
  const overrideValue = String(mac.value(field("shell.pathOverride")) ?? "");
  const [overrideReason, setOverrideReason] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setOverrideReason(null);
    if (!override) return;
    programFoldersCheck(overrideValue)
      .then((v) => live && setOverrideReason(v.problems.length > 0 ? problemReason(v.problems, v.windows) : null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [override, overrideValue]);
  const openSettingsSection = useUi((s) => s.openSettingsSection);
  const closeSettings = useUi((s) => s.setSettingsOverlayOpen);
  const activeWs = useWorkspaces((s) => s.workspaces.find((w) => w.id === s.activeId));

  // 1.176.1: the saved free-text settings that can't work as written
  // (`savedSettingChecks.ts`), read when the page opens and at each Look
  // again. A row opens its field; nothing is changed from here.
  const savedTileShell = String(mac.value(field("shell.tileShell")) ?? "");
  const savedCloneRoot = mac.settings.team?.cloneRoot ?? null;
  const [settingProblems, setSettingProblems] = useState<SavedSettingProblem[]>([]);

  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // 1.176.0 R6: the Repair group reads again at each Look again.
  const [lookKey, setLookKey] = useState(0);
  // H1 (1.173.0): the watchdog's record, read with the page and with each
  // Look again. A read that fails leaves the row out rather than guessing.
  const [responsiveness, setResponsiveness] = useState<ResponsivenessStatus | null>(null);
  const readResponsiveness = useCallback(() => {
    void watchdogStatus().then(setResponsiveness, () => setResponsiveness(null));
  }, []);
  useEffect(() => readResponsiveness(), [readResponsiveness]);
  const activeId = activeWs?.id ?? null;
  const activeCwd = activeWs?.cwd ?? null;
  useEffect(() => {
    let live = true;
    const project = async () => {
      if (!activeId || !activeCwd) return null;
      const [view, setup] = await Promise.all([
        projectTryCommandGet(activeId).catch(() => null),
        worktreeSettingsGet(activeId).catch(() => null),
      ]);
      const state = tryRowState(view);
      return {
        folder: activeCwd,
        tryCommand: state.kind === "saved" ? state.command : null,
        setupCommand: setup?.worktreeSetup ?? null,
      };
    };
    void project()
      .then((p) => savedSettingProblems({ tileShell: savedTileShell, teamCloneRoot: savedCloneRoot, project: p }, settingCheck))
      .then((list) => live && setSettingProblems(list))
      .catch(() => live && setSettingProblems([]));
    return () => {
      live = false;
    };
  }, [savedTileShell, savedCloneRoot, activeId, activeCwd, lookKey]);
  // 1.173.0 walk: a freeze while the page is open shows without reopening
  // it. The watchdog emits no event, so the page reads its record again
  // every few seconds while it is open (an in-memory read, no process).
  useEffect(() => {
    const timer = window.setInterval(readResponsiveness, RESPONSIVENESS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [readResponsiveness]);

  // Opening the page re-reads the report, and this is one of the two reads
  // that also ask `gh` whether it is signed in — this page is where that row
  // is shown. It costs a network round trip at most once every ninety seconds
  // (the backend remembers the answer), and a page showing yesterday's answer
  // is worse than a wait.
  useEffect(() => {
    void refresh({ withAuth: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1.176.0 seams: an Update its own updater can't do is offered as Repair.
  const updateBlocked = useQuickRepair((s) => s.updateBlocked);
  const rows = report ? needsRows(report, override).map((row) => repairWhenUpdateBlocked(row, updateBlocked)) : [];
  const reviewers = report ? reviewerRows(report) : [];

  // 1.176.1: Copy report. Read when pressed (never on a timer): the page's own
  // rows, the folders Plyloft looks in, and each AI tool's Repair report. A part
  // that can't be read is said in its place; the copy never fails for it.
  const buildReport = useCallback(async (): Promise<string> => {
    const read = async <T,>(get: () => Promise<T>): Promise<T | null> => {
      try {
        return await get();
      } catch {
        return null;
      }
    };
    const now = new Date();
    const version = useHelp.getState().version ?? (await read(() => getVersion()));
    const env = await read(() => shellEnvInfo());
    const reading = override ? await read(() => programFoldersCheck(overrideValue)) : null;
    // `null` is a real answer (no project): only a failed read is "couldn't be read".
    const cache = await read(() => buildCacheStatus().then((row) => ({ row })));
    const [claudeText, codexText] = await Promise.all([
      read(() => cliRepairReport("claude", false)),
      read(() => cliRepairReport("codex", false)),
    ]);
    const delimiter = isWindows() ? ";" : ":";
    return diagnosticsReport({
      version,
      platform: isWindows() ? "Windows" : "Mac",
      needs: report ? rows : null,
      probeError: report?.probeError ?? null,
      other: otherLines(report, responsiveness ? responsivenessLine(responsiveness, now) : null, [activeWs?.name, cache?.row?.workspaceName]),
      reviewers: report ? reviewers : null,
      buildCache:
        cache === null
          ? null
          : cache.row
            ? buildCacheLine(
                cache.row,
                formatDiskBytes(cache.row.status.bytes),
                projectLabeller([
                  report?.projectSkills?.workspace,
                  report?.sharedDefinition?.workspace,
                  report?.railway?.workspace,
                  activeWs?.name,
                  cache.row.workspaceName,
                ])(cache.row.workspaceName),
              )
            : "",
      folders: {
        setting: override ? overrideValue : "",
        reading: !override
          ? null
          : reading
            ? `${reading.problems.length > 0 ? `Can't work as written: ${problemReason(reading.problems, reading.windows)}. ` : ""}${findsLine(reading)}`
            : null,
        source: override
          ? "your Program folders setting"
          : isWindows()
            ? "the folders Windows gave Plyloft, plus where these tools usually install"
            : "your login shell, plus where these tools usually install",
        dirs: env ? env.path.split(delimiter).filter((d) => d.trim() !== "") : null,
      },
      tools: [
        { name: "Claude Code", text: claudeText },
        { name: "Codex", text: codexText },
      ],
      settings: settingProblems.map((x) => ({ label: x.label, value: x.value, reason: x.reason })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, rows, reviewers, responsiveness, override, overrideValue, activeWs, settingProblems]);

  const take = useCallback(
    // GH #169 review 1: `fix` is the row's own step, or its secondary one
    // (`claude auth login` beside a neutral claude row).
    async (row: DiagnosticRow, fix: DiagnosticFix = row.fix) => {
      const secondary = fix !== row.fix;
      setFailure(null);
      setBusy(row.id);
      try {
        if (fix.kind === "ply") {
          // The one step Ply takes itself: the tile shell is Ply's own setting,
          // and asking the reader to type it in another page is Ply asking for
          // help with its own job.
          // Through the field map like every other settings write, so it gets
          // the same sentence and the same Undo as changing it on Terminals &
          // shell would (review 1, finding 12).
          await mac.set(field("shell.tileShell"), preferredTileShell());
          await refresh({ withAuth: true });
        } else if (fix.kind === "app") {
          if (fix.what === "microphone") {
            await microphoneRequestAccess();
            await refresh({ withAuth: true });
          } else if (fix.what === "privacy-pane") {
            // System Settings opens beside Ply, so Settings can stay where it
            // is; the row answers by itself once macOS is told.
            await microphoneOpenSettings();
            watch(row.id);
          } else if (fix.what === "program-folders") {
            // 1.176.1 walk: a tool outside the folders set is never installed
            // from here; the row that decides it opens.
            openSettingsSection("editor-terminals", { row: "Program folders", focus: true });
          } else if (fix.what === "git-identity") {
            // OB-6: Setup's Git step (step 4) sets it, after its consent
            // sheet. Setup opens over Settings; closing it comes back here.
            useSetup.getState().openSetup("rerun", "git");
          } else {
            openSettingsSection("dictation");
          }
        } else if (fix.kind === "probe") {
          await reviewerCapabilityProbe(fix.provider);
          await refresh({ withAuth: true });
        } else if (fix.kind === "person") {
          // 1.176.0 R6: Claude Code's and Codex's own Install, Reinstall and
          // Update no longer open a blind shell tile. Reinstall is the guided
          // Repair; Install and Update run in Setup's guided terminal, whose
          // consent sheet names the command and whose outcome is read.
          const ai = aiToolOfRow(row.id);
          if (
            ai &&
            !secondary &&
            (fix.action === "Reinstall" || fix.action === "Repair" || fix.action === "Update" || fix.action === "Install")
          ) {
            if (fix.action === "Reinstall" || fix.action === "Repair") useRepair.getState().show(ai);
            else
              useSetup
                .getState()
                .openSetup("rerun", "ai", { aiAction: { tool: ai, action: fix.action === "Update" ? "update" : "install" } });
            return;
          }
          if (!activeWs) {
            setFailure(
              "Open a workspace first — the tile that runs this belongs to one of them.",
            );
            return;
          }
          await runInShellTile({
            workspaceId: activeWs.id,
            cwd: activeWs.cwd,
            command: fix.command,
          });
          // A neutral row is already counted ready, so watching it would
          // "turn good" at once; the next Diagnostics read shows the sign-in.
          // OB-2: likewise an update — the row is ready before and after.
          const update = fix.update === true;
          if (!secondary && !update) watch(row.id);
          // Settings is a modal over the app, so the tile it just opened is
          // behind it — and the command in it is asking the person a question.
          // Ply gets out of the way; the row turns Ready on its own.
          closeSettings(false);
          pushToast({
            kind: "info",
            title: `${fix.command} is running in a shell tile.`,
            body: update
              ? "When it finishes, Look again in Diagnostics reads the new version."
              : secondary
                ? `Diagnostics looks again for the ${row.label} sign-in the next time it opens.`
                : `Diagnostics says ${row.label} is ready as soon as it works.`,
          });
        }
      } catch (e) {
        setFailure(String(e));
      } finally {
        setBusy(null);
      }
    },
    [activeWs, closeSettings, mac, openSettingsSection, refresh, watch],
  );

  return (
    <SettingsPage
      entry="diagnostics"
      scope={scope}
      hiddenNote={hiddenNote}
      lede="What Plyloft needs on this Mac, whether it's there, and what to do when something is slow or missing."
      status={
        report == null ? (
          <StatusLine state="running">Plyloft is looking at your tools…</StatusLine>
        ) : report.allRequiredOk ? (
          <StatusLine state="done">Everything Plyloft cannot work without is here.</StatusLine>
        ) : (
          <StatusLine state="aborted">
            {/* 1.176.1 walk 2: with Program folders set, Plyloft looks only
                there, so that is what the line names. */}
            {override
              ? "Your Program folders don't find what Plyloft needs."
              : "Something Plyloft cannot work without is missing — the rows below say which."}
          </StatusLine>
        )
      }
    >
      {report?.probeError && (override || !isNoAiProbeError(report.probeError)) && (
        <ErrorBlock
          error={probeFailedError(report.probeError, override, isWindows(), override ? overrideReason : null)}
          onAction={(id) => {
            if (id === "reprobe") void reprobe({ withAuth: true });
            // 1.176.1: straight to the row, which names its corrections.
            else if (override) openSettingsSection("editor-terminals", { row: "Program folders", focus: true });
            else openSettingsSection("shell");
          }}
        />
      )}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <CopyButton label="Copy report" announce="Report copied" text={buildReport} />
      </div>
      {failure && (
        <Group>
          <Row kind="value" label="That step didn't start" hint={failure} error={failure} />
        </Group>
      )}
      {/* Launch G3 (Challenger P3-7): a team key from before Plyloft
          accounts is reported here, never used. */}
      {licenceKeyStatus !== "none" && (
        <StatusLine state="empty">
          {`A team key from before Plyloft accounts is stored on this Mac${licenceKeyTeam ? `, naming ${licenceKeyTeam}` : ""}. It unlocks nothing: your plan comes from your Plyloft account.`}
        </StatusLine>
      )}

      <Section title="What Plyloft needs" scope="this-mac" count={report ? readyLine(rows) : undefined}>
        <Group>
          {report == null ? (
            <Row kind="value" label="Checking…" hint={checkingHint(override)} />
          ) : (
            rows.map((row) => (
              <CheckRow
                key={row.id}
                row={row}
                busy={busy === row.id}
                waiting={watching[row.id] != null}
                onTake={() => void take(row)}
                onSecondary={
                  row.secondary ? () => void take(row, row.secondary ?? undefined) : undefined
                }
              />
            ))
          )}
        </Group>
      </Section>

      {settingProblems.length > 0 && (
        <Section title="Settings that can't work as written" scope="this-mac">
          <Group>
            {settingProblems.map((p) => (
              <Row
                key={p.id}
                kind="procedure"
                label={p.label}
                hint={p.reason}
                action={
                  <CBtn
                    tone={p.signal === "error" ? "strong" : "ghost"}
                    onClick={() => openSettingsSection(p.open.section, { row: p.open.row, focus: true })}
                  >
                    Open the setting
                  </CBtn>
                }
              />
            ))}
          </Group>
        </Section>
      )}

      <RepairGroup lookKey={lookKey} />

      {(responsiveness ||
        (report && (report.teamSkills || report.projectSkills || report.sharedDefinition || report.railway))) && (
        <Section title="What else Plyloft read" scope="this-mac">
          <Group>
            {responsiveness && <ResponsivenessRow status={responsiveness} />}
            {report && (
              <>
                {report.teamSkills && (
                  <Row
                    kind="value"
                    label="Team skills"
                    hint={report.teamSkills.detail}
                    error={report.teamSkills.blocked ?? undefined}
                  >
                    <RowValue>{`${report.teamSkills.loaded} loaded`}</RowValue>
                  </Row>
                )}
                {report.projectSkills && (
                  <ProjectSkillsRow
                    status={report.projectSkills}
                    onChecked={() => refresh({ withAuth: true })}
                  />
                )}
                {report.sharedDefinition && (
                  <Row
                    kind="value"
                    label={`Shared setup of ${report.sharedDefinition.workspace}`}
                    hint={report.sharedDefinition.detail}
                  >
                    <RowValue mono>{report.sharedDefinition.summary}</RowValue>
                  </Row>
                )}
                {report.railway && (
                  <Row kind="value" label="Railway" hint={<BacktickCode text={report.railway.detail} />}>
                    <RowValue>{report.railway.summary}</RowValue>
                  </Row>
                )}
              </>
            )}
          </Group>
        </Section>
      )}

      {reviewers.length > 0 && (
        <Section title="Reviewers can't change files" scope="this-mac">
          <p className="ux-footnote">
            Before a Reviewer reads a card, Plyloft proves that its AI cannot change files while it reviews.
            Each proof is one small call on your own subscription.
          </p>
          {reviewers.some((row) => row.id === "reviewer:claude") && (
            <ClaudeReviewTrustStep
              refused={isFolderTrustRefusal(failure)}
              onTrusted={() => setFailure(null)}
            />
          )}
          <Group>
            {reviewers.map((row) => (
              <CheckRow
                key={row.id}
                row={row}
                busy={busy === row.id}
                waiting={watching[row.id] != null}
                onTake={() => void take(row)}
              />
            ))}
          </Group>
        </Section>
      )}

      <BuildCache onFailure={setFailure} />

      <Section title="If you need to show someone" scope="this-mac">
        <Group>
          <Row
            kind="procedure"
            label="Reveal log folder"
            hint={`Opens the folder in ${platformWord("fileManager")}. Nothing is sent anywhere.`}
            action={
              <CBtn
                onClick={() => {
                  invoke("reveal_log_dir").catch((e) => setFailure(String(e)));
                }}
              >
                Reveal
              </CBtn>
            }
          />
          <Row
            kind="procedure"
            label="Copy tutorial report"
            hint={TUTORIAL_REPORT_HINT}
            action={
              <CBtn
                onClick={() =>
                  void navigator.clipboard.writeText(tutorialReportNow()).then(
                    () => pushToast({ kind: "info", title: "Report copied" }),
                    (e) => pushErrorToast("Couldn't copy the report", e),
                  )
                }
              >
                Copy
              </CBtn>
            }
          />
          <Row
            kind="procedure"
            label="Look again, from scratch"
            hint={lookAgainHint(override)}
            action={
              <CBtn
                disabled={loading}
                onClick={() => {
                  readResponsiveness();
                  setLookKey((k) => k + 1);
                  void reprobe({ withAuth: true });
                }}
              >
                {loading ? "Looking…" : "Look again"}
              </CBtn>
            }
          />
        </Group>
        {(report || responsiveness) && (
          <Details summary="Details">
            <pre className="ux-output">
              {[
                report ? allDetails(report) : "",
                responsiveness ? responsivenessDetails(responsiveness, new Date()) : "",
              ]
                .filter(Boolean)
                .join("\n\n")}
            </pre>
          </Details>
        )}
      </Section>
      {/* UX-9.3: Reset is no page of its own; it is this page's danger zone. */}
      <ResetThisMac />
    </SettingsPage>
  );
}

/**
 * H1 (1.173.0): whether the window froze since Plyloft started, from the
 * watchdog (`watchdog.rs`). The words are `lib/responsiveness.ts`'s; Copy
 * details copies them with the watchdog's own log lines.
 */
function ResponsivenessRow({ status }: { status: ResponsivenessStatus }) {
  const now = new Date();
  return (
    <Row
      kind="value"
      label="Responsiveness"
      // 1.174.0 (DS7, scene 13): what happened, then what to do — one line.
      hint={responsivenessLine(status, now)}
      more={
        <MoreMenu
          label="More about responsiveness"
          items={[
            {
              label: "Copy details",
              onSelect: () => {
                navigator.clipboard.writeText(responsivenessDetails(status, new Date())).then(
                  () => pushToast({ kind: "info", title: "Details copied" }),
                  (e) => pushErrorToast("Couldn't copy the details", e),
                );
              },
            },
          ]}
        />
      }
    />
  );
}

/**
 * The open workspace's project skills. GH #215: a skill root git ignores gets
 * the row's one step, `Un-ignore` — a confirmation that shows the exact lines
 * and the file they go into, then the append and the doctor's check again.
 */
function ProjectSkillsRow({
  status,
  onChecked,
}: {
  status: ProjectSkillsStatus;
  onChecked: () => Promise<unknown>;
}) {
  const workspaceId = useWorkspaces((s) => s.activeId);
  const fix = useSkillRootIgnoreFix({ workspaceId, status, onChecked });
  const ignored = status.gitignored.length > 0;
  return (
    <>
      <Row
        kind={ignored ? "procedure" : "value"}
        label={`Skills in ${status.workspace}`}
        hint={fix.note ? `${status.detail} ${fix.note}` : status.detail}
        chips={ignored ? <PChip>{`${status.loaded} loaded`}</PChip> : undefined}
        action={
          ignored ? (
            <CBtn disabled={fix.busy} onClick={fix.start}>
              {fix.busy ? "Looking…" : "Let Git see it"}
            </CBtn>
          ) : undefined
        }
      >
        {ignored ? undefined : <RowValue>{`${status.loaded} loaded`}</RowValue>}
      </Row>
      {fix.sheet}
    </>
  );
}

/**
 * One check: the condition it is in, and the one step that changes it.
 *
 * Review 1, finding 6: the badge (`Required` / `Optional`), what the thing
 * calls itself, and where it is were all in the row model and drawn by none of
 * it. They are chips and a mono tail on the hint now, as the sectioned Settings
 * drew them.
 *
 * Finding 3c: the docs link and the install command stay **reachable** — in
 * the row's menu, copyable. Ply has no URL opener (no opener plugin is in
 * `capabilities/default.json`, and the page must not navigate the webview off
 * the app), which is exactly why the old rows copied rather than opened.
 */
function CheckRow({
  row,
  busy,
  waiting,
  onTake,
  onSecondary,
}: {
  row: DiagnosticRow;
  busy: boolean;
  waiting: boolean;
  onTake: () => void;
  /** GH #169 review 1: the row's secondary step, drawn first in its menu. */
  onSecondary?: () => void;
}) {
  const steps =
    row.secondary && onSecondary
      ? [
          {
            label: `${row.secondary.action} — runs ${row.secondary.command} in a shell tile`,
            onSelect: onSecondary,
          },
        ]
      : [];
  const copies: { label: string; value: string }[] = [];
  // 1.174.0 (DS7): a reviewer's proof, whole, behind its few words.
  if (row.details) copies.push({ label: "Copy details", value: row.details });
  if (row.command) copies.push({ label: "Copy the command", value: row.command });
  if (row.docs) copies.push({ label: "Copy the link to its docs", value: row.docs });
  if (row.where) copies.push({ label: "Copy where it is", value: row.where });
  // 1.174.0 (DS7, scene 13): titled by what it is for, the program and its
  // version in the hint, and no chips in the title.
  const title = diagnosticsTitle(row);
  const hint = diagnosticsHint(row);
  return (
    <Row
      kind="procedure"
      label={title}
      mono={title === row.label && row.mono}
      hint={
        <>
          {waiting
            ? `${hint} Plyloft is watching this line and will say so the moment it turns good.`
            : hint}
          {/* GH #317: where it is sits behind ⋯ (`Copy where it is`), not in
              the first layer — words first, mechanism behind. */}
        </>
      }
      action={
        row.fix.kind === "ready" ? (
          <span className="ux-ready">Ready</span>
        ) : (
          <CBtn
            tone={row.signal === "error" ? "strong" : "ghost"}
            disabled={busy || waiting}
            onClick={onTake}
          >
            {waiting ? "Waiting…" : busy ? "Starting…" : row.fix.action}
          </CBtn>
        )
      }
      more={
        steps.length + copies.length > 0 ? (
          <MoreMenu
            label={`More about ${row.label}`}
            items={[
              ...steps,
              ...copies.map((copy) => ({
                label: copy.label,
                onSelect: () => {
                  navigator.clipboard.writeText(copy.value).catch(() => {});
                },
              })),
            ]}
          />
        ) : undefined
      }
    />
  );
}

/**
 * The shared build cache (review 1, finding 3a).
 *
 * Every card's Verify builds into one `.plyloft-worktrees/.cargo-target`
 * instead of its own `target/`, so it can reach many gigabytes — and `Clear`
 * was the only way to get them back. It was on the Dependency Doctor, which
 * Settings no longer hosts: on a healthy Mac the welcome screen is past and
 * the missing-dependency banner never opens, so both the size and the button
 * had become unreachable.
 *
 * It is on **Diagnostics** rather than Repository › Build & release because it
 * is a directory on this Mac that nobody else can see, and that page publishes
 * what it changes to everyone who opens the repository. `Shared build cache`
 * there decides whether the cache is used; this says how big it got and throws
 * it away. The words are the row's own, unchanged.
 */
function BuildCache({ onFailure }: { onFailure: (message: string | null) => void }) {
  const activeId = useWorkspaces((s) => s.activeId);
  const [row, setRow] = useState<BuildCacheRowData | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    void buildCacheStatus()
      .then(setRow)
      .catch((e) => onFailure(String(e)));
  }, [onFailure]);

  useEffect(() => {
    setNote(null);
    load();
  }, [activeId, load]);

  if (!row) return null;
  const { status } = row;
  // GH #317: the words first; the file names behind Details under the row.
  const detail = !row.enabled
    ? `Off for ${row.workspaceName}: each card's checks build in the card's own copy. Cards › Building and checking turns it on.`
    : status.exists
      ? `${row.workspaceName}: each card's checks build here, reusing compiled dependencies. The project's own code always rebuilds from the card being checked.`
      : `${row.workspaceName}: no shared build yet. The next card's checks create it.`;
  const mechanism = !row.enabled
    ? "Off: each card's checks build inside the card's own copy, in its target/ folder (sharedBuildCache in the project's settings)."
    : "The project's own crates are cleaned first. Only checkouts carrying .atelier/shared-cargo-target use it.";

  async function clear() {
    if (!row) return;
    const ok = await confirmSheet({
      title: `Delete the shared build cache for ${row.workspaceName} (${formatDiskBytes(status.bytes)})?`,
      body: "No work is lost; the next card's checks build from scratch.",
      confirmLabel: "Clear",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setNote(null);
    try {
      const freed = await buildCacheClear(row.workspaceId);
      setNote(`Freed ${formatDiskBytes(freed)}.`);
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
      load();
    }
  }

  return (
    // scope: none — the title says this disk already; a mark read "…on this disk on this Mac" (1.174.1 Windows walk).
    <Section title="What Plyloft is keeping on this disk">
      <Group>
        <Row
          kind="procedure"
          label="Build cache"
          hint={note ? `${detail} ${note}` : detail}
          chips={<PChip>{status.exists ? formatDiskBytes(status.bytes) : "empty"}</PChip>}
          action={
            status.exists ? (
              <CBtn disabled={busy} onClick={() => void clear()}>
                {busy ? "Clearing…" : "Clear"}
              </CBtn>
            ) : (
              <RowValue>Nothing to clear</RowValue>
            )
          }
          more={
            status.exists ? (
              <MoreMenu
                label="More about the build cache"
                items={[
                  {
                    label: "Copy where it is",
                    onSelect: () => {
                      navigator.clipboard.writeText(status.path).catch(() => {});
                    },
                  },
                ]}
              />
            ) : undefined
          }
        />
      </Group>
      <Details>
        <span className="ux-details-line">{mechanism}</span>
      </Details>
    </Section>
  );
}

/** TU-8 (TUTORIAL_SPEC §13, D9): what Copy tutorial report copies. */
export const TUTORIAL_REPORT_HINT =
  "A short summary of the Getting started tour: which steps you did or skipped, and when. No project names or text. Nothing is sent anywhere.";
