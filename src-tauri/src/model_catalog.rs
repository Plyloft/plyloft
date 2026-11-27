//! 1.169.0 (A1): the models and efforts Plyloft offers in its model menus,
//! from three sources, newest first:
//!
//! - **Codex**: `codex debug models`, run with the cached PATH like every
//!   spawn (`shell_env`), bounded in time and output, off the UI thread.
//!   Codex may refresh its list over the network with the member's own
//!   login, so it is read at most once a day (again when a menu opens after a
//!   failed read, or once Codex's version changed). The last good list and
//!   when it was read are kept in `model_catalog.json` (1.176.2), so a start
//!   within the day uses that list without running Codex. The read is left
//!   out while the automatic Codex update runs. It is a *debug* subcommand whose shape
//!   may change, so it is parsed field by field; a read that fails keeps the
//!   last good list, else the file below is used.
//! - **The site file** `https://www.plyloft.com/models.json` (Claude, and Codex
//!   when its own list can't be read): asked at start and once a day after a
//!   good answer, after an hour after a failed one; cached atomically in the
//!   app's data dir (`model_catalog.json`).
//! - **The bundled copy** (`src-tauri/catalog/models.json`, the same file the
//!   site publishes): first run, offline, a 404 or a file this build can't
//!   read (another `schemaVersion`).
//!
//! The menus stay free text (#50): the catalog only suggests, and only the
//! newest version of each family (owner D2, [`latest_per_family`]); an older
//! model typed or saved keeps working, and its levels stay known. It also
//! decides at spawn ([`ModelCatalog::fit`]): an effort the chosen model is
//! known not to take passes no flag, so that model's own default runs.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// The file the site publishes; its copy ships in the app. With `www.`:
/// HTTPS on the bare plyloft.com does not answer (checked 2026-10-23).
pub const SITE_URL: &str = "https://www.plyloft.com/models.json";
/// The only `schemaVersion` this build reads. A file with another one is
/// ignored (cache, then bundled copy), so the site must keep serving a
/// version-1 file for every Plyloft that reads only 1.
pub const SCHEMA_VERSION: u64 = 1;
const BUNDLED: &str = include_str!("../catalog/models.json");
const CACHE_FILE: &str = "model_catalog.json";
/// After a good answer the site is asked again a day later…
const SITE_EVERY_MS: i64 = 24 * 60 * 60 * 1000;
/// …after a failed one (offline, 404), an hour later.
const SITE_RETRY_MS: i64 = 60 * 60 * 1000;
/// Bigger than this is not a model list. Checked once the body is read:
/// `account::ReqwestHttp` reads it whole (its 20 s `HTTP_TIMEOUT` bounds that).
const SITE_MAX_BYTES: usize = 1024 * 1024;
/// `codex debug models` answers from Codex's local cache in milliseconds
/// (~0.5 MB today: it carries each model's instructions).
const CODEX_TIMEOUT: Duration = Duration::from_secs(10);
const CODEX_MAX_STDOUT: usize = 16 * 1024 * 1024;
/// A good read of Codex's list lasts a day.
const CODEX_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// A failed one is tried again when a menu opens, at most this often.
const CODEX_RETRY: Duration = Duration::from_secs(60);
/// Sent to the UI whenever the catalog changes.
pub const EVENT_CHANGED: &str = "model-catalog-changed";

/// Finding 1 (Challenger, A1): the oldest Claude Code known to take all of
/// `--effort low|medium|high|xhigh|max`. The CLI changelog shows `--effort`
/// by 2.1.72 and adds `xhigh` "via `/effort`, `--effort`" in 2.1.111 (with
/// `max` already above it, back since 2.1.98's `/effort max` fix). Older or
/// unknown versions get no effort flag.
pub const MIN_CLAUDE_VERSION_EFFORT: (u32, u32, u32) = (2, 1, 111);

/// Whether the Claude CLI at `version` takes `--effort` with every level
/// the menus offer. Unknown versions don't: no flag is the safe choice.
pub fn claude_supports_effort(version: Option<&str>) -> bool {
    version
        .and_then(crate::shell_env::parse_semver)
        .is_some_and(|v| v >= MIN_CLAUDE_VERSION_EFFORT)
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// One model a menu offers. `efforts` absent: the vendor's list, support
/// unknown (no effort is dropped for it); present: exactly those. `hidden`:
/// known (its levels count at spawn) but not offered in the menus — Codex's
/// `visibility: "hide"`, a file model missing from Codex's own list, or an
/// older version of a family.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub efforts: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub hidden: bool,
}

/// One vendor's models and the efforts its CLI takes (what a model the
/// catalog doesn't know is offered).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VendorCatalog {
    pub efforts: Vec<String>,
    pub models: Vec<CatalogModel>,
}

/// The site file, read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CatalogFile {
    pub claude: VendorCatalog,
    pub codex: VendorCatalog,
}

/// What the menus get (`model_catalog_get`, [`EVENT_CHANGED`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub claude: VendorCatalog,
    pub codex: VendorCatalog,
    /// Codex's models came from `codex debug models` on this computer.
    pub codex_from_cli: bool,
    /// `site` (fetched this run), `cache` or `bundled`.
    pub file_from: &'static str,
    /// The installed Claude Code takes `--effort` ([`claude_supports_effort`]).
    pub claude_effort: bool,
    /// Why it doesn't, for the UI's line: `tooOld`, `notInstalled` or
    /// `versionUnknown`; absent when it does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_effort_why: Option<&'static str>,
}

/// The Claude CLI as this run found it (`shell_env`).
#[derive(Debug, Clone, Default)]
pub struct ClaudeCli {
    pub installed: bool,
    pub version: Option<String>,
}

/// Whether `--effort` is passed, and why not.
fn claude_effort_state(cli: &ClaudeCli) -> (bool, Option<&'static str>) {
    if !cli.installed {
        return (false, Some("notInstalled"));
    }
    let version = cli.version.as_deref();
    if version.and_then(crate::shell_env::parse_semver).is_none() {
        (false, Some("versionUnknown"))
    } else if claude_supports_effort(version) {
        (true, None)
    } else {
        (false, Some("tooOld"))
    }
}

impl ModelCatalog {
    fn vendor(&self, vendor: &str) -> &VendorCatalog {
        if vendor == "codex" {
            &self.codex
        } else {
            &self.claude
        }
    }

    /// The model's own efforts: `Some` only when the catalog knows the model
    /// (hidden ones included) and lists its levels.
    pub fn model_efforts(&self, vendor: &str, model: &str) -> Option<&[String]> {
        self.vendor(vendor)
            .models
            .iter()
            .find(|m| m.id == model)
            .and_then(|m| m.efforts.as_deref())
    }

    /// Owner decision 3 (1.169.0, da confermare): a stored effort that can't
    /// run passes no flag — the model's (or the CLI's) default runs:
    /// - Claude Code older than [`MIN_CLAUDE_VERSION_EFFORT`] (or unknown):
    ///   no `--effort` at all;
    /// - a known model whose levels don't include it;
    /// - no model chosen (the CLI's default) and a level the vendor doesn't
    ///   take at all (an old Codex `minimal`).
    ///
    /// A model the catalog doesn't know, or one whose levels aren't listed,
    /// keeps the effort, as before.
    pub fn fit(&self, vendor: &str, choice: crate::settings::ModelChoice) -> crate::settings::ModelChoice {
        let drop = || crate::settings::ModelChoice { model: choice.model.clone(), reasoning: None };
        let Some(effort) = choice.reasoning.as_deref() else {
            return choice;
        };
        if vendor != "codex" && !self.claude_effort {
            return drop();
        }
        if self.effort_fits(vendor, choice.model.as_deref(), effort) {
            choice
        } else {
            drop()
        }
    }

    /// Whether `effort` runs on `model` as far as the catalog knows (the
    /// Claude Code version aside): a known model's levels, or with no model
    /// the vendor's; an unknown model takes any. A2 (Challenger 5): the
    /// layers are walked with it, so an effort that doesn't fit falls to the
    /// next layer's (`settings::resolve_card_model_fitted`).
    pub fn effort_fits(&self, vendor: &str, model: Option<&str>, effort: &str) -> bool {
        let levels = match model {
            Some(model) => self.model_efforts(vendor, model),
            // No model chosen: the file's vendor levels (Codex's from the file even when
            // Codex's own list is read) — the safe direction, a level they lack is dropped.
            None => Some(self.vendor(vendor).efforts.as_slice()).filter(|l| !l.is_empty()),
        };
        levels.is_none_or(|levels| levels.iter().any(|l| l == effort))
    }
}

/// A model id's family and version (owner D2): the version is every token
/// made of digits and dots (`6.1`, `5`, `5`), the family the other tokens
/// (`gpt-sol`, `claude-opus`). An id with no number is its own family.
fn family_and_version(id: &str) -> (String, Vec<u64>) {
    let mut family: Vec<&str> = Vec::new();
    let mut version: Vec<u64> = Vec::new();
    for token in id.split('-') {
        let numeric = !token.is_empty()
            && token.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
        if numeric {
            version.extend(token.split('.').filter_map(|p| p.parse::<u64>().ok()));
        } else {
            family.push(token);
        }
    }
    while version.last() == Some(&0) {
        version.pop();
    }
    (family.join("-"), version)
}

/// Owner D2 (1.169.0): of `ids`, the newest version of each family, in the
/// order given (the first of equals kept, duplicates once). The mirror of
/// `modelCatalog.ts::latestPerFamily`; `src/lib/modelFamilies.fixtures.json`
/// holds both.
pub fn latest_per_family(ids: &[String]) -> Vec<String> {
    let parsed: Vec<(String, Vec<u64>)> = ids.iter().map(|id| family_and_version(id)).collect();
    let mut out: Vec<String> = Vec::new();
    for (i, id) in ids.iter().enumerate() {
        let (family, version) = &parsed[i];
        let beaten = parsed
            .iter()
            .enumerate()
            .any(|(j, (f, v))| f == family && (v > version || (v == version && j < i)));
        if !beaten && !out.contains(id) {
            out.push(id.clone());
        }
    }
    out
}

/// Hides every offered model that isn't the newest of its family.
fn hide_older(models: &mut [CatalogModel]) {
    let offered: Vec<String> = models.iter().filter(|m| !m.hidden).map(|m| m.id.clone()).collect();
    let latest = latest_per_family(&offered);
    for m in models.iter_mut() {
        if !latest.contains(&m.id) {
            m.hidden = true;
        }
    }
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// A list of levels: strings, or objects carrying `effort` (Codex's shape).
fn levels(v: &Value) -> Option<Vec<String>> {
    let items = v.as_array()?;
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let level = item
            .as_str()
            .map(str::to_string)
            .or_else(|| text(item, "effort"))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if let Some(level) = level {
            if !out.contains(&level) {
                out.push(level);
            }
        }
    }
    Some(out)
}

fn vendor_from_file(v: Option<&Value>) -> VendorCatalog {
    let Some(v) = v else {
        return VendorCatalog::default();
    };
    let efforts = v.get("efforts").and_then(levels).unwrap_or_default();
    let models = v
        .get("models")
        .and_then(Value::as_array)
        .map(|items| {
            let mut out: Vec<CatalogModel> = Vec::new();
            for item in items {
                let Some(id) = text(item, "id") else { continue };
                if out.iter().any(|m| m.id == id) {
                    continue;
                }
                out.push(CatalogModel {
                    label: text(item, "label").unwrap_or_else(|| id.clone()),
                    efforts: item.get("efforts").and_then(levels),
                    default_effort: text(item, "defaultEffort"),
                    hidden: false,
                    id,
                });
            }
            out
        })
        .unwrap_or_default();
    VendorCatalog { efforts, models }
}

/// The site file's schema, read leniently: `schemaVersion` must be
/// [`SCHEMA_VERSION`]; a model without an `id` is skipped; unknown fields
/// are ignored.
pub fn parse_file(raw: &str) -> Option<CatalogFile> {
    let v: Value = serde_json::from_str(raw).ok()?;
    parse_file_value(&v)
}

fn parse_file_value(v: &Value) -> Option<CatalogFile> {
    if v.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION) {
        return None;
    }
    let vendors = v.get("vendors");
    Some(CatalogFile {
        claude: vendor_from_file(vendors.and_then(|x| x.get("claude"))),
        codex: vendor_from_file(vendors.and_then(|x| x.get("codex"))),
    })
}

/// The copy in the app, read once (finding 12). A test holds it readable.
static BUNDLED_FILE: std::sync::LazyLock<CatalogFile> =
    std::sync::LazyLock::new(|| parse_file(BUNDLED).unwrap_or_default());

pub fn bundled() -> CatalogFile {
    BUNDLED_FILE.clone()
}

/// `codex debug models`' stdout, read field by field: `{"models":[{slug,
/// display_name, visibility, default_reasoning_level,
/// supported_reasoning_levels:[{effort}]}]}`. An entry whose `visibility`
/// isn't `list` is kept hidden (its levels still count at spawn). `None`
/// when no offered entry is there, so the file's Codex list is used instead.
pub fn parse_codex_debug_models(stdout: &str) -> Option<Vec<CatalogModel>> {
    let v: Value = serde_json::from_str(stdout.trim()).ok()?;
    let items = v.get("models").and_then(Value::as_array)?;
    let mut out: Vec<CatalogModel> = Vec::new();
    for item in items {
        let Some(slug) = text(item, "slug") else { continue };
        if out.iter().any(|m| m.id == slug) {
            continue;
        }
        let hidden = item.get("visibility").and_then(Value::as_str).is_some_and(|v| v != "list");
        out.push(CatalogModel {
            label: text(item, "display_name").unwrap_or_else(|| slug.clone()),
            efforts: item.get("supported_reasoning_levels").and_then(levels).filter(|l| !l.is_empty()),
            default_effort: text(item, "default_reasoning_level"),
            hidden,
            id: slug,
        });
    }
    out.iter().any(|m| !m.hidden).then_some(out)
}

/// `model_catalog.json` in the app's data dir: when the site was last
/// asked, and the last file it answered with (verbatim, read again on load).
/// `fetchedAt == checkedAt`: the last ask was answered.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct CacheRecord {
    checked_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    fetched_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    catalog: Option<Value>,
    /// 1.176.2: the last good `codex debug models` read. Absent in a file
    /// written before 1.176.2; 1.176.1 ignores it (and drops it when it
    /// next records a site ask, which only means one more read).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    codex: Option<CodexRecord>,
}

/// A good read of Codex's own list: when (ms since the epoch), the Codex
/// version that answered, when Codex's sign-in file was last changed then
/// (its modification time, ms; see [`auth_stamp`]), and the list.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct CodexRecord {
    read_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_at: Option<i64>,
    models: Vec<CatalogModel>,
}

/// When `<codex home>/auth.json` was last modified (ms since the epoch): a
/// sign-in, a sign-out to another account or a plan change rewrites it, and
/// the models offered may change with it. Only the file's metadata is read,
/// never its contents. `None` when it can't be read (no such file).
fn auth_stamp(codex_home: &Path) -> Option<i64> {
    let modified = std::fs::metadata(codex_home.join("auth.json")).ok()?.modified().ok()?;
    modified.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}

fn auth_stamp_now() -> Option<i64> {
    auth_stamp(&crate::codex_home::real_codex_home())
}

fn codex_installed_now() -> bool {
    crate::shell_env::try_get().is_some_and(|env| env.codex_path.is_some())
}

/// Keeps a good Codex read in the cache file (atomically), beside what the
/// site part holds.
fn save_codex_read(config_dir: &Path, record: CodexRecord) {
    let mut cache = read_cache(config_dir).unwrap_or_default();
    cache.codex = Some(record);
    if let Err(e) = crate::atomic::write_atomic_json(&config_dir.join(CACHE_FILE), &cache) {
        log::warn!("model catalog: cache not written: {e}");
    }
}

impl CacheRecord {
    /// The site is due: never asked, a clock that went back, or a day after
    /// a good answer / an hour after a failed one (finding 7).
    fn site_due(&self, now: i64) -> bool {
        if self.checked_at <= 0 || now < self.checked_at {
            return true;
        }
        let wait = if self.fetched_at == Some(self.checked_at) { SITE_EVERY_MS } else { SITE_RETRY_MS };
        now - self.checked_at >= wait
    }
}

fn read_cache(config_dir: &Path) -> Option<CacheRecord> {
    let raw = std::fs::read_to_string(config_dir.join(CACHE_FILE)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// What starts the run: the cached site file when it reads, else the
/// bundled copy; and when the site was last asked.
fn load(config_dir: &Path) -> (Option<CatalogFile>, i64) {
    let record = read_cache(config_dir).unwrap_or_default();
    let file = record.catalog.as_ref().and_then(parse_file_value);
    (file, record.checked_at)
}

/// The site's answer, or `None` (no answer, not 200, too big, unreadable),
/// logged in one line without anything that identifies the member.
fn fetch_site(http: &dyn crate::account::Http) -> Option<(Value, CatalogFile)> {
    let answer = fetch_site_quiet(http);
    match &answer {
        Ok(_) => log::info!("model catalog: site file {SITE_URL} read"),
        Err(why) => {
            log::info!("model catalog: site file {SITE_URL} not used ({why}); keeping the cache or the bundled copy")
        }
    }
    answer.ok()
}

fn fetch_site_quiet(http: &dyn crate::account::Http) -> Result<(Value, CatalogFile), String> {
    let req = crate::account::HttpRequest {
        method: crate::account::Method::Get,
        url: SITE_URL.to_string(),
        bearer: None,
        headers: Vec::new(),
        body: crate::account::Body::None,
    };
    let resp = http.send(&req).map_err(|_| "no answer".to_string())?;
    if resp.status != 200 {
        return Err(format!("HTTP {}", resp.status));
    }
    if resp.body.len() > SITE_MAX_BYTES {
        return Err("too big".into());
    }
    let v: Value = serde_json::from_str(&resp.body).map_err(|_| "not JSON".to_string())?;
    let file = parse_file_value(&v).ok_or_else(|| "another schemaVersion".to_string())?;
    Ok((v, file))
}

/// Asks the site when it is due ([`CacheRecord::site_due`]); records the ask
/// (and a good answer) atomically. `Some` only with a new, readable file.
fn refresh_site(config_dir: &Path, http: &dyn crate::account::Http, now: i64) -> Option<CatalogFile> {
    let previous = read_cache(config_dir).unwrap_or_default();
    if !previous.site_due(now) {
        return None;
    }
    let answer = fetch_site(http);
    let record = match &answer {
        Some((raw, _)) => CacheRecord { checked_at: now, fetched_at: Some(now), catalog: Some(raw.clone()), ..previous },
        None => CacheRecord { checked_at: now, ..previous },
    };
    if let Err(e) = crate::atomic::write_atomic_json(&config_dir.join(CACHE_FILE), &record) {
        log::warn!("model catalog: cache not written: {e}");
    }
    answer.map(|(_, file)| file)
}

/// What a look at Codex's list gave.
enum CodexRead {
    /// The automatic update was running: not read, still due.
    Skipped,
    /// Codex isn't installed or its answer doesn't read.
    Failed,
    Good(Vec<CatalogModel>),
}

/// The Codex version this computer has now (`shell_env`, no spawn).
fn codex_version_now() -> Option<String> {
    crate::shell_env::try_get().and_then(|env| env.codex_version.clone())
}

/// `codex debug models` with the cached PATH, bounded.
fn read_codex() -> CodexRead {
    let Some(env) = crate::shell_env::try_get() else { return CodexRead::Failed };
    let Some(codex) = env.codex_path.as_deref() else { return CodexRead::Failed };
    // 1.176.0 R5: a Codex start (the automatic update's gate). 1.176.2
    // (A5R-08): one the update never waits for or is stopped by — left out
    // while it runs, and read at the next menu that asks.
    if !crate::codex_auto_update::codex_start_unless_updating() {
        return CodexRead::Skipped;
    }
    let mut command = crate::platform::command(codex, &env.path);
    command.args(["debug", "models"]).env("PATH", &env.path);
    let Ok(out) = crate::worktrees::run_bounded_output_capped(&mut command, CODEX_TIMEOUT, CODEX_MAX_STDOUT) else {
        return CodexRead::Failed;
    };
    if !out.status.success() {
        return CodexRead::Failed;
    }
    match parse_codex_debug_models(&String::from_utf8_lossy(&out.stdout)) {
        Some(models) => CodexRead::Good(models),
        None => CodexRead::Failed,
    }
}

struct Inner {
    config_dir: Option<PathBuf>,
    file: Option<CatalogFile>,
    file_from: &'static str,
    /// The last good Codex list (finding 5: a later failed read keeps it).
    codex_cli: Option<Vec<CatalogModel>>,
    /// When Codex was last read (ms since the epoch; 1.176.2: a good read
    /// is kept across starts), and whether that read was good.
    codex_read: Option<(i64, bool)>,
    /// The Codex version of the last good read.
    codex_read_version: Option<String>,
    /// [`auth_stamp`] at the last good read.
    codex_read_auth: Option<i64>,
    busy: bool,
}

impl Inner {
    fn new() -> Self {
        Inner {
            config_dir: None,
            file: None,
            file_from: "bundled",
            codex_cli: None,
            codex_read: None,
            codex_read_version: None,
            codex_read_auth: None,
            busy: false,
        }
    }

    /// Finding 4: a good read lasts a day — across starts since 1.176.2 —
    /// unless Codex's version changed since; a failed one is tried again
    /// (when a menu asks) after a minute. A clock that went back reads again.
    /// Also due once Codex's sign-in file changed (`auth_now`, its
    /// [`auth_stamp`]; `None` when it can't be read, which changes nothing).
    fn codex_due(&self, now: i64, version_now: Option<&str>, auth_now: Option<i64>) -> bool {
        let wait = |at: i64, every: Duration| now < at || now - at >= every.as_millis() as i64;
        match self.codex_read {
            None => true,
            Some((at, true)) => {
                wait(at, CODEX_EVERY)
                    || version_now.is_some_and(|v| self.codex_read_version.as_deref() != Some(v))
                    || auth_now.is_some_and(|a| self.codex_read_auth != Some(a))
            }
            Some((at, false)) => wait(at, CODEX_RETRY),
        }
    }

    /// A good read, held (and its record kept by the caller).
    fn take_good_read(&mut self, record: &CodexRecord) {
        self.codex_read = Some((record.read_at, true));
        self.codex_read_version = record.version.clone();
        self.codex_read_auth = record.auth_at;
        self.codex_cli = Some(record.models.clone());
    }

    /// REV-R4 F3: Codex removed while Plyloft is open — its list is no
    /// longer offered, and a read is due again (one that finds Codex fails).
    fn forget_codex_if_gone(&mut self, codex_installed: bool) {
        if !codex_installed && self.codex_cli.is_some() {
            self.codex_cli = None;
            self.codex_read = None;
        }
    }

    /// At start: a good read kept from an earlier run, while Codex is still
    /// installed (its list is not offered for a Codex that is gone).
    fn adopt_codex_record(&mut self, record: Option<CodexRecord>, codex_installed: bool) {
        let Some(record) = record.filter(|r| codex_installed && !r.models.is_empty()) else { return };
        self.take_good_read(&record);
    }
}

static STATE: std::sync::LazyLock<Mutex<Inner>> = std::sync::LazyLock::new(|| Mutex::new(Inner::new()));

fn lock() -> std::sync::MutexGuard<'static, Inner> {
    STATE.lock().unwrap_or_else(|p| p.into_inner())
}

/// The catalog from what is held: Codex's own list first, with the file's
/// Codex models it doesn't name kept hidden (their levels still known —
/// finding 3); older versions of a family hidden (D2).
fn compose(inner: &Inner, claude_cli: &ClaudeCli) -> ModelCatalog {
    let file = inner.file.clone().unwrap_or_else(bundled);
    let (mut codex, codex_from_cli) = match &inner.codex_cli {
        Some(models) => {
            let mut all = models.clone();
            for m in &file.codex.models {
                if !all.iter().any(|x| x.id == m.id) {
                    all.push(CatalogModel { hidden: true, ..m.clone() });
                }
            }
            (VendorCatalog { efforts: file.codex.efforts.clone(), models: all }, true)
        }
        None => (file.codex, false),
    };
    let mut claude = file.claude;
    hide_older(&mut codex.models);
    hide_older(&mut claude.models);
    let (claude_effort, claude_effort_why) = claude_effort_state(claude_cli);
    ModelCatalog { claude, codex, codex_from_cli, file_from: inner.file_from, claude_effort, claude_effort_why }
}

fn claude_cli() -> ClaudeCli {
    crate::shell_env::try_get()
        .map(|env| ClaudeCli { installed: env.claude_path.is_some(), version: env.claude_version.clone() })
        .unwrap_or_default()
}

/// The catalog as it stands (the bundled copy before [`init`]).
pub fn current() -> ModelCatalog {
    let cli = claude_cli();
    compose(&lock(), &cli)
}

/// The spawn-time rule ([`ModelCatalog::fit`]) on the current catalog.
pub fn fit(vendor: &str, choice: crate::settings::ModelChoice) -> crate::settings::ModelChoice {
    current().fit(vendor, choice)
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// At start, after `shell_env::init`: the cached file now (a file read), and
/// the site and Codex in the background.
pub fn init<R: tauri::Runtime>(app: &tauri::AppHandle<R>, config_dir: PathBuf) {
    let (file, _) = load(&config_dir);
    let codex_record = read_cache(&config_dir).and_then(|r| r.codex);
    let codex_installed = codex_installed_now();
    {
        let mut inner = lock();
        if file.is_some() {
            inner.file = file;
            inner.file_from = "cache";
        }
        inner.adopt_codex_record(codex_record, codex_installed);
        inner.config_dir = Some(config_dir);
    }
    refresh_in_background(app);
}

/// Clears `busy` however the refresh thread ends (finding 12).
struct NotBusy;

impl Drop for NotBusy {
    fn drop(&mut self) {
        lock().busy = false;
    }
}

/// Reads Codex's list and asks the site, each when it is due, on its own
/// thread; tells the UI when anything changed. Never two at once.
pub fn refresh_in_background<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let (codex_due, site_dir) = {
        let version_now = codex_version_now();
        let auth_now = auth_stamp_now();
        let installed = codex_installed_now();
        let mut inner = lock();
        inner.forget_codex_if_gone(installed);
        let codex_due = inner.codex_due(now_millis(), version_now.as_deref(), auth_now);
        let site_dir = inner
            .config_dir
            .clone()
            .filter(|dir| read_cache(dir).unwrap_or_default().site_due(now_millis()));
        if inner.busy || (!codex_due && site_dir.is_none()) {
            return;
        }
        inner.busy = true;
        (codex_due, site_dir)
    };
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("model-catalog".into()).spawn(move || {
        use tauri::Emitter;
        let _not_busy = NotBusy;
        let before = current();
        // Taken before the read: a change landing during it reads again.
        let (version, auth_at) = (codex_version_now(), auth_stamp_now());
        let codex = codex_due.then(read_codex);
        let site = site_dir
            .as_deref()
            .and_then(|dir| refresh_site(dir, &crate::account::ReqwestHttp, now_millis()));
        let mut to_save = None;
        {
            let mut inner = lock();
            match codex {
                None | Some(CodexRead::Skipped) => {}
                Some(CodexRead::Failed) => inner.codex_read = Some((now_millis(), false)),
                Some(CodexRead::Good(models)) => {
                    let record = CodexRecord { read_at: now_millis(), version, auth_at, models };
                    inner.take_good_read(&record);
                    to_save = inner.config_dir.clone().map(|dir| (dir, record));
                }
            }
            if let Some(file) = site {
                inner.file = Some(file);
                inner.file_from = "site";
            }
        }
        if let Some((dir, record)) = to_save {
            save_codex_read(&dir, record);
        }
        let after = current();
        log::info!(
            "model catalog: Codex from {}, Claude from the {} file",
            if after.codex_from_cli { "codex debug models" } else { "file" },
            after.file_from
        );
        if after != before {
            let _ = app.emit(EVENT_CHANGED, &after);
        }
    });
    if spawned.is_err() {
        lock().busy = false;
    }
}

/// The catalog for the model menus. Also starts a refresh when one is due,
/// whose result arrives as [`EVENT_CHANGED`].
#[tauri::command]
pub fn model_catalog_get(app: tauri::AppHandle) -> ModelCatalog {
    refresh_in_background(&app);
    current()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::ModelChoice;

    fn choice(model: Option<&str>, effort: Option<&str>) -> ModelChoice {
        ModelChoice { model: model.map(Into::into), reasoning: effort.map(Into::into) }
    }

    fn claude(version: Option<&str>) -> ClaudeCli {
        ClaudeCli { installed: true, version: version.map(Into::into) }
    }

    fn with(codex_cli: Option<Vec<CatalogModel>>) -> ModelCatalog {
        compose(&Inner { codex_cli, ..Inner::new() }, &claude(Some("2.1.309")))
    }

    fn offered(v: &VendorCatalog) -> Vec<&str> {
        v.models.iter().filter(|m| !m.hidden).map(|m| m.id.as_str()).collect()
    }

    #[test]
    fn the_site_file_is_asked_for_on_www() {
        assert_eq!(SITE_URL, "https://www.plyloft.com/models.json");
    }

    #[test]
    fn the_bundled_copy_reads_and_names_both_vendors() {
        let file = parse_file(BUNDLED).expect("bundled models.json reads");
        assert_eq!(file.claude.efforts, ["low", "medium", "high", "xhigh", "max"]);
        assert!(!file.codex.efforts.iter().any(|e| e == "minimal"), "minimal is no longer offered");
        for m in &file.codex.models {
            assert!(m.efforts.as_ref().is_some_and(|e| !e.is_empty()), "{} lists its efforts", m.id);
        }
        assert_eq!(bundled(), file, "read once, the same");
    }

    /// Owner D2: only the newest of each family is offered, from the file
    /// and from Codex's own list alike.
    #[test]
    fn the_menus_offer_only_the_newest_of_each_family() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../src/lib/modelFamilies.fixtures.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let ids: Vec<String> = serde_json::from_value(case["ids"].clone()).unwrap();
            let latest: Vec<String> = serde_json::from_value(case["latest"].clone()).unwrap();
            assert_eq!(latest_per_family(&ids), latest, "{ids:?}");
        }
        let catalog = with(None);
        assert_eq!(
            offered(&catalog.claude),
            ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"]
        );
        assert_eq!(offered(&catalog.codex), ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-terra"]);
        // Older versions stay known: their levels still decide at spawn.
        assert_eq!(
            catalog.fit("codex", choice(Some("gpt-5.6-luna"), Some("ultra"))),
            choice(Some("gpt-5.6-luna"), None)
        );
    }

    #[test]
    fn a_file_of_another_schema_version_or_garbage_is_not_read() {
        assert!(parse_file(r#"{"schemaVersion":2,"vendors":{}}"#).is_none());
        assert!(parse_file(r#"{"vendors":{}}"#).is_none());
        assert!(parse_file("<html>404</html>").is_none());
        let lenient = parse_file(
            r#"{"schemaVersion":1,"future":true,"vendors":{"claude":{"models":[{"label":"no id"},{"id":"opus"},{"id":"opus"}]}}}"#,
        )
        .unwrap();
        assert_eq!(lenient.claude.models.len(), 1);
        assert_eq!(lenient.claude.models[0].label, "opus", "label falls back to the id");
        assert_eq!(lenient.claude.models[0].efforts, None);
        assert_eq!(lenient.codex, VendorCatalog::default());
    }

    #[test]
    fn codex_debug_models_is_read_field_by_field() {
        let stdout = r#"{"models":[
            {"slug":"gpt-6-astra","display_name":"GPT-6-Astra","visibility":"list","default_reasoning_level":"medium",
             "supported_reasoning_levels":[{"effort":"low","description":"x"},{"effort":"ultra"}],"base_instructions":"…"},
            {"slug":"gpt-reserve","display_name":"GPT-Reserve","visibility":"hide","supported_reasoning_levels":[{"effort":"max"}]},
            {"display_name":"no slug","visibility":"list"},
            {"slug":"plain","supported_reasoning_levels":["low","high"]},
            {"slug":"odd","supported_reasoning_levels":"high"}
        ]}"#;
        let models = parse_codex_debug_models(stdout).unwrap();
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["gpt-6-astra", "gpt-reserve", "plain", "odd"]);
        assert_eq!(models[0].label, "GPT-6-Astra");
        assert_eq!(models[0].efforts.as_deref().unwrap(), ["low", "ultra"]);
        assert_eq!(models[0].default_effort.as_deref(), Some("medium"));
        assert!(models[1].hidden && !models[0].hidden && !models[2].hidden);
        assert_eq!(models[2].efforts.as_deref().unwrap(), ["low", "high"]);
        assert_eq!(models[3].efforts, None, "a shape it can't read is support unknown");
        assert_eq!(parse_codex_debug_models("error: unknown command"), None);
        assert_eq!(parse_codex_debug_models(r#"{"models":[]}"#), None);
        assert_eq!(parse_codex_debug_models(r#"{"models":[{"slug":"x","visibility":"hide"}]}"#), None);
        assert_eq!(parse_codex_debug_models(r#"{"data":[{"slug":"x"}]}"#), None);
    }

    #[test]
    fn an_effort_that_cannot_run_passes_no_flag() {
        let catalog = with(None);
        // A saved "minimal" on a listed model: not passed, the model's own default runs.
        assert_eq!(catalog.fit("codex", choice(Some("gpt-6-astra"), Some("minimal"))), choice(Some("gpt-6-astra"), None));
        assert_eq!(catalog.fit("codex", choice(Some("gpt-6-luna"), Some("ultra"))), choice(Some("gpt-6-luna"), None));
        // Supported: kept.
        assert_eq!(
            catalog.fit("codex", choice(Some("gpt-6-astra"), Some("xhigh"))),
            choice(Some("gpt-6-astra"), Some("xhigh"))
        );
        // Unknown model: passed as before.
        assert_eq!(catalog.fit("codex", choice(Some("gpt-5.5"), Some("minimal"))), choice(Some("gpt-5.5"), Some("minimal")));
        // Finding 2: no model and a level the vendor doesn't take: dropped; one it takes: kept.
        assert_eq!(catalog.fit("codex", choice(None, Some("minimal"))), choice(None, None));
        assert_eq!(catalog.fit("codex", choice(None, Some("high"))), choice(None, Some("high")));
        // A Claude model whose levels aren't listed: passed.
        assert_eq!(
            catalog.fit("claude", choice(Some("claude-opus-5-5"), Some("max"))),
            choice(Some("claude-opus-5-5"), Some("max"))
        );
        assert_eq!(catalog.fit("claude", choice(Some("opus"), None)), choice(Some("opus"), None));
    }

    /// Finding 1: `--effort` only on a Claude Code known to take every level.
    #[test]
    fn claude_effort_needs_a_claude_code_that_takes_it() {
        assert_eq!(MIN_CLAUDE_VERSION_EFFORT, (2, 1, 111));
        assert!(claude_supports_effort(Some("2.1.309")));
        assert!(claude_supports_effort(Some("2.1.111")));
        assert!(!claude_supports_effort(Some("2.1.110")));
        assert!(!claude_supports_effort(None));
        let cases = [
            (claude(Some("2.1.309")), true, None),
            (claude(Some("2.1.72")), false, Some("tooOld")),
            (claude(None), false, Some("versionUnknown")),
            (claude(Some("garbage")), false, Some("versionUnknown")),
            (ClaudeCli::default(), false, Some("notInstalled")),
        ];
        for (cli, passes, why) in cases {
            let version = cli.version.clone();
            let catalog = compose(&Inner::new(), &cli);
            assert_eq!(catalog.claude_effort, passes);
            assert_eq!(catalog.claude_effort_why, why);
            let fitted = catalog.fit("claude", choice(Some("opus"), Some("high")));
            assert_eq!(fitted.reasoning.is_some(), passes, "{version:?}");
            assert_eq!(fitted.model.as_deref(), Some("opus"));
            // Codex never depends on it.
            assert_eq!(
                catalog.fit("codex", choice(Some("gpt-6-astra"), Some("high"))).reasoning.as_deref(),
                Some("high")
            );
        }
    }

    /// Finding 3: Codex's own list first; a file model it doesn't name stays
    /// known (hidden), and hidden entries' levels count too.
    #[test]
    fn codex_s_own_list_leads_and_the_file_s_levels_stay_known() {
        let cli = parse_codex_debug_models(
            r#"{"models":[{"slug":"gpt-9-sol","visibility":"list","supported_reasoning_levels":[{"effort":"low"}]},
                          {"slug":"gpt-8-sol","visibility":"list","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}]},
                          {"slug":"gpt-reserve","visibility":"hide","supported_reasoning_levels":[{"effort":"max"}]}]}"#,
        );
        let catalog = with(cli);
        assert!(catalog.codex_from_cli);
        assert_eq!(catalog.codex.efforts, bundled().codex.efforts);
        // gpt-9-sol beats gpt-8-sol; the file's gpt-6.1-sol is not in Codex's list.
        assert_eq!(offered(&catalog.codex), ["gpt-9-sol"]);
        assert_eq!(catalog.fit("codex", choice(Some("gpt-9-sol"), Some("high"))), choice(Some("gpt-9-sol"), None));
        assert_eq!(catalog.fit("codex", choice(Some("gpt-8-sol"), Some("high"))), choice(Some("gpt-8-sol"), Some("high")));
        assert_eq!(catalog.fit("codex", choice(Some("gpt-reserve"), Some("low"))), choice(Some("gpt-reserve"), None));
        // The file's model missing from Codex's list: its levels from the file.
        assert_eq!(catalog.fit("codex", choice(Some("gpt-6-luna"), Some("ultra"))), choice(Some("gpt-6-luna"), None));
    }

    const DAY_MS: i64 = 24 * 60 * 60 * 1000;
    const HOUR_MS: i64 = 60 * 60 * 1000;

    #[test]
    fn codex_is_read_daily_and_retried_soon_after_a_failure() {
        let now = 10 * DAY_MS;
        let mut inner = Inner::new();
        assert!(inner.codex_due(now, None, None));
        inner.codex_read = Some((now, true));
        assert!(!inner.codex_due(now, None, None));
        inner.codex_read = Some((now - CODEX_EVERY.as_millis() as i64, true));
        assert!(inner.codex_due(now, None, None));
        inner.codex_read = Some((now, false));
        assert!(!inner.codex_due(now, None, None));
        inner.codex_read = Some((now - CODEX_RETRY.as_millis() as i64, false));
        assert!(inner.codex_due(now, None, None));
        // A clock that went back reads again.
        inner.codex_read = Some((now + HOUR_MS, true));
        assert!(inner.codex_due(now, None, None));
    }

    fn sol() -> Vec<CatalogModel> {
        vec![CatalogModel { id: "gpt-9-sol".into(), label: "GPT-9 Sol".into(), efforts: None, default_effort: None, hidden: false }]
    }

    /// 1.176.2 (known item 3): a good read is kept in `model_catalog.json`,
    /// so a start within the day runs no `codex debug models` and still
    /// offers Codex's own list; a day later, or once Codex's version
    /// changed, it is read again.
    #[test]
    fn a_good_codex_read_lasts_a_day_across_starts() {
        let dir = tempfile::tempdir().unwrap();
        let now = 10 * DAY_MS;
        save_codex_read(dir.path(), CodexRecord { read_at: now - HOUR_MS, version: Some("0.130.0".into()), auth_at: None, models: sol() });
        assert!(!dir.path().join(format!("{CACHE_FILE}{}", crate::atomic::TEMP_SUFFIX)).exists());

        // The next start (what `init` does with the file).
        let start = |codex_installed: bool| {
            let mut inner = Inner::new();
            inner.adopt_codex_record(read_cache(dir.path()).and_then(|r| r.codex), codex_installed);
            inner
        };
        let inner = start(true);
        assert!(!inner.codex_due(now, Some("0.130.0"), None), "read an hour ago: no read at this start");
        assert!(compose(&inner, &claude(Some("2.1.309"))).codex_from_cli, "Codex's own list, from the file");
        assert!(inner.codex_due(now, Some("0.131.0"), None), "Codex changed version: read again");
        assert!(inner.codex_due(now - HOUR_MS + DAY_MS, Some("0.130.0"), None), "a day after the read: read again");
        // Codex gone: its kept list isn't offered, and a read is due.
        let gone = start(false);
        assert!(gone.codex_cli.is_none());
        assert!(gone.codex_due(now, None, None));
    }

    /// REV-R4 F3: a changed sign-in file (its modification time only) makes
    /// a read due; one that can't be read changes nothing. A temp folder
    /// stands in for the Codex home.
    #[test]
    fn a_changed_codex_sign_in_makes_a_read_due() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(auth_stamp(home.path()), None, "no auth.json: nothing read");
        let auth = home.path().join("auth.json");
        std::fs::write(&auth, "{}").unwrap();
        let file = std::fs::File::options().write(true).open(&auth).unwrap();
        let first = std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        file.set_modified(first).unwrap();
        let stamp = auth_stamp(home.path()).expect("its modification time");
        assert_eq!(stamp, 1_700_000_000_000);

        let now = 10 * DAY_MS;
        let mut inner = Inner::new();
        inner.take_good_read(&CodexRecord { read_at: now, version: None, auth_at: Some(stamp), models: sol() });
        assert!(!inner.codex_due(now, None, auth_stamp(home.path())), "same sign-in: no read");
        assert!(!inner.codex_due(now, None, None), "a stat that fails changes nothing");
        file.set_modified(first + Duration::from_secs(60)).unwrap();
        assert!(inner.codex_due(now, None, auth_stamp(home.path())), "signed in again: read");
    }

    /// REV-R4 F3: Codex removed while Plyloft is open: its list goes.
    #[test]
    fn a_removed_codex_stops_offering_its_list() {
        let mut inner = Inner::new();
        inner.take_good_read(&CodexRecord { read_at: 5, version: None, auth_at: None, models: sol() });
        inner.forget_codex_if_gone(true);
        assert!(compose(&inner, &claude(Some("2.1.309"))).codex_from_cli, "still installed: kept");
        inner.forget_codex_if_gone(false);
        assert!(!compose(&inner, &claude(Some("2.1.309"))).codex_from_cli);
        assert!(inner.codex_due(5, None, None));
    }

    /// The site part and the Codex part of the file keep each other.
    #[test]
    fn the_site_ask_and_the_codex_read_keep_each_other() {
        let dir = tempfile::tempdir().unwrap();
        let record = CodexRecord { read_at: 7, version: None, auth_at: Some(3), models: sol() };
        save_codex_read(dir.path(), record.clone());
        assert!(refresh_site(dir.path(), &http(200, SITE), 1_000).is_some());
        assert_eq!(read_cache(dir.path()).unwrap().codex, Some(record.clone()));
        let site_file = load(dir.path());
        save_codex_read(dir.path(), CodexRecord { read_at: 8, ..record });
        assert_eq!(load(dir.path()), site_file);
    }

    /// The cache as 1.176.1 wrote and read it (before the `codex` field).
    #[derive(Debug, Default, Serialize, Deserialize)]
    #[serde(default, rename_all = "camelCase")]
    struct CacheRecord1761 {
        checked_at: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        fetched_at: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        catalog: Option<Value>,
    }

    /// Persisted field migration (1.176.2): a file written by 1.176.1 loads
    /// here with no Codex read kept, and one written by this build loads in
    /// 1.176.1's struct with its site part intact.
    #[test]
    fn the_cache_file_reads_both_ways_across_1_176_1() {
        let old = serde_json::to_string(&CacheRecord1761 {
            checked_at: 5,
            fetched_at: Some(5),
            catalog: Some(serde_json::from_str(SITE).unwrap()),
        })
        .unwrap();
        let read: CacheRecord = serde_json::from_str(&old).unwrap();
        assert_eq!((read.checked_at, read.fetched_at), (5, Some(5)));
        assert!(read.catalog.as_ref().and_then(parse_file_value).is_some());
        assert_eq!(read.codex, None);

        let new = serde_json::to_string(&CacheRecord {
            codex: Some(CodexRecord { read_at: 9, version: Some("0.130.0".into()), auth_at: Some(4), models: sol() }),
            ..read
        })
        .unwrap();
        assert!(new.contains("\"codex\":{\"readAt\":9"), "{new}");
        assert!(new.contains("\"authAt\":4"), "{new}");
        let back: CacheRecord1761 = serde_json::from_str(&new).unwrap();
        assert_eq!((back.checked_at, back.fetched_at), (5, Some(5)));
        assert!(back.catalog.as_ref().and_then(parse_file_value).is_some());
    }

    struct FakeHttp {
        status: u16,
        body: String,
        asked: std::sync::atomic::AtomicUsize,
    }

    impl crate::account::Http for FakeHttp {
        fn send(&self, req: &crate::account::HttpRequest) -> Result<crate::account::HttpResponse, String> {
            assert_eq!(req.url, SITE_URL);
            self.asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.status == 0 {
                return Err("offline".into());
            }
            Ok(crate::account::HttpResponse::new(self.status, self.body.clone()))
        }
    }

    fn http(status: u16, body: &str) -> FakeHttp {
        FakeHttp { status, body: body.into(), asked: Default::default() }
    }

    fn asked(h: &FakeHttp) -> usize {
        h.asked.load(std::sync::atomic::Ordering::SeqCst)
    }

    const SITE: &str =
        r#"{"schemaVersion":1,"vendors":{"claude":{"efforts":["low"],"models":[{"id":"newest","label":"Newest"}]}}}"#;

    #[test]
    fn a_404_or_no_network_keeps_the_bundled_copy_and_retries_in_an_hour() {
        let dir = tempfile::tempdir().unwrap();
        for fake in [http(404, "Not found"), http(0, ""), http(200, "<html>"), http(200, r#"{"schemaVersion":7}"#)] {
            let _ = std::fs::remove_file(dir.path().join(CACHE_FILE));
            assert_eq!(refresh_site(dir.path(), &fake, 1_000), None);
            assert_eq!(asked(&fake), 1);
            let (file, checked) = load(dir.path());
            assert_eq!(file, None, "nothing cached: the bundled copy is used");
            assert_eq!(checked, 1_000);
            // Within the hour it isn't asked again; after it, it is.
            assert_eq!(refresh_site(dir.path(), &fake, 1_000 + SITE_RETRY_MS - 1), None);
            assert_eq!(asked(&fake), 1);
            assert_eq!(refresh_site(dir.path(), &fake, 1_000 + SITE_RETRY_MS), None);
            assert_eq!(asked(&fake), 2);
        }
        let too_big = http(200, &format!(r#"{{"schemaVersion":1,"pad":"{}"}}"#, "x".repeat(SITE_MAX_BYTES)));
        let _ = std::fs::remove_file(dir.path().join(CACHE_FILE));
        assert_eq!(refresh_site(dir.path(), &too_big, 1_000), None);
    }

    #[test]
    fn a_good_answer_is_cached_kept_a_day_and_survives_a_later_failure() {
        let dir = tempfile::tempdir().unwrap();
        let good = http(200, SITE);
        let file = refresh_site(dir.path(), &good, 1_000).expect("read");
        assert_eq!(file.claude.models[0].id, "newest");
        assert!(!dir.path().join(format!("{CACHE_FILE}{}", crate::atomic::TEMP_SUFFIX)).exists());
        assert_eq!(load(dir.path()).0, Some(file.clone()));
        // An hour later: still not asked (a good answer lasts a day).
        assert_eq!(refresh_site(dir.path(), &good, 1_000 + SITE_RETRY_MS), None);
        assert_eq!(asked(&good), 1);
        // A day later the site is down: the cached file stays.
        let down = http(503, "");
        assert_eq!(refresh_site(dir.path(), &down, 1_000 + SITE_EVERY_MS), None);
        assert_eq!(asked(&down), 1);
        let (cached, checked) = load(dir.path());
        assert_eq!(cached, Some(file));
        assert_eq!(checked, 1_000 + SITE_EVERY_MS);
    }

    #[test]
    fn a_damaged_cache_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(CACHE_FILE), "{not json").unwrap();
        assert_eq!(load(dir.path()), (None, 0));
        std::fs::write(dir.path().join(CACHE_FILE), r#"{"checkedAt":5,"catalog":{"schemaVersion":3}}"#).unwrap();
        assert_eq!(load(dir.path()), (None, 5));
    }

    /// Finding 12: `busy` is cleared however the refresh thread ends.
    #[test]
    fn busy_is_cleared_by_the_guard() {
        lock().busy = true;
        drop(NotBusy);
        assert!(!lock().busy);
    }
}
