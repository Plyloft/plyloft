import { useRef } from "react";
import { FailureText, Sheet } from "./ux";
import { failure } from "../lib/failure";
import { CBtn } from "./ui/primitives";
import { machineWords } from "../lib/platform";
import {
  CONFLICT_LEDE,
  USE_MINE_LABEL,
  conflictTitle,
  differenceRows,
  keepTheirsLabel,
} from "../lib/settingConflict";
import { useSettingConflict } from "../store/settingConflictStore";

/**
 * 1.173.0 (C3, mockup two-macs.html scene 2): "Your MacBook Pro changed
 * “Version files” 10 min ago" — only the difference, then *Keep the
 * MacBook Pro’s* · **Use this Mac’s**. Focus starts on keeping theirs, which
 * changes nothing on the repository. Closing it decides nothing; the Inbox
 * row stays until the choice is made. Mounted once, in the App.
 */
export function SettingConflictHost() {
  const open = useSettingConflict((s) => s.open);
  const busy = useSettingConflict((s) => s.busy);
  const error = useSettingConflict((s) => s.error);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  if (!open) return null;
  const { conflict } = open;
  const { close, answer } = useSettingConflict.getState();
  return (
    <Sheet
      key={`${open.workspaceId}:${conflict.field}`}
      title={conflictTitle(conflict)}
      lede={CONFLICT_LEDE}
      size="confirm"
      onClose={close}
      canDismiss={!busy}
      initialFocusRef={keepRef}
      actions={
        <>
          <CBtn ref={keepRef} disabled={busy} onClick={() => void answer("theirs")}>
            {keepTheirsLabel(conflict)}
          </CBtn>
          <CBtn tone="accent" disabled={busy} onClick={() => void answer("mine")}>
            {machineWords(USE_MINE_LABEL)}
          </CBtn>
        </>
      }
    >
      <dl className="ux-conflict-diff" data-ply-conflict-field={conflict.field}>
        {differenceRows(conflict).map((row) => (
          <div key={row.label} className="ux-conflict-row">
            <dt>{row.label}</dt>
            <dd>
              {row.items.map((item, i) => (
                <span key={`${i}:${item}`} className="ux-conflict-item">
                  {row.added && <span aria-hidden="true">+ </span>}
                  {item}
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      {error && (
        <div className="ux-sheet-lede" role="alert">
          <FailureText failure={failure("Plyloft couldn’t record your choice. Try again in a moment.", error)} />
        </div>
      )}
    </Sheet>
  );
}
