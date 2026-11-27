// OB-13 (ONBOARDING_SPEC §5 step 9): "How Plyloft builds “lyra”".
//
// Setup's own workspace (the active one, else the first) is read by
// `project_detect_for_setup` — never a silent `main` (C10): the branch step 8
// kept for a detached or unborn HEAD (`firstProjectStore.targetBranch`), else
// the branch the folder is on, else `main` when it exists, else the step asks.
// The four facts are plain words (`lib/projectSettingsStep.ts`), the file's
// own fields under Details. `Looks right` saves through the existing
// `project_config_set` (Plyloft's own data: no sheet); the quiet `Change`
// opens an inline form — the branch, checks on or off with the script the
// scan found; everything else is in Settings after setup. A shared
// definition is shown read-only; a saved config is done, with `Change`.
// Try it (TRY_IT_SPEC §3.3): one line says how Plyloft will start the app
// (saved, else what the folder suggests); its own `Change` types another,
// and the step's save keeps it (`project_try_command_save`).
import { useCallback, useEffect, useRef, useState } from "react";
import { CBtn, Callout, Details, Group, Properties, Row, Select, TextField, Toggle } from "../ux";
import type { StepPrimary } from "./GitStep";
import {
  onWorkspaceDefinitionRefreshed,
  projectConfigGet,
  projectConfigSet,
  projectDetectForSetup,
  projectTryCommandGet,
  projectTryCommandSave,
  type SetupConfigView,
  type TryCommandView,
} from "../../ipc";
import { detectedCommand, setupTryLine, setupTryToSave, tryCommandProblem } from "../../lib/tryCommand";
import { useFirstProject } from "../../store/firstProjectStore";
import { machineWords } from "../../lib/platform";
import {
  CHANGE_MORE,
  NO_CHECK_SCRIPT,
  NO_WORKSPACE,
  SHARED_WAITING,
  branchOptions,
  checksLabel,
  checksOffer,
  detailLines,
  draftChanged,
  draftConfig,
  patchSavedConfig,
  initialDraft,
  projectFacts,
  stepScreen,
  type SettingsDraft,
} from "../../lib/projectSettingsStep";

export { projectSettingsTitle } from "../../lib/projectSettingsStep";

type Reading =
  | { kind: "loading" }
  | { kind: "failed"; error: string }
  | { kind: "read"; view: SetupConfigView };

export function ProjectSettingsStep({
  workspace,
  onPrimary,
  onSaved,
  onDone,
  onGoProject,
}: {
  /** Setup's workspace: the active one, else the first; null = none yet. */
  workspace: { id: string; name: string } | null;
  onPrimary: (primary: StepPrimary | null) => void;
  /** A config was written: Setup reads the config list again. */
  onSaved: () => void;
  onDone: () => void;
  onGoProject: () => void;
}) {
  const wsId = workspace?.id ?? null;
  const name = workspace?.name ?? "";
  const chosen = useFirstProject((s) => (wsId ? (s.targetBranch[wsId] ?? null) : null));
  const [reading, setReading] = useState<Reading>({ kind: "loading" });
  const [draft, setDraft] = useState<SettingsDraft>({ branch: "", checksOn: false });
  const [changing, setChanging] = useState(false);
  const [saving, setSaving] = useState(false);
  // The save's raw error: shown only in its Details.
  const [saveError, setSaveErrorDetails] = useState<string | null>(null);
  // The build settings were saved but the start command wasn't: its own raw
  // error, so the words can say which part failed.
  const [tryErrorDetails, setTryErrorDetails] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const again = useCallback(() => setReads((n) => n + 1), []);
  // Try it: the start command as read, and one typed here (null = none).
  const [tryView, setTryView] = useState<TryCommandView | null>(null);
  // null = untouched; "" = the person cleared it (no start command).
  const [tryTyped, setTryTyped] = useState<string | null>(null);
  const [tryEditing, setTryEditing] = useState(false);
  const [tryText, setTryText] = useState("");

  useEffect(() => {
    if (!wsId) return;
    let live = true;
    projectTryCommandGet(wsId)
      .then((v) => {
        if (live && v) setTryView(v);
      })
      .catch(() => {
        // The line is left out; Settings › Build and release has the row.
      });
    return () => {
      live = false;
    };
  }, [wsId, reads]);

  useEffect(() => {
    if (!wsId) return;
    let live = true;
    setReading((r) => (r.kind === "read" ? r : { kind: "loading" }));
    projectDetectForSetup(wsId, chosen)
      .then((view) => {
        if (!live) return;
        if (!view) throw new Error("Plyloft got no answer about this project.");
        setReading({ kind: "read", view });
        setDraft(initialDraft(view));
      })
      .catch((e) => {
        if (live) setReading({ kind: "failed", error: String(e) });
      });
    return () => {
      live = false;
    };
  }, [wsId, chosen, reads]);

  // A shared definition whose settings aren't on this Mac yet: its refresh
  // (run when the workspace warms) writes them; read again when it lands.
  const waitingShared =
    reading.kind === "read" && reading.view.state === "shared" && reading.view.config === null;
  useEffect(() => {
    if (!waitingShared || !wsId) return;
    let unlisten: (() => void) | null = null;
    let live = true;
    void onWorkspaceDefinitionRefreshed((report) => {
      if (report.workspaceId === wsId) {
        again();
        onSaved();
      }
    }).then((fn) => {
      if (live) unlisten = fn;
      else fn();
    });
    return () => {
      live = false;
      unlisten?.();
    };
  }, [waitingShared, wsId, again, onSaved]);

  const view = reading.kind === "read" ? reading.view : null;
  const screen = view ? stepScreen(view, name) : null;
  const config = view?.config ?? null;
  const shown = config && view && screen?.kind !== "shared" ? draftConfig(config, draft, view.detectedVerify) : config;
  const offer = config && view ? checksOffer(config, view.detectedVerify) : null;
  // A command typed here is a change of its own on a saved config.
  const tryChanged = tryTyped !== null && setupTryToSave(tryView, tryTyped) !== null;
  const changed = config ? draftChanged(config, draft) || tryChanged : false;

  const save = useCallback(async () => {
    if (!wsId || !view || !view.config) return;
    setSaving(true);
    setSaveErrorDetails(null);
    setTryErrorDetails(null);
    try {
      // A saved config is changed as it is on disk now, not as it was read.
      const next =
        view.state === "existing"
          ? patchSavedConfig((await projectConfigGet(wsId)) ?? view.config, view.config, draft, view.detectedVerify)
          : draftConfig(view.config, draft, view.detectedVerify);
      await projectConfigSet(wsId, next);
      // A first config keeps the start command the line showed; a saved one
      // only the one typed here (Continue on it saves nothing).
      const keep = view.state === "existing" ? (tryChanged ? setupTryToSave(tryView, tryTyped) : null) : setupTryToSave(tryView, tryTyped);
      if (keep) {
        try {
          setTryView(await projectTryCommandSave(wsId, keep.command));
        } catch (e) {
          // The settings are in: say so, and stay on the step.
          setTryErrorDetails(String(e));
          onSaved();
          setChanging(false);
          again();
          return;
        }
      }
      setTryTyped(null);
      onSaved();
      setChanging(false);
      again();
      onDone();
    } catch (e) {
      setSaveErrorDetails(String(e));
    } finally {
      setSaving(false);
    }
  }, [wsId, view, draft, onSaved, again, onDone, tryView, tryTyped, tryChanged]);

  // ── The footer's primary ───────────────────────────────────────────
  let primary: StepPrimary;
  if (!workspace) primary = { label: "Add a project", onClick: onGoProject };
  else if (reading.kind === "loading") primary = { label: "Looks right", onClick: () => {}, disabled: true };
  else if (reading.kind === "failed") primary = { label: "Try again", onClick: again };
  else if (screen?.kind === "fixFirst") primary = { label: "Go to First project", onClick: onGoProject };
  else if (screen?.kind === "shared") primary = { label: "Continue", onClick: onDone };
  else if (screen?.kind === "existing")
    primary = changed
      ? { label: "Save", onClick: () => void save(), disabled: saving || !draft.branch }
      : { label: "Continue", onClick: onDone };
  else primary = { label: "Looks right", onClick: () => void save(), disabled: saving || !draft.branch };
  const click = useRef(primary.onClick);
  click.current = primary.onClick;
  const stableClick = useCallback(() => click.current(), []);
  useEffect(() => {
    onPrimary({ label: primary.label, disabled: primary.disabled, onClick: stableClick });
  }, [onPrimary, primary.label, primary.disabled, stableClick]);
  useEffect(() => () => onPrimary(null), [onPrimary]);

  if (!workspace) return <p className="ux-setup-note">{NO_WORKSPACE}</p>;
  if (reading.kind === "loading") return <p className="ux-setup-note">{`Looking at “${name}”…`}</p>;
  if (reading.kind === "failed")
    return (
      <Callout
        kind="warn"
        title={`Plyloft couldn't look at “${name}”.`}
        text={
          <>
            Nothing was changed. Try again, or set it up later in Settings › Cards › Building and checking.
            <Details>
              <pre className="ux-output">{reading.error}</pre>
            </Details>
          </>
        }
      />
    );
  if (!view || !screen) return null;

  if (screen.kind === "fixFirst") return <Callout kind="warn" text={screen.sentence} />;

  const asking = screen.kind === "ask";
  const readOnly = screen.kind === "shared";
  const formOpen = !readOnly && (changing || asking);
  const branches = branchOptions(view.branches, draft.branch);

  return (
    <>
      {screen.kind === "ask" ? (
        <>
          <p className="ux-page-lede">
            <strong>{screen.headline}</strong> {screen.sentence}
          </p>
          <p className="ux-setup-note">Plyloft doesn't switch your folder's branch.</p>
        </>
      ) : (
        <p className="ux-page-lede">{screen.lede}</p>
      )}
      {readOnly && screen.kind === "shared" && screen.waiting ? (
        <p className="ux-setup-note">
          {SHARED_WAITING}{" "}
          <CBtn tone="quiet" onClick={again}>
            Look again
          </CBtn>
        </p>
      ) : null}
      {formOpen && (
        <Group label="Change how Plyloft builds this project">
          <Row kind="choice" label="Cards start from" hint="Each card starts from this branch and is merged back into it.">
            <Select
              label="Cards start from"
              value={draft.branch}
              onChange={(branch) => setDraft((d) => ({ ...d, branch }))}
              options={[
                ...(draft.branch ? [] : [{ value: "", label: "Choose a branch", disabled: true }]),
                ...branches.map((b) => ({ value: b, label: b })),
              ]}
            />
          </Row>
          {offer ? (
            <Row kind="toggle" label="Checks before shipping" hint={checksLabel(offer)}>
              <Toggle checked={draft.checksOn} onChange={(checksOn) => setDraft((d) => ({ ...d, checksOn }))} />
            </Row>
          ) : (
            <Row kind="value" label="Checks before shipping" hint={NO_CHECK_SCRIPT} />
          )}
        </Group>
      )}
      {formOpen && <p className="ux-setup-note">{CHANGE_MORE}</p>}
      {shown && (
        <>
          <Properties items={projectFacts(shown, view.version).map((f) => ({ label: f.label, value: machineWords(f.value) }))} />
          <Details>
            <pre className="ux-output">{detailLines(shown).join("\n")}</pre>
          </Details>
        </>
      )}
      {!readOnly && !asking && !changing && (
        <div>
          <CBtn tone="quiet" onClick={() => setChanging(true)}>
            Change
          </CBtn>
        </div>
      )}
      <TryLine
        view={tryView}
        typed={tryTyped}
        readOnly={readOnly}
        saved={screen.kind === "existing"}
        editing={tryEditing}
        text={tryText}
        onText={setTryText}
        onEdit={() => {
          setTryText(tryTyped ?? tryView?.command ?? detectedCommand(tryView?.detection) ?? "");
          setTryEditing(true);
        }}
        onUse={(command) => setTryTyped(command)}
        onDone={(command) => {
          setTryTyped(command);
          setTryEditing(false);
        }}
        onCancel={() => setTryEditing(false)}
      />
      {tryErrorDetails && (
        <Callout
          kind="warn"
          title="Plyloft saved the build settings, but not how your app starts."
          text={
            <>
              The build settings are saved. Try again, or set how your app starts in Settings › Cards › Building and
              checking.
              <Details>
                <pre className="ux-output">{tryErrorDetails}</pre>
              </Details>
            </>
          }
        />
      )}
      {saveError && (
        <Callout
          kind="warn"
          title="Plyloft couldn't save these settings."
          text={
            <>
              Nothing was changed. Try again, or set them up later in Settings › Cards › Building and checking.
              <Details>
                <pre className="ux-output">{saveError}</pre>
              </Details>
            </>
          }
        />
      )}
    </>
  );
}

/** Try it: step 9's one line about how the app starts. On a saved config a
 *  suggestion is offered with Use this, since Continue saves nothing. */
function TryLine({
  view,
  typed,
  readOnly,
  saved,
  editing,
  text,
  onText,
  onEdit,
  onUse,
  onDone,
  onCancel,
}: {
  view: TryCommandView | null;
  typed: string | null;
  readOnly: boolean;
  /** This project's build settings are saved already, so the step's
   *  Continue saves nothing: a suggestion is kept only with Use this. */
  saved: boolean;
  editing: boolean;
  text: string;
  onText: (next: string) => void;
  onEdit: () => void;
  onUse: (command: string) => void;
  /** What was typed; "" clears the start command (never the suggestion). */
  onDone: (command: string) => void;
  onCancel: () => void;
}) {
  const line = setupTryLine(view, typed);
  if (!view || !line) return null;
  if (readOnly || view.readOnly) {
    return view.command ? <p className="ux-setup-note">{line.sentence}</p> : null;
  }
  if (editing) {
    const problem = tryCommandProblem(text);
    return (
      <Group label="How to start your app">
        <Row
          kind="text"
          label="How to start your app"
          hint={problem ?? "The command you'd type in a terminal to start the app."}
          error={problem ?? undefined}
          action={
            <CBtn tone="strong" disabled={!!problem} onClick={() => onDone(text.trim())}>
              Done
            </CBtn>
          }
        >
          <TextField
            value={text}
            mono
            wide
            autoFocus
            placeholder="npm run dev"
            onChange={onText}
            onEnter={(next) => {
              if (!tryCommandProblem(next)) onDone(next.trim());
            }}
            onCancel={onCancel}
            label="How to start your app"
          />
        </Row>
      </Group>
    );
  }
  const suggestion = saved && typed === null && !view.command ? detectedCommand(view.detection) : null;
  // Nothing to change: no command, no suggestion — and not a plain website,
  // whose sentence states what will happen, which "Change" still changes.
  const typeIt = !line.command && !suggestion && view.detection.kind !== "staticSite";
  return (
    <p className="ux-setup-note">
      {suggestion ? `Plyloft found how your app starts: "${suggestion}".` : line.sentence}{" "}
      {suggestion && (
        <CBtn tone="quiet" onClick={() => onUse(suggestion)}>
          Use this
        </CBtn>
      )}{" "}
      {/* 1.176.3: with nothing to change there is nothing called Change here —
          the button beside the sentence says what it does. */}
      <CBtn
        tone="quiet"
        aria-label={typeIt ? "Type how your app starts" : "Change how your app starts"}
        onClick={onEdit}
      >
        {typeIt ? "Type it in" : "Change"}
      </CBtn>
    </p>
  );
}
