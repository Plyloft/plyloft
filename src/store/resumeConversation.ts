import { terminalResumeCheck, type ShellEnvInfo, type TileTitle } from "../ipc";
import {
  FOLDER_GONE,
  OPEN_ELSEWHERE,
  goneMessage,
  type ConversationKind,
} from "../lib/terminalConversations";
import { ACCOUNT_REMOVED } from "../lib/claudeAccountNames";
import { openCodexTile } from "./openCodexTile";
import { useTiles } from "./tileStore";
import { showNewTile, showTile } from "./tileActions";

/**
 * Terminals block P4 (owner, 2026-10-21): one way to pick a conversation up
 * again — Resume… in New ▾ and History › Sessions. One a tile runs (in any
 * workspace) is shown, never opened twice; one another Claude on this
 * computer is in, or whose folder or file is gone, says so and starts
 * nothing (`terminal_resume_check`); any other opens a new tile of its kind
 * in the folder it ran in (`claude --resume <id>`, `codex resume <id>`),
 * through the tiles' own spawn (`pty_spawn`), named as the conversation was.
 */
export interface ResumeTarget {
  workspaceId: string;
  /** The folder it ran in: a conversation resumes there only. */
  cwd: string;
  kind: ConversationKind;
  cliSessionId: string;
  title?: string | null;
  titleSource?: TileTitle["titleSource"] | null;
  /** A tile that runs it now. */
  livePtyId?: string | null;
  /** 1.179.0 (C2): the Claude account it is kept on (the row's); absent:
   *  Main, or the one its record says. */
  account?: string | null;
}

export type ResumeOutcome =
  | { kind: "shown"; tileId: string }
  | { kind: "opened"; tileId: string }
  | {
      kind: "failed";
      message: string;
      /** Challenger round 2: Claude's file says another Claude is in it — a
       *  hint only (a crash can leave one behind): the member may open it
       *  anyway. */
      canOpenAnyway?: boolean;
      /** 1.174.0: the folder it ran in is gone. */
      folderGone?: boolean;
    };

export async function resumeConversation(
  t: ResumeTarget,
  env: ShellEnvInfo | null | undefined,
  how: { anyway?: boolean } = {},
): Promise<ResumeOutcome> {
  const show = (ptyId: string | null | undefined): ResumeOutcome | null => {
    const live = ptyId ? useTiles.getState().getTileByPtyId(ptyId) : null;
    if (!live) return null;
    // QoL 1.168 (A1): Show it lands with the keyboard in the tile.
    showTile(live.workspaceId, live.id);
    return { kind: "shown", tileId: live.id };
  };
  const shown = show(t.livePtyId);
  if (shown) return shown;
  if (t.kind === "claude" && !env?.claudePath) {
    return { kind: "failed", message: "Claude isn't installed on this computer, so this conversation can't be resumed here." };
  }
  if (t.kind === "codex" && !env?.codexPath) {
    return { kind: "failed", message: "Codex isn't installed on this computer, so this conversation can't be resumed here." };
  }
  const account = t.kind === "claude" ? (t.account ?? null) : null;
  const check = await terminalResumeCheck(t.kind, t.cliSessionId, t.cwd, account).catch(() => null);
  if (!check) return { kind: "failed", message: "Plyloft couldn't check this conversation. Try again in a moment." };
  if (check.kind === "inTile") {
    const there = show(check.ptyId);
    if (there) return there;
    return { kind: "failed", message: OPEN_ELSEWHERE };
  }
  if (check.kind === "elsewhere" && !how.anyway) return { kind: "failed", message: OPEN_ELSEWHERE, canOpenAnyway: true };
  if (check.kind === "folderGone") return { kind: "failed", message: FOLDER_GONE, folderGone: true };
  if (check.kind === "conversationGone") return { kind: "failed", message: goneMessage(t.kind) };
  if (check.kind === "accountRemoved") return { kind: "failed", message: ACCOUNT_REMOVED };
  const opts = {
    args: t.kind === "claude" ? ["--resume", t.cliSessionId] : ["resume", t.cliSessionId],
    label: t.title ?? undefined,
    // A name the member gave stays theirs; any other follows the CLI (P2).
    labelSource: t.titleSource === "user" ? ("user" as const) : ("auto" as const),
    cliSessionId: t.cliSessionId,
    ...(account ? { account } : {}),
  };
  const tile =
    t.kind === "claude"
      ? useTiles.getState().addClaudeTile(t.workspaceId, t.cwd, opts)
      : openCodexTile(t.workspaceId, t.cwd, env, "codex", opts);
  if (!tile) return { kind: "failed", message: "Codex can't start on this computer right now. Settings › Setup and account › Diagnostics says why." };
  showNewTile(tile);
  return { kind: "opened", tileId: tile.id };
}
