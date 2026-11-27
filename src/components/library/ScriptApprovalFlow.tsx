import { Fragment, useEffect, useState } from "react";
import { CBtn, Group, PChip, Row, StatusLine } from "../ux";
import {
  projectSkillPublishReview,
  skillsHubApprove,
  skillsHubCopyReview,
  skillsHubInstallReview,
  skillsHubScriptsReview,
  type CopyFrom,
  type ScriptsReview,
  type ScriptsReviewFile,
} from "../../ipc";
import { approvedDay } from "../../lib/librarySkills";
import { machineWords } from "../../lib/platform";
import { LatestRequest } from "../../lib/latestRequest";
import { isScriptsWait } from "../../lib/skillCards";
import {
  ASKS_FOOTER,
  ASKS_PUBLISH_FOOTER,
  askingTexts,
  askingTextHint,
  asksInstallLede,
  asksLede,
  asksPublishLede,
  asksTitle,
  changedLines,
  sheetIsAboutText,
} from "../../lib/skillAsks";
import { SkillAsksList } from "./SkillAsksList";

/**
 * Skills hub H6b: the sheet asked before Install or Update writes a
 * library skill's files into the repository. `onConfirm` makes the card with
 * the scripts ids the OK names; it rejects with the backend's words, and a
 * refusal that names scripts (the library moved under the sheet) reads the
 * sheet again.
 */
export interface InstallSheet {
  workspaceId: string;
  /** Owner, 2026-10-19: `publish` — Publish to (or Update on) the shared
   *  workspace's branch of the member's own repository copy, which reaches
   *  teammates with no card; `branch` names it. */
  verb: "install" | "update" | "publish" | "copy";
  branch?: string;
  /** Skills hub H8: `copy` — Copy to…, what it copies and the workspaces
   *  that each get a card. */
  copyFrom?: CopyFrom;
  into?: string[];
  onConfirm: (scriptsIds: string[] | undefined) => Promise<void>;
}

type SheetVerb = InstallSheet["verb"];

/**
 * Skills hub H6a (R15; mockup `script-approval.html`): the *Needs your OK*
 * sheet for a team-library skill that brings a script or an extra file.
 *
 * A flow of its own in the centre, like Promote and Align: what came in and
 * from whom, what new sessions get meanwhile, every file — scripts first,
 * each one's text a press away — then the two answers. `OK` approves exactly
 * the version shown (its commit and scripts), on this Mac only; a pull that
 * landed meanwhile makes the backend refuse, and the sheet reads it again.
 *
 * H6b: with `install`, the same sheet is the **Install-time sheet** — what
 * the card would put in this repository — answered **OK, install** /
 * **OK, update** or **Cancel**.
 */
export function ScriptApprovalFlow({
  plugin,
  skill,
  onDone,
  onCancel,
  install,
  library,
}: {
  plugin: string;
  skill: string;
  /** The OK was recorded (or nothing needed one any more). */
  onDone: (approved: boolean) => void;
  onCancel: () => void;
  install?: InstallSheet;
  /** Skills hub H10: a My library skill's sheet (its clone, its words). */
  library?: "mine";
}) {
  const [review, setReview] = useState<ScriptsReview | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [generation, setGeneration] = useState(0);
  const installWorkspace = install?.workspaceId ?? null;
  const installVerb = install?.verb ?? null;
  const copyFrom = install?.copyFrom ?? null;
  const copyKey = copyFrom ? JSON.stringify(copyFrom) : null;

  useEffect(() => {
    const latest = new LatestRequest();
    const ticket = latest.begin();
    setReview(undefined);
    const read = installVerb === "copy" && copyFrom
      ? skillsHubCopyReview(copyFrom)
      : !installWorkspace || !installVerb
      ? skillsHubScriptsReview(plugin, skill, library)
      : installVerb === "publish"
        ? projectSkillPublishReview(installWorkspace, skill)
        : skillsHubInstallReview(installWorkspace, plugin, skill, installVerb === "copy" ? "install" : installVerb, library);
    read
      .then((answer) => {
        if (latest.isCurrent(ticket)) setReview(answer);
      })
      .catch((cause) => {
        if (!latest.isCurrent(ticket)) return;
        setReview(null);
        setError(String((cause as Error)?.message ?? cause));
      });
    return () => latest.retireAll();
    // `copyFrom` is read through its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin, skill, generation, installWorkspace, installVerb, copyKey, library]);

  async function approve(current: ScriptsReview) {
    setBusy(true);
    setError(null);
    try {
      await skillsHubApprove(current.plugin, current.skill, current.commit, current.scriptsIds, library);
      onDone(true);
    } catch (cause) {
      // The library moved under the sheet: show the new version.
      setError(String((cause as Error)?.message ?? cause));
      setGeneration((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  async function confirmInstall(sheet: InstallSheet, scriptsIds: string[] | undefined) {
    setBusy(true);
    setError(null);
    try {
      await sheet.onConfirm(scriptsIds);
      onDone(scriptsIds != null);
    } catch (cause) {
      const message = String((cause as Error)?.message ?? cause);
      setError(message);
      // The pull before the card brought other scripts: read them.
      if (isScriptsWait(message)) setGeneration((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  const eyebrow = install ? VERB_WORD[install.verb] : "Needs your OK";
  const branch = install?.branch ?? "the branch";
  const busyWords =
    install?.verb === "publish" ? "Publishing…" : install?.verb === "copy" ? "Making the cards…" : "Making the card…";
  if (review === undefined) {
    return (
      <div className="ux-flow">
        <p className="ux-flow-eyebrow">{eyebrow}</p>
        <StatusLine state="running">Reading {skill}…</StatusLine>
      </div>
    );
  }
  if (review === null) {
    return (
      <div className="ux-flow">
        <p className="ux-flow-eyebrow">{eyebrow}</p>
        <h2 className="ux-flow-title">
          <span className="ux-mono-fg">{skill}</span>
        </h2>
        <StatusLine state={error ? "aborted" : "done"}>
          {error ??
            (install?.verb === "publish"
              ? `Nothing in it needs your OK any more: what it brings is text only, or already on ${branch}.`
              : install
                ? "Nothing in it needs your OK any more: what it brings is text only, or already in this repository."
                : "Nothing to approve any more. New sessions get it as it is.")}
        </StatusLine>
        <div className="ux-flow-actions">
          {install ? (
            <>
              <CBtn tone="quiet" onClick={onCancel} disabled={busy}>
                Cancel
              </CBtn>
              <CBtn tone="accent" onClick={() => void confirmInstall(install, undefined)} disabled={busy}>
                {busy ? busyWords : VERB_WORD[install.verb]}
              </CBtn>
            </>
          ) : (
            <CBtn tone="accent" onClick={() => onDone(false)}>
              Done
            </CBtn>
          )}
        </div>
      </div>
    );
  }

  const asked = review.files.filter((f) => f.kind !== "text").length;
  // 1.175.0 B1: the skill's own text asks. With no script among what is
  // new, the sheet speaks of the text; either way it lists what it asks.
  // Round 3: every asking text, each with its own list (a nested SKILL.md,
  // the other CLI's copy when the two differ).
  const asking = askingTexts(review);
  const aboutText = sheetIsAboutText(review);
  const place = library === "mine" ? "My library" : "the team library";
  return (
    <div className="ux-flow">
      <p className="ux-flow-eyebrow">{eyebrow}</p>
      <h2 className="ux-flow-title">
        <span className="ux-mono-fg">{review.skill}</span>{" "}
        {aboutText ? asksTitle(install ? { ...review, firstTime: true } : review) : install ? installBringsWords(review, install.verb) : bringsWords(review)}
      </h2>
      <p className="ux-page-lede">
        {machineWords(
          aboutText && install?.verb === "publish"
            ? asksPublishLede(review, branch)
            : aboutText && (install?.verb === "install" || install?.verb === "update")
            ? asksInstallLede(review, install.verb)
            : aboutText && !install
            ? asksLede(review, place, approvedDay)
            : install?.verb === "publish"
            ? publishLedeOf(review, branch)
            : install?.verb === "copy"
              ? copyLedeOf(review, install.into ?? [])
              : install
                ? installLedeOf(review, install.verb)
                : ledeOf(review, library === "mine" ? "My library" : undefined),
        )}
      </p>
      {asking.length > 0 && (
        <SkillAsksList
          texts={asking.map((file) => ({
            path: file.path,
            copy: file.copies.length === 1 ? (file.copies[0] === "claude" ? "claude" : "codex") : null,
            asks: file.asks!,
            before: file.asksBefore,
          }))}
          approvedDay={review.approvedAt != null ? approvedDay(review.approvedAt) : null}
          publish={install?.verb === "publish"}
        />
      )}
      <Group>
        {review.files.map((file) => {
          const key = `${file.path}:${file.copies.join(",")}`;
          // A text nobody could read is shown at once: it is what to read.
          const open = shown[key] ?? (file.asks?.unreadable != null);
          const both = file.kind === "asks" && file.change === "changed" && file.textBefore != null && file.text != null;
          return (
            <Fragment key={key}>
              <Row
                kind="item"
                mono
                label={file.path}
                chips={<FileChips file={file} />}
                hint={
                  file.kind === "asks"
                    ? askingTextHint(file, sizeWords(file.size))
                    : install?.verb === "install" || install?.verb === "copy"
                      ? installFileHint(file)
                      : fileHint(file)
                }
                action={
                  file.text != null ? (
                    <CBtn size="sm" tone="quiet" onClick={() => setShown((s) => ({ ...s, [key]: !open }))}>
                      {open ? "Hide" : both ? "Show both" : "Show"}
                    </CBtn>
                  ) : undefined
                }
              />
              {open && both && (
                <div className="ux-versions" data-ply-text-versions="">
                  <div>
                    <div className="ux-versions-key">
                      {review.approvedAt != null ? `You approved on ${approvedDay(review.approvedAt)}` : "Before"}
                    </div>
                    <pre className="ux-output" aria-label={`${file.path} text you approved`}>
                      {file.textBefore}
                    </pre>
                  </div>
                  <div>
                    <div className="ux-versions-key">Now</div>
                    <pre className="ux-output ux-versions-value" aria-label={`${file.path} text`}>
                      <MarkedText text={file.text!} marked={changedLines(file.textBefore!, file.text!)} />
                    </pre>
                  </div>
                </div>
              )}
              {open && !both && file.text != null && (
                <pre className="ux-output" aria-label={`${file.path} text`}>
                  {file.text}
                </pre>
              )}
            </Fragment>
          );
        })}
      </Group>
      <p className="ux-footnote">
        {machineWords(
          aboutText && install?.verb === "publish"
            ? ASKS_PUBLISH_FOOTER
            : aboutText && !install
            ? ASKS_FOOTER
            : install?.verb === "publish"
            ? "Text-only skills never ask. Your OK is for this publish only: a later one that brings a new or changed script or file that is not text asks again."
            : install?.verb === "copy" && install.copyFrom?.kind !== "team"
            ? "Text-only skills never ask. Your OK is for this copy only: a later one that brings a new or changed script or file that is not text asks again."
            : install
            ? "Text-only skills never ask. A skill with hooks or an MCP server is refused, whatever you answer here. Your OK also lets new sessions on this Mac use this version."
            : "Text-only skills never ask. A skill with hooks or an MCP server is refused, whatever you answer here. Your OK is for this Mac only.",
        )}
      </p>
      {error && <StatusLine state="aborted">{error}</StatusLine>}
      <div className="ux-flow-actions">
        <CBtn tone="quiet" onClick={onCancel} disabled={busy}>
          {install ? "Cancel" : "Not now"}
        </CBtn>
        {install ? (
          <CBtn
            tone="accent"
            onClick={() => void confirmInstall(install, review.scriptsIds)}
            disabled={busy || asked === 0}
          >
            {busy ? busyWords : `OK, ${VERB_WORD[install.verb].toLowerCase()}`}
          </CBtn>
        ) : (
          <CBtn tone="accent" onClick={() => void approve(review)} disabled={busy || asked === 0}>
            {busy ? "Saving…" : review.firstTime ? "OK, use it" : "OK, use the new version"}
          </CBtn>
        )}
      </div>
    </div>
  );
}

const VERB_WORD: Record<SheetVerb, string> = {
  install: "Install",
  update: "Update",
  publish: "Publish",
  copy: "Copy",
};

const KIND_WORD: Record<ScriptsReviewFile["kind"], string> = {
  script: "Script",
  extra: "Extra file",
  // 1.175.0 B1: a skill's text that asks is still text; what it asks is the
  // list above the files.
  asks: "Text",
  text: "Text",
};

/** "Show both": the text now, the lines the approved version doesn't hold
 *  bold and underlined (never a background colour). */
function MarkedText({ text, marked }: { text: string; marked: Set<number> }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <Fragment key={i}>
          {marked.has(i + 1) ? <mark>{line}</mark> : line}
          {"\n"}
        </Fragment>
      ))}
    </>
  );
}

function FileChips({ file }: { file: ScriptsReviewFile }) {
  return (
    <>
      <PChip tone={file.kind === "script" ? "warn" : file.kind === "extra" ? "neutral" : "outline"}>
        {KIND_WORD[file.kind]}
      </PChip>
      {file.executable && <PChip tone="outline">executable</PChip>}
      {file.copies.length === 1 && (
        <PChip tone="outline">{file.copies[0] === "claude" ? "Claude copy" : "Codex copy"}</PChip>
      )}
    </>
  );
}

/** `1.2 KB · changed` — and why a file has no text to show. */
export function fileHint(file: ScriptsReviewFile): string {
  const parts = [sizeWords(file.size), file.change];
  if (file.tooLarge) parts.push("too large to show here");
  else if (file.text == null) parts.push("not text, so not shown");
  return parts.join(" · ");
}

/** H6b: on Install every file is new to the repository, so the hint says
 *  only its size and why it has no text to show. */
export function installFileHint(file: ScriptsReviewFile): string {
  const parts = [sizeWords(file.size)];
  if (file.tooLarge) parts.push("too large to show here");
  else if (file.text == null) parts.push("not text, so not shown");
  return parts.join(" · ");
}

export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Windows walk (H6b): what the sheet asks about is what is new or changed
 *  against the version sessions keep (every file on a first version) — an
 *  unchanged script beside a new image is not "a changed script". Scripts
 *  when one is among them, else the files that are not text; and whether
 *  those are new, changed, or both. */
function askedAbout(review: ScriptsReview): { script: boolean; how: "new" | "changed" | "new or changed" } {
  const moved = review.files.filter((f) => f.kind !== "text" && f.change !== "unchanged");
  const scripts = moved.filter((f) => f.kind === "script");
  // Nothing new or changed (a file only removed): named as the skill holds it.
  const script = moved.length > 0 ? scripts.length > 0 : review.files.some((f) => f.kind === "script");
  const pick = script ? scripts : moved;
  const how =
    pick.length > 0 && pick.every((f) => f.change === "new")
      ? "new"
      : pick.some((f) => f.change === "new")
        ? "new or changed"
        : "changed";
  return { script, how };
}

/** H6a: the sheet's heading after the skill's name. */
export function bringsWords(review: ScriptsReview): string {
  const { script, how } = askedAbout(review);
  const what = script ? "a script" : "a file that is not text";
  // Walk of H6a: the heading says what happened, as the lede does.
  if (review.firstTime) return `brings ${what}`;
  if (review.approvedAt != null) return `has a ${how} ${script ? "script" : "file that is not text"}`;
  return `now brings ${what}`;
}

/** Challenger (H6b): an Update names a script only when a script is what is
 *  new or changed: an unchanged script beside a new image is not "brought". */
function bringsScript(review: ScriptsReview, verb: SheetVerb): boolean {
  return review.files.some((f) => f.kind === "script" && (verb === "install" || verb === "copy" || f.change !== "unchanged"));
}

/** H6b: the Install-time sheet's heading. */
export function installBringsWords(review: ScriptsReview, verb: SheetVerb): string {
  const scripts = bringsScript(review, verb);
  if (verb === "install" || verb === "copy") return scripts ? "brings a script" : "brings a file that is not text";
  return scripts ? "brings a new or changed script" : "brings a new or changed file that is not text";
}

/** Owner, 2026-10-19: what Publish to <branch> puts on the shared branch,
 *  with no card to review it, and who gets it. */
export function publishLedeOf(review: ScriptsReview, branch: string): string {
  const script = bringsScript(review, "publish");
  const what = script ? "a new or changed script" : "a new or changed file that is not text";
  const use = script
    ? "Agents may run the script when they use the skill."
    : "Agents get the file when they use the skill.";
  return (
    `Publishing puts ${what} on ${branch} at once, with no card to review it. ` +
    `Everyone who works on this repository gets it. ${use}`
  );
}

/** Skills hub H8: what Copy to… would put in each workspace picked, who
 *  gets it. */
export function copyLedeOf(review: ScriptsReview, into: readonly string[]): string {
  const script = bringsScript(review, "copy");
  const what = script ? "a script" : "a file that is not text";
  const where =
    into.length === 0
      ? "each workspace you picked"
      : into.length === 1
        ? into[0]
        : `${into.slice(0, -1).join(", ")} and ${into[into.length - 1]}`;
  const use = script
    ? "Agents may run the script when they use the skill."
    : "Agents get the file when they use the skill.";
  return (
    `Copying puts these files in ${where} through ${into.length > 1 ? "a card each" : "a card"}, ${what} among them. ` +
    `Everyone who works on ${into.length > 1 ? "those repositories" : "that repository"} gets them once ${into.length > 1 ? "a card ships" : "the card ships"}. ${use}`
  );
}

/** H6b: what Install or Update would put in the repository, who gets it,
 *  and what the OK does on this Mac. */
export function installLedeOf(review: ScriptsReview, verb: "install" | "update"): string {
  const script = bringsScript(review, verb);
  const what = script ? "a script" : "a file that is not text";
  const put =
    verb === "install"
      ? `Installing puts these files in this repository through a card, ${what} among them.`
      : `This update puts ${script ? "a new or changed script" : "a new or changed file that is not text"} in this repository through a card.`;
  const who = "Everyone who works on this repository gets them once the card ships.";
  const use = script
    ? "Agents may run the script when they use the skill."
    : "Agents get the file when they use the skill.";
  const before =
    review.approvedAt != null
      ? ` You said OK to this version for sessions on this Mac on ${approvedDay(review.approvedAt)}.`
      : "";
  return `${put} ${who} ${use}${before}`;
}

/** What came in, what it can do, and what new sessions get meanwhile. */
/** H10: `place` names the library — the team's, or "My library". */
export function ledeOf(review: ScriptsReview, place = "the team library"): string {
  const who = review.author ?? "Someone";
  const { script, how } = askedAbout(review);
  const what = script ? "a script" : "a file that is not text";
  // (Challenger) True in each state: a version kept that was all text means
  // the script was added, not changed; and an image is not something agents run.
  // Windows walk (H6b): after an OK, what changed is said as it is — added,
  // changed, or both — and an unchanged script is not counted.
  const since =
    how === "new"
      ? `${who} added ${what} to it in ${place}.`
      : how === "changed"
        ? `${who} changed ${what} in ${place}.`
        : `${who} added or changed ${what} in ${place}.`;
  const came = review.firstTime
    ? `${who} added it to ${place} with ${what}.`
    : review.approvedAt != null
      ? since
      : `${who} added ${what} to it in ${place}.`;
  const kept = review.firstTime
    ? "New sessions don't get it until you say OK."
    : review.approvedAt != null
      ? `New sessions keep the version you approved on ${approvedDay(review.approvedAt)} until you say OK.`
      : `New sessions keep the version from before ${script ? "the script" : "that file"} until you say OK.`;
  const use = script
    ? machineWords("Agents may run it on this Mac when they use the skill.")
    : machineWords("Agents get it on this Mac when they use the skill.");
  return `${came} ${use} ${kept}`;
}
