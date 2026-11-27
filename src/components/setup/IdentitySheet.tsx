// OB-6's identity consent sheet, shared with OB-7a's back-fill ("Use my
// GitHub address" runs the same `git config --global` write, with the same
// sheet — ONBOARDING_SPEC §5 step 5). It names both commands under Details
// and shows what changes; the caller writes on Save (`setupIdentityWrite`).
import { CBtn, Details, Sheet, SheetChange, StatusLine } from "../ux";
import { machineWords } from "../../lib/platform";
import { configCommands } from "../../lib/gitStep";
import type { IdentityWritten } from "../../ipc";

export function IdentitySheet({
  pending,
  from,
  saving,
  error,
  onCancel,
  onSave,
}: {
  /** What Save writes, fixed when the sheet opened. */
  pending: IdentityWritten;
  /** What Git has now. */
  from: { name: string | null; email: string | null };
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <Sheet
      size="confirm"
      title="Set your Git name and email?"
      lede={machineWords("Every Git project on this Mac uses these unless it sets its own.")}
      onClose={() => {
        if (!saving) onCancel();
      }}
      canDismiss={!saving}
      actions={
        <>
          <CBtn tone="quiet" onClick={onCancel} disabled={saving}>
            Cancel
          </CBtn>
          <CBtn tone="accent" onClick={onSave} disabled={saving}>
            Save
          </CBtn>
        </>
      }
    >
      <SheetChange label="Name" from={from.name ?? "Not set"} to={pending.name} />
      <SheetChange label="Email" from={from.email ?? "Not set"} to={pending.email} />
      <Details summary="Details">
        <pre className="ux-output">{configCommands(pending.name, pending.email).join("\n")}</pre>
        <p className="ux-setup-note">A project can set its own with git config user.email inside it.</p>
      </Details>
      {error && <StatusLine state="aborted">{error}</StatusLine>}
    </Sheet>
  );
}
