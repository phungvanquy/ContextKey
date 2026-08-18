//! Persistence for the translate-popup's manually-resized size.
//!
//! Stored beside the main config (<home>/.quicktranslator_window_state.json) so
//! the Python config file is not extended. Logical pixels only; validated on
//! load so a corrupted/tampered file silently falls back to the estimate.

use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

const FILE_NAME: &str = ".quicktranslator_window_state.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogicalSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct WindowState {
    translate_popup: Option<LogicalSize>,
}

pub fn state_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(FILE_NAME)
}

/// Load the persisted translate-popup size. Returns `None` on any malformed,
/// missing, or out-of-range data.
pub fn load_translate_popup_size() -> Option<LogicalSize> {
    let text = fs::read_to_string(state_path()).ok()?;
    let state: WindowState = serde_json::from_str(&text).ok()?;
    let size = state.translate_popup?;
    if !size.width.is_finite() || !size.height.is_finite() {
        return None;
    }
    if !(crate::popup_sizing::MIN_W..=1600.0).contains(&size.width)
        || !(crate::popup_sizing::MIN_H..=1200.0).contains(&size.height)
    {
        return None;
    }
    Some(size)
}

/// Persist the translate-popup size. Best-effort; write failures are ignored
/// by the caller (mirrors `config::save_to_disk` error handling style).
pub fn save_translate_popup_size(size: LogicalSize) -> Result<(), String> {
    if !size.width.is_finite() || !size.height.is_finite() {
        return Err("non-finite size".into());
    }
    let path = state_path();
    let state = WindowState {
        translate_popup: Some(size),
    };
    let json =
        serde_json::to_string_pretty(&state).map_err(|e| format!("serialise: {e}"))?;
    // Atomic write via a temporary file + rename.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}
