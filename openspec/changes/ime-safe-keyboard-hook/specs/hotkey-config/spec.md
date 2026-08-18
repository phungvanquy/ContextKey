## MODIFIED Requirements

### Requirement: Supported "then" keys round-trip

A `then` key name SHALL be accepted only if the hotkey engine can map it to a virtual-key code. The Settings UI and the backend validator MUST agree on the supported set: `RCtrl`, `RShift`, `Space`, `Insert`, `A`–`Z`, `0`–`9`, `F1`–`F12`.

An unmappable name would resolve to a code that no real keyboard event carries. The hotkey would save successfully and then never fire, with nothing to tell the user why. `RCtrl` and `RShift` MUST remain valid `then` values because a double-tap hotkey uses a modifier as its `then`.

#### Scenario: Unsupported key refused at capture

- **WHEN** the user presses a key the engine cannot map (for example Left Ctrl, a numpad key, or an arrow key) into a hotkey capture field
- **THEN** the key is not stored, the field reports that it is unsupported, and capture stays active so another key can be tried

#### Scenario: Hand-edited config with an unsupported key

- **WHEN** a config file is edited by hand to a `then` key outside the supported set
- **THEN** validation fails rather than silently producing a hotkey that never fires

#### Scenario: Modifier as a double-tap "then"

- **WHEN** the user captures `RCtrl` as the `then` key for a double-tap binding
- **THEN** it is accepted, so the default screenshot binding can be re-entered after being changed

### Requirement: Hot-swap without restart

A saved hotkey table SHALL take effect without restarting the application or the listener thread. The parsed table MUST be readable by the hook callback without blocking.

The hook is installed once for the life of the process and is not reinstalled on a config change, so the listener must outlive any config change. The callback runs inside a Windows low-level keyboard hook, which is skipped or unhooked if it exceeds `LowLevelHooksTimeout` (~300ms) — so the read must be wait-free rather than lock-based.

#### Scenario: New binding active immediately

- **WHEN** the user saves a changed hotkey
- **THEN** the new binding fires and the previous binding stops firing, with no restart
