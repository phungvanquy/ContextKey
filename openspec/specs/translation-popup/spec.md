# translation-popup Specification

## Purpose
TBD - created by archiving change rewrite-rust-tauri-stage1. Update Purpose after archive.
## Requirements
### Requirement: Popup appearance and placement

The application SHALL show translation results in a frameless, always-on-top, resizable window positioned near the mouse cursor, styled with the GitHub-dark palette carried over from the Python `constants.py`.

#### Scenario: Popup opens near the cursor

- **WHEN** a translate trigger fires with non-empty captured text
- **THEN** a frameless, always-on-top window appears offset from the current cursor position
- **AND** the window is clamped to remain on-screen if the cursor is near a screen edge

#### Scenario: Original text shown

- **WHEN** the popup opens
- **THEN** it displays the captured original text, truncated with an ellipsis when longer than ~120 characters
- **AND** a header region indicates the target language

#### Scenario: Full original discoverable

- **WHEN** the displayed original text has been truncated
- **THEN** the full untruncated original text is available via the element's tooltip (`title`) on hover

### Requirement: Popup placement and sizing

The application SHALL show translation results in a frameless, always-on-top, resizable window positioned near the mouse cursor, styled with the GitHub-dark palette.

The window SHALL size to its content: an estimate derived from the source text length determines the initial height before the window is shown; once chunks stream, the window SHALL grow or shrink to fit the measured content, capped to 65% of the current monitor's logical height. Beyond the cap, the result area scrolls. A manually drag-resized size SHALL be persisted and used on the next open, re-clamped to the current monitor so it never opens off-screen or wider than the monitor.

#### Scenario: Initial height is estimated from source

- **WHEN** a translate trigger fires with non-empty captured text
- **THEN** the window's initial height is computed from `chars_for_estimate(source)` with an expansion allowance, converted to lines via `CONTENT_W / AVG_CHAR_W`, and capped to `min(max, monitor_h * 0.65)`
- **AND** the window is built hidden, `set_size` to that height, then shown at the capped size so there is no visible flash

#### Scenario: Window grows as chunks arrive

- **WHEN** translation chunks are appended or the markdown render completes
- **THEN** the frontend measures `chrome + resultArea.scrollHeight` and invokes `resize_translate_popup` with the desired logical height
- **AND** the backend caps to `monitor_h * 0.65`, ignores changes smaller than 8px logical, preserves the current width, and re-clamps the Y position if the growth would push the bottom off-screen

#### Scenario: Capped content scrolls

- **WHEN** the measured desired height exceeds `monitor_h * 0.65`
- **THEN** the window stays at the cap and the result area shows a scrollbar

#### Scenario: Manually resized size is remembered

- **WHEN** the user drag-resizes the translate popup
- **THEN** the logical size is saved to `~/.quicktranslator_window_state.json` (atomic write, throttled to one write per 400ms), with programmatic resizes excluded by a deadline guard
- **AND** the next translate popup opens at the persisted size, clamped to the current monitor's height and to 1200×1200 limits, instead of the estimate
- **AND** an invalid or missing state file silently falls back to the estimate

#### Scenario: Popup is resizable with sensible minimum

- **WHEN** the user drags the window's edge or corner
- **THEN** the window resizes down to `MIN_W 360` × `MIN_H 160` and the result area reflows

#### Scenario: Popup remains DPI-safe

- **WHEN** the popup is shown or resized on a monitor with scale > 1.0, or the user drags it to a monitor with a different scale
- **THEN** all sizes are kept as logical pixels until the last `* scale` conversion to physical pixels, using the cursor monitor for the initial placement and the window's current monitor for live grows

### Requirement: Streaming render

The popup SHALL render translation chunks as they arrive.

#### Scenario: Chunks appended live

- **WHEN** translation chunks are received from the backend
- **THEN** a loading indicator is shown until the first chunk arrives, after which chunks are appended to the result area in order as plain text

#### Scenario: Stream completion

- **WHEN** the stream completes
- **THEN** the loading indicator is no longer shown and the full translated text remains visible and selectable

### Requirement: Popup dismissal

The popup SHALL be dismissible by keyboard, by losing focus, and be repositionable.

#### Scenario: Escape closes

- **WHEN** the popup has focus and the user presses Escape
- **THEN** the popup closes

#### Scenario: Click outside closes

- **WHEN** the popup loses focus (the user clicks outside it)
- **THEN** the popup closes

#### Scenario: Draggable header

- **WHEN** the user presses and drags on the popup's header region
- **THEN** the window moves with the cursor

### Requirement: Copy translation result

The popup SHALL provide a control to copy the full translation result to the system clipboard once the stream has completed.

#### Scenario: Copy after completion

- **WHEN** the translation stream has completed and the user activates the copy control
- **THEN** the full translated text is written to the system clipboard
- **AND** the control briefly indicates success (e.g. a checkmark or "Copied" label) before reverting

#### Scenario: Copy unavailable before completion

- **WHEN** the translation is still streaming or no text has been produced
- **THEN** the copy control is disabled or non-functional so an empty/partial result cannot be copied

