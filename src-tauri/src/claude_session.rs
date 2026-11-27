//! A collected Claude session run in Claude's interactive TUI instead of
//! `claude -p`.
//!
//! Anthropic announced separate credits for `claude -p` and the Agent SDK in
//! May 2026 and suspended the change in June ("for now, nothing has
//! changed"). A review billed outside the member's plan would break Hard
//! rule 1, so the read-only sessions (Challenger, proposal, discussion,
//! capability probe) and the unattended writer sessions (a Verify slash
//! check, an Agent's oneshot run: [`unattended_writer_args`]) start the
//! interactive CLI in a PTY, like a Builder, and read the answer from the
//! session's own transcript:
//!
//! - the argv names the session (`--session-id <uuid>`), so its transcript is
//!   `<claude config>/projects/<cwd key>/<uuid>.jsonl`;
//! - the turn is over when Claude writes its end-of-turn entry
//!   (`system`/`turn_duration`) after the assistant's final message, or —
//!   for a Claude that writes none — when that message carries its answer
//!   and the transcript has not grown for a while ([`Transcript`]);
//! - a screen only the member can get past (sign-in, first-run setup, the
//!   API-key question, the usage-limit menu) writes no transcript; it stops
//!   the session at once, in words the failure classifiers read
//!   ([`blocking_screen`]);
//! - the collected output is the transcript followed by one line shaped like
//!   `claude -p --output-format json`'s answer, so every reader of a
//!   collected session (final message, error, probe evidence) reads it as
//!   before;
//! - Claude's folder-trust question is never answered by Plyloft: a session
//!   that meets it stops with `FOLDER_TRUST_REFUSAL`, for the member to
//!   decide (`-p` never asked it): the member trusts Plyloft's session
//!   folder ([`SESSIONS_DIR`]) once, in a Claude tile Plyloft opens there,
//!   and every session folder below it inherits the trust because none of
//!   them is a git root: Claude asks again for a repository or worktree root
//!   below a trusted folder (measured, Claude Code 2.1.299), so each session
//!   runs in a plain tree whose git state is kept outside it
//!   (`pinned_read::PlainTree`). On 2.1.319 (measured 2026-11-09, proof
//!   P3's follow-up) a linked worktree is no longer asked about by where it
//!   sits: Claude decides its trust by the repository it belongs to, so a
//!   worktree of a trusted project is trusted anywhere on disk and loads
//!   that copy's own project settings. A tree with a `.git` link here would
//!   then follow the project's trust, not this folder's — one more reason
//!   the sessions' trees are plain.

use std::path::{Path, PathBuf};

/// The flag that names a session, and so its transcript.
pub(crate) const SESSION_ID_FLAG: &str = "--session-id";

/// What a collected session that met Claude's folder-trust question says.
/// The UI matches it word for word (`src/lib/claudeReviewTrust.ts`, held
/// to it by `folder_trust_refusal_matches_the_ui_constant`).
pub(crate) const FOLDER_TRUST_REFUSAL: &str = "Claude asks whether to trust the review folder before it starts. Plyloft never answers that question for you.";

/// Variables a Claude parent sets that would turn the child's transcript off
/// ("inherited CLAUDE_CODE_CHILD_SESSION marker"); without a transcript a
/// collected session never ends. Plyloft started from a Claude Code terminal
/// inherits them.
pub(crate) const CHILD_SESSION_ENV: [&str; 3] =
    ["CLAUDE_CODE_CHILD_SESSION", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];

/// The session a collected argv names when it is an interactive Claude
/// session: `--session-id <uuid>` and no `-p`/`--print`.
pub(crate) fn collected_session_id(args: &[String]) -> Option<String> {
    if args.iter().any(|arg| arg == "-p" || arg == "--print") {
        return None;
    }
    let at = args.iter().position(|arg| arg == SESSION_ID_FLAG)?;
    args.get(at + 1).filter(|id| !id.trim().is_empty()).cloned()
}

/// The permission mode of an unattended writer session for a member whose
/// own `defaultMode` is the default (or `dontAsk`, `plan`, unset): a tool
/// the member's allow rules (or the caller's `--allowedTools`) don't
/// pre-approve is refused, never asked about. That is what `claude -p` did
/// with a tool it had no answer for; the interactive TUI would otherwise
/// stop at the question and sit there, with nobody to answer it.
pub(crate) const UNATTENDED_WRITER_PERMISSION_MODE: &str = "dontAsk";

/// The file tools an `acceptEdits` member's session pre-approves
/// ([`WriterMode::AcceptEdits`]). Unscoped: Claude's path-rule syntax for
/// an absolute folder is not something Plyloft can check without running
/// Claude, and the session's folder is the project or the card's worktree
/// anyway — where `acceptEdits` let `-p` edit.
pub(crate) const EDIT_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/// Nobody can answer a question asked in an unattended session.
pub(crate) const UNATTENDED_DISALLOWED_TOOLS: &str = "AskUserQuestion";

/// How the member's own effective `permissions.defaultMode` maps onto an
/// unattended writer session, which can't answer a permission question.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WriterMode {
    /// `bypassPermissions`: as under `-p`, nothing is asked.
    Bypass,
    /// `acceptEdits`: `dontAsk` plus the edit tools pre-approved — edits
    /// went through under `-p`, and anything else would ask (and hang).
    AcceptEdits,
    /// Anything else: `dontAsk`.
    Refuse,
}

impl WriterMode {
    fn from_default_mode(mode: Option<&str>) -> Self {
        match mode {
            Some("bypassPermissions") => WriterMode::Bypass,
            Some("acceptEdits") => WriterMode::AcceptEdits,
            _ => WriterMode::Refuse,
        }
    }
}

/// 1.175.0 (A6, SEC-3): one settings file's text, and whose it is.
#[derive(Debug, Clone)]
enum Layer {
    /// The member's own: the managed file, their user settings, and the
    /// project's `settings.local.json` when it is plainly theirs
    /// ([`own_local_settings`]). Only these can choose bypass.
    Own(Option<String>),
    /// A file that reaches this computer with the repository (the project's
    /// `settings.json`, a `settings.local.json` git tracks), or that the
    /// session's own work can write (any settings file in a card's copy). It
    /// may ask for accept edits, never for bypass ([`writer_mode_in`]).
    Shared(Option<String>),
    /// The folder's own `settings.local.json` when git gave no answer about
    /// it (no repository, no git, 5 s). Read like a shared file; a bypass it
    /// asks for and doesn't get is only logged — it may well be the
    /// member's own, so nothing is said about "this project's settings".
    Unjudged(Option<String>),
}

impl Layer {
    fn text(&self) -> Option<&str> {
        match self {
            Layer::Own(text) | Layer::Shared(text) | Layer::Unjudged(text) => text.as_deref(),
        }
    }
}

/// `permissions.defaultMode` of one settings file's text. A missing,
/// unreadable or invalid file, or one that names no mode, says nothing.
fn default_mode_of(text: Option<&str>) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(text?)
        .ok()?
        .get("permissions")?
        .get("defaultMode")?
        .as_str()
        .map(str::to_string)
}

/// Where Claude Code reads managed (enterprise) settings.
fn managed_settings_paths() -> Vec<PathBuf> {
    if cfg!(target_os = "macos") {
        vec![PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json")]
    } else if cfg!(windows) {
        vec![
            PathBuf::from(r"C:\Program Files\ClaudeCode\managed-settings.json"),
            PathBuf::from(r"C:\ProgramData\ClaudeCode\managed-settings.json"),
        ]
    } else {
        vec![PathBuf::from("/etc/claude-code/managed-settings.json")]
    }
}

/// What an unattended writer session in a folder runs as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WriterChoice {
    pub mode: WriterMode,
    /// 1.175.0 (A6; round 3, S2): a file that isn't the member's own asked
    /// for Bypass Permissions mode and the member's own settings don't
    /// choose it: the session runs without it. Which kind of file asked.
    pub bypass_not_followed: Option<BypassAsked>,
}

/// Whose request for bypass was not followed ([`WriterChoice`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BypassAsked {
    /// A file the repository brings, or one in a card's copy: logged, and a
    /// check that fails says so ([`PROJECT_BYPASS_NOT_FOLLOWED`]).
    Shared,
    /// Only the folder's own local file, which git couldn't judge: logged.
    Unjudged,
}

/// What a Verify check that failed adds to its reason when a shared file's
/// bypass was not followed ([`BypassAsked::Shared`]): the check ran with
/// fewer permissions than the project's file asks for, and that may be why.
/// Modelled on [`BYPASS_QUESTION`].
pub(crate) const PROJECT_BYPASS_NOT_FOLLOWED: &str = "This project's Claude settings ask for Bypass Permissions mode. A check nobody watches starts in that mode only when your own Claude settings choose it, so this one ran without it.";

/// The member's effective writer mode in `cwd`, read from Claude's own
/// settings files in its precedence: managed > `settings.local.json` >
/// `<cwd>/.claude/settings.json` > `<claude config>/settings.json`. Read
/// only: Plyloft never writes any of them.
///
/// 1.175.0 (A6, SEC-3; owner: only what is the member's own counts — and,
/// round 3, the repository may ask for accept edits, never for bypass).
/// **Bypass** is chosen by the member's own files alone ([`Layer::Own`]):
/// the managed file, their user settings, and the project's own
/// `.claude/settings.local.json` when it is plainly theirs. The project's
/// `settings.json`, a tracked `settings.local.json` and every settings file
/// of a card's copy ([`Layer::Shared`]) are read in Claude's precedence like
/// the rest, and one that asks for bypass gets accept edits at most — a
/// teammate's commit, or what a Builder wrote in its copy, can't start a
/// session nobody watches in bypass.
///
/// 1.179.0: "their user settings" are those of the Claude account the
/// session runs on (`account`; `None`: Main), the folder it reads them from.
pub(crate) fn writer_mode(cwd: &Path, account: Option<&str>) -> WriterMode {
    writer_choice(cwd, account).mode
}

/// [`writer_mode`] with what was not followed, said in the log.
pub(crate) fn writer_choice(cwd: &Path, account: Option<&str>) -> WriterChoice {
    let read = |path: PathBuf| std::fs::read_to_string(path).ok();
    let managed = managed_settings_paths().into_iter().map(read).collect();
    let user = match crate::ai_accounts::claude_dir(account) {
        Some(dir) => user_settings_layer(&own_settings_folder(cwd), &dir.join("settings.json")),
        None => Layer::Own(None),
    };
    let choice = writer_mode_in(&settings_layers(cwd, managed, user));
    match choice.bypass_not_followed {
        Some(BypassAsked::Shared) => log::warn!(
            "claude_session: a Claude settings file in {} that comes with the repository (or was written in a card's copy) asks for bypassPermissions; only the member's own settings choose it, so the unattended session runs as {:?}",
            cwd.display(),
            choice.mode
        ),
        Some(BypassAsked::Unjudged) => log::warn!(
            "claude_session: {}/.claude/settings.local.json asks for bypassPermissions, and git couldn't say whether the file is the member's own (no repository, or no answer); the unattended session runs as {:?}",
            cwd.display(),
            choice.mode
        ),
        None => {}
    }
    choice
}

/// The folder whose `.claude/settings.local.json` is the member's own for a
/// session in `cwd`: the project's. A card's copy lives under one of the
/// project's worktree roots (`<project>/.plyloft-worktrees/…`,
/// `worktrees::worktree_dir_names`), where the Builder's own session can
/// write a `settings.local.json` before Verify runs — so for a copy it is
/// the project above that root, never the copy. The root is known by its
/// name whatever its case (a disk that ignores case opens the same folder
/// under either spelling), in `cwd` as given and as the disk resolves it.
fn own_settings_folder(cwd: &Path) -> PathBuf {
    let above_copies = |path: &Path| {
        path.ancestors()
            .skip(1)
            .find(|dir| {
                dir.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(crate::worktrees::is_worktrees_dir_name)
            })
            .and_then(Path::parent)
            .map(Path::to_path_buf)
    };
    above_copies(cwd)
        .or_else(|| crate::platform::canonicalize(cwd).ok().and_then(|real| above_copies(&real)))
        .unwrap_or_else(|| cwd.to_path_buf())
}

/// What `<folder>/.claude/settings.local.json` is to the member.
#[derive(Debug, Clone, PartialEq, Eq)]
enum LocalSettings {
    /// Their own: its text (`None` when it can't be read).
    Own(Option<String>),
    /// It comes with the repository, or is reached in a way that can't be
    /// told from that.
    Shared,
    /// Git gave no answer about it (no repository, no git, 5 s).
    Unjudged,
    Absent,
}

/// `dir` holds an entry named exactly `name` — as the disk spells it, read
/// from the directory itself, never from the path asked for — and it is a
/// plain folder (`folder`) or a plain file: not a link, whatever it points at.
fn plain_entry(dir: &Path, name: &str, folder: bool) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry.file_name() == std::ffi::OsStr::new(name)
            && entry.file_type().is_ok_and(|kind| if folder { kind.is_dir() } else { kind.is_file() })
    })
}

/// Round 3 (S1): whose `<folder>/.claude/settings.local.json` is. The
/// member's own only when all of this holds; anything else is not theirs.
///
/// - On disk `.claude` is a real folder and the file a real file, under
///   exactly those names ([`plain_entry`]). `is_file()` follows links and, on
///   macOS and Windows, ignores case: a committed link `.claude` →
///   `config/claude`, a tracked `.claude/Settings.local.json` or
///   `.Claude/settings.local.json` all answered it.
/// - `.claude` holds no `.git`: a repository of its own there (a submodule)
///   tracks the file where the project's git doesn't list it.
/// - On Unix the file has one name (no hard link to bytes kept elsewhere).
/// - Git, asked without regard to case and with the folder's own path taken
///   literally (`:(top,icase,literal)<prefix>.claude/settings.local.json`),
///   says no tracked path is that file: exit 1. A tracked case variant in the
///   index — which a pull writes into the member's file on a disk that
///   ignores case, `core.ignorecase` or not — exits 0.
fn own_local_settings(folder: &Path) -> LocalSettings {
    let claude = folder.join(".claude");
    let file = claude.join("settings.local.json");
    if std::fs::symlink_metadata(&file).is_err() {
        return LocalSettings::Absent;
    }
    // Where `folder` is in its repository, as git spells it (`""` at the top).
    let git = |args: &[&str]| {
        let mut cmd = crate::platform::git_command();
        cmd.args(args).current_dir(folder).env("GIT_TERMINAL_PROMPT", "0");
        crate::worktrees::run_bounded_output(&mut cmd, std::time::Duration::from_secs(5)).ok()
    };
    let prefix = git(&["rev-parse", "--show-prefix"])
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|prefix| prefix.trim_end_matches(['\n', '\r']).to_string());
    // 0: a tracked path is that one. 1: none is. Anything else: no answer.
    let tracked = |path: &str| {
        let prefix = prefix.as_deref()?;
        git(&["ls-files", "--error-unmatch", "--", &format!(":(top,icase,literal){prefix}{path}")])
            .and_then(|out| out.status.code())
    };
    if !plain_entry(folder, ".claude", true) || !plain_entry(&claude, "settings.local.json", false) {
        // Round 5 (V2): a link git doesn't track is the member's own doing,
        // not the repository's — still never taken as theirs (what it points
        // at can be anything), but nothing is said of "this project's
        // settings" about it. A committed link, or a case variant, is shared.
        let is_link = |path: &Path| std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink());
        let untracked_link = if is_link(&claude) {
            tracked(".claude") == Some(1)
        } else {
            is_link(&file) && plain_entry(folder, ".claude", true) && tracked(".claude/settings.local.json") == Some(1)
        };
        return if untracked_link { LocalSettings::Unjudged } else { LocalSettings::Shared };
    }
    let nested_repository = std::fs::read_dir(&claude).map_or(true, |entries| {
        entries.flatten().any(|entry| entry.file_name().to_string_lossy().eq_ignore_ascii_case(".git"))
    });
    if nested_repository {
        return LocalSettings::Shared;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if !std::fs::symlink_metadata(&file).is_ok_and(|meta| meta.nlink() == 1) {
            return LocalSettings::Shared;
        }
    }
    match tracked(".claude/settings.local.json") {
        Some(1) => LocalSettings::Own(std::fs::read_to_string(&file).ok()),
        Some(0) => LocalSettings::Shared,
        _ => LocalSettings::Unjudged,
    }
}

/// The member's user settings as a layer: their own — unless the file, as
/// the disk resolves it, lies inside the project (`~/.claude/settings.json`
/// linked into a dotfiles repository that is the project itself): then a
/// commit to the project changes it, and it is read as shared.
fn user_settings_layer(own_folder: &Path, file: &Path) -> Layer {
    let text = std::fs::read_to_string(file).ok();
    let inside = match (crate::platform::canonicalize(file), crate::platform::canonicalize(own_folder)) {
        (Ok(file), Ok(project)) => crate::platform::is_within(&file, &project),
        _ => false,
    };
    if inside {
        Layer::Shared(text)
    } else {
        Layer::Own(text)
    }
}

/// The settings files of a session in `cwd`, in Claude's precedence, each
/// with whose it is ([`Layer`]). `managed` are those files' texts and `user`
/// the user's own layer (tests give their own).
fn settings_layers(cwd: &Path, managed: Vec<Option<String>>, user: Layer) -> Vec<Layer> {
    let read = |path: PathBuf| std::fs::read_to_string(path).ok();
    let local = |folder: &Path| folder.join(".claude").join("settings.local.json");
    let mut layers: Vec<Layer> = managed.into_iter().map(Layer::Own).collect();
    let own_folder = own_settings_folder(cwd);
    let judged = own_local_settings(&own_folder);
    let own = match &judged {
        LocalSettings::Own(text) => {
            layers.push(Layer::Own(text.clone()));
            true
        }
        LocalSettings::Shared | LocalSettings::Unjudged | LocalSettings::Absent => false,
    };
    // The folder's own local file when it is not that one: a card's copy's,
    // or one that isn't the member's own. Read as the session would reach it.
    if own_folder == cwd && judged == LocalSettings::Unjudged {
        layers.push(Layer::Unjudged(read(local(cwd))));
    } else if !own || own_folder != cwd {
        layers.push(Layer::Shared(read(local(cwd))));
    }
    layers.push(Layer::Shared(read(cwd.join(".claude").join("settings.json"))));
    layers.push(user);
    layers
}

/// [`writer_mode`] of the settings files' texts, in precedence order. The
/// first file that names a mode decides, as in Claude. Round 3 (S2; owner:
/// the repository can reach accept edits, never bypass): when that file is
/// not the member's own and asks for bypass, the session runs with accept
/// edits — unless the member's own files below it choose bypass themselves —
/// and [`WriterChoice::bypass_not_followed`] says who asked. Anything else a
/// shared file names is followed as Claude would follow it: accept edits,
/// or a mode that asks (`plan`, `default`), which here is `dontAsk`.
/// Bypass is not available when any layer, shared or not, sets
/// `permissions.disableBypassPermissionsMode` to `"disable"` (Claude then
/// refuses the mode): such a member maps like the default, `dontAsk`.
fn writer_mode_in(layers: &[Layer]) -> WriterChoice {
    let named = |layer: &Layer| default_mode_of(layer.text());
    let mode_of = |layer: &Layer| named(layer).map(|mode| WriterMode::from_default_mode(Some(&mode)));
    let mut bypass_not_followed = None;
    let mut mode = WriterMode::Refuse;
    if let Some((at, asked)) = layers.iter().enumerate().find_map(|(at, l)| mode_of(l).map(|m| (at, m))) {
        let own = matches!(layers[at], Layer::Own(_));
        mode = if own || asked != WriterMode::Bypass {
            asked
        } else {
            let own_below = layers[at + 1..].iter().filter(|l| matches!(l, Layer::Own(_))).find_map(mode_of);
            if own_below == Some(WriterMode::Bypass) {
                WriterMode::Bypass
            } else {
                // Said of "this project's settings" only when a file the
                // repository brings asks; the unjudged local file alone is
                // only logged.
                let shared_asks = layers
                    .iter()
                    .any(|l| matches!(l, Layer::Shared(_)) && mode_of(l) == Some(WriterMode::Bypass));
                bypass_not_followed = Some(if shared_asks { BypassAsked::Shared } else { BypassAsked::Unjudged });
                WriterMode::AcceptEdits
            }
        };
    }
    // Round 5 (V2): with bypass disabled, a bypass asked by a shared file is
    // the default like the member's own would be — nobody named accept edits
    // — and it is the disabling that took it away, so nothing more is said.
    if bypass_disabled_in(layers) && (mode == WriterMode::Bypass || bypass_not_followed.is_some()) {
        mode = WriterMode::Refuse;
        bypass_not_followed = None;
    }
    WriterChoice { mode, bypass_not_followed }
}

fn bypass_disabled_in(layers: &[Layer]) -> bool {
    layers.iter().filter_map(Layer::text).any(|text| {
        serde_json::from_str::<serde_json::Value>(text).ok().is_some_and(|value| {
            value["permissions"]["disableBypassPermissionsMode"].as_str() == Some("disable")
        })
    })
}

/// The argv of an unattended *writer* session collected through its
/// transcript — a Verify slash check (`verify::build_claude_slash_argv`) and
/// an Agent's oneshot run (`agents::build_claude_argv`), which replaced
/// `claude -p` there: the session is named ([`SESSION_ID_FLAG`]), its
/// permission mode follows the member's own ([`writer_mode`]), the prompt
/// comes right after it, as `-p`'s did, then `--disallowedTools
/// AskUserQuestion` and one `--allowedTools` list: the edit tools for an
/// `acceptEdits` member, then the caller's `allowed` (an agent's own list;
/// a swarm role's `Write` for its artifact).
///
/// Unlike a read-only session (`read_only_provider::read_only_argv`) it is
/// neither `--restricted` nor tool-limited and runs in the caller's own
/// folder (the project, or the card's worktree): the member's settings,
/// allow rules, project skills and hooks apply, as they did under `-p`.
/// Claude's folder-trust question there is the member's, as for the
/// Builder: a session that meets it stops with [`FOLDER_TRUST_REFUSAL`].
pub(crate) fn unattended_writer_args(prompt: &str, mode: WriterMode, allowed: &[String]) -> Vec<String> {
    let permission_mode = match mode {
        WriterMode::Bypass => "bypassPermissions",
        WriterMode::AcceptEdits | WriterMode::Refuse => UNATTENDED_WRITER_PERMISSION_MODE,
    };
    let mut args: Vec<String> = vec![
        SESSION_ID_FLAG.into(),
        uuid::Uuid::new_v4().to_string(),
        "--permission-mode".into(),
        permission_mode.into(),
        prompt.into(),
        "--disallowedTools".into(),
        UNATTENDED_DISALLOWED_TOOLS.into(),
    ];
    let mut tools: Vec<String> = Vec::new();
    if mode == WriterMode::AcceptEdits {
        tools.extend(EDIT_TOOLS.iter().map(|tool| tool.to_string()));
    }
    for tool in allowed {
        if !tool.trim().is_empty() && !tools.contains(tool) {
            tools.push(tool.clone());
        }
    }
    if !tools.is_empty() {
        args.push("--allowedTools".into());
        args.extend(tools);
    }
    args
}

/// Whether `args` start an unattended writer session (no `--restricted`):
/// the startup net (`pty::SessionWatch`) applies to it. A read-only
/// session keeps its own timeout and its own failure readers.
pub(crate) fn is_unattended_writer(args: &[String]) -> bool {
    collected_session_id(args).is_some() && !args.iter().any(|arg| arg == "--restricted")
}

/// What an unattended writer session that met Claude's folder-trust
/// question says ([`FOLDER_TRUST_REFUSAL`] is the reviews', naming their
/// own folder): the folder it ran in, and the way on.
pub(crate) fn writer_trust_refusal(cwd: &Path) -> String {
    format!(
        "Claude asks whether to trust {} before it starts. Plyloft never answers that question for you: open a Claude tile in that folder, answer it there, then try again.",
        cwd.display()
    )
}

/// The folder every collected Claude session runs under, inside Plyloft's
/// config dir: review, discussion and proposal worktrees and the reviewer
/// probe. It holds nothing else (no settings, no workspaces, no entitlement),
/// so the Claude tile the member opens there to trust it reaches nothing of
/// Plyloft's own state. Claude trusts a folder below a trusted one only when
/// it is no git root (no `.git` in it, nor in a folder between it and this
/// one), so every session folder here is plain — `pty::spawn_collect` refuses
/// one that is not ([`git_root_under_sessions`]) — and one answer covers
/// every session.
pub(crate) const SESSIONS_DIR: &str = "claude-sessions";

/// `<config>/claude-sessions`. Every session folder's path is built from it,
/// so it is also where Plyloft learns its own session roots
/// ([`sessions_root_above`]): a member's folder that happens to be named
/// `claude-sessions` is never one.
pub(crate) fn sessions_root(config_dir: &Path) -> PathBuf {
    let root = config_dir.join(SESSIONS_DIR);
    let mut known = known_roots().lock();
    if !known.contains(&root) {
        known.push(root.clone());
    }
    root
}

fn known_roots() -> &'static parking_lot::Mutex<Vec<PathBuf>> {
    static ROOTS: std::sync::OnceLock<parking_lot::Mutex<Vec<PathBuf>>> = std::sync::OnceLock::new();
    ROOTS.get_or_init(Default::default)
}

/// Where one kind of session (`reviews`, `discussions`, `proposals`) keeps
/// its detached read worktrees: `<config>/claude-sessions/<kind>/worktrees`.
/// The kind's state (records, answers) stays where it was,
/// `<config>/<kind>/`; only the folders a session runs in moved.
pub(crate) fn session_worktrees(config_dir: &Path, kind: &str) -> PathBuf {
    sessions_root(config_dir).join(kind).join("worktrees")
}

/// Every session root built in this process ([`sessions_root`]), for what
/// names a path under one without having the config folder at hand
/// (`publish_filter`: a Reviewer's read tree is the project's own files).
pub(crate) fn known_session_roots() -> Vec<PathBuf> {
    known_roots().lock().clone()
}

/// Before the session root, a kind's worktrees were `<config>/<kind>/
/// worktrees`. Each one lives only while its session runs (a
/// `DetachedReadWorktree` removes itself), and nothing persisted names
/// one, so what is left there at launch is a leftover of a run that never
/// finished; it is removed, and the repository's own record of it goes with
/// its next `git worktree prune` (every new read worktree runs one). An
/// entry touched in the last hour is kept: an older Plyloft still running
/// beside this one may be reading it. The root goes once it is empty.
pub(crate) fn retire_legacy_worktrees(config_dir: &Path, kind: &str) {
    retire_legacy_worktrees_older_than(config_dir, kind, LEFTOVER_AGE);
}

/// How old a session folder left at launch must be before it is removed.
const LEFTOVER_AGE: std::time::Duration = std::time::Duration::from_secs(3600);

/// The same for the session root's own folders: a kind's read trees (and a
/// plain tree's `<name>-git` link beside it, which keeps the repository's
/// record of the tree from being pruned while the link is there), and the
/// reviewer probes (`probes`, the probe's git dir and plugin beside it).
/// Each lives only while its session runs, so what a launch finds is a
/// leftover of a run that never finished.
pub(crate) fn retire_session_leftovers(config_dir: &Path, kind: &str) {
    let dir = if kind == "probes" {
        sessions_root(config_dir).join(kind)
    } else {
        session_worktrees(config_dir, kind)
    };
    remove_entries_older_than(&dir, kind, LEFTOVER_AGE);
}

fn retire_legacy_worktrees_older_than(config_dir: &Path, kind: &str, age: std::time::Duration) {
    remove_entries_older_than(&config_dir.join(kind).join("worktrees"), kind, age);
}

fn remove_entries_older_than(dir: &Path, kind: &str, age: std::time::Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let fresh = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|at| at.elapsed().ok())
            .is_some_and(|elapsed| elapsed < age);
        if fresh {
            continue;
        }
        let path = entry.path();
        let removed = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if let Err(error) = removed {
            log::warn!("remove leftover {kind} folder {}: {error}", path.display());
        }
    }
    let _ = std::fs::remove_dir(dir);
}

/// Walk 3 of #386 (owner decision): the read trees a quit left behind for
/// the read-only runs other than the Challenger's (discussions, proposals,
/// Build with both's comparison), taken at launch — before any run of this
/// launch starts — whatever their age, and retired with the repository's
/// record of them, as `reviewer::retire_interrupted_worktrees` does for
/// reviews. Each lives only while its run does, and the profile has one
/// Plyloft, so a tree there at launch is an orphan. Only a direct child of
/// the kind's root is taken (`only`: just the names its records give).
#[derive(Debug, Default)]
pub(crate) struct OrphanReadTrees {
    kind: String,
    /// The trees, moved aside (`.retiring-<name>`) so a run of this launch
    /// reusing the name never meets them.
    moved: Vec<PathBuf>,
    /// The repositories' git dirs of the trees (`<repo>/.git`), to prune.
    git_dirs: Vec<PathBuf>,
}

/// `gitdir: <repo>/.git/worktrees/<name>` in a tree's `.git` file or a
/// plain tree's `<name>-git` link: the repository's own git dir.
fn common_git_dir_of(link: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(link).ok()?;
    let gitdir = PathBuf::from(text.trim().strip_prefix("gitdir:")?.trim());
    let parent = gitdir.parent()?;
    (parent.file_name()? == "worktrees").then(|| parent.parent().map(Path::to_path_buf)).flatten()
}

/// The trees under `root` (a kind's read-tree root) to retire; see
/// [`OrphanReadTrees`]. Cheap: reads a few small files and renames.
pub(crate) fn take_orphan_read_trees(
    root: &Path,
    kind: &str,
    only: Option<&std::collections::HashSet<String>>,
) -> OrphanReadTrees {
    let mut out = OrphanReadTrees { kind: kind.to_string(), ..Default::default() };
    let Ok(entries) = std::fs::read_dir(root) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_string) else { continue };
        if !path.is_dir() || name.starts_with('.') || path.parent() != Some(root) {
            continue;
        }
        if only.is_some_and(|names| !names.contains(&name)) {
            continue;
        }
        // The tree itself, or (a discussion's) the trees of its legs.
        let mut trees = vec![path.clone()];
        if let Ok(children) = std::fs::read_dir(&path) {
            trees.extend(children.flatten().map(|c| c.path()).filter(|c| c.is_dir()));
        }
        for tree in &trees {
            let link = PathBuf::from(format!("{}-git", tree.to_string_lossy()));
            for file in [tree.join(".git"), link.clone()] {
                if let Some(dir) = common_git_dir_of(&file) {
                    if !out.git_dirs.contains(&dir) {
                        out.git_dirs.push(dir);
                    }
                }
            }
            if link.is_file() {
                let _ = std::fs::remove_file(&link);
            }
        }
        let aside = root.join(format!(".retiring-{name}"));
        match std::fs::rename(&path, &aside) {
            Ok(()) => out.moved.push(aside),
            // Windows: a file still open in it. The hour-old sweep of a
            // later launch takes it.
            Err(e) => log::warn!("{kind}: couldn't move the orphan read tree {} aside: {e}", path.display()),
        }
    }
    out
}

impl OrphanReadTrees {
    pub(crate) fn is_empty(&self) -> bool {
        self.moved.is_empty() && self.git_dirs.is_empty()
    }

    /// Removes the trees and prunes the repositories' records of them.
    pub(crate) fn retire(self) {
        self.retire_with(|dir, args| crate::git::capture(dir, args));
    }

    /// [`Self::retire`] with the git it runs (a test's own).
    pub(crate) fn retire_with(self, git: impl Fn(&Path, &[&str]) -> Result<String, String>) {
        for tree in &self.moved {
            if let Err(e) = std::fs::remove_dir_all(tree) {
                // Windows locked files: left for a later launch's sweep.
                log::warn!("{}: remove the orphan read tree {}: {e}", self.kind, tree.display());
            }
        }
        for dir in &self.git_dirs {
            if dir.is_dir() {
                if let Err(e) = git(dir, &["worktree", "prune"]) {
                    log::info!("{}: git worktree prune in {}: {e}", self.kind, dir.display());
                }
            }
        }
        if !self.moved.is_empty() {
            log::info!("{}: retired {} orphan read tree(s) at launch", self.kind, self.moved.len());
        }
    }

    /// Off the launch path (each is a prune or two); a test retires them
    /// itself.
    pub(crate) fn retire_in_background(self) {
        if self.is_empty() || cfg!(test) {
            return;
        }
        std::thread::spawn(move || self.retire());
    }
}

/// Claude's own directory: `CLAUDE_CONFIG_DIR` when set, else `~/.claude`
/// under the home Claude itself uses (node's `os.homedir`: the profile on
/// Windows, `platform::home_dir`).
pub(crate) fn claude_config_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|dir| !dir.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    Some(crate::platform::home_dir()?.join(".claude"))
}

/// Claude's global state file: `$CLAUDE_CONFIG_DIR/.claude.json` when set,
/// else `~/.claude.json`. Plyloft only ever reads it.
///
/// 1.179.0: of the Claude account `account`. Main (`None`) as before;
/// another account's is in its own folder (Claude keeps `.claude.json`, and
/// so the folder-trust answers, under `CLAUDE_CONFIG_DIR`).
fn claude_global_config(account: Option<&str>) -> Option<PathBuf> {
    if account.is_some() {
        return Some(crate::ai_accounts::claude_dir(account)?.join(".claude.json"));
    }
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|dir| !dir.is_empty()) {
        return Some(PathBuf::from(dir).join(".claude.json"));
    }
    Some(crate::platform::home_dir()?.join(".claude.json"))
}

/// Whether Claude trusts the plain folder `dir`: it, or a folder above it,
/// carries `hasTrustDialogAccepted` in Claude's own state (a folder in no
/// repository inside a trusted one is trusted — measured, Claude Code
/// 2.1.299). For a git root below a trusted folder Claude's answer is its
/// own (a fresh repository or an outside repository's worktree there asks
/// again, a card worktree nested in its trusted repository does not), so
/// nothing here predicts it: what the session's screen shows decides
/// (`pty::SessionWatch`). `None` when the state can't be read. Read-only:
/// the member answers the question in Claude.
///
/// 1.179.0: as the Claude account `account` answered it (`None`: Main);
/// every account answers the question for itself.
pub(crate) fn folder_trusted(dir: &Path, account: Option<&str>) -> Option<bool> {
    let text = std::fs::read_to_string(claude_global_config(account)?).ok()?;
    trusted_in(&text, dir)
}

/// G3b review (4a): `None` when the state doesn't parse or holds no
/// `projects` — Claude's answer is unknown, so nothing is promised.
fn trusted_in(state: &str, dir: &Path) -> Option<bool> {
    let value = serde_json::from_str::<serde_json::Value>(state).ok()?;
    let projects = value.get("projects").and_then(|p| p.as_object())?;
    let dir = crate::platform::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    Some(projects.iter().any(|(key, entry)| {
        entry.get("hasTrustDialogAccepted").and_then(|flag| flag.as_bool()) == Some(true)
            && within(&dir, key)
    }))
}

/// The nearest folder, `dir` itself or one above it, holding a `.git` entry
/// (a repository's folder, or a worktree's `.git` file): where Claude asks
/// its trust question when `dir` is in a repository.
#[cfg(test)]
pub(crate) fn git_root(dir: &Path) -> Option<&Path> {
    dir.ancestors().find(|folder| std::fs::symlink_metadata(folder.join(".git")).is_ok())
}

/// Plyloft's own session root `dir` is in (`dir` itself or below it): one
/// [`sessions_root`] built, compared as the file system compares paths (on
/// Windows without case, with either separator).
pub(crate) fn sessions_root_above(dir: &Path) -> Option<PathBuf> {
    known_roots()
        .lock()
        .iter()
        .find(|root| within(dir, &root.to_string_lossy()))
        .cloned()
}

/// A git root at or above `dir` and no higher than the session root it is
/// in — where a collected Claude session must never run (`pty::spawn_collect`
/// refuses it): Claude asks to trust such a folder even below the trusted
/// root. `None` for a plain folder, and for one outside every session root.
pub(crate) fn git_root_under_sessions(dir: &Path) -> Option<PathBuf> {
    let root = sessions_root_above(dir)?;
    let root = root.to_string_lossy();
    dir.ancestors()
        .take_while(|folder| within(folder, &root))
        .find(|folder| std::fs::symlink_metadata(folder.join(".git")).is_ok())
        .map(Path::to_path_buf)
}

/// `dir` is `key` or below it. On Windows paths compare as the file system
/// does: case-insensitively, with either separator (Claude writes its keys
/// with `/` or `\`, and a drive letter in either case).
fn within(dir: &Path, key: &str) -> bool {
    if cfg!(windows) {
        within_windows(&dir.to_string_lossy(), key)
    } else {
        dir.starts_with(Path::new(key))
    }
}

fn within_windows(dir: &str, key: &str) -> bool {
    let norm = |path: &str| {
        let path = path.strip_prefix(r"\\?\").unwrap_or(path);
        path.replace('/', "\\").trim_end_matches('\\').to_lowercase()
    };
    let (dir, key) = (norm(dir), norm(key));
    !key.is_empty() && (dir == key || dir.starts_with(&format!("{key}\\")))
}

/// The session's transcript, found by its file name under every project
/// directory: Claude's key for a working directory is its own business.
pub(crate) fn find_transcript(config_dir: &Path, session_id: &str) -> Option<PathBuf> {
    let name = format!("{session_id}.jsonl");
    std::fs::read_dir(config_dir.join("projects"))
        .ok()?
        .flatten()
        .map(|entry| entry.path().join(&name))
        .find(|path| path.is_file())
}

/// Where a session's turn stands, read from its transcript.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Turn {
    /// Still working (or nothing written yet).
    Pending,
    /// The assistant finished its turn.
    Done {
        text: String,
        is_error: bool,
        usage: Option<serde_json::Value>,
        /// The turn ended with no answer (on a tool result, a hook's
        /// feedback): `text` is Claude's own last words, never a provider's
        /// failure, and no reader may classify it as one
        /// ([`TURN_WITHOUT_ANSWER_SUBTYPE`]).
        without_answer: bool,
    },
}

/// A transcript read as it grows: only the bytes after the last read are
/// parsed, an incomplete last line waits for the rest of it.
///
/// Every line of one assistant message carries the message's final
/// `stop_reason`, and a `thinking` line can be written many seconds before
/// the `text` line of the same message; a member's Stop hook can also
/// continue the turn. So the turn is over when Claude says so: the
/// `{"type":"system","subtype":"turn_duration"}` entry it writes after a
/// turn. [`Transcript::answer_shaped`] is the fallback for a Claude that
/// writes none.
#[derive(Debug, Default)]
pub(crate) struct Transcript {
    raw: String,
    partial: Vec<u8>,
    entries: Vec<serde_json::Value>,
    turn_over: bool,
}

impl Transcript {
    /// Adds what the file grew by.
    pub(crate) fn push(&mut self, bytes: &[u8]) {
        self.partial.extend_from_slice(bytes);
        let Some(end) = self.partial.iter().rposition(|byte| *byte == b'\n') else {
            return;
        };
        let complete: Vec<u8> = self.partial.drain(..=end).collect();
        let text = String::from_utf8_lossy(&complete).into_owned();
        for line in text.lines() {
            self.take_line(line);
        }
        self.raw.push_str(&text);
    }

    /// Reads an incomplete last line as complete (a whole file read once).
    #[cfg(test)]
    fn flush(&mut self) {
        if self.partial.is_empty() {
            return;
        }
        let text = String::from_utf8_lossy(&std::mem::take(&mut self.partial)).into_owned();
        self.take_line(&text);
        self.raw.push_str(&text);
    }

    fn take_line(&mut self, line: &str) {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            return;
        };
        match entry.get("type").and_then(|kind| kind.as_str()) {
            Some("assistant" | "user") => {
                self.turn_over = false;
                self.entries.push(entry);
            }
            Some("system")
                if entry.get("subtype").and_then(|kind| kind.as_str()) == Some("turn_duration") =>
            {
                self.turn_over = true;
            }
            _ => {}
        }
    }

    /// Every complete line read so far.
    pub(crate) fn raw(&self) -> &str {
        &self.raw
    }

    /// The tool the session is waiting on: the last entry is the
    /// assistant's, its last block a `tool_use` with no `tool_result` after
    /// it (a result is a user entry, which would be last). Named with what
    /// it was asked to do, briefly (`Bash (git push)`, `Write (.claude/x)`).
    pub(crate) fn pending_tool(&self) -> Option<String> {
        let last = self.entries.last()?;
        if last.get("type").and_then(|kind| kind.as_str()) != Some("assistant") {
            return None;
        }
        let block = last["message"]["content"].as_array()?.last()?;
        if block.get("type").and_then(|kind| kind.as_str()) != Some("tool_use") {
            return None;
        }
        let name = block.get("name").and_then(|name| name.as_str()).unwrap_or("a tool");
        let input = &block["input"];
        let detail = ["command", "file_path", "notebook_path", "path", "url"]
            .iter()
            .find_map(|key| input.get(*key).and_then(|value| value.as_str()))
            .map(|value| value.lines().next().unwrap_or("").chars().take(120).collect::<String>());
        Some(match detail {
            Some(detail) if !detail.trim().is_empty() => format!("{name} ({detail})"),
            _ => name.to_string(),
        })
    }

    /// Claude wrote its end-of-turn entry after the last message.
    pub(crate) fn turn_over(&self) -> bool {
        self.turn_over
    }

    /// The turn as it ended once Claude wrote its end-of-turn entry: its
    /// answer, or — when the turn ended on a user entry (a tool result, a
    /// hook's feedback) — an error carrying the last thing the assistant
    /// wrote, so the session ends instead of waiting for its timeout.
    pub(crate) fn ended(&self) -> Option<Turn> {
        if !self.turn_over {
            return None;
        }
        match self.turn() {
            Turn::Pending => {
                let said = self
                    .entries
                    .iter()
                    .rev()
                    .filter(|entry| entry.get("type").and_then(|kind| kind.as_str()) == Some("assistant"))
                    .find_map(|entry| {
                        entry["message"]["content"].as_array().into_iter().flatten().rev().find_map(|block| {
                            (block.get("type").and_then(|kind| kind.as_str()) == Some("text"))
                                .then(|| block.get("text").and_then(|part| part.as_str()))
                                .flatten()
                                .filter(|text| !text.trim().is_empty())
                                .map(str::to_string)
                        })
                    });
                Some(Turn::Done {
                    text: said.unwrap_or_else(|| TURN_WITHOUT_ANSWER.to_string()),
                    is_error: true,
                    usage: None,
                    without_answer: true,
                })
            }
            done => Some(done),
        }
    }

    /// The last message is the assistant's, final, and carries its answer
    /// (a text block, or an API error): what a turn looks like at its end,
    /// for a Claude that writes no `turn_duration`. A thinking-only line is
    /// never the answer, however final its stop reason reads.
    pub(crate) fn answer_shaped(&self) -> bool {
        match self.turn() {
            Turn::Pending => false,
            Turn::Done { text, is_error, .. } => is_error || !text.is_empty(),
        }
    }

    /// The turn's state: done once the last user/assistant entry is the
    /// assistant's with a final stop reason. Its text is every text block of
    /// that message (Claude writes one message in several lines sharing its
    /// id).
    pub(crate) fn turn(&self) -> Turn {
        let entries = &self.entries;
        let Some(last) = entries.last() else {
            return Turn::Pending;
        };
        if last.get("type").and_then(|kind| kind.as_str()) != Some("assistant") {
            return Turn::Pending;
        }
        let message = &last["message"];
        let final_stop = matches!(
            message.get("stop_reason").and_then(|reason| reason.as_str()),
            Some("end_turn" | "stop_sequence" | "max_tokens" | "refusal")
        );
        let api_error = last.get("isApiErrorMessage").and_then(|flag| flag.as_bool()) == Some(true);
        if !final_stop && !api_error {
            return Turn::Pending;
        }
        let id = message.get("id").and_then(|id| id.as_str());
        let same: Vec<&serde_json::Value> = entries
            .iter()
            .rev()
            .take_while(|entry| {
                entry.get("type").and_then(|kind| kind.as_str()) == Some("assistant")
                    && entry["message"].get("id").and_then(|id| id.as_str()) == id
            })
            .collect();
        let mut text = String::new();
        for entry in same.into_iter().rev() {
            for block in entry["message"]["content"].as_array().into_iter().flatten() {
                if block.get("type").and_then(|kind| kind.as_str()) == Some("text") {
                    if let Some(part) = block.get("text").and_then(|part| part.as_str()) {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(part);
                    }
                }
            }
        }
        Turn::Done {
            text,
            is_error: api_error,
            usage: message.get("usage").cloned(),
            without_answer: false,
        }
    }
}

/// [`Transcript::turn`] of a whole transcript.
#[cfg(test)]
pub(crate) fn read_turn(transcript: &str) -> Turn {
    let mut read = Transcript::default();
    read.push(transcript.as_bytes());
    read.flush();
    read.turn()
}

/// The result line's subtype for a turn that ended without an answer
/// (`Turn::Done::without_answer`): its text is Claude's own words, so the
/// sign-in and quota readers leave it alone.
pub(crate) const TURN_WITHOUT_ANSWER_SUBTYPE: &str = "error_turn_without_answer";

/// One line shaped like `claude -p --output-format json`'s answer.
pub(crate) fn result_line(session_id: &str, text: &str, is_error: bool, usage: Option<&serde_json::Value>) -> String {
    result_line_for(session_id, text, is_error, false, usage)
}

/// Whether a collected session's result line (its last) marks a turn that
/// ended without an answer: its text is Claude's own words, not a failure
/// to classify.
pub(crate) fn ended_without_answer(output: &str) -> bool {
    output
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .find(|value| value.get("type").and_then(|t| t.as_str()) == Some("result"))
        .is_some_and(|value| value.get("subtype").and_then(|s| s.as_str()) == Some(TURN_WITHOUT_ANSWER_SUBTYPE))
}

/// [`result_line`], marking a turn that ended without an answer.
pub(crate) fn result_line_for(
    session_id: &str,
    text: &str,
    is_error: bool,
    without_answer: bool,
    usage: Option<&serde_json::Value>,
) -> String {
    let subtype = match (is_error, without_answer) {
        (true, true) => TURN_WITHOUT_ANSWER_SUBTYPE,
        (true, false) => "error_during_execution",
        (false, _) => "success",
    };
    let mut envelope = serde_json::json!({
        "type": "result",
        "subtype": subtype,
        "is_error": is_error,
        "result": text,
        "session_id": session_id,
    });
    if let Some(usage) = usage {
        envelope["usage"] = usage.clone();
    }
    envelope.to_string()
}

/// The screen as the matchers compare it: no escapes, no whitespace, lower
/// case. The TUI draws spaces with cursor moves, so words only line up once
/// both are gone.
fn flat(screen: &str) -> String {
    strip_escapes(screen)
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}

/// Claude asks whether to trust a folder it has not seen: "Quick safety
/// check: Is this a project you created or one you trust? … ❯ No, exit /
/// Yes, I trust this folder … Enter to confirm · Esc to cancel" (Claude Code
/// 2.1.300; earlier ones number the options; the cancel option may read "No,
/// continue without these permissions", and the footer's key names come from
/// the member's key bindings). Read by the dialog's own layout on the latest
/// frame, not by its phrases anywhere: the question, then both options, then
/// "… to confirm … to cancel" as the last thing drawn. A brief that quotes
/// the dialog is echoed in the conversation, with the prompt box and status
/// line drawn after it, so its footer is never last.
pub(crate) fn asks_for_folder_trust(screen: &str) -> bool {
    const CONFIRM: &str = "toconfirm";
    const CANCEL: &str = "tocancel";
    let flat = flat(latest_frame(screen));
    let Some(cancel) = flat.rfind(CANCEL) else {
        return false;
    };
    // Nothing but a stray cell or two after the footer.
    if flat[cancel + CANCEL.len()..].chars().count() > 4 {
        return false;
    }
    let Some(confirm) = flat[..cancel].rfind(CONFIRM) else {
        return false;
    };
    // Only a key name between the two halves of the footer.
    if flat[confirm + CONFIRM.len()..cancel].chars().count() > 24 {
        return false;
    }
    let before = &flat[..confirm];
    let Some(question) = before.rfind("quicksafetycheck") else {
        return false;
    };
    let options = &before[question..];
    options.contains("yes,itrustthisfolder")
        && (options.contains("no,exit") || options.contains("no,continuewithoutthesepermissions"))
}

/// Claude asks for permission to use a tool: "Do you want to proceed?" (or
/// "…make this edit to X?", "…create X?"), then numbered choices from "1.
/// Yes" to a "No" one ("No, and tell Claude what to do differently"), as
/// the last thing drawn. The question and choice wording is the one the
/// tile header already reads (`src/lib/tileHeaderStatus.ts`, its tests).
/// Read on the latest frame by drawn lines, like [`asks_for_folder_trust`]
/// reads its dialog: box-drawing and block glyphs are no text (a bordered
/// dialog's edges, a full-width rule — on Windows 32,767 columns of it), and
/// after the "No" choice at most [`PERMISSION_FOOTER_LINES`] lines may follow
/// (a footer, the box's bottom edge) — assumed from the dialog's layout,
/// unmeasured. A working turn's status line ("esc to interrupt") or the
/// composer (a line starting `❯` / `>`) after it is no dialog. Only one half
/// of the stop: the transcript must say a tool is waiting too.
pub(crate) fn asks_for_permission(screen: &str) -> bool {
    let lines: Vec<String> = strip_escapes(latest_frame(screen))
        .lines()
        .map(drawn_line)
        .filter(|line| !line.is_empty())
        .collect();
    let Some(question) = lines.iter().rposition(|line| line.contains("doyouwantto")) else {
        return false;
    };
    // The question may wrap: its `?` ends it on its line or the next.
    let ends = if lines[question].contains('?') {
        question
    } else if lines.get(question + 1).is_some_and(|line| line.contains('?')) {
        question + 1
    } else {
        return false;
    };
    let after = &lines[ends + 1..];
    let Some(yes) = after.iter().position(|line| line.contains("1.yes")) else {
        return false;
    };
    let Some(no) = after[yes..].iter().rposition(|line| line.contains(".no")) else {
        return false;
    };
    let below = &after[yes + no + 1..];
    if below.iter().any(|line| line.contains("esctointerrupt") || line.starts_with('❯') || line.starts_with('>')) {
        return false;
    }
    below.len() <= PERMISSION_FOOTER_LINES
}

/// How many drawn lines may follow the permission dialog's "No" choice: a
/// footer ("Esc to cancel · …"), the box's bottom edge and a spare.
const PERMISSION_FOOTER_LINES: usize = 3;

/// A drawn line as the permission matcher reads it: no whitespace, no
/// box-drawing (U+2500–U+257F) or block (U+2580–U+259F) glyphs, no `|`,
/// lower case.
fn drawn_line(line: &str) -> String {
    line.chars()
        .filter(|c| !c.is_whitespace() && !is_frame_glyph(*c))
        .collect::<String>()
        .to_lowercase()
}

fn is_frame_glyph(c: char) -> bool {
    matches!(c, '\u{2500}'..='\u{259F}' | '|')
}

/// How much of the screen's text, from its end, the still-screen signature
/// covers.
const SIGNATURE_CHARS: usize = 3 * 1024;

/// A signature of what the screen shows last: the last [`SIGNATURE_CHARS`]
/// of its text once escapes and whitespace are out (stripped first, then cut
/// from the end). Claude redraws with erase-line and cursor-up, not a clear,
/// so output that is only escapes — a cursor shown and hidden, a title —
/// adds no text and leaves it unchanged, and a dialog redrawn identically
/// over and over settles to the same text; a spinner whose words or digits
/// move changes it (`pty::SessionWatch`'s still screen).
pub(crate) fn frame_signature(screen: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let text: Vec<char> = strip_escapes(screen).chars().filter(|c| !c.is_whitespace()).collect();
    let start = text.len().saturating_sub(SIGNATURE_CHARS);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text[start..].hash(&mut hasher);
    hasher.finish()
}

/// How far back the matchers look into a PTY's output: enough for a dialog
/// bordered at ConPTY's 32,767 columns with literal padding.
const MATCHER_RAW_WINDOW: usize = 1 << 20;

/// Collapses runs of one character to four while walking `text` backwards,
/// keeping at most `max_chars`: no copy of the whole window is made.
fn cut_runs_from_end(text: &str, max_chars: usize) -> String {
    let mut kept: Vec<char> = Vec::with_capacity(max_chars.min(text.len()));
    let mut run = 0usize;
    let mut last: Option<char> = None;
    for c in text.chars().rev() {
        if kept.len() >= max_chars {
            break;
        }
        if Some(c) == last {
            run += 1;
            if run > 4 {
                continue;
            }
        } else {
            last = Some(c);
            run = 1;
        }
        kept.push(c);
    }
    kept.into_iter().rev().collect()
}

/// The end of a PTY's output as the matchers read it: a run of one
/// character longer than four is cut to four, so a full-width rule
/// (32,767 columns on Windows) can't push a dialog's words out, then the
/// last `max_chars` are kept. It walks the last [`MATCHER_RAW_WINDOW`]
/// bytes backwards and stops once it has them (it runs every poll, under
/// the output's lock).
pub(crate) fn matcher_tail(screen: &[u8], max_chars: usize) -> String {
    let mut start = screen.len().saturating_sub(MATCHER_RAW_WINDOW);
    // Start on a character, not inside one.
    while start < screen.len() && (screen[start] & 0xC0) == 0x80 {
        start += 1;
    }
    cut_runs_from_end(&String::from_utf8_lossy(&screen[start..]), max_chars)
}

/// What a session stopped at a permission question says: the tool, and the
/// way on, then the screen's tail on lines of its own.
pub(crate) fn permission_question_message(tool: &str, tail: &str) -> String {
    format!(
        "Claude asks for permission to use {tool}; Plyloft never answers it in an unattended session, so the session was stopped. Allow it in your Claude settings' allow rules, or do this in a Claude tile. Its screen:\n{tail}"
    )
}

/// The result line's subtype for a session stopped at a permission question
/// mid-session: its text quotes the screen, so no reader classifies it.
pub(crate) const PERMISSION_QUESTION_SUBTYPE: &str = "error_permission_question";

/// [`result_line`] of a session stopped at a permission question.
pub(crate) fn permission_question_line(session_id: &str, tool: &str, tail: &str) -> String {
    serde_json::json!({
        "type": "result",
        "subtype": PERMISSION_QUESTION_SUBTYPE,
        "is_error": true,
        "result": permission_question_message(tool, tail),
        "session_id": session_id,
    })
    .to_string()
}

/// Result-line subtypes whose words no reader classifies as a sign-in or a
/// quota.
pub(crate) fn subtype_unclassifiable(subtype: &str) -> bool {
    matches!(
        subtype,
        TURN_WITHOUT_ANSWER_SUBTYPE | UNKNOWN_SCREEN_SUBTYPE | PERMISSION_QUESTION_SUBTYPE | UNKNOWN_COMMAND_SUBTYPE
    )
}

/// The line that heads an unattended writer session's screen in its output
/// when it ended without Plyloft's result line (a timeout, an exit before
/// its turn ended): its transcript first, then this, then the screen's tail,
/// once (`pty::CollectRun::wait`).
pub(crate) const SCREEN_AT_STOP: &str = "screen at stop:";

/// What a session's output showed on screen when it stopped
/// ([`SCREEN_AT_STOP`]), or the whole output for one without the label.
pub(crate) fn screen_at_stop(output: &str) -> &str {
    match output.rfind(&format!("{SCREEN_AT_STOP}\n")) {
        Some(at) => &output[at + SCREEN_AT_STOP.len() + 1..],
        None => output,
    }
}

/// The result line's subtype for a session whose first prompt named a
/// command Claude doesn't know: its words quote the screen.
pub(crate) const UNKNOWN_COMMAND_SUBTYPE: &str = "error_unknown_command";

/// Claude answered a slash prompt it doesn't know locally — "⏺ Unknown
/// command: /nope. Did you mean /copy?" (measured, Claude Code 2.1.300, live
/// walk of PR #384) — and went back to its composer, writing a transcript
/// but never ending a turn. Read on the screen as the last thing Claude
/// said: no `⏺` entry after it, the composer (`❯`) drawn after it, and no
/// working status ("esc to interrupt"). The command's name and Claude's own
/// sentence, or `None`.
pub(crate) fn unknown_command(screen: &str) -> Option<(String, String)> {
    // Claude's own words, as measured.
    const MARK: &str = "Unknown command: /";
    let text = strip_escapes(latest_frame(screen));
    let at = text.rfind(MARK)?;
    let after = &text[at..];
    let rest = &after[MARK.len()..];
    if rest.contains('⏺') || !rest.contains('❯') || rest.to_lowercase().contains("esc to interrupt") {
        return None;
    }
    let name: String = rest
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != '.' && *c != '?' && *c != ',')
        .collect();
    if name.is_empty() {
        return None;
    }
    // Claude's sentence: up to its line's end or the composer, its spaces
    // (drawn as cursor moves) as single spaces.
    let end = after.find(['\n', '❯']).unwrap_or(after.len());
    let said = after[..end].split_whitespace().collect::<Vec<_>>().join(" ");
    Some((name, said))
}

/// What a slash check stopped at an unknown command says.
pub(crate) fn unknown_command_message(name: &str, said: &str) -> String {
    format!("Claude doesn't know /{name} in this folder (Claude said: {said})")
}

/// [`result_line`] of a session stopped at an unknown command.
pub(crate) fn unknown_command_line(session_id: &str, name: &str, said: &str) -> String {
    serde_json::json!({
        "type": "result",
        "subtype": UNKNOWN_COMMAND_SUBTYPE,
        "is_error": true,
        "result": unknown_command_message(name, said),
        "session_id": session_id,
    })
    .to_string()
}

/// Whether a collected session's transcript shows Claude running `/<name>`
/// as a command: a user entry whose content carries
/// `<command-name>/<name></command-name>` (measured, Claude Code 2.1.300,
/// live walk of PR #384: `"<command-message>hello</command-message>\n
/// <command-name>/hello</command-name>"`, then an `isMeta` entry with the
/// command's body). A prompt Claude took as text (`//hello`) is plain
/// content and is not.
pub(crate) fn ran_as_command(output: &str, name: &str) -> bool {
    let wanted = format!("<command-name>/{}</command-name>", name.trim().trim_start_matches('/'));
    output
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .filter(|entry| entry.get("type").and_then(|t| t.as_str()) == Some("user"))
        .any(|entry| {
            let content = &entry["message"]["content"];
            match content {
                serde_json::Value::String(text) => text.contains(&wanted),
                serde_json::Value::Array(blocks) => blocks.iter().any(|block| {
                    block.get("text").and_then(|t| t.as_str()).is_some_and(|text| text.contains(&wanted))
                }),
                _ => false,
            }
        })
}

/// What a session stopped on a screen only the member can get past says.
/// Each names its cause in words the failure classifiers read
/// (`review_failure::classify`, the probe's and the discussion's): "not
/// logged in" is a sign-in, "usage limit" a quota.
pub(crate) const NOT_LOGGED_IN: &str = "Claude is not logged in on this machine (Please run /login). Open Claude in a terminal tile, sign in, then try again.";
pub(crate) const FIRST_RUN_SETUP: &str = "Claude's first-run setup isn't finished. Open Claude in a terminal tile once and finish it, then try again.";
pub(crate) const API_KEY_QUESTION: &str = "Claude asks whether to use the API key in its environment (ANTHROPIC_API_KEY). Plyloft never answers that question for you: remove the variable, or answer it once in a Claude tile.";
pub(crate) const TURN_WITHOUT_ANSWER: &str = "Claude's turn ended without an answer.";
pub(crate) const USAGE_LIMIT: &str = "Claude's usage limit is reached. Try again after it resets.";
// P-D2 Mac walk: in words, not the settings key (`permissions.defaultMode`).
pub(crate) const BYPASS_QUESTION: &str = "Claude asks you to accept Bypass Permissions mode before it starts, because your Claude settings start it in that mode. Plyloft never answers that question for you: accept it once in a Claude tile, or choose another mode in Claude's settings, then try again.";

/// The result line's subtype for an unattended writer session stopped by
/// the startup net (`pty::SessionWatch`): its text quotes a screen Plyloft
/// doesn't know, so no reader classifies it ([`unclassifiable`]).
pub(crate) const UNKNOWN_SCREEN_SUBTYPE: &str = "error_unknown_screen";

/// What a session stopped by the startup net says: the marker sentence on
/// its own line, then the screen's tail.
pub(crate) fn unknown_screen_message(tail: &str) -> String {
    format!("Claude is waiting on a screen Plyloft doesn't know, so the session was stopped. Its screen:\n{tail}")
}

/// Whether a collected session's result line carries words no reader may
/// classify as a sign-in or a quota: Claude's own (a turn that ended without
/// an answer) or an unknown screen's.
pub(crate) fn unclassifiable(output: &str) -> bool {
    result_subtype(output).is_some_and(|subtype| subtype_unclassifiable(&subtype))
}

fn result_subtype(output: &str) -> Option<String> {
    output
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .find(|value| value.get("type").and_then(|t| t.as_str()) == Some("result"))
        .and_then(|value| value.get("subtype").and_then(|s| s.as_str()).map(str::to_string))
}

/// [`result_line`] of an unattended writer session the startup net stopped.
pub(crate) fn unknown_screen_line(session_id: &str, tail: &str) -> String {
    serde_json::json!({
        "type": "result",
        "subtype": UNKNOWN_SCREEN_SUBTYPE,
        "is_error": true,
        "result": unknown_screen_message(tail),
        "session_id": session_id,
    })
    .to_string()
}

/// A screen the TUI waits on that writes no transcript, so the session
/// would otherwise sit until its timeout. Only before the session started
/// (`started`: its transcript exists): after that, everything on screen may
/// be the conversation — a Challenger quoting these very screens — and a
/// limit reached mid-turn is the transcript's own API error, which ends the
/// turn. Only the latest frame is read (what follows the last clear or
/// cursor-home), and each screen by words of its own shape, never by a
/// phrase a brief echoed on the screen could carry.
pub(crate) fn blocking_screen(screen: &str, started: bool) -> Option<&'static str> {
    if started {
        return None;
    }
    let flat = flat(latest_frame(screen));
    let has = |needles: &[&str]| needles.iter().any(|needle| flat.contains(needle));
    // The menu itself: both of its ways out.
    if flat.contains("waitforlimittoreset") && flat.contains("upgrade") {
        return Some(USAGE_LIMIT);
    }
    if has(&["selectloginmethod", "invalidapikey·pleaserun/login"]) {
        return Some(NOT_LOGGED_IN);
    }
    if has(&["doyouwanttousethisapikey", "detectedacustomapikey"]) {
        return Some(API_KEY_QUESTION);
    }
    if has(&["choosethetextstyle", "let'sgetstarted", "let’sgetstarted"]) {
        return Some(FIRST_RUN_SETUP);
    }
    // Claude's warning before its first session in Bypass Permissions mode:
    // the mode's name and both ways out ("No, exit" / "Yes, I accept").
    if flat.contains("bypasspermissionsmode") && flat.contains("yes,iaccept") && flat.contains("no,exit") {
        return Some(BYPASS_QUESTION);
    }
    None
}

/// What the TUI drew since it last cleared the screen or sent the cursor
/// home: the frame on screen now. Without either, the whole of `screen`.
pub(crate) fn latest_frame(screen: &str) -> &str {
    ["\u{1b}[2J", "\u{1b}[H", "\u{1b}[1;1H"]
        .iter()
        .filter_map(|mark| screen.rfind(mark).map(|at| at + mark.len()))
        .max()
        .map_or(screen, |at| &screen[at..])
}

/// The end of what the TUI drew, readable: escapes removed (a cursor move
/// right is a space, a cursor position a new line), blank lines dropped.
/// What a session that ended without an answer reports.
pub(crate) fn screen_tail(screen: &[u8], max_chars: usize) -> String {
    let text = strip_escapes(&String::from_utf8_lossy(screen));
    // A row of frame glyphs (a rule, a box's edge — 32,767 columns of it on
    // Windows) is no text the member needs; runs of one character are cut
    // to four, so what is left is the words.
    let lines: Vec<String> = text
        .lines()
        .map(str::trim_end)
        .filter(|line| line.chars().any(|c| !c.is_whitespace() && !is_frame_glyph(c)))
        .map(|line| cut_runs_from_end(line, usize::MAX))
        .collect();
    let joined = lines.join("\n");
    let count = joined.chars().count();
    if count <= max_chars {
        return joined;
    }
    let tail: String = joined.chars().skip(count - max_chars).collect();
    format!("…{tail}")
}

pub(crate) fn strip_escapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            continue;
        }
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            // CSI: parameters, then one final byte in @..~.
            Some('[') => {
                chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        match next {
                            'C' => out.push(' '),
                            'H' | 'f' | 'E' | 'B' => out.push('\n'),
                            _ => {}
                        }
                        break;
                    }
                }
            }
            // OSC: up to BEL or ESC \.
            Some(']') => {
                chars.next();
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            // A character-set designation, `ESC ( B` (what `sgr0` sends):
            // two characters, or its `B` is left on a line of its own (live
            // walk of PR #384's step log).
            Some('(' | ')' | '*' | '+' | '-' | '.' | '/' | '#' | '%') => {
                chars.next();
                chars.next();
            }
            // DCS, APC, PM: a string up to ESC \.
            Some('P' | '_' | '^') => {
                chars.next();
                while let Some(next) = chars.next() {
                    if next == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {
                chars.next();
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(value: serde_json::Value) -> String {
        value.to_string()
    }

    /// The UI recognises a refused session by this exact text
    /// (`src/lib/claudeReviewTrust.ts`), so the two must not drift apart.
    #[test]
    fn folder_trust_refusal_matches_the_ui_constant() {
        let ui = include_str!("../../src/lib/claudeReviewTrust.ts");
        assert!(
            ui.contains(&format!("\"{FOLDER_TRUST_REFUSAL}\"")),
            "FOLDER_TRUST_REFUSAL in src/lib/claudeReviewTrust.ts differs from claude_session.rs"
        );
    }

    fn assistant(id: &str, content: serde_json::Value, stop: Option<&str>) -> String {
        line(serde_json::json!({
            "type": "assistant",
            "message": {"id": id, "role": "assistant", "content": content, "stop_reason": stop,
                        "usage": {"input_tokens": 3, "output_tokens": 5}},
        }))
    }

    #[test]
    fn an_interactive_argv_names_its_session_and_a_print_one_does_not() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            collected_session_id(&args(&["--session-id", "abc", "--restricted", "review"])),
            Some("abc".into())
        );
        assert_eq!(collected_session_id(&args(&["-p", "x", "--session-id", "abc"])), None);
        assert_eq!(collected_session_id(&args(&["--restricted", "review"])), None);
        assert_eq!(collected_session_id(&args(&["--session-id"])), None);
    }

    #[test]
    fn a_turn_is_done_when_the_assistant_ends_it_with_its_text() {
        let transcript = [
            line(serde_json::json!({"type": "permission-mode"})),
            line(serde_json::json!({"type": "user", "message": {"role": "user", "content": "review"}})),
            assistant("m1", serde_json::json!([{"type": "tool_use", "name": "Read", "input": {}}]), Some("tool_use")),
            line(serde_json::json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}})),
            assistant("m2", serde_json::json!([{"type": "thinking", "thinking": "hm"}]), None),
            assistant("m2", serde_json::json!([{"type": "text", "text": "{\"verdict\":"}]), None),
            assistant("m2", serde_json::json!([{"type": "text", "text": "\"approve\"}"}]), Some("end_turn")),
            line(serde_json::json!({"type": "system"})),
        ]
        .join("\n");
        let Turn::Done { text, is_error, usage, .. } = read_turn(&transcript) else {
            panic!("not done");
        };
        assert_eq!(text, "{\"verdict\":\n\"approve\"}");
        assert!(!is_error);
        assert_eq!(usage.unwrap()["output_tokens"], 5);
    }

    #[test]
    fn a_turn_waiting_on_a_tool_or_still_writing_is_pending() {
        let tool = assistant("m1", serde_json::json!([{"type": "tool_use", "name": "Bash", "input": {}}]), Some("tool_use"));
        assert_eq!(read_turn(&tool), Turn::Pending);
        let result = [
            tool.clone(),
            line(serde_json::json!({"type": "user", "message": {"content": [{"type": "tool_result"}]}})),
        ]
        .join("\n");
        assert_eq!(read_turn(&result), Turn::Pending);
        assert_eq!(read_turn(""), Turn::Pending);
        assert_eq!(read_turn("not json\n"), Turn::Pending);
    }

    #[test]
    fn an_api_error_ends_the_turn_as_an_error() {
        let transcript = line(serde_json::json!({
            "type": "assistant",
            "isApiErrorMessage": true,
            "message": {"id": "e", "content": [{"type": "text", "text": "Claude usage limit reached"}], "stop_reason": "stop_sequence"},
        }));
        let Turn::Done { text, is_error, .. } = read_turn(&transcript) else {
            panic!("not done");
        };
        assert!(is_error);
        assert_eq!(text, "Claude usage limit reached");
    }

    #[test]
    fn the_result_line_reads_like_print_mode_for_every_reader() {
        let ok = result_line("s", "{\"verdict\":\"approve\"}", false, None);
        assert_eq!(
            crate::read_only_provider::extract_final_message(crate::coordination::Provider::Claude, &format!("{{\"type\":\"user\"}}\n{ok}")),
            Some("{\"verdict\":\"approve\"}".into())
        );
        let failed = result_line("s", "Claude usage limit reached", true, None);
        assert_eq!(
            crate::read_only_provider::extract_error_message(crate::coordination::Provider::Claude, &failed),
            Some("Claude usage limit reached".into())
        );
    }

    #[test]
    fn the_folder_trust_question_is_seen_through_terminal_escapes() {
        let drawn = "\u{1b}[2J Quick\u{1b}[1Csafety\u{1b}[1Ccheck: Is this a project you created or one you trust?\r\n \u{1b}[38;5;2m❯ 1. Yes, I\u{1b}[1Ctrust\u{1b}[1Cthis\u{1b}[1Cfolder\u{1b}[0m\r\n   2. No,\u{1b}[1Cexit\r\n\r\n Enter\u{1b}[1Cto\u{1b}[1Cconfirm · Esc to cancel\u{1b}[39m\r\n";
        assert!(asks_for_folder_trust(drawn));
        assert!(!asks_for_folder_trust("❯ Reply PONG\r\n⏺ PONG"));
        // A brief quoting the answer, echoed on the screen, is not the dialog.
        assert!(!asks_for_folder_trust(
            "❯ When Claude asks, choose \"Yes, I trust this folder\" and go on."
        ));
    }

    /// Real-shaped (Claude Code 2.1.299): every line of a message carries its
    /// final stop reason, a thinking line comes first, and `turn_duration`
    /// closes the turn.
    #[test]
    fn the_turn_ends_on_claudes_end_of_turn_entry_not_on_a_thinking_line() {
        let mut read = Transcript::default();
        read.push(format!("{}\n", line(serde_json::json!({"type": "user", "message": {"role": "user", "content": "review"}}))).as_bytes());
        read.push(format!("{}\n", assistant("m1", serde_json::json!([{"type": "thinking", "thinking": "hm"}]), Some("end_turn"))).as_bytes());
        // Final-looking, but no answer and no end-of-turn entry yet.
        assert!(matches!(read.turn(), Turn::Done { ref text, .. } if text.is_empty()));
        assert!(!read.answer_shaped());
        assert!(!read.turn_over());
        // The text line arrives in two writes: half a line waits.
        let text = assistant("m1", serde_json::json!([{"type": "text", "text": "{\"verdict\":\"approve\"}"}]), Some("end_turn"));
        let (head, tail) = text.split_at(20);
        read.push(head.as_bytes());
        assert!(!read.answer_shaped(), "an incomplete line is not read");
        read.push(format!("{tail}\n").as_bytes());
        assert!(read.answer_shaped());
        assert!(!read.turn_over());
        read.push(format!("{}\n", line(serde_json::json!({"type": "system", "subtype": "turn_duration", "durationMs": 18000}))).as_bytes());
        assert!(read.turn_over());
        let Turn::Done { text, .. } = read.turn() else { panic!("not done") };
        assert_eq!(text, "{\"verdict\":\"approve\"}");
        assert!(read.raw().contains("turn_duration"));
    }

    /// A Stop hook that continues the turn: the end-of-turn entry of the
    /// first stop is followed by more conversation, which reopens the turn.
    #[test]
    fn a_turn_a_stop_hook_continues_is_open_again() {
        let mut read = Transcript::default();
        read.push(format!(
            "{}\n{}\n",
            assistant("m1", serde_json::json!([{"type": "text", "text": "draft"}]), Some("end_turn")),
            line(serde_json::json!({"type": "system", "subtype": "turn_duration"})),
        ).as_bytes());
        assert!(read.turn_over());
        read.push(format!("{}\n", line(serde_json::json!({"type": "user", "message": {"content": "Stop hook feedback: keep going"}}))).as_bytes());
        assert!(!read.turn_over());
        assert_eq!(read.turn(), Turn::Pending);
        assert_eq!(read.ended(), None);
    }

    /// The end-of-turn entry after a user entry (a tool result, a hook's
    /// feedback): the turn ended without an answer, so it ends as an error
    /// carrying the last thing the assistant said — not a wait for the
    /// timeout.
    #[test]
    fn a_turn_that_ends_after_a_user_entry_ends_as_an_error() {
        let mut read = Transcript::default();
        read.push(format!(
            "{}\n{}\n{}\n",
            assistant("m1", serde_json::json!([{"type": "text", "text": "Reading the diff."}, {"type": "tool_use", "name": "Read", "input": {}}]), Some("tool_use")),
            line(serde_json::json!({"type": "user", "message": {"content": [{"type": "tool_result", "content": "…"}]}})),
            line(serde_json::json!({"type": "system", "subtype": "turn_duration"})),
        ).as_bytes());
        assert_eq!(read.turn(), Turn::Pending);
        assert_eq!(
            read.ended(),
            Some(Turn::Done { text: "Reading the diff.".into(), is_error: true, usage: None, without_answer: true })
        );
        let mut silent = Transcript::default();
        silent.push(format!(
            "{}\n{}\n",
            line(serde_json::json!({"type": "user", "message": {"content": "review"}})),
            line(serde_json::json!({"type": "system", "subtype": "turn_duration"})),
        ).as_bytes());
        assert_eq!(
            silent.ended(),
            Some(Turn::Done { text: TURN_WITHOUT_ANSWER.into(), is_error: true, usage: None, without_answer: true })
        );
    }

    /// Challenger round 6 on PR #374: a turn that ended without an answer
    /// says so in its result line's subtype, so no reader takes Claude's own
    /// words ("I can't authenticate…") for a sign-in or quota failure.
    #[test]
    fn a_turn_without_an_answer_is_marked_in_its_result_line() {
        let words = "I can't authenticate to the service; the usage limit is unclear.";
        let marked = result_line_for("s", words, true, true, None);
        assert!(marked.contains(TURN_WITHOUT_ANSWER_SUBTYPE));
        assert!(ended_without_answer(&format!("{{\"type\":\"user\"}}\n{marked}\n")));
        assert!(!ended_without_answer(&result_line("s", words, true, None)));
        assert!(!ended_without_answer(&result_line("s", "ok", false, None)));
        assert!(!ended_without_answer("{\"type\":\"user\"}"));
        // Not an error, never marked.
        assert!(!result_line_for("s", "ok", false, true, None).contains(TURN_WITHOUT_ANSWER_SUBTYPE));
    }

    #[test]
    fn screens_only_the_member_can_get_past_stop_the_session_in_classifiable_words() {
        let login = "\u{1b}[1mInvalid API key \u{b7} Please\u{1b}[1Crun\u{1b}[1C/login\u{1b}[0m";
        assert_eq!(blocking_screen(login, false), Some(NOT_LOGGED_IN));
        assert_eq!(blocking_screen("Select login method:\r\n ❯ 1. Claude account with subscription", false), Some(NOT_LOGGED_IN));
        assert_eq!(blocking_screen("Let's get started.\r\n Choose the text style that looks best with your terminal", false), Some(FIRST_RUN_SETUP));
        assert_eq!(blocking_screen("Detected a custom API key in your environment\r\n Do you want to use this API key?", false), Some(API_KEY_QUESTION));
        let limit = "Claude usage limit reached.\r\n What do you want to do?\r\n ❯ 1. Stop and wait for limit to reset\r\n   2. Upgrade your plan";
        assert_eq!(blocking_screen(limit, false), Some(USAGE_LIMIT));
        // Once the session started, everything on screen may be the
        // conversation: a streamed answer quoting the very menu does not stop
        // it (a real mid-turn limit is the transcript's API error).
        assert_eq!(blocking_screen(limit, true), None);
        assert_eq!(blocking_screen(login, true), None);
        assert_eq!(blocking_screen("❯ review the diff\r\n⏺ Reading 3 files", false), None);
        // Before it started: a brief echoed on the screen that quotes the
        // sign-in error or the menu's words is not those screens.
        let brief = "❯ When Claude says \"Please run /login\" or \"Not logged in\", ask the member to sign in; offer \"Stop and wait for limit to reset\".";
        assert_eq!(blocking_screen(brief, false), None);
        // Only the latest frame counts: a menu drawn, then cleared, is gone.
        let cleared = format!("{limit}\u{1b}[2J\u{1b}[H╭ Claude Code ╮\r\n❯ ");
        assert_eq!(blocking_screen(&cleared, false), None);
        assert_eq!(blocking_screen(&format!("old\u{1b}[2J{limit}"), false), Some(USAGE_LIMIT));
        // The classifiers read them as a sign-in and a quota.
        use crate::review_failure::{classify, ProviderFailure};
        assert_eq!(classify(NOT_LOGGED_IN, Some(1), false, true), ProviderFailure::NotSignedIn);
        assert_eq!(classify(USAGE_LIMIT, Some(1), false, true), ProviderFailure::UsageLimit);
        assert!(NOT_LOGGED_IN.to_ascii_lowercase().contains("not logged in"));
        assert!(USAGE_LIMIT.to_ascii_lowercase().contains("usage limit"));
    }

    #[test]
    fn a_screen_tail_is_readable_text() {
        let screen = b"\x1b]0;claude\x07\x1b[2J\x1b[1;1HWelcome\x1b[1Cback\r\n\r\n\x1b[38;5;1mError:\x1b[1Csomething\x1b[0m\r\n";
        assert_eq!(screen_tail(screen, 100), "Welcome back\nError: something");
        assert_eq!(screen_tail(b"abcdef", 3), "…def");
    }

    /// Sessions moved under `claude-sessions`; a leftover under the old
    /// root goes, one an older Plyloft may still be reading stays.
    #[test]
    fn legacy_worktrees_are_retired_and_fresh_ones_kept() {
        let config = tempfile::tempdir().unwrap();
        assert_eq!(
            session_worktrees(config.path(), "discussions"),
            config.path().join("claude-sessions/discussions/worktrees")
        );
        let left = config.path().join("discussions/worktrees/d1/analysis_a");
        std::fs::create_dir_all(&left).unwrap();
        std::fs::write(left.join("file.rs"), "x").unwrap();
        retire_legacy_worktrees(config.path(), "discussions");
        assert!(left.exists(), "touched within the hour: kept");
        retire_legacy_worktrees_older_than(config.path(), "discussions", std::time::Duration::ZERO);
        assert!(!config.path().join("discussions/worktrees").exists());
        assert!(config.path().join("discussions").exists(), "the kind's own folder stays");
        retire_legacy_worktrees(config.path(), "reviews"); // nothing there: no-op
    }

    #[test]
    fn windows_paths_compare_without_case_or_separator() {
        assert!(within_windows(r"C:\Users\A\AppData\Roaming\com.mbadv.ply\claude-sessions\reviews", "c:/users/a/AppData/Roaming/com.mbadv.ply/claude-sessions"));
        assert!(within_windows(r"\\?\C:\Users\A\x", r"C:\Users\A\"));
        assert!(within_windows(r"C:\Users\A", "C:/Users/A"));
        assert!(!within_windows(r"C:\Users\Apples", r"C:\Users\A"));
        assert!(!within_windows(r"C:\Users\A", ""));
    }

    #[test]
    fn the_transcript_is_found_under_any_project_directory() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("projects").join("-some-cwd");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("abc.jsonl"), "{}").unwrap();
        assert_eq!(find_transcript(dir.path(), "abc"), Some(project.join("abc.jsonl")));
        assert_eq!(find_transcript(dir.path(), "other"), None);
    }

    #[test]
    fn a_folder_inside_a_trusted_one_is_trusted() {
        let state = r#"{"projects":{"/Users/a/Library/App":{"hasTrustDialogAccepted":true},"/Users/a/other":{"hasTrustDialogAccepted":false}}}"#;
        assert_eq!(trusted_in(state, Path::new("/Users/a/Library/App/reviews/worktrees/r1")), Some(true));
        assert_eq!(trusted_in(state, Path::new("/Users/a/Library/App")), Some(true));
        assert_eq!(trusted_in(state, Path::new("/Users/a/Library/Apples")), Some(false));
        assert_eq!(trusted_in(state, Path::new("/Users/a/other/x")), Some(false));
        // G3b review (4a): unreadable, or no projects at all: unknown.
        assert_eq!(trusted_in("not json", Path::new("/Users/a/Library/App")), None);
        assert_eq!(trusted_in(r#"{"numStartups":3}"#, Path::new("/Users/a/Library/App")), None);
        assert_eq!(trusted_in(r#"{"projects":{}}"#, Path::new("/Users/a/Library/App")), Some(false));
    }

    /// The trust question is read on the frame on screen now, whatever
    /// Claude's state says about the folder (`pty::SessionWatch`): Claude
    /// asks again for a git root below a trusted folder.
    #[test]
    fn the_trust_question_is_read_on_the_latest_frame() {
        let dialog = "Quick safety check: Is this a project you created or one you trust?\r\n❯ No, exit\r\n  Yes, I trust this folder\r\n\r\nEnter to confirm · Esc to cancel\r\n";
        assert!(asks_for_folder_trust(&format!("starting…\r\n\u{1b}[2J{dialog}")));
        assert!(!asks_for_folder_trust(&format!("{dialog}\u{1b}[2J╭ Welcome to Claude Code")));
    }

    /// Challenger P2-1 on PR #374: a prompt that quotes the whole dialog —
    /// footer and all — is echoed with the prompt box and status line drawn
    /// after it, so it is not the dialog; nor is a footer before the question.
    #[test]
    fn the_dialogs_other_wording_labels_and_key_names_are_read() {
        // The second question, the other cancel label, and a member's own keys.
        let other = "Accessing workspace:\r\n/x\r\n\r\nQuick safety check: is this a project you created or one you trust? Sessions started here can read, edit, and execute files.\r\n❯ Yes, I trust this folder\r\n  No, continue without these permissions\r\n\r\nctrl+y to confirm · q to cancel\u{1b}[39m\r\n";
        assert!(asks_for_folder_trust(other));
        assert!(asks_for_folder_trust(&other.replace("ctrl+y to confirm · q", "Enter to confirm · Esc")));
        // The footer's two halves must stay together, at the end.
        assert!(!asks_for_folder_trust(&other.replace("ctrl+y to confirm · q", "to confirm, then a long sentence of a brief that runs on, then")));
    }

    #[test]
    fn a_prompt_quoting_the_whole_dialog_is_not_the_dialog() {
        let quoted = "> Review this. Quick safety check: Is this a project you created or one you trust? ❯ No, exit / Yes, I trust this folder. Enter to confirm · Esc to cancel\r\n";
        let echoed = format!("{quoted}\u{1b}[2G────────────\r\n❯ \r\n────────────\r\n  ⏵⏵ auto mode on (shift+tab to cycle)");
        assert!(!asks_for_folder_trust(&echoed));
        assert!(!asks_for_folder_trust("Enter to confirm · Esc to cancel Quick safety check ❯ No, exit Yes, I trust this folder"));
        assert!(!asks_for_folder_trust("Quick safety check: … Enter to confirm · Esc to cancel"));
    }

    /// The guard on where a collected Claude session runs: every place that
    /// builds a Claude session's read tree under the session root builds it
    /// plain (`pinned_read`'s and the probe's own tests prove a plain tree
    /// holds no `.git`), never a worktree root Claude would ask about.
    #[test]
    fn every_claude_session_folder_is_built_plain() {
        for (file, source) in [
            ("reviewer.rs", include_str!("reviewer.rs")),
            ("discussion.rs", include_str!("discussion.rs")),
            ("proposals.rs", include_str!("proposals.rs")),
            ("build_both.rs", include_str!("build_both.rs")),
            ("next_improvement_round.rs", include_str!("next_improvement_round.rs")),
        ] {
            // Up to the top-level test module, not the first `#[cfg(test)]`:
            // a test-only helper above the session code (next_improvement_round.rs's
            // `load`, 1.174.0 B5) would otherwise hide it.
            let code = production_part(source);
            assert!(code.contains("session_worktrees("), "{file} runs its sessions outside the session root");
            assert!(code.contains("DetachedReadWorktree::create_plain"), "{file} gives Claude a worktree root");
        }
        let probe = include_str!("review_capabilities.rs");
        assert!(probe.contains("let plain = init_probe_repo(provider, &root)?;"));
        assert!(probe.contains("PlainTree::register(path.to_path_buf(), git_dir)"));
    }

    /// The production part of a source file: up to its top-level test
    /// module (`#[cfg(test…)]` then `mod <name> {` at column 0).
    fn production_part(source: &str) -> &str {
        let mut offset = 0;
        for line in source.split_inclusive('\n') {
            let rest = &source[offset + line.len()..];
            if line.starts_with("#[cfg(") && line.contains("test") && rest.starts_with("mod ") {
                return &source[..offset];
            }
            offset += line.len();
        }
        source
    }

    /// Hard rule 1 after Anthropic's `-p` billing announcement: no Plyloft
    /// code passes `-p` / `--print` or print mode's output flag to a CLI.
    /// Every non-test source under `src/` is read; the allowed uses are
    /// another program's own `-p` (cargo's package, git's parent, the
    /// CLT probe) and the checks that refuse or recognise print mode.
    #[test]
    fn no_claude_spawn_uses_print_mode() {
        const ALLOWED: [(&str, &str); 6] = [
            ("build_cache.rs", "args.push(\"-p\".into());"), // cargo clean -p <crate>
            ("shared_config.rs", "\"commit-tree\""),          // git commit-tree -p <parent>
            ("worktrees.rs", "\"commit-tree\""),              // git commit-tree -p <parent> (H6b land)
            ("ship.rs", "\"commit-tree\""),                   // git commit-tree -p <parent> (R6 kept stash, R7 batch step)
            ("shell_env.rs", "command.arg(\"-p\");"),          // xcode-select -p
            ("test_bridge.rs", "ps_lines(&["),                // ps -p <pid>, dev-only
        ];
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        let mut dirs = vec![src];
        while let Some(dir) = dirs.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    dirs.push(path);
                } else if path.extension().is_some_and(|ext| ext == "rs")
                    && !path.to_string_lossy().ends_with("_tests.rs")
                {
                    files.push(path);
                }
            }
        }
        assert!(files.len() > 100, "the source tree was read: {}", files.len());
        let mut found = Vec::new();
        for path in files {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let source = std::fs::read_to_string(&path).unwrap();
            for (index, line) in production_part(&source).lines().enumerate() {
                let passes = ["\"-p\"", "\"--print\"", "\"--output-format\""].iter().any(|flag| line.contains(flag));
                let checks = line.contains("== \"-p\"") || line.contains("== \"--print\"");
                let allowed = ALLOWED.iter().any(|(file, text)| *file == name && line.contains(text));
                if passes && !checks && !allowed {
                    found.push(format!("{name}:{}: {}", index + 1, line.trim()));
                }
            }
        }
        assert!(found.is_empty(), "print-mode flags passed to a CLI:\n{}", found.join("\n"));
        assert_eq!(production_part("fn a() {}\n#[cfg(all(test, unix))]\nmod tests {\n\"-p\"\n}\n"), "fn a() {}\n");
    }

    /// The member's `defaultMode`, in Claude's precedence (managed, local,
    /// project, user), maps onto what an unattended session can do: bypass
    /// stays bypass, acceptEdits is `dontAsk` with the edit tools, anything
    /// else (or nothing readable) is `dontAsk`.
    ///
    /// 1.175.0 (A6, SEC-3): only the member's own files choose it. A file
    /// that comes with the repository narrows it, and never widens it.
    #[test]
    fn the_writer_mode_follows_the_members_default_mode() {
        let mode = |m: &str| Some(format!(r#"{{"permissions":{{"defaultMode":"{m}"}}}}"#));
        let own = |m: &str| Layer::Own(mode(m));
        let shared = |m: &str| Layer::Shared(mode(m));
        let of = |layers: &[Layer]| writer_mode_in(layers).mode;
        assert_eq!(default_mode_of(mode("acceptEdits").as_deref()).as_deref(), Some("acceptEdits"));
        assert_eq!(of(&[Layer::Own(None), own("acceptEdits"), own("bypassPermissions")]), WriterMode::AcceptEdits);
        assert_eq!(of(&[own("plan"), own("bypassPermissions")]), WriterMode::Refuse, "managed wins");
        // Invalid, unreadable or silent layers say nothing.
        assert_eq!(
            of(&[Layer::Own(Some("{not json".into())), Layer::Shared(None), Layer::Own(Some(r#"{"permissions":{}}"#.into())), own("acceptEdits")]),
            WriterMode::AcceptEdits
        );
        assert_eq!(default_mode_of(Some("{not json")), None);
        assert_eq!(of(&[Layer::Own(Some("{not json".into())), Layer::Shared(None)]), WriterMode::Refuse);
        assert_eq!(WriterMode::from_default_mode(Some("bypassPermissions")), WriterMode::Bypass);
        assert_eq!(WriterMode::from_default_mode(Some("acceptEdits")), WriterMode::AcceptEdits);
        for other in [Some("default"), Some("dontAsk"), Some("plan"), Some("auto"), None] {
            assert_eq!(WriterMode::from_default_mode(other), WriterMode::Refuse, "{other:?}");
        }

        // Round 3 (S2): the repository may ask for accept edits, never for
        // bypass. A file that isn't the member's own and asks for bypass
        // gets accept edits, and who asked is kept.
        let capped = WriterChoice { mode: WriterMode::AcceptEdits, bypass_not_followed: Some(BypassAsked::Shared) };
        assert_eq!(writer_mode_in(&[Layer::Own(None), shared("bypassPermissions"), Layer::Own(None)]), capped);
        assert_eq!(writer_mode_in(&[shared("bypassPermissions"), own("acceptEdits")]), capped);
        assert_eq!(writer_mode_in(&[shared("bypassPermissions"), own("plan")]), capped, "above the member's own, as in Claude");
        assert_eq!(writer_mode_in(&[shared("bypassPermissions"), shared("bypassPermissions"), Layer::Own(None)]), capped);
        // Accept edits asked by the repository is followed, with nothing said.
        let edits = WriterChoice { mode: WriterMode::AcceptEdits, bypass_not_followed: None };
        assert_eq!(writer_mode_in(&[shared("acceptEdits"), Layer::Own(None)]), edits, "no mode of the member's own");
        assert_eq!(writer_mode_in(&[shared("acceptEdits"), own("default")]), edits);
        assert_eq!(writer_mode_in(&[shared("acceptEdits"), own("bypassPermissions")]), edits, "the project's file is above the user's");
        // The member's own bypass is bypass, whatever the project asks for.
        let both = writer_mode_in(&[shared("bypassPermissions"), own("bypassPermissions")]);
        assert_eq!(both, WriterChoice { mode: WriterMode::Bypass, bypass_not_followed: None });
        assert_eq!(of(&[Layer::Shared(None), own("bypassPermissions")]), WriterMode::Bypass);
        // A shared file that names a mode which asks decides where Claude
        // puts it first — above the user's settings…
        assert_eq!(of(&[shared("plan"), own("bypassPermissions")]), WriterMode::Refuse);
        // …and not below the member's own local file.
        assert_eq!(of(&[own("bypassPermissions"), shared("plan")]), WriterMode::Bypass);
        assert_eq!(of(&[own("acceptEdits"), shared("bypassPermissions"), own("default")]), WriterMode::AcceptEdits);
        assert_eq!(writer_mode_in(&[own("acceptEdits"), shared("bypassPermissions")]).bypass_not_followed, None, "it never came to the project's file");

        // The folder's own local file that git couldn't judge is read like a
        // shared one, and a bypass it alone asks for is only logged.
        let unjudged = |m: &str| Layer::Unjudged(mode(m));
        assert_eq!(
            writer_mode_in(&[unjudged("bypassPermissions"), Layer::Own(None)]),
            WriterChoice { mode: WriterMode::AcceptEdits, bypass_not_followed: Some(BypassAsked::Unjudged) }
        );
        assert_eq!(writer_mode_in(&[unjudged("bypassPermissions"), shared("bypassPermissions")]), capped, "the project's file asks too");
        assert_eq!(writer_mode_in(&[unjudged("acceptEdits")]), edits);
        assert_eq!(of(&[unjudged("bypassPermissions"), own("bypassPermissions")]), WriterMode::Bypass);
    }

    fn git_in(dir: &Path, args: &[&str]) {
        let out = crate::platform::git_command().args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// Round 3 (S1, the blocker): a file that comes with the repository never
    /// counts as the member's own, however the disk and git's exact-path,
    /// exact-case answer disagree about it — a link, a case variant of the
    /// folder or of the file, a repository of its own at `.claude`, a
    /// workspace folder whose name git would read as a pattern.
    #[test]
    fn a_file_the_repository_brings_is_never_the_members_own_however_it_is_reached() {
        let bypass = r#"{"permissions":{"defaultMode":"bypassPermissions"}}"#;
        let of = |cwd: &Path| writer_mode_in(&settings_layers(cwd, vec![None], Layer::Own(None)));
        let dir = tempfile::tempdir().unwrap();
        let repo = |name: &str| {
            let project = dir.path().join(name);
            std::fs::create_dir_all(&project).unwrap();
            git_in(&project, &["init", "-q"]);
            project
        };
        let put = |file: PathBuf| {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, bypass).unwrap();
        };
        // Every layout is tried before the test fails, so one run names all
        // that still choose bypass.
        let chose_bypass = std::cell::RefCell::new(Vec::<String>::new());
        let not_bypass = |project: &Path, what: &str| {
            if of(project).mode == WriterMode::Bypass {
                chose_bypass.borrow_mut().push(what.to_string());
            }
        };

        // The control: a file of the member's own, which git doesn't track.
        let clean = repo("clean");
        put(clean.join(".claude/settings.local.json"));
        assert_eq!(of(&clean).mode, WriterMode::Bypass, "a clean untracked local file is theirs");

        // 1. `.claude` committed as a link to a folder whose file is tracked.
        #[cfg(unix)]
        {
            let linked = repo("linked");
            put(linked.join("config/claude/settings.local.json"));
            std::os::unix::fs::symlink("config/claude", linked.join(".claude")).unwrap();
            git_in(&linked, &["add", "-f", "."]);
            assert!(linked.join(".claude/settings.local.json").is_file(), "the disk follows the link");
            not_bypass(&linked, "a tracked file behind a committed link");
            assert_eq!(own_local_settings(&linked), LocalSettings::Shared, "the repository's link");

            // A link nobody committed is not taken either: what it points at
            // can be anything, a tracked folder included.
            let own_link = repo("own-link");
            put(dir.path().join("elsewhere/settings.local.json"));
            std::os::unix::fs::symlink(dir.path().join("elsewhere"), own_link.join(".claude")).unwrap();
            not_bypass(&own_link, "an untracked link at .claude");
            // Round 5 (V2): the member's own link — never theirs to choose
            // bypass with, and nothing is said of "this project's settings".
            assert_eq!(own_local_settings(&own_link), LocalSettings::Unjudged);
            assert_eq!(of(&own_link).bypass_not_followed, Some(BypassAsked::Unjudged));
            let file_link = repo("file-link");
            std::fs::create_dir_all(file_link.join(".claude")).unwrap();
            std::os::unix::fs::symlink(
                dir.path().join("elsewhere/settings.local.json"),
                file_link.join(".claude/settings.local.json"),
            )
            .unwrap();
            not_bypass(&file_link, "a link in place of the file");
            assert_eq!(own_local_settings(&file_link), LocalSettings::Unjudged);
            git_in(&file_link, &["add", "-f", ".claude/settings.local.json"]);
            assert_eq!(own_local_settings(&file_link), LocalSettings::Shared, "committed, it is the repository's");
            // A second name for the same bytes (a hard link).
            let hard = repo("hard-link");
            put(hard.join("shared.json"));
            git_in(&hard, &["add", "-f", "shared.json"]);
            std::fs::create_dir_all(hard.join(".claude")).unwrap();
            std::fs::hard_link(hard.join("shared.json"), hard.join(".claude/settings.local.json")).unwrap();
            not_bypass(&hard, "a hard link to a tracked file");
        }

        // 2. and 3. A case variant of the file, or of the folder, tracked.
        let file_case = repo("file-case");
        put(file_case.join(".claude/Settings.local.json"));
        git_in(&file_case, &["add", "-f", "."]);
        not_bypass(&file_case, "a tracked Settings.local.json");
        let folder_case = repo("folder-case");
        put(folder_case.join(".Claude/settings.local.json"));
        git_in(&folder_case, &["add", "-f", "."]);
        not_bypass(&folder_case, "a tracked .Claude/settings.local.json");
        // The member's own file under the exact name, and a commit that
        // tracks a case variant of it: on a disk that ignores case they are
        // one file, and a pull writes the commit's bytes into it.
        let both = repo("index-case");
        put(both.join(".claude/settings.local.json"));
        git_in(&both, &["update-index", "--add", "--cacheinfo", "100644,e69de29bb2d1d6434b8b29ae775ad8c2e48c5391,.claude/Settings.local.json"]);
        not_bypass(&both, "the index holds a case variant");
        // …also in a repository told its disk keeps case apart.
        git_in(&both, &["config", "core.ignorecase", "false"]);
        not_bypass(&both, "core.ignorecase=false");

        // A repository of its own at `.claude` (a submodule): the project's
        // git doesn't list the file, and it is tracked all the same.
        let nested = repo("nested");
        put(nested.join(".claude/settings.local.json"));
        git_in(&nested.join(".claude"), &["init", "-q"]);
        git_in(&nested.join(".claude"), &["add", "-f", "."]);
        not_bypass(&nested, "a repository at .claude");

        // A workspace in a folder whose name git would read as a pattern.
        let odd = repo("odd");
        let web = odd.join("web[1]");
        put(web.join(".claude/settings.local.json"));
        assert_eq!(of(&web).mode, WriterMode::Bypass, "untracked, in a subfolder");
        git_in(&odd, &["add", "-f", "."]);
        not_bypass(&web, "tracked under web[1]");

        assert!(chose_bypass.borrow().is_empty(), "still choosing bypass: {:#?}", chose_bypass.borrow());
        assert_eq!(own_local_settings(&repo("empty")), LocalSettings::Absent);

        // The user's own settings are theirs — unless the file is really one
        // of the project's (linked into a dotfiles repository that is the
        // project): then a commit there changes it.
        let home = dir.path().join("home/.claude");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("settings.json"), bypass).unwrap();
        assert!(matches!(user_settings_layer(&clean, &home.join("settings.json")), Layer::Own(Some(_))));
        assert!(matches!(user_settings_layer(&clean, &home.join("none.json")), Layer::Own(None)));
        #[cfg(unix)]
        {
            let dotfiles = repo("dotfiles");
            put(dotfiles.join("claude/settings.json"));
            std::fs::remove_file(home.join("settings.json")).unwrap();
            std::os::unix::fs::symlink(dotfiles.join("claude/settings.json"), home.join("settings.json")).unwrap();
            assert!(matches!(user_settings_layer(&dotfiles, &home.join("settings.json")), Layer::Shared(Some(_))));
            assert!(matches!(user_settings_layer(&clean, &home.join("settings.json")), Layer::Own(Some(_))));
        }

        // A card's copy is a copy however its root's name is spelled.
        for spelled in [".plyloft-worktrees", ".Plyloft-Worktrees", ".ATELIER-WORKTREES"] {
            let copy = Path::new("/p").join(spelled).join("card-1");
            assert_eq!(own_settings_folder(&copy), Path::new("/p"), "{spelled}");
        }
        assert!(crate::worktrees::is_worktrees_dir_name(".PLYLOFT-WORKTREES"));
    }

    /// A6: which files on disk are the member's own. `settings.json` never
    /// is; `settings.local.json` is only where git says it doesn't track it;
    /// in a card's copy, it is the project's, never the copy's.
    #[test]
    fn only_the_members_own_settings_files_choose_the_writer_mode() {
        let mode = |m: &str| format!(r#"{{"permissions":{{"defaultMode":"{m}"}}}}"#);
        let of = |cwd: &Path, user: Option<&str>| {
            writer_mode_in(&settings_layers(cwd, vec![None], Layer::Own(user.map(&mode))))
        };
        // S2: bypass asked by a file that isn't the member's own is accept edits.
        let capped = WriterChoice { mode: WriterMode::AcceptEdits, bypass_not_followed: Some(BypassAsked::Shared) };
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let write = |folder: &Path, file: &str, text: &str| {
            std::fs::create_dir_all(folder.join(".claude")).unwrap();
            std::fs::write(folder.join(".claude").join(file), text).unwrap();
        };
        std::fs::create_dir_all(&project).unwrap();
        git_in(&project, &["init", "-q"]);

        // The repository's settings.json asks for bypass.
        write(&project, "settings.json", &mode("bypassPermissions"));
        assert_eq!(of(&project, None), capped);
        assert_eq!(of(&project, Some("acceptEdits")), capped);
        assert_eq!(of(&project, Some("plan")), capped);
        assert_eq!(of(&project, Some("bypassPermissions")).mode, WriterMode::Bypass, "the member's own bypass");

        // The member's own local file, which git doesn't track, chooses —
        // and is above the project's file, as in Claude.
        write(&project, "settings.local.json", &mode("acceptEdits"));
        assert_eq!(of(&project, None), WriterChoice { mode: WriterMode::AcceptEdits, bypass_not_followed: None }, "local beats project");
        write(&project, "settings.local.json", &mode("bypassPermissions"));
        assert_eq!(of(&project, None).mode, WriterMode::Bypass);
        write(&project, "settings.local.json", "{broken");
        assert_eq!(of(&project, None), capped, "nothing readable of the member's own");
        // The repository asks for accept edits: followed, nothing said.
        write(&project, "settings.json", &mode("acceptEdits"));
        assert_eq!(of(&project, None), WriterChoice { mode: WriterMode::AcceptEdits, bypass_not_followed: None });

        // Committed, it is shared content like settings.json.
        write(&project, "settings.json", "{}");
        write(&project, "settings.local.json", &mode("bypassPermissions"));
        git_in(&project, &["add", "-f", ".claude/settings.local.json"]);
        assert_eq!(of(&project, None), capped, "a tracked local file");
        assert_eq!(of(&project, Some("bypassPermissions")).mode, WriterMode::Bypass);
        git_in(&project, &["rm", "-q", "--cached", ".claude/settings.local.json"]);
        assert_eq!(of(&project, None).mode, WriterMode::Bypass, "untracked again");

        // A card's copy: what the Builder can write there chooses nothing.
        std::fs::remove_file(project.join(".claude/settings.local.json")).unwrap();
        for root in crate::worktrees::worktree_dir_names() {
            let copy = project.join(root).join("card-1");
            write(&copy, "settings.local.json", &mode("bypassPermissions"));
            assert_eq!(own_settings_folder(&copy), project.as_path());
            assert_eq!(own_settings_folder(&copy.join("packages/web")), project.as_path());
            assert_eq!(of(&copy, None), capped, "{root}: the copy's local file");
            write(&copy, "settings.json", &mode("bypassPermissions"));
            assert_eq!(of(&copy, None), capped, "{root}: the copy's settings.json");
            assert_eq!(of(&copy, Some("bypassPermissions")).mode, WriterMode::Bypass);
            // A mode that asks, in the copy, is above the user's settings.
            write(&copy, "settings.local.json", &mode("plan"));
            assert_eq!(of(&copy, Some("bypassPermissions")).mode, WriterMode::Refuse);
            // The project's own local file is the member's for its copies too.
            write(&copy, "settings.local.json", &mode("bypassPermissions"));
            write(&project, "settings.local.json", &mode("acceptEdits"));
            assert_eq!(of(&copy, None), WriterChoice { mode: WriterMode::AcceptEdits, bypass_not_followed: None });
            // …and outranks the copy's files: its bypass is the member's.
            write(&project, "settings.local.json", &mode("bypassPermissions"));
            write(&copy, "settings.local.json", &mode("plan"));
            assert_eq!(of(&copy, None).mode, WriterMode::Bypass, "{root}: the project's own local file comes first");
            write(&copy, "settings.local.json", &mode("bypassPermissions"));
            std::fs::remove_file(project.join(".claude/settings.local.json")).unwrap();
        }
        assert_eq!(own_settings_folder(&project), project.as_path());

        // Where git can't say (no repository), a local file is not taken as
        // the member's own.
        let plain = dir.path().join("plain");
        write(&plain, "settings.local.json", &mode("bypassPermissions"));
        assert_eq!(own_local_settings(&plain), LocalSettings::Unjudged);
        assert_eq!(
            of(&plain, None),
            WriterChoice { mode: WriterMode::AcceptEdits, bypass_not_followed: Some(BypassAsked::Unjudged) },
            "read like a shared file, and only logged"
        );
        assert!(!PROJECT_BYPASS_NOT_FOLLOWED.contains("defaultMode"), "in words, as BYPASS_QUESTION");
    }

    #[test]
    fn the_writer_argv_follows_its_mode_and_merges_one_allowed_list() {
        let tools = |list: &[&str]| list.iter().map(|t| t.to_string()).collect::<Vec<_>>();
        let refuse = unattended_writer_args("/ppvp", WriterMode::Refuse, &[]);
        assert_eq!(collected_session_id(&refuse).as_deref(), Some(refuse[1].as_str()));
        assert_eq!(&refuse[2..], ["--permission-mode", "dontAsk", "/ppvp", "--disallowedTools", "AskUserQuestion"]);
        let bypass = unattended_writer_args("go", WriterMode::Bypass, &tools(&["Read"]));
        assert_eq!(&bypass[2..], ["--permission-mode", "bypassPermissions", "go", "--disallowedTools", "AskUserQuestion", "--allowedTools", "Read"]);
        let edits = unattended_writer_args("go", WriterMode::AcceptEdits, &tools(&["Bash(git log:*)", "Write", " "]));
        assert_eq!(
            &edits[7..],
            ["--allowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit", "Bash(git log:*)"],
            "one list, no duplicate, no blank"
        );
        assert!(is_unattended_writer(&edits));
        assert!(!is_unattended_writer(&["--session-id".into(), "x".into(), "--restricted".into()]));
    }

    /// Claude's warning before Bypass Permissions mode stops the session,
    /// never answered; an unknown screen's line is never classified.
    #[test]
    fn the_bypass_warning_stops_the_session_and_an_unknown_screen_is_unclassifiable() {
        let warning = "\u{1b}[2J WARNING: Claude Code running in Bypass Permissions mode\r\n In Bypass Permissions mode, Claude Code will not ask for your approval\r\n ❯ 1. No, exit\r\n   2. Yes, I accept\r\n";
        assert_eq!(blocking_screen(warning, false), Some(BYPASS_QUESTION));
        // P-D2 Mac walk: the Inbox shows it; it names no settings key.
        assert!(!BYPASS_QUESTION.contains("defaultMode"));
        assert_eq!(blocking_screen(warning, true), None);
        assert_eq!(blocking_screen("❯ explain Bypass Permissions mode", false), None);
        let line = unknown_screen_line("s", "Claude usage limit reached\n❯ 1. Continue");
        assert!(unclassifiable(&line));
        assert!(!ended_without_answer(&line));
        assert!(unclassifiable(&result_line_for("s", "x", true, true, None)));
        assert!(!unclassifiable(&result_line("s", USAGE_LIMIT, true, None)));
        let message = crate::read_only_provider::extract_error_message(crate::coordination::Provider::Claude, &line).unwrap();
        assert!(message.lines().next().unwrap().starts_with("Claude is waiting on a screen Plyloft doesn't know"));
    }

    /// Claude's permission dialog, as the tile header's own fixtures draw it
    /// (`src/lib/tileHeaderStatus.test.ts`), is read only when drawn last.
    #[test]
    fn a_permission_dialog_is_read_by_its_shape_when_drawn_last() {
        let framed = "\u{1b}[2J> add a test\r\n⏺ I'll run the suite.\r\n╭──────────────────────╮\r\n│ Bash command │\r\n│ npm test │\r\n│ Do you want to proceed? │\r\n│ ❯ 1. Yes │\r\n│   2. Yes, and don't ask again │\r\n│   3. No, and tell Claude what to do │\r\n╰──────────────────────╯\r\n";
        assert!(asks_for_permission(framed));
        let bare = "  Edit file src/lib/parser.ts\r\n\r\n  Do you want to make this edit?\r\n  ❯ 1. Yes\r\n    2. No, and tell Claude what to do differently\r\n  Esc to cancel\r\n";
        assert!(asks_for_permission(bare));
        // A working turn after it, or a long conversation and composer drawn
        // below it, is no dialog waiting.
        assert!(!asks_for_permission(&format!("{bare}✻ Thinking… (12s · esc to interrupt)")));
        let below = format!("{bare}⏺ Done. The parser now handles empty input and the tests pass on both platforms, so the change is ready.\r\n────────────────\r\n❯ \r\n────────────────\r\n  ⏵⏵ accept edits on (shift+tab to cycle)");
        assert!(!asks_for_permission(&below));
        // Challenger round 3: a dialog bordered at the PTY's width — 120
        // columns on unix — with its bottom edge and a footer, and the same
        // under a 32,767-column rule (Windows' ConPTY width), read through
        // the matcher tail the session watch keeps.
        let edge = |cols: usize, left: char, right: char| format!("{left}{}{right}", "─".repeat(cols - 2));
        let row = |cols: usize, text: &str| format!("│ {text}{}│", " ".repeat(cols - 3 - text.chars().count()));
        let boxed = |cols: usize| {
            [
                "⏺ Writing the agent file.".to_string(),
                edge(cols, '╭', '╮'),
                row(cols, "Create file"),
                row(cols, ".claude/agents/reviewer.md"),
                row(cols, "Do you want to create reviewer.md?"),
                row(cols, "❯ 1. Yes"),
                row(cols, "  2. Yes, allow all edits during this session (shift+tab)"),
                row(cols, "  3. No, and tell Claude what to do differently (esc)"),
                edge(cols, '╰', '╯'),
                "  Esc to cancel · Tab to add additional instructions".to_string(),
            ]
            .join("\r\n")
        };
        assert!(asks_for_permission(&boxed(120)), "a 120-column box and its footer");
        let wide = format!("{}\r\n{}", "─".repeat(32_767), boxed(32_767));
        let tail = matcher_tail(wide.as_bytes(), 16 * 1024);
        assert!(tail.contains("Do you want to create reviewer.md?"), "the question survives a full-width rule");
        assert!(asks_for_permission(&tail), "a 32,767-column box read through the tail");
        // More than the footer below it is no dialog drawn last.
        assert!(!asks_for_permission(&format!("{}\r\nmore\r\nand more\r\nstill more\r\nand again", boxed(120))));
        // A prompt quoting the question, with no choices, is no dialog.
        assert!(!asks_for_permission("❯ Why does Claude ask \"Do you want to proceed?\" so often"));
        let line = permission_question_line("s", "Write (.claude/settings.json)", "Do you want to proceed?");
        assert!(unclassifiable(&line));
        assert!(line.contains("Claude asks for permission to use Write (.claude/settings.json); Plyloft never answers"));
    }

    /// The matcher tail cuts runs of one character, keeps the words; the
    /// frame signature changes with the text, not with escapes.
    #[test]
    fn the_matcher_tail_cuts_runs_and_the_frame_signature_reads_text_only() {
        let tail = matcher_tail(format!("{}Yes, I accept{}", "─".repeat(50_000), " ".repeat(9)).as_bytes(), 100);
        assert_eq!(tail, "────Yes, I accept    ");
        assert_eq!(matcher_tail(b"abc", 2), "bc");
        let screen = "⠋ Starting\r\n";
        assert_eq!(frame_signature(screen), frame_signature("\u{1b}[?25l⠋ Starting\u{1b}[?25h\r\n"), "a cursor blink");
        assert_eq!(frame_signature(screen), frame_signature("\u{1b}[38;5;2m⠋ Starting\u{1b}[0m"), "a colour");
        assert_ne!(frame_signature(screen), frame_signature("⠙ Starting\r\n"), "the spinner moved");
    }

    /// Challenger round 4 (S1): a growing screen whose new output is only
    /// escapes — a cursor hidden and shown, a title — keeps its signature;
    /// a dialog redrawn identically settles to one; a spinner whose digits
    /// move does not. (S3) The shown tail drops rows of frame glyphs and cuts
    /// runs. (S4) The matcher tail starts on a character.
    #[test]
    fn the_still_screen_signature_ignores_escape_only_output() {
        let dialog = "Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No, and tell Claude what to do differently\r\n";
        let mut screen = format!("{}{dialog}", "⏺ Earlier output.\r\n".repeat(400));
        let still = frame_signature(&screen);
        for _ in 0..50 {
            screen.push_str("\u{1b}[?25l\u{1b}]0;claude\u{7}\u{1b}[?25h\u{1b}[2K\u{1b}[1A");
            assert_eq!(frame_signature(&screen), still, "escape-only output is no redraw");
        }
        let mut redrawn = screen.clone();
        let signatures: Vec<u64> = (0..60)
            .map(|_| {
                redrawn.push_str(&format!("\u{1b}[3A\u{1b}[2K{dialog}"));
                frame_signature(&redrawn)
            })
            .collect();
        assert_eq!(signatures[58], signatures[59], "an identical redraw settles");
        let mut spinner = screen.clone();
        let mut last = frame_signature(&spinner);
        for second in 1..5 {
            spinner.push_str(&format!("\r✻ Starting… ({second}s)"));
            let now = frame_signature(&spinner);
            assert_ne!(now, last, "the spinner moved");
            last = now;
        }
        let windows = format!("Error: something\r\n{}\r\nDo you want to proceed?\r\n{}{}\r\n", "─".repeat(32_767), "x".repeat(20), " ".repeat(30_000));
        let shown = screen_tail(windows.as_bytes(), 1500);
        assert_eq!(shown, "Error: something\nDo you want to proceed?\nxxxx");
        let cut = "é".repeat(10);
        assert_eq!(matcher_tail(&cut.as_bytes()[1..], 100), "éééé", "a cut character is skipped, runs cut");
    }

    /// The live walk of PR #384: Claude answers an unknown slash prompt on
    /// screen and goes back to its composer — read by its measured words,
    /// as the last thing said, with the composer after it.
    const UNKNOWN_NOPE: &str = "\u{1b}[2J ▐▛███▜▌\u{1b}[1CClaude\u{1b}[1CCode\u{1b}[1Cv2.1.300\r\n  ⏵⏵ don't ask on\r\n❯ /nope\r\n\r\n⏺ Unknown\u{1b}[1Ccommand:\u{1b}[1C/nope.\u{1b}[1CDid\u{1b}[1Cyou\u{1b}[1Cmean\u{1b}[1C/copy?\r\n\u{1b}(B────────\r\n❯ \r\n────────\r\n  ⏵⏵ don't ask on (shift+tab to cycle)";

    #[test]
    fn an_unknown_command_is_read_as_claudes_last_words_with_the_composer_back() {
        assert_eq!(
            unknown_command(UNKNOWN_NOPE),
            Some(("nope".to_string(), "Unknown command: /nope. Did you mean /copy?".to_string()))
        );
        assert_eq!(
            unknown_command_message("nope", "Unknown command: /nope. Did you mean /copy?"),
            "Claude doesn't know /nope in this folder (Claude said: Unknown command: /nope. Did you mean /copy?)"
        );
        // Still working, more said after it, or no composer yet: not it.
        assert_eq!(unknown_command(&format!("{UNKNOWN_NOPE}\r\n✻ Thinking… (esc to interrupt)")), None);
        assert_eq!(unknown_command(&format!("{UNKNOWN_NOPE}\r\n⏺ Here is what /nope would do…\r\n❯ ")), None);
        assert_eq!(unknown_command("⏺ Unknown command: /nope. Did you mean /copy?"), None);
        let line = unknown_command_line("s", "nope", "Unknown command: /nope.");
        assert!(unclassifiable(&line));
        // `ESC ( B` leaves no stray `B` on a line of its own.
        assert!(!strip_escapes(UNKNOWN_NOPE).lines().any(|l| l.trim() == "B"));
        assert_eq!(strip_escapes("a\u{1b}(Bb\u{1b}Pq#0\u{1b}\\c"), "abc");
    }

    /// Measured on the walk: a custom command that runs writes its name in
    /// a user entry; a prompt taken as text (`//hello`) is plain content.
    #[test]
    fn a_command_claude_ran_is_read_from_its_transcript() {
        let ran = [
            line(serde_json::json!({"type": "user", "message": {"role": "user", "content": "<command-message>hello</command-message>\n<command-name>/hello</command-name>"}})),
            line(serde_json::json!({"type": "user", "isMeta": true, "message": {"role": "user", "content": [{"type": "text", "text": "Say hello."}]}})),
            assistant("m1", serde_json::json!([{"type": "text", "text": "Hello!"}]), Some("end_turn")),
        ]
        .join("\n");
        assert!(ran_as_command(&ran, "/hello"));
        assert!(ran_as_command(&ran, "hello"));
        assert!(!ran_as_command(&ran, "hell"));
        let text = [
            line(serde_json::json!({"type": "user", "message": {"role": "user", "content": "//hello"}})),
            assistant("m1", serde_json::json!([{"type": "text", "text": "Hello! What do you want to work on?"}]), Some("end_turn")),
        ]
        .join("\n");
        assert!(!ran_as_command(&text, "/hello"));
        // Claude quoting the tag in its answer is no command it ran.
        let quoted = assistant("m1", serde_json::json!([{"type": "text", "text": "<command-name>/hello</command-name>"}]), Some("end_turn"));
        assert!(!ran_as_command(&quoted, "hello"));
        assert_eq!(screen_at_stop(&format!("{{\"type\":\"user\"}}\n{SCREEN_AT_STOP}\nWelcome")), "Welcome");
        assert_eq!(screen_at_stop("Welcome"), "Welcome");
    }

    /// The tool a session waits on: a tool_use last, with no result after it.
    #[test]
    fn the_pending_tool_is_the_last_tool_use_without_a_result() {
        let mut read = Transcript::default();
        let tool = assistant(
            "m1",
            serde_json::json!([{"type": "text", "text": "Saving."}, {"type": "tool_use", "name": "Write", "input": {"file_path": "/w/.claude/agents/x.md", "content": "…"}}]),
            Some("tool_use"),
        );
        read.push(format!("{tool}\n").as_bytes());
        assert_eq!(read.pending_tool().as_deref(), Some("Write (/w/.claude/agents/x.md)"));
        read.push(format!("{}\n", line(serde_json::json!({"type": "user", "message": {"content": [{"type": "tool_result", "content": "ok"}]}}))).as_bytes());
        assert_eq!(read.pending_tool(), None, "answered");
        read.push(format!("{}\n", assistant("m2", serde_json::json!([{"type": "text", "text": "Done."}]), Some("end_turn"))).as_bytes());
        assert_eq!(read.pending_tool(), None, "an answer is no tool");
        let mut bash = Transcript::default();
        bash.push(format!("{}\n", assistant("m3", serde_json::json!([{"type": "tool_use", "name": "Bash", "input": {"command": "git push\nmore"}}]), Some("tool_use"))).as_bytes());
        assert_eq!(bash.pending_tool().as_deref(), Some("Bash (git push)"));
    }

    /// `disableBypassPermissionsMode: "disable"` in any layer takes bypass
    /// away: the member maps like the default. A6: a file that comes with
    /// the repository disables it too.
    #[test]
    fn bypass_disabled_in_any_layer_maps_like_the_default() {
        let bypass = Some(r#"{"permissions":{"defaultMode":"bypassPermissions"}}"#.to_string());
        let disabled = Some(r#"{"permissions":{"disableBypassPermissionsMode":"disable"}}"#.to_string());
        let of = |layers: &[Layer]| writer_mode_in(layers).mode;
        assert_eq!(of(&[Layer::Own(None), Layer::Own(bypass.clone())]), WriterMode::Bypass);
        assert_eq!(of(&[Layer::Own(disabled.clone()), Layer::Own(None), Layer::Own(bypass.clone())]), WriterMode::Refuse, "managed");
        assert_eq!(of(&[Layer::Own(bypass.clone()), Layer::Own(disabled.clone())]), WriterMode::Refuse, "a lower layer disables it too");
        let project = writer_mode_in(&[Layer::Shared(disabled.clone()), Layer::Own(bypass.clone())]);
        assert_eq!(project, WriterChoice { mode: WriterMode::Refuse, bypass_not_followed: None }, "the project's file disables it");
        // Round 5 (V2): a shared file asking for bypass with bypass disabled
        // is the default too, as the member's own is — nobody named accept
        // edits — and nothing is said: the disabling took it away.
        let asked = writer_mode_in(&[Layer::Shared(bypass.clone()), Layer::Shared(disabled.clone()), Layer::Own(None)]);
        assert_eq!(asked, WriterChoice { mode: WriterMode::Refuse, bypass_not_followed: None });
        let asked = writer_mode_in(&[Layer::Unjudged(bypass.clone()), Layer::Own(disabled.clone())]);
        assert_eq!(asked, WriterChoice { mode: WriterMode::Refuse, bypass_not_followed: None });
        // Accept edits named by a shared file stays accept edits.
        let edits = Some(r#"{"permissions":{"defaultMode":"acceptEdits"}}"#.to_string());
        assert_eq!(of(&[Layer::Shared(edits), Layer::Shared(disabled.clone())]), WriterMode::AcceptEdits);
        assert_eq!(of(&[Layer::Own(bypass.clone()), Layer::Shared(disabled)]), WriterMode::Refuse, "below the member's local file too");
        let edits = Some(r#"{"permissions":{"defaultMode":"acceptEdits","disableBypassPermissionsMode":"disable"}}"#.to_string());
        assert_eq!(of(&[Layer::Own(edits)]), WriterMode::AcceptEdits, "only bypass is taken away");
        assert_eq!(of(&[Layer::Own(Some("{broken".into())), Layer::Own(bypass)]), WriterMode::Bypass);
    }

    /// A plain folder inherits the trust of the session root; a repository
    /// or a worktree root below it is a git root of its own.
    #[test]
    fn only_a_plain_folder_under_the_session_root_has_no_git_root() {
        let root = tempfile::tempdir().unwrap();
        let sessions = sessions_root(root.path());
        let plain = sessions.join("reviews/worktrees/r1/src");
        std::fs::create_dir_all(&plain).unwrap();
        assert_eq!(git_root(&plain), None);
        std::fs::create_dir(sessions.join("reviews/worktrees/r1/.git")).unwrap();
        assert_eq!(git_root(&plain), Some(sessions.join("reviews/worktrees/r1").as_path()));
        let worktree = sessions.join("discussions/worktrees/d1/claude");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(worktree.join(".git"), "gitdir: /elsewhere\n").unwrap();
        assert_eq!(git_root(&worktree), Some(worktree.as_path()));

        // The spawn guard looks no higher than the session root.
        assert_eq!(git_root_under_sessions(&worktree), Some(worktree.clone()));
        assert_eq!(git_root_under_sessions(&plain), Some(sessions.join("reviews/worktrees/r1")));
        let clean = sessions.join("probes/p1");
        std::fs::create_dir_all(&clean).unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap(); // above the root
        assert_eq!(git_root_under_sessions(&clean), None);
        assert_eq!(sessions_root_above(&clean), Some(sessions.clone()));
        assert_eq!(git_root_under_sessions(root.path()), None, "outside every session root");
    }

    /// Round 2 on PR #374: only Plyloft's own session root counts, never a
    /// member's folder that happens to be named `claude-sessions`.
    #[test]
    fn a_workspace_folder_named_claude_sessions_is_no_session_root() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join(SESSIONS_DIR).join("app/src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir(tmp.path().join(SESSIONS_DIR).join("app/.git")).unwrap();
        assert_eq!(sessions_root_above(&src), None);
        assert_eq!(git_root_under_sessions(&src), None);
        let config = tempfile::tempdir().unwrap();
        let ours = session_worktrees(config.path(), "reviews").join("r1");
        assert_eq!(sessions_root_above(&ours), Some(sessions_root(config.path())));
    }

    /// Walk 3 of #386 (owner decision): a quit leaves a discussion's,
    /// proposal pass's or comparison's read tree (its own cleanup never
    /// ran); the next launch retires each — plain or not, nested under a
    /// discussion or not, however fresh — from disk and from `git worktree
    /// list`; a discussion tree no record names is left to the hour sweep.
    #[test]
    fn orphan_read_trees_are_retired_at_the_next_launch() {
        const GIT: &str = if cfg!(windows) { "git" } else { "/usr/bin/git" };
        let repo = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| crate::pinned_read::git_capture_with(GIT, repo.path(), args).unwrap();
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.name", "t"]);
        git(&["config", "user.email", "t.invalid"]);
        std::fs::write(repo.path().join("a"), "1").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "one"]);
        let head = git(&["rev-parse", "HEAD"]).trim().to_string();
        let config = tempfile::tempdir().unwrap();
        let proposals = session_worktrees(config.path(), "proposals");
        let discussions = session_worktrees(config.path(), "discussions");
        // As a quit leaves them: made, never dropped.
        let quit = |path: PathBuf, root: PathBuf, plain: bool| {
            let tree = if plain {
                crate::pinned_read::DetachedReadWorktree::create_plain_with_git(GIT, repo.path(), path, root, &head)
            } else {
                crate::pinned_read::DetachedReadWorktree::create_with_git(GIT, repo.path(), path, root, &head)
            };
            std::mem::forget(tree.unwrap());
        };
        quit(proposals.join("u1"), proposals.clone(), true);
        quit(proposals.join("u2"), proposals.clone(), false);
        quit(discussions.join("d1").join("analysis-a"), discussions.join("d1"), true);
        quit(discussions.join("d9").join("synthesis"), discussions.join("d9"), false);
        assert_eq!(git(&["worktree", "list"]).lines().count(), 5);
        let taken = take_orphan_read_trees(&proposals, "proposals", None);
        assert!(!proposals.join("u1").exists(), "moved aside at once");
        taken.retire_with(|dir, args| crate::pinned_read::git_capture_with(GIT, dir, args));
        let named: std::collections::HashSet<String> = ["d1".to_string()].into();
        take_orphan_read_trees(&discussions, "discussions", Some(&named))
            .retire_with(|dir, args| crate::pinned_read::git_capture_with(GIT, dir, args));
        let left: Vec<_> = std::fs::read_dir(&proposals).unwrap().flatten().collect();
        assert!(left.is_empty(), "no tree, link or moved-aside folder left: {left:?}");
        assert!(!discussions.join("d1").exists() && !discussions.join("d1").join("analysis-a-git").exists());
        assert!(discussions.join("d9").join("synthesis").exists(), "a tree no record names is left alone");
        let list = git(&["worktree", "list"]);
        assert_eq!(list.lines().count(), 2, "only the main checkout and d9's: {list}");
        assert!(list.contains("d9"), "{list}");
    }

    #[test]
    fn session_leftovers_are_retired_and_fresh_ones_kept() {
        let config = tempfile::tempdir().unwrap();
        let trees = session_worktrees(config.path(), "reviews");
        std::fs::create_dir_all(trees.join("r1")).unwrap();
        std::fs::write(trees.join("r1-git"), "gitdir: /x\n").unwrap();
        let probes = sessions_root(config.path()).join("probes");
        std::fs::create_dir_all(probes.join("ply-review-probe-1-git")).unwrap();
        retire_session_leftovers(config.path(), "reviews");
        assert!(trees.join("r1").exists() && trees.join("r1-git").exists(), "fresh: kept");
        remove_entries_older_than(&trees, "reviews", std::time::Duration::ZERO);
        remove_entries_older_than(&probes, "probes", std::time::Duration::ZERO);
        assert!(!trees.exists());
        assert!(!probes.exists());
    }
}
