# Tasks: adaptive-translate-popup-size

- [x] Add `src-tauri/src/popup_sizing.rs` with `estimate_popup_height`, `cap_height`, `estimate_text_height`, `chars_for_estimate` and unit tests (short→MIN_H, long→cap, unicode counting, clamp never exceeds monitor)
- [x] Add `src-tauri/src/window_state.rs` with `LogicalSize`, `load_translate_popup_size`, `save_translate_popup_size` (finite+range validation, atomic tmp+rename)
- [x] Split `windows.rs` popup builder into `build_cursor_popup`/`show_built_popup` and add monitor helpers `cursor_monitor_logical_height`, `resolve_translate_popup_size`
- [x] Make `show_translate_popup` adaptive: build hidden placeholder, resolve target size (persisted wins), `set_size` before `show_built_popup`, install resize-persistence listener (deadline-guarded, 400ms throttle)
- [x] Add `resize_translate_popup_to_content` (cap 65%, threshold 8px, preserve width, re-clamp Y) and `translate_popup_{deadline,last_persist}` guards
- [x] Add `#[tauri::command] resize_translate_popup` in `main.rs` and register in `invoke_handler`
- [x] Wire `frontend/popup.js` live resize: `resultArea` ref, `requestResize` debounced (120ms, 12px hysteresis, 80..3000 guards), hooks on `translate://chunk`/`error`/`done`+rAF, reset on retry
- [x] Verify JS syntax (`node --check`) and confirm `on_window_event` additive behavior in `tauri-runtime-wry`
- [x] Push to git and archive spec delta (`translation-popup`)
