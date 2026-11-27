import { useCallback, useEffect, useState } from "react";
import {
  dictationModelDownload,
  dictationModelDownloadCancel,
  dictationStatus,
  isDictationError,
  onDictationDownloadProgress,
  type DictationModel,
  type DictationStatus,
} from "../../ipc";
import { useDoctor } from "../../store/doctorStore";
import { CBtn, Details, Group, MoreMenu, Row, RowValue, Section, StatusLine } from "../ux";
import { ChoiceRow, ResetThisPage, SettingsPage, ToggleRow } from "./rows";
import { useMacSettings } from "./useMacSettings";
import { field } from "./fields";
import type { Scope } from "../../lib/settingsNav";

/**
 * UX language card 8 (GH #103): Settings › This Mac › Dictation, on the `ux`
 * layer. The three preferences save as they change, with an Undo; the model
 * download is a procedure that runs now, and its progress is the row's hint.
 */

/** MiB, the unit the model sizes are quoted in ("~466 MB"). */
function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

const MODEL_LABEL: Record<DictationModel, string> = {
  small: "Small — understands any language, about 466 MB. Recommended.",
  base: "Base — understands any language, about 142 MB. Lighter, less accurate.",
};

export function DictationPage({
  scope,
  hiddenNote,
}: {
  scope: Scope;
  hiddenNote?: string | null;
}) {
  const mac = useMacSettings();
  const which = mac.settings.behavior.dictation.model;
  const enabled = mac.settings.behavior.dictation.enabled;
  const refreshDoctor = useDoctor((s) => s.refresh);

  const [status, setStatus] = useState<DictationStatus | null>(null);
  const [progress, setProgress] = useState<
    Partial<Record<DictationModel, { received: number; total: number | null }>>
  >({});
  const [starting, setStarting] = useState<DictationModel | null>(null);
  // The raw error: shown only in its Details ("What went wrong").
  const [error, setErrorDetails] = useState<string | null>(null);

  const reload = useCallback(() => {
    dictationStatus()
      .then(setStatus)
      .catch((e) => setErrorDetails(String(e)));
  }, []);

  useEffect(() => {
    reload();
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void onDictationDownloadProgress((p) => {
      setProgress((current) => ({
        ...current,
        [p.model]: { received: p.received, total: p.total },
      }));
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [reload]);

  // A download this page did not start (begun before it opened) settles with
  // no promise here, and a cancel or a failure emits no final event: follow
  // the backend's own flag until nothing is downloading.
  const anyDownloading =
    starting !== null || (status?.models.some((entry) => entry.downloading) ?? false);
  useEffect(() => {
    if (!anyDownloading) return;
    const timer = window.setInterval(reload, 1000);
    return () => window.clearInterval(timer);
  }, [anyDownloading, reload]);

  const model = status?.models.find((entry) => entry.id === which) ?? null;
  const downloading = Boolean(model?.downloading) || starting === which;
  const current = progress[which];
  const percent =
    current?.total && current.total > 0
      ? Math.min(100, Math.round((current.received / current.total) * 100))
      : null;

  function download(target: DictationModel) {
    setErrorDetails(null);
    setStarting(target);
    setProgress((p) => ({ ...p, [target]: { received: 0, total: null } }));
    // Show "downloading" at once; the status's own flag follows.
    reload();
    dictationModelDownload(target)
      .then((next) => {
        setStatus(next);
        void refreshDoctor();
      })
      .catch((e) => {
        if (isDictationError(e) && e.kind === "cancelled") return;
        setErrorDetails(isDictationError(e) ? e.message : String(e));
      })
      .finally(() => {
        setStarting(null);
        setProgress((p) => ({ ...p, [target]: undefined }));
        reload();
      });
  }

  const ready = model?.present === true && status?.whisperCli != null;
  return (
    <SettingsPage
      entry="dictation"
      scope={scope}
      hiddenNote={hiddenNote}
      lede="Hold Space to speak into a Codex or shell tile. Everything is transcribed on this Mac — nothing is sent anywhere. Saved as you change it."
      status={
        status == null ? (
          <StatusLine state="empty">Plyloft is looking for what dictation needs…</StatusLine>
        ) : ready ? (
          <StatusLine state="done">
            Ready — the {which} model is on this Mac and whisper.cpp is installed.
          </StatusLine>
        ) : (
          <StatusLine state="empty">
            Not ready yet — the two rows under “What it needs” say what is missing.
          </StatusLine>
        )
      }
    >
      <Section title="How it works" scope="this-mac">
        <Group>
          <ToggleRow
            mac={mac}
            field={field("behavior.dictation.enabled")}
            label="Hold Space to dictate"
            hint="In a Codex or shell tile, hold Space while the prompt is idle and speak; let go and the text is inserted, never sent — you press Enter. A tap is an ordinary space, and Esc cancels. Claude tiles use Claude Code's own /voice."
          />
          <ChoiceRow
            mac={mac}
            field={field("behavior.dictation.model")}
            label="Model"
            hint="The bigger one hears more accurately and takes longer to download."
            options={[
              { value: "small", label: MODEL_LABEL.small },
              { value: "base", label: MODEL_LABEL.base },
            ]}
          />
          <ChoiceRow
            mac={mac}
            field={field("behavior.dictation.language")}
            label="Language"
            hint="Left to itself it works out which language it heard. Pick one if short phrases come out in the wrong language."
            options={[
              { value: "auto", label: "Whatever it hears" },
              { value: "it", label: "Italian" },
              { value: "en", label: "English" },
            ]}
          />
        </Group>
      </Section>

      <Section title="What it needs" scope="this-mac">
        <Group>
          <Row
            kind="procedure"
            label="The model file"
            hint={
              status == null
                ? "Plyloft is looking…"
                : downloading
                  ? current
                    ? `Downloading — ${megabytes(current.received)}${
                        current.total ? ` of ${megabytes(current.total)}` : ""
                      }${percent != null ? ` (${percent}%)` : ""}`
                    : "Starting the download…"
                  : model?.present
                    ? `On this Mac — ${megabytes(model.sizeBytes ?? model.approxBytes)}.`
                    : `Not on this Mac yet. About ${megabytes(model?.approxBytes ?? 0)} to download, once.`
            }
            action={
              status == null ? undefined : downloading ? (
                <CBtn
                  disabled={!model?.downloading}
                  onClick={() => {
                    dictationModelDownloadCancel(which)
                      .catch(() => {})
                      .finally(() => window.setTimeout(reload, 300));
                  }}
                >
                  Cancel
                </CBtn>
              ) : model?.present ? (
                <RowValue>Ready</RowValue>
              ) : (
                <CBtn tone="accent" onClick={() => download(which)}>
                  Download
                </CBtn>
              )
            }
            // GH #317: the file's place is behind ⋯, not in the line.
            more={model?.present ? copyWhere("the model file", model.path) : undefined}
          />
          <Row
            kind="value"
            label="whisper.cpp"
            hint={
              status == null
                ? "Plyloft is looking…"
                : status.whisperCli
                  ? "This is what turns the sound into text, here on this Mac."
                  : "Not installed. Diagnostics offers the one step that installs it."
            }
            more={status?.whisperCli ? copyWhere("whisper.cpp", status.whisperCli) : undefined}
          >
            {status && <RowValue>{status.whisperCli ? "Installed" : "Not found"}</RowValue>}
          </Row>
        </Group>
        {error && (
          <Details summary="What went wrong">
            <pre className="ux-output">{error}</pre>
          </Details>
        )}
      </Section>

      <ResetThisPage
        mac={mac}
        page="dictation"
        hint={
          enabled
            ? "Holding Space, the model and the language go back to how Plyloft ships. The downloaded model file stays."
            : "Holding Space, the model and the language go back to how Plyloft ships — dictation comes back on. The downloaded model file stays."
        }
      />
    </SettingsPage>
  );
}

/** GH #317: a path is offered behind ⋯, never drawn in the row's line. */
function copyWhere(what: string, path: string) {
  return (
    <MoreMenu
      label={`More about ${what}`}
      items={[
        {
          label: "Copy where it is",
          onSelect: () => {
            navigator.clipboard.writeText(path).catch(() => {});
          },
        },
      ]}
    />
  );
}
