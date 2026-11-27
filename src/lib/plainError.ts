import { cliNotStartingSentence, decodeCliNotStarting } from "./cliNotStarting.ts";
import { showBackendText } from "./backendMarks.ts";
// QoL 1.168 block 8 (A5): an error that used to be shown in the tool's own
// words (`String(e)`, "os error 13", "[spawn failed: …]") as the error shape
// (`UxError`, PATTERNS.md §4): what happened in plain words, what was left as
// it was, what to do — and the raw text only behind Details. Pure: node runs
// it (`src/lib/plainError.test.ts`).
import { isWindows, machineWords } from "./platform.ts";
import type { UxError, UxErrorAction } from "./uxError.ts";
import { RELEASE_ASK_BUILDER_WORDS, RELEASE_ROLLED_BACK_WORDS, rawError, releaseConflict, releaseRollbackNotes } from "./cardPage.ts";
import { decodeTargetDirtyError, targetDirtyToastBody } from "./shipPreflight.ts";
import { decodeStopped, stoppedWords } from "./releaseSheet.ts";
import { decodeBackendRefusal } from "./shipRefusalWords.ts";
import { backendMarks } from "./backendMarks.ts";
import { startFailureLine } from "./startFailure.ts";

/** 1.169.1 (R11): what GitHub (through git or gh) refused a push, a pull
 *  request or a merge for — the shapes a person can act on. Matched on
 *  git's and gh's own stderr (`GH001`, `GH006`/`GH013`, `[rejected]`, an
 *  auth refusal), before the generic shapes below.
 *
 *  R11 (Challenger): only for a GitHub press (`opts.github`: Ship it to GitHub,
 *  Push update, Merge) or text that names GitHub ([`namesGitHub`]) — a
 *  Claude or Codex "not logged in" on Start build is not GitHub's. */
export type GitHubCause =
  | "large-file"
  | "secret"
  | "protected"
  | "ruleset"
  | "moved"
  | "rate-limit"
  | "ssh-key"
  | "no-access"
  | "sign-in";

/** Text that is GitHub's (or git talking to it): github.com, a `gh`
 *  command, a GHnnn code, a `remote:` line from the server. */
export function namesGitHub(raw: string): boolean {
  return /github\.com|\bgh\s|\bGH0\d\d\b|(?:^|\s)remote:\s|GitHub CLI/im.test(raw);
}

export function githubCause(cause: unknown, opts: { github?: boolean } = {}): GitHubCause | null {
  const raw = cause == null ? "" : rawError(cause);
  if (!opts.github && !namesGitHub(raw)) return null;
  if (/\bGH001\b|Large files detected|exceeds GitHub's file size limit/i.test(raw)) return "large-file";
  // GH013 is also secret scanning's push protection: a secret, not a rule.
  if (/PUSH PROTECTION|cannot contain secrets/i.test(raw)) return "secret";
  if (/\bGH006\b/i.test(raw)) return "protected";
  if (/\bGH013\b|repository rule violations/i.test(raw)) return "ruleset";
  if (/protected branch/i.test(raw)) return "protected";
  if (/\[rejected\]|non-fast-forward|\(fetch first\)|\(stale info\)/i.test(raw)) return "moved";
  // A 403 for too many requests is a wait, not a sign-in.
  if (/rate limit/i.test(raw)) return "rate-limit";
  if (/permission denied \(publickey\)/i.test(raw)) return "ssh-key";
  if (/resource not accessible|must have admin rights|permission to \S+ denied to/i.test(raw)) return "no-access";
  if (
    /authentication failed|bad credentials|invalid username or (?:password|token)|returned error: 40[13]\b|could not read username|terminal prompts disabled|not logged in|gh auth login|HTTP 40[13]\b/i.test(
      raw,
    )
  )
    return "sign-in";
  return null;
}

/** 1.171.0 B3 (DL-27): beside a protected branch, a repository rule or a
 *  branch that moved on — the page to look at, on GitHub. */
export const OPEN_ON_GITHUB_ACTION: UxErrorAction = { id: "open-github", label: "Open on GitHub" };

/** The GitHub page for a refusal of `kind`: the repository's branches, which
 *  mark the protected ones (protected), its rules (ruleset), the branch
 *  itself (moved — its branches when it isn't known). Null for any other refusal, or without an
 *  `owner/name` to name the repository. */
export function githubRefusalPage(
  kind: GitHubCause | null,
  repo: string | null | undefined,
  branch?: string | null,
): string | null {
  const slug = repo?.trim();
  if (!slug || !/^[\w.-]+\/[\w.-]+$/.test(slug)) return null;
  switch (kind) {
    // Challenger 5: pages every member can open (the settings pages are the
    // admins' only).
    case "protected":
      return `https://github.com/${slug}/branches`;
    case "ruleset":
      return `https://github.com/${slug}/rules`;
    case "moved": {
      const name = branch?.trim();
      return name
        ? `https://github.com/${slug}/tree/${name.split("/").map(encodeURIComponent).join("/")}`
        : `https://github.com/${slug}/branches`;
    }
    default:
      return null;
  }
}

/** The files GitHub named over its 100 MB limit (`File <path> is 123.45
 *  MB; this exceeds GitHub's file size limit …`). */
export function largeFilePaths(raw: string): string[] {
  return [...new Set([...raw.matchAll(/File (.+?) is [\d.]+ MB; this exceeds/g)].map((m) => m[1]))];
}

/** Sign in to GitHub: opens Settings › Account › Setup at GitHub accounts
 *  (`GITHUB_ACCOUNTS_ROW`), where gh's accounts are managed. */
export const GITHUB_SIGN_IN_ACTION: UxErrorAction = { id: "github-sign-in", label: "Sign in to GitHub", primary: true };
export const GITHUB_ACCOUNTS_PAGE = "setup";
export const GITHUB_ACCOUNTS_ROW = "GitHub accounts";

/** What GitHub refused for a file over 100 MB, the files named. */
export function largeFileFact(raw: string): string {
  const paths = largeFilePaths(raw);
  return `GitHub refuses files over 100 MB${paths.length > 0 ? `: ${paths.join(", ")}` : ""}.`;
}

/** The way on for a file over 100 MB: out of the card's commits (a
 *  .gitignore alone doesn't remove a file already committed) and into
 *  .gitignore — by the card's Builder when it has one (`builder`), then the
 *  same press again (`action`). */
export function largeFileWay(raw: string, opts: { action?: string; builder?: boolean } = {}): string {
  const it = largeFilePaths(raw).length > 1 ? "them" : "it";
  const take = opts.builder ? `Ask the Builder to take ${it}` : `Take ${it}`;
  const again = opts.action ? `, then press ${opts.action} again` : "";
  return `${take} out of the card's commits and add ${it} to .gitignore${again}.`;
}

/** GitHub's refusal of `kind`, in plain words (no press named). */
export function githubCauseWords(kind: GitHubCause, raw: string): string {
  switch (kind) {
    case "large-file":
      return `${largeFileFact(raw)} ${largeFileWay(raw)}`;
    case "secret":
      return `${SECRET_FACT} ${secretWay()}`;
    case "protected":
      return "This branch is protected on GitHub.";
    case "ruleset":
      return "GitHub's rules for this repository refused the push.";
    case "moved":
      // R11 (Challenger): neutral — it may be this person's own push.
      return "The branch on GitHub has commits this card doesn't.";
    case "rate-limit":
      return "GitHub is limiting requests right now; try again in a few minutes.";
    case "ssh-key":
      // 1.174.1 P5 (T5): this PC on Windows.
      return machineWords("GitHub didn't accept this Mac's SSH key.");
    case "no-access":
      return "This GitHub account can't push to or merge in this repository.";
    case "sign-in":
      return "GitHub didn't accept the sign-in.";
  }
}

/** GH013's push protection: a secret in the commits. */
export const SECRET_FACT = "GitHub found a secret in the card's commits.";

/** The way on for a secret: out of the card's commits — by the Builder
 *  when the card has one — then the same press again. */
export function secretWay(opts: { action?: string; builder?: boolean } = {}): string {
  const again = opts.action ? `, then press ${opts.action} again` : "";
  return `${opts.builder ? "Ask the Builder to take it out" : "Take it out"} of the card's commits${again}.`;
}

/** 1.176.2 (E1): a program that didn't start — only for a real spawn
 *  failure (a word `spawn`, not "respawn" or a file called spawn.rs), and
 *  naming the program when the text does: git, gh, the shell. */
function didntStartWords(raw: string): string | null {
  const spawned = /(?<![\w./-])spawn(?:ing)?(?![\w-]|\.\w)/i.test(raw);
  if (
    !spawned &&
    !/failed to start|not found in PATH|command not found|is not recognized/i.test(raw)
  )
    return null;
  if (/(?<![\w./-])(?:spawn(?:ing)?|failed to spawn)\s+git\b|\bgit: command not found|'git' is not recognized/i.test(raw))
    return "Git didn't start.";
  if (/(?<![\w./-])(?:spawn(?:ing)?|failed to spawn)\s+gh\b|\bgh: command not found|'gh' is not recognized/i.test(raw))
    return "The GitHub command didn't start.";
  return "The program didn't start.";
}

/** What a raw error says, in plain words — the known shapes; otherwise a
 *  sentence that sends the reader to Details. Never the raw text itself. */
export function plainCause(cause: unknown): string {
  const raw = cause == null ? "" : rawError(cause);
  // 1.176.0 R7: the typed "installed but doesn't start" (`lib/cliNotStarting`).
  const notStarting = decodeCliNotStarting(raw);
  if (notStarting) return cliNotStartingSentence(notStarting);
  // 1.176.2 (E1, M1): the typed "isn't there, even after looking again": the
  // sentence the tile's own line already says (`startFailureLine`).
  const gone = backendMarks(raw).find((m) => m.kind === "unavailable");
  if (gone) return startFailureLine({ tool: gone.tool, cause: "gone" });
  // 1.176.2 (E1): a release's own refusal says its reason in words.
  const refusal = decodeBackendRefusal(raw);
  if (refusal) return refusal;
  const github = githubCause(raw);
  if (github) return githubCauseWords(github, raw);
  const didntStart = didntStartWords(raw);
  if (didntStart) return didntStart;
  const byCode = osErrorCause(raw);
  if (byCode) return byCode;
  if (/EACCES|EPERM|permission denied|operation not permitted|access is denied/i.test(raw)) return PERMISSION_CAUSE;
  if (/ENOENT|no such file or directory|cannot find the (?:file|path)/i.test(raw)) return NOT_THERE_CAUSE;
  if (/ENOSPC|no space left/i.test(raw)) return DISK_FULL_CAUSE;
  if (/timed? ?out|ETIMEDOUT/i.test(raw)) return "It took too long and was stopped.";
  if (/could not resolve host|ENOTFOUND|network is unreachable|ECONNREFUSED|ECONNRESET|offline/i.test(raw))
    return "The network didn't answer.";
  // R11 (Challenger): not "not logged in" — Claude and Codex say that too.
  if (/authentication failed|bad credentials|401\b|403\b|gh auth login/i.test(raw))
    return "GitHub didn't accept the sign-in.";
  return CATCH_ALL;
}

const NOT_THERE_CAUSE = "A file or folder it needed isn't there any more.";
const DISK_FULL_CAUSE = "The disk is full.";
const NOT_A_FOLDER_CAUSE = "A folder it needed is a file instead.";
const IN_USE_CAUSE = "Another program is using that file.";
const NAME_TOO_LONG_CAUSE = "A file or folder name is too long.";

/** 1.176.3 (Windows walk): the OS error CODE Rust appends, `(os error N)`,
 *  whatever language the system's own text is in (an Italian Windows says
 *  "Accesso negato."). Codes are per platform: 2 is "not found" on both, but
 *  Windows' 3 is a missing path and Unix's 20 a "not a folder". */
export function osErrorCause(raw: string, windows: boolean = isWindows()): string | null {
  const m = /\(os error (\d+)\)/i.exec(raw);
  if (!m) return null;
  const code = Number(m[1]);
  if (windows) {
    if (code === 5) return PERMISSION_CAUSE;
    if (code === 2 || code === 3) return NOT_THERE_CAUSE;
    if (code === 32) return IN_USE_CAUSE;
    if (code === 267) return NOT_A_FOLDER_CAUSE;
    if (code === 112) return DISK_FULL_CAUSE;
    if (code === 206) return NAME_TOO_LONG_CAUSE;
    return null;
  }
  if (code === 13 || code === 1) return PERMISSION_CAUSE;
  if (code === 2) return NOT_THERE_CAUSE;
  if (code === 20) return NOT_A_FOLDER_CAUSE;
  if (code === 28) return DISK_FULL_CAUSE;
  if (code === 63 || code === 36) return NAME_TOO_LONG_CAUSE;
  return null;
}

/** The catch-all: for a surface that has a Details to send the reader to. */
const PERMISSION_CAUSE = "The computer didn't let Plyloft read or change a file there.";
export const CATCH_ALL = "Something went wrong; Details has the tool's own words.";

/** `plainCause` for a surface with no Details (a status line, the file tree,
 *  the Inbox's callout): a known cause in words; otherwise the tool's own
 *  line, so the clue isn't lost and nothing points at a Details that isn't there. */
export function lineCause(cause: unknown): string {
  const said = plainCause(cause);
  if (said !== CATCH_ALL) return said;
  const raw = (cause == null ? "" : rawError(cause)).trim().split("\n")[0] ?? "";
  return raw ? unquoteNames(raw) : "Plyloft doesn't know why.";
}

/** The cause in words for a toast body: a backend sentence (one line, a capital
 *  to a full stop) stands; anything else is put in words by `plainCause`. */
export function causeSentence(cause: unknown): string {
  const raw = (cause == null ? "" : rawError(cause)).trim();
  if (raw && !raw.includes("\n") && /^[A-Z“"`]/.test(raw) && /[.!?]$/.test(raw) && !looksRaw(raw) && !decodeBackendRefusal(raw))
    return unquoteNames(raw);
  return plainCause(raw);
}

/** 1.176.3 (walk): a folder that could not be listed. The shared cause says
 *  "a file" for a refused permission; a folder says "that folder". */
export function folderListCause(cause: unknown): string {
  const said = knownCause(cause);
  if (said === PERMISSION_CAUSE) return "The computer didn't let Plyloft read that folder.";
  return said ?? "Plyloft couldn't read that folder.";
}

/** The cause in words when it is a known shape or a backend sentence; null
 *  otherwise — never the raw text (an inline line has no Details to hold it). */
export function knownCause(cause: unknown): string | null {
  const said = causeSentence(cause);
  return said === CATCH_ALL ? null : said;
}

/** A search's status line for a failure: the backend's own message when it is
 *  already a full sentence (it says what to do), alone; otherwise "The search
 *  failed." and the cause in words. */
export function searchFailureLine(message: unknown): string {
  const raw = (message == null ? "" : rawError(message)).trim();
  if (raw && !raw.includes("\n") && /^[A-Z“"`]/.test(raw) && /[.!?]$/.test(raw) && !looksRaw(raw)) return unquoteNames(raw);
  if (!raw) return "The search failed.";
  return joinSentences("The search failed", lineCause(raw));
}

/** Sentences joined with one space, each ended once: never "..", "?." or ".!". */
export function joinSentences(...parts: ReadonlyArray<string | null | undefined | false>): string {
  return parts
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .map((p) => endSentence(p))
    .join(" ");
}

/** A capital to a full stop, three words or more, on one line: Rust's
 *  sentences for the person that happen to name a card or a slug in
 *  backticks. */
function readsAsSentence(t: string): boolean {
  return !t.includes("\n") && /^[A-Z“"`]/.test(t) && /[.!?]$/.test(t) && t.split(/\s+/).length >= 3;
}

/** A backend refusal already written for the person stands as what
 *  happened, with nothing behind Details; only text that reads as a tool's
 *  own — an OS error, an errno, a tool's lowercase prefix ("gh: …",
 *  "ship_batch blocked: …"), a stack, JSON, an exit status — is raw. */
export function looksRaw(raw: string): boolean {
  const t = raw.trim();
  if (t.length === 0) return false;
  return (
    /PLY_CLI_UNAVAILABLE_V1:/.test(t) ||
    /os error \d|\bE[A-Z]{3,}\b|^(?:Error|error|fatal|warning)\b|thread '.*' panicked|stack backtrace|Traceback|\bat \S+:\d+:\d+|^\s*[{[]|exit (?:code|status) -?\d|\bHTTP \d{3}\b/.test(t) ||
    /^[a-z][\w.-]*(?: [a-z_]+)?:\s/.test(t) ||
    // code-like tokens only (Challenger M2): `quoted`, a::path, a_call(
    // 1.176.2 (E1): …but a whole sentence that names something in backticks
    // is for the person ([`readsAsSentence`]); a lone token is not.
    (!readsAsSentence(t) && /`[^`]+`/.test(t)) ||
    /\w::\w|\b[a-z]+_[a-z_]+\(/.test(t) ||
    // long text is raw only when it doesn't read as sentences
    (t.length > 400 && !/[.!?]\s+[A-Z]/.test(t))
  );
}

/** A name Rust put in backticks, as the app's own quotes. */
export function unquoteNames(text: string): string {
  return text.replace(/`([^`]+)`/g, "“$1”");
}

/** Not raw, and something to say. */
export function looksPlain(raw: string): boolean {
  return raw.trim().length > 0 && !looksRaw(raw);
}

/** `text` as a sentence: a full stop only when it ends without one. */
export function endSentence(text: string): string {
  const t = text.trim();
  return /[.!?…:]$/.test(t) ? t : `${t}.`;
}

/** A Failure (`lib/failure.ts`) from a thrown error: a refusal already in
 *  plain words stands with nothing behind Details; raw text is put in plain
 *  words and kept for Details. */
export function plainFailure(cause: unknown): { sentence: string; details: string } {
  const raw = cause == null ? "" : rawError(cause).trim();
  return looksPlain(raw) && !decodeBackendRefusal(raw) ? { sentence: unquoteNames(raw), details: "" } : { sentence: plainCause(cause), details: raw };
}

/** "Your message wasn't sent." and why in plain words, as one Failure; the
 *  raw text behind Details. */
export function failureWith(what: string, cause: unknown): { sentence: string; details: string } {
  const said = plainFailure(cause);
  const head = /[.!?]$/.test(what) ? what : `${what}.`;
  return { sentence: `${head} ${said.sentence}`, details: said.details };
}

/** The error shape for a failure that has nothing more specific: `title`
 *  says what didn't happen, the cause is put in plain words, and its raw
 *  text waits behind Details. */
export function plainError(
  title: string,
  cause: unknown,
  opts: { todo?: string; untouched?: string; happened?: string; actions?: UxErrorAction[] } = {},
): UxError {
  const raw = cause == null ? "" : rawError(cause).trim();
  const plain = opts.happened == null && looksPlain(raw) && !decodeBackendRefusal(raw);
  return {
    title: /[.!?]$/.test(title) ? title : `${title}.`,
    happened: opts.happened ?? (plain ? unquoteNames(raw) : plainCause(cause)),
    untouched: opts.untouched ?? "Nothing was changed.",
    todo: opts.todo ?? "Try again. If it happens again, Details has what to look for.",
    actions: opts.actions ?? [],
    details: raw.length > 0 && !plain ? raw : null,
  };
}

/** A terminal's own lines for a session that didn't start or attach: the
 *  plain sentence in red, what to do, then the raw text dimmed — xterm has
 *  no Details, so the tool's words come last and quiet. */
export function terminalFailureLines(sentence: string, cause: unknown, todo: string): string[] {
  // 1.176.0 seams: a terminal never prints a backend mark (`backendMarks`).
  const raw = showBackendText(rawError(cause)).trim();
  return [
    `\x1b[31m${sentence}\x1b[0m ${plainCause(cause)}`,
    todo,
    ...(raw ? [`\x1b[2m${raw}\x1b[0m`] : []),
  ];
}

/** 1.169.1 (R11): the card's Push update and Merge line when GitHub said
 *  no. The backend's own line (`line`) stands unless GitHub's answer
 *  (`raw`, kept for Details) is one a person can act on — a sign-in, a
 *  protected branch, a file over 100 MB; a branch that moved on keeps the
 *  backend's words, which already say what to do. `signIn`: offer Sign in
 *  to GitHub beside it. */
export function githubRefusalLine(
  done: "Not pushed" | "Not merged",
  line: string,
  raw: string | null | undefined,
  way: { action?: string; builder?: boolean } = {},
): { line: string; signIn: boolean } {
  // Always a GitHub press: Push update and Merge talk to GitHub only.
  const kind = raw ? githubCause(raw, { github: true }) : null;
  if (kind == null || kind === "moved") return { line, signIn: false };
  if (kind === "large-file" && raw) {
    return {
      line: `${done}. ${largeFileFact(raw)} The pull request is as it was. ${largeFileWay(raw, way)}`,
      signIn: false,
    };
  }
  if (kind === "secret") {
    return { line: `${done}. ${SECRET_FACT} The pull request is as it was. ${secretWay(way)}`, signIn: false };
  }
  return {
    line: `${done}. ${githubCauseWords(kind, raw ?? "")} The pull request is as it was.`,
    // R11 (Challenger): another account may be able to (no-access).
    signIn: kind === "sign-in" || kind === "no-access",
  };
}

// ── The pull request card's own errors (PrReviewPanel) ──────────────────

const PR_AS_IT_WAS = "The pull request on GitHub is as it was.";

/** Push the fixes refused, in the backend's words (`refused`), or failed. */
export function prPushError(refused: string | null, cause?: unknown): UxError {
  if (cause !== undefined) return plainError("Nothing was pushed", cause, { untouched: PR_AS_IT_WAS });
  return plainError("Nothing was pushed", null, {
    happened: refused ?? "GitHub didn't take the push.",
    untouched: PR_AS_IT_WAS,
    todo: "Do what the line above says, then press Send the fixes to GitHub again.",
  });
}

/** Close and push: the Builder's session is still open. */
export function prSessionStillOpenError(): UxError {
  return plainError("Nothing was pushed", null, {
    happened: "The Builder's session didn't close.",
    untouched: PR_AS_IT_WAS,
    todo: "Close it from ⋯, then push.",
  });
}

/** The pull request couldn't be read from GitHub. */
export function prReadError(raw: string): UxError {
  return plainError("Plyloft couldn't read the pull request from GitHub", raw, {
    untouched: "The card and its copy are as they were.",
    todo: "Plyloft reads it again on the next refresh.",
  });
}

/** DR3 round 1: what a release that didn't go left, by the ready cards it
 *  had ticked (their titles): none — nothing; one — that card is still
 *  ready; more — the ready cards are. */
export function releaseUntouchedWords(ticked: readonly string[]): string {
  if (ticked.length === 0) return "Nothing was released.";
  if (ticked.length === 1) return `The cards on main are as they were; ${ticked[0].trim() || "the card"} is still ready.`;
  return "The cards on main are as they were; the ready cards are still ready.";
}

/** A release failed: the alert's line and the raw text for Details.
 *  `ticked`: the titles of the ready cards it had ticked. */
export function shipBatchFailure(cause: unknown, ticked: readonly string[] = []): { line: string; details: string | null } {
  const untouched = releaseUntouchedWords(ticked);
  // 1.174.0 (DR2): Stop the release took it back — the person's own stop,
  // never a failure (`{ stopped }`, from shipBatch, shipCard or releaseTheArea).
  const stopped = decodeStopped(cause);
  if (stopped) return { line: stoppedWords(stopped).body, details: null };
  // R6: the project folder's own changes refuse the batch before anything
  // is merged (Land's words); the files are under Details.
  const dirty = decodeTargetDirtyError(cause);
  // TX5 round 1 (T31b): the Ship toast's words; its Show them opens the
  // changes sheet (the Release sheet).
  if (dirty) return { line: `${targetDirtyToastBody(dirty)} ${untouched}`, details: dirty.paths.join("\n") || null };
  // R6: a card's conflict — the folder put back, the conflict on that card.
  const conflict = releaseConflict(rawError(cause));
  if (conflict) {
    return {
      line: [
        `Git couldn't merge “${conflict.title}” into ${conflict.target}: they conflict in ${conflict.files}.`,
        RELEASE_ROLLED_BACK_WORDS,
        ...releaseRollbackNotes(rawError(cause)),
        untouched,
        conflict.builder ? RELEASE_ASK_BUILDER_WORDS : "Resolve it in the card's copy, then release again.",
      ].join(" "),
      details: rawError(cause),
    };
  }
  // R7: two cards of the batch changed the same lines — nothing recorded on
  // either card; they ship separately.
  const between = /^Plyloft couldn't ship these cards together: (.+?; ship them separately\.)/s.exec(rawError(cause));
  if (between) {
    const raw = rawError(cause);
    return {
      line: [
        between[1],
        ...(raw.includes(RELEASE_ROLLED_BACK_WORDS) ? [RELEASE_ROLLED_BACK_WORDS] : []),
        ...releaseRollbackNotes(raw),
        untouched,
      ].join(" "),
      details: raw,
    };
  }
  const shown = plainError("The release didn't go", cause, { untouched });
  return { line: `${shown.happened} ${shown.untouched}`, details: shown.details };
}
