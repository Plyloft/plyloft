/**
 * 1.173.0 (C3): the words of the question a shared setting both sides
 * changed asks — "Your MacBook Pro changed “Version files” 10 min ago" —
 * and when it opens by itself. The backend holds the field
 * (`shared_config::prepare`) and sends only the difference
 * (`setting_conflict.rs`). Pure, so `settingConflict.test.ts` runs it under
 * plain node.
 */
import { ago, quotedLabel } from "./definitionRefresh.ts";
import { machineWords, platform } from "./platform.ts";
import type { SettingConflict } from "../ipc.ts";

export const CONFLICT_LEDE = "You changed it here too, before seeing that. Which should the repository keep?";
export const USE_MINE_LABEL = "Use this Mac’s";

function machine(): string {
  return platform() === "windows" ? "PC" : "Mac";
}

/** The other side, as the sentence names it. */
function them(c: SettingConflict): { the: string; Who: string; The: string } {
  // C3 Challenger 2: another folder of this repository on this very Mac.
  if (c.thisComputer) {
    return { the: "the other folder", Who: "You", The: "The other folder" };
  }
  if (c.samePerson) {
    const computer = c.device?.trim() || `other ${machine()}`;
    return { the: `the ${computer}`, Who: `Your ${computer}`, The: `The ${computer}` };
  }
  // A login keeps its own case.
  const author = c.author?.trim();
  return author
    ? { the: author, Who: author, The: author }
    : { the: "the repository", Who: "Someone else", The: "The repository" };
}

/** "Your MacBook Pro changed “Version files” 10 min ago". */
export function conflictTitle(c: SettingConflict, nowSecs: number = Date.now() / 1000): string {
  const when = c.changedAt != null ? ` ${ago(nowSecs, c.changedAt)}` : "";
  const where = c.thisComputer ? machineWords(" in another folder on this Mac") : "";
  return `${them(c).Who} changed “${c.label}”${where}${when}`;
}

/** "Keep the MacBook Pro’s", "Keep bob’s". */
export function keepTheirsLabel(c: SettingConflict): string {
  return `Keep ${them(c).the}’s`;
}

export interface DifferenceRow {
  label: string;
  /** What the row lists, in words. */
  items: string[];
  /** Only this Mac's: each item is marked "+". */
  added?: boolean;
}

/** Only what differs: for a list, what both have and what each side alone
 *  has; for one value, theirs against this Mac's. */
export function differenceRows(c: SettingConflict): DifferenceRow[] {
  const d = c.difference;
  const t = them(c);
  if (d.keys?.length) {
    return [
      { label: t.The, items: d.keys.map((k) => `${k.name}: ${k.theirs}`) },
      { label: machineWords("This Mac"), items: d.keys.map((k) => `${k.name}: ${k.mine}`) },
    ];
  }
  if (!d.list) {
    return [
      { label: t.The, items: [d.theirs] },
      { label: machineWords("This Mac"), items: [d.mine] },
    ];
  }
  const rows: DifferenceRow[] = [];
  if (d.both.length) rows.push({ label: "Both have", items: d.both });
  if (d.different.length) rows.push({ label: "Set differently on each", items: d.different });
  if (d.onlyMine.length) rows.push({ label: machineWords("Only this Mac adds"), items: d.onlyMine, added: true });
  if (d.onlyTheirs.length) rows.push({ label: `Only ${t.the} has`, items: d.onlyTheirs });
  return rows;
}

/** One question, for "asked already this session". A new value from the
 *  other side is a new question. */
export function conflictKey(workspaceId: string, c: Pick<SettingConflict, "field" | "changedAt">): string {
  return `${workspaceId}:${c.field}:${c.changedAt ?? 0}`;
}

/** The Inbox row's id (`setting_conflict::inbox_id`) → its field. */
export function conflictFieldOfInboxId(id: string): string | null {
  const m = /^setting-conflict:.+:([^:]+):-?\d+$/.exec(id);
  return m ? m[1] : null;
}

/**
 * The sheet opens by itself only where the person is: Plyloft visible and
 * focused, on that workspace. Otherwise the Inbox row waits. Never twice for
 * the same question in a session (closing it leaves the row).
 */
export function opensByItself(ctx: {
  visible: boolean;
  focused: boolean;
  activeWorkspaceId: string | null;
  workspaceId: string;
  key: string;
  asked: ReadonlySet<string>;
}): boolean {
  return ctx.visible && ctx.focused && ctx.activeWorkspaceId === ctx.workspaceId && !ctx.asked.has(ctx.key);
}

/** C3 Challenger 9: the toast after *Keep …'s* — what this Mac's change
 *  carried that is gone now. For a value made of keys only the clashing keys
 *  go (the rest stays). */
export function droppedToast(c: SettingConflict): { title: string; body?: string } {
  const d = c.difference;
  // 1.174.0 (DS2 round 1): a row's name in a sentence is quoted.
  const title = `Your change to ${quotedLabel(c.label)} was dropped`;
  if (d.keys?.length) {
    return {
      title,
      body: `${d.keys.map((k) => `${k.name}: ${k.mine}`).join(" · ")}. Your other changes to it stay.`,
    };
  }
  if (d.list) {
    const gone = [...d.onlyMine.map((i) => `+ ${i}`), ...d.different];
    return gone.length ? { title, body: gone.join(" · ") } : { title };
  }
  return { title, body: machineWords(`This Mac had: ${d.mine}`) };
}

/** What the answer sends back: the question as it was shown. */
export function shownOf(c: SettingConflict): { theirs: unknown; changedAt: number | null } {
  return { theirs: c.theirs ?? null, changedAt: c.changedAt };
}
