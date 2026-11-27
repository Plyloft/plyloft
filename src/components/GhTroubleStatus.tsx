// N14 walk F16: a GitHub read that failed because gh isn't signed in (or Git
// couldn't sign in), said as one plain line with its one way out — Setup ›
// GitHub for pull requests — and the tools' own words behind Show details.
// The classification is `lib/ghTrouble.ts`; any surface whose raw error may
// be one of these draws this in place of the raw line.
import { CBtn, Details, StatusLine } from "./ux";
import { useSetup } from "../store/setupStore";
import { GH_SIGN_IN_ACTION, GH_TROUBLE_DETAILS, type GhTrouble } from "../lib/ghTrouble";

export function GhTroubleStatus({ trouble }: { trouble: GhTrouble }) {
  return (
    <div className="ux-gh-trouble" data-ply-gh-trouble={trouble.kind}>
      <StatusLine state="aborted">{trouble.line}</StatusLine>
      {trouble.action && (
        <div className="ux-gh-trouble-action">
          <CBtn
            tone="strong"
            onClick={() =>
              // F16c: Sign in to GitHub names the account to sign in as.
              useSetup.getState().openSetup("rerun", "github", {
                githubAccount: trouble.action === GH_SIGN_IN_ACTION ? trouble.account : null,
              })
            }
          >
            {trouble.action}
          </CBtn>
        </div>
      )}
      {/* Errors this trouble doesn't explain stay as they are. */}
      {trouble.others.map((e) => (
        <StatusLine key={e} state="aborted">
          {e}
        </StatusLine>
      ))}
      <Details summary={GH_TROUBLE_DETAILS}>
        <pre className="ux-output">{trouble.details.join("\n")}</pre>
      </Details>
    </div>
  );
}
