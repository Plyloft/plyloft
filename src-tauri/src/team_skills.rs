//! v1.116.0 (team sharing rung 3) — team skills for both CLIs.
//!
//! The team library carries an instruction package per vendor:
//!
//! - `library/claude/<plugin>/` — Claude Code plugins (`.claude-plugin/plugin.json`
//!   plus `skills/` and `agents/`).
//! - `library/codex/` — a Codex local marketplace: `.agents/plugins/marketplace.json`
//!   plus `plugins/<plugin>/` (`.codex-plugin/plugin.json`, `skills/`, `agents/`).
//!
//! Both vendors read the *same* `SKILL.md` files; only the manifest around
//! them differs. `docs/team-sharing/PLAN.md` (Rung 3) records how each format
//! was established against the real CLIs.
//!
//! Two facts from that research shape everything here.
//!
//! **Hooks execute.** A plugin handed to `claude --plugin-dir` runs its hooks
//! with no prompt — a `SessionStart` hook injected context into a live session
//! during the research. Anyone with write access to the team repo could
//! therefore run commands on every other member's Mac. So a plugin carrying
//! hooks is **refused**, not silently stripped: refusing is visible in
//! Settings and in the doctor, whereas rewriting a shared library on read
//! would leave two members disagreeing about what the library contains. This
//! is also why Claude gets one `--plugin-dir` per accepted plugin rather than
//! the containing folder — the folder form would load every child, refused
//! ones included.
//!
//! **Codex has no session-scoped override.** A marketplace registered with
//! `-c` leaves its plugins uninstalled, and the `[plugins."p@m"]` entry that
//! marks one installed is read only from the persisted config file. The
//! delivery mechanism is therefore a Ply-owned `CODEX_HOME` overlay: every
//! entry of the member's real `~/.codex` is symlinked into a throwaway
//! directory, `config.toml` is copied with the team entries appended, and
//! `plugins/` is Ply's. Auth, thread history, memories and state stay in the
//! member's own `~/.codex` because those are the symlinks; nothing is ever
//! written there.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use crate::platform::YOUR_MACHINE;

/// Which CLI can load a given skill. A skill authored once and published to
/// both halves of the library carries both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Vendor {
    Claude,
    Codex,
}

impl Vendor {
    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
        }
    }
}

/// One skill the team library offers, with the vendors that can load it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSkill {
    /// Its **directory** name, which is its identity: measured against both
    /// CLIs, Claude invokes a skill by the directory and ignores the
    /// frontmatter `name` entirely (`plugprobe:plug-dirname` for a skill whose
    /// frontmatter said `plug-frontname`), and Codex falls back to the
    /// directory when the frontmatter has no name. It is also the path a
    /// Promote and an Install write.
    pub name: String,
    /// Never absent: a `SKILL.md` without one is not a skill either CLI
    /// loads, so it is never listed.
    pub description: String,
    /// What Codex calls it, when its frontmatter `name` differs from the
    /// directory. Measured: Codex lists the frontmatter name (`probe-frontname2`
    /// for `.../probe-dirname2/SKILL.md`) while Claude lists the directory, so
    /// such a skill genuinely has two names and the panel says so rather than
    /// picking one.
    pub codex_name: Option<String>,
    /// The plugin it lives in — the CLIs namespace a skill as `<plugin>:<name>`.
    pub plugin: String,
    /// Loadable by Claude Code (present and accepted in `library/claude/`).
    pub claude: bool,
    /// Loadable by Codex (present and accepted in `library/codex/`).
    pub codex: bool,
}

impl TeamSkill {
    /// Both CLIs can load it. The rung ships on this being true for the
    /// library's skills; the Settings badges make an asymmetry visible.
    pub fn both_vendors(&self) -> bool {
        self.claude && self.codex
    }

    /// `<plugin>:<name>` — how both CLIs name a skill, and what makes two
    /// rows the same skill rather than two that merely share a word.
    pub fn qualified_name(&self) -> String {
        format!("{}:{}", self.plugin, self.name)
    }
}

/// A plugin Ply will not hand to a CLI, and why. Surfaced rather than
/// swallowed: a member must be able to see that part of the library is
/// deliberately not loaded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusedPlugin {
    pub plugin: String,
    pub vendor: Vendor,
    pub reason: String,
    /// Skills hub H6b walk (R15): the skills it would have offered (their
    /// directories), so the Library can say on their rows why a CLI doesn't
    /// get them. Empty when the plugin couldn't be read that far.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
}

/// One Codex plugin resolved out of the marketplace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexPlugin {
    pub name: String,
    pub version: String,
    pub dir: PathBuf,
}

/// How a refusal names a marketplace, so a member reads which layer it is about.
///
/// GH #106 review 2: one overlay now carries the team library **and** the skills
/// that come with Ply, and both are read by this module's one reader — so the
/// sentences cannot be worded from the code that writes them. Whoever knows which
/// layer a marketplace is says so here.
pub const TEAM_MARKETPLACE_LABEL: &str = "the team marketplace";

/// The Codex half of the library: a local marketplace root and its plugins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexMarketplace {
    pub root: PathBuf,
    pub name: String,
    pub plugins: Vec<CodexPlugin>,
    /// What a refusal calls it — `the team marketplace`, or `Ply's own
    /// marketplace`. Only ever read into a sentence.
    pub label: String,
}

impl CodexMarketplace {
    /// `<plugin>@<marketplace>` — the id `codex plugin add` uses and the key
    /// of the `[plugins."…"]` table the overlay's `config.toml` carries.
    pub fn plugin_id(&self, plugin: &CodexPlugin) -> String {
        format!("{}@{}", plugin.name, self.name)
    }
}

/// Everything Ply knows about the team library's skills on this Mac.
///
/// Reading it never fails: the team layer is additive (rung 2's rule), so a
/// malformed or unreadable half is recorded in `errors` and skipped while the
/// other half still loads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TeamSkillsLibrary {
    /// Directories to hand to `claude --plugin-dir`, one per accepted plugin.
    pub claude_plugin_dirs: Vec<PathBuf>,
    /// The same accepted plugins with the identity the CLI gives them — the
    /// manifest's `name`, which need not be the directory's. Removal resolves
    /// its paths through this, never by joining a plugin name onto a path.
    pub claude_plugins: Vec<(String, PathBuf)>,
    /// The Codex marketplace, when it holds at least one accepted plugin.
    pub codex: Option<CodexMarketplace>,
    /// Every skill either half offers, sorted by name.
    pub skills: Vec<TeamSkill>,
    pub refused: Vec<RefusedPlugin>,
    pub errors: Vec<String>,
}

impl TeamSkillsLibrary {
    pub fn is_empty(&self) -> bool {
        self.claude_plugin_dirs.is_empty() && self.codex.is_none()
    }

    /// How many distinct skills are loaded into a session of `vendor`.
    pub fn loaded_for(&self, vendor: Vendor) -> usize {
        self.skills
            .iter()
            .filter(|s| match vendor {
                Vendor::Claude => s.claude,
                Vendor::Codex => s.codex,
            })
            .count()
    }
}

/// Whether `raw` is safe to use as one path component.
///
/// Every name in the Codex half of the library — the marketplace's, each
/// plugin's, each plugin's version — is joined into a filesystem path, and
/// all three come out of JSON that any teammate with write access to the team
/// repo can edit. `Path::join` with an absolute component *replaces* the path
/// it was joining onto, so a `"version": "/etc"` would redirect the copy
/// anywhere the member can write, and `".."` would climb out of the overlay.
/// That is the same threat model that makes a hook-carrying plugin a refusal,
/// so the answer is the same: refuse, and say so.
fn is_safe_path_component(raw: &str) -> bool {
    !raw.is_empty()
        && raw != "."
        && raw != ".."
        && !raw.contains('/')
        && !raw.contains('\\')
        && !raw.contains('\0')
        // A leading dot would also hide the directory from `read_child_dirs`.
        && !raw.starts_with('.')
}

/// `library/claude` and `library/codex` inside a team-repo clone.
pub fn claude_library_dir(team_clone_dir: &Path) -> PathBuf {
    team_clone_dir.join("library").join("claude")
}

pub fn codex_library_dir(team_clone_dir: &Path) -> PathBuf {
    team_clone_dir.join("library").join("codex")
}

/// Marketplace names Ply registers for its own layers in the same `CODEX_HOME`
/// overlay the team's goes into (GH #156 review 1): Ply's own skills
/// (`ply_skills::MARKETPLACE_NAME`) and the branch's project skills
/// (`branch_codex_skills::MARKETPLACE_NAME`). A **team** marketplace of either
/// name would collide with Ply's layer inside the overlay — one of the two would
/// be refused at launch with a false "you already have one", while the Library
/// had lit its chip. So the team's is refused here, where it is read, with its
/// reason.
///
/// Not `ply-team`: that is the name Ply itself gives a team's marketplace
/// ([`PLY_PLUGIN`], `ensure_ply_plugin`), so every team that shares a skill has it.
pub const RESERVED_MARKETPLACES: [&str; 2] = [
    crate::ply_skills::MARKETPLACE_NAME,
    crate::branch_codex_skills::MARKETPLACE_NAME,
];

/// Read both halves of a team clone's skill library.
///
/// A team marketplace named one of [`RESERVED_MARKETPLACES`] is refused.
pub fn read_library(team_clone_dir: &Path) -> TeamSkillsLibrary {
    read_library_as(team_clone_dir, None)
}

/// The same reader, for a library **Ply** built for one of its own layers —
/// `own` is the reserved marketplace name that layer is allowed to carry.
pub fn read_own_library(dir: &Path, own: &str) -> TeamSkillsLibrary {
    read_library_as(dir, Some(own))
}

fn read_library_as(team_clone_dir: &Path, own: Option<&str>) -> TeamSkillsLibrary {
    let mut library = TeamSkillsLibrary::default();
    // Keyed by `(name, plugin)` — the identity both CLIs use, which they
    // spell `<plugin>:<name>`. One authored skill published to both halves
    // shares a plugin name and so is one row with two badges; two *different*
    // skills that happen to share a word are two rows, because merging them
    // would claim a skill loads in a vendor that has never seen it. Name
    // first so the panel's order is alphabetical by skill.
    let mut skills: BTreeMap<(String, String), TeamSkill> = BTreeMap::new();

    read_claude_half(&claude_library_dir(team_clone_dir), &mut library, &mut skills);
    read_codex_half(&codex_library_dir(team_clone_dir), own, &mut library, &mut skills);

    library.skills = skills.into_values().collect();
    library
}

// ── Claude half ─────────────────────────────────────────────────────

fn read_claude_half(
    dir: &Path,
    library: &mut TeamSkillsLibrary,
    skills: &mut BTreeMap<(String, String), TeamSkill>,
) {
    let Some(children) = read_child_dirs(dir, "library/claude", &mut library.errors) else {
        return;
    };
    let children = children
        .into_iter()
        .map(|plugin_dir| (directory_name(&plugin_dir), plugin_dir))
        .collect();
    read_claude_plugins(children, library, skills);
}

/// Skills hub H1: the library a session is **given** — each Claude plugin
/// from its own snapshot directory (named by its git tree id, so the
/// directory's name is not the plugin's) and the Codex half from the
/// snapshot of `library/codex`. The same reader as [`read_library`], so
/// what a session loads is decided by the one rule (refusals, frontmatter,
/// the reserved marketplace names) over exactly the bytes it gets.
///
/// `claude` pairs each plugin's directory name **in the library** — the label
/// a refusal names, as for a clone — with its snapshot.
pub fn read_snapshot_library(
    claude: Vec<(String, PathBuf)>,
    codex_root: Option<&Path>,
) -> TeamSkillsLibrary {
    let mut library = TeamSkillsLibrary::default();
    let mut skills: BTreeMap<(String, String), TeamSkill> = BTreeMap::new();
    read_claude_plugins(claude, &mut library, &mut skills);
    if let Some(root) = codex_root {
        read_codex_half(root, None, &mut library, &mut skills);
    }
    library.skills = skills.into_values().collect();
    library
}

fn read_claude_plugins(
    children: Vec<(String, PathBuf)>,
    library: &mut TeamSkillsLibrary,
    skills: &mut BTreeMap<(String, String), TeamSkill>,
) {
    for (label, plugin_dir) in children {
        let manifest_path = plugin_dir.join(".claude-plugin").join("plugin.json");
        if !manifest_path.is_file() {
            // Not a plugin — a stray directory, or a half-written share.
            continue;
        }
        let manifest = match read_plugin_manifest(&manifest_path) {
            Ok(manifest) => manifest,
            Err(reason) => {
                library.refused.push(RefusedPlugin {
                    // The directory name is only a label for the refusal —
                    // the manifest is what the CLI reads, and it is unusable.
                    plugin: label.clone(),
                    vendor: Vendor::Claude,
                    reason,
                    skills: skill_dirs_of(&plugin_dir),
                });
                continue;
            }
        };
        let name = manifest.name.clone();
        // The manifest's name is a path component from v1.117.0 on: Install
        // reads a skill out of `library/claude/<plugin>/skills/<skill>`, so a
        // name like `../..` would aim that read outside the team clone. The
        // Codex half has refused unusable names since rung 3 for the same
        // reason; this closes the other door.
        if !is_safe_path_component(&name) {
            library.refused.push(RefusedPlugin {
                plugin: label.clone(),
                vendor: Vendor::Claude,
                reason: format!("its manifest name `{name}` is not a usable directory name"),
                skills: skill_dirs_of(&plugin_dir),
            });
            continue;
        }
        if let Some(reason) = executable_refusal(&plugin_dir, &manifest) {
            library.refused.push(RefusedPlugin {
                plugin: name,
                vendor: Vendor::Claude,
                reason,
                skills: skill_dirs_of(&plugin_dir),
            });
            continue;
        }
        for skill in read_skills(&plugin_dir, &mut library.errors) {
            let row = skills
                .entry((skill.dir.clone(), name.clone()))
                .or_insert_with(|| TeamSkill {
                    name: skill.dir,
                    codex_name: skill.codex_name,
                    description: skill.description,
                    plugin: name.clone(),
                    claude: false,
                    codex: false,
                });
            row.claude = true;
        }
        library.claude_plugins.push((name, plugin_dir.clone()));
        library.claude_plugin_dirs.push(plugin_dir);
    }
    library.claude_plugin_dirs.sort();
}

// ── Codex half ──────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct MarketplaceFile {
    name: String,
    #[serde(default)]
    plugins: Vec<MarketplaceEntry>,
}

#[derive(serde::Deserialize)]
struct MarketplaceEntry {
    name: String,
}

/// `<root>/.agents/plugins/marketplace.json` — the layout the shipped
/// `openai-curated` marketplace uses and the one `codex plugin marketplace
/// add` accepts.
pub fn codex_marketplace_manifest(root: &Path) -> PathBuf {
    root.join(".agents").join("plugins").join("marketplace.json")
}

fn read_codex_half(
    root: &Path,
    own: Option<&str>,
    library: &mut TeamSkillsLibrary,
    skills: &mut BTreeMap<(String, String), TeamSkill>,
) {
    if !root.is_dir() {
        return;
    }
    let manifest_path = codex_marketplace_manifest(root);
    let bytes = match std::fs::read(&manifest_path) {
        Ok(bytes) => bytes,
        // `team-init.sh` seeds `library/codex/` with a `.gitkeep`, so a
        // marketplace that is simply not there yet is the normal state of
        // every team before its first skill is shared — silent, exactly like
        // an absent directory. Only a directory that exists and cannot be
        // read is worth a member's attention.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            library
                .errors
                .push(format!("library/codex marketplace unreadable: {error}"));
            return;
        }
    };
    let manifest: MarketplaceFile = match serde_json::from_slice(&bytes) {
        Ok(manifest) => manifest,
        Err(error) => {
            library.errors.push(format!(
                "library/codex marketplace is not valid JSON: {error}"
            ));
            return;
        }
    };
    if !is_safe_path_component(&manifest.name) {
        // The marketplace name is a directory in the overlay's plugin cache,
        // so an unusable one costs the whole Codex half rather than one
        // plugin. Named, never silently skipped.
        library.errors.push(format!(
            "library/codex marketplace name `{}` is not a usable directory name",
            manifest.name
        ));
        return;
    }
    if RESERVED_MARKETPLACES.contains(&manifest.name.as_str()) && own != Some(manifest.name.as_str())
    {
        // Every plugin it lists is refused with the reason, so the doctor and the
        // Library say it rather than badging skills no Codex session will get.
        for entry in &manifest.plugins {
            library.refused.push(RefusedPlugin {
                plugin: entry.name.clone(),
                vendor: Vendor::Codex,
                reason: format!(
                    "its marketplace is named `{}`, which Plyloft uses for its own skills in \
                     Codex; rename the team's marketplace in \
                     library/codex/.agents/plugins/marketplace.json",
                    manifest.name
                ),
                skills: if is_safe_path_component(&entry.name) {
                    skill_dirs_of(&root.join("plugins").join(&entry.name))
                } else {
                    Vec::new()
                },
            });
        }
        return;
    }

    let mut plugins = Vec::new();
    for entry in &manifest.plugins {
        if !is_safe_path_component(&entry.name) {
            library.refused.push(RefusedPlugin {
                plugin: entry.name.clone(),
                vendor: Vendor::Codex,
                reason: "its name is not a usable directory name".to_string(),
                skills: Vec::new(),
            });
            continue;
        }
        let plugin_dir = root.join("plugins").join(&entry.name);
        let manifest_path = plugin_dir.join(".codex-plugin").join("plugin.json");
        if !manifest_path.is_file() {
            library.errors.push(format!(
                "library/codex lists `{}` but it has no .codex-plugin/plugin.json",
                entry.name
            ));
            continue;
        }
        let mut refuse = |reason: String| {
            library.refused.push(RefusedPlugin {
                plugin: entry.name.clone(),
                vendor: Vendor::Codex,
                reason,
                skills: skill_dirs_of(&plugin_dir),
            });
        };
        let plugin_manifest = match read_plugin_manifest(&manifest_path) {
            Ok(manifest) => manifest,
            Err(reason) => {
                refuse(reason);
                continue;
            }
        };
        if let Some(reason) = executable_refusal(&plugin_dir, &plugin_manifest) {
            refuse(reason);
            continue;
        }
        // The version is part of the cache path Codex resolves an installed
        // plugin through, so an absent one needs a stable stand-in rather
        // than a skipped plugin — and an unusable one is a refusal, because
        // it is a path component like any other.
        let version = plugin_manifest
            .version
            .clone()
            .unwrap_or_else(|| FALLBACK_VERSION.to_string());
        if !is_safe_path_component(&version) {
            refuse(format!(
                "its version `{version}` is not a usable directory name"
            ));
            continue;
        }

        // Only now. Every reason this plugin might not load has been ruled
        // out, so a skill badged Codex here is one a Codex session actually
        // gets — badging before the last check is how a refused plugin's
        // skills kept their badge while `library.codex` came back empty.
        for skill in read_skills(&plugin_dir, &mut library.errors) {
            let row = skills
                .entry((skill.dir.clone(), entry.name.clone()))
                .or_insert_with(|| TeamSkill {
                    name: skill.dir,
                    codex_name: skill.codex_name,
                    description: skill.description,
                    plugin: entry.name.clone(),
                    claude: false,
                    codex: false,
                });
            row.codex = true;
        }
        plugins.push(CodexPlugin {
            name: entry.name.clone(),
            version,
            dir: plugin_dir,
        });
    }
    if plugins.is_empty() {
        return;
    }
    library.codex = Some(CodexMarketplace {
        root: root.to_path_buf(),
        name: manifest.name,
        plugins,
        // The team's by default, because this reader was written for the team
        // library; `ply_skills` relabels the one it builds for itself.
        label: TEAM_MARKETPLACE_LABEL.to_string(),
    });
}

// ── Shared plugin reading ───────────────────────────────────────────

fn read_child_dirs(dir: &Path, label: &str, errors: &mut Vec<String>) -> Option<Vec<PathBuf>> {
    if !dir.is_dir() {
        return None;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            errors.push(format!("{label} unreadable: {error}"));
            return None;
        }
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter(|path| {
            // Dot directories are the vendors' own metadata, never plugins.
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| !n.starts_with('.'))
        })
        .collect();
    out.sort();
    Some(out)
}

/// A plugin's manifest, parsed exactly once.
///
/// Both vendors require one, so a manifest that cannot be read or is not a
/// JSON object means the CLI will not load the plugin either. Ply used to
/// swallow that: a parse failure became "declares no hooks", a fallback name
/// and a stand-in version, so a plugin the CLI would reject was still
/// advertised as loadable and its skills counted. A failure is a refusal now,
/// with the reason.
struct PluginManifest {
    /// Both CLIs require a non-empty string `name` — measured: `claude plugin
    /// validate` fails a manifest that omits it *or* gives it a number. So a
    /// manifest without one describes a plugin the CLI will reject, and Ply
    /// must not badge its skills as loadable.
    name: String,
    version: Option<String>,
    /// A `hooks` key in the manifest itself, as opposed to a `hooks/`
    /// directory or a `hooks.json` beside it.
    declares_hooks: bool,
    /// An MCP server declared in the manifest rather than in `.mcp.json`.
    declares_mcp: bool,
    /// Round 2 (G2): the first key of the manifest that isn't one Plyloft
    /// knows to describe the plugin and nothing else ([`MANIFEST_KEYS`]).
    unknown_key: Option<String>,
}

/// Round 2 (G2): the manifest keys a delivered plugin may have. What
/// Plyloft's own writers emit (`name`, `description`, `version`:
/// [`write_manifest_if_absent`], `my_library`, `ply_skills`, the `project`
/// plugin) and the keys that only describe who made it. Every other key the
/// CLIs know (`commands`, `skills`, `agents`, `lspServers`, `monitors`,
/// `outputStyles`…) points them at something to load or run, and one they
/// don't know today may tomorrow: any other key refuses the plugin.
const MANIFEST_KEYS: &[&str] = &["name", "version", "description", "author", "homepage", "repository", "license", "keywords"];

/// The stand-in when a manifest declares no version. Codex resolves an
/// installed plugin through a versioned cache path, so there has to be one.
const FALLBACK_VERSION: &str = "0.0.0";

fn read_plugin_manifest(path: &Path) -> Result<PluginManifest, String> {
    let bytes =
        std::fs::read(path).map_err(|error| format!("its manifest could not be read: {error}"))?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("its manifest is not valid JSON: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "its manifest is not a JSON object".to_string())?;
    let string = |key: &str| {
        object
            .get(key)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let present = |key: &str| object.get(key).is_some_and(|value| !value.is_null());
    Ok(PluginManifest {
        name: string("name")
            .ok_or_else(|| "its manifest has no `name`, which both CLIs require".to_string())?,
        version: string("version"),
        declares_hooks: present("hooks"),
        declares_mcp: present("mcpServers") || present("mcp"),
        unknown_key: object
            .keys()
            .find(|key| !MANIFEST_KEYS.contains(&key.as_str()) && !matches!(key.as_str(), "hooks" | "mcpServers" | "mcp"))
            .cloned(),
    })
}

/// Round 2 (G2, the review's major 4 and proof P2): a delivered plugin is
/// accepted only in the shape Plyloft itself produces, an **allow-list** —
/// what the CLIs load from a plugin grows with every release (`.lsp.json`,
/// `monitors/`, `workflows/`, `output-styles/`…), and a list of what to
/// refuse is always one release behind. The first thing at the plugin's
/// root, or inside its two fixed folders, that isn't on it:
///
/// - `.claude-plugin/` or `.codex-plugin/`, holding `plugin.json` only;
/// - `skills/`, holding skill folders only (each asked about by its OK);
/// - `commands/` and `agents/`: the layout rung 3 documents for a team's
///   hand-written plugin. Their texts are read by
///   [`crate::skill_scripts::asking_text_outside_skills`]: one that asks
///   refuses the plugin, a script there too;
/// - at the root, the files a repository keeps beside its code and nobody
///   runs: a README, licence or changelog as text, an image, git's own
///   dotfiles, Finder's and Explorer's files.
///
/// Not reachable through Share, Promote or Publish (they write only under
/// `skills/<skill>/`); a teammate with write access to the library can
/// commit anything with git.
fn outside_the_shape(plugin_dir: &Path) -> Option<String> {
    const OS_FILES: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];
    // Git's own, and the note Plyloft's snapshot keeps beside a delivered
    // plugin (`library_snapshot::SNAPSHOT_META`); no CLI reads either.
    const GIT_FILES: &[&str] = &[".gitignore", ".gitattributes", ".gitkeep", ".plyloft-snapshot.json"];
    const KEPT_EXTENSIONS: &[&str] = &["md", "markdown", "txt", "png", "jpg", "jpeg", "gif", "svg", "webp"];
    let names = |dir: &Path| -> Vec<(String, bool)> {
        let mut out: Vec<(String, bool)> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| {
                let is_dir = std::fs::symlink_metadata(entry.path()).is_ok_and(|meta| meta.is_dir());
                (entry.file_name().to_string_lossy().into_owned(), is_dir)
            })
            .collect();
        out.sort();
        out
    };
    for (name, is_dir) in names(plugin_dir) {
        if is_dir {
            match name.as_str() {
                ".claude-plugin" | ".codex-plugin" => {
                    if let Some((inner, _)) = names(&plugin_dir.join(&name)).into_iter().find(|(inner, dir)| *dir || (inner != "plugin.json" && !OS_FILES.contains(&inner.as_str()))) {
                        return Some(format!("{name}/{inner}"));
                    }
                }
                "skills" => {
                    if let Some((inner, _)) = names(&plugin_dir.join(&name)).into_iter().find(|(inner, dir)| !*dir && !OS_FILES.contains(&inner.as_str())) {
                        return Some(format!("skills/{inner}"));
                    }
                }
                "commands" | "agents" => {}
                // `hooks/` has its own sentence, said before this one.
                _ => return Some(format!("{name}/")),
            }
            continue;
        }
        if OS_FILES.contains(&name.as_str()) || GIT_FILES.contains(&name.as_str()) {
            continue;
        }
        let extension = name.rsplit_once('.').filter(|(stem, _)| !stem.is_empty()).map(|(_, ext)| ext.to_ascii_lowercase());
        let kept = match extension.as_deref() {
            Some(ext) => KEPT_EXTENSIONS.contains(&ext),
            // `LICENSE`, `NOTICE`: a plain name with no dot.
            None => !name.starts_with('.') && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')),
        };
        if !kept {
            return Some(name);
        }
    }
    None
}

/// Why this plugin may not be loaded, or `None` when it is clean.
///
/// Two ways a plugin runs commands, and both are refused.
///
/// **Hooks** — a `hooks/` directory (Claude reads `hooks/hooks.json`), a
/// `hooks.json` at the plugin root (Codex's shape), or a `hooks` key in the
/// manifest. Measured: a `SessionStart` hook injected context into a live
/// session with no prompt.
///
/// **MCP servers** — a `.mcp.json` beside the manifest, or `mcpServers`/`mcp`
/// inside it. A stdio server *is* a command line: the official `terraform`
/// plugin's is `docker run …`. Measured the same way as the hook, and it is
/// the same hazard through a different door — a plugin whose `.mcp.json` ran
/// `/bin/sh -c` wrote its sentinel file during an ordinary `claude -p`, with
/// nothing asked. Refusing hooks while passing this through would have been a
/// lock on one door of two.
fn executable_refusal(plugin_dir: &Path, manifest: &PluginManifest) -> Option<String> {
    if plugin_dir.join("hooks").is_dir() || plugin_dir.join("hooks.json").is_file() {
        return Some(format!("it carries hooks, which run commands on {YOUR_MACHINE}"));
    }
    if manifest.declares_hooks {
        return Some(format!("its manifest declares hooks, which run commands on {YOUR_MACHINE}"));
    }
    if plugin_dir.join(".mcp.json").is_file() {
        return Some(format!("it carries an MCP server, which runs a command on {YOUR_MACHINE}"));
    }
    if manifest.declares_mcp {
        return Some(format!(
            "its manifest declares an MCP server, which runs a command on {YOUR_MACHINE}"
        ));
    }
    // Round 2 (G2): the plugin's shape is an allow-list.
    if let Some(key) = &manifest.unknown_key {
        return Some(format!(
            "its manifest declares `{key}`, which Plyloft doesn't deliver; a plugin's manifest may hold its \
             name, version, description and author"
        ));
    }
    // Skills hub H6a (Challenger): the OK is asked per skill, so a script
    // beside the skills could reach every session, and change, unasked.
    crate::skill_scripts::script_outside_skills(plugin_dir)
        .map(|path| {
            format!(
                "it carries a script outside its skills (`{path}`), which Plyloft cannot ask you \
                 about; move it into the skill that uses it"
            )
        })
        // 1.175.0 B1 (SEC-1): the same door through text — a command or an
        // agent file whose front matter or body runs things unasked.
        .or_else(|| {
            crate::skill_scripts::miscased_component(plugin_dir).map(|name| {
                format!(
                    "it carries a folder named `{name}`, which some computers read as one of a plugin's own \
                     folders and Plyloft cannot ask you about; rename it"
                )
            })
        })
        .or_else(|| {
            crate::skill_scripts::asking_text_outside_skills(plugin_dir).map(|path| {
                format!(
                    "it carries a text outside its skills (`{path}`) that lets agents run things without \
                     asking, which Plyloft cannot ask you about; make it a skill"
                )
            })
        })
        // Round 2 (G2): after the sentences that name a script or a text —
        // anything else that isn't part of a plugin as Plyloft delivers one.
        .or_else(|| {
            outside_the_shape(plugin_dir).map(|found| {
                format!(
                    "it carries `{found}`, which is not part of a plugin as Plyloft delivers one (its \
                     manifest and its skills); take it out of the library"
                )
            })
        })
}

fn directory_name(dir: &Path) -> String {
    dir.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("plugin")
        .to_string()
}

/// One loadable `skills/<dir>/SKILL.md`, as the two CLIs see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedSkill {
    /// The directory name — the skill's identity, and the name Claude uses.
    pub dir: String,
    /// The frontmatter `name`, when it differs from the directory: that is
    /// what Codex calls the same skill.
    pub codex_name: Option<String>,
    pub description: String,
}

/// Every `skills/<dir>/SKILL.md` under `plugin_dir` that a CLI will load.
///
/// **A skill needs a `description` in its frontmatter**, and that is the only
/// thing it needs. Measured against both CLIs with four variants of the same
/// file: `name` + `description` loads; `description` alone loads, under the
/// directory's name; `name` alone does **not**; no frontmatter at all does
/// not. Ply counted the last two and badged them, which claimed a skill
/// reached a session that never saw it — so they are skipped and named here
/// instead, because a description is a one-line fix for whoever shared it.
///
/// **The identity is the directory**, not the frontmatter `name`. v1.117.0
/// measured what each CLI actually calls a skill whose two names disagree:
/// Claude invoked `plugprobe:plug-dirname` for frontmatter `plug-frontname`,
/// and Codex listed `probe-frontname2` for `.../probe-dirname2/SKILL.md`. The
/// directory is the half both CLIs agree on when the two match, it is the
/// path Promote and Install write, and it is therefore what keys a row.
fn read_skills(plugin_dir: &Path, errors: &mut Vec<String>) -> Vec<LoadedSkill> {
    let Some(children) = read_child_dirs(&plugin_dir.join("skills"), "skills", errors) else {
        return Vec::new();
    };
    children
        .into_iter()
        .filter_map(|dir| read_skill_dir(&dir, errors))
        .collect()
}

/// Skills hub H6b walk: the directories under `plugin_dir/skills/` holding a
/// `SKILL.md` — what a refused plugin would have offered, named on those
/// skills' Library rows. No frontmatter check: nothing of it is loaded.
fn skill_dirs_of(plugin_dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(plugin_dir.join("skills")) else {
        return Vec::new();
    };
    let mut out: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().join("SKILL.md").is_file())
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .filter(|name| !name.starts_with('.'))
        .collect();
    out.sort();
    out
}

/// One skill directory, or `None` with the reason recorded in `errors`.
/// Shared with rung 4's project-skill reader, so both answer "would a CLI
/// load this?" the same way.
pub fn read_skill_dir(dir: &Path, errors: &mut Vec<String>) -> Option<LoadedSkill> {
    let file = dir.join("SKILL.md");
    let text = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(error) => {
            errors.push(format!("{} could not be read: {error}", file.display()));
            return None;
        }
    };
    let name = directory_name(dir);
    let frontmatter = match parse_skill_frontmatter(&text) {
        Ok(frontmatter) => frontmatter,
        Err(reason) => {
            errors.push(format!("skill `{name}` is not loaded: {reason}"));
            return None;
        }
    };
    let Some(description) = frontmatter.description else {
        errors.push(format!(
            "skill `{name}` has no description in its frontmatter, so neither CLI loads it"
        ));
        return None;
    };
    Some(LoadedSkill {
        codex_name: frontmatter.name.filter(|declared| *declared != name),
        dir: name,
        description,
    })
}

/// A `SKILL.md`'s frontmatter, or why the CLIs will not read it.
#[derive(Debug)]
pub struct SkillFrontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
}

/// `name:` and `description:` out of a `SKILL.md`'s YAML frontmatter.
///
/// **Deliberately not a YAML parser, and the reason is measured.** Handing
/// these blocks to `serde_yaml_ng` rejects three of the five shapes tested
/// against the real CLIs, and the CLIs *load* two of them: a tab-indented
/// key, and `description: [unterminated`, which strict YAML calls an
/// unterminated flow sequence. A parser stricter than the vendor's makes Ply
/// under-report — it would hide a skill that every session actually has,
/// which is the same lie as over-reporting, told the other way.
///
/// So the rule is the vendors' own, established by running all five shapes
/// through both CLIs:
///
/// | frontmatter                        | CLIs | here |
/// | ---------------------------------- | ---- | ---- |
/// | `name` + `description`             | load | ok |
/// | `description` only                 | load | ok, name from the directory |
/// | tab-indented key                   | load | ok |
/// | `description: [unterminated`       | load | ok |
/// | no closing `---`                   | **no** | refused — "No frontmatter block found" is the CLI's own words |
/// | `description: "unclosed quote`     | **no** | refused — the CLI reports EOF scanning a quoted scalar |
///
/// The last two are the only failures, and each has an exact cause worth
/// naming rather than a general "it is not valid YAML".
pub fn parse_skill_frontmatter(text: &str) -> Result<SkillFrontmatter, String> {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Err("it has no frontmatter block".to_string());
    }
    let lines: Vec<&str> = lines.collect();
    let mut name = None;
    let mut description = None;
    let mut closed = false;
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        index += 1;
        // `trim` so a tab- or space-indented key is still found: the CLIs
        // read one, and missing it would drop a working skill.
        let trimmed = line.trim();
        if trimmed == "---" {
            closed = true;
            break;
        }
        let (slot, rest) = if let Some(rest) = trimmed.strip_prefix("name:") {
            (&mut name, rest)
        } else if let Some(rest) = trimmed.strip_prefix("description:") {
            (&mut description, rest)
        } else {
            continue;
        };
        let (value, consumed) = value(rest, indent_of(line), &lines[index..])?;
        *slot = Some(value);
        index += consumed;
    }
    if !closed {
        return Err("its frontmatter block is never closed by a second `---`".to_string());
    }
    Ok(SkillFrontmatter {
        name: name.filter(|v: &String| !v.trim().is_empty()),
        description: description.filter(|v: &String| !v.trim().is_empty()),
    })
}

/// A key's value, and how many of the `following` lines it took.
///
/// LYRA's skills — and plenty of others — write the description as a block
/// scalar (`description: >-` over indented lines), which both CLIs read.
/// Taking only the key's own line made the description the indicator itself.
/// So a value may continue onto the lines indented deeper than its key: as a
/// block scalar when the key's line holds only an indicator, otherwise as
/// YAML's multi-line plain style. A continuation stops at the closing `---`,
/// at the first line indented no deeper than the key, at a comment line (a
/// plain scalar's end in YAML; a block's content), and — so an indented
/// key after a plain value is still a key — at another `name:`/`description:`.
fn value(rest: &str, key_indent: usize, following: &[&str]) -> Result<(String, usize), String> {
    if let Some(header) = block_header(rest) {
        return Ok(block_scalar(header, key_indent, following));
    }
    let first = scalar(rest)?;
    let quoted = rest.trim_start().starts_with(['"', '\'']);
    if quoted {
        return Ok((first, 0));
    }
    let mut taken = 0;
    for line in following {
        let trimmed = line.trim();
        // A comment line ends a plain scalar in YAML; it is never content.
        if trimmed == "---"
            || trimmed.starts_with('#')
            || trimmed.starts_with("name:")
            || trimmed.starts_with("description:")
            || (!trimmed.is_empty() && indent_of(line) <= key_indent)
        {
            break;
        }
        taken += 1;
    }
    // Trailing blank lines belong to nobody: they end the value, not extend it.
    while taken > 0 && following[taken - 1].trim().is_empty() {
        taken -= 1;
    }
    if taken == 0 {
        return Ok((first, 0));
    }
    // Plain folding: lines join with a space, a blank line is a line break.
    let mut joined = first;
    let mut pending_breaks = 0;
    for line in &following[..taken] {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            pending_breaks += 1;
            continue;
        }
        if pending_breaks > 0 {
            joined.push_str(&"\n".repeat(pending_breaks));
        } else if !joined.is_empty() {
            joined.push(' ');
        }
        pending_breaks = 0;
        joined.push_str(trimmed);
    }
    Ok((joined, taken))
}

/// A block scalar's header: `>` (folded) or `|` (literal), then an optional
/// indentation digit and chomping indicator in either order, then an optional
/// comment.
#[derive(Clone, Copy)]
struct BlockHeader {
    folded: bool,
    indent: Option<usize>,
    /// `Some(false)` strips (`-`), `Some(true)` keeps (`+`), `None` clips.
    chomp: Option<bool>,
}

fn block_header(rest: &str) -> Option<BlockHeader> {
    let trimmed = rest.trim();
    let header = match trimmed.find(" #").or_else(|| trimmed.find("\t#")) {
        Some(at) => trimmed[..at].trim_end(),
        None => trimmed,
    };
    let mut chars = header.chars();
    let folded = match chars.next()? {
        '>' => true,
        '|' => false,
        _ => return None,
    };
    let mut parsed = BlockHeader { folded, indent: None, chomp: None };
    for c in chars {
        match c {
            '-' | '+' if parsed.chomp.is_none() => parsed.chomp = Some(c == '+'),
            '1'..='9' if parsed.indent.is_none() => {
                parsed.indent = c.to_digit(10).map(|d| d as usize)
            }
            _ => return None,
        }
    }
    Some(parsed)
}

/// The block's value and how many lines it took. The block runs until the
/// first non-blank line indented no deeper than its key — which includes the
/// closing `---`. An indented `---` is the block's content, not a delimiter.
fn block_scalar(header: BlockHeader, key_indent: usize, following: &[&str]) -> (String, usize) {
    let mut taken = 0;
    for line in following {
        let trimmed = line.trim();
        if !trimmed.is_empty() && indent_of(line) <= key_indent {
            break;
        }
        taken += 1;
    }
    let block = &following[..taken];
    let content_indent = header.indent.map(|digit| key_indent + digit).unwrap_or_else(|| {
        block
            .iter()
            .find(|line| !line.trim().is_empty())
            .map(|line| indent_of(line))
            .unwrap_or(0)
    });
    // Each line with the block's indentation removed; blank lines are empty.
    let body: Vec<&str> = block
        .iter()
        .map(|line| {
            if line.trim().is_empty() {
                ""
            } else {
                let skip = content_indent.min(indent_of(line));
                &line[line.char_indices().nth(skip).map_or(line.len(), |(at, _)| at)..]
            }
        })
        .collect();
    let content_end = body.iter().rposition(|line| !line.is_empty()).map_or(0, |at| at + 1);
    let trailing_blank = body.len() - content_end;

    let mut text = String::new();
    let mut previous: Option<&str> = None;
    let mut pending_blank = 0;
    for line in &body[..content_end] {
        if line.is_empty() {
            pending_blank += 1;
            continue;
        }
        if let Some(prev) = previous {
            // Folding joins two ordinary lines with a space; a blank line
            // between them is a paragraph break, and a more-indented line
            // keeps its newlines, as in literal style.
            let spaced = |l: &str| l.starts_with([' ', '\t']);
            if header.folded && !spaced(prev) && !spaced(line) {
                if pending_blank == 0 {
                    text.push(' ');
                } else {
                    text.push_str(&"\n".repeat(pending_blank));
                }
            } else {
                text.push_str(&"\n".repeat(pending_blank + 1));
            }
        } else {
            text.push_str(&"\n".repeat(pending_blank));
        }
        pending_blank = 0;
        text.push_str(line);
        previous = Some(line);
    }
    match header.chomp {
        Some(false) => {}
        None if content_end > 0 => text.push('\n'),
        None => {}
        Some(true) if content_end > 0 => text.push_str(&"\n".repeat(1 + trailing_blank)),
        Some(true) => text.push_str(&"\n".repeat(trailing_blank)),
    }
    (text, taken)
}

/// Leading whitespace, in characters: a tab counts as one, as it does for the
/// key it indents.
fn indent_of(line: &str) -> usize {
    line.chars().take_while(|c| *c == ' ' || *c == '\t').count()
}

/// One frontmatter value, with its quotes removed.
///
/// A value that opens a quote and never closes it is the one malformed shape
/// the CLIs refuse — they report an unexpected end of stream while scanning a
/// quoted scalar, and the skill does not load. Returning the raw text with
/// its dangling quote, as this used to, made Ply count it.
fn scalar(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix('"') {
        return double_quoted(rest)
            .ok_or_else(|| "its frontmatter opens a \" that is never closed".to_string());
    }
    if let Some(rest) = trimmed.strip_prefix('\'') {
        // Single-quoted: `''` is one quote, and nothing else is special.
        return rest
            .strip_suffix('\'')
            .map(|inner| inner.replace("''", "'"))
            .ok_or_else(|| "its frontmatter opens a ' that is never closed".to_string());
    }
    Ok(trimmed.to_string())
}

/// GH #216 review 2: the body of a YAML double-quoted scalar after its opening
/// `"`, with its escapes read (`\"`, `\\`, `\t`, `\n`, `\uXXXX`, …), up to the
/// closing quote — so a description `New skill…` wrote quoted and escaped
/// reads in the Library as it was typed. `None` when it never closes; an
/// escape YAML does not define is kept as written.
fn double_quoted(rest: &str) -> Option<String> {
    let mut out = String::with_capacity(rest.len());
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => {
                let escape = chars.next()?;
                let hex = |chars: &mut std::str::Chars, len: usize| -> Option<char> {
                    let digits: String = chars.by_ref().take(len).collect();
                    (digits.len() == len)
                        .then(|| u32::from_str_radix(&digits, 16).ok().and_then(char::from_u32))
                        .flatten()
                };
                let read = match escape {
                    '0' => Some('\0'),
                    'a' => Some('\u{7}'),
                    'b' => Some('\u{8}'),
                    't' | '\t' => Some('\t'),
                    'n' => Some('\n'),
                    'v' => Some('\u{b}'),
                    'f' => Some('\u{c}'),
                    'r' => Some('\r'),
                    'e' => Some('\u{1b}'),
                    ' ' => Some(' '),
                    '"' => Some('"'),
                    '/' => Some('/'),
                    '\\' => Some('\\'),
                    'N' => Some('\u{85}'),
                    '_' => Some('\u{a0}'),
                    'L' => Some('\u{2028}'),
                    'P' => Some('\u{2029}'),
                    'x' => hex(&mut chars, 2),
                    'u' => hex(&mut chars, 4),
                    'U' => hex(&mut chars, 8),
                    _ => None,
                };
                match read {
                    Some(c) => out.push(c),
                    None => {
                        out.push('\\');
                        out.push(escape);
                    }
                }
            }
            c => out.push(c),
        }
    }
    None
}

// ── Writing into the library (v1.117.0 — team sharing rung 4) ───────
//
// Promote puts one project skill into both halves of the library, so both
// CLIs load it. The *format* of those halves is this module's knowledge;
// `project_skills.rs` owns the copying and the repo side of the move.

/// The plugin Ply's own Promote writes into. Created on a team's first
/// Promote — `team-init.sh` seeds the two library directories empty, so until
/// someone shares a skill there is no plugin at all.
pub const PLY_PLUGIN: &str = "ply-team";

/// The version both manifests carry. Codex resolves an installed plugin
/// through a versioned cache path, and the overlay is rebuilt per launch, so
/// there is nothing for a bump to invalidate: it stays put rather than
/// becoming a number nobody maintains.
const PLY_PLUGIN_VERSION: &str = "1.0.0";
const PLY_PLUGIN_DESCRIPTION: &str = "Skills this team shares through Plyloft.";
const PLY_MARKETPLACE_DISPLAY_NAME: &str = "Plyloft team library";

/// `library/claude/<plugin>` — one Claude Code plugin.
pub fn claude_plugin_dir(team_clone_dir: &Path, plugin: &str) -> PathBuf {
    claude_library_dir(team_clone_dir).join(plugin)
}

/// `library/codex/plugins/<plugin>` — one plugin inside the local marketplace.
pub fn codex_plugin_dir(team_clone_dir: &Path, plugin: &str) -> PathBuf {
    codex_library_dir(team_clone_dir).join("plugins").join(plugin)
}

/// `<plugin>/skills/<skill>` for either vendor — the CLIs use the same layout.
pub fn plugin_skill_dir(plugin_dir: &Path, skill: &str) -> PathBuf {
    plugin_dir.join("skills").join(skill)
}

/// Both vendors' copies of one library skill, Claude first.
///
/// **Resolved through the plugins the reader accepted as `plugin`**, as
/// [`remove_paths`] does: a Claude plugin is whoever its manifest says it is,
/// so `library/claude/alpha/` may be plugin `beta`, and joining the name onto
/// the path would read (or write) a directory that is not that plugin. The
/// Codex half is the marketplace entry's own directory. A plugin the reader
/// does not list yet — the first Promote into it — is where its name puts it,
/// which is where [`ensure_ply_plugin`] creates it.
pub fn library_skill_dirs(team_clone_dir: &Path, plugin: &str, skill: &str) -> Vec<PathBuf> {
    let library = read_library(team_clone_dir);
    let named = claude_plugin_dir(team_clone_dir, plugin);
    // Two directories claiming one name: the one it names wins, so nothing
    // that worked by name before resolves elsewhere now.
    let claimed: Vec<&PathBuf> = library
        .claude_plugins
        .iter()
        .filter(|(name, _)| name == plugin)
        .map(|(_, dir)| dir)
        .collect();
    let claude = if claimed.is_empty() || claimed.contains(&&named) {
        named
    } else {
        claimed[0].clone()
    };
    let codex = library
        .codex
        .as_ref()
        .and_then(|marketplace| marketplace.plugins.iter().find(|p| p.name == plugin))
        .map(|p| p.dir.clone())
        .unwrap_or_else(|| codex_plugin_dir(team_clone_dir, plugin));
    vec![plugin_skill_dir(&claude, skill), plugin_skill_dir(&codex, skill)]
}

/// Both vendors' copies where `plugin`'s name puts them — the paths a Promote
/// stages ([`promote_paths`]) and creates the manifests beside.
pub fn named_skill_dirs(team_clone_dir: &Path, plugin: &str, skill: &str) -> Vec<PathBuf> {
    vec![
        plugin_skill_dir(&claude_plugin_dir(team_clone_dir, plugin), skill),
        plugin_skill_dir(&codex_plugin_dir(team_clone_dir, plugin), skill),
    ]
}

/// The repo-relative paths one Promote stages, as a single commit.
///
/// Deliberately narrow: the two plugin directories and the marketplace
/// manifest, never `library/` wholesale. Staging the whole library would
/// also commit any unrelated dirt a previous abandoned write left behind —
/// a member's Promote must publish their skill and nothing else.
pub fn promote_paths(plugin: &str, skill: &str) -> Result<Vec<String>, String> {
    if !is_safe_path_component(plugin) || !is_safe_path_component(skill) {
        return Err(format!(
            "`{skill}` cannot be shared: a skill's directory name must be a plain \
             name, with no slashes and no leading dot."
        ));
    }
    let library = crate::team::LIBRARY_DIR;
    Ok(vec![
        format!("{library}/claude/{plugin}/skills/{skill}"),
        format!("{library}/codex/plugins/{plugin}/skills/{skill}"),
        // The manifests come last only because the skill is the point; git
        // stages all of them in one commit either way.
        format!("{library}/claude/{plugin}/.claude-plugin/plugin.json"),
        format!("{library}/codex/plugins/{plugin}/.codex-plugin/plugin.json"),
        format!("{library}/codex/.agents/plugins/marketplace.json"),
    ])
}

/// Create the two plugin manifests and the marketplace entry if they are not
/// there yet, leaving anything that already exists exactly as it is.
///
/// A team's library starts empty, so the first Promote is also what makes the
/// library a plugin. Nothing here overwrites: a team that hand-authored its
/// own `plugin.json` (a description they wrote, a version they bumped) keeps
/// it, and only the marketplace's plugin *list* is added to.
pub fn ensure_ply_plugin(team_clone_dir: &Path, plugin: &str) -> Result<(), String> {
    let claude = claude_plugin_dir(team_clone_dir, plugin);
    write_manifest_if_absent(
        &claude.join(".claude-plugin").join("plugin.json"),
        plugin,
    )?;
    let codex = codex_plugin_dir(team_clone_dir, plugin);
    write_manifest_if_absent(&codex.join(".codex-plugin").join("plugin.json"), plugin)?;
    ensure_marketplace_entry(team_clone_dir, plugin)
}

fn write_manifest_if_absent(path: &Path, plugin: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    crate::atomic::write_atomic_json(
        path,
        &serde_json::json!({
            "name": plugin,
            "description": PLY_PLUGIN_DESCRIPTION,
            "version": PLY_PLUGIN_VERSION,
        }),
    )
}

/// Add `plugin` to the Codex marketplace manifest, creating the manifest when
/// the team has none.
///
/// Read-modify-write through `serde_json::Value` rather than a typed struct:
/// the manifest belongs to the team, and a field Ply does not model — a
/// display name they edited, a `policy` they tightened — must survive Ply
/// writing beside it. This is the same reason rung 3 refused to *append* to a
/// member's `config.toml`.
fn ensure_marketplace_entry(team_clone_dir: &Path, plugin: &str) -> Result<(), String> {
    let path = codex_marketplace_manifest(&codex_library_dir(team_clone_dir));
    let mut manifest = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|error| {
            format!(
                "The team's Codex marketplace manifest is not valid JSON, so Plyloft will not \
                 write beside it: {error}"
            )
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let object = manifest
        .as_object_mut()
        .ok_or_else(|| "The team's Codex marketplace manifest is not a JSON object.".to_string())?;
    object
        .entry("name".to_string())
        .or_insert_with(|| serde_json::Value::String(PLY_PLUGIN.to_string()));
    object
        .entry("interface".to_string())
        .or_insert_with(|| serde_json::json!({"displayName": PLY_MARKETPLACE_DISPLAY_NAME}));
    let plugins = object
        .entry("plugins".to_string())
        .or_insert_with(|| serde_json::Value::Array(Vec::new()));
    let plugins = plugins
        .as_array_mut()
        .ok_or_else(|| "The team's marketplace manifest has no plugin list.".to_string())?;
    let listed = plugins.iter().any(|entry| {
        entry.get("name").and_then(serde_json::Value::as_str) == Some(plugin)
    });
    if !listed {
        plugins.push(serde_json::json!({
            "name": plugin,
            "source": { "source": "local", "path": format!("./plugins/{plugin}") },
            "policy": { "installation": "AVAILABLE" },
        }));
    }
    crate::atomic::write_atomic_json(&path, &manifest)
}

// ── Retiring a skill from the library ───────────────────────────────
//
// The inverse of Promote, through the same library write: one commit that
// removes both halves, rolled back if anything after the removal fails. The
// manifests stay — the plugin is still a plugin, with one skill fewer, and
// the next Promote finds it exactly as the team left it.

/// The repo-relative paths one "Remove from team" stages, as a single commit:
/// each half of the library that holds `plugin:skill` now.
///
/// **Resolved through the plugins rung 3's reader accepted as `plugin`**, not
/// by joining the name onto `library/claude/`. A Claude plugin is whoever its
/// manifest says it is, so `library/claude/alpha/` may be plugin `beta`;
/// guessing the path from the name would delete `beta:<skill>` when asked to
/// retire `alpha:<skill>` (Challenger's P1 on snapshot 1). The Codex half is
/// `plugins/<entry name>` by construction, and is read from the marketplace
/// all the same.
///
/// Only the halves that are there. `git add -- <path>` refuses a path that is
/// neither on disk nor in the index, so a skill that reached one half only
/// must not name the other.
pub fn remove_paths(team_clone_dir: &Path, plugin: &str, skill: &str) -> Result<Vec<String>, String> {
    if !is_safe_path_component(plugin) || !is_safe_path_component(skill) {
        return Err(format!(
            "`{plugin}:{skill}` is not a plain library name, so Plyloft will not remove it."
        ));
    }
    let library = read_library(team_clone_dir);
    let mut dirs: Vec<PathBuf> = library
        .claude_plugins
        .iter()
        .filter(|(name, _)| name == plugin)
        .map(|(_, dir)| plugin_skill_dir(dir, skill))
        .collect();
    if let Some(marketplace) = &library.codex {
        dirs.extend(
            marketplace
                .plugins
                .iter()
                .filter(|candidate| candidate.name == plugin)
                .map(|candidate| plugin_skill_dir(&candidate.dir, skill)),
        );
    }
    let mut paths: Vec<String> = Vec::new();
    for dir in dirs {
        if std::fs::symlink_metadata(&dir).is_err() {
            continue;
        }
        let relative = dir.strip_prefix(team_clone_dir).map_err(|_| {
            format!("{} is outside the team clone, so Plyloft will not remove it.", dir.display())
        })?;
        refuse_links(team_clone_dir, relative)?;
        let relative = crate::platform::slash_path(relative);
        if !paths.contains(&relative) {
            paths.push(relative);
        }
    }
    if paths.is_empty() {
        return Err(format!(
            "`{plugin}:{skill}` is not in the team library any more — refresh."
        ));
    }
    Ok(paths)
}

/// Every component from the clone down to `relative` is a real directory.
///
/// The reader follows a symlinked plugin directory (`is_dir` does), so a link
/// in `library/claude/` could aim a removal — and the rollback's rewrite —
/// outside the team clone. A link anywhere on the way is refused before
/// anything is deleted.
fn refuse_links(team_clone_dir: &Path, relative: &Path) -> Result<(), String> {
    let mut current = team_clone_dir.to_path_buf();
    for component in relative.components() {
        current.push(component);
        let meta = std::fs::symlink_metadata(&current)
            .map_err(|error| format!("read {}: {error}", current.display()))?;
        if meta.file_type().is_symlink() {
            return Err(format!(
                "{} is a symlink, so Plyloft will not remove anything through it.",
                current.display()
            ));
        }
    }
    Ok(())
}

/// **Remove from team**, the half that runs inside the library write.
///
/// Deletes each of `relative_paths` (from [`remove_paths`]), prunes the
/// `skills/` directories that leaves empty, and then asks rung 3's reader —
/// the one that hands skills to the CLIs — whether it still offers the skill.
/// The paths were resolved before the pull; a teammate who meanwhile added
/// another copy under the same plugin would leave it loading in every session
/// while the member is told it is gone. Refusing is safe: the library write's
/// rollback restores every path it snapshotted.
pub fn remove_library_skill(
    team_clone_dir: &Path,
    plugin: &str,
    skill: &str,
    relative_paths: &[String],
) -> Result<(), String> {
    // Resolved again against the clone exactly as the publish just pulled it,
    // before anything is deleted (Challenger's P1 on snapshot 2). The paths
    // were chosen before that pull, and a teammate's pushed manifest rename
    // can make `library/claude/alpha/` plugin `beta` in between: deleting it
    // then retires `beta:<skill>`, and the check below would pass because
    // `alpha:<skill>` no longer loads. Any difference — an owner changed, a
    // half gone, a copy added — refuses, and nothing has been touched yet.
    let mut now = remove_paths(team_clone_dir, plugin, skill)?;
    let mut planned = relative_paths.to_vec();
    now.sort();
    planned.sort();
    if now != planned {
        return Err(format!(
            "`{plugin}:{skill}` changed in the team library while Plyloft was working — the \
             directories that hold it now are not the ones Plyloft was about to remove. \
             Refresh Settings › Team › Members and library and try again"
        ));
    }
    for relative in relative_paths {
        let dir = team_clone_dir.join(relative);
        match std::fs::symlink_metadata(&dir) {
            Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(&dir)
                .map_err(|error| format!("remove {relative}: {error}"))?,
            Ok(_) => {
                return Err(format!(
                    "{relative} is not a skill directory, so Plyloft will not remove it."
                ))
            }
            // Present when the paths were chosen, gone after the pull.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(format!(
                    "A teammate changed `{plugin}:{skill}` while Plyloft was working ({relative} \
                     is gone). Refresh Settings › Team › Members and library and try again."
                ))
            }
            Err(error) => return Err(format!("read {relative}: {error}")),
        }
        crate::team::prune_empty_parents(team_clone_dir, &dir);
    }
    let still_offered = read_library(team_clone_dir)
        .skills
        .iter()
        .any(|row| row.plugin == plugin && row.name == skill);
    if still_offered {
        return Err(format!(
            "`{plugin}:{skill}` still loads from the team library after Plyloft removed {}: \
             another copy of it appeared while Plyloft was working. Refresh Settings › Team › Members and library \
             and try again",
            relative_paths.join(" and ")
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "team_skills_tests.rs"]
mod tests;

/// The acceptance proof against the real CLIs. `#[ignore]`d — see the module.
#[cfg(all(test, unix))]
#[path = "team_skills_live_tests.rs"]
mod live_tests;
