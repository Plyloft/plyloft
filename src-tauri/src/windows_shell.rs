//! Windows (W4): what the Mac's dock and app menu give Ply for free.
//!
//! Closing the window hides it (hard rule 5), and on the Mac the dock icon
//! brings it back (`RunEvent::Reopen`) and ⌘Q quits. Windows has neither, so
//! a notification-area icon does both: a click shows the window, its menu
//! shows it or quits. Quit goes through `AppHandle::exit`, the same
//! `ExitRequested` path as ⌘Q, so every child is killed (hard rule 4).
//!
//! Also here: the taskbar overlay dot and the tray's dot and count standing
//! in for the dock badge, and WebView2's browser accelerator keys turned off.

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

const TRAY_ID: &str = "main";
const MENU_SHOW: &str = "tray-show";
const MENU_QUIT: &str = "tray-quit";
/// QoL 1.168 S3: Check for Updates, the Mac menu's item on Windows.
const MENU_CHECK_UPDATES: &str = "tray-check-updates";

/// How many things wait on the user (the Inbox count), and whether the
/// window is closed to the tray: what the tooltip and icon say.
static WAITING: AtomicU32 = AtomicU32::new(0);
static HIDDEN: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayAction {
    Show,
    CheckUpdates,
    Quit,
}

/// What a tray menu item does, by its id.
fn tray_action(menu_id: &str) -> Option<TrayAction> {
    match menu_id {
        MENU_SHOW => Some(TrayAction::Show),
        MENU_QUIT => Some(TrayAction::Quit),
        MENU_CHECK_UPDATES => Some(TrayAction::CheckUpdates),
        _ => None,
    }
}

/// The tray's tooltip: the count while anything waits, else whether Ply is
/// still running behind a closed window.
fn tooltip_text(waiting: u32, hidden: bool) -> String {
    if waiting > 0 {
        format!("Plyloft \u{2014} {waiting} waiting")
    } else if hidden {
        "Plyloft \u{2014} still running".to_string()
    } else {
        "Plyloft".to_string()
    }
}

/// The notification-area icon. Called once from `setup`.
pub fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, MENU_SHOW, "Show Plyloft", true, None::<&str>)?;
    let check = MenuItem::with_id(app, MENU_CHECK_UPDATES, "Check for Updates…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit Plyloft", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &check, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tooltip_text(0, false))
        .menu(&menu)
        // Left click shows the window; the menu is on the right button.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match tray_action(event.id().as_ref()) {
            Some(TrayAction::Show) => show_main(app),
            // The page's sheet answers (`menu://help`, as the Mac's menu).
            Some(TrayAction::CheckUpdates) => {
                show_main(app);
                let _ = app.emit("menu://help", "check-updates");
            }
            // The same quit as ⌘Q on the Mac, through the quit guard (S1-2):
            // `ExitRequested` kills the agents, PTYs and every process group
            // first.
            Some(TrayAction::Quit) => crate::request_quit(app),
            None => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Show, restore and focus the main window.
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    HIDDEN.store(false, Ordering::Relaxed);
    refresh_tooltip(app);
}

/// The main window's close: hidden to the tray, still running. Without a
/// tray (it failed to install) a hidden window could not come back but by a
/// second launch, so it is minimized to the taskbar instead.
pub fn close_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // H1 (1.173.0): a hidden or minimized page beats every 30 s; no silence.
    crate::watchdog::window_shown(false);
    if !has_tray(app) {
        let _ = window.minimize();
        return;
    }
    let _ = window.hide();
    HIDDEN.store(true, Ordering::Relaxed);
    refresh_tooltip(app);
}

/// Whether the notification-area icon is there (it can fail to install);
/// without it a close minimizes instead of hiding.
pub fn has_tray(app: &AppHandle) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}

fn refresh_tooltip(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let text = tooltip_text(WAITING.load(Ordering::Relaxed), HIDDEN.load(Ordering::Relaxed));
        let _ = tray.set_tooltip(Some(text));
    }
}

// ── Attention: the taskbar overlay and the tray (the dock badge's stand-in) ──

// Drawn at 32 px; Windows scales it to the overlay's size for the DPI.
const DOT_SIZE: u32 = 32;
// The shell's red, opaque; a white ring keeps it apart from any icon.
const DOT_FILL: [u8; 3] = [0xE5, 0x48, 0x4D];
const DOT_RING: [u8; 3] = [0xFF, 0xFF, 0xFF];

/// A `size`×`size` RGBA dot: a filled circle with a white ring (1.5 px at
/// 16 px, scaled), its edge anti-aliased by coverage. Windows draws no number
/// on an overlay, so the dot says "something needs you"; the tooltip and the
/// Inbox have the count.
fn attention_dot(size: u32) -> Vec<u8> {
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    let c = size as f32 / 2.0;
    let outer = c;
    let inner = c - 1.5 * size as f32 / 16.0;
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 + 0.5 - c;
            let dy = y as f32 + 0.5 - c;
            let d = (dx * dx + dy * dy).sqrt();
            let alpha = (outer - d + 0.5).clamp(0.0, 1.0);
            if alpha == 0.0 {
                continue;
            }
            let fill = (inner - d + 0.5).clamp(0.0, 1.0);
            let i = ((y * size + x) * 4) as usize;
            for k in 0..3 {
                let v = DOT_FILL[k] as f32 * fill + DOT_RING[k] as f32 * (1.0 - fill);
                rgba[i + k] = v.round() as u8;
            }
            rgba[i + 3] = (alpha * 255.0).round() as u8;
        }
    }
    rgba
}

/// `base` (`width`×`height` RGBA) with the attention dot over its
/// bottom-right corner, a little over half its size: the tray icon while
/// anything waits.
fn with_dot(base: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = base.to_vec();
    let size = (width.min(height) * 9 / 16).max(1);
    let dot = attention_dot(size);
    let (x0, y0) = (width - size, height - size);
    for y in 0..size {
        for x in 0..size {
            let s = ((y * size + x) * 4) as usize;
            let a = dot[s + 3] as f32 / 255.0;
            if a == 0.0 {
                continue;
            }
            let d = (((y0 + y) * width + (x0 + x)) * 4) as usize;
            let da = out[d + 3] as f32 / 255.0;
            // Source over, on straight (unpremultiplied) alpha.
            let oa = a + da * (1.0 - a);
            for k in 0..3 {
                let v = (dot[s + k] as f32 * a + out[d + k] as f32 * da * (1.0 - a)) / oa;
                out[d + k] = v.round() as u8;
            }
            out[d + 3] = (oa * 255.0).round() as u8;
        }
    }
    out
}

/// `count` things wait on the user: the overlay dot on the taskbar button,
/// the dot on the tray icon and the count in its tooltip — the tray is all
/// there is to see while the window is closed.
pub fn set_attention(app: &AppHandle, window: &WebviewWindow, count: u32) -> tauri::Result<()> {
    let was = WAITING.swap(count, Ordering::Relaxed);
    refresh_tooltip(app);
    if (was > 0) == (count > 0) {
        return Ok(());
    }
    if let (Some(tray), Some(base)) = (app.tray_by_id(TRAY_ID), app.default_window_icon()) {
        let icon = if count > 0 {
            let rgba = with_dot(base.rgba(), base.width(), base.height());
            Image::new_owned(rgba, base.width(), base.height())
        } else {
            base.clone().to_owned()
        };
        let _ = tray.set_icon(Some(icon));
    }
    let overlay = (count > 0).then(|| Image::new_owned(attention_dot(DOT_SIZE), DOT_SIZE, DOT_SIZE));
    window.set_overlay_icon(overlay)
}

// ── WebView2 ──────────────────────────────────────────────────────────

/// Turn off WebView2's browser accelerator keys (reload, print, find, the
/// developer tools, history). Keys still reach the page, so Ply's shortcuts,
/// the editor and the terminal see them; editing keys (copy, paste, undo)
/// are not browser keys and keep working. The page-level guard in
/// `lib/browserKeys.ts` stays as the fallback. Zoom and pinch are already off
/// (Tauri's `zoomHotkeysEnabled` defaults to false). A debug build keeps
/// them, so F12 and the developer tools stay reachable while developing.
pub fn disable_browser_accelerators(window: &WebviewWindow) {
    if cfg!(debug_assertions) {
        return;
    }
    let result = window.with_webview(|webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows_core::Interface;
        let applied = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.Settings())
                .and_then(|settings| settings.cast::<ICoreWebView2Settings3>())
                .and_then(|settings| settings.SetAreBrowserAcceleratorKeysEnabled(false))
        };
        if let Err(error) = applied {
            log::warn!("webview2: browser accelerator keys left on: {error}");
        }
    });
    if let Err(error) = result {
        log::warn!("webview2: settings unreachable: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_menu_ids_map_to_their_actions() {
        assert_eq!(tray_action(MENU_SHOW), Some(TrayAction::Show));
        assert_eq!(tray_action(MENU_QUIT), Some(TrayAction::Quit));
        assert_eq!(tray_action(MENU_CHECK_UPDATES), Some(TrayAction::CheckUpdates));
        assert_eq!(tray_action("quit"), None);
        assert_eq!(tray_action(""), None);
    }

    #[test]
    fn the_tooltip_says_the_count_else_whether_ply_is_still_running() {
        assert_eq!(tooltip_text(0, false), "Plyloft");
        assert_eq!(tooltip_text(0, true), "Plyloft \u{2014} still running");
        assert_eq!(tooltip_text(3, false), "Plyloft \u{2014} 3 waiting");
        assert_eq!(tooltip_text(1, true), "Plyloft \u{2014} 1 waiting");
    }

    #[test]
    fn the_tray_dot_covers_the_bottom_right_corner_only() {
        let (w, h) = (32u32, 32u32);
        // An opaque grey icon.
        let base: Vec<u8> = (0..w * h).flat_map(|_| [0x80, 0x80, 0x80, 0xFF]).collect();
        let out = with_dot(&base, w, h);
        assert_eq!(out.len(), base.len());
        let px = |x: u32, y: u32| {
            let i = ((y * w + x) * 4) as usize;
            [out[i], out[i + 1], out[i + 2], out[i + 3]]
        };
        assert_eq!(px(0, 0), [0x80, 0x80, 0x80, 0xFF], "the top-left is the icon");
        assert_eq!(px(w / 4, h - 1), [0x80, 0x80, 0x80, 0xFF], "left of the dot");
        // The dot is 18 px, from (14, 14): its centre is the fill.
        assert_eq!(px(14 + 9, 14 + 9), [DOT_FILL[0], DOT_FILL[1], DOT_FILL[2], 0xFF]);
        // A transparent icon takes the dot's own alpha.
        let clear = vec![0u8; (w * h * 4) as usize];
        let out = with_dot(&clear, w, h);
        assert_eq!(out[3], 0, "the top-left stays clear");
        assert_eq!(out[(((14 + 9) * w + 14 + 9) * 4 + 3) as usize], 0xFF);
    }

    #[test]
    fn attention_dot_is_a_ringed_circle_with_clear_corners() {
        let size = DOT_SIZE;
        let rgba = attention_dot(size);
        assert_eq!(rgba.len(), (size * size * 4) as usize);
        let px = |x: u32, y: u32| {
            let i = ((y * size + x) * 4) as usize;
            [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
        };
        // Corners are transparent.
        for (x, y) in [(0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1)] {
            assert_eq!(px(x, y)[3], 0, "corner {x},{y}");
        }
        // The centre is the opaque fill.
        let centre = px(size / 2, size / 2);
        assert_eq!(centre, [DOT_FILL[0], DOT_FILL[1], DOT_FILL[2], 255]);
        // The edge row's middle is the white ring.
        let edge = px(size / 2, 0);
        assert!(edge[3] > 128, "edge is drawn: {edge:?}");
        assert!(edge[1] > 200 && edge[2] > 200, "edge is the ring: {edge:?}");
    }
}
