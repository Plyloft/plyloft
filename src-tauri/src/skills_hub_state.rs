//! Skills hub (`docs/plans/SKILLS_HUB.md` §5.2): the per-Mac store
//! `<config_dir>/skills_hub/state.json`.
//!
//! H6a writes one part of it: the **script approvals** (R15). An approval is
//! the key `(origin, skill, scriptsId)` — the library and plugin a skill comes
//! from, its directory name, and a digest over every file in it that is not
//! plain text ([`crate::skill_scripts`]). A change to `SKILL.md` alone keeps
//! the key, so it never asks again; a change to a script or an extra file
//! makes a new key, which nobody has approved yet.
//!
//! Approvals are **per Mac** (§14 Q15): nothing here is synced, and a
//! teammate's OK does not count on this Mac.
//!
//! H2 adds `libraries`: per library on this Mac, when it was last pulled, the
//! failures since, and the member's decisions about a library GitHub no longer
//! lets them read (R1, R16, R17).
//!
//! H8 adds `localLinks`: the links of copies whose origin a committed file
//! can't name (`crate::skill_copy::LocalLink`).
//!
//! Later phases add their own keys (`seen`, …).
//! Every key this build does not know is kept on rewrite (`extra`), so an
//! older app approving a script never drops what a newer one wrote — and the
//! same holds for each approval record.
//!
//! Written atomically (Hard rule 3) under one process-wide lock, so two
//! approvals at once cannot lose each other.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub(crate) const SCHEMA_VERSION: u32 = 1;

fn schema_version() -> u32 {
    SCHEMA_VERSION
}

/// `<config_dir>/skills_hub/state.json`.
pub(crate) fn state_path(config_dir: &Path) -> PathBuf {
    config_dir.join("skills_hub").join("state.json")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubState {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub approvals: Vec<Approval>,
    /// H2: per library key (`team:<owner>/<repo>`), its pull record.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub libraries: std::collections::BTreeMap<String, LibraryState>,
    /// H4 (R3, R7): the pull requests this Mac opened in a library with a
    /// linked copy's content (*Propose mine upstream*), or instead of a push
    /// (*Promote* onto a skill that changed meanwhile), by [`proposal_key`].
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub proposals: std::collections::BTreeMap<String, Proposal>,
    /// H5 (R12): per workspace id, per skill directory, the content id of
    /// each twin (`claude`, `codex`) the last time the Library read them
    /// aligned in that workspace's checkout — the record that tells which
    /// twin changed since, for a skill with no link record (or one whose
    /// record is older than the last align). Absent from files written
    /// before H5, and left out of the file while empty.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub twin_ledger: std::collections::BTreeMap<String, std::collections::BTreeMap<String, crate::skill_links::TwinIds>>,
    /// H10 (R6, §14 Q4): per `library:<owner>/<repo>/<skill>`, the content id
    /// (the git tree id of the skill's directory in My library) this Mac last
    /// published or kept for that skill — the version a later publish from
    /// this Mac started from. My library on two Macs: a publish whose skill
    /// moved on GitHub since this base (the other Mac published) shows the
    /// 3-way compare instead of overwriting it. Absent from files written
    /// before H10, and left out of the file while empty.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub my_library_bases: std::collections::BTreeMap<String, String>,
    /// H8 (R5, §5.2): per destination workspace id, per skill directory, the
    /// links that can't be committed — a copy from a workspace with no GitHub
    /// repository, or from this Mac's own skills. Absent from files written
    /// before H8, and left out of the file while empty.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub local_links: std::collections::BTreeMap<String, std::collections::BTreeMap<String, crate::skill_copy::LocalLink>>,
    /// H8 (Mac walk): per GitHub repository (`owner/name`, lower case), the
    /// workspace on this Mac its skills were last copied from — which of two
    /// checkouts of it a committed copy's row names. Absent from files
    /// written before it, and left out of the file while empty.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub copy_origins: std::collections::BTreeMap<String, String>,
    /// Keys a later phase writes; kept as they are.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for HubState {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            approvals: Vec::new(),
            libraries: std::collections::BTreeMap::new(),
            proposals: std::collections::BTreeMap::new(),
            twin_ledger: std::collections::BTreeMap::new(),
            my_library_bases: std::collections::BTreeMap::new(),
            local_links: std::collections::BTreeMap::new(),
            copy_origins: std::collections::BTreeMap::new(),
            extra: serde_json::Map::new(),
        }
    }
}

/// H2 (§5.2): what this Mac knows about pulling one library. Every field is
/// optional on disk; a record from a later build keeps its unknown fields.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryState {
    /// Unix ms of the last pull that reached GitHub and went through.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_pull_at: Option<i64>,
    /// The clone's `HEAD` after that pull.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_pull_commit: Option<String>,
    /// Unix ms of the last attempt, whatever it gave.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_attempt_at: Option<i64>,
    /// Why the last attempt did not go through: `"offline"` (GitHub could not
    /// be asked), `"noAccess"` (GitHub refuses the repository to this
    /// account) or `"failed"` (anything else). `None` after a pull that did.
    /// H10, My library's record also: `"gone"` (GitHub says the repository
    /// isn't there for its account), `"held"` (the clone and GitHub both
    /// moved) and `"signIn"` (its account couldn't sign in).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Consecutive attempts GitHub refused the repository (R16: three over at
    /// least 30 minutes before Plyloft says access is gone). An offline attempt
    /// neither adds to it nor clears it; a pull that goes through clears it.
    #[serde(default)]
    pub failures: u32,
    /// Unix ms of the first refusal of that run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_failure_at: Option<i64>,
    /// R16: the member chose *Switch it off on this Mac*. No pull, no
    /// delivery, until *Switch it back on*.
    #[serde(default)]
    pub switched_off: bool,
    /// R16: Unix ms when Plyloft concluded GitHub no longer lets this account
    /// read the library. Cleared by the next pull that goes through.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_lost: Option<i64>,
    /// R16: the member answered *Keep the last copy* to that question.
    #[serde(default)]
    pub kept_last_copy: bool,
    /// R17: Unix ms when this Mac found it is no longer in the team. The clone
    /// went to the Trash and nothing is pulled in the background until a read
    /// of the team finds the account listed again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left_at: Option<i64>,
    /// The GitHub login GitHub last confirmed as a member on this Mac. R16 and
    /// R17 act only on an answer about that same login: a member who never got
    /// in (still joining) is never told they left, and a switch of gh account
    /// is not a revocation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_login: Option<String>,
    /// The team's name as its manifest last said, for the words once the
    /// clone is gone ("You're no longer in acme's team.").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_name: Option<String>,
    /// R17: why the clone stayed on this Mac when it should have gone (a
    /// volume with no Recycle Bin, say). `None` when it went, or never had to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clone_kept: Option<String>,
    /// H10 (R6 edge): Unix ms when GitHub said **My library**'s repository is
    /// not there for its account (deleted, renamed, or access lost). The last
    /// clone keeps reaching sessions; the line offers *Create it again*,
    /// *Point to another repository…* and *Stop using it on this Mac*.
    /// Cleared by the next pull that goes through. Never set for the team
    /// library (R16's three-refusal rule is the team's).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gone_at: Option<i64>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// H4: one pull request this Mac opened in a library for one skill. The same
/// branch takes a later proposal of the same skill while it is open (R7 edge
/// "PR already open for this skill from this Mac").
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Proposal {
    /// `plyloft/skill-<name>-<yyyymmdd-hhmm>`.
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u64>,
    /// The content id proposed: the row says *Proposed upstream* while the
    /// copy is still that content.
    #[serde(default)]
    pub content_id: String,
    /// The commit on the branch, the parent of a later proposal's commit.
    #[serde(default)]
    pub commit: String,
    /// Unix ms.
    #[serde(default)]
    pub at: i64,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// `<library key>/<plugin>/<skill>`, as [`HubState::proposals`] is keyed.
pub(crate) fn proposal_key(library_key: &str, plugin: &str, skill: &str) -> String {
    format!("{library_key}/{plugin}/{skill}")
}

/// H10: the key of My library `<owner>/<repo>` in [`HubState::libraries`]
/// (and the approval origin's first part, `skill_scripts::library_id`).
pub(crate) fn my_library_key(repo: &str) -> String {
    format!("library:{}", repo.to_ascii_lowercase())
}

/// H10: the key of one skill's base in [`HubState::my_library_bases`].
pub(crate) fn my_library_base_key(repo: &str, skill: &str) -> String {
    format!("{}/{skill}", my_library_key(repo))
}

/// The key of the team library in [`HubState::libraries`].
pub(crate) fn team_key(slug: &str) -> String {
    format!("team:{}", slug.to_ascii_lowercase())
}

/// One OK, given on this Mac.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Approval {
    /// `team:<owner>/<repo>/<plugin>` — where the skill comes from.
    #[serde(default)]
    pub origin: String,
    /// The skill's directory name.
    #[serde(default)]
    pub skill: String,
    /// The digest over the skill's non-text files that was shown and approved.
    #[serde(default)]
    pub scripts_id: String,
    /// Unix ms.
    #[serde(default)]
    pub approved_at: i64,
    /// The library commit the member was shown, for the record. Absent in an
    /// approval written by a build before it existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl HubState {
    /// H5: the twins' ids `skill` last had aligned in `workspace_id`.
    pub(crate) fn ledger(&self, workspace_id: &str, skill: &str) -> Option<&crate::skill_links::TwinIds> {
        self.twin_ledger.get(workspace_id)?.get(skill)
    }

    /// Whether `(origin, skill, scripts_id)` was approved on this Mac.
    pub(crate) fn approved(&self, origin: &str, skill: &str, scripts_id: &str) -> Option<&Approval> {
        self.approvals
            .iter()
            .filter(|a| a.origin == origin && a.skill == skill && a.scripts_id == scripts_id)
            .max_by_key(|a| a.approved_at)
    }
}

fn lock() -> &'static parking_lot::Mutex<()> {
    static LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
    &LOCK
}

/// The store as it is on disk. A missing file is the empty store. A file that
/// does not parse is read as empty too (a launch never fails over it) — and
/// set aside on the next write, never overwritten in place.
pub(crate) fn load(config_dir: &Path) -> HubState {
    read(&state_path(config_dir)).unwrap_or_default()
}

fn read(path: &Path) -> Result<HubState, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HubState::default()),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    serde_json::from_slice::<HubState>(&bytes).map_err(|error| {
        log::warn!("skills hub: {} is unreadable ({error})", path.display());
        format!("parse {}: {error}", path.display())
    })
}

/// Read the store, let `change` edit it, write it back atomically, under the
/// one lock. A file that does not parse is set aside first (never
/// overwritten in place) and the edit starts from the empty store.
pub(crate) fn update<T>(
    config_dir: &Path,
    now_ms: i64,
    change: impl FnOnce(&mut HubState) -> T,
) -> Result<T, String> {
    let _guard = lock().lock();
    let path = state_path(config_dir);
    let mut state = read_or_set_aside(&path, now_ms)?;
    let out = change(&mut state);
    write(&path, &state)?;
    Ok(out)
}

/// H8 Challenger: a workspace removed from Plyloft takes what this store
/// keeps for it as a *destination* — its links kept on this Mac only and
/// its twin record — so a later workspace never inherits them. Links other
/// workspaces keep *to* it stay: their rows say it isn't available on this
/// Mac (R5 Challenger edge). Nothing is written when there is nothing to
/// forget.
pub(crate) fn forget_workspace(config_dir: &Path, workspace_id: &str, now_ms: i64) -> Result<(), String> {
    let current = load(config_dir);
    if !current.local_links.contains_key(workspace_id)
        && !current.twin_ledger.contains_key(workspace_id)
        && !current.copy_origins.values().any(|id| id == workspace_id)
    {
        return Ok(());
    }
    update(config_dir, now_ms, |state| {
        state.local_links.remove(workspace_id);
        state.twin_ledger.remove(workspace_id);
        state.copy_origins.retain(|_, id| id != workspace_id);
    })
}

fn read_or_set_aside(path: &Path, now_ms: i64) -> Result<HubState, String> {
    match read(path) {
        Ok(state) => Ok(state),
        Err(error) => {
            if path.is_file() {
                // Kept for whoever wants to look; the store starts again.
                let aside = path.with_extension(format!("json.unreadable-{now_ms}"));
                std::fs::rename(path, &aside)
                    .map_err(|rename| format!("{error}; could not set it aside: {rename}"))?;
            }
            Ok(HubState::default())
        }
    }
}

fn write(path: &Path, state: &HubState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    crate::atomic::write_atomic_json(path, state)
}

/// Record approvals of `scripts_ids` for `(origin, skill)`, now.
pub(crate) fn approve(
    config_dir: &Path,
    origin: &str,
    skill: &str,
    scripts_ids: &[String],
    commit: Option<&str>,
    now_ms: i64,
) -> Result<(), String> {
    update(config_dir, now_ms, |state| {
        for scripts_id in scripts_ids {
            if state.approved(origin, skill, scripts_id).is_some() {
                continue;
            }
            state.approvals.push(Approval {
                origin: origin.to_string(),
                skill: skill.to_string(),
                scripts_id: scripts_id.clone(),
                approved_at: now_ms,
                commit: commit.map(str::to_string),
                extra: serde_json::Map::new(),
            });
        }
    })
}

/// H5 (R12): record `entries` (skill, both twins' ids) as the twins'
/// last aligned state in `workspace_id`. Writes only when something changed,
/// so a Library read that finds the ledger current writes nothing.
pub(crate) fn record_aligned(
    config_dir: &Path,
    workspace_id: &str,
    entries: &[(String, crate::skill_links::TwinIds)],
    now_ms: i64,
) -> Result<(), String> {
    let current = load(config_dir);
    let stale = entries
        .iter()
        .any(|(skill, ids)| current.ledger(workspace_id, skill).is_none_or(|known| !known.same_ids(ids)));
    if !stale {
        return Ok(());
    }
    update(config_dir, now_ms, |state| {
        let ledger = state.twin_ledger.entry(workspace_id.to_string()).or_default();
        for (skill, ids) in entries {
            let entry = ledger.entry(skill.clone()).or_default();
            // Unknown keys of an entry a later build wrote stay.
            entry.claude = ids.claude.clone();
            entry.codex = ids.codex.clone();
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_is_the_empty_store() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), HubState::default());
    }

    /// Tier 2 (§5.9): an empty file body and a partial file load with defaults.
    #[test]
    fn empty_and_partial_files_load_with_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{}").unwrap();
        let state = load(dir.path());
        assert_eq!(state.schema_version, SCHEMA_VERSION);
        assert!(state.approvals.is_empty());

        // An approval written before `commit` existed, with only the key.
        std::fs::write(
            &path,
            r#"{"approvals":[{"origin":"team:acme/team/acme","skill":"check","scriptsId":"abc"}]}"#,
        )
        .unwrap();
        let state = load(dir.path());
        assert_eq!(state.approvals.len(), 1);
        assert_eq!(state.approvals[0].commit, None);
        assert_eq!(state.approvals[0].approved_at, 0);
        assert!(state.approved("team:acme/team/acme", "check", "abc").is_some());
        assert!(state.approved("team:acme/team/acme", "check", "abd").is_none());
    }

    /// Tier 2: keys a later phase writes (§5.2's `libraries`, `seen`, …) and
    /// unknown fields of an approval survive an approval written by this build.
    #[test]
    fn unknown_keys_survive_an_approval() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,
                "libraries":{"team:acme/team":{"lastPullAt":1760000000000}},
                "seen":{"team:acme/team/acme/review-rules":"c0ffee"},
                "approvals":[{"origin":"o","skill":"s","scriptsId":"1","approvedAt":5,"note":"kept"}]}"#,
        )
        .unwrap();
        approve(dir.path(), "o", "t", &["2".to_string()], Some("deadbeef"), 10).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["libraries"]["team:acme/team"]["lastPullAt"], 1760000000000u64);
        assert_eq!(value["seen"]["team:acme/team/acme/review-rules"], "c0ffee");
        assert_eq!(value["approvals"][0]["note"], "kept");
        assert_eq!(value["approvals"][1]["skill"], "t");
        assert_eq!(value["approvals"][1]["commit"], "deadbeef");
        assert_eq!(value["schemaVersion"], 1);
    }

    /// Tier 2 (§5.9, H2): a file from H6a (approvals only) and a library
    /// record with only some fields load with defaults; a record's unknown
    /// fields and the store's unknown keys survive an H2 write.
    #[test]
    fn an_h6a_file_and_a_partial_library_record_load_and_keep_what_they_carry() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"approvals":[{"origin":"o","skill":"s","scriptsId":"1","approvedAt":5}]}"#,
        )
        .unwrap();
        let state = load(dir.path());
        assert!(state.libraries.is_empty());
        assert_eq!(state.approvals.len(), 1);

        std::fs::write(
            &path,
            r#"{"schemaVersion":1,
                "libraries":{"team:acme/team":{"lastPullAt":1760000000000,"lastPullCommit":"abc",
                                                "lastError":null,"failures":0,"switchedOff":false,
                                                "accessLost":null,"later":"kept"},
                             "library:matteo/plyloft-skills":{"lastPullAt":1}},
                "seen":{"x":"y"}}"#,
        )
        .unwrap();
        let state = load(dir.path());
        let team = &state.libraries["team:acme/team"];
        assert_eq!(team.last_pull_at, Some(1760000000000));
        assert_eq!(team.last_pull_commit.as_deref(), Some("abc"));
        assert_eq!((team.failures, team.switched_off, team.access_lost), (0, false, None));
        assert_eq!((team.left_at, team.member_login.as_deref(), team.kept_last_copy), (None, None, false));

        update(dir.path(), 9, |state| {
            state.libraries.get_mut("team:acme/team").unwrap().failures = 1;
        })
        .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["libraries"]["team:acme/team"]["later"], "kept");
        assert_eq!(value["libraries"]["team:acme/team"]["failures"], 1);
        assert_eq!(value["libraries"]["library:matteo/plyloft-skills"]["lastPullAt"], 1);
        assert_eq!(value["seen"]["x"], "y");
        // An H6a build reading it back keeps `libraries` too (its `extra`).
        let approvals_only: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(approvals_only.get("libraries").is_some());
    }

    /// Tier 2 (H4): a file from H2/H6a (no `proposals`) loads with none; a
    /// proposal written by H4 round-trips, its unknown fields kept, and an
    /// older build's rewrite keeps the whole key (its `extra`).
    #[test]
    fn proposals_load_from_older_files_and_keep_unknown_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"schemaVersion":1,"libraries":{"team:a/b":{"lastPullAt":1}}}"#).unwrap();
        assert!(load(dir.path()).proposals.is_empty());
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"proposals":{"team:a/b/acme/x":{"branch":"plyloft/skill-x-20261018-1200","url":"https://github.com/a/b/pull/3","number":3,"contentId":"c","later":"kept"}}}"#,
        )
        .unwrap();
        let state = load(dir.path());
        let proposal = &state.proposals[&proposal_key("team:a/b", "acme", "x")];
        assert_eq!((proposal.number, proposal.content_id.as_str(), proposal.at), (Some(3), "c", 0));
        update(dir.path(), 5, |state| {
            state.proposals.get_mut("team:a/b/acme/x").unwrap().at = 5;
        })
        .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["proposals"]["team:a/b/acme/x"]["later"], "kept");
        assert_eq!(value["proposals"]["team:a/b/acme/x"]["at"], 5);
    }

    #[test]
    fn an_h4_file_loads_with_an_empty_twin_ledger_and_keeps_it_on_rewrite() {
        // Tier 2 schema migration (H5): a state.json written before H5 has
        // no `twinLedger`; it loads, and recording one keeps the rest.
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"approvals":[],"proposals":{"team:a/b/p/x":{"branch":"plyloft/skill-x-1","url":"u","contentId":"c","commit":"k","at":1}},"later":{"kept":true}}"#,
        )
        .unwrap();
        let state = load(dir.path());
        assert!(state.twin_ledger.is_empty());
        assert_eq!(state.proposals.len(), 1);
        let ids = crate::skill_links::TwinIds { claude: Some("a".into()), codex: Some("b".into()), extra: Default::default() };
        record_aligned(dir.path(), "ws", &[("lint".into(), ids.clone())], 5).unwrap();
        let state = load(dir.path());
        assert!(state.ledger("ws", "lint").unwrap().same_ids(&ids));
        assert_eq!(state.proposals.len(), 1, "the proposals survive");
        assert_eq!(state.extra.get("later"), Some(&serde_json::json!({"kept": true})), "unknown keys survive");
        // The same reading again writes nothing: a hand-made marker in the
        // file survives, which a rewrite would have normalised away.
        let mut marked = std::fs::read_to_string(&path).unwrap();
        marked.push('\n');
        std::fs::write(&path, &marked).unwrap();
        record_aligned(dir.path(), "ws", &[("lint".into(), ids)], 7).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), marked, "a current ledger is not written again");
        // An entry a later build wrote keeps its unknown keys.
        std::fs::write(&path, r#"{"twinLedger":{"ws":{"lint":{"claude":"a","codex":"b","seenAt":9}}}}"#).unwrap();
        let next = crate::skill_links::TwinIds { claude: Some("c".into()), codex: Some("c".into()), extra: Default::default() };
        record_aligned(dir.path(), "ws", &[("lint".into(), next)], 8).unwrap();
        let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(raw["twinLedger"]["ws"]["lint"], serde_json::json!({"claude":"c","codex":"c","seenAt":9}));
    }

    #[test]
    fn team_keys_ignore_case() {
        assert_eq!(team_key("Acme/Team"), "team:acme/team");
    }

    #[test]
    fn approving_twice_records_one_approval() {
        let dir = tempfile::tempdir().unwrap();
        approve(dir.path(), "o", "s", &["1".to_string(), "1".to_string()], None, 1).unwrap();
        approve(dir.path(), "o", "s", &["1".to_string()], None, 2).unwrap();
        assert_eq!(load(dir.path()).approvals.len(), 1);
    }

    #[test]
    fn an_unreadable_file_is_set_aside_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(load(dir.path()), HubState::default());
        approve(dir.path(), "o", "s", &["1".to_string()], None, 7).unwrap();
        assert_eq!(load(dir.path()).approvals.len(), 1);
        let aside = path.with_extension("json.unreadable-7");
        assert_eq!(std::fs::read_to_string(aside).unwrap(), "{ not json");
    }

    /// H10 Tier 2 (§5.9): a file from before My library — an H2 library
    /// record without `goneAt`, no `myLibraryBases` — loads with neither; an
    /// H10 write keeps the older keys, and the new ones round-trip.
    #[test]
    fn a_file_from_before_my_library_loads_and_keeps_its_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"libraries":{"team:acme/team":{"lastPullAt":5,"failures":1}},"later":{"x":1}}"#,
        )
        .unwrap();
        let state = load(dir.path());
        assert!(state.my_library_bases.is_empty());
        assert_eq!(state.libraries["team:acme/team"].gone_at, None);
        update(dir.path(), 9, |state| {
            let lib = state.libraries.entry(my_library_key("Matteo/plyloft-skills")).or_default();
            lib.gone_at = Some(9);
            state.my_library_bases.insert(my_library_base_key("Matteo/plyloft-skills", "my-review"), "abc".into());
        })
        .unwrap();
        let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(raw["libraries"]["team:acme/team"]["lastPullAt"], 5);
        assert_eq!(raw["later"]["x"], 1);
        assert_eq!(raw["libraries"]["library:matteo/plyloft-skills"]["goneAt"], 9);
        assert_eq!(raw["myLibraryBases"]["library:matteo/plyloft-skills/my-review"], "abc");
        // An H2 team record never gains the field.
        assert!(raw["libraries"]["team:acme/team"].get("goneAt").is_none());
    }
}
