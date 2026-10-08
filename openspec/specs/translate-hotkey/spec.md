# translate-hotkey Specification

## Purpose

Defines the translation shortcut, clipboard capture, and feedback when no text is available.

## Requirements

### Requirement: Double Ctrl+C triggers translation

The translate action SHALL be triggered by the two-step sequence stored in the `hotkeys.translate` config entry, defaulting to `Ctrl+C` → `C` within 600ms. It MUST NOT be hardcoded — the double Ctrl+C is now the default binding rather than the only one.

All actions SHALL share the owned Windows keyboard hook in `keyhook.rs` and the debounce state in `hotkey.rs`. The hook SHALL remain passive so normal keyboard input continues to reach the foreground application.

#### Scenario: Default binding preserves prior behavior

- **WHEN** no hotkey config has been saved
- **THEN** Ctrl+C twice within 600ms triggers translate, matching the behavior before hotkeys became configurable

#### Scenario: Rebound trigger

- **WHEN** the user rebinds translate and saves
- **THEN** the new sequence triggers translate and the previous one no longer does

#### Scenario: Clipboard capture unchanged

- **WHEN** the translate action fires
- **THEN** text is read through `get_clipboard_after_copy`; modifier-only prefixes do not copy a selection, so those bindings use text already on the clipboard

### Requirement: Clipboard capture after copy

When the translation action fires, the application SHALL poll the clipboard through `arboard` for updated text, with a bounded fallback to its initial read.

#### Scenario: Clipboard updates within the poll window

- **WHEN** the translate flow reads the clipboard after a Ctrl+C copy
- **THEN** it polls up to 10 times at 20 ms intervals and returns trimmed, non-empty text as soon as the content differs from the initial clipboard read

#### Scenario: Clipboard does not change

- **WHEN** the clipboard content never changes during the poll window
- **THEN** the previously captured clipboard text (trimmed) is returned as a fallback

#### Scenario: Empty selection

- **WHEN** the resolved clipboard text is empty
- **THEN** the translate flow does not open a translation popup or issue an API request
- **AND** a brief notice near the cursor explains that no text was selected
