//! Window management — create/show translation popup and settings windows.

use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

// ── Cursor-anchored popups ────────────────────────────────────────────────────

/// The chrome that differs between the two cursor-anchored popups. Everything
/// they share lives in `show_cursor_popup`.
struct PopupSpec {
    label: &'static str,
    title: &'static str,
    url: String,
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
    /// Hidden from the taskbar for ephemeral popups whose content is one hotkey
    /// press away from being regenerated. A chat session is not: it holds
    /// history and screenshots, so it must stay reachable via alt-tab after the
    /// user clicks away.
    skip_taskbar: bool,
}

/// Build, position, and show a frameless popup anchored to the cursor.
///
/// Built hidden so it can be placed by PHYSICAL pixel before first paint
/// (`keyhook::cursor_pos` reports physical, the builder's `position()` takes
/// logical) — otherwise it flashes at the wrong spot on high-DPI displays.
fn show_cursor_popup(
    app: &AppHandle,
    spec: PopupSpec,
    cursor_x: f64,
    cursor_y: f64,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(spec.label) {
        let _ = existing.close();
    }

    let window = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::App(spec.url.into()))
        .title(spec.title)
        .inner_size(spec.width, spec.height)
        .min_inner_size(spec.min_width, spec.min_height)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(spec.skip_taskbar)
        .resizable(true)
        .focused(true)
        .visible(false)
        .build()
        .map_err(|e| format!("failed to create {}: {e}", spec.label))?;

    // This window's own cancellation flag, set only by its own close handler —
    // a stream left running for a closed window can only bill tokens nobody will
    // read. Claiming also cancels the stream of the window just replaced above.
    let cancelled = app
        .state::<crate::api::StreamRegistry>()
        .claim(spec.label);
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            cancelled.store(true, Ordering::Relaxed);
        }
    });

    position_at_cursor(&window, spec.width, spec.height, cursor_x, cursor_y);

    let _ = window.show();
    let _ = window.set_focus();

    Ok(())
}

// ── Translation popup ─────────────────────────────────────────────────────────

/// Create and show the translation popup near the cursor.
/// `original`: captured text (may be truncated in HTML layer)
/// `target_language`: shown in the popup header
/// `cursor_x`, `cursor_y`: current cursor position in PHYSICAL screen pixels
///
/// If original is empty, does nothing.
pub fn show_translate_popup(
    app: &AppHandle,
    original: &str,
    target_language: &str,
    cursor_x: f64,
    cursor_y: f64,
) -> Result<(), String> {
    if original.trim().is_empty() {
        return Ok(());
    }

    let url = format!(
        "popup.html?original={}&lang={}",
        url_encode(original),
        url_encode(target_language)
    );

    show_cursor_popup(
        app,
        PopupSpec {
            label: "translate-popup",
            title: "Quick Translator",
            url,
            width: 460.0,
            height: 220.0,
            min_width: 360.0,
            min_height: 160.0,
            skip_taskbar: true,
        },
        cursor_x,
        cursor_y,
    )
}

// ── Chat popup ────────────────────────────────────────────────────────────────

/// Create and show the chat popup near the cursor.
/// `selected`: captured selection text (may be empty → free chat)
/// `cursor_x`, `cursor_y`: cursor position in PHYSICAL screen pixels
pub fn show_chat_popup(
    app: &AppHandle,
    selected: &str,
    cursor_x: f64,
    cursor_y: f64,
) -> Result<(), String> {
    show_cursor_popup(
        app,
        PopupSpec {
            label: "chat-popup",
            title: "Quick Translator — Chat",
            url: format!("chat.html?selected={}", url_encode(selected)),
            width: 500.0,
            height: 580.0,
            min_width: 380.0,
            min_height: 320.0,
            skip_taskbar: false,
        },
        cursor_x,
        cursor_y,
    )
}

// ── Cursor-anchored positioning (DPI-safe) ──────────────────────────────────────

/// Position an already-built (hidden) window near the cursor, clamped to the
/// monitor under the cursor. All math is in physical pixels: `GetCursorPos`
/// reports physical, set_position takes physical, and scale comes from the
/// cursor's monitor (correct on mixed-DPI multi-monitor). Never pass physical
/// coords to the builder's logical `.position()`.
fn position_at_cursor(
    window: &tauri::WebviewWindow,
    logical_w: f64,
    logical_h: f64,
    cursor_x: f64,
    cursor_y: f64,
) {
    let cursor_monitor = window.monitor_from_point(cursor_x, cursor_y).ok().flatten();
    let scale = cursor_monitor
        .as_ref()
        .map(|m| m.scale_factor())
        .unwrap_or_else(|| window.scale_factor().unwrap_or(1.0));

    let popup_pw = logical_w * scale;
    let popup_ph = logical_h * scale;
    let offset = 16.0 * scale;

    let mut x = cursor_x + offset;
    let mut y = cursor_y + offset;

    if let Some(monitor) = cursor_monitor {
        let m_pos = monitor.position();
        let m_size = monitor.size();
        let left = m_pos.x as f64;
        let top = m_pos.y as f64;
        let right = left + m_size.width as f64;
        let bottom = top + m_size.height as f64;

        if x + popup_pw > right {
            x = right - popup_pw - 10.0 * scale;
        }
        if y + popup_ph > bottom {
            y = bottom - popup_ph - 10.0 * scale;
        }
        if x < left {
            x = left + 10.0 * scale;
        }
        if y < top {
            y = top + 10.0 * scale;
        }
    }

    let _ = window.set_position(PhysicalPosition::new(x, y));
}

// ── Toast (transient notice) ─────────────────────────────────────────────────

/// Show a short-lived notice near the cursor. The window closes itself.
///
/// Anchored at the cursor because that is where the user is looking when they
/// press a hotkey, and `focused(false)` because stealing focus from the app they
/// are typing in would be worse than the silence this replaces.
pub fn show_toast(app: &AppHandle, message: &str, cursor_x: f64, cursor_y: f64) {
    // Reusing one label means a rapid second notice replaces the first rather
    // than stacking windows over each other.
    if let Some(existing) = app.get_webview_window("toast") {
        let _ = existing.close();
    }

    let toast_w: f64 = 300.0;
    let toast_h: f64 = 44.0;
    let url = format!("toast.html?message={}", url_encode(message));

    let window = match WebviewWindowBuilder::new(app, "toast", WebviewUrl::App(url.into()))
        .title("Quick Translator")
        .inner_size(toast_w, toast_h)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()
    {
        Ok(w) => w,
        // Nothing left to report it with — a toast is the reporting channel.
        Err(_) => return,
    };

    position_at_cursor(&window, toast_w, toast_h, cursor_x, cursor_y);
    let _ = window.show();
}

// ── Settings window ───────────────────────────────────────────────────────

/// Create or focus the Settings window.
pub fn show_settings_window(app: &AppHandle) -> Result<(), String> {
    // If already open, just focus
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Quick Translator — Settings")
        .inner_size(520.0, 520.0)
        .decorations(true)
        .always_on_top(false)
        .resizable(true)
        .visible(true)
        .build()
        .map_err(|e| format!("failed to create settings window: {e}"))?;

    Ok(())
}

// ── Overlay windows (screenshot selection) ───────────────────────────────────

/// Create one fullscreen borderless overlay window per monitor for region selection.
/// Each window displays the frozen screenshot preview as its background.
pub fn show_overlay_windows(
    app: &AppHandle,
    monitors: &[crate::screenshot::MonitorInfo],
) -> Result<(), String> {
    // Close any existing overlays first
    close_overlay_windows(app);

    for (i, info) in monitors.iter().enumerate() {
        let label = format!("overlay-{i}");

        // Only the monitor index goes in the URL — the preview image itself is
        // pulled over IPC. A multi-MB base64 data URL in a query string would
        // blow past URL length limits.
        let url = format!("overlay.html?monitor={i}");

        let window = WebviewWindowBuilder::new(
            app,
            &label,
            WebviewUrl::App(url.into()),
        )
            .title("Screenshot")
            // Placeholder — the real size is applied below in physical pixels.
            .inner_size(640.0, 480.0)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            // Built resizable so the set_size below is honoured, then locked.
            .resizable(true)
            .focused(i == 0)
            .visible(false)
            .build()
            .map_err(|e| format!("failed to create overlay-{i}: {e}"))?;

        // Size and position in physical pixels so the overlay covers exactly the
        // monitor's capture. The builder's logical inner_size is resolved against
        // whichever scale factor the window is created on, which is not
        // necessarily this monitor's — that mismatch skews the CSS→physical
        // factor the crop is derived from.
        // Position before size: moving a window onto a monitor with a different
        // scale factor makes Windows suggest a rescaled rect, which would undo a
        // size applied first. Sizing last wins.
        let _ = window.set_position(PhysicalPosition::new(info.x as f64, info.y as f64));
        let _ = window.set_size(PhysicalSize::new(info.width, info.height));
        let _ = window.set_resizable(false);
        let _ = window.show();
        if i == 0 {
            let _ = window.set_focus();
        }
    }

    Ok(())
}

/// Close all overlay windows.
pub fn close_overlay_windows(app: &AppHandle) {
    for i in 0..16 {
        let label = format!("overlay-{i}");
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.close();
        } else {
            break;
        }
    }
}

// ── URL encoding helper ───────────────────────────────────────────────────────

fn url_encode(s: &str) -> String {
    let mut encoded = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*b as char);
            }
            b' ' => encoded.push('+'),
            _ => {
                encoded.push('%');
                encoded.push_str(&format!("{:02X}", b));
            }
        }
    }
    encoded
}
