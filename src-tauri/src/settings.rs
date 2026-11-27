use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const SETTINGS_FILE: &str = "settings.json";
const CURRENT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThemePref {
    System,
    Light,
    Dark,
    /// v0.6.0: pure-black OLED-friendly with cyan accent.
    Void,
    /// v0.6.0 LEGACY — retired in v1.64.0 (themes 5→3, UX revamp step 0).
    /// Kept deserializable so an old settings.json never fails parse (a
    /// serde error here would make `SettingsStore::new` fall back to
    /// defaults and silently reset the user's ENTIRE settings file).
    /// `AppearanceSettings::normalize` maps it to `Dark` + `Cyan` at load;
    /// it is never persisted again.
    NeonTokyo,
    /// v0.6.0 LEGACY — see `NeonTokyo`. Maps to `Dark` + `Sunset` at load.
    Synthwave,
}

impl Default for ThemePref {
    fn default() -> Self {
        Self::System
    }
}

/// v1.64.0 (UX revamp step 0): accent preset applied on top of the theme.
/// `Violet` = no override — each theme keeps its own designed accent
/// (violet on light/dark, cyan on void). The frontend mirrors this as a
/// `data-accent` attribute; only `--claude-accent` retints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccentPreset {
    Violet,
    Cyan,
    Magenta,
    Sunset,
}

impl Default for AccentPreset {
    fn default() -> Self {
        Self::Violet
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PaneKind {
    Shell,
    Claude,
}

impl Default for PaneKind {
    fn default() -> Self {
        Self::Shell
    }
}

/// QoL 1.168 (D3): what ⌘T opens, Codex included. Kept beside
/// [`PaneKind`], which 1.167 and earlier read strictly: a `codex` there would
/// make an older Plyloft set the whole file aside.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NewTileKind {
    Shell,
    Claude,
    Codex,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReloadStrategy {
    PromptIfDirty,
    AlwaysPrompt,
    AlwaysReload,
}

impl Default for ReloadStrategy {
    fn default() -> Self {
        Self::PromptIfDirty
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppearanceSettings {
    pub theme: ThemePref,
    /// v1.64.0: see [`AccentPreset`]. Missing in pre-1.64 files → Violet.
    pub accent: AccentPreset,
    /// QoL 1.168 (block 10, A7): Appearance › Screen reader support — the
    /// terminals' xterm `screenReaderMode`. Absent (1.167 and earlier, or
    /// never touched) = off; an unknown value reads as absent.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub screen_reader: Option<bool>,
}

impl AppearanceSettings {
    /// v1.64.0 one-way fold of the two retired v0.6.0 themes into
    /// theme + accent. Runs on every load and replace, so the legacy
    /// variants can never re-enter persisted state.
    pub fn normalize(&mut self) {
        match self.theme {
            ThemePref::NeonTokyo => {
                self.theme = ThemePref::Dark;
                self.accent = AccentPreset::Cyan;
            }
            ThemePref::Synthwave => {
                self.theme = ThemePref::Dark;
                self.accent = AccentPreset::Sunset;
            }
            _ => {}
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TerminalSettings {
    /// What an older Plyloft reads: "shell" or "claude". An unknown value
    /// falls back to a shell rather than failing the file.
    #[serde(deserialize_with = "lenient")]
    pub default_new_pane_kind: PaneKind,
    /// QoL 1.168 (D3): set only when the choice is Codex; absent, the field
    /// above says. An unknown value reads as absent.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub new_tile_kind: Option<NewTileKind>,
    pub scrollback_lines: u32,
    /// QoL 1.168 (block 10, A7): Settings › Text size of the terminals, in
    /// px (the app reads 10–24). Absent (1.167 and earlier, or never
    /// changed) = the shipped 13; an unknown value reads as absent.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub text_size: Option<u32>,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            default_new_pane_kind: PaneKind::default(),
            new_tile_kind: None,
            scrollback_lines: 5000,
            text_size: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ShellSettings {
    pub path_override: Option<String>,
    /// GH #68: the program new shell tiles run. `None` (or blank) runs the
    /// login shell (`$SHELL`), as before the field existed. Dictation in a
    /// shell tile needs a line editor with bracketed paste, which macOS
    /// `/bin/bash` 3.2 lacks, so a user whose login shell is that bash picks
    /// zsh or a newer bash here without changing their login shell.
    pub tile_shell: Option<String>,
}

impl ShellSettings {
    /// The configured tile shell, or `None` for the login shell.
    pub fn tile_shell(&self) -> Option<&str> {
        self.tile_shell
            .as_deref()
            .map(str::trim)
            .filter(|shell| !shell.is_empty())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OnboardingSettings {
    /// v1.32.0: ISO-8601 timestamp at which the guided first-run welcome
    /// screen was completed or skipped. `None` = the user has never gotten
    /// past first run, so the welcome screen still shows. For existing
    /// installs upgrading into v1.32.0, `lib.rs::setup` backfills this to
    /// "now" when workspaces already exist — an established user must not be
    /// shown a first-run screen.
    pub first_run_completed_at: Option<String>,
    /// Onboarding (ONBOARDING_SPEC §8.1): which guided Setup this Mac has
    /// seen. `None` = never saw it, so it opens once over the shell —
    /// existing users included (D1). Setup stamps [`SETUP_VERSION`]. Left out
    /// of the file while unset, so an untouched file reads as before.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub setup_version: Option<u32>,
    /// How Setup explains things: step by step or just the essentials.
    /// `None` = not asked yet. An unknown value reads as not asked.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub level: Option<SetupLevel>,
    /// The step Setup was on when it last closed, by id ([`SETUP_STEP_IDS`]).
    /// The resume point. An id a later release dropped is ignored by the
    /// reader, never an error here.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub current_step: Option<String>,
    /// Steps the person skipped, by id → ISO time. Facts are never stored:
    /// "done" is detected each time.
    #[serde(
        default,
        skip_serializing_if = "BTreeMap::is_empty",
        deserialize_with = "lenient"
    )]
    pub skipped: BTreeMap<String, String>,
    /// 1.175.0 F1: the person said yes, in Setup's one "Connect GitHub"
    /// sheet, to letting Git use the GitHub command's sign-in while Git was
    /// not installed yet. The Git step does it once Git is there, with no
    /// second question, and clears this. Kept in the file so a Setup closed
    /// between the two steps still knows. F1 round 2: written only once the
    /// sign-in has succeeded (or at the press when an account was already
    /// signed in) — an expired code, a stopped or failed sign-in, or a Setup
    /// closed before it finished keep nothing. `false` (and left out of the
    /// file) when no such yes is waiting; a value that isn't a bool reads as
    /// `false` — a consent is never read out of a damaged value.
    #[serde(default, skip_serializing_if = "is_false", deserialize_with = "lenient")]
    pub git_helper_consented: bool,
    /// The optional guided first card (§14). A malformed record reads as
    /// none rather than failing the whole file.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub first_card: Option<FirstCardGuide>,
    /// Getting started (TUTORIAL_SPEC §8.1): the tour's progress on this
    /// Mac. `None` = nothing recorded yet. A record does not mean a tour was
    /// started — the tips switch alone makes one — `startedAt` (full) or
    /// `path` says that. Left out of the file while unset, so a pre-tutorial
    /// file saves back as it was.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub tutorial: Option<TutorialProgress>,
    /// 1.175.0 (F4, UX-4): the tour's question at its end — how the Builder
    /// works on the next cards — was answered or closed. "Use this" also
    /// wrote `behavior.builderPermissions`; "Keep this" only this. `false`
    /// (and left out of the file) while it wasn't; a value that isn't a
    /// bool reads as `false`.
    #[serde(default, skip_serializing_if = "is_false", deserialize_with = "lenient")]
    pub builder_permissions_asked: bool,
}

impl OnboardingSettings {
    /// v1.32.0's startup backfill of `first_run_completed_at`: an install
    /// that already has workspaces is not a first run. Except (OB-4 review)
    /// a first run already under way in Setup — a `level` or a `current_step`
    /// set — which keeps its first-run header across a relaunch even after it
    /// added its first project.
    pub fn needs_first_run_backfill(&self, has_workspaces: bool) -> bool {
        self.first_run_completed_at.is_none()
            && has_workspaces
            && self.level.is_none()
            && self.current_step.is_none()
    }
}

/// Onboarding: the Setup this build ships. `OnboardingSettings::setup_version`
/// below it (or absent) opens Setup once.
#[allow(dead_code)] // state for the Setup cards (OB-4, OB-12); tested here
///
/// 2 (launch A2): the "Plyloft account" step after Welcome. 1.178.0 (A3): the
/// step is optional ("Only for teams") and nothing waits for an account, so
/// a Mac that saw Setup 1 is not shown Setup again for it: the frontend stamps
/// it as it does for an account already signed in. The number stays 2.
pub const SETUP_VERSION: u32 = 2;

/// Onboarding: Setup's step ids, stable forever (like template ids). Stored
/// in `currentStep` and as `skipped` keys; a reader ignores any other id.
///
/// The ids never change; their **order** is Setup's and did in 1.175.0 (F1):
/// `github` moved from after `git` to right after `account`, so the two
/// GitHub sign-ins follow each other. A `currentStep` written by 1.174.5
/// names a step by id, so it reopens on that step wherever it now stands.
#[allow(dead_code)] // state for the Setup cards (OB-4, OB-12); tested here
pub const SETUP_STEP_IDS: [&str; 11] = [
    "welcome", "account", "github", "mode", "ai", "git", "team", "folder", "project", "config", "ready",
];

/// Onboarding: how Setup explains things. `"guided"` | `"fast"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SetupLevel {
    /// Step by step.
    Guided,
    /// Just the essentials.
    Fast,
}

/// Onboarding §14: the optional guided first card, while it runs and after.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstCardGuide {
    pub workspace_id: String,
    pub card_id: String,
    pub started_at: String,
    /// When it finished or was dismissed.
    #[serde(default)]
    pub ended_at: Option<String>,
    /// `"shipped"` | `"dismissed"`.
    #[serde(default)]
    pub outcome: Option<String>,
}

/// Getting started (TUTORIAL_SPEC §8.1): the tour, per Mac, never synced.
///
/// Each field is lenient on its own: a wrong type, a time that is not
/// ISO-8601 or an unknown `path` reads as unset, and the rest of the record
/// (and of the file) still loads. `done` and `skipped` keep step ids this
/// build does not know, so a newer app's steps survive an older app's save.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TutorialProgress {
    /// When the full tour was started.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_iso"
    )]
    pub started_at: Option<String>,
    /// The app version the full tour was first started on (§12.2: *New in
    /// this version* lists only steps newer than it). Set once; Start over
    /// keeps it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub started_version: Option<String>,
    /// Which tour was last started.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub path: Option<TutorialPath>,
    /// The tour workspace.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub workspace_id: Option<String>,
    /// The tour card (`tourCardId`, step B3).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub card_id: Option<String>,
    /// Steps done, by id → ISO time.
    #[serde(
        default,
        skip_serializing_if = "BTreeMap::is_empty",
        deserialize_with = "lenient_iso_map"
    )]
    pub done: BTreeMap<String, String>,
    /// Steps skipped, by id → ISO time.
    #[serde(
        default,
        skip_serializing_if = "BTreeMap::is_empty",
        deserialize_with = "lenient_iso_map"
    )]
    pub skipped: BTreeMap<String, String>,
    /// The panel is collapsed to the pill.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub paused: Option<bool>,
    /// When *End the tour* was pressed.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_iso"
    )]
    pub ended_at: Option<String>,
    /// The last version whose New-in steps were seen.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub seen_version: Option<String>,
    /// First-visit tips. `None` = the Setup level's default.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub tips: Option<bool>,
    /// Sections whose first-visit tip was already shown.
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        deserialize_with = "lenient_strings"
    )]
    pub seen_sections: Vec<String>,
    /// Keys a later app writes in the tour's record, kept as they are when
    /// this build saves (the `team.json` member pattern, Skills hub §5.6): a
    /// newer app's new tour field survives an older app's save, as its step
    /// ids do. Never read here.
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Getting started: the full tour or the 1-minute one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TutorialPath {
    Full,
    Quick,
}

/// An ISO-8601 (RFC 3339) time, as `Date.toISOString()` writes it.
fn is_iso_time(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

/// TUTORIAL_SPEC §8.1: an optional time; anything but an ISO string is unset.
fn lenient_iso<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value.as_str().filter(|s| is_iso_time(s)).map(str::to_string))
}

/// TUTORIAL_SPEC §8.1: step id → ISO time. Every id is kept, known or not;
/// only an entry whose time is not an ISO string is dropped, and a value
/// that is not an object reads as empty.
fn lenient_iso_map<'de, D>(deserializer: D) -> Result<BTreeMap<String, String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    let serde_json::Value::Object(map) = value else {
        return Ok(BTreeMap::new());
    };
    Ok(map
        .into_iter()
        .filter_map(|(id, at)| match at {
            serde_json::Value::String(at) if is_iso_time(&at) => Some((id, at)),
            _ => None,
        })
        .collect())
}

/// A list of strings; anything else in it is dropped, and a value that is
/// not a list reads as empty.
fn lenient_strings<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    let serde_json::Value::Array(items) = value else {
        return Ok(Vec::new());
    };
    Ok(items
        .into_iter()
        .filter_map(|item| match item {
            serde_json::Value::String(s) => Some(s),
            _ => None,
        })
        .collect())
}

/// Onboarding §8.2 (D9): where new and cloned projects go, in tilde form.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ProjectsSettings {
    /// Tilde form (`~/Projects`), never an expanded path — the same reason as
    /// `TeamSettings::clone_root`. `None` = not chosen; callers use
    /// [`DEFAULT_PROJECTS_FOLDER`] (D9). Left out of the file while unset.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub folder: Option<String>,
}

/// 1.173.0 (C2): this computer, as a card's claim marker names it. `id` is
/// a uuid made once on this computer; `name` its ComputerName (Mac) or
/// `%COMPUTERNAME%` (Windows), read again so a rename shows. Local only,
/// backend-owned ([`SettingsStore::ensure_device`]); left out while unset.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct DeviceSettings {
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient_opt")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient_opt")]
    pub name: Option<String>,
    /// Challenger 8: the hashed hardware fingerprint the id was made on
    /// (`device_claim::read_hardware_id`); a different one (Migration
    /// Assistant, a restored backup) makes a new id.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient_opt")]
    pub hardware: Option<String>,
}

/// 1.174.0 (A4): Next improvement's slate on this computer, per area of a
/// workspace (`<workspaceId>::<area>`, the section's key). Written by the
/// frontend; local only, never shared. Absent in every earlier settings.json
/// → empty, and left out of the file while empty.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct NextImprovementSettings {
    /// One entry per area. An entry that can't be read is dropped on its own,
    /// never the whole file (`lenient_slate_views`).
    #[serde(
        default,
        skip_serializing_if = "BTreeMap::is_empty",
        deserialize_with = "lenient_slate_views"
    )]
    pub view: BTreeMap<String, NiSlateView>,
    /// 1.174.0 (A6, D2c): when this person's first card shipped on this Mac
    /// (ISO-8601). Written by the frontend (`firstShipWatch`) at the first
    /// ship, and at start from the Boards already read, so people who shipped
    /// before 1.174 keep Next improvement. Absent in every earlier file →
    /// none; a value that isn't an ISO time is none (`lenient_iso`).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_iso"
    )]
    pub first_card_shipped_at: Option<String>,
    /// 1.174.0 (A6 round 1): when the tour's base chapter was first found
    /// finished or fully skipped (ISO-8601), recorded once by the frontend so
    /// *Take the tour again* or Start over never hides Next improvement. Same
    /// rules as `first_card_shipped_at`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_iso"
    )]
    pub opens_since: Option<String>,
}

/// How an area's slate opens: the round already seen once (it then opens
/// folded), and the person's own Collapse / Show for that round.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct NiSlateView {
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient_opt")]
    pub seen_round: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient_opt")]
    pub collapsed: Option<bool>,
}

fn lenient_slate_views<'de, D>(deserializer: D) -> Result<BTreeMap<String, NiSlateView>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    let serde_json::Value::Object(map) = value else {
        return Ok(BTreeMap::new());
    };
    Ok(map
        .into_iter()
        .filter_map(|(k, v)| serde_json::from_value::<NiSlateView>(v).ok().map(|view| (k, view)))
        .collect())
}

/// The device name to keep: the one read, else the one kept, else a word.
pub(crate) fn device_name_or(read: &str, kept: Option<&str>) -> String {
    let read = crate::device_claim::clean_name(read);
    if !read.is_empty() {
        return read;
    }
    kept.map(crate::device_claim::clean_name)
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| if cfg!(windows) { "PC".to_string() } else { "Mac".to_string() })
}

/// D9: the projects folder Setup always suggests, on macOS and Windows alike
/// (`~` is `%USERPROFILE%` there). `~/code` is used only when picked.
#[allow(dead_code)] // state for the Setup cards (OB-4, OB-12); tested here
pub const DEFAULT_PROJECTS_FOLDER: &str = "~/Projects";

impl ProjectsSettings {
    /// The chosen folder (trimmed), or `None` when nothing usable is stored.
    pub fn chosen(&self) -> Option<&str> {
        self.folder
            .as_deref()
            .map(str::trim)
            .filter(|folder| !folder.is_empty())
    }

    /// The folder new projects go in, tilde form: the choice, else D9's
    /// `~/Projects`.
    #[allow(dead_code)] // state for the Setup cards (OB-4, OB-12); tested here
    pub fn folder_or_default(&self) -> &str {
        self.chosen().unwrap_or(DEFAULT_PROJECTS_FOLDER)
    }
}

/// Onboarding §8.3: whether team surfaces are shown. `"solo"` | `"team"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkMode {
    Solo,
    Team,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct IdentitySettings {
    /// v1.49.0 (Team Mode Phase 0): cached `git config --global user.email`.
    /// Attached as `author` / `lastEditedBy` on every write to shared-library
    /// stores (prompts, swarm templates, user templates, agents, kanban
    /// cards) so a second developer's edits are distinguishable from the
    /// owner's. `None` until backfilled by `lib.rs::setup` at app startup
    /// (or if git is missing / no global email is configured).
    pub user_email: Option<String>,
}

/// v1.114.0 (team sharing rung 1): the per-machine team settings.
/// The team itself lives in the team repo — named by `team_repo` (onboarding,
/// team free during the beta) or else by the license key; see [`crate::team`]
/// and ADR 0002 — so nothing about *who* is in the team is persisted here.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TeamSettings {
    /// Where picked team workspaces are cloned. `None` means the projects
    /// folder, else its default [`crate::team::default_clone_root`]
    /// (`~/Projects`; `~/code` while team checkouts are already there,
    /// [`crate::team::effective_clone_root`]) — stored as `None`
    /// rather than an expanded path so the default follows the home
    /// directory instead of freezing one machine's path into settings.
    pub clone_root: Option<String>,
    /// v1.118.0 (rung 5): repositories the owner has dismissed from
    /// assisted discovery, as `owner/name`.
    ///
    /// Persisted because "ignore" has to mean it: a scan re-runs whenever
    /// the owner presses the button, and a dismissal that lasted only until
    /// the next press would put the same repositories back in front of them
    /// forever. It is a per-machine preference, not part of the team — the
    /// team is the manifest in the team repo, and a repo one owner is not
    /// interested in is not a fact about the team.
    #[serde(default)]
    pub ignored_repos: Vec<String>,
    /// Onboarding §8.3: solo | team, as chosen in Setup or Settings. `None` =
    /// derived by [`crate::team::effective_work_mode`] from the team signals
    /// on this Mac — so an existing member with a key is `team` with no
    /// write. An unknown value reads as not chosen.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub work_mode: Option<WorkMode>,
    /// Onboarding §8.3/§11: the team this Mac is in, `owner/name`, when
    /// joined or created without a key (team is free during the beta). A
    /// key's `teamRepo` is used while this is `None`
    /// ([`crate::team::current_team_repo`]).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub team_repo: Option<String>,
    /// Onboarding §8.3: the GitHub login used for the team repo when several
    /// are signed in. `None` = gh's active account.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub account: Option<String>,
}

/// GH #81: adoption of the shared workspace definition, per Mac.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct SharingSettings {
    /// Repositories (`owner/name`, lowercase) whose "Share this workspace's
    /// setup?" question was answered "Not on this Mac". Per Mac, never in
    /// the repository: the next person who opens the repo is asked too.
    pub not_on_this_mac: Vec<String>,
    /// Onboarding §11 (OB-8, owner decision "ask first"): repositories
    /// (`owner/name`, lowercase) whose board this Mac was told to move to
    /// GitHub Issues — the one-press offer answered "Move to GitHub Issues",
    /// Share, or GitHub Issues chosen by hand. While teams are free and no key
    /// unlocks the board, only these switch or migrate cards on their own.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub github_board_moved: Vec<String>,
    /// The same offer answered "Keep it on this Mac": not offered again.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub github_board_kept_local: Vec<String>,
}

/// UX language card 1: sizes of resizable surfaces, remembered on this Mac.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowSizes {
    /// The Settings modal, in CSS pixels. `None` = the default size
    /// (1100 × 800, clamped to the window).
    pub settings: Option<SurfaceSize>,
    /// UX-9.4: the Settings page open when the modal last closed, by its
    /// navigation id, so ⌘, reopens there. `None` = Appearance. The frontend
    /// maps an id it no longer knows (a page merged away) to the page that
    /// holds it, so any string is safe to keep. Left out of the file while
    /// unset, like the sidebar layout, so an untouched file reads as before.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings_page: Option<String>,
    /// UX-3.4: the sidebar's width (200–320 CSS px) and whether ⌘\ hid it.
    /// `None` = never touched: 240 px, shown. Left out of the file while
    /// untouched, so a file that never used it reads as it always did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidebar: Option<SidebarLayout>,
}

/// UX-3.4: the shell's sidebar, remembered on this Mac.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SidebarLayout {
    pub width: u32,
    #[serde(default)]
    pub collapsed: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceSize {
    pub width: u32,
    pub height: u32,
}

/// GH #100 (BOARDS.md §4, ADR 0005): one duplicate notice `Keep both` silenced.
///
/// ADR 0005: "A duplicate skill has no winner; its notice can be silenced **per
/// Mac** until either copy changes." Per Mac is why it lives here and not in
/// `.atelier/workspace.json`: the same two copies are the same fact for every
/// member of the repository, and one member having read the comparison is not.
/// It must never travel on the shared channel.
///
/// "Until either copy changes" is why the two content ids are stored with the
/// pair rather than a bare flag: the record matches only while both copies still
/// hash to what they hashed to when the button was pressed, so an edit to either
/// one brings the notice back with no expiry date to keep.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct SilencedDuplicate {
    /// The two scopes, sorted and joined with `|` (`repository|team`), so the
    /// pair has one key whichever side it was silenced from.
    pub scopes: String,
    /// The skill's directory name, which is the name both copies carry.
    pub name: String,
    /// The content id of each copy, in the same order as `scopes`.
    pub contents: Vec<String>,
}

/// GH #100: what the Library remembers on this Mac.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct LibrarySettings {
    /// Duplicate notices `Keep both` silenced here. Grows by one per pressed
    /// button and is replaced in place for a pair already in it, so a skill
    /// edited and silenced ten times holds one record, not ten.
    pub silenced_duplicates: Vec<SilencedDuplicate>,
    /// GH #106 (ADR 0005, BOARDS.md §3 `Comes with Ply`): the skills that ship
    /// inside the app and are switched **off** on this Mac, by directory name.
    ///
    /// Off rather than on, and that is the whole of the migration. Every Ply
    /// skill is on by default, so a `settings.json` written before this card —
    /// and a fresh one — carries an absent list, which is no skill switched off.
    /// It also means an app update that ships a *new* Ply skill arrives switched
    /// on without a settings write, and a name no build ships any more is a
    /// stale entry that decides nothing rather than a skill gone missing.
    ///
    /// Per Mac: ADR 0005 says these are switched on or off per Mac, so this
    /// belongs here and must never travel on the shared channel.
    #[serde(default)]
    pub ply_skills_off: Vec<String>,
    /// Skills hub H10 (R6, §5.3): this Mac's **My library** — the member's own
    /// private GitHub repository of skills, cloned at
    /// `<config_dir>/my-library/<owner>__<name>/` and delivered to sessions as
    /// the plugin `mine`. `None` (and absent from files written before H10):
    /// this Mac uses none. Per Mac: a second Mac opts in with *Use it on this
    /// Mac*. Backend-owned ([`SettingsStore::set_my_library`]); a frontend save
    /// keeps what is stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub my_library: Option<MyLibrarySettings>,
}

/// Skills hub H10 (§5.3): `{ repo: "matteo/plyloft-skills", account: "matteo" }`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct MyLibrarySettings {
    /// `owner/name` on GitHub.
    pub repo: String,
    /// (Challenger) The gh login that owns the repository: every pull,
    /// publish and `gh` call of My library runs in this account's scope, so a
    /// Mac whose active gh account is another login still reaches it. `None`
    /// (a file from before the field): gh's active account.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EditorSettings {
    pub tab_size: u32,
    pub line_numbers: bool,
    pub word_wrap: bool,
    /// QoL 6.1 (owner D12): Code's tree and Go to file (⌘P) list hidden
    /// files (`.env`, `.github/`…) too. Off by default, and absent (a file
    /// from before 1.168.0) is off. `.git` and `.DS_Store` are never shown.
    pub show_hidden_files: bool,
    /// QoL 1.168 (block 10, A7): Settings › Text size of the editor, in px
    /// (the app reads 10–24). Absent = the shipped 13; an unknown value
    /// reads as absent.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub text_size: Option<u32>,
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            tab_size: 2,
            line_numbers: true,
            word_wrap: false,
            show_hidden_files: false,
            text_size: None,
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiscussionSynthesizer {
    #[default]
    Claude,
    Codex,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RunHistoryRetention {
    /// Drop runs older than this many days. `None` = never prune by age.
    pub days: Option<u32>,
    /// Keep at most this many runs total (newest first). `None` = no cap.
    pub max_runs: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BehaviorSettings {
    pub file_watcher_enabled: bool,
    pub external_write_reload_strategy: ReloadStrategy,
    /// "Tell me about my cards" (QoL 1.168): native notifications (Mac and
    /// Windows) when a card needs its person — Finish and check ends, a ship
    /// finishes or fails (`lib/cardNotify.ts`), a pull request's checks or
    /// review on GitHub (`pr_status::notify`) — and when an agent run
    /// finishes (with the agent's own `notify_on_done`). The id is the one it
    /// always had.
    pub notify_on_agent_done: bool,
    /// Tell me when a session is waiting for me: a native notification when a
    /// Claude or Codex session finishes its turn and waits for the user in
    /// another workspace, or while Ply is in the background. Its own toggle,
    /// independent of `notify_on_agent_done` (which covers cards and runs). Absent from
    /// every earlier settings.json → on, as that notification was before.
    #[serde(default = "default_true")]
    pub notify_on_session_waiting: bool,
    // GH #175: `experimentalLayout` (v0.5.0's switch back to the v0.4.0
    // shell) is gone: nothing had read it since the tile grid became the only
    // shell. An old settings.json that still has it loads — serde ignores the
    // unknown key — and the next save writes the file without it
    // (`tier2_gh175_old_settings_with_retired_keys_loads_and_round_trips`).
    /// v0.8.0: optional cap on stored agent runs. Pruned at app startup.
    #[serde(default)]
    pub run_history_retention: RunHistoryRetention,
    /// v0.10.0: when true, terminals parse OSC 133 sequences emitted by the
    /// shell integration script and surface command-boundary markers.
    /// Default off — requires user to source the integration script first.
    #[serde(default)]
    pub command_blocks_enabled: bool,
    /// v1.0: Swarm. Globally gate the per-swarm completion notification.
    /// AND'd with `notify_on_agent_done` (the existing global toggle). Lets a
    /// user keep single-agent notifications on while silencing swarms (or vice
    /// versa). Default true — fresh installs and pre-v1.0 settings.json files
    /// both opt in.
    #[serde(default = "default_true")]
    pub notify_on_swarm_done: bool,
    /// Fire a native notification at every swarm role handoff (e.g. scout done
    /// — builder running). AND'd with `notify_on_agent_done`. Default false —
    /// opt-in noise for users who want async awareness of mid-swarm progress.
    #[serde(default)]
    pub notify_swarm_role_boundary: bool,
    /// v1.1.1: when true, any swarm left `Suspended` by a previous Cmd-Q
    /// is auto-resumed at app start (after `reconcile_orphans` flips
    /// orphaned `Running` swarms to `Suspended`). Default false — opt-in
    /// because resume re-fires a `claude` PTY per swarm, which the user
    /// may want to confirm before paying the wall-time + token cost.
    /// One native notification fires summarizing the count.
    #[serde(default)]
    pub auto_resume_suspended: bool,
    /// v1.5.0 (S2): age cap on the per-run artifact directories at
    /// `<workspace_cwd>/.atelier/swarm/<runId>/`. Dirs older than this
    /// many days get reaped at startup. Skipped for runIds belonging to
    /// `Running` / `Suspended` swarms (those are still load-bearing for
    /// the handoff/resume paths). `None` = never reap by age. Default
    /// 30 days — long enough to read post-mortem on a swarm run, short
    /// enough that a user with weekly cadence accumulates < ~30 dirs.
    ///
    /// GH #175: owned by this side. The frontend's shape no longer has it
    /// (no page ever drew it, and the swarm pages are retired), so
    /// `SettingsStore::replace` keeps the stored value whatever a save sends:
    /// a number someone wrote into settings.json by hand survives every save.
    #[serde(default = "default_swarm_artifact_retention_days")]
    pub swarm_artifact_retention_days: Option<u32>,
    /// When true, agent-run tiles spawned by a kanban-card-driven swarm
    /// or single-agent run auto-close ~5s after the run/swarm hits a
    /// terminal status. Agents-tab manual launches are unaffected.
    #[serde(default = "default_true")]
    pub auto_close_finished_run_tiles: bool,
    /// v1.30.0 (parallel swarms): max card-driven swarms allowed to run
    /// concurrently in one workspace. Cards dragged to In Progress beyond
    /// this limit queue and auto-start as slots free. Default 3 — balances
    /// parallelism against Claude rate limits (each swarm can itself fan out
    /// to ~5 role runs). Read via `Settings::card_swarm_cap()`, which clamps
    /// to [1, 20]; only card-kind swarms are counted/capped.
    #[serde(default = "default_max_concurrent_card_swarms")]
    pub max_concurrent_card_swarms: u32,
    /// v1.35.0 (memory): when true, the per-workspace memory injection at
    /// card dispatch (Increment 2, v1.36.0) ALSO pulls from the global
    /// memory pool. When false (the default), only the active workspace's
    /// memories are considered. v1.35.0 ships the toggle but the dispatch
    /// path that consumes it lands in v1.36.0 — the toggle is wired and
    /// persisted now so users can opt in before the behavior arrives.
    #[serde(default)]
    pub inject_global_memories: bool,
    /// UX-4.3 (C4): where a workspace opens when no mode has been chosen
    /// this session — at launch, and on switching to it: the Inbox, its
    /// Board or its Terminals. Always `Some` after [`BehaviorSettings::normalize`];
    /// absent in files written before C4, which read `landOnBoard` instead.
    /// An unknown value reads as absent rather than failing the file.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub open_on: Option<OpenOn>,
    /// v1.69.0–C3: the boolean `openOn` replaced (true = Board). Read once
    /// by `normalize` — true → Board, false or absent → Inbox — and never
    /// written again.
    #[serde(default, skip_serializing)]
    pub land_on_board: Option<bool>,
    /// Agent collaboration Phase 5: the explicit choice remains visible in
    /// every start dialog; this only supplies the next dialog's default.
    #[serde(default)]
    pub discussion_synthesizer: DiscussionSynthesizer,
    /// v1.107.0 (Builder/Challenger D2): which vendor a card's live Builder
    /// uses unless the card overrides it at Run. Default Claude.
    #[serde(default)]
    pub builder_vendor: BuilderVendor,
    /// 1.171.0 (E1, K7): the Builder the person last chose on a card — a
    /// card made next takes it as its own `builder_vendor_pref`
    /// (`kanban_card_create`, `kanban_card_follow_up`); cards made before
    /// keep following `builder_vendor`. Settings or Setup choosing again
    /// clears it. Local to this
    /// computer; independent of `builder_permissions`. Absent from every
    /// earlier settings.json, and a value this Plyloft doesn't know, read as
    /// none: `builder_vendor` decides, as before.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_opt"
    )]
    pub last_builder_vendor: Option<BuilderVendor>,
    /// 1.171.0 (D1): how a new card's Builder asks before it changes things
    /// — the choice the card shows before Start build until the person
    /// picks another for it (`KanbanCard::builder_permissions`). Absent from
    /// every earlier settings.json → `Asks` (owner D3), which passes the
    /// same flags as before for Claude.
    #[serde(default, deserialize_with = "lenient_permissions")]
    pub builder_permissions: BuilderPermissions,
    /// #74: the model each role runs on, per vendor. Every field optional;
    /// blank = the vendor CLI's own default, which is exactly the
    /// behaviour of every Ply before this block existed.
    #[serde(default)]
    pub models: RoleModels,
    // G4 (launch D8): `advancedSwarms` (v1.110.0's switch for the role-chain
    // swarm machinery) left with the swarm UI. An old settings.json that
    // carries it loads (serde ignores the key); the next save drops it.
    /// #47: Ply's own dictation in Codex and shell tiles (hold Space).
    /// Absent from every earlier settings.json → on, `small`, `auto`.
    #[serde(default)]
    pub dictation: DictationSettings,
    /// Windows (W4): what the window's close (its X, Alt+F4) does — ask
    /// every time, keep running in the notification area, or quit. Read on
    /// Windows only; the Mac's close always hides (hard rule 5). Absent from
    /// every earlier settings.json → `Ask`; an unknown value reads as `Ask`
    /// rather than failing the file.
    #[serde(default, deserialize_with = "lenient")]
    pub windows_close_action: WindowsCloseAction,
    /// QoL 1.168 S1-2: the quit sheet also asks when a session is working
    /// (mid-turn), not only when files have unsaved changes. Its "Don't ask
    /// again" turns it off; unsaved files are always asked about. Absent from
    /// every earlier settings.json → on.
    #[serde(default = "default_true")]
    pub confirm_quit_with_working_sessions: bool,
    /// 1.175.0 (F5, UX-5; owner I6, I7): after a fix round Plyloft sent the
    /// Builder (the Reviewer's findings, this computer's failed checks, a
    /// pull request's fix), Finish and check starts by itself once the
    /// Builder's turn is over cleanly — each card can change it
    /// (`KanbanCard::fix_round_check`). Absent from every earlier
    /// settings.json → on (a function, not `bool::default()`).
    #[serde(default = "default_true")]
    pub check_fix_rounds_by_itself: bool,
}

/// Windows (W4): the choice behind the window's close. See
/// `close_choice::close_decision`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowsCloseAction {
    /// Ply's sheet asks: keep running in the notification area, or quit.
    #[default]
    Ask,
    /// Hide to the notification area, still running (the behaviour before
    /// the choice existed).
    Tray,
    /// Quit Ply, through the same exit as the tray's "Quit Ply".
    Quit,
}

/// #47: dictation in Codex and shell tiles. Claude tiles have Claude Code's
/// own `/voice` and are never affected by these.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DictationSettings {
    /// Hold Space in an idle Codex or shell prompt to dictate. Off returns
    /// Space to an ordinary key in every tile.
    pub enabled: bool,
    /// Which downloaded model whisper-cli runs.
    #[serde(deserialize_with = "lenient")]
    pub model: crate::dictation::DictationModel,
    /// `auto`, or an Italian / English override.
    #[serde(deserialize_with = "lenient")]
    pub language: crate::dictation::DictationLanguage,
}

impl Default for DictationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            model: Default::default(),
            language: Default::default(),
        }
    }
}

/// An unknown value (a model a later Ply offers, a hand edit) falls back to
/// the default instead of failing the parse — which would reset the whole
/// settings file, not just this field.
fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// `skip_serializing_if` for a flag that is left out of the file while off.
fn is_false(value: &bool) -> bool {
    !*value
}

/// UX-4.3: the absent-tolerant twin of [`lenient`], for an optional field.
pub(crate) fn lenient_opt<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

/// UX-4.3 (C4): where a workspace opens when no mode has been chosen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenOn {
    #[default]
    Inbox,
    Board,
    Terminals,
}

impl BehaviorSettings {
    /// UX-4.3: fold the retired `landOnBoard` into `openOn` — true is Board,
    /// false or absent the Inbox. Runs on every load and replace, so the old
    /// key never re-enters persisted state and `open_on` is always set.
    pub fn normalize(&mut self) {
        if self.open_on.is_none() {
            self.open_on = Some(if self.land_on_board == Some(true) {
                OpenOn::Board
            } else {
                OpenOn::Inbox
            });
        }
        self.land_on_board = None;
    }
}

/// v1.107.0: the two Builder vendors. Same shape as
/// [`DiscussionSynthesizer`]; kept separate because they are separate
/// decisions (the Challenger is always the other one).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BuilderVendor {
    #[default]
    Claude,
    Codex,
}

impl BehaviorSettings {
    /// 1.171.0 (K7): the Builder a card made now starts with — the one
    /// last chosen on a card, else Settings' (`newCardBuilderVendor` in
    /// `settingsShape.ts`). An existing card with no pick of its own
    /// follows `builder_vendor`.
    pub fn new_card_builder_vendor(&self) -> BuilderVendor {
        self.last_builder_vendor.unwrap_or(self.builder_vendor)
    }
}

impl BuilderVendor {
    pub fn as_str(self) -> &'static str {
        match self {
            BuilderVendor::Claude => "claude",
            BuilderVendor::Codex => "codex",
        }
    }
}

/// 1.171.0 (D1): how a card's Builder session asks before it changes
/// things — the card's choice before Start build, and
/// `behavior.builderPermissions`, the default a new card shows (owner D3:
/// `Asks`). The flags each one passes are `builder::builder_args_in_mode`'s:
/// Claude `--permission-mode acceptEdits` / no flag (its own default) /
/// `--dangerously-skip-permissions`; Codex `--sandbox workspace-write -a
/// on-request` / `--sandbox read-only -a on-request` / `--sandbox
/// workspace-write -a never` (never Codex's unsandboxed bypass). A value
/// this Plyloft doesn't know reads as the default (`lenient_permissions`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BuilderPermissions {
    /// "Edits its copy without asking".
    EditsCopy,
    /// "Asks before every change" with Codex; "Uses Claude's own setting"
    /// with Claude, which gets no permission mode (1.175.0 F9, owner I1).
    /// The saved value stays `asks`.
    #[default]
    Asks,
    /// "Never asks (risky)": the session's `bypass`.
    NeverAsks,
}

impl BuilderPermissions {
    /// The value `builder::builder_args_in_mode` reads as its
    /// `permission_mode` (the guided card's `acceptEdits` is the other one).
    pub fn mode_str(self) -> &'static str {
        match self {
            BuilderPermissions::EditsCopy => "editsCopy",
            BuilderPermissions::Asks => "asks",
            BuilderPermissions::NeverAsks => "neverAsks",
        }
    }
}

/// D1: `behavior.builderPermissions` — absent or unknown reads as `Asks`.
fn lenient_permissions<'de, D>(deserializer: D) -> Result<BuilderPermissions, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(lenient_opt(deserializer)?.unwrap_or_default())
}

/// #74: which of Ply's two roles a spawn is. The Builder is the live
/// session in the card's worktree; the Challenger is the reviewer that
/// reads the snapshot. They are separate rows so a slow, careful Builder
/// can be paired with a fast Challenger (and the reverse).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentRole {
    Builder,
    Challenger,
}

/// #74: the Claude row pair. Free text on purpose — no allow-list, so a
/// model name works the day the vendor ships it and an unknown one is the
/// CLI's own error, not Ply's (#50).
///
/// 1.169.0 (A1): Claude's effort too (`--effort low|medium|high|xhigh|max`),
/// under the same key names as Codex's. Absent from every file written
/// before it, and not written while unset, so an untouched settings.json,
/// workspace or card reads and writes exactly as before.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ClaudeModels {
    pub builder: Option<String>,
    pub challenger: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub builder_reasoning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub challenger_reasoning: Option<String>,
}

/// #74: the Codex row pair. Codex also carries a reasoning effort, because
/// a Challenger on a "high" model makes every review round slow. 1.169.0
/// (A1): the levels offered are the chosen model's (`model_catalog`); a
/// stored one the model doesn't take (an old `minimal`) is kept here and
/// passes no flag at spawn.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CodexModels {
    pub builder: Option<String>,
    pub challenger: Option<String>,
    pub builder_reasoning: Option<String>,
    pub challenger_reasoning: Option<String>,
}

/// #74: `behavior.models`. Absent from every settings.json written before
/// this block existed, and every field inside is optional.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RoleModels {
    pub claude: ClaudeModels,
    pub codex: CodexModels,
}

/// One resolved row: what a single spawn of one vendor in one role runs
/// on. Both fields blank means "pass nothing", i.e. today's behaviour.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelChoice {
    pub model: Option<String>,
    /// The effort: Codex's `-c model_reasoning_effort=…`, and since 1.169.0
    /// (A1) Claude's `--effort …`.
    pub reasoning: Option<String>,
}

/// A recorded label ("gpt-6-astra high", "opus", "low effort") split back
/// into model and effort: a model id has no space (one CLI argument), so
/// the first space ends it. The mirror of `roleModels.ts::splitModelLabel`.
pub fn split_model_label(label: &str) -> (Option<&str>, Option<&str>) {
    let label = label.trim();
    if label.is_empty() {
        return (None, None);
    }
    match label.split_once(' ') {
        None => (Some(label), None),
        Some((first, rest)) => {
            let rest = rest.trim();
            if rest == "effort" || rest == "reasoning" {
                (None, Some(first))
            } else {
                (Some(first), Some(rest).filter(|r| !r.is_empty()))
            }
        }
    }
}

/// Blank, whitespace-only and missing all mean "the CLI's default".
pub(crate) fn cleaned(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

impl ModelChoice {
    pub fn is_empty(&self) -> bool {
        self.model.is_none() && self.reasoning.is_none()
    }

    /// How the choice is named to the human — in the Builder tile header,
    /// in the review record and in the verdict's coverage line
    /// ("reviewed in 1 pass by gpt-6-astra medium"). `None` when nothing
    /// was chosen, so the line reads exactly as it did before #74.
    pub fn label(&self) -> Option<String> {
        match (self.model.as_deref(), self.reasoning.as_deref()) {
            (Some(model), Some(effort)) => Some(format!("{model} {effort}")),
            (Some(model), None) => Some(model.to_string()),
            // 1.169.0 (owner D1): one word for both vendors.
            (None, Some(effort)) => Some(format!("{effort} effort")),
            (None, None) => None,
        }
    }

    /// [`Self::label`] in a sentence (walk 2026-10-23): "gpt-6-astra with
    /// high effort". Chips keep the compact label.
    pub fn sentence_label(label: &str) -> String {
        let label = label.trim();
        let (model, effort) = split_model_label(label);
        match (model, effort) {
            (Some(m), Some(e)) => format!("{m} with {e} effort"),
            (Some(m), None) => m.to_string(),
            (None, Some(e)) => format!("{e} effort"),
            (None, None) => String::new(),
        }
    }

    /// [`Self::label`] for a vendor. Since owner D1 (1.169.0) both vendors
    /// read the same ("high effort"); kept so the callers name the vendor.
    pub fn label_for(&self, _vendor: &str) -> Option<String> {
        self.label()
    }

    /// 1.169.0 (A1): Claude's model flags — `--model <m>` and `--effort <e>`,
    /// each only when chosen. Every Claude spawn for a card or a run uses it,
    /// so the two always travel together.
    pub fn claude_flags(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(m) = self.model.as_deref() {
            args.push("--model".to_string());
            args.push(m.to_string());
        }
        if let Some(e) = self.reasoning.as_deref() {
            args.push("--effort".to_string());
            args.push(e.to_string());
        }
        args
    }
}

impl RoleModels {
    /// The row for one vendor and one role. Unknown vendors read the
    /// Claude row, matching every other `vendor == "codex"` branch in Ply.
    pub fn for_role(&self, vendor: &str, role: AgentRole) -> ModelChoice {
        if vendor == "codex" {
            let (model, reasoning) = match role {
                AgentRole::Builder => (&self.codex.builder, &self.codex.builder_reasoning),
                AgentRole::Challenger => (&self.codex.challenger, &self.codex.challenger_reasoning),
            };
            ModelChoice {
                model: cleaned(model),
                reasoning: cleaned(reasoning),
            }
        } else {
            let (model, reasoning) = match role {
                AgentRole::Builder => (&self.claude.builder, &self.claude.builder_reasoning),
                AgentRole::Challenger => (&self.claude.challenger, &self.claude.challenger_reasoning),
            };
            ModelChoice {
                model: cleaned(model),
                reasoning: cleaned(reasoning),
            }
        }
    }
}

fn default_swarm_artifact_retention_days() -> Option<u32> {
    Some(30)
}

fn default_max_concurrent_card_swarms() -> u32 {
    3
}

impl Default for BehaviorSettings {
    fn default() -> Self {
        Self {
            file_watcher_enabled: true,
            external_write_reload_strategy: ReloadStrategy::default(),
            notify_on_agent_done: true,
            notify_on_session_waiting: true,
            run_history_retention: RunHistoryRetention::default(),
            command_blocks_enabled: false,
            notify_on_swarm_done: true,
            notify_swarm_role_boundary: false,
            auto_resume_suspended: false,
            swarm_artifact_retention_days: default_swarm_artifact_retention_days(),
            auto_close_finished_run_tiles: true,
            max_concurrent_card_swarms: default_max_concurrent_card_swarms(),
            inject_global_memories: false,
            // UX-4.3: a fresh install opens on the Inbox.
            open_on: Some(OpenOn::Inbox),
            land_on_board: None,
            discussion_synthesizer: DiscussionSynthesizer::default(),
            builder_vendor: BuilderVendor::default(),
            last_builder_vendor: None,
            builder_permissions: BuilderPermissions::default(),
            models: RoleModels::default(),
            dictation: DictationSettings::default(),
            windows_close_action: WindowsCloseAction::Ask,
            confirm_quit_with_working_sessions: true,
            check_fix_rounds_by_itself: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub schema_version: u32,
    pub appearance: AppearanceSettings,
    pub terminals: TerminalSettings,
    pub shell: ShellSettings,
    pub editor: EditorSettings,
    pub behavior: BehaviorSettings,
    #[serde(default)]
    pub onboarding: OnboardingSettings,
    #[serde(default)]
    pub identity: IdentitySettings,
    /// v1.114.0: absent in every pre-1.114 settings.json → defaults.
    #[serde(default)]
    pub team: TeamSettings,
    /// GH #81: absent in every pre-#81 settings.json → defaults.
    #[serde(default)]
    pub sharing: SharingSettings,
    /// UX language card 1: absent in every earlier settings.json → defaults.
    #[serde(default)]
    pub windows: WindowSizes,
    /// GH #100: absent in every pre-#100 settings.json → no silenced notices.
    #[serde(default)]
    pub library: LibrarySettings,
    /// Onboarding §8.2: absent in every pre-v1.153 settings.json → defaults.
    #[serde(default)]
    pub projects: ProjectsSettings,
    /// 1.173.0 (C2): this computer's id and name for the claim marker.
    /// Absent in every earlier settings.json → filled at startup.
    #[serde(default)]
    pub device: DeviceSettings,
    /// 1.174.0 (A4): how Next improvement's slate opens, per area, on this
    /// computer. Absent in every earlier settings.json → empty.
    #[serde(default)]
    pub next_improvement: NextImprovementSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            appearance: AppearanceSettings::default(),
            terminals: TerminalSettings::default(),
            shell: ShellSettings::default(),
            editor: EditorSettings::default(),
            behavior: BehaviorSettings::default(),
            onboarding: OnboardingSettings::default(),
            identity: IdentitySettings::default(),
            team: TeamSettings::default(),
            sharing: SharingSettings::default(),
            windows: WindowSizes::default(),
            library: LibrarySettings::default(),
            projects: ProjectsSettings::default(),
            device: DeviceSettings::default(),
            next_improvement: NextImprovementSettings::default(),
        }
    }
}

impl Settings {
    /// Effective concurrency cap for card-driven swarms, clamped to a sane
    /// range. A hand-edited `0` would deadlock the queue (no card could ever
    /// dispatch); an absurdly high value risks a Claude rate-limit meltdown.
    pub fn card_swarm_cap(&self) -> usize {
        self.behavior.max_concurrent_card_swarms.clamp(1, 20) as usize
    }
}

/// CL-4 round 2: the names of the fields a workspace can set, as
/// `WorkspaceModels::cli_default` lists them (1.169.0: Claude's effort too).
pub const MODEL_FIELD_KEYS: [&str; 8] = [
    "claude.builder",
    "claude.challenger",
    "claude.builderReasoning",
    "claude.challengerReasoning",
    "codex.builder",
    "codex.challenger",
    "codex.builderReasoning",
    "codex.challengerReasoning",
];

/// The `cli_default` key of one vendor/role part (`model` or `reasoning`).
pub fn model_field_key(vendor: &str, role: AgentRole, reasoning: bool) -> &'static str {
    match (vendor == "codex", role, reasoning) {
        (true, AgentRole::Builder, false) => "codex.builder",
        (true, AgentRole::Challenger, false) => "codex.challenger",
        (true, AgentRole::Builder, true) => "codex.builderReasoning",
        (true, AgentRole::Challenger, true) => "codex.challengerReasoning",
        (false, AgentRole::Builder, false) => "claude.builder",
        (false, AgentRole::Challenger, false) => "claude.challenger",
        (false, AgentRole::Builder, true) => "claude.builderReasoning",
        (false, AgentRole::Challenger, true) => "claude.challengerReasoning",
    }
}

/// CL-4: a workspace's own model rows (`Workspace.models`, this Mac only).
///
/// Each field has three states, and none of them can be mistaken for the
/// others or for the app row:
/// - blank / absent: use the app's `behavior.models` field;
/// - a value: that model or effort;
/// - listed in `cli_default` (round 2): pass no flag at all in this
///   workspace, whatever the app row says.
///
/// Persisted as `{"claude":{…},"codex":{…},"cliDefault":["codex.builder"]}`.
/// `cliDefault` is left out while empty; names this build does not know are
/// kept and ignored, so a newer file read by an older build loses nothing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkspaceModels {
    #[serde(flatten)]
    pub rows: RoleModels,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub cli_default: Vec<String>,
}

impl WorkspaceModels {
    /// The field is forced to the CLI's own default in this workspace.
    pub fn forces_cli_default(&self, key: &str) -> bool {
        self.cli_default.iter().any(|k| k == key)
    }

    /// Trimmed, blanks dropped, `cli_default` sorted and deduplicated, and a
    /// forced field's value cleared (forced wins). `None` when nothing is
    /// left, so a cleared override writes no `models` key at all.
    pub fn normalized(&self) -> Option<WorkspaceModels> {
        let mut cli_default: Vec<String> = self
            .cli_default
            .iter()
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty())
            .collect();
        cli_default.sort();
        cli_default.dedup();
        let forced = |key: &str| cli_default.iter().any(|k| k == key);
        let keep = |key: &str, value: &Option<String>| if forced(key) { None } else { cleaned(value) };
        let r = &self.rows;
        let out = WorkspaceModels {
            rows: RoleModels {
                claude: ClaudeModels {
                    builder: keep("claude.builder", &r.claude.builder),
                    challenger: keep("claude.challenger", &r.claude.challenger),
                    builder_reasoning: keep("claude.builderReasoning", &r.claude.builder_reasoning),
                    challenger_reasoning: keep(
                        "claude.challengerReasoning",
                        &r.claude.challenger_reasoning,
                    ),
                },
                codex: CodexModels {
                    builder: keep("codex.builder", &r.codex.builder),
                    challenger: keep("codex.challenger", &r.codex.challenger),
                    builder_reasoning: keep("codex.builderReasoning", &r.codex.builder_reasoning),
                    challenger_reasoning: keep(
                        "codex.challengerReasoning",
                        &r.codex.challenger_reasoning,
                    ),
                },
            },
            cli_default,
        };
        (out != WorkspaceModels::default()).then_some(out)
    }
}

/// CL-4: the workspace's own rows merged field by field over the app's
/// `behavior.models`: a field the workspace forces to the CLI default passes
/// nothing; else the workspace value when set; else the app's; else none
/// (the CLI's default). A workspace that sets only Codex reasoning still
/// takes the app's model, and the other way round. 1.169.0 (A1): Claude's
/// effort is a field like the others. This is the one place the layers
/// meet (a card's go on top in [`resolve_card_model`]); a team layer
/// between the workspace and the app belongs here.
pub fn resolve_model(
    workspace: Option<&WorkspaceModels>,
    app: &RoleModels,
    vendor: &str,
    role: AgentRole,
) -> ModelChoice {
    resolve_model_with_team(workspace, None, app, vendor, role)
}

/// 1.169.0 (A2): [`resolve_model`] with the team's suggestion
/// (`.atelier/workspace.json` → `models`, `team_models`) between this Mac's
/// workspace choice and its app rows, field by field: my workspace > team >
/// my app > the tool's default. A field the workspace forces to the tool's
/// default still passes nothing.
pub fn resolve_model_with_team(
    workspace: Option<&WorkspaceModels>,
    team: Option<&RoleModels>,
    app: &RoleModels,
    vendor: &str,
    role: AgentRole,
) -> ModelChoice {
    let app_row = app.for_role(vendor, role);
    let team_row = team.map(|t| t.for_role(vendor, role)).unwrap_or_default();
    let fallback = ModelChoice {
        model: team_row.model.or(app_row.model),
        reasoning: team_row.reasoning.or(app_row.reasoning),
    };
    let Some(ws) = workspace else {
        return fallback;
    };
    let own = ws.rows.for_role(vendor, role);
    let model = if ws.forces_cli_default(model_field_key(vendor, role, false)) {
        None
    } else {
        own.model.or(fallback.model)
    };
    let reasoning = if ws.forces_cli_default(model_field_key(vendor, role, true)) {
        None
    } else {
        own.reasoning.or(fallback.reasoning)
    };
    ModelChoice { model, reasoning }
}

/// CL-4: the model row a spawn for one workspace should use — the
/// workspace's personal override (`Workspace.models`, this Mac only) over
/// the app row. A store missing from state (early boot, tests) reads as
/// empty: an empty choice means "pass no model", the CLI default.
pub fn model_for_workspace<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    vendor: &str,
    role: AgentRole,
) -> ModelChoice {
    use tauri::Manager;
    let app_models = app
        .try_state::<SettingsStore>()
        .map(|store| store.snapshot().behavior.models)
        .unwrap_or_default();
    let workspace_models = app
        .try_state::<crate::workspace::WorkspaceStore>()
        .and_then(|store| store.models_for(workspace_id));
    let team = crate::team_models::for_workspace(app, workspace_id);
    // 1.169.0 (A1/A2): an effort the model doesn't take falls to the next
    // layer's, else passes no flag.
    fitted_for_spawn(None, workspace_models.as_ref(), team.as_ref(), &app_models, vendor, role)
}

/// 1.168.1 (E2): a card's own model choice (`KanbanCard.models`, this Mac
/// only) over the workspace's resolution, field by field, with the same
/// three states as a workspace field: blank — the workspace's (else the
/// app's, else the CLI's own); a value — that model or effort; listed in
/// `cli_default` — no flag on this card, whatever is set above it.
pub fn resolve_card_model(
    card: Option<&WorkspaceModels>,
    workspace: Option<&WorkspaceModels>,
    app: &RoleModels,
    vendor: &str,
    role: AgentRole,
) -> ModelChoice {
    resolve_card_model_with_team(card, workspace, None, app, vendor, role)
}

/// [`resolve_card_model`] with the team's suggestion (A2) below the
/// workspace's: card > my workspace > team > my app > the tool's default.
pub fn resolve_card_model_with_team(
    card: Option<&WorkspaceModels>,
    workspace: Option<&WorkspaceModels>,
    team: Option<&RoleModels>,
    app: &RoleModels,
    vendor: &str,
    role: AgentRole,
) -> ModelChoice {
    let below = resolve_model_with_team(workspace, team, app, vendor, role);
    let Some(card) = card else {
        return below;
    };
    let own = card.rows.for_role(vendor, role);
    let model = if card.forces_cli_default(model_field_key(vendor, role, false)) {
        None
    } else {
        own.model.or(below.model)
    };
    let reasoning = if card.forces_cli_default(model_field_key(vendor, role, true)) {
        None
    } else {
        own.reasoning.or(below.reasoning)
    };
    ModelChoice { model, reasoning }
}

/// A2 (Challenger 5): [`resolve_card_model_with_team`]'s model, and the
/// first effort down the layers (card > workspace > team > app) that `fits`
/// that model — a team's effort the model doesn't take falls to my app's
/// before none is passed. A layer forcing the tool's default stops the walk
/// (no flag). With a `fits` that takes everything it is exactly
/// [`resolve_card_model_with_team`]. Held with `cardModels.ts` to
/// `src/lib/cardModels.fixtures.json` (CH-4).
pub fn resolve_card_model_fitted(
    card: Option<&WorkspaceModels>,
    workspace: Option<&WorkspaceModels>,
    team: Option<&RoleModels>,
    app: &RoleModels,
    vendor: &str,
    role: AgentRole,
    fits: &dyn Fn(Option<&str>, &str) -> bool,
) -> ModelChoice {
    let model = resolve_card_model_with_team(card, workspace, team, app, vendor, role).model;
    let key = model_field_key(vendor, role, true);
    let forced = |m: Option<&WorkspaceModels>| m.is_some_and(|m| m.forces_cli_default(key));
    let own = |m: Option<&WorkspaceModels>| m.and_then(|m| m.rows.for_role(vendor, role).reasoning);
    let layers = [
        (forced(card), own(card)),
        (forced(workspace), own(workspace)),
        (false, team.and_then(|t| t.for_role(vendor, role).reasoning)),
        (false, app.for_role(vendor, role).reasoning),
    ];
    let mut reasoning = None;
    for (is_forced, value) in layers {
        if is_forced {
            break;
        }
        if let Some(value) = value.filter(|v| fits(model.as_deref(), v)) {
            reasoning = Some(value);
            break;
        }
    }
    ModelChoice { model, reasoning }
}

/// The resolution every spawn uses: the layers walked against the current
/// catalog, then the catalog's own rule (the Claude Code version).
fn fitted_for_spawn(
    card: Option<&WorkspaceModels>,
    workspace: Option<&WorkspaceModels>,
    team: Option<&RoleModels>,
    app: &RoleModels,
    vendor: &str,
    role: AgentRole,
) -> ModelChoice {
    let catalog = crate::model_catalog::current();
    let choice =
        resolve_card_model_fitted(card, workspace, team, app, vendor, role, &|m, e| catalog.effort_fits(vendor, m, e));
    catalog.fit(vendor, choice)
}

/// 1.168.1 (E2): the model row a spawn for one card should use — the card's
/// own choice (`card_models`), else [`model_for_workspace`]'s.
pub fn model_for_card<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    card_models: Option<&WorkspaceModels>,
    vendor: &str,
    role: AgentRole,
) -> ModelChoice {
    use tauri::Manager;
    let app_models = app
        .try_state::<SettingsStore>()
        .map(|store| store.snapshot().behavior.models)
        .unwrap_or_default();
    let workspace_models = app
        .try_state::<crate::workspace::WorkspaceStore>()
        .and_then(|store| store.models_for(workspace_id));
    let team = crate::team_models::for_workspace(app, workspace_id);
    fitted_for_spawn(card_models, workspace_models.as_ref(), team.as_ref(), &app_models, vendor, role)
}

/// [`model_for_card`] for a card known by id, read from the board. A card
/// (or a board store) that isn't there reads as no card choice.
pub fn model_for_card_id<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    card_id: &str,
    vendor: &str,
    role: AgentRole,
) -> ModelChoice {
    use tauri::Manager;
    let card_models = app
        .try_state::<crate::kanban::KanbanStore>()
        .and_then(|kanban| kanban.get_card(workspace_id, card_id).ok())
        .and_then(|card| card.models);
    model_for_card(app, workspace_id, card_models.as_ref(), vendor, role)
}

pub struct SettingsStore {
    config_dir: PathBuf,
    state: Mutex<Settings>,
}

impl SettingsStore {
    pub fn new(config_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&config_dir).map_err(|e| format!("create_dir_all: {e}"))?;
        let path = config_dir.join(SETTINGS_FILE);
        let state = Self::load(&path).unwrap_or_else(|e| {
            log::error!("settings: load failed ({e}); falling back to defaults");
            Self::move_aside_corrupt(&path);
            Settings::default()
        });
        Ok(Self {
            config_dir,
            state: Mutex::new(state),
        })
    }

    /// Read the existing settings without creating, repairing, renaming, or
    /// defaulting any persisted state. Used by read-only headless diagnostics
    /// whose preflight must be able to prove a byte-identical filesystem.
    pub fn new_read_only_strict(config_dir: PathBuf) -> Result<Self, String> {
        if !config_dir.is_dir() {
            return Err("settings: config directory is missing".into());
        }
        let path = config_dir.join(SETTINGS_FILE);
        let bytes = fs::read(&path).map_err(|e| format!("settings: strict read: {e}"))?;
        if bytes.is_empty() {
            return Err("settings: strict input is empty".into());
        }
        let state = Self::parse(&bytes).map_err(|e| format!("settings: strict {e}"))?;
        Ok(Self {
            config_dir,
            state: Mutex::new(state),
        })
    }

    fn load(path: &Path) -> Result<Settings, String> {
        if !path.exists() {
            return Ok(Settings::default());
        }
        let bytes = fs::read(path).map_err(|e| format!("read: {e}"))?;
        if bytes.is_empty() {
            return Ok(Settings::default());
        }
        Self::parse(&bytes)
    }

    fn parse(bytes: &[u8]) -> Result<Settings, String> {
        let mut s: Settings = serde_json::from_slice(bytes).map_err(|e| format!("parse: {e}"))?;
        if s.schema_version == 0 {
            s.schema_version = CURRENT_SCHEMA_VERSION;
        }
        // v1.64.0: fold retired themes into theme+accent (never fails).
        s.appearance.normalize();
        // UX-4.3: landOnBoard → openOn.
        s.behavior.normalize();
        Ok(s)
    }

    fn move_aside_corrupt(path: &Path) {
        if !path.exists() {
            return;
        }
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mut backup = path.as_os_str().to_owned();
        backup.push(format!(".broken-{ts}"));
        let backup: PathBuf = backup.into();
        if let Err(e) = fs::rename(path, &backup) {
            log::error!("settings: could not move corrupt file aside: {e}");
        } else {
            log::warn!("settings: corrupt file moved to {}", backup.display());
        }
    }

    fn save_atomic(&self, settings: &Settings) -> Result<(), String> {
        let path = self.config_dir.join(SETTINGS_FILE);
        let tmp = self.config_dir.join(format!("{SETTINGS_FILE}.tmp"));
        let json = serde_json::to_vec_pretty(settings).map_err(|e| format!("encode: {e}"))?;
        // Skip writes that would produce identical bytes
        if let Ok(existing) = fs::read(&path) {
            if existing == json {
                return Ok(());
            }
        }
        fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
        crate::platform::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
        Ok(())
    }

    pub fn snapshot(&self) -> Settings {
        self.state.lock().clone()
    }

    /// 1.174.0 (A6 round 1): at launch, the earliest ship among every board
    /// file (`kanban::earliest_ship_ms`) becomes `firstCardShippedAt`, once —
    /// people who shipped before 1.174 keep Next improvement on every
    /// project, not only on the Boards the frontend has read. `true` when it
    /// wrote; a time already there is kept.
    pub fn backfill_first_card_shipped(&self, at_ms: Option<i64>) -> Result<bool, String> {
        let Some(at) = at_ms.and_then(chrono::DateTime::from_timestamp_millis) else {
            return Ok(false);
        };
        let mut state = self.state.lock();
        if state.next_improvement.first_card_shipped_at.is_some() {
            return Ok(false);
        }
        let mut next = state.clone();
        next.next_improvement.first_card_shipped_at =
            Some(at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        self.save_atomic(&next)?;
        *state = next;
        Ok(true)
    }

    /// A whole-value save with nothing to merge against. Tests only: the
    /// backend changes settings through [`Self::update`], and the window's
    /// save goes through [`Self::replace_from`] with its base (1.176.2 R2).
    #[cfg(test)]
    pub fn replace(&self, new_settings: Settings) -> Result<Settings, String> {
        self.replace_from(None, new_settings)
    }

    /// 1.176.2 R2: the one way the backend changes settings. `change` runs on
    /// the stored value under the store's lock, which is held through the
    /// atomic save and the swap: no other write can land between the read and
    /// the write, and nothing read earlier is written back.
    pub fn update(&self, change: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
        let mut state = self.state.lock();
        let mut next = state.clone();
        change(&mut next);
        Self::normalize(&mut next);
        self.save_atomic(&next)?;
        *state = next.clone();
        Ok(next)
    }

    /// The window's save (`settings_set`). With the copy the window's change
    /// was based on (`base`), only the fields the window changed are applied
    /// onto what is stored, under the lock ([`crate::settings_merge::merge3`]):
    /// a backend change the window hadn't heard of yet stays. Without a base,
    /// `next` is saved whole.
    pub fn replace_from(&self, base: Option<Settings>, next: Settings) -> Result<Settings, String> {
        // One lock across read, merge, write and swap, so the carried value is
        // the one stored when this save lands.
        let mut state = self.state.lock();
        let mut new_settings = match base {
            Some(base) => crate::settings_merge::merge_settings(&state, &base, &next)?,
            None => next,
        };
        Self::normalize(&mut new_settings);
        Self::keep_backend_owned(&mut new_settings, &state);
        self.save_atomic(&new_settings)?;
        *state = new_settings.clone();
        Ok(new_settings)
    }

    /// 1.176.3 (owner, 2026-11-23): a reset from the window
    /// (`settings_reset`). The window's change is merged as any save is
    /// ([`Self::replace_from`]), and then every path in `paths` takes the
    /// window's value whatever is stored there — a value Plyloft wrote after
    /// the window's copy too ([`crate::settings_reset::merge_forcing`]). Keys
    /// outside `paths` keep what the backend wrote meanwhile. Gives back what
    /// was stored before the reset, read under the same lock, and what was
    /// saved: the Undo puts back the first.
    pub fn reset_from(&self, base: Settings, next: Settings, paths: &[String]) -> Result<(Settings, Settings), String> {
        let mut state = self.state.lock();
        let before = state.clone();
        let mut new_settings = crate::settings_reset::merge_forcing(&state, &base, &next, paths)?;
        Self::normalize(&mut new_settings);
        Self::keep_backend_owned(&mut new_settings, &state);
        self.save_atomic(&new_settings)?;
        *state = new_settings.clone();
        Ok((before, new_settings))
    }

    fn normalize(settings: &mut Settings) {
        settings.schema_version = CURRENT_SCHEMA_VERSION;
        // v1.64.0: a stale frontend could still send a retired theme.
        settings.appearance.normalize();
        settings.behavior.normalize();
    }

    /// GH #175: the keys the frontend's `Settings` shape does not carry. A
    /// save from the frontend deserializes them to their defaults, so they are
    /// taken from what is stored instead — never reset by an unrelated change.
    fn keep_backend_owned(next: &mut Settings, stored: &Settings) {
        // 1.174.0 (A6): Next improvement's two records are never cleared — a
        // save from a frontend that read settings before the launch backfill
        // (or before the other record landed) keeps what is stored.
        if next.next_improvement.first_card_shipped_at.is_none() {
            next.next_improvement.first_card_shipped_at =
                stored.next_improvement.first_card_shipped_at.clone();
        }
        if next.next_improvement.opens_since.is_none() {
            next.next_improvement.opens_since = stored.next_improvement.opens_since.clone();
        }
        next.behavior.swarm_artifact_retention_days =
            stored.behavior.swarm_artifact_retention_days;
        // G4 (launch D8): the swarm notifications and the card-swarm cap left
        // Settings with the swarm UI, but a card still finishing its swarm
        // reads them; a save keeps what was set.
        next.behavior.notify_on_swarm_done = stored.behavior.notify_on_swarm_done;
        next.behavior.notify_swarm_role_boundary = stored.behavior.notify_swarm_role_boundary;
        next.behavior.max_concurrent_card_swarms = stored.behavior.max_concurrent_card_swarms;
        // Onboarding §11.1: the team this Mac is in is written by the backend
        // when a team is created or joined ([`Self::set_team_repo`]). A
        // frontend holding settings read before that must not undo it.
        next.team.team_repo = stored.team.team_repo.clone();
        // OB-10: and the GitHub account the team was joined with, written
        // beside it ([`Self::set_joined_team`]).
        next.team.account = stored.team.account.clone();
        // OB-8: the board offer's answers are recorded by the backend
        // ([`Self::set_board_choice`]); a stale frontend save keeps them.
        next.sharing.github_board_moved = stored.sharing.github_board_moved.clone();
        next.sharing.github_board_kept_local = stored.sharing.github_board_kept_local.clone();
        // Skills hub H10: My library is recorded by the backend when it is
        // created, used, pointed elsewhere or stopped ([`Self::set_my_library`]).
        next.library.my_library = stored.library.my_library.clone();
        // 1.173.0 (C2): this computer's id and name ([`Self::ensure_device`]).
        next.device = stored.device.clone();
    }

    /// 1.173.0 (C2): this computer's identity — its id made once (a uuid)
    /// and its name read now through `read_name` (kept when the read gives
    /// nothing). Saved atomically only when either changed; published for
    /// the claim marker ([`crate::device_claim::set_this_device`]).
    pub fn ensure_device(
        &self,
        read_name: impl FnOnce() -> String,
        read_hardware: impl FnOnce() -> String,
    ) -> Result<crate::device_claim::ThisDevice, String> {
        let read = read_name();
        let hardware_now = Some(read_hardware()).filter(|h| !h.trim().is_empty());
        let mut state = self.state.lock();
        let kept_id = state.device.id.clone().map(|id| id.trim().to_string()).filter(|id| !id.is_empty());
        // Another computer's copy of these settings: its id is not this one's.
        let moved = matches!((&state.device.hardware, &hardware_now), (Some(was), Some(now)) if was != now);
        let id = kept_id
            .filter(|_| !moved)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let hardware = hardware_now.or_else(|| state.device.hardware.clone());
        let name = device_name_or(&read, state.device.name.as_deref());
        let next_device = DeviceSettings { id: Some(id.clone()), name: Some(name.clone()), hardware };
        if state.device != next_device {
            let mut next = state.clone();
            next.device = next_device;
            self.save_atomic(&next)?;
            *state = next;
        }
        let device = crate::device_claim::ThisDevice { id, name };
        crate::device_claim::set_this_device(device.clone());
        Ok(device)
    }

    /// Skills hub H10 (R6): record this Mac's My library (`None`: stop using
    /// it here). Backend-owned: [`Self::replace`] keeps it.
    pub fn set_my_library(&self, my_library: Option<MyLibrarySettings>) -> Result<Settings, String> {
        let mut state = self.state.lock();
        let mut next = state.clone();
        next.library.my_library = my_library;
        self.save_atomic(&next)?;
        *state = next.clone();
        Ok(next)
    }

    /// OB-8: record this Mac's answer to "Move this board to GitHub Issues?"
    /// for `repo_key` (lowercase `owner/name`); the other answer is dropped.
    pub fn set_board_choice(&self, repo_key: &str, moved: bool) -> Result<Settings, String> {
        let mut state = self.state.lock();
        let mut next = state.clone();
        let sharing = &mut next.sharing;
        let key = repo_key.trim().to_ascii_lowercase();
        let other = |r: &String| r.trim().to_ascii_lowercase() != key;
        sharing.github_board_moved.retain(other);
        sharing.github_board_kept_local.retain(other);
        let repo_key = key.as_str();
        if moved {
            sharing.github_board_moved.push(repo_key.to_string());
        } else {
            sharing.github_board_kept_local.push(repo_key.to_string());
        }
        self.save_atomic(&next)?;
        *state = next.clone();
        Ok(next)
    }

    /// Onboarding §11.1: record the team this Mac is in — created or joined,
    /// with or without a key. Backend-owned: [`Self::replace`] keeps it.
    /// Launch G3: leaving clears the whole team record (`clear_team`), so only
    /// tests set the repo alone now.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn set_team_repo(&self, team_repo: Option<String>) -> Result<Settings, String> {
        let mut state = self.state.lock();
        let mut next = state.clone();
        next.team.team_repo = team_repo;
        self.save_atomic(&next)?;
        *state = next.clone();
        Ok(next)
    }

    /// N14 (P2-1): leave the team — `team_repo` and the account it ran as go
    /// together, in one atomic write, so a team created afterwards runs as
    /// gh's active account rather than the old team's.
    pub fn clear_team(&self) -> Result<Settings, String> {
        let mut state = self.state.lock();
        let mut next = state.clone();
        next.team.team_repo = None;
        next.team.account = None;
        self.save_atomic(&next)?;
        *state = next.clone();
        Ok(next)
    }

    /// OB-10: record a team just joined — `team_repo`, and the GitHub account
    /// the join used (`None` = gh's active one) — in one atomic write.
    pub fn set_joined_team(&self, team_repo: &str, account: Option<String>) -> Result<Settings, String> {
        let mut state = self.state.lock();
        let mut next = state.clone();
        next.team.team_repo = Some(team_repo.to_string());
        next.team.account = account;
        self.save_atomic(&next)?;
        *state = next.clone();
        Ok(next)
    }

    /// OB-8 review 2 (P3-5): write `team_repo` only when the stored setting
    /// names no team — checked and written under one lock, so a team recorded
    /// meanwhile (a create, a join) is never overwritten. `None` when it kept
    /// what was there.
    pub fn set_team_repo_if_blank(&self, team_repo: &str) -> Result<Option<Settings>, String> {
        let mut state = self.state.lock();
        let blank = state
            .team
            .team_repo
            .as_deref()
            .map(str::trim)
            .is_none_or(str::is_empty);
        if !blank {
            return Ok(None);
        }
        let mut next = state.clone();
        next.team.team_repo = Some(team_repo.to_string());
        // N14 review 2: an account left from an earlier team is not this one's.
        next.team.account = None;
        self.save_atomic(&next)?;
        *state = next.clone();
        Ok(Some(next))
    }

    /// Launch G3 (Challenger P3-5): record the GitHub account the team's calls
    /// ran as, when the team names none yet — checked and written under one
    /// lock, and only while `team_repo` is still this Mac's team. `Some` when
    /// it wrote. The team gates then compare with a recorded account, never a
    /// process-wide guess.
    pub fn set_team_account_if_blank(&self, team_repo: &str, login: &str) -> Result<Option<Settings>, String> {
        let login = login.trim();
        let mut state = self.state.lock();
        let same_team = state
            .team
            .team_repo
            .as_deref()
            .is_some_and(|r| r.trim().eq_ignore_ascii_case(team_repo.trim()));
        let blank = state.team.account.as_deref().map(str::trim).is_none_or(str::is_empty);
        if !same_team || !blank || login.is_empty() {
            return Ok(None);
        }
        let mut next = state.clone();
        next.team.account = Some(login.to_string());
        self.save_atomic(&next)?;
        *state = next.clone();
        Ok(Some(next))
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn first_run_backfill_skips_a_first_run_under_way_in_setup() {
        let fresh = OnboardingSettings::default();
        // v1.32.0's rule stands: workspaces and no stamp → backfill.
        assert!(fresh.needs_first_run_backfill(true));
        assert!(!fresh.needs_first_run_backfill(false));
        // Already stamped → nothing to do.
        let stamped = OnboardingSettings {
            first_run_completed_at: Some("2026-01-01T00:00:00Z".into()),
            ..Default::default()
        };
        assert!(!stamped.needs_first_run_backfill(true));
        // A fresh user mid-setup who added a project keeps the first run.
        let mid_level = OnboardingSettings {
            level: Some(SetupLevel::Guided),
            ..Default::default()
        };
        assert!(!mid_level.needs_first_run_backfill(true));
        let mid_step = OnboardingSettings {
            current_step: Some("project".into()),
            ..Default::default()
        };
        assert!(!mid_step.needs_first_run_backfill(true));
    }
    use super::*;

    #[test]
    fn strict_read_only_store_requires_existing_nonempty_valid_file() {
        let temp = tempfile::tempdir().unwrap();
        let missing = SettingsStore::new_read_only_strict(temp.path().join("missing"));
        assert!(missing.is_err());
        assert!(!temp.path().join("missing").exists());

        assert!(SettingsStore::new_read_only_strict(temp.path().to_path_buf()).is_err());
        assert!(!temp.path().join(SETTINGS_FILE).exists());

        std::fs::write(temp.path().join(SETTINGS_FILE), []).unwrap();
        assert!(SettingsStore::new_read_only_strict(temp.path().to_path_buf()).is_err());

        std::fs::write(temp.path().join(SETTINGS_FILE), b"not json").unwrap();
        assert!(SettingsStore::new_read_only_strict(temp.path().to_path_buf()).is_err());
        let names = std::fs::read_dir(temp.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(names, vec![std::ffi::OsString::from(SETTINGS_FILE)]);

        std::fs::write(
            temp.path().join(SETTINGS_FILE),
            br#"{"schemaVersion":1,"shell":{"pathOverride":"/opt/bin"}}"#,
        )
        .unwrap();
        let store = SettingsStore::new_read_only_strict(temp.path().to_path_buf()).unwrap();
        assert_eq!(
            store.snapshot().shell.path_override.as_deref(),
            Some("/opt/bin")
        );
    }

    /// PPVP Tier 2: a v0.4.0 settings.json (without `experimentalLayout`)
    /// must load cleanly and default the new field to `true`.
    #[test]
    fn loads_v0_4_0_settings_json_without_experimental_layout() {
        let v0_4_0_json = br#"{
            "schemaVersion": 1,
            "appearance": { "theme": "system" },
            "terminals": { "defaultNewPaneKind": "shell", "scrollbackLines": 5000 },
            "shell": { "pathOverride": null },
            "editor": { "tabSize": 2, "lineNumbers": true, "wordWrap": false },
            "behavior": {
                "fileWatcherEnabled": true,
                "externalWriteReloadStrategy": "promptIfDirty",
                "notifyOnAgentDone": true
            }
        }"#;
        let parsed: Settings = serde_json::from_slice(v0_4_0_json).expect("parse");
        assert!(parsed.behavior.file_watcher_enabled);
        assert!(parsed.behavior.notify_on_agent_done);
        assert_eq!(
            parsed.behavior.discussion_synthesizer,
            DiscussionSynthesizer::Claude
        );
    }

    /// QoL 6.1 Tier 2: a v1.167.0 `editor` block (no `showHiddenFiles`)
    /// loads with hidden files off and keeps its other fields; the new field
    /// round-trips.
    #[test]
    fn tier2_show_hidden_files_defaults_off_and_round_trips() {
        let legacy: Settings = serde_json::from_slice(
            br#"{ "schemaVersion": 1, "editor": { "tabSize": 4, "lineNumbers": false, "wordWrap": true } }"#,
        )
        .expect("parse");
        assert!(!legacy.editor.show_hidden_files);
        assert_eq!(legacy.editor.tab_size, 4);
        assert!(!legacy.editor.line_numbers && legacy.editor.word_wrap);
        let no_editor: Settings = serde_json::from_str(r#"{"schemaVersion":1}"#).unwrap();
        assert!(!no_editor.editor.show_hidden_files);

        let mut on = legacy.clone();
        on.editor.show_hidden_files = true;
        let json = serde_json::to_value(&on).unwrap();
        assert_eq!(json["editor"]["showHiddenFiles"], serde_json::json!(true));
        let back: Settings = serde_json::from_value(json).unwrap();
        assert!(back.editor.show_hidden_files);
    }

    #[test]
    fn tier2_discussion_synthesizer_defaults_and_round_trips() {
        let legacy: Settings = serde_json::from_str(r#"{"schemaVersion":1}"#).unwrap();
        assert_eq!(
            legacy.behavior.discussion_synthesizer,
            DiscussionSynthesizer::Claude
        );

        let mut current = Settings::default();
        current.behavior.discussion_synthesizer = DiscussionSynthesizer::Codex;
        let encoded = serde_json::to_vec(&current).unwrap();
        let decoded: Settings = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(
            decoded.behavior.discussion_synthesizer,
            DiscussionSynthesizer::Codex
        );
    }

    /// GH #68 Tier 2: a settings.json from before the tile-shell field loads
    /// with the login shell, and a chosen shell round-trips.
    #[test]
    fn tier2_tile_shell_defaults_to_the_login_shell_and_round_trips() {
        let legacy: Settings = serde_json::from_slice(
            br#"{"schemaVersion":1,"shell":{"pathOverride":"/opt/bin"}}"#,
        )
        .unwrap();
        assert_eq!(legacy.shell.path_override.as_deref(), Some("/opt/bin"));
        assert_eq!(legacy.shell.tile_shell, None);
        assert_eq!(legacy.shell.tile_shell(), None);

        let mut current = Settings::default();
        current.shell.tile_shell = Some("/bin/zsh".into());
        let encoded = serde_json::to_value(&current).unwrap();
        assert_eq!(encoded["shell"]["tileShell"], "/bin/zsh");
        let decoded: Settings = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded.shell.tile_shell(), Some("/bin/zsh"));

        current.shell.tile_shell = Some("   ".into());
        assert_eq!(current.shell.tile_shell(), None, "blank is the login shell");
    }

    /// GH #175 Tier 2: a settings.json written before the swarm pages were
    /// retired — `experimentalLayout`, `swarmArtifactRetentionDays`,
    /// `advancedSwarms` on and the swarm notifications — loads with every
    /// value it had that is still a setting. Round trip: `experimentalLayout`
    /// is dropped on the next write (nothing reads it); the swarm retention is
    /// **kept**, including through a save from a frontend whose shape no
    /// longer carries it; the rest survive as they were. G4: `advancedSwarms`
    /// is no longer a setting, so the next write drops it too.
    #[test]
    fn tier2_gh175_old_settings_with_retired_keys_loads_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let old = br#"{
            "schemaVersion": 1,
            "behavior": {
                "fileWatcherEnabled": true,
                "notifyOnAgentDone": true,
                "experimentalLayout": false,
                "notifyOnSwarmDone": false,
                "notifySwarmRoleBoundary": true,
                "autoResumeSuspended": true,
                "swarmArtifactRetentionDays": 7,
                "maxConcurrentCardSwarms": 5,
                "discussionSynthesizer": "codex",
                "advancedSwarms": true
            }
        }"#;
        std::fs::write(dir.path().join(SETTINGS_FILE), old).unwrap();
        let store = SettingsStore::new(dir.path().to_path_buf()).unwrap();
        let loaded = store.snapshot();
        assert_eq!(loaded.behavior.swarm_artifact_retention_days, Some(7));
        assert!(!loaded.behavior.notify_on_swarm_done);
        assert!(loaded.behavior.notify_swarm_role_boundary);
        assert!(loaded.behavior.auto_resume_suspended);
        assert_eq!(loaded.behavior.max_concurrent_card_swarms, 5);
        assert_eq!(
            loaded.behavior.discussion_synthesizer,
            DiscussionSynthesizer::Codex
        );
        // Nothing was written by loading: the file is byte-identical.
        assert_eq!(std::fs::read(dir.path().join(SETTINGS_FILE)).unwrap(), old);

        // What the frontend sends now: its own shape, which has neither key.
        let mut sent = serde_json::to_value(&loaded).unwrap();
        let behavior = sent["behavior"].as_object_mut().unwrap();
        behavior.remove("swarmArtifactRetentionDays");
        assert!(!behavior.contains_key("experimentalLayout"));
        behavior.insert("openOn".into(), serde_json::json!("board"));
        let sent: Settings = serde_json::from_value(sent).unwrap();
        assert_eq!(
            sent.behavior.swarm_artifact_retention_days,
            Some(30),
            "absent from the save, it would have been reset to the default"
        );
        let saved = store.replace(sent).unwrap();
        assert_eq!(saved.behavior.swarm_artifact_retention_days, Some(7));
        assert_eq!(
            saved.behavior.open_on,
            Some(OpenOn::Board),
            "the change itself landed"
        );

        let on_disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(SETTINGS_FILE)).unwrap())
                .unwrap();
        let b = &on_disk["behavior"];
        assert!(b.get("experimentalLayout").is_none(), "the dead key is dropped");
        assert_eq!(b["swarmArtifactRetentionDays"], 7, "the retention is kept");
        assert!(b.get("advancedSwarms").is_none(), "G4: no longer a setting");
        assert_eq!(b["discussionSynthesizer"], "codex");
        assert_eq!(b["notifySwarmRoleBoundary"], true);

        // A later launch reads the same values back.
        let again = SettingsStore::new(dir.path().to_path_buf()).unwrap().snapshot();
        assert_eq!(again.behavior.swarm_artifact_retention_days, Some(7));

        // A hand-edited `null` (never reap) is kept the same way.
        let mut never = again.clone();
        never.behavior.swarm_artifact_retention_days = None;
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            serde_json::to_vec(&never).unwrap(),
        )
        .unwrap();
        let reopened = SettingsStore::new(dir.path().to_path_buf()).unwrap();
        let saved = reopened.replace(Settings::default()).unwrap();
        assert_eq!(saved.behavior.swarm_artifact_retention_days, None);
    }

    /// Tier 2 schema-migration test for v1.0 Swarm: a pre-v1.0 settings.json
    /// (no `notifyOnSwarmDone`) loads with the new field defaulting to `true`,
    /// matching the fresh-install default.
    #[test]
    fn legacy_settings_loads_with_notify_on_swarm_done_default_true() {
        let pre_v1_json = br#"{
            "schemaVersion": 1,
            "behavior": {
                "fileWatcherEnabled": true,
                "notifyOnAgentDone": true,
                "experimentalLayout": true
            }
        }"#;
        let parsed: Settings = serde_json::from_slice(pre_v1_json).expect("parse");
        assert!(parsed.behavior.notify_on_swarm_done);
        assert!(parsed.behavior.notify_on_agent_done);
    }

    /// Tier 2 schema-migration test (QoL 1.168 S1-2): a settings.json written
    /// before `confirmQuitWithWorkingSessions` existed loads with it on and its
    /// other fields kept; a saved `false` ("Don't ask again") survives a save
    /// through the store and a reload.
    #[test]
    fn legacy_settings_loads_with_confirm_quit_with_working_sessions_on() {
        let old = br#"{
            "schemaVersion": 1,
            "appearance": { "theme": "dark" },
            "behavior": { "fileWatcherEnabled": false, "windowsCloseAction": "tray" }
        }"#;
        let parsed: Settings = serde_json::from_slice(old).expect("parse");
        assert!(parsed.behavior.confirm_quit_with_working_sessions);
        assert!(!parsed.behavior.file_watcher_enabled, "other fields kept");
        assert_eq!(parsed.behavior.windows_close_action, WindowsCloseAction::Tray);
        assert!(BehaviorSettings::default().confirm_quit_with_working_sessions);

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SETTINGS_FILE), old).unwrap();
        let store = SettingsStore::new(dir.path().to_path_buf()).unwrap();
        let mut next = store.snapshot();
        assert!(next.behavior.confirm_quit_with_working_sessions);
        next.behavior.confirm_quit_with_working_sessions = false;
        store.replace(next).unwrap();
        let on_disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(SETTINGS_FILE)).unwrap())
                .unwrap();
        assert_eq!(on_disk["behavior"]["confirmQuitWithWorkingSessions"], false);
        let reloaded = SettingsStore::new(dir.path().to_path_buf()).unwrap().snapshot();
        assert!(!reloaded.behavior.confirm_quit_with_working_sessions);
        assert_eq!(reloaded.appearance.theme, ThemePref::Dark);
    }

    /// Tier 2 schema-migration test (Windows close choice): a settings.json
    /// written before `windowsCloseAction` existed loads as `Ask` with its
    /// other fields kept; an unknown value reads as `Ask` instead of resetting
    /// the file; a chosen `quit` survives a save through the store and a
    /// reload.
    #[test]
    fn legacy_settings_loads_with_windows_close_action_ask() {
        let old = br#"{
            "schemaVersion": 1,
            "appearance": { "theme": "dark" },
            "behavior": {
                "fileWatcherEnabled": false,
                "openOn": "board"
            }
        }"#;
        let parsed: Settings = serde_json::from_slice(old).expect("parse");
        assert_eq!(parsed.behavior.windows_close_action, WindowsCloseAction::Ask);
        assert!(!parsed.behavior.file_watcher_enabled, "other fields kept");
        assert_eq!(BehaviorSettings::default().windows_close_action, WindowsCloseAction::Ask);

        let unknown = br#"{ "behavior": { "windowsCloseAction": "minimize", "fileWatcherEnabled": false } }"#;
        let parsed: Settings = serde_json::from_slice(unknown).expect("an unknown value still parses");
        assert_eq!(parsed.behavior.windows_close_action, WindowsCloseAction::Ask);
        assert!(!parsed.behavior.file_watcher_enabled);

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SETTINGS_FILE), old).unwrap();
        let store = SettingsStore::new(dir.path().to_path_buf()).unwrap();
        let mut next = store.snapshot();
        assert_eq!(next.behavior.windows_close_action, WindowsCloseAction::Ask);
        assert_eq!(next.behavior.open_on, Some(OpenOn::Board));
        next.behavior.windows_close_action = WindowsCloseAction::Quit;
        store.replace(next).unwrap();
        let on_disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(SETTINGS_FILE)).unwrap())
                .unwrap();
        assert_eq!(on_disk["behavior"]["windowsCloseAction"], "quit");
        let reloaded = SettingsStore::new(dir.path().to_path_buf()).unwrap().snapshot();
        assert_eq!(reloaded.behavior.windows_close_action, WindowsCloseAction::Quit);
        assert_eq!(reloaded.appearance.theme, ThemePref::Dark);
    }

    /// Tier 2 schema-migration test: a settings.json written before the
    /// session-waiting notification had its own toggle loads with
    /// `notifyOnSessionWaiting` on — even when runs' `notifyOnAgentDone` was
    /// off, since the two are independent now — and an explicit `false`
    /// survives a load, a save through the store and a reload.
    #[test]
    fn legacy_settings_loads_with_notify_on_session_waiting_default_true() {
        let old = br#"{
            "schemaVersion": 1,
            "behavior": {
                "fileWatcherEnabled": true,
                "notifyOnAgentDone": false,
                "notifyOnSwarmDone": true
            }
        }"#;
        let parsed: Settings = serde_json::from_slice(old).expect("parse");
        assert!(parsed.behavior.notify_on_session_waiting);
        assert!(!parsed.behavior.notify_on_agent_done, "the run toggle kept its value");
        assert!(BehaviorSettings::default().notify_on_session_waiting);

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SETTINGS_FILE), old).unwrap();
        let store = SettingsStore::new(dir.path().to_path_buf()).unwrap();
        let mut next = store.snapshot();
        assert!(next.behavior.notify_on_session_waiting);
        next.behavior.notify_on_session_waiting = false;
        let saved = store.replace(next).unwrap();
        assert!(!saved.behavior.notify_on_session_waiting);
        let on_disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(SETTINGS_FILE)).unwrap())
                .unwrap();
        assert_eq!(on_disk["behavior"]["notifyOnSessionWaiting"], false);
        let reloaded = SettingsStore::new(dir.path().to_path_buf()).unwrap().snapshot();
        assert!(!reloaded.behavior.notify_on_session_waiting, "false round-trips");
        assert!(!reloaded.behavior.notify_on_agent_done);
    }

    /// Tier 2 schema-migration test: a settings.json that predates the
    /// role-boundary toggle loads with `notify_swarm_role_boundary` defaulting
    /// to `false` (opt-in, additive). Pairs with the swarm-done test above.
    #[test]
    fn legacy_settings_loads_with_notify_swarm_role_boundary_default_false() {
        let pre_role_boundary_json = br#"{
            "schemaVersion": 1,
            "behavior": {
                "fileWatcherEnabled": true,
                "notifyOnAgentDone": true,
                "experimentalLayout": true,
                "notifyOnSwarmDone": true
            }
        }"#;
        let parsed: Settings =
            serde_json::from_slice(pre_role_boundary_json).expect("parse");
        assert!(!parsed.behavior.notify_swarm_role_boundary);
        assert!(parsed.behavior.notify_on_swarm_done);
    }

    /// v1.1.1 Tier 2: a v1.0 / v1.1.0 settings.json (no `autoResumeSuspended`)
    /// loads with the new field defaulting to `false` (opt-in, additive). The
    /// behavior matches the fresh-install default.
    #[test]
    fn legacy_settings_loads_with_auto_resume_suspended_default_false() {
        let pre_v1_1_1_json = br#"{
            "schemaVersion": 1,
            "behavior": {
                "fileWatcherEnabled": true,
                "notifyOnAgentDone": true,
                "experimentalLayout": true,
                "notifyOnSwarmDone": true,
                "notifySwarmRoleBoundary": false
            }
        }"#;
        let parsed: Settings =
            serde_json::from_slice(pre_v1_1_1_json).expect("parse");
        assert!(!parsed.behavior.auto_resume_suspended);
        // v1.5.0 (S2): pre-1.5 settings default the new field to Some(30).
        assert_eq!(parsed.behavior.swarm_artifact_retention_days, Some(30));
    }

    /// Tier 2 schema-migration test: a settings.json that predates the
    /// `autoCloseFinishedRunTiles` toggle loads with the new field
    /// defaulting to `true` (matches the fresh-install default).
    #[test]
    fn legacy_settings_loads_with_auto_close_finished_run_tiles_default_true() {
        let pre_auto_close_json = br#"{
            "schemaVersion": 1,
            "behavior": {
                "fileWatcherEnabled": true,
                "notifyOnAgentDone": true,
                "experimentalLayout": true,
                "notifyOnSwarmDone": true,
                "notifySwarmRoleBoundary": false,
                "autoResumeSuspended": false
            }
        }"#;
        let parsed: Settings =
            serde_json::from_slice(pre_auto_close_json).expect("parse");
        assert!(parsed.behavior.auto_close_finished_run_tiles);
    }

    /// v1.35.0 Tier 2: a pre-memory settings.json (no
    /// `injectGlobalMemories`) loads with the new field defaulting to
    /// `false` (opt-in, additive). Pairs with the v1.30.0 test above —
    /// realistic mid-history fixture missing only the latest field.
    #[test]
    fn legacy_settings_loads_with_inject_global_memories_default_false() {
        let pre_memory_json = br#"{
            "schemaVersion": 1,
            "behavior": {
                "fileWatcherEnabled": true,
                "notifyOnAgentDone": true,
                "experimentalLayout": true,
                "notifyOnSwarmDone": true,
                "autoResumeSuspended": false,
                "maxConcurrentCardSwarms": 5
            }
        }"#;
        let parsed: Settings =
            serde_json::from_slice(pre_memory_json).expect("parse");
        assert!(!parsed.behavior.inject_global_memories);
        // Adjacent fields still survive the migration.
        assert_eq!(parsed.behavior.max_concurrent_card_swarms, 5);
    }

    /// v1.30.0 Tier 2: a pre-parallel-swarms settings.json (no
    /// `maxConcurrentCardSwarms`) loads with the new field defaulting to 3,
    /// matching the fresh-install default.
    #[test]
    fn legacy_settings_loads_with_max_concurrent_card_swarms_default_3() {
        let pre_parallel_json = br#"{
            "schemaVersion": 1,
            "behavior": {
                "fileWatcherEnabled": true,
                "notifyOnAgentDone": true,
                "experimentalLayout": true,
                "notifyOnSwarmDone": true,
                "autoResumeSuspended": false
            }
        }"#;
        let parsed: Settings =
            serde_json::from_slice(pre_parallel_json).expect("parse");
        assert_eq!(parsed.behavior.max_concurrent_card_swarms, 3);
        assert_eq!(parsed.card_swarm_cap(), 3);
    }

    /// `card_swarm_cap()` clamps a hand-edited or out-of-range value into
    /// the safe [1, 20] band.
    #[test]
    fn card_swarm_cap_clamps_out_of_range() {
        let mut s = Settings::default();
        s.behavior.max_concurrent_card_swarms = 0;
        assert_eq!(s.card_swarm_cap(), 1, "0 must clamp up to 1");
        s.behavior.max_concurrent_card_swarms = 999;
        assert_eq!(s.card_swarm_cap(), 20, "huge value must clamp to 20");
        s.behavior.max_concurrent_card_swarms = 5;
        assert_eq!(s.card_swarm_cap(), 5, "in-range value passes through");
    }

    /// 1.173.0 (C2) Tier 2: a settings.json from before the device group
    /// loads with no id and no name, every other field kept; the first
    /// `ensure_device` makes the id, keeps it, and saves atomically.
    #[test]
    fn legacy_settings_loads_without_a_device_and_ensure_device_fills_it_once() {
        let pre_device = br#"{
            "schemaVersion": 1,
            "appearance": { "theme": "system" },
            "behavior": { "fileWatcherEnabled": true },
            "identity": { "userEmail": "owner@example.com" },
            "projects": { "folder": "~/Projects" }
        }"#;
        let parsed: Settings = serde_json::from_slice(pre_device).expect("parse");
        assert_eq!(parsed.device, DeviceSettings::default());
        assert_eq!(parsed.projects.folder.as_deref(), Some("~/Projects"));
        assert_eq!(parsed.identity.user_email.as_deref(), Some("owner@example.com"));
        // Unset, the group is left out of the file.
        let json = serde_json::to_value(&parsed).unwrap();
        assert_eq!(json["device"], serde_json::json!({}));

        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(SETTINGS_FILE), pre_device).unwrap();
        let store = SettingsStore::new(tmp.path().to_path_buf()).unwrap();
        let first = store.ensure_device(|| "Mac mini".to_string(), || "hw-1".to_string()).unwrap();
        assert_eq!(first.name, "Mac mini");
        assert!(uuid::Uuid::parse_str(&first.id).is_ok());
        let reopened = SettingsStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(reopened.snapshot().device.id.as_deref(), Some(first.id.as_str()));
        assert_eq!(reopened.snapshot().identity.user_email.as_deref(), Some("owner@example.com"));
        // Renamed: the same id, the new name.
        let renamed = reopened.ensure_device(|| "Studio Mac".to_string(), || "hw-1".to_string()).unwrap();
        assert_eq!((renamed.id.as_str(), renamed.name.as_str()), (first.id.as_str(), "Studio Mac"));
        // A name that can't be read keeps the one before.
        let unread = reopened.ensure_device(String::new, String::new).unwrap();
        assert_eq!(unread.name, "Studio Mac");
        // Copied to another computer (Migration Assistant): a new id.
        let moved = reopened.ensure_device(|| "Studio Mac".to_string(), || "hw-2".to_string()).unwrap();
        assert_ne!(moved.id, first.id);
        assert_eq!(reopened.snapshot().device.hardware.as_deref(), Some("hw-2"));
        // A fingerprint that can't be read keeps the id.
        let unread_hw = reopened.ensure_device(|| "Studio Mac".to_string(), String::new).unwrap();
        assert_eq!(unread_hw.id, moved.id);
        let first = moved;
        // A frontend save never resets it.
        let mut from_fe = reopened.snapshot();
        from_fe.device = DeviceSettings::default();
        assert_eq!(reopened.replace(from_fe).unwrap().device.id.as_deref(), Some(first.id.as_str()));
    }

    /// 1.174.0 (A4) Tier 2: a 1.173 settings.json (no `nextImprovement`)
    /// loads with no slate views, every other field kept, and writes no key
    /// for it; a view saved from the frontend round-trips through an atomic
    /// save; an entry that can't be read is dropped on its own.
    #[test]
    fn settings_1173_load_without_slate_views_and_a_saved_view_round_trips() {
        let settings_1173 = br#"{
            "schemaVersion": 1,
            "appearance": { "theme": "system" },
            "identity": { "userEmail": "owner@example.com" },
            "projects": { "folder": "~/Projects" },
            "device": { "id": "d-1", "name": "Mac mini" }
        }"#;
        let parsed: Settings = serde_json::from_slice(settings_1173).expect("parse");
        assert_eq!(parsed.next_improvement, NextImprovementSettings::default());
        assert_eq!(parsed.device.name.as_deref(), Some("Mac mini"));
        assert_eq!(parsed.projects.folder.as_deref(), Some("~/Projects"));
        let json = serde_json::to_value(&parsed).unwrap();
        assert_eq!(json["nextImprovement"], serde_json::json!({}));

        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(SETTINGS_FILE), settings_1173).unwrap();
        let store = SettingsStore::new(tmp.path().to_path_buf()).unwrap();
        let mut next = store.snapshot();
        next.next_improvement.view.insert(
            "ws-1::site".to_string(),
            NiSlateView { seen_round: Some("r7".to_string()), collapsed: Some(false) },
        );
        store.replace(next).unwrap();
        let reopened = SettingsStore::new(tmp.path().to_path_buf()).unwrap();
        let view = reopened.snapshot().next_improvement.view;
        assert_eq!(view.get("ws-1::site").and_then(|v| v.seen_round.as_deref()), Some("r7"));
        assert_eq!(view.get("ws-1::site").and_then(|v| v.collapsed), Some(false));
        assert_eq!(reopened.snapshot().identity.user_email.as_deref(), Some("owner@example.com"));
        // The file on disk carries the camelCase keys.
        let on_disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(tmp.path().join(SETTINGS_FILE)).unwrap()).unwrap();
        assert_eq!(
            on_disk["nextImprovement"]["view"]["ws-1::site"],
            serde_json::json!({ "seenRound": "r7", "collapsed": false })
        );

        // A hand-edited entry of the wrong shape goes alone; a view that is
        // not an object is empty.
        let odd = br#"{ "nextImprovement": { "view": {
            "ws-1::": { "seenRound": "r1" },
            "ws-2::": 5,
            "ws-3::": { "seenRound": 9, "collapsed": true }
        } } }"#;
        let parsed: Settings = serde_json::from_slice(odd).expect("parse");
        let view = parsed.next_improvement.view;
        assert_eq!(view.len(), 2);
        assert_eq!(view["ws-1::"].seen_round.as_deref(), Some("r1"));
        assert_eq!(view["ws-3::"], NiSlateView { seen_round: None, collapsed: Some(true) });
        let parsed: Settings = serde_json::from_slice(br#"{ "nextImprovement": { "view": [] } }"#).expect("parse");
        assert!(parsed.next_improvement.view.is_empty());
    }

    /// 1.174.0 (A6) Tier 2: a 1.173 settings.json (no `firstCardShippedAt`)
    /// loads with none and writes no key for it, the slate views kept; a time
    /// saved from the frontend round-trips through an atomic save, and a
    /// value that isn't an ISO time is none.
    #[test]
    fn settings_1173_load_without_first_card_shipped_and_a_saved_time_round_trips() {
        let settings_1173 = br#"{
            "schemaVersion": 1,
            "identity": { "userEmail": "owner@example.com" },
            "nextImprovement": { "view": { "ws-1::": { "seenRound": "r1" } } }
        }"#;
        let parsed: Settings = serde_json::from_slice(settings_1173).expect("parse");
        assert_eq!(parsed.next_improvement.first_card_shipped_at, None);
        assert_eq!(parsed.next_improvement.view["ws-1::"].seen_round.as_deref(), Some("r1"));
        let json = serde_json::to_value(&parsed).unwrap();
        assert!(json["nextImprovement"].get("firstCardShippedAt").is_none());

        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(SETTINGS_FILE), settings_1173).unwrap();
        let store = SettingsStore::new(tmp.path().to_path_buf()).unwrap();
        let mut next = store.snapshot();
        next.next_improvement.first_card_shipped_at = Some("2026-10-31T09:00:00.000Z".to_string());
        store.replace(next).unwrap();
        let reopened = SettingsStore::new(tmp.path().to_path_buf()).unwrap();
        let ni = reopened.snapshot().next_improvement;
        assert_eq!(ni.first_card_shipped_at.as_deref(), Some("2026-10-31T09:00:00.000Z"));
        assert_eq!(ni.view["ws-1::"].seen_round.as_deref(), Some("r1"));
        assert_eq!(reopened.snapshot().identity.user_email.as_deref(), Some("owner@example.com"));
        let on_disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(tmp.path().join(SETTINGS_FILE)).unwrap()).unwrap();
        assert_eq!(on_disk["nextImprovement"]["firstCardShippedAt"], "2026-10-31T09:00:00.000Z");

        for odd in [
            br#"{ "nextImprovement": { "firstCardShippedAt": "yesterday", "opensSince": "soon" } }"#.as_slice(),
            br#"{ "nextImprovement": { "firstCardShippedAt": 5, "opensSince": true } }"#.as_slice(),
        ] {
            let parsed: Settings = serde_json::from_slice(odd).expect("parse");
            assert_eq!(parsed.next_improvement.first_card_shipped_at, None);
            assert_eq!(parsed.next_improvement.opens_since, None);
        }

        // Round 1: `opensSince` loads as none from 1.173 and round-trips.
        assert_eq!(serde_json::from_slice::<Settings>(settings_1173).unwrap().next_improvement.opens_since, None);
        let mut next = reopened.snapshot();
        next.next_improvement.opens_since = Some("2026-10-31T10:00:00.000Z".to_string());
        reopened.replace(next).unwrap();
        let again = SettingsStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(again.snapshot().next_improvement.opens_since.as_deref(), Some("2026-10-31T10:00:00.000Z"));

        // Neither record is ever cleared by a save (a stale frontend copy).
        let mut stale = again.snapshot();
        stale.next_improvement = NextImprovementSettings::default();
        let saved = again.replace(stale).unwrap();
        assert_eq!(saved.next_improvement.first_card_shipped_at.as_deref(), Some("2026-10-31T09:00:00.000Z"));
        assert_eq!(saved.next_improvement.opens_since.as_deref(), Some("2026-10-31T10:00:00.000Z"));
    }

    /// 1.174.0 (A6 round 1): the launch backfill writes the earliest ship
    /// once, in ISO-8601, and keeps a time already there.
    #[test]
    fn backfill_first_card_shipped_writes_once() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(tmp.path().to_path_buf()).unwrap();
        assert!(!store.backfill_first_card_shipped(None).unwrap());
        assert_eq!(store.snapshot().next_improvement.first_card_shipped_at, None);
        let at = 1_790_000_000_000_i64;
        assert!(store.backfill_first_card_shipped(Some(at)).unwrap());
        let written = store.snapshot().next_improvement.first_card_shipped_at.unwrap();
        assert!(is_iso_time(&written), "{written}");
        assert_eq!(chrono::DateTime::parse_from_rfc3339(&written).unwrap().timestamp_millis(), at);
        assert!(!store.backfill_first_card_shipped(Some(at - 1)).unwrap());
        let reopened = SettingsStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(reopened.snapshot().next_improvement.first_card_shipped_at.as_deref(), Some(written.as_str()));
    }

    #[test]
    fn device_names_fall_back_to_the_kept_one_then_a_word() {
        assert_eq!(device_name_or("  Mac mini \n", None), "Mac mini");
        assert_eq!(device_name_or("", Some("MacBook Pro")), "MacBook Pro");
        assert_eq!(device_name_or("   ", Some("")), if cfg!(windows) { "PC" } else { "Mac" });
        assert_eq!(device_name_or("DESKTOP-\"X\"", None), "DESKTOP-'X'");
    }

    /// v1.32.0 Tier 2: a pre-v1.32.0 settings.json (no `onboarding` key) loads
    /// with `firstRunCompletedAt` defaulting to `None` — an upgrading user is
    /// treated as not-yet-past-first-run (the startup backfill in `lib.rs`
    /// then clears it when workspaces already exist).
    #[test]
    fn legacy_settings_loads_with_onboarding_first_run_none() {
        let pre_v1_32_json = br#"{
            "schemaVersion": 1,
            "appearance": { "theme": "system" },
            "shell": { "pathOverride": null },
            "behavior": { "fileWatcherEnabled": true }
        }"#;
        let parsed: Settings = serde_json::from_slice(pre_v1_32_json).expect("parse");
        assert_eq!(parsed.onboarding.first_run_completed_at, None);
    }

    /// v1.114.0 Tier 2 (team sharing rung 1): a settings.json written
    /// before Settings → Team had a clone root loads with `None`, which
    /// means "the default" — not an empty path. The value round-trips.
    #[test]
    fn legacy_settings_loads_with_team_clone_root_none() {
        let pre_team_sharing = br#"{
            "schemaVersion": 1,
            "appearance": { "theme": "system" },
            "behavior": { "fileWatcherEnabled": true },
            "identity": { "userEmail": "owner@example.com" }
        }"#;
        let parsed: Settings = serde_json::from_slice(pre_team_sharing).expect("parse");
        assert_eq!(parsed.team.clone_root, None);
        assert_eq!(
            parsed.identity.user_email.as_deref(),
            Some("owner@example.com")
        );

        let with_root = br#"{ "schemaVersion": 1, "team": { "cloneRoot": "~/work" } }"#;
        let parsed: Settings = serde_json::from_slice(with_root).expect("parse");
        assert_eq!(parsed.team.clone_root.as_deref(), Some("~/work"));
        let json = serde_json::to_string(&parsed).expect("serialize");
        assert!(json.contains(r#""cloneRoot":"~/work""#));
    }

    /// v1.118.0 Tier 2 (team sharing rung 5): a settings.json written by any
    /// earlier version — including one that already had a clone root — loads
    /// with an empty ignore list, and the list round-trips. Ignoring a repo
    /// has to survive a restart or the same proposals come back forever.
    #[test]
    fn legacy_settings_loads_with_no_ignored_discovery_repos() {
        let pre_rung_5 = br#"{
            "schemaVersion": 1,
            "team": { "cloneRoot": "~/work" }
        }"#;
        let parsed: Settings = serde_json::from_slice(pre_rung_5).expect("parse");
        assert_eq!(parsed.team.clone_root.as_deref(), Some("~/work"));
        assert!(parsed.team.ignored_repos.is_empty());

        let with_ignores =
            br#"{ "schemaVersion": 1, "team": { "ignoredRepos": ["owner/scratch"] } }"#;
        let parsed: Settings = serde_json::from_slice(with_ignores).expect("parse");
        assert_eq!(parsed.team.ignored_repos, vec!["owner/scratch".to_string()]);
        // The clone root is still the default when only the ignore list is set.
        assert_eq!(parsed.team.clone_root, None);
        let json = serde_json::to_string(&parsed).expect("serialize");
        assert!(json.contains(r#""ignoredRepos":["owner/scratch"]"#));
    }

    /// OB-8 Tier 2: a settings.json written before the board offer loads with
    /// no answers and writes its sharing block as it was; answers round-trip,
    /// switch sides, and survive a stale frontend save.
    #[test]
    fn board_offer_answers_load_from_older_files_and_are_backend_owned() {
        let older = br#"{ "schemaVersion": 1, "sharing": { "notOnThisMac": ["owner/lyra"] } }"#;
        let parsed: Settings = serde_json::from_slice(older).expect("parse");
        assert!(parsed.sharing.github_board_moved.is_empty());
        assert!(parsed.sharing.github_board_kept_local.is_empty());
        let json = serde_json::to_value(&parsed).unwrap();
        assert_eq!(json["sharing"], serde_json::json!({ "notOnThisMac": ["owner/lyra"] }));

        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path().to_path_buf()).unwrap();
        let stale = store.snapshot();
        store.set_board_choice("owner/lyra", false).unwrap();
        assert_eq!(store.snapshot().sharing.github_board_kept_local, vec!["owner/lyra"]);
        // Keys compare lowercase (P3-4): a hand-written "Owner/Lyra" is the
        // same repository and goes when the other answer is recorded.
        let mut mixed = store.snapshot();
        mixed.sharing.github_board_kept_local = vec!["Owner/Lyra".into()];
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            serde_json::to_vec(&mixed).unwrap(),
        )
        .unwrap();
        let store = SettingsStore::new(dir.path().to_path_buf()).unwrap();
        store.set_board_choice("OWNER/lyra", true).unwrap();
        let saved = store.replace(stale).unwrap();
        assert_eq!(saved.sharing.github_board_moved, vec!["owner/lyra"]);
        assert!(saved.sharing.github_board_kept_local.is_empty());
        let reopened = SettingsStore::new(dir.path().to_path_buf()).unwrap().snapshot();
        assert_eq!(reopened.sharing.github_board_moved, vec!["owner/lyra"]);
    }

    /// GH #81 Tier 2: a settings.json written before adoption loads with no
    /// declined repositories, and a "Not on this Mac" answer round-trips.
    #[test]
    fn legacy_settings_loads_with_no_declined_sharing_repos() {
        let pre_adoption = br#"{
            "schemaVersion": 1,
            "team": { "ignoredRepos": ["owner/scratch"] }
        }"#;
        let parsed: Settings = serde_json::from_slice(pre_adoption).expect("parse");
        assert!(parsed.sharing.not_on_this_mac.is_empty());
        assert_eq!(parsed.team.ignored_repos, vec!["owner/scratch".to_string()]);

        let declined = br#"{ "schemaVersion": 1, "sharing": { "notOnThisMac": ["owner/lyra"] } }"#;
        let parsed: Settings = serde_json::from_slice(declined).expect("parse");
        assert_eq!(parsed.sharing.not_on_this_mac, vec!["owner/lyra".to_string()]);
        let json = serde_json::to_string(&parsed).expect("serialize");
        assert!(json.contains(r#""notOnThisMac":["owner/lyra"]"#));
    }

    /// UX language card 1 Tier 2: a settings.json written before the
    /// Settings modal remembered its size loads with no size (the default
    /// 1100 × 800); a saved size round-trips and the rest is untouched.
    #[test]
    fn legacy_settings_loads_without_window_sizes() {
        let legacy = br#"{
            "schemaVersion": 1,
            "appearance": { "theme": "dark", "accent": "cyan" },
            "sharing": { "notOnThisMac": ["owner/lyra"] }
        }"#;
        let parsed: Settings = serde_json::from_slice(legacy).expect("parse");
        assert_eq!(parsed.windows, WindowSizes::default());
        assert_eq!(parsed.windows.settings, None);
        assert_eq!(parsed.appearance.accent, AccentPreset::Cyan);
        assert_eq!(parsed.sharing.not_on_this_mac, vec!["owner/lyra".to_string()]);

        let sized = br#"{ "schemaVersion": 1, "windows": { "settings": { "width": 960, "height": 700 } } }"#;
        let parsed: Settings = serde_json::from_slice(sized).expect("parse");
        assert_eq!(
            parsed.windows.settings,
            Some(SurfaceSize { width: 960, height: 700 })
        );
        let json = serde_json::to_string(&parsed).expect("serialize");
        // An unset settingsPage stays out of the file, like the sidebar layout.
        assert!(json.contains(
            r#""windows":{"settings":{"width":960,"height":700}}"#
        ));

        let empty = br#"{ "schemaVersion": 1, "windows": {} }"#;
        let parsed: Settings = serde_json::from_slice(empty).expect("parse");
        assert_eq!(parsed.windows.settings, None);
    }

    /// UX-9.4 Tier 2: a settings.json written before Settings remembered its
    /// last page loads with none (Settings opens on Appearance), keeps the
    /// size it had, and a remembered page round-trips beside the size.
    #[test]
    fn legacy_settings_loads_without_settings_page() {
        let legacy = br#"{ "schemaVersion": 1, "windows": { "settings": { "width": 960, "height": 700 } } }"#;
        let parsed: Settings = serde_json::from_slice(legacy).expect("parse");
        assert_eq!(parsed.windows.settings_page, None);
        assert_eq!(
            parsed.windows.settings,
            Some(SurfaceSize { width: 960, height: 700 })
        );

        let remembered = br#"{ "schemaVersion": 1, "windows": { "settingsPage": "claude-codex" } }"#;
        let parsed: Settings = serde_json::from_slice(remembered).expect("parse");
        assert_eq!(parsed.windows.settings_page.as_deref(), Some("claude-codex"));
        assert_eq!(parsed.windows.settings, None);
        let json = serde_json::to_string(&parsed).expect("serialize");
        assert!(json.contains(r#""settingsPage":"claude-codex""#));
        let back: Settings = serde_json::from_str(&json).expect("round-trip");
        assert_eq!(back.windows, parsed.windows);
    }

    /// UX-3.4 Tier 2: a settings.json written before the sidebar remembered its
    /// width loads with no sidebar layout (240 px, shown) and keeps the Settings
    /// modal's size; a saved layout round-trips, and `collapsed` defaults off.
    #[test]
    fn legacy_settings_loads_without_sidebar_layout() {
        let pre_card = br#"{
            "schemaVersion": 1,
            "appearance": { "theme": "dark", "accent": "cyan" },
            "windows": { "settings": { "width": 960, "height": 700 } }
        }"#;
        let parsed: Settings = serde_json::from_slice(pre_card).expect("parse");
        assert_eq!(parsed.windows.sidebar, None);
        assert_eq!(
            parsed.windows.settings,
            Some(SurfaceSize { width: 960, height: 700 })
        );
        assert_eq!(parsed.appearance.accent, AccentPreset::Cyan);

        let saved = br#"{ "schemaVersion": 1, "windows": { "sidebar": { "width": 280, "collapsed": true } } }"#;
        let parsed: Settings = serde_json::from_slice(saved).expect("parse");
        assert_eq!(
            parsed.windows.sidebar,
            Some(SidebarLayout { width: 280, collapsed: true })
        );
        let json = serde_json::to_string(&parsed).expect("serialize");
        assert!(json.contains(r#""sidebar":{"width":280,"collapsed":true}"#));

        let width_only = br#"{ "schemaVersion": 1, "windows": { "sidebar": { "width": 210 } } }"#;
        let parsed: Settings = serde_json::from_slice(width_only).expect("parse");
        assert_eq!(
            parsed.windows.sidebar,
            Some(SidebarLayout { width: 210, collapsed: false })
        );
    }

    /// GH #100 Tier 2: a settings.json written before `Keep both` existed loads
    /// with nothing silenced, and a silenced pair round-trips with its two
    /// content ids — which are what makes the record expire when either copy
    /// changes, so losing them would silence a notice forever.
    #[test]
    fn legacy_settings_loads_with_no_silenced_duplicates() {
        let pre_card = br#"{
            "schemaVersion": 1,
            "appearance": { "theme": "dark", "accent": "cyan" },
            "windows": { "settings": { "width": 960, "height": 700 } },
            "sharing": { "notOnThisMac": ["owner/lyra"] }
        }"#;
        let parsed: Settings = serde_json::from_slice(pre_card).expect("parse");
        assert_eq!(parsed.library, LibrarySettings::default());
        assert!(parsed.library.silenced_duplicates.is_empty());
        // The neighbours an old file did carry are untouched by the addition.
        assert_eq!(
            parsed.windows.settings,
            Some(SurfaceSize { width: 960, height: 700 })
        );
        assert_eq!(parsed.sharing.not_on_this_mac, vec!["owner/lyra".to_string()]);
        assert_eq!(parsed.appearance.accent, AccentPreset::Cyan);

        let silenced = br#"{
            "schemaVersion": 1,
            "library": {
                "silencedDuplicates": [
                    {
                        "scopes": "repository|team",
                        "name": "deploy",
                        "contents": ["1f4a-8c", "90b2-11"]
                    }
                ]
            }
        }"#;
        let parsed: Settings = serde_json::from_slice(silenced).expect("parse");
        assert_eq!(
            parsed.library.silenced_duplicates,
            vec![SilencedDuplicate {
                scopes: "repository|team".to_string(),
                name: "deploy".to_string(),
                contents: vec!["1f4a-8c".to_string(), "90b2-11".to_string()],
            }],
        );
        let json = serde_json::to_string(&parsed).expect("serialize");
        // Up to the list's own `]` and no further: the claim is that the pair and
        // both content ids survive, not that `library` holds nothing else — GH
        // #106 added a second field to the same block, and a closing brace in the
        // pattern would have made this test fail for a reason it is not about.
        assert!(
            json.contains(
                r#""library":{"silencedDuplicates":[{"scopes":"repository|team","name":"deploy","contents":["1f4a-8c","90b2-11"]}]"#
            ),
            "the pair and both content ids survive a round trip: {json}",
        );

        // A half-written record — the block present, the list absent — is the
        // same as nothing silenced rather than a parse failure that would reset
        // the member's whole settings file.
        let block_only = br#"{ "schemaVersion": 1, "library": {} }"#;
        let parsed: Settings = serde_json::from_slice(block_only).expect("parse");
        assert!(parsed.library.silenced_duplicates.is_empty());
    }

    /// GH #106 Tier 2: a settings.json written before Ply had skills of its own
    /// loads with **all of them on**, which is an absent `plySkillsOff`; a Mac
    /// that has switched one off round-trips exactly that name; and the two
    /// `library` fields do not disturb each other.
    #[test]
    fn legacy_settings_loads_with_every_ply_skill_switched_on() {
        // The file a member upgrading from #100 or #105 has: a `library` block
        // that knows about silenced duplicates and nothing about Ply skills.
        let pre_card = br#"{
            "schemaVersion": 1,
            "appearance": { "theme": "dark", "accent": "cyan" },
            "library": {
                "silencedDuplicates": [
                    { "scopes": "repository|team", "name": "deploy", "contents": ["1f4a-8c", "90b2-11"] }
                ]
            }
        }"#;
        let parsed: Settings = serde_json::from_slice(pre_card).expect("parse");
        assert!(
            parsed.library.ply_skills_off.is_empty(),
            "an absent list is every Plyloft skill switched on",
        );
        // The neighbour in the same block survives the addition.
        assert_eq!(parsed.library.silenced_duplicates.len(), 1);
        assert_eq!(parsed.appearance.accent, AccentPreset::Cyan);
        // And the default-constructed settings say the same thing.
        assert!(Settings::default().library.ply_skills_off.is_empty());

        let with_one_off = br#"{
            "schemaVersion": 1,
            "library": { "plySkillsOff": ["release-notes"] }
        }"#;
        let parsed: Settings = serde_json::from_slice(with_one_off).expect("parse");
        assert_eq!(parsed.library.ply_skills_off, vec!["release-notes".to_string()]);
        // Nothing was silenced in that file, and nothing is invented.
        assert!(parsed.library.silenced_duplicates.is_empty());

        let json = serde_json::to_string(&parsed).expect("serialize");
        assert!(
            json.contains(r#""plySkillsOff":["release-notes"]"#),
            "the switched-off name survives a round trip: {json}",
        );
        let round_tripped: Settings = serde_json::from_str(&json).expect("reparse");
        assert_eq!(round_tripped.library, parsed.library);
    }

    /// Skills hub H10 Tier 2 (§5.9): a settings.json from before My library
    /// loads with none; `myLibrary` without `account` (§5.9 Challenger) loads
    /// with gh's active account; the record round-trips; and a frontend save
    /// that doesn't carry it keeps it.
    #[test]
    fn settings_without_my_library_load_and_a_frontend_save_keeps_it() {
        let before = br#"{ "schemaVersion": 1, "library": { "plySkillsOff": ["x"] } }"#;
        let parsed: Settings = serde_json::from_slice(before).expect("parse");
        assert!(parsed.library.my_library.is_none());
        assert_eq!(parsed.library.ply_skills_off, vec!["x".to_string()]);
        let json = serde_json::to_string(&parsed).expect("serialize");
        assert!(!json.contains("myLibrary"), "absent stays absent: {json}");

        let no_account = br#"{ "schemaVersion": 1, "library": { "myLibrary": { "repo": "matteo/plyloft-skills", "later": 1 } } }"#;
        let parsed: Settings = serde_json::from_slice(no_account).expect("parse");
        let mine = parsed.library.my_library.clone().expect("my library");
        assert_eq!(mine.repo, "matteo/plyloft-skills");
        assert_eq!(mine.account, None);

        let dir = tempfile::tempdir().expect("tmp");
        let store = SettingsStore::new(dir.path().to_path_buf()).expect("store");
        store
            .set_my_library(Some(MyLibrarySettings { repo: "matteo/plyloft-skills".into(), account: Some("matteo".into()) }))
            .expect("set");
        // A save from a window that read the settings before (no myLibrary).
        let mut stale = Settings::default();
        stale.library.my_library = None;
        let saved = store.replace(stale).expect("replace");
        assert_eq!(saved.library.my_library.as_ref().map(|m| m.repo.as_str()), Some("matteo/plyloft-skills"));
        let reread = SettingsStore::new(dir.path().to_path_buf()).expect("reopen").snapshot();
        assert_eq!(reread.library.my_library.and_then(|m| m.account), Some("matteo".to_string()));
        store.set_my_library(None).expect("stop");
        assert!(store.snapshot().library.my_library.is_none());
    }

    /// v1.49.0 Tier 2 (Team Mode Phase 0): a pre-team-mode settings.json
    /// (no `identity` key) loads with `userEmail` defaulting to `None`. The
    /// startup backfill in `lib.rs::setup` then populates it from
    /// `git config --global user.email` when available. Adjacent
    /// fields survive the migration.
    #[test]
    fn legacy_settings_loads_with_identity_user_email_none() {
        let pre_team_json = br#"{
            "schemaVersion": 1,
            "appearance": { "theme": "system" },
            "behavior": {
                "fileWatcherEnabled": true,
                "notifyOnAgentDone": true,
                "experimentalLayout": true
            },
            "onboarding": { "firstRunCompletedAt": "2026-05-19T12:00:00Z" }
        }"#;
        let parsed: Settings = serde_json::from_slice(pre_team_json).expect("parse");
        assert_eq!(parsed.identity.user_email, None);
        assert_eq!(
            parsed.onboarding.first_run_completed_at.as_deref(),
            Some("2026-05-19T12:00:00Z")
        );
    }

    /// UX-4.3 Tier 2: a fresh install opens on the Inbox.
    #[test]
    fn fresh_install_opens_on_the_inbox() {
        assert_eq!(BehaviorSettings::default().open_on, Some(OpenOn::Inbox));
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["behavior"]["openOn"], "inbox");
        assert!(v["behavior"].get("landOnBoard").is_none());
    }

    /// v1.107.0 Tier 2: a settings.json written before the Builder vendor
    /// setting existed loads with Claude; the camelCase value round-trips.
    #[test]
    fn legacy_settings_loads_with_builder_vendor_claude() {
        let pre = br#"{ "schemaVersion": 1, "behavior": { "fileWatcherEnabled": true } }"#;
        let parsed: Settings = serde_json::from_slice(pre).expect("parse");
        assert_eq!(parsed.behavior.builder_vendor, BuilderVendor::Claude);
        let codex = br#"{ "schemaVersion": 1, "behavior": { "builderVendor": "codex" } }"#;
        let parsed2: Settings = serde_json::from_slice(codex).expect("parse");
        assert_eq!(parsed2.behavior.builder_vendor, BuilderVendor::Codex);
        assert_eq!(parsed2.behavior.builder_vendor.as_str(), "codex");
        let back = serde_json::to_value(&parsed2).unwrap();
        assert_eq!(back["behavior"]["builderVendor"].as_str(), Some("codex"));
    }

    /// 1.171.0 (K7) Tier 2: a settings.json written before the last
    /// Builder choice was remembered loads with none, so Settings' Builder
    /// decides as before; a remembered one wins for a new card, round-trips
    /// in camelCase and isn't written while absent; a value this Plyloft
    /// doesn't know reads as none instead of failing the file.
    #[test]
    fn legacy_settings_loads_with_no_last_builder_vendor() {
        let pre = br#"{ "schemaVersion": 1, "behavior": { "builderVendor": "codex" } }"#;
        let parsed: Settings = serde_json::from_slice(pre).expect("parse");
        assert_eq!(parsed.behavior.last_builder_vendor, None);
        assert_eq!(parsed.behavior.new_card_builder_vendor(), BuilderVendor::Codex);
        let back = serde_json::to_value(&parsed).unwrap();
        assert!(back["behavior"].get("lastBuilderVendor").is_none(), "{back}");
        let chosen = br#"{ "schemaVersion": 1, "behavior": { "builderVendor": "claude", "lastBuilderVendor": "codex", "builderPermissions": "editsCopy" } }"#;
        let parsed: Settings = serde_json::from_slice(chosen).expect("parse");
        assert_eq!(parsed.behavior.last_builder_vendor, Some(BuilderVendor::Codex));
        assert_eq!(parsed.behavior.new_card_builder_vendor(), BuilderVendor::Codex);
        assert_eq!(parsed.behavior.builder_permissions, BuilderPermissions::EditsCopy, "independent fields");
        let back = serde_json::to_value(&parsed).unwrap();
        assert_eq!(back["behavior"]["lastBuilderVendor"], "codex");
        let unknown = br#"{ "schemaVersion": 1, "behavior": { "lastBuilderVendor": "gemini" } }"#;
        let parsed: Settings = serde_json::from_slice(unknown).expect("parse");
        assert_eq!(parsed.behavior.last_builder_vendor, None);
        assert_eq!(parsed.behavior.new_card_builder_vendor(), BuilderVendor::Claude);
        assert_eq!(BehaviorSettings::default().last_builder_vendor, None);
    }

    /// 1.171.0 (D1) Tier 2: a settings.json written before the Builder
    /// permissions default existed loads with `Asks` (owner D3); a saved
    /// choice round-trips in camelCase; a value this Plyloft doesn't know
    /// reads as `Asks` instead of failing the whole file.
    #[test]
    fn a_settings_file_from_1_174_5_checks_fix_rounds_by_itself() {
        // 1.175.0 (F5, owner I7): on by default, also in a file that never had it.
        let pre = br#"{ "schemaVersion": 1, "behavior": { "builderVendor": "codex", "confirmQuitWithWorkingSessions": false } }"#;
        let parsed: Settings = serde_json::from_slice(pre).expect("parse");
        assert!(parsed.behavior.check_fix_rounds_by_itself);
        assert!(!parsed.behavior.confirm_quit_with_working_sessions, "the rest is kept");
        assert!(BehaviorSettings::default().check_fix_rounds_by_itself);
        let off = br#"{ "schemaVersion": 1, "behavior": { "checkFixRoundsByItself": false } }"#;
        let parsed: Settings = serde_json::from_slice(off).expect("parse");
        assert!(!parsed.behavior.check_fix_rounds_by_itself);
        assert_eq!(serde_json::to_value(&parsed).unwrap()["behavior"]["checkFixRoundsByItself"], false);
    }

    #[test]
    fn legacy_settings_loads_with_builder_permissions_asks() {
        let pre = br#"{ "schemaVersion": 1, "behavior": { "builderVendor": "codex" } }"#;
        let parsed: Settings = serde_json::from_slice(pre).expect("parse");
        assert_eq!(parsed.behavior.builder_permissions, BuilderPermissions::Asks);
        assert_eq!(parsed.behavior.builder_vendor, BuilderVendor::Codex);
        assert_eq!(BehaviorSettings::default().builder_permissions, BuilderPermissions::Asks);
        let saved = br#"{ "schemaVersion": 1, "behavior": { "builderPermissions": "editsCopy" } }"#;
        let parsed: Settings = serde_json::from_slice(saved).expect("parse");
        assert_eq!(parsed.behavior.builder_permissions, BuilderPermissions::EditsCopy);
        let back = serde_json::to_value(&parsed).unwrap();
        assert_eq!(back["behavior"]["builderPermissions"], "editsCopy");
        let newer = br#"{ "schemaVersion": 1, "behavior": { "builderPermissions": "askLater", "builderVendor": "codex" } }"#;
        let parsed: Settings = serde_json::from_slice(newer).expect("parse");
        assert_eq!(parsed.behavior.builder_permissions, BuilderPermissions::Asks);
        assert_eq!(parsed.behavior.builder_vendor, BuilderVendor::Codex);
    }

    /// #74 Tier 2: a settings.json written before `behavior.models`
    /// existed loads with every row blank — which is "pass no model", so
    /// the vendor CLIs keep deciding exactly as they did. Set values
    /// round-trip in camelCase, and blank / whitespace-only text is the
    /// same as absent.
    #[test]
    fn legacy_settings_loads_without_the_models_block() {
        let pre = br#"{ "schemaVersion": 1, "behavior": { "builderVendor": "codex" } }"#;
        let parsed: Settings = serde_json::from_slice(pre).expect("parse");
        assert_eq!(parsed.behavior.models, RoleModels::default());
        for vendor in ["claude", "codex"] {
            for role in [AgentRole::Builder, AgentRole::Challenger] {
                assert!(parsed.behavior.models.for_role(vendor, role).is_empty());
            }
        }

        let set = br#"{
            "schemaVersion": 1,
            "behavior": {
              "models": {
                "claude": { "builder": "opus", "challenger": "sonnet" },
                "codex": {
                  "challenger": "gpt-6-astra",
                  "challengerReasoning": "medium",
                  "builder": "  ",
                  "builderReasoning": ""
                }
              }
            }
          }"#;
        let parsed: Settings = serde_json::from_slice(set).expect("parse");
        let models = &parsed.behavior.models;
        assert_eq!(
            models.for_role("claude", AgentRole::Builder).model.as_deref(),
            Some("opus")
        );
        assert!(models
            .for_role("claude", AgentRole::Builder)
            .reasoning
            .is_none());
        assert_eq!(
            models
                .for_role("claude", AgentRole::Challenger)
                .model
                .as_deref(),
            Some("sonnet")
        );
        let codex_challenger = models.for_role("codex", AgentRole::Challenger);
        assert_eq!(codex_challenger.model.as_deref(), Some("gpt-6-astra"));
        assert_eq!(codex_challenger.reasoning.as_deref(), Some("medium"));
        assert_eq!(codex_challenger.label().as_deref(), Some("gpt-6-astra medium"));
        // Blank and whitespace-only mean "the CLI's default".
        assert!(models.for_role("codex", AgentRole::Builder).is_empty());

        let back = serde_json::to_value(&parsed).unwrap();
        assert_eq!(
            back["behavior"]["models"]["codex"]["challengerReasoning"].as_str(),
            Some("medium")
        );
        assert_eq!(
            back["behavior"]["models"]["claude"]["builder"].as_str(),
            Some("opus")
        );
        // No schema bump: the block is additive.
        assert_eq!(parsed.schema_version, CURRENT_SCHEMA_VERSION);
    }

    /// 1.169.0 (A1) migration: a settings.json from 1.168 (models block
    /// with no Claude effort, a saved Codex `minimal`), a workspace's
    /// `models` and a card's `models` load unchanged — no Claude effort, the
    /// `minimal` kept — and write back without any new key.
    #[test]
    fn a1_files_before_claude_effort_load_and_write_back_unchanged() {
        let settings_1168 = br#"{
            "schemaVersion": 1,
            "behavior": { "models": {
                "claude": { "builder": "opus", "challenger": null },
                "codex": { "builder": "gpt-6-astra", "builderReasoning": "minimal" }
            } }
        }"#;
        let parsed: Settings = serde_json::from_slice(settings_1168).expect("parse");
        let models = &parsed.behavior.models;
        assert_eq!(models.claude.builder_reasoning, None);
        assert_eq!(models.claude.challenger_reasoning, None);
        assert_eq!(models.for_role("claude", AgentRole::Builder), ModelChoice { model: Some("opus".into()), reasoning: None });
        assert_eq!(models.codex.builder_reasoning.as_deref(), Some("minimal"), "a saved minimal is kept");
        let back = serde_json::to_value(&parsed).unwrap();
        let claude = back["behavior"]["models"]["claude"].as_object().unwrap();
        assert!(!claude.contains_key("builderReasoning") && !claude.contains_key("challengerReasoning"));
        assert_eq!(parsed.schema_version, CURRENT_SCHEMA_VERSION);

        let ws_1168 = r#"{"claude":{"builder":"sonnet"},"codex":{"challengerReasoning":"low"},"cliDefault":["claude.challenger"]}"#;
        let ws: WorkspaceModels = serde_json::from_str(ws_1168).unwrap();
        assert_eq!(ws.rows.claude.builder_reasoning, None);
        assert_eq!(ws.normalized().as_ref(), Some(&ws));
        let again: serde_json::Value = serde_json::to_value(&ws).unwrap();
        assert_eq!(again, serde_json::from_str::<serde_json::Value>(
            r#"{"claude":{"builder":"sonnet","challenger":null},"codex":{"builder":null,"challenger":null,"builderReasoning":null,"challengerReasoning":"low"},"cliDefault":["claude.challenger"]}"#
        ).unwrap());
    }

    /// 1.169.0 (A1): Claude's effort is layered like every other field —
    /// card over workspace over app, a forced field passes nothing — and
    /// travels as `--effort` next to `--model`.
    #[test]
    fn a1_claude_effort_resolves_card_over_workspace_over_app() {
        let mut app = app_rows();
        app.claude.builder_reasoning = Some("high".into());
        assert_eq!(resolve_model(None, &app, "claude", AgentRole::Builder), ModelChoice { model: Some("opus".into()), reasoning: Some("high".into()) });
        assert_eq!(resolve_model(None, &app, "claude", AgentRole::Challenger).reasoning, None);

        let mut ws = WorkspaceModels::default();
        ws.rows.claude.builder_reasoning = Some(" xhigh ".into());
        assert_eq!(resolve_model(Some(&ws), &app, "claude", AgentRole::Builder).reasoning.as_deref(), Some("xhigh"));
        assert_eq!(resolve_model(Some(&ws), &app, "claude", AgentRole::Builder).model.as_deref(), Some("opus"));

        let mut card = WorkspaceModels::default();
        card.rows.claude.builder_reasoning = Some("max".into());
        assert_eq!(resolve_card_model(Some(&card), Some(&ws), &app, "claude", AgentRole::Builder).reasoning.as_deref(), Some("max"));
        card.rows.claude.builder_reasoning = None;
        card.cli_default = vec!["claude.builderReasoning".into()];
        assert_eq!(resolve_card_model(Some(&card), Some(&ws), &app, "claude", AgentRole::Builder), ModelChoice { model: Some("opus".into()), reasoning: None });
        // The forced key is one of the known names, and normalizing keeps it.
        assert!(MODEL_FIELD_KEYS.contains(&model_field_key("claude", AgentRole::Builder, true)));
        assert_eq!(card.normalized().unwrap().cli_default, vec!["claude.builderReasoning".to_string()]);
        let mut forced_ws = WorkspaceModels::default();
        forced_ws.rows.claude.challenger_reasoning = Some("low".into());
        forced_ws.cli_default = vec!["claude.challengerReasoning".into()];
        assert_eq!(forced_ws.normalized().unwrap().rows.claude.challenger_reasoning, None, "forced wins");

        let both = ModelChoice { model: Some("opus".into()), reasoning: Some("high".into()) };
        assert_eq!(both.claude_flags(), ["--model", "opus", "--effort", "high"]);
        assert_eq!(ModelChoice { model: None, reasoning: Some("low".into()) }.claude_flags(), ["--effort", "low"]);
        assert!(ModelChoice::default().claude_flags().is_empty());
        assert_eq!(both.label_for("claude").as_deref(), Some("opus high"));
        assert_eq!(ModelChoice { model: None, reasoning: Some("low".into()) }.label_for("claude").as_deref(), Some("low effort"));
        assert_eq!(ModelChoice { model: None, reasoning: Some("low".into()) }.label_for("codex").as_deref(), Some("low effort"));
    }

    /// Walk 2026-10-23: a recorded label in a sentence.
    #[test]
    fn a_recorded_label_reads_with_its_effort_in_a_sentence() {
        assert_eq!(split_model_label("gpt-6-astra high"), (Some("gpt-6-astra"), Some("high")));
        assert_eq!(split_model_label("opus"), (Some("opus"), None));
        assert_eq!(split_model_label("low effort"), (None, Some("low")));
        assert_eq!(split_model_label("low reasoning"), (None, Some("low")));
        assert_eq!(split_model_label("  "), (None, None));
        assert_eq!(ModelChoice::sentence_label("gpt-6-astra high"), "gpt-6-astra with high effort");
        assert_eq!(ModelChoice::sentence_label("sonnet"), "sonnet");
        assert_eq!(ModelChoice::sentence_label("max effort"), "max effort");
    }

    /// 1.169.0 (A2): the team's suggestion sits between my workspace and my
    /// app, field by field; a forced workspace field still passes nothing.
    #[test]
    fn a2_team_suggestions_sit_between_the_workspace_and_the_app() {
        let app = app_rows();
        let mut team = RoleModels::default();
        team.codex.builder = Some("gpt-6.1-sol".into());
        team.claude.challenger_reasoning = Some("max".into());
        // No workspace choice: the team's model, the app's effort below it.
        assert_eq!(
            resolve_model_with_team(None, Some(&team), &app, "codex", AgentRole::Builder),
            ModelChoice { model: Some("gpt-6.1-sol".into()), reasoning: Some("high".into()) }
        );
        assert_eq!(
            resolve_model_with_team(None, Some(&team), &app, "claude", AgentRole::Challenger),
            ModelChoice { model: Some("sonnet".into()), reasoning: Some("max".into()) }
        );
        // My workspace's own choice wins over the team's.
        let mut ws = WorkspaceModels::default();
        ws.rows.codex.builder = Some("gpt-6-luna".into());
        assert_eq!(
            resolve_model_with_team(Some(&ws), Some(&team), &app, "codex", AgentRole::Builder).model.as_deref(),
            Some("gpt-6-luna")
        );
        // Forced to the tool's default in the workspace: no flag, whatever the team says.
        ws.cli_default = vec!["claude.challengerReasoning".into()];
        assert_eq!(
            resolve_model_with_team(Some(&ws), Some(&team), &app, "claude", AgentRole::Challenger).reasoning,
            None
        );
        // The card is first.
        let mut card = WorkspaceModels::default();
        card.rows.codex.builder = Some("gpt-7".into());
        assert_eq!(
            resolve_card_model_with_team(Some(&card), None, Some(&team), &app, "codex", AgentRole::Builder).model.as_deref(),
            Some("gpt-7")
        );
        // No team: exactly as before.
        for vendor in ["claude", "codex"] {
            for role in [AgentRole::Builder, AgentRole::Challenger] {
                assert_eq!(resolve_model_with_team(Some(&ws), None, &app, vendor, role), resolve_model(Some(&ws), &app, vendor, role));
            }
        }
    }

    /// A2: a spawn reads the team's suggestion from this Mac's store.
    #[test]
    fn a2_a_spawn_reads_the_team_s_suggestion() {
        use tauri::Manager;
        let tmp = tempfile::tempdir().unwrap();
        let settings = SettingsStore::new(tmp.path().join("settings")).unwrap();
        let configs = crate::project_config::ProjectConfigStore::new(tmp.path().join("projects")).unwrap();
        let mut team = crate::team_models::TeamModels::default();
        team.codex.challenger = Some("gpt-6-luna".into());
        crate::team_models::save(&configs, "ws", &team).unwrap();
        crate::team_models::share_for_test(&configs, "ws", false);
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(settings);
        let h = app.handle();
        assert!(model_for_workspace(h, "ws", "codex", AgentRole::Challenger).model.is_none(), "no store yet");
        app.manage(configs);
        assert_eq!(model_for_workspace(h, "ws", "codex", AgentRole::Challenger).model.as_deref(), Some("gpt-6-luna"));
        assert_eq!(model_for_card(h, "ws", None, "codex", AgentRole::Challenger).model.as_deref(), Some("gpt-6-luna"));
        assert!(model_for_workspace(h, "other", "codex", AgentRole::Challenger).model.is_none());
    }

    /// A2 (Challenger 5): an effort that doesn't fit the model falls to the
    /// next layer's; a forced layer stops the walk; none fitting passes none.
    #[test]
    fn a2_an_effort_that_does_not_fit_falls_to_the_next_layer() {
        let mut app = RoleModels::default();
        app.codex.builder_reasoning = Some("high".into());
        let mut team = RoleModels::default();
        team.codex.builder = Some("gpt-6-luna".into());
        team.codex.builder_reasoning = Some("ultra".into());
        let luna = |_: Option<&str>, e: &str| e != "ultra";
        let fitted = resolve_card_model_fitted(None, None, Some(&team), &app, "codex", AgentRole::Builder, &luna);
        assert_eq!(fitted, ModelChoice { model: Some("gpt-6-luna".into()), reasoning: Some("high".into()) });
        // Everything fits: exactly the plain resolution.
        let all = |_: Option<&str>, _: &str| true;
        assert_eq!(
            resolve_card_model_fitted(None, None, Some(&team), &app, "codex", AgentRole::Builder, &all),
            resolve_card_model_with_team(None, None, Some(&team), &app, "codex", AgentRole::Builder)
        );
        // A workspace forcing the tool's default stops it: no flag.
        let ws = WorkspaceModels { rows: RoleModels::default(), cli_default: vec!["codex.builderReasoning".into()] };
        assert_eq!(resolve_card_model_fitted(None, Some(&ws), Some(&team), &app, "codex", AgentRole::Builder, &luna).reasoning, None);
        // None fits: none.
        let none = |_: Option<&str>, _: &str| false;
        assert_eq!(resolve_card_model_fitted(None, None, Some(&team), &app, "codex", AgentRole::Builder, &none).reasoning, None);
        // The card's own unfitting effort falls too.
        let mut card = WorkspaceModels::default();
        card.rows.codex.builder_reasoning = Some("ultra".into());
        assert_eq!(
            resolve_card_model_fitted(Some(&card), None, None, &app, "codex", AgentRole::Builder, &luna).reasoning.as_deref(),
            Some("high")
        );
    }

    fn app_rows() -> RoleModels {
        RoleModels {
            claude: ClaudeModels {
                builder: Some("opus".into()),
                challenger: Some("sonnet".into()),
                ..Default::default()
            },
            codex: CodexModels {
                builder: Some("gpt-6-astra".into()),
                challenger: Some("gpt-5.5".into()),
                builder_reasoning: Some("high".into()),
                challenger_reasoning: Some("medium".into()),
            },
        }
    }

    fn ws_rows(rows: RoleModels) -> WorkspaceModels {
        WorkspaceModels { rows, cli_default: Vec::new() }
    }

    /// CL-4: no workspace override reads the app row unchanged, for every
    /// vendor and role.
    #[test]
    fn resolve_model_without_a_workspace_override_is_the_app_row() {
        let app = app_rows();
        for vendor in ["claude", "codex"] {
            for role in [AgentRole::Builder, AgentRole::Challenger] {
                assert_eq!(resolve_model(None, &app, vendor, role), app.for_role(vendor, role));
            }
        }
        assert!(resolve_model(None, &RoleModels::default(), "codex", AgentRole::Builder).is_empty());
    }

    /// CL-4: a blank or whitespace workspace field falls back to the app
    /// row; a set one wins, field by field.
    #[test]
    fn resolve_model_merges_field_by_field() {
        let app = app_rows();
        let mut rows = RoleModels::default();
        rows.claude.builder = Some("   ".into());
        rows.claude.challenger = Some("claude-fable-5-1".into());
        let ws = ws_rows(rows);
        assert_eq!(
            resolve_model(Some(&ws), &app, "claude", AgentRole::Builder).model.as_deref(),
            Some("opus")
        );
        assert_eq!(
            resolve_model(Some(&ws), &app, "claude", AgentRole::Challenger).model.as_deref(),
            Some("claude-fable-5-1")
        );
        assert_eq!(
            resolve_model(Some(&ws), &app, "codex", AgentRole::Builder),
            app.for_role("codex", AgentRole::Builder)
        );
    }

    /// CL-4: workspace reasoning without a workspace model keeps the app's
    /// model; a workspace model without reasoning keeps the app's effort.
    #[test]
    fn resolve_model_respects_reasoning_set_without_a_model() {
        let app = app_rows();
        let mut rows = RoleModels::default();
        rows.codex.challenger_reasoning = Some("low".into());
        rows.codex.builder = Some("gpt-7".into());
        let ws = ws_rows(rows);
        let challenger = resolve_model(Some(&ws), &app, "codex", AgentRole::Challenger);
        assert_eq!(challenger.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(challenger.reasoning.as_deref(), Some("low"));
        let builder = resolve_model(Some(&ws), &app, "codex", AgentRole::Builder);
        assert_eq!(builder.model.as_deref(), Some("gpt-7"));
        assert_eq!(builder.reasoning.as_deref(), Some("high"));
        let alone = resolve_model(Some(&ws), &RoleModels::default(), "codex", AgentRole::Challenger);
        assert_eq!(alone, ModelChoice { model: None, reasoning: Some("low".into()) });
        assert_eq!(resolve_model(Some(&ws), &app, "claude", AgentRole::Builder).reasoning, None);
    }

    /// CL-4: the whole chain — forced CLI default, else workspace, else app,
    /// else none (CLI default).
    #[test]
    fn resolve_model_precedence_chain() {
        let mut app = RoleModels::default();
        let mut ws = WorkspaceModels::default();
        let pick = |ws: &WorkspaceModels, app: &RoleModels| {
            resolve_model(Some(ws), app, "claude", AgentRole::Builder).model
        };
        assert_eq!(pick(&ws, &app), None);
        app.claude.builder = Some("sonnet".into());
        assert_eq!(pick(&ws, &app).as_deref(), Some("sonnet"));
        ws.rows.claude.builder = Some("opus".into());
        assert_eq!(pick(&ws, &app).as_deref(), Some("opus"));
        app.claude.builder = None;
        assert_eq!(pick(&ws, &app).as_deref(), Some("opus"));
        // Round 2: forced to the CLI default beats both.
        app.claude.builder = Some("sonnet".into());
        ws.cli_default = vec!["claude.builder".into()];
        assert_eq!(pick(&ws, &app), None);
    }

    /// CL-4 round 2: "CLI default" forces no flag even when the app row sets
    /// one, per field: a forced Codex effort keeps the app's model, a forced
    /// model keeps the app's effort.
    #[test]
    fn resolve_model_honours_a_forced_cli_default_per_field() {
        let app = app_rows();
        let ws = WorkspaceModels {
            rows: RoleModels::default(),
            cli_default: vec!["codex.challengerReasoning".into(), "codex.builder".into()],
        };
        let challenger = resolve_model(Some(&ws), &app, "codex", AgentRole::Challenger);
        assert_eq!(challenger, ModelChoice { model: Some("gpt-5.5".into()), reasoning: None });
        let builder = resolve_model(Some(&ws), &app, "codex", AgentRole::Builder);
        assert_eq!(builder, ModelChoice { model: None, reasoning: Some("high".into()) });
        // Claude untouched.
        assert_eq!(
            resolve_model(Some(&ws), &app, "claude", AgentRole::Builder).model.as_deref(),
            Some("opus")
        );
        // Unknown names are ignored by the merge.
        let odd = WorkspaceModels { rows: RoleModels::default(), cli_default: vec!["codex.someday".into()] };
        assert_eq!(resolve_model(Some(&odd), &app, "codex", AgentRole::Builder), app.for_role("codex", AgentRole::Builder));
        for key in MODEL_FIELD_KEYS {
            assert!(key.starts_with("claude.") || key.starts_with("codex."));
        }
    }

    /// CL-4: normalizing trims, drops blanks, reads all-blank as None, and a
    /// forced field drops its value.
    #[test]
    fn workspace_models_normalized_drops_blanks_and_forced_values() {
        assert_eq!(WorkspaceModels::default().normalized(), None);
        let mut blank = WorkspaceModels::default();
        blank.rows.claude.builder = Some("  ".into());
        blank.rows.codex.builder_reasoning = Some("".into());
        blank.cli_default = vec![" ".into()];
        assert_eq!(blank.normalized(), None);
        let mut some = WorkspaceModels::default();
        some.rows.claude.builder = Some(" opus ".into());
        some.rows.codex.challenger = Some(" ".into());
        some.rows.claude.challenger = Some("sonnet".into());
        some.cli_default = vec!["claude.challenger".into()];
        let n = some.normalized().unwrap();
        assert_eq!(n.rows.claude.builder.as_deref(), Some("opus"));
        assert_eq!(n.rows.codex.challenger, None);
        assert_eq!(n.rows.claude.challenger, None);
        assert_eq!(n.cli_default, vec!["claude.challenger".to_string()]);
    }

    /// CL-4 (F4): the live lookup reads both stores — the open workspace's
    /// rows for its own id, the app row for any other, and a forced CLI
    /// default as no flag.
    #[test]
    fn model_for_workspace_reads_both_stores() {
        use tauri::Manager;
        let tmp = tempfile::tempdir().unwrap();
        let settings = SettingsStore::new(tmp.path().join("settings")).unwrap();
        let mut s = settings.snapshot();
        s.behavior.models = app_rows();
        settings.replace(s).unwrap();
        let ws_dir = tmp.path().join("ws");
        std::fs::create_dir_all(&ws_dir).unwrap();
        std::fs::write(
            ws_dir.join("workspaces.json"),
            br#"{"workspaces":[
                {"id":"ws-a","name":"a","cwd":"/tmp/a","createdAt":1,"lastOpenedAt":1},
                {"id":"ws-b","name":"b","cwd":"/tmp/b","createdAt":1,"lastOpenedAt":1}
            ],"activeWorkspaceId":"ws-a"}"#,
        )
        .unwrap();
        let workspaces = crate::workspace::WorkspaceStore::new(ws_dir).unwrap();
        let mut own = WorkspaceModels::default();
        own.rows.claude.builder = Some("claude-fable-5-1".into());
        own.cli_default = vec!["codex.challengerReasoning".into()];
        workspaces.set_models("ws-a", Some(own)).unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        // Before the stores are managed: nothing, the CLI default.
        assert!(model_for_workspace(app.handle(), "ws-a", "claude", AgentRole::Builder).is_empty());
        app.manage(settings);
        app.manage(workspaces);
        let h = app.handle();
        assert_eq!(
            model_for_workspace(h, "ws-a", "claude", AgentRole::Builder).model.as_deref(),
            Some("claude-fable-5-1")
        );
        assert_eq!(
            model_for_workspace(h, "ws-b", "claude", AgentRole::Builder).model.as_deref(),
            Some("opus")
        );
        assert_eq!(
            model_for_workspace(h, "ws-a", "codex", AgentRole::Challenger),
            ModelChoice { model: Some("gpt-5.5".into()), reasoning: None }
        );
        assert_eq!(
            model_for_workspace(h, "ws-b", "codex", AgentRole::Challenger).reasoning.as_deref(),
            Some("medium")
        );
        assert_eq!(
            model_for_workspace(h, "gone", "claude", AgentRole::Challenger).model.as_deref(),
            Some("sonnet")
        );
    }

    /// 1.168.1 (E2): a card's own choice wins over the workspace and the
    /// app, field by field; blank falls through; forced passes nothing.
    #[test]
    fn resolve_card_model_puts_the_card_first() {
        let app = app_rows();
        let mut ws = WorkspaceModels::default();
        ws.rows.claude.builder = Some("claude-fable-5-1".into());
        ws.rows.codex.builder_reasoning = Some("low".into());
        // No card choice: exactly the workspace's resolution.
        for vendor in ["claude", "codex"] {
            for role in [AgentRole::Builder, AgentRole::Challenger] {
                assert_eq!(
                    resolve_card_model(None, Some(&ws), &app, vendor, role),
                    resolve_model(Some(&ws), &app, vendor, role)
                );
                assert_eq!(
                    resolve_card_model(Some(&WorkspaceModels::default()), Some(&ws), &app, vendor, role),
                    resolve_model(Some(&ws), &app, vendor, role)
                );
            }
        }
        let mut card = WorkspaceModels::default();
        card.rows.claude.builder = Some("sonnet".into());
        card.rows.codex.builder = Some("gpt-7".into());
        card.rows.claude.challenger = Some("  ".into());
        assert_eq!(resolve_card_model(Some(&card), Some(&ws), &app, "claude", AgentRole::Builder).model.as_deref(), Some("sonnet"));
        // Blank on the card: the app's (the workspace sets none).
        assert_eq!(resolve_card_model(Some(&card), Some(&ws), &app, "claude", AgentRole::Challenger).model.as_deref(), Some("sonnet"));
        // The card's model, the workspace's effort.
        assert_eq!(
            resolve_card_model(Some(&card), Some(&ws), &app, "codex", AgentRole::Builder),
            ModelChoice { model: Some("gpt-7".into()), reasoning: Some("low".into()) }
        );
        // Forced on the card: no flag, whatever the workspace and app say.
        card.cli_default = vec!["codex.builderReasoning".into(), "claude.builder".into()];
        assert_eq!(
            resolve_card_model(Some(&card), Some(&ws), &app, "codex", AgentRole::Builder),
            ModelChoice { model: Some("gpt-7".into()), reasoning: None }
        );
        assert!(resolve_card_model(Some(&card), Some(&ws), &app, "claude", AgentRole::Builder).is_empty());
        // Nothing anywhere: the CLI's own default.
        assert!(resolve_card_model(None, None, &RoleModels::default(), "codex", AgentRole::Challenger).is_empty());
    }

    /// 1.168.1 (E2): the live card lookup reads the card's own choice from
    /// the board, over the workspace and the app; an unknown card, or no
    /// board, reads as no card choice.
    fn kanban_models<R: tauri::Runtime>(h: &tauri::AppHandle<R>, card: &str) -> Option<WorkspaceModels> {
        use tauri::Manager;
        h.state::<crate::kanban::KanbanStore>().get_card("ws", card).ok().and_then(|c| c.models)
    }

    #[test]
    fn model_for_card_id_reads_the_board_first() {
        use tauri::Manager;
        let tmp = tempfile::tempdir().unwrap();
        let settings = SettingsStore::new(tmp.path().join("settings")).unwrap();
        let mut s = settings.snapshot();
        s.behavior.models = app_rows();
        settings.replace(s).unwrap();
        let kanban = crate::kanban::KanbanStore::new(tmp.path().join("k")).unwrap();
        let mut card = crate::kanban::KanbanCard::new("c1".into(), "ws".into(), "T".into(), None, crate::kanban::KanbanColumnId::Todo);
        let mut own = WorkspaceModels::default();
        own.rows.codex.challenger = Some("gpt-7".into());
        own.cli_default = vec!["claude.builder".into()];
        // 1.169.0 (A1): a saved `minimal` on a model the catalog lists
        // without it; and a Claude effort.
        own.rows.codex.builder = Some("gpt-6-astra".into());
        own.rows.codex.builder_reasoning = Some("minimal".into());
        own.rows.claude.challenger_reasoning = Some("xhigh".into());
        card.models = Some(own);
        kanban.create_card("ws", card).unwrap();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(settings);
        let h = app.handle();
        // No board yet: the app's row.
        assert_eq!(model_for_card_id(h, "ws", "c1", "claude", AgentRole::Builder).model.as_deref(), Some("opus"));
        app.manage(kanban);
        assert!(model_for_card_id(h, "ws", "c1", "claude", AgentRole::Builder).is_empty(), "forced on the card");
        assert_eq!(
            model_for_card_id(h, "ws", "c1", "codex", AgentRole::Challenger),
            ModelChoice { model: Some("gpt-7".into()), reasoning: Some("medium".into()) }
        );
        assert_eq!(model_for_card_id(h, "ws", "other", "claude", AgentRole::Builder).model.as_deref(), Some("opus"));
        // The card's effort the model is known not to take falls to the
        // next layer's (A2, Challenger 5): the app's "high"…
        assert_eq!(
            model_for_card_id(h, "ws", "c1", "codex", AgentRole::Builder),
            ModelChoice { model: Some("gpt-6-astra".into()), reasoning: Some("high".into()) }
        );
        // …and Claude's effort only on a Claude Code known to take it
        // (finding 1): what this process probed, if anything, decides.
        let takes_effort = crate::model_catalog::current().claude_effort;
        assert_eq!(
            model_for_card_id(h, "ws", "c1", "claude", AgentRole::Challenger),
            ModelChoice { model: Some("sonnet".into()), reasoning: takes_effort.then(|| "xhigh".into()) }
        );
        assert_eq!(
            resolve_card_model(
                kanban_models(h, "c1").as_ref(),
                None,
                &app_rows(),
                "claude",
                AgentRole::Challenger
            ),
            ModelChoice { model: Some("sonnet".into()), reasoning: Some("xhigh".into()) },
            "resolved before the version rule"
        );
    }

    /// #47 Tier 2: a settings.json written before dictation existed loads
    /// with it on, `small`, `auto`; set values round-trip; an unknown model
    /// or language falls back to its default without resetting the file.
    #[test]
    fn legacy_settings_loads_with_dictation_defaults() {
        use crate::dictation::{DictationLanguage, DictationModel};
        let pre = br#"{ "schemaVersion": 1, "behavior": { "fileWatcherEnabled": false } }"#;
        let parsed: Settings = serde_json::from_slice(pre).expect("parse");
        assert!(!parsed.behavior.file_watcher_enabled);
        assert_eq!(parsed.behavior.dictation, DictationSettings::default());
        assert!(parsed.behavior.dictation.enabled);
        assert_eq!(parsed.behavior.dictation.model, DictationModel::Small);
        assert_eq!(parsed.behavior.dictation.language, DictationLanguage::Auto);

        let set = br#"{ "schemaVersion": 1, "behavior": { "dictation": { "enabled": false, "model": "base", "language": "it" } } }"#;
        let parsed2: Settings = serde_json::from_slice(set).expect("parse");
        assert!(!parsed2.behavior.dictation.enabled);
        assert_eq!(parsed2.behavior.dictation.model, DictationModel::Base);
        assert_eq!(parsed2.behavior.dictation.language, DictationLanguage::It);
        let back = serde_json::to_value(&parsed2).unwrap();
        assert_eq!(
            back["behavior"]["dictation"],
            serde_json::json!({ "enabled": false, "model": "base", "language": "it" })
        );

        let partial = br#"{ "schemaVersion": 1, "appearance": { "theme": "dark" }, "behavior": { "dictation": { "model": "large-v9", "language": 7 } } }"#;
        let parsed3: Settings = serde_json::from_slice(partial).expect("unknown values do not fail the parse");
        assert_eq!(parsed3.appearance.theme, ThemePref::Dark);
        assert!(parsed3.behavior.dictation.enabled);
        assert_eq!(parsed3.behavior.dictation.model, DictationModel::Small);
        assert_eq!(parsed3.behavior.dictation.language, DictationLanguage::Auto);
    }

    /// G4 (launch D8) Tier 2 schema migration: the swarm UI is gone. A
    /// settings.json written with `"advancedSwarms": true` and the swarm
    /// settings set by hand loads, untouched on disk; a save shaped like
    /// today's frontend — which carries neither `advancedSwarms`, the two
    /// swarm notifications nor the card-swarm cap — keeps the notifications
    /// and the cap a card still finishing its swarm reads, drops
    /// `advancedSwarms`, and a relaunch reads the same.
    #[test]
    fn tier2_g4_old_settings_with_advanced_swarms_loads_and_keeps_swarm_values() {
        let dir = tempfile::tempdir().unwrap();
        let old = br#"{
            "schemaVersion": 1,
            "behavior": {
                "notifyOnAgentDone": true,
                "notifyOnSwarmDone": false,
                "notifySwarmRoleBoundary": true,
                "autoResumeSuspended": true,
                "maxConcurrentCardSwarms": 5,
                "advancedSwarms": true
            }
        }"#;
        std::fs::write(dir.path().join(SETTINGS_FILE), old).unwrap();
        let store = SettingsStore::new(dir.path().to_path_buf()).unwrap();
        let loaded = store.snapshot();
        assert!(!loaded.behavior.notify_on_swarm_done);
        assert!(loaded.behavior.notify_swarm_role_boundary);
        assert!(loaded.behavior.auto_resume_suspended);
        assert_eq!(loaded.card_swarm_cap(), 5);
        assert_eq!(std::fs::read(dir.path().join(SETTINGS_FILE)).unwrap(), old, "loading writes nothing");

        // Today's frontend shape: none of the four keys.
        let mut sent = serde_json::to_value(&loaded).unwrap();
        let behavior = sent["behavior"].as_object_mut().unwrap();
        assert!(!behavior.contains_key("advancedSwarms"));
        for key in ["notifyOnSwarmDone", "notifySwarmRoleBoundary", "maxConcurrentCardSwarms"] {
            behavior.remove(key);
        }
        behavior.insert("openOn".into(), serde_json::json!("board"));
        let sent: Settings = serde_json::from_value(sent).unwrap();
        assert!(sent.behavior.notify_on_swarm_done, "absent, it decodes to the default");
        let saved = store.replace(sent).unwrap();
        assert!(!saved.behavior.notify_on_swarm_done);
        assert!(saved.behavior.notify_swarm_role_boundary);
        assert_eq!(saved.card_swarm_cap(), 5);
        assert_eq!(saved.behavior.open_on, Some(OpenOn::Board), "the change itself landed");

        let on_disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(SETTINGS_FILE)).unwrap())
                .unwrap();
        let b = &on_disk["behavior"];
        assert!(b.get("advancedSwarms").is_none(), "the dead key is dropped");
        assert_eq!(b["notifyOnSwarmDone"], false);
        assert_eq!(b["notifySwarmRoleBoundary"], true);
        assert_eq!(b["maxConcurrentCardSwarms"], 5);

        let again = SettingsStore::new(dir.path().to_path_buf()).unwrap().snapshot();
        assert!(!again.behavior.notify_on_swarm_done);
        assert!(again.behavior.notify_swarm_role_boundary);
        assert_eq!(again.card_swarm_cap(), 5);

        // A file with only the old switch, either way, still parses.
        for json in [
            br#"{ "schemaVersion": 1, "behavior": { "advancedSwarms": true } }"#.as_slice(),
            br#"{ "schemaVersion": 1, "behavior": { "advancedSwarms": false } }"#.as_slice(),
        ] {
            let parsed: Settings = serde_json::from_slice(json).expect("parse");
            assert!(parsed.behavior.notify_on_swarm_done);
        }
    }

    /// UX-4.3 Tier 2 (schema migration): the `landOnBoard` boolean becomes
    /// `openOn`. A file without it (before v1.69) or with `false` opens on
    /// the Inbox; `true` opens on the Board. The old key is never written
    /// back, a file that has `openOn` keeps it, and an unknown value falls
    /// back instead of failing the file.
    #[test]
    fn legacy_land_on_board_reads_as_open_on() {
        let parse = |json: &str| SettingsStore::parse(json.as_bytes()).expect("parse");
        let absent = parse(r#"{ "schemaVersion": 1, "behavior": { "fileWatcherEnabled": true } }"#);
        assert_eq!(absent.behavior.open_on, Some(OpenOn::Inbox));
        let off = parse(r#"{ "schemaVersion": 1, "behavior": { "landOnBoard": false } }"#);
        assert_eq!(off.behavior.open_on, Some(OpenOn::Inbox));
        let on = parse(r#"{ "schemaVersion": 1, "behavior": { "landOnBoard": true } }"#);
        assert_eq!(on.behavior.open_on, Some(OpenOn::Board));
        let back = serde_json::to_value(&on).unwrap();
        assert_eq!(back["behavior"]["openOn"], "board");
        assert!(back["behavior"].get("landOnBoard").is_none(), "the old key is dropped");

        let both = parse(
            r#"{ "schemaVersion": 1, "behavior": { "landOnBoard": true, "openOn": "terminals" } }"#,
        );
        assert_eq!(both.behavior.open_on, Some(OpenOn::Terminals));
        let junk = parse(r#"{ "schemaVersion": 1, "behavior": { "openOn": "garden" } }"#);
        assert_eq!(junk.behavior.open_on, Some(OpenOn::Inbox));
        let round = parse(&serde_json::to_string(&both).unwrap());
        assert_eq!(round.behavior.open_on, Some(OpenOn::Terminals));
    }

    /// UX-4.3: a save through the store folds the old key too, and writes
    /// `openOn` atomically in its place.
    #[test]
    fn replace_folds_land_on_board_into_open_on() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path().to_path_buf()).unwrap();
        let sent: Settings = serde_json::from_str(
            r#"{ "schemaVersion": 1, "behavior": { "landOnBoard": true } }"#,
        )
        .unwrap();
        let saved = store.replace(sent).unwrap();
        assert_eq!(saved.behavior.open_on, Some(OpenOn::Board));
        let on_disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(SETTINGS_FILE)).unwrap())
                .unwrap();
        assert_eq!(on_disk["behavior"]["openOn"], "board");
        assert!(on_disk["behavior"].get("landOnBoard").is_none());
    }

    /// A settings.json carrying an `identity` block round-trips and the
    /// cached email survives.
    #[test]
    fn identity_user_email_round_trips() {
        let json = br#"{
            "schemaVersion": 1,
            "identity": { "userEmail": "m@example.com" }
        }"#;
        let parsed: Settings = serde_json::from_slice(json).expect("parse");
        assert_eq!(parsed.identity.user_email.as_deref(), Some("m@example.com"));
        let back = serde_json::to_value(&parsed).unwrap();
        assert_eq!(
            back["identity"]["userEmail"].as_str(),
            Some("m@example.com")
        );
    }

    /// A settings.json carrying an `onboarding` block round-trips and the
    /// timestamp survives.
    #[test]
    fn onboarding_first_run_completed_at_round_trips() {
        let json = br#"{
            "schemaVersion": 1,
            "onboarding": { "firstRunCompletedAt": "2026-05-19T12:00:00Z" }
        }"#;
        let parsed: Settings = serde_json::from_slice(json).expect("parse");
        assert_eq!(
            parsed.onboarding.first_run_completed_at.as_deref(),
            Some("2026-05-19T12:00:00Z")
        );
        let back = serde_json::to_value(&parsed).unwrap();
        assert_eq!(
            back["onboarding"]["firstRunCompletedAt"].as_str(),
            Some("2026-05-19T12:00:00Z")
        );
    }

    /// PPVP Tier 2: a v0.5.x settings.json must load cleanly into v0.6.0
    /// — existing theme variants keep their wire format unchanged.
    #[test]
    fn loads_v0_5_x_settings_with_existing_theme_unchanged() {
        for theme_name in ["system", "light", "dark"] {
            let json = format!(
                r#"{{"schemaVersion":1,"appearance":{{"theme":"{}"}}}}"#,
                theme_name
            );
            let parsed: Settings = serde_json::from_str(&json).expect("parse");
            // Round-trip preserves the variant
            let back = serde_json::to_value(&parsed.appearance.theme).unwrap();
            assert_eq!(back.as_str().unwrap(), theme_name);
        }
    }

    /// v0.6.0 named themes still PARSE via their original wire format.
    /// Since v1.64.0 the two retired ones (`neonTokyo`, `synthwave`) are
    /// legacy-deserializable only — the fold to theme+accent happens in
    /// `AppearanceSettings::normalize`, not in serde, so parsing alone
    /// must keep working (a serde failure would nuke the whole settings
    /// file via the corrupt-fallback path).
    #[test]
    fn v0_6_0_named_themes_still_parse() {
        for theme_name in ["void", "neonTokyo", "synthwave"] {
            let json = format!(
                r#"{{"schemaVersion":1,"appearance":{{"theme":"{}"}}}}"#,
                theme_name
            );
            let parsed: Settings = serde_json::from_str(&json).expect("parse");
            let back = serde_json::to_value(&parsed.appearance.theme).unwrap();
            assert_eq!(back.as_str().unwrap(), theme_name);
        }
    }

    /// PPVP Tier 2 (v1.64.0 themes 5→3): a pre-1.64 settings.json carrying
    /// a retired theme loads via the real `SettingsStore::load` path and
    /// comes out folded to Dark + the matching accent preset — with every
    /// other field intact (the failure mode being guarded: serde rejecting
    /// the old string and the store silently resetting ALL settings).
    #[test]
    fn v1_64_0_retired_themes_fold_to_dark_plus_accent() {
        for (old, accent) in [
            ("neonTokyo", AccentPreset::Cyan),
            ("synthwave", AccentPreset::Sunset),
        ] {
            let json = format!(
                r#"{{
                    "schemaVersion": 1,
                    "appearance": {{ "theme": "{old}" }},
                    "terminals": {{ "defaultNewPaneKind": "claude", "scrollbackLines": 9000 }},
                    "behavior": {{ "maxConcurrentCardSwarms": 5 }}
                }}"#
            );
            let dir = std::env::temp_dir().join(format!(
                "ply-settings-migration-test-{old}-{}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(SETTINGS_FILE), json).unwrap();
            let store = SettingsStore::new(dir.clone()).expect("store");
            let s = store.snapshot();
            assert_eq!(s.appearance.theme, ThemePref::Dark, "{old} → Dark");
            assert_eq!(s.appearance.accent, accent, "{old} accent");
            // The rest of the file survived — nothing was reset to defaults.
            assert_eq!(s.terminals.scrollback_lines, 9000);
            assert_eq!(s.behavior.max_concurrent_card_swarms, 5);
            // No `.broken-*` file appeared (load did not take the corrupt path).
            let broke = std::fs::read_dir(&dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .any(|e| e.file_name().to_string_lossy().contains(".broken-"));
            assert!(!broke, "migration must not trip the corrupt-fallback");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// QoL 1.168 (D3): `newTileKind` is new. A 1.167 file (without it)
    /// loads as it was; a file with Codex chosen loads it and keeps the field
    /// an older Plyloft reads; an unknown value in either reads as the
    /// default instead of setting the whole file aside.
    #[test]
    fn new_tile_kind_is_backward_compatible() {
        let cases: [(&str, PaneKind, Option<NewTileKind>); 5] = [
            // What the app writes when the choice goes back to a shell or
            // Claude (`writeNewTileKind`): an explicit null.
            (
                r#"{ "defaultNewPaneKind": "claude", "newTileKind": null, "scrollbackLines": 9000 }"#,
                PaneKind::Claude,
                None,
            ),
            (r#"{ "defaultNewPaneKind": "claude", "scrollbackLines": 9000 }"#, PaneKind::Claude, None),
            (
                r#"{ "defaultNewPaneKind": "shell", "newTileKind": "codex", "scrollbackLines": 9000 }"#,
                PaneKind::Shell,
                Some(NewTileKind::Codex),
            ),
            (
                r#"{ "defaultNewPaneKind": "shell", "newTileKind": "somethingLater", "scrollbackLines": 9000 }"#,
                PaneKind::Shell,
                None,
            ),
            (r#"{ "defaultNewPaneKind": "codex", "scrollbackLines": 9000 }"#, PaneKind::Shell, None),
        ];
        for (i, (terminals, pane, new_kind)) in cases.into_iter().enumerate() {
            let json = format!(
                r#"{{ "schemaVersion": 1, "terminals": {terminals}, "behavior": {{ "maxConcurrentCardSwarms": 5 }} }}"#
            );
            let dir = std::env::temp_dir().join(format!(
                "ply-settings-new-tile-kind-{i}-{}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(SETTINGS_FILE), json).unwrap();
            let store = SettingsStore::new(dir.clone()).expect("store");
            let s = store.snapshot();
            assert!(matches!(
                (&s.terminals.default_new_pane_kind, &pane),
                (PaneKind::Shell, PaneKind::Shell) | (PaneKind::Claude, PaneKind::Claude)
            ), "case {i}: pane kind");
            assert_eq!(s.terminals.new_tile_kind, new_kind, "case {i}: new tile kind");
            assert_eq!(s.terminals.scrollback_lines, 9000, "case {i}: the rest survived");
            assert_eq!(s.behavior.max_concurrent_card_swarms, 5, "case {i}: the rest survived");
            let broke = std::fs::read_dir(&dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .any(|e| e.file_name().to_string_lossy().contains(".broken-"));
            assert!(!broke, "case {i}: no corrupt-fallback");
            // Unset, the key stays out of the file: what 1.167 wrote is
            // what it reads back.
            let out = serde_json::to_value(&s).unwrap();
            assert_eq!(out["terminals"].get("newTileKind").is_some(), new_kind.is_some(), "case {i}: written back");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// QoL 1.168 (block 10, A7): `terminals.textSize`, `editor.textSize`
    /// and `appearance.screenReader` are new. A 1.167 file (without them)
    /// loads as it was, with nothing set; a file with them loads them; an
    /// unknown value reads as unset instead of setting the file aside; and
    /// unset, the keys stay out of the file.
    #[test]
    fn text_size_and_screen_reader_are_backward_compatible() {
        let cases: [(&str, Option<u32>, Option<u32>, Option<bool>); 3] = [
            (
                r#""appearance": { "theme": "dark" }, "terminals": { "scrollbackLines": 9000 }, "editor": { "tabSize": 4 }"#,
                None,
                None,
                None,
            ),
            (
                r#""appearance": { "theme": "dark", "screenReader": true }, "terminals": { "scrollbackLines": 9000, "textSize": 16 }, "editor": { "tabSize": 4, "textSize": 15 }"#,
                Some(16),
                Some(15),
                Some(true),
            ),
            (
                r#""appearance": { "theme": "dark", "screenReader": "yes" }, "terminals": { "scrollbackLines": 9000, "textSize": "big" }, "editor": { "tabSize": 4, "textSize": -3 }"#,
                None,
                None,
                None,
            ),
        ];
        for (i, (body, term, edit, reader)) in cases.into_iter().enumerate() {
            let json = format!(
                r#"{{ "schemaVersion": 1, {body}, "behavior": {{ "maxConcurrentCardSwarms": 5 }} }}"#
            );
            let dir = std::env::temp_dir().join(format!(
                "ply-settings-text-size-{i}-{}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(SETTINGS_FILE), json).unwrap();
            let store = SettingsStore::new(dir.clone()).expect("store");
            let s = store.snapshot();
            assert_eq!(s.terminals.text_size, term, "case {i}: terminal text size");
            assert_eq!(s.editor.text_size, edit, "case {i}: editor text size");
            assert_eq!(s.appearance.screen_reader, reader, "case {i}: screen reader");
            assert_eq!(s.terminals.scrollback_lines, 9000, "case {i}: the rest survived");
            assert_eq!(s.editor.tab_size, 4, "case {i}: the rest survived");
            assert!(matches!(s.appearance.theme, ThemePref::Dark), "case {i}: the rest survived");
            assert_eq!(s.behavior.max_concurrent_card_swarms, 5, "case {i}: the rest survived");
            let broke = std::fs::read_dir(&dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .any(|e| e.file_name().to_string_lossy().contains(".broken-"));
            assert!(!broke, "case {i}: no corrupt-fallback");
            let out = serde_json::to_value(&s).unwrap();
            assert_eq!(out["terminals"].get("textSize").is_some(), term.is_some(), "case {i}: written back");
            assert_eq!(out["editor"].get("textSize").is_some(), edit.is_some(), "case {i}: written back");
            assert_eq!(out["appearance"].get("screenReader").is_some(), reader.is_some(), "case {i}: written back");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// PPVP Tier 2 (v1.64.0): a pre-1.64 file with a SURVIVING theme and no
    /// `accent` field defaults to Violet and keeps its theme untouched.
    #[test]
    fn v1_64_0_missing_accent_defaults_to_violet() {
        for theme_name in ["system", "light", "dark", "void"] {
            let json = format!(
                r#"{{"schemaVersion":1,"appearance":{{"theme":"{}"}}}}"#,
                theme_name
            );
            let parsed: Settings = serde_json::from_str(&json).expect("parse");
            let mut appearance = parsed.appearance.clone();
            appearance.normalize();
            assert_eq!(appearance.accent, AccentPreset::Violet);
            let back = serde_json::to_value(&appearance.theme).unwrap();
            assert_eq!(back.as_str().unwrap(), theme_name, "theme untouched");
        }
    }

    /// v1.64.0: the new appearance shape round-trips (theme + accent), and
    /// `replace` normalizes a retired theme a stale frontend might send.
    #[test]
    fn v1_64_0_accent_round_trips_and_replace_normalizes() {
        let mut s = Settings::default();
        s.appearance.theme = ThemePref::Void;
        s.appearance.accent = AccentPreset::Magenta;
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains(r#""accent":"magenta""#));
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.appearance.theme, ThemePref::Void);
        assert_eq!(back.appearance.accent, AccentPreset::Magenta);

        let dir = std::env::temp_dir().join(format!(
            "ply-settings-replace-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let store = SettingsStore::new(dir.clone()).expect("store");
        let mut stale = Settings::default();
        stale.appearance.theme = ThemePref::Synthwave;
        let saved = store.replace(stale).expect("replace");
        assert_eq!(saved.appearance.theme, ThemePref::Dark);
        assert_eq!(saved.appearance.accent, AccentPreset::Sunset);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Onboarding (ONBOARDING_SPEC §8) Tier 2 ─────────────────────────

    /// A settings.json as v1.152.1 writes it: every block it knew, the
    /// onboarding and team blocks with only their old keys.
    const V1_152_1_SETTINGS: &[u8] = br#"{
        "schemaVersion": 1,
        "appearance": { "theme": "dark", "accent": "cyan" },
        "behavior": { "fileWatcherEnabled": false, "builderVendor": "codex" },
        "onboarding": { "firstRunCompletedAt": "2026-01-02T03:04:05Z" },
        "identity": { "userEmail": "owner@example.com" },
        "team": { "cloneRoot": "~/work", "ignoredRepos": ["owner/scratch"] },
        "sharing": { "notOnThisMac": ["a/b"] },
        "library": { "silencedDuplicates": [], "plySkillsOff": ["x"] }
    }"#;

    /// Load `bytes` through the store, save the snapshot back untouched and
    /// return what landed on disk.
    fn saved_untouched(bytes: &[u8]) -> (Settings, serde_json::Value) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SETTINGS_FILE), bytes).unwrap();
        let store = SettingsStore::new(dir.path().to_path_buf()).unwrap();
        let loaded = store.snapshot();
        store.replace(loaded.clone()).unwrap();
        let on_disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(SETTINGS_FILE)).unwrap())
                .unwrap();
        (loaded, on_disk)
    }

    /// §8.1: a v1.152.1 file with `firstRunCompletedAt` and no new keys
    /// loads with Setup never seen (`setupVersion` None → Setup opens once),
    /// no level, no step and nothing skipped; an untouched save writes the
    /// onboarding block exactly as it was; set values round-trip; an unknown
    /// level or a malformed record reads as unset without resetting the file.
    #[test]
    fn pre_v153_onboarding_loads_without_setup_state() {
        let (parsed, on_disk) = saved_untouched(V1_152_1_SETTINGS);
        let o = &parsed.onboarding;
        assert_eq!(o.first_run_completed_at.as_deref(), Some("2026-01-02T03:04:05Z"));
        assert_eq!(o.setup_version, None);
        assert_eq!(o.level, None);
        assert_eq!(o.current_step, None);
        assert!(o.skipped.is_empty());
        assert_eq!(o.first_card, None);
        assert_eq!(
            on_disk["onboarding"],
            serde_json::json!({ "firstRunCompletedAt": "2026-01-02T03:04:05Z" }),
            "an untouched onboarding block is written as it was"
        );
        // Existing fields survive.
        assert_eq!(parsed.appearance.theme, ThemePref::Dark);
        assert_eq!(parsed.behavior.builder_vendor, BuilderVendor::Codex);

        // Round trip of every new key.
        let mut set = parsed.clone();
        set.onboarding.setup_version = Some(SETUP_VERSION);
        set.onboarding.level = Some(SetupLevel::Fast);
        set.onboarding.current_step = Some("folder".into());
        set.onboarding
            .skipped
            .insert("github".into(), "2026-09-27T10:00:00Z".into());
        set.onboarding.first_card = Some(FirstCardGuide {
            workspace_id: "ws-1".into(),
            card_id: "card-1".into(),
            started_at: "2026-09-27T10:05:00Z".into(),
            ended_at: Some("2026-09-27T10:30:00Z".into()),
            outcome: Some("shipped".into()),
        });
        let value = serde_json::to_value(&set).unwrap();
        assert_eq!(value["onboarding"]["setupVersion"], SETUP_VERSION);
        assert_eq!(value["onboarding"]["level"], "fast");
        assert_eq!(value["onboarding"]["currentStep"], "folder");
        assert_eq!(value["onboarding"]["skipped"]["github"], "2026-09-27T10:00:00Z");
        assert_eq!(value["onboarding"]["firstCard"]["cardId"], "card-1");
        assert_eq!(value["onboarding"]["firstCard"]["outcome"], "shipped");
        let back: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(back.onboarding.setup_version, Some(SETUP_VERSION));
        assert_eq!(back.onboarding.level, Some(SetupLevel::Fast));
        assert_eq!(back.onboarding.current_step.as_deref(), Some("folder"));
        assert_eq!(back.onboarding.skipped.len(), 1);
        assert_eq!(back.onboarding.first_card, set.onboarding.first_card);
        let guided: Settings =
            serde_json::from_str(r#"{"onboarding":{"level":"guided"}}"#).unwrap();
        assert_eq!(guided.onboarding.level, Some(SetupLevel::Guided));

        // Unknown or malformed values read as unset; the file is not reset.
        let odd = br#"{
            "schemaVersion": 1,
            "appearance": { "theme": "dark" },
            "onboarding": {
                "firstRunCompletedAt": "2026-01-02T03:04:05Z",
                "setupVersion": "one",
                "level": "expert",
                "currentStep": 7,
                "skipped": ["github"],
                "firstCard": { "cardId": "only-this" }
            }
        }"#;
        let parsed = SettingsStore::parse(odd).expect("unknown values do not fail the parse");
        assert_eq!(parsed.appearance.theme, ThemePref::Dark);
        let o = &parsed.onboarding;
        assert_eq!(o.first_run_completed_at.as_deref(), Some("2026-01-02T03:04:05Z"));
        assert_eq!(o.setup_version, None);
        assert_eq!(o.level, None);
        assert_eq!(o.current_step, None);
        assert!(o.skipped.is_empty());
        assert_eq!(o.first_card, None);
        // A null from the frontend's shape is unset too.
        let nulls: Settings = serde_json::from_str(
            r#"{"onboarding":{"setupVersion":null,"level":null,"currentStep":null,"firstCard":null}}"#,
        )
        .unwrap();
        assert_eq!(nulls.onboarding.level, None);
        assert_eq!(nulls.onboarding.setup_version, None);
    }

    // ── Getting started (TUTORIAL_SPEC §8) Tier 2 ──────────────────────

    /// A settings.json as v1.166.0 writes it: every block, Setup's records
    /// and answers set, and no `tutorial` key.
    const V1_166_0_SETTINGS: &[u8] = br#"{
        "schemaVersion": 1,
        "appearance": { "theme": "dark", "accent": "sunset" },
        "terminals": { "defaultNewPaneKind": "claude", "scrollbackLines": 20000 },
        "shell": { "pathOverride": "/opt/homebrew/bin", "tileShell": "/bin/zsh" },
        "editor": { "tabSize": 4, "lineNumbers": false, "wordWrap": true },
        "behavior": {
            "fileWatcherEnabled": false,
            "notifyOnAgentDone": false,
            "openOn": "board",
            "builderVendor": "codex",
            "discussionSynthesizer": "codex"
        },
        "onboarding": {
            "firstRunCompletedAt": "2026-01-02T03:04:05Z",
            "setupVersion": 2,
            "level": "guided",
            "currentStep": "ready",
            "skipped": { "github": "2026-09-27T10:00:00Z", "later-step": "2026-09-27T10:01:00Z" },
            "firstCard": {
                "workspaceId": "ws-1",
                "cardId": "card-1",
                "startedAt": "2026-09-27T10:05:00Z",
                "endedAt": "2026-09-27T10:30:00Z",
                "outcome": "shipped"
            }
        },
        "identity": { "userEmail": "owner@example.com" },
        "team": {
            "cloneRoot": "~/work",
            "ignoredRepos": ["owner/scratch"],
            "workMode": "team",
            "teamRepo": "owner/team",
            "account": "octocat"
        },
        "sharing": { "notOnThisMac": ["a/b"], "githubBoardMoved": ["c/d"], "githubBoardKeptLocal": ["e/f"] },
        "windows": {
            "settings": { "width": 1200, "height": 850 },
            "settingsPage": "setup",
            "sidebar": { "width": 260, "collapsed": true }
        },
        "library": { "silencedDuplicates": [], "plySkillsOff": ["x"] },
        "projects": { "folder": "~/Projects" }
    }"#;

    /// Every leaf of `want` is in `got` with the same value.
    fn assert_leaves_kept(want: &serde_json::Value, got: &serde_json::Value, path: &str) {
        match want {
            serde_json::Value::Object(map) if !map.is_empty() => {
                for (k, v) in map {
                    assert_leaves_kept(v, &got[k.as_str()], &format!("{path}.{k}"));
                }
            }
            _ => assert_eq!(got, want, "{path} is unchanged"),
        }
    }

    /// A tour record with every key set, one done step and one skipped step
    /// this build has no manifest for.
    fn full_tutorial_json() -> serde_json::Value {
        serde_json::json!({
            "startedAt": "2026-10-21T09:00:00.000Z",
            "startedVersion": "1.167.0",
            "path": "full",
            "workspaceId": "ws-tour",
            "cardId": "card-tour",
            "done": { "b1": "2026-10-21T09:01:00.000Z", "z99-from-a-newer-app": "2026-10-21T09:02:00Z" },
            "skipped": { "b2": "2026-10-21T09:03:00+02:00", "q-unknown": "2026-10-21T09:04:00Z" },
            "paused": true,
            "endedAt": "2026-10-21T10:00:00Z",
            "seenVersion": "1.166.0",
            "tips": false,
            "seenSections": ["board", "inbox"]
        })
    }

    /// §8.2 (1, 2): a v1.166.0 file loads with no tour and every other key as
    /// it was; an untouched save writes the onboarding block exactly as it was
    /// and adds no `tutorial` key.
    #[test]
    fn pre_tutorial_settings_load_without_tutorial() {
        let fixture: serde_json::Value = serde_json::from_slice(V1_166_0_SETTINGS).unwrap();
        let (parsed, on_disk) = saved_untouched(V1_166_0_SETTINGS);
        assert_eq!(parsed.onboarding.tutorial, None);
        assert_eq!(parsed.onboarding.setup_version, Some(2));
        assert_eq!(parsed.onboarding.level, Some(SetupLevel::Guided));
        assert_eq!(parsed.onboarding.skipped.len(), 2);
        assert_eq!(
            on_disk["onboarding"], fixture["onboarding"],
            "an untouched onboarding block is written as it was"
        );
        assert!(on_disk["onboarding"].get("tutorial").is_none());
        assert_leaves_kept(&fixture, &on_disk, "settings");

        // A file with a tour saves back untouched too.
        let mut with_tour = fixture.clone();
        with_tour["onboarding"]["tutorial"] = full_tutorial_json();
        let bytes = serde_json::to_vec(&with_tour).unwrap();
        let (parsed, on_disk) = saved_untouched(&bytes);
        assert!(parsed.onboarding.tutorial.is_some());
        assert_eq!(on_disk["onboarding"], with_tour["onboarding"]);
        assert_leaves_kept(&with_tour, &on_disk, "settings");
    }

    /// §8.2 (3, 4): every tutorial key round-trips in camelCase; unknown step
    /// ids survive; a frontend `null` is unset.
    #[test]
    fn tutorial_progress_round_trips_every_key() {
        let raw = full_tutorial_json();
        let t: TutorialProgress = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(t.started_at.as_deref(), Some("2026-10-21T09:00:00.000Z"));
        assert_eq!(t.started_version.as_deref(), Some("1.167.0"));
        assert_eq!(t.path, Some(TutorialPath::Full));
        assert_eq!(t.workspace_id.as_deref(), Some("ws-tour"));
        assert_eq!(t.card_id.as_deref(), Some("card-tour"));
        assert_eq!(t.done.len(), 2);
        assert!(t.done.contains_key("z99-from-a-newer-app"));
        assert_eq!(t.skipped.len(), 2);
        assert!(t.skipped.contains_key("q-unknown"));
        assert_eq!(t.paused, Some(true));
        assert_eq!(t.ended_at.as_deref(), Some("2026-10-21T10:00:00Z"));
        assert_eq!(t.seen_version.as_deref(), Some("1.166.0"));
        assert_eq!(t.tips, Some(false));
        assert_eq!(t.seen_sections, vec!["board".to_string(), "inbox".to_string()]);
        assert_eq!(serde_json::to_value(&t).unwrap(), raw, "written back key for key");

        let quick: TutorialProgress = serde_json::from_str(r#"{"path":"quick"}"#).unwrap();
        assert_eq!(quick.path, Some(TutorialPath::Quick));
        // An empty record stays a record: started nothing, but not absent.
        let s: Settings = serde_json::from_str(r#"{"onboarding":{"tutorial":{}}}"#).unwrap();
        assert_eq!(s.onboarding.tutorial, Some(TutorialProgress::default()));
        assert_eq!(serde_json::to_value(&s).unwrap()["onboarding"]["tutorial"], serde_json::json!({}));
        // The frontend's nulls are unset, and unset keys are not written.
        let nulls: TutorialProgress = serde_json::from_str(
            r#"{"startedAt":null,"startedVersion":null,"path":null,"workspaceId":null,"cardId":null,"done":null,
                "skipped":null,"paused":null,"endedAt":null,"seenVersion":null,"tips":null,
                "seenSections":null}"#,
        )
        .unwrap();
        assert_eq!(nulls, TutorialProgress::default());
        let s: Settings = serde_json::from_str(r#"{"onboarding":{"tutorial":null}}"#).unwrap();
        assert_eq!(s.onboarding.tutorial, None);

        // A key a newer app adds to the record survives this build's save
        // through the real store, beside the keys this build knows.
        let mut newer = full_tutorial_json();
        newer["lastChapter"] = serde_json::json!("terminals");
        newer["chapters"] = serde_json::json!({ "team": { "open": true } });
        let file = serde_json::json!({ "schemaVersion": 1, "onboarding": { "tutorial": newer } });
        let (parsed, on_disk) = saved_untouched(&serde_json::to_vec(&file).unwrap());
        let t = parsed.onboarding.tutorial.expect("the record loads");
        assert_eq!(t.path, Some(TutorialPath::Full));
        assert_eq!(t.extra.len(), 2, "only the unknown keys are extra");
        assert_eq!(on_disk["onboarding"]["tutorial"], newer, "a newer app's keys are kept");
    }

    /// §8.2 (4): a bad value reads as unset, field by field — the rest of the
    /// record and of the file still load.
    #[test]
    fn tutorial_bad_values_read_as_unset() {
        let odd = br#"{
            "schemaVersion": 1,
            "appearance": { "theme": "dark" },
            "onboarding": {
                "firstRunCompletedAt": "2026-01-02T03:04:05Z",
                "setupVersion": 2,
                "tutorial": {
                    "startedAt": "yesterday",
                    "startedVersion": 167,
                    "path": "scenic",
                    "workspaceId": 7,
                    "cardId": "card-tour",
                    "done": {
                        "b1": "2026-10-21T09:01:00Z",
                        "b2": "soon",
                        "b3": 12,
                        "unknown-id": "2026-10-21T09:05:00Z"
                    },
                    "skipped": ["b4"],
                    "paused": "yes",
                    "endedAt": 1729500000,
                    "seenVersion": 166,
                    "tips": "on",
                    "seenSections": ["board", 3, null, "inbox"]
                }
            }
        }"#;
        let parsed = SettingsStore::parse(odd).expect("bad tour values do not fail the parse");
        assert_eq!(parsed.appearance.theme, ThemePref::Dark);
        assert_eq!(parsed.onboarding.setup_version, Some(2));
        let t = parsed.onboarding.tutorial.expect("the record still loads");
        assert_eq!(t.started_at, None);
        assert_eq!(t.started_version, None);
        assert_eq!(t.path, None);
        assert_eq!(t.workspace_id, None);
        assert_eq!(t.card_id.as_deref(), Some("card-tour"));
        assert_eq!(
            t.done.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["b1", "unknown-id"],
            "an entry without an ISO time is dropped; unknown ids are kept"
        );
        assert!(t.skipped.is_empty());
        assert_eq!(t.paused, None);
        assert_eq!(t.ended_at, None);
        assert_eq!(t.seen_version, None);
        assert_eq!(t.tips, None);
        assert_eq!(t.seen_sections, vec!["board".to_string(), "inbox".to_string()]);

        // A tutorial that is not an object reads as never started.
        let s = SettingsStore::parse(br#"{"onboarding":{"tutorial":"done"}}"#).unwrap();
        assert_eq!(s.onboarding.tutorial, None);
        let s = SettingsStore::parse(br#"{"onboarding":{"tutorial":42}}"#).unwrap();
        assert_eq!(s.onboarding.tutorial, None);

        // Unknown ids survive the store's save, not just serde.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SETTINGS_FILE), odd).unwrap();
        let store = SettingsStore::new(dir.path().to_path_buf()).unwrap();
        store.replace(store.snapshot()).unwrap();
        let on_disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(SETTINGS_FILE)).unwrap())
                .unwrap();
        assert_eq!(
            on_disk["onboarding"]["tutorial"],
            serde_json::json!({
                "cardId": "card-tour",
                "done": { "b1": "2026-10-21T09:01:00Z", "unknown-id": "2026-10-21T09:05:00Z" },
                "seenSections": ["board", "inbox"]
            })
        );
    }

    /// §8.3: a v1.152.1 team block (clone root and dismissals) loads with no
    /// work mode (derived), no team repo and no account; an untouched save
    /// writes it as it was; set values round-trip as `"solo"`/`"team"`; an
    /// unknown mode reads as not chosen.
    #[test]
    fn pre_v153_team_loads_without_work_mode_team_repo_or_account() {
        let (parsed, on_disk) = saved_untouched(V1_152_1_SETTINGS);
        assert_eq!(parsed.team.work_mode, None);
        assert_eq!(parsed.team.team_repo, None);
        assert_eq!(parsed.team.account, None);
        assert_eq!(parsed.team.clone_root.as_deref(), Some("~/work"));
        assert_eq!(parsed.team.ignored_repos, vec!["owner/scratch".to_string()]);
        assert_eq!(
            on_disk["team"],
            serde_json::json!({ "cloneRoot": "~/work", "ignoredRepos": ["owner/scratch"] }),
            "an untouched team block is written as it was"
        );

        let mut set = parsed.clone();
        set.team.work_mode = Some(WorkMode::Solo);
        set.team.team_repo = Some("mb-adv/ply-team".into());
        set.team.account = Some("octocat-work".into());
        let value = serde_json::to_value(&set).unwrap();
        assert_eq!(value["team"]["workMode"], "solo");
        assert_eq!(value["team"]["teamRepo"], "mb-adv/ply-team");
        assert_eq!(value["team"]["account"], "octocat-work");
        let back: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(back.team.work_mode, Some(WorkMode::Solo));
        assert_eq!(back.team.team_repo.as_deref(), Some("mb-adv/ply-team"));
        assert_eq!(back.team.account.as_deref(), Some("octocat-work"));
        let team: Settings = serde_json::from_str(r#"{"team":{"workMode":"team"}}"#).unwrap();
        assert_eq!(team.team.work_mode, Some(WorkMode::Team));

        let odd = br#"{
            "schemaVersion": 1,
            "team": { "cloneRoot": "~/work", "workMode": "duo", "teamRepo": 42, "account": null }
        }"#;
        let parsed = SettingsStore::parse(odd).expect("unknown values do not fail the parse");
        assert_eq!(parsed.team.clone_root.as_deref(), Some("~/work"));
        assert_eq!(parsed.team.work_mode, None);
        assert_eq!(parsed.team.team_repo, None);
        assert_eq!(parsed.team.account, None);
    }

    /// Onboarding §11.1: `team.teamRepo` is the backend's to write. A
    /// frontend save made from settings read before a team was created keeps
    /// it, and `set_team_repo` persists atomically and can clear it.
    #[test]
    fn team_repo_if_blank_never_overwrites_a_team() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path().to_path_buf()).unwrap();
        assert!(store.set_team_repo_if_blank("mb/team").unwrap().is_some());
        assert!(store.set_team_repo_if_blank("other/team").unwrap().is_none());
        assert_eq!(store.snapshot().team.team_repo.as_deref(), Some("mb/team"));
        store.set_team_repo(Some("  ".into())).unwrap();
        assert!(store.set_team_repo_if_blank("other/team").unwrap().is_some());
        // N14 review 2: an account left from another team goes with the write.
        store.set_joined_team("old/team", Some("old-acct".into())).unwrap();
        store.set_team_repo(None).unwrap();
        assert!(store.set_team_repo_if_blank("new/team").unwrap().is_some());
        assert_eq!(store.snapshot().team.account, None);
        // …and a refused write leaves the team's own account alone.
        store.set_joined_team("mine/team", Some("me".into())).unwrap();
        assert!(store.set_team_repo_if_blank("other/team").unwrap().is_none());
        assert_eq!(store.snapshot().team.account.as_deref(), Some("me"));
    }

    /// OB-10: a join records the team and the account it used in one write,
    /// persisted; joining with gh's active account clears a stale choice.
    #[test]
    fn a_joined_team_is_recorded_with_its_account() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path().to_path_buf()).unwrap();
        store.set_joined_team("mb-adv/ply-team", Some("mb-work".into())).unwrap();
        let reopened = SettingsStore::new(dir.path().to_path_buf()).unwrap().snapshot();
        assert_eq!(reopened.team.team_repo.as_deref(), Some("mb-adv/ply-team"));
        assert_eq!(reopened.team.account.as_deref(), Some("mb-work"));
        store.set_joined_team("mb-adv/ply-team", None).unwrap();
        assert_eq!(store.snapshot().team.account, None);
    }

    #[test]
    fn team_repo_is_backend_owned_and_survives_a_stale_frontend_save() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path().to_path_buf()).unwrap();
        let stale = store.snapshot();
        store.set_joined_team("octocat/octocat-team", Some("mb-work".into())).unwrap();
        let saved = store.replace(stale).unwrap();
        assert_eq!(saved.team.team_repo.as_deref(), Some("octocat/octocat-team"));
        // OB-10: the account the join used survives the stale save too.
        assert_eq!(saved.team.account.as_deref(), Some("mb-work"));
        let reopened = SettingsStore::new(dir.path().to_path_buf()).unwrap().snapshot();
        assert_eq!(reopened.team.team_repo.as_deref(), Some("octocat/octocat-team"));
        store.set_team_repo(None).unwrap();
        let cleared = SettingsStore::new(dir.path().to_path_buf()).unwrap().snapshot();
        assert_eq!(cleared.team.team_repo, None);
    }

    /// §8.2 / D9: a v1.152.1 file has no `projects` block; it loads with no
    /// folder chosen, which callers read as `~/Projects` — never `~/code`.
    /// The folder is stored in tilde form and round-trips; a blank or
    /// non-string value reads as not chosen.
    #[test]
    fn pre_v153_projects_loads_with_no_folder_and_defaults_to_projects() {
        let (parsed, on_disk) = saved_untouched(V1_152_1_SETTINGS);
        assert_eq!(parsed.projects, ProjectsSettings::default());
        assert_eq!(parsed.projects.folder, None);
        assert_eq!(parsed.projects.chosen(), None);
        assert_eq!(parsed.projects.folder_or_default(), "~/Projects");
        assert_eq!(DEFAULT_PROJECTS_FOLDER, "~/Projects");
        assert_eq!(
            on_disk["projects"],
            serde_json::json!({}),
            "no folder key is written while none is chosen"
        );

        let mut set = parsed.clone();
        set.projects.folder = Some("~/code".into());
        let value = serde_json::to_value(&set).unwrap();
        assert_eq!(value["projects"]["folder"], "~/code");
        let back: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(back.projects.folder_or_default(), "~/code");

        let blank: Settings =
            serde_json::from_str(r#"{"projects":{"folder":"   "}}"#).unwrap();
        assert_eq!(blank.projects.folder_or_default(), "~/Projects");
        let odd = SettingsStore::parse(br#"{"schemaVersion":1,"appearance":{"theme":"dark"},"projects":{"folder":["x"]}}"#)
            .expect("a bad folder does not fail the parse");
        assert_eq!(odd.projects.folder, None);
        assert_eq!(odd.appearance.theme, ThemePref::Dark);
    }

    /// Setup's step ids are stable forever: a rename would strand every
    /// stored `currentStep` and `skipped` key.
    #[test]
    fn setup_step_ids_are_the_specs_eleven() {
        // 1.175.0 F1: the same eleven ids, `github` now right after `account`.
        assert_eq!(
            SETUP_STEP_IDS,
            ["welcome", "account", "github", "mode", "ai", "git", "team", "folder", "project", "config", "ready"]
        );
        let mut ids = SETUP_STEP_IDS;
        ids.sort_unstable();
        let mut before = ["welcome", "account", "mode", "ai", "git", "github", "team", "folder", "project", "config", "ready"];
        before.sort_unstable();
        assert_eq!(ids, before, "no id was added, dropped or renamed");
        assert_eq!(SETUP_VERSION, 2, "a new order is not a new Setup: nobody is shown it again");
    }

    /// 1.175.0 F1 (schema migration, the v1.11.x template): a settings.json
    /// as 1.174.5 wrote it mid-Setup. Each resume point it could hold for a
    /// step whose place moved (`github`, `mode`, `folder`, `git`, `team`)
    /// still reads as that step's id — an id this build knows — and is
    /// written back as it was, with nothing else of the onboarding block
    /// touched; the file has no `gitHelperConsented`, which reads as no
    /// consent waiting and is not written.
    #[test]
    fn a_1_174_5_resume_point_reads_as_the_same_step_in_the_new_order() {
        for step in ["github", "mode", "folder", "git", "team"] {
            let raw = format!(
                r#"{{"schemaVersion":1,"appearance":{{"theme":"dark"}},"onboarding":{{"firstRunCompletedAt":null,"setupVersion":2,"level":"guided","currentStep":"{step}","skipped":{{"ai":"2026-11-01T10:00:00Z"}}}}}}"#
            );
            let (parsed, on_disk) = saved_untouched(raw.as_bytes());
            let o = &parsed.onboarding;
            assert_eq!(o.current_step.as_deref(), Some(step));
            assert!(SETUP_STEP_IDS.contains(&step), "{step} is still a step");
            assert_eq!(o.setup_version, Some(2));
            assert_eq!(o.level, Some(SetupLevel::Guided));
            assert_eq!(o.skipped.get("ai").map(String::as_str), Some("2026-11-01T10:00:00Z"));
            assert!(!o.git_helper_consented, "{step}: no consent is read from a file without one");
            assert_eq!(on_disk["onboarding"]["currentStep"], step, "written back as it was");
            assert!(on_disk["onboarding"].get("gitHelperConsented").is_none(), "{step}: not written while false");
            assert_eq!(parsed.appearance.theme, ThemePref::Dark, "the rest of the file is read");
        }
        // Where each id stands now: the two GitHub sign-ins follow each other.
        let at = |id: &str| SETUP_STEP_IDS.iter().position(|s| *s == id).unwrap();
        assert_eq!(at("github"), at("account") + 1);
        assert!(at("github") < at("mode") && at("mode") < at("ai") && at("ai") < at("git"));
        assert!(at("git") < at("team") && at("team") < at("folder") && at("folder") < at("project"));
    }

    /// 1.175.0 F1 (schema migration): `onboarding.gitHelperConsented`. A
    /// 1.175.0 (F4): the tour's permissions question, absent from a 1.174.5
    /// file: read as not asked, saved back without the key; a yes round-trips.
    #[test]
    fn the_tours_permissions_question_is_absent_in_a_1_174_5_file_and_round_trips() {
        let (parsed, on_disk) = saved_untouched(V1_152_1_SETTINGS);
        assert!(!parsed.onboarding.builder_permissions_asked);
        assert!(on_disk["onboarding"].get("builderPermissionsAsked").is_none());
        let mut asked = parsed.clone();
        asked.onboarding.builder_permissions_asked = true;
        let value = serde_json::to_value(&asked).unwrap();
        assert_eq!(value["onboarding"]["builderPermissionsAsked"], true);
        let back: Settings = serde_json::from_value(value).unwrap();
        assert!(back.onboarding.builder_permissions_asked);
        let mut odd = serde_json::to_value(&parsed).unwrap();
        odd["onboarding"]["builderPermissionsAsked"] = serde_json::json!("yes");
        let read: Settings = serde_json::from_value(odd).unwrap();
        assert!(!read.onboarding.builder_permissions_asked, "a value that isn't a bool is not asked");
    }

    /// 1.174.5 file loads without it (false) and saves back without the key;
    /// a yes round-trips; a value that isn't a bool is no consent, and
    /// doesn't fail the file.
    #[test]
    fn the_git_helper_consent_is_absent_in_a_1_174_5_file_and_round_trips() {
        let (parsed, on_disk) = saved_untouched(V1_152_1_SETTINGS);
        assert!(!parsed.onboarding.git_helper_consented);
        assert!(on_disk["onboarding"].get("gitHelperConsented").is_none());

        let mut yes = parsed.clone();
        yes.onboarding.git_helper_consented = true;
        let value = serde_json::to_value(&yes).unwrap();
        assert_eq!(value["onboarding"]["gitHelperConsented"], true);
        let back: Settings = serde_json::from_value(value).unwrap();
        assert!(back.onboarding.git_helper_consented);
        assert_eq!(back.onboarding.first_run_completed_at, parsed.onboarding.first_run_completed_at);

        // F1 round 2: a yes taken back (a sign-in that didn't succeed, or the
        // Git step spent it) leaves no trace in the file.
        let mut taken_back = back.clone();
        taken_back.onboarding.git_helper_consented = false;
        let value = serde_json::to_value(&taken_back).unwrap();
        assert!(value["onboarding"].get("gitHelperConsented").is_none());

        for odd in [r#""yes""#, "1", "null", r#"{"at":"2026-11-09"}"#] {
            let raw = format!(r#"{{"schemaVersion":1,"appearance":{{"theme":"dark"}},"onboarding":{{"gitHelperConsented":{odd}}}}}"#);
            let read = SettingsStore::parse(raw.as_bytes()).expect("a damaged value does not fail the parse");
            assert!(!read.onboarding.git_helper_consented, "{odd} is not a consent");
            assert_eq!(read.appearance.theme, ThemePref::Dark);
        }
    }

    /// Launch A2: a file stamped by Setup 1 (before the "Plyloft account"
    /// step) still reads, keeps its stamp and resume point as written, and is
    /// below this build's Setup (1.178.0: the frontend stamps it without
    /// opening Setup for the account, which is optional).
    #[test]
    fn a_setup_1_stamp_reads_and_is_older_than_this_setup() {
        let raw = br#"{"schemaVersion":1,"onboarding":{"firstRunCompletedAt":"2026-09-01T00:00:00Z","setupVersion":1,"level":"fast","currentStep":"ready","skipped":{"github":"2026-09-27T10:00:00Z"}}}"#;
        let parsed = SettingsStore::parse(raw).expect("a Setup 1 file parses");
        let o = &parsed.onboarding;
        assert_eq!(o.setup_version, Some(1));
        assert!(o.setup_version.unwrap() < SETUP_VERSION);
        assert_eq!(o.current_step.as_deref(), Some("ready"));
        assert_eq!(o.skipped.get("github").map(String::as_str), Some("2026-09-27T10:00:00Z"));
        let written = serde_json::to_value(&parsed).unwrap();
        assert_eq!(written["onboarding"]["setupVersion"], 1, "the stamp is kept until Setup closes");
    }

    /// CH-4 (1.174.0): the layers, held to the same fixtures as
    /// `cardModels.ts` (`src/lib/cardModels.fixtures.json`).
    #[test]
    fn card_model_layers_match_the_shared_fixtures() {
        #[derive(serde::Deserialize)]
        struct Expected {
            model: Option<String>,
            reasoning: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            card: Option<WorkspaceModels>,
            workspace: Option<WorkspaceModels>,
            team: Option<RoleModels>,
            app: RoleModels,
            vendor: String,
            role: String,
            fits: Option<std::collections::HashMap<String, Vec<String>>>,
            expected: Expected,
        }
        #[derive(serde::Deserialize)]
        struct Fixtures {
            cases: Vec<Case>,
        }
        let fixtures: Fixtures = serde_json::from_str(include_str!("../../src/lib/cardModels.fixtures.json")).unwrap();
        assert!(fixtures.cases.len() >= 10);
        for c in &fixtures.cases {
            let role = match c.role.as_str() {
                "builder" => AgentRole::Builder,
                "challenger" => AgentRole::Challenger,
                other => panic!("{}: role {other}", c.name),
            };
            let fits = |model: Option<&str>, effort: &str| match (&c.fits, model) {
                (Some(fits), Some(model)) => fits.get(model).is_none_or(|levels| levels.iter().any(|l| l == effort)),
                _ => true,
            };
            let got = resolve_card_model_fitted(
                c.card.as_ref(),
                c.workspace.as_ref(),
                c.team.as_ref(),
                &c.app,
                &c.vendor,
                role,
                &fits,
            );
            let want = ModelChoice { model: c.expected.model.clone(), reasoning: c.expected.reasoning.clone() };
            assert_eq!(got, want, "{}", c.name);
            if c.fits.is_none() {
                let plain = resolve_card_model_with_team(c.card.as_ref(), c.workspace.as_ref(), c.team.as_ref(), &c.app, &c.vendor, role);
                assert_eq!(plain, want, "{} (resolve_card_model_with_team)", c.name);
            }
        }
    }
}
