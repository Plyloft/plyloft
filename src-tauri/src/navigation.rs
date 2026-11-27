//! GH #138 — the native webview navigation policy.
//!
//! The in-page drop guard (`src/lib/dropGuard.ts`) stops the drop that caused
//! the bug, and the in-page click guard stops an off-page anchor. Neither is a
//! categorical refusal: cancelling `beforeunload` only *asks* the UA to prompt,
//! and the UA is free not to (no user activation, and WebKit's prompt is a
//! delegate the host need not implement). A navigation that reaches the webview
//! another way — a dropped file that escaped the guard, a `location` assignment
//! from a future code path — would still replace the app.
//!
//! So the refusal lives where it is not advisory: wry's `WKNavigationDelegate`
//! policy, reached through a Tauri plugin's `on_navigation` hook. Returning
//! false there is `WKNavigationActionPolicy::Cancel` — the load does not happen.
//!
//! **What this hook can and cannot decide.** It is handed a URL and nothing
//! else. wry reads `action.request().URL()` and calls
//! `function(url.to_string())`; it never looks at `action.targetFrame`, and
//! neither Tauri signature carries one —
//! `plugin::Builder::on_navigation(Fn(&Webview, &Url) -> bool)`
//! (tauri-2.11.0/src/plugin.rs:458) and
//! `WebviewWindowBuilder::on_navigation(Fn(&Url) -> bool)`
//! (tauri-2.11.0/src/webview/webview_window.rs:266), over
//! wry-0.55.0/src/wkwebview/navigation.rs:76. So **a main-frame navigation and
//! an iframe load are indistinguishable here.**
//!
//! `BrowserPane` is a real browser: Generic mode frames whatever URL the user
//! types and the page then follows its own links, cross-origin included, and
//! Localhost mode frames a dev server that redirects where it likes. Any
//! policy that refused remote pages would break it. Remote `http(s)` is
//! therefore allowed, and the top-level half of that case is held elsewhere:
//! `installNavigationGuard` cancels an off-page anchor in the page, and the
//! panes' iframes carry a `sandbox` without `allow-top-navigation`, so a
//! framed page cannot reach the shell.
//!
//! What this policy does refuse categorically is every scheme that is not a
//! page: `file:` above all — what a dropped image resolves to, and what this
//! card exists to stop — and `data:`, `blob:`, `javascript:`, `ftp:` and
//! `about:` with it. None of those has a legitimate use in Ply, in any frame;
//! an iframe's initial empty document is created without a navigation, so
//! refusing `about:blank` costs nothing.
//!
//! **Why this is where it stops, and what would let it go further.** The
//! brief asks for a fallback against a top-level navigation. Constraining the
//! *main frame* to the app's page while leaving subframes alone is the right
//! shape, and it cannot be written here: the hook is handed a URL and nothing
//! else, so a main-frame navigation and an iframe load cannot be told apart —
//! and `BrowserPane` frames real pages in both of its modes, so refusing
//! remote `http(s)` would break it. What the card exists to close *is* closed
//! natively and for every frame: `file:` — what a dropped image resolves to —
//! along with `data:`, `blob:`, `javascript:`, `ftp:` and `about:`.
//!
//! The top-level half of the `http(s)` case is held twice inside the page
//! instead: `installNavigationGuard` cancels an off-page anchor (and a form,
//! and `window.open` aimed at this frame), and the panes' iframes carry a
//! `sandbox` without `allow-top-navigation`, so a framed page cannot reach
//! the shell at all.
//!
//! **The condition for revisiting this:** if Tauri ever passes the target
//! frame to `on_navigation`, narrow the main frame to the app's own document
//! here and keep the `http(s)` allowance for subframes only. Until then there
//! is nothing to branch on. (Checked at tauri 2.11.0 / wry 0.55.0: the
//! response-policy hook is no help either — wry reads only `canShowMIMEType`
//! and never surfaces `WKNavigationResponse.isForMainFrame`,
//! wkwebview/navigation.rs:84.)
//!
//! What must keep working, and does:
//!   * the app's own page, in dev (`http://localhost:1420`) and packaged
//!     (`tauri://localhost`), including the very first load and the fresh
//!     process the updater's relaunch starts;
//!   * Tauri's own internal schemes, so the IPC and the asset protocol behind
//!     attachment and workspace-icon images are untouched;
//!   * `mailto:` and friends are not refused here — but the webview does not
//!     hand them to the OS either (WKWebView loads them itself; WebView2
//!     prompts): a page that needs one asks the backend
//!     (`commands::open_support_mail`, Get help);
//!   * `BrowserPane` in both modes, and the links and redirects each follows.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Schemes the OS takes rather than the webview. Kept in step with
/// `src/lib/dropGuard.ts::HANDED_OFF_SCHEMES`, which `dropGuard.test.ts`
/// asserts by reading this file.
pub const HANDED_OFF_SCHEMES: &[&str] = &["mailto", "tel", "sms", "facetime"];

/// Schemes Tauri itself serves the app over.
pub const APP_SCHEMES: &[&str] = &["tauri", "asset", "ipc"];

/// May the webview navigate to this URL?
///
/// Pure, so the policy is a contract test rather than a claim (see the tests
/// at the bottom of this file).
pub fn navigation_allowed(url: &str) -> bool {
    let Some((scheme, _rest)) = url.split_once(':') else {
        // `WKNavigationAction`'s URL is always absolute, so this is
        // unreachable — and a policy is the wrong place to fail open.
        // Everything legitimate is matched by name below.
        return false;
    };
    let scheme = scheme.to_ascii_lowercase();

    if APP_SCHEMES.contains(&scheme.as_str()) {
        return true;
    }
    if HANDED_OFF_SCHEMES.contains(&scheme.as_str()) {
        return true;
    }
    // A page, wherever it is: the app's own dev server, a dev server in a
    // Browser tile, and whatever a Browser tile in Generic mode is showing.
    // See the module docs for why this cannot be narrowed to the app's own
    // page without breaking that tile.
    scheme == "http" || scheme == "https"
}

/// The plugin that enforces it. Registered from `lib.rs` before the window is
/// created, so it covers the first load too.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ply-navigation")
        .on_navigation(|_webview, url| {
            let allowed = navigation_allowed(url.as_str());
            if !allowed {
                log::warn!("navigation refused — Plyloft is a single page: {url}");
            }
            allowed
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_apps_own_page_loads() {
        assert!(navigation_allowed("tauri://localhost"));
        assert!(navigation_allowed("tauri://localhost/index.html"));
        assert!(navigation_allowed("http://localhost:1420/"));
        assert!(navigation_allowed("http://localhost:1420/index.html"));
        assert!(navigation_allowed("http://tauri.localhost/"));
        assert!(navigation_allowed("http://asset.localhost/foo.png"));
    }

    #[test]
    fn tauris_own_schemes_are_untouched() {
        for scheme in APP_SCHEMES {
            assert!(
                navigation_allowed(&format!("{scheme}://localhost/x")),
                "{scheme} must stay allowed"
            );
        }
    }

    #[test]
    fn the_os_still_takes_its_links() {
        assert!(navigation_allowed("mailto:beta@ply.app?subject=Key"));
        assert!(navigation_allowed("MAILTO:beta@ply.app"));
        assert!(navigation_allowed("tel:+390000000"));
    }

    #[test]
    fn browser_pane_keeps_framing_dev_servers() {
        assert!(navigation_allowed("http://localhost:3000/"));
        assert!(navigation_allowed("http://127.0.0.1:5173/some/path?x=1"));
        assert!(navigation_allowed("https://localhost:8443/"));
        assert!(navigation_allowed("http://[::1]:4321/"));
    }

    #[test]
    fn browser_pane_keeps_framing_remote_pages() {
        // Generic mode frames whatever the user types and the page then
        // follows its own links; a local preview may redirect off-machine.
        // The delegate cannot tell any of that from a top-level load, so
        // refusing remote pages would break the tile.
        assert!(navigation_allowed("https://example.com/"));
        assert!(navigation_allowed("https://example.com/deep/link?q=1#frag"));
        assert!(navigation_allowed("http://example.com/redirected"));
        assert!(navigation_allowed("https://sub.example.co.uk:8443/"));
    }

    #[test]
    fn a_dropped_file_is_refused() {
        assert!(!navigation_allowed("file:///Users/me/Desktop/shot.png"));
        assert!(!navigation_allowed("FILE:///Users/me/Desktop/shot.png"));
        assert!(!navigation_allowed("file:///"));
    }

    #[test]
    fn everything_that_is_not_a_page_is_refused() {
        assert!(!navigation_allowed("javascript:alert(1)"));
        assert!(!navigation_allowed("data:text/html,<h1>x</h1>"));
        assert!(!navigation_allowed("blob:https://example.com/abc"));
        assert!(!navigation_allowed("ftp://example.com/x"));
        // `about:` has no legitimate use in Ply, in any frame: an iframe's
        // initial empty document is created without a navigation.
        assert!(!navigation_allowed("about:blank"));
        assert!(!navigation_allowed("about:srcdoc"));
    }

    #[test]
    fn an_unparseable_url_fails_closed() {
        assert!(!navigation_allowed(""));
        assert!(!navigation_allowed("not-a-url"));
        assert!(!navigation_allowed("/Users/me/Desktop/shot.png"));
    }
}
