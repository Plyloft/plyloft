import { CBtn } from "./ui/primitives";
import { Details, Icon, Sheet } from "./ux";
import { toastText } from "./ToastStack";
import { useToasts, RECENT_TOASTS } from "../store/toastStore";
import { ago } from "../lib/cardPage";

/**
 * QoL 1.168 block 8 (A2): the last ten toasts, newest first, from the
 * Inbox's ⋯ › Recent messages — so a message that went while the person
 * looked away (or under the next one) can still be read. Words only: an
 * old toast's action (Undo, Open) is not offered again, it may act on
 * something that has moved on. Kept for this run of the app only.
 */
export function RecentMessagesSheet({ onClose, now = Date.now() }: { onClose: () => void; now?: number }) {
  const recent = useToasts((s) => s.recent);
  const clearRecent = useToasts((s) => s.clearRecent);
  return (
    <Sheet
      title="Recent messages"
      lede={`The last ${RECENT_TOASTS} messages Plyloft showed since it opened, newest first.`}
      onClose={onClose}
      actions={
        <>
          {recent.length > 0 && (
            <CBtn tone="quiet" onClick={clearRecent}>
              Clear the list
            </CBtn>
          )}
          <CBtn tone="accent" onClick={onClose}>
            Close
          </CBtn>
        </>
      }
    >
      {recent.length === 0 ? (
        <p className="ux-recent-empty">No messages yet. Each one Plyloft shows at the bottom of the window is kept here.</p>
      ) : (
        <ul className="ux-recent-list">
          {recent.map((t) => (
            <li key={t.id} className={`ux-recent-row ux-recent-row--${t.kind}`}>
              <span className="ux-recent-icon" aria-hidden="true">
                <Icon name={t.kind === "error" ? "failed" : t.kind === "warn" ? "warning" : "info"} />
              </span>
              <div className="ux-recent-text">
                <p className="ux-recent-line">
                  {t.kind === "error" ? <span className="ux-sr-only">Error: </span> : null}
                  {t.kind === "warn" ? <span className="ux-sr-only">Warning: </span> : null}
                  {toastText(t)}
                  {t.times && t.times > 1 ? <span className="ux-recent-when"> ×{t.times}</span> : null}
                  {t.undone ? <span className="ux-recent-when"> (undone)</span> : null}
                </p>
                <p className="ux-recent-when">{ago(now - t.createdAt)}</p>
                {t.details && (
                  <Details summary="Details">
                    <pre className="ux-output">{t.details}</pre>
                  </Details>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
