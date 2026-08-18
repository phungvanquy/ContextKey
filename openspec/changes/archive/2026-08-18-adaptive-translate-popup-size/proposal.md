# Change: Adaptive translate popup size

## Why

The translate popup is fixed at 460×220px (header+separator+footer ~110px, leaving ~5 lines for results). Longer selections scroll in a tiny viewport, while single-word translations waste space on empty chrome. Users can drag-resize, but the size is discarded on next open. The goal is a popup that sizes to its content, capped to the monitor, with no flash and with manual resize remembered.

## What Changes

- Stage 1 (no flash): backend estimates popup height from source text length before `WebviewWindowBuilder::build` completes, caps at 65% of cursor monitor's logical height. Window is built hidden, `set_size` to target, then `position_at_cursor` with correct `h`, then `show()`.
- Stage 2 (exact): frontend measures `resultArea.scrollHeight` after each `translate://chunk`, on `translate://done` (markdown render + rAF), and on `translate://error`, debounces, and `invoke('resize_translate_popup')`. Backend caps, threshold-skips, preserves width, re-clamps Y.
- Persistence: `window_state` JSON at `~/.quicktranslator_window_state.json` stores last manual drag size (logical px, atomic temp+rename). Load validates, save throttles to 400ms, programmatic resizes are deadline-guarded (600ms) so they don't get persisted. Persisted size wins over estimate.
- New modules `popup_sizing` (pure math + tests) and `window_state`.

## Impact

- `src-tauri/src/popup_sizing.rs` new — constants `CHROME_H 110`, `LINE_H 20.8`, `CONTENT_W 428`, `EXPANSION 1.40`, `MAX_RATIO 0.65`, funcs `estimate_popup_height`/`cap_height`.
- `src-tauri/src/window_state.rs` new — logical size JSON, validated range.
- `src-tauri/src/windows.rs` — split `build_cursor_popup`/`show_built_popup`, adaptive `show_translate_popup`, `resize_translate_popup_to_content`, DPI-safe monitor helpers, `on_window_event` additive.
- `src-tauri/src/main.rs` — new command `resize_translate_popup`.
- `frontend/popup.js` — `resultArea` ref, `requestResize` debounced, hooks in chunk/error/done, retry resets.
- `openspec/specs/translation-popup` delta.
