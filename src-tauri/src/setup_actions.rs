//! OB-3 — Setup's allowlist (onboarding spec §6, principle 8).
//!
//! The frontend never sends a command to run. It sends an action id
//! (`install.claude`, `login.gh`, …) and, where the spec needs one, a
//! validated structured argument; Rust builds the program and its arguments
//! here, from a fixed table. The command strings themselves live where the
//! Diagnostics rows already take them from — `doctor::install_cmd_on`,
//! `codex_update_cmd`, `gh_update_cmd` — so the command a consent sheet names
//! under Details is the command that runs.
//!
//! Every value in an argv is one of: a constant of this table or of
//! `doctor`'s, a program path the shell probe resolved, or
//! [`GITHUB_HOST`]. `tests::no_frontend_string_reaches_an_argv` holds that.
//!
//! Pure: [`plan`] takes the facts it needs ([`PlanFacts`]) and returns the
//! [`RunPlan`] or the words of a refusal.

use serde::{Deserialize, Serialize};

use crate::doctor;
use crate::shell_env::ShellEnv;

/// The only GitHub host Setup signs in to. GitHub Enterprise stays outside
/// Setup (spec §5 step 5: *Details says `gh auth login --hostname <host>`
/// works*), so a `hostname` argument must be exactly this.
pub const GITHUB_HOST: &str = "github.com";

/// `gh auth refresh`'s scopes (spec §5 step 5, "token lacks repo/read:org").
pub const GH_SCOPES: &str = "repo,read:org";

/// Every action Setup's guided terminal (or, for `status.*`, the AI step's
/// bounded read) may run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ActionId {
    InstallClaude,
    UpdateClaude,
    LoginClaude,
    StatusClaude,
    /// Claude's TUI in Plyloft's review folder (`<config>/claude-sessions`),
    /// for the member to answer Claude's trust question there once. Plyloft
    /// never answers it; the run ends once Claude's own state says the folder
    /// is trusted ([`Watch::ClaudeFolderTrust`]). Its folder is set by
    /// `setup_run` (`RunPlan::cwd`), never by the frontend.
    TrustClaude,
    InstallCodex,
    UpdateCodex,
    LoginCodex,
    LoginDeviceCodex,
    StatusCodex,
    InstallGh,
    UpdateGh,
    LoginGh,
    AddAccountGh,
    SetupGitGh,
    RefreshGh,
    InstallGit,
    InstallNode,
    /// OB-11: `gh repo clone` for step 8b. Never parsed from an id (it isn't
    /// in [`ALL_ACTIONS`]): only `project_clone` builds its plan
    /// (`project_setup::clone_plan`), with a validated `owner/name` and a
    /// folder Ply created.
    ProjectClone,
    /// R4 (1.176.0): the guided Repair's terminal steps (`cli_repair`).
    /// Like `ProjectClone`, never parsed from an id: only
    /// `cli_repair_run` builds their plans ([`repair_install_plan`],
    /// [`repair_chown_plan`], [`repair_npm_remove_plan`]) from a fresh look,
    /// each path checked on the disk first.
    RepairInstallClaude,
    RepairInstallCodex,
    RepairChownClaude,
    RepairChownCodex,
    RepairNpmRemoveClaude,
    RepairNpmRemoveCodex,
}

pub const ALL_ACTIONS: [ActionId; 18] = [
    ActionId::InstallClaude,
    ActionId::UpdateClaude,
    ActionId::LoginClaude,
    ActionId::StatusClaude,
    ActionId::TrustClaude,
    ActionId::InstallCodex,
    ActionId::UpdateCodex,
    ActionId::LoginCodex,
    ActionId::LoginDeviceCodex,
    ActionId::StatusCodex,
    ActionId::InstallGh,
    ActionId::UpdateGh,
    ActionId::LoginGh,
    ActionId::AddAccountGh,
    ActionId::SetupGitGh,
    ActionId::RefreshGh,
    ActionId::InstallGit,
    ActionId::InstallNode,
];

/// The tool an action is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tool {
    Claude,
    Codex,
    Gh,
    Git,
    Node,
}

impl ActionId {
    /// The id the frontend sends (spec §6 names).
    pub fn id(self) -> &'static str {
        match self {
            Self::InstallClaude => "install.claude",
            Self::UpdateClaude => "update.claude",
            Self::LoginClaude => "login.claude",
            Self::StatusClaude => "status.claude",
            Self::TrustClaude => "trust.claude",
            Self::InstallCodex => "install.codex",
            Self::UpdateCodex => "update.codex",
            Self::LoginCodex => "login.codex",
            Self::LoginDeviceCodex => "login-device.codex",
            Self::StatusCodex => "status.codex",
            Self::InstallGh => "install.gh",
            Self::UpdateGh => "update.gh",
            Self::LoginGh => "login.gh",
            Self::AddAccountGh => "add-account.gh",
            Self::SetupGitGh => "setupgit.gh",
            Self::RefreshGh => "refresh.gh",
            Self::InstallGit => "install.git",
            Self::InstallNode => "install.node",
            Self::ProjectClone => "project.clone",
            Self::RepairInstallClaude => "repair-install.claude",
            Self::RepairInstallCodex => "repair-install.codex",
            Self::RepairChownClaude => "repair-chown.claude",
            Self::RepairChownCodex => "repair-chown.codex",
            Self::RepairNpmRemoveClaude => "repair-npm-remove.claude",
            Self::RepairNpmRemoveCodex => "repair-npm-remove.codex",
        }
    }

    /// Exact match only: no trimming, no case folding.
    pub fn parse(id: &str) -> Option<Self> {
        ALL_ACTIONS.iter().copied().find(|a| a.id() == id)
    }

    /// `status.*`: a bounded read the AI step runs (D2, D4), not a terminal.
    pub fn is_status_read(self) -> bool {
        matches!(self, Self::StatusClaude | Self::StatusCodex)
    }

    /// An install or update: re-probe the shell and refresh the doctor after.
    pub fn changes_programs(self) -> bool {
        matches!(
            self,
            Self::InstallClaude
                | Self::UpdateClaude
                | Self::InstallCodex
                | Self::UpdateCodex
                | Self::InstallGh
                | Self::UpdateGh
                | Self::InstallGit
                | Self::InstallNode
                | Self::RepairInstallClaude
                | Self::RepairInstallCodex
                | Self::RepairChownClaude
                | Self::RepairChownCodex
                | Self::RepairNpmRemoveClaude
                | Self::RepairNpmRemoveCodex
        )
    }

    /// The gh actions whose one argument is the host.
    fn takes_hostname(self) -> bool {
        matches!(
            self,
            Self::LoginGh | Self::AddAccountGh | Self::SetupGitGh | Self::RefreshGh
        )
    }
}

/// The structured arguments an action may take. Unknown fields are refused
/// when the IPC call is decoded; a known field is only ever compared against
/// a constant, never passed on as given.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SetupArgs {
    /// gh's host: only [`GITHUB_HOST`] (the default when absent).
    pub hostname: Option<String>,
}

/// How Ply decides the action worked (spec §4 principle 4: observed, not
/// assumed).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case", tag = "kind", content = "tool")]
pub enum Watch {
    /// After the run: the shell is re-probed and the tool resolves and
    /// answers `--version` (git on Windows: with Git Bash).
    ToolWorks(Tool),
    /// Claude Code's credential appears (keychain item or credentials file,
    /// `claude_auth::read`) — polled while the login runs.
    ClaudeSignIn,
    /// Codex's `auth.json` appears in the real `CODEX_HOME` — polled.
    CodexSignIn,
    /// `gh auth status` lists an account it did not list before the run.
    GhNewAccount,
    /// `gh auth status` lists a new account, or a signed-in one where none
    /// was signed in before (a sign-in again of the same account).
    GhSignedIn,
    /// git asks gh for github.com's password (`credential.…helper`).
    GhGitHelper,
    /// The signed-in account's token has `repo` and `read:org`.
    GhScopes,
    /// `xcode-select -p` answers, polled every 5 s for up to 30 min: the
    /// macOS installer dialog outlives `xcode-select --install`.
    CommandLineTools,
    /// `trust.claude`: Claude's own state (`~/.claude.json`, read only,
    /// `claude_session::folder_trusted`) says the review folder is trusted —
    /// polled every 500 ms while Claude runs, which is then closed within
    /// about a second (`setup_run::stops_on_sight`).
    ClaudeFolderTrust,
    /// `status.*`: the read's own answer.
    Answer,
    /// OB-11: the clone's folder holds a repository once `gh repo clone`
    /// exits 0.
    Cloned,
    /// R4: a Repair's `chown` or npm removal — its exit code says whether it
    /// ran; what it changed is judged by the Repair's next look.
    ExitCode,
}

/// What [`plan`] needs to know about this machine. Read by Rust
/// ([`PlanFacts::read`]), never sent by the frontend.
#[derive(Debug, Clone, Default)]
pub struct PlanFacts {
    pub windows: bool,
    pub claude: Option<String>,
    pub codex: Option<String>,
    /// Codex's resolved binary with its links followed (which updater).
    pub codex_real: Option<String>,
    pub gh: Option<String>,
    pub gh_real: Option<String>,
    pub brew: Option<String>,
    pub npm: Option<String>,
    pub git_works: bool,
    /// A git resolved on PATH, working or not (OB-6 review P3-6: a Windows
    /// git that resolves but doesn't start is reinstalled with `--force`).
    pub git_resolved: bool,
    /// Windows: Git Bash found (`ShellEnv::git_bash_path`).
    pub git_bash: bool,
    /// Windows PowerShell 5.1 (`powershell.exe`), for the `irm … | iex`
    /// installers.
    pub powershell: Option<String>,
    /// Windows: winget (an App Execution Alias under WindowsApps).
    pub winget: Option<String>,
}

impl PlanFacts {
    /// This machine's facts, from the cached shell probe.
    pub fn read(env: &ShellEnv) -> Self {
        let real = |p: &Option<String>| {
            p.as_deref().map(|p| {
                std::fs::canonicalize(p)
                    .map(|r| r.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| p.to_string())
            })
        };
        let find = |name: &str| crate::shell_env::find_in_path(&env.path, name);
        Self {
            windows: cfg!(windows),
            claude: env.claude_path.clone(),
            codex: env.codex_path.clone(),
            codex_real: real(&env.codex_path),
            gh: env.gh_path.clone(),
            gh_real: real(&env.gh_path),
            brew: if cfg!(windows) { None } else { find("brew") },
            npm: find("npm"),
            git_works: env.git_works(),
            git_resolved: env.git_path.is_some(),
            git_bash: env.git_bash_path.is_some(),
            powershell: windows_powershell(),
            winget: if cfg!(windows) {
                find("winget").or_else(windows_apps_winget)
            } else {
                None
            },
        }
    }
}

#[cfg(windows)]
fn windows_powershell() -> Option<String> {
    let root = std::env::var_os("SystemRoot")?;
    let exe = std::path::PathBuf::from(root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    exe.is_file().then(|| exe.to_string_lossy().into_owned())
}

#[cfg(not(windows))]
fn windows_powershell() -> Option<String> {
    None
}

/// winget is an App Execution Alias: a reparse point `is_file` may not see,
/// so its presence is read without following it.
#[cfg(windows)]
fn windows_apps_winget() -> Option<String> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    let alias = std::path::PathBuf::from(local)
        .join("Microsoft")
        .join("WindowsApps")
        .join("winget.exe");
    std::fs::symlink_metadata(&alias)
        .ok()
        .map(|_| alias.to_string_lossy().into_owned())
}

#[cfg(not(windows))]
fn windows_apps_winget() -> Option<String> {
    None
}

/// What runs, and how Ply will know it worked.
#[derive(Debug, Clone, PartialEq)]
pub struct RunPlan {
    pub action: ActionId,
    /// The program (a resolved path or a fixed system path) and its arguments.
    pub argv: Vec<String>,
    /// Windows: start `argv[0]` as given (winget's alias) instead of looking
    /// it up with PATHEXT.
    pub direct: bool,
    /// The command as the consent sheet's Details names it.
    pub display: String,
    pub watch: Watch,
    /// OB-11: more environment for the run (never a secret).
    pub env: Vec<(String, String)>,
    /// OB-11: `GH_TOKEN` for a GitHub account that isn't gh's active one —
    /// for this run's environment only (D7); redacted in its tail.
    pub token: Option<crate::project_setup::GhToken>,
    /// OB-11: a clone — the folder Ply created for it, removed unless the
    /// clone succeeds, and the repository.
    pub clone: Option<crate::project_setup::CloneRun>,
    /// Where the run starts; `None`: the home folder. Only `trust.claude`
    /// sets it (Plyloft's review folder, by `setup_run`), and it is refused
    /// without one: Claude must never be asked to trust the home folder.
    pub cwd: Option<std::path::PathBuf>,
}

// ── Refusals (words a person reads) ────────────────────────────────────

pub fn unknown_action(id: &str) -> String {
    // The id is not echoed back as-is: it came from the frontend.
    let shown: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
        .take(40)
        .collect();
    format!("Plyloft doesn't know the setup step \"{shown}\".")
}

pub const ARGS_REFUSED: &str = "This setup step takes no settings.";
pub const HOST_REFUSED: &str =
    "Setup signs in to github.com only. For another GitHub host, run gh auth login --hostname <host> yourself.";

fn not_installed(tool: &str) -> String {
    format!("{tool} isn't installed yet. Install it first.")
}

// ── The table ──────────────────────────────────────────────────────────

/// Validate `args` for `action`: the host, or nothing at all.
pub fn validate_args(action: ActionId, args: Option<&SetupArgs>) -> Result<&'static str, String> {
    let args = args.cloned().unwrap_or_default();
    match args.hostname {
        None => Ok(GITHUB_HOST),
        Some(_) if !action.takes_hostname() => Err(ARGS_REFUSED.into()),
        Some(host) if host == GITHUB_HOST => Ok(GITHUB_HOST),
        Some(_) => Err(HOST_REFUSED.into()),
    }
}

/// Parse and validate a request from the frontend, then build its plan.
pub fn plan_request(
    id: &str,
    args: Option<&SetupArgs>,
    facts: &PlanFacts,
) -> Result<RunPlan, String> {
    let action = ActionId::parse(id).ok_or_else(|| unknown_action(id))?;
    plan(action, args, facts)
}

/// The allowlist (spec §6): `action` on this machine.
pub fn plan(
    action: ActionId,
    args: Option<&SetupArgs>,
    facts: &PlanFacts,
) -> Result<RunPlan, String> {
    let host = validate_args(action, args)?;
    let w = facts.windows;
    let from_doctor = |cmd: &'static str, watch: Watch| -> Result<RunPlan, String> {
        let (argv, direct) = argv_for(cmd, facts)?;
        Ok(RunPlan {
            action,
            argv,
            direct,
            display: cmd.to_string(),
            watch,
            env: Vec::new(),
            token: None,
            clone: None,
            cwd: None,
        })
    };
    let run = |program: &Option<String>,
               name: &str,
               args: &[&str],
               watch: Watch|
     -> Result<RunPlan, String> {
        let program = program.clone().ok_or_else(|| not_installed(name))?;
        let mut argv = vec![program];
        argv.extend(args.iter().map(|a| a.to_string()));
        let display = format!("{name} {}", args.join(" ")).trim_end().to_string();
        Ok(RunPlan {
            action,
            argv,
            direct: false,
            display,
            watch,
            env: Vec::new(),
            token: None,
            clone: None,
            cwd: None,
        })
    };
    let install = |tool: &str| -> Result<&'static str, String> {
        doctor::install_cmd_on(tool, w).ok_or_else(|| unsupported(action))
    };
    match action {
        ActionId::InstallClaude => from_doctor(install("claude")?, Watch::ToolWorks(Tool::Claude)),
        ActionId::UpdateClaude => run(
            &facts.claude,
            "claude",
            &["update"],
            Watch::ToolWorks(Tool::Claude),
        ),
        ActionId::LoginClaude => run(
            &facts.claude,
            "claude",
            &["auth", "login"],
            Watch::ClaudeSignIn,
        ),
        ActionId::StatusClaude => run(
            &facts.claude,
            "claude",
            &["auth", "status", "--json"],
            Watch::Answer,
        ),
        // Claude's own TUI with no prompt and no flag: Plyloft sends nothing;
        // the member answers the trust question and Plyloft closes Claude
        // within about a second of Claude's state saying so.
        ActionId::TrustClaude => run(&facts.claude, "claude", &[], Watch::ClaudeFolderTrust),
        ActionId::InstallCodex => from_doctor(install("codex")?, Watch::ToolWorks(Tool::Codex)),
        ActionId::UpdateCodex => {
            if facts.codex.is_none() {
                return Err(not_installed("Codex"));
            }
            let cmd = doctor::codex_update_cmd(facts.codex_real.as_deref(), w).ok_or_else(|| {
                "Plyloft can't update this Codex: it wasn't installed in a way Plyloft knows. Update it the way you installed it.".to_string()
            })?;
            from_doctor(cmd, Watch::ToolWorks(Tool::Codex))
        }
        // The user's own CODEX_HOME (or none): never a tile's overlay, so the
        // login lands where every later Codex looks (spec §5 step 3).
        ActionId::LoginCodex => run(&facts.codex, "codex", &["login"], Watch::CodexSignIn),
        ActionId::LoginDeviceCodex => run(
            &facts.codex,
            "codex",
            &["login", "--device-auth"],
            Watch::CodexSignIn,
        ),
        ActionId::StatusCodex => run(&facts.codex, "codex", &["login", "status"], Watch::Answer),
        ActionId::InstallGh => {
            let cmd = if w || facts.brew.is_some() {
                install("gh")?
            } else {
                install("gh-zip")?
            };
            from_doctor(cmd, Watch::ToolWorks(Tool::Gh))
        }
        ActionId::UpdateGh => {
            if facts.gh.is_none() {
                return Err(not_installed("The GitHub CLI"));
            }
            let cmd = doctor::gh_update_cmd(facts.gh_real.as_deref(), w).ok_or_else(|| {
                "Plyloft can't update this GitHub CLI: it wasn't installed with Homebrew, winget or Plyloft. Update it the way you installed it.".to_string()
            })?;
            from_doctor(cmd, Watch::ToolWorks(Tool::Gh))
        }
        ActionId::LoginGh | ActionId::AddAccountGh => run(
            &facts.gh,
            "gh",
            &[
                "auth",
                "login",
                "--hostname",
                host,
                "--git-protocol",
                "https",
                "--web",
                "--skip-ssh-key",
            ],
            if action == ActionId::AddAccountGh {
                Watch::GhNewAccount
            } else {
                Watch::GhSignedIn
            },
        ),
        ActionId::SetupGitGh => run(
            &facts.gh,
            "gh",
            &["auth", "setup-git", "--hostname", host],
            Watch::GhGitHelper,
        ),
        ActionId::RefreshGh => run(
            &facts.gh,
            "gh",
            &["auth", "refresh", "-h", host, "-s", GH_SCOPES],
            Watch::GhScopes,
        ),
        ActionId::InstallGit => {
            if w {
                // OB-2 review (P3-5): a git without Git Bash (MinGit, Scoop)
                // gets Git for Windows with --force; OB-6 review (P3-6): so
                // does a git that resolves but doesn't start, which winget
                // would otherwise call already installed.
                let cmd = if (facts.git_works && !facts.git_bash)
                    || (facts.git_resolved && !facts.git_works)
                {
                    doctor::WINGET_GIT_FORCE
                } else {
                    install("git")?
                };
                from_doctor(cmd, Watch::ToolWorks(Tool::Git))
            } else {
                from_doctor(install("git")?, Watch::CommandLineTools)
            }
        }
        ActionId::InstallNode => {
            if !w {
                return Err(unsupported(action));
            }
            from_doctor(install("node")?, Watch::ToolWorks(Tool::Node))
        }
        ActionId::ProjectClone
        | ActionId::RepairInstallClaude
        | ActionId::RepairInstallCodex
        | ActionId::RepairChownClaude
        | ActionId::RepairChownCodex
        | ActionId::RepairNpmRemoveClaude
        | ActionId::RepairNpmRemoveCodex => Err(unknown_action(action.id())),
    }
}

// ── R4: the guided Repair's terminal steps ─────────────────────────────

/// The PATH of an npm removal: the prefix's bin (Windows: the prefix) first.
pub fn npm_path(prefix: &str, path: &str, windows: bool) -> String {
    let bin = if windows {
        prefix.to_string()
    } else {
        format!("{}/bin", prefix.trim_end_matches('/'))
    };
    let sep = if windows { ';' } else { ':' };
    if path.is_empty() {
        bin
    } else {
        format!("{bin}{sep}{path}")
    }
}

/// R4 (B2): Setup's Update refuses a copy whose own updater can't write its
/// folders (`cli_health::update_folders_writable`): `claude update` or npm
/// would fail with EACCES or write elsewhere. `None`: go ahead.
pub fn update_refusal(action: ActionId, writable: Option<bool>) -> Option<String> {
    let (name, cli) = match action {
        ActionId::UpdateClaude => ("Claude Code", crate::cli_fresh::Cli::Claude),
        ActionId::UpdateCodex => ("Codex", crate::cli_fresh::Cli::Codex),
        _ => return None,
    };
    // 1.176.0 seams: typed, so Setup's block offers Repair (the sentence
    // after the mark still names where it is, for a surface with only text).
    (writable == Some(false)).then(|| {
        crate::cli_fresh::update_refused(
            cli,
            &format!(
                "Plyloft can't update this {name}: the folders its updater writes aren't yours to change. Use Repair in Settings › Setup and account › Diagnostics."
            ),
        )
    })
}

fn repair_tool(tool: crate::cli_health::CliTool) -> Tool {
    match tool {
        crate::cli_health::CliTool::Claude => Tool::Claude,
        crate::cli_health::CliTool::Codex => Tool::Codex,
    }
}

/// R4: the official installer (`doctor::install_cmd_on`, the same command
/// Setup's Install runs), with the real home and a PATH that has the
/// installer's own folder on it: without it, Codex's installer appends a PATH
/// block to `~/.zprofile` (R0 X1). `path` is the snapshot's PATH with that
/// folder added by `cli_repair_run`.
pub fn repair_install_plan(
    tool: crate::cli_health::CliTool,
    facts: &PlanFacts,
    home: Option<&str>,
    path: &str,
) -> Result<RunPlan, String> {
    use crate::cli_health::CliTool;
    let action = match tool {
        CliTool::Claude => ActionId::RepairInstallClaude,
        CliTool::Codex => ActionId::RepairInstallCodex,
    };
    let cmd = doctor::install_cmd_on(tool.program(), facts.windows).ok_or_else(|| unsupported(action))?;
    let (argv, direct) = argv_for(cmd, facts)?;
    let mut env = vec![("PATH".to_string(), path.to_string())];
    if let (Some(home), false) = (home, facts.windows) {
        env.push(("HOME".to_string(), home.to_string()));
    }
    Ok(RunPlan {
        action,
        argv,
        direct,
        display: cmd.to_string(),
        watch: Watch::ToolWorks(repair_tool(tool)),
        env,
        token: None,
        clone: None,
        cwd: None,
    })
}

/// R4 (D1, B1): `sudo chown` in the visible terminal, where the person types
/// their password themselves. `recursive`: `chown -R -P -- <user> <folders>`
/// for folders that are only the tool's (`cli_repair_run::check_chown`);
/// otherwise `chown -h -- <user> <paths>`, the shared install folder itself
/// and the tool's own launcher entries by name
/// (`cli_repair_run::check_chown_shared`). None a system folder, the home or
/// `/`; never to root. macOS only.
pub fn repair_chown_plan(
    tool: crate::cli_health::CliTool,
    user: &str,
    folders: &[crate::cli_repair_run::CheckedPath],
    recursive: bool,
    windows: bool,
) -> Result<RunPlan, String> {
    use crate::cli_health::CliTool;
    let action = match tool {
        CliTool::Claude => ActionId::RepairChownClaude,
        CliTool::Codex => ActionId::RepairChownCodex,
    };
    if windows {
        return Err(unsupported(action));
    }
    if folders.is_empty() {
        return Err("There is no folder to give back.".into());
    }
    if !crate::cli_repair_run::valid_user(user) {
        return Err("Plyloft couldn't tell your user name.".into());
    }
    let paths: Vec<String> = folders.iter().map(|f| f.as_str().to_string()).collect();
    let mut argv = vec!["/usr/bin/sudo".to_string(), "/usr/sbin/chown".to_string()];
    if recursive {
        argv.extend(["-R".to_string(), "-P".to_string()]);
    } else {
        argv.push("-h".to_string());
    }
    argv.extend(["--".to_string(), user.to_string()]);
    argv.extend(paths.iter().cloned());
    let display = if recursive {
        crate::cli_repair::chown_display(user, &paths)
    } else {
        crate::cli_repair::chown_shared_display(user, &paths)
    };
    Ok(RunPlan {
        action,
        argv,
        direct: false,
        display,
        watch: Watch::ExitCode,
        env: Vec::new(),
        token: None,
        clone: None,
        cwd: None,
    })
}

/// R4 (D3): `npm uninstall -g --prefix <prefix> <package>` with the npm of
/// that prefix, so nothing lands in another one (R0 incident 2). `prefix` was
/// checked on the disk (`cli_repair_run::check_npm_prefix`).
pub fn repair_npm_remove_plan(
    tool: crate::cli_health::CliTool,
    npm: &str,
    prefix: &crate::cli_repair_run::CheckedPath,
    path: &str,
    windows: bool,
) -> Result<RunPlan, String> {
    use crate::cli_health::CliTool;
    let action = match tool {
        CliTool::Claude => ActionId::RepairNpmRemoveClaude,
        CliTool::Codex => ActionId::RepairNpmRemoveCodex,
    };
    let package = crate::cli_repair::npm_package(tool);
    let argv = vec![
        npm.to_string(),
        "uninstall".to_string(),
        "-g".to_string(),
        "--prefix".to_string(),
        prefix.as_str().to_string(),
        package.to_string(),
    ];
    Ok(RunPlan {
        action,
        argv,
        direct: false,
        display: crate::cli_repair::npm_display(npm, prefix.as_str(), package, windows),
        watch: Watch::ExitCode,
        // npm's own prefix setting, too, so a script it runs agrees; and the
        // prefix's bin first on PATH, so npm's `#!/usr/bin/env node` finds
        // the node beside it, not another one.
        env: vec![
            ("npm_config_prefix".to_string(), prefix.as_str().to_string()),
            ("PATH".to_string(), npm_path(prefix.as_str(), path, windows)),
        ],
        token: None,
        clone: None,
        cwd: None,
    })
}

fn unsupported(action: ActionId) -> String {
    format!(
        "The setup step \"{}\" isn't offered on {}.",
        action.id(),
        crate::platform::THIS_MACHINE
    )
}

/// A command string from `doctor`'s table (never from the frontend) as an
/// argv: winget's argv as given; `irm … | iex` in Windows PowerShell; any
/// other pipeline or script in `bash -o pipefail -c` (the Mac); and a few
/// plain commands, their program resolved from the probe.
pub fn argv_for(cmd: &'static str, facts: &PlanFacts) -> Result<(Vec<String>, bool), String> {
    let words: Vec<String> = cmd.split_whitespace().map(String::from).collect();
    if let Some(rest) = cmd.strip_prefix("winget ") {
        if !facts.windows {
            return Err(format!("\"{cmd}\" runs on Windows only."));
        }
        let winget = facts.winget.clone().ok_or_else(|| {
            format!(
                "Windows' package installer (winget) isn't available on {}.",
                crate::platform::THIS_MACHINE
            )
        })?;
        let mut argv = vec![winget];
        argv.extend(rest.split_whitespace().map(String::from));
        return Ok((argv, true));
    }
    if cmd.contains("| iex") {
        let powershell = facts.powershell.clone().ok_or_else(|| {
            format!(
                "Windows PowerShell isn't available on {}.",
                crate::platform::THIS_MACHINE
            )
        })?;
        return Ok((
            vec![
                powershell,
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-Command".into(),
                cmd.to_string(),
            ],
            false,
        ));
    }
    if cmd.contains('|') || cmd.contains("&&") || cmd.contains('$') {
        if facts.windows {
            return Err(format!("\"{cmd}\" runs on macOS only."));
        }
        return Ok((
            vec![
                "/bin/bash".into(),
                "-o".into(),
                "pipefail".into(),
                "-c".into(),
                cmd.to_string(),
            ],
            false,
        ));
    }
    let program = match words.first().map(String::as_str) {
        Some("xcode-select") if !facts.windows => Some("/usr/bin/xcode-select".to_string()),
        Some("brew") => facts.brew.clone(),
        Some("codex") => facts.codex.clone(),
        Some("claude") => facts.claude.clone(),
        Some("npm") => facts.npm.clone(),
        Some("gh") => facts.gh.clone(),
        _ => return Err(format!("\"{cmd}\" isn't a command Setup runs.")),
    };
    let program = program.ok_or_else(|| not_installed(&words[0]))?;
    let mut argv = vec![program];
    argv.extend(words.into_iter().skip(1));
    Ok((argv, false))
}

// ── The AI step's reads (D2, D4) ───────────────────────────────────────

/// What `claude auth status --json` / `codex login status` said (spec §5
/// step 3, MEASUREMENTS §1–2). `signed_in: None` = Ply could not tell.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInAnswer {
    pub signed_in: Option<bool>,
    /// Claude: `authMethod` (`claude.ai`, `api_key`, `api_key_helper`,
    /// `oauth_token`, `third_party`, `none`); Codex: `chatgpt` or `api_key`.
    pub method: Option<String>,
    /// Claude only: `subscriptionType` (`pro`, `max`, `team`, …).
    pub plan: Option<String>,
    /// Codex: its own words from stderr.
    pub words: Option<String>,
}

impl SignInAnswer {
    pub fn unknown() -> Self {
        Self {
            signed_in: None,
            method: None,
            plan: None,
            words: None,
        }
    }
}

/// Pure: `claude auth status --json`. Exit 1 with `loggedIn: false` is
/// signed out; unreadable JSON or no exit code is "could not tell".
pub fn claude_status_answer(code: Option<i32>, stdout: &str) -> SignInAnswer {
    let Some(code) = code else {
        return SignInAnswer::unknown();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(stdout.trim()) else {
        return SignInAnswer::unknown();
    };
    let text = |k: &str| json.get(k).and_then(|v| v.as_str()).map(String::from);
    let signed_in = match (json.get("loggedIn").and_then(|v| v.as_bool()), code) {
        (Some(true), 0) => Some(true),
        (Some(false), _) => Some(false),
        _ => None,
    };
    SignInAnswer {
        signed_in,
        method: text("authMethod"),
        plan: text("subscriptionType"),
        words: None,
    }
}

/// Pure: `codex login status`. The exit code is the answer; the words are on
/// stderr; `Error loading configuration` (or any `Error`) is "could not tell".
pub fn codex_status_answer(code: Option<i32>, stderr: &str) -> SignInAnswer {
    let words = stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("WARNING"))
        .map(String::from);
    let method = words.as_deref().and_then(|w| {
        if w.contains("ChatGPT") {
            Some("chatgpt".to_string())
        } else if w.contains("API key") {
            Some("api_key".to_string())
        } else {
            None
        }
    });
    let signed_in = match code {
        Some(0) => Some(true),
        Some(_) if words.as_deref().is_some_and(|w| w.starts_with("Error")) => None,
        Some(1) => Some(false),
        _ => None,
    };
    SignInAnswer {
        signed_in,
        method,
        plan: None,
        words,
    }
}

// ── OB-5: can the installer's host be reached? (spec §5 step 3, "Offline") ──

/// The address an install downloads from, checked with one HEAD before the
/// run starts. `None` for actions whose download host Setup can't name for
/// sure — the updates (Claude Code's channel feed, Codex's standalone or npm
/// path), sign-ins, winget's own sources — which then go ahead unchecked.
pub fn reach_url(action: ActionId, windows: bool) -> Option<&'static str> {
    match action {
        ActionId::InstallClaude => Some(if windows {
            "https://claude.ai/install.ps1"
        } else {
            "https://claude.ai/install.sh"
        }),
        ActionId::InstallCodex => Some(if windows {
            "https://chatgpt.com/codex/install.ps1"
        } else {
            "https://chatgpt.com/codex/install.sh"
        }),
        _ => None,
    }
}

/// The HEAD's program and arguments, all fixed: `url` is one of
/// [`reach_url`]'s constants. The Mac asks curl (with the run's PATH and
/// proxy variables); Windows asks PowerShell's `Invoke-WebRequest`, which
/// goes through the system proxy (WinINet settings, with this user's
/// credentials) the way a browser does — curl.exe would not. `None` (no
/// PowerShell) means the check can't run, and the install goes ahead.
pub fn reach_argv(url: &'static str, windows: bool, powershell: Option<&str>) -> Option<Vec<String>> {
    if !windows {
        return Some(
            ["curl", "-sSI", "--max-time", "5", url]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        );
    }
    let powershell = powershell?;
    // Any HTTP answer, even an error status, means the host was reached.
    let script = format!(
        "$ProgressPreference='SilentlyContinue'; \
         [System.Net.WebRequest]::DefaultWebProxy.Credentials=[System.Net.CredentialCache]::DefaultCredentials; \
         try {{ Invoke-WebRequest -Uri '{url}' -Method Head -UseBasicParsing -TimeoutSec 5 | Out-Null; exit 0 }} \
         catch {{ if ($_.Exception.Response) {{ exit 0 }}; [Console]::Error.WriteLine($_.Exception.Message); exit 1 }}"
    );
    Some(vec![
        powershell.to_string(),
        "-NoLogo".into(),
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-Command".into(),
        script,
    ])
}

/// Windows PowerShell 5.1, for the reachability check.
pub fn powershell_path() -> Option<String> {
    windows_powershell()
}

/// What the HEAD found. `reachable: false` stops the install before it
/// starts ("Nothing was installed"); `proxy` adds the proxy sentence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reach {
    pub reachable: bool,
    pub proxy: bool,
    /// curl's own words, for Details.
    pub details: Option<String>,
}

impl Reach {
    pub fn ok() -> Self {
        Self { reachable: true, proxy: false, details: None }
    }
}

/// Pure: the check's exit code and stderr (`curl -sSI`, no `-f`, or the
/// PowerShell probe: any HTTP answer means the host was reached). `None` = it ran past its bound (offline or
/// a network that swallows the connection). A proxy-looking failure — curl
/// could not resolve or talk to the proxy (5, 97), a 407 or a failed
/// `CONNECT` (56), a TLS certificate an intercepting proxy replaced (35, 60)
/// — sets `proxy`.
pub fn reach_verdict(code: Option<i32>, stderr: &str) -> Reach {
    let details = {
        let t = stderr.trim();
        (!t.is_empty()).then(|| t.to_string())
    };
    let Some(code) = code else {
        return Reach { reachable: false, proxy: false, details };
    };
    if code == 0 {
        return Reach::ok();
    }
    let proxy = matches!(code, 5 | 35 | 60 | 97) || proxy_words(&stderr.to_ascii_lowercase());
    Reach { reachable: false, proxy, details }
}

/// HTTP's 407 as a status: a whole word beside HTTP words ("response 407",
/// "HTTP/1.1 407", "407 Proxy Authentication Required"), never the digits
/// of a version (`2.1.407`) or a count.
fn status_407(lower: &str) -> bool {
    let whole = lower.match_indices("407").any(|(at, _)| {
        let before = lower[..at].chars().next_back();
        let after = lower[at + 3..].chars().next();
        !before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '.')
            && !after.is_some_and(|c| c.is_ascii_alphanumeric() || c == '.')
    });
    whole && ["response", "http", "status", "proxy", "authentication"].iter().any(|w| lower.contains(w))
}

/// The words of a failure that looks like a proxy's, in lowercased text: a
/// 407, a failed `CONNECT`, a proxy named, or PowerShell's words for a
/// certificate an intercepting proxy replaced ("trust relationship").
/// Shared by [`reach_verdict`] and a run's cause (`setup_outcome::classify`).
pub fn proxy_words(lower: &str) -> bool {
    status_407(lower)
        || lower.contains("connect tunnel")
        || lower.contains("after connect")
        || lower.contains("proxy")
        || lower.contains("trust relationship")
}

// ── OB-5: the pages Setup opens in the browser ─────────────────────────

/// The sign-up plan pages (D13) and the vendors' own install pages (the
/// "Do it yourself" way out). The frontend sends a page id, never a URL.
pub fn setup_page(id: &str) -> Option<&'static str> {
    Some(match id {
        "get-claude" => "https://claude.ai/upgrade",
        "get-chatgpt" => "https://chatgpt.com/pricing",
        "install-claude" => "https://docs.claude.com/en/docs/claude-code/setup",
        "install-codex" => "https://developers.openai.com/codex/quickstart",
        "install-git-windows" => "https://git-scm.com/download/win",
        // OB-7a: `I don't have an account` on the GitHub step.
        "github-signup" => "https://github.com/signup",
        // Launch A2: the Plyloft sign-in's code is entered here (GitHub's
        // Device Flow). A fixed page, never the server's own URL.
        "github-device" => "https://github.com/login/device",
        "install-gh" => "https://cli.github.com",
        _ => return None,
    })
}

#[cfg(test)]
#[path = "setup_actions_tests.rs"]
mod tests;
