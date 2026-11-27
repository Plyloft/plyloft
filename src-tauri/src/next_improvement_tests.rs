//! Tests for Next improvement's direction (1.173.0, E1), against real git and
//! a temporary bare remote.

use super::*;
use crate::workspace_definition::{load_cache, parse_definition, save_cache, DefinitionCache};
use crate::setting_conflict::SettingConflict;
use std::path::Path;
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = crate::platform::git_command()
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A bare origin with `main` carrying a shared definition and a README, the
/// user's clone (`work`, on `feature` with a dirty file) and another clone.
struct Fixture {
    dir: TempDir,
    store: ProjectConfigStore,
}

const WS: &str = "ws";

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("origin.git")).unwrap();
        git(&root.join("origin.git"), &["init", "-q", "--bare", "-b", "main"]);
        git(root, &["clone", "-q", "origin.git", "other"]);
        let other = root.join("other");
        git(&other, &["config", "user.name", "other-mac"]);
        git(&other, &["config", "user.email", "other@example.com"]);
        git(&other, &["checkout", "-q", "-b", "main"]);
        std::fs::create_dir_all(other.join(".atelier")).unwrap();
        std::fs::write(other.join(".atelier/workspace.json"), "{\"schemaVersion\":1,\"name\":\"LYRA\"}\n").unwrap();
        std::fs::write(other.join("README.md"), "# Lyra\n\n[![ci](https://img.shields.io/x.svg)](https://github.com/o/lyra)\n\nLyra helps PPC agencies audit Google Ads accounts. It runs nightly.\n\nWebsite: https://www.lyrappc.com\n").unwrap();
        git(&other, &["add", "."]);
        git(&other, &["commit", "-q", "-m", "init"]);
        git(&other, &["push", "-q", "origin", "main"]);
        git(root, &["clone", "-q", "origin.git", "work"]);
        let work = root.join("work");
        git(&work, &["config", "user.name", "test-owner"]);
        git(&work, &["config", "user.email", "matteo@example.com"]);
        git(&work, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(work.join("README.md"), "dirty\n").unwrap();
        let store = ProjectConfigStore::new(root.join("config")).unwrap();
        Fixture { dir, store }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    /// The workspace shares its definition on `main`.
    fn share(&self) {
        let mut cache = DefinitionCache::empty();
        cache.definition = Some(parse_definition(b"{\"schemaVersion\":1,\"name\":\"LYRA\"}").unwrap());
        cache.branch = Some("main".into());
        save_cache(&self.store, WS, &cache).unwrap();
    }

    fn channel(&self) -> Channel {
        Channel { git: Plumbing { cwd: self.path("work") }, prs: None, device: Some("MacBook Pro".into()) }
    }

    fn on_origin(&self, path: &str) -> Option<String> {
        let out = crate::platform::git_command()
            .args(["show", &format!("main:{path}")])
            .current_dir(self.path("origin.git"))
            .output()
            .unwrap();
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }

    fn press(&self, area: Option<&str>, edit: Edit) -> Result<String, String> {
        let channel = self.channel();
        let key = record(&self.store, &channel.git, WS, area, None, edit)?;
        drain_with(&self.store, &channel, WS, Some(&key));
        Ok(key)
    }

    fn view(&self) -> DirectionView {
        view(&self.store, &self.channel().git, WS, None, None, &Vec::new).unwrap()
    }

    /// Another Mac rewrites the direction on main.
    fn other_writes(&self, area: &str, change: impl FnOnce(&mut Direction)) {
        let other = self.path("other");
        git(&other, &["pull", "-q", "origin", "main"]);
        let file = other.join(direction_path(area));
        let mut d = std::fs::read(&file).ok().map(|b| parse_direction(&b).unwrap()).unwrap_or_default();
        change(&mut d);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, direction_bytes(&d)).unwrap();
        git(&other, &["add", "."]);
        git(&other, &["commit", "-q", "-m", "chore(config): theirs\n\nPlyloft-Device: Mac mini"]);
        git(&other, &["push", "-q", "origin", "main"]);
    }
}

fn mine() -> Direction {
    Direction {
        audience: "PPC agencies evaluating Lyra.".into(),
        better: "They start a trial without help.".into(),
        avoid: "Pop-ups.".into(),
        look_at: "https://www.lyrappc.com".into(),
        approaches: vec!["simplify".into(), "fix".into()],
        proposer: Some("claude".into()),
        ..Direction::default()
    }
}

fn reject(title: &str, reason: &str) -> Edit {
    Edit::Reject { title: title.into(), reason: reason.into(), by: Some("matteo".into()), device: None, at: 1 }
}

// ── The file ───────────────────────────────────────────────────────────

/// The v1.11.x migration template for a new file: a direction with only
/// some fields (an older or hand-written file) loads with the rest at their
/// defaults, and keys a newer Plyloft wrote survive a rewrite here.
#[test]
fn an_older_or_newer_direction_loads_and_keeps_unknown_fields() {
    let d = parse_direction(b"{}").unwrap();
    assert_eq!(d, Direction::default(), "an empty file is an empty direction");
    assert_eq!(d.schema_version, DIRECTION_SCHEMA_VERSION);

    let newer = br#"{"schemaVersion":2,"audience":"agencies","approaches":["polish","tidy"],
        "tone":"warm","rejected":[{"title":"Pop-up","reason":"no","at":5,"why2":true}]}"#;
    let d = parse_direction(newer).unwrap();
    assert_eq!(d.audience, "agencies");
    assert_eq!(d.better, "", "absent fields default");
    assert_eq!(d.approaches, vec!["polish", "tidy"], "an approach this build doesn't know is kept");
    assert_eq!(d.extra.get("tone"), Some(&Value::from("warm")));
    assert_eq!(d.rejected[0].extra.get("why2"), Some(&Value::Bool(true)));
    let back: Value = serde_json::from_slice(&direction_bytes(&d)).unwrap();
    assert_eq!(back["tone"], "warm");
    assert_eq!(back["rejected"][0]["why2"], true);
    assert_eq!(back["schemaVersion"], 2);

    assert!(parse_direction(b"[1,2]").is_err(), "not a direction: refused, never written over");
}

#[test]
fn a_missing_or_older_queue_reads_as_empty_or_as_written() {
    let fx = Fixture::new();
    assert!(load_queue(&fx.store, WS).areas.is_empty(), "no file: nothing queued");
    let file = queue_path(&fx.store, WS);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, br#"{"areas":{"default":{"value":{"audience":"x"}}}}"#).unwrap();
    let queue = load_queue(&fx.store, WS);
    let entry = &queue.areas["default"];
    assert_eq!((entry.value.audience.as_str(), entry.base.is_none(), entry.attempts), ("x", true, 0));
    std::fs::write(&file, b"not json").unwrap();
    assert!(load_queue(&fx.store, WS).areas.is_empty());
    assert!(!file.exists(), "an unreadable queue is set aside, not overwritten");
    // C17: beside itself as `<name>.unreadable-<ms>`, as it was.
    let aside: Vec<_> = std::fs::read_dir(file.parent().unwrap())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(&format!("{QUEUE_FILENAME}.unreadable-")))
        .collect();
    assert_eq!(aside.len(), 1);
    assert_eq!(std::fs::read(aside[0].path()).unwrap(), b"not json");
    // The state starts fresh: the next save writes a new queue.
    save_queue(&fx.store, WS, &queue).unwrap();
    assert_eq!(load_queue(&fx.store, WS).areas.len(), 1);
}

/// C17: a queue that can't be set aside is logged and reads as empty, and no
/// save writes over it or removes it.
#[test]
#[cfg(unix)]
fn an_unreadable_queue_that_cannot_be_set_aside_is_never_written_over() {
    use std::os::unix::fs::PermissionsExt;
    let fx = Fixture::new();
    let file = queue_path(&fx.store, WS);
    let dir = file.parent().unwrap().to_path_buf();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(&file, b"not json").unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    let loaded = load_queue(&fx.store, WS);
    let saved = save_queue(&fx.store, WS, &loaded);
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(loaded.areas.is_empty());
    let error = saved.expect_err("reported, not ignored");
    assert!(error.contains("couldn't be set aside"), "{error}");
    assert_eq!(std::fs::read(&file).unwrap(), b"not json", "left as it is");
}

#[test]
fn save_trims_caps_and_refuses_what_it_cannot_use() {
    let mut d = mine();
    d.audience = format!("  {}  ", "a".repeat(TEXT_MAX + 50));
    d.approaches = vec!["Fix".into(), "fix".into(), " ".into()];
    let n = normalized_for_save(d).unwrap();
    assert_eq!(n.audience.chars().count(), TEXT_MAX);
    assert_eq!(n.approaches, vec!["fix"]);
    let n = normalized_for_save(Direction { approaches: Vec::new(), ..mine() }).unwrap();
    assert_eq!(n.approaches, ["polish"], "no approach chosen: Polish");
    let err = normalized_for_save(Direction { look_at: "lyrappc.com".into(), ..mine() }).unwrap_err();
    assert!(err.contains("web address"), "{err}");
    let err = normalized_for_save(Direction { proposer: Some("gemini".into()), ..mine() }).unwrap_err();
    assert!(err.contains("Claude or Codex"), "{err}");
}

// ── Publishing ─────────────────────────────────────────────────────────

#[test]
fn saving_publishes_only_the_direction_file_and_never_touches_the_checkout() {
    let fx = Fixture::new();
    fx.share();
    let before = git(&fx.path("work"), &["status", "--porcelain"]);
    fx.press(None, Edit::Save(mine())).unwrap();
    let on_branch = parse_direction(fx.on_origin(".atelier/next-improvement/default.json").unwrap().as_bytes()).unwrap();
    assert_eq!(on_branch, normalized_for_save(mine()).unwrap());
    let origin = fx.path("origin.git");
    let files = git(&origin, &["show", "--name-only", "--format=", "main"]);
    assert_eq!(files, ".atelier/next-improvement/default.json", "the commit changes only that file");
    let message = git(&origin, &["log", "-1", "--format=%B", "main"]);
    assert!(message.starts_with("chore(config): next improvement direction — default"), "{message}");
    assert!(message.contains("Plyloft-Device: MacBook Pro"), "{message}");
    assert!(load_queue(&fx.store, WS).areas.is_empty(), "published: nothing left queued");
    assert_eq!(git(&fx.path("work"), &["status", "--porcelain"]), before);
    assert_eq!(git(&fx.path("work"), &["branch", "--show-current"]), "feature");

    let v = fx.view();
    assert!(v.exists && v.shared && !v.read_only && v.pending.is_none());
    assert_eq!(v.direction.audience, "PPC agencies evaluating Lyra.");
    assert!(v.draft.is_none(), "no draft once a direction exists");
}

#[test]
fn an_area_writes_its_own_file_and_an_unknown_area_is_refused() {
    let fx = Fixture::new();
    fx.share();
    let site = areas::AreaDef { id: "site".into(), name: "Site".into(), path: "site".into(), ..Default::default() };
    let app = areas::AreaDef { id: "app".into(), name: "App".into(), path: "".into(), ..Default::default() };
    areas::save(&fx.store, WS, &[app, site]).unwrap();
    assert_eq!(fx.press(Some("site"), Edit::Save(mine())).unwrap(), "site");
    assert!(fx.on_origin(".atelier/next-improvement/site.json").is_some());
    let message = git(&fx.path("origin.git"), &["log", "-1", "--format=%s", "main"]);
    assert_eq!(message, "chore(config): next improvement direction — Site");
    assert_eq!(area_key(&fx.store, WS, None, None).unwrap_err(), WHICH_AREA_WORDS, "two areas, none given: ask");
    assert_eq!(area_key(&fx.store, WS, None, Some("site")).unwrap().0, "site", "the workspace's default area");
    assert_eq!(area_key(&fx.store, WS, None, Some("gone")).unwrap_err(), WHICH_AREA_WORDS);
    let err = fx.press(Some("default"), Edit::Save(mine())).unwrap_err();
    assert!(err.contains("no area “default”"), "{err}");
}

#[test]
fn a_single_set_aside_names_itself_and_anything_else_is_the_direction() {
    let one = |line: &str| commit_message("Site", &[line.to_string()], None);
    assert!(one("Not to propose again: “Pop-up” — no pop-ups").starts_with("chore(config): next improvement — set aside “Pop-up” (Site)\n"));
    assert!(one("Can be proposed again: “Pop-up”").starts_with("chore(config): next improvement — “Pop-up” can be proposed again (Site)\n"));
    assert!(one("Direction saved").starts_with("chore(config): next improvement direction — Site\n"));
    // Several presses published together: the direction.
    let both = commit_message("Site", &["Direction saved".into(), "Not to propose again: “Pop-up” — no".into()], None);
    assert!(both.starts_with("chore(config): next improvement direction — Site\n"), "{both}");
    // A long title is cut inside its quotes — the prefix, both quotes and
    // the area stay — and kept whole in the body (1.173.0 re-walk).
    let subject = |m: &str| m.lines().next().unwrap().to_string();
    let walk = "Remove the Pricing page and the home page's link to it";
    assert_eq!(walk.chars().count(), 54);
    let message = one(&format!("Not to propose again: “{walk}” — not now"));
    let s = subject(&message);
    assert!(s.chars().count() <= crate::commit_message::MAX_HEADER, "{s}");
    assert!(s.starts_with("chore(config): next improvement — set aside “Remove the Pricing"), "{s}");
    assert!(s.ends_with("…” (Site)"), "{s}");
    assert!(message.contains(walk), "the whole title in the body: {message}");
    let message = one(&format!("Can be proposed again: “{walk}”"));
    let s = subject(&message);
    assert!(s.chars().count() <= crate::commit_message::MAX_HEADER, "{s}");
    assert!(s.starts_with("chore(config): next improvement — “Remove the"), "{s}");
    assert!(s.ends_with("…” can be proposed again (Site)"), "{s}");
    assert!(message.contains(walk), "{message}");
    let long = "x".repeat(200);
    for line in [format!("Not to propose again: “{long}” — why"), format!("Can be proposed again: “{long}”")] {
        let message = one(&line);
        let s = subject(&message);
        assert_eq!(s.chars().count(), crate::commit_message::MAX_HEADER, "{s}");
        assert!(s.ends_with(" (Site)") && s.contains("x…”"), "{s}");
        assert!(message.contains(&long), "{message}");
    }
    // A short title is whole.
    assert!(one("Not to propose again: “Pop-up” — no").starts_with("chore(config): next improvement — set aside “Pop-up” (Site)\n"));
}

#[test]
fn rejecting_appends_and_publishes_and_removing_takes_it_back() {
    let fx = Fixture::new();
    fx.share();
    fx.press(None, Edit::Save(mine())).unwrap();
    fx.press(None, reject("Exit-intent pop-up", "No pop-ups on the site, ever.")).unwrap();
    fx.press(None, reject("Testimonials carousel", "adds a section")).unwrap();
    let file = || parse_direction(fx.on_origin(".atelier/next-improvement/default.json").unwrap().as_bytes()).unwrap();
    let titles: Vec<String> = file().rejected.iter().map(|r| r.title.clone()).collect();
    assert_eq!(titles, ["Exit-intent pop-up", "Testimonials carousel"]);
    assert_eq!(file().rejected[0].by.as_deref(), Some("matteo"));
    let message = git(&fx.path("origin.git"), &["log", "-1", "--format=%B", "main"]);
    assert!(message.contains("Not to propose again: “Testimonials carousel” — adds a section"), "{message}");
    // 1.173.0 walk: a set-aside has its own subject, not a direction save's.
    let subject = git(&fx.path("origin.git"), &["log", "-1", "--format=%s", "main"]);
    assert_eq!(subject, "chore(config): next improvement — set aside “Testimonials carousel” (default)");
    assert_eq!(file().audience, mine().audience, "the rest of the direction stays");

    fx.press(None, Edit::Unreject { index: 0, title: "Exit-intent pop-up".into(), at: 1 }).unwrap();
    let subject = git(&fx.path("origin.git"), &["log", "-1", "--format=%s", "main"]);
    assert_eq!(subject, "chore(config): next improvement — “Exit-intent pop-up” can be proposed again (default)");
    let titles: Vec<String> = file().rejected.iter().map(|r| r.title.clone()).collect();
    assert_eq!(titles, ["Testimonials carousel"]);
    assert_eq!(fx.press(None, Edit::Unreject { index: 5, title: "x".into(), at: 1 }).unwrap_err(), GONE_WORDS);
    assert!(fx.press(None, reject("x", "  ")).unwrap_err().contains("Say why"));
    // Save never changes the list: only its own presses do.
    fx.press(None, Edit::Save(Direction { rejected: Vec::new(), ..mine() })).unwrap();
    assert_eq!(file().rejected.len(), 1);
}

#[test]
fn a_rejection_from_another_mac_is_kept_alongside_this_ones() {
    let fx = Fixture::new();
    fx.share();
    fx.press(None, Edit::Save(mine())).unwrap();
    // This Mac rejects against the tip it has…
    let channel = fx.channel();
    record(&fx.store, &channel.git, WS, None, None, reject("Mine", "because")).unwrap();
    // …and the other Mac rejected another meanwhile.
    fx.other_writes("default", |d| {
        d.rejected.push(Rejected { title: "Theirs".into(), reason: "no".into(), at: 2, by: None, device: None, extra: Default::default() })
    });
    drain_with(&fx.store, &channel, WS, None);
    let d = parse_direction(fx.on_origin(".atelier/next-improvement/default.json").unwrap().as_bytes()).unwrap();
    let titles: Vec<&str> = d.rejected.iter().map(|r| r.title.as_str()).collect();
    assert_eq!(titles, ["Theirs", "Mine"]);
}

fn shown_of(c: &SettingConflict) -> ShownConflict {
    ShownConflict { theirs: c.theirs.clone(), changed_at: c.changed_at }
}

/// This Mac changed `better` and `avoid`; the other Mac changed `better`.
fn both_changed_better(fx: &Fixture) -> Channel {
    fx.press(None, Edit::Save(mine())).unwrap();
    let channel = fx.channel();
    record(
        &fx.store,
        &channel.git,
        WS,
        None,
        None,
        Edit::Save(Direction { better: "Fast on a phone.".into(), avoid: "Countdowns.".into(), ..mine() }),
    )
    .unwrap();
    fx.other_writes("default", |d| d.better = "Clear pricing.".into());
    let changed = drain_with(&fx.store, &channel, WS, None);
    assert_eq!(changed, ["default"], "the area whose state changed, for ni://direction");
    channel
}

fn on_branch(fx: &Fixture) -> Direction {
    parse_direction(fx.on_origin(".atelier/next-improvement/default.json").unwrap().as_bytes()).unwrap()
}

#[test]
fn a_field_both_macs_changed_asks_through_c3s_question_and_every_other_field_goes() {
    let fx = Fixture::new();
    fx.share();
    let channel = both_changed_better(&fx);
    assert_eq!(on_branch(&fx).better, "Clear pricing.", "theirs stays until the person chooses");
    assert_eq!(on_branch(&fx).avoid, "Countdowns.", "the field only this Mac changed went");

    // C3's question: the definition view and the Inbox read it from here.
    let questions = setting_conflicts_in(&fx.store.workspace_dir(WS));
    assert_eq!(questions.len(), 1);
    let q = &questions[0];
    assert_eq!(q.field, "ni-default-better");
    assert_eq!(q.label, "Next improvement · What “better” means here");
    assert_eq!(q.author.as_deref(), Some("other-mac"));
    assert_eq!(q.device.as_deref(), Some("Mac mini"));
    assert!(!q.same_person && !q.this_computer);
    assert_eq!(q.theirs, Value::from("Clear pricing."));
    assert_eq!(q.difference.theirs, crate::shared_config::describe(&Value::from("Clear pricing.")));
    assert_eq!(q.difference.mine, crate::shared_config::describe(&Value::from("Fast on a phone.")));
    assert_eq!(
        crate::setting_conflict::inbox_id(WS, q),
        format!("setting-conflict:{WS}:ni-default-better:{}", q.changed_at.unwrap())
    );
    assert_eq!(parse_conflict_field(&q.field), Some(("default", "better")));

    let v = fx.view();
    let pending = v.pending.expect("waits for a choice");
    assert_eq!(pending.state, PendingState::Conflict);
    assert_eq!(pending.conflicts, questions);
    assert_eq!(v.direction.better, "Fast on a phone.", "this Mac shows its own while it asks");

    // Save waits for the answer; setting ideas aside doesn't.
    let err = record(&fx.store, &channel.git, WS, None, None, Edit::Save(mine())).unwrap_err();
    assert!(err.contains("choose which answer to keep"), "{err}");
    record(&fx.store, &channel.git, WS, None, None, reject("Carousel", "adds a section")).unwrap();
    drain_with(&fx.store, &channel, WS, None);
    assert_eq!(on_branch(&fx).rejected.len(), 1, "the rejected list went while the question waits");
    let again = setting_conflicts_in(&fx.store.workspace_dir(WS));
    assert_eq!(again, questions, "this Mac's own commit doesn't change who asked or when");

    // An answer to an older question records nothing.
    let stale = ShownConflict { theirs: Value::from("Something older"), changed_at: q.changed_at };
    assert_eq!(resolve(&fx.store, WS, &q.field, true, &stale).unwrap(), None);

    // Use this Mac's: published over exactly the value shown.
    assert_eq!(resolve(&fx.store, WS, &q.field, true, &shown_of(q)).unwrap().as_deref(), Some("default"));
    drain_with(&fx.store, &channel, WS, None);
    assert_eq!(on_branch(&fx).better, "Fast on a phone.");
    assert!(load_queue(&fx.store, WS).areas.is_empty());
    let message = git(&fx.path("origin.git"), &["log", "-1", "--format=%B", "main"]);
    assert!(message.contains("What “better” means here — over other-mac's answer"), "{message}");
}

#[test]
fn keeping_theirs_drops_this_macs_change_to_that_field() {
    let base = mine();
    let theirs = Direction { better: "Clear pricing.".into(), ..mine() };
    let me = Direction { better: "Fast on a phone.".into(), ..mine() };
    let merged = merge(Some(&base), Some(&theirs), &me);
    assert_eq!(merged.conflicts, ["better"]);
    assert_eq!(merged.value.better, "Clear pricing.");
    assert_eq!(merged.shown.better, "Fast on a phone.");
    // Agreeing, or only one side changing, is no question.
    assert!(merge(Some(&base), Some(&me), &me).conflicts.is_empty());
    assert_eq!(merge(Some(&base), Some(&theirs), &base).value.better, "Clear pricing.");
    assert_eq!(merge(Some(&base), Some(&base), &me).value.better, "Fast on a phone.");
    // Created on both sides meanwhile, differently: a question too.
    assert_eq!(merge(None, Some(&theirs), &me).conflicts, ["better"]);

    let fx = Fixture::new();
    fx.share();
    let channel = both_changed_better(&fx);
    let q = setting_conflicts_in(&fx.store.workspace_dir(WS)).remove(0);
    resolve(&fx.store, WS, &q.field, false, &shown_of(&q)).unwrap().unwrap();
    let entry = &load_queue(&fx.store, WS).areas["default"];
    assert_eq!(entry.value.better, "Clear pricing.");
    assert!(entry.conflicts.is_empty());
    assert_eq!(resolve(&fx.store, WS, &q.field, false, &shown_of(&q)).unwrap(), None, "answered: nothing left");
    drain_with(&fx.store, &channel, WS, None);
    assert!(load_queue(&fx.store, WS).areas.is_empty(), "nothing left to publish");
    assert_eq!(on_branch(&fx).better, "Clear pricing.");
    assert_eq!(on_branch(&fx).avoid, "Countdowns.");
}

#[test]
fn removing_an_idea_checks_it_is_still_the_row_shown() {
    let fx = Fixture::new();
    fx.share();
    fx.press(None, reject("A", "one")).unwrap();
    fx.press(None, reject("B", "two")).unwrap();
    // The other Mac removed "A": the list shifted, row 0 is "B" now.
    fx.other_writes("default", |d| d.rejected.retain(|r| r.title != "A"));
    git(&fx.path("work"), &["fetch", "-q", "origin", "main"]);
    let err = fx.press(None, Edit::Unreject { index: 0, title: "A".into(), at: 1 }).unwrap_err();
    assert_eq!(err, GONE_WORDS, "never removes the row that moved into its place");
    assert_eq!(on_branch(&fx).rejected.len(), 1);
    fx.press(None, Edit::Unreject { index: 0, title: "B".into(), at: 1 }).unwrap();
    assert!(on_branch(&fx).rejected.is_empty());
}

// ── Areas ──────────────────────────────────────────────────────────────

#[test]
fn held_areas_refuse_and_the_implicit_area_is_never_used_with_areas() {
    let site = areas::AreaDef { id: "site".into(), name: "Site".into(), ..Default::default() };
    let app = areas::AreaDef { id: "app".into(), name: "App".into(), ..Default::default() };
    let two = [app.clone(), site.clone()];
    assert_eq!(resolve_area(&[], None, None).unwrap().0, "default");
    assert_eq!(resolve_area(&[], Some("default"), Some("site")).unwrap().0, "default");
    assert_eq!(resolve_area(&two, None, None).unwrap_err(), WHICH_AREA_WORDS);
    assert!(resolve_area(&two, Some("default"), None).is_err(), "never the implicit area with areas");
    assert_eq!(resolve_area(&two, None, Some("site")).unwrap(), ("site".into(), "Site".into()));
    assert_eq!(resolve_area(&[site], None, None).unwrap().0, "site", "the only area");

    let fx = Fixture::new();
    fx.share();
    let mut cache = load_cache(&fx.store, WS).unwrap();
    cache.field_problems.insert(
        "areas".into(),
        serde_json::from_value(serde_json::json!({ "message": "Two areas share the folder site." })).unwrap(),
    );
    save_cache(&fx.store, WS, &cache).unwrap();
    assert_eq!(area_key(&fx.store, WS, None, None).unwrap_err(), "Two areas share the folder site.");
    assert_eq!(fx.press(None, Edit::Save(mine())).unwrap_err(), "Two areas share the folder site.");
}

// ── The pull request ───────────────────────────────────────────────────

#[derive(Default)]
struct StubPrs {
    state: std::sync::Mutex<Option<PrState>>,
    created: std::sync::Mutex<Vec<(String, String, String)>>,
    /// A5R-02: `create` answers with this error.
    fail_create: std::sync::Mutex<Option<String>>,
    /// A5R-07: GitHub made the pull request although the answer was lost.
    made_anyway: std::sync::Mutex<bool>,
    /// The heads GitHub has a pull request from.
    made: std::sync::Mutex<Vec<String>>,
    /// M1: the base `for_branch` answers (`None`: the branch asked about).
    found_base: std::sync::Mutex<Option<String>>,
    /// Round 2: every head `for_branch` was asked about.
    looked: std::sync::Mutex<Vec<String>>,
}

impl PullRequests for std::sync::Arc<StubPrs> {
    fn state(&self, _git: &Plumbing, _number: u64) -> Option<PrState> {
        *self.state.lock().unwrap()
    }
    fn create(&self, _git: &Plumbing, base: &str, head: &str, title: &str, _body: &str) -> Result<String, String> {
        self.created.lock().unwrap().push((base.into(), head.into(), title.into()));
        if let Some(e) = self.fail_create.lock().unwrap().clone() {
            if *self.made_anyway.lock().unwrap() {
                self.made.lock().unwrap().push(head.into());
            }
            return Err(e);
        }
        self.made.lock().unwrap().push(head.into());
        Ok("https://github.com/o/lyra/pull/7".into())
    }
    fn for_branch(&self, _git: &Plumbing, head: &str) -> Result<Option<(PrState, String, Option<String>)>, String> {
        self.looked.lock().unwrap().push(head.into());
        let state = self.state.lock().unwrap().unwrap_or(PrState::Open);
        let base = Some(self.found_base.lock().unwrap().clone().unwrap_or_else(|| "main".into()));
        Ok(self.made.lock().unwrap().iter().any(|h| h == head).then(|| (state, "https://github.com/o/lyra/pull/7".to_string(), base)))
    }
}

#[cfg(unix)]
fn refuse_main(fx: &Fixture) {
    use std::os::unix::fs::PermissionsExt;
    let hook = fx.path("origin.git/hooks/pre-receive");
    std::fs::write(
        &hook,
        "#!/bin/sh\nwhile read old new ref; do\n  if [ \"$ref\" = refs/heads/main ]; then echo 'protected branch' >&2; exit 1; fi\ndone\nexit 0\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
#[test]
fn a_refused_push_goes_to_a_pull_request_that_takes_later_presses_and_settles() {
    let fx = Fixture::new();
    fx.share();
    refuse_main(&fx);
    let stub = std::sync::Arc::new(StubPrs::default());
    let channel = Channel {
        git: Plumbing { cwd: fx.path("work") },
        prs: Some(Box::new(stub.clone())),
        device: None,
    };
    let press = |edit: Edit| {
        record(&fx.store, &channel.git, WS, None, None, edit).unwrap();
        drain_with(&fx.store, &channel, WS, None)
    };
    // Opened.
    press(Edit::Save(mine()));
    let created = stub.created.lock().unwrap().clone();
    assert_eq!(created.len(), 1);
    let (base, head, title) = &created[0];
    assert_eq!(base, "main");
    assert!(head.starts_with("atelier/config-next-improvement-default-"), "{head}");
    assert_eq!(title, "Settings: Next improvement direction — this project");
    let entry = load_queue(&fx.store, WS).areas["default"].clone();
    assert_eq!(entry.pull_request.as_ref().unwrap().number, 7);
    assert_eq!(fx.view().pending.unwrap().state, PendingState::PullRequest);
    assert!(fx.on_origin(".atelier/next-improvement/default.json").is_none(), "main untouched");
    let on_pr = |fx: &Fixture| {
        let text = git(&fx.path("origin.git"), &["show", &format!("{head}:.atelier/next-improvement/default.json")]);
        parse_direction(text.as_bytes()).unwrap()
    };
    assert_eq!(on_pr(&fx).audience, mine().audience);
    let first_tip = git(&fx.path("origin.git"), &["rev-parse", head]);

    // Open: a press adds a commit on top of the branch (a fast-forward).
    *stub.state.lock().unwrap() = Some(PrState::Open);
    press(Edit::Save(mine())); // nothing new: the pull request stays as it is
    press(reject("Pop-up", "no pop-ups"));
    assert_eq!(on_pr(&fx).rejected.len(), 1, "the press went to the pull request");
    let parent = git(&fx.path("origin.git"), &["rev-parse", &format!("{head}^")]);
    assert_eq!(parent, first_tip, "on top of its tip, never forced");
    assert_eq!(stub.created.lock().unwrap().len(), 1, "no second pull request");
    // Open with nothing new: still waiting, nothing pushed.
    let tip = git(&fx.path("origin.git"), &["rev-parse", head]);
    drain_with(&fx.store, &channel, WS, None);
    assert_eq!(git(&fx.path("origin.git"), &["rev-parse", head]), tip);

    // Merged: settled — the branch carries it now.
    let other = fx.path("other");
    git(&other, &["fetch", "-q", "origin"]);
    git(&other, &["checkout", "-q", "main"]);
    git(&other, &["merge", "-q", "--ff-only", &format!("origin/{head}")]);
    std::fs::remove_file(fx.path("origin.git/hooks/pre-receive")).unwrap();
    git(&other, &["push", "-q", "origin", "main"]);
    *stub.state.lock().unwrap() = Some(PrState::Merged);
    drain_with(&fx.store, &channel, WS, None);
    assert!(load_queue(&fx.store, WS).areas.is_empty(), "merged: settled");
    assert_eq!(on_branch(&fx).rejected.len(), 1);
}

#[cfg(unix)]
#[test]
fn a_pull_request_closed_without_merging_is_forgotten_and_a_taken_name_is_skipped() {
    let fx = Fixture::new();
    fx.share();
    refuse_main(&fx);
    let stub = std::sync::Arc::new(StubPrs::default());
    let channel = Channel { git: Plumbing { cwd: fx.path("work") }, prs: Some(Box::new(stub.clone())), device: None };
    // Another branch already has the first name this one would pick (and
    // the next second's), at a commit this push can't fast-forward.
    let now = crate::shared_config::now_millis() / 1000;
    let other = fx.path("other");
    std::fs::write(other.join("x.txt"), "moved\n").unwrap();
    git(&other, &["add", "."]);
    git(&other, &["commit", "-q", "-m", "x"]);
    for ts in [now, now + 1] {
        git(&other, &["push", "-q", "origin", &format!("HEAD:refs/heads/atelier/config-next-improvement-default-{ts}")]);
    }
    record(&fx.store, &channel.git, WS, None, None, Edit::Save(mine())).unwrap();
    drain_with(&fx.store, &channel, WS, None);
    let head = stub.created.lock().unwrap()[0].1.clone();
    assert!(head.ends_with("-2"), "a taken name is skipped: {head}");
    *stub.state.lock().unwrap() = Some(PrState::Closed);
    assert_eq!(drain_with(&fx.store, &channel, WS, None), ["default"]);
    assert!(load_queue(&fx.store, WS).areas.is_empty(), "closed: forgotten");
    assert!(fx.on_origin(".atelier/next-improvement/default.json").is_none());
}

/// Round 2, finding 1: a change waiting in a pull request, then a direction
/// kept here while unshared, then shared again: the kept one updates the
/// entry's value only, so it publishes over what the pull request merged.
#[cfg(unix)]
fn queued_in_a_pull_request_then_kept_here(fx: &Fixture) -> (std::sync::Arc<StubPrs>, Channel, String) {
    fx.share();
    refuse_main(fx);
    let stub = std::sync::Arc::new(StubPrs::default());
    let channel = Channel { git: Plumbing { cwd: fx.path("work") }, prs: Some(Box::new(stub.clone())), device: None };
    record(&fx.store, &channel.git, WS, None, None, Edit::Save(mine())).unwrap();
    drain_with(&fx.store, &channel, WS, None);
    let head = stub.created.lock().unwrap()[0].1.clone();
    *stub.state.lock().unwrap() = Some(PrState::Open);
    // Unshared: the next press is kept here.
    save_cache(&fx.store, WS, &DefinitionCache::empty()).unwrap();
    fx.press(None, Edit::Save(Direction { better: "Kept while unshared".into(), ..mine() })).unwrap();
    assert!(local_file(fx, "default").exists());
    (stub, channel, head)
}

#[cfg(unix)]
#[test]
fn a_direction_kept_while_unshared_publishes_over_the_merged_pull_request() {
    let fx = Fixture::new();
    let (stub, channel, head) = queued_in_a_pull_request_then_kept_here(&fx);
    let other = fx.path("other");
    git(&other, &["fetch", "-q", "origin"]);
    git(&other, &["checkout", "-q", "main"]);
    git(&other, &["merge", "-q", "--ff-only", &format!("origin/{head}")]);
    std::fs::remove_file(fx.path("origin.git/hooks/pre-receive")).unwrap();
    git(&other, &["push", "-q", "origin", "main"]);
    *stub.state.lock().unwrap() = Some(PrState::Merged);
    fx.share();
    drain_with(&fx.store, &channel, WS, None);
    assert!(!local_file(&fx, "default").exists());
    assert!(load_queue(&fx.store, WS).areas.is_empty(), "published");
    assert_eq!(on_branch(&fx).better, "Kept while unshared");
    assert!(fx.view().notice.is_none());
}

#[cfg(unix)]
#[test]
fn a_direction_kept_while_unshared_updates_the_open_pull_request() {
    let fx = Fixture::new();
    let (stub, channel, head) = queued_in_a_pull_request_then_kept_here(&fx);
    fx.share();
    drain_with(&fx.store, &channel, WS, None);
    let text = git(&fx.path("origin.git"), &["show", &format!("{head}:.atelier/next-improvement/default.json")]);
    assert_eq!(parse_direction(text.as_bytes()).unwrap().better, "Kept while unshared", "pushed to its branch");
    assert_eq!(stub.created.lock().unwrap().len(), 1, "no second pull request");
    let entry = &load_queue(&fx.store, WS).areas["default"];
    assert!(entry.pull_request.is_some() && !entry.pull_request_behind && !entry.moved);
    assert!(fx.on_origin(".atelier/next-improvement/default.json").is_none(), "main untouched");
    assert!(fx.view().notice.is_none());
}

#[test]
fn a_read_only_mac_publishes_nothing_it_had_queued() {
    let fx = Fixture::new();
    fx.share();
    let channel = fx.channel();
    record(&fx.store, &channel.git, WS, None, None, Edit::Save(mine())).unwrap();
    let mut cache = load_cache(&fx.store, WS).unwrap();
    cache.write_access.can_push = Some(false);
    save_cache(&fx.store, WS, &cache).unwrap();
    assert!(drain_with(&fx.store, &channel, WS, None).is_empty());
    assert_eq!(load_queue(&fx.store, WS).areas.len(), 1, "kept, not tried");
    assert!(fx.on_origin(".atelier/next-improvement/default.json").is_none());
}

#[test]
fn the_pending_words_are_the_apps_and_gits_go_to_details() {
    let mut q = QueuedDirection::new(mine(), None, Vec::new());
    q.last_error = Some("fatal: unable to access 'https://github.com/o/l.git/': Could not resolve host".into());
    q.last_offline = true;
    let p = pending_of(&q, "default", "");
    assert_eq!((p.state, p.message.as_deref()), (PendingState::Offline, Some(OFFLINE_WORDS)));
    assert!(p.technical.unwrap().contains("Could not resolve host"));
    q.last_offline = false;
    q.last_error = Some(format!("main {REFUSED_MARKER} (protected branch) and the GitHub CLI isn't available"));
    let p = pending_of(&q, "default", "");
    assert_eq!(p.message, Some(refused_words()));
    for words in [OFFLINE_WORDS.to_string(), FAILED_WORDS.to_string(), refused_words(), unreadable_words("Site")] {
        for jargon in ["origin", "CLI", "gh ", ".atelier", "push"] {
            assert!(!words.contains(jargon), "{jargon} in {words}");
        }
    }
}
// ── Read-only, unshared, offline ───────────────────────────────────────

#[test]
fn a_read_only_mac_reads_the_direction_and_cannot_change_it() {
    let fx = Fixture::new();
    fx.share();
    fx.press(None, Edit::Save(mine())).unwrap();
    let mut cache = load_cache(&fx.store, WS).unwrap();
    cache.write_access.can_push = Some(false);
    save_cache(&fx.store, WS, &cache).unwrap();
    let v = fx.view();
    assert!(v.read_only && v.exists);
    assert_eq!(v.direction.audience, mine().audience, "it reads");
    assert_eq!(
        v.read_only_reason.as_deref(),
        Some("The direction for this project is set in the repository; ask for write access to change it.")
    );
    for edit in [Edit::Save(mine()), reject("a", "b"), Edit::Unreject { index: 0, title: "a".into(), at: 1 }] {
        assert_eq!(fx.press(None, edit).unwrap_err(), v.read_only_reason.clone().unwrap());
    }
    assert!(load_queue(&fx.store, WS).areas.is_empty(), "nothing queued");
}

#[cfg(unix)]
#[test]
fn a_refused_push_without_a_pull_request_makes_this_mac_read_only() {
    use std::os::unix::fs::PermissionsExt;
    let fx = Fixture::new();
    fx.share();
    let hook = fx.path("origin.git/hooks/pre-receive");
    std::fs::write(&hook, "#!/bin/sh\necho 'protected branch' >&2\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    fx.press(None, Edit::Save(mine())).unwrap();
    let entry = &load_queue(&fx.store, WS).areas["default"];
    assert!(entry.last_error.as_deref().unwrap().contains(REFUSED_MARKER), "{:?}", entry.last_error);
    assert!(load_cache(&fx.store, WS).unwrap().write_access.read_only());
    assert_eq!(fx.view().pending.unwrap().state, PendingState::Failed);
    assert!(fx.on_origin(".atelier/next-improvement/default.json").is_none());
}

/// A5R-02 (owner, 2026-11-23): a pull request that couldn't be opened
/// leaves this computer able to change the shared setup; the change waits
/// for the person's next press, never for a read.
#[cfg(unix)]
#[test]
fn a_failed_pull_request_keeps_this_computer_writable_and_waits_for_a_press() {
    let fx = Fixture::new();
    fx.share();
    refuse_main(&fx);
    let stub = std::sync::Arc::new(StubPrs::default());
    *stub.fail_create.lock().unwrap() = Some("gh pr create timed out".into());
    let channel = Channel { git: Plumbing { cwd: fx.path("work") }, prs: Some(Box::new(stub.clone())), device: None };
    record(&fx.store, &channel.git, WS, None, None, Edit::Save(mine())).unwrap();
    drain_with(&fx.store, &channel, WS, Some("default"));
    assert_eq!(stub.created.lock().unwrap().len(), 1);
    assert!(!load_cache(&fx.store, WS).unwrap().write_access.read_only(), "not read-only");
    let entry = load_queue(&fx.store, WS).areas["default"].clone();
    assert!(entry.pull_request.is_none() && entry.last_error.is_some(), "{entry:?}");
    let pending = fx.view().pending.unwrap();
    // 1.176.4: the line names the branch the try left on GitHub — really there.
    let head = entry.pull_request_branch.clone().unwrap();
    assert_eq!(
        (pending.state, pending.message.as_deref()),
        (PendingState::Failed, Some(format!("{PULL_REQUEST_FAILED_WORDS} The branch {head} is on GitHub.").as_str()))
    );
    assert!(!git(&fx.path("origin.git"), &["rev-parse", "--verify", &format!("refs/heads/{head}")]).is_empty());
    // A read never tries it again.
    drain_with(&fx.store, &channel, WS, None);
    drain_with(&fx.store, &channel, WS, None);
    assert_eq!(stub.created.lock().unwrap().len(), 1, "no retry at a read");
    // The person's press tries once more, and it opens.
    *stub.fail_create.lock().unwrap() = None;
    record(&fx.store, &channel.git, WS, None, None, Edit::Save(mine())).unwrap();
    drain_with(&fx.store, &channel, WS, Some("default"));
    assert_eq!(stub.created.lock().unwrap().len(), 2);
    let entry = load_queue(&fx.store, WS).areas["default"].clone();
    assert_eq!(entry.pull_request.as_ref().unwrap().number, 7);
    assert!(fx.on_origin(".atelier/next-improvement/default.json").is_none(), "main untouched");
}

/// A5R-07: GitHub opened the pull request but its answer was lost. The
/// press finds it from the branch kept for it and adds the change on top:
/// one branch, one pull request, never forced.
#[cfg(unix)]
#[test]
fn a_pull_request_whose_answer_was_lost_is_found_and_never_opened_twice() {
    let fx = Fixture::new();
    fx.share();
    refuse_main(&fx);
    let stub = std::sync::Arc::new(StubPrs::default());
    *stub.fail_create.lock().unwrap() = Some("gh pr create timed out".into());
    *stub.made_anyway.lock().unwrap() = true;
    let channel = Channel { git: Plumbing { cwd: fx.path("work") }, prs: Some(Box::new(stub.clone())), device: None };
    record(&fx.store, &channel.git, WS, None, None, Edit::Save(mine())).unwrap();
    drain_with(&fx.store, &channel, WS, Some("default"));
    let head = stub.created.lock().unwrap()[0].1.clone();
    let entry = load_queue(&fx.store, WS).areas["default"].clone();
    assert_eq!(entry.pull_request_branch.as_deref(), Some(head.as_str()), "kept for the next press");
    let first_tip = git(&fx.path("origin.git"), &["rev-parse", &head]);
    *stub.fail_create.lock().unwrap() = None;
    record(&fx.store, &channel.git, WS, None, None, reject("Pop-up", "no pop-ups")).unwrap();
    drain_with(&fx.store, &channel, WS, Some("default"));
    assert_eq!(stub.created.lock().unwrap().len(), 1, "no second pull request");
    let entry = load_queue(&fx.store, WS).areas["default"].clone();
    assert_eq!(entry.pull_request.as_ref().map(|p| p.branch.as_str()), Some(head.as_str()));
    assert!(entry.pull_request_branch.is_none() && entry.last_error.is_none(), "{entry:?}");
    let text = git(&fx.path("origin.git"), &["show", &format!("{head}:.atelier/next-improvement/default.json")]);
    let on_pr = parse_direction(text.as_bytes()).unwrap();
    assert_eq!((on_pr.audience.as_str(), on_pr.rejected.len()), (mine().audience.as_str(), 1), "the press went to it");
    let parent = git(&fx.path("origin.git"), &["rev-parse", &format!("{head}^")]);
    assert_eq!(parent, first_tip, "on top of its tip, never forced");
    let branches = git(&fx.path("origin.git"), &["branch", "--list", "atelier/*"]);
    assert_eq!(branches.lines().count(), 1, "one branch: {branches}");
}

/// A5R-02: a computer the old wording made read-only for a pull request
/// that couldn't be opened is writable again, with nothing sent to GitHub;
/// its change waits for a press. Any other refusal stands.
#[test]
fn a_computer_made_read_only_by_a_failed_pull_request_is_writable_again() {
    let fx = Fixture::new();
    fx.share();
    let stub = std::sync::Arc::new(StubPrs::default());
    let channel = Channel { git: Plumbing { cwd: fx.path("work") }, prs: Some(Box::new(stub.clone())), device: None };
    let old = format!("main {REFUSED_MARKER}; opening the pull request failed: gh pr create timed out");
    let stuck = |refused: &str| {
        let mut q = QueuedDirection::new(mine(), None, vec!["Direction saved".into()]);
        q.last_error = Some(old.clone());
        q.attempts = 1;
        let mut queue = load_queue(&fx.store, WS);
        queue.areas.insert("default".into(), q);
        save_queue(&fx.store, WS, &queue).unwrap();
        let mut cache = load_cache(&fx.store, WS).unwrap();
        cache.write_access.push_refused = Some(refused.to_string());
        save_cache(&fx.store, WS, &cache).unwrap();
    };
    // Another refusal: still read-only, nothing tried.
    stuck(&format!("main {REFUSED_MARKER}, and the pull request branch too: denied"));
    drain_with(&fx.store, &channel, WS, None);
    assert!(load_cache(&fx.store, WS).unwrap().write_access.read_only());
    // This one: writable, and the change waits for a press.
    stuck(&old);
    let before = git(&fx.path("origin.git"), &["for-each-ref"]);
    drain_with(&fx.store, &channel, WS, None);
    assert!(!load_cache(&fx.store, WS).unwrap().write_access.read_only(), "writable again");
    assert_eq!(git(&fx.path("origin.git"), &["for-each-ref"]), before, "nothing pushed");
    assert!(stub.created.lock().unwrap().is_empty(), "nothing opened");
    assert!(fx.on_origin(".atelier/next-improvement/default.json").is_none());
    let pending = fx.view().pending.unwrap();
    assert_eq!(pending.message.as_deref(), Some(PULL_REQUEST_FAILED_WORDS));
    assert!(!fx.view().read_only);
}

/// A5R-07's persisted field: a queue written before it reads as before, and
/// a queue with it still reads in the shape without it.
#[test]
fn a_queue_without_or_with_the_pull_request_branch_reads() {
    let old = br#"{"schemaVersion":1,"areas":{"default":{"value":{"audience":"x"},"attempts":2,"lastError":"e"}}}"#;
    let queue: DirectionQueue = serde_json::from_slice(old).unwrap();
    let entry = &queue.areas["default"];
    assert_eq!((entry.pull_request_branch.as_deref(), entry.attempts), (None, 2));
    let plain = serde_json::to_value(entry).unwrap();
    assert!(plain.get("pullRequestBranch").is_none(), "not written while unset: {plain}");
    let mut kept = entry.clone();
    kept.pull_request_branch = Some("atelier/config-next-improvement-default-1".into());
    let text = serde_json::to_string(&DirectionQueue { areas: [("default".to_string(), kept.clone())].into(), ..queue.clone() }).unwrap();
    assert!(text.contains("\"pullRequestBranch\":\"atelier/config-next-improvement-default-1\""), "{text}");
    assert_eq!(serde_json::from_str::<DirectionQueue>(&text).unwrap().areas["default"], kept);
    // The shape before the field (1.176.2's), which denies no unknown key.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Before {
        value: Direction,
        #[serde(default)]
        attempts: u32,
        #[serde(default)]
        last_error: Option<String>,
    }
    #[derive(Deserialize)]
    struct BeforeQueue {
        areas: BTreeMap<String, Before>,
    }
    let read: BeforeQueue = serde_json::from_str(&text).unwrap();
    let before = &read.areas["default"];
    assert_eq!((before.value.audience.as_str(), before.attempts, before.last_error.as_deref()), ("x", 2, Some("e")));
}

/// Review round 1: a lost pull request's answer, GitHub having made it.
#[cfg(unix)]
fn lost_answer(fx: &Fixture) -> (std::sync::Arc<StubPrs>, Channel, String) {
    fx.share();
    refuse_main(fx);
    let stub = std::sync::Arc::new(StubPrs::default());
    *stub.fail_create.lock().unwrap() = Some("gh pr create timed out".into());
    *stub.made_anyway.lock().unwrap() = true;
    let channel = Channel { git: Plumbing { cwd: fx.path("work") }, prs: Some(Box::new(stub.clone())), device: None };
    record(&fx.store, &channel.git, WS, None, None, Edit::Save(mine())).unwrap();
    drain_with(&fx.store, &channel, WS, Some("default"));
    *stub.fail_create.lock().unwrap() = None;
    let head = stub.created.lock().unwrap()[0].1.clone();
    (stub, channel, head)
}

/// M1: one found onto another branch is left alone and a new one opens
/// onto the integration branch.
#[cfg(unix)]
#[test]
fn a_lost_pull_request_onto_another_branch_is_left_alone() {
    let fx = Fixture::new();
    let (stub, channel, head) = lost_answer(&fx);
    *stub.found_base.lock().unwrap() = Some("staging".into());
    let tip = git(&fx.path("origin.git"), &["rev-parse", &head]);
    record(&fx.store, &channel.git, WS, None, None, reject("Pop-up", "no pop-ups")).unwrap();
    drain_with(&fx.store, &channel, WS, Some("default"));
    assert_eq!(git(&fx.path("origin.git"), &["rev-parse", &head]), tip, "nothing pushed onto it");
    let created = stub.created.lock().unwrap().clone();
    assert_eq!(created.len(), 2, "a new one");
    assert_eq!(created[1].0, "main");
    assert_ne!(created[1].1, head);
    // Round 2 (SF2): named to the person, never closed.
    let notice = fx.view().notice.unwrap_or_default();
    assert!(notice.contains("#7") && notice.contains("staging"), "{notice}");
}

/// M2: found closed onto this branch: withdrawn, never opened again.
#[cfg(unix)]
#[test]
fn a_lost_pull_request_closed_since_is_withdrawn() {
    let fx = Fixture::new();
    let (stub, channel, _) = lost_answer(&fx);
    *stub.state.lock().unwrap() = Some(PrState::Closed);
    record(&fx.store, &channel.git, WS, None, None, Edit::Save(mine())).unwrap();
    drain_with(&fx.store, &channel, WS, Some("default"));
    assert_eq!(stub.created.lock().unwrap().len(), 1, "no second pull request");
    assert!(load_queue(&fx.store, WS).areas.is_empty(), "withdrawn");
    // Round 2 (SF1): said, not dropped in silence.
    assert_eq!(fx.view().notice.as_deref(), Some(CLOSED_ON_GITHUB_WORDS));
}

/// M3: found merged: its value is the base, so the press's own change of
/// the same field asks nothing.
#[cfg(unix)]
#[test]
fn a_lost_pull_request_merged_since_asks_no_question() {
    let fx = Fixture::new();
    let (stub, channel, head) = lost_answer(&fx);
    let other = fx.path("other");
    git(&other, &["fetch", "-q", "origin"]);
    git(&other, &["checkout", "-q", "main"]);
    git(&other, &["merge", "-q", "--ff-only", &format!("origin/{head}")]);
    std::fs::remove_file(fx.path("origin.git/hooks/pre-receive")).unwrap();
    git(&other, &["push", "-q", "origin", "main"]);
    *stub.state.lock().unwrap() = Some(PrState::Merged);
    record(&fx.store, &channel.git, WS, None, None, Edit::Save(Direction { audience: "Agencies again".into(), ..mine() })).unwrap();
    drain_with(&fx.store, &channel, WS, Some("default"));
    assert!(load_queue(&fx.store, WS).areas.is_empty(), "published: {:?}", load_queue(&fx.store, WS).areas);
    assert_eq!(on_branch(&fx).audience, "Agencies again");
    assert_eq!(stub.created.lock().unwrap().len(), 1);
}

/// S1: the branch can't be kept on disk: no create.
#[cfg(unix)]
#[test]
fn no_pull_request_is_opened_when_its_branch_cannot_be_kept() {
    use std::os::unix::fs::PermissionsExt;
    let fx = Fixture::new();
    fx.share();
    refuse_main(&fx);
    let stub = std::sync::Arc::new(StubPrs::default());
    let channel = Channel { git: Plumbing { cwd: fx.path("work") }, prs: Some(Box::new(stub.clone())), device: None };
    record(&fx.store, &channel.git, WS, None, None, Edit::Save(mine())).unwrap();
    let dir = queue_path(&fx.store, WS).parent().unwrap().to_path_buf();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    drain_with(&fx.store, &channel, WS, Some("default"));
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(stub.created.lock().unwrap().is_empty(), "no create");
}

/// S2: while the create runs (or after a quit in it) nothing says it failed.
#[test]
fn a_create_still_running_is_not_said_to_have_failed() {
    let mut q = QueuedDirection::new(mine(), None, Vec::new());
    q.pull_request_branch = Some("atelier/config-next-improvement-default-1".into());
    assert_ne!(pending_of(&q, "default", "").message.as_deref(), Some(PULL_REQUEST_FAILED_WORDS));
    q.last_error = Some("timed out".into());
    assert!(pending_of(&q, "default", "").message.unwrap().starts_with(PULL_REQUEST_FAILED_WORDS));
}

/// S3: a press that fails before the create leaves the retry with the
/// person: a later read opens nothing, for a recorded branch and for an
/// entry from before the fix.
#[cfg(unix)]
#[test]
fn a_press_that_fails_before_the_create_still_waits_for_a_press() {
    for legacy in [false, true] {
        let fx = Fixture::new();
        fx.share();
        refuse_main(&fx);
        let stub = std::sync::Arc::new(StubPrs::default());
        let channel = Channel { git: Plumbing { cwd: fx.path("work") }, prs: Some(Box::new(stub.clone())), device: None };
        if legacy {
            let mut q = QueuedDirection::new(mine(), None, vec!["Direction saved".into()]);
            q.last_error = Some(format!("main {REFUSED_MARKER}; opening the pull request failed: timed out"));
            let mut queue = load_queue(&fx.store, WS);
            queue.areas.insert("default".into(), q);
            save_queue(&fx.store, WS, &queue).unwrap();
        } else {
            *stub.fail_create.lock().unwrap() = Some("timed out".into());
            record(&fx.store, &channel.git, WS, None, None, Edit::Save(mine())).unwrap();
            drain_with(&fx.store, &channel, WS, Some("default"));
            *stub.fail_create.lock().unwrap() = None;
        }
        let before = stub.created.lock().unwrap().len();
        // The press fails before the create: origin can't be reached.
        let work = fx.path("work");
        git(&work, &["remote", "set-url", "origin", "/nonexistent/origin.git"]);
        record(&fx.store, &channel.git, WS, None, None, reject("Pop-up", "no pop-ups")).unwrap();
        drain_with(&fx.store, &channel, WS, Some("default"));
        git(&work, &["remote", "set-url", "origin", fx.path("origin.git").to_str().unwrap()]);
        drain_with(&fx.store, &channel, WS, None);
        assert_eq!(stub.created.lock().unwrap().len(), before, "legacy {legacy}: no create at a read");
        assert!(waits_for_press(&load_queue(&fx.store, WS).areas["default"]), "legacy {legacy}");
        assert!(!stub.looked.lock().unwrap().iter().any(|h| h.is_empty()), "an empty branch is never a ref");
    }
}

/// S5: without the GitHub CLI, putting the direction back settles it.
#[cfg(unix)]
#[test]
fn without_the_cli_a_direction_put_back_leaves_the_queue() {
    let fx = Fixture::new();
    fx.share();
    fx.other_writes("default", |d| {
        d.audience = "Theirs".into();
        d.approaches = vec!["polish".into()];
    });
    git(&fx.path("work"), &["fetch", "-q", "origin"]);
    let theirs = on_branch(&fx);
    refuse_main(&fx);
    let stub = std::sync::Arc::new(StubPrs::default());
    *stub.fail_create.lock().unwrap() = Some("timed out".into());
    let channel = Channel { git: Plumbing { cwd: fx.path("work") }, prs: Some(Box::new(stub.clone())), device: None };
    record(&fx.store, &channel.git, WS, None, None, Edit::Save(mine())).unwrap();
    drain_with(&fx.store, &channel, WS, Some("default"));
    assert!(waits_for_press(&load_queue(&fx.store, WS).areas["default"]));
    let none = Channel { git: Plumbing { cwd: fx.path("work") }, prs: None, device: None };
    // A read without the CLI leaves it waiting.
    drain_with(&fx.store, &none, WS, None);
    assert!(waits_for_press(&load_queue(&fx.store, WS).areas["default"]), "a read leaves it");
    record(&fx.store, &none.git, WS, None, None, Edit::Save(theirs)).unwrap();
    drain_with(&fx.store, &none, WS, Some("default"));
    assert!(load_queue(&fx.store, WS).areas.is_empty(), "{:?}", load_queue(&fx.store, WS).areas);
}

/// Round 2 (MF1): an entry from 1.176.2, its error then cleared by a
/// direction kept while unshared, still waits for a press at a read.
#[cfg(unix)]
fn legacy_entry(fx: &Fixture, conflict: bool) {
    let mut q = QueuedDirection::new(mine(), None, vec!["Direction saved".into()]);
    q.last_error = Some(format!("main {REFUSED_MARKER}; opening the pull request failed: timed out"));
    if conflict {
        q.conflicts.insert(
            "audience".into(),
            FieldConflict { theirs: Value::String("Theirs".into()), author: None, device: None, same_person: false, this_computer: false, changed_at: Some(5) },
        );
    }
    let mut queue = load_queue(&fx.store, WS);
    queue.areas.insert("default".into(), q);
    save_queue(&fx.store, WS, &queue).unwrap();
}

#[cfg(unix)]
#[test]
fn an_old_entry_moved_over_by_a_direction_kept_here_waits_for_a_press() {
    let fx = Fixture::new();
    fx.share();
    refuse_main(&fx);
    legacy_entry(&fx, false);
    save_cache(&fx.store, WS, &DefinitionCache::empty()).unwrap();
    fx.press(None, Edit::Save(Direction { better: "Kept while unshared".into(), ..mine() })).unwrap();
    fx.share();
    let stub = std::sync::Arc::new(StubPrs::default());
    let channel = Channel { git: Plumbing { cwd: fx.path("work") }, prs: Some(Box::new(stub.clone())), device: None };
    drain_with(&fx.store, &channel, WS, None);
    assert!(stub.created.lock().unwrap().is_empty(), "no create at a read");
    let entry = load_queue(&fx.store, WS).areas["default"].clone();
    assert_eq!(entry.value.better, "Kept while unshared");
    assert!(waits_for_press(&entry) && entry.last_error.is_some(), "{entry:?}");
}

#[cfg(unix)]
#[test]
fn an_old_entry_whose_question_is_answered_offline_waits_for_a_press() {
    let fx = Fixture::new();
    fx.share();
    refuse_main(&fx);
    legacy_entry(&fx, true);
    let stub = std::sync::Arc::new(StubPrs::default());
    let channel = Channel { git: Plumbing { cwd: fx.path("work") }, prs: Some(Box::new(stub.clone())), device: None };
    let work = fx.path("work");
    git(&work, &["remote", "set-url", "origin", "/nonexistent/origin.git"]);
    let shown = ShownConflict { theirs: Value::String("Theirs".into()), changed_at: Some(5) };
    assert!(resolve(&fx.store, WS, &conflict_field("default", "audience"), true, &shown).unwrap().is_some());
    drain_with(&fx.store, &channel, WS, Some("default"));
    git(&work, &["remote", "set-url", "origin", fx.path("origin.git").to_str().unwrap()]);
    drain_with(&fx.store, &channel, WS, None);
    assert!(stub.created.lock().unwrap().is_empty(), "no create at a read");
    assert!(waits_for_press(&load_queue(&fx.store, WS).areas["default"]));
}

/// Round 2 (SF3): waiting with no error (a quit during the create) is said,
/// except while the create runs.
#[test]
fn waiting_for_a_press_without_an_error_is_said_unless_the_create_runs() {
    let mut q = QueuedDirection::new(mine(), None, Vec::new());
    q.pull_request_branch = Some("atelier/config-next-improvement-default-sf3".into());
    let unfinished = format!("{PULL_REQUEST_UNFINISHED_WORDS} The branch atelier/config-next-improvement-default-sf3 is on GitHub.");
    assert_eq!(pending_of(&q, "default", "").message.as_deref(), Some(unfinished.as_str()));
    let creating = Creating::start(&q);
    assert_eq!(pending_of(&q, "default", "").message, None, "while it runs");
    drop(creating);
    assert_eq!(pending_of(&q, "default", "").message.as_deref(), Some(unfinished.as_str()));
    q.pull_request_branch = Some(String::new());
    assert_eq!(pending_of(&q, "default", "").message.as_deref(), Some(PULL_REQUEST_UNFINISHED_WORDS));
    // Round 3: a create a read runs for an entry with an older error.
    q.pull_request_branch = Some("atelier/config-next-improvement-default-sf3b".into());
    q.last_error = Some("offline".into());
    let creating = Creating::start(&q);
    assert_eq!(pending_of(&q, "default", "").message, None, "while it runs, never failed");
    drop(creating);
    assert!(pending_of(&q, "default", "").message.unwrap().starts_with(PULL_REQUEST_FAILED_WORDS));
}

/// Round 3: a notice said once and the repository's direction kept, found
/// by the same press, are both said.
#[test]
fn a_said_notice_and_a_kept_repository_notice_are_both_said() {
    let fx = Fixture::new();
    fx.share();
    let mut queue = load_queue(&fx.store, WS);
    queue.kept_repository.insert("default".into());
    save_queue(&fx.store, WS, &queue).unwrap();
    said_notices().lock().unwrap().insert(notice_key(&fx.store, WS, "default"), CLOSED_ON_GITHUB_WORDS.into());
    assert_eq!(fx.view().notice, Some(format!("{} {CLOSED_ON_GITHUB_WORDS}", kept_repository_words())));
    assert!(notice_seen(&fx.store, WS, "default").unwrap());
    assert_eq!(fx.view().notice, None);
}

/// Round 2 (SF4): an origin that is no GitHub repository has no pull
/// request to look for, and a create it refused says so, not "save it".
#[test]
fn an_origin_off_github_is_looked_up_as_none_and_never_told_to_save_again() {
    let fx = Fixture::new();
    let prs = GhPullRequests(Gh::new("/nonexistent/gh".into()));
    let found = prs.for_branch(&Plumbing { cwd: fx.path("work") }, "atelier/config-next-improvement-default-1");
    assert_eq!(found, Ok(None));
    let mut q = QueuedDirection::new(mine(), None, Vec::new());
    q.pull_request_branch = Some("atelier/config-next-improvement-default-1".into());
    q.last_error = Some(format!(
        "main takes no direct push, and the pull request from x couldn't be opened: {REFUSED_MARKER}, and origin isn't a GitHub repository Plyloft can open a pull request on"
    ));
    assert_eq!(pending_of(&q, "default", "").message, Some(refused_words()));
}

/// Round 3: a press that settles with questions left (nothing pushed)
/// keeps the change waiting for a press; a later read that would now
/// publish it opens nothing and pushes nothing.
#[cfg(unix)]
#[test]
fn a_press_that_leaves_questions_keeps_the_change_waiting_for_a_press() {
    let fx = Fixture::new();
    fx.share();
    let base = |d: &mut Direction| {
        *d = Direction { better: "B0".into(), avoid: "A0".into(), ..mine() };
    };
    fx.other_writes("default", base);
    let work = fx.path("work");
    git(&work, &["fetch", "-q", "origin"]);
    let hook = fx.path("origin.git/hooks/pre-receive");
    refuse_main(&fx);
    let stub = std::sync::Arc::new(StubPrs::default());
    *stub.fail_create.lock().unwrap() = Some("timed out".into());
    let channel = Channel { git: Plumbing { cwd: work.clone() }, prs: Some(Box::new(stub.clone())), device: None };
    record(&fx.store, &channel.git, WS, None, None, Edit::Save(mine())).unwrap();
    drain_with(&fx.store, &channel, WS, Some("default"));
    // Someone else changes both fields; a press then asks both questions.
    std::fs::remove_file(&hook).unwrap();
    fx.other_writes("default", |d| {
        d.better = "TB".into();
        d.avoid = "TA".into();
    });
    refuse_main(&fx);
    record(&fx.store, &channel.git, WS, None, None, Edit::Save(mine())).unwrap();
    drain_with(&fx.store, &channel, WS, Some("default"));
    let entry = load_queue(&fx.store, WS).areas["default"].clone();
    assert_eq!(entry.conflicts.len(), 2, "{entry:?}");
    // The press: keep theirs for `better`. Nothing to push; `avoid` still asks.
    let better = entry.conflicts["better"].clone();
    let shown = ShownConflict { theirs: better.theirs, changed_at: better.changed_at };
    resolve(&fx.store, WS, &conflict_field("default", "better"), false, &shown).unwrap().unwrap();
    drain_with(&fx.store, &channel, WS, Some("default"));
    let entry = load_queue(&fx.store, WS).areas["default"].clone();
    assert_eq!(entry.conflicts.len(), 1, "{entry:?}");
    assert!(waits_for_press(&entry), "still waits: {entry:?}");
    // `avoid` goes back to its base on the branch: a read would now publish.
    std::fs::remove_file(&hook).unwrap();
    fx.other_writes("default", |d| d.avoid = "A0".into());
    refuse_main(&fx);
    let refs = git(&fx.path("origin.git"), &["for-each-ref"]);
    let created = stub.created.lock().unwrap().len();
    drain_with(&fx.store, &channel, WS, None);
    assert_eq!(stub.created.lock().unwrap().len(), created, "no create at a read");
    assert_eq!(git(&fx.path("origin.git"), &["for-each-ref"]), refs, "no push at a read");
}

// ── Kept on this computer (E6) ────────────────────────────────────────

fn local_file(fx: &Fixture, area: &str) -> PathBuf {
    fx.path("config").join("projects").join(WS).join(LOCAL_DIR).join(format!("{area}.json"))
}

fn origin_direction(fx: &Fixture) -> Option<Direction> {
    fx.on_origin(".atelier/next-improvement/default.json").map(|t| parse_direction(t.as_bytes()).unwrap())
}

/// The migration's case: no file is no direction; a file kept here loads
/// with absent fields at their defaults and unknown keys kept.
#[test]
fn a_missing_or_older_local_direction_reads_as_none_or_as_written() {
    let fx = Fixture::new();
    assert_eq!(place(&fx.store, WS), Place::ThisComputer);
    assert!(load_local(&fx.store, WS, "default").is_none(), "absent file = no direction");
    let file = local_file(&fx, "default");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, br#"{"audience":"agencies","tone":"warm"}"#).unwrap();
    let d = load_local(&fx.store, WS, "default").unwrap();
    assert_eq!(d.audience, "agencies");
    assert_eq!(d.schema_version, DIRECTION_SCHEMA_VERSION);
    assert!(d.rejected.is_empty());
    assert_eq!(d.extra.get("tone"), Some(&Value::from("warm")));
    std::fs::write(&file, b"not json").unwrap();
    assert!(load_local(&fx.store, WS, "default").is_none(), "unreadable reads as none");
    assert!(!file.exists(), "and is set aside, never dropped");
    let aside = std::fs::read_dir(file.parent().unwrap()).unwrap().flatten().any(|e| {
        e.file_name().to_string_lossy().starts_with("default.json.unreadable-")
    });
    assert!(aside);
    assert!(local_areas(&fx.store, WS).is_empty(), "a set-aside file is no area");
}

#[test]
fn an_unshared_workspace_keeps_the_direction_on_this_computer_without_git() {
    let fx = Fixture::new();
    let head = git(&fx.path("work"), &["rev-parse", "HEAD"]);
    let v = fx.view();
    assert!(!v.shared && !v.exists && !v.read_only && v.read_only_reason.is_none());
    assert!(v.draft.is_some(), "drafted from the folder's own files");
    fx.press(None, Edit::Save(mine())).unwrap();
    let file = local_file(&fx, "default");
    let saved = parse_direction(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(saved.better, "They start a trial without help.");
    let v = fx.view();
    assert!(!v.shared && v.exists && v.draft.is_none() && v.pending.is_none());
    assert_eq!(v.direction.audience, mine().audience);
    // Reject and take back, on this computer.
    fx.press(None, reject("Pop-up", "Not us")).unwrap();
    fx.press(None, reject("Countdown", "Fake")).unwrap();
    let v = fx.view();
    assert_eq!(v.direction.rejected.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), ["Pop-up", "Countdown"]);
    let gone = &v.direction.rejected[0];
    fx.press(None, Edit::Unreject { index: 0, title: gone.title.clone(), at: gone.at }).unwrap();
    assert_eq!(fx.view().direction.rejected.len(), 1);
    assert_eq!(fx.press(None, Edit::Unreject { index: 3, title: "x".into(), at: 1 }).unwrap_err(), GONE_WORDS);
    // A later Save keeps the list (only its own presses change it).
    fx.press(None, Edit::Save(Direction { audience: "Agencies".into(), ..mine() })).unwrap();
    assert_eq!(fx.view().direction.rejected.len(), 1);
    // Nothing went near the repository.
    assert!(load_queue(&fx.store, WS).areas.is_empty(), "no queue");
    assert!(!fx.path("work/.atelier/next-improvement").exists(), "never in the checkout");
    assert_eq!(git(&fx.path("work"), &["rev-parse", "HEAD"]), head, "no commit");
    assert!(fx.on_origin(".atelier/next-improvement/default.json").is_none());
    assert_eq!(git(&fx.path("work"), &["status", "--porcelain"]), "M README.md", "only the user's own dirty file");
}

#[test]
fn the_round_reads_the_direction_kept_on_this_computer() {
    let fx = Fixture::new();
    assert_eq!(direction_for(&fx.store, &fx.path("work"), WS, None, None).unwrap(), ("default".to_string(), None));
    fx.press(None, Edit::Save(mine())).unwrap();
    let (key, d) = direction_for(&fx.store, &fx.path("work"), WS, None, None).unwrap();
    assert_eq!(key, "default");
    assert_eq!(d.unwrap().better, mine().better);
}

#[test]
fn sharing_moves_the_local_direction_into_the_repository_when_it_has_none() {
    let fx = Fixture::new();
    fx.press(None, Edit::Save(mine())).unwrap();
    fx.press(None, reject("Pop-up", "Not us")).unwrap();
    fx.share();
    let changed = drain(&fx.store, &fx.path("work"), WS);
    assert_eq!(changed, ["default"]);
    assert!(!local_file(&fx, "default").exists(), "the local file is removed");
    assert!(load_queue(&fx.store, WS).areas.is_empty(), "published");
    let on = origin_direction(&fx).unwrap();
    assert_eq!(on.better, mine().better);
    assert_eq!(on.rejected.len(), 1);
    let message = git(&fx.path("origin.git"), &["log", "-1", "--format=%B", "main"]);
    assert!(message.contains(&moved_line()), "{message}");
    let v = fx.view();
    assert!(v.shared && v.exists && v.notice.is_none());
    // Nothing kept here any more: a second drain does nothing.
    assert!(drain(&fx.store, &fx.path("work"), WS).is_empty());
}

#[test]
fn sharing_keeps_the_repositorys_direction_and_says_so_once() {
    let fx = Fixture::new();
    fx.press(None, Edit::Save(mine())).unwrap();
    fx.share();
    fx.other_writes("default", |d| {
        d.audience = "Theirs".into();
        d.better = "Their better".into();
    });
    drain(&fx.store, &fx.path("work"), WS);
    assert!(!local_file(&fx, "default").exists(), "the local one is dropped");
    let on = origin_direction(&fx).unwrap();
    assert_eq!(on.audience, "Theirs", "the repository's wins");
    let v = fx.view();
    assert_eq!(v.direction.audience, "Theirs");
    assert!(v.pending.is_none(), "nothing waits, no question");
    assert_eq!(v.notice.as_deref(), Some(kept_repository_words().as_str()));
    assert!(notice_seen(&fx.store, WS, "default").unwrap());
    assert!(fx.view().notice.is_none(), "said once");
    assert!(!notice_seen(&fx.store, WS, "default").unwrap());
    assert!(!queue_path(&fx.store, WS).exists(), "an empty queue leaves no file");
}

/// Offline at the share: the move waits in the queue, and the branch's
/// direction found at the next publish still wins.
#[test]
fn a_moved_direction_that_waited_offline_yields_to_one_the_branch_got_meanwhile() {
    let fx = Fixture::new();
    fx.press(None, Edit::Save(mine())).unwrap();
    fx.share();
    let work = fx.path("work");
    let url = git(&work, &["remote", "get-url", "origin"]);
    git(&work, &["remote", "set-url", "origin", &fx.path("gone.git").display().to_string()]);
    drain(&fx.store, &work, WS);
    assert!(!local_file(&fx, "default").exists());
    let entry = &load_queue(&fx.store, WS).areas["default"];
    assert!(entry.moved && entry.base.is_none() && entry.last_offline);
    assert_eq!(fx.view().direction.better, mine().better, "shown while it waits");
    git(&work, &["remote", "set-url", "origin", &url]);
    fx.other_writes("default", |d| d.audience = "Theirs".into());
    git(&work, &["fetch", "-q", "origin"]);
    assert_eq!(fx.view().direction.audience, "Theirs", "the branch's, as soon as it is seen");
    drain(&fx.store, &work, WS);
    assert!(load_queue(&fx.store, WS).areas.is_empty());
    assert_eq!(origin_direction(&fx).unwrap().audience, "Theirs");
    assert!(fx.view().notice.is_some());
}

/// Challenger 1: a read-only Mac keeps its local file until it can publish,
/// and meanwhile shows it and proposes in it, saying why; the read-only rule
/// is for the shared direction.
#[test]
fn a_read_only_mac_shows_and_uses_the_direction_it_kept_until_the_branch_has_one() {
    let fx = Fixture::new();
    fx.press(None, Edit::Save(mine())).unwrap();
    fx.share();
    let mut cache = load_cache(&fx.store, WS).unwrap();
    cache.write_access.push_refused = Some("no".into());
    save_cache(&fx.store, WS, &cache).unwrap();
    assert!(drain(&fx.store, &fx.path("work"), WS).is_empty());
    assert!(local_file(&fx, "default").exists(), "kept until this Mac can publish");
    let v = fx.view();
    assert!(v.shared && v.read_only && v.exists);
    assert_eq!(v.direction.better, mine().better);
    assert_eq!(v.kept_here.as_deref(), Some(kept_until_writable_words().as_str()));
    assert!(v.pending.is_none());
    let (_, d) = direction_for(&fx.store, &fx.path("work"), WS, None, None).unwrap();
    assert_eq!(d.unwrap().better, mine().better, "the round reads it");
    assert!(fx.press(None, Edit::Save(mine())).is_err(), "still read-only");
    // The branch gets its own: that one is shown and used.
    fx.other_writes("default", |d| d.better = "Theirs".into());
    git(&fx.path("work"), &["fetch", "-q", "origin"]);
    let v = fx.view();
    assert_eq!(v.direction.better, "Theirs");
    assert!(v.kept_here.is_none());
    assert_eq!(direction_for(&fx.store, &fx.path("work"), WS, None, None).unwrap().1.unwrap().better, "Theirs");
}

/// Challenger 2: a press after the share is this Mac's own change: it merges
/// and asks C3's question rather than being dropped for the branch's.
#[test]
fn a_press_after_the_share_becomes_a_question_not_a_loss() {
    let fx = Fixture::new();
    fx.press(None, Edit::Save(mine())).unwrap();
    fx.share();
    let work = fx.path("work");
    let url = git(&work, &["remote", "get-url", "origin"]);
    git(&work, &["remote", "set-url", "origin", &fx.path("gone.git").display().to_string()]);
    drain(&fx.store, &work, WS);
    fx.press(None, Edit::Save(Direction { better: "Mine, after the share".into(), ..mine() })).unwrap();
    assert!(!load_queue(&fx.store, WS).areas["default"].moved);
    git(&work, &["remote", "set-url", "origin", &url]);
    fx.other_writes("default", |d| d.better = "Theirs".into());
    drain(&fx.store, &work, WS);
    let entry = &load_queue(&fx.store, WS).areas["default"];
    assert!(entry.conflicts.contains_key("better"), "{:?}", entry.conflicts.keys().collect::<Vec<_>>());
    let v = fx.view();
    assert_eq!(v.pending.unwrap().state, PendingState::Conflict);
    assert!(v.notice.is_none(), "not dropped, so nothing to say");
}

/// Challenger 3: the branch already holding the very same direction settles
/// the move, with no "the repository's wins".
#[test]
fn the_same_direction_on_the_branch_settles_the_move_quietly() {
    let fx = Fixture::new();
    fx.press(None, Edit::Save(mine())).unwrap();
    let kept = load_local(&fx.store, WS, "default").unwrap();
    fx.share();
    fx.other_writes("default", |d| *d = kept.clone());
    drain(&fx.store, &fx.path("work"), WS);
    assert!(load_queue(&fx.store, WS).areas.is_empty());
    assert!(fx.view().notice.is_none());
    assert!(!queue_path(&fx.store, WS).exists());
    // And a moved entry against the same value is no rival in a press either.
    let mut queue = DirectionQueue::default();
    let entry = moved_entry(kept.clone());
    assert!(unless_repository_has_one(&mut queue, "default", Some(entry.clone()), Some(&kept)).is_none());
    assert!(queue.kept_repository.is_empty());
    assert!(!yields(&entry, Some(&kept)));
    assert_eq!(effective(Some(&kept), Some(&entry)), Some(kept));
}

/// Challenger 4: a local file moves only to an area the repository has;
/// `default` goes to the only area; anything else stays, and is said.
#[test]
fn a_local_file_moves_to_its_area_or_stays_and_is_said() {
    let fx = Fixture::new();
    fx.press(None, Edit::Save(mine())).unwrap(); // default.json
    fx.share();
    let site = areas::AreaDef { id: "site".into(), name: "Site".into(), ..Default::default() };
    areas::save(&fx.store, WS, &[site.clone()]).unwrap();
    assert_eq!(adopt_local(&fx.store, WS), ["site"], "default goes to the only area");
    assert!(load_queue(&fx.store, WS).areas["site"].moved);
    assert!(!local_file(&fx, "default").exists());

    let fx = Fixture::new();
    fx.press(None, Edit::Save(mine())).unwrap();
    fx.share();
    let app = areas::AreaDef { id: "app".into(), name: "App".into(), ..Default::default() };
    areas::save(&fx.store, WS, &[site, app]).unwrap();
    assert!(adopt_local(&fx.store, WS).is_empty(), "two areas: no orphan published");
    assert!(local_file(&fx, "default").exists(), "left in place");
    assert!(load_queue(&fx.store, WS).areas.is_empty());
    // Said on the area a call naming none goes to, and only there.
    let on = |area: &str, default_area: Option<&str>| {
        view(&fx.store, &fx.channel().git, WS, Some(area), default_area, &Vec::new).unwrap().kept_here
    };
    assert_eq!(on("site", Some("site")).as_deref(), Some(orphan_words("default").as_str()));
    assert!(on("app", Some("site")).is_none());
    assert!(on("site", None).is_none(), "no area a call naming none goes to");
}

/// Challenger 5: shared, unshared, shared again — the direction kept here
/// meanwhile replaces the stale queued change instead of being deleted.
#[test]
fn a_direction_kept_while_unshared_again_replaces_the_stale_queued_change() {
    let fx = Fixture::new();
    fx.share();
    let work = fx.path("work");
    git(&work, &["remote", "set-url", "origin", &fx.path("gone.git").display().to_string()]);
    fx.press(None, Edit::Save(mine())).unwrap(); // queued, offline
    assert!(load_queue(&fx.store, WS).areas.contains_key("default"));
    // Unshared: the press is kept here.
    save_cache(&fx.store, WS, &DefinitionCache::empty()).unwrap();
    fx.press(None, Edit::Save(Direction { better: "Kept while unshared".into(), ..mine() })).unwrap();
    assert!(local_file(&fx, "default").exists());
    // Shared again.
    fx.share();
    assert_eq!(adopt_local(&fx.store, WS), ["default"]);
    let entry = &load_queue(&fx.store, WS).areas["default"];
    assert_eq!(entry.value.better, "Kept while unshared");
    assert!(!entry.moved, "round 2: the entry keeps its own base and moved, only its value changes");
    assert!(entry.lines.contains(&moved_line()));
    assert!(!local_file(&fx, "default").exists());
}

#[test]
fn the_words_name_this_computer() {
    let words = kept_repository_words();
    assert!(words.contains(crate::this_machine!()), "{words}");
    if cfg!(windows) {
        assert!(words.contains("this PC") && moved_line().contains("this PC"));
    } else {
        assert!(words.contains("this Mac") && moved_line().contains("this Mac"));
    }
}

#[test]
fn offline_the_change_waits_and_the_next_drain_publishes_it() {
    let fx = Fixture::new();
    fx.share();
    let work = fx.path("work");
    let url = git(&work, &["remote", "get-url", "origin"]);
    git(&work, &["remote", "set-url", "origin", &fx.path("gone.git").display().to_string()]);
    fx.press(None, Edit::Save(mine())).unwrap();
    let entry = load_queue(&fx.store, WS).areas["default"].clone();
    assert!(entry.last_error.is_some() && entry.attempts == 1);
    assert!(!load_cache(&fx.store, WS).unwrap().write_access.read_only(), "offline is not refused");
    git(&work, &["remote", "set-url", "origin", &url]);
    drain(&fx.store, &work, WS);
    assert!(load_queue(&fx.store, WS).areas.is_empty());
    assert!(fx.on_origin(".atelier/next-improvement/default.json").is_some());
}

#[test]
fn the_view_drafts_from_the_branch_while_there_is_no_direction() {
    let fx = Fixture::new();
    fx.share();
    let v = fx.view();
    assert!(!v.exists && v.direction == Direction::default());
    let draft = v.draft.unwrap();
    // C9 (P14): For whom stays empty; the README's words are a suggestion.
    assert_eq!(draft.direction.audience, "");
    assert_eq!(
        draft.audience.unwrap().text, "Lyra helps PPC agencies audit Google Ads accounts.",
        "the branch's README, not the dirty checkout"
    );
    // NIW-2: the README's address is suggested, not filled in.
    assert_eq!(draft.direction.look_at, "");
    assert_eq!(v.look_at_hint.unwrap().url, "https://www.lyrappc.com");
    assert_eq!(draft.from, [DraftSource::Readme]);
    // NIW-1: the save goes to the cards' branch, said before the press.
    assert_eq!(v.saves_to.as_deref(), Some("main"));
    assert!(load_queue(&fx.store, WS).areas.is_empty(), "a draft is never queued");
    assert!(fx.on_origin(".atelier/next-improvement/default.json").is_none(), "nor written");
}

// ── The draft ──────────────────────────────────────────────────────────

#[test]
fn the_draft_reads_the_projects_own_words() {
    let readme = "---\ntitle: x\n---\n# Lyra\n\n<p align=\"center\"><img src=\"logo.png\"></p>\n\n[![build](https://img.shields.io/b.svg)](https://github.com/o/l)\n\n> **Lyra** is for [PPC agencies](https://lyra.dev/agencies) and in-house marketers. More text here.\n\nSee https://docs.rs/x and the live site: https://www.lyrappc.com.\n";
    let d = draft(&DraftInputs { readme: Some(readme), ..Default::default() });
    assert_eq!(d.direction.audience, "", "C9: For whom is never filled in");
    assert_eq!(
        d.audience.clone().unwrap(),
        AudienceHint { text: "Lyra is for PPC agencies and in-house marketers.".into(), source: DraftSource::Readme }
    );
    assert_eq!(d.direction.look_at, "", "C9: a README's address is only suggested");
    let hint = d.look_at.clone().unwrap();
    assert_eq!((hint.url.as_str(), hint.source), ("https://www.lyrappc.com", LookAtSource::Readme), "the line that names the site wins");
    assert_eq!(d.direction.avoid, DEFAULT_AVOID);
    assert_eq!(d.direction.approaches, ["polish"]);
    assert_eq!(d.direction.proposer, None);

    let package = r#"{"name":"x","description":"A tiny pricing page for bakeries","homepage":"https://github.com/o/x"}"#;
    let d = draft(&DraftInputs { package_json: Some(package), ..Default::default() });
    assert_eq!(d.direction.audience, "");
    assert_eq!(d.audience.unwrap().text, "A tiny pricing page for bakeries");
    assert_eq!(d.direction.look_at, "", "a code host's page is not the product");
    assert_eq!(d.from, [DraftSource::PackageJson]);

    let package = r#"{"homepage":"https://bakery.example.org"}"#;
    let d = draft(&DraftInputs { package_json: Some(package), ..Default::default() });
    assert_eq!((d.direction.audience.as_str(), d.audience), ("", None), "no README, no description: no suggestion");
    assert_eq!(d.direction.look_at, "https://bakery.example.org", "package.json's homepage is filled in");
    assert_eq!(d.direction.better, "", "What “better” means is never drafted");
    assert_eq!(
        d.look_at.unwrap(),
        LookAtHint { url: "https://bakery.example.org".into(), source: LookAtSource::PackageJson }
    );
    assert_eq!(d.from, [DraftSource::PackageJson]);

    // Settings › Areas, then Railway, win over the files.
    let d = draft(&DraftInputs {
        package_json: Some(package),
        railway: Some("https://lyra.up.railway.app"),
        area_look_at: Some("https://www.lyrappc.com"),
        ..Default::default()
    });
    assert_eq!(d.look_at.unwrap().source, LookAtSource::Area);
    let d = draft(&DraftInputs { package_json: Some(package), railway: Some("https://lyra.up.railway.app"), ..Default::default() });
    assert_eq!(d.look_at.unwrap().source, LookAtSource::Railway);

    let empty = draft(&DraftInputs::default());
    assert_eq!((empty.direction.audience.as_str(), empty.look_at, empty.from.len()), ("", None, 0));
}

#[test]
fn the_draft_caps_what_it_reads() {
    let long = format!("# T\n\n{} end.\n", "word ".repeat(DRAFT_INPUT_MAX));
    assert!(capped(&long).len() <= DRAFT_INPUT_MAX);
    let d = draft(&DraftInputs { readme: Some(&long), ..Default::default() });
    let text = d.audience.unwrap().text;
    assert!(text.chars().count() <= 241, "one sentence, cut at a word");
    assert!(text.ends_with('…'));
    // A multi-byte character on the cap is not split.
    let wide = "é".repeat(DRAFT_INPUT_MAX);
    assert!(capped(&wide).len() <= DRAFT_INPUT_MAX && capped(&wide).chars().all(|c| c == 'é'));
    // A file over the cap, on the branch or in the folder, is not read.
    let fx = Fixture::new();
    let other = fx.path("other");
    std::fs::write(other.join("big.md"), "x".repeat(DRAFT_INPUT_MAX + 1)).unwrap();
    std::fs::write(other.join("small.md"), "small").unwrap();
    git(&other, &["add", "."]);
    git(&other, &["commit", "-q", "-m", "big"]);
    let git_other = Plumbing { cwd: other.clone() };
    assert_eq!(read_blob_capped(&git_other, "HEAD", "big.md"), None);
    assert_eq!(read_blob_capped(&git_other, "HEAD", "small.md").as_deref(), Some(&b"small"[..]));
    assert_eq!(read_capped(&other.join("big.md")), None);
    assert_eq!(read_capped(&other.join("small.md")).as_deref(), Some(&b"small"[..]));
    // A package.json over the cap is not read at all.
    let huge = format!("{{\"description\":\"x\",\"pad\":\"{}\"}}", "a".repeat(DRAFT_INPUT_MAX));
    assert_eq!(draft(&DraftInputs { package_json: Some(&huge), ..Default::default() }).audience, None);
}

/// C9 (NIW-2): markdown marks end an address, and an API's is not a page.
#[test]
fn a_readme_address_is_cleaned_and_an_api_is_not_the_product() {
    assert_eq!(
        readme_address("Base URL: `https://api.plyloft.com/v1`\n\nVisit the site: https://plyloft.com\n").as_deref(),
        Some("https://plyloft.com")
    );
    assert_eq!(readme_address("Try **https://lyrappc.com**!").as_deref(), Some("https://lyrappc.com"));
    assert_eq!(readme_address("See _https://lyrappc.com/pricing_ for plans").as_deref(), Some("https://lyrappc.com/pricing"));
    assert_eq!(readme_address("Call `https://lyrappc.com/v2/items` from your code."), None);
    assert_eq!(readme_address("Docs at https://lyrappc.com/docs/v1-launch").as_deref(), Some("https://lyrappc.com/docs/v1-launch"));
    // Round 1: `_` and `*` inside an address stay; a backtick still ends it.
    assert_eq!(
        readme_address("Start at https://lyrappc.com/getting_started today").as_deref(),
        Some("https://lyrappc.com/getting_started")
    );
    assert_eq!(readme_address("See `https://lyrappc.com/pricing` for plans").as_deref(), Some("https://lyrappc.com/pricing"));
    // A version is an API's only first, or after `api`; the query is not the path.
    assert_eq!(readme_address("The site: https://lyrappc.com/v2"), None);
    assert_eq!(readme_address("The site: https://lyrappc.com/api/v1/items"), None);
    assert_eq!(readme_address("The site: https://lyrappc.com/docs/v2").as_deref(), Some("https://lyrappc.com/docs/v2"));
    assert_eq!(readme_address("The site: https://lyrappc.com/blog?tag=v1").as_deref(), Some("https://lyrappc.com/blog?tag=v1"));
    assert_eq!(readme_address("The site: https://lyrappc.com/pricing#v1").as_deref(), Some("https://lyrappc.com/pricing#v1"));
}

/// C9 round 1 (owner): GitHub's answers on whether the branch takes a pull
/// request; anything else is "not known", said as a commit.
#[test]
fn a_branch_that_needs_a_pull_request_is_read_from_github() {
    assert_eq!(rules_require_pull_request(r#"[{"type":"pull_request","parameters":{}}]"#), Some(true));
    assert_eq!(rules_require_pull_request(r#"[{"type":"required_status_checks"}]"#), Some(false));
    assert_eq!(rules_require_pull_request("[]"), Some(false));
    assert_eq!(rules_require_pull_request(r#"{"message":"Not Found"}"#), None);
    assert!(protection_requires_pull_request(r#"{"required_pull_request_reviews":{"required_approving_review_count":1}}"#));
    assert!(!protection_requires_pull_request(r#"{"required_status_checks":{"contexts":["ci"]}}"#));
    assert!(!protection_requires_pull_request("not json"));
    // The pure view never asks GitHub.
    let fx = Fixture::new();
    fx.share();
    assert!(!fx.view().saves_via_pull_request);
}

#[test]
fn railway_gives_the_address_of_the_service_that_builds_the_area() {
    use crate::deploy_map::RailwayService;
    let service = |env: &str, root: Option<&str>, domain: &str, ours: bool| RailwayService {
        environment: env.into(),
        name: "web".into(),
        root_directory: root.map(str::to_string),
        domains: vec![domain.into()],
        this_repository: ours,
        ..Default::default()
    };
    let services = vec![
        service("production", Some("api"), "api.lyra.com", true),
        service("staging", Some("site"), "staging.lyrappc.com", true),
        service("production", Some("site"), "www.lyrappc.com", true),
        service("production", None, "other.com", false),
    ];
    assert_eq!(railway_address(&services, "site").as_deref(), Some("https://www.lyrappc.com"));
    assert_eq!(railway_address(&services, "docs"), None);
    assert_eq!(
        railway_address(&[service("production", None, "https://app.com", true)], "").as_deref(),
        Some("https://app.com")
    );
}

// ── Challenger round 2 minors ──────────────────────────────────────────

#[test]
fn a_waiting_question_is_no_retry_and_no_news_on_each_refresh() {
    let fx = Fixture::new();
    fx.share();
    let channel = both_changed_better(&fx);
    let before = load_queue(&fx.store, WS).areas["default"].clone();
    for _ in 0..2 {
        assert!(drain_with(&fx.store, &channel, WS, None).is_empty(), "nothing changed: no ni://direction");
    }
    assert_eq!(load_queue(&fx.store, WS).areas["default"].attempts, before.attempts, "not counted as a try");
}

#[test]
fn the_same_person_is_known_case_aside_and_a_dashed_key_can_be_answered() {
    let fx = Fixture::new();
    fx.share();
    git(&fx.path("other"), &["config", "user.name", "TEST-OWNER"]);
    let channel = both_changed_better(&fx);
    let q = setting_conflicts_in(&fx.store.workspace_dir(WS)).remove(0);
    assert!(q.same_person, "the same name in another case is this person");

    // A key a newer Plyloft writes, with a dash, in an area with a dash.
    let mut queue = load_queue(&fx.store, WS);
    let mut entry = queue.areas.remove("default").unwrap();
    let conflict = entry.conflicts.remove("better").unwrap();
    entry.conflicts.insert("tone-of-voice".into(), FieldConflict { theirs: Value::from("warm"), ..conflict });
    queue.areas.insert("lyra-site".into(), entry);
    save_queue(&fx.store, WS, &queue).unwrap();
    let q = setting_conflicts_in(&fx.store.workspace_dir(WS)).remove(0);
    assert_eq!(q.field, "ni-lyra-site-tone-of-voice");
    assert_eq!(resolve(&fx.store, WS, &q.field, false, &shown_of(&q)).unwrap().as_deref(), Some("lyra-site"));
    assert!(load_queue(&fx.store, WS).areas["lyra-site"].conflicts.is_empty());
    drop(channel);
}

#[test]
fn approaches_in_a_question_are_named_as_the_editor_names_them() {
    let mut q = QueuedDirection::new(Direction { approaches: vec!["polish".into(), "fix".into()], ..mine() }, None, Vec::new());
    q.conflicts.insert(
        "approaches".into(),
        FieldConflict {
            theirs: serde_json::json!(["simplify"]),
            author: None,
            device: None,
            same_person: false,
            this_computer: false,
            changed_at: Some(1),
        },
    );
    let c = conflicts_of_entry("default", "", &q).remove(0);
    assert_eq!(c.label, "Next improvement · Approach");
    assert_eq!(c.difference.only_mine, ["Polish", "Fix"]);
    assert_eq!(c.difference.only_theirs, ["Simplify"]);
    assert_eq!(c.theirs, serde_json::json!(["simplify"]), "the answer still compares the file's value");
}

// ── The direction written before the areas (1.174.0, C11) ─────────────

fn two_areas() -> Vec<areas::AreaDef> {
    vec![
        areas::AreaDef { id: "app".into(), name: "App".into(), path: "app".into(), ..Default::default() },
        areas::AreaDef { id: "site".into(), name: "Site".into(), path: "site".into(), ..Default::default() },
    ]
}

fn area_view(fx: &Fixture, area: &str) -> DirectionView {
    view(&fx.store, &fx.channel().git, WS, Some(area), None, &Vec::new).unwrap()
}

/// Kept on this computer: a direction and its list written without areas,
/// then two areas saved here. Both take a copy, list included; the file
/// written before the areas goes once both have their own.
#[test]
fn a_direction_written_before_the_areas_is_copied_into_each_with_its_list() {
    let fx = Fixture::new();
    fx.press(None, Edit::Save(mine())).unwrap();
    fx.press(None, reject("Pop-up", "Not us")).unwrap();
    fx.press(None, reject("Countdown", "Fake")).unwrap();
    assert!(before_areas(&fx.store, &fx.channel().git, WS).is_none(), "no areas: it is simply the direction");
    areas::save_local(&fx.store, WS, &two_areas()).unwrap();
    let asked = before_areas(&fx.store, &fx.channel().git, WS).unwrap();
    assert_eq!(asked.areas, ["app", "site"]);
    assert_eq!(asked.direction.audience, mine().audience);
    assert_eq!(asked.direction.rejected.len(), 2);
    let v = area_view(&fx, "site");
    assert!(!v.exists);
    assert_eq!(v.before_areas.as_ref().map(|d| d.better.as_str()), Some(mine().better.as_str()));

    let took = adopt_project(&fx.store, &fx.channel().git, WS, &["app".into(), "site".into()], None).unwrap();
    assert_eq!(took, ["app", "site"]);
    for area in ["app", "site"] {
        let d = load_local(&fx.store, WS, area).unwrap();
        assert_eq!(d.better, mine().better);
        assert_eq!(d.rejected.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), ["Pop-up", "Countdown"]);
        let v = area_view(&fx, area);
        assert!(v.exists && v.before_areas.is_none());
    }
    assert!(!local_file(&fx, "default").exists(), "gone once every area has its own");
    assert!(before_areas(&fx.store, &fx.channel().git, WS).is_none());
    assert!(load_queue(&fx.store, WS).areas.is_empty(), "nothing queued, nothing in git");
    assert!(!fx.path("work/.atelier/next-improvement").exists());
}

/// *Start fresh*, then *Use it for Site* in Site's first time; App writes
/// its own after *Check the direction first…*: the list still comes along,
/// an area with its own is left alone, and the old file goes at the end.
#[test]
fn start_fresh_leaves_it_for_each_area_to_take_or_check_first() {
    let fx = Fixture::new();
    fx.press(None, Edit::Save(mine())).unwrap();
    fx.press(None, reject("Pop-up", "Not us")).unwrap();
    areas::save_local(&fx.store, WS, &two_areas()).unwrap();
    assert_eq!(adopt_project(&fx.store, &fx.channel().git, WS, &["site".into()], None).unwrap(), ["site"]);
    assert!(local_file(&fx, "default").exists(), "App has none of its own yet");
    assert_eq!(before_areas(&fx.store, &fx.channel().git, WS).unwrap().areas, ["app"]);
    assert!(adopt_project(&fx.store, &fx.channel().git, WS, &["site".into()], None).unwrap().is_empty(), "Site keeps its own");
    let checked = Direction { audience: "People who install the app.".into(), rejected: Vec::new(), ..mine() };
    assert_eq!(adopt_project(&fx.store, &fx.channel().git, WS, &["app".into()], Some(checked)).unwrap(), ["app"]);
    let app = load_local(&fx.store, WS, "app").unwrap();
    assert_eq!(app.audience, "People who install the app.");
    assert_eq!(app.rejected.len(), 1, "the list comes from the project's");
    assert!(!local_file(&fx, "default").exists());
    assert_eq!(
        adopt_project(&fx.store, &fx.channel().git, WS, &["app".into()], None).unwrap_err(),
        NO_PROJECT_DIRECTION_WORDS
    );
    assert!(adopt_project(&fx.store, &fx.channel().git, WS, &["docs".into()], None).unwrap_err().contains("no area"));
}

/// Shared: the branch's direction written before the areas is published
/// into each area's own file, list included, as one press; a read-only Mac
/// is refused.
#[test]
fn shared_the_direction_written_before_the_areas_is_published_into_each_area() {
    let fx = Fixture::new();
    fx.share();
    fx.press(None, Edit::Save(mine())).unwrap();
    fx.press(None, reject("Pop-up", "Not us")).unwrap();
    assert!(origin_direction(&fx).is_some());
    areas::save(&fx.store, WS, &two_areas()).unwrap();
    assert_eq!(before_areas(&fx.store, &fx.channel().git, WS).unwrap().areas, ["app", "site"]);
    assert!(area_view(&fx, "app").before_areas.is_some());

    let channel = fx.channel();
    let took = adopt_project(&fx.store, &channel.git, WS, &["app".into(), "site".into()], None).unwrap();
    assert_eq!(took, ["app", "site"]);
    drain_with(&fx.store, &channel, WS, None);
    for area in ["app", "site"] {
        let text = fx.on_origin(&direction_path(area)).expect("published");
        let d = parse_direction(text.as_bytes()).unwrap();
        assert_eq!(d.better, mine().better);
        assert_eq!(d.rejected.len(), 1);
    }
    let log = git(&fx.path("origin.git"), &["log", "-3", "--format=%B", "main"]);
    assert!(log.contains(FROM_BEFORE_AREAS_LINE), "{log}");
    assert!(load_queue(&fx.store, WS).areas.is_empty());
    assert!(before_areas(&fx.store, &fx.channel().git, WS).is_none());
    assert!(fx.on_origin(".atelier/next-improvement/default.json").is_some(), "the branch's file is never removed");

    // A read-only Mac can't copy it.
    let fx = Fixture::new();
    fx.share();
    fx.press(None, Edit::Save(mine())).unwrap();
    areas::save(&fx.store, WS, &two_areas()).unwrap();
    let mut cache = load_cache(&fx.store, WS).unwrap();
    cache.write_access.push_refused = Some("refused".into());
    save_cache(&fx.store, WS, &cache).unwrap();
    assert_eq!(place(&fx.store, WS), Place::Repository(Target { branch: "main".into(), read_only: true }));
    assert_eq!(
        adopt_project(&fx.store, &fx.channel().git, WS, &["app".into()], None).unwrap_err(),
        read_only_words("App")
    );
}

/// C11 (§5c): the file written before the areas is never called "default".
#[test]
fn the_words_for_a_direction_written_before_the_areas_never_say_default() {
    let words = orphan_words(IMPLICIT_AREA_ID);
    assert!(!words.contains("default"), "{words}");
    assert!(words.contains(crate::this_machine!()), "{words}");
    assert!(orphan_words("docs").contains("“docs”"));
    assert!(!NO_PROJECT_DIRECTION_WORDS.contains("default"));
    assert!(!FROM_BEFORE_AREAS_LINE.contains("default"));
}

/// C11 review: one area is the whole project's — nothing to ask or copy.
#[test]
fn with_one_area_nothing_is_asked_about_the_direction_written_before() {
    let fx = Fixture::new();
    fx.press(None, Edit::Save(mine())).unwrap();
    areas::save_local(&fx.store, WS, &two_areas()[..1]).unwrap();
    assert!(before_areas(&fx.store, &fx.channel().git, WS).is_none());
    assert!(area_view(&fx, "app").before_areas.is_none());
    assert_eq!(
        adopt_project(&fx.store, &fx.channel().git, WS, &["app".into()], None).unwrap_err(),
        NO_PROJECT_DIRECTION_WORDS
    );
}

/// C11 review: an area whose branch file can't be read isn't written over,
/// and isn't counted as having its own: the direction kept here stays.
#[test]
fn an_unreadable_area_file_keeps_the_direction_written_before_the_areas() {
    let fx = Fixture::new();
    fx.press(None, Edit::Save(mine())).unwrap(); // kept here as default
    fx.share();
    areas::save(&fx.store, WS, &two_areas()).unwrap();
    let other = fx.path("other");
    git(&other, &["pull", "-q", "origin", "main"]);
    std::fs::create_dir_all(other.join(DIRECTION_DIR)).unwrap();
    std::fs::write(other.join(direction_path("site")), "not json").unwrap();
    git(&other, &["add", "."]);
    git(&other, &["commit", "-q", "-m", "broken"]);
    git(&other, &["push", "-q", "origin", "main"]);
    git(&fx.path("work"), &["fetch", "-q", "origin"]);
    assert_eq!(before_areas(&fx.store, &fx.channel().git, WS).unwrap().areas, ["app"]);
    let took = adopt_project(&fx.store, &fx.channel().git, WS, &["app".into(), "site".into()], None).unwrap();
    assert_eq!(took, ["app"], "never over the unreadable file");
    assert!(local_file(&fx, "default").exists(), "Site has no readable direction of its own");
}

/// C11 round 3: kept on this computer with one area, the area reads the
/// direction written before it (`default`) until it has its own; a press
/// there writes `<area>.json` and the old file goes.
#[test]
fn one_area_kept_here_reads_the_direction_written_before_it() {
    let fx = Fixture::new();
    fx.press(None, Edit::Save(mine())).unwrap();
    fx.press(None, reject("Pop-up", "Not us")).unwrap();
    areas::save_local(&fx.store, WS, &two_areas()[..1]).unwrap();
    let v = area_view(&fx, "app");
    assert!(v.exists && v.direction.better == mine().better && v.direction.rejected.len() == 1);
    let (key, d) = direction_for(&fx.store, &fx.path("work"), WS, Some("app"), None).unwrap();
    assert_eq!(key, "app");
    assert_eq!(d.unwrap().audience, mine().audience);
    fx.press(Some("app"), Edit::Save(Direction { audience: "App users".into(), ..mine() })).unwrap();
    let app = load_local(&fx.store, WS, "app").unwrap();
    assert_eq!(app.audience, "App users");
    assert_eq!(app.rejected.len(), 1, "the list goes with it");
    assert!(!local_file(&fx, "default").exists(), "moved to the area's own file");
    assert_eq!(area_view(&fx, "app").direction.audience, "App users");
}

/// C17: a newer Plyloft's queue is never written over or removed.
#[test]
fn a_newer_plyloft_s_queue_refuses_the_save_and_is_left_as_it_is() {
    let fx = Fixture::new();
    let file = queue_path(&fx.store, WS);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let newer = format!(r#"{{"schemaVersion":{},"areas":{{}}}}"#, QUEUE_SCHEMA_VERSION + 1);
    std::fs::write(&file, &newer).unwrap();
    let queue = load_queue(&fx.store, WS);
    for attempt in [queue.clone(), DirectionQueue::default()] {
        let error = save_queue(&fx.store, WS, &attempt).expect_err("refused");
        assert!(error.contains("saved by a newer Plyloft"), "{error}");
    }
    assert_eq!(std::fs::read_to_string(&file).unwrap(), newer, "neither written over nor removed");
}

/// C17 (round 1): a newer Plyloft's queue whose fields changed shape (it
/// doesn't parse here) reads as empty, is never set aside, and no save
/// writes over it or removes it.
#[test]
fn a_newer_queue_that_does_not_parse_here_is_left_byte_identical() {
    let fx = Fixture::new();
    let file = queue_path(&fx.store, WS);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let newer = format!(r#"{{"schemaVersion":{},"areas":[["default",{{"value":"now a list"}}]]}}"#, QUEUE_SCHEMA_VERSION + 1);
    std::fs::write(&file, &newer).unwrap();
    assert!(load_queue(&fx.store, WS).areas.is_empty());
    for attempt in [load_queue(&fx.store, WS), DirectionQueue::default()] {
        let error = save_queue(&fx.store, WS, &attempt).expect_err("refused");
        assert!(error.contains("saved by a newer Plyloft"), "{error}");
    }
    assert_eq!(std::fs::read_to_string(&file).unwrap(), newer, "byte-identical");
    assert_eq!(std::fs::read_dir(file.parent().unwrap()).unwrap().count(), 1, "nothing set aside");
}

/// C17 (round 1): `save_local` as `save_queue`: a newer Plyloft's direction
/// is left as it is (also on read), an unreadable one is set aside first.
#[test]
fn save_local_refuses_a_newer_direction_and_sets_an_unreadable_one_aside() {
    let fx = Fixture::new();
    let file = local_file(&fx, "default");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let newer = format!(r#"{{"schemaVersion":{},"audience":["changed"]}}"#, DIRECTION_SCHEMA_VERSION + 1);
    std::fs::write(&file, &newer).unwrap();
    assert!(load_local(&fx.store, WS, "default").is_none());
    let error = save_local(&fx.store, WS, "default", &mine()).expect_err("refused");
    assert!(error.contains("saved by a newer Plyloft"), "{error}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), newer, "byte-identical");
    std::fs::write(&file, b"not json").unwrap();
    save_local(&fx.store, WS, "default", &mine()).unwrap();
    assert_eq!(load_local(&fx.store, WS, "default").unwrap().audience, mine().audience);
    let aside = std::fs::read_dir(file.parent().unwrap()).unwrap().flatten().any(|e| {
        e.file_name().to_string_lossy().starts_with("default.json.unreadable-")
    });
    assert!(aside, "the unreadable one kept beside it");
}

/// C17: the old `default` file an area still reads goes only when it was
/// read: a newer Plyloft's is refused and left byte-identical, with no
/// `<area>.json` made from nothing.
#[test]
fn a_newer_default_direction_is_refused_and_never_removed() {
    let fx = Fixture::new();
    fx.press(None, Edit::Save(mine())).unwrap();
    areas::save_local(&fx.store, WS, &two_areas()[..1]).unwrap();
    let old = local_file(&fx, "default");
    let newer = format!(r#"{{"schemaVersion":{},"audience":["changed"]}}"#, DIRECTION_SCHEMA_VERSION + 1);
    std::fs::write(&old, &newer).unwrap();
    let error = fx.press(Some("app"), Edit::Save(Direction { audience: "App users".into(), ..mine() })).unwrap_err();
    assert!(error.contains("saved by a newer Plyloft"), "{error}");
    assert_eq!(std::fs::read_to_string(&old).unwrap(), newer, "byte-identical");
    assert!(!local_file(&fx, "app").exists(), "nothing written for the area");
}

/// 1.176.4 (owner 2026-11-23): no branch is deleted; the line said while a
/// direction waits for a press names the branch the failed try left on
/// GitHub — only a recorded one, never 1.176.2's empty marker.
#[test]
fn a_direction_waiting_for_a_press_names_the_branch_left_on_github() {
    let branch = "atelier/config-next-improvement-default-20261123";
    let mut q = QueuedDirection::new(mine(), None, Vec::new());
    q.pull_request_branch = Some(branch.into());
    q.last_error = Some("gh pr create timed out".into());
    let failed = pending_of(&q, "default", "");
    assert_eq!(failed.state, PendingState::Failed);
    assert_eq!(
        failed.message.as_deref(),
        Some(format!("{PULL_REQUEST_FAILED_WORDS} The branch {branch} is on GitHub.").as_str())
    );
    // A quit during the create: the same line.
    q.last_error = None;
    assert_eq!(
        pending_of(&q, "default", "").message.as_deref(),
        Some(format!("{PULL_REQUEST_UNFINISHED_WORDS} The branch {branch} is on GitHub.").as_str())
    );
    // While the create runs: nothing, as before.
    let creating = Creating::start(&q);
    assert_eq!(pending_of(&q, "default", "").message, None);
    drop(creating);
    // 1.176.2's marker names no branch.
    q.pull_request_branch = Some(String::new());
    q.last_error = Some("offline".into());
    assert_eq!(pending_of(&q, "default", "").message.as_deref(), Some(PULL_REQUEST_FAILED_WORDS));
    // A change that doesn't wait for a press names none either.
    q.pull_request_branch = None;
    assert!(!pending_of(&q, "default", "").message.unwrap_or_default().contains("atelier/"));
}
