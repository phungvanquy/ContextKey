## ADDED Requirements

### Requirement: Keystroke path stays out of the way of text input

The global keyboard listener SHALL observe key identity and direction only. Its hook callback MUST NOT call any Windows API that reads or mutates keyboard translation state, specifically `ToUnicodeEx`/`ToAsciiEx`, `AttachThreadInput`, `GetKeyboardState`, or `GetKeyboardLayout`.

Those calls mutate state shared with the foreground application's text input: `ToUnicodeEx` changes the kernel-mode keyboard buffer that holds dead-key and composition state, and `AttachThreadInput` alters key state and is documented to disrupt TSF IME composition when called from a hook callback. A hotkey engine needs neither — the hook already delivers a virtual-key code.

#### Scenario: IME composition is unaffected while the app runs

- **WHEN** the user types quickly in a language whose input method composes several keystrokes into one character, such as Vietnamese Telex
- **THEN** characters compose exactly as they do when the application is not running
- **AND** no accent or diacritic is dropped, duplicated, or applied to the wrong base character

#### Scenario: No keyboard translation on the keystroke path

- **WHEN** any key is pressed anywhere on the system
- **THEN** the hook callback derives the key from the event's virtual-key code
- **AND** performs no character translation and no keyboard-layout or keyboard-state query

### Requirement: Hook callback is bounded and cheap

The hook callback SHALL complete in bounded time on every path. It MUST NOT allocate, block, spawn threads, or loop without a bound, and it MUST pass the event on via `CallNextHookEx` whatever happens inside it.

Windows removes or skips a low-level hook whose callback exceeds `LowLevelHooksTimeout` (~300ms by default), which would both degrade system-wide input latency and silently disable the hotkeys.

#### Scenario: Bounded work per keystroke

- **WHEN** a key event arrives
- **THEN** the callback performs a fixed number of comparisons against the parsed hotkey table
- **AND** allocates no memory and enters no unbounded loop
- **AND** the event is passed to the next hook in the chain

#### Scenario: Triggered action does not run in the callback

- **WHEN** a hotkey sequence completes
- **THEN** the callback records the trigger and hands the action to the async runtime
- **AND** returns without waiting for clipboard access, window creation, or network I/O

#### Scenario: A panic cannot cross the FFI boundary

- **WHEN** the state machine panics while handling an event
- **THEN** the panic is caught before unwinding out of the `extern "system"` callback
- **AND** the event is still passed to the next hook in the chain
- **AND** later key events continue to be processed

### Requirement: Only a keyboard hook is installed

The application SHALL install a low-level keyboard hook and no low-level mouse hook. Cursor position MUST be sampled on demand at the moment a hotkey fires rather than tracked per mouse event.

A mouse hook makes every mouse move on the system a synchronous call into this process. Nothing in the app consumes streamed mouse events.

#### Scenario: Mouse movement does no work in this process

- **WHEN** the user moves the mouse or clicks while the application is running
- **THEN** no callback in this process runs for that event

#### Scenario: Popup still anchors at the cursor

- **WHEN** a hotkey fires
- **THEN** the cursor position is read at that moment
- **AND** the popup appears at the cursor as before

### Requirement: Only physical keystrokes trigger hotkeys

The listener SHALL ignore key events flagged as injected by software. A hotkey is a physical gesture by the user.

Input methods and automation tools synthesise keystrokes — a Telex-style helper deletes and re-sends characters as the user types — and acting on those would drive the state machine repeatedly per typed character.

#### Scenario: Synthetic keystrokes are ignored

- **WHEN** another process or an input method injects a key event matching a bound hotkey
- **THEN** the hotkey does not fire and the state machine does not advance

#### Scenario: Physical keystrokes still fire

- **WHEN** the user presses the bound sequence on a physical keyboard
- **THEN** the hotkey fires as configured

### Requirement: Single running instance

The application SHALL run as a single instance so only one global hook is installed at a time. Launching it while an instance is running MUST NOT start a second process, install a second hook, or cause hotkeys to fire more than once.

#### Scenario: Second launch does not duplicate the app

- **WHEN** the application is already running in the tray and the user launches the executable again
- **THEN** no second instance starts and no second global hook is installed
- **AND** exactly one popup and one API request result from a single hotkey trigger
- **AND** the running instance surfaces the Settings window so the user sees the app is alive

### Requirement: Listener survives for the life of the process

The listener SHALL remain installed and responsive for as long as the application runs. A transient panic while its internal state lock is held MUST NOT permanently disable the hotkeys.

#### Scenario: Transient lock poisoning does not kill the hotkey

- **WHEN** a panic occurs while the listener's state lock is held
- **THEN** subsequent key events recover the lock and continue to be processed
- **AND** the hotkeys keep working without restarting the application
