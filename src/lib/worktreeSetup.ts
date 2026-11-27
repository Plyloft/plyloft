// SL-4: the words of a card worktree's setup — the one-time question about
// git-ignored `.env` files, the failure a card shows with Retry and Start
// anyway, and the rules an entry of `worktreeCopy` follows (the same ones
// `worktree_setup::copy_entry_problem` applies). Pure, so
// `worktreeSetup.test.ts` runs it under node.
import type { KanbanCard, WorktreeSetupRecord, WorktreeSetupStarted } from "../ipc";

/** The backend's refusals (`worktree_setup::SETUP_FAILED_REFUSAL`,
 *  `SETUP_APPROVAL_REFUSAL`, `SETUP_RUNNING_REFUSAL`) start with these
 *  words; `worktreeSetup.test.ts` reads the Rust source to keep them so. */
export const SETUP_FAILED_LEAD = "The card's setup failed";
export const SETUP_APPROVAL_LEAD = "The card's setup command needs your OK";
export const SETUP_RUNNING_LEAD = "The card is still being set up";

/** Which refusal `e` is: the lead that comes first in its text, so a
 *  command quoted in the reason after it can never decide. */
function setupRefusalKind(e: unknown): "failed" | "approval" | "running" | null {
  const text = e instanceof Error ? e.message : String(e ?? "");
  let best: { kind: "failed" | "approval" | "running"; at: number } | null = null;
  for (const [kind, lead] of [
    ["failed", SETUP_FAILED_LEAD],
    ["approval", SETUP_APPROVAL_LEAD],
    ["running", SETUP_RUNNING_LEAD],
  ] as const) {
    const at = text.indexOf(lead);
    if (at !== -1 && (best === null || at < best.at)) best = { kind, at };
  }
  return best?.kind ?? null;
}

/** A start refused because the card's setup failed or is still running. */
export function isWorktreeSetupFailure(e: unknown): boolean {
  return setupRefusalKind(e) !== null;
}

/** F5: a start refused by the card's setup says what to press — Retry,
 *  Allow and run, or Start anyway, on the card — never Start build, which
 *  the setup holds. `null` for any other refusal. */
export function setupRefusalNotice(e: unknown): { title: string; body: string } | null {
  const kind = setupRefusalKind(e);
  if (kind === "running") {
    return {
      title: "The card is still being set up",
      body: "The Builder waits for the setup; the card shows how it is going.",
    };
  }
  if (kind === null) return null;
  if (kind === "approval") {
    return {
      title: "The setup command needs your OK",
      body: "Nothing was started. On the card, Allow and run lets it run on this Mac; Start anyway starts the Builder without it.",
    };
  }
  return {
    title: "Setup failed",
    body: "Nothing was started. Open the card to see the output, then Retry or Start anyway.",
  };
}

/** What holds the card's Builder back, from its setup record (lane a). */
export type SetupHold = "running" | "failed" | "approval";

export function setupHold(record: WorktreeSetupRecord | null | undefined): SetupHold | null {
  if (!record) return null;
  if (record.state === "running") return "running";
  if (record.state === "failed") return record.approvalNeeded ? "approval" : "failed";
  return null;
}

/** F3/F5: the card's Now box and Board chip while its setup holds the
 *  Builder — under way, failed, or waiting for this Mac's OK — instead of
 *  "Ready to start … nothing has started". `retryLabel` is the primary. */
export function setupNowWords(
  record: WorktreeSetupRecord | null | undefined,
): { hold: SetupHold; label: string; helper: string; retryLabel: string | null } | null {
  const hold = setupHold(record);
  if (!hold || !record) return null;
  if (hold === "running") {
    return {
      hold,
      label: "Setting up the card",
      helper: record.command
        ? `${record.command} is running; the Builder waits for it.`
        : "Copying files in; the Builder waits for it.",
      retryLabel: null,
    };
  }
  const reason = record.reason ?? "The setup command failed.";
  if (hold === "approval") {
    return {
      hold,
      label: "Setup needs your OK",
      helper: `${reason} Nothing has started.`,
      retryLabel: "Allow and run",
    };
  }
  return {
    hold,
    label: "Setup failed",
    helper: `${reason} Nothing has started.`,
    retryLabel: "Retry",
  };
}

/** "a", "a and b", "a, b and c". */
function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function files(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

/** The one-time question, asked before the first card worktree is made. */
export function envProposalQuestion(found: string[], shared: boolean) {
  const one = found.length === 1;
  const them = one ? "it" : "them";
  return {
    title: one ? "Copy this file into cards' copies?" : "Copy these files into cards' copies?",
    body:
      `${listWords(found)} ${one ? "is" : "are"} ignored by git, so a card's ` +
      `copy starts without ${them}. Plyloft can copy ${them} in before the Builder starts. ` +
      // v1.154.1 (F10): one file is "its name … what it holds".
      `Only ${one ? "its name is" : "their names are"} ` +
      (shared ? "published with this repository's settings" : "saved in this repository's settings") +
      `, never what ${one ? "it holds" : "they hold"}.`,
    confirmLabel: one ? "Copy it" : "Copy them",
    cancelLabel: "Don't copy",
  };
}

/** What the card's run says about its setup — under way, failed, waiting
 *  for this Mac's OK, or started anyway. No "worktree" on this surface
 *  (docs/ux-language/PATTERNS.md): the card's own copy is "the card". */
export function setupFailureWords(record: WorktreeSetupRecord): { title: string; text: string } {
  if (record.state === "running") {
    return {
      title: "Setting up the card",
      text: record.command
        ? `${record.command} is running. The Builder starts when it is done.`
        : "Copying files in. The Builder starts when it is done.",
    };
  }
  const reason = record.reason ?? "The setup command failed.";
  if (record.state === "skipped") {
    return {
      title: "Setup failed — started anyway",
      text: `${reason} The Builder was started without it.`,
    };
  }
  if (record.approvalNeeded) {
    return {
      title: "The setup command needs your OK",
      text: `${reason} Allow and run lets it run on this Mac from now on; Start anyway starts the Builder without it.`,
    };
  }
  return {
    title: "Setup failed",
    text: `${reason} The Builder hasn't started. Retry runs the setup again; Start anyway starts the Builder without it.`,
  };
}

/** One line on what the copy did, when it did anything worth saying. */
export function copySummary(record: WorktreeSetupRecord): string | null {
  const copied = record.copied?.length ?? 0;
  const left = (record.skipped?.length ?? 0) + (record.unmatched?.length ?? 0);
  if (copied === 0 && left === 0) return null;
  const parts: string[] = [];
  if (copied > 0) parts.push(`${files(copied)} copied in`);
  if (left > 0) parts.push(`${left} left out`);
  return `${parts.join(", ")}.`;
}

/** The copy's leftovers, one line each: `path — why`. */
export function copyProblems(record: WorktreeSetupRecord): string[] {
  return [
    ...(record.skipped ?? []).map((s) => `${s.path} — ${s.reason}`),
    ...(record.unmatched ?? []).map((p) => `${p} — nothing in the main checkout matches it`),
  ];
}

/** The toast while a setup command runs (a cold install takes minutes).
 *  `card`: the card as known now. 1.168.1 (Mac walk): once its Builder has
 *  started (Try it's Set it up and try on a built card), the setup runs for
 *  the app, not before the Builder. */
export function setupStartedToast(
  e: WorktreeSetupStarted,
  card?: Pick<KanbanCard, "builder" | "buildBoth"> | null,
): { title: string; body: string } | null {
  if (!e.command) return null;
  const builderStarted = !!card?.builder || !!card?.buildBoth?.lanes.some((l) => l.startedAt != null);
  return builderStarted
    ? { title: "Setting up the card's copy", body: `${e.command} runs in the card's copy before your app starts.` }
    : { title: "Setting up the card", body: `${e.command} runs before the Builder starts.` };
}

/** Why a `worktreeCopy` entry can't be kept, in words; `null` when it can. */
export function worktreeCopyProblem(entry: string): string | null {
  const e = entry.trim();
  if (!e) return "A path is needed.";
  if (e.length > 300) return "A path is at most 300 characters.";
  if (e.startsWith("/") || e.startsWith("\\") || e[1] === ":") {
    return "A path is relative to the repository, so it can't start with /, \\ or a drive.";
  }
  if (e.includes("\\")) {
    return "A path is shared with every platform, so its folders are separated by /, not \\.";
  }
  const body = e.replace(/\/+$/, "");
  if (body.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return "A path names something inside the repository: no . or .. in it.";
  }
  if (body === ".git" || body.startsWith(".git/")) return "Git's own folder is never copied.";
  return null;
}

/** Ports per card worktree (`worktree_ports::PORT_COUNT`). */
export const PORT_COUNT = 10;

/** The card worktree's port block as its Technical details show it:
 *  `41020–41029 (PLYLOFT_PORT_BASE)`. */
export function portRangeWords(base: number): string {
  return `${base}–${base + PORT_COUNT - 1} (PLYLOFT_PORT_BASE)`;
}

/** How to use the block, one line. The setup command and the Builder run
 *  in bash (Git Bash on Windows), so `$PLYLOFT_PORT_BASE` reads the same on
 *  both; a PowerShell terminal on Windows reads `$env:PLYLOFT_PORT_BASE`. */
export function portHint(windows: boolean): string {
  const shell = windows ? " In PowerShell: $env:PLYLOFT_PORT_BASE." : "";
  return `Everything run in this card's copy gets them, e.g. PORT=$PLYLOFT_PORT_BASE npm run dev.${shell}`;
}
