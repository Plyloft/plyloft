//! The tools the app-tester agent sees, and how each one uses the bridge
//! (Plyloft Test) and the helper (trusted input, screenshots, native AX).

use crate::readers;
use crate::sock::LineClient;
use crate::vm::{VmChannel, VmConfig};
use crate::walk::{now_stamp, Walk};
use base64::Engine;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// Where Plyloft Test runs: on this Mac, or in the Windows VM (Parallels).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Mac,
    Windows,
}

impl Target {
    pub fn parse(text: &str) -> Result<Self, String> {
        match text {
            "mac" => Ok(Target::Mac),
            "windows" => Ok(Target::Windows),
            other => Err(format!("target must be mac or windows, not {other:?}")),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Target::Mac => "mac",
            Target::Windows => "windows",
        }
    }
}

/// Who a tool call acts as, on the Mac: the owner in "Plyloft Test" or the
/// second person of a team walk in "Plyloft Test Member" (its own bundle,
/// profile, run dir, `gh` and git identity). Both are driven by this one
/// server and one helper; a call without `instance` is the owner's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Instance {
    Owner,
    Member,
}

impl Instance {
    pub fn parse(text: &str) -> Result<Self, String> {
        match text {
            "owner" => Ok(Instance::Owner),
            "member" => Ok(Instance::Member),
            other => Err(format!("instance must be owner or member, not {other:?}")),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Instance::Owner => "owner",
            Instance::Member => "member",
        }
    }

    fn app_name(self) -> &'static str {
        match self {
            Instance::Owner => "Plyloft Test",
            Instance::Member => "Plyloft Test Member",
        }
    }

    fn identifier(self) -> &'static str {
        match self {
            Instance::Owner => "com.mbadv.ply.test",
            Instance::Member => MEMBER_IDENTIFIER,
        }
    }

    /// The GitHub identity this instance's dev Team plan names.
    fn identity(self) -> (&'static str, &'static str) {
        match self {
            Instance::Owner => ("test-owner", "1000001"),
            Instance::Member => (readers::MEMBER_LOGIN, "1000002"),
        }
    }
}

pub const MEMBER_IDENTIFIER: &str = "com.mbadv.ply.test2";
/// Beside the owner's bundle (`scripts/app-tester/make-member-app.sh`).
pub const MEMBER_APP: &str = "Plyloft Test Member.app";

/// Which tools act on one instance's app and so take `instance`.
pub fn targets_instance(tool: &str) -> bool {
    tool.starts_with("ui_") || tool.starts_with("native_") || tool.starts_with("app_") || tool == "builder_inject_block"
}

/// Read-only tools on an app: they don't count as that instance acting.
pub fn is_read_only(tool: &str) -> bool {
    matches!(
        tool,
        "app_status" | "app_state" | "ui_snapshot" | "ui_wait_for" | "ui_terminal" | "ui_screenshot" | "native_snapshot"
    )
}

/// Each instance's team checkouts: inside its own profile, so the two never
/// resolve to the same `~/code/<repo>` or `~/Projects/<repo>` (`team.rs`,
/// `effective_clone_root`). Set through the app's own `team.cloneRoot`.
pub fn own_clone_root(profile: &Path) -> PathBuf {
    profile.join("team-clones")
}

fn read_profile_json(path: &Path) -> Result<Option<Value>, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Whether the profile already has its own clone root. Another one is refused:
/// the two instances could share a checkout through it.
pub fn clone_root_is_own(profile: &Path) -> Result<bool, String> {
    let settings = read_profile_json(&profile.join("settings.json"))?;
    let set = settings.as_ref().and_then(|s| s["team"]["cloneRoot"].as_str()).map(str::trim).filter(|r| !r.is_empty());
    match set {
        None => Ok(false),
        Some(root) if Path::new(root) == own_clone_root(profile) => Ok(true),
        Some(root) => Err(format!(
            "{} sets team.cloneRoot to {root}, not {}: reset this test profile (reset-profile.sh) before a team walk",
            profile.display(),
            own_clone_root(profile).display()
        )),
    }
}

/// Writes the profile's own clone root, keeping everything else in its
/// settings: temp + rename, and only while the app is closed.
pub fn write_own_clone_root(profile: &Path) -> Result<(), String> {
    std::fs::create_dir_all(profile).map_err(|e| format!("{}: {e}", profile.display()))?;
    let path = profile.join("settings.json");
    let mut settings = read_profile_json(&path)?.unwrap_or_else(|| json!({"schemaVersion": 1}));
    if !settings["team"].is_object() {
        settings["team"] = json!({});
    }
    settings["team"]["cloneRoot"] = json!(own_clone_root(profile));
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display()))
}

/// What every launch does with the app closed: no clone root set takes the
/// profile's own, so a walk that joins a team never clones or reuses under the
/// app's default (`~/code`: a walk on a fresh profile picked up a folder of the
/// owner's there). A foreign value is refused in a team walk; outside one it may
/// be what the walk is about, and it stays, as does a file this can't read.
pub fn ensure_own_clone_root(profile: &Path, team: bool) -> Result<(), String> {
    match clone_root_is_own(profile) {
        Ok(true) => Ok(()),
        Ok(false) => write_own_clone_root(profile),
        Err(why) if team => Err(why),
        Err(_) => Ok(()),
    }
}

/// A profile that names another GitHub login would have the app fetch that
/// login's token from the shared keychain (`github_account.rs`), whatever
/// the instance's `gh` config says: refused.
pub fn profile_names_only(profile: &Path, login: &str) -> Result<(), String> {
    let other = |found: Option<&str>| found.map(str::trim).filter(|f| !f.is_empty() && !f.eq_ignore_ascii_case(login)).map(str::to_string);
    let mut named = Vec::new();
    if let Some(settings) = read_profile_json(&profile.join("settings.json"))? {
        if let Some(found) = other(settings["team"]["account"].as_str()) {
            named.push(format!("team.account {found}"));
        }
    }
    if let Some(workspaces) = read_profile_json(&profile.join("workspaces.json"))? {
        for ws in workspaces["workspaces"].as_array().into_iter().flatten() {
            if let Some(found) = other(ws["githubAccount"].as_str()) {
                named.push(format!("workspace {} githubAccount {found}", ws["name"].as_str().unwrap_or("?")));
            }
        }
    }
    if named.is_empty() {
        Ok(())
    } else {
        Err(format!("{} names {}, not {login}: refused (reset-profile.sh)", profile.display(), named.join(", ")))
    }
}

/// The member's runtime root, never the owner's: inside `$PLY_TEST_ROOT` when
/// that is set, else in its own profile, as the app itself would choose.
pub fn member_root_for(explicit_root: Option<&Path>, home: &Path) -> PathBuf {
    match explicit_root {
        Some(root) => root.join("member"),
        None => home.join("Library/Application Support").join(MEMBER_IDENTIFIER).join("app-tester"),
    }
}

/// Whether the app behind a socket is the one this instance expects, so a
/// mixed-up run dir is refused rather than driven as the wrong person.
pub fn instance_identity_matches(instance: Instance, info: &Value) -> Result<(), String> {
    match info.get("identifier").and_then(Value::as_str) {
        Some(found) if found != instance.identifier() => Err(format!(
            "the {} bridge is served by {found}, not {}: quit both instances and start them with app_launch",
            instance.name(),
            instance.identifier()
        )),
        _ => Ok(()),
    }
}

pub struct Config {
    /// `$PLY_TEST_ROOT`: `run/` holds the sockets, tokens and `stop`.
    pub root: PathBuf,
    /// The member's own runtime root: only its bridge socket and sandboxes.
    /// The helper and the emergency `stop` stay in the owner's `root`.
    pub member_root: PathBuf,
    /// `PLY_TEST_MEMBER_ENV`: `gh/` (GH_CONFIG_DIR) and `gitconfig`
    /// (GIT_CONFIG_GLOBAL) of the member's account.
    pub member_env: PathBuf,
    /// `PLY_TEST_OWNER_ENV`: the same for the owner, used only in team walks
    /// and only when it exists (`make-instance-env.sh`).
    pub owner_env: PathBuf,
    /// Where the profiles live (`<here>/<bundle id>`).
    pub support: PathBuf,
    /// The `gh` to run (`gh`; tests give a fake).
    pub gh: String,
    pub walks: PathBuf,
    pub app: PathBuf,
    pub helper: PathBuf,
    /// The target when a walk does not name one (`PLY_TEST_TARGET`).
    pub target: Target,
    pub vm: VmConfig,
    /// The dev key to mint with; `None` is the script's own default, on this
    /// Mac (`~/ply-build/launch-dev-keys`). Tests give a throwaway one.
    pub dev_key: Option<PathBuf>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("HOME is not set")?;
        let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
        Ok(Self {
            // In the test profile, on the internal disk: Plyloft Test and the
            // helper never wait on a macOS prompt for an external volume.
            root: var("PLY_TEST_ROOT").unwrap_or_else(|| {
                home.join("Library/Application Support/com.mbadv.ply.test/app-tester")
            }),
            member_root: member_root_for(var("PLY_TEST_ROOT").as_deref(), &home),
            member_env: var("PLY_TEST_MEMBER_ENV").unwrap_or_else(|| home.join("Library/Application Support/ply-test-member")),
            owner_env: var("PLY_TEST_OWNER_ENV").unwrap_or_else(|| home.join("Library/Application Support/ply-test-owner")),
            support: home.join("Library/Application Support"),
            gh: "gh".to_string(),
            walks: var("PLY_APP_WALKS_DIR").unwrap_or_else(|| home.join("ply-build/app-walks")),
            app: var("PLY_TEST_APP")
                .unwrap_or_else(|| home.join("ply-build/sl0/debug/bundle/macos/Plyloft Test.app")),
            helper: var("PLY_TEST_HELPER").unwrap_or_else(|| home.join("ply-build/tools/PlyTestHelper.app")),
            target: match std::env::var("PLY_TEST_TARGET").ok().filter(|v| !v.is_empty()) {
                Some(t) => Target::parse(&t)?,
                None => Target::Mac,
            },
            vm: VmConfig::from_env(),
            dev_key: None,
        })
    }

    pub fn run_dir(&self) -> PathBuf {
        self.root.join("run")
    }

    /// Throwaway repos for walks: under the test profile, where Plyloft Test
    /// may open them without a volume prompt; wiped with the profile.
    pub fn sandboxes(&self) -> PathBuf {
        self.root.join("sandboxes")
    }

    pub fn profile(&self, instance: Instance) -> PathBuf {
        self.support.join(instance.identifier())
    }

    /// The `gh/` and `gitconfig` of an env dir, when both are there.
    fn identity_of(env: &Path) -> Option<(PathBuf, PathBuf)> {
        let (gh, git) = (env.join("gh"), env.join("gitconfig"));
        (gh.is_dir() && git.is_file()).then_some((gh, git))
    }

    /// The owner's pinned `gh` config, when it exists.
    pub fn owner_gh(&self) -> Option<PathBuf> {
        Self::identity_of(&self.owner_env).map(|(gh, _)| gh)
    }

    /// What pins the owner in a team walk: nothing if its env dir isn't there.
    pub fn owner_team_env(&self) -> Vec<(String, String)> {
        Self::identity_of(&self.owner_env)
            .map(|(gh, git)| {
                vec![
                    ("GH_CONFIG_DIR".to_string(), gh.display().to_string()),
                    ("GIT_CONFIG_GLOBAL".to_string(), git.display().to_string()),
                ]
            })
            .unwrap_or_default()
    }

    /// The member's throwaway repos, in its own profile.
    pub fn member_sandboxes(&self) -> PathBuf {
        self.member_root.join("sandboxes")
    }

    /// The member's copy of the bundle under test, ready to start: a missing
    /// one, or one older than the build it copies (a walk would run two
    /// different builds), is refused.
    pub fn member_app(&self) -> Result<PathBuf, String> {
        let member = self.app.with_file_name(MEMBER_APP);
        let remake = format!("run scripts/app-tester/make-member-app.sh \"{}\"", self.app.display());
        if !member.exists() {
            return Err(format!("no Plyloft Test Member at {}: {remake}", member.display()));
        }
        let built = |app: &Path| std::fs::metadata(app.join("Contents/MacOS/atelier")).and_then(|m| m.modified()).ok();
        if let (Some(owner), Some(copy)) = (built(&self.app), built(&member)) {
            if copy < owner {
                return Err(format!("{} is older than the build it copies: {remake}", member.display()));
            }
        }
        Ok(member)
    }

    /// What only the member is started with.
    pub fn member_launch_env(&self) -> Result<Vec<(String, String)>, String> {
        let (gh, git) = Self::identity_of(&self.member_env).ok_or_else(|| {
            format!(
                "the member's environment is missing: {} needs gh/ (the test account's GH_CONFIG_DIR) and gitconfig (scripts/app-tester/make-instance-env.sh)",
                self.member_env.display()
            )
        })?;
        Ok(vec![
            ("PLY_TEST_INSTANCE".to_string(), "member".to_string()),
            ("PLY_TEST_ROOT".to_string(), self.member_root.display().to_string()),
            ("GH_CONFIG_DIR".to_string(), gh.display().to_string()),
            ("GIT_CONFIG_GLOBAL".to_string(), git.display().to_string()),
        ])
    }
}

const BRIDGE_TIMEOUT: Duration = Duration::from_secs(30);
const AUDIT_DURING_WAIT: Duration = Duration::from_secs(5);
const HELPER_TIMEOUT: Duration = Duration::from_secs(30);
const LAUNCH_WAIT: Duration = Duration::from_secs(90);
const QUIT_WAIT: Duration = Duration::from_secs(20);
const PREVIEW_MAX_PX: u32 = 1400;
/// Windows: how long after the app exits its children may take to go.
const ORPHAN_WAIT_WINDOWS: Duration = Duration::from_secs(10);
/// Windows: WebView2's runtime shuts its processes down asynchronously and
/// outside Plyloft's control, so `msedgewebview2.exe` children get a longer
/// grace (total, from the app's exit) before they count as orphans.
const WEBVIEW_GRACE_WINDOWS: Duration = Duration::from_secs(30);

pub struct Server {
    pub config: Config,
    bridge: LineClient,
    member_bridge: LineClient,
    helper: LineClient,
    /// How often `ui_wait_for` looks at the process trees while it waits.
    pub audit_every: Duration,
    /// Who the tool call in progress acts as (owner unless it says otherwise).
    instance: Instance,
    target: Target,
    vm: VmChannel,
    walk: Option<Walk>,
    /// Set while a walk runs: keeps the screensaver away (see `keep_awake`).
    awake: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

/// During a walk the agent reads and thinks for minutes without any input
/// event, so macOS starts the screensaver: the test window can no longer be
/// brought forward and captures come out blank. Declare user activity every
/// minute (`caffeinate -u`) until the walk ends.
fn keep_awake(running: std::sync::Arc<std::sync::atomic::AtomicBool>) {
    std::thread::spawn(move || {
        while running.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = Command::new("/usr/bin/caffeinate").args(["-u", "-t", "2"]).status();
            for _ in 0..60 {
                if !running.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    });
}

type Outcome = Result<Value, String>;

/// Who a dev plan names: `(role, login, sub)`. On the Mac each instance is its
/// own person. The VM has one test profile, which plays either, so a Windows
/// plan says which: `role` always; `login` defaults to that role's test account,
/// and a login that isn't one of the two needs its `sub`.
pub fn plan_identity(target: Target, instance: Instance, args: &Value) -> Result<(&'static str, String, String), String> {
    let (role, login, sub) = (str_arg(args, "role"), str_arg(args, "login"), str_arg(args, "sub"));
    if target == Target::Mac {
        if role.or(login).or(sub).is_some() {
            return Err("role, login and sub are for target windows: on the Mac the instance says who it is".into());
        }
        let (login, sub) = instance.identity();
        return Ok((instance.name(), login.to_string(), sub.to_string()));
    }
    let role = role.ok_or("target windows needs role (owner or member): the VM's one test profile plays either")?;
    let role = Instance::parse(role).map_err(|_| format!("role must be owner or member, not {role:?}"))?;
    let login = login.unwrap_or(role.identity().0);
    if login.is_empty() || !login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!("{login:?} is not a GitHub login"));
    }
    let known = [Instance::Owner, Instance::Member].map(Instance::identity).into_iter().find(|(l, _)| l.eq_ignore_ascii_case(login)).map(|(_, s)| s);
    let sub = match (sub, known) {
        (Some(sub), _) if !sub.is_empty() && sub.chars().all(|c| c.is_ascii_digit()) => sub,
        (Some(sub), _) => return Err(format!("sub must be a GitHub account's number, not {sub:?}")),
        (None, Some(sub)) => sub,
        (None, None) => return Err(format!("{login} is not one of the two test accounts: say its sub too")),
    };
    Ok((role.name(), login.to_string(), sub.to_string()))
}

/// Launch A2: the Plyloft account variables Plyloft Test may be started
/// with. Walks skip the Sign-in screen (`PLYLOFT_DEV_SKIP_SIGNIN=1`, honoured
/// only by debug builds) unless the step list is about sign-in (`sign_in`);
/// the staging sign-in's own variables pass through from this server's
/// environment when they are set.
pub const SIGNIN_FORWARDED: [&str; 3] = ["PLYLOFT_API_URL", "PLYLOFT_GITHUB_CLIENT_ID", "PLYLOFT_ENTITLEMENT_PUBKEY"];
pub const SIGNIN_SKIP: &str = "PLYLOFT_DEV_SKIP_SIGNIN";

pub fn launch_env(sign_in: bool, env: impl Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if !sign_in {
        out.push((SIGNIN_SKIP.to_string(), "1".to_string()));
    }
    for name in SIGNIN_FORWARDED {
        if let Some(value) = env(name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
            out.push((name.to_string(), value));
        }
    }
    out
}

/// Launch A2: a running Plyloft Test started the other way (with or without
/// the Sign-in screen) is refused, not reused; a build too old to say
/// (`signInSkipped` absent) is reused as before.
pub fn running_sign_in_matches(info: &Value, sign_in: bool) -> Result<(), String> {
    match info.get("signInSkipped").and_then(Value::as_bool) {
        Some(skipped) if skipped == sign_in => Err(format!(
            "Plyloft Test is already running {} the Plyloft Sign-in screen; app_quit, then app_launch with sign_in: {sign_in}",
            if skipped { "past" } else { "with" }
        )),
        _ => Ok(()),
    }
}

fn str_arg<'a>(args: &'a Value, name: &str) -> Option<&'a str> {
    args.get(name).and_then(Value::as_str)
}

fn pick(args: &Value, keys: &[&str]) -> Value {
    let mut out = serde_json::Map::new();
    for key in keys {
        if let Some(v) = args.get(*key) {
            out.insert((*key).to_string(), v.clone());
        }
    }
    Value::Object(out)
}

const QUERY_KEYS: &[&str] = &["ref", "name", "role", "index"];

impl Server {
    pub fn new(config: Config) -> Self {
        let run = config.run_dir();
        Self {
            bridge: LineClient::new(&run, "bridge"),
            member_bridge: LineClient::new(&config.member_root.join("run"), "bridge"),
            audit_every: AUDIT_DURING_WAIT,
            instance: Instance::Owner,
            helper: LineClient::new(&run, "helper"),
            target: config.target,
            vm: VmChannel::new(config.vm.clone()),
            config,
            walk: None,
            awake: None,
        }
    }

    fn stop_file(&self) -> PathBuf {
        self.config.run_dir().join("stop")
    }

    fn check_not_stopped(&mut self) -> Result<(), String> {
        if self.stop_file().exists() {
            return Err("stopped by the owner (emergency chord ctrl+option+cmd+.): end the walk \
                        with walk_finish and report; do not continue"
                .into());
        }
        if self.target == Target::Windows {
            let status = self.vm.call("status", json!({}), Duration::from_secs(20))?;
            if status["stopped"].as_bool() == Some(true) {
                return Err(format!(
                    "stopped by the owner (emergency chord {} in the VM): end the walk with \
                     walk_finish and report; do not continue",
                    status["emergencyChord"].as_str().unwrap_or("ctrl+alt+shift+.")
                ));
            }
        }
        Ok(())
    }

    /// Switches target outside a walk; inside one only the walk's own.
    fn set_target(&mut self, args: &Value) -> Result<(), String> {
        let Some(name) = str_arg(args, "target") else { return Ok(()) };
        let target = Target::parse(name)?;
        if target != self.target {
            if let Some(walk) = &self.walk {
                return Err(format!("the walk in progress runs on {}; finish it first", walk.target));
            }
            self.bridge.disconnect();
            self.member_bridge.disconnect();
            self.target = target;
        }
        Ok(())
    }

    fn team_walk(&self) -> bool {
        self.walk.as_ref().is_some_and(|w| w.team)
    }

    /// The member is up, or took part in this walk: a call that names nobody
    /// could act as the wrong person without anyone noticing.
    fn member_in_play(&mut self) -> bool {
        if self.target != Target::Mac {
            return false;
        }
        if self.walk.as_ref().is_some_and(|w| w.member_used) {
            return true;
        }
        self.member_bridge.socket_exists()
            && self.as_instance(Instance::Member, |s| s.bridge_call("app.info", json!({})).is_ok())
    }

    /// The instance a call names. The member runs only on this Mac.
    fn select_instance(&mut self, tool: &str, args: &Value) -> Result<Instance, String> {
        let Some(value) = args.get("instance") else {
            if (tool.starts_with("ui_") || tool.starts_with("native_")) && self.member_in_play() {
                return Err(format!(
                    "{tool} needs instance (owner or member): the member is running or has acted in this walk, so a call must say who acts"
                ));
            }
            return Ok(Instance::Owner);
        };
        let name = value.as_str().ok_or("instance must be owner or member")?;
        let instance = Instance::parse(name)?;
        let target = str_arg(args, "target").and_then(|t| Target::parse(t).ok()).unwrap_or(self.target);
        if instance == Instance::Member && target == Target::Windows {
            return Err("instance member runs only on the Mac; the Windows target has the owner's instance".into());
        }
        Ok(instance)
    }

    /// The bridge of the instance this call acts as.
    fn client(&mut self) -> &mut LineClient {
        match self.instance {
            Instance::Owner => &mut self.bridge,
            Instance::Member => &mut self.member_bridge,
        }
    }

    /// Runs `work` as another instance, for the checks that cover both.
    fn as_instance<T>(&mut self, instance: Instance, work: impl FnOnce(&mut Self) -> T) -> T {
        let current = std::mem::replace(&mut self.instance, instance);
        let out = work(self);
        self.instance = current;
        out
    }

    // ── connections ──────────────────────────────────────────────────────

    fn bridge_call(&mut self, method: &str, params: Value) -> Outcome {
        if self.target == Target::Windows {
            let timeout = params
                .get("timeout_ms")
                .and_then(Value::as_u64)
                .map(|ms| Duration::from_millis(ms) + BRIDGE_TIMEOUT)
                .unwrap_or(BRIDGE_TIMEOUT);
            let relay = json!({"method": method, "params": params, "timeout_ms": timeout.as_millis() as u64});
            return self.vm.call("bridge", relay, timeout + Duration::from_secs(10));
        }
        if !self.client().socket_exists() {
            return Err(match self.instance {
                Instance::Owner => "Plyloft Test is not running (app_launch starts it)".into(),
                Instance::Member => "Plyloft Test Member is not running (app_launch with instance member starts it)".into(),
            });
        }
        let timeout = params
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .map(|ms| Duration::from_millis(ms) + BRIDGE_TIMEOUT)
            .unwrap_or(BRIDGE_TIMEOUT);
        self.client().call(method, params, timeout)
    }

    fn app_pid(&mut self) -> Result<i64, String> {
        let info = self.bridge_call("app.info", json!({}))?;
        info.get("pid").and_then(Value::as_i64).ok_or("app.info without a pid".into())
    }

    fn helper_call(&mut self, method: &str, params: Value) -> Outcome {
        if self.target == Target::Windows {
            let method = match method {
                "ax.tree" => "native.tree",
                "ax.press" => "native.press",
                "permissions" => "status",
                "ax.menu" => {
                    return Err("Windows has no app menu: quit with via cmd+q (Ctrl+Shift+Q) or bridge; \
                                the tray menu is not reachable"
                        .into())
                }
                other => other,
            };
            return self.vm.call(method, params, HELPER_TIMEOUT);
        }
        if self.helper.call("ping", json!({}), Duration::from_secs(3)).is_err() {
            self.launch_helper()?;
        }
        self.helper.call(method, params, HELPER_TIMEOUT)
    }

    fn launch_helper(&mut self) -> Result<(), String> {
        self.helper.disconnect();
        if !self.config.helper.exists() {
            return Err(format!(
                "PlyTestHelper is not installed at {} (scripts/app-tester/build-helper.sh)",
                self.config.helper.display()
            ));
        }
        // Through LaunchServices, so the helper is its own responsible
        // process and its permissions (not this process's host) apply.
        let status = Command::new("/usr/bin/open")
            .arg("-n")
            .arg("-g")
            .arg(&self.config.helper)
            .args(["--args", "serve", "--root"])
            .arg(&self.config.root)
            .status()
            .map_err(|e| format!("open helper: {e}"))?;
        if !status.success() {
            return Err("open PlyTestHelper failed".into());
        }
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(8) {
            std::thread::sleep(Duration::from_millis(200));
            if self.helper.call("ping", json!({}), Duration::from_secs(2)).is_ok() {
                return Ok(());
            }
        }
        Err("PlyTestHelper did not start: its permissions may be missing (Input Monitoring is \
             required for the emergency chord), or its signature is broken \
             (rebuild with scripts/app-tester/build-helper.sh on an unlocked Mac)"
            .into())
    }

    // ── walk bookkeeping ─────────────────────────────────────────────────

    fn agent_processes(&mut self) -> Result<Vec<crate::walk::AgentProcess>, String> {
        self.bridge_call("app.state", json!({"kind": "processes"})).map(|state| agents_in(&state))
    }

    /// The instances to look at for a check that covers both: the member
    /// only on the Mac and only while its bridge exists, so a walk that never
    /// starts it looks at the owner alone, as ever.
    fn live_instances(&self) -> Vec<Instance> {
        let mut out = vec![Instance::Owner];
        if self.target == Target::Mac && self.member_bridge.socket_exists() {
            out.push(Instance::Member);
        }
        out
    }

    fn audit(&mut self) {
        if self.walk.as_ref().is_some_and(|w| !w.allow_agent_tiles) {
            let mac = self.target == Target::Mac;
            for instance in self.live_instances() {
                // A closed app is nothing to look at, not a failed look.
                if mac && !self.as_instance(instance, |s| s.client().socket_exists()) {
                    continue;
                }
                let current = self.as_instance(instance, |s| s.agent_processes());
                let Some(walk) = self.walk.as_mut() else { return };
                match current {
                    Ok(current) => walk.audit_agents(&current, instance.name()),
                    // Windows: an app not up looks the same, so it stays as it was.
                    Err(why) if mac => walk.failed_sample(instance.name(), &why),
                    Err(_) => {}
                }
            }
        }
    }

    fn shots_dir(&self) -> PathBuf {
        match &self.walk {
            Some(walk) => walk.dir.join("shots"),
            None => self.config.walks.join("_loose-shots"),
        }
    }

    // ── dispatch ─────────────────────────────────────────────────────────

    /// Runs a tool; returns MCP `content` items.
    pub fn call_tool(&mut self, name: &str, args: &Value) -> Result<Vec<Value>, String> {
        let outcome = self.run_tool(name, args);
        let instance = self.instance;
        if let Some(walk) = self.walk.as_mut() {
            let logged = outcome.as_ref().map(|items| json!(items.len())).map_err(Clone::clone);
            walk.log_action(name, args, &logged, invitation_detail(name, &outcome));
            // A status says nothing about the app being up.
            if outcome.is_ok() && targets_instance(name) && name != "app_status" {
                walk.note_instance(instance.name(), is_read_only(name));
            }
        }
        if name.starts_with("ui_") || name.starts_with("native_") {
            self.audit();
        }
        outcome
    }

    fn run_tool(&mut self, name: &str, args: &Value) -> Result<Vec<Value>, String> {
        self.instance = Instance::Owner;
        if targets_instance(name) {
            self.instance = self.select_instance(name, args)?;
        }
        let text = |value: Value| -> Vec<Value> {
            let body = match value {
                Value::String(s) => s,
                other => serde_json::to_string_pretty(&other).unwrap_or_default(),
            };
            vec![json!({"type": "text", "text": body})]
        };
        // After the emergency chord only reading, recording and a clean quit
        // through the bridge (no real input) stay allowed.
        let quit_via_bridge = name == "app_quit" && str_arg(args, "via").unwrap_or("bridge") == "bridge";
        let gated = !quit_via_bridge
            && !matches!(name, "walk_start" | "walk_step" | "walk_finish" | "app_status" | "gh_read" | "repo_read" | "permissions" | "win_read");
        if gated {
            self.check_not_stopped()?;
        }
        match name {
            "permissions" => {
                let helper = self.helper_call("permissions", json!({}));
                Ok(text(json!({"helper": helper.unwrap_or_else(|e| json!({"error": e}))})))
            }
            "walk_start" => self.walk_start(args).map(text),
            "walk_step" => {
                let walk = self.walk.as_mut().ok_or("no walk in progress (walk_start first)")?;
                walk.step(args).map(text)
            }
            "walk_finish" => self.walk_finish(args).map(text),
            "app_launch" => {
                self.set_target(args)?;
                let sign_in = args.get("sign_in").and_then(Value::as_bool).unwrap_or(false);
                if sign_in && self.instance == Instance::Member {
                    return Err("sign_in is not for the member: its session would go in the keychain; walks about signing in use the owner".into());
                }
                self.app_launch(sign_in).map(text)
            }
            "app_quit" => {
                let quit = self.app_quit(args)?;
                let instance = self.instance;
                if let Some(walk) = self.walk.as_mut() {
                    walk.record_quit(instance.name(), &quit);
                }
                Ok(text(quit))
            }
            "app_dev_team_plan" => self.app_dev_team_plan(args).map(text),
            "app_status" => {
                self.set_target(args)?;
                let mut status = self
                    .bridge_call("app.info", json!({}))
                    .unwrap_or_else(|e| json!({"running": false, "why": e}));
                status["target"] = json!(self.target.name());
                if self.instance == Instance::Member {
                    status["instance"] = json!(self.instance.name());
                }
                Ok(text(status))
            }
            "win_read" => {
                if self.target != Target::Windows {
                    return Err("win_read reads the Windows VM: start the walk with target windows".into());
                }
                self.vm.call("read", pick(args, &["query", "path", "base", "lines"]), HELPER_TIMEOUT).map(text)
            }
            "app_skills_hub_interval" => self
                .bridge_call("app.skillsHubInterval", pick(args, &["secs"]))
                .map(text),
            "app_freeze" => self
                .bridge_call("app.freeze", pick(args, &["what", "secs"]))
                .map(text),
            "builder_inject_block" => self
                .bridge_call("builder.injectBlock", pick(args, &["card", "lane", "kind", "resetsAt"]))
                .map(text),
            "app_state" => self
                .bridge_call("app.state", pick(args, &["kind", "workspace", "lines"]))
                .map(redact_process_lines)
                .map(text),
            "ui_snapshot" => {
                let snap = self.bridge_call("ui.snapshot", pick(args, &["scope", "filter", "max_depth"]))?;
                let mut out = snap["tree"].as_str().unwrap_or("").to_string();
                if snap["truncated"].as_bool() == Some(true) {
                    out.push_str("\n… (truncated: pass a scope ref or a filter)");
                }
                if let Some(f) = snap.get("focused").filter(|f| !f.is_null()) {
                    out.push_str(&format!("\n\nfocused: {f}"));
                }
                if let Some(d) = snap["openDialogs"].as_array().filter(|d| !d.is_empty()) {
                    out.push_str(&format!("\nopen dialogs: {}", Value::Array(d.clone())));
                }
                Ok(text(Value::String(out)))
            }
            "ui_click" => self.ui_click(args).map(text),
            "ui_type" => self.ui_type(args).map(text),
            "ui_key" => self.ui_key(args).map(text),
            "ui_drag" => self.ui_drag(args).map(text),
            "ui_scroll" => {
                let locate = self.bridge_call("ui.locate", pick(args, QUERY_KEYS))?;
                let (x, y, pid) = self.screen_point(&locate)?;
                let lines = args.get("lines").and_then(Value::as_i64).unwrap_or(5);
                self.helper_call("mouse.scroll", json!({"pid": pid, "at": {"x": x, "y": y}, "lines": lines}))?;
                std::thread::sleep(Duration::from_millis(200));
                let hits = self.bridge_call("ui.hits", json!({"after": locate["mark"], "ref": locate["ref"]}))?;
                let wheels = hits["hits"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|h| h["type"] == "wheel" && h["trusted"].as_bool() == Some(true))
                    .count();
                if wheels == 0 {
                    return Err(format!("the wheel over {} [ref={}] reached nothing on the page", locate["name"], locate["ref"].as_str().unwrap_or("")));
                }
                Ok(text(json!({"scrolled": lines, "over": locate["name"], "wheelEventsSeen": wheels, "via": "trusted"})))
            }
            "ui_wait_for" => self.ui_wait_for(args).map(text),
            "ui_terminal" => self
                .bridge_call("ui.terminal", pick(args, &["ref", "name", "role", "index", "lines"]))
                .map(text),
            "ui_screenshot" => self.ui_screenshot(args),
            "native_snapshot" => {
                let pid = self.app_pid()?;
                let mut params = pick(args, &["menus", "max_depth"]);
                params["pid"] = json!(pid);
                self.helper_call("ax.tree", params).map(|r| text(r["tree"].clone()))
            }
            "native_press" => {
                let pid = self.app_pid()?;
                self.helper_call("ax.press", json!({"pid": pid, "ax": args.get("ax")})).map(text)
            }
            "native_menu" => {
                let pid = self.app_pid()?;
                self.helper_call("ax.menu", json!({"pid": pid, "path": args.get("path")})).map(text)
            }
            "gh_read" => {
                let owner = self.config.owner_gh();
                readers::gh_read(&self.config.gh, owner.as_deref(), args).map(text)
            }
            "gh_accept_invitation" => {
                if self.walk.is_none() {
                    return Err("gh_accept_invitation is only for walks: walk_start first".into());
                }
                let repo = readers::invited_repo(args)?;
                readers::accept_invitation(&self.config.gh, &self.config.member_env.join("gh"), repo).map(text)
            }
            "repo_read" => readers::repo_read(
                &[self.config.sandboxes(), self.config.walks.clone(), self.config.member_sandboxes()],
                args,
            )
            .map(text),
            other => Err(format!("unknown tool {other}")),
        }
    }

    // ── walk ─────────────────────────────────────────────────────────────

    fn walk_start(&mut self, args: &Value) -> Outcome {
        if let Some(walk) = &self.walk {
            return Err(format!("a walk is in progress in {} (walk_finish first)", walk.dir.display()));
        }
        let guide = str_arg(args, "guide").ok_or("guide is required")?;
        let allow = args
            .get("allow_agent_tiles")
            .and_then(Value::as_bool)
            .ok_or("allow_agent_tiles is required: true only if the owner said yes for this walk")?;
        let title = str_arg(args, "title").unwrap_or("");
        let team = args.get("team").and_then(Value::as_bool).unwrap_or(false);
        self.set_target(args)?;
        if team && self.target == Target::Windows {
            return Err("a team walk runs only on the Mac".into());
        }
        let _ = std::fs::remove_file(self.stop_file());
        let vm = if self.target == Target::Windows {
            match self.vm.call("stop.clear", json!({}), Duration::from_secs(30)) {
                Ok(_) => json!({"vm": self.config.vm.name, "reachable": true}),
                Err(e) => return Err(format!("the Windows VM is not reachable: {e}")),
            }
        } else {
            Value::Null
        };
        let mut walk = Walk::start(&self.config.walks, &now_stamp(), guide, title, allow)?;
        walk.target = self.target.name().into();
        walk.team = team;
        walk.baseline_agents = self.agent_processes().unwrap_or_default().into_iter().map(|p| (p.pid, p.command)).collect();
        if self.live_instances().contains(&Instance::Member) {
            let member = self.as_instance(Instance::Member, |s| s.agent_processes());
            walk.baseline_agents.extend(member.unwrap_or_default().into_iter().map(|p| (p.pid, p.command)));
        }
        let dir = walk.dir.clone();
        let member_running = self.live_instances().contains(&Instance::Member);
        let sandbox = self.config.sandboxes().join(dir.file_name().unwrap_or_default());
        std::fs::create_dir_all(&sandbox).map_err(|e| format!("{}: {e}", sandbox.display()))?;
        self.walk = Some(walk);
        let running = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        keep_awake(running.clone());
        self.awake = Some(running);
        let mut started = json!({
            "dir": dir,
            "sandbox": sandbox,
            "sandboxes": self.config.sandboxes(),
            "shots": dir.join("shots"),
            "allowAgentTiles": allow,
            "target": self.target.name(),
            "vm": vm,
            "appRunning": if self.target == Target::Windows {
                self.bridge_call("app.info", json!({})).is_ok()
            } else {
                self.bridge.socket_exists()
            },
        });
        if team {
            started["team"] = json!(true);
            started["memberRunning"] = json!(member_running);
        }
        Ok(started)
    }

    fn walk_finish(&mut self, args: &Value) -> Outcome {
        self.audit();
        if self.walk.as_ref().is_some_and(|w| w.member_used) {
            let mut running = Vec::new();
            for instance in [Instance::Owner, Instance::Member] {
                if self.as_instance(instance, |s| s.bridge_call("app.info", json!({})).is_ok()) {
                    running.push(instance.name().to_string());
                }
            }
            if let Some(walk) = self.walk.as_mut() {
                walk.still_running = running;
            }
        }
        let walk = self.walk.take().ok_or("no walk in progress")?;
        if let Some(running) = self.awake.take() {
            running.store(false, std::sync::atomic::Ordering::Relaxed);
        }
        walk.finish(str_arg(args, "summary").unwrap_or(""))
    }

    // ── app lifecycle ────────────────────────────────────────────────────

    /// A team walk's instance answers as its own person: `gh` in its env, and
    /// a profile that names no other login. Checked before the app is reused
    /// or started; the keychain itself stays shared (known limit, DESIGN.md).
    fn check_team_identity(&self) -> Result<(), String> {
        let (login, _) = self.instance.identity();
        let config = match self.instance {
            Instance::Owner => self.config.owner_gh(),
            Instance::Member => {
                self.config.member_launch_env()?;
                Some(self.config.member_env.join("gh"))
            }
        };
        let found = readers::gh_login(&self.config.gh, config.as_deref()).map_err(|e| {
            format!("could not ask gh who the {} is: {e}", self.instance.name())
        })?;
        if !found.eq_ignore_ascii_case(login) {
            return Err(format!(
                "gh in the {}'s environment ({}) answers as {found:?}, not {login}: fix it with scripts/app-tester/make-instance-env.sh",
                self.instance.name(),
                config.map_or("gh's default config".to_string(), |c| c.display().to_string()),
            ));
        }
        profile_names_only(&self.config.profile(self.instance), login)
    }

    /// A team walk reuses a running instance only if it was started pinned.
    fn check_running_team_env(&self, info: &Value) -> Result<(), String> {
        let expected = match self.instance {
            Instance::Owner => self.config.owner_gh(),
            Instance::Member => Some(self.config.member_env.join("gh")),
        };
        let running = info["ghConfigDir"].as_str().map(PathBuf::from);
        if running != expected {
            return Err(format!(
                "the running {} was not started with this team walk's gh config ({}): app_quit, then app_launch",
                self.instance.app_name(),
                expected.map_or("the default".to_string(), |c| c.display().to_string()),
            ));
        }
        if !clone_root_is_own(&self.config.profile(self.instance))? {
            return Err(format!(
                "the running {} has no clone root of its own: app_quit, then app_launch",
                self.instance.app_name()
            ));
        }
        Ok(())
    }

    /// A team walk without the owner's env dir: refused, because the report
    /// would say "owner" whoever gh's active account happened to be.
    fn owner_unpinned(&self) -> bool {
        self.team_walk() && self.instance == Instance::Owner && self.config.owner_gh().is_none()
    }

    fn app_launch(&mut self, sign_in: bool) -> Outcome {
        let team = self.team_walk();
        if self.instance == Instance::Member {
            if !team {
                return Err("the member starts only in a team walk: walk_start with team: true first".into());
            }
            // Before reusing a running copy too: it may be the stale one.
            self.config.member_app()?;
        }
        if self.owner_unpinned() {
            return Err("the owner's env dir is missing, so gh auth switch could change who the owner is: run scripts/app-tester/make-instance-env.sh".into());
        }
        if team {
            self.check_team_identity()?;
        }
        if let Ok(info) = self.bridge_call("app.info", json!({})) {
            instance_identity_matches(self.instance, &info)?;
            running_sign_in_matches(&info, sign_in)?;
            if team {
                self.check_running_team_env(&info)?;
            }
            let mut out = json!({"alreadyRunning": true, "target": self.target.name(), "info": info});
            if self.instance == Instance::Member {
                out["instance"] = json!(self.instance.name());
                out["sandboxes"] = json!(self.config.member_sandboxes());
            }
            return Ok(out);
        }
        if self.target == Target::Windows {
            let exe = self.config.vm.app.clone();
            let root = self.config.vm.root.clone();
            let env: serde_json::Map<String, Value> = launch_env(sign_in, |n| std::env::var(n).ok())
                .into_iter()
                .map(|(k, v)| (k, Value::String(v)))
                .collect();
            let started_vm = self.vm.call("app.launch", json!({"exe": exe, "root": root, "env": env}), HELPER_TIMEOUT)?;
            return self.wait_for_page(json!({"target": "windows", "exe": exe, "start": started_vm}));
        }
        if !self.config.app.exists() {
            return Err(format!(
                "no Plyloft Test at {} (CARGO_TARGET_DIR=… scripts/app-tester/build-app.sh)",
                self.config.app.display()
            ));
        }
        let mut open = Command::new("/usr/bin/open");
        let mut launched = json!({"target": "mac"});
        match self.instance {
            Instance::Owner => {
                open.arg("-n").arg(&self.config.app);
                if std::env::var_os("PLY_TEST_ROOT").is_some() {
                    open.arg("--env").arg(format!("PLY_TEST_ROOT={}", self.config.root.display()));
                }
                if team {
                    for (name, value) in self.config.owner_team_env() {
                        open.arg("--env").arg(format!("{name}={value}"));
                    }
                }
            }
            Instance::Member => {
                let app = self.config.member_app()?;
                let env = self.config.member_launch_env()?;
                let sandboxes = self.config.member_sandboxes();
                std::fs::create_dir_all(&sandboxes).map_err(|e| format!("{}: {e}", sandboxes.display()))?;
                open.arg("-n").arg(app);
                for (name, value) in env {
                    open.arg("--env").arg(format!("{name}={value}"));
                }
                launched["instance"] = json!(self.instance.name());
                launched["sandboxes"] = json!(sandboxes);
            }
        }
        // The app is closed here, so the file is ours to write.
        ensure_own_clone_root(&self.config.profile(self.instance), team)?;
        self.client().disconnect();
        for (name, value) in launch_env(sign_in, |n| std::env::var(n).ok()) {
            open.arg("--env").arg(format!("{name}={value}"));
        }
        let status = open.status().map_err(|e| format!("open: {e}"))?;
        if !status.success() {
            return Err(format!("open {} failed", self.instance.app_name()));
        }
        self.wait_for_page(launched)
    }

    /// A dev-only Team plan on the team's test repository: minted here, on the
    /// Mac and with the dev key, for the running app's own device, and loaded
    /// through the bridge (on Windows, the relay to the VM's test profile: only
    /// the token crosses, never the key). The token stays between those two
    /// steps: it is in no tool argument, answer or log. Nothing reaches a server.
    fn app_dev_team_plan(&mut self, args: &Value) -> Outcome {
        if self.walk.is_none() {
            return Err("app_dev_team_plan is only for walks: walk_start first".into());
        }
        let (role, login, sub) = plan_identity(self.target, self.instance, args)?;
        let info = self.bridge_call("app.info", json!({}))?;
        // Only a test profile takes a dev plan, whatever answers on the bridge.
        if info["identifier"].as_str() != Some(self.instance.identifier()) {
            return Err(format!(
                "app_dev_team_plan is for {}, and the bridge is served by {}",
                self.instance.identifier(),
                info["identifier"].as_str().unwrap_or("something that doesn't say")
            ));
        }
        // A run through the Sign-in screen would keep the placeholder session
        // in the real keychain; a run past it asks nothing.
        if info["signInSkipped"].as_bool() != Some(true) {
            return Err("app_dev_team_plan needs a run past the Sign-in screen: app_quit, then app_launch without sign_in".into());
        }
        let account = self.bridge_call("app.state", json!({"kind": "account"}))?;
        let device = account["deviceId"].as_str().ok_or("the app did not report its device id")?;
        let token = crate::dev_plan::mint_team(device, &login, &sub, role, self.config.dev_key.as_deref())?;
        let loaded = self.bridge_call("account.devLoadEntitlement", json!({"token": token})).map_err(|e| {
            format!("{e} (the app trusts the dev key only when started with PLYLOFT_ENTITLEMENT_PUBKEY: use the installed wrapper, then app_quit and app_launch)")
        })?;
        let mut out = json!({
            "login": loaded["login"],
            "plan": loaded["plan"],
            "teamRepo": loaded["teamRepo"],
            "teamRole": loaded["teamRole"],
            "exp": loaded["exp"],
        });
        match self.target {
            Target::Mac => out["instance"] = json!(self.instance.name()),
            Target::Windows => out["target"] = json!(self.target.name()),
        }
        Ok(out)
    }

    fn wait_for_page(&mut self, mut launched: Value) -> Outcome {
        let started = Instant::now();
        let mut last = String::from("no bridge yet");
        while started.elapsed() < LAUNCH_WAIT {
            std::thread::sleep(Duration::from_millis(500));
            match self.bridge_call("app.info", json!({})) {
                Ok(info) if info["jsAgentReady"].as_bool() == Some(true) => {
                    instance_identity_matches(self.instance, &info)?;
                    launched["launched"] = json!(true);
                    launched["seconds"] = json!(started.elapsed().as_secs());
                    launched["info"] = info;
                    return Ok(launched);
                }
                Ok(_) => last = "the bridge is up, the page is still loading".into(),
                Err(e) => last = e,
            }
        }
        Err(format!("{} did not come up in {}s: {last}", self.instance.app_name(), LAUNCH_WAIT.as_secs()))
    }

    /// Quits through the bridge (default), a real Cmd-Q, or the app menu, and
    /// then checks no child of the app outlived it (hard rule 4).
    fn app_quit(&mut self, args: &Value) -> Outcome {
        let via = str_arg(args, "via").unwrap_or("bridge");
        let info = self.bridge_call("app.info", json!({}))?;
        let pid = info["pid"].as_i64().ok_or("no pid")?;
        let tree = self.bridge_call("app.state", json!({"kind": "processes"}))?;
        // Windows: the installed Plyloft is never this app's child, whatever its
        // stale parent pid says. Unread, nothing is left out: never a clean quit unseen.
        let mut not_children = not_children_in(&tree, None);
        let (tree, not_ours, installed_unread) = if self.target == Target::Windows {
            match self.vm.call("read", json!({"query": "processes"}), HELPER_TIMEOUT) {
                Ok(report) => {
                    not_children = not_children_in(&tree, Some(&report));
                    let (tree, gone) = without_installed(tree, &installed_pids(&report));
                    (tree, gone, None)
                }
                Err(why) => (tree, Vec::new(), Some(why)),
            }
        } else {
            (tree, Vec::new(), None)
        };
        // The last look at this instance: what's running now counts.
        let instance = self.instance;
        if let Some(walk) = self.walk.as_mut() {
            walk.audit_agents(&agents_in(&tree), instance.name());
        }
        let children: Vec<(i64, String)> = tree["processes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| Some((p["pid"].as_i64()?, p["command"].as_str()?.to_string())))
            .collect();
        match via {
            "bridge" => {
                let _ = self.bridge_call("app.quit", json!({}));
            }
            "cmd+q" => {
                // Windows: Ctrl+Shift+Q is Plyloft's quit (Ctrl+Q stays the terminal's).
                let keys = if self.target == Target::Windows { "ctrl+shift+q" } else { "cmd+q" };
                self.helper_call("key", json!({"pid": pid, "keys": keys}))?;
            }
            "menu" => {
                // The test build's app menu may keep the product's own name.
                let mut last = String::new();
                let mut quit = false;
                let names: &[&str] = match self.instance {
                    Instance::Owner => &["Plyloft Test", "Plyloft"],
                    Instance::Member => &["Plyloft Test Member", "Plyloft Test", "Plyloft"],
                };
                for app_name in names {
                    match self.helper_call("ax.menu", json!({"pid": pid, "path": [app_name, format!("Quit {app_name}")]})) {
                        Ok(_) => {
                            quit = true;
                            break;
                        }
                        Err(e) => last = e,
                    }
                }
                if !quit {
                    return Err(format!("no Quit item in the app menu: {last}"));
                }
            }
            other => return Err(format!("via must be bridge, cmd+q or menu, not {other:?}")),
        }
        self.client().disconnect();
        let started = Instant::now();
        while self.alive(&[pid]).contains(&pid) && started.elapsed() < QUIT_WAIT {
            std::thread::sleep(Duration::from_millis(200));
        }
        if self.alive(&[pid]).contains(&pid) {
            return Err(format!("{} (pid {pid}) is still running {}s after quit via {via}", self.instance.app_name(), QUIT_WAIT.as_secs()));
        }
        // Time until the app process exited; `cleanupSeconds` adds the wait
        // for its children.
        let seconds = started.elapsed().as_secs_f32();
        let exited = Instant::now();
        let (orphans, webview_lingering) = if self.target == Target::Windows {
            let mut watch = CleanupWatch::new(&children);
            loop {
                let pending = watch.pending();
                let survivors = if pending.is_empty() { Vec::new() } else { self.alive(&pending) };
                let at = exited.elapsed();
                watch.observe(&survivors, at);
                if watch.settled(at) {
                    break watch.verdict(at);
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        } else {
            // Give reaped children a moment, then look for survivors.
            std::thread::sleep(Duration::from_millis(1500));
            let child_pids: Vec<i64> = children.iter().map(|(p, _)| *p).collect();
            let survivors = self.alive(&child_pids);
            let orphans: Vec<Value> = children
                .iter()
                .filter(|(p, _)| survivors.contains(p))
                .map(|(p, c)| json!({"pid": p, "command": c}))
                .collect();
            (orphans, Vec::new())
        };
        let mut out = json!({
            "quit": true,
            "target": self.target.name(),
            "via": via,
            "seconds": seconds,
            "cleanupSeconds": started.elapsed().as_secs_f32(),
            "childrenBefore": children.len(),
            "orphans": orphans,
            "webviewLingering": webview_lingering,
        });
        if self.instance == Instance::Member {
            out["instance"] = json!(self.instance.name());
        }
        if self.target == Target::Windows {
            // The links a creation-time check refused: a clock stepped back
            // reads as a reused pid, so a real orphan shows here, still running.
            let pids: Vec<i64> = not_children.iter().filter_map(|row| row["pid"].as_i64()).collect();
            let running = if pids.is_empty() { Vec::new() } else { self.alive(&pids) };
            for row in &mut not_children {
                let pid = row["pid"].as_i64().unwrap_or_default();
                row["stillRunning"] = json!(running.contains(&pid));
            }
            out["notChildren"] = json!(not_children);
            out["installedLeftOut"] = json!(not_ours);
            if let Some(why) = installed_unread {
                out["installedUnread"] = json!(why);
            }
        }
        Ok(out)
    }

    /// Which of these pids still run, on the current target.
    // TODO: on Windows this checks by pid only, so a pid reused during the
    // grace could read as a survivor. Comparing the creation time recorded
    // with the child list needs the bridge's process list to carry it.
    fn alive(&mut self, pids: &[i64]) -> Vec<i64> {
        if self.target == Target::Windows {
            return match self.vm.call("process.alive", json!({"pids": pids}), HELPER_TIMEOUT) {
                Ok(v) => v["alive"].as_array().into_iter().flatten().filter_map(Value::as_i64).collect(),
                // Unknown counts as alive: never report a clean quit unseen.
                Err(_) => pids.to_vec(),
            };
        }
        pids.iter().copied().filter(|p| alive(*p)).collect()
    }

    // ── input ────────────────────────────────────────────────────────────

    fn wants_trusted(&self, args: &Value, locate: &Value) -> Result<bool, String> {
        match str_arg(args, "mode").unwrap_or("auto") {
            "dom" => Ok(false),
            "trusted" => Ok(true),
            "auto" => Ok(locate["role"] == "terminal"
                || str_arg(args, "button") == Some("right")
                || args.get("count").and_then(Value::as_u64).unwrap_or(1) > 1),
            other => Err(format!("mode must be auto, dom or trusted, not {other:?}")),
        }
    }

    /// Screen point of a located control: the webview's origin on screen
    /// plus the control's centre in page coordinates.
    fn screen_point(&mut self, locate: &Value) -> Result<(f64, f64, i64), String> {
        let info = self.bridge_call("app.info", json!({}))?;
        let content = &info["window"]["content"];
        let (ox, oy) = (content["x"].as_f64().ok_or("no window origin")?, content["y"].as_f64().ok_or("no window origin")?);
        let (cx, cy) = (locate["center"]["x"].as_f64().ok_or("no centre")?, locate["center"]["y"].as_f64().ok_or("no centre")?);
        // Windows: the helper is per-monitor DPI aware and takes physical pixels.
        let scale = if self.target == Target::Windows { info["window"]["scale"].as_f64().unwrap_or(1.0) } else { 1.0 };
        Ok(((ox + cx) * scale, (oy + cy) * scale, info["pid"].as_i64().ok_or("no pid")?))
    }

    fn trusted_click(&mut self, args: &Value, locate: &Value) -> Outcome {
        if locate["unobscured"].as_bool() != Some(true) {
            return Err(format!(
                "{} \"{}\" is covered at its centre by {} — not clicked",
                locate["role"].as_str().unwrap_or(""),
                locate["name"].as_str().unwrap_or(""),
                locate["obscuredBy"]
            ));
        }
        let (x, y, pid) = self.screen_point(locate)?;
        let mut params = pick(args, &["button", "count", "modifiers"]);
        params["pid"] = json!(pid);
        params["at"] = json!({"x": x, "y": y});
        self.helper_call("mouse.click", params)?;
        std::thread::sleep(Duration::from_millis(150));
        let hits = self.bridge_call("ui.hits", json!({"after": locate["mark"], "ref": locate["ref"]}))?;
        if hits["landed"].as_bool() != Some(true) {
            return Err(format!(
                "the trusted click at ({x:.0}, {y:.0}) did not reach {} [ref={}]; the page saw: {}",
                locate["name"], locate["ref"].as_str().unwrap_or(""), hits["hits"]
            ));
        }
        Ok(json!({"clicked": {"ref": locate["ref"], "role": locate["role"], "name": locate["name"]}, "via": "trusted", "at": {"x": x, "y": y}, "landed": true}))
    }

    fn ui_click(&mut self, args: &Value) -> Outcome {
        let locate = self.bridge_call("ui.locate", pick(args, QUERY_KEYS))?;
        if self.wants_trusted(args, &locate)? {
            self.trusted_click(args, &locate)
        } else {
            self.bridge_call("ui.click", pick(args, QUERY_KEYS))
        }
    }

    fn ui_type(&mut self, args: &Value) -> Outcome {
        let text_arg = str_arg(args, "text").ok_or("text is required")?.to_string();
        let locate = self.bridge_call("ui.locate", pick(args, QUERY_KEYS))?;
        let trusted = match str_arg(args, "mode").unwrap_or("auto") {
            "auto" => false,
            _ => self.wants_trusted(args, &locate)?,
        };
        if !trusted {
            let mut params = pick(args, &["ref", "name", "role", "index", "text", "submit", "replace"]);
            params["text"] = json!(text_arg);
            return self.bridge_call("ui.type", params);
        }
        let click_args = pick(args, QUERY_KEYS);
        self.trusted_click(&click_args, &locate)?;
        let pid = self.app_pid()?;
        let terminal = locate["role"] == "terminal";
        if !terminal && args.get("replace").and_then(Value::as_bool) != Some(false) {
            self.helper_call("key", json!({"pid": pid, "keys": "cmd+a"}))?;
        }
        self.helper_call("type", json!({"pid": pid, "text": text_arg}))?;
        if args.get("submit").and_then(Value::as_bool) == Some(true) {
            self.helper_call("key", json!({"pid": pid, "keys": "enter"}))?;
        }
        Ok(json!({"typed": {"ref": locate["ref"], "name": locate["name"]}, "via": "trusted", "chars": text_arg.chars().count()}))
    }

    fn ui_key(&mut self, args: &Value) -> Outcome {
        let keys = str_arg(args, "keys").ok_or("keys is required, e.g. cmd+k or escape")?;
        let query = pick(args, &["ref", "name", "role", "index"]);
        let to_terminal = str_arg(args, "mode").is_none()
            && query.as_object().is_some_and(|q| q.contains_key("ref") || q.contains_key("name"))
            && self.bridge_call("ui.locate", query.clone())?["role"] == "terminal";
        // A terminal takes keys as input sequences (real keys would need its
        // window focused and xterm's keyCode handling): found on the ship
        // loop's walks, where arrows reached the Builder as literal text.
        if str_arg(args, "mode") == Some("dom") || to_terminal {
            return self.bridge_call("ui.key", pick(args, &["keys", "ref", "name", "role", "index"]));
        }
        let pid = self.app_pid()?;
        let mark = self.bridge_call("ui.mark", json!({}))?;
        self.helper_call("key", json!({"pid": pid, "keys": keys}))?;
        std::thread::sleep(Duration::from_millis(150));
        // A quitting app may not answer: that is not an error of the key.
        let seen = self.bridge_call("ui.hits", json!({"after": mark["mark"]})).unwrap_or(Value::Null);
        Ok(json!({"pressed": keys, "via": "trusted", "pageSaw": seen["hits"]}))
    }

    /// Polls one-look checks from here: the page's own timers are throttled
    /// while Plyloft Test is behind other windows, so a wait inside the page
    /// can overrun by seconds (found on the Ship pilot's fix walk).
    fn ui_wait_for(&mut self, args: &Value) -> Outcome {
        let timeout = Duration::from_millis(args.get("timeout_ms").and_then(Value::as_u64).unwrap_or(10_000));
        let params = pick(args, &["text", "ref", "name", "role", "index", "gone"]);
        let started = Instant::now();
        let mut audited = Instant::now();
        loop {
            // A long wait is when a process can come and go between calls.
            if audited.elapsed() >= self.audit_every {
                self.audit();
                audited = Instant::now();
            }
            let look = self.bridge_call("ui.check", params.clone())?;
            if look["met"].as_bool() == Some(true) {
                return Ok(json!({"met": true, "waitedMs": started.elapsed().as_millis() as u64}));
            }
            if started.elapsed() >= timeout {
                let what = str_arg(args, "text")
                    .map(|t| format!("text \"{t}\""))
                    .unwrap_or_else(|| format!("control {}", pick(args, QUERY_KEYS)));
                let gone = args.get("gone").and_then(Value::as_bool) == Some(true);
                return Err(format!(
                    "timed out after {}ms waiting for {what} to {}",
                    timeout.as_millis(),
                    if gone { "disappear" } else { "appear" }
                ));
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    fn ui_drag(&mut self, args: &Value) -> Outcome {
        let from_q = args.get("from").cloned().ok_or("from is required ({ref} or {name, role})")?;
        let to_q = args.get("to").cloned().ok_or("to is required ({ref} or {name, role})")?;
        let from = self.bridge_call("ui.locate", pick(&from_q, QUERY_KEYS))?;
        let to = self.bridge_call("ui.locate", pick(&to_q, QUERY_KEYS))?;
        let (fx, fy, pid) = self.screen_point(&from)?;
        let (tx, mut ty, _) = self.screen_point(&to)?;
        // Where on the target to let go: lists place a drop by its height.
        let height = to["rect"]["height"].as_f64().unwrap_or(0.0);
        match str_arg(args, "to_position").unwrap_or("center") {
            "top" => ty -= height * 0.3,
            "bottom" => ty += height * 0.3,
            "center" => {}
            other => return Err(format!("to_position must be top, center or bottom, not {other:?}")),
        }
        let mut params = pick(args, &["steps"]);
        params["pid"] = json!(pid);
        params["from"] = json!({"x": fx, "y": fy});
        params["to"] = json!({"x": tx, "y": ty});
        self.helper_call("mouse.drag", params)?;
        std::thread::sleep(Duration::from_millis(300));
        let hits = self.bridge_call("ui.hits", json!({"after": from["mark"], "ref": to["ref"]}))?;
        let types: Vec<&str> = hits["hits"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|h| h["trusted"].as_bool() == Some(true))
            .filter_map(|h| h["type"].as_str())
            .collect();
        Ok(json!({
            "dragged": {"from": from["name"], "to": to["name"]},
            "via": "trusted",
            "dragStarted": types.contains(&"dragstart"),
            "droppedOnTarget": hits["landed"],
            "events": types,
        }))
    }

    // ── screenshots ──────────────────────────────────────────────────────

    fn ui_screenshot(&mut self, args: &Value) -> Result<Vec<Value>, String> {
        let pid = self.app_pid()?;
        let dir = self.shots_dir();
        let name = str_arg(args, "name").map(crate::walk::slug).filter(|s| !s.is_empty());
        let stem = name.unwrap_or_else(|| format!("shot-{}", now_stamp()));
        // Both instances may name a shot alike in one walk.
        let stem = if self.instance == Instance::Member { format!("member-{stem}") } else { stem };
        // The helper writes on the profile's disk; the walk dir may be on
        // another volume the helper has no permission for, so move them here.
        let staging = self.config.root.join("shots-tmp");
        if self.target == Target::Windows {
            return self.vm_screenshot(pid, &dir, &stem);
        }
        let shot = self.helper_call("screenshot", json!({"pid": pid, "dir": staging, "name": stem}))?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let mut files: Vec<String> = Vec::new();
        for staged in shot["files"].as_array().into_iter().flatten().filter_map(|f| f["path"].as_str()) {
            let staged = PathBuf::from(staged);
            let target = dir.join(staged.file_name().ok_or("screenshot without a file name")?);
            if std::fs::rename(&staged, &target).is_err() {
                std::fs::copy(&staged, &target).map_err(|e| format!("copy screenshot: {e}"))?;
                let _ = std::fs::remove_file(&staged);
            }
            files.push(target.to_string_lossy().into_owned());
        }
        let first = files.first().ok_or("the helper returned no file")?;
        let mut items = vec![json!({"type": "text", "text": format!("saved: {}", files.join(", "))})];
        if let Ok(data) = preview_png(Path::new(first)) {
            items.push(json!({"type": "image", "data": data, "mimeType": "image/png"}));
        }
        Ok(items)
    }

    /// The VM helper captures the app's windows (PrintWindow) and sends the
    /// PNGs back over the pipe; they are written here, in the walk's shots/.
    fn vm_screenshot(&mut self, pid: i64, dir: &Path, stem: &str) -> Result<Vec<Value>, String> {
        let shot = self.vm.call("screenshot", json!({"pid": pid}), Duration::from_secs(60))?;
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let mut files: Vec<String> = Vec::new();
        let mut notes: Vec<String> = Vec::new();
        for file in shot["files"].as_array().into_iter().flatten() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(file["png"].as_str().ok_or("screenshot without data")?)
                .map_err(|e| format!("screenshot data: {e}"))?;
            let target = dir.join(format!("{stem}{}.png", file["suffix"].as_str().unwrap_or("")));
            std::fs::write(&target, bytes).map_err(|e| format!("{}: {e}", target.display()))?;
            if file["black"].as_bool() == Some(true) {
                notes.push(format!("{} came out black (a locked VM screen?)", target.display()));
            }
            files.push(target.to_string_lossy().into_owned());
        }
        let first = files.first().ok_or("the VM helper returned no picture")?;
        let mut text_out = format!("saved: {}", files.join(", "));
        for note in notes {
            text_out.push_str(&format!("\nwarning: {note}"));
        }
        let mut items = vec![json!({"type": "text", "text": text_out})];
        if let Ok(data) = preview_png(Path::new(first)) {
            items.push(json!({"type": "image", "data": data, "mimeType": "image/png"}));
        }
        Ok(items)
    }
}

fn agents_in(state: &Value) -> Vec<crate::walk::AgentProcess> {
    state["processes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["agent"].as_bool() == Some(true))
        .filter_map(|p| {
            Some(crate::walk::AgentProcess {
                pid: p["pid"].as_u64()?,
                command: p["command"].as_str()?.to_string(),
                argv: p["args"].as_str().map(str::to_string),
            })
        })
        .collect()
}

/// A process list on its way to the agent: command lines without their secrets.
fn redact_process_lines(mut state: Value) -> Value {
    // Other kinds of state may be an array, which `state["processes"]` would panic on.
    let list = state.get_mut("processes").and_then(Value::as_array_mut);
    for process in list.into_iter().flatten() {
        if let Some(line) = process["args"].as_str().map(crate::walk::redact_argv) {
            process["args"] = json!(line);
        }
    }
    state
}

/// `actions.jsonl`: whether an invitation was really accepted, which "the tool
/// answered" doesn't say.
fn invitation_detail(tool: &str, outcome: &Result<Vec<Value>, String>) -> Option<Value> {
    if tool != "gh_accept_invitation" {
        return None;
    }
    let answer = outcome
        .as_ref()
        .ok()
        .and_then(|items| items.first())
        .and_then(|item| item["text"].as_str())
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    Some(match answer {
        Some(a) => json!({"accepted": a["accepted"], "invitation": a["invitation"], "repo": a["repo"]}),
        None => json!({"accepted": false}),
    })
}

/// The picture the agent sees: scaled down with `sips` (the full one stays
/// on disk for the report), base64.
fn preview_png(path: &Path) -> Result<String, String> {
    let preview = path.with_extension("preview.png");
    let status = Command::new("/usr/bin/sips")
        .args(["-Z", &PREVIEW_MAX_PX.to_string()])
        .arg(path)
        .arg("--out")
        .arg(&preview)
        .output()
        .map_err(|e| format!("sips: {e}"))?;
    let source = if status.status.success() { preview.clone() } else { path.to_path_buf() };
    let bytes = std::fs::read(&source).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&preview);
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn alive(pid: i64) -> bool {
    Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Whether a child (as the bridge lists it: on Windows, the executable's
/// file name) is a WebView2 runtime process.
fn is_webview2(command: &str) -> bool {
    let name = command.rsplit(['\\', '/']).next().unwrap_or(command).trim().to_ascii_lowercase();
    name == "msedgewebview2.exe" || name == "msedgewebview2"
}

/// `win_read processes`' pids of the installed Plyloft.
fn installed_pids(report: &Value) -> Vec<i64> {
    report["installedPlyloftPids"].as_array().into_iter().flatten().filter_map(Value::as_i64).collect()
}

/// The links the bridge's list and the helper's report refused as not really
/// parent and child, each process once.
fn not_children_in(tree: &Value, report: Option<&Value>) -> Vec<Value> {
    let from_helper = report
        .and_then(|report| report["plyloftTest"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|app| app["notChildren"].as_array())
        .flatten();
    let mut out: Vec<Value> = Vec::new();
    for row in tree["notChildren"].as_array().into_iter().flatten().chain(from_helper) {
        if !out.iter().any(|seen| seen["pid"] == row["pid"]) {
            out.push(row.clone());
        }
    }
    out
}

/// A process list without the installed Plyloft and its descendants, and those
/// as a list of their own. They reach the test app's tree by a parent pid Windows
/// never updates: the installed app's parent had exited and a WebView2 of the test
/// app got its number (walk of 2026-11-03, 5672 running since the day before under
/// the new 4496). Only what hangs from an installed pid leaves; a real child of the
/// test app, orphan or not, stays.
fn without_installed(mut tree: Value, installed: &[i64]) -> (Value, Vec<Value>) {
    let Some(rows) = tree.get_mut("processes").and_then(Value::as_array_mut) else {
        return (tree, Vec::new());
    };
    let mut out: Vec<i64> = installed.to_vec();
    let mut grew = true;
    while grew {
        grew = false;
        for row in rows.iter() {
            let (Some(pid), Some(ppid)) = (row["pid"].as_i64(), row["ppid"].as_i64()) else { continue };
            if out.contains(&ppid) && !out.contains(&pid) {
                out.push(pid);
                grew = true;
            }
        }
    }
    let (gone, kept): (Vec<Value>, Vec<Value>) =
        rows.drain(..).partition(|row| row["pid"].as_i64().is_some_and(|pid| out.contains(&pid)));
    *rows = kept;
    let gone = gone.iter().map(|row| json!({"pid": row["pid"], "command": row["command"]})).collect();
    (tree, gone)
}

struct Tracked {
    pid: i64,
    command: String,
    webview: bool,
    seen_alive: bool,
    gone_at: Option<Duration>,
}

/// The Windows orphan check after the app exits, kept pure so the grace
/// rules are testable. Times are from the app's exit. A child other than
/// WebView2 still running at `ORPHAN_WAIT_WINDOWS` is an orphan, as before;
/// a WebView2 child is an orphan only if still running at
/// `WEBVIEW_GRACE_WINDOWS`, and is listed as lingering if it outlived the
/// app at all.
struct CleanupWatch {
    children: Vec<Tracked>,
}

impl CleanupWatch {
    fn new(children: &[(i64, String)]) -> Self {
        let children = children
            .iter()
            .map(|(pid, command)| Tracked {
                pid: *pid,
                command: command.clone(),
                webview: is_webview2(command),
                seen_alive: false,
                gone_at: None,
            })
            .collect();
        Self { children }
    }

    /// The pids not yet seen gone.
    fn pending(&self) -> Vec<i64> {
        self.children.iter().filter(|c| c.gone_at.is_none()).map(|c| c.pid).collect()
    }

    /// Records one look: `alive` are the pending pids still running at `at`.
    fn observe(&mut self, alive: &[i64], at: Duration) {
        for c in self.children.iter_mut().filter(|c| c.gone_at.is_none()) {
            if alive.contains(&c.pid) {
                c.seen_alive = true;
            } else {
                c.gone_at = Some(at);
            }
        }
    }

    /// Nothing left to wait for: each class is gone or out of time.
    fn settled(&self, at: Duration) -> bool {
        let waiting = |webview: bool| self.children.iter().any(|c| c.webview == webview && c.gone_at.is_none());
        (!waiting(false) || at >= ORPHAN_WAIT_WINDOWS) && (!waiting(true) || at >= WEBVIEW_GRACE_WINDOWS)
    }

    /// `(orphans, webviewLingering)` as of `at`.
    fn verdict(&self, at: Duration) -> (Vec<Value>, Vec<Value>) {
        let mut orphans = Vec::new();
        let mut lingering = Vec::new();
        for c in &self.children {
            let orphan = match c.gone_at {
                None => true,
                Some(t) => !c.webview && t > ORPHAN_WAIT_WINDOWS,
            };
            if orphan {
                orphans.push(json!({"pid": c.pid, "command": c.command}));
            }
            if c.webview && c.seen_alive {
                lingering.push(json!({
                    "pid": c.pid,
                    "command": c.command,
                    "lingeredSeconds": c.gone_at.unwrap_or(at).as_secs_f32(),
                    "stillRunning": c.gone_at.is_none(),
                }));
            }
        }
        (orphans, lingering)
    }
}

#[cfg(test)]
mod cleanup_tests {
    use super::*;

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    fn kids() -> Vec<(i64, String)> {
        vec![(10, "msedgewebview2.exe".into()), (11, "MSEdgeWebView2.exe".into()), (20, "claude.exe".into())]
    }

    #[test]
    fn the_installed_plyloft_and_what_hangs_from_it_leave_the_tree_and_nothing_else_does() {
        let row = |pid: i64, ppid: i64, command: &str| json!({"pid": pid, "ppid": ppid, "command": command, "agent": false});
        // The walk of 2026-11-03: 4496 is a WebView2 of the test app (5452) and
        // the stale parent of the installed 5672, whose WebView2s follow it.
        let tree = json!({"processes": [
            row(4496, 5452, "msedgewebview2.exe"),
            row(5672, 4496, "atelier.exe"),
            row(2192, 11544, "msedgewebview2.exe"),
            row(11544, 5672, "msedgewebview2.exe"),
            row(77, 5452, "claude.exe"),
            row(78, 77, "node.exe"),
        ], "agentCount": 0});
        let (kept, gone) = without_installed(tree, &installed_pids(&json!({"installedPlyloftPids": [5672]})));
        let pids = |rows: &Value| rows.as_array().unwrap().iter().map(|r| r["pid"].as_i64().unwrap()).collect::<Vec<_>>();
        assert_eq!(pids(&kept["processes"]), vec![4496, 77, 78], "real children stay, orphans included");
        assert_eq!(kept["agentCount"], 0, "the rest of the answer is kept");
        let mut left: Vec<i64> = pids(&json!(gone));
        left.sort_unstable();
        assert_eq!(left, vec![2192, 5672, 11544], "whatever order the listing has");
    }

    #[test]
    fn with_no_installed_plyloft_nothing_leaves() {
        let tree = json!({"processes": [{"pid": 77, "ppid": 5452, "command": "claude.exe"}]});
        let (kept, gone) = without_installed(tree.clone(), &installed_pids(&json!({"installedPlyloftPids": []})));
        assert_eq!(kept, tree);
        assert!(gone.is_empty());
        let (kept, gone) = without_installed(tree.clone(), &installed_pids(&json!({})));
        assert_eq!(kept, tree, "an answer without the list leaves everything in");
        assert!(gone.is_empty());
    }

    #[test]
    fn classifies_webview2_by_file_name() {
        assert!(is_webview2("msedgewebview2.exe"));
        assert!(is_webview2("MSEdgeWebView2.exe"));
        assert!(is_webview2(r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\msedgewebview2.exe"));
        assert!(!is_webview2("claude.exe"));
        assert!(!is_webview2("msedge.exe"));
        assert!(!is_webview2("msedgewebview2-helper.exe"));
    }

    #[test]
    fn all_gone_at_once_is_clean_and_settles() {
        let mut w = CleanupWatch::new(&kids());
        w.observe(&[], secs(0));
        assert!(w.settled(secs(0)));
        let (orphans, lingering) = w.verdict(secs(0));
        assert!(orphans.is_empty() && lingering.is_empty());
        assert!(w.pending().is_empty());
    }

    #[test]
    fn non_webview_survivor_at_ten_seconds_is_an_orphan() {
        let mut w = CleanupWatch::new(&kids());
        w.observe(&[20], secs(0));
        assert!(!w.settled(secs(5)));
        w.observe(&[20], secs(10));
        assert!(w.settled(secs(10)));
        let (orphans, lingering) = w.verdict(secs(10));
        assert_eq!(orphans, vec![json!({"pid": 20, "command": "claude.exe"})]);
        assert!(lingering.is_empty());
    }

    #[test]
    fn non_webview_gone_within_ten_seconds_is_fine() {
        let mut w = CleanupWatch::new(&kids());
        w.observe(&[20], secs(0));
        w.observe(&[], secs(4));
        assert!(w.settled(secs(4)));
        assert!(w.verdict(secs(4)).0.is_empty());
    }

    #[test]
    fn webview_lingering_within_grace_is_reported_not_an_orphan() {
        let mut w = CleanupWatch::new(&kids());
        w.observe(&[10, 11], secs(0));
        // Past the ordinary wait, WebView2 still has its grace.
        w.observe(&[10, 11], secs(10));
        assert!(!w.settled(secs(10)));
        w.observe(&[11], secs(14));
        w.observe(&[], secs(17));
        assert!(w.settled(secs(17)));
        let (orphans, lingering) = w.verdict(secs(17));
        assert!(orphans.is_empty(), "{orphans:?}");
        assert_eq!(lingering.len(), 2);
        assert_eq!(lingering[0]["lingeredSeconds"], json!(14.0));
        assert_eq!(lingering[1]["lingeredSeconds"], json!(17.0));
        assert_eq!(lingering[0]["stillRunning"], json!(false));
    }

    #[test]
    fn webview_alive_after_grace_is_an_orphan() {
        let mut w = CleanupWatch::new(&kids());
        w.observe(&[10], secs(0));
        assert!(!w.settled(secs(29)));
        w.observe(&[10], secs(30));
        assert!(w.settled(secs(30)));
        let (orphans, lingering) = w.verdict(secs(30));
        assert_eq!(orphans, vec![json!({"pid": 10, "command": "msedgewebview2.exe"})]);
        assert_eq!(lingering[0]["stillRunning"], json!(true));
        assert_eq!(lingering[0]["lingeredSeconds"], json!(30.0));
    }

    #[test]
    fn non_webview_gone_late_stays_an_orphan_while_webview_waits() {
        let mut w = CleanupWatch::new(&kids());
        w.observe(&[10, 20], secs(0));
        w.observe(&[10, 20], secs(10));
        assert!(!w.settled(secs(10)));
        // claude.exe goes at 12 s: past its wait, still an orphan.
        w.observe(&[10], secs(12));
        w.observe(&[], secs(20));
        assert!(w.settled(secs(20)));
        let (orphans, lingering) = w.verdict(secs(20));
        assert_eq!(orphans, vec![json!({"pid": 20, "command": "claude.exe"})]);
        assert_eq!(lingering.len(), 1);
    }
}

#[cfg(test)]
mod redaction_tests {
    use super::*;

    /// `app_state` kind `board` answers with an array: the first live scenario
    /// panicked here and took the whole MCP with it.
    #[test]
    fn a_state_that_is_an_array_passes_through() {
        let board = json!([{"ghIssueNumber": 1}]);
        assert_eq!(redact_process_lines(board.clone()), board);
        assert_eq!(redact_process_lines(json!({"cards": 1})), json!({"cards": 1}));
    }
}
