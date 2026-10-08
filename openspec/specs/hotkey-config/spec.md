# hotkey-config Specification

## Purpose

Defines configurable keyboard sequences, validation, and updates that take effect without restarting the app.

The owned keyboard hook forwards input to the foreground application. Two-step sequences and a restricted set of prefixes reduce accidental activation; Settings explains when a binding can also affect the active application.

## Requirements

### Requirement: Two-step hotkey model

Every hotkey SHALL be a two-step sequence: a `prefix` key/chord, followed by a `then` key, both within a time window (`window_ms`). A double-tap is the degenerate case where `prefix` and `then` resolve to the same key. One-step hotkeys MUST NOT be offered.

The reason is that the owned keyboard hook is passive and forwards input, so every keystroke in a hotkey also reaches the foreground application. A one-step hotkey would therefore fire on an ordinary keypress and leak that key to whatever app is focused.

#### Scenario: Two-step sequence fires

- **WHEN** the user presses the configured `prefix`, then the configured `then` key within `window_ms`
- **THEN** the action fires exactly once for that pair

#### Scenario: Window expiry

- **WHEN** the `then` key arrives after `window_ms` has elapsed since the prefix
- **THEN** the action does NOT fire and the armed state is cleared

#### Scenario: Double-tap requires a release between presses

- **WHEN** `prefix` and `then` are the same key and the key is held down, producing OS key-repeat
- **THEN** the action does NOT fire, because a KeyRelease between the two presses is required
- **AND** a genuine press-release-press within the window DOES fire

### Requirement: Prefix whitelist

The application SHALL only accept a `prefix` drawn from a whitelist of combos whose solo press is harmless: `Ctrl+C` (copy, idempotent), `Ctrl+Insert` (copy), `RCtrl` (no-op alone), `RShift` (no-op alone). A prefix outside the whitelist MUST be rejected by config validation.

Since input cannot be suppressed, the first step of every hotkey is delivered to the foreground app. Restricting prefixes to harmless keys is what keeps that leak from causing damage.

#### Scenario: Non-whitelisted prefix rejected

- **WHEN** a config specifies a prefix outside the whitelist
- **THEN** validation fails with an error naming the offending prefix and the allowed set

#### Scenario: Ctrl+Shift combos are not offered

- **WHEN** the prefix options are presented to the user
- **THEN** no `Ctrl+Shift+*` combo appears, because the Vietnamese IME (Unikey) uses Ctrl+Shift for input-method switching by default

### Requirement: Supported "then" keys round-trip

A `then` key name SHALL be accepted only if the hotkey engine can map it to a real key. The Settings UI and the backend validator MUST agree on the supported set: `RCtrl`, `RShift`, `Space`, `Insert`, `A`–`Z`, `0`–`9`, `F1`–`F12`.

An unmappable name would parse to an unknown key that no real keyboard event carries. The hotkey would save successfully and then never fire, with nothing to tell the user why. `RCtrl` and `RShift` MUST remain valid `then` values because a double-tap hotkey uses a modifier as its `then`.

#### Scenario: Unsupported key refused at capture

- **WHEN** the user presses a key the engine cannot map (for example Left Ctrl, a numpad key, or an arrow key) into a hotkey capture field
- **THEN** the key is not stored, the field reports that it is unsupported, and capture stays active so another key can be tried

#### Scenario: Hand-edited config with an unsupported key

- **WHEN** a config file is edited by hand to a `then` key outside the supported set
- **THEN** validation fails rather than silently producing a hotkey that never fires

#### Scenario: Modifier as a double-tap "then"

- **WHEN** the user captures `RCtrl` as the `then` key for a double-tap binding
- **THEN** it is accepted, so the default screenshot binding can be re-entered after being changed

### Requirement: Conflict and range validation

Config validation SHALL reject: a duplicate `(prefix, then)` pair across two actions, a `window_ms` outside 200–1000, and an empty `then`.

#### Scenario: Duplicate combo

- **WHEN** two actions are assigned the same `(prefix, then)` pair
- **THEN** validation fails, since the firing action would otherwise be arbitrary

#### Scenario: Conflict surfaced before save

- **WHEN** the user's in-progress Settings selections would collide
- **THEN** the conflict is shown inline and saving is blocked

### Requirement: Hot-swap without restart

A saved hotkey table SHALL take effect without restarting the application or the listener thread. The parsed table MUST be readable by the hook callback without blocking.

A single owned keyboard hook remains installed while settings change. The callback reads the parsed hotkey table through `ArcSwap`; updating the table must not require restarting the listener or blocking the callback on a table lock.

#### Scenario: New binding active immediately

- **WHEN** the user saves a changed hotkey
- **THEN** the new binding fires and the previous binding stops firing, with no restart

### Requirement: Fail-safe on invalid stored config

If the stored hotkey table fails validation at startup, the application SHALL fall back to the default table and continue running with a warning, rather than starting with no working hotkeys.

#### Scenario: Corrupted hotkey block

- **WHEN** the config file's `hotkeys` block is invalid or conflicting at load time
- **THEN** defaults are used, a warning is logged, and all three actions remain usable

#### Scenario: Missing hotkey block

- **WHEN** an existing config file predates this feature and has no `hotkeys` key
- **THEN** defaults are applied: translate `Ctrl+C`→`C`, chat `Ctrl+C`→`Space`, screenshot `RCtrl`→`RCtrl`

### Requirement: Side-effect warnings in Settings

The Settings UI SHALL warn when a chosen combo has a known side effect in common applications, without blocking the choice.

Because the keystrokes still reach the foreground app, the user needs to know that, for example, `Ctrl+S` will also trigger Save wherever they use it.

#### Scenario: Known-dangerous combo warned

- **WHEN** the user selects a `then` key that forms a combo with a well-known side effect (Save, Close tab, Undo, Select all, Paste, Cut, New, Find)
- **THEN** an inline warning explains the side effect and the selection is still allowed

### Requirement: Reset to defaults

The Settings UI SHALL provide a control that restores all hotkeys to their defaults.

#### Scenario: Reset

- **WHEN** the user activates reset
- **THEN** all three actions are repopulated with their default prefix, then-key, and window
