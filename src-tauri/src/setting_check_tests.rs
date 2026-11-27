//! 1.176.1: the free-text settings readers, Mac and Windows forms, on a fake
//! disk.

use super::*;
use std::collections::{HashMap, HashSet};

#[derive(Default)]
struct Fake {
    windows: bool,
    dirs: HashSet<String>,
    /// Files, and whether each can be run.
    files: HashMap<String, bool>,
    read_only: HashSet<String>,
    texts: HashMap<String, String>,
    /// Links whose target isn't there: link → target.
    dangling: HashMap<String, String>,
}

impl Fake {
    fn key(&self, p: &str) -> String {
        if self.windows {
            let t = p.trim_end_matches('\\').to_ascii_lowercase();
            if t.len() == 2 && t.ends_with(':') {
                format!("{t}\\")
            } else {
                t
            }
        } else {
            let t = p.trim_end_matches('/');
            if t.is_empty() {
                "/".into()
            } else {
                t.to_string()
            }
        }
    }
    fn dir(mut self, d: &str) -> Self {
        let k = self.key(d);
        self.dirs.insert(k);
        self
    }
    fn file(mut self, f: &str, runnable: bool) -> Self {
        let k = self.key(f);
        self.files.insert(k, runnable);
        self
    }
    fn text(mut self, f: &str, body: &str) -> Self {
        let k = self.key(f);
        self.files.insert(k.clone(), false);
        self.texts.insert(k, body.into());
        self
    }
    fn dangling(mut self, link: &str, target: &str) -> Self {
        let k = self.key(link);
        self.dangling.insert(k, target.into());
        self
    }
    fn locked(mut self, d: &str) -> Self {
        let k = self.key(d);
        self.read_only.insert(k);
        self
    }

    fn mac() -> Self {
        Fake::default()
            .dir("/")
            .dir("/bin")
            .dir("/usr/bin")
            .dir("/opt/homebrew/bin")
            .dir("/Users")
            .dir("/Users/ada")
            .dir("/Users/ada/code/app")
            .dir("/Users/ada/Library/Application Support/com.mbadv.ply")
            .file("/bin/zsh", true)
            .file("/bin/bash", true)
            .file("/bin/sh", true)
            .file("/usr/bin/git", true)
            .file("/usr/bin/make", true)
            .file("/opt/homebrew/bin/fish", true)
            .file("/opt/homebrew/bin/npm", true)
            .file("/opt/homebrew/bin/pnpm", true)
            .file("/opt/homebrew/bin/bun", true)
            .file("/opt/homebrew/bin/tmux", true)
            .file("/Users/ada/notes.txt", false)
            .dir("/Volumes/Work")
            .locked("/")
    }

    fn win() -> Self {
        Fake { windows: true, ..Fake::default() }
            .dir(r"C:\")
            .dir(r"C:\Windows\System32")
            .dir(r"C:\Program Files\PowerShell\7")
            .dir(r"C:\Users\Ada")
            .dir(r"C:\Users\Ada\code\app")
            .file(r"C:\Windows\System32\cmd.exe", true)
            .file(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe", true)
            .file(r"C:\Program Files\PowerShell\7\pwsh.exe", true)
            .file(r"C:\Program Files\Git\cmd\git.exe", true)
            .file(r"C:\Users\Ada\AppData\Roaming\npm\npm.cmd", true)
    }
}

impl Look for Fake {
    fn kind(&self, path: &str) -> PathKind {
        let k = self.key(path);
        if self.dirs.contains(&k) {
            PathKind::Dir
        } else if self.files.contains_key(&k) {
            PathKind::File
        } else {
            PathKind::Absent
        }
    }
    fn runnable(&self, path: &str) -> bool {
        self.files.get(&self.key(path)).copied().unwrap_or(false)
    }
    fn program(&self, dir: &str, name: &str) -> Option<String> {
        let sep = if self.windows { '\\' } else { '/' };
        let base = format!("{}{sep}{name}", dir.trim_end_matches(['/', '\\']));
        let mut c = vec![base.clone()];
        if self.windows {
            c.extend([".exe", ".cmd", ".bat"].iter().map(|e| format!("{base}{e}")));
        }
        c.into_iter().find(|p| self.runnable(p))
    }
    fn writable(&self, dir: &str) -> bool {
        !self.read_only.contains(&self.key(dir))
    }
    fn read_small(&self, path: &str) -> Option<String> {
        self.texts.get(&self.key(path)).cloned()
    }
    fn link_away(&self, path: &str) -> Option<String> {
        self.dangling.get(&self.key(path)).cloned()
    }
}

fn mac_ctx() -> Ctx {
    Ctx {
        windows: false,
        home: Some("/Users/ada".into()),
        path: "/opt/homebrew/bin:/usr/bin:/bin".into(),
        vars: vec![],
    }
}

fn win_ctx() -> Ctx {
    Ctx {
        windows: true,
        home: Some(r"C:\Users\Ada".into()),
        path: r"C:\Windows\System32;C:\Windows\System32\WindowsPowerShell\v1.0;C:\Program Files\Git\cmd;C:\Users\Ada\AppData\Roaming\npm".into(),
        vars: vec![("LOCALAPPDATA".into(), r"C:\Users\Ada\AppData\Local".into())],
    }
}

fn shell(v: &str) -> Reading {
    read_tile_shell(v, &mac_ctx(), &Fake::mac())
}
fn wshell(v: &str) -> Reading {
    read_tile_shell(v, &win_ctx(), &Fake::win())
}

// ── Tile shell ─────────────────────────────────────────────────────────

#[test]
fn a_good_shell_is_saved_as_is_and_says_what_runs() {
    for (v, runs) in [("/bin/zsh", "/bin/zsh"), ("fish", "/opt/homebrew/bin/fish"), ("", "")] {
        let r = shell(v);
        assert_eq!(r.level, Level::Ok, "{v}: {r:?}");
        assert_eq!(r.save_as.as_deref(), Some(v));
        assert!(!r.broken);
        if !v.is_empty() {
            assert_eq!(r.resolved.as_deref(), Some(runs));
        }
    }
}

#[test]
fn a_shell_that_certainly_cannot_start_is_refused() {
    let cases = [
        ("/opt/homebrew/bin", Finding::IsFolder { path: "/opt/homebrew/bin".into() }),
        ("/Users/ada/notes.txt", Finding::NotRunnable { path: "/Users/ada/notes.txt".into() }),
        ("nushell", Finding::ProgramNotFound { name: "nushell".into() }),
        ("/usr/local/bin/fish", Finding::Missing { path: "/usr/local/bin/fish".into() }),
        ("~bob/bin/zsh", Finding::OtherHome),
    ];
    for (v, want) in cases {
        let r = shell(v);
        assert_eq!(r.level, Level::Blocked, "{v}: {r:?}");
        assert_eq!(r.save_as, None, "{v}");
        assert_eq!(r.findings[0], want, "{v}");
        assert!(r.broken, "{v}");
    }
}

#[test]
fn arguments_and_variables_are_refused_with_the_one_press_correction() {
    let r = shell("zsh -i");
    assert_eq!(r.level, Level::Blocked);
    assert_eq!(r.findings[0], Finding::HasArguments { program: "zsh".into() });
    assert_eq!(r.fix.as_deref(), Some("zsh"));

    let r = shell("/bin/bash --login");
    assert_eq!(r.fix.as_deref(), Some("/bin/bash"));

    let r = read_tile_shell("$HOME/bin/zsh", &mac_ctx(), &Fake::mac().dir("/Users/ada/bin").file("/Users/ada/bin/zsh", true));
    assert_eq!(r.level, Level::Blocked);
    assert_eq!(r.findings[0], Finding::Variable { name: "HOME".into() });
    assert_eq!(r.fix.as_deref(), Some("/Users/ada/bin/zsh"));

    // Written out, it isn't a program either: no correction to offer.
    let r = shell("$HOME/bin/nothing");
    assert_eq!(r.fix, None);
}

#[test]
fn a_tilde_is_written_out_on_save_and_a_saved_one_is_broken() {
    let look = Fake::mac().dir("/Users/ada/.local/bin").file("/Users/ada/.local/bin/fish", true);
    let r = read_tile_shell("~/.local/bin/fish", &mac_ctx(), &look);
    assert_eq!(r.level, Level::Hint);
    assert_eq!(r.save_as.as_deref(), Some("/Users/ada/.local/bin/fish"));
    assert!(r.broken, "a spawn reads ~ literally");
    assert_eq!(r.fix.as_deref(), Some("/Users/ada/.local/bin/fish"));

    let r = shell("  \"/bin/zsh\" ");
    assert_eq!(r.save_as.as_deref(), Some("/bin/zsh"));
    assert!(r.findings.contains(&Finding::Untidy));
    assert!(r.broken, "quotes reach the spawn");

    // Spaces alone are trimmed where the value is used: it works.
    let r = shell("  /bin/zsh ");
    assert_eq!(r.level, Level::Ok);
    assert!(!r.broken);
    assert!(r.findings.is_empty());
}

#[test]
fn env_and_wsl() {
    let r = shell("/usr/bin/env zsh");
    assert_eq!(r.findings[0], Finding::HasArguments { program: "zsh".into() });
    assert_eq!(r.fix.as_deref(), Some("zsh"));
    let look = Fake::win().file(r"C:\Windows\System32\wsl.exe", true);
    let r = read_tile_shell("wsl", &win_ctx(), &look);
    assert_eq!(r.level, Level::Ok, "{r:?}");
}

#[test]
fn unusual_but_possible_shells_are_asked() {
    let r = shell("tmux");
    assert_eq!(r.level, Level::Confirm);
    assert_eq!(r.findings[0], Finding::NotAShell { name: "tmux".into() });
    assert_eq!(r.save_as.as_deref(), Some("tmux"));

    let r = shell("/Volumes/Tools/bin/zsh");
    assert_eq!(r.level, Level::Confirm);
    assert_eq!(r.findings[0], Finding::DiskAbsent { disk: "/Volumes/Tools".into() });
    assert_eq!(r.save_as.as_deref(), Some("/Volumes/Tools/bin/zsh"));

    // On a disk that is there, a missing file is just missing.
    let r = shell("/Volumes/Work/bin/zsh");
    assert_eq!(r.findings[0], Finding::Missing { path: "/Volumes/Work/bin/zsh".into() });
}

#[test]
fn windows_shells_by_name_by_path_without_extension_and_quoted() {
    for v in ["powershell", "cmd", r"C:\Program Files\PowerShell\7\pwsh.exe", r"C:\Program Files\PowerShell\7\pwsh"] {
        let r = wshell(v);
        assert_eq!(r.level, Level::Ok, "{v}: {r:?}");
    }
    // `pwsh` is not on this PATH.
    assert_eq!(wshell("pwsh").findings[0], Finding::ProgramNotFound { name: "pwsh".into() });
    // Explorer's "Copy as path".
    let r = wshell("\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\"");
    assert_eq!(r.save_as.as_deref(), Some(r"C:\Program Files\PowerShell\7\pwsh.exe"));
    assert!(r.broken);

    let r = wshell(r"E:\tools\nu.exe");
    assert_eq!(r.findings[0], Finding::DiskAbsent { disk: r"E:\".into() });
    assert_eq!(r.level, Level::Confirm);

    let r = wshell(r"tools\pwsh.exe");
    assert_eq!(r.findings[0], Finding::Relative);

    let r = wshell(r"%LOCALAPPDATA%\nu\nu.exe");
    assert_eq!(r.findings[0], Finding::Variable { name: "LOCALAPPDATA".into() });

    // A Mac path to a shell: Windows tiles run the default shell for it.
    let r = wshell("/bin/zsh");
    assert_eq!(r.level, Level::Hint);
    assert_eq!(r.findings[0], Finding::MacShellPath);
    assert!(!r.broken);
}

// ── Commands ───────────────────────────────────────────────────────────

fn project() -> CheckContext {
    CheckContext { project: Some("/Users/ada/code/app".into()), keeps_tilde: false, interactive: false }
}

fn cmd_on(look: Fake, v: &str) -> Reading {
    read_command(v, &project(), &mac_ctx(), &look)
}

#[test]
fn commands_found_are_fine_and_never_refused() {
    // Review 1: redirections, workspace flags and files read as nothing.
    let review = || {
        Fake::mac()
            .text("/Users/ada/code/app/package.json", r#"{"scripts":{"dev":"vite"}}"#)
            .text("/Users/ada/code/app/Makefile", "all:\n")
            .file("/Users/ada/code/app/configure", true)
    };
    for v in [
        "npm ci > /dev/null 2>&1",
        "npm ci &> log",
        "npm ci >> log 2> err",
        "npm ci >&2",
        "npm run -w web build",
        "npm run --workspace web build",
        "pnpm run -r build",
        "npm run build --if-present",
        "bun run src/index.ts",
        "./configure && make install",
        "make -j 8 all",
        "make -j 8 x",
        "cat <<EOF\nhi\nEOF",
        "echo $(nope)",
        "echo 'open",
    ] {
        let r = cmd_on(review(), v);
        assert_eq!(r.level, Level::Ok, "{v}: {r:?}");
    }
    let look = || Fake::mac().text("/Users/ada/code/app/package.json", r#"{"scripts":{"dev":"vite","test":"vitest"}}"#);
    for v in [
        "npm run dev",
        "npm test",
        "PORT=3000 npm run dev",
        "cd web && npm install && ./missing-but-after-cd",
        "git status | sh",
        "echo hi; export X=1",
        "$EDITOR file",
        "env FOO=1 npm run dev",
        "# a comment only",
    ] {
        let r = cmd_on(look(), v);
        assert_eq!(r.level, Level::Ok, "{v}: {r:?}");
        assert_eq!(r.save_as.as_deref(), Some(v));
    }
}

#[test]
fn commands_that_will_fail_here_are_warned_never_refused() {
    let look = || Fake::mac().text("/Users/ada/code/app/package.json", r#"{"scripts":{"dev":"vite"}}"#);
    let cases = [
        ("cargo build", Finding::CommandNotFound { word: "cargo".into() }),
        ("./scripts/dev.sh", Finding::ProjectFileMissing { path: "./scripts/dev.sh".into() }),
        ("npm run start", Finding::NoScript { script: "start".into(), tool: "npm".into() }),
        ("npm test", Finding::NoScript { script: "test".into(), tool: "npm".into() }),
        ("make dev", Finding::NoMakefile),
        ("FOO=1 nope && npm run dev", Finding::CommandNotFound { word: "nope".into() }),
        ("time 'pnpmx' build", Finding::CommandNotFound { word: "pnpmx".into() }),
    ];
    for (v, want) in cases {
        let r = cmd_on(look(), v);
        assert_eq!(r.level, Level::Warn, "{v}: {r:?}");
        assert_eq!(r.findings[0], want, "{v}");
        assert_eq!(r.save_as.as_deref(), Some(v), "never blocked: {v}");
    }
    let r = cmd_on(Fake::mac(), "npm run dev");
    assert_eq!(r.findings[0], Finding::NoPackageJson);
}

#[test]
fn make_targets_are_judged_only_when_a_plain_read_can_say() {
    let mk = "CC := clang\nall: build\nbuild test:\n\techo hi\n";
    let look = || Fake::mac().text("/Users/ada/code/app/Makefile", mk);
    assert_eq!(cmd_on(look(), "make test").level, Level::Ok);
    let r = cmd_on(look(), "make deploy");
    assert_eq!(r.findings, vec![Finding::NoMakeTarget { target: "deploy".into() }]);
    assert_eq!(r.level, Level::Hint);
    let inc = Fake::mac().text("/Users/ada/code/app/Makefile", "include other.mk\nall:\n");
    assert_eq!(cmd_on(inc, "make deploy").level, Level::Ok);
    let pat = Fake::mac().text("/Users/ada/code/app/Makefile", "%.o: %.c\n");
    assert_eq!(cmd_on(pat, "make deploy").level, Level::Ok);
    assert_eq!(cmd_on(Fake::mac(), "make -C sub all").level, Level::Ok);
    // A step before it may write the Makefile.
    let gen = Fake::mac().file("/Users/ada/code/app/configure", true);
    assert_eq!(cmd_on(gen, "./configure && make").level, Level::Ok);
}

#[test]
fn a_project_file_that_is_not_runnable_is_a_hint() {
    let look = Fake::mac().dir("/Users/ada/code/app/scripts").file("/Users/ada/code/app/scripts/dev.sh", false);
    let r = cmd_on(look, "./scripts/dev.sh");
    assert_eq!(r.level, Level::Hint);
    assert_eq!(r.findings[0], Finding::NotRunnable { path: "./scripts/dev.sh".into() });
}

#[test]
fn try_it_is_typed_into_the_persons_own_shell_so_not_found_is_a_hint() {
    let ctx = CheckContext { project: Some("/Users/ada/code/app".into()), keeps_tilde: false, interactive: true };
    let r = read_command("nvm use && npm run dev", &ctx, &mac_ctx(), &Fake::mac().text("/Users/ada/code/app/package.json", r#"{"scripts":{"dev":"vite"}}"#));
    assert_eq!(r.level, Level::Hint);
    assert_eq!(r.findings, vec![Finding::NotFoundHere { word: "nvm".into() }]);
    // A missing project file is still certain.
    let r = read_command("./start.sh", &ctx, &mac_ctx(), &Fake::mac());
    assert_eq!(r.level, Level::Warn);
    // Windows: cmdlets and a .ps1 PowerShell runs.
    let wctx = CheckContext { project: Some(r"C:\Users\Ada\code\app".into()), keeps_tilde: false, interactive: true };
    let look = Fake::win().dir(r"C:\Users\Ada\code\app\scripts").file(r"C:\Users\Ada\code\app\scripts\dev.ps1", false);
    let r = read_command(r"Remove-Item -Recurse dist; .\scripts\dev.ps1", &wctx, &win_ctx(), &look);
    assert_eq!(r.level, Level::Ok, "{r:?}");
}

#[test]
fn windows_commands_resolve_with_their_extensions() {
    let look = Fake::win().text(r"C:\Users\Ada\code\app\package.json", r#"{"scripts":{"dev":"vite"}}"#);
    let ctx = CheckContext { project: Some(r"C:\Users\Ada\code\app".into()), keeps_tilde: false, interactive: false };
    assert_eq!(read_command("npm run dev", &ctx, &win_ctx(), &look).level, Level::Ok);
    assert_eq!(read_command("git status", &ctx, &win_ctx(), &look).level, Level::Ok);
    let r = read_command("cargo run", &ctx, &win_ctx(), &look);
    assert_eq!(r.findings[0], Finding::CommandNotFound { word: "cargo".into() });
}

#[test]
fn script_steps_must_be_in_the_project() {
    let look = Fake::mac().dir("/Users/ada/code/app/scripts").file("/Users/ada/code/app/scripts/ppvp.sh", false);
    assert_eq!(read_script("scripts/ppvp.sh", &project(), &mac_ctx(), &look).level, Level::Ok);
    let r = read_script("scripts/gone.sh", &project(), &mac_ctx(), &look);
    assert_eq!(r.level, Level::Warn);
    assert_eq!(r.findings[0], Finding::ProjectFileMissing { path: "scripts/gone.sh".into() });
    let r = read_script("scripts", &project(), &mac_ctx(), &look);
    assert_eq!(r.findings[0], Finding::IsFolder { path: "scripts".into() });
}

// ── Folders ────────────────────────────────────────────────────────────

fn folder(v: &str, look: &Fake) -> Reading {
    read_folder(v, &CheckContext { project: None, keeps_tilde: true, interactive: false }, &mac_ctx(), look)
}

#[test]
fn folders_that_work_are_saved_as_typed_with_their_tilde_kept() {
    let look = Fake::mac().dir("/Users/ada/Team");
    let r = folder("~/Team", &look);
    assert_eq!(r.level, Level::Ok);
    assert_eq!(r.save_as.as_deref(), Some("~/Team"));
    assert_eq!(r.resolved.as_deref(), Some("/Users/ada/Team"));
    // Not there yet, under a folder that is: created with the first project.
    let r = folder("~/Team/new", &look);
    assert_eq!(r.level, Level::Hint);
    assert_eq!(r.findings[0], Finding::WillBeCreated { path: "/Users/ada/Team/new".into() });
}

#[test]
fn folders_that_cannot_hold_projects_are_refused() {
    let look = Fake::mac().locked("/Users/ada/locked").dir("/Users/ada/locked");
    let cases = [
        ("/Users/ada/notes.txt", Finding::NotAFolder { path: "/Users/ada/notes.txt".into() }),
        ("/Users/ada/notes.txt/inside", Finding::NotAFolder { path: "/Users/ada/notes.txt".into() }),
        ("/Users/ada/locked", Finding::NotWritable { path: "/Users/ada/locked".into() }),
        ("/Users/ada/locked/new", Finding::NotWritable { path: "/Users/ada/locked".into() }),
    ];
    for (v, want) in cases {
        let r = folder(v, &look);
        assert_eq!(r.level, Level::Blocked, "{v}: {r:?}");
        assert_eq!(r.findings[0], want, "{v}");
        assert_eq!(r.save_as, None);
    }
    assert_eq!(folder("/Users/ada/notes.txt", &look).fix.as_deref(), Some("/Users/ada"));
}

#[test]
fn a_dangling_link_says_its_target_is_away_never_that_it_will_be_created() {
    // The owner's `~/ply-build`, a link to an external disk.
    let look = Fake::mac().dangling("/Users/ada/ply-build", "/Volumes/Fast/ply-build");
    let r = folder("~/ply-build/team", &look);
    assert_eq!(r.level, Level::Confirm);
    assert_eq!(r.findings[0], Finding::DiskAbsent { disk: "/Volumes/Fast".into() });
    let look = Fake::mac().dangling("/Users/ada/ply-build", "/Users/ada/gone");
    let r = folder("~/ply-build", &look);
    assert_eq!(r.findings[0], Finding::LinkAway { link: "/Users/ada/ply-build".into(), target: "/Users/ada/gone".into() });
}

#[test]
fn a_folder_on_a_disk_that_is_away_is_asked() {
    let r = folder("/Volumes/Backup/team", &Fake::mac());
    assert_eq!(r.level, Level::Confirm);
    assert_eq!(r.findings[0], Finding::DiskAbsent { disk: "/Volumes/Backup".into() });
    assert_eq!(r.save_as.as_deref(), Some("/Volumes/Backup/team"));
    let ctx = CheckContext { project: None, keeps_tilde: true, interactive: false };
    let r = read_folder(r"D:\Team", &ctx, &win_ctx(), &Fake::win());
    assert_eq!(r.findings[0], Finding::DiskAbsent { disk: r"D:\".into() });
    let r = read_folder(r"\\nas\share\team", &ctx, &win_ctx(), &Fake::win());
    assert_eq!(r.findings[0], Finding::DiskAbsent { disk: r"\\nas\share".into() });
    let r = read_folder(r"C:\Users\Ada\Team", &ctx, &win_ctx(), &Fake::win());
    assert_eq!(r.findings[0], Finding::WillBeCreated { path: r"C:\Users\Ada\Team".into() });
}

#[test]
fn readings_serialize_as_the_frontend_reads_them() {
    let v = serde_json::to_value(shell("zsh -i")).unwrap();
    assert_eq!(v["kind"], "tileShell");
    assert_eq!(v["level"], "blocked");
    assert_eq!(v["findings"][0]["kind"], "hasArguments");
    assert_eq!(v["findings"][0]["program"], "zsh");
    assert_eq!(v["saveAs"], serde_json::Value::Null);
    let c: CheckContext = serde_json::from_value(serde_json::json!({"project": "/x", "keepsTilde": true})).unwrap();
    assert!(c.keeps_tilde);
}

#[test]
fn walk_audit_values_that_may_work_today_are_never_refused_or_broken() {
    // The team test profile keeps its clones inside Plyloft's data, and it
    // works: not judged at all.
    let path = "/Users/ada/Library/Application Support/com.mbadv.ply.test/team-clones";
    let look = Fake::mac().dir("/Users/ada/Library/Application Support/com.mbadv.ply.test").dir(path);
    let r = folder(path, &look);
    assert_eq!(r.level, Level::Ok, "{r:?}");
    assert!(r.findings.is_empty());
    assert!(!r.broken);
    // A relative folder or `~name`: asked, saved as typed, never broken.
    for v in ["code/team", "~bob/team"] {
        let r = folder(v, &Fake::mac());
        assert_eq!(r.level, Level::Confirm, "{v}");
        assert_eq!(r.save_as.as_deref(), Some(v));
        assert!(!r.broken, "{v}");
    }
    // A relative tile shell runs from the tile's own folder: asked.
    let r = shell("bin/zsh");
    assert_eq!(r.level, Level::Confirm);
    assert_eq!(r.findings[0], Finding::Relative);
    assert_eq!(r.save_as.as_deref(), Some("bin/zsh"));
    assert!(!r.broken);
}

#[test]
fn options_come_first_and_the_program_is_judged_on_its_own() {
    // Windows walk: `pwsh -NoLogo` on a PC without pwsh.
    let r = wshell("pwsh -NoLogo");
    assert_eq!(r.level, Level::Blocked);
    assert_eq!(
        r.findings,
        vec![Finding::HasArguments { program: "pwsh".into() }, Finding::ProgramNotFound { name: "pwsh".into() }]
    );
    assert_eq!(r.fix, None, "nothing that can't work is offered");
    // With pwsh there, the program alone is the correction.
    let look = Fake::win().dir(r"C:\Tools").file(r"C:\Tools\pwsh.exe", true);
    let ctx = Ctx { path: format!("{};C:\\Tools", win_ctx().path), ..win_ctx() };
    let r = read_tile_shell("pwsh -NoLogo", &ctx, &look);
    assert_eq!(r.fix.as_deref(), Some("pwsh"));
    // A path with spaces is still read whole, not as options.
    let r = wshell(r"C:\Program Files\Nu\nu.exe");
    assert_eq!(r.findings[0], Finding::Missing { path: r"C:\Program Files\Nu\nu.exe".into() });
}
