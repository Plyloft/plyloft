import { useCallback, useEffect, useState } from "react";
import {
  notificationAccess,
  notificationOpenSettings,
  notificationRequestAccess,
  notificationSendTest,
  type NotificationAccess,
} from "../ipc";
import { isWindows } from "../lib/platform";
import { notificationRowWords } from "../lib/notificationAccessWords";
import { setNotificationAccessCache } from "../store/notificationAccessCache";
import { CBtn, Details, Row } from "./ux";

/**
 * QoL 1.168 (F4, owner D6): the notification permission, as the system has
 * it, with the one action that moves it on — Allow (macOS asks once), the
 * system's settings when turned off, else a test. In Setup's Your AI step
 * and in Settings › Claude and Codex › Notifications.
 */
export function NotificationAccessRow() {
  const windows = isWindows();
  const [access, setAccessState] = useState<NotificationAccess | null>(null);
  const setAccess = useCallback((a: NotificationAccess | null) => {
    setAccessState(a);
    setNotificationAccessCache(a);
  }, []);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);

  const read = useCallback(() => {
    notificationAccess()
      .then(setAccess)
      .catch(() => setAccess("unknown"));
  }, [setAccess]);
  useEffect(() => {
    read();
    // Back from System Settings: say what it is now.
    const onFocus = () => read();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [read]);

  const words = notificationRowWords(access, windows);
  const act = () => {
    setDetails(null);
    if (words.action === "settings") {
      notificationOpenSettings().catch((e) => {
        setSaid("Plyloft couldn't open the settings. Details says why.");
        setDetails(String(e));
      });
      return;
    }
    setBusy(true);
    if (words.action === "allow") {
      setSaid("Answer macOS's question…");
      notificationRequestAccess()
        .then((next) => {
          setAccess(next);
          setSaid(next === "allowed" ? "Allowed." : next === "denied" ? "Not allowed." : null);
        })
        .catch((e) => {
          setSaid("macOS didn't answer. Details says why.");
          setDetails(String(e));
        })
        .finally(() => setBusy(false));
      return;
    }
    setSaid("Sending…");
    notificationSendTest()
      .then(() => {
        setSaid(windows ? "Sent. If nothing appeared, look in the notification centre." : "Sent. If nothing appeared, look in Notification Centre.");
        read();
      })
      .catch((e) => {
        setSaid("The system refused it. Details says why.");
        setDetails(String(e));
      })
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Row
        kind="procedure"
        label={words.label}
        hint={said ?? words.hint}
        action={
          <CBtn disabled={busy || access === null} onClick={act}>
            {busy && words.action === "test" ? "Sending…" : words.actionLabel}
          </CBtn>
        }
      />
      {details && (
        <Details>
          <pre className="ux-output">{details}</pre>
        </Details>
      )}
    </>
  );
}
