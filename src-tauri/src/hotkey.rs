//! Global hotkey engine — table-driven, configurable.
//!
//! Observes key events from the passive, non-suppressing hook in `keyhook`. The
//! state machine interprets a parsed hotkey table (hot-swappable via ArcSwap)
//! rather than hardcoded key sequences.
//!
//! Every hotkey is a two-step sequence: prefix → then, within a time window.
//! Double-tap is the degenerate case where prefix == then (requires a KeyRelease
//! between the two presses to filter out key-repeat).
//!
//! Ctrl state is queried live (`keyhook::ctrl_is_down`) to avoid stuck-key desync
//! from missed KeyRelease events.
//!
//! The hook is installed once for the life of the process — this single thread
//! handles all hotkey detection.

use arc_swap::ArcSwap;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::config::HotkeyConfig;
use crate::keyhook::{self, KeyEvent, Vk};

// ── Actions ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Translate,
    Chat,
    Screenshot,
}

// ── Parsed prefix representation ─────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedPrefix {
    pub key: Vk,
    pub requires_ctrl: bool,
}

// ── Parsed hotkey entry ──────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ParsedEntry {
    pub prefix: ParsedPrefix,
    pub then_key: Vk,
    pub then_requires_ctrl: bool,
    pub window_ms: u16,
    pub action: Action,
    pub is_double_tap: bool,
}

// ── Parsed hotkey table ──────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ParsedHotkeys {
    pub entries: Vec<ParsedEntry>,
    pub no_reset_keys: HashSet<Vk>,
}

impl ParsedHotkeys {
    pub fn from_config(cfg: &HotkeyConfig) -> Self {
        let raw = [
            (&cfg.translate, Action::Translate),
            (&cfg.chat, Action::Chat),
            (&cfg.screenshot, Action::Screenshot),
        ];

        let mut entries = Vec::with_capacity(3);
        let mut no_reset_keys: HashSet<Vk> = HashSet::new();

        // Always exempt modifier keys from resetting armed state
        for k in [
            keyhook::VK_CONTROL, keyhook::VK_LCONTROL, keyhook::VK_RCONTROL,
            keyhook::VK_SHIFT, keyhook::VK_LSHIFT, keyhook::VK_RSHIFT,
            keyhook::VK_MENU, keyhook::VK_LMENU, keyhook::VK_RMENU,
            keyhook::VK_LWIN, keyhook::VK_RWIN,
            keyhook::VK_CAPITAL,
        ] {
            no_reset_keys.insert(k);
        }

        for (entry, action) in raw {
            let prefix = parse_prefix(&entry.prefix);
            let (then_key, then_requires_ctrl) = parse_then(&entry.then, &entry.prefix);
            let is_double_tap = prefix.key == then_key
                && prefix.requires_ctrl == then_requires_ctrl;

            // Keys involved in any hotkey should not reset armed state
            no_reset_keys.insert(prefix.key);
            no_reset_keys.insert(then_key);

            entries.push(ParsedEntry {
                prefix,
                then_key,
                then_requires_ctrl,
                window_ms: entry.window_ms,
                action,
                is_double_tap,
            });
        }

        ParsedHotkeys { entries, no_reset_keys }
    }
}

fn parse_prefix(s: &str) -> ParsedPrefix {
    match s {
        "Ctrl+C" => ParsedPrefix { key: keyhook::VK_C, requires_ctrl: true },
        "Ctrl+Insert" => ParsedPrefix { key: keyhook::VK_INSERT, requires_ctrl: true },
        "RCtrl" => ParsedPrefix { key: keyhook::VK_RCONTROL, requires_ctrl: false },
        "RShift" => ParsedPrefix { key: keyhook::VK_RSHIFT, requires_ctrl: false },
        _ => ParsedPrefix { key: keyhook::VK_C, requires_ctrl: true }, // fallback
    }
}

/// Whether a "then" key name can be mapped to a virtual-key code.
///
/// Config validation calls this to reject an unmappable name at save/load time.
/// Otherwise it resolves to 0, which no real event carries — the hotkey would
/// save fine and then silently never fire, with nothing to tell the user why.
///
/// The accepted set MUST stay in sync with `SUPPORTED_THEN` in `frontend/settings.js`.
pub fn is_supported_then(then: &str) -> bool {
    then == "RCtrl" || then == "RShift" || map_then_key(then).is_some()
}

fn parse_then(then: &str, prefix: &str) -> (Vk, bool) {
    // For double-tap patterns, the "then" key is the same as the prefix key
    if then == "RCtrl" {
        return (keyhook::VK_RCONTROL, false);
    }
    if then == "RShift" {
        return (keyhook::VK_RSHIFT, false);
    }

    // For prefix "Ctrl+C" / "Ctrl+Insert", Ctrl is still held when "then" fires
    let ctrl = prefix.starts_with("Ctrl+");

    // Unreachable for a validated config — is_supported_then gates every write.
    (map_then_key(then).unwrap_or(0), ctrl)
}

fn map_then_key(then: &str) -> Option<Vk> {
    match then {
        "Space" => Some(keyhook::VK_SPACE),
        "Insert" => Some(keyhook::VK_INSERT),
        _ => {
            let mut chars = then.chars();
            let first = chars.next()?;
            let rest = chars.as_str();

            if rest.is_empty() {
                return keyhook::vk_letter(first).or_else(|| keyhook::vk_digit(first));
            }
            // F1–F12. Reject anything `u8::parse` would otherwise accept, such as
            // a leading '+' or whitespace, so the set matches SUPPORTED_THEN exactly.
            if first == 'F' && rest.chars().all(|c| c.is_ascii_digit()) {
                return keyhook::vk_function(rest.parse().ok()?);
            }
            None
        }
    }
}

// ── Shared state ─────────────────────────────────────────────────────────────

struct HotkeyState {
    armed_prefix: Option<(Vk, bool, Instant)>, // (prefix_key, requires_ctrl, arm_time)
    last_trigger_time: Option<Instant>,
    prefix_released: bool, // for double-tap key-repeat filtering
}

impl HotkeyState {
    fn new() -> Self {
        HotkeyState {
            armed_prefix: None,
            last_trigger_time: None,
            prefix_released: false,
        }
    }
}

// ── Spawn ────────────────────────────────────────────────────────────────────

pub fn spawn_hotkey_listener(app: AppHandle, hotkeys: Arc<ArcSwap<ParsedHotkeys>>) {
    std::thread::Builder::new()
        .name("keyhook-listener".into())
        .spawn(move || {
            let state = Mutex::new(HotkeyState::new());

            keyhook::install(move |event| match event {
                KeyEvent::Press(key) => on_key_press(key, &state, &app, &hotkeys),
                KeyEvent::Release(key) => on_key_release(key, &state),
            });
        })
        .expect("failed to spawn keyhook-listener thread");
}

// ── Key release handler (for double-tap filtering) ───────────────────────────

fn on_key_release(key: Vk, state: &Mutex<HotkeyState>) {
    let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
    // If the released key matches the armed prefix key, mark released
    if let Some((prefix_key, _, _)) = s.armed_prefix {
        if key == prefix_key {
            s.prefix_released = true;
        }
    }
}

// ── Key press handler ────────────────────────────────────────────────────────

fn on_key_press(
    key: Vk,
    state: &Mutex<HotkeyState>,
    app: &AppHandle,
    hotkeys: &ArcSwap<ParsedHotkeys>,
) {
    let table = hotkeys.load();
    let now = Instant::now();

    let mut s = state.lock().unwrap_or_else(|e| e.into_inner());

    // Debounce: ignore everything within 0.4s of last trigger
    if let Some(last) = s.last_trigger_time {
        if now.duration_since(last) < Duration::from_millis(400) {
            return;
        }
    }

    // Check if this key press matches any "then" for the currently armed prefix
    if let Some((armed_key, armed_ctrl, arm_time)) = s.armed_prefix {
        for entry in &table.entries {
            if entry.prefix.key != armed_key || entry.prefix.requires_ctrl != armed_ctrl {
                continue;
            }
            let window = Duration::from_millis(entry.window_ms as u64);
            if now.duration_since(arm_time) >= window {
                continue;
            }

            // Check if this key matches the "then" for this entry
            let key_matches = key == entry.then_key;
            let ctrl_ok = !entry.then_requires_ctrl || keyhook::ctrl_is_down();

            if key_matches && ctrl_ok {
                // Double-tap: require a release between the two presses
                if entry.is_double_tap && !s.prefix_released {
                    continue;
                }

                // FIRE
                s.armed_prefix = None;
                s.last_trigger_time = Some(now);
                s.prefix_released = false;
                let action = entry.action;
                drop(s);

                fire_action(action, app);
                return;
            }
        }
    }

    // Check if this key press matches any prefix → arm
    let ctrl_down = keyhook::ctrl_is_down();
    for entry in &table.entries {
        let prefix_matches = key == entry.prefix.key;
        let ctrl_ok = !entry.prefix.requires_ctrl || ctrl_down;

        if prefix_matches && ctrl_ok {
            s.armed_prefix = Some((entry.prefix.key, entry.prefix.requires_ctrl, now));
            s.prefix_released = false;
            return;
        }
    }

    // If the key is not in no_reset_keys, clear armed state
    if !table.no_reset_keys.contains(&key) {
        s.armed_prefix = None;
        s.prefix_released = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact set `SUPPORTED_THEN` in `frontend/settings.js` offers. A name
    /// accepted there but rejected here saves fine and then never fires, so this
    /// list is the contract between the two.
    fn supported_then_names() -> Vec<String> {
        let mut names = vec![
            "RCtrl".to_string(),
            "RShift".to_string(),
            "Space".to_string(),
            "Insert".to_string(),
        ];
        names.extend(('A'..='Z').map(|c| c.to_string()));
        names.extend(('0'..='9').map(|c| c.to_string()));
        names.extend((1..=12).map(|n| format!("F{n}")));
        names
    }

    #[test]
    fn every_frontend_then_key_is_accepted() {
        for name in supported_then_names() {
            assert!(
                is_supported_then(&name),
                "settings.js offers {name:?} but the backend rejects it"
            );
        }
    }

    #[test]
    fn every_accepted_then_key_resolves_to_a_real_vk() {
        for name in supported_then_names() {
            let (vk, _) = parse_then(&name, "Ctrl+C");
            assert_ne!(vk, 0, "{name:?} resolved to 0, which no key event carries");
        }
    }

    #[test]
    fn unsupported_then_keys_are_rejected() {
        // F0/F13 are out of range; the rest are shapes a looser parser would let
        // through (whitespace, sign, leading zero, lowercase, non-ASCII digits).
        for name in [
            "", "F0", "F13", "F 1", "F+1", "F١", "LCtrl", "Up", "Numpad0", "c", "AB", " C",
        ] {
            assert!(!is_supported_then(name), "{name:?} should be unsupported");
        }
    }

    #[test]
    fn letters_and_digits_map_to_ascii_vk() {
        assert_eq!(map_then_key("C"), Some(keyhook::VK_C));
        assert_eq!(map_then_key("A"), Some(0x41));
        assert_eq!(map_then_key("Z"), Some(0x5A));
        assert_eq!(map_then_key("0"), Some(0x30));
        assert_eq!(map_then_key("9"), Some(0x39));
        assert_eq!(map_then_key("F1"), Some(0x70));
        assert_eq!(map_then_key("F12"), Some(0x7B));
    }

    #[test]
    fn default_bindings_parse_as_expected() {
        let parsed = ParsedHotkeys::from_config(&HotkeyConfig::default());
        assert_eq!(parsed.entries.len(), 3);

        let translate = &parsed.entries[0];
        assert_eq!(translate.action, Action::Translate);
        assert_eq!(translate.prefix.key, keyhook::VK_C);
        assert!(translate.prefix.requires_ctrl);
        assert!(
            translate.is_double_tap,
            "Ctrl+C then C is a double-tap, so it must require a key release"
        );

        // Screenshot defaults to RCtrl twice: a modifier as its own "then".
        let screenshot = &parsed.entries[2];
        assert_eq!(screenshot.action, Action::Screenshot);
        assert_eq!(screenshot.then_key, keyhook::VK_RCONTROL);
        assert!(screenshot.is_double_tap);
        assert!(!screenshot.then_requires_ctrl);
    }

    #[test]
    fn modifiers_never_reset_the_armed_prefix() {
        // Typing a modifier between prefix and "then" must not disarm, or no
        // Ctrl-prefixed binding could ever complete.
        let parsed = ParsedHotkeys::from_config(&HotkeyConfig::default());
        for vk in [
            keyhook::VK_CONTROL, keyhook::VK_LCONTROL, keyhook::VK_RCONTROL,
            keyhook::VK_SHIFT, keyhook::VK_LSHIFT, keyhook::VK_RSHIFT,
            keyhook::VK_MENU, keyhook::VK_LMENU, keyhook::VK_RMENU,
            keyhook::VK_LWIN, keyhook::VK_RWIN, keyhook::VK_CAPITAL,
        ] {
            assert!(parsed.no_reset_keys.contains(&vk), "VK {vk:#04X} should not reset");
        }
    }
}

fn fire_action(action: Action, app: &AppHandle) {
    let app_handle = app.clone();
    match action {
        Action::Translate => {
            tauri::async_runtime::spawn(async move {
                crate::handle_translate_trigger(app_handle).await;
            });
        }
        Action::Chat => {
            tauri::async_runtime::spawn(async move {
                crate::handle_chat_trigger(app_handle).await;
            });
        }
        Action::Screenshot => {
            tauri::async_runtime::spawn(async move {
                crate::handle_screenshot_trigger(app_handle).await;
            });
        }
    }
}
