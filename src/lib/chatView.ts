/**
 * Card chat (part 2): the words and rules of the card's Chat tab, apart
 * from React. Pure — no store, no IPC.
 */
import type {
  ChatAttachment,
  ChatAttachmentKind,
  ChatMessage,
  ChatStatus,
  ChatTokenUsage,
  ChatVendor,
} from "../ipc.ts";

export const CHAT_VENDORS: readonly ChatVendor[] = ["claude", "codex"];

export function chatVendorName(vendor: ChatVendor): string {
  return vendor === "codex" ? "Codex" : "Claude";
}

/** `chat://messages` carries added or changed messages: each replaces the
 *  one with its `id` where it stands, a new one goes at the end. */
export function mergeChatMessages(existing: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return existing as ChatMessage[];
  const out = existing.slice();
  const at = new Map<string, number>();
  out.forEach((m, i) => at.set(m.id, i));
  for (const message of incoming) {
    const i = at.get(message.id);
    if (i === undefined) {
      at.set(message.id, out.length);
      out.push(message);
    } else {
      out[i] = message;
    }
  }
  return out;
}

/** The member may write and send (the backend can still refuse a send). */
export function composerOpen(status: ChatStatus): boolean {
  return status === "idle" || status === "ready" || status === "stopped";
}

/** Stop is offered while the model answers. */
export function stopOffered(status: ChatStatus): boolean {
  return status === "working";
}

/** The vendor can be switched only when no answer is on its way: switching
 *  ends the other vendor's session. */
export function vendorSwitchOpen(status: ChatStatus): boolean {
  return status !== "working" && status !== "starting";
}

/** The state line. With `attention` (a menu or dialog on the vendor's own
 *  screen) a running session says it waits there, never "ready" beside the
 *  notice that says so (Mac walk of 6daf6ffd). */
export function chatStatusWords(status: ChatStatus, vendor: ChatVendor, attention?: string | null): string {
  const name = chatVendorName(vendor);
  // Not the notice's own title ("… is waiting on its own screen"): the
  // line and the notice say the same in different words.
  if (attention && (status === "ready" || status === "working")) return `${name} waits for an answer on its own screen.`;
  switch (status) {
    case "idle":
      return `${name} isn't running. Your next message starts it.`;
    case "starting":
      return `Starting ${name}…`;
    case "working":
      return `${name} is answering…`;
    case "ready":
      return `${name} is ready.`;
    case "stopped":
      return `${name} stopped. Your next message starts it again.`;
  }
}

/** The state line after a refused send: never "ready". */
export function chatRefusedWords(vendor: ChatVendor): string {
  return `${chatVendorName(vendor)} didn't take your last message. The reason is below.`;
}

const COUNT = new Intl.NumberFormat("en-US");

/** The conversation's tokens, as its vendor reported them. Never a cost.
 *  1.174.0 E10 (T14): null at zero — no line until something was used. */
export function chatTokenLine(usage: ChatTokenUsage | null | undefined): string | null {
  if (!usage) return null;
  const total =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens + usage.reasoningTokens;
  if (total === 0) return null;
  const parts = [`${COUNT.format(usage.inputTokens)} in`, `${COUNT.format(usage.outputTokens)} out`];
  if (usage.cacheReadTokens > 0) parts.push(`${COUNT.format(usage.cacheReadTokens)} read from the cache`);
  if (usage.cacheCreationTokens > 0) parts.push(`${COUNT.format(usage.cacheCreationTokens)} written to the cache`);
  if (usage.reasoningTokens > 0) parts.push(`${COUNT.format(usage.reasoningTokens)} reasoning`);
  return `Tokens in this conversation: ${parts.join(" · ")}.`;
}

export function formatChatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

const KIND_WORD: Record<ChatAttachmentKind, string> = {
  image: "Image",
  pdf: "PDF",
  docx: "Word",
  text: "Text",
  other: "File",
};

/** What a chip says after the name: kind, size, pages. */
export function attachmentFacts(attachment: Pick<ChatAttachment, "kind" | "bytes" | "pages">): string {
  const parts = [KIND_WORD[attachment.kind] ?? "File", formatChatBytes(attachment.bytes)];
  if (attachment.pages != null) parts.push(attachment.pages === 1 ? "1 page" : `${attachment.pages} pages`);
  return parts.join(" · ");
}

/** How each file is named in the tab. A chat can hold several files of one
 *  name (the same PDF added three times): the first keeps its name, the
 *  next are "name (2)", "name (3)", in the order they were added — so the
 *  list, the chips and each Remove button tell them apart. */
export function attachmentLabels(attachments: readonly Pick<ChatAttachment, "id" | "name">[]): Map<string, string> {
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const a of attachments) {
    const n = (seen.get(a.name) ?? 0) + 1;
    seen.set(a.name, n);
    labels.set(a.id, n === 1 ? a.name : `${a.name} (${n})`);
  }
  return labels;
}

/** The names that more than one file in the chat has. */
export function repeatedNames(attachments: readonly Pick<ChatAttachment, "name">[]): Set<string> {
  const counts = new Map<string, number>();
  for (const a of attachments) counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** When a file was added, for a name the chat holds more than once:
 *  "added 19:42" today, "added 15 Oct 19:42" another day, and
 *  "added 15 Oct 2025 19:42" another year (local time). */
export function attachmentAddedWords(addedAt: number | undefined, now: Date = new Date()): string | null {
  if (addedAt == null || !Number.isFinite(addedAt) || addedAt <= 0) return null;
  const at = new Date(addedAt);
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const today =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  if (today) return `added ${time}`;
  const year = at.getFullYear() === now.getFullYear() ? "" : ` ${at.getFullYear()}`;
  return `added ${at.getDate()} ${MONTHS[at.getMonth()]}${year} ${time}`;
}

/** The largest file any kind takes (a PDF's 32 MB): a bigger one is
 *  refused here, before its bytes are read. The backend holds each kind to
 *  its own limit (images 5 MB, Word 20 MB, text 2 MB). */
export const CHAT_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;

/** What Add files… offers: the extensions `chat_attachments.rs` takes
 *  (`IMAGE_EXTENSIONS`, pdf, docx, `TEXT_EXTENSIONS`). The backend still
 *  checks each file's signature. */
export const CHAT_ATTACHMENT_ACCEPT = [
  "png", "jpg", "jpeg", "gif", "webp",
  "pdf", "docx",
  "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "toml", "log", "html", "htm", "xml", "rtf", "ini", "sql",
]
  .map((ext) => `.${ext}`)
  .join(",");

export const CHAT_ATTACHMENT_LIMITS =
  "A chat takes images up to 5 MB, PDFs up to 32 MB, Word files up to 20 MB and text files up to 2 MB.";

export function tooLargeReason(bytes: number): string {
  return `It is ${formatChatBytes(bytes)}. ${CHAT_ATTACHMENT_LIMITS}`;
}

/** Pasted files are attached only when the clipboard holds no text: a copy
 *  from a document carries a picture of the text beside the text itself. */
export function pastedFilesToAttach(types: readonly string[], files: readonly File[]): File[] {
  if (files.length === 0) return [];
  if (types.includes("text/plain")) return [];
  return files.slice();
}

const IMAGE_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** A pasted image's name: the clipboard calls every one `image.png`, so it
 *  is named by when it was pasted, "Pasted image 2026-10-15 19.42.07.png".
 *  Anything that is not an image keeps its own name. */
export function pastedFileName(file: Pick<File, "name" | "type">, now: Date): string {
  const fromName = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase();
  const ext = IMAGE_EXTENSION[file.type] ?? (fromName && Object.values(IMAGE_EXTENSION).includes(fromName) ? fromName : null);
  if (!file.type.startsWith("image/") || !ext) return file.name;
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}.${two(now.getSeconds())}`;
  return `Pasted image ${stamp}.${ext}`;
}

/** Remove's tooltip: no question is asked, because only Plyloft's copy goes. */
export function removeAttachmentTitle(name: string): string {
  return `Remove ${name} from this chat. Only Plyloft's copy is deleted; your own file stays where it was.`;
}

/** The size the chat's screen grid keeps when no terminal shows it
 *  (`chat_screen`: the PTY's own 40 × 120). */
export const CHAT_PTY_COLS = 120;
export const CHAT_PTY_ROWS = 40;

/** The screen-reader line for a finished answer. */
export function answerAnnouncement(vendor: ChatVendor, text: string): string {
  const words = text.replace(/\s+/g, " ").trim();
  const short = words.length > 240 ? `${words.slice(0, 240)}…` : words;
  return `${chatVendorName(vendor)} answered: ${short}`;
}

export const CHAT_SCOPE_LINE =
  "Discussion only. The chat can read this card's title and notes, the files you add here, and the project, but it can't change anything.";

/** 1.171.0 (E1; CP-1, CF19): the card's chat is named for what it does —
 *  the header's button, its section and the tab's mode. */
export const ASK_ABOUT_CARD_LABEL = "Ask about this card";

/** 1.171.0 (E1; LG-21): the chat's way to the Builder — the draft goes to
 *  the Builder's session the way the result's Not right does. 1.175.0 F10
 *  (UX-11): "Send to the Builder"; with the field empty it sends the
 *  person's last message in the chat (to confirm at the strings' reread). */
export const TELL_BUILDER_LABEL = "Send to the Builder";
export const TELL_BUILDER_TITLE =
  "Sends what you wrote to the Builder's session instead of this chat, as Not right does, and opens the session so you can see it arrive. Files added here stay in this chat.";

/**
 * F10 round 2: the person's own last message in the chat, or null — only
 * one the person typed and sent here (`typed`: `chatStore`'s `typedIds`,
 * this window session). Not a `user` message read back from the CLI's
 * transcript (the session's priming), not a relay of the other AI's answer
 * (`relayOf`), not one that wasn't sent.
 */
export function lastPersonMessage(
  messages: readonly { id: string; role: string; text: string; isError?: boolean; relayOf?: string | null }[],
  typed: readonly string[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || m.isError || m.relayOf || !typed.includes(m.id) || !m.text.trim()) continue;
    return m.text.trim();
  }
  return null;
}

/** F10 round 2: what Send to the Builder does. With text in the field it
 *  sends it; with the field empty it never sends by itself: it puts the
 *  person's last message in the field (`fill`), to read and send with a
 *  second press; with neither it is off. */
export function tellBuilderPress(draft: string, last: string | null): { send: string } | { fill: string } | null {
  if (draft.trim()) return { send: draft.trim() };
  if (last) return { fill: last };
  return null;
}

/** F10: its title — today's with text in the field; with it empty, which
 *  message it puts back ("Also make the confirmation green…"). */
export function tellBuilderTitle(draft: string, last: string | null): string {
  if (draft.trim() || !last) return TELL_BUILDER_TITLE;
  const words = last.replace(/\s+/g, " ");
  const quote = words.length > 40 ? `${words.slice(0, 40).trimEnd()}…` : words;
  return `Puts your last message, “${quote}”, back in the field: read it, then press Send to the Builder to send it to the Builder's session.`;
}

/** Challenger 4: what the Builder reads — its own short intro, not the
 *  reviewer's "rejected" words of the result's Not right. */
export function tellBuilderMessage(text: string): string {
  return `The person sent you this from the card's chat, a side conversation you don't see. Make this change to the card's work:\n\n${text.trim()}`;
}

/** The toast once it is in the Builder's session. */
export const TELL_BUILDER_SENT =
  "It's in the Builder's session, opened so you can watch it pick it up. Files added in the chat stay there: add them to the card's Files, in its brief, for the Builder. When it's done, press Finish and check.";

/** Held per card: a second press while the first waits is refused. */
export const TELL_BUILDER_KEY = "chat-tell-builder";

/** Where the card's Builder stands, as the chat speaks of it: one that can
 *  be told (a Builder card, not done), none yet, or a card that is done. */
export type ChatBuilderReach = "builder" | "unbuilt" | "done";

/** The line above the chat's field: the Builder never sees this
 *  conversation, and the way that does change the work. */
export function chatBuilderLine(reach: ChatBuilderReach): string {
  // 1.175.0 F10 (UX-11): "chat", and the press it names.
  const lead = "The Builder doesn't see this chat.";
  switch (reach) {
    case "builder":
      return `${lead} To change the work, send it to the Builder.`;
    case "unbuilt":
      return `${lead} To change what it builds, edit What you want.`;
    case "done":
      return `${lead} This card is done: for more changes, use Follow up.`;
  }
}

/** The reach of a card that is not a pull request's review: done once it
 *  landed (Follow up is its way on), told once it has a Builder session
 *  record and isn't archived, else not built yet. */
export function chatBuilderReach(card: { landed: boolean; hasBuilder: boolean; archived: boolean }): ChatBuilderReach {
  if (card.landed) return "done";
  if (card.hasBuilder && !card.archived) return "builder";
  return "unbuilt";
}

/** Walk of #386: the scope line on a pull request's card, in the words its
 *  session is told (`pr_review::chat_note`): someone else's pull request has
 *  no Builder; the member's own is fixed only by Fix with the Builder. */
export function chatScopeLine(pullRequest?: { pushable: boolean; fixNote?: string | null } | null): string {
  if (!pullRequest) return CHAT_SCOPE_LINE;
  const lead =
    "Discussion only. The chat can read this card's title and notes, the files you add here, and the pull request's code, but it can't change anything.";
  if (pullRequest.pushable) return `${lead} Fixes to your pull request are made by Fix with the Builder, never here.`;
  // Walk 3 of #386 (finding 7): the member's own, from a protected branch.
  if (pullRequest.fixNote?.startsWith(PROTECTED_HEAD_LEAD)) {
    return `${lead} ${pullRequest.fixNote} Nothing on this card changes its code.`;
  }
  return `${lead} It is someone else's pull request: Plyloft only reviews it, and nothing on this card changes its code.`;
}

/** `pr_review::PROTECTED_HEAD_LEAD`. */
const PROTECTED_HEAD_LEAD = "This pull request's branch is ";

/** 1.174.1 P5 (T5): drawn through `machineWords` (this PC on Windows). */
export const CHAT_FILES_LINE = "Files you add stay on this Mac and are deleted with the card.";

export const CHAT_TERMINAL_RIGHTS =
  "This is the chat's own terminal. Anything you type here goes to Claude as you, and a command you run here runs with your rights on this Mac. Ctrl+C goes to Claude too (pressed twice it ends the session); on Windows it copies a selection when there is one.";
