import type { DeliveryPath } from "../lib/deliveryStage";
import { machineWords } from "../lib/platform";
import { GITHUB_SIGN_IN_ACTION } from "../lib/plainError";
import { CBtn } from "./ux";

/**
 * 1.171.0 B1 (PLAN §3 Block B; REPORT T2): where the card's change is, under
 * Now's title — text first, as `deliveryPath` says it: the stops it passed,
 * the one it is at (bold, `aria-current`), the next one ("Next: …"). No
 * live region of its own (Challenger 3): Now's announcement says the
 * headline, which is the stage word, once when it changes — never every
 * tick of its checks. A shipped-only-here card has no stops (its headline
 * says it): only the helper.
 */
export function DeliveryPathLine({ path, onSignIn }: { path: DeliveryPath; onSignIn?: () => void }) {
  return (
    <div className="ux-delivery-path" data-ply-delivery-path={path.stage}>
      {path.steps.length > 0 && (
        <ol className="ux-delivery-steps" aria-label="Where the change is">
          {path.steps.map((step, i) => (
            <li
              key={`${i}-${step.at}`}
              className={`ux-delivery-step--${step.at}`}
              aria-current={step.at === "now" ? "step" : undefined}
            >
              {i > 0 && (
                <span className="ux-delivery-arrow" aria-hidden="true">
                  →
                </span>
              )}
              {machineWords(step.at === "next" ? `Next: ${step.text}` : step.text)}
            </li>
          ))}
        </ol>
      )}
      {path.helper && <p className="ux-delivery-helper">{machineWords(path.helper)}</p>}
      {path.signIn && onSignIn && (
        <div className="ux-card-section-actions" data-ply-github-sign-in="path">
          <CBtn tone="quiet" onClick={onSignIn}>
            {GITHUB_SIGN_IN_ACTION.label}
          </CBtn>
        </div>
      )}
    </div>
  );
}
