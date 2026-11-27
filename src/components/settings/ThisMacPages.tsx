import { useEffect, useState } from "react";
import { CBtn, Details, Group, Row, RowValue, Section, Segmented, Select, Swatches, Toggle, TypeOrChoose } from "../ux";
import { useCheckedField } from "./CheckedField";
import { useSettings } from "../../store/settingsStore";
import { saveSidebarLayout } from "../../store/uiStore";
import { sidebarLayoutOf } from "../../lib/sidebarLayout";
import { ChoiceRow, ResetThisPage, SettingsPage, TextRow, ToggleRow } from "./rows";
import { useMacSettings, type MacSettings } from "./useMacSettings";
import { field } from "./fields";
import { HIDDEN_FILES_HINT } from "../../lib/hiddenFiles";
import { useDoctor } from "../../store/doctorStore";
import { shellIntegrationScript, type SnippetShell } from "../../ipc";
import { NotificationAccessRow } from "../NotificationAccessRow";
import { ProgramFoldersRow } from "./ProgramFoldersRow";
import type { Scope } from "../../lib/settingsNav";
import { shortcutKeys } from "../../lib/shortcuts";
import { tileShellChoices } from "../../lib/tileShell";
import { isWindows } from "../../lib/platform";

/**
 * UX language card 8 (GH #103; ADR 0004, BOARDS.md §2): the This Mac pages on
 * the `ux` layer. C9 (UX-9.3) merged the thin ones: Appearance holds Startup's
 * `Window` section, and Editor and terminals is the old Editor and Terminals &
 * shell. 1.174.0 (DS1): Notifications is a page of its own again.
 *
 * Every row here saves as it changes and says so with an Undo (PATTERNS.md
 * §5). The words are written for someone who is not a developer: the old
 * sections said `Default new-pane kind`, `External-write reload` and
 * `File-watcher enabled`, which name Ply's internals rather than what happens.
 */

type PageProps = { scope: Scope; hiddenNote?: string | null };

// ── Appearance ──────────────────────────────────────────────────────────

const ACCENTS = [
  { id: "violet", name: "Violet", value: "violet" },
  { id: "cyan", name: "Cyan", value: "cyan" },
  { id: "magenta", name: "Magenta", value: "magenta" },
  { id: "sunset", name: "Sunset", value: "sunset" },
];

const THEMES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "void", label: "Void" },
];

/** SP-7: the Theme row's hint says what the chosen theme does. */
const THEME_HINT: Record<string, string> = {
  system: "Light or dark, as macOS is.",
  light: "Stays light whatever macOS uses.",
  dark: "Stays dark whatever macOS uses.",
  void: "Dark on pure black, whatever macOS uses.",
};

export function AppearancePage({ scope, hiddenNote }: PageProps) {
  const mac = useMacSettings();
  const accent = field("appearance.accent");
  const chosen = String(mac.value(accent) ?? "violet");
  const theme = field("appearance.theme");
  const themeChosen = String(mac.value(theme) ?? "system");
  // GH #275: the sidebar ⌘\ hides, remembered in `windows.sidebar.collapsed`.
  const sidebarShown = !useSettings((s) => sidebarLayoutOf(s.settings.windows).collapsed);
  return (
    <SettingsPage entry="appearance" scope={scope} hiddenNote={hiddenNote}>
      <Section title="Theme" scope="this-mac">
        <Group>
          {/* GH #275: the board's segmented control — four short words.
              SP-7: the hint says what the chosen one does. */}
          <Row kind="choice" label="Theme" hint={THEME_HINT[themeChosen] ?? THEME_HINT.system}>
            <Segmented
              label="Theme"
              value={themeChosen}
              options={THEMES}
              onChange={(next) => void mac.set(theme, next)}
            />
          </Row>
          <Row
            kind="choice"
            label="Accent colour on this Mac"
            hint="Buttons, links and the focus ring, on this Mac."
          >
            <Swatches
              value={chosen}
              options={ACCENTS}
              name={ACCENTS.find((a) => a.id === chosen)?.name ?? "Violet"}
              onChange={(next) => void mac.set(accent, next)}
            />
          </Row>
        </Group>
      </Section>
      {/* QoL 1.168 (block 10, A7): the terminals read out loud. The text
          size of terminals and the editor is on Editor and terminals. */}
      <Section title="Accessibility" scope="this-mac">
        <Group>
          <ToggleRow
            mac={mac}
            field={field("appearance.screenReader")}
            label="Screen reader support"
            hint={isWindows() ? "The terminal you are typing in tells Narrator or NVDA what it prints, line by line; the others stay quiet. Leave it off otherwise: it makes a busy terminal slower." : "The terminal you are typing in tells VoiceOver what it prints, line by line; the others stay quiet. Leave it off otherwise: it makes a busy terminal slower."}
          />
        </Group>
      </Section>
      {/* UX-9.3: Startup's one row, under the board's `Window`. */}
      <Section title="Window" scope="this-mac">
        <Group>
          <ChoiceRow
            mac={mac}
            field={field("behavior.openOn")}
            label="Open on"
            hint="Where Plyloft opens, and where a workspace opens when you switch to it."
            options={[
              { value: "inbox", label: "Inbox" },
              { value: "board", label: "Board" },
              { value: "terminals", label: "Terminals" },
            ]}
          />
          <Row kind="toggle" label="Show the sidebar" hint={`${shortcutKeys("sidebar")} hides and shows it.`}>
            <Toggle
              checked={sidebarShown}
              onChange={(next) => {
                const current = sidebarLayoutOf(useSettings.getState().settings.windows);
                saveSidebarLayout({ ...current, collapsed: !next });
              }}
            />
          </Row>
          {/* QoL 1.168 S1-2: the quit sheet's "Don't ask again" for sessions. */}
          <ToggleRow
            mac={mac}
            field={field("behavior.confirmQuitWithWorkingSessions")}
            label="Ask before quitting while a session is working"
            hint="Quitting stops a Claude or Codex turn halfway. Unsaved files are always asked about."
          />
          {/* Windows (W4): the window's X and Alt+F4. The Mac's close always
              hides (hard rule 5), so it has no row. */}
          {isWindows() && (
            <ChoiceRow
              mac={mac}
              field={field("behavior.windowsCloseAction")}
              label="When I close the window"
              hint="Plyloft can keep running in the notification area, so sessions and builds go on, or quit completely."
              options={[
                { value: "ask", label: "Ask every time" },
                { value: "tray", label: "Keep running in the notification area" },
                { value: "quit", label: "Quit Plyloft" },
              ]}
            />
          )}
        </Group>
      </Section>
      <ResetThisPage
        mac={mac}
        page="appearance"
        hint={
          isWindows()
            ? "The theme, the accent colour, screen reader support, where a workspace opens, what closing the window does and the question before quitting go back to how Plyloft ships."
            : "The theme, the accent colour, screen reader support, where a workspace opens and the question before quitting go back to how Plyloft ships."
        }
      />
    </SettingsPage>
  );
}

// ── Editor and terminals ────────────────────────────────────────────────

export function EditorTerminalsPage({ scope, hiddenNote }: PageProps) {
  const mac = useMacSettings();
  const loginShell = useDoctor((s) => s.env?.shell ?? null);
  // QoL 1.168 (D3): Codex is offered once it is installed here (or already
  // chosen, so the row never reads blank).
  const codexHere = useDoctor((s) => Boolean(s.env?.codexPath));
  const refreshDoctor = useDoctor((s) => s.refresh);
  const blocks = mac.value(field("behavior.commandBlocksEnabled")) === true;

  return (
    <SettingsPage entry="editor-terminals" scope={scope} hiddenNote={hiddenNote}>
      <Section title="How a file reads" scope="this-mac">
        <Group>
          <TextRow
            mac={mac}
            field={field("editor.textSize")}
            label="Editor text size"
            hint={`In px, from 10 to 24; Plyloft ships 13. ${shortcutKeys("zoomIn")} and ${shortcutKeys("zoomOut")} in the editor change it too, ${shortcutKeys("zoomReset")} puts it back.`}
            inputMode="numeric"
          />
          <TextRow
            mac={mac}
            field={field("editor.tabSize")}
            label="Tab size"
            hint="How wide one indent is, in spaces."
            inputMode="numeric"
          />
          <ToggleRow
            mac={mac}
            field={field("editor.lineNumbers")}
            label="Line numbers"
            hint="Numbers down the left of the editor."
          />
          <ToggleRow
            mac={mac}
            field={field("editor.wordWrap")}
            label="Wrap long lines"
            hint="A long line folds instead of running off the side. Markdown always wraps; the editor's Wrap button overrides this for one file."
          />
          <ToggleRow
            mac={mac}
            field={field("editor.showHiddenFiles")}
            label="Show hidden files"
            hint={HIDDEN_FILES_HINT}
          />
        </Group>
      </Section>
      <Section title="When something else writes the file" scope="this-mac">
        <Group>
          <ToggleRow
            mac={mac}
            field={field("behavior.fileWatcherEnabled")}
            label="Watch files for changes"
            hint="Plyloft notices when an agent or another editor writes a file you have open."
          />
          <ChoiceRow
            mac={mac}
            field={field("behavior.externalWriteReloadStrategy")}
            label="When a file changes outside Plyloft"
            hint="What the editor does with a file that was rewritten under it."
            options={[
              { value: "promptIfDirty", label: "Ask only if you have unsaved changes" },
              { value: "alwaysPrompt", label: "Always ask" },
              { value: "alwaysReload", label: "Reload without asking" },
            ]}
          />
        </Group>
      </Section>
      <Section title="How a terminal reads" scope="this-mac">
        <Group>
          <TextRow
            mac={mac}
            field={field("terminals.textSize")}
            label="Terminal text size"
            hint={`In px, from 10 to 24; Plyloft ships 13. Every terminal follows it, open ones too. ${shortcutKeys("zoomIn")} and ${shortcutKeys("zoomOut")} in a terminal change it, ${shortcutKeys("zoomReset")} puts it back.`}
            inputMode="numeric"
          />
        </Group>
      </Section>
      <Section title="New tiles" scope="this-mac">
        <Group>
          <ChoiceRow
            mac={mac}
            field={field("terminals.defaultNewPaneKind")}
            label="What a new tile opens"
            hint={`${shortcutKeys("newShell")} opens this kind. ${shortcutKeys("newClaude")} always opens Claude, ${shortcutKeys("newCodex")} Codex. One that isn't installed here opens a shell.`}
            options={[
              { value: "shell", label: "A shell" },
              { value: "claude", label: "Claude" },
              ...(codexHere || mac.value(field("terminals.defaultNewPaneKind")) === "codex"
                ? [{ value: "codex", label: "Codex" }]
                : []),
            ]}
          />
          <TextRow
            mac={mac}
            field={field("terminals.scrollbackLines")}
            label="Scrollback"
            hint="How many lines of output a tile keeps, from 500 to 100,000. Open tiles take it too; lowering it trims what they already hold."
            inputMode="numeric"
          />
        </Group>
      </Section>
      <Section title="The shell they run" scope="this-mac">
        <TileShellGroup mac={mac} loginShell={loginShell} onSaved={() => void refreshDoctor()} />
        {/* 1.176.1: read on save and when the page opens, never per keystroke. */}
        <ProgramFoldersRow mac={mac} />
      </Section>
      <Section title="Command blocks" scope="this-mac">
        <Group>
          <ToggleRow
            mac={mac}
            field={field("behavior.commandBlocksEnabled")}
            label="Mark where each command starts and ends"
            hint={
              isWindows()
                ? "Plyloft can show a tile's output one command at a time, once your shell tells it where the boundaries are. Experimental: it needs a snippet in your own PowerShell profile (or .bashrc for Git Bash), shown here once this is on."
                : "Plyloft can show a tile's output one command at a time, once your shell tells it where the boundaries are. Experimental: it needs a snippet in your own .zshrc, .bashrc or PowerShell profile, shown here once this is on."
            }
          />
        </Group>
        {blocks && <ShellIntegrationSnippet />}
      </Section>
      <ResetThisPage
        mac={mac}
        page="editor-terminals"
        hint="The text sizes, tab size, line numbers, wrapping, the file watcher, what a new tile opens, the scrollback, the tile shell, the program folders and command blocks go back to how Plyloft ships."
      />
    </SettingsPage>
  );
}

/**
 * 1.176.1: Tile shell, read before it can stop every shell tile
 * (`setting_check::read_tile_shell`, on save and when the page opens): a
 * folder, a file that can't run, a name no program folder holds, `zsh -i`,
 * a variable or a relative path isn't saved as typed; a disk that isn't
 * connected or a program Plyloft doesn't know as a shell is asked first. The
 * dictation footnote stays as it was.
 */
export function TileShellGroup({
  mac,
  loginShell,
  onSaved,
}: {
  mac: MacSettings;
  loginShell: string | null;
  onSaved: () => void;
}) {
  const tileShell = field("shell.tileShell");
  const checked = useCheckedField({
    kind: "tileShell",
    committed: String(mac.value(tileShell) ?? ""),
    commit: async (value) => {
      const ok = await mac.set(tileShell, value);
      if (ok) onSaved();
      return ok;
    },
  });
  // The commit is the setting's write, read first.
  const setTileShell = checked.onCommit;
  return (
    <>
      <Group>
        <Row
          kind="text"
          label="Tile shell"
          hint={
            <>
              {/* Walk (1.176.1): one line, so JSX keeps the space before "shell". */}
              {`The program a new shell tile runs. Left empty it runs your ${isWindows() ? "default" : "login"} shell`}
              {loginShell ? <> (<span className="ux-mono-fg">{loginShell}</span>)</> : null}.
              {isWindows()
                ? " Dictation needs one that understands pasted text, such as PowerShell 7 (pwsh)."
                : " Dictation needs one that understands pasted text: zsh, fish, or bash 5.1 and later — macOS ships bash 3.2, which does not."}
            </>
          }
        >
          <TypeOrChoose
            id={checked.inputId}
            value={checked.draft}
            onChange={checked.setDraft}
            onCommit={(v) => setTileShell(v)}
            onCancel={checked.onCancel}
            options={TILE_SHELLS}
            defaultLabel={isWindows() ? "Your default shell" : "Your login shell"}
            footnote={isWindows() ? "Or type the path of any shell on this PC." : "Or type the path of any shell on this Mac."}
            label="Tile shell"
            placeholder={loginShell ?? (isWindows() ? "Your default shell" : "Your login shell")}
          />
          {checked.line && <RowValue>{checked.line}</RowValue>}
        </Row>
      </Group>
      {checked.notice}
    </>
  );
}

/** The shells Ply knows on this platform, offered under the caret; anything
 *  else can be typed. Saving it re-asks the doctor, whose `Dictation in shell
 *  tiles` row reads the saved value. */
const TILE_SHELLS = tileShellChoices();

// ── Notifications ───────────────────────────────────────────────────────

/** 1.174.0 (DS1, P29): Notifications is a page of its own again, under Look
 *  and feel — it was the last sections of Claude and Codex. Its `Reset this
 *  page` covers its two switches (`settingsFields.ts`). */
export function NotificationsPage({ scope, hiddenNote }: PageProps) {
  const mac = useMacSettings();
  return (
    <SettingsPage entry="notifications" scope={scope} hiddenNote={hiddenNote}>
      <NotificationsSections mac={mac} />
      <ResetThisPage
        mac={mac}
        page="notifications"
        hint="Both notifications go back to how Plyloft ships."
      />
    </SettingsPage>
  );
}

/** The two sections of Notifications: the switches, and whether the system
 *  lets a notification through. */
export function NotificationsSections({ mac }: { mac: MacSettings }) {
  return (
    <>
      <Section title="Notifications" scope="this-mac">
        <Group>
          <ToggleRow
            mac={mac}
            field={field("behavior.notifyOnAgentDone")}
            label="Tell me about my cards"
            hint="A notification when a card is ready to ship, needs a fix or shipped, while you're elsewhere."
          />
          <ToggleRow
            mac={mac}
            field={field("behavior.notifyOnSessionWaiting")}
            label="Tell me when a session is waiting for me"
            hint="A notification when a Claude or Codex session finishes its turn and waits for you in another workspace, or while Plyloft is in the background."
          />
        </Group>
      </Section>
      {/* QoL 1.168 (F4, D6): whether the system lets them through, and the
          one action that moves it on — Allow, its settings, or a test. */}
      <Section title="Is a notification getting through" scope="this-mac">
        <Group>
          <NotificationAccessRow />
        </Group>
      </Section>
    </>
  );
}

// ── The shell integration snippet ───────────────────────────────────────

/** The shells the snippet is written for, in the order offered: PowerShell
 *  first on Windows, where it is a tile's own shell; zsh first on the Mac. */
export function shellSnippetChoices(windows: boolean): { value: SnippetShell; label: string }[] {
  const zsh = { value: "zsh" as const, label: "zsh — ~/.zshrc" };
  const bash = { value: "bash" as const, label: windows ? "Git Bash — ~/.bashrc" : "bash — ~/.bashrc" };
  const pwsh = { value: "powershell" as const, label: "PowerShell — $PROFILE" };
  return windows ? [pwsh, bash] : [zsh, bash, pwsh];
}

/** Where the chosen shell's snippet goes, in the row's hint. The PowerShell
 *  one names the file's creation in the form that never empties a profile
 *  that is already there (`New-Item -Force` on an existing file does), and
 *  the two Windows PowerShell notes only on Windows. */
export function snippetWhereHint(shell: SnippetShell, windows: boolean): string {
  if (shell === "powershell") {
    const where =
      "Paste it at the end of the file PowerShell names when you type $PROFILE, then open a fresh tile. " +
      "The snippet's first lines say how to create that file if it isn't there yet.";
    if (!windows) return where;
    return (
      where +
      " PowerShell 7 and Windows PowerShell each have their own. If Windows PowerShell says " +
      "running scripts is disabled, run Set-ExecutionPolicy -Scope CurrentUser RemoteSigned in it once."
    );
  }
  return "Paste it at the end of the file, then open a fresh shell tile.";
}

function ShellIntegrationSnippet() {
  const choices = shellSnippetChoices(isWindows());
  const [which, setWhich] = useState<SnippetShell>(choices[0].value);
  const [script, setScript] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    setCopied(false);
    shellIntegrationScript(which)
      .then((s) => live && setScript(s))
      .catch(() => live && setScript("Plyloft couldn't read its own snippet."));
    return () => {
      live = false;
    };
  }, [which]);
  return (
    <>
      {/* The row stays out of Details: its body is set in mono for raw text. */}
      <Group>
        <Row
          kind="choice"
          label="Which shell"
          hint={snippetWhereHint(which, isWindows())}
          action={
            <CBtn
              disabled={!script}
              onClick={() => {
                navigator.clipboard
                  .writeText(script)
                  .then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 2000);
                  })
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </CBtn>
          }
        >
          <Select
            value={which}
            options={choices}
            onChange={(v) => setWhich(v as SnippetShell)}
          />
        </Row>
      </Group>
      <Details summary={isWindows() ? "The snippet to paste into your shell's profile" : "The snippet to paste into your shell's startup file"}>
        <pre className="ux-output">{script}</pre>
      </Details>
    </>
  );
}
