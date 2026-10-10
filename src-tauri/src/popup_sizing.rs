//! Height estimate for the translate popup, computed before the window is built.
//!
//! The backend knows the source text at build time but not the translation, so
//! this is deliberately an estimate: it picks a starting height that is close
//! enough to avoid a visible flash, capped so a huge selection never overflows
//! the monitor. The frontend then corrects to the exact height as the stream
//! lands (see `resize_translate_popup`).
//!
//! All values are LOGICAL pixels. The caller converts to physical using the
//! cursor monitor's scale factor at the last possible moment.

/// Header + source card + footer + result padding + window border, in logical px.
/// Approximation of the fixed chrome in `popup.css`; only used for the estimate.
pub const CHROME_H: f64 = 220.0;
/// The compact layout in popup.css keeps short translations small.
const COMPACT_CHROME_H: f64 = 138.0;
const COMPACT_MAX_H: f64 = 240.0;

/// Rendered line height of `.translation-text` (14px font × 1.75 line-height).
pub const LINE_H: f64 = 24.5;

/// Usable content width: DEFAULT_W minus the result-area's 20px side padding ×2.
pub const CONTENT_W: f64 = 420.0;

/// Average advance width of one character at 14px in the system font. Chosen a
/// touch wide on purpose so the estimate errs tall rather than short.
pub const AVG_CHAR_W: f64 = 7.6;

/// Worst-case source→translation length expansion (e.g. English → German/Vietnamese).
pub const EXPANSION: f64 = 1.40;

/// The popup never grows past this fraction of the monitor's logical height.
pub const MAX_RATIO: f64 = 0.65;

pub const MIN_H: f64 = 160.0;
pub const MIN_W: f64 = 360.0;
pub const DEFAULT_W: f64 = 460.0;

const CHARS_PER_LINE: f64 = CONTENT_W / AVG_CHAR_W;
/// Extra allowance for the margins Markdown block elements introduce.
const BOTTOM_MARGIN: f64 = 8.0;

/// Count characters, not bytes — a Vietnamese string is mostly multi-byte.
pub fn chars_for_estimate(original: &str) -> usize {
    original.chars().count()
}

/// Height of the translated text block alone for a given source character count.
pub fn estimate_text_height(char_count: usize) -> f64 {
    if char_count == 0 {
        return LINE_H;
    }
    let expanded = (char_count as f64 * EXPANSION).ceil();
    let lines = (expanded / CHARS_PER_LINE).ceil().max(1.0);
    lines * LINE_H + BOTTOM_MARGIN
}

/// Clamp a height to `[MIN_H, monitor_logical_h * MAX_RATIO]`.
pub fn cap_height(h: f64, monitor_logical_h: f64) -> f64 {
    let max = (monitor_logical_h * MAX_RATIO).floor().max(MIN_H);
    h.clamp(MIN_H, max)
}

/// Estimated total popup height (chrome + text) for a source string, capped to
/// the monitor under the cursor.
pub fn estimate_popup_height(original: &str, monitor_logical_h: f64) -> f64 {
    let text_h = estimate_text_height(chars_for_estimate(original));
    let compact_h = COMPACT_CHROME_H + text_h;
    let height = if compact_h <= COMPACT_MAX_H {
        compact_h
    } else {
        CHROME_H + text_h
    };
    cap_height(height, monitor_logical_h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_stays_compact() {
        let height = estimate_popup_height("hi", 1080.0);
        assert!((MIN_H..=200.0).contains(&height));
    }

    #[test]
    fn long_text_caps_at_max_ratio() {
        let h = estimate_popup_height(&"a ".repeat(2000), 1080.0);
        assert!((h - 702.0).abs() < 1.0, "got {h}");
    }

    #[test]
    fn empty_is_one_line() {
        assert!(estimate_text_height(0) >= LINE_H);
    }

    #[test]
    fn clamp_never_exceeds_monitor() {
        assert!(cap_height(9999.0, 800.0) <= 520.0);
    }

    #[test]
    fn chars_counts_unicode_not_bytes() {
        // "Tiếng Việt" is 10 chars but 14 UTF-8 bytes.
        assert_eq!(chars_for_estimate("Tiếng Việt"), 10);
    }

    #[test]
    fn estimate_grows_with_length() {
        let short = estimate_popup_height("hello world", 1080.0);
        let long = estimate_popup_height(&"x".repeat(400), 1080.0);
        assert!(long > short);
    }
}
