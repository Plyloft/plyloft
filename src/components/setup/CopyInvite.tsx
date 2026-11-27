// §12.2: Copy invite — the team's invite message on the clipboard, and the
// code it holds on screen (team walk 2026-10-01, F2): a clipboard nobody can
// see is not something an owner can check before sending. Drawn by Setup ›
// Team and by Settings › Team › Members, inside the caller's Group.
import { useState } from "react";
import { CBtn, Row, RowValue } from "../ux";
import { teamInviteCode } from "../../ipc";
import { pushToast } from "../../store/toastStore";
import { COPY_INVITE, copiedToast } from "../../lib/teamStep";
import { pushErrorToast } from "../../lib/errorToast";


export function CopyInviteRows({ name }: { name: string | null }) {
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  async function copy() {
    setBusy(true);
    try {
      const invite = await teamInviteCode();
      await navigator.clipboard.writeText(invite.message);
      setCode(invite.code);
      const toast = copiedToast(name);
      pushToast({ kind: "info", title: toast.title, body: toast.body });
    } catch (e) {
      pushErrorToast("Couldn't copy the invite", e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Row
        kind="procedure"
        label={COPY_INVITE}
        hint="A message with the team's invite code. Send it to the people you've invited: they paste it in Plyloft, which accepts the invitation for them."
        action={
          <CBtn disabled={busy} onClick={() => void copy()}>
            {COPY_INVITE}
          </CBtn>
        }
      />
      {code && (
        <Row kind="value" label="Copied" hint="The invite code in the message on your clipboard.">
          <RowValue mono>{code}</RowValue>
        </Row>
      )}
    </>
  );
}
