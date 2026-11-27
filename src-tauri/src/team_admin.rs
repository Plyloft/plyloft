//! v1.118.0 (team sharing rung 5): the owner's side of a team.
//!
//! Rungs 1–4 are everything a *member* does — join with an invite code, pick team
//! workspaces, read and write the team library. The three things only the
//! owner does were still a shell script and two hand-typed `gh` commands
//! (`scripts/team-init.sh`, and its printed "now run these" tail). This
//! module is those three, as product:
//!
//! - **Create team** — [`create_team_with`]: `gh repo create` private, the
//!   manifest that defines the team, the empty library rungs 2 and 3 fill.
//!   Launch T1: the team runs on the owner's Team plan; keys are retired.
//! - **Add member** — [`build_invite_plan`], then [`invite_member_with`].
//!   An invite is not one grant, it is one per repository the team owns:
//!   the team repo *and* every team workspace. Ply lists all of them with
//!   the permission it would grant and does nothing until the owner has
//!   read that list ([`grants_were_confirmed`]).
//! - **Assisted discovery** — [`discovery_proposals`]: repositories this
//!   account can reach that already carry `.atelier/workspace.json` (ADR
//!   0003) or the older `.atelier/workspace_default.json`, i.e. repos that are already set up as Ply workspaces. It *proposes*;
//!   the owner adds or ignores, which is the design's word for it
//!   ("Assisted discovery … only proposes; the owner decides").
//!
//! Everything that talks to GitHub or to git is injected at the call site,
//! so every rule below is tested on temporary directories and a local bare
//! remote, and never reaches the network.

use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::platform::THIS_MACHINE;
use crate::github::CollaboratorAccess;
use crate::team::{
    is_valid_repo_slug, LibraryGit, TeamManifest, TeamMember, TeamWorkspace,
    MANIFEST_FILE,
};

/// The marker that makes a repository *look like* a Ply workspace: it is
/// committed, it reaches every teammate, and `workspace::import_default`
/// turns it into a registered workspace on clone. A repo carrying one has
/// already been set up for Ply by somebody — which is the whole signal
/// assisted discovery is built on.
pub const WORKSPACE_MARKER: &str = ".atelier/workspace_default.json";

/// ADR 0003's shared definition, which every repository adopted since
/// v1.150 carries instead of (or as well as) [`WORKSPACE_MARKER`]. Either
/// file means somebody already set the repository up as a Ply workspace.
pub const SHARED_DEFINITION_MARKER: &str = crate::workspace_definition::DEFINITION_PATH;

/// Every file assisted discovery accepts as "already set up for Ply",
/// newest first: the scan asks for the next one only when the previous
/// answer was not a yes.
pub const WORKSPACE_MARKERS: [&str; 2] = [SHARED_DEFINITION_MARKER, WORKSPACE_MARKER];

/// Fold one repository's answers for [`WORKSPACE_MARKERS`] into the one
/// `carries_marker` the filter reads: any yes is a yes; otherwise a probe
/// that could not be answered makes the whole answer unknown (never a no);
/// only all-answered noes are a no. No answers at all is unknown too.
pub fn combine_marker_answers(answers: &[Result<bool, String>]) -> Option<bool> {
    if answers.iter().any(|a| matches!(a, Ok(true))) {
        return Some(true);
    }
    if answers.is_empty() || answers.iter().any(|a| a.is_err()) {
        return None;
    }
    Some(false)
}

/// The permission a team member needs on every repository the team owns.
///
/// `push`, not `pull`, and the same on both kinds: on the team repo because
/// sharing Knowledge and skills into the team library is a commit and a push
/// (`DESIGN.md`: "Anyone with GitHub write access to the team repo can share
/// into the library"), and on a team workspace because working a card means
/// pushing its branch and opening its PR. Ply grants one permission and says
/// so, rather than offering a matrix nobody would tune.
pub const MEMBER_PERMISSION: &str = "push";

/// How many repositories one assisted-discovery scan looks at.
pub const DISCOVERY_SCAN_LIMIT: usize = 100;

// ── Names ───────────────────────────────────────────────────────────

/// A GitHub login: ASCII alphanumerics and single inner hyphens, at most 39
/// characters. Checked before anything is sent, because a login is joined
/// into every `gh api` path an invite runs.
pub fn is_valid_login(login: &str) -> bool {
    let login = login.trim();
    !login.is_empty()
        && login.len() <= 39
        && !login.starts_with('-')
        && !login.ends_with('-')
        && !login.contains("--")
        && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// `scripts/team-init.sh`'s `slugify`, in Rust: lowercase, every run of
/// non-alphanumerics collapsed to one hyphen, no leading or trailing one.
/// The two must agree — a team created either way should get the same
/// suggested repo name.
pub fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut pending_hyphen = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_hyphen && !out.is_empty() {
                out.push('-');
            }
            pending_hyphen = false;
            out.push(ch.to_ascii_lowercase());
        } else {
            pending_hyphen = true;
        }
    }
    out
}

/// The team repo Ply suggests for a team called `name`, owned by `login` —
/// `scripts/team-init.sh`'s default. Empty when the name slugifies to
/// nothing, which the form reports rather than sending.
///
/// F6 (team walk): a name that already ends in the word "team" keeps it once
/// — "Plyloft test team" is `plyloft-test-team`, not `…-team-team`.
pub fn suggest_team_repo(login: &str, name: &str) -> String {
    let slug = slugify(name);
    if slug.is_empty() || login.trim().is_empty() {
        return String::new();
    }
    if slug == "team" || slug.ends_with("-team") {
        format!("{}/{}", login.trim(), slug)
    } else {
        format!("{}/{}-team", login.trim(), slug)
    }
}

// ── Who may act ─────────────────────────────────────────────────────

/// The gate in front of every owner-only action: creating the team,
/// inviting a member, editing the list of team workspaces.
///
/// Two separate refusals, because two different people fix them. The plan is
/// a Plyloft matter (launch G3: the owner's Team plan, for this team, as the
/// team's account). Being the owner is the manifest's, and
/// GitHub cannot enforce it — repository write access is repository-wide, so
/// any member with write could push a manifest edit. **This check is the
/// only enforcement of "the owner is the only person who edits members and
/// team workspaces"**, which is why an unknown login is a refusal here while
/// it is never a refusal for membership: refusing to *edit* costs a retry,
/// and getting it wrong costs the team's definition of itself.
pub fn authorize_owner_action(
    team_allowed: bool,
    owner_login: Option<&str>,
    login: Option<&str>,
) -> Result<(), String> {
    if !team_allowed {
        return Err(crate::license::TeamAccess::NoTeamPlan
            .refusal()
            .unwrap_or_default());
    }
    let Some(owner) = owner_login.map(str::trim).filter(|s| !s.is_empty()) else {
        return Err(format!(
            "The team manifest names no owner, so Plyloft cannot tell whether you may edit it. \
             Add an `\"owner\": true` member to {MANIFEST_FILE} in the team repo."
        ));
    };
    let Some(login) = login.map(str::trim).filter(|s| !s.is_empty()) else {
        return Err(
            "Plyloft could not read your GitHub login, so it cannot confirm you are the team \
             owner. Refresh Settings › Team › Members and library once `gh` can reach GitHub."
                .to_string(),
        );
    };
    if !login.eq_ignore_ascii_case(owner) {
        return Err(format!(
            "Only the team owner ({owner}) edits members and team workspaces. You are \
             signed in to GitHub as {login}."
        ));
    }
    Ok(())
}

// ── Create team ─────────────────────────────────────────────────────

/// A validated Create-team form. Nothing here has touched GitHub yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTeamPlan {
    pub name: String,
    pub repo: String,
    pub owner_login: String,
    /// The repositories the new team lists as team workspaces. May be empty:
    /// a team with no workspaces yet is a perfectly good team, and assisted
    /// discovery is how the owner fills it in.
    pub workspaces: Vec<TeamWorkspace>,
}

/// Validate the form. Every refusal names the field, because this is the
/// one screen where a typo becomes a repository on GitHub. An empty `repo`
/// takes [`suggest_team_repo`]'s answer.
pub fn plan_create_team(
    name: &str,
    repo: &str,
    owner_login: &str,
    workspaces: &[String],
) -> Result<CreateTeamPlan, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A team needs a name.".to_string());
    }
    // A team name is a display string in every member's panel and a word in
    // a line of its own. A newline or a control character in it is
    // never what somebody meant, and both make one of those unreadable.
    if name.chars().any(char::is_control) {
        return Err("A team name cannot contain line breaks or control characters.".to_string());
    }
    let owner_login = owner_login.trim();
    if !is_valid_login(owner_login) {
        return Err(
            "Plyloft could not read your GitHub login, so it does not know who would own this \
             team. Check `gh auth status`."
                .to_string(),
        );
    }
    // A blank field means "use the suggestion", and the suggestion is
    // computed here rather than in the form: the frontend's version is a
    // live placeholder, and the name that actually becomes a repository on
    // GitHub has to come from one place.
    let typed = repo.trim();
    let suggested;
    let repo = if typed.is_empty() {
        suggested = suggest_team_repo(owner_login, name);
        if suggested.is_empty() {
            return Err(format!(
                "Plyloft cannot suggest a repository name for \"{name}\" — type one, as                  owner/name."
            ));
        }
        suggested.as_str()
    } else {
        typed
    };
    if !is_valid_repo_slug(repo) {
        return Err(format!(
            "The team repo must be owner/name on GitHub (got: {repo})."
        ));
    }
    let mut listed: Vec<TeamWorkspace> = Vec::new();
    for slug in workspaces {
        let slug = slug.trim();
        if slug.is_empty() {
            continue;
        }
        if !is_valid_repo_slug(slug) {
            return Err(format!(
                "{slug} is not an owner/name repository, so it cannot be a team workspace."
            ));
        }
        if slug.eq_ignore_ascii_case(repo) {
            return Err(format!(
                "{slug} is the team repo itself. The team repo holds the manifest and the \
                 library; it is never a workspace."
            ));
        }
        if listed.iter().any(|w| w.repo.eq_ignore_ascii_case(slug)) {
            continue;
        }
        listed.push(TeamWorkspace {
            repo: slug.to_string(),
            name: None,
            default_branch: None,
        });
    }
    Ok(CreateTeamPlan {
        name: name.to_string(),
        repo: repo.to_string(),
        owner_login: owner_login.to_string(),
        workspaces: listed,
    })
}

impl CreateTeamPlan {
    /// The manifest that *is* this team — the shape `team::parse_manifest`
    /// reads and `scripts/team-init.sh` writes.
    pub fn manifest(&self) -> TeamManifest {
        TeamManifest {
            schema_version: 1,
            name: self.name.clone(),
            members: vec![TeamMember {
                login: self.owner_login.clone(),
                owner: true,
                extra: Default::default(),
            }],
            workspaces: self.workspaces.clone(),
            extra: Default::default(),
        }
    }
}

/// A manifest as it is written into the team repo: pretty JSON with a
/// trailing newline, so a human editing it by hand and a Ply write produce
/// the same diff shape.
pub fn manifest_bytes(manifest: &TeamManifest) -> Result<Vec<u8>, String> {
    let mut json = serde_json::to_vec_pretty(manifest)
        .map_err(|e| format!("serialise {MANIFEST_FILE}: {e}"))?;
    json.push(b'\n');
    Ok(json)
}

/// Write the manifest into a clone — **atomically**, through the canonical
/// tempfile-plus-rename helper (hard rule 3).
///
/// Every writer of `team.json` goes through this one function. The manifest
/// *is* the team: a write interrupted halfway leaves a file that will not
/// parse, and every owner action then refuses with "team.json is not
/// readable" until somebody thinks to run `git checkout -- team.json`. The
/// library's other writes are content files a member can see are missing;
/// this one is the file that has to parse before Ply can tell them anything
/// at all.
pub fn write_manifest(clone_dir: &Path, manifest: &TeamManifest) -> Result<(), String> {
    let json = String::from_utf8(manifest_bytes(manifest)?)
        .map_err(|e| format!("serialise {MANIFEST_FILE}: {e}"))?;
    crate::atomic::write_atomic_text(&clone_dir.join(MANIFEST_FILE), &json)
        .map_err(|e| format!("write {MANIFEST_FILE}: {e}"))
}

/// The team repo's README — the same text `scripts/team-init.sh` writes, so
/// a team created either way explains itself the same way.
pub fn readme_text(team_name: &str) -> String {
    format!(
        "# {team_name} — Plyloft team\n\n\
         This repository **is** the team (Plyloft, ADR 0002). Nothing here is meant to be\n\
         edited by hand except by the team owner.\n\n\
         - `team.json` — the manifest: team name, members, team workspaces.\n\
         \x20 Membership = listed here **and** able to read this repo on GitHub.\n\
         - `library/knowledge/` — Team-scope Knowledge (Plyloft writes it).\n\
         - `library/claude/`, `library/codex/` — team skills for both CLIs.\n\n\
         Members join from Plyloft's Settings › Team › Members and library with a seat on the team's plan; Plyloft\n\
         clones it under its own app support and never treats it as a workspace.\n"
    )
}

/// The library directories rungs 2 and 3 fill. Git does not track an empty
/// directory, so each carries a `.gitkeep` — the same three the script
/// seeds, and the reason rung 3's library reader already tolerates a
/// `library/codex/` holding nothing but one.
pub const LIBRARY_SEED_DIRS: [&str; 3] =
    ["library/knowledge", "library/claude", "library/codex"];

/// What creating a team produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedTeam {
    pub name: String,
    pub repo: String,
    pub clone_path: String,
    /// The team was already there, finished and owned by this account —
    /// Ply changed nothing on GitHub.
    pub already_existed: bool,
    /// Launch T1 (D17): the repository is bound to the owner's Team plan on
    /// the Plyloft server (`POST /team`). Set by `commands::team_create`.
    pub bound: bool,
    /// Why it isn't bound yet, with how to finish ("Finish creating your
    /// team" retries it).
    pub bind_error: Option<String>,
}

/// Where a Create-team run is starting from.
///
/// Creating a team is four steps against two systems — make the repository,
/// clone it, write the files, push — and the first one is the only
/// irreversible one. Anything that fails after it leaves a real, empty,
/// private repository on GitHub, and telling the owner to "pick a different
/// name" would be advice to abandon it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateStart {
    /// Nothing exists yet.
    Fresh,
    /// The repository exists, **is private and has no commits** — exactly
    /// what `gh repo create --private` leaves, and exactly what a creation
    /// that died before its push leaves. Continue into it.
    ///
    /// Decided by [`resume_decision`], never by the absence of one file.
    Resume,
    /// The repository is **already this owner's finished team**: private,
    /// with history, and a `team.json` that names this login as its owner.
    ///
    /// Two ways to get here, both real. A push GitHub accepted whose
    /// acknowledgement never reached Ply — the run reported a failure and
    /// said "press Create team again", and the push had landed. Or the owner
    /// created the team, closed Settings before reading the result,
    /// and came back to a form that no longer knew about it. Either way the
    /// answer is the creation result, with nothing on GitHub touched.
    Completed(TeamManifest),
}

/// Whether an existing repository may be finished as a team repo.
///
/// "It has no `team.json`" is not enough, and the difference is the whole
/// point: an ordinary repository the owner happens to type the name of has
/// no manifest either, and resuming into it would overwrite its README and
/// publish the team's membership into it — into a *public* one, if that is
/// what it is, and every later library write after it. So only the state
/// this flow itself produces qualifies:
///
/// - **private** — a team repo holds who is in the team and everything they
///   share, and Ply only ever creates one private;
/// - **empty** — no commits at all. `gh repo create` makes it that way and a
///   failed run leaves it that way, because the push is the last step and a
///   push is all-or-nothing. A repository with any history is somebody's, and
///   there is nothing of this flow's in it to finish.
///
/// `Err` from GitHub is a refusal too: "could not tell" is never the reason
/// Ply writes into somebody's repository.
pub fn resume_decision(
    repo: &str,
    login: &str,
    state: Result<crate::github::RemoteRepoState, String>,
) -> Result<CreateStart, String> {
    let state = state.map_err(|e| {
        format!(
            "{repo} already exists on GitHub, and Plyloft could not confirm it is the empty \
             private repository an earlier Create team left behind ({e}). Pick another \
             name, or check it on GitHub and try again."
        )
    })?;
    if !state.private {
        return Err(format!(
            "{repo} already exists on GitHub and is public. A team repo holds who is in \
             the team and everything they share, so Plyloft only uses a private one. Pick \
             another name."
        ));
    }
    if state.empty {
        return Ok(CreateStart::Resume);
    }
    // History. The only history Ply may adopt is a finished team this very
    // account owns — recognised by its manifest, and then used as it is:
    // nothing is written, so whatever the team already holds is untouched.
    if let Some(manifest) = state
        .manifest
        .as_deref()
        .and_then(|text| crate::team::parse_manifest(text.as_bytes()).ok())
    {
        return match manifest.owner_login() {
            Some(owner) if owner.eq_ignore_ascii_case(login.trim()) => {
                Ok(CreateStart::Completed(manifest))
            }
            Some(owner) => Err(format!(
                "{repo} is already a Plyloft team, owned by {owner}. Only its owner can \
                 finish creating it; pick another name for yours."
            )),
            None => Err(format!(
                "{repo} already carries a team manifest that names no owner, so Plyloft \
                 cannot tell whose team it is. Pick another name."
            )),
        };
    }
    Err(format!(
        "{repo} already exists on GitHub and already has commits, so it is not an \
         unfinished Create team. Plyloft will not write a team into a repository that \
         holds somebody's work. Pick another name."
    ))
}

/// Create the team: the private repo, its manifest, its empty library.
///
/// Ply clones straight into the team store's own directory rather than a
/// temporary one, so the moment this returns the panel has the clone every
/// other team command reads — no refresh round trip in between, and no
/// second copy of the team repo on disk.
///
/// Every step after the repository exists is written to be **repeatable**:
/// an existing clone of this same repo is reused rather than refused,
/// identical bytes stage nothing, and the push runs regardless. So a run that
/// died at the clone, the write or the push finishes on the next press
/// instead of stranding an empty repository nobody can get back to — and the
/// error it failed with says which repository is waiting.
///
/// `publish` commits and pushes; production hands it `git`, tests hand it a
/// real git against a local bare remote.
///
/// Measured while building (2026-09-10), because the whole flow rests on it:
/// `git clone` of an **empty** repository still writes `branch.<name>.remote`
/// and `.merge`, so the plain `git push` behind `publish` pushes the first
/// commit without needing `-u`.
pub fn create_team_with(
    plan: &CreateTeamPlan,
    start: CreateStart,
    clone_dir: &Path,
    create_repo: impl FnOnce(&str, &str) -> Result<(), String>,
    clone: impl FnOnce(&str, &Path) -> Result<(), String>,
    publish: impl FnOnce(&Path, &[String], &str) -> Result<(), String>,
    origin_of: impl Fn(&Path) -> Option<String>,
) -> Result<CreatedTeam, String> {
    // A directory here that is *not* a checkout of this repo means this Mac
    // is on some other team by that name. Refuse rather than write into it.
    let clone_is_reusable = match clone_dir.join(".git").exists() {
        true => match origin_of(clone_dir) {
            Some(url) if crate::team::origin_matches(&url, &plan.repo) => true,
            _ => {
                return Err(format!(
                    "{} is already a checkout of another repository. Move it aside, or \
                     pick a different team repo.",
                    clone_dir.display()
                ))
            }
        },
        false if clone_dir.exists() => {
            return Err(format!(
                "{} already exists on {THIS_MACHINE} and is not a git checkout. Remove it, or \
                 pick a different team repo.",
                clone_dir.display()
            ))
        }
        false => false,
    };

    // Already finished: make sure this Mac has the clone every team command
    // reads (a clone writes nothing to GitHub), and hand back the command.
    // The manifest's own name wins over what was typed — it is the team.
    if let CreateStart::Completed(manifest) = &start {
        if !clone_is_reusable {
            if let Some(parent) = clone_dir.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("create {}: {e}", parent.display()))?;
            }
            clone(&plan.repo, clone_dir).map_err(|e| {
                format!(
                    "{e} — {} is already your team on GitHub and nothing was changed \
                     there. Press Create team again to fetch it.",
                    plan.repo
                )
            })?;
        }
        return Ok(CreatedTeam {
            name: manifest.name.clone(),
            repo: plan.repo.clone(),
            clone_path: clone_dir.to_string_lossy().to_string(),
            already_existed: true,
            bound: false,
            bind_error: None,
        });
    }

    if start == CreateStart::Fresh {
        create_repo(&plan.repo, &format!("Plyloft team: {}", plan.name))?;
    }
    // From here on the repository exists, so every failure names it: the
    // owner has to be able to find what was made on their behalf.
    let stranded = |step: &str, error: String| {
        format!(
            "{error} — {} exists on GitHub but is not finished ({step}). Press Create \
             team again with the same name to complete it.",
            plan.repo
        )
    };

    if !clone_is_reusable {
        if let Some(parent) = clone_dir.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| stranded("cloning it", format!("create {}: {e}", parent.display())))?;
        }
        clone(&plan.repo, clone_dir).map_err(|e| stranded("cloning it", e))?;
    }

    let mut paths = vec![MANIFEST_FILE.to_string(), "README.md".to_string()];
    write_manifest(clone_dir, &plan.manifest()).map_err(|e| stranded("writing the manifest", e))?;
    std::fs::write(clone_dir.join("README.md"), readme_text(&plan.name))
        .map_err(|e| stranded("writing the manifest", format!("write README.md: {e}")))?;
    for dir in LIBRARY_SEED_DIRS {
        let path = clone_dir.join(dir);
        std::fs::create_dir_all(&path)
            .map_err(|e| stranded("seeding the library", format!("create {}: {e}", path.display())))?;
        std::fs::write(path.join(".gitkeep"), b"")
            .map_err(|e| stranded("seeding the library", format!("write {dir}/.gitkeep: {e}")))?;
        paths.push(format!("{dir}/.gitkeep"));
    }
    publish(
        clone_dir,
        &paths,
        &format!("team: {} manifest and empty library", plan.name),
    )
    .map_err(|e| stranded("pushing the manifest", e))?;

    Ok(CreatedTeam {
        name: plan.name.clone(),
        repo: plan.repo.clone(),
        clone_path: clone_dir.to_string_lossy().to_string(),
        already_existed: false,
        bound: false,
        bind_error: None,
    })
}


// ── Add member: the invite plan ─────────────────────────────────────

/// What Ply would do about one repository, for one person.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InviteAction {
    /// GitHub will be asked to grant access.
    Grant,
    /// GitHub already gives this person what the team needs. Shown anyway —
    /// the confirmation screen's job is to list *every* repository the team
    /// owns, including the ones that need nothing.
    AlreadyHas,
    /// GitHub could not say what access this person has. Ply never grants
    /// on a guess: the PUT carries an explicit permission, so a "needless"
    /// grant to someone who is already an admin is a downgrade, not a no-op
    /// (6th Challenger round on PR #29). The step is shown, and the plan
    /// cannot be applied until a refresh resolves it.
    Unresolved,
    /// N14 (item 1): GitHub already holds an invitation for this person
    /// here that they haven't accepted yet. Not offered again: the grant is
    /// sent, it is waiting on them. An *expired* invitation is a grant.
    Invited,
    /// GitHub says no account has this login. Refused: the plan can't be
    /// sent, and reading it again wouldn't change that.
    NoSuchAccount,
}

/// Why a repository is on the list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InviteRepoKind {
    TeamRepo,
    Workspace,
}

/// One line of the confirmation screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteStep {
    pub repo: String,
    pub kind: InviteRepoKind,
    /// The permission Ply would grant — always [`MEMBER_PERMISSION`].
    pub permission: String,
    /// What GitHub says they have now, in a word.
    pub current: String,
    pub action: InviteAction,
    /// N14 (item 1): with [`InviteAction::Invited`], the day (`YYYY-MM-DD`)
    /// the pending invitation expires.
    pub invitation_expires: Option<String>,
    /// What this grant is *for*, in the member's terms. The owner is being
    /// asked to hand someone write access to a repository; "why" belongs on
    /// the same line as "what".
    pub purpose: String,
}

/// Everything the owner reads before a single `gh api` call is made.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitePlan {
    pub login: String,
    pub team_name: String,
    pub steps: Vec<InviteStep>,
    /// The manifest does not list them yet, so applying this plan commits
    /// and pushes a manifest that does.
    pub adds_to_manifest: bool,
    /// Repositories in the manifest that cannot be granted — a slug the
    /// manifest holds that is not `owner/name`. Named rather than dropped:
    /// a member silently missing one workspace is the failure this whole
    /// screen exists to prevent.
    pub warnings: Vec<String>,
    /// The exact grants, as [`InvitePlan::grants`] renders them, space-
    /// separated. Carried back by the frontend when the owner confirms.
    pub digest: String,
}

impl InvitePlan {
    /// The set of grants this plan would make: `repo=permission`, sorted,
    /// lowercased. Repositories that need nothing are deliberately absent —
    /// what is being confirmed is what Ply would *grant*.
    pub fn grants(&self) -> Vec<String> {
        let mut grants: Vec<String> = self
            .steps
            .iter()
            .filter(|step| step.action == InviteAction::Grant)
            .map(|step| format!("{}={}", step.repo.to_ascii_lowercase(), step.permission))
            .collect();
        grants.sort();
        grants.dedup();
        grants
    }

    /// Is there anything to do at all?
    pub fn is_empty(&self) -> bool {
        !self.adds_to_manifest
            && self
                .steps
                .iter()
                .all(|step| matches!(step.action, InviteAction::AlreadyHas | InviteAction::Invited))
    }
}

/// Build the confirmation screen.
///
/// `access` is what GitHub answered for each repository, in manifest order;
/// a repository missing from it is [`CollaboratorAccess::Unknown`], which
/// plans a grant rather than assuming one. The whole function is pure so
/// that the rule "an invite is one grant per repository the team owns" is
/// stated once and tested without a GitHub account. The app builds it with
/// the pending invitations ([`build_invite_plan_with`]).
#[cfg_attr(not(test), allow(dead_code))]
pub fn build_invite_plan(
    login: &str,
    team_repo: &str,
    manifest: &TeamManifest,
    access: &[(String, CollaboratorAccess)],
) -> Result<InvitePlan, String> {
    build_invite_plan_with(login, team_repo, manifest, access, &[])
}

/// N14 (item 1): a pending invitation, as the invite plan and Members read
/// it — the repository, the invitee and GitHub's dates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingInvitation {
    pub repo: String,
    pub invitation: crate::github::RepoInvitation,
}

/// How long GitHub keeps a repository invitation open (GitHub docs:
/// "Invitations … expire after 7 days").
pub const INVITATION_DAYS: i64 = 7;

/// The day (`YYYY-MM-DD`, UTC) an invitation sent at `created_at` expires;
/// `None` when GitHub's date doesn't parse.
pub fn invitation_expiry(created_at: &str) -> Option<String> {
    let at = chrono::DateTime::parse_from_rfc3339(created_at.trim()).ok()?;
    let ends = at.with_timezone(&chrono::Utc) + chrono::Duration::days(INVITATION_DAYS);
    Some(ends.format("%Y-%m-%d").to_string())
}

/// The invitation `login` holds for `repo`, open ones before expired ones.
fn invitation_for<'a>(
    invitations: &'a [PendingInvitation],
    repo: &str,
    login: &str,
) -> Option<&'a crate::github::RepoInvitation> {
    let theirs: Vec<&crate::github::RepoInvitation> = invitations
        .iter()
        .filter(|p| {
            p.repo.eq_ignore_ascii_case(repo)
                && p.invitation.login.eq_ignore_ascii_case(login.trim())
        })
        .map(|p| &p.invitation)
        .collect();
    theirs.iter().find(|i| !i.expired).or(theirs.first()).copied()
}

/// [`build_invite_plan`] knowing the pending invitations (N14 item 1): a
/// repository where this person already has an open invitation is
/// [`InviteAction::Invited`], never offered as a grant again.
pub fn build_invite_plan_with(
    login: &str,
    team_repo: &str,
    manifest: &TeamManifest,
    access: &[(String, CollaboratorAccess)],
    invitations: &[PendingInvitation],
) -> Result<InvitePlan, String> {
    let login = login.trim();
    if !is_valid_login(login) {
        return Err(format!(
            "{login:?} is not a GitHub login. Logins are letters, digits and single \
             hyphens."
        ));
    }
    if !is_valid_repo_slug(team_repo) {
        return Err(format!(
            "{team_repo} is not an owner/name repository, so Plyloft cannot grant access to it."
        ));
    }
    let answered = |slug: &str| -> CollaboratorAccess {
        access
            .iter()
            .find(|(repo, _)| repo.eq_ignore_ascii_case(slug))
            .map(|(_, a)| *a)
            .unwrap_or(CollaboratorAccess::Unknown)
    };
    let step = |repo: &str, kind: InviteRepoKind, purpose: &str| {
        let current = answered(repo);
        let open = invitation_for(invitations, repo, login).filter(|i| !i.expired);
        InviteStep {
            repo: repo.to_string(),
            kind,
            permission: MEMBER_PERMISSION.to_string(),
            current: if open.is_some() && !current.can_push() {
                "a pending invitation".to_string()
            } else {
                current.label().to_string()
            },
            invitation_expires: open
                .filter(|_| !current.can_push())
                .and_then(|i| invitation_expiry(&i.created_at)),
            // An unknown answer is neither a grant nor a pass: the PUT sets
            // the permission it names, so granting `push` to someone whose
            // access Ply could not read may take `admin` away from them. The
            // step stays visible with the reason; apply refuses until a
            // refresh answers.
            action: if current == CollaboratorAccess::NoSuchAccount {
                InviteAction::NoSuchAccount
            } else if current.can_push() {
                InviteAction::AlreadyHas
            } else if open.is_some() {
                // Sent and waiting on them; GitHub answers "none" or can't
                // say for a person who hasn't accepted yet.
                InviteAction::Invited
            } else if current == CollaboratorAccess::Unknown {
                InviteAction::Unresolved
            } else {
                InviteAction::Grant
            },
            purpose: purpose.to_string(),
        }
    };

    let mut steps = vec![step(
        team_repo,
        InviteRepoKind::TeamRepo,
        "Read the team and share Knowledge and skills into the team library.",
    )];
    let mut warnings = Vec::new();
    for entry in &manifest.workspaces {
        if !is_valid_repo_slug(&entry.repo) {
            warnings.push(format!(
                "{} is not an owner/name repository, so Plyloft cannot grant access to it. \
                 Fix it in the team manifest.",
                entry.repo
            ));
            continue;
        }
        if entry.repo.eq_ignore_ascii_case(team_repo)
            || steps.iter().any(|s| s.repo.eq_ignore_ascii_case(&entry.repo))
        {
            continue;
        }
        steps.push(step(
            &entry.repo,
            InviteRepoKind::Workspace,
            "Clone it as a workspace, and push card branches and pull requests.",
        ));
    }

    let mut plan = InvitePlan {
        login: login.to_string(),
        team_name: manifest.name.clone(),
        steps,
        adds_to_manifest: !manifest.lists(login),
        warnings,
        digest: String::new(),
    };
    plan.digest = plan.grants().join(" ");
    Ok(plan)
}

/// Refuse to apply a plan that grants anything the owner did not read.
///
/// The confirmation screen is the point of this rung, so it has to be worth
/// something: GitHub's answers can change between the review and the press,
/// and a plan that *shrank* is covered by what was confirmed while one that
/// grew is not. Comparing sets rather than digests is what makes the
/// harmless direction harmless.
pub fn grants_were_confirmed(fresh: &InvitePlan, confirmed: &str) -> Result<(), String> {
    let confirmed: Vec<&str> = confirmed.split_whitespace().collect();
    let unseen: Vec<String> = fresh
        .grants()
        .into_iter()
        .filter(|grant| !confirmed.iter().any(|c| *c == grant))
        .collect();
    if unseen.is_empty() {
        return Ok(());
    }
    Err(format!(
        "The team changed while you were reading the invite: Plyloft would now also grant \
         {}. Review the list again before sending.",
        unseen.join(", ")
    ))
}

/// Add `login` to a manifest, if it is not already there. `None` when the
/// manifest already lists them — nothing to write.
pub fn manifest_with_member(manifest: &TeamManifest, login: &str) -> Option<TeamManifest> {
    if manifest.lists(login) {
        return None;
    }
    let mut next = manifest.clone();
    next.members.push(TeamMember {
        login: login.trim().to_string(),
        owner: false,
        extra: Default::default(),
    });
    Some(next)
}

/// Add a team workspace to a manifest. `None` when it is already listed.
pub fn manifest_with_workspace(
    manifest: &TeamManifest,
    repo: &str,
    name: Option<&str>,
) -> Option<TeamManifest> {
    let repo = repo.trim();
    if manifest
        .workspaces
        .iter()
        .any(|w| w.repo.eq_ignore_ascii_case(repo))
    {
        return None;
    }
    let mut next = manifest.clone();
    next.workspaces.push(TeamWorkspace {
        repo: repo.to_string(),
        name: name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        default_branch: None,
    });
    Some(next)
}

/// QoL 14.4 (G25): take a team workspace off a manifest. `None` when it is
/// not listed. Only the list changes: members' access on GitHub and their
/// clones stay as they are.
pub fn manifest_without_workspace(manifest: &TeamManifest, repo: &str) -> Option<TeamManifest> {
    let repo = repo.trim();
    if !manifest
        .workspaces
        .iter()
        .any(|w| w.repo.eq_ignore_ascii_case(repo))
    {
        return None;
    }
    let mut next = manifest.clone();
    next.workspaces.retain(|w| !w.repo.eq_ignore_ascii_case(repo));
    Some(next)
}

/// What applying an invite plan did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteOutcome {
    pub login: String,
    /// **The team repo on GitHub lists them.** Not "the local clone does":
    /// this is only ever true after a push Ply watched succeed, which is the
    /// whole precondition for granting anything.
    pub listed: bool,
    /// True when this call committed the manifest. False when it was already
    /// listed — including when an earlier attempt committed it locally and
    /// only the push is being completed now.
    pub manifest_written: bool,
    /// Repositories GitHub created an invitation for.
    pub invited: Vec<String>,
    /// Repositories that needed nothing: already a collaborator, or already
    /// covered by an organisation.
    pub already_had: Vec<String>,
    /// N14 (item 1): repositories where an invitation was already waiting on
    /// them — not sent again.
    pub already_invited: Vec<String>,
    /// Grants GitHub refused, with its reason. The member is listed in the
    /// manifest either way, so this is the half the owner must retry — and
    /// the PUT behind it is idempotent, so retrying is safe.
    pub failed: Vec<String>,
}

/// Who is being invited, and to which team.
pub struct InviteRequest<'a> {
    pub login: &'a str,
    pub team_repo: &'a str,
    /// The digest of the plan the owner read. Nothing outside it is granted.
    pub confirmed: &'a str,
}

/// Apply an invite: **the manifest, pushed, and only then the grants**.
///
/// Not the other way around. Both halves are recoverable and Ply names which
/// one is missing (`Membership::NotListed` vs `NoRepoAccess`), but they are
/// not equally visible: a member listed without access is on the owner's
/// screen, in the team's own history, and the retry is one idempotent PUT
/// away. A grant made and never recorded is access handed out that nothing in
/// the team knows about — the failure nobody goes looking for.
///
/// Three things this function refuses to shortcut, each of which was a way
/// for that ordering to be true in the code and false in practice:
///
/// - **The manifest round trip always runs**, even when the local clone
///   already lists them. A previous attempt whose *push* was refused left the
///   membership commit sitting locally, and a plan built from that clone
///   would read "already listed", skip the publish and grant access the
///   team's own repository still does not record. Rung 2 wrote the rule
///   down — always push, even when the write staged nothing — and this is
///   what it is for.
/// - **A publish that did not push grants nothing.** `pushed: false` means
///   the clone has no remote, so nothing was verified and nothing reached
///   anybody. There is no team to be recorded in.
/// - **The plan is rebuilt from the manifest the pull produced**, not from
///   the one the panel read. Another Mac may have added or removed a team
///   workspace in between, and the repository set is what the grants are.
///   `confirmed` is then checked against *that* plan, so a workspace that
///   appeared refuses the press instead of being granted unread, and one that
///   was removed is simply not granted.
///
/// `authorize` re-runs the owner check against the pulled manifest for the
/// same reason: who owns a team is a fact in the file being edited.
pub fn invite_member_with(
    request: &InviteRequest<'_>,
    clone_dir: &Path,
    git: &dyn LibraryGit,
    authorize: impl Fn(&TeamManifest) -> Result<(), String>,
    access: impl Fn(&[String]) -> Vec<(String, CollaboratorAccess)>,
    invitations: impl Fn(&[String]) -> Vec<PendingInvitation>,
    mut grant: impl FnMut(&str, &str, &str) -> Result<bool, String>,
) -> Result<InviteOutcome, String> {
    let login = request.login.trim();
    if !is_valid_login(login) {
        return Err(format!(
            "{login:?} is not a GitHub login. Logins are letters, digits and single \
             hyphens."
        ));
    }
    if !is_valid_repo_slug(request.team_repo) {
        return Err(format!(
            "{} is not an owner/name repository, so Plyloft cannot grant access to it.",
            request.team_repo
        ));
    }

    // ── The record, pushed ──
    let message = format!("team: add {login} as a member");
    let published = crate::team::publish_library_paths(
        clone_dir,
        &[MANIFEST_FILE.to_string()],
        &message,
        |clone| {
            // Read *and* decide inside the mutation: anything read before
            // `publish` pulls is stale by the time this runs, and for the
            // manifest that means overwriting whatever another of the owner's
            // Macs added a minute ago — or editing a team somebody else now
            // owns.
            let current = crate::team::read_manifest(clone)?.ok_or_else(|| {
                format!("The team repo has no {MANIFEST_FILE} to add a member to.")
            })?;
            authorize(&current)?;
            match manifest_with_member(&current, login) {
                // Already listed here. Writing nothing is the right answer;
                // the wrapper reports `committed: false` and pushes anyway,
                // which is what completes a previously stranded commit.
                None => Ok(()),
                Some(next) => write_manifest(clone, &next),
            }
        },
        git,
    )
    .map_err(|error| error.message())?;

    if !published.pushed {
        return Err(format!(
            "The team clone on {THIS_MACHINE} has no remote to push {MANIFEST_FILE} to, so \
             nothing would record that {login} is in the team. Plyloft will not grant \
             access on GitHub from that state."
        ));
    }

    // ── The grants, from the manifest the pull produced ──
    let current = crate::team::read_manifest(clone_dir)?.ok_or_else(|| {
        format!("The team repo has no {MANIFEST_FILE} to read the team workspaces from.")
    })?;
    let mut repos: Vec<String> = vec![request.team_repo.to_string()];
    for entry in &current.workspaces {
        if is_valid_repo_slug(&entry.repo)
            && !repos.iter().any(|r| r.eq_ignore_ascii_case(&entry.repo))
        {
            repos.push(entry.repo.clone());
        }
    }
    let answers = access(&repos);
    let pending = invitations(&repos);
    let plan = build_invite_plan_with(login, request.team_repo, &current, &answers, &pending)?;
    if let Err(reason) = grants_were_confirmed(&plan, request.confirmed) {
        return Err(format!(
            "{reason} {login} is now listed in the team manifest; nothing was granted \
             on GitHub."
        ));
    }

    // LAUNCH_PLAN T2: the server seat was taken by the caller before this
    // ran (`team_billing::add_member_with_seat`): a refused seat changes
    // nothing on GitHub, not even the manifest.
    let mut outcome = InviteOutcome {
        login: login.to_string(),
        listed: true,
        manifest_written: published.committed,
        invited: Vec::new(),
        already_had: Vec::new(),
        already_invited: Vec::new(),
        failed: Vec::new(),
    };
    for step in &plan.steps {
        match step.action {
            InviteAction::AlreadyHas => {
                outcome.already_had.push(step.repo.clone());
                continue;
            }
            InviteAction::Invited => {
                outcome.already_invited.push(step.repo.clone());
                continue;
            }
            // NoSuchAccount only in a race: the seat step's lookup refuses a login
            // nobody has before any of this runs (`add_member_with_seat`).
            InviteAction::Unresolved | InviteAction::NoSuchAccount => {
                outcome.failed.push(format!(
                    "{}: GitHub did not say what access {login} has there, so nothing was \
                     granted — refresh and try again.",
                    step.repo
                ));
                continue;
            }
            InviteAction::Grant => {}
        }
        match grant(&step.repo, login, &step.permission) {
            Ok(true) => outcome.invited.push(step.repo.clone()),
            Ok(false) => outcome.already_had.push(step.repo.clone()),
            Err(error) => outcome.failed.push(format!("{}: {error}", step.repo)),
        }
    }
    Ok(outcome)
}

// ── Members: invitations as a state (N14 items 1 and 9) ─────────────

/// What a manifest member has on one repository, as GitHub says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberAccessState {
    /// GitHub lists them as able to reach it.
    Joined,
    /// An open invitation is waiting on them.
    Invited,
    /// Listed in `team.json`, but neither a collaborator nor invited (an
    /// expired invitation included).
    NoAccess,
    /// GitHub couldn't be asked, or its one-page answer was full and didn't
    /// name them — never read as "no access".
    Unknown,
}

/// What GitHub answered about one repository's people.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoPeople {
    pub repo: String,
    pub collaborators: Result<Vec<String>, String>,
    pub invitations: Result<Vec<crate::github::RepoInvitation>, String>,
}

/// One row of Settings › Team › Members.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberStateView {
    pub login: String,
    pub owner: bool,
    /// On the team repository — what being in the team needs.
    pub state: MemberAccessState,
    /// With `Invited`: the day (`YYYY-MM-DD`) the invitation expires.
    pub invitation_expires: Option<String>,
    /// With `NoAccess`: the day an invitation they never accepted expired.
    pub invitation_expired: Option<String>,
    /// Team workspaces where an invitation waits on them.
    pub workspaces_invited: Vec<String>,
    /// Team workspaces they can't reach and aren't invited to.
    pub workspaces_missing: Vec<String>,
}

/// Members, and what couldn't be read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberStates {
    pub members: Vec<MemberStateView>,
    /// "repo: why", for each repository GitHub didn't answer for.
    pub problems: Vec<String>,
    /// N14 review (P3-6): every repository Remove from team acts on, in
    /// order — what its confirmation sheet lists.
    pub repos: Vec<String>,
}

/// At most this many repositories are read for Members (the team repo
/// first, then the team workspaces in manifest order): two `gh api` reads
/// each, every time the page opens.
pub const MEMBER_STATE_REPO_LIMIT: usize = 20;

/// The repositories a team owns, in the order Ply reads and acts on them:
/// the team repo, then every valid, distinct team workspace.
pub fn team_repos(team_repo: &str, manifest: &TeamManifest) -> Vec<String> {
    let mut repos = vec![team_repo.to_string()];
    for entry in &manifest.workspaces {
        if is_valid_repo_slug(&entry.repo) && !repos.iter().any(|r| r.eq_ignore_ascii_case(&entry.repo)) {
            repos.push(entry.repo.clone());
        }
    }
    repos
}

/// One member on one repository, with the expiry day of the invitation
/// behind an `Invited` / `NoAccess`.
fn access_on(people: &RepoPeople, login: &str) -> (MemberAccessState, Option<String>) {
    let collaborators = match &people.collaborators {
        Ok(list) => list,
        Err(_) => return (MemberAccessState::Unknown, None),
    };
    if collaborators.iter().any(|c| c.eq_ignore_ascii_case(login)) {
        return (MemberAccessState::Joined, None);
    }
    let invitations = match &people.invitations {
        Ok(list) => list,
        Err(_) => return (MemberAccessState::Unknown, None),
    };
    let pending: Vec<PendingInvitation> = invitations
        .iter()
        .map(|i| PendingInvitation { repo: people.repo.clone(), invitation: i.clone() })
        .collect();
    if let Some(invitation) = invitation_for(&pending, &people.repo, login) {
        let day = invitation_expiry(&invitation.created_at);
        if !invitation.expired {
            return (MemberAccessState::Invited, day);
        }
        if collaborators.len() < crate::github::TEAM_LIST_PAGE {
            return (MemberAccessState::NoAccess, day);
        }
    }
    // A full page that doesn't name them may simply have stopped before them.
    if collaborators.len() >= crate::github::TEAM_LIST_PAGE
        || invitations.len() >= crate::github::TEAM_LIST_PAGE
    {
        return (MemberAccessState::Unknown, None);
    }
    (MemberAccessState::NoAccess, None)
}

/// Pure: every manifest member's state, from GitHub's answers for the team's
/// repositories (`answers[0]` is the team repo when it was read). The owner
/// is `Joined` without asking: the team repository is theirs.
pub fn member_states(team_repo: &str, manifest: &TeamManifest, answers: &[RepoPeople]) -> MemberStates {
    let mut problems = Vec::new();
    for people in answers {
        for why in [people.collaborators.as_ref().err(), people.invitations.as_ref().err()]
            .into_iter()
            .flatten()
        {
            let line = format!("{}: {why}", people.repo);
            if !problems.contains(&line) {
                problems.push(line);
            }
        }
    }
    let team = answers.iter().find(|p| p.repo.eq_ignore_ascii_case(team_repo));
    let members = manifest
        .members
        .iter()
        .map(|member| {
            let mut view = MemberStateView {
                login: member.login.clone(),
                owner: member.owner,
                state: MemberAccessState::Unknown,
                invitation_expires: None,
                invitation_expired: None,
                workspaces_invited: Vec::new(),
                workspaces_missing: Vec::new(),
            };
            if member.owner {
                view.state = MemberAccessState::Joined;
                return view;
            }
            if let Some(team) = team {
                let (state, day) = access_on(team, &member.login);
                view.state = state;
                match state {
                    MemberAccessState::Invited => view.invitation_expires = day,
                    MemberAccessState::NoAccess => view.invitation_expired = day,
                    _ => {}
                }
            }
            for people in answers.iter().filter(|p| !p.repo.eq_ignore_ascii_case(team_repo)) {
                match access_on(people, &member.login).0 {
                    MemberAccessState::Invited => view.workspaces_invited.push(people.repo.clone()),
                    MemberAccessState::NoAccess => view.workspaces_missing.push(people.repo.clone()),
                    _ => {}
                }
            }
            view
        })
        .collect();
    MemberStates {
        members,
        problems,
        repos: team_repos(team_repo, manifest),
    }
}

// ── Remove from team (N14 item 3) ───────────────────────────────────

/// Who is being removed, and from which team.
pub struct RemoveRequest<'a> {
    pub login: &'a str,
    pub team_repo: &'a str,
    /// Who is acting — the owner gate's login. Nobody removes themselves.
    pub acting_login: &'a str,
}

/// What one repository's revocation did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Revoked {
    /// Pending invitations to them that were withdrawn.
    pub cancelled_invitations: usize,
    /// They can still read it, and it is private (an organisation's base
    /// permission): access is no longer theirs to push, but it is said.
    pub still_reads: bool,
}

/// What Remove from team did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveOutcome {
    pub login: String,
    /// Repositories where their access (and any invitation) is gone.
    pub removed: Vec<String>,
    /// Repositories where an invitation to them was withdrawn.
    pub cancelled_invitations: Vec<String>,
    /// Private repositories they can still read (an organisation's base
    /// permission): no write access, but not nothing.
    pub still_read: Vec<String>,
    /// "repo: why" for each repository GitHub refused or still opens to them.
    pub failed: Vec<String>,
    /// `team.json` on GitHub no longer lists them (also when it already
    /// didn't). Only ever true after every repository succeeded.
    pub manifest_updated: bool,
    /// Why the manifest couldn't be updated after every repository was done.
    pub manifest_error: Option<String>,
    /// Launch T2: their seat on the team's plan was freed (after every
    /// repository succeeded). Set by `commands::team_member_remove`.
    pub seat_freed: bool,
    /// Why the seat is still taken (retried from Members).
    pub seat_error: Option<String>,
}

/// `manifest` without `login`. `None` when it doesn't list them.
pub fn manifest_without_member(manifest: &TeamManifest, login: &str) -> Option<TeamManifest> {
    if !manifest.lists(login) {
        return None;
    }
    let mut next = manifest.clone();
    next.members.retain(|m| !m.login.trim().eq_ignore_ascii_case(login.trim()));
    Some(next)
}

/// The refusal for removing the owner, or oneself.
fn refuse_removing(manifest: &TeamManifest, login: &str, acting: &str) -> Result<(), String> {
    if login.eq_ignore_ascii_case(acting.trim()) {
        return Err(format!(
            "You can't remove yourself from a team you own. To stop following it on \
             {THIS_MACHINE}, use Leave this team."
        ));
    }
    if manifest
        .members
        .iter()
        .any(|m| m.owner && m.login.trim().eq_ignore_ascii_case(login))
    {
        return Err(format!("{login} owns the team, so Plyloft won't remove them."));
    }
    Ok(())
}

/// **Remove from team**: GitHub access first, on the team repository and on
/// every team workspace (pending invitations withdrawn, collaborator taken
/// off); **`team.json` only once every repository succeeded**.
///
/// The order is [`invite_member_with`]'s, mirrored, and for the same reason:
/// of the two half-states, one is visible and one isn't. A person listed in
/// the manifest whose access is gone shows in Members as "No access" and the
/// owner presses Remove again — every step is idempotent. A person taken out
/// of the manifest who can still push to a workspace is access nothing in the
/// team records, which nobody goes looking for. So a partial failure leaves
/// the manifest as it was and names the repositories that failed.
///
/// The manifest write re-reads the pulled `team.json` and re-runs the owner
/// check inside the mutation; a team workspace another Mac added while this
/// ran (so not revoked here) refuses the write instead of being skipped.
///
/// LAUNCH_PLAN T2: the server seat is freed by the caller once every
/// repository succeeded (`team_billing::free_seat_after_removal`) — their
/// GitHub access is gone by then.
pub fn remove_member_with(
    request: &RemoveRequest<'_>,
    clone_dir: &Path,
    git: &dyn LibraryGit,
    authorize: impl Fn(&TeamManifest) -> Result<(), String>,
    mut revoke: impl FnMut(&str, &str) -> Result<Revoked, String>,
) -> Result<RemoveOutcome, String> {
    let login = request.login.trim();
    if !is_valid_login(login) {
        return Err(format!(
            "{login:?} is not a GitHub login. Logins are letters, digits and single hyphens."
        ));
    }
    if !is_valid_repo_slug(request.team_repo) {
        return Err(format!("{} is not an owner/name repository.", request.team_repo));
    }
    let local = crate::team::read_manifest(clone_dir)?.ok_or_else(|| {
        format!("The team repo is not on {THIS_MACHINE} yet — read the team again first.")
    })?;
    authorize(&local)?;
    refuse_removing(&local, login, request.acting_login)?;

    let repos = team_repos(request.team_repo, &local);
    let mut outcome = RemoveOutcome {
        login: login.to_string(),
        removed: Vec::new(),
        cancelled_invitations: Vec::new(),
        still_read: Vec::new(),
        failed: Vec::new(),
        manifest_updated: false,
        manifest_error: None,
        seat_freed: false,
        seat_error: None,
    };
    for repo in &repos {
        match revoke(repo, login) {
            Ok(done) => {
                outcome.removed.push(repo.clone());
                if done.cancelled_invitations > 0 {
                    outcome.cancelled_invitations.push(repo.clone());
                }
                if done.still_reads {
                    outcome.still_read.push(repo.clone());
                }
            }
            Err(why) => outcome.failed.push(format!("{repo}: {why}")),
        }
    }
    if !outcome.failed.is_empty() {
        return Ok(outcome);
    }

    let message = format!("team: remove {login}");
    let published = crate::team::publish_library_paths(
        clone_dir,
        &[MANIFEST_FILE.to_string()],
        &message,
        |clone| {
            let current = crate::team::read_manifest(clone)?
                .ok_or_else(|| format!("The team repo has no {MANIFEST_FILE} to remove {login} from."))?;
            authorize(&current)?;
            refuse_removing(&current, login, request.acting_login)?;
            let unrevoked: Vec<String> = team_repos(request.team_repo, &current)
                .into_iter()
                .filter(|r| !repos.iter().any(|done| done.eq_ignore_ascii_case(r)))
                .collect();
            if !unrevoked.is_empty() {
                return Err(format!(
                    "The team gained {} while Plyloft was removing {login}. Press Remove again to \
                     take that away too.",
                    unrevoked.join(", ")
                ));
            }
            match manifest_without_member(&current, login) {
                None => Ok(()),
                Some(next) => write_manifest(clone, &next),
            }
        },
        git,
    );
    match published {
        Ok(published) if published.pushed => outcome.manifest_updated = true,
        Ok(_) => {
            outcome.manifest_error = Some(format!(
                "The team clone on {THIS_MACHINE} has no remote to push {MANIFEST_FILE} to."
            ))
        }
        Err(error) => outcome.manifest_error = Some(removal_manifest_words(&error.message())),
    }
    Ok(outcome)
}

/// A refused `team.json` write, said on the Remove path: their access is
/// already gone on GitHub, so only the member list stayed as it was.
fn removal_manifest_words(message: &str) -> String {
    message.replace(
        crate::team::NOTHING_REACHED_GITHUB,
        "The team's member list is as it was.",
    )
}

// ── Assisted discovery ──────────────────────────────────────────────

/// One repository a scan looked at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredRepo {
    pub repo: String,
    pub description: Option<String>,
    pub archived: bool,
    pub private: bool,
    /// Does it carry one of [`WORKSPACE_MARKERS`]? `None` is "the probe could not be
    /// answered" and is counted, never folded into "no" — a scan that lost
    /// its connection halfway must not report a team's repositories as
    /// having nothing to offer.
    pub carries_marker: Option<bool>,
}

/// One repository worth proposing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryProposal {
    pub repo: String,
    pub description: Option<String>,
    pub private: bool,
}

/// What one scan found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub proposals: Vec<DiscoveryProposal>,
    /// How many repositories the scan looked at, so "nothing found" can be
    /// told apart from "nothing was looked at".
    pub scanned: usize,
    /// How many could not be checked. Shown when non-zero: the list is
    /// incomplete and the owner is the only one who can tell whether that
    /// matters.
    pub unchecked: usize,
    /// Repositories already listed as team workspaces, so the panel can say
    /// how many of the marked repos are already in.
    pub already_listed: usize,
}

/// The discovery filter: which of the repositories a scan looked at are
/// worth proposing as team workspaces.
///
/// It proposes and nothing more (`DESIGN.md`: "Assisted discovery … only
/// proposes; the owner decides"). Every exclusion is one the owner would
/// otherwise have to make by hand, one at a time:
///
/// - none of [`WORKSPACE_MARKERS`] — the repo has never been set up for Ply, so
///   there is nothing to suggest about it;
/// - the probe could not be answered — counted as `unchecked`, never as a no;
/// - archived — a team workspace is somewhere cards get pushed;
/// - not `owner/name` — nothing Ply could clone;
/// - already a team workspace, or already ignored by the owner;
/// - the team repo itself. It holds the manifest and the library and is
///   never a workspace, so adding it is refused — and a row whose only
///   outcome is a refusal should not be on the list at all.
pub fn discovery_proposals(
    found: &[DiscoveredRepo],
    team_repo: &str,
    manifest: Option<&TeamManifest>,
    ignored: &[String],
) -> Discovery {
    let listed = |slug: &str| {
        manifest.is_some_and(|m| {
            m.workspaces
                .iter()
                .any(|w| w.repo.eq_ignore_ascii_case(slug))
        })
    };
    let is_ignored =
        |slug: &str| ignored.iter().any(|i| i.trim().eq_ignore_ascii_case(slug));

    let mut proposals: Vec<DiscoveryProposal> = Vec::new();
    let mut unchecked = 0usize;
    let mut already_listed = 0usize;
    for repo in found {
        match repo.carries_marker {
            None => {
                unchecked += 1;
                continue;
            }
            Some(false) => continue,
            Some(true) => {}
        }
        if !is_valid_repo_slug(&repo.repo) {
            continue;
        }
        if listed(&repo.repo) {
            already_listed += 1;
            continue;
        }
        if repo.archived
            || is_ignored(&repo.repo)
            || repo.repo.eq_ignore_ascii_case(team_repo.trim())
        {
            continue;
        }
        if proposals
            .iter()
            .any(|p| p.repo.eq_ignore_ascii_case(&repo.repo))
        {
            continue;
        }
        proposals.push(DiscoveryProposal {
            repo: repo.repo.clone(),
            description: repo
                .description
                .as_deref()
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .map(str::to_string),
            private: repo.private,
        });
    }
    // Stable order: the scan comes back from eight concurrent probes, so
    // without this the same repositories would reshuffle on every press.
    proposals.sort_by(|a, b| {
        a.repo
            .to_ascii_lowercase()
            .cmp(&b.repo.to_ascii_lowercase())
    });
    Discovery {
        proposals,
        scanned: found.len(),
        unchecked,
        already_listed,
    }
}

#[cfg(test)]
#[path = "team_admin_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "team_admin_live_tests.rs"]
mod live_tests;
