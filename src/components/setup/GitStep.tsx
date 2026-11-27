// OB-6 (ONBOARDING_SPEC §5 step 4): Setup's "Git and your name" step.
//
// Two parts: the Git row (the Mac's Command Line Tools, or Git for Windows
// with Git Bash), installed through the guided runner after its consent
// sheet; and the name and email Git puts on every commit, prefilled in the
// spec's order (the global config, GitHub, the system) and written with
// `Save to Git` → a consent sheet naming the two `git config --global`
// commands → `setup_identity_write` (argv, read back). The step's primary
// sits in Setup's footer: the step hands it up through `onPrimary`.
//
// The words and states are pure in `lib/gitStep.ts`.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CBtn,
  Callout,
  ChoiceList,
  Details,
  ErrorBlock,
  Group,
  Row,
  Section,
  Sheet,
  StateWord,
  StatusLine,
  TextField,
} from "../ux";
import { IdentitySheet } from "./IdentitySheet";
import { SetupTerminal } from "../SetupTerminal";
import { useDoctor } from "../../store/doctorStore";
import { useSetupRun } from "../../store/setupRunStore";
import { useGithubStatus } from "../../store/githubStatusStore";
import { useSettings } from "../../store/settingsStore";
import { useUi } from "../../store/uiStore";
import { platform } from "../../lib/platform";
import { hasPathOverride } from "../../lib/diagnostics";
import { HELPER_NOW_LINE, githubConnected, helperRowShown } from "../../lib/githubStep";
import { setupLine } from "../../lib/setupRun";
import {
  setupIdentityPrefill,
  setupIdentityWrite,
  setupOpenGitDownloads,
  type IdentityPrefill,
  type IdentityWritten,
} from "../../ipc";
import {
  IDENTITY_NEEDED,
  INSTALL_GIT_WINDOWS_LINE,
  chosenEmail,
  gitRow,
  identityErrors,
  identityLine,
  installFailure,
  installSheet,
} from "../../lib/gitStep";

export const GIT_TITLE = "Git and your name";
export const GIT_WHY =
  "Git keeps the history of your project. Plyloft uses it to give each card its own copy of the code and to merge the result back.";

/** The footer's primary, as Setup draws it. */
export type StepPrimary = { label: string; onClick: () => void; disabled?: boolean };

type SheetKind = "install" | "save" | null;
type EmailChoice = "private" | "other";

export function GitStep({
  guided,
  onPrimary,
  onDone,
}: {
  /** Step by step: the "What is Git?" block. */
  guided: boolean;
  /** The footer's primary for this step; null when the step leaves. */
  onPrimary: (primary: StepPrimary | null) => void;
  /** Move on (the next step, or back to the checklist). */
  onDone: () => void;
}) {
  const windows = platform() === "windows";
  const report = useDoctor((s) => s.report);
  // 1.176.1: a missing tool or a command not found points to Program folders when it is set.
  const programFoldersSet = useSettings((s) => hasPathOverride(s.settings.shell.pathOverride));
  const row = gitRow(report, windows, programFoldersSet);
  const gitReady = row.state === "ready";

  const run = useSetupRun((s) => s.run);
  const phase = useSetupRun((s) => s.phase);
  const outcome = useSetupRun((s) => s.outcome);
  const tail = useSetupRun((s) => s.tail);
  const runError = useSetupRun((s) => s.error);
  const evidence = useSetupRun((s) => s.evidence);
  const gitRun = run?.actionId === "install.git" ? run : null;
  const installing = gitRun !== null && phase !== "done";
  const [askedInstall, setAskedInstall] = useState(false);

  // ── 1.175.0 F1: Git's part of "Connect GitHub", owed since step 3 ──
  // On a computer without Git, the GitHub step's one sheet was agreed to
  // with its third thing ("Lets Git use that sign-in") left for here. Once
  // Git answers, and an account is signed in, and Git still doesn't ask the
  // GitHub command: it is done, with no second question. The yes is used
  // up as it starts — never twice — and is not there at all if the person
  // stopped the sign-in.
  const helperConsented = useSettings((s) => Boolean(s.settings.onboarding?.gitHelperConsented));
  const githubStatus = useGithubStatus((s) => s.status);
  const refreshGithub = useGithubStatus((s) => s.refresh);
  const readingGithub = useGithubStatus((s) => s.reading);
  const helperRun = run?.actionId === "setupgit.gh" ? run : null;
  const anyRunLive = run !== null && phase !== "done";
  /** The read of GitHub's state made here, with Git working. */
  const [helperRead, setHelperRead] = useState(false);
  useEffect(() => {
    if (!helperConsented || !gitReady) return;
    let live = true;
    void refreshGithub(true).then(() => {
      if (live) setHelperRead(true);
    });
    return () => {
      live = false;
    };
  }, [helperConsented, gitReady, refreshGithub]);
  const helperStarted = useRef(false);
  /** This visit did it: the step says so. */
  const [helperDoneHere, setHelperDoneHere] = useState(false);
  useEffect(() => {
    if (!helperConsented || !gitReady || !helperRead || readingGithub || anyRunLive || helperStarted.current) return;
    if (!githubStatus) return;
    const connected = githubConnected(githubStatus);
    // Can't tell yet whether an account is signed in: wait for a read that can.
    if (connected === null) return;
    helperStarted.current = true;
    // The yes is used up now, whatever follows: one try, never a second.
    void useSettings
      .getState()
      .update((cur) => ({ ...cur, onboarding: { ...cur.onboarding, gitHelperConsented: false } }))
      .catch((e) => console.warn("setup: the yes for Git's sign-in wasn't cleared", e));
    if (connected && helperRowShown(githubStatus.helper, true, githubStatus.gcm ?? null)) {
      setHelperDoneHere(true);
      void useSetupRun.getState().start("setupgit.gh");
    }
  }, [helperConsented, gitReady, helperRead, readingGithub, anyRunLive, githubStatus]);

  const reported = report?.gitIdentity ?? null;
  const [written, setWritten] = useState<IdentityWritten | null>(null);
  const known: IdentityWritten | null =
    written ??
    (reported?.set && reported.name && reported.email ? { name: reported.name, email: reported.email } : null);
  const [editing, setEditing] = useState(false);
  const showFields = !known || editing;

  // ── The fields and their prefill ───────────────────────────────────
  const [prefill, setPrefill] = useState<IdentityPrefill | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [choice, setChoice] = useState<EmailChoice>("private");
  const touched = useRef(false);
  const [errors, setErrors] = useState<{ name: string | null; email: string | null } | null>(null);

  // Only once Git works (its config is the first source), and only while
  // the fields are asked for: someone already set up asks nobody.
  const wantPrefill = gitReady && showFields && !editing;
  useEffect(() => {
    if (!wantPrefill || prefill) return;
    let live = true;
    setupIdentityPrefill()
      .then((p) => {
        if (!live) return;
        setPrefill(p);
        if (!touched.current) {
          setName(p.name);
          // The private address is a choice of its own, not the field's text.
          setEmail(p.githubNoreply ? "" : p.email);
        } else {
          // Review P2-1: a prefill that lands after the person typed (gh can
          // take its time) never replaces what they typed — the private
          // address is offered, not chosen.
          setChoice("other");
        }
      })
      .catch(() => {
        // Nothing to prefill: the fields start empty.
      });
    return () => {
      live = false;
    };
  }, [wantPrefill, prefill]);

  const noreply = !editing ? (prefill?.githubNoreply ?? null) : null;
  const emailToSave = chosenEmail(noreply, choice, email);
  // Once shown, the inline errors follow the fields.
  useEffect(() => {
    if (errors) setErrors(identityErrors(name, emailToSave));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, emailToSave]);

  // ── Sheets and actions ─────────────────────────────────────────────
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** What the sheet names and Save writes, fixed when the sheet opens. */
  const [pending, setPending] = useState<IdentityWritten | null>(null);

  const install = useCallback(async () => {
    setSheet(null);
    setAskedInstall(true);
    await useSetupRun.getState().start("install.git");
  }, []);

  const askSave = () => {
    const errs = identityErrors(name, emailToSave);
    setErrors(errs);
    if (!errs) {
      setSaveError(null);
      setPending({ name: name.trim(), email: emailToSave.trim() });
      setSheet("save");
    }
  };

  const save = async () => {
    if (!pending) return;
    setSaving(true);
    setSaveError(null);
    try {
      const done = await setupIdentityWrite(pending.name, pending.email);
      setWritten(done);
      setEditing(false);
      setSheet(null);
      // The step turns done from what the doctor reads back.
      void useDoctor.getState().refresh().catch(() => {});
    } catch (e) {
      setSaveError(typeof e === "string" ? e : String(e));
    } finally {
      setSaving(false);
    }
  };

  const change = () => {
    if (!known) return;
    touched.current = true;
    setName(known.name);
    setEmail(known.email);
    setChoice("other");
    setErrors(null);
    setEditing(true);
  };

  // ── The footer's primary ───────────────────────────────────────────
  let primary: StepPrimary;
  if (!gitReady && row.programFolders) {
    // 1.176.1 walk: never an installer for a Git that may exist.
    primary = {
      label: "Open Program folders",
      onClick: () => useUi.getState().openSettingsSection("editor-terminals", { row: "Program folders", focus: true }),
    };
  } else if (!gitReady && row.state !== "unknown" && row.install) {
    primary = { label: row.install, onClick: () => setSheet("install"), disabled: installing };
  } else if (gitReady && showFields) {
    primary = { label: "Save to Git", onClick: askSave, disabled: saving };
  } else {
    primary = { label: "Continue", onClick: onDone };
  }
  const click = useRef(primary.onClick);
  click.current = primary.onClick;
  const stableClick = useCallback(() => click.current(), []);
  useEffect(() => {
    onPrimary({ label: primary.label, disabled: primary.disabled, onClick: stableClick });
  }, [onPrimary, primary.label, primary.disabled, stableClick]);
  useEffect(() => () => onPrimary(null), [onPrimary]);

  const failure = gitRun && phase === "done" && !gitReady ? installFailure(outcome, windows, row.command ?? gitRun.display, tail, evidence, programFoldersSet) : null;
  const sheetWords = installSheet(windows);

  return (
    <>
      {guided && (
        <Details summary="What is Git?">
          <p className="ux-setup-note">
            A record of every saved version of your files, so you can see what changed and go back.
            You don&apos;t need to learn its commands: Plyloft runs them for you.
          </p>
        </Details>
      )}

      <Group label="Git">
        <Row kind="value" label={row.label} hint={row.hint}>
          {gitReady ? (
            <StateWord state="done">Ready</StateWord>
          ) : installing ? (
            <StateWord state="running" live>
              Installing
            </StateWord>
          ) : row.state === "unknown" ? null : (
            <StateWord state="aborted">Needs you</StateWord>
          )}
        </Row>
      </Group>
      {/* 1.176.4: what Install Git for Windows does, before the press. */}
      {windows && !gitReady && row.install && !installing && (
        <p className="ux-setup-note">{INSTALL_GIT_WINDOWS_LINE}</p>
      )}

      {(gitRun || (askedInstall && runError)) && <SetupTerminal />}
      {/* F1: what was agreed to in the GitHub step, done here. */}
      {helperDoneHere && helperRun && phase === "done" && (
        <StatusLine state={outcome === "succeeded" ? "done" : "empty"}>
          {outcome === "succeeded" ? HELPER_NOW_LINE : setupLine("setupgit.gh", "done", outcome, windows ? "windows" : "mac")}
        </StatusLine>
      )}
      {failure && (
        <ErrorBlock
          error={failure}
          busy={installing ? "install" : null}
          onAction={(id) => {
            if (id === "install") setSheet("install");
            else void setupOpenGitDownloads().catch(() => {});
          }}
        />
      )}

      <Section title="Your name and email">
        {!showFields && known ? (
          <Group label="Your name and email">
            <Row
              kind="value"
              label="Git knows you"
              hint={identityLine(known.name, known.email)}
              action={
                <CBtn tone="quiet" onClick={change}>
                  Change
                </CBtn>
              }
            >
              <StateWord state="done">Done</StateWord>
            </Row>
          </Group>
        ) : (
          <>
            {!gitReady && (
              <p className="ux-setup-note">Install Git first. Then Plyloft can save your name and email.</p>
            )}
            <Group label="Your name and email">
              <Row kind="text" label="Name" hint="Shown on every commit you make." error={errors?.name ?? undefined}>
                <TextField
                  value={name}
                  onChange={(v) => {
                    touched.current = true;
                    setName(v);
                  }}
                  disabled={!gitReady}
                  wide
                />
              </Row>
              {(!noreply || choice === "other") && (
                <Row
                  kind="text"
                  label="Email"
                  hint="Also shown on commits. If you use GitHub, use an email your GitHub account knows, or GitHub's private address."
                  error={errors?.email ?? undefined}
                >
                  <TextField
                    value={email}
                    onChange={(v) => {
                      touched.current = true;
                      setEmail(v);
                    }}
                    disabled={!gitReady}
                    wide
                  />
                </Row>
              )}
            </Group>
            {/* F1: with GitHub before Git, the address usually comes from there. */}
            {noreply && choice === "private" && (
              <p className="ux-setup-note" data-ply-email-from-github="">
                From your GitHub account. It keeps your real address private.
              </p>
            )}
            {noreply && (
              <ChoiceList<EmailChoice>
                label="Email"
                value={choice}
                onChange={setChoice}
                options={[
                  { value: "private", label: "Use my private GitHub address", hint: noreply },
                  {
                    value: "other",
                    label: "Use another email",
                    hint: "Also shown on commits. If you use GitHub, use an email your GitHub account knows.",
                  },
                ]}
              />
            )}
            {editing && (
              <div>
                <CBtn tone="quiet" onClick={() => setEditing(false)}>
                  Keep what Git has
                </CBtn>
              </div>
            )}
          </>
        )}
      </Section>

      {sheet === "install" && (
        <Sheet
          size="confirm"
          title={sheetWords.title}
          lede={sheetWords.lede}
          onClose={() => setSheet(null)}
          actions={
            <>
              <CBtn tone="quiet" onClick={() => setSheet(null)}>
                Cancel
              </CBtn>
              <CBtn tone="accent" onClick={() => void install()}>
                {sheetWords.confirm}
              </CBtn>
            </>
          }
        >
          {row.command && (
            <Details summary="Details">
              <pre className="ux-output">{row.command}</pre>
            </Details>
          )}
        </Sheet>
      )}

      {sheet === "save" && pending && (
        <IdentitySheet
          pending={pending}
          from={{ name: reported?.name ?? null, email: reported?.email ?? null }}
          saving={saving}
          error={saveError}
          onCancel={() => setSheet(null)}
          onSave={() => void save()}
        />
      )}
    </>
  );
}

/** Step 8, while Git can't commit yet (§5 step 4 Skip): the sentence and
 *  the way back to step 4. */
export function IdentityNeeded({ onGo }: { onGo: () => void }) {
  return (
    <Callout
      kind="warn"
      text={IDENTITY_NEEDED}
      actions={
        <CBtn tone="strong" onClick={onGo}>
          Go to Git and your name
        </CBtn>
      }
    />
  );
}
