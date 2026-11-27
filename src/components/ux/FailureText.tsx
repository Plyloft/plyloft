import { Details } from "./Page";
import { CBtn } from "../ui/primitives";
import type { Failure } from "../../lib/failure";
import { repairLabelFor } from "../../lib/cliNotStarting";
import { backendMarkTool, showBackendText } from "../../lib/backendMarks";
import { openRepair } from "../../lib/openRepair";

/** UX P-D2: a {@link Failure} where a line of text stood — its plain sentence,
 *  then the raw text under a closed `Details` (PRINCIPLES 2). Drawn inside the
 *  caller's own container (a block element, since `Details` is one), so the
 *  line keeps its place and its colour.
 *  1.176.0 R7: a failure whose cause is a Claude or Codex that doesn't start
 *  (the backend's typed mark, `lib/cliNotStarting`) loses the mark and gets
 *  Repair beside it. */
export function FailureText({ failure }: { failure: Failure }) {
  // 1.176.0 seams: any of the backend's marks (`lib/backendMarks`).
  const tool = backendMarkTool(failure.sentence) ?? backendMarkTool(failure.details);
  const sentence = showBackendText(failure.sentence);
  const details = showBackendText(failure.details);
  return (
    <>
      {sentence}
      {tool && (
        <>
          {" "}
          <CBtn size="sm" tone="quiet" onClick={() => void openRepair(tool)}>
            {repairLabelFor(tool)}
          </CBtn>
        </>
      )}
      {details && details !== sentence && (
        <Details>
          <pre className="ux-output">{details}</pre>
        </Details>
      )}
    </>
  );
}
