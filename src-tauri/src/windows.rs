//! Window management — create/show translation popup and settings windows.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

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

/// Build a frameless popup anchored to the cursor, still hidden.
///
/// Built hidden so it can be placed by PHYSICAL pixel before first paint
/// (`keyhook::cursor_pos` reports physical, the builder's `position()` takes
/// logical) — otherwise it flashes at the wrong spot on high-DPI displays.
fn build_cursor_popup(app: &AppHandle, spec: &PopupSpec) -> Result<tauri::WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window(spec.label) {
        let _ = existing.close();
    }

    let window = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::App(spec.url.clone().into()))
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

    Ok(window)
}

fn show_built_popup(
    window: &tauri::WebviewWindow,
    logical_w: f64,
    logical_h: f64,
    cursor_x: f64,
    cursor_y: f64,
) {
    position_at_cursor(window, logical_w, logical_h, cursor_x, cursor_y);
    let _ = window.show();
    let _ = window.set_focus();
}

fn show_cursor_popup(
    app: &AppHandle,
    spec: PopupSpec,
    cursor_x: f64,
    cursor_y: f64,
) -> Result<(), String> {
    let window = build_cursor_popup(app, &spec)?;
    show_built_popup(&window, spec.width, spec.height, cursor_x, cursor_y);
    Ok(())
}

// ── Translation popup ─────────────────────────────────────────────────────────

const TRANSLATE_LABEL: &str = "translate-popup";

/// Flag + expiry for programmatic resizes (estimate + live-grow). A plain
/// boolean is racy: the Resized event can arrive after we clear the flag.
///
/// `translate_popup_mark_programmatic` records `Instant::now() + 500ms`; the
/// persistence handler skips Resized events while `deadline` is still in the
/// future. Cheap to read, no contention in the common path.
fn translate_popup_programmatic_deadline() -> Arc<Mutex<Option<Instant>>> {
    static DL: OnceLock<Arc<Mutex<Option<Instant>>>> = OnceLock::new();
    DL.get_or_init(|| Arc::new(Mutex::new(None))).clone()
}

fn translate_popup_mark_programmatic() {
    let dl = translate_popup_programmatic_deadline();
    let mut g = dl.lock().unwrap_or_else(|e| e.into_inner());
    *g = Some(Instant::now() + std::time::Duration::from_millis(600));
}

fn translate_popup_is_programmatic() -> bool {
    let dl = translate_popup_programmatic_deadline();
    let g = dl.lock().unwrap_or_else(|e| e.into_inner());
    matches!(*g, Some(t) if Instant::now() < t)
}

/// Throttle disk writes from rapid Resized events during a drag-resize.
fn translate_popup_last_persist() -> Arc<Mutex<Option<Instant>>> {
    static LAST: OnceLock<Arc<Mutex<Option<Instant>>>> = OnceLock::new();
    LAST.get_or_init(|| Arc::new(Mutex::new(None))).clone()
}

/// Logical height of the monitor under the cursor, used for capping the popup.
fn cursor_monitor_logical_height(window: &tauri::WebviewWindow, cursor_x: f64, cursor_y: f64) -> f64 {
    if let Some(monitor) = window.monitor_from_point(cursor_x, cursor_y).ok().flatten() {
        let scale = monitor.scale_factor().max(0.5);
        return (monitor.size().height as f64 / scale).max(crate::popup_sizing::MIN_H + 80.0);
    }
    // Fallback: assume a 900px-tall monitor at the window's own scale.
    let scale = window.scale_factor().unwrap_or(1.0).max(0.5);
    900.0 / scale
}

fn resolve_translate_popup_size(
    original: &str,
    cursor_x: f64,
    cursor_y: f64,
    window: &tauri::WebviewWindow,
) -> (f64, f64) {
    let monitor_h = cursor_monitor_logical_height(window, cursor_x, cursor_y);

    // A previously persisted manual resize wins over the estimate.
    if let Some(saved) = crate::window_state::load_translate_popup_size() {
        let w = saved.width.clamp(crate::popup_sizing::MIN_W, 1200.0);
        let h = saved.height.clamp(
            crate::popup_sizing::MIN_H,
            crate::popup_sizing::cap_height(f64::MAX, monitor_h),
        );
        return (w, h);
    }

    let h = crate::popup_sizing::estimate_popup_height(original, monitor_h);
    (crate::popup_sizing::DEFAULT_W, h)
}

/// Persist the user's manual drag-resize of the translate popup.
/// Called on WindowEvent::Resized. Skips programmatic resizes (flag) and
/// throttles disk writes to at most once per 400ms.
fn install_translate_popup_resize_persistence(window: &tauri::WebviewWindow) {
    let win = window.clone();
    let last = translate_popup_last_persist();
    window.on_window_event(move |event| {
        let tauri::WindowEvent::Resized(tauri::PhysicalSize { width, height }) = event else {
            return;
        };
        if translate_popup_is_programmatic() {
            return;
        }
        {
            let mut guard = last.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(t) = *guard {
                if t.elapsed().as_millis() < 400 {
                    return;
                }
            }
            *guard = Some(Instant::now());
        }
        let scale = win.scale_factor().unwrap_or(1.0).max(0.5);
        let logical = crate::window_state::LogicalSize {
            width: *width as f64 / scale,
            height: *height as f64 / scale,
        };
        if !(crate::popup_sizing::MIN_W..=1600.0).contains(&logical.width)
            || !(crate::popup_sizing::MIN_H..=1200.0).contains(&logical.height)
        {
            return;
        }
        let _ = crate::window_state::save_translate_popup_size(logical);
    });
}

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

    // Build hidden with a placeholder size so we have a WebviewWindow handle to
    // query the cursor monitor's scale. The real size is applied before `show()`,
    // so there is still no flash.
    let spec = PopupSpec {
        label: TRANSLATE_LABEL,
        title: "ContextKey",
        url,
        width: crate::popup_sizing::DEFAULT_W,
        height: 220.0,
        min_width: crate::popup_sizing::MIN_W,
        min_height: crate::popup_sizing::MIN_H,
        skip_taskbar: true,
    };
    let window = build_cursor_popup(app, &spec)?;

    let (target_w, target_h) = resolve_translate_popup_size(original, cursor_x, cursor_y, &window);

    // Apply the resolved size if it differs from the placeholder.
    if (target_w - spec.width).abs() > 0.5 || (target_h - spec.height).abs() > 0.5 {
        let scale = window
            .monitor_from_point(cursor_x, cursor_y)
            .ok()
            .flatten()
            .map(|m| m.scale_factor())
            .or_else(|| window.scale_factor().ok())
            .unwrap_or(1.0)
            .max(0.5);
        translate_popup_mark_programmatic();
        let _ = window.set_size(PhysicalSize::new(
            (target_w * scale).round() as u32,
            (target_h * scale).round() as u32,
        ));
    }

    // Add a second listener for manual-resize persistence; the Destroyed
    // listener installed by build_cursor_popup stays active alongside it
    // (on_window_event appends rather than replaces).
    install_translate_popup_resize_persistence(&window);

    show_built_popup(&window, target_w, target_h, cursor_x, cursor_y);
    Ok(())
}

/// Handle the frontend's live resize request: the webview has measured its
/// content and asks the window to grow/shrink to fit, capped to the current
/// monitor. Safe to call after the popup has closed (becomes a no-op).
pub fn resize_translate_popup_to_content(app: &AppHandle, desired_logical_h: f64) -> Result<(), String> {
    if !desired_logical_h.is_finite() || !(80.0..=3000.0).contains(&desired_logical_h) {
        return Ok(());
    }
    let Some(window) = app.get_webview_window(TRANSLATE_LABEL) else {
        return Ok(());
    };

    let scale = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .or_else(|| window.scale_factor().ok())
        .unwrap_or(1.0)
        .max(0.5);
    let monitor_h = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.size().height as f64 / m.scale_factor())
        .unwrap_or(900.0);

    let capped = desired_logical_h.clamp(
        crate::popup_sizing::MIN_H,
        (monitor_h * crate::popup_sizing::MAX_RATIO).floor().max(crate::popup_sizing::MIN_H),
    );

    let current_ph = window.inner_size().map(|s| s.height as f64).unwrap_or(capped * scale);
    let current_logical_h = current_ph / scale;
    if (capped - current_logical_h).abs() < 8.0 {
        return Ok(());
    }

    let current_w_logical = window
        .inner_size()
        .map(|s| s.width as f64 / scale)
        .unwrap_or(crate::popup_sizing::DEFAULT_W);
    let target_ph = (capped * scale).round() as u32;
    let target_pw = (current_w_logical * scale).round() as u32;

    translate_popup_mark_programmatic();
    let _ = window.set_size(PhysicalSize::new(target_pw, target_ph));

    // Re-clamp Y so a growth does not push the bottom off-screen. Keep X.
    if let Ok(pos) = window.outer_position() {
        if let Some(monitor) = window.current_monitor().ok().flatten() {
            let m_pos = monitor.position();
            let m_size = monitor.size();
            let monitor_bottom = m_pos.y as f64 + m_size.height as f64;
            let popup_bottom = pos.y as f64 + target_ph as f64;
            if popup_bottom > monitor_bottom {
                let new_y = monitor_bottom - target_ph as f64 - 10.0 * scale;
                let clamped_y = new_y.max(m_pos.y as f64 + 10.0 * scale);
                let _ = window.set_position(PhysicalPosition::new(pos.x as f64, clamped_y));
            }
        }
    }
    Ok(())
}

// ── Chat popup ────────────────────────────────────────────────────────────────

/// Pulled after the chat's listeners are ready, including when a second hotkey
/// arrives while the existing webview is still loading.
#[derive(Default)]
pub struct PendingChatSelection(pub Mutex<Option<String>>);

/// Create the chat popup or bring its existing conversation back into view.
/// `selected`: captured selection text (may be empty → free chat)
/// `cursor_x`, `cursor_y`: cursor position in PHYSICAL screen pixels
pub fn show_chat_popup(
    app: &AppHandle,
    selected: &str,
    cursor_x: f64,
    cursor_y: f64,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("chat-popup") {
        if !selected.trim().is_empty() {
            *app.state::<PendingChatSelection>()
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(selected.to_string());
            let _ = window.emit("chat://selection-available", ());
        }
        let _ = window.unminimize();
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }

    *app.state::<PendingChatSelection>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
    show_cursor_popup(
        app,
        PopupSpec {
            label: "chat-popup",
            title: "ContextKey — Chat",
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
        .title("ContextKey")
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
        .title("ContextKey — Settings")
        .inner_size(600.0, 680.0)
        .min_inner_size(360.0, 420.0)
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
