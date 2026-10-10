//! Configuration management with compatibility for the former app's JSON schema.
//! Persists to ~/.contextkey_config.json and imports the legacy file on first load.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

// ── Defaults (must match config.py exactly) ───────────────────────────────────

fn default_api_key() -> String {
    String::new()
}

fn default_base_url() -> String {
    "https://api.openai.com/v1".to_string()
}

fn default_target_language() -> String {
    "Vietnamese".to_string()
}

fn default_model() -> String {
    "gpt-4o-mini".to_string()
}

fn default_custom_prompt() -> String {
    "You are a translator. Translate the user's text to {target_language}. \
     Reply with ONLY the translation — no explanations, no notes."
        .to_string()
}

// ── Hotkey configuration ─────────────────────────────────────────────────────

/// Allowed prefix values. Only these are accepted by validation.
pub const HOTKEY_PREFIX_WHITELIST: &[&str] = &["Ctrl+C", "Ctrl+Insert", "RCtrl", "RShift"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HotkeyEntry {
    pub prefix: String,
    pub then: String,
    pub window_ms: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HotkeyConfig {
    #[serde(default = "default_hotkey_translate")]
    pub translate: HotkeyEntry,
    #[serde(default = "default_hotkey_chat")]
    pub chat: HotkeyEntry,
    #[serde(default = "default_hotkey_screenshot")]
    pub screenshot: HotkeyEntry,
}

fn default_hotkey_translate() -> HotkeyEntry {
    HotkeyEntry {
        prefix: "Ctrl+C".into(),
        then: "C".into(),
        window_ms: 600,
    }
}

fn default_hotkey_chat() -> HotkeyEntry {
    HotkeyEntry {
        prefix: "Ctrl+C".into(),
        then: "Space".into(),
        window_ms: 600,
    }
}

fn default_hotkey_screenshot() -> HotkeyEntry {
    HotkeyEntry {
        prefix: "RCtrl".into(),
        then: "RCtrl".into(),
        window_ms: 400,
    }
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        HotkeyConfig {
            translate: default_hotkey_translate(),
            chat: default_hotkey_chat(),
            screenshot: default_hotkey_screenshot(),
        }
    }
}

impl HotkeyConfig {
    /// Validate hotkey configuration. Returns Ok(()) if valid, or a list of problems.
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();
        let entries = [
            ("translate", &self.translate),
            ("chat", &self.chat),
            ("screenshot", &self.screenshot),
        ];

        for (name, entry) in &entries {
            if !HOTKEY_PREFIX_WHITELIST.contains(&entry.prefix.as_str()) {
                errors.push(format!(
                    "{name}: prefix '{}' not in whitelist {:?}",
                    entry.prefix, HOTKEY_PREFIX_WHITELIST
                ));
            }
            if !(200..=1000).contains(&entry.window_ms) {
                errors.push(format!(
                    "{name}: window_ms {} out of range [200, 1000]",
                    entry.window_ms
                ));
            }
            if entry.then.is_empty() {
                errors.push(format!("{name}: 'then' key is empty"));
            } else if !crate::hotkey::is_supported_then(&entry.then) {
                // An unmappable key parses to Key::Unknown, which no real event
                // carries: the hotkey would never fire and show no reason why.
                errors.push(format!(
                    "{name}: 'then' key '{}' is not supported",
                    entry.then
                ));
            }
        }

        // Check for duplicate (prefix, then) pairs
        let mut seen = HashSet::new();
        for (name, entry) in &entries {
            let key = (entry.prefix.as_str(), entry.then.as_str());
            if !seen.insert(key) {
                errors.push(format!(
                    "{name}: duplicate combo ({}, {})",
                    entry.prefix, entry.then
                ));
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

// ── Appearance ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

impl ThemePreference {
    pub fn native(self) -> Option<tauri::Theme> {
        match self {
            Self::System => None,
            Self::Light => Some(tauri::Theme::Light),
            Self::Dark => Some(tauri::Theme::Dark),
        }
    }
}

// ── Config struct ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "default_api_key")]
    pub api_key: String,

    #[serde(default = "default_base_url")]
    pub base_url: String,

    #[serde(default = "default_target_language")]
    pub target_language: String,

    #[serde(default = "default_model")]
    pub model: String,

    #[serde(default)]
    pub vision_model: String,

    #[serde(default = "default_custom_prompt")]
    pub custom_prompt: String,

    #[serde(default)]
    pub hotkeys: HotkeyConfig,

    #[serde(default)]
    pub theme: ThemePreference,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            api_key: default_api_key(),
            base_url: default_base_url(),
            target_language: default_target_language(),
            model: default_model(),
            vision_model: String::new(),
            custom_prompt: default_custom_prompt(),
            hotkeys: HotkeyConfig::default(),
            theme: ThemePreference::default(),
        }
    }
}

// ── File path ─────────────────────────────────────────────────────────────────

pub fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".contextkey_config.json")
}

// ── Load (mirrors load_config in config.py) ───────────────────────────────────
/// Load config from disk.
/// - If file exists and parses: serde fills missing keys with defaults.
/// - If only the legacy file exists: import it before applying the same validation.
/// - If both files are absent: write defaults to disk, return defaults.
/// - If file is malformed: return defaults WITHOUT overwriting.
pub fn load() -> Config {
    let path = config_path();

    match crate::storage::read_with_legacy(&path, ".quicktranslator_config.json") {
        Ok(text) => match serde_json::from_str::<Config>(&text) {
            Ok(mut cfg) => {
                if let Err(errors) = cfg.hotkeys.validate() {
                    eprintln!(
                        "hotkey config invalid, using defaults: {}",
                        errors.join("; ")
                    );
                    cfg.hotkeys = HotkeyConfig::default();
                }
                return cfg;
            }
            // Malformed — return defaults, do NOT overwrite.
            Err(_) => return Config::default(),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Config::default(),
    }

    // Both files absent — write defaults then return them
    let defaults = Config::default();
    let _ = save_to_disk(&defaults); // best-effort; ignore error
    defaults
}

// ── Save (mirrors save_config in config.py) ───────────────────────────────────
/// Write config as pretty-printed, UTF-8, non-ASCII-escaped JSON.
/// serde_json does not \u-escape non-ASCII by default, satisfying ensure_ascii=False.
pub fn save_to_disk(cfg: &Config) -> Result<(), String> {
    let path = config_path();
    let json = serde_json::to_string_pretty(cfg).map_err(|e| format!("serialise error: {e}"))?;
    fs::write(&path, json.as_bytes()).map_err(|e| format!("write error: {e}"))
}

// ── Tauri-managed state ───────────────────────────────────────────────────────

/// Thread-safe config state stored in Tauri's managed state.
pub struct ConfigState(pub Mutex<Config>);

impl ConfigState {
    pub fn new(cfg: Config) -> Self {
        ConfigState(Mutex::new(cfg))
    }

    pub fn get(&self) -> Config {
        self.0.lock().unwrap().clone()
    }

    pub fn update(&self, partial: ConfigUpdate) -> Result<(), String> {
        self.update_with_save(partial, save_to_disk)
    }

    fn update_with_save(
        &self,
        partial: ConfigUpdate,
        save: impl FnOnce(&Config) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut cfg = self.0.lock().unwrap();
        // Keep the live settings unchanged if validation or persistence fails.
        let mut next = cfg.clone();
        if let Some(v) = partial.api_key {
            next.api_key = v;
        }
        if let Some(v) = partial.base_url {
            next.base_url = v;
        }
        if let Some(v) = partial.target_language {
            next.target_language = v;
        }
        if let Some(v) = partial.model {
            next.model = v;
        }
        if let Some(v) = partial.vision_model {
            next.vision_model = v;
        }
        if let Some(v) = partial.custom_prompt {
            next.custom_prompt = v;
        }
        if let Some(v) = partial.hotkeys {
            if let Err(errors) = v.validate() {
                return Err(format!("hotkey config invalid: {}", errors.join("; ")));
            }
            next.hotkeys = v;
        }
        if let Some(v) = partial.theme {
            next.theme = v;
        }
        save(&next)?;
        *cfg = next;
        Ok(())
    }
}

/// Partial update payload from the Settings UI — all fields optional.
#[derive(Debug, Deserialize)]
pub struct ConfigUpdate {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub target_language: Option<String>,
    pub model: Option<String>,
    pub vision_model: Option<String>,
    pub custom_prompt: Option<String>,
    pub hotkeys: Option<HotkeyConfig>,
    pub theme: Option<ThemePreference>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_config_defaults_to_system_without_losing_settings() {
        let cfg: Config = serde_json::from_str(
            r#"{"api_key":"existing-key","model":"existing-model","target_language":"French"}"#,
        )
        .unwrap();
        assert_eq!(cfg.theme, ThemePreference::System);
        assert_eq!(cfg.api_key, "existing-key");
        assert_eq!(cfg.model, "existing-model");
        assert_eq!(cfg.target_language, "French");
    }

    #[test]
    fn saved_themes_round_trip_and_map_to_native_preferences() {
        for (value, preference, native) in [
            ("system", ThemePreference::System, None),
            ("light", ThemePreference::Light, Some(tauri::Theme::Light)),
            ("dark", ThemePreference::Dark, Some(tauri::Theme::Dark)),
        ] {
            let cfg = Config {
                theme: preference,
                ..Config::default()
            };
            let json = serde_json::to_value(&cfg).unwrap();
            assert_eq!(json["theme"], value);
            assert_eq!(
                serde_json::from_value::<Config>(json).unwrap().theme,
                preference
            );
            assert_eq!(preference.native(), native);
        }
    }

    #[test]
    fn invalid_theme_updates_are_rejected() {
        for value in [r#""sepia""#, "42", "{}"] {
            let json = format!(r#"{{"theme":{value}}}"#);
            assert!(serde_json::from_str::<ConfigUpdate>(&json).is_err());
        }
    }

    #[test]
    fn partial_updates_preserve_theme_and_theme_changes_are_persisted() {
        let state = ConfigState::new(Config {
            theme: ThemePreference::Dark,
            ..Config::default()
        });
        let update = serde_json::from_str(r#"{"model":"updated-model"}"#).unwrap();
        state
            .update_with_save(update, |cfg| {
                assert_eq!(cfg.theme, ThemePreference::Dark);
                assert_eq!(cfg.model, "updated-model");
                Ok(())
            })
            .unwrap();
        let update = serde_json::from_str(r#"{"theme":"light"}"#).unwrap();
        state
            .update_with_save(update, |cfg| {
                let saved = serde_json::to_string_pretty(cfg).unwrap();
                let reloaded: Config = serde_json::from_str(&saved).unwrap();
                assert_eq!(reloaded.theme, ThemePreference::Light);
                assert_eq!(reloaded.model, "updated-model");
                Ok(())
            })
            .unwrap();
        assert_eq!(state.get().theme, ThemePreference::Light);
    }

    #[test]
    fn failed_save_keeps_the_active_config_unchanged() {
        let state = ConfigState::new(Config::default());
        let before = serde_json::to_value(state.get()).unwrap();
        let update = serde_json::from_str(r#"{"theme":"dark","model":"updated-model"}"#).unwrap();
        let result = state.update_with_save(update, |_| Err("Disk full".into()));
        assert_eq!(result.unwrap_err(), "Disk full");
        assert_eq!(serde_json::to_value(state.get()).unwrap(), before);
    }

    #[test]
    fn invalid_hotkeys_do_not_partially_apply_settings() {
        let state = ConfigState::new(Config::default());
        let before = serde_json::to_value(state.get()).unwrap();
        let update = serde_json::from_str(
            r#"{"theme":"dark","model":"updated-model","hotkeys":{"translate":{"prefix":"invalid","then":"C","window_ms":600}}}"#,
        ).unwrap();
        let result =
            state.update_with_save(update, |_| panic!("invalid settings must not be saved"));
        assert!(result.is_err());
        assert_eq!(serde_json::to_value(state.get()).unwrap(), before);
    }
}
