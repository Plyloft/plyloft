//! 1.179.0 (C1): several Claude accounts on one computer.
//!
//! A Claude account is the official CLI's own login kept in its own
//! configuration folder: Claude Code reads `CLAUDE_CONFIG_DIR` and keeps that
//! folder's settings, history and login apart (Anthropic's documentation,
//! "Log in with multiple accounts"). The account Claude uses with no folder
//! given is **Main**: exactly what `claude_session::claude_config_dir`
//! answers today, and its sessions get no new variable at all.
//!
//! Rules this module keeps:
//!
//! - **Plyloft never reads, copies or stores a credential.** Sign-in and
//!   sign-out are the CLI's own (`claude auth login` / `logout` in Setup's
//!   guided terminal, `setup_actions::ActionId::LoginAccountClaude`). Whether
//!   an account is signed in is read from attributes only
//!   (`claude_auth::read_for_dir`: the keychain item keyed to the folder,
//!   asked for its attributes; a `stat` of `.credentials.json`).
//! - **Each folder is Plyloft's own**, `<app-config>/ai-accounts/claude/<id>/`,
//!   never inside `~/.claude`. Its path is derived from the id and never
//!   stored, so no machine path lives in settings; the id is made here
//!   ([`new_id`]) and carries no text the member typed.
//! - **Removal never follows a link** ([`remove_folder_in`]): a link is
//!   removed as a link, never what it points to.
//! - The list lives in `settings.json` (`aiAccounts.claude`), written only by
//!   these commands through `SettingsStore::update` (tempfile and rename,
//!   Hard rule 3).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::doctor::CredentialSeen;
use crate::settings::{AiAccountEntry, ClaudeAccountsSettings, SettingsStore};

/// Plyloft's folder for AI account folders, under its app config folder.
pub const ACCOUNTS_DIR: &str = "ai-accounts";
/// Claude's accounts, under [`ACCOUNTS_DIR`].
pub const CLAUDE_DIR: &str = "claude";
/// What Main is called until the member names it.
pub const MAIN_NAME: &str = "Main";
/// The longest name an account may have, in characters.
pub const NAME_MAX_CHARS: usize = 40;
/// The variable Claude Code reads its configuration folder from.
pub const CONFIG_DIR_VAR: &str = "CLAUDE_CONFIG_DIR";
/// Hex characters in an id Plyloft makes.
const ID_LEN: usize = 8;

/// Plyloft's app config folder, told once at startup ([`init`]), so a spawn
/// path deep in the app derives an account's folder exactly as the commands
/// here made it.
static CONFIG_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Called once at startup with the app config folder `SettingsStore` uses.
pub fn init(config_dir: &Path) {
    let _ = CONFIG_ROOT.set(config_dir.to_path_buf());
}

fn config_root() -> Option<&'static Path> {
    CONFIG_ROOT.get().map(PathBuf::as_path)
}

// ── Words a person reads ───────────────────────────────────────────────

pub fn name_taken(name: &str) -> String {
    format!("You already have an account named {name}.")
}

pub fn sessions_running(n: usize, name: &str) -> String {
    let sessions = if n == 1 { "session" } else { "sessions" };
    format!("Close {n} {sessions} running on {name} first.")
}

/// Not in the approved table (C1 report): an empty name.
pub const NAME_EMPTY: &str = "Give this account a name.";
/// Not in the approved table (C1 report): a name over [`NAME_MAX_CHARS`].
pub const NAME_TOO_LONG: &str = "Keep the name to 40 characters or fewer.";
/// Not in the approved table (C1 report): an id no account has (a window
/// that read the list before a removal).
pub const UNKNOWN_ACCOUNT: &str = "Plyloft doesn't know this Claude account.";

/// Not in the approved table (C1 report).
pub fn folder_not_made(name: &str) -> String {
    format!("Plyloft couldn't make the folder for {name}.")
}

/// Not in the approved table (C1 report).
pub fn folder_not_deleted(name: &str) -> String {
    format!("Plyloft couldn't delete the folder for {name}.")
}

// ── Ids and folders ────────────────────────────────────────────────────

/// An id as Plyloft makes them: lowercase ASCII letters and digits, at most
/// 32. Anything else names no folder.
pub fn valid_id(id: &str) -> bool {
    (1..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// A new id: 8 hex characters of a random uuid, none `taken` says is in use
/// (listed, or a folder already on disk).
pub fn new_id(taken: impl Fn(&str) -> bool) -> String {
    loop {
        let id: String = uuid::Uuid::new_v4().simple().to_string().chars().take(ID_LEN).collect();
        if !taken(&id) {
            return id;
        }
    }
}

/// `<config>/ai-accounts/claude`.
pub fn claude_accounts_root(config_dir: &Path) -> PathBuf {
    config_dir.join(ACCOUNTS_DIR).join(CLAUDE_DIR)
}

/// The Claude configuration folder of `account` under `config_dir`. Main
/// (`None`) is exactly `claude_session::claude_config_dir()`: Plyloft's own
/// `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`. `None` for an id that
/// isn't one Plyloft makes, or a Main whose home can't be told.
pub fn claude_dir_in(config_dir: &Path, account: Option<&str>) -> Option<PathBuf> {
    match account {
        None => crate::claude_session::claude_config_dir(),
        Some(id) if valid_id(id) => Some(claude_accounts_root(config_dir).join(id)),
        Some(_) => None,
    }
}

/// [`claude_dir_in`] under the app config folder [`init`] was told.
pub fn claude_dir(account: Option<&str>) -> Option<PathBuf> {
    match account {
        None => crate::claude_session::claude_config_dir(),
        Some(_) => claude_dir_in(config_root()?, account),
    }
}

/// The environment a Claude session on `account` gets on top of today's:
/// nothing for Main, `CLAUDE_CONFIG_DIR=<its folder>` for another account.
/// `None` when the account's folder can't be told: the caller refuses the
/// start instead of running it on Main without saying so.
#[allow(dead_code)] // C2's spawn paths are its callers.
pub fn spawn_env(account: Option<&str>) -> Option<Vec<(String, String)>> {
    match account {
        None => Some(Vec::new()),
        Some(_) => spawn_env_in(config_root()?, account),
    }
}

/// [`spawn_env`] under `config_dir`. The value is the folder spelled exactly
/// as [`claude_dir_in`] gives it, which is the text the CLI hashes for the
/// account's keychain item and the text [`signed_in_at`] hashes too.
pub fn spawn_env_in(config_dir: &Path, account: Option<&str>) -> Option<Vec<(String, String)>> {
    match account {
        None => Some(Vec::new()),
        Some(_) => {
            let dir = claude_dir_in(config_dir, account)?;
            Some(vec![(CONFIG_DIR_VAR.to_string(), dir.to_string_lossy().into_owned())])
        }
    }
}

fn is_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

fn through_link(config_dir: &Path) -> std::io::Result<()> {
    let accounts = config_dir.join(ACCOUNTS_DIR);
    if is_link(&accounts) || is_link(&accounts.join(CLAUDE_DIR)) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "an accounts folder is a link",
        ));
    }
    Ok(())
}

/// Make the folder for a new account `id`. Refused when the id isn't one
/// Plyloft makes, when a folder of that id is already there, and when the
/// accounts folder itself is a link (a folder made through it would be
/// somewhere else).
pub fn create_folder_in(config_dir: &Path, id: &str) -> std::io::Result<PathBuf> {
    if !valid_id(id) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not an account id"));
    }
    through_link(config_dir)?;
    let root = claude_accounts_root(config_dir);
    std::fs::create_dir_all(&root)?;
    through_link(config_dir)?;
    let dir = root.join(id);
    std::fs::create_dir(&dir)?;
    // The CLI's own login file can land here (Windows, the macOS fallback):
    // the folder is the member's alone.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

/// Delete account `id`'s folder without following a link, the rule
/// `codex_home::remove_overlay_dir` keeps (its helper is shaped for an
/// overlay's levels, so the same rule is applied here to every level): the
/// folder itself, when a link, is removed as a link; inside it every link is
/// removed as a link first, then what is left. A folder already gone is
/// fine.
pub fn remove_folder_in(config_dir: &Path, id: &str) -> std::io::Result<()> {
    if !valid_id(id) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not an account id"));
    }
    through_link(config_dir)?;
    let dir = claude_accounts_root(config_dir).join(id);
    let meta = match std::fs::symlink_metadata(&dir) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if meta.file_type().is_symlink() {
        return crate::platform::remove_link(&dir);
    }
    if !meta.is_dir() {
        return std::fs::remove_file(&dir);
    }
    remove_links_within(&dir)?;
    std::fs::remove_dir_all(&dir)
}

/// Every link below `dir`, removed as a link; real folders are walked, never
/// a linked one (`DirEntry::file_type` does not follow links; a junction
/// reads as a link on Windows).
fn remove_links_within(dir: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            crate::platform::remove_link(&entry.path())?;
        } else if kind.is_dir() {
            remove_links_within(&entry.path())?;
        }
    }
    Ok(())
}

/// The folders Repair never acts on as a whole (`cli_repair_run::Roots`):
/// the accounts folders and every account folder in them.
pub fn protected_dirs_in(config_dir: &Path) -> Vec<PathBuf> {
    let root = claude_accounts_root(config_dir);
    let mut dirs = vec![config_dir.join(ACCOUNTS_DIR), root.clone()];
    if let Ok(entries) = std::fs::read_dir(&root) {
        dirs.extend(entries.flatten().map(|entry| entry.path()));
    }
    dirs
}

/// [`protected_dirs_in`] under the app config folder [`init`] was told.
pub fn protected_dirs() -> Vec<PathBuf> {
    config_root().map(protected_dirs_in).unwrap_or_default()
}

// ── Signed in ──────────────────────────────────────────────────────────

/// Whether an account is signed in, as the row says it: "Signed in", "Not
/// signed in", or "Plyloft can't tell whether this account is signed in."
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SignedIn {
    Yes,
    No,
    Unknown,
}

/// The two attribute reads, as one answer. Present anywhere is signed in. For
/// Main, nothing seen is "can't tell" (`claude_auth`: an API key or a helper
/// signs Claude in without either trace, as Diagnostics says); for a folder
/// Plyloft made, nothing seen is "not signed in". A place Plyloft couldn't
/// look in is never "not signed in".
pub fn seen(keychain: CredentialSeen, file: CredentialSeen, main: bool) -> SignedIn {
    match (keychain, file) {
        (CredentialSeen::Present, _) | (_, CredentialSeen::Present) => SignedIn::Yes,
        (CredentialSeen::Absent, CredentialSeen::Absent) if !main => SignedIn::No,
        _ => SignedIn::Unknown,
    }
}

/// Signed in at `dir`, an account folder Plyloft made (attributes only).
pub fn signed_in_at(dir: &Path) -> SignedIn {
    let (keychain, file) = crate::claude_auth::read_for_dir(dir);
    seen(keychain, file, false)
}

/// Whether `account` is signed in (`None`: Main, as Diagnostics reads it).
/// Never opens a secret and runs nothing.
pub fn signed_in(account: Option<&str>) -> SignedIn {
    match account {
        None => {
            let (keychain, file) = crate::claude_auth::read();
            seen(keychain, file, true)
        }
        Some(_) => match claude_dir(account) {
            Some(dir) => signed_in_at(&dir),
            None => SignedIn::Unknown,
        },
    }
}

// ── Names ──────────────────────────────────────────────────────────────

/// Which account a name is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target<'a> {
    /// A new account.
    New,
    Main,
    Account(&'a str),
}

/// The name as kept: control characters dropped, runs of spaces one space,
/// trimmed.
pub fn clean_name(raw: &str) -> String {
    let visible: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    visible.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// Main's name as shown.
pub fn main_name(accounts: &ClaudeAccountsSettings) -> String {
    accounts
        .main_name
        .clone()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| MAIN_NAME.to_string())
}

/// Check `raw` as the name of `target`: not empty, at most
/// [`NAME_MAX_CHARS`], "Main" only for Main, and no other Claude account
/// (Main included) of the same name ignoring case. Gives the cleaned name.
pub fn check_name(accounts: &ClaudeAccountsSettings, target: Target<'_>, raw: &str) -> Result<String, String> {
    let name = clean_name(raw);
    if name.is_empty() {
        return Err(NAME_EMPTY.into());
    }
    if name.chars().count() > NAME_MAX_CHARS {
        return Err(NAME_TOO_LONG.into());
    }
    if target != Target::Main && (same_name(&name, MAIN_NAME) || same_name(&name, &main_name(accounts))) {
        return Err(name_taken(&name));
    }
    let clash = accounts
        .accounts
        .iter()
        .filter(|a| target != Target::Account(a.id.as_str()))
        .any(|a| same_name(&a.name, &name));
    if clash {
        return Err(name_taken(&name));
    }
    Ok(name)
}

pub fn find<'a>(accounts: &'a ClaudeAccountsSettings, id: &str) -> Option<&'a AiAccountEntry> {
    accounts.accounts.iter().find(|a| a.id == id)
}

// ── Rows ───────────────────────────────────────────────────────────────

/// One row of Settings › AI and models › Claude accounts.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRow {
    /// `None`: Main.
    pub id: Option<String>,
    pub name: String,
    pub signed_in: SignedIn,
    /// New sessions start on this account.
    pub is_current: bool,
    /// The account's folder, for "Show folder" (`None`: Main's home can't be
    /// told).
    pub folder: Option<String>,
}

/// The rows: Main first, then each account in the order it was added.
/// `signed_in` reads each row's state; `dir` gives each row's folder.
pub fn rows_with(
    accounts: &ClaudeAccountsSettings,
    dir: impl Fn(Option<&str>) -> Option<PathBuf>,
    signed_in: impl Fn(Option<&str>) -> SignedIn,
) -> Vec<AccountRow> {
    let current = accounts.current_id();
    let folder = |account: Option<&str>| dir(account).map(|p| p.to_string_lossy().into_owned());
    let mut rows = vec![AccountRow {
        id: None,
        name: main_name(accounts),
        signed_in: signed_in(None),
        is_current: current.is_none(),
        folder: folder(None),
    }];
    rows.extend(accounts.accounts.iter().map(|a| AccountRow {
        id: Some(a.id.clone()),
        name: a.name.clone(),
        signed_in: signed_in(Some(a.id.as_str())),
        is_current: current == Some(a.id.as_str()),
        folder: folder(Some(a.id.as_str())),
    }));
    rows
}

fn rows(accounts: &ClaudeAccountsSettings) -> Vec<AccountRow> {
    rows_with(accounts, claude_dir, signed_in)
}

fn row_of(accounts: &ClaudeAccountsSettings, id: Option<&str>) -> Option<AccountRow> {
    rows(accounts).into_iter().find(|row| row.id.as_deref() == id)
}

/// Each account's folder, for Setup's sign-in and sign-out steps
/// (`setup_actions::plan_request_with`): the folder comes from the stored id,
/// never from a string the window sent.
#[derive(Debug, Clone, PartialEq)]
pub struct AccountFolder {
    pub id: String,
    pub dir: PathBuf,
}

pub fn setup_folders(accounts: &ClaudeAccountsSettings) -> Vec<AccountFolder> {
    accounts
        .accounts
        .iter()
        .filter_map(|a| Some(AccountFolder { id: a.id.clone(), dir: claude_dir(Some(a.id.as_str()))? }))
        .collect()
}

// ── Sessions on an account (seam) ──────────────────────────────────────

/// How many sessions run on account `id` now: tiles, Builders, reviewers,
/// chats. **Seam (C1):** no session can start on an account before C2, so
/// this answers 0; C2 counts the sessions it records an account for
/// (PtyRegistry, AgentRegistry, ChatRegistry, CodexAppRegistry) here, and
/// Remove is refused while it is above 0.
pub fn sessions_running_on<R: Runtime>(app: &AppHandle<R>, id: &str) -> usize {
    let _ = (app, id);
    0
}

// ── Commands ───────────────────────────────────────────────────────────

fn store<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::State<'_, SettingsStore>, String> {
    app.try_state::<SettingsStore>()
        .ok_or_else(|| "The settings aren't ready.".to_string())
}

fn changed<R: Runtime>(app: &AppHandle<R>, saved: &crate::settings::Settings) {
    // The window's copy hears it, as for every backend settings write.
    let _ = app.emit("settings://changed", saved.clone());
}

/// The Claude accounts, Main first.
#[tauri::command(async)]
pub fn ai_accounts_list(app: AppHandle) -> Result<Vec<AccountRow>, String> {
    let settings = store(&app)?.snapshot();
    Ok(rows(&settings.ai_accounts.claude))
}

/// Add a Claude account: make its folder, then list it. The window then
/// starts Setup's `login-account.claude` with the id this gives back.
#[tauri::command(async)]
pub fn ai_account_add(app: AppHandle, name: String) -> Result<AccountRow, String> {
    let store = store(&app)?;
    let config = config_root().ok_or_else(|| folder_not_made(&clean_name(&name)))?;
    let before = store.snapshot().ai_accounts.claude;
    let name = check_name(&before, Target::New, &name)?;
    let root = claude_accounts_root(config);
    let id = new_id(|id| find(&before, id).is_some() || std::fs::symlink_metadata(root.join(id)).is_ok());
    create_folder_in(config, &id).map_err(|error| {
        log::warn!("ai_accounts: folder for a new account not made: {error}");
        folder_not_made(&name)
    })?;
    // Checked again under the store's lock: another add may have landed.
    let mut refused = None;
    let saved = store.update(|s| {
        let claude = &mut s.ai_accounts.claude;
        match check_name(claude, Target::New, &name) {
            Ok(name) => claude.accounts.push(AiAccountEntry {
                id: id.clone(),
                name,
                added_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                extra: serde_json::Map::new(),
            }),
            Err(words) => refused = Some(words),
        }
    });
    let saved = match (saved, refused) {
        (Ok(saved), None) => saved,
        (Ok(_), Some(words)) | (Err(words), _) => {
            let _ = remove_folder_in(config, &id);
            return Err(words);
        }
    };
    changed(&app, &saved);
    row_of(&saved.ai_accounts.claude, Some(id.as_str())).ok_or_else(|| UNKNOWN_ACCOUNT.to_string())
}

/// Rename an account; `id` `None` renames Main (kept as `mainName`; "Main"
/// itself is kept as no name).
#[tauri::command(async)]
pub fn ai_account_rename(app: AppHandle, id: Option<String>, name: String) -> Result<AccountRow, String> {
    let store = store(&app)?;
    let mut refused = None;
    let saved = store.update(|s| {
        let claude = &mut s.ai_accounts.claude;
        let target = match id.as_deref() {
            None => Target::Main,
            Some(id) if find(claude, id).is_some() => Target::Account(id),
            Some(_) => {
                refused = Some(UNKNOWN_ACCOUNT.to_string());
                return;
            }
        };
        match (check_name(claude, target, &name), target) {
            (Err(words), _) => refused = Some(words),
            (Ok(name), Target::Main) => {
                claude.main_name = (name != MAIN_NAME).then_some(name);
            }
            (Ok(name), Target::Account(id)) => {
                if let Some(entry) = claude.accounts.iter_mut().find(|a| a.id == id) {
                    entry.name = name;
                }
            }
            (Ok(_), Target::New) => {}
        }
    })?;
    if let Some(words) = refused {
        return Err(words);
    }
    changed(&app, &saved);
    row_of(&saved.ai_accounts.claude, id.as_deref()).ok_or_else(|| UNKNOWN_ACCOUNT.to_string())
}

/// The account new sessions start on (`id` `None`: Main). A running session
/// keeps its own. Gives back every row.
#[tauri::command(async)]
pub fn ai_account_use_for_new(app: AppHandle, id: Option<String>) -> Result<Vec<AccountRow>, String> {
    let store = store(&app)?;
    let mut refused = false;
    let saved = store.update(|s| {
        let claude = &mut s.ai_accounts.claude;
        match id.as_deref() {
            None => claude.current = None,
            Some(id) if find(claude, id).is_some() => claude.current = Some(id.to_string()),
            Some(_) => refused = true,
        }
    })?;
    if refused {
        return Err(UNKNOWN_ACCOUNT.into());
    }
    changed(&app, &saved);
    Ok(rows(&saved.ai_accounts.claude))
}

/// What a removal did.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub name: String,
    /// What the window asked: `true` after it ran `logout-account.claude`.
    pub sign_out: bool,
    /// Whether Claude's own login for the account is still saved on this
    /// computer, read after the folder went (attributes only). `yes` on a
    /// Mac whose keychain item Claude didn't remove (*Remove without signing
    /// out*, or a sign-out that didn't take); on Windows the login file was
    /// in the folder, so it went with it.
    pub login_left: SignedIn,
}

/// Remove account `id`: its folder, then its entry. Main has no id, so it is
/// never removed. Refused while sessions run on it, and while Setup's sign-in
/// or sign-out of an account runs. `sign_out` says whether the window ran
/// `logout-account.claude` first; Plyloft removes no login itself.
#[tauri::command(async)]
pub fn ai_account_remove(app: AppHandle, id: String, sign_out: bool) -> Result<RemoveResult, String> {
    let store = store(&app)?;
    let accounts = store.snapshot().ai_accounts.claude;
    let entry = find(&accounts, &id).cloned().ok_or_else(|| UNKNOWN_ACCOUNT.to_string())?;
    let config = config_root().ok_or_else(|| folder_not_deleted(&entry.name))?;
    let running = sessions_running_on(&app, &id);
    if running > 0 {
        return Err(sessions_running(running, &entry.name));
    }
    if let Some(runner) = app.try_state::<crate::setup_run::SetupRunner>() {
        let account_step = runner
            .active()
            .and_then(|run| crate::setup_actions::ActionId::parse(&run.action_id))
            .filter(|action| action.is_account_step());
        if let Some(action) = account_step {
            return Err(crate::setup_run::busy(action));
        }
    }
    remove_folder_in(config, &id).map_err(|error| {
        log::warn!("ai_accounts: account folder not deleted: {error}");
        folder_not_deleted(&entry.name)
    })?;
    let saved = store.update(|s| {
        let claude = &mut s.ai_accounts.claude;
        claude.accounts.retain(|a| a.id != id);
        if claude.current.as_deref() == Some(id.as_str()) {
            claude.current = None;
        }
    })?;
    changed(&app, &saved);
    Ok(RemoveResult {
        name: entry.name,
        sign_out,
        login_left: signed_in_at(&claude_accounts_root(config).join(&id)),
    })
}

/// "Show folder": the account's folder in Finder or Explorer (`id` `None`:
/// Main's).
#[tauri::command(async)]
pub fn ai_account_show_folder(app: AppHandle, id: Option<String>) -> Result<(), String> {
    let accounts = store(&app)?.snapshot().ai_accounts.claude;
    if let Some(id) = id.as_deref() {
        if find(&accounts, id).is_none() {
            return Err(UNKNOWN_ACCOUNT.into());
        }
    }
    let dir = claude_dir(id.as_deref()).ok_or_else(|| UNKNOWN_ACCOUNT.to_string())?;
    crate::platform::open_path(&dir).map_err(|e| format!("open: {e}"))
}

#[cfg(test)]
#[path = "ai_accounts_tests.rs"]
mod tests;
