# Design: adaptive-translate-popup-size

## Context

`windows.rs` created `translate-popup` at a fixed size; `popup.js` streamed into a scrollable `resultArea`. Sizing should improve without introducing flash, DPI errors, or new dependencies (`tauri-plugin-window-state` is overkill).

## Goals / Non-Goals

Goals: fit short text compactly, grow for longer text up to monitor cap then scroll, no visible reflow flash, remember user's manual size across restarts, keep backend/frontend responsibilities clear.

Non-Goals: per-monitor per-virtual-desktop profiles, animated transitions, settings UI for cap, changing chat/settings popups.

## Decisions

- **D1 Hybrid two-stage vs estimate-only or measure-only.** Estimate-only leaves long translations cramped (length ratio varies, markdown inflates). Measure-only needs DOM earlier than window exists. Hybrid gives good first frame (estimate) and exact final (measure).
- **D2 Width fixed at 460px logical.** Wider hurts readability; height is the useful dimension.
- **D3 Constants: EXPANSION 1.40, MAX_RATIO 0.65.** Conservative tall bias; 65% leaves breathing room on small laptops.
- **D4 Persistence beside config, not in `Config`.** Preserves Python interop (`~/.quicktranslator_config.json` unchanged). Separate `~/.quicktranslator_window_state.json`.
- **D5 Separate pure module `popup_sizing`.** Keeps math testable without Tauri.
- **D6 Deadline-guarded programmatic flag (600ms) not boolean.** Windows delivers `Resized` async; boolean is racy, timestamp window is not.
- **D7 `on_window_event` is additive.** Confirmed in `tauri-runtime-wry`: `AddEventListener` with id. Second listener coexists with first.

## Risks / Trade-offs

- Estimation heuristics need tuning per language pair — mitigated by live correction.
- Persisted size could be stale after monitor change — mitigated by re-clamping on load.
- Extra `set_size` before show adds one IPC — hidden window so no flash observable.

## Migration

No migration; missing state file falls back to estimate. Invalid JSON yields `None` and is overwritten on next manual resize.

## Open Questions

None.
