use super::*;
use std::path::PathBuf;

// Every secret-shaped string below is put together at run time: none is in
// this file as written, so nothing here trips a secret scanner (GitHub's
// push protection would refuse the commit), and none is a real secret.

fn body(len: usize) -> String {
    "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7c".chars().cycle().take(len).collect()
}

fn joined(parts: &[&str]) -> String {
    parts.concat()
}

/// (what it is, the token)
fn tokens() -> Vec<(&'static str, String)> {
    let b = body;
    vec![
        ("GitHub personal", joined(&["gh", "p_", &b(36)])),
        ("GitHub OAuth", joined(&["gh", "o_", &b(36)])),
        ("GitHub user-to-server", joined(&["gh", "u_", &b(36)])),
        ("GitHub server-to-server", joined(&["gh", "s_", &b(36)])),
        ("GitHub refresh", joined(&["gh", "r_", &b(36)])),
        ("GitHub fine-grained", joined(&["github", "_pat_", &b(22), "_", &b(59)])),
        ("OpenAI", joined(&["s", "k-", &b(48)])),
        ("OpenAI project", joined(&["s", "k-proj-", &b(40), "-", &b(20)])),
        ("Anthropic", joined(&["s", "k-ant-", "api03-", &b(40), "_", &b(40)])),
        ("Stripe live", joined(&["s", "k_live_", &b(24)])),
        ("Stripe test", joined(&["s", "k_test_", &b(24)])),
        ("Stripe restricted", joined(&["r", "k_live_", &b(24)])),
        ("Stripe webhook", joined(&["wh", "sec_", &b(32)])),
        ("AWS access key id", joined(&["AK", "IA", "IOSFODNN7EXAMPLE"])),
        ("AWS temporary key id", joined(&["AS", "IA", "IOSFODNN7EXAMPLE"])),
        ("Slack bot", joined(&["xo", "xb-", "1234567890-", "1234567890123-", &b(24)])),
        ("Slack user", joined(&["xo", "xp-", "1234567890-", &b(24)])),
        ("Google API key", joined(&["AI", "za", &b(35)])),
        ("JSON Web Token", joined(&["ey", "J", &b(33), ".", "ey", "J", &b(60), ".", &b(43)])),
    ]
}

fn published(text: &str) -> Published {
    for_github(text, &Places::default())
}

/// The filter with only the reviewed project known.
fn in_project(text: &str, project: &[&Path]) -> Published {
    for_github(text, &Places { project, ..Default::default() })
}

/// Each token shape is removed, wherever it stands: alone, in a sentence,
/// in code, in a quoted diff line. What is around it stays.
#[test]
fn each_token_shape_is_removed() {
    for (what, token) in tokens() {
        for (before, after) in [
            ("", ""),
            ("The config has ", " in it."),
            ("`", "`"),
            ("+  token: \"", "\","),
            ("Authorization: token ", "\n"),
            ("(", ")"),
            ("x = ", ";"),
        ] {
            let text = format!("{before}{token}{after}");
            let out = published(&text);
            assert_eq!(out.text, format!("{before}{REMOVED}{after}"), "{what}: {text:?}");
            assert_eq!(out.removed, 1, "{what}");
        }
        assert!(!published(&format!("see {token}")).text.contains(&token[4..]), "{what}: nothing of it is left");
    }
}

/// `Bearer <long token>`: the token goes, the word stays.
#[test]
fn the_token_after_bearer_is_removed() {
    let token = joined(&[&body(20), ".", &body(12), "-", &body(8)]);
    for word in ["Bearer", "bearer", "BEARER"] {
        let out = published(&format!("curl -H 'Authorization: {word} {token}' https://api.example.com"));
        assert_eq!(out.text, format!("curl -H 'Authorization: {word} {REMOVED}' https://api.example.com"));
        assert_eq!(out.removed, 1);
    }
    // Words, placeholders and references after it are not a token.
    for kept in [
        "Use a Bearer token in the Authorization header.",
        "Authorization: Bearer <token>",
        "headers: { Authorization: `Bearer ${token}` }",
        "Authorization: Bearer $GITHUB_TOKEN",
        "The Bearer authentication-scheme-is-required-here by the gateway.",
    ] {
        assert_eq!(published(kept), Published { text: kept.to_string(), removed: 0 }, "{kept}");
    }
}

/// A private key block is removed whole, header to footer; one that isn't
/// closed is removed to the end of the text. Whatever is before it stays,
/// and after a closed one too.
#[test]
fn a_private_key_block_is_removed_whole() {
    for label in ["RSA PRIVATE KEY", "PRIVATE KEY", "OPENSSH PRIVATE KEY", "EC PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK"] {
        let begin = joined(&["-----BEGIN ", label, "-----"]);
        let end = joined(&["-----END ", label, "-----"]);
        let key = format!("{begin}\n{}\n{}\n{}==\n{end}", body(64), body(64), body(40));
        let closed = published(&format!("The fixture holds a key:\n\n{key}\n\nIt should not be committed."));
        assert_eq!(closed.text, format!("The fixture holds a key:\n\n{REMOVED}\n\nIt should not be committed."), "{label}");
        assert_eq!(closed.removed, 1, "{label}");

        let open = published(&format!("Quoted from deploy/key.pem:\n{begin}\n{}\n{}", body(64), body(64)));
        assert_eq!(open.text, format!("Quoted from deploy/key.pem:\n{REMOVED}"), "{label}: to the end when not closed");
        assert_eq!(open.removed, 1);
    }
    // Two blocks are two things; a public key and a certificate are not secrets.
    let block = |label: &str| format!("-----BEGIN {label}-----\n{}\n-----END {label}-----", body(64));
    let two = published(&format!("{}\nand\n{}", block(&joined(&["RSA PRIVATE", " KEY"])), block(&joined(&["EC PRIVATE", " KEY"]))));
    assert_eq!((two.text.as_str(), two.removed), (format!("{REMOVED}\nand\n{REMOVED}").as_str(), 2));
    for public in [block("PUBLIC KEY"), block("CERTIFICATE"), "Never commit a -----BEGIN line of a key.".to_string()] {
        assert_eq!(published(&public), Published { text: public.clone(), removed: 0 }, "{public}");
    }
}

/// `NAME=value`: the value goes when the name is an environment variable's
/// that names a secret and the value is long and token-like.
#[test]
fn the_value_of_a_secret_s_assignment_is_removed() {
    let value = body(32);
    for (line, expected) in [
        (format!("API_KEY={value}"), format!("API_KEY={REMOVED}")),
        (format!("export STRIPE_SECRET_KEY={value}"), format!("export STRIPE_SECRET_KEY={REMOVED}")),
        (format!("DB_PASSWORD=\"{value}\""), format!("DB_PASSWORD=\"{REMOVED}\"")),
        (format!("NPM_TOKEN='{value}'"), format!("NPM_TOKEN='{REMOVED}'")),
        (format!("+AWS_SECRET_ACCESS_KEY={value}"), format!("+AWS_SECRET_ACCESS_KEY={REMOVED}")),
        (format!("The `.env` has `SESSION_SECRET={value}` in it."), format!("The `.env` has `SESSION_SECRET={REMOVED}` in it.")),
        (format!("PASSWORD={}{}", "correcthorse", "batterystaple"), format!("PASSWORD={REMOVED}")),
        (format!("  GITHUB_TOKEN={value}  # from the CI"), format!("  GITHUB_TOKEN={REMOVED}  # from the CI")),
    ] {
        let out = published(&line);
        assert_eq!(out.text, expected, "{line}");
        assert_eq!(out.removed, 1, "{line}");
    }
    // A value that is itself a token shape is one thing removed, not two.
    let gh = joined(&["gh", "p_", &body(36)]);
    assert_eq!(published(&format!("GITHUB_TOKEN={gh}")), Published { text: format!("GITHUB_TOKEN={REMOVED}"), removed: 1 });
}

/// Ordinary code and prose a review quotes survive, byte for byte: the
/// names of environment variables, references to them, placeholders, short
/// values, names that aren't a secret's, ids and hashes, and the decoy line
/// of the proof (its name is not a secret's name: the rule goes by the name).
#[test]
fn ordinary_code_quoting_secrets_names_survives() {
    let sha = "9fc68e7c0d2b4a6e8f1a3c5d7e9b0a2c4d6e8f10";
    let long = body(40);
    let kept = [
        "const API_KEY = process.env.API_KEY",
        "const API_KEY = process.env.API_KEY;\nif (!API_KEY) throw new Error(\"API_KEY is not set\");",
        "API_KEY=process.env.API_KEY",
        "API_KEY=$API_KEY",
        "export GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}",
        "PASSWORD=${DB_PASSWORD}",
        "DB_PASSWORD=<your password>",
        "API_KEY=your-api-key-here",
        "SECRET_KEY=changeme",
        "API_KEY=",
        "let token = os.environ[\"GITHUB_TOKEN\"]",
        "token := os.Getenv(\"STRIPE_SECRET_KEY\")",
        "`STRIPE_SECRET_KEY` must be set before `npm run build`.",
        "The review found that API_KEY == undefined is never handled.",
        "PLYLOFT_TEST_DECOY=not-a-secret-1175",
        "NODE_ENV=production",
        "DATABASE_URL=postgres://localhost:5432/app",
        "CACHE_KEY=users:list:page:1",
        "PRIMARY_KEY=id",
        "config.API_TOKEN=loadTokenFromKeychain()",
        "scikit: use sk-learn-style-estimators-and-pipelines here",
        // Round 2: a path after the word; a path or a name as a key's value;
        // a name about a secret, not the secret; a class name that starts `sk-`.
        "Bearer auth/middleware/v2/refresh_handler.rs is where the token is read",
        "See Bearer src/Auth/Middleware/V2/RefreshHandler2.ts for the header",
        "CACHE_KEY=users/profile/v2/list",
        "SORT_KEY=created_at_desc_v2",
        "PARTITION_KEY=tenant-id.created-at",
        "PASSWORD_RESET_PATH=/auth/password/reset/v2",
        "TOKEN_URL=https-oauth-example-com-token-v2",
        "SECRET_NAME=prod-stripe-webhook-secret-01",
        "TOKEN_TTL=3600",
        "<div class=\"sk-spinner-three-bounce-wrapper-Large2\">",
        "The id AKIA is a prefix; AKIAIOSFODNN7 alone is too short.",
        "MAKIAIOSFODNN7EXAMPLEX is a word, not a key id",
        "ghp_ and github_pat_ are GitHub's prefixes; ghp_short is not a token.",
        "sk_live_ keys must never be committed; rk_live_x is too short.",
        "xoxb- tokens are Slack's.",
        "eyJhbGciOi is how a JWT's header starts.",
        "AIza is how Google's keys start.",
        "Fixes #12 in src/lib/platform.ts:131 — see https://github.com/o/r/pull/7#discussion_r1",
        "```ts\nexport function token(): string {\n  return readKeychain(\"plyloft\");\n}\n```",
        "Il titolo è «già fatto»: niente da togliere — 日本語も大丈夫。",
        "",
    ];
    for text in kept {
        assert_eq!(published(text), Published { text: text.to_string(), removed: 0 }, "{text}");
    }
    for text in [format!("commit {sha}"), format!("sha256:{long}"), format!("id = \"{long}\""), format!("uuid 3f2504e0-4f89-41d3-9a0c-0305e82c3301")] {
        assert_eq!(published(&text), Published { text: text.clone(), removed: 0 }, "{text}");
    }
}

/// A whole review with nothing to remove comes back byte for byte.
#[test]
fn a_text_with_nothing_to_remove_is_byte_identical() {
    let review = "## Verdict\nCHANGES_REQUESTED\n\n## Findings\n\n1. **P2 — `src/store/kanbanStore.ts:1092`**: `loadFromDisk` asks for the notice only on the first load.\n   ```ts\n   if (!existing?.loaded) void sayBoardUnreadable(workspaceId);\n   ```\n   Fix: ask at launch too.\n\n2. **P3 — `src-tauri/src/kanban.rs`**: `const KANBAN_SUBDIR: &str = \"kanban/workspaces\";` keeps the `/` on Windows.\n\n_Plyloft: 3 files, reviewed in 2 passes._\n";
    let out = published(review);
    assert_eq!(out.text.as_bytes(), review.as_bytes());
    assert_eq!(out.removed, 0);
    assert_eq!(removed_line(out.removed, Posted::Notes), None);
}

/// The reviewed project and the homes: a path under the card's copy is
/// shown relative to it; any other path under a home folder keeps its tail
/// behind `~`. Nothing is counted as removed.
#[test]
fn a_home_path_is_made_anonymous_and_stays_readable() {
    let copy = PathBuf::from("/Users/matteo/code/lyra/.plyloft-worktrees/card-abc");
    let project: [&Path; 1] = [copy.as_path()];
    for (text, expected) in [
        ("`/Users/matteo/code/lyra/.plyloft-worktrees/card-abc/src/app.js:12` reads the file", "`src/app.js:12` reads the file"),
        ("in /Users/matteo/code/lyra/.plyloft-worktrees/card-abc/src/lib/x.ts and", "in src/lib/x.ts and"),
        ("cwd: /Users/matteo/code/lyra/.plyloft-worktrees/card-abc", "cwd: ."),
        ("cd /Users/matteo/code/lyra/.plyloft-worktrees/card-abc/ && npm test", "cd . && npm test"),
        // Another copy with a longer name is not this one: it keeps its tail behind `~`.
        ("/Users/matteo/code/lyra/.plyloft-worktrees/card-abc-2/a.rs", "~/code/lyra/.plyloft-worktrees/card-abc-2/a.rs"),
        ("It also read /Users/matteo/.ssh/config and /Users/matteo/Library/Application Support/x.json.", "It also read ~/.ssh/config and ~/Library/Application Support/x.json."),
        ("HOME=/Users/matteo", "HOME=~"),
        ("(/home/marta/projects/site/index.html)", "(~/projects/site/index.html)"),
        ("C:\\Users\\Matteo\\code\\lyra\\src\\app.js", "~\\code\\lyra\\src\\app.js"),
        ("\"C:\\\\Users\\\\Matteo\\\\AppData\\\\Roaming\\\\x.json\"", "\"~\\\\AppData\\\\Roaming\\\\x.json\""),
        ("D:/Users/matteo/code/x", "~/code/x"),
        ("file:///Users/matteo/code/x.html", "file://~/code/x.html"),
    ] {
        let out = in_project(text, &project);
        assert_eq!(out.text, expected, "{text}");
        assert_eq!(out.removed, 0, "a path is rewritten, not removed: {text}");
    }
    // Not a home folder: a URL's path, a shared folder, a longer path's tail,
    // a word, a route.
    for kept in [
        "https://github.com/Users/matteo/settings",
        "https://example.com/home/page",
        "/Users/Shared/tools/bin",
        "C:\\Users\\Public\\Documents",
        "src/Users/matteo.ts",
        "The /Users/ folder holds every home.",
        "/usr/local/bin and /home/ are not names",
        "GET /users/42/profile and /api/users/42",
    ] {
        assert_eq!(in_project(kept, &project).text, kept, "{kept}");
    }
    // On Windows the copy's own path, with either separator and in any case.
    let copy = PathBuf::from("C:\\Users\\Matteo\\code\\lyra\\.plyloft-worktrees\\card-abc");
    let project: [&Path; 1] = [copy.as_path()];
    for (text, expected) in [
        ("see C:\\Users\\Matteo\\code\\lyra\\.plyloft-worktrees\\card-abc\\src\\app.js", "see src\\app.js"),
        ("see C:/Users/Matteo/code/lyra/.plyloft-worktrees/card-abc/src/app.js", "see src/app.js"),
        ("see c:\\users\\matteo\\code\\lyra\\.plyloft-worktrees\\card-abc\\src\\app.js", "see src\\app.js"),
        ("see \\\\?\\C:\\Users\\Matteo\\code\\lyra\\.plyloft-worktrees\\card-abc\\src\\app.js", "see src\\app.js"),
        ("see /c/Users/Matteo/code/lyra/.plyloft-worktrees/card-abc/src/app.js", "see src/app.js"),
        ("see /mnt/c/Users/Matteo/code/lyra/.plyloft-worktrees/card-abc/src/app.js", "see src/app.js"),
    ] {
        assert_eq!(in_project(text, &project).text, expected, "{text}");
    }
}

/// Round 2 (the Reviewer's probes): the forms that leaked the name. The
/// member's own home is replaced as an exact prefix, so a name with a space
/// goes whole, in every spelling a tool prints the folder; and the generic
/// rule knows the same spellings for anybody else's home.
#[test]
fn every_spelling_of_a_home_folder_loses_the_name() {
    // The member's own home: exact, whatever is in the name.
    let home = PathBuf::from("C:\\Users\\Mario Rossi");
    let places = Places { home: Some(home.as_path()), ..Default::default() };
    for (text, expected) in [
        ("C:\\Users\\Mario Rossi\\proj\\a.rs", "~\\proj\\a.rs"),
        ("c:\\users\\mario rossi\\proj\\a.rs", "~\\proj\\a.rs"),
        ("C:/Users/Mario Rossi/proj/a.rs", "~/proj/a.rs"),
        ("\"C:\\\\Users\\\\Mario Rossi\\\\proj\\\\a.rs\"", "\"~\\\\proj\\\\a.rs\""),
        ("\\\\?\\C:\\Users\\Mario Rossi\\proj\\a.rs", "~\\proj\\a.rs"),
        ("/c/Users/Mario Rossi/proj/a.rs", "~/proj/a.rs"),
        ("/mnt/c/Users/Mario Rossi/proj/a.rs", "~/proj/a.rs"),
        ("cwd is C:\\Users\\Mario Rossi and nothing else", "cwd is ~ and nothing else"),
        // Somebody else's folder that starts the same is not the member's.
        ("C:\\Users\\Mario Rossini\\x", "~\\x"),
    ] {
        let out = for_github(text, &places);
        assert_eq!(out.text, expected, "{text}");
        assert!(!out.text.contains("Mario") && !out.text.contains("Rossi") && !out.text.to_lowercase().contains("mario"), "{text} → {}", out.text);
        assert_eq!(out.removed, 0);
    }
    let home = PathBuf::from("/Users/José María");
    let places = Places { home: Some(home.as_path()), ..Default::default() };
    assert_eq!(for_github("/Users/José María/código/x.rs and /Users/José María", &places).text, "~/código/x.rs and ~");

    // Anybody's home, with nothing handed in: the same spellings, by shape.
    for (text, expected) in [
        ("c:\\users\\matteo\\x", "~\\x"),
        ("C:\\USERS\\Matteo\\x", "~\\x"),
        ("\\\\?\\C:\\Users\\Matteo\\x", "~\\x"),
        ("\"\\\\\\\\?\\\\C:\\\\Users\\\\Matteo\\\\x\"", "\"~\\\\x\""),
        ("/c/Users/Matteo/x", "~/x"),
        ("/mnt/c/Users/Matteo/x", "~/x"),
        ("`/d/Users/Matteo/x`", "`~/x`"),
        // A name with a space, followed by the rest of a path: the whole name.
        ("C:\\Users\\Mario Rossi\\proj\\a.rs", "~\\proj\\a.rs"),
        ("/Users/José María/código/x.rs", "~/código/x.rs"),
        ("/Users/Anna Maria Bianchi/Documents/x.md", "~/Documents/x.md"),
        ("`/home/mario rossi/site/index.html`", "`~/site/index.html`"),
    ] {
        let out = published(text);
        assert_eq!(out.text, expected, "{text}");
    }
    // A sentence after a home path is not a name: more than two words before
    // the next separator, or none at all.
    for (text, expected) in [
        ("/Users/matteo and then src/app.js", "~ and then src/app.js"),
        ("/Users/matteo is the home; src/app.js is the file", "~ is the home; src/app.js is the file"),
        ("see /home/alice or /home/bob/x", "see ~ or ~/x"),
        ("/Users/matteo: src/app.js", "~: src/app.js"),
        ("/Users/matteo", "~"),
    ] {
        assert_eq!(published(text).text, expected, "{text}");
    }
    // The rule's cost, as chosen: one or two words of a sentence before a
    // path go with the name rather than half a name staying.
    assert_eq!(published("/Users/matteo and src/app.js").text, "~/app.js");
}

/// Round 3: after a one-letter folder, `Users` is a home only as Git Bash
/// and WSL print it, with its capital. A route of the same shape is a
/// route.
#[test]
fn a_one_letter_route_is_not_a_home() {
    for kept in [
        "GET /v/users/42/profile",
        "the route /v/users/42/profile returns 404",
        "`/a/users/list` and `/mnt/x/users/list`",
        "/mnt/d/users/matteo/x",
        "/api/Users/42 and /v1/Users/42",
    ] {
        assert_eq!(published(kept), Published { text: kept.to_string(), removed: 0 }, "{kept}");
    }
    for (text, expected) in [("/c/Users/Matteo/x", "~/x"), ("/mnt/c/Users/Matteo/x", "~/x"), ("see /D/Users/Mario Rossi/proj/a.rs", "see ~/proj/a.rs")] {
        assert_eq!(published(text).text, expected, "{text}");
    }
}

/// Round 3: somebody's home on a network share loses the name too, in the
/// spellings Windows paths have. A URL is not a share.
#[test]
fn a_home_on_a_network_share_loses_the_name() {
    for (text, expected) in [
        (r"\\server\share\Users\matteo\y", r"~\y"),
        (r"see `\\fs01.corp.example\homes$\Users\Mario Rossi\proj\a.rs`", r"see `~\proj\a.rs`"),
        (r"\\SERVER\Share\USERS\matteo", "~"),
        (r#""\\\\server\\share\\Users\\matteo\\y""#, r#""~\\y""#),
        ("//server/share/Users/matteo/y", "~/y"),
        ("cd //server/share/Users/matteo/y && ls", "cd ~/y && ls"),
    ] {
        let out = published(text);
        assert_eq!(out.text, expected, "{text}");
        assert_eq!(out.removed, 0);
    }
    for kept in [
        "https://x.y/Users/matteo/z",
        "https://github.com/org/Users/matteo/z",
        "http://host/share/Users/matteo",
        "git+ssh://git@host/team/Users/matteo.git",
        r"\\server\share\Users\Public\x",
        r"\\server\share\docs\Users.md",
        r"\\server\Users\matteo is one name short of a share",
        "a // comment about /api/v2/Users/",
    ] {
        assert_eq!(published(kept), Published { text: kept.to_string(), removed: 0 }, "{kept}");
    }
}

/// Round 3: an id that follows `SECRET` or `TOKEN` is itself a secret
/// (`VAULT_SECRET_ID`), so `ID` exempts nothing there; an id of anything
/// else, and the other "about a secret" endings, are as they were.
#[test]
fn the_id_of_a_secret_is_a_secret() {
    let value = body(32);
    for name in ["CLIENT_SECRET_ID", "VAULT_SECRET_ID", "APPROLE_SECRET_ID", "REFRESH_TOKEN_ID"] {
        let out = published(&format!("{name}={value}"));
        assert_eq!((out.text.as_str(), out.removed), (format!("{name}={REMOVED}").as_str(), 1), "{name}");
    }
    for name in ["AWS_ACCESS_KEY_ID", "SECRET_KEY_ID", "SESSION_ID", "TOKEN_URL", "SECRET_NAME", "SECRET_PATH", "TOKEN_FILE", "TOKEN_TYPE", "SECRET_VERSION", "TOKEN_HEADER"] {
        let text = format!("{name}={value}");
        assert_eq!(published(&text), Published { text: text.clone(), removed: 0 }, "{name}");
    }
}

/// Round 2: a path in the Reviewer's own read-only tree of the project —
/// under Plyloft's session root, `<kind>/worktrees/<id>` — is the project's
/// file, shown relative like one in the card's copy. Anything else under
/// the session root is only a path under the member's home.
#[test]
fn a_path_in_the_reviewer_s_own_tree_is_shown_relative_to_the_project() {
    let home = PathBuf::from("/Users/matteo");
    let roots = [PathBuf::from("/Users/matteo/Library/Application Support/com.mbadv.ply/claude-sessions")];
    let places = Places { session_roots: &roots, home: Some(home.as_path()), ..Default::default() };
    let tree = "/Users/matteo/Library/Application Support/com.mbadv.ply/claude-sessions/reviews/worktrees/r-7f3a";
    for (text, expected) in [
        (format!("`{tree}/src/app.js:12` hard-codes the key"), "`src/app.js:12` hard-codes the key".to_string()),
        (format!("ran `git diff` in {tree}"), "ran `git diff` in .".to_string()),
        (format!("cd {tree}/ && ls"), "cd . && ls".to_string()),
        (
            "/Users/matteo/Library/Application Support/com.mbadv.ply/claude-sessions/discussions/worktrees/d-1/README.md".to_string(),
            "README.md".to_string(),
        ),
        // Not a tree: left to the home rule.
        (
            "/Users/matteo/Library/Application Support/com.mbadv.ply/claude-sessions/reviews/answers/a.json".to_string(),
            "~/Library/Application Support/com.mbadv.ply/claude-sessions/reviews/answers/a.json".to_string(),
        ),
    ] {
        assert_eq!(for_github(&text, &places).text, expected, "{text}");
    }
    // On Windows, in the spellings a tool prints.
    let roots = [PathBuf::from("C:\\Users\\Matteo\\AppData\\Roaming\\com.mbadv.ply\\claude-sessions")];
    let places = Places { session_roots: &roots, ..Default::default() };
    assert_eq!(
        for_github("C:\\Users\\Matteo\\AppData\\Roaming\\com.mbadv.ply\\claude-sessions\\reviews\\worktrees\\r-1\\src\\app.js", &places).text,
        "src\\app.js"
    );
    assert_eq!(
        for_github("c:/users/matteo/appdata/roaming/com.mbadv.ply/claude-sessions/reviews/worktrees/r-1/src/app.js", &places).text,
        "src/app.js"
    );
}

/// Round 2: the scans are linear. A megabyte of `sk-sk-sk-…` took 116 s —
/// each `sk-` walked the rest of the run. The bound is generous: the suite
/// runs under load, and the old cost was a hundred times it.
#[test]
fn a_megabyte_of_almost_tokens_is_filtered_fast() {
    let megabyte = |unit: &str, tail: &str| -> String {
        let mut text = unit.repeat(1_048_576 / unit.len());
        text.push_str(tail);
        text
    };
    let started = std::time::Instant::now();
    for (what, text) in [
        ("sk- repeated", megabyte("sk-", "")),
        ("sk- repeated, a digit and a capital at the end", megabyte("sk-", "A1")),
        ("sk- words, a digit and a capital at the end", megabyte("sk-abc-", "Large2")),
        ("xoxb- repeated", megabyte("xoxb-", "")),
        ("eyJ- repeated", megabyte("eyJ-", "")),
        // Round 3: many `eyJ` starts in one run, then a payload a megabyte
        // long that is no token (nothing signs it): it was walked from each.
        ("eyJ starts before a long payload", format!("{}.eyJ{}", "eyJabcdefghijkl-".repeat(4096), "a".repeat(1_048_576))),
        ("eyJ starts before a long payload and a short signature", format!("{}.eyJ{}.abc", "eyJabcdefghijkl-".repeat(4096), "a".repeat(1_048_576))),
        ("ghp_ short runs", megabyte("ghp_abc-", "")),
        ("Bearer repeated", megabyte("Bearer ", "")),
        ("a secret's name repeated", megabyte("A_KEY=", "")),
        ("a secret's name with a path", megabyte("A_KEY=a:b ", "")),
        ("home leads", megabyte("/Users/", "")),
        ("key headers", megabyte("-----BEGIN ", "")),
        ("one long word", megabyte("a", "")),
    ] {
        let one = std::time::Instant::now();
        let out = published(&text);
        assert!(out.text.len() <= text.len() + 64, "{what}");
        assert!(one.elapsed() < std::time::Duration::from_secs(10), "{what}: {:?}", one.elapsed());
    }
    assert!(started.elapsed() < std::time::Duration::from_secs(30), "{:?}", started.elapsed());
}

/// The line under the text says how many things were removed, in the
/// comment's own voice; nothing removed, no line.
#[test]
fn the_count_line_says_how_many_things_were_removed() {
    assert_eq!((removed_line(0, Posted::Notes), removed_line(0, Posted::Description)), (None, None));
    assert_eq!(
        removed_line(1, Posted::Notes).as_deref(),
        Some("Plyloft: 1 thing that looked like a secret was removed from these notes before posting. The card keeps the whole text.")
    );
    assert_eq!(
        removed_line(3, Posted::Notes).as_deref(),
        Some("Plyloft: 3 things that looked like secrets were removed from these notes before posting. The card keeps the whole text.")
    );
    // Round 2: the card doesn't keep the Builder's description (its draft is
    // deleted once Ship took it), so that line doesn't say it does.
    assert_eq!(
        removed_line(1, Posted::Description).as_deref(),
        Some("Plyloft: 1 thing that looked like a secret was removed from this description before posting.")
    );
    assert_eq!(
        removed_line(3, Posted::Description).as_deref(),
        Some("Plyloft: 3 things that looked like secrets were removed from this description before posting.")
    );
    // Counted across kinds: a token, an assignment's value, a key block.
    let text = format!(
        "{}\nSESSION_SECRET={}\n-----BEGIN {}-----\n{}\n-----END {}-----\n/Users/matteo/x",
        joined(&["gh", "p_", &body(36)]),
        body(32),
        joined(&["RSA PRIVATE", " KEY"]),
        body(64),
        joined(&["RSA PRIVATE", " KEY"]),
    );
    let out = published(&text);
    assert_eq!(out.removed, 3);
    assert_eq!(out.text, format!("{REMOVED}\nSESSION_SECRET={REMOVED}\n{REMOVED}\n~/x"));
}

/// Filtering what was already filtered changes nothing more.
#[test]
fn filtering_twice_is_filtering_once() {
    let text = format!("{} and API_KEY={} in /Users/matteo/x", joined(&["s", "k_live_", &body(24)]), body(32));
    let once = published(&text);
    let twice = published(&once.text);
    assert_eq!(twice.text, once.text);
    assert_eq!(twice.removed, 0);
}

/// No test in this file holds a secret-shaped string as written.
#[test]
fn this_file_holds_no_secret_shaped_literal() {
    let source = include_str!("publish_filter_tests.rs");
    assert_eq!(published(source).removed, 0, "build the fixture at run time instead");
}
