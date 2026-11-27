//! Skills hub H9 (`docs/plans/SKILLS_HUB.md` R9, §6 `ply_skill_setting`,
//! `ply_skill_personalize`): the commands behind a Plyloft skill's versions,
//! its switch at the workspace and team levels, and **Personalize**.
//!
//! A child of `commands` (as `skills_hub_twins` is), so it shares the skill
//! card's helpers and the team write path rather than copying them.
//!
//! - **The workspace level** is a field of the shared definition when the
//!   workspace has one (`workspace_definition::edit_shared`: applied here at
//!   once, published to the integration branch through the write channel,
//!   refused for a read-only collaborator), and this Mac's
//!   `projects/<ws>/ply_skills.json` otherwise ([`crate::ply_skill_switch`]).
//! - **The team level** is `library.plySkillsOff` in `team.json`, written
//!   through the team library's own write path (`team::publish_library_paths`,
//!   the owner re-checked inside the post-pull mutation, as Add workspace
//!   does). Anyone else is refused in words that name the owner (Q27: the
//!   team can only switch a skill off).
//! - **Personalize** into a repository is a skill card (`SkillVerb::Personalize`,
//!   free, §14 Q3); into the team library it is a Promote of the bundle's copy
//!   (R7), followed — only for the owner — by the team default.

use super::*;
use crate::ply_skill_switch as switch;

/// Where a Plyloft skill's switch is being read: what a row and the page
/// need to say which level decides, and who may change each.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlyPlace {
    pub workspace_name: String,
    /// The checkout's GitHub repository (`acme/web`), for "set in acme/web".
    pub repository: Option<String>,
    /// The workspace has a shared definition: its choice reaches everyone
    /// who opens the repository.
    pub shared: bool,
    /// A shared definition this Mac can't write (GH #82).
    pub read_only: bool,
    /// The team whose default applies to this Mac's sessions, if any.
    pub team: Option<PlyTeamPlace>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlyTeamPlace {
    pub slug: String,
    /// The manifest's team name (`acme`).
    pub name: String,
    pub owner: Option<String>,
    /// This Mac is signed in to GitHub as the owner (as last asked).
    pub you_own: bool,
}

/// One skill's switch at every level, and which one decides.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlySwitchView {
    /// What the next session in this workspace gets.
    pub on: bool,
    pub level: switch::Level,
    /// This workspace's explicit choice, if any.
    pub workspace: Option<bool>,
    /// This repository holds a fork of it linked to Plyloft.
    pub fork: bool,
    /// The team switched it off.
    pub team_off: bool,
    /// This Mac's own switch.
    pub mac_on: bool,
}

impl PlySwitchView {
    pub fn of(inputs: &switch::Inputs, name: &str) -> Self {
        let decision = inputs.decide(name);
        PlySwitchView {
            on: decision.on,
            level: decision.level,
            workspace: inputs.workspace.choice(name),
            fork: inputs.forks.iter().any(|n| n == name),
            team_off: inputs.team_off.as_ref().is_some_and(|off| off.iter().any(|n| n == name)),
            mac_on: !inputs.mac_off.iter().any(|n| n == name),
        }
    }
}

/// The place and the switch inputs of `workspace_id` (none: this Mac only).
pub(crate) fn place_and_inputs<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: Option<&str>, mac_off: Vec<String>) -> (Option<PlyPlace>, switch::Inputs) {
    let Some(workspace_id) = workspace_id else {
        return (None, switch::Inputs { mac_off, ..Default::default() });
    };
    let Ok((workspace_name, cwd)) = workspace_checkout(app, workspace_id) else {
        return (None, switch::Inputs { mac_off, ..Default::default() });
    };
    let project_configs = app.state::<ProjectConfigStore>();
    let team_clone = crate::mcp_launch::team_clone_dir(app);
    let inputs = switch::inputs(Some(&project_configs), workspace_id, Some(&cwd), team_clone.as_deref(), mac_off);
    let cache = crate::workspace_definition::load_cache(&project_configs, workspace_id);
    let shared = cache.as_ref().is_some_and(|c| c.definition.is_some());
    let read_only = cache.as_ref().is_some_and(|c| c.write_access.read_only());
    let team = team_clone.as_deref().and_then(|clone| {
        let slug = current_team_repo(app)?;
        let manifest = crate::team::read_manifest(clone).ok().flatten()?;
        let owner = manifest.owner_login().map(str::to_string);
        // Who this Mac is, as the team's last membership read said (no `gh`
        // on every Library read); `gh`'s own 60-second cache only before the
        // first one. A read that changes nothing: the write asks afresh.
        //
        // Challenger (H9): before the first read, the team's own account
        // (`settings.team.account`) if one is chosen, and only then `gh` —
        // as the team's account, so a workspace's other account is never
        // taken for who this Mac is on the team.
        let login = app
            .try_state::<crate::team::TeamStore>()
            .and_then(|team| team.cached_membership(&slug))
            .and_then(|cached| cached.login)
            .or_else(|| app.try_state::<SettingsStore>().and_then(|settings| team_account_of(&settings)))
            .or_else(|| {
                let _account = team_account_scope(app);
                crate::github::current_login().ok()
            });
        let you_own = matches!((&owner, &login), (Some(o), Some(l)) if o.eq_ignore_ascii_case(l));
        Some(PlyTeamPlace { slug, name: manifest.name.clone(), owner, you_own })
    });
    let repository = crate::shared_config::Plumbing { cwd: cwd.clone() }.github_repo();
    (Some(PlyPlace { workspace_name, repository, shared, read_only, team }), inputs)
}

/// A name the bundle offers, or the refusal that says it doesn't.
fn bundled<R: tauri::Runtime>(app: &tauri::AppHandle<R>, name: &str) -> Result<(PathBuf, crate::ply_skills::PlySkill), String> {
    let name = crate::project_skills::safe_name(name)?;
    let bundle = crate::ply_skills::bundle_dir(app)
        .ok_or_else(|| "This build of Plyloft has no skills of its own.".to_string())?;
    let skill = crate::ply_skills::read_bundle(&bundle)
        .into_iter()
        .find(|skill| skill.name == name)
        .ok_or_else(|| format!("{name} doesn't come with this version of Plyloft."))?;
    Ok((bundle, skill))
}

/// The owner-only refusal for the team default (R9 edge, Q27).
pub(crate) fn owner_only_words(name: &str, owner: Option<&str>, login: Option<&str>) -> String {
    match (owner, login) {
        (Some(owner), Some(login)) => format!(
            "Only {owner} can switch Plyloft's {name} off for the team. You are signed in to GitHub as {login}."
        ),
        (Some(owner), None) => format!("Only {owner} can switch Plyloft's {name} off for the team."),
        _ => format!(
            "The team manifest names no owner, so nobody can switch Plyloft's {name} off for the team yet."
        ),
    }
}

/// **The switch at the workspace or team level** (R9). `choice`: `Some(false)`
/// off, `Some(true)` on (workspace only), `None` back to no choice at that
/// level. This Mac's level is `settings.json`, set by the Library as before.
#[tauri::command]
pub async fn ply_skill_setting(
    app: AppHandle,
    level: String,
    workspace_id: Option<String>,
    name: String,
    choice: Option<bool>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let (_, skill) = bundled(&app, &name)?;
        let name = skill.name;
        match level.as_str() {
            "workspace" => set_workspace_choice(&app, &workspace_id.ok_or("Which workspace?")?, &name, choice),
            "team" => {
                if choice == Some(true) {
                    return Err(format!(
                        "The team can only switch Plyloft's {name} off; with no team choice it follows each Mac."
                    ));
                }
                set_team_default(&app, &name, choice == Some(false)).map(|_| ())
            }
            _ => Err(format!("{level} isn't a level Plyloft's skills are switched at here.")),
        }
    })
    .await
    .map_err(|error| format!("join Plyloft skill setting: {error}"))?
}

/// The workspace level: a field of the shared definition, or this Mac's
/// file for a workspace with none.
pub(crate) fn set_workspace_choice<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    name: &str,
    choice: Option<bool>,
) -> Result<(), String> {
    workspace_checkout(app, workspace_id)?;
    let project_configs = app.state::<ProjectConfigStore>();
    let cache = crate::workspace_definition::load_cache(&project_configs, workspace_id);
    let shared = cache.as_ref().is_some_and(|c| c.definition.is_some());
    if cache.as_ref().is_some_and(|c| c.write_access.read_only()) {
        return Err(crate::workspace_definition::read_only_error(
            "This workspace's choice of Plyloft's skills",
        ));
    }
    let save = || {
        let current = switch::load(&project_configs, workspace_id);
        switch::save(&project_configs, workspace_id, &current.with(name, choice))
    };
    if shared {
        // Applied here at once and published to the integration branch like
        // every field of the definition (Q14).
        crate::workspace_definition::edit_shared(app, workspace_id, save)
    } else {
        save()
    }
}

/// The team default, written by the owner through the team library's write
/// path. `Ok(true)` when the manifest changed.
fn set_team_default(app: &AppHandle, name: &str, off: bool) -> Result<bool, String> {
    let _account = team_account_scope(app);
    let owner = team_owner_gate(app, Identity::Fresh).map_err(|why| {
        if why.starts_with("Only the team owner") {
            let slug = current_team_repo(app).unwrap_or_default();
            let (owner, login) = team_owner_facts(app, &slug, Identity::Cached);
            owner_only_words(name, owner.as_deref(), login.as_deref())
        } else {
            why
        }
    })?;
    let team = app.state::<crate::team::TeamStore>();
    let clone_dir = team.clone_dir(&owner.slug);
    let message = if off {
        format!("team: switch Plyloft's {name} off for the team")
    } else {
        format!("team: Plyloft's {name} follows each Mac again")
    };
    let _git = team.git_guard();
    let published = crate::team::publish_library_paths(
        &clone_dir,
        &[crate::team::MANIFEST_FILE.to_string()],
        &message,
        |clone| {
            // Re-read and re-decide inside the mutation (what was read before
            // the pull is stale; who owns the team is a fact in this file).
            let current = crate::team::read_manifest(clone)?
                .ok_or_else(|| "The team repo has no team.json to keep the team's choice in.".to_string())?;
            crate::team_admin::authorize_owner_action(owner.team_allowed, current.owner_login(), Some(&owner.login))
                .map_err(|_| owner_only_words(name, current.owner_login(), Some(&owner.login)))?;
            match switch::manifest_with_team_off(&current, name, off) {
                None => Ok(()),
                Some(next) => crate::team_admin::write_manifest(clone, &next),
            }
        },
        &crate::team::RealLibraryGit,
    )
    .map_err(|error| error.message())?;
    Ok(published.committed)
}

/// What Personalize did.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Personalized {
    /// Into a repository: the skill card that carries the fork.
    pub card: Option<KanbanCard>,
    /// Into the team library: the plugin the fork is in (`ply-team`).
    pub plugin: Option<String>,
    pub pushed: bool,
    pub pull_request: Option<PromotePullRequest>,
    /// The team default now switches Plyloft's copy off (the owner only).
    pub team_switched: bool,
    /// Who may switch it off for the team, when this Mac couldn't.
    pub owner: Option<String>,
    /// The owner's own team-default write failed after the fork was shared:
    /// why, in the team write's words.
    pub team_switch_problem: Option<String>,
}

/// Personalize into the team when the team library already has a skill of
/// that name in Plyloft's team plugin (R7: never over a teammate's change).
pub(crate) fn team_name_taken_words(name: &str, plugin: &str) -> String {
    format!(
        "The team library already has a {name} ({plugin}:{name}) that differs from Plyloft's, so nothing \
         was shared over it. Open that one in the Library to change it, or remove it from the team library first."
    )
}

/// **Personalize** (R9): `target` `"repository"` (a skill card, free) or
/// `"team"` (published to the team library, R7; the team default follows
/// only for the owner).
#[tauri::command]
pub async fn ply_skill_personalize(
    app: AppHandle,
    workspace_id: String,
    name: String,
    target: String,
    replace: Option<bool>,
) -> Result<Personalized, crate::project_skills::CopyError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Personalized, crate::project_skills::CopyError> {
        let (bundle, skill) = bundled(&app, &name)?;
        if target == "repository" {
            let card = personalize_into_repository(&app, &workspace_id, &bundle, &skill)?;
            return Ok(Personalized {
                card: Some(card),
                plugin: None,
                pushed: false,
                pull_request: None,
                team_switched: false,
                owner: None,
                team_switch_problem: None,
            });
        }
        if target != "team" {
            return Err(format!("{target} isn't somewhere Plyloft can personalize a skill into.").into());
        }
        // The team half is the paid, outward write (§9): the gate first.
        team_gate(&app.state::<crate::license::LicenseStore>())?;
        // N14 (OB-7b): every GitHub call of the team half runs as the team's
        // account — the owner check below asks `gh` who this Mac is.
        let _account = team_account_scope(&app);
        let slug = current_team_repo(&app).ok_or_else(no_team_message)?;
        let (allowed, reason) = promote_authorization(&app, &slug);
        if !allowed {
            return Err(reason
                .unwrap_or_else(|| format!("Plyloft cannot share into this team's library from {THIS_MACHINE}."))
                .into());
        }
        let plugin = crate::team_skills::PLY_PLUGIN;
        let replace = replace.unwrap_or(false);
        let written = match promote_into_library(&app, &slug, plugin, &skill.name, &bundle.join(&skill.name), replace) {
            // Challenger (H9): a team skill of that name already there is a
            // teammate's (or an earlier fork's) — never shared over, and said
            // in words that name it rather than the Promote's generic replace.
            Err(error) if !replace && error.refusal().is_some() => {
                return Err(team_name_taken_words(&skill.name, plugin).into());
            }
            other => other?,
        };
        let (pushed, pull_request) = match written {
            LibraryWrite::Pushed(outcome, _) => (outcome.pushed, None),
            LibraryWrite::PullRequest(pr) => (false, Some(pr)),
        };
        // The team default: only the owner may write it, and never as a
        // hidden write for anyone else (R9 edge) — they hear who can.
        let (owner, login) = team_owner_facts(&app, &slug, Identity::Fresh);
        let you_own = matches!((&owner, &login), (Some(o), Some(l)) if o.eq_ignore_ascii_case(l));
        let mut team_switch_problem = None;
        let team_switched = if you_own && pushed {
            match set_team_default(&app, &skill.name, true) {
                Ok(_) => true,
                Err(why) => {
                    log::warn!("ply skills: the fork of {} is in the team library; the team default wasn't set ({why})", skill.name);
                    // Challenger (H9): the owner hears why, never "Only
                    // <themselves> can switch it off".
                    team_switch_problem = Some(why);
                    false
                }
            }
        } else {
            false
        };
        Ok(Personalized {
            card: None,
            plugin: Some(plugin.to_string()),
            pushed,
            pull_request,
            team_switched,
            owner: if team_switched || you_own { None } else { owner },
            team_switch_problem,
        })
    })
    .await
    .map_err(|error| format!("join personalize: {error}"))?
}

/// The source a fork is written from: the bundle's copy at its Plyloft
/// version, hashed by the repository's git as a checkout holding exactly
/// these bytes reads it.
fn plyloft_source<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    repo: &Path,
    bundle: &Path,
    skill: &crate::ply_skills::PlySkill,
) -> Result<TeamSkillSource, String> {
    let files: Vec<crate::skill_card::SourceFile> = crate::project_skills::read_tree(&bundle.join(&skill.name))?
        .into_iter()
        .map(|file| crate::skill_card::SourceFile { path: file.path, bytes: file.bytes, executable: file.executable })
        .collect();
    let tree = crate::skill_card::tree_id_of(repo, &files)?;
    let version = skill
        .version()
        .map(str::to_string)
        .unwrap_or_else(|| app.package_info().version.to_string());
    Ok(TeamSkillSource {
        kind: crate::skill_links::KIND_PLYLOFT,
        slug: crate::skill_links::KIND_PLYLOFT.to_string(),
        plugin: String::new(),
        source: crate::skill_card::Source {
            commit: version.clone(),
            path: format!("{}/{}", crate::ply_skills::BUNDLE_DIR, skill.name),
            tree,
            files,
        },
        reach: crate::skill_card::Reach::BOTH,
        confirmed: None,
        clone: PathBuf::new(),
        plyloft: Some(version),
    })
}

/// The link origin of a fork (§5.1: `kind` `plyloft`, `source` `plyloft`, no
/// plugin, `version.commit` the Plyloft version of the skill).
pub(crate) fn plyloft_origin(skill: &str, source: &crate::skill_card::Source) -> crate::skill_links::LinkOrigin {
    crate::skill_links::LinkOrigin {
        kind: crate::skill_links::KIND_PLYLOFT.to_string(),
        source: crate::skill_links::KIND_PLYLOFT.to_string(),
        plugin: None,
        name: skill.to_string(),
        path: Some(source.path.clone()),
        version: crate::skill_links::LinkVersion {
            commit: source.commit.clone(),
            content_id: source.tree.clone(),
            extra: Default::default(),
        },
        extra: Default::default(),
    }
}

/// Personalize into this workspace's repository: a skill card in Complete
/// whose one commit adds both copies and the link record — nothing else.
/// Owner, 2026-10-20: the fork rule (`ply_skill_switch::forks_here`), not a
/// definition write, switches Plyloft's own copy off, in each checkout once
/// the fork is there, so no session is ever left with neither copy.
pub(crate) fn personalize_into_repository<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    bundle: &Path,
    skill: &crate::ply_skills::PlySkill,
) -> Result<KanbanCard, String> {
    let name = skill.name.as_str();
    let (_, cwd) = workspace_checkout(app, workspace_id)?;
    if !cwd.is_dir() {
        return Err(format!(
            "This workspace's folder is not on {THIS_MACHINE} any more ({}), so there is nowhere to personalize {name}.",
            cwd.display()
        ));
    }
    if crate::skill_card::workspace_prefix(&cwd).is_err() {
        return Err(format!(
            "This workspace's folder isn't a git repository, so no card can carry a personalized {name}. \
             Switch Plyloft's {name} off here and write your own instead."
        ));
    }
    let workspaces = app.state::<WorkspaceStore>();
    team_gate_github_card_write(&workspaces, &app.state::<crate::license::LicenseStore>(), workspace_id, true)?;
    let (links, unreadable) = crate::skill_links::read_checkout(&cwd);
    refuse_unreadable_link(&unreadable, name)?;
    if let Some(link) = links.get(name) {
        return Err(format!(
            "{name} is already linked to {} here, so this repository has its own {name}.",
            crate::skill_links::origin_words(&link.origin)
        ));
    }
    let here = crate::skill_card::checkout_twin_ids(&cwd, name);
    if here.claude.is_some() || here.codex.is_some() {
        return Err(format!(
            "This repository already has a skill called {name}. Personalize makes a new copy of Plyloft's; \
             rename or remove that one first, or switch Plyloft's {name} off in this workspace."
        ));
    }
    let from = plyloft_source(app, &cwd, bundle, skill)?;
    let kanban = app.state::<KanbanStore>();
    skill_card_refusals(&kanban, workspace_id, &cwd, name, &from.source.tree)?;
    let verb = crate::skill_card::SkillVerb::Personalize;
    let notes = from.notes(verb, name, false);
    make_skill_card(app, workspace_id, &cwd, verb, name, &from.card_from(verb, name, false, &notes), None)
}

/// **Update** of a fork from Plyloft (R9): the bundle's current copy,
/// as an Update (or Take upstream) card — the team Update's rules.
pub(crate) fn update_from_plyloft<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    cwd: &Path,
    skill: &str,
    link: &crate::skill_links::SkillLink,
    take_upstream: bool,
) -> Result<KanbanCard, String> {
    let bundle = crate::ply_skills::bundle_dir(app).ok_or("This build of Plyloft has no skills of its own.")?;
    let source_skill = crate::ply_skills::read_bundle(&bundle)
        .into_iter()
        .find(|candidate| candidate.name == link.origin.name)
        .ok_or_else(|| format!("{} doesn't come with this version of Plyloft any more.", link.origin.name))?;
    let here = crate::skill_card::checkout_twin_ids(cwd, skill);
    let modified = crate::skill_links::modified_here(link, &here);
    if modified && !take_upstream {
        return Err(format!(
            "{skill} was changed in this repository since it was personalized, so an update would \
             overwrite that change. Compare shows what differs."
        ));
    }
    let from = plyloft_source(app, cwd, &bundle, &source_skill)?;
    let here_is_it = [&here.claude, &here.codex].into_iter().flatten().all(|id| *id == from.source.tree);
    if (!modified && from.source.tree == link.origin.version.content_id) || (modified && here_is_it) {
        return Err(format!("{skill} is already the version Plyloft has."));
    }
    let kanban = app.state::<KanbanStore>();
    skill_card_refusals(&kanban, workspace_id, cwd, skill, &from.source.tree)?;
    let verb = crate::skill_card::SkillVerb::Update;
    let take = take_upstream && modified;
    let notes = from.notes(verb, skill, take);
    make_skill_card(app, workspace_id, cwd, verb, skill, &from.card_from(verb, skill, take, &notes), Some(link))
}

/// What Plyloft holds now for a fork: the bundle's content id (the newest
/// `CHANGES.json` entry, which PPVP keeps equal to the bundle's tree), or
/// *Missing* when this version of Plyloft no longer has the skill.
pub(crate) fn plyloft_upstream<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    repo: &Path,
    name: &str,
) -> (crate::skill_links::Upstream, Option<String>) {
    use crate::skill_links::Upstream;
    let Some(bundle) = crate::ply_skills::bundle_dir(app) else {
        return (Upstream::Unavailable, None);
    };
    let skills = crate::ply_skills::read_bundle(&bundle);
    let Some(skill) = skills.iter().find(|skill| skill.name == name) else {
        // A bundle that read at all and lacks it: Plyloft removed it (R8).
        return if skills.is_empty() { (Upstream::Unavailable, None) } else { (Upstream::Missing, None) };
    };
    let version = skill.version().map(str::to_string);
    if let Some(change) = skill.changes.first().filter(|change| !change.content_id.is_empty()) {
        return (Upstream::At(change.content_id.clone()), version);
    }
    match plyloft_source(app, repo, &bundle, skill) {
        Ok(source) => (Upstream::At(source.source.tree), version),
        Err(_) => (Upstream::Unavailable, version),
    }
}

/// The files of a fork's starting version: this Mac's base store, else the
/// bundle's history of that version.
pub(crate) fn plyloft_start_files<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    link: &crate::skill_links::SkillLink,
) -> Option<std::collections::BTreeMap<String, Vec<u8>>> {
    let config_dir = app.try_state::<WorkspaceStore>().map(|store| store.config_dir.clone())?;
    if let Some(files) = crate::skill_bases::read(&config_dir, &link.origin.version.content_id) {
        return Some(files.into_iter().map(|file| (file.path, file.bytes)).collect());
    }
    let history = crate::ply_skills::history_dir(app)?;
    let files = crate::ply_skills::history_files(&history, &link.origin.name, &link.origin.version.commit)?;
    Some(files.into_iter().map(|file| (file.path, file.bytes)).collect())
}

/// The bundle's current files of a fork's skill.
pub(crate) fn plyloft_now_files<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    name: &str,
) -> Option<std::collections::BTreeMap<String, Vec<u8>>> {
    let bundle = crate::ply_skills::bundle_dir(app)?;
    let files = crate::project_skills::read_tree(&bundle.join(name)).ok()?;
    Some(files.into_iter().map(|file| (file.path, file.bytes)).collect())
}

/// The 2-way Compare of a fork (§9: free, read only): *Modified here* reads
/// where it started → here; otherwise here → Plyloft now.
pub(crate) fn compare_with_plyloft<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    link: &crate::skill_links::SkillLink,
    here_dir: &Path,
    modified: bool,
) -> Result<LinkCompare, String> {
    let here = || ("This repository".to_string(), "your copy".to_string(), "here".to_string(), files_of_dir(here_dir));
    let now = plyloft_now_files(app, &link.origin.name);
    if modified {
        if let Some(start) = plyloft_start_files(app, link) {
            return Ok(link_compare(
                (
                    format!("Plyloft {}", link.origin.version.commit),
                    "where this copy started".into(),
                    "the version it started from".into(),
                    start,
                ),
                here(),
                None,
                "here",
            ));
        }
    }
    let now = now.ok_or_else(|| format!("{} doesn't come with this version of Plyloft, so there is nothing to compare with.", link.origin.name))?;
    Ok(link_compare(here(), ("Plyloft".into(), "its version now".into(), "Plyloft".into(), now), None, "upstream"))
}

#[cfg(test)]
#[path = "ply_skill_ipc_tests.rs"]
mod tests;
