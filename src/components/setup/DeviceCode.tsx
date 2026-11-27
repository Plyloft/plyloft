// N14 walk F1 / F17: a one-time device code, the way every sign-in shows it —
// centred, large and spaced in its own block, with Copy code and the page to
// type it on (the primary) in a row under it. Used by the Plyloft sign-in
// (Setup step 2 and Settings › Plan) and by Setup's guided terminal for
// the GitHub CLI's (and Codex's) code.
import { CBtn } from "../ux";
import { pushToast } from "../../store/toastStore";
import { pushErrorToast } from "../../lib/errorToast";


export function DeviceCode({
  code,
  page,
  openLabel,
  onOpen,
}: {
  code: string;
  /** Where the code is typed ("github.com/login/device"), for Copy's toast;
   *  null when only the terminal names it. */
  page: string | null;
  /** The primary that opens `page`; without it only Copy code shows. */
  openLabel?: string;
  onOpen?: () => void;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      pushToast({
        kind: "info",
        title: "Code copied",
        body: page ? `Paste it on ${page}.` : "Paste it on the sign-in page.",
      });
    } catch (e) {
      pushErrorToast("Couldn't copy the code", e);
    }
  };
  return (
    <div className="ux-signin-code">
      <p className="ux-signin-code-value" data-ply-signin-code="" aria-label="One-time code">
        {code}
      </p>
      <div className="ux-signin-code-actions">
        <CBtn tone="strong" onClick={() => void copy()}>
          Copy code
        </CBtn>
        {onOpen && openLabel && (
          <CBtn tone="accent" onClick={onOpen}>
            {openLabel}
          </CBtn>
        )}
      </div>
    </div>
  );
}
