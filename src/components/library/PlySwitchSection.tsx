import { Group, Row, Section, Segmented, StatusLine, Toggle } from "../ux";
import type { PlyPlace, PlySkillChange, PlySkillSwitch } from "../../ipc";
import { PLY_WHERE_TITLE, plyChangeLines, plySwitchRows } from "../../lib/plySkillSwitch";
import { TeamMark } from "../ProMark";

/** The workspace row's three answers. */
export type WorkspaceChoice = "follow" | "on" | "off";

/**
 * Skills hub H9 (R9; mockup 7): a Plyloft skill's versions and **Where it's
 * on** — this workspace's choice, the team default, this Mac's switch, each
 * with the sentence that says what it does and who decides. Everything said
 * is `lib/plySkillSwitch.ts`'s; this file draws.
 */
export function PlyVersionLines({ changes }: { changes: readonly PlySkillChange[] | undefined }) {
  const lines = plyChangeLines(changes);
  if (!lines.latest) return null;
  return (
    <>
      <StatusLine state="empty">{lines.latest}</StatusLine>
      {lines.earlier && <StatusLine state="empty">{lines.earlier}</StatusLine>}
    </>
  );
}

export function PlySwitchSection({
  name,
  sw,
  place,
  busy,
  onWorkspace,
  onTeam,
  onMac,
}: {
  name: string;
  sw: PlySkillSwitch;
  place: PlyPlace;
  busy: boolean;
  onWorkspace: (choice: WorkspaceChoice) => void;
  /** `off`: the team switches it off; `false`: back to no team choice. */
  onTeam: (off: boolean) => void;
  onMac: (on: boolean) => void;
}) {
  const rows = plySwitchRows(name, sw, place);
  return (
    <Section title={PLY_WHERE_TITLE} count={rows.count}>
      <StatusLine state="empty">{rows.note}</StatusLine>
      <Group label={PLY_WHERE_TITLE}>
        <Row kind="choice" label={rows.workspace.label} hint={rows.workspace.hint} disabled={rows.workspace.disabled || busy}>
          <Segmented<WorkspaceChoice>
            value={rows.workspace.choice}
            onChange={onWorkspace}
            label={rows.workspace.label}
            options={[
              { value: "follow", label: "Follow", disabled: rows.workspace.disabled || busy },
              { value: "on", label: "On", disabled: rows.workspace.disabled || busy },
              { value: "off", label: "Off", disabled: rows.workspace.disabled || busy },
            ]}
          />
        </Row>
        {rows.team && (
          <Row
            kind="toggle"
            label={
              <>
                {rows.team.label} <TeamMark />
              </>
            }
            hint={rows.team.hint}
          >
            {/* A member's press is answered with who decides (R9 edge): the
                switch stays live, and the owner-only words come back. */}
            <Toggle checked={!rows.team.off} disabled={busy} onChange={(on) => onTeam(!on)} />
          </Row>
        )}
        <Row kind="toggle" label={rows.mac.label} hint={rows.mac.hint}>
          <Toggle checked={rows.mac.on} onChange={onMac} />
        </Row>
      </Group>
    </Section>
  );
}
