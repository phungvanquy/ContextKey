// Prevent a console window on Windows
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod clipboard;
mod config;
mod hotkey;
mod keyhook;
mod popup_sizing;
mod screenshot;
mod storage;
mod tts;
#[cfg(windows)]
mod webview_runtime;
mod window_state;
mod windows;

use arc_swap::ArcSwap;
use config::{Config, ConfigState, ConfigUpdate};
use hotkey::ParsedHotkeys;
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Listener, Manager,
};

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Return the current config to the Settings UI.
#[tauri::command]
fn get_config(state: tauri::State<'_, ConfigState>) -> Config {
    state.get()
}

/// Save updated config fields from the Settings UI.
#[tauri::command]
fn update_config(
    app: AppHandle,
    state: tauri::State<'_, ConfigState>,
    update: ConfigUpdate,
) -> Result<(), String> {
    state.update(update)?;
    // Hot-swap the parsed hotkey table
    let new_cfg = state.get();
    let parsed = ParsedHotkeys::from_config(&new_cfg.hotkeys);
    let hotkey_state = app.state::<Arc<ArcSwap<ParsedHotkeys>>>();
    hotkey_state.store(Arc::new(parsed));
    // Tauri updates existing windows and the default for future windows.
    // On Windows, this also updates WebView2's prefers-color-scheme value.
    app.set_theme(new_cfg.theme.native());
    Ok(())
}

/// Open (or focus) the settings window.
#[tauri::command]
fn open_settings_cmd(app: AppHandle) -> Result<(), String> {
    windows::show_settings_window(&app)
}

/// Hand the pending cropped screenshot to a freshly opened chat popup, clearing
/// it so it is delivered exactly once.
///
/// Pull model for the same reason as get_overlay_preview: a backend emit timed
/// against webview startup gets dropped. Taking rather than cloning also stops a
/// leftover crop from re-attaching itself to an unrelated later chat session.
#[tauri::command]
fn take_pending_image(
    state: tauri::State<'_, screenshot::ScreenshotStore>,
) -> Option<String> {
    let mut guard = state.0.lock().unwrap();
    guard.as_mut().and_then(|s| s.prepared_image.take())
}

#[tauri::command]
fn take_pending_chat_selection(
    state: tauri::State<'_, windows::PendingChatSelection>,
) -> Option<String> {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).take()
}

/// Return the frozen screenshot preview for one overlay window.
///
/// Pull model, not push: the overlay calls this once its listeners/canvas are
/// ready. An emit from the backend would race WebView2 startup and be dropped
/// (Tauri events are not buffered), leaving the overlay black.
#[tauri::command]
fn get_overlay_preview(
    state: tauri::State<'_, screenshot::ScreenshotStore>,
    monitor_index: usize,
) -> Result<String, String> {
    let guard = state.0.lock().unwrap();
    let s = guard.as_ref().ok_or_else(|| "no screenshot in flight".to_string())?;
    s.previews
        .get(monitor_index)
        .cloned()
        .ok_or_else(|| format!("no preview for monitor {monitor_index}"))
}

/// Test the given endpoint/key/model with a minimal live request (Settings UI).
/// Takes current-form values so the user can test before saving.
#[tauri::command]
async fn test_connection(
    state: tauri::State<'_, api::HttpClient>,
    base_url: String,
    api_key: String,
    model: String,
) -> Result<String, String> {
    api::test_connection(&state.0, base_url, api_key, model).await
}

// ── Translate trigger ─────────────────────────────────────────────────────────

/// Called from hotkey.rs via tauri::async_runtime when Ctrl+C+C fires.
pub async fn handle_translate_trigger(app: AppHandle) {
    let (cx, cy) = keyhook::cursor_pos();
    let cfg = app.state::<ConfigState>().get();

    // Spawn clipboard polling on a blocking thread — runs concurrently with
    // the ready-listener setup below. The window needs the text for its query
    // string, so we await clipboard before building, but the spawn starts the
    // work immediately rather than blocking the async task.
    let clipboard_fut = tokio::task::spawn_blocking(clipboard::get_clipboard_after_copy);

    // Register the readiness listener BEFORE creating the popup, so we can't
    // miss the popup://ready event the webview emits once its listeners are up.
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
    let ready_tx = std::sync::Mutex::new(Some(ready_tx));
    let ready_handler = app.once_any("popup://ready", move |_event| {
        if let Some(tx) = ready_tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
    });

    // Await clipboard result
    let text = clipboard_fut.await.unwrap_or_default();

    if text.trim().is_empty() {
        app.unlisten(ready_handler);
        // A hotkey that does nothing at all reads as a dead app, so say why.
        windows::show_toast(&app, "No text selected", cx, cy);
        return;
    }

    // Create the popup window
    if let Err(e) = windows::show_translate_popup(&app, &text, &cfg.target_language, cx, cy) {
        eprintln!("popup error: {e}");
        app.unlisten(ready_handler);
        windows::show_toast(&app, "Could not open the translation popup", cx, cy);
        return;
    }

    // Wait for the webview to signal it has attached its event listeners.
    let _ = tokio::time::timeout(std::time::Duration::from_millis(2000), ready_rx).await;
    app.unlisten(ready_handler);

    let popup_window = match app.get_webview_window("translate-popup") {
        Some(w) => w,
        None => return,
    };

    let client = app.state::<api::HttpClient>();
    let registry = app.state::<api::StreamRegistry>();
    api::translate_stream(text, cfg, &client.0, popup_window, registry.inner()).await;
}

// ── Chat trigger ────────────────────────────────────────────────────────────────

/// Called from hotkey.rs when Ctrl+C+Space fires.
/// Captures the selection, opens the chat popup (even for an empty selection —
/// that becomes free chat), and lets the frontend drive requests via chat_send.
pub async fn handle_chat_trigger(app: AppHandle) {
    let (cx, cy) = keyhook::cursor_pos();

    // Spawn clipboard polling immediately — runs while we prepare
    let clipboard_fut = tokio::task::spawn_blocking(clipboard::get_clipboard_after_copy);

    // Await clipboard (chat accepts empty — still opens in free-chat mode)
    let selected = clipboard_fut.await.unwrap_or_default();

    if let Err(e) = windows::show_chat_popup(&app, &selected, cx, cy) {
        eprintln!("chat popup error: {e}");
        windows::show_toast(&app, "Could not open the chat popup", cx, cy);
    }
}

// ── Chat command (frontend-driven) ────────────────────────────────────────────

/// Re-run a failed translation for the same text, without needing the user to
/// re-select it. The popup already holds the original text, so no backend state
/// has to survive the failure.
#[tauri::command]
async fn translate_retry(app: AppHandle, text: String) -> Result<(), String> {
    let cfg = app.state::<ConfigState>().get();
    let window = app
        .get_webview_window("translate-popup")
        .ok_or_else(|| "translate popup window not found".to_string())?;
    let client = app.state::<api::HttpClient>();
    let registry = app.state::<api::StreamRegistry>();
    api::translate_stream(text, cfg, &client.0, window, registry.inner()).await;
    Ok(())
}

/// Stream a chat response for the conversation so far.
/// The frontend owns the conversation history and selected-text context; the
/// history's last entry is the question being asked, so there is no separate
/// question parameter to keep in sync with it.
#[tauri::command]
async fn chat_send(
    app: AppHandle,
    selected_text: String,
    history: Vec<api::ChatMessage>,
) -> Result<(), String> {
    let cfg = app.state::<ConfigState>().get();
    let window = app
        .get_webview_window("chat-popup")
        .ok_or_else(|| "chat popup window not found".to_string())?;
    let client = app.state::<api::HttpClient>();
    let registry = app.state::<api::StreamRegistry>();
    api::chat_stream(selected_text, history, cfg, &client.0, window, registry.inner()).await;
    Ok(())
}

// ── Screenshot trigger ───────────────────────────────────────────────────────

pub async fn handle_screenshot_trigger(app: AppHandle) {
    let (cx, cy) = keyhook::cursor_pos();

    // Capture all monitors
    let captures = match screenshot::capture_all_monitors() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("screenshot capture failed: {e}");
            windows::show_toast(&app, "Screen capture failed", cx, cy);
            return;
        }
    };

    if captures.is_empty() {
        eprintln!("no monitors captured");
        windows::show_toast(&app, "Screen capture failed — no monitors found", cx, cy);
        return;
    }

    // Encode a preview per monitor for the overlay to display
    let previews: Vec<String> = captures
        .iter()
        .map(|(_info, img)| screenshot::prepare_preview(img))
        .collect();
    let monitor_infos: Vec<screenshot::MonitorInfo> =
        captures.iter().map(|(info, _)| info.clone()).collect();

    // Store captures + previews BEFORE creating windows: each overlay pulls its
    // preview via get_overlay_preview as soon as its canvas is ready, which can
    // happen before this function returns.
    {
        let store = app.state::<screenshot::ScreenshotStore>();
        let mut guard = store.0.lock().unwrap();
        *guard = Some(screenshot::ScreenshotState::new(captures, previews));
    }

    // Open overlay windows
    if let Err(e) = windows::show_overlay_windows(&app, &monitor_infos) {
        eprintln!("overlay window error: {e}");
        {
            let store = app.state::<screenshot::ScreenshotStore>();
            let mut guard = store.0.lock().unwrap();
            *guard = None;
        }
        windows::show_toast(&app, "Could not open the selection overlay", cx, cy);
    }
}

// ── Overlay select handler ───────────────────────────────────────────────────

async fn handle_overlay_select(app: AppHandle, event: tauri::Event) {
    // Close overlay windows immediately
    windows::close_overlay_windows(&app);

    // Parse selection rect from event payload
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SelectPayload {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        viewport_w: f64,
        viewport_h: f64,
        monitor: usize,
    }

    let payload: SelectPayload = match serde_json::from_str(event.payload()) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("overlay select parse error: {e}");
            return;
        }
    };

    // Crop from the capture belonging to the monitor the user dragged on —
    // coordinates are relative to that overlay, so any other capture would
    // yield the wrong region on a multi-monitor setup.
    {
        let store = app.state::<screenshot::ScreenshotStore>();
        let mut guard = store.0.lock().unwrap();
        let state = match guard.as_mut() {
            Some(s) => s,
            None => {
                eprintln!("no screenshot state available");
                return;
            }
        };

        let img = match state.captures.get(payload.monitor) {
            Some((_, img)) => img,
            None => {
                eprintln!("no capture for monitor {}", payload.monitor);
                return;
            }
        };
        // Derive CSS→physical scale from the capture itself rather than trusting
        // the webview's devicePixelRatio, which can disagree with the monitor's
        // real scale factor. An under-estimated factor crops a smaller region
        // that prepare_for_api then upscales — the "zoomed in" symptom.
        let (img_w, img_h) = (img.width() as f64, img.height() as f64);
        let sx = if payload.viewport_w > 0.0 { img_w / payload.viewport_w } else { 1.0 };
        let sy = if payload.viewport_h > 0.0 { img_h / payload.viewport_h } else { 1.0 };

        let rect = screenshot::PhysicalRect {
            x: (payload.x * sx).round().max(0.0) as u32,
            y: (payload.y * sy).round().max(0.0) as u32,
            width: (payload.width * sx).round().max(1.0) as u32,
            height: (payload.height * sy).round().max(1.0) as u32,
        };

        let cropped = screenshot::crop_region(img, &rect);
        let url = screenshot::prepare_for_api(&cropped);
        state.prepared_image = Some(url);
    }

    // Wake an existing popup, but let it consume the pending crop by pull. If
    // its webview is still loading, init will pull after attaching listeners.
    if let Some(chat_window) = app.get_webview_window("chat-popup") {
        use tauri::Emitter;
        let _ = chat_window.emit("chat://image-available", ());
        let _ = chat_window.unminimize();
        let _ = chat_window.show();
        let _ = chat_window.set_focus();
    } else {
        // Open chat popup fresh; init consumes the pending image.
        let (cx, cy) = keyhook::cursor_pos();
        if let Err(e) = windows::show_chat_popup(&app, "", cx, cy) {
            eprintln!("chat popup error: {e}");
            windows::show_toast(&app, "Could not open the chat popup", cx, cy);
            return;
        }
        // Nothing to send: the popup pulls the crop via take_pending_image once
        // its listeners are up. Emitting here on a timer would race webview
        // startup and be dropped, since Tauri events are not buffered.
    }
}

// ── TTS commands ──────────────────────────────────────────────────────────────

#[tauri::command]
fn tts_speak(state: tauri::State<'_, tts::TtsHandle>, text: String) {
    state.speak(&text);
}

#[tauri::command]
fn tts_stop(state: tauri::State<'_, tts::TtsHandle>) {
    state.stop();
}

// ── Translate popup resize ────────────────────────────────────────────────────

/// Live resize request from the popup webview: it has measured its content and
/// asks the window to grow/shrink to fit, capped to the current monitor.
/// Safe to call after the popup closed (no-op).
#[tauri::command]
fn resize_translate_popup(app: AppHandle, content_logical_h: f64) -> Result<(), String> {
    windows::resize_translate_popup_to_content(&app, content_logical_h)
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() {
    // Check before settings migration, plugins, tray, hooks, or any webview.
    // Recovery must work even when the HTML interface cannot be created.
    #[cfg(windows)]
    if !webview_runtime::ensure_available() {
        return;
    }

    let cfg = config::load();
    let parsed_hotkeys = Arc::new(ArcSwap::from_pointee(
        ParsedHotkeys::from_config(&cfg.hotkeys),
    ));

    tauri::Builder::default()
        // Single instance MUST be the first plugin registered. A second launch
        // runs this callback in the primary instance instead of installing a
        // second global hook set (which would double-fire every hotkey).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // No main window to raise — surface Settings so the user sees the
            // app is already running.
            if let Err(e) = windows::show_settings_window(app) {
                eprintln!("single-instance settings error: {e}");
            }
        }))
        .manage(ConfigState::new(cfg.clone()))
        .manage(api::HttpClient::new())
        .manage(api::StreamRegistry::new())
        .manage(tts::TtsHandle::new())
        .manage(parsed_hotkeys.clone())
        .manage(screenshot::ScreenshotStore::new())
        .manage(windows::PendingChatSelection::default())
        .setup(move |app| {
            // Set the saved preference before any window is created. None
            // restores live system-theme tracking; no window overrides it.
            app.set_theme(cfg.theme.native());

            // ── Tray menu ──────────────────────────────────────────────────────
            let menu = Menu::new(app.handle())?;

            let settings_item = MenuItem::with_id(
                app.handle(),
                "settings",
                "Settings",
                true,
                None::<&str>,
            )?;
            let quit_item = MenuItem::with_id(
                app.handle(),
                "quit",
                "Quit",
                true,
                None::<&str>,
            )?;

            menu.append(&settings_item)?;
            menu.append(&quit_item)?;

            // ── Tray icon ──────────────────────────────────────────────────────
            let icon = app
                .default_window_icon()
                .cloned()
                .unwrap_or_else(|| {
                    // Fallback: 16×16 solid white RGBA square
                    let rgba = vec![0xffu8; 16 * 16 * 4];
                    tauri::image::Image::new_owned(rgba, 16, 16)
                });

            TrayIconBuilder::new()
                .menu(&menu)
                .icon(icon)
                .tooltip("ContextKey")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "settings" => {
                        if let Err(e) = windows::show_settings_window(app) {
                            eprintln!("settings window error: {e}");
                        }
                    }
                    "quit" => {
                        // Signal hotkey thread to stop (best-effort) then exit
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app.handle())?;

            // ── First-run: open settings if no API key ─────────────────────────
            let api_key_empty = app
                .state::<ConfigState>()
                .get()
                .api_key
                .trim()
                .is_empty();

            if api_key_empty {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                    if let Err(e) = windows::show_settings_window(&app_handle) {
                        eprintln!("first-run settings error: {e}");
                    }
                });
            }

            // ── Overlay events (screenshot selection) ──────────────────────────
            let app_select = app.handle().clone();
            app.listen_any("overlay://select", move |event| {
                let app = app_select.clone();
                tauri::async_runtime::spawn(async move {
                    handle_overlay_select(app, event).await;
                });
            });

            let app_cancel = app.handle().clone();
            app.listen_any("overlay://cancel", move |_event| {
                windows::close_overlay_windows(&app_cancel);
                let store = app_cancel.state::<screenshot::ScreenshotStore>();
                let mut guard = store.0.lock().unwrap();
                *guard = None;
            });

            let app_closed = app.handle().clone();
            app.listen_any("chat://closed", move |_event| {
                *app_closed.state::<windows::PendingChatSelection>()
                    .0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = None;
                let store = app_closed.state::<screenshot::ScreenshotStore>();
                let mut guard = store.0.lock().unwrap();
                *guard = None;
            });

            // ── Install the global keyboard hook ───────────────────────────────
            let app_handle = app.handle().clone();
            hotkey::spawn_hotkey_listener(app_handle, parsed_hotkeys.clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            update_config,
            open_settings_cmd,
            get_overlay_preview,
            take_pending_image,
            take_pending_chat_selection,
            chat_send,
            translate_retry,
            test_connection,
            tts_speak,
            tts_stop,
            resize_translate_popup
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Tray app: having no open windows is normal, so closing the last
            // popup/settings window must NOT quit the process. ExitRequested
            // fires with code == None on window-close (prevent it) and with
            // Some(_) only when we call app.exit() from the tray Quit item.
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                } else {
                    // Real exit (tray Quit): release the global hook rather than
                    // leaving it for process teardown to clean up.
                    keyhook::uninstall();
                }
            }
        });
}
