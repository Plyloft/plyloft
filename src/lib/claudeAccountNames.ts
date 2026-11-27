// 1.179.0 (C2): which Claude account a session runs on, in the words the
// tile, the card, the Inbox and History say it. The list is Rust's
// (`ai_accounts_list`, Main first); payloads carry only an account's id
// (absent or null: Main), so the name is looked up here. With Main alone
// nothing is said anywhere: every function that names an account says
// nothing then. Pure, so node tests it:
//
//     node --experimental-strip-types src/lib/claudeAccountNames.test.ts

import type { ClaudeAccountRow } from "../ipc.ts";

/** 1.179.0 (C3): what is sent to ask for Main by name while another
 *  account is current (`ai_accounts::MAIN_ID`): Main's row has no id, and
 *  an absent account means the current one. Read back as Main here. */
export const MAIN_ACCOUNT_ID = "main";

/** Names are shown only when more than one Claude account exists. */
export function accountNamesShown(rows: readonly ClaudeAccountRow[] | null | undefined): boolean {
  return (rows?.length ?? 0) > 1;
}

/** The name of account `id` (absent or null: Main), or null when no row
 *  has it (removed since) or the list isn't read yet. */
export function accountName(rows: readonly ClaudeAccountRow[] | null | undefined, id: string | null | undefined): string | null {
  const want = id === MAIN_ACCOUNT_ID ? null : (id ?? null);
  return rows?.find((r) => r.id === want)?.name ?? null;
}

/** The id of the account new sessions start on (null: Main). */
export function currentAccountId(rows: readonly ClaudeAccountRow[] | null | undefined): string | null {
  return rows?.find((r) => r.isCurrent)?.id ?? null;
}

/** The name to show for `id`, or null when names aren't shown (Main alone)
 *  or the account isn't listed. */
export function shownAccountName(rows: readonly ClaudeAccountRow[] | null | undefined, id: string | null | undefined): string | null {
  return accountNamesShown(rows) ? accountName(rows, id) : null;
}

/** Said where a recorded account is no longer listed (`ai_accounts::ACCOUNT_REMOVED`). */
export const ACCOUNT_REMOVED = "Its account was removed from Plyloft.";

/** Whether `id` names an account the list no longer has (Main never is). */
export function accountRemoved(rows: readonly ClaudeAccountRow[] | null | undefined, id: string | null | undefined): boolean {
  return rows != null && id != null && accountName(rows, id) === null;
}

export function tileAccountWords(name: string): string {
  return `Claude · ${name}`;
}

export function tileAccountTitle(name: string): string {
  return `This session runs on your Claude account ${name}. Its conversation is kept in that account's folder.`;
}

export function newSessionLabel(name: string): string {
  return `Claude on ${name}`;
}

/**
 * The accounts the new-session menu offers, as the `account` each one is
 * spawned with: every account by its id, Main included (C3: by
 * `MAIN_ACCOUNT_ID`, whichever account is current). Nothing with Main alone.
 */
export function newSessionChoices(rows: readonly ClaudeAccountRow[] | null | undefined): { label: string; account: string }[] {
  if (!rows || !accountNamesShown(rows)) return [];
  return rows.map((r) => ({ label: newSessionLabel(r.name), account: r.id ?? MAIN_ACCOUNT_ID }));
}

export function startFreshOnLabel(name: string): string {
  return `Start fresh on ${name}`;
}

export function startFreshOnTitle(name: string): string {
  return `Ends this session and starts a new Builder on ${name} in the same copy. The files stay; the conversation starts again.`;
}

/**
 * 1.179.0 (C3): the account a card's limit line offers to start fresh on,
 * for a Builder on `builderAccount` (absent or null: Main): the one new
 * sessions start on when it isn't the Builder's, else the first other one.
 * `account` is what `builder_start` is sent. Null with Main alone, or before
 * the list is read.
 */
export function startFreshOnChoice(
  rows: readonly ClaudeAccountRow[] | null | undefined,
  builderAccount: string | null | undefined,
): { name: string; account: string } | null {
  if (!rows || !accountNamesShown(rows)) return null;
  const own = builderAccount === MAIN_ACCOUNT_ID ? null : (builderAccount ?? null);
  const current = rows.find((r) => r.isCurrent);
  const row = current && current.id !== own ? current : rows.find((r) => r.id !== own);
  return row ? { name: row.name, account: row.id ?? MAIN_ACCOUNT_ID } : null;
}

/** The card's Run step sentence when names are shown. */
export function buildsOnWords(name: string, model: string | null): string {
  return model ? `Builds on Claude (${name}) with ${model}` : `Builds on Claude (${name})`;
}

export function resumesOnNote(name: string): string {
  return `Resumes on ${name}, where this conversation is kept.`;
}

/** The note beside a Resume whose recorded account isn't the one new
 *  sessions start on, or null (names not shown, the same account, or one
 *  no longer listed: that says `ACCOUNT_REMOVED` instead). */
export function resumeNoteFor(rows: readonly ClaudeAccountRow[] | null | undefined, recorded: string | null | undefined): string | null {
  if (!accountNamesShown(rows)) return null;
  if ((recorded ?? null) === currentAccountId(rows)) return null;
  const name = accountName(rows, recorded);
  return name ? resumesOnNote(name) : null;
}

/** The Inbox row of a usage limit on a named account. */
export function inboxLimitWords(name: string, resetsAt: string | null | undefined): string {
  return resetsAt ? `Claude (${name}) usage limit · resets ${resetsAt}` : `Claude (${name}) usage limit`;
}

/** Setup's "Your AI" step: where a second subscription is added. The
 *  line is drawn as the question and its link (the second part). */
export const SETUP_SECOND_ACCOUNT_ASK = "Have a second Claude subscription?";
export const SETUP_SECOND_ACCOUNT_LINK = "Add it in Settings › Cards › AI and models.";
export const SETUP_SECOND_ACCOUNT = `${SETUP_SECOND_ACCOUNT_ASK} ${SETUP_SECOND_ACCOUNT_LINK}`;
