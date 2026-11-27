// QoL 1.168 G10 (Windows walk): the workspace colour's row says "(shared with
// everyone who opens this repository)" only where the repository shares; a
// search still lands on it as "Workspace colour" either way (`Row.findAs`).
import { describe, expect, it } from "vitest";
import { FoundRow, Row } from "../components/ux";
import { accentColorRowLabel, rowLabel } from "../lib/repositoryPage";
import { renderUi, screen } from "./render";

describe("a row found by other words than it draws", () => {
  for (const shared of [true, false]) {
    it(`lands on the workspace colour (${shared ? "shared" : "not shared"})`, () => {
      renderUi(
        <FoundRow token="Workspace colour" nonce={1} marked onArrived={() => {}} onMissing={() => {}}>
          <Row kind="choice" label={accentColorRowLabel(shared)} findAs={rowLabel("accentColor")} />
        </FoundRow>,
      );
      expect(screen.getByText(accentColorRowLabel(shared))).toBeTruthy();
      expect(screen.getByText("Found here")).toBeTruthy();
    });
  }
});
