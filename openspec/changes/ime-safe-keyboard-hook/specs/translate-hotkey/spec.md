## MODIFIED Requirements

### Requirement: Double Ctrl+C triggers translation

The translate action SHALL be triggered by the two-step sequence stored in the `hotkeys.translate` config entry, defaulting to `Ctrl+C` → `C` within 600ms. It MUST NOT be hardcoded — the double Ctrl+C is now the default binding rather than the only one.

The trigger continues to share the single global keyboard hook and the debounce state with every other action; the Tauri global-shortcut plugin MUST NOT be used, since it cannot express a two-step sequence.

#### Scenario: Default binding preserves prior behavior

- **WHEN** no hotkey config has been saved
- **THEN** Ctrl+C twice within 600ms triggers translate, matching the behavior before hotkeys became configurable

#### Scenario: Rebound trigger

- **WHEN** the user rebinds translate and saves
- **THEN** the new sequence triggers translate and the previous one no longer does

#### Scenario: Clipboard capture unchanged

- **WHEN** the translate action fires
- **THEN** the selection is read via the existing `get_clipboard_after_copy` polling, since the whitelisted prefixes are themselves copy operations
