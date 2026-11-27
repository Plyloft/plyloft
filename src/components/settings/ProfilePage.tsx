import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { CBtn, Details, Group, Row, RowValue, Section, StatusLine } from "../ux";
import { SettingsPage } from "./rows";
import { useSettings } from "../../store/settingsStore";
import { useSetup } from "../../store/setupStore";
import { useUi } from "../../store/uiStore";
import type { Scope } from "../../lib/settingsNav";
import { updateFlow, useUpdateState, useUpdateWait } from "../UpdatePrompt";
import type { UpdateState } from "../../lib/updateFlow";
import { checkForUpdates } from "../tutorial/HelpMenu";

/**
 * UX language card 8 (GH #103): Settings › Account › Profile, on the `ux`
 * layer. Who Ply says you are on the records you share. The Plyloft account
 * (sign-in, plan, Sign out) is Account › Plan since launch A3.
 *
 * Read-only here: the identity comes from `git config --global user.email`,
 * read at startup (`lib.rs::setup`) and stamped as author on every shared
 * record. OB-6 (spec C4): Setup's Git step writes the global name and email
 * after its consent sheet and updates this at once, so the row's action
 * opens Setup there; nothing on this page writes git's configuration.
 */
export function ProfilePage({
  scope,
  hiddenNote,
}: {
  scope: Scope;
  hiddenNote?: string | null;
}) {
  const email = useSettings((s) => s.settings.identity?.userEmail ?? null);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getVersion()
      .then((v) => live && setVersion(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return (
    <SettingsPage
      entry="profile-licence"
      scope={scope}
      hiddenNote={hiddenNote}
      lede="Who Plyloft says you are on everything you share: the author of a card, a note, a skill, a published setting."
      status={
        email ? (
          <StatusLine state="done">
            Everything you share is stamped <span className="ux-mono-fg">{email}</span>.
          </StatusLine>
        ) : (
          <StatusLine state="aborted">
            Plyloft has no name for you, so nothing you share can say who made it.
          </StatusLine>
        )
      }
    >
      <Section title="You" scope="this-mac">
        <Group>
          <Row
            kind="value"
            label="Git identity"
            readOnly
            hint={
              email
                ? "Read from your git configuration. Setup's Git and your name step changes it, and asks before it saves."
                : "Nothing is set. Setup's Git and your name step sets it, and asks before it saves."
            }
            action={
              <CBtn onClick={() => useSetup.getState().openSetup("rerun", "git")}>
                {email ? "Change" : "Set"}
              </CBtn>
            }
          >
            <RowValue mono>{email ?? "not set"}</RowValue>
          </Row>
        </Group>
      </Section>

      <Section title="This copy of Plyloft" scope="this-mac">
        <Group>
          <Row kind="value" label="Plyloft" readOnly hint="One AI builds. The other reviews.">
            <RowValue mono>{version ? `v${version}` : "—"}</RowValue>
          </Row>
          {/* QoL 1.168 S3: Check for updates, beside the version. */}
          <UpdatesRow />
          <Row
            kind="value"
            label="Trademarks"
            readOnly
            hint="Claude and Claude Code are trademarks of Anthropic, PBC; ChatGPT and Codex are trademarks of OpenAI; GitHub is a trademark of GitHub, Inc.; Git is a trademark of Software Freedom Conservancy. Plyloft is not affiliated with or endorsed by them."
          />
        </Group>
        <Details summary="Details">
          <pre className="ux-output">
            {[
              `identity: ${email ?? "(not set)"}`,
              `version: ${version ?? "(not read yet)"}`,
              "identity source: git config --global user.email, read at startup and when Setup saves it",
            ].join("\n")}
          </pre>
        </Details>
      </Section>
    </SettingsPage>
  );
}

/** What the update flow says now, in the row's value — never more than it
 *  knows: "available" until the bytes are here, nothing about a look that
 *  never answered. */
export function updateValue(
  state: UpdateState,
  facts: { downloaded: string | null; lastLooked: { ok: boolean } | null },
): string {
  switch (state.kind) {
    case "available":
    case "confirming":
      return facts.downloaded === state.version
        ? `${state.version} is downloaded`
        : `${state.version} is available`;
    case "ready":
      return `${state.version} is downloaded`;
    case "scheduled":
      return `${state.version} installs when your work is done`;
    case "looking":
    case "checking":
      return "Checking…";
    case "downloading":
      return `Downloading ${state.version}`;
    case "installing":
    case "relaunching":
      return `Installing ${state.version}`;
    case "upToDate":
      return "Up to date";
    case "failed":
      return state.version ? `${state.version} wasn't installed` : "Couldn't check";
    case "idle":
      if (!facts.lastLooked) return "Not checked yet";
      return facts.lastLooked.ok ? "Up to date" : "Couldn't check";
  }
}

export function UpdatesRow() {
  const state = useUpdateState();
  // 1.176.4 (owner): a scheduled update says what it waits for, as the
  // sidebar's row does; its press leaves Settings for the session.
  const wait = useUpdateWait();
  const busy = ["looking", "checking", "downloading", "installing", "relaunching"].includes(state.kind);
  return (
    <Row
      kind="value"
      label="Updates"
      readOnly
      hint={
        wait ? (
          <>
            {wait.line}
            {wait.open && (
              <>
                {" "}
                <CBtn
                  aria-label={wait.open.ariaLabel}
                  onClick={() => {
                    useUi.getState().setSettingsOverlayOpen(false);
                    wait.open?.onClick();
                  }}
                >
                  {wait.open.label}
                </CBtn>
              </>
            )}
          </>
        ) : (
          "Plyloft looks for a new version when it opens and every 30 minutes while it runs."
        )
      }
      action={
        <CBtn disabled={busy} onClick={checkForUpdates}>
          Check for updates
        </CBtn>
      }
    >
      <RowValue>
        {updateValue(state, { downloaded: updateFlow().downloadedVersion, lastLooked: updateFlow().lastLooked })}
      </RowValue>
    </Row>
  );
}
