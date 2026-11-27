//! 1.173.0 (B1): areas — one repository, several products.
//!
//! An area is a part of the repository that ships on its own: its folder,
//! the branch its cards go to, the files that carry its version, the prefix
//! of its release tags, its board label and "Where to look at it" (a URL
//! Next improvement opens). Areas are a shared field of the workspace
//! definition (`.atelier/workspace.json` → `areas`, [`AreaDef`]), published
//! and read like every other one ("read live, repo wins"). They publish as a
//! whole list: two Macs changing them at once, the last writer wins and the
//! other is named in the commit (a merge per area may come later).
//!
//! **No areas, no change.** An absent `areas` (every repository before
//! 1.173.0) or an empty list is one *implicit* area: the whole repository
//! with the workspace's own values. It has no id — the resolution functions
//! take `None` for it, and E1 names its files [`IMPLICIT_AREA_ID`] — and
//! nothing about it is ever written: no `areas` key in the definition, no
//! `areas.json` on this Mac. An older Plyloft keeps `areas` as an unknown key
//! and ignores it: its cards go to the workspace's integration branch.
//!
//! **Rules** ([`check`]): ids are unique slugs, not [`RESERVED_IDS`]; at most
//! one area is the root (`path` "" or "/": the whole repository except the
//! other areas' folders); the other folders don't overlap; labels and tag
//! prefixes are unique; branches are git branch names and "Where to look at
//! it" is a web address. Version files outside the area's folder are a
//! warning only.
//!
//! **A list that breaks them** never makes the definition unreadable: the
//! field reads as [`AreasField::Invalid`] (kept as a JSON value, so a
//! publish of any other field writes the same value back), the refresh records the
//! problem (`DefinitionCache::field_problems`), applies every other field and
//! keeps this Mac's last good areas. A Mac with no good copy is *held*
//! ([`AreasView::held`], [`AreaConfig::Held`]): B3/B4 refuse to start, ship
//! or release any card until a valid list is published — never the implicit
//! area in its place. The editor refuses to save a list with errors.
//!
//! **Tags** (PLAN decision 4, the default only): an explicit `tagPrefix`
//! wins wherever the area is in the list, "" included; without one the
//! first area is tagged `vX.Y.Z` and every other one `<id>-vX.Y.Z`. Settings
//! (B5) writes the resolved prefix on save, so reordering never retags.
//! [`release_version`] reads a tag back strictly.
//!
//! **This Mac.** `projects/<ws>/areas.json` (atomic, one writer at a time)
//! holds the areas as this Mac last read them, kept in step by every
//! definition refresh — the store a card start or a Ship reads without git.
//!
//! **Until you share (1.174.0, C10, D6).** On a workspace that shares no
//! setup, Settings › Areas saves the list here (`source: "local"`,
//! [`save_local`]) and it decides: cards start, ship and release in those
//! areas. A file the repository's areas last wrote (a setup no longer
//! shared) still decides nothing ([`for_workspace`]). Share puts the list
//! in its own `chore(config)` commit of `.atelier/workspace.json` (as does
//! a legacy file's conversion). When the setup comes in with other areas —
//! another computer shared first — this Mac's list is set aside
//! ([`reconcile_shared`]: `areas.set-aside-<ms>.json`, kept until answered)
//! and the repository's apply; the Board asks "Use the repository's" (writes
//! nothing) or "Publish mine" (an ordinary edit of the shared field).

// The resolution API (`area_of_path`, `resolve_config`, `for_workspace`) is
// the foundation B2–B4 build on; until they call it, only tests do.
#![cfg_attr(not(test), allow(dead_code))]

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

use crate::project_config::{ProjectConfig, ProjectConfigStore, VersionFileEntry};

const FILE: &str = "areas.json";
const SCHEMA_VERSION: u32 = 1;
/// The longest id: it becomes part of tags, branch names and labels.
pub const ID_MAX: usize = 40;
/// GitHub's limit on a label's name.
pub const LABEL_MAX: usize = 50;
/// The implicit area's name where a file needs one
/// (`.atelier/next-improvement/default.json`, E1).
pub const IMPLICIT_AREA_ID: &str = "default";
/// Ids no area may take: the picker's *All*, and the implicit area's name.
pub const RESERVED_IDS: [&str; 2] = ["all", IMPLICIT_AREA_ID];
/// Label prefixes that are Plyloft's own (`status:…`, `plyloft:skill`).
const RESERVED_LABEL_PREFIXES: [&str; 2] = ["status:", "plyloft:"];

/// One area, as `.atelier/workspace.json` writes it (camelCase). Every field
/// after `path` is optional and falls back to the workspace's value
/// ([`resolve_config`]); unknown keys are kept, so an area written by a newer
/// Plyloft survives a rewrite here.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AreaDef {
    /// Lowercase letters, digits and dashes; stable — cards keep it.
    pub id: String,
    /// What the picker and the sheets say ("Site"); empty reads as the id.
    #[serde(default)]
    pub name: String,
    /// The folder, **from the repository root** ("lyrappc-astro"), whatever
    /// folder the workspace was opened on; "" or "/" is the root area: the
    /// whole repository except the other areas' folders.
    #[serde(default)]
    pub path: String,
    /// Where its cards go; absent = the workspace's integration branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_branch: Option<String>,
    /// The files that carry its version; absent = the workspace's. Their
    /// paths are **from the workspace's folder**, like the workspace's own
    /// `versionFiles` ([`repo_path`] turns one into a repository path).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_files: Option<Vec<VersionFileEntry>>,
    /// Its release tags' prefix; it wins wherever the area is listed.
    /// Absent = "" for the first area, `<id>-` for every other one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag_prefix: Option<String>,
    /// Its board label; absent = `area:<id>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// "Where to look at it": the web address Next improvement opens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub look_at: Option<String>,
    /// 1.173.0 (G1): how a release of this area goes by default — where
    /// Release… and Ship batch start (Settings › Shipping). Absent = not
    /// chosen (they start on this Mac only). Kept as written, like
    /// `Workspace.shipVia`: a kind a later Plyloft adds survives a publish
    /// here, and the readers take only the kinds they know (`local`,
    /// `push_only`, `github`). A value of the wrong type reads as absent.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::project_config::lenient_opt"
    )]
    pub release_kind: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// The definition's `areas` as read: a list that keeps the rules, or the raw
/// value of one that doesn't (a wrong type, or a [`check`] error) with the
/// first reason. Written back as the same JSON value — every key and value
/// kept; like the rest of the file, its formatting and key order are
/// Plyloft's own.
#[derive(Debug, Clone, PartialEq)]
pub enum AreasField {
    Valid(Vec<AreaDef>),
    Invalid { raw: Value, problem: String },
}

impl AreasField {
    /// `raw`, read and checked.
    pub fn from_value(raw: Value) -> Self {
        match serde_json::from_value::<Vec<AreaDef>>(raw.clone()) {
            Ok(list) => match check(&list).errors.into_iter().next() {
                None => AreasField::Valid(list),
                Some(problem) => AreasField::Invalid { raw, problem: problem.message },
            },
            Err(error) => AreasField::Invalid {
                raw,
                problem: format!("The areas aren't a list Plyloft can read ({error})."),
            },
        }
    }

    pub fn valid(&self) -> Option<&[AreaDef]> {
        match self {
            AreasField::Valid(list) => Some(list),
            AreasField::Invalid { .. } => None,
        }
    }

    pub fn problem(&self) -> Option<&str> {
        match self {
            AreasField::Valid(_) => None,
            AreasField::Invalid { problem, .. } => Some(problem),
        }
    }
}

impl From<Vec<AreaDef>> for AreasField {
    fn from(list: Vec<AreaDef>) -> Self {
        AreasField::Valid(list)
    }
}

impl Serialize for AreasField {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            AreasField::Valid(list) => list.serialize(serializer),
            AreasField::Invalid { raw, .. } => raw.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for AreasField {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(AreasField::from_value(Value::deserialize(deserializer)?))
    }
}

/// A repository-relative folder as areas compare them: forward slashes, no
/// leading `./` or `/`, no trailing `/`, no empty components. "" is the root.
pub fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
        .split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/")
}

/// A version file's path (from the workspace's folder) as a path from the
/// repository root, for a workspace opened on `workspace_prefix` (git's
/// `--show-prefix`, "" at the root).
pub fn repo_path(workspace_prefix: &str, workspace_relative: &str) -> String {
    normalize_path(&format!("{workspace_prefix}/{workspace_relative}"))
}

fn trimmed(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

impl AreaDef {
    /// Every value in the form two copies compare in: trimmed, the folder
    /// normalized, an empty optional text read as absent. A tag prefix keeps
    /// an explicit "" (it means "tagged vX.Y.Z").
    pub fn normalized(&self) -> Self {
        Self {
            id: self.id.trim().to_string(),
            name: self.name.trim().to_string(),
            path: normalize_path(&self.path),
            target_branch: trimmed(&self.target_branch),
            version_files: self.version_files.clone(),
            tag_prefix: self.tag_prefix.as_deref().map(|p| p.trim().to_string()),
            label: trimmed(&self.label),
            look_at: trimmed(&self.look_at),
            release_kind: self.release_kind.clone(),
            extra: self.extra.clone(),
        }
    }

    pub fn is_root(&self) -> bool {
        normalize_path(&self.path).is_empty()
    }

    /// The name, or the id when it has none.
    pub fn display_name(&self) -> String {
        let name = self.name.trim();
        if name.is_empty() { self.id.trim().to_string() } else { name.to_string() }
    }
}

/// The list as the definition compares it: each area normalized.
pub fn normalized(areas: &[AreaDef]) -> Vec<AreaDef> {
    areas.iter().map(AreaDef::normalized).collect()
}

/// `area:<id>`.
pub fn default_label(id: &str) -> String {
    format!("area:{}", id.trim())
}

/// The tag prefix of the area at `index`: its own wherever it is listed;
/// without one, "" for the first area (`vX.Y.Z`) and `<id>-` for the others.
pub fn tag_prefix_at(areas: &[AreaDef], index: usize) -> String {
    let Some(area) = areas.get(index) else {
        return String::new();
    };
    match area.tag_prefix.as_deref().map(str::trim) {
        Some(prefix) => prefix.to_string(),
        None if index == 0 => String::new(),
        None => format!("{}-", area.id.trim()),
    }
}

/// A release tag: `<prefix>v1.2.3`.
pub fn tag_for(prefix: &str, version: &str) -> String {
    format!("{prefix}v{version}")
}

/// The version a tag carries for `prefix`, read strictly
/// (`^<prefix>v\d+\.\d+\.\d+$`): `vendor-v1.0.0` is no tag of the first
/// area's (prefix ""), and `site-v1.0.0-rc1` is no release of the site's.
pub fn release_version(prefix: &str, tag: &str) -> Option<String> {
    let version = tag.strip_prefix(prefix)?.strip_prefix('v')?;
    let parts: Vec<&str> = version.split('.').collect();
    (parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())))
        .then(|| version.to_string())
}

// ── Rules ──────────────────────────────────────────────────────────────

/// One thing [`check`] found. `area` is the id it is about (absent for the
/// list as a whole); `field` the camelCase key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AreaProblem {
    #[serde(default)]
    pub area: Option<String>,
    pub field: String,
    pub message: String,
}

/// Errors refuse the list (a held field, a refused save); warnings are said
/// and the list stands.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AreaCheck {
    pub errors: Vec<AreaProblem>,
    pub warnings: Vec<AreaProblem>,
}

impl AreaCheck {
    pub fn ok(&self) -> bool {
        self.errors.is_empty()
    }
}

fn problem(area: Option<&str>, field: &str, message: String) -> AreaProblem {
    AreaProblem { area: area.map(str::to_string), field: field.to_string(), message }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= ID_MAX
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !id.starts_with('-')
        && !id.ends_with('-')
}

/// A folder no area may name: one that climbs out of the repository, a
/// drive, a network share or a NUL.
fn valid_path(raw: &str) -> bool {
    let text = raw.trim();
    let bytes = text.as_bytes();
    let path = normalize_path(text);
    !text.contains('\0')
        && !text.starts_with("\\\\")
        && !text.starts_with("//")
        && !path.split('/').any(|part| part == "..")
        && !(bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic())
}

/// git's rules for a ref name's components (`git check-ref-format`), pure.
fn valid_ref_parts(name: &str) -> bool {
    !name.is_empty()
        && name != "@"
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.ends_with('.')
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("@{")
        && !name
            .chars()
            .any(|c| c.is_control() || c == ' ' || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
        && name.split('/').all(|part| !part.starts_with('.') && !part.ends_with(".lock"))
}

/// A branch name git takes (`git check-ref-format --branch`).
pub fn valid_branch(name: &str) -> bool {
    valid_ref_parts(name) && !name.starts_with('-')
}

/// A tag prefix git takes in a tag and in `plyloft/release-<prefix>v…`.
fn valid_tag_prefix(prefix: &str) -> bool {
    prefix.is_empty()
        || (prefix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/'))
            && !prefix.starts_with(['-', '.', '/'])
            && valid_ref_parts(&format!("{prefix}v1"))
            && prefix.split('/').all(|part| !part.ends_with(".lock")))
}

pub(crate) fn valid_web_address(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    ["https://", "http://"]
        .iter()
        .any(|scheme| lower.starts_with(scheme) && url.len() > scheme.len() && !url.contains(char::is_whitespace))
}

/// `file` (repository-relative) is inside `folder` ("" holds everything).
pub fn path_in(folder: &str, file: &str) -> bool {
    let folder = normalize_path(folder);
    let file = normalize_path(file);
    folder.is_empty() || file == folder || file.starts_with(&format!("{folder}/"))
}

/// The folder as a sheet writes it: "lyrappc-astro/", or the root's words.
pub fn folder_words(path: &str) -> String {
    let path = normalize_path(path);
    if path.is_empty() {
        "the whole repository".to_string()
    } else {
        format!("{path}/")
    }
}

/// The rules of the module header, for a workspace at the repository root.
pub fn check(areas: &[AreaDef]) -> AreaCheck {
    check_in(areas, "")
}

/// [`check`] for a workspace opened on `workspace_prefix` (git's
/// `--show-prefix`): version files are read from there. Only warnings
/// depend on it.
pub fn check_in(areas: &[AreaDef], workspace_prefix: &str) -> AreaCheck {
    let mut out = AreaCheck::default();
    let list = normalized(areas);
    let mut ids = BTreeSet::new();
    let mut labels: BTreeMap<String, String> = BTreeMap::new();
    let mut prefixes: BTreeMap<String, String> = BTreeMap::new();
    let mut root: Option<String> = None;
    for (index, (area, raw)) in list.iter().zip(areas).enumerate() {
        let id = area.id.as_str();
        let name = area.display_name();
        if !valid_id(id) {
            out.errors.push(problem(
                Some(id),
                "id",
                format!(
                    "“{name}” can't be an area's name: use lowercase letters, digits and dashes, up to {ID_MAX}."
                ),
            ));
        } else if RESERVED_IDS.contains(&id) {
            out.errors.push(problem(Some(id), "id", format!("“{id}” is a word Plyloft keeps for itself: give the area another name.")));
        } else if !ids.insert(id.to_string()) {
            out.errors.push(problem(Some(id), "id", format!("Two areas are called “{name}”: each needs its own name.")));
        }
        if !valid_path(&raw.path) {
            out.errors.push(problem(
                Some(id),
                "path",
                format!("{name}'s folder “{}” isn't a folder of this repository.", raw.path.trim()),
            ));
        }
        if area.is_root() {
            match &root {
                Some(first) => out.errors.push(problem(
                    Some(id),
                    "path",
                    format!("{first} and {name} both take the whole repository: only one area can."),
                )),
                None => root = Some(name.clone()),
            }
        }
        if let Some(branch) = &area.target_branch {
            if !valid_branch(branch) {
                out.errors.push(problem(
                    Some(id),
                    "targetBranch",
                    format!("{name}'s cards can't go to “{branch}”: it isn't a branch name git takes."),
                ));
            }
        }
        let label = area.label.clone().unwrap_or_else(|| default_label(id));
        let lower = label.to_lowercase();
        if label.chars().count() > LABEL_MAX || label.contains(',') {
            out.errors.push(problem(
                Some(id),
                "label",
                format!("{name}'s board label “{label}” must be up to {LABEL_MAX} characters, without commas."),
            ));
        } else if RESERVED_LABEL_PREFIXES.iter().any(|p| lower.starts_with(p)) {
            out.errors.push(problem(
                Some(id),
                "label",
                format!("{name}'s board label “{label}” is one Plyloft uses for its own: choose another."),
            ));
        } else if let Some(other) = labels.insert(lower, name.clone()) {
            out.errors.push(problem(
                Some(id),
                "label",
                format!("{other} and {name} have the same board label, {label}."),
            ));
        }
        let prefix = tag_prefix_at(&list, index);
        if !valid_tag_prefix(&prefix) {
            out.errors.push(problem(
                Some(id),
                "tagPrefix",
                format!("{name}'s tag prefix “{prefix}” can't start a release tag: use letters, digits, dashes, dots or slashes."),
            ));
        } else if let Some(other) = prefixes.insert(prefix.clone(), name.clone()) {
            out.errors.push(problem(
                Some(id),
                "tagPrefix",
                format!("{other} and {name} would tag their releases the same way ({prefix}v1.0.0)."),
            ));
        }
        if let Some(url) = &area.look_at {
            if !valid_web_address(url) {
                out.errors.push(problem(
                    Some(id),
                    "lookAt",
                    format!("Where to look at {name} must be a web address (https://…), not “{url}”."),
                ));
            }
        }
    }
    if !list.is_empty() && !prefixes.contains_key("") {
        out.warnings.push(problem(None, "tagPrefix", "No area's releases are tagged plain v1.2.3: every release tag has a prefix.".to_string()));
    }
    // Folders: none inside another, except the root that holds the rest.
    for (i, a) in list.iter().enumerate() {
        for b in list.iter().skip(i + 1) {
            if a.is_root() || b.is_root() {
                continue;
            }
            if path_in(&a.path, &b.path) || path_in(&b.path, &a.path) {
                out.errors.push(problem(
                    Some(&b.id),
                    "path",
                    format!(
                        "{} ({}) and {} ({}) overlap: a file can belong to one area only.",
                        a.display_name(),
                        folder_words(&a.path),
                        b.display_name(),
                        folder_words(&b.path)
                    ),
                ));
            }
        }
    }
    // Version files: inside the area's own folder (warn, don't refuse).
    for (index, area) in list.iter().enumerate() {
        let name = area.display_name();
        match &area.version_files {
            Some(files) => {
                for file in files {
                    let in_repo = repo_path(workspace_prefix, &file.path);
                    if area_index_of_path(&list, &in_repo) != Some(index) {
                        out.warnings.push(problem(
                            Some(&area.id),
                            "versionFiles",
                            format!("{in_repo} is outside {name}'s folder ({}).", folder_words(&area.path)),
                        ));
                    }
                }
            }
            None if index > 0 => out.warnings.push(problem(
                Some(&area.id),
                "versionFiles",
                format!("{name} has no version file of its own, so a release would change the whole repository's version."),
            )),
            None => {}
        }
    }
    out
}

// ── Which area a file is in ────────────────────────────────────────────

fn area_index_of_path(areas: &[AreaDef], path: &str) -> Option<usize> {
    let file = normalize_path(path);
    let mut best: Option<(usize, usize)> = None;
    for (index, area) in areas.iter().enumerate() {
        let folder = normalize_path(&area.path);
        if folder.is_empty() || !path_in(&folder, &file) {
            continue;
        }
        if best.is_none_or(|(_, len)| folder.len() > len) {
            best = Some((index, folder.len()));
        }
    }
    best.map(|(index, _)| index)
        .or_else(|| areas.iter().position(AreaDef::is_root))
}

/// The id of the area `path` (from the repository root) belongs to: the
/// longest folder that holds it, else the root area, else none — also none
/// when the repository has no areas (the implicit one has no id).
pub fn area_of_path(areas: &[AreaDef], path: &str) -> Option<String> {
    area_index_of_path(areas, path).map(|index| areas[index].id.trim().to_string())
}

/// 1.174.0 (DR1): what a release of `area_id` counts — its folder and the
/// other areas' folders inside it (all of them for the root area), or
/// `None` without areas (the whole repository). `None` asks for the first
/// area. `icase` (Windows) compares the folders whatever their case.
pub fn area_folders(areas: &[AreaDef], area_id: Option<&str>, icase: bool) -> Option<(String, Vec<String>)> {
    if areas.is_empty() {
        return None;
    }
    let id = area_id.map(str::trim).filter(|id| !id.is_empty()).unwrap_or(areas[0].id.trim());
    let own = areas.iter().find(|a| a.id.trim() == id)?;
    let own_path = normalize_path(&own.path);
    let key = |p: &str| if icase { p.to_lowercase() } else { p.to_string() };
    let others = areas
        .iter()
        .filter(|a| a.id.trim() != id)
        .map(|a| normalize_path(&a.path))
        .filter(|p| !p.is_empty() && key(p) != key(&own_path) && path_in(&key(&own_path), &key(p)))
        .collect();
    Some((own_path, others))
}

// ── Words ──────────────────────────────────────────────────────────────

fn names_of(list: &[Value]) -> Vec<String> {
    list.iter()
        .map(|a| {
            let name = a.get("name").and_then(Value::as_str).unwrap_or_default().trim();
            if name.is_empty() {
                a.get("id").and_then(Value::as_str).unwrap_or_default().to_string()
            } else {
                name.to_string()
            }
        })
        .collect()
}

/// "A", "A and B", "A, B and C".
fn list_words(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// A change of the areas in words, when both sides name the same areas in
/// the same order: "Site changed", "App and Site changed". `None` otherwise
/// (added, removed or renamed areas read as the two lists of names).
pub fn change_words(old: &Value, new: &Value) -> Option<String> {
    let (Value::Array(old), Value::Array(new)) = (old, new) else {
        return None;
    };
    let names = names_of(new);
    if old.is_empty() || names_of(old) != names {
        return None;
    }
    let changed: Vec<String> = old
        .iter()
        .zip(new)
        .zip(&names)
        .filter(|((a, b), _)| a != b)
        .map(|(_, name)| name.clone())
        .collect();
    (!changed.is_empty()).then(|| format!("{} changed", list_words(&changed)))
}

// ── Resolution ─────────────────────────────────────────────────────────

/// An area with every default filled in, for the picker, Settings and the
/// sheets. `target_branch` and `version_files` stay `None` when the area
/// has none of its own; `branch` is where its cards go either way.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedArea {
    pub id: String,
    pub name: String,
    /// Normalized; "" for the root area.
    pub path: String,
    pub root: bool,
    /// The first area listed.
    pub first: bool,
    #[serde(default)]
    pub target_branch: Option<String>,
    /// Where its cards go: its own branch, else the workspace's.
    pub branch: String,
    #[serde(default)]
    pub version_files: Option<Vec<VersionFileEntry>>,
    pub tag_prefix: String,
    pub label: String,
    #[serde(default)]
    pub look_at: Option<String>,
    /// 1.173.0 (G1): its default release kind, as written.
    #[serde(default)]
    pub release_kind: Option<String>,
}

/// Every area with its defaults, in the order the repository lists them;
/// `workspace_branch` is the workspace's integration branch.
pub fn resolve(areas: &[AreaDef], workspace_branch: &str) -> Vec<ResolvedArea> {
    let list = normalized(areas);
    list.iter()
        .enumerate()
        .map(|(index, area)| ResolvedArea {
            id: area.id.clone(),
            name: area.display_name(),
            path: area.path.clone(),
            root: area.is_root(),
            first: index == 0,
            target_branch: area.target_branch.clone(),
            branch: area.target_branch.clone().unwrap_or_else(|| workspace_branch.to_string()),
            version_files: area.version_files.clone(),
            tag_prefix: tag_prefix_at(&list, index),
            label: area.label.clone().unwrap_or_else(|| default_label(&area.id)),
            look_at: area.look_at.clone(),
            release_kind: area.release_kind.clone(),
        })
        .collect()
}

/// A workspace's project config as one area ships it. B3/B4 start, ship
/// and release only on `Implicit` and `Area`; `Unknown` and `Held` are
/// refused, never read as the implicit area.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AreaConfig {
    /// No area asked: the workspace's config as it is, tagged `vX.Y.Z`.
    Implicit { config: ProjectConfig },
    /// The area's branch and version files, else the workspace's; every
    /// other value the workspace's. Tags: `area.tag_prefix`.
    Area { area: ResolvedArea, config: ProjectConfig },
    /// An id the repository doesn't list (removed, renamed, or no areas).
    Unknown { id: String },
    /// The repository's areas break the rules and this Mac has no good copy.
    Held { problem: String },
}

impl AreaConfig {
    /// The config to ship with; `None` when refused.
    pub fn config(&self) -> Option<&ProjectConfig> {
        match self {
            AreaConfig::Implicit { config } | AreaConfig::Area { config, .. } => Some(config),
            AreaConfig::Unknown { .. } | AreaConfig::Held { .. } => None,
        }
    }

    /// The release tags' prefix; `None` when refused.
    pub fn tag_prefix(&self) -> Option<&str> {
        match self {
            AreaConfig::Implicit { .. } => Some(""),
            AreaConfig::Area { area, .. } => Some(&area.tag_prefix),
            AreaConfig::Unknown { .. } | AreaConfig::Held { .. } => None,
        }
    }
}

/// [`AreaConfig`] for `area_id` over `config` (pure; never `Held`). An
/// absent or empty id is `Implicit`; one the list doesn't hold, `Unknown`.
pub fn resolve_config(config: &ProjectConfig, areas: &[AreaDef], area_id: Option<&str>) -> AreaConfig {
    let Some(id) = area_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return AreaConfig::Implicit { config: config.clone() };
    };
    let Some(area) = resolve(areas, &config.target_branch).into_iter().find(|a| a.id == id) else {
        return AreaConfig::Unknown { id: id.to_string() };
    };
    let mut config = config.clone();
    config.target_branch = area.branch.clone();
    if let Some(files) = &area.version_files {
        config.version_files = files.clone();
    }
    AreaConfig::Area { area, config }
}

// ── This Mac's copy ────────────────────────────────────────────────────

/// 1.174.0 (C10, D6): who decides the areas `areas.json` holds.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AreasSource {
    /// Saved here on a workspace that shares no setup: they decide until the
    /// person shares it, and then go in Share's own commit.
    Local,
    /// The repository's, as this Mac last read them — every file written
    /// before 1.174.0, and a value a later Plyloft adds.
    #[default]
    #[serde(other)]
    Shared,
}

fn is_shared(source: &AreasSource) -> bool {
    *source == AreasSource::Shared
}

/// A `source` of the wrong type reads as `shared`, so the file stays readable.
fn lenient_source<'de, D: Deserializer<'de>>(deserializer: D) -> Result<AreasSource, D::Error> {
    Ok(serde_json::from_value(Value::deserialize(deserializer)?).unwrap_or_default())
}

/// 1.174.0 (C10, D6): this Mac's own list, set aside when the setup came in
/// from the repository with other areas. The list is also kept in its own
/// file beside `areas.json` (`file`, `areas.set-aside-<ms>.json`), which no
/// answer removes; this entry is what the Board's sheet asks about, until
/// the person answers it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SetAside {
    pub areas: Vec<AreaDef>,
    /// Its file's name, beside `areas.json`.
    pub file: String,
    /// Unix ms.
    pub at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Stored {
    schema_version: u32,
    areas: Vec<AreaDef>,
    /// 1.173.0 (G1): the workspace's own default release kind (the
    /// definition's top-level `releaseKind`, for a repository without
    /// areas) — kept in step by every refresh where the workspace shares a
    /// definition, and this Mac's own choice where it shares none. Absent in
    /// files written before; not written while unset.
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "crate::project_config::lenient_opt")]
    release_kind: Option<String>,
    /// 1.174.0 (C10): absent (every file before) is `shared`; not written
    /// while it is.
    #[serde(skip_serializing_if = "is_shared", deserialize_with = "lenient_source")]
    source: AreasSource,
    /// 1.174.0 (C10): absent until the setup came in with other areas; a
    /// value of the wrong type reads as absent.
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "crate::project_config::lenient_opt")]
    set_aside: Option<SetAside>,
    #[serde(flatten)]
    extra: serde_json::Map<String, Value>,
}

/// What `areas.set-aside-<ms>.json` holds.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetAsideFile {
    schema_version: u32,
    source: AreasSource,
    areas: Vec<AreaDef>,
    at: i64,
}

/// 1.174.0 (CH-6): one writer of `areas.json` at a time — a definition
/// refresh, a save in Settings, the release kind, the set-aside — so no read
/// of it is written back over another's change.
static FILE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn file_lock() -> std::sync::MutexGuard<'static, ()> {
    FILE_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn path(store: &ProjectConfigStore, workspace_id: &str) -> std::path::PathBuf {
    store.workspace_dir(workspace_id).join(FILE)
}

/// The file as it is, for a write: a file that isn't JSON is set aside
/// first (`areas.json.unreadable-<ms>`, CH-6); one that can't be read at all
/// refuses the write. C17: so does one a newer Plyloft wrote that doesn't
/// parse here, left as it is ([`crate::atomic::newer_refusal`]).
fn read_stored(store: &ProjectConfigStore, workspace_id: &str) -> Result<Stored, String> {
    let parse = |bytes: &[u8]| serde_json::from_slice::<Stored>(bytes).map_err(|e| e.to_string());
    match crate::atomic::load_or_set_aside_versioned(&path(store, workspace_id), ("schemaVersion", SCHEMA_VERSION), parse)? {
        crate::atomic::Loaded::Newer(found) => Err(crate::atomic::newer_refusal(NEWER_AREAS, found, SCHEMA_VERSION)),
        loaded => Ok(loaded.found().unwrap_or_default()),
    }
}

/// C17: what [`crate::atomic::newer_refusal`] calls `areas.json`.
const NEWER_AREAS: &str = "The list of areas";

/// The file as it is, for a read: one Plyloft can't use reads as none.
fn load_stored(store: &ProjectConfigStore, workspace_id: &str) -> Stored {
    read_stored(store, workspace_id).unwrap_or_else(|error| {
        log::warn!("areas: {FILE} for {workspace_id}: {error}");
        Stored::default()
    })
}

/// C17: a newer Plyloft's `areas.json` is never written over (this build
/// would stamp it back down to its own version).
fn write_stored(store: &ProjectConfigStore, workspace_id: &str, stored: &mut Stored) -> Result<(), String> {
    let path = path(store, workspace_id);
    crate::atomic::refuse_newer_on_disk(&path, "schemaVersion", SCHEMA_VERSION, NEWER_AREAS)?;
    stored.schema_version = SCHEMA_VERSION;
    crate::atomic::write_atomic_json(&path, stored)
}

/// The areas `areas.json` holds, whoever decides them; a missing or
/// unreadable file is none.
pub fn load(store: &ProjectConfigStore, workspace_id: &str) -> Vec<AreaDef> {
    normalized(&load_stored(store, workspace_id).areas)
}

/// The repository's areas as this Mac read them (a definition refresh).
/// Atomic (Hard rule 3). Keeps the file's unknown keys.
pub fn save(store: &ProjectConfigStore, workspace_id: &str, areas: &[AreaDef]) -> Result<(), String> {
    let _lock = file_lock();
    let mut stored = read_stored(store, workspace_id)?;
    stored.areas = normalized(areas);
    stored.source = AreasSource::Shared;
    write_stored(store, workspace_id, &mut stored)
}

/// 1.174.0 (C10, D6): Settings › Areas' Save on a workspace that shares no
/// setup — the list decides on this Mac until the person shares the setup.
/// Refused where the workspace shares one (its areas are published there),
/// and for a list that breaks the rules.
pub fn save_local(store: &ProjectConfigStore, workspace_id: &str, areas: &[AreaDef]) -> Result<(), String> {
    if shares_definition(store, workspace_id) {
        return Err("This repository shares its settings: its areas are published with them.".into());
    }
    if let Some(problem) = check(areas).errors.into_iter().next() {
        return Err(problem.message);
    }
    {
        let _lock = file_lock();
        let mut stored = read_stored(store, workspace_id)?;
        stored.areas = normalized(areas);
        stored.source = AreasSource::Local;
        write_stored(store, workspace_id, &mut stored)
    }
}

/// 1.174.0 (C10): the areas kept on this Mac until the setup is shared —
/// what Share (and a legacy file's conversion) puts in `.atelier/workspace.json`.
/// `None` when this Mac keeps none.
pub fn kept_here(store: &ProjectConfigStore, workspace_id: &str) -> Option<Vec<AreaDef>> {
    let stored = load_stored(store, workspace_id);
    let list = normalized(&stored.areas);
    (stored.source == AreasSource::Local && !list.is_empty()).then_some(list)
}

/// 1.174.0 (C10, D6): the setup came in from the repository (Share, a
/// legacy file's conversion, or another computer shared it). This Mac's own
/// areas go to the repository's side: the same list (Share's own commit
/// carried it) just stops being this Mac's; another one — the repository's
/// areas, none, or a list that breaks the rules — is set aside: written to
/// `areas.set-aside-<ms>.json`, kept in [`SetAside`] for the Board's sheet,
/// and taken out of the list this Mac runs with, so the repository's apply.
/// Nothing is written to the repository here. `theirs`: the repository's
/// list, `None` when it breaks the rules. The set-aside, when there is one.
pub fn reconcile_shared(
    store: &ProjectConfigStore,
    workspace_id: &str,
    theirs: Option<&[AreaDef]>,
) -> Result<Option<SetAside>, String> {
    let _lock = file_lock();
    let mut stored = read_stored(store, workspace_id)?;
    if stored.source != AreasSource::Local {
        return Ok(None);
    }
    let mine = normalized(&stored.areas);
    stored.source = AreasSource::Shared;
    if mine.is_empty() || theirs.map(normalized).as_ref() == Some(&mine) {
        write_stored(store, workspace_id, &mut stored)?;
        return Ok(None);
    }
    let at = crate::kanban::now_ms();
    let file = format!("areas.set-aside-{at}.json");
    crate::atomic::write_atomic_json(
        &store.workspace_dir(workspace_id).join(&file),
        &SetAsideFile { schema_version: SCHEMA_VERSION, source: AreasSource::Local, areas: mine.clone(), at },
    )?;
    let aside = SetAside { areas: mine, file, at };
    stored.areas = Vec::new();
    stored.set_aside = Some(aside.clone());
    write_stored(store, workspace_id, &mut stored)?;
    Ok(Some(aside))
}

/// This Mac's list waiting for the Board's sheet, while it waits.
pub fn set_aside(store: &ProjectConfigStore, workspace_id: &str) -> Option<SetAside> {
    load_stored(store, workspace_id).set_aside
}

/// The sheet was answered: it asks no more. The set-aside file stays.
pub fn clear_set_aside(store: &ProjectConfigStore, workspace_id: &str) -> Result<Option<SetAside>, String> {
    let _lock = file_lock();
    let mut stored = read_stored(store, workspace_id)?;
    let Some(aside) = stored.set_aside.take() else {
        return Ok(None);
    };
    write_stored(store, workspace_id, &mut stored)?;
    Ok(Some(aside))
}

/// 1.173.0 (G1): the workspace's default release kind as this Mac keeps it
/// (`areas.json`); `None` = not chosen.
pub fn load_release_kind(store: &ProjectConfigStore, workspace_id: &str) -> Option<String> {
    load_stored(store, workspace_id).release_kind
}

/// Atomic (Hard rule 3); keeps the areas and the file's unknown keys.
/// Nothing is written when nothing changes (no file just to say "not chosen").
pub fn save_release_kind(
    store: &ProjectConfigStore,
    workspace_id: &str,
    kind: Option<String>,
) -> Result<(), String> {
    let _lock = file_lock();
    let mut stored = read_stored(store, workspace_id)?;
    if kind == stored.release_kind {
        return Ok(());
    }
    stored.release_kind = kind;
    write_stored(store, workspace_id, &mut stored)
}

fn shares_definition(store: &ProjectConfigStore, workspace_id: &str) -> bool {
    crate::workspace_definition::load_cache(store, workspace_id).is_some_and(|c| c.definition.is_some())
}

/// The areas a workspace runs with: where it shares a definition, the
/// repository's as this Mac last read them; where it shares none, the ones
/// saved here (1.174.0, D6) — a file the repository's last wrote (a setup no
/// longer shared) decides nothing. Empty is the implicit area — unless
/// [`held`] says otherwise.
pub fn for_workspace(store: &ProjectConfigStore, workspace_id: &str) -> Vec<AreaDef> {
    let stored = load_stored(store, workspace_id);
    if shares_definition(store, workspace_id) || stored.source == AreasSource::Local {
        normalized(&stored.areas)
    } else {
        Vec::new()
    }
}

/// Why the repository's areas can't be used, while they can't.
pub fn problem_for(store: &ProjectConfigStore, workspace_id: &str) -> Option<String> {
    crate::workspace_definition::load_cache(store, workspace_id)
        .filter(|c| c.definition.is_some())
        .and_then(|c| c.field_problems.get("areas").map(|p| p.message.clone()))
}

/// The repository's areas break the rules and this Mac has no good copy:
/// nothing may start, ship or release until a valid list is published.
pub fn held(store: &ProjectConfigStore, workspace_id: &str) -> Option<String> {
    let cache = crate::workspace_definition::load_cache(store, workspace_id)?;
    is_held(&cache, &load(store, workspace_id))
        .then(|| cache.field_problems.get("areas").map(|p| p.message.clone()))
        .flatten()
}

/// What the picker (B2) and Settings › Areas (B5) read.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AreasView {
    /// The workspace shares a definition, so areas can be set.
    pub shared: bool,
    pub read_only: bool,
    /// The areas this Mac runs with, as the repository wrote them (empty:
    /// none, or held).
    pub defined: Vec<AreaDef>,
    /// The same with their defaults; empty is the implicit area (unless held).
    pub areas: Vec<ResolvedArea>,
    /// The workspace's integration branch, where an area without its own
    /// branch sends its cards.
    pub workspace_branch: String,
    pub check: AreaCheck,
    /// Why the repository's list can't be used (the last good one is kept).
    pub problem: Option<String>,
    /// `problem` and no good copy here: refuse every card until it's fixed.
    pub held: bool,
    /// 1.173.0 (G1): the workspace's default release kind (the definition's
    /// `releaseKind`, or this Mac's own where it shares none) — what Release…
    /// and Ship batch start from without areas. `None` = not chosen; kept
    /// as written (the frontend reads only the kinds it knows).
    pub release_kind: Option<String>,
    /// 1.174.0 (C10, D6): the areas are this Mac's own (`shared` is false):
    /// saved here, they decide until the setup is shared.
    pub kept_here: bool,
    /// 1.174.0 (C10): this Mac's list, set aside when the setup came in with
    /// other areas, with its defaults — what the Board's sheet asks about.
    pub set_aside: Option<Vec<ResolvedArea>>,
}

/// A light read: the definition cache and `areas.json`, no git.
/// `workspace_prefix` is the workspace's folder in the repository.
pub fn view(store: &ProjectConfigStore, workspace_id: &str, workspace_prefix: &str) -> AreasView {
    view_with(store, workspace_id, || workspace_prefix.to_string())
}

/// [`view`], asking for the workspace's folder only when an area has
/// version files of its own (the only rule that reads it).
pub fn view_with(store: &ProjectConfigStore, workspace_id: &str, workspace_prefix: impl FnOnce() -> String) -> AreasView {
    let stored = load_stored(store, workspace_id);
    let release_kind = stored.release_kind.clone();
    let Some(cache) = crate::workspace_definition::load_cache(store, workspace_id).filter(|c| c.definition.is_some())
    else {
        // 1.174.0 (C10, D6): nothing shared — the areas saved here decide.
        if stored.source != AreasSource::Local {
            return AreasView { release_kind, ..AreasView::default() };
        }
        let defined = normalized(&stored.areas);
        let workspace_branch = store.get(workspace_id).map(|c| c.target_branch).unwrap_or_default();
        let prefix = if needs_prefix(&defined) { workspace_prefix() } else { String::new() };
        return AreasView {
            kept_here: true,
            areas: resolve(&defined, &workspace_branch),
            check: check_in(&defined, &prefix),
            workspace_branch,
            defined,
            release_kind,
            ..AreasView::default()
        };
    };
    let defined = normalized(&stored.areas);
    let workspace_branch = store
        .get(workspace_id)
        .map(|c| c.target_branch)
        .filter(|b| !b.trim().is_empty())
        .or_else(|| cache.definition.as_ref().and_then(|d| d.integration_branch.clone()))
        .or_else(|| cache.branch.clone())
        .unwrap_or_default();
    let problem = cache.field_problems.get("areas").map(|p| p.message.clone());
    let prefix = if needs_prefix(&defined) { workspace_prefix() } else { String::new() };
    AreasView {
        shared: true,
        read_only: cache.write_access.read_only(),
        areas: resolve(&defined, &workspace_branch),
        check: check_in(&defined, &prefix),
        held: is_held(&cache, &defined),
        problem,
        set_aside: stored.set_aside.as_ref().map(|a| resolve(&a.areas, &workspace_branch)),
        workspace_branch,
        defined,
        release_kind,
        kept_here: false,
    }
}

/// The one rule for "held", for the Doctor and every reader: the
/// repository's areas break the rules and this Mac has no good copy.
pub fn is_held(cache: &crate::workspace_definition::DefinitionCache, local: &[AreaDef]) -> bool {
    cache.definition.is_some() && cache.field_problems.contains_key("areas") && local.is_empty()
}

/// Only version-file warnings read the workspace's folder.
fn needs_prefix(areas: &[AreaDef]) -> bool {
    areas.iter().any(|a| a.version_files.as_ref().is_some_and(|f| !f.is_empty()))
}

/// The workspace folders' places in their repositories, asked of git once
/// per folder while Plyloft runs (a folder doesn't move inside its repo).
static PREFIXES: std::sync::Mutex<BTreeMap<String, String>> = std::sync::Mutex::new(BTreeMap::new());

/// git's `--show-prefix` for a folder: where it sits in its repository.
/// "" at the root — and when git can't say (not a repository, git
/// missing), which reads the folder as the root: only the version-file
/// warnings depend on it, never a rule that refuses. Cached per folder;
/// call it off the main thread.
pub fn workspace_prefix(cwd: &str) -> String {
    if let Some(known) = PREFIXES.lock().unwrap_or_else(|p| p.into_inner()).get(cwd) {
        return known.clone();
    }
    let out = crate::platform::git_command()
        .args(["rev-parse", "--show-prefix"])
        .current_dir(cwd)
        .output()
        .ok();
    let Some(out) = out.filter(|out| out.status.success()) else {
        return String::new(); // not cached: the folder may become a repository
    };
    let prefix = normalize_path(String::from_utf8_lossy(&out.stdout).trim());
    PREFIXES.lock().unwrap_or_else(|p| p.into_inner()).insert(cwd.to_string(), prefix.clone());
    prefix
}

fn prefix_of(workspaces: &crate::workspace::WorkspaceStore, workspace_id: &str) -> String {
    workspaces
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .map(|w| workspace_prefix(&w.cwd))
        .unwrap_or_default()
}

/// The workspace's areas, resolved (`areasGet`). Off the main thread: it may
/// ask git where the workspace's folder is.
#[tauri::command(async)]
pub fn areas_get(app: tauri::AppHandle, workspace_id: String) -> Result<AreasView, String> {
    use tauri::Manager;
    let store = app.state::<ProjectConfigStore>();
    let workspaces = app.state::<crate::workspace::WorkspaceStore>();
    Ok(view_with(&store, &workspace_id, || prefix_of(&workspaces, &workspace_id)))
}

/// 1.173.0 (G1): this Mac's default release kind, for a workspace that
/// shares no definition (Settings › Shipping saves it as it changes). Where
/// the workspace shares one, the default is the repository's and goes
/// through `workspace_definition_save` like every shared field.
pub fn set_local_release_kind(
    store: &ProjectConfigStore,
    workspace_id: &str,
    kind: Option<crate::kanban::ReleaseKind>,
) -> Result<(), String> {
    if crate::workspace_definition::load_cache(store, workspace_id).is_some_and(|c| c.definition.is_some()) {
        return Err("This repository shares its settings: its default release is published with them.".into());
    }
    save_release_kind(store, workspace_id, kind.map(release_kind_word))
}

/// A kind as the definition writes it (`"push_only"`).
pub fn release_kind_word(kind: crate::kanban::ReleaseKind) -> String {
    match kind {
        crate::kanban::ReleaseKind::Local => "local",
        crate::kanban::ReleaseKind::PushOnly => "push_only",
        crate::kanban::ReleaseKind::Github => "github",
    }
    .to_string()
}

#[tauri::command]
pub fn release_kind_set(
    app: tauri::AppHandle,
    workspace_id: String,
    kind: Option<crate::kanban::ReleaseKind>,
) -> Result<(), String> {
    use tauri::Manager;
    set_local_release_kind(&app.state::<ProjectConfigStore>(), &workspace_id, kind)
}

/// 1.174.0 (C10, D6): Settings › Areas' Save on a workspace that shares no
/// setup (`areasSaveLocal`): the list decides on this Mac until the setup
/// is shared. The view as it is after.
#[tauri::command(async)]
pub fn areas_save_local(app: tauri::AppHandle, workspace_id: String, areas: Vec<AreaDef>) -> Result<AreasView, String> {
    use tauri::Manager;
    crate::workspace_definition::app_areas_save_local(&app, &workspace_id, &areas)?;
    let store = app.state::<ProjectConfigStore>();
    let workspaces = app.state::<crate::workspace::WorkspaceStore>();
    Ok(view_with(&store, &workspace_id, || prefix_of(&workspaces, &workspace_id)))
}

/// 1.174.0 (C10, D6): the Board's sheet answered (`areasAnswerSetAside`):
/// "Use the repository's" (`publishMine` false, writes nothing to the
/// repository) or "Publish mine".
#[tauri::command(async)]
pub fn areas_answer_set_aside(app: tauri::AppHandle, workspace_id: String, publish_mine: bool) -> Result<(), String> {
    crate::workspace_definition::app_answer_set_aside(&app, &workspace_id, publish_mine)
}

/// The rules over a list being edited (`areasCheck`), before it is saved.
/// Off the main thread, like [`areas_get`].
#[tauri::command(async)]
pub fn areas_check(app: tauri::AppHandle, workspace_id: Option<String>, areas: Vec<AreaDef>) -> Result<AreaCheck, String> {
    use tauri::Manager;
    let prefix = match workspace_id.filter(|_| needs_prefix(&areas)) {
        Some(id) => prefix_of(&app.state::<crate::workspace::WorkspaceStore>(), &id),
        None => String::new(),
    };
    Ok(check_in(&areas, &prefix))
}

/// The Doctor's sentence for the areas, when they can't be used.
pub fn doctor_sentence(cache: &crate::workspace_definition::DefinitionCache, local: &[AreaDef]) -> Option<(bool, String)> {
    let problem = cache.field_problems.get("areas")?;
    let held = is_held(cache, local);
    let then = if held {
        "No card can start, ship or release until they're fixed"
    } else {
        "Plyloft keeps using the last good areas"
    };
    Some((
        held,
        format!(
            "The areas in .atelier/workspace.json break a rule: {} {then}; every other setting applies. Fix them in Settings › Project › Areas or in the repository.",
            problem.message
        ),
    ))
}

#[cfg(test)]
#[path = "areas_tests.rs"]
mod tests;
