//! 1.173.0 (B2): does this repository hold more than one product?
//!
//! The Board's one notice ("This repository seems to hold two products…",
//! mockup areas.html scene 1) is shown when a repository has no areas yet
//! and Plyloft sees a product at the root **and** a sub-folder that ships on
//! its own next to it. *Set up areas…* opens Settings › Areas (B5) with the
//! suggestion below filled in.
//!
//! What counts as a product:
//! - **the root**: a project file of its own at the top (`package.json`,
//!   `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `go.mod`, …) or a
//!   deploy file (`Dockerfile*` or `Containerfile*` in any case,
//!   `railway.json`, `vercel.json`, `render.yaml`, …) — unless it is a
//!   monorepo's root (`workspaces` in its `package.json`,
//!   `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json`), which
//!   holds products and is none itself;
//! - **a sub-folder**: a project file **and** a deploy file of its own. A
//!   folder with only a `package.json` (a `frontend/` the root app builds, a
//!   package of a monorepo) is part of the product around it, and a folder
//!   with only a Dockerfile (a database image) is a service of it, not a
//!   product. A product folder inside another one is part of the outer one.
//!   1.174.0 (C10 walk): one exception — a plain static website, published
//!   as its files are (GitHub Pages, a host's own settings), needs no deploy
//!   file: a folder with its own `package.json` **and** its own `index.html`
//!   at its top, named as a site (a whole part of its name is `site`,
//!   `website`, `www`, `landing` or `blog`: `site/`, `lyrappc-website/`, not
//!   `composite-ui/`) or with a site generator in its `package.json`.
//!
//! Folders that are never products: hidden ones (`.claude/`, `.github/`),
//! dependencies and build output (`node_modules/`, `vendor/`, `dist/`,
//! `target/`, …) and examples, demos, fixtures, tests, templates and
//! archives. A `docs/` folder counts only as a website of its own: a site
//! generator in its `package.json` and a deploy file.
//!
//! The notice applies to a workspace opened on the repository's root only:
//! one opened on a folder inside it is one product's already.
//!
//! [`detect`] is pure (a file list and a reader in, the products out) and
//! tested; [`areas_discover`] runs it off the main thread on git's list of
//! the repository's files with those names ([`pathspecs`]), cached per
//! repository and commit.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::Serialize;

use crate::areas::{normalize_path, AreaDef, ID_MAX, RESERVED_IDS};

/// A folder's own project files: what makes it a project.
pub const PROJECT_FILES: [&str; 10] = [
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
    "Gemfile",
    "composer.json",
    "pom.xml",
    "build.gradle",
    "deno.json",
];

/// Files that say a folder is deployed on its own — and, matched without
/// case and with any suffix, a `Dockerfile*` or `Containerfile*`
/// ([`is_deploy_file`]).
pub const DEPLOY_FILES: [&str; 10] = [
    "railway.json",
    "railway.toml",
    "fly.toml",
    "vercel.json",
    "netlify.toml",
    "Procfile",
    "wrangler.toml",
    "render.yaml",
    "firebase.json",
    "nixpacks.toml",
];

/// Container recipes, matched case-blind as a name's start
/// (`Dockerfile.prod`, `dockerfile`, `Containerfile`).
const CONTAINER_FILES: [&str; 2] = ["dockerfile", "containerfile"];

/// A root with one of these (or a `package.json` with `workspaces`) is a
/// monorepo's: not a product itself, its folders are.
pub const MONOREPO_FILES: [&str; 4] = ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"];

pub fn is_deploy_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    DEPLOY_FILES.contains(&name) || CONTAINER_FILES.iter().any(|c| lower.starts_with(c))
}

/// A static website's page: with a `package.json` beside it, a site
/// folder ships on its own without a deploy file.
pub const STATIC_PAGE: &str = "index.html";

/// The pathspecs `git ls-files` lists: only the file names [`detect`] reads.
pub fn pathspecs() -> Vec<String> {
    let mut specs: Vec<String> = PROJECT_FILES
        .iter()
        .chain(DEPLOY_FILES.iter())
        .chain(MONOREPO_FILES.iter())
        .chain(std::iter::once(&STATIC_PAGE))
        .map(|name| format!("*{name}"))
        .collect();
    specs.extend(CONTAINER_FILES.iter().map(|c| format!(":(icase)*{c}*")));
    specs
}

/// Folder names that never hold a product of the repository's own.
const NOT_PRODUCTS: [&str; 21] = [
    "node_modules",
    "vendor",
    "dist",
    "build",
    "out",
    "target",
    "coverage",
    "example",
    "examples",
    "demo",
    "demos",
    "fixture",
    "fixtures",
    "test",
    "tests",
    "__tests__",
    "spec",
    "template",
    "templates",
    "archive",
    "third_party",
];

/// How deep a product folder may sit (`apps/site/` is 2).
pub const MAX_DEPTH: usize = 3;

/// A `package.json` dependency that makes a folder a website.
const SITE_PACKAGES: [&str; 8] = [
    "astro",
    "@docusaurus/core",
    "gatsby",
    "vitepress",
    "@11ty/eleventy",
    "hexo",
    "nextra",
    "@astrojs/starlight",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProductKind {
    App,
    Site,
}

/// One product Plyloft saw.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    /// From the repository root; "" is the root.
    pub path: String,
    pub kind: ProductKind,
}

/// What [`detect`] found: two products or more.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaDiscovery {
    /// The root first, then the folders in path order.
    pub products: Vec<Product>,
    /// One area per product, in the same order (the root's first, so it
    /// keeps the `vX.Y.Z` tags): what *Set up areas…* fills in.
    pub suggestion: Vec<AreaDef>,
    /// The Board's notice applies: a product at the root and one beside
    /// it, or a monorepo's root with two products or more in its folders.
    pub notice: bool,
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn folder_of(path: &str) -> String {
    match path.rfind('/') {
        Some(at) => path[..at].to_string(),
        None => String::new(),
    }
}

fn may_hold_a_product(folder: &str) -> bool {
    folder.is_empty()
        || (folder.split('/').count() <= MAX_DEPTH
            && folder.split('/').all(|part| {
                !part.starts_with('.') && !NOT_PRODUCTS.contains(&part.to_ascii_lowercase().as_str())
            }))
}

/// A `docs/` folder is the code's documentation — unless it is a website of
/// its own: a site generator in its `package.json` and its own deploy file.
fn in_docs(folder: &str) -> bool {
    folder.split('/').any(|part| part.eq_ignore_ascii_case("docs"))
}

fn package_json(folder: &str, read: &impl Fn(&str) -> Option<String>) -> Option<serde_json::Value> {
    let manifest = if folder.is_empty() { "package.json".to_string() } else { format!("{folder}/package.json") };
    read(&manifest).and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
}

fn site_by_dependencies(folder: &str, read: &impl Fn(&str) -> Option<String>) -> bool {
    let deps = package_json(folder, read)
        .map(|json| {
            ["dependencies", "devDependencies"]
                .iter()
                .filter_map(|key| json.get(*key).and_then(|d| d.as_object()))
                .flat_map(|d| d.keys().cloned())
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    SITE_PACKAGES.iter().any(|p| deps.contains(*p))
}

fn inside(outer: &str, inner: &str) -> bool {
    !outer.is_empty() && inner.len() > outer.len() && inner.starts_with(outer) && inner.as_bytes()[outer.len()] == b'/'
}

/// Words that, as a whole part of a folder's name (split on `-`, `_` and
/// `.`), say it is a website — what decides a static site is a product.
const SITE_WORDS: [&str; 5] = ["site", "website", "www", "landing", "blog"];

fn named_as_a_site(folder: &str) -> bool {
    file_name(folder)
        .to_ascii_lowercase()
        .split(['-', '_', '.'])
        .any(|part| SITE_WORDS.contains(&part))
}

fn kind_of(folder: &str, has_package_json: bool, read: &impl Fn(&str) -> Option<String>) -> ProductKind {
    if has_package_json && site_by_dependencies(folder, read) {
        return ProductKind::Site;
    }
    let name = file_name(folder).to_ascii_lowercase();
    if ["site", "www", "landing", "blog"].iter().any(|w| name.contains(w)) {
        ProductKind::Site
    } else {
        ProductKind::App
    }
}

/// A folder's last part as an area id: lowercase letters, digits and dashes.
fn slug(folder: &str) -> String {
    let mut out = String::new();
    for c in file_name(folder).chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').to_string();
    out.chars().take(ID_MAX).collect::<String>().trim_end_matches('-').to_string()
}

fn kind_word(kind: ProductKind) -> &'static str {
    match kind {
        ProductKind::App => "app",
        ProductKind::Site => "site",
    }
}

fn capitalized(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// One area per product: "app"/"site" while a kind is seen once, the
/// folder's name otherwise — unique, never a reserved id.
fn suggest(products: &[Product]) -> Vec<AreaDef> {
    let mut count: BTreeMap<ProductKind, usize> = BTreeMap::new();
    for p in products {
        *count.entry(p.kind).or_default() += 1;
    }
    let mut taken = BTreeSet::new();
    products
        .iter()
        .map(|p| {
            let by_kind = count[&p.kind] == 1 || p.path.is_empty();
            let mut base = if by_kind { kind_word(p.kind).to_string() } else { slug(&p.path) };
            if base.is_empty() || RESERVED_IDS.contains(&base.as_str()) || taken.contains(&base) {
                base = if p.path.is_empty() { kind_word(p.kind).to_string() } else { slug(&p.path) };
            }
            if base.is_empty() || RESERVED_IDS.contains(&base.as_str()) {
                base = "area".to_string();
            }
            let mut id = base.clone();
            let mut n = 2;
            while taken.contains(&id) {
                id = format!("{}-{n}", base.chars().take(ID_MAX - 3).collect::<String>());
                n += 1;
            }
            taken.insert(id.clone());
            let name = if by_kind && id == kind_word(p.kind) {
                capitalized(&id)
            } else {
                file_name(&p.path).to_string()
            };
            AreaDef { id, name, path: p.path.clone(), ..Default::default() }
        })
        .collect()
}

/// The products in a repository, from its files (paths from the root) and a
/// reader for a few of them (`package.json`s, to tell a site from an app).
/// `None` while there are fewer than two.
pub fn detect<S: AsRef<str>>(files: &[S], read: impl Fn(&str) -> Option<String>) -> Option<AreaDiscovery> {
    let mut markers: BTreeMap<String, (bool, bool, bool)> = BTreeMap::new(); // project, deploy, package.json
    // Folders with an index.html of their own (a static site's page).
    let mut pages: BTreeSet<String> = BTreeSet::new();
    let mut monorepo = false;
    // The manifests that carry a folder's version (Settings › Areas'
    // suggestion fills them in as its version files).
    let mut manifests: BTreeMap<String, BTreeSet<&'static str>> = BTreeMap::new();
    for file in files {
        let path = normalize_path(file.as_ref());
        let name = file_name(&path);
        let folder = folder_of(&path);
        if folder.is_empty() && MONOREPO_FILES.contains(&name) {
            monorepo = true;
        }
        if name == STATIC_PAGE {
            if may_hold_a_product(&folder) {
                pages.insert(folder);
            }
            continue;
        }
        let project = PROJECT_FILES.contains(&name);
        let deploy = is_deploy_file(name);
        if !project && !deploy {
            continue;
        }
        if !may_hold_a_product(&folder) {
            continue;
        }
        if let Some(kind) = VERSION_MANIFESTS.iter().find(|m| **m == name) {
            manifests.entry(folder.clone()).or_default().insert(kind);
        }
        let entry = markers.entry(folder).or_default();
        entry.0 |= project;
        entry.1 |= deploy;
        entry.2 |= name == "package.json";
    }
    // A monorepo's root (`workspaces` in its package.json, or a workspace
    // tool's file) holds the products; it is none itself.
    let root_package = markers.get("").is_some_and(|m| m.2);
    monorepo |= root_package
        && package_json("", &read).is_some_and(|json| json.get("workspaces").is_some());
    let root = !monorepo && markers.get("").is_some_and(|(project, deploy, _)| *project || *deploy);
    let candidates: Vec<&String> = markers
        .iter()
        .filter(|(folder, (project, deploy, package))| {
            if folder.is_empty() || !*project {
                return false;
            }
            if *deploy {
                return !in_docs(folder) || (*package && site_by_dependencies(folder, &read));
            }
            // A static website of its own: a site by its name or its
            // generator, its package.json and its own index.html (never
            // docs/ without a deploy file: the code's documentation).
            *package
                && pages.contains(folder.as_str())
                && !in_docs(folder)
                && (named_as_a_site(folder) || site_by_dependencies(folder, &read))
        })
        .map(|(folder, _)| folder)
        .collect();
    let folders: Vec<&String> = candidates
        .iter()
        .filter(|f| !candidates.iter().any(|outer| inside(outer, f)))
        .copied()
        .collect();
    let mut products = Vec::new();
    if root {
        products.push(Product { path: String::new(), kind: kind_of("", markers[""].2, &read) });
    }
    for folder in &folders {
        products.push(Product { path: (*folder).clone(), kind: kind_of(folder, markers[*folder].2, &read) });
    }
    if products.len() < 2 {
        return None;
    }
    // The notice: a product at the root and one beside it, or a monorepo
    // whose root holds two products or more.
    let notice = root || monorepo;
    let suggestion = suggest(&products)
        .into_iter()
        .zip(&products)
        .enumerate()
        .map(|(index, (area, product))| filled_in(area, product, index, manifests.get(&product.path), &read))
        .collect();
    Some(AreaDiscovery { suggestion, notice, products })
}

/// The manifests whose `version` an area's releases write, in this order.
const VERSION_MANIFESTS: [&str; 3] = ["package.json", "pyproject.toml", "Cargo.toml"];

/// Settings › Areas' suggestion, written out: its board label and tag
/// prefix (explicit, so reordering never retags: "" for the first area,
/// `<id>-` for the others), a folder's own version manifests (the root
/// keeps the workspace's), and "Where to look at it" from a `homepage`.
fn filled_in(
    mut area: AreaDef,
    product: &Product,
    index: usize,
    manifests: Option<&BTreeSet<&'static str>>,
    read: &impl Fn(&str) -> Option<String>,
) -> AreaDef {
    use crate::project_config::{VersionFileEntry, VersionFileKind};
    area.label = Some(crate::areas::default_label(&area.id));
    area.tag_prefix = Some(if index == 0 { String::new() } else { format!("{}-", area.id) });
    if !product.path.is_empty() {
        let files: Vec<VersionFileEntry> = VERSION_MANIFESTS
            .iter()
            .filter(|m| manifests.is_some_and(|set| set.contains(**m)))
            .map(|m| VersionFileEntry {
                path: format!("{}/{m}", product.path),
                kind: match *m {
                    "package.json" => VersionFileKind::PackageJson,
                    "pyproject.toml" => VersionFileKind::PyProjectToml,
                    _ => VersionFileKind::CargoToml,
                },
                variable_name: None,
            })
            .collect();
        if !files.is_empty() {
            area.version_files = Some(files);
        }
    }
    area.look_at = package_json(&product.path, read)
        .and_then(|json| json.get("homepage").and_then(|h| h.as_str()).map(str::trim).map(str::to_string))
        .filter(|url| url.starts_with("https://") || url.starts_with("http://"))
        .filter(|url| !is_code_host(url));
    area
}

/// A homepage that is the code's page (a repository on GitHub, GitLab or
/// Bitbucket), not the product's.
const CODE_HOSTS: [&str; 3] = ["github.com", "gitlab.com", "bitbucket.org"];

pub(crate) fn is_code_host(url: &str) -> bool {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let host = rest.split(['/', '?', '#']).next().unwrap_or("").to_ascii_lowercase();
    let host = host.rsplit('@').next().unwrap_or("").split(':').next().unwrap_or("").trim_start_matches("www.");
    CODE_HOSTS.contains(&host)
}

/// What one look found, by repository root: the commit it was read at.
type Seen = BTreeMap<String, (String, Option<AreaDiscovery>)>;
static SEEN: std::sync::Mutex<Seen> = std::sync::Mutex::new(BTreeMap::new());

fn git_line(cwd: &str, args: &[&str]) -> Option<String> {
    let out = crate::platform::git_command().args(args).current_dir(cwd).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/// [`detect`] over the repository `cwd` sits in, from git's list of its
/// files. Cached per repository and commit; call it off the main thread.
/// `None` outside a git repository, and when git can't list it.
pub fn discover(cwd: &str) -> Option<AreaDiscovery> {
    let top = git_line(cwd, &["rev-parse", "--show-toplevel"])?;
    let head = git_line(&top, &["rev-parse", "HEAD"]).unwrap_or_default();
    if let Some((at, found)) = SEEN.lock().unwrap_or_else(|p| p.into_inner()).get(&top) {
        if !head.is_empty() && *at == head {
            return found.clone();
        }
    }
    let out = crate::platform::git_command()
        .args(["-c", "core.quotepath=off", "ls-files", "-z", "--"])
        .args(pathspecs())
        .current_dir(&top)
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let listed = String::from_utf8_lossy(&out.stdout).into_owned();
    let files: Vec<&str> = listed.split('\0').filter(|f| !f.is_empty()).collect();
    let root = Path::new(&top);
    let found = detect(&files, |rel| {
        let path = root.join(rel);
        let small = std::fs::metadata(&path).map(|m| m.len() <= 512 * 1024).unwrap_or(false);
        small.then(|| std::fs::read_to_string(&path).ok()).flatten()
    });
    if !head.is_empty() {
        SEEN.lock().unwrap_or_else(|p| p.into_inner()).insert(top, (head, found.clone()));
    }
    found
}

/// The Board's two-products notice and Settings › Areas' suggestion
/// (`areasDiscover`). Off the main thread: it asks git for the
/// repository's files.
#[tauri::command(async)]
pub fn areas_discover(app: tauri::AppHandle, workspace_id: String) -> Result<Option<AreaDiscovery>, String> {
    use tauri::Manager;
    let workspaces = app.state::<crate::workspace::WorkspaceStore>();
    let Some(cwd) = workspaces.snapshot().workspaces.into_iter().find(|w| w.id == workspace_id).map(|w| w.cwd)
    else {
        return Ok(None);
    };
    // A workspace opened on a folder inside its repository is one product's
    // already: it is not told about the others.
    if !crate::areas::workspace_prefix(&cwd).is_empty() {
        return Ok(None);
    }
    Ok(discover(&cwd))
}

#[cfg(test)]
#[path = "area_discovery_tests.rs"]
mod tests;
