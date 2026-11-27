//! OB-3 Tier 3: the allowlist, per platform — every id to its exact argv,
//! unknown ids and arguments refused, and no string from the frontend ever
//! reaching an argv.

use super::*;

const CLAUDE: &str = "/Users/u/.local/bin/claude";
const CODEX: &str = "/Users/u/.local/bin/codex";
const GH: &str = "/opt/homebrew/bin/gh";
const BREW: &str = "/opt/homebrew/bin/brew";

const W_CLAUDE: &str = r"C:\Users\u\.local\bin\claude.exe";
const W_CODEX: &str = r"C:\Users\u\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe";
const W_GH: &str = r"C:\Users\u\AppData\Local\Microsoft\WinGet\Links\gh.exe";
const W_PS: &str = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
const W_WINGET: &str = r"C:\Users\u\AppData\Local\Microsoft\WindowsApps\winget.exe";
const W_NPM: &str = r"C:\Program Files\nodejs\npm.cmd";

fn mac() -> PlanFacts {
    PlanFacts {
        windows: false,
        claude: Some(CLAUDE.into()),
        codex: Some(CODEX.into()),
        codex_real: Some("/Users/u/.codex/packages/standalone/releases/0.157.1/bin/codex".into()),
        gh: Some(GH.into()),
        gh_real: Some("/opt/homebrew/Cellar/gh/2.101.0/bin/gh".into()),
        brew: Some(BREW.into()),
        npm: None,
        git_works: true,
        git_resolved: true,
        git_bash: false,
        powershell: None,
        winget: None,
    }
}

fn windows() -> PlanFacts {
    PlanFacts {
        windows: true,
        claude: Some(W_CLAUDE.into()),
        codex: Some(W_CODEX.into()),
        codex_real: Some(W_CODEX.into()),
        gh: Some(W_GH.into()),
        gh_real: Some(W_GH.into()),
        brew: None,
        npm: Some(W_NPM.into()),
        git_works: true,
        git_resolved: true,
        git_bash: true,
        powershell: Some(W_PS.into()),
        winget: Some(W_WINGET.into()),
    }
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn argv(id: &str, facts: &PlanFacts) -> Vec<String> {
    plan_request(id, None, facts)
        .unwrap_or_else(|e| panic!("{id}: {e}"))
        .argv
}

fn bash(script: &str) -> Vec<String> {
    s(&["/bin/bash", "-o", "pipefail", "-c", script])
}

fn ps(script: &str) -> Vec<String> {
    s(&[W_PS, "-NoLogo", "-NoProfile", "-Command", script])
}

const GH_LOGIN: [&str; 8] = [
    "auth",
    "login",
    "--hostname",
    "github.com",
    "--git-protocol",
    "https",
    "--web",
    "--skip-ssh-key",
];

fn with(program: &str, args: &[&str]) -> Vec<String> {
    let mut v = vec![program.to_string()];
    v.extend(args.iter().map(|a| a.to_string()));
    v
}

#[test]
fn every_id_is_its_exact_argv_on_a_mac() {
    let f = mac();
    let table: Vec<(&str, Vec<String>, Watch)> = vec![
        (
            "install.claude",
            bash("curl -fsSL https://claude.ai/install.sh | bash"),
            Watch::ToolWorks(Tool::Claude),
        ),
        (
            "update.claude",
            with(CLAUDE, &["update"]),
            Watch::ToolWorks(Tool::Claude),
        ),
        (
            "login.claude",
            with(CLAUDE, &["auth", "login"]),
            Watch::ClaudeSignIn,
        ),
        (
            "status.claude",
            with(CLAUDE, &["auth", "status", "--json"]),
            Watch::Answer,
        ),
        ("trust.claude", s(&[CLAUDE]), Watch::ClaudeFolderTrust),
        (
            "install.codex",
            bash("curl -fsSL https://chatgpt.com/codex/install.sh | sh"),
            Watch::ToolWorks(Tool::Codex),
        ),
        (
            "update.codex",
            with(CODEX, &["update"]),
            Watch::ToolWorks(Tool::Codex),
        ),
        ("login.codex", with(CODEX, &["login"]), Watch::CodexSignIn),
        (
            "login-device.codex",
            with(CODEX, &["login", "--device-auth"]),
            Watch::CodexSignIn,
        ),
        (
            "status.codex",
            with(CODEX, &["login", "status"]),
            Watch::Answer,
        ),
        (
            "install.gh",
            with(BREW, &["install", "gh"]),
            Watch::ToolWorks(Tool::Gh),
        ),
        (
            "update.gh",
            with(BREW, &["upgrade", "gh"]),
            Watch::ToolWorks(Tool::Gh),
        ),
        ("login.gh", with(GH, &GH_LOGIN), Watch::GhSignedIn),
        ("add-account.gh", with(GH, &GH_LOGIN), Watch::GhNewAccount),
        (
            "setupgit.gh",
            with(GH, &["auth", "setup-git", "--hostname", "github.com"]),
            Watch::GhGitHelper,
        ),
        (
            "refresh.gh",
            with(
                GH,
                &["auth", "refresh", "-h", "github.com", "-s", "repo,read:org"],
            ),
            Watch::GhScopes,
        ),
        (
            "install.git",
            s(&["/usr/bin/xcode-select", "--install"]),
            Watch::CommandLineTools,
        ),
    ];
    assert_eq!(
        table.len() + 1,
        ALL_ACTIONS.len(),
        "every id but install.node"
    );
    for (id, expected, watch) in table {
        let plan = plan_request(id, None, &f).unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(plan.argv, expected, "{id}");
        assert_eq!(plan.watch, watch, "{id}");
        assert!(
            !plan.direct,
            "{id}: nothing is started around the PATH lookup on a Mac"
        );
    }
    // Node is a Windows row only (an npm Codex runs on it).
    assert!(plan_request("install.node", None, &f)
        .unwrap_err()
        .contains("isn't offered on"));
}

#[test]
fn the_mac_without_homebrew_installs_gh_from_the_release_zip() {
    let f = PlanFacts {
        brew: None,
        ..mac()
    };
    let plan = plan_request("install.gh", None, &f).unwrap();
    assert_eq!(plan.argv, bash(doctor::GH_ZIP_INSTALL));
    assert_eq!(plan.display, doctor::GH_ZIP_INSTALL);
    // The zip's gh updates the same way; a .pkg gh gets no update at all.
    let zip = PlanFacts {
        gh: Some("/Users/u/.local/bin/gh".into()),
        gh_real: Some("/Users/u/.local/bin/gh".into()),
        ..f.clone()
    };
    assert_eq!(argv("update.gh", &zip), bash(doctor::GH_ZIP_INSTALL));
    let pkg = PlanFacts {
        gh: Some("/usr/local/bin/gh".into()),
        gh_real: Some("/usr/local/bin/gh".into()),
        ..f
    };
    assert!(plan_request("update.gh", None, &pkg)
        .unwrap_err()
        .contains("can't update this GitHub CLI"));
}

#[test]
fn codex_updates_through_the_way_it_was_installed() {
    let brew = PlanFacts {
        codex_real: Some("/opt/homebrew/Caskroom/codex/0.157.1/codex".into()),
        ..mac()
    };
    assert_eq!(
        argv("update.codex", &brew),
        with(BREW, &["upgrade", "codex"])
    );
    let npm_mac = PlanFacts {
        codex_real: Some("/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js".into()),
        npm: Some("/opt/homebrew/bin/npm".into()),
        ..mac()
    };
    assert_eq!(
        argv("update.codex", &npm_mac),
        with(
            "/opt/homebrew/bin/npm",
            &["install", "-g", "@openai/codex@latest"]
        )
    );
    // npm Codex without npm on PATH: refused in words, nothing runs.
    let no_npm = PlanFacts {
        npm: None,
        ..npm_mac
    };
    assert!(plan_request("update.codex", None, &no_npm)
        .unwrap_err()
        .contains("npm isn't installed"));

    let w = windows();
    assert_eq!(argv("update.codex", &w), ps(doctor::CODEX_WINDOWS_INSTALL));
    let npm_win = PlanFacts {
        codex: Some(r"C:\Users\u\AppData\Roaming\npm\codex.cmd".into()),
        codex_real: Some(r"C:\Users\u\AppData\Roaming\npm\codex.cmd".into()),
        ..w.clone()
    };
    assert_eq!(
        argv("update.codex", &npm_win),
        with(W_NPM, &["install", "-g", "@openai/codex@latest"])
    );
    let scoop = PlanFacts {
        codex: Some(r"C:\Users\u\scoop\shims\codex.exe".into()),
        codex_real: Some(r"C:\Users\u\scoop\shims\codex.exe".into()),
        ..w
    };
    assert!(plan_request("update.codex", None, &scoop)
        .unwrap_err()
        .contains("can't update this Codex"));
}

#[test]
fn every_id_is_its_exact_argv_on_windows() {
    let f = windows();
    let winget = |cmd: &str| -> Vec<String> {
        let mut v = vec![W_WINGET.to_string()];
        v.extend(
            cmd.strip_prefix("winget ")
                .unwrap()
                .split_whitespace()
                .map(String::from),
        );
        v
    };
    let table: Vec<(&str, Vec<String>, bool)> = vec![
        (
            "install.claude",
            ps("irm https://claude.ai/install.ps1 | iex"),
            false,
        ),
        ("update.claude", with(W_CLAUDE, &["update"]), false),
        ("login.claude", with(W_CLAUDE, &["auth", "login"]), false),
        (
            "status.claude",
            with(W_CLAUDE, &["auth", "status", "--json"]),
            false,
        ),
        ("trust.claude", s(&[W_CLAUDE]), false),
        (
            "install.codex",
            ps("irm https://chatgpt.com/codex/install.ps1 | iex"),
            false,
        ),
        (
            "update.codex",
            ps("irm https://chatgpt.com/codex/install.ps1 | iex"),
            false,
        ),
        ("login.codex", with(W_CODEX, &["login"]), false),
        (
            "login-device.codex",
            with(W_CODEX, &["login", "--device-auth"]),
            false,
        ),
        ("status.codex", with(W_CODEX, &["login", "status"]), false),
        (
            "install.gh",
            with(
                W_WINGET,
                &[
                    "install",
                    "--id",
                    "GitHub.cli",
                    "-e",
                    "--source",
                    "winget",
                    "--scope",
                    "user",
                    "--accept-package-agreements",
                    "--accept-source-agreements",
                ],
            ),
            true,
        ),
        (
            "update.gh",
            with(
                W_WINGET,
                &[
                    "upgrade",
                    "--id",
                    "GitHub.cli",
                    "-e",
                    "--source",
                    "winget",
                    "--accept-package-agreements",
                    "--accept-source-agreements",
                ],
            ),
            true,
        ),
        ("login.gh", with(W_GH, &GH_LOGIN), false),
        ("add-account.gh", with(W_GH, &GH_LOGIN), false),
        (
            "setupgit.gh",
            with(W_GH, &["auth", "setup-git", "--hostname", "github.com"]),
            false,
        ),
        (
            "refresh.gh",
            with(
                W_GH,
                &["auth", "refresh", "-h", "github.com", "-s", "repo,read:org"],
            ),
            false,
        ),
        (
            "install.git",
            with(
                W_WINGET,
                &[
                    "install",
                    "--id",
                    "Git.Git",
                    "-e",
                    "--source",
                    "winget",
                    "--accept-package-agreements",
                    "--accept-source-agreements",
                ],
            ),
            true,
        ),
        (
            "install.node",
            with(
                W_WINGET,
                &[
                    "install",
                    "--id",
                    "OpenJS.NodeJS.LTS",
                    "-e",
                    "--source",
                    "winget",
                    "--scope",
                    "user",
                    "--accept-package-agreements",
                    "--accept-source-agreements",
                ],
            ),
            true,
        ),
    ];
    assert_eq!(table.len(), ALL_ACTIONS.len());
    for (id, expected, direct) in table {
        let plan = plan_request(id, None, &f).unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(plan.argv, expected, "{id}");
        assert_eq!(
            plan.direct, direct,
            "{id}: only winget's alias starts as given"
        );
    }
    // The winget lines are doctor's, word for word.
    assert_eq!(argv("install.gh", &f), winget(doctor::WINGET_GH));
    assert_eq!(argv("install.node", &f), winget(doctor::WINGET_NODE));
    // A git without Git Bash gets Git for Windows with --force.
    let no_bash = PlanFacts {
        git_bash: false,
        ..f.clone()
    };
    assert_eq!(
        argv("install.git", &no_bash),
        winget(doctor::WINGET_GIT_FORCE)
    );
    // OB-6 review P3-6: a git that resolves but doesn't start, likewise.
    let broken = PlanFacts {
        git_works: false,
        git_resolved: true,
        git_bash: false,
        ..f.clone()
    };
    assert_eq!(argv("install.git", &broken), winget(doctor::WINGET_GIT_FORCE));
    let none = PlanFacts {
        git_works: false,
        git_resolved: false,
        git_bash: false,
        ..f.clone()
    };
    assert_eq!(argv("install.git", &none), winget(doctor::WINGET_GIT));
    // No winget (LTSC, Server, blocked): refused in words.
    let no_winget = PlanFacts { winget: None, ..f };
    assert!(plan_request("install.gh", None, &no_winget)
        .unwrap_err()
        .contains("winget"));
}

#[test]
fn a_missing_tool_is_refused_before_anything_runs() {
    let bare = PlanFacts {
        claude: None,
        codex: None,
        gh: None,
        ..mac()
    };
    for id in [
        "update.claude",
        "login.claude",
        "status.claude",
        "trust.claude",
        "update.codex",
        "login.codex",
        "login-device.codex",
        "status.codex",
        "update.gh",
        "login.gh",
        "add-account.gh",
        "setupgit.gh",
        "refresh.gh",
    ] {
        let error = plan_request(id, None, &bare).unwrap_err();
        assert!(error.contains("isn't installed yet"), "{id}: {error}");
    }
    // Installs need nothing installed.
    for id in [
        "install.claude",
        "install.codex",
        "install.gh",
        "install.git",
    ] {
        assert!(plan_request(id, None, &bare).is_ok(), "{id}");
    }
}

#[test]
fn ids_are_matched_exactly_and_unknown_ones_are_refused() {
    let mut seen = std::collections::HashSet::new();
    for action in ALL_ACTIONS {
        assert_eq!(ActionId::parse(action.id()), Some(action));
        assert!(seen.insert(action.id()), "duplicate id {}", action.id());
        // Status reads are the AI step's; every other id is a terminal run.
        assert_eq!(action.is_status_read(), action.id().starts_with("status."));
    }
    for bad in [
        "",
        "install",
        "install.claude ",
        " install.claude",
        "INSTALL.CLAUDE",
        "install.Claude",
        "install.claude;rm -rf ~",
        "install.claude\n",
        "install.python",
        "identity.write",
        "project.clone",
        "team.accept",
        "status.gh",
        "../install.claude",
    ] {
        let error = plan_request(bad, None, &mac()).unwrap_err();
        assert!(
            error.starts_with("Plyloft doesn't know the setup step"),
            "{bad:?}: {error}"
        );
        assert!(
            !error.contains(';') && !error.contains('\n') && !error.contains(" ~"),
            "echoed unsafely: {error:?}"
        );
    }
}

#[test]
fn arguments_are_only_the_github_host_and_only_for_gh() {
    let host = |h: &str| SetupArgs {
        hostname: Some(h.to_string()),
    };
    for id in ["login.gh", "add-account.gh", "setupgit.gh", "refresh.gh"] {
        assert!(
            plan_request(id, Some(&host("github.com")), &mac()).is_ok(),
            "{id}"
        );
        for bad in [
            "github.example.com",
            "GitHub.com",
            "github.com ",
            "github.com; rm -rf ~",
            "",
            "--with-token",
        ] {
            assert_eq!(
                plan_request(id, Some(&host(bad)), &mac()).unwrap_err(),
                HOST_REFUSED,
                "{id} {bad:?}"
            );
        }
    }
    for id in ALL_ACTIONS.iter().map(|a| a.id()).filter(|id| {
        !id.ends_with(".gh") || id.starts_with("install.") || id.starts_with("update.")
    }) {
        let error = plan_request(id, Some(&host("github.com")), &mac()).unwrap_err();
        assert_eq!(error, ARGS_REFUSED, "{id}");
    }
    // Empty args are the same as none.
    assert!(plan_request("install.claude", Some(&SetupArgs::default()), &mac()).is_ok());
    // A field the table doesn't know never decodes.
    for raw in [
        r#"{"command":"rm -rf ~"}"#,
        r#"{"hostname":"github.com","argv":["x"]}"#,
        r#"{"args":"--x"}"#,
    ] {
        assert!(serde_json::from_str::<SetupArgs>(raw).is_err(), "{raw}");
    }
    assert_eq!(
        serde_json::from_str::<SetupArgs>(r#"{"hostname":"github.com"}"#).unwrap(),
        host("github.com")
    );
}

/// A tiny deterministic generator, so the fuzz is the same on every run.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn string(&mut self) -> String {
        const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz.-_;|&$`'\" \n\\/~*(){}<>ABCZ0189";
        let len = (self.next() % 24) as usize;
        (0..len)
            .map(|_| ALPHABET[(self.next() as usize) % ALPHABET.len()] as char)
            .collect()
    }
}

/// The literals the table itself holds (its arguments and wrappers).
fn table_literals() -> Vec<String> {
    let mut words: Vec<String> = s(&[
        "/bin/bash",
        "-o",
        "pipefail",
        "-c",
        "/usr/bin/xcode-select",
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "update",
        "auth",
        "login",
        "status",
        "--json",
        "--device-auth",
        "setup-git",
        "refresh",
        "-h",
        "-s",
        GH_SCOPES,
        GITHUB_HOST,
        "--hostname",
        "--git-protocol",
        "https",
        "--web",
        "--skip-ssh-key",
    ]);
    let doctor_cmds = [
        doctor::install_cmd_on("claude", false).unwrap(),
        doctor::install_cmd_on("claude", true).unwrap(),
        doctor::install_cmd_on("codex", false).unwrap(),
        doctor::install_cmd_on("codex", true).unwrap(),
        doctor::install_cmd_on("gh", false).unwrap(),
        doctor::install_cmd_on("git", false).unwrap(),
        doctor::GH_ZIP_INSTALL,
        doctor::WINGET_GIT,
        doctor::WINGET_GIT_FORCE,
        doctor::WINGET_GH,
        doctor::WINGET_NODE,
        doctor::WINGET_GH_UPGRADE,
        doctor::CODEX_WINDOWS_INSTALL,
        "brew upgrade gh",
        "brew upgrade codex",
        "codex update",
        "npm install -g @openai/codex@latest",
    ];
    for cmd in doctor_cmds {
        words.push(cmd.to_string());
        words.extend(cmd.split_whitespace().map(String::from));
    }
    words
}

/// Principle 8: whatever the frontend sends — any id, any host — every argv
/// Rust builds is made of the table's literals and the probe's paths only.
/// A frontend string is never one of its values.
#[test]
fn no_frontend_string_reaches_an_argv() {
    let literals = table_literals();
    let mut rng = Lcg(0x0B3);
    for facts in [
        mac(),
        windows(),
        PlanFacts {
            brew: None,
            ..mac()
        },
    ] {
        let paths: Vec<String> = [
            &facts.claude,
            &facts.codex,
            &facts.gh,
            &facts.brew,
            &facts.npm,
            &facts.powershell,
            &facts.winget,
        ]
        .iter()
        .filter_map(|p| (*p).clone())
        .collect();
        let check = |id: &str, args: Option<&SetupArgs>, sent: &[String]| {
            if let Ok(plan) = plan_request(id, args, &facts) {
                for value in &plan.argv {
                    assert!(
                        literals.contains(value) || paths.contains(value),
                        "{id}: {value:?} is neither a table literal nor a probed path"
                    );
                    for s in sent {
                        if s.len() >= 6 && s != GITHUB_HOST && !literals.contains(s) {
                            assert!(
                                !value.contains(s.as_str()),
                                "{id}: the frontend's {s:?} reached {value:?}"
                            );
                        }
                    }
                }
            }
        };
        for action in ALL_ACTIONS {
            check(action.id(), None, &[]);
            check(
                action.id(),
                Some(&SetupArgs {
                    hostname: Some(GITHUB_HOST.into()),
                }),
                &[],
            );
        }
        for _ in 0..4000 {
            let id = if rng.next() % 3 == 0 {
                ALL_ACTIONS[(rng.next() as usize) % ALL_ACTIONS.len()]
                    .id()
                    .to_string()
            } else {
                rng.string()
            };
            let host = rng.string();
            let args = SetupArgs {
                hostname: Some(host.clone()),
            };
            check(&id, Some(&args), &[id.clone(), host]);
            // Mutations of a real id are never accepted.
            let real = ALL_ACTIONS[(rng.next() as usize) % ALL_ACTIONS.len()].id();
            let mutated = format!("{real}{}", rng.string());
            if mutated != real {
                assert!(plan_request(&mutated, None, &facts).is_err(), "{mutated:?}");
            }
        }
    }
}

#[test]
fn installs_and_updates_re_probe_and_nothing_else_does() {
    for action in ALL_ACTIONS {
        let id = action.id();
        assert_eq!(
            action.changes_programs(),
            id.starts_with("install.") || id.starts_with("update."),
            "{id}"
        );
    }
}

#[test]
fn the_ai_steps_reads_are_answered_by_exit_code_and_words() {
    // MEASUREMENTS §1.
    let max = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}"#;
    assert_eq!(
        claude_status_answer(Some(0), max),
        SignInAnswer {
            signed_in: Some(true),
            method: Some("claude.ai".into()),
            plan: Some("max".into()),
            words: None
        }
    );
    let out = r#"{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}"#;
    assert_eq!(claude_status_answer(Some(1), out).signed_in, Some(false));
    let key = r#"{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}"#;
    let answer = claude_status_answer(Some(0), key);
    assert_eq!(
        (answer.signed_in, answer.method.as_deref(), answer.plan),
        (Some(true), Some("api_key"), None)
    );
    assert_eq!(
        claude_status_answer(Some(0), "not json"),
        SignInAnswer::unknown()
    );
    assert_eq!(
        claude_status_answer(None, max),
        SignInAnswer::unknown(),
        "timed out"
    );

    // MEASUREMENTS §2: words on stderr, exit code the answer.
    let a = codex_status_answer(Some(0), "Logged in using ChatGPT\n");
    assert_eq!(
        (a.signed_in, a.method.as_deref(), a.words.as_deref()),
        (Some(true), Some("chatgpt"), Some("Logged in using ChatGPT"))
    );
    let a = codex_status_answer(Some(0), "Logged in using an API key - sk-FAKE-***a-key");
    assert_eq!(
        (a.signed_in, a.method.as_deref()),
        (Some(true), Some("api_key"))
    );
    assert_eq!(
        codex_status_answer(Some(1), "Not logged in").signed_in,
        Some(false)
    );
    let broken = "WARNING: proceeding, even though we could not create PATH aliases\nError loading configuration: CODEX_HOME points to \"x\", but that path does not exist";
    assert_eq!(
        codex_status_answer(Some(1), broken).signed_in,
        None,
        "could not tell"
    );
    assert_eq!(codex_status_answer(None, "").signed_in, None);
}

// OB-5: the offline check before a download.
#[test]
fn reach_names_the_installer_host_and_reads_curl() {
    assert_eq!(reach_url(ActionId::InstallClaude, false), Some("https://claude.ai/install.sh"));
    assert_eq!(reach_url(ActionId::InstallClaude, true), Some("https://claude.ai/install.ps1"));
    assert_eq!(reach_url(ActionId::InstallCodex, false), Some("https://chatgpt.com/codex/install.sh"));
    assert_eq!(reach_url(ActionId::InstallCodex, true), Some("https://chatgpt.com/codex/install.ps1"));
    // Updates download from a host that depends on the channel or the
    // package manager: not checked (review P3-3).
    for quiet in [
        ActionId::UpdateClaude,
        ActionId::UpdateCodex,
        ActionId::LoginClaude,
        ActionId::StatusCodex,
        ActionId::InstallGit,
        ActionId::InstallGh,
    ] {
        assert_eq!(reach_url(quiet, false), None, "{}", quiet.id());
    }

    assert_eq!(reach_verdict(Some(0), ""), Reach::ok());
    let offline = reach_verdict(Some(6), "curl: (6) Could not resolve host: claude.ai");
    assert!(!offline.reachable && !offline.proxy);
    assert_eq!(offline.details.as_deref(), Some("curl: (6) Could not resolve host: claude.ai"));
    let timed_out = reach_verdict(None, "");
    assert!(!timed_out.reachable && !timed_out.proxy && timed_out.details.is_none());
    let auth = reach_verdict(Some(56), "curl: (56) CONNECT tunnel failed, response 407");
    assert!(!auth.reachable && auth.proxy, "407 from a proxy");
    let tls = reach_verdict(Some(60), "curl: (60) SSL certificate problem: self signed certificate in certificate chain");
    assert!(!tls.reachable && tls.proxy, "an intercepting proxy's certificate");
    assert!(reach_verdict(Some(5), "curl: (5) Could not resolve proxy: corp").proxy);
    assert!(!reach_verdict(Some(7), "curl: (7) Failed to connect to claude.ai port 443").proxy);
}

#[test]
fn setup_pages_are_a_fixed_table() {
    assert_eq!(setup_page("get-claude"), Some("https://claude.ai/upgrade"));
    assert_eq!(setup_page("get-chatgpt"), Some("https://chatgpt.com/pricing"));
    assert!(setup_page("install-git-windows").is_some_and(|u| u.starts_with("https://")));
    assert_eq!(setup_page("github-signup"), Some("https://github.com/signup"));
    assert_eq!(setup_page("github-device"), Some("https://github.com/login/device"));
    assert_eq!(setup_page("install-gh"), Some("https://cli.github.com"));
    for refused in ["", "https://evil.example", "get-claude ", "GET-CLAUDE", "file:///etc/passwd"] {
        assert_eq!(setup_page(refused), None, "{refused:?}");
    }
}

// Review P2-2: Windows checks through PowerShell (the system proxy), with a
// fixed argv; no PowerShell = no check.
#[test]
fn reach_argv_is_fixed_per_platform() {
    let url = reach_url(ActionId::InstallClaude, false).unwrap();
    assert_eq!(
        reach_argv(url, false, None).unwrap(),
        vec!["curl", "-sSI", "--max-time", "5", "https://claude.ai/install.sh"]
    );
    let url = reach_url(ActionId::InstallCodex, true).unwrap();
    let argv = reach_argv(url, true, Some(W_PS)).unwrap();
    assert_eq!(&argv[..5], &[W_PS, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    assert_eq!(argv.len(), 6);
    let script = &argv[5];
    assert!(script.contains("Invoke-WebRequest -Uri 'https://chatgpt.com/codex/install.ps1' -Method Head -UseBasicParsing -TimeoutSec 5"));
    assert!(script.contains("DefaultCredentials"), "the system proxy with this user's credentials");
    assert!(script.contains("$_.Exception.Response) { exit 0 }"), "an HTTP error status is still reached");
    assert_eq!(reach_argv(url, true, None), None, "no PowerShell: go ahead unchecked");

    let proxy = reach_verdict(Some(1), "The remote server returned an error: (407) Proxy Authentication Required.");
    assert!(!proxy.reachable && proxy.proxy);
    let tls = reach_verdict(Some(1), "The underlying connection was closed: Could not establish trust relationship for the SSL/TLS secure channel.");
    assert!(tls.proxy);
    let offline = reach_verdict(Some(1), "The remote name could not be resolved: 'claude.ai'");
    assert!(!offline.reachable && !offline.proxy);
}
