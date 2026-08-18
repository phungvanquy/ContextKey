## Why

A user typing Vietnamese with the built-in Windows Telex IME reports that the app degrades typing while it runs. Reading `rdev 0.5.3`'s Windows implementation shows why, and the cost is entirely avoidable.

`rdev::listen` installs `WH_KEYBOARD_LL`, and for **every keystroke on the system** its callback runs this before the key reaches the foreground app (`rdev-0.5.3/src/windows/listen.rs:20-44` → `keyboard.rs:36-127`):

- `AttachThreadInput(us, foreground_thread, TRUE)` … `GetKeyboardState` … `AttachThreadInput(…, FALSE)`
- `GetForegroundWindow`, `GetWindowThreadProcessId`, `GetKeyboardLayout`
- `ToUnicodeEx(...)`, and on a dead key `clear_keyboard_buffer` — an **unbounded** `while len < 0 { ToUnicodeEx(...) }` loop
- `String::from_utf16` — a heap allocation
- a global `KEYBOARD.lock()` mutex

All of that exists to populate `Event::name`. **`hotkey.rs:265-275` never reads `name`** — it matches on `event.event_type` only. Every cycle is waste.

Two of those calls are actively harmful, not merely slow:

- **`AttachThreadInput` per keystroke.** The docs state it alters key state. Microsoft Q&A [1605020](https://learn.microsoft.com/en-us/answers/questions/1605020/attachthreadinput-in-the-callback-of-setwindowshoo) reports precisely this: `AttachThreadInput` inside a `SetWindowsHookEx` callback makes the Microsoft Pinyin IME "interrupted" — fast input fragments instead of composing as one sentence, and only when typing fast. Vietnamese Telex is a TSF IME like Pinyin, and Telex needs 2-3 keystrokes per accented character, so it crosses that window far more often than Latin typing does.
- **`ToUnicodeEx` per keystroke.** It mutates the kernel-mode keyboard buffer where dead-key and composition state lives. Calling it from an LL hook is a known way to break accented input ([SO 1964614](https://stackoverflow.com/questions/1964614/toascii-tounicode-in-a-keyboard-hook-destroys-dead-keys), [NVDA #3](https://github.com/nvaccess/nvda/issues/3), [SDL #1735](https://github.com/libsdl-org/SDL/issues/1735)). This hits dead-key layouts hardest; a TSF IME less so, but it still shares the layout.

Two further costs come free with the same fix:

- **rdev installs `WH_MOUSE_LL` too** (`listen.rs:54`) with no opt-out. Change `harden-runtime-footprint` already stopped *using* mouse events (`cursor_pos()` samples on demand), so every mouse move still runs `convert` + `SystemTime::now()` + our callback purely to be discarded — against the project's low-idle-footprint goal. That change recorded removing the mouse hook as deferred (`R2`); this is that follow-up.
- **`LowLevelHooksTimeout` (~300ms) risk.** CLAUDE.md states the callback "stays allocation-free". True of *our* callback; rdev allocates and can spin unboundedly before reaching it. The claim only becomes true once rdev is gone.

## What Changes

- **Replace `rdev::listen` with a direct `SetWindowsHookExW(WH_KEYBOARD_LL)`** in a new `keyhook` module. The callback reads `KBDLLHOOKSTRUCT.vkCode`/`flags`, calls `CallNextHookEx`, and does nothing else: no `ToUnicodeEx`, no `AttachThreadInput`, no `GetKeyboardState`, no `GetKeyboardLayout`, no heap allocation, no unbounded loop, and **no mouse hook**.
- **Ignore injected keystrokes** (`LLKHF_INJECTED`). rdev does not check this flag, so software-generated input is indistinguishable from real typing. A hotkey is a physical gesture; honouring synthetic input only adds spurious state-machine work.
- **Key identity becomes the Windows virtual-key code** (`u32`) instead of `rdev::Key`. This is what the hook already delivers; `rdev::Key` was a translation layer in both directions (`map_then_key` mapped 55 names to `Key`, rdev mapped VK back to `Key`).
- **Drop the `rdev` dependency** — and with it `winapi`, which rdev pulls in and which is no longer maintained.
- **Promote the two listener requirements** the `harden-runtime-footprint` change wrote but never promoted into `openspec/specs/`, restated without the rdev-specific wording.

Observable behavior is unchanged: same two-step model, same prefixes, same "then" key names, same 600ms/400ms timing, same config file. **No config schema change** (Python interop preserved) — stored hotkey strings are untouched.

## Non-Goals

- **Removing the low-level keyboard hook.** Any `WH_KEYBOARD_LL` adds a synchronous step to every keystroke system-wide. That is the price of passive double-tap detection (`translate-hotkey`) and stays.
- **Moving the state machine off the hook thread.** A ring buffer + worker thread would shrink the callback to "record VK, return". After this change the callback is a handful of integer compares over ≤3 entries; optimising further before measuring would be speculation. Recorded in `design.md` as the next lever if symptoms persist.
- **Suppressing hotkey keystrokes.** The listener stays passive; `hotkey-config` depends on that.
- **Non-Windows support.** Already Windows-only in practice (xcap, SAPI TTS, `app.manifest`, CI is `windows-latest`). Non-Windows keeps compiling via stubs so `cargo check` works in the Linux dev environment.

## Capabilities

### New Capabilities
- `input-listener`: how the global keyboard hook is installed and what the callback may do. Currently implicit and spread across `tray-lifecycle`, `hotkey-config`, and `translate-hotkey`, all of which name `rdev` in requirement text. Promotes the two unpromoted requirements from `harden-runtime-footprint`.

### Modified Capabilities
- `hotkey-config`: "Hot-swap without restart" and the Purpose drop `rdev::listen` naming in favour of the mechanism-neutral constraint; "Supported 'then' keys round-trip" restated against virtual-key codes.
- `translate-hotkey`: "Double Ctrl+C triggers translation" drops the `rdev::listen`-thread wording.
- `tray-lifecycle`: "Shutdown releases the keyboard hook" restated for an owned hook handle.

## Impact

- `src-tauri/Cargo.toml` — remove `rdev`; add `windows-sys` (Microsoft-published, the successor to the unmaintained `winapi` rdev used) with only the `Win32_UI_Input_KeyboardAndMouse`, `Win32_UI_WindowsAndMessaging`, and `Win32_Foundation` features.
- `src-tauri/src/keyhook.rs` — **new.** Hook install/teardown, callback, VK constants, non-Windows stub.
- `src-tauri/src/hotkey.rs` — `Key` → `u32` VK throughout (`ParsedPrefix`, `ParsedEntry`, `no_reset_keys`, `HotkeyState`); `map_then_key` returns VK; `ctrl_is_down`/`cursor_pos` move to `keyhook` beside the other FFI.
- `src-tauri/src/main.rs` — register the `keyhook` module; unchanged trigger handlers.
- `frontend/settings.js` — unchanged. `SUPPORTED_THEN` ↔ `is_supported_then` must still agree; that invariant stays a two-place contract, no third place added.
- `openspec/specs/input-listener` (new) + `hotkey-config`, `translate-hotkey`, `tray-lifecycle` deltas.
- `openspec/QA-CHECKLIST.md` — add the A/B Vietnamese fast-typing check (app quit vs running) plus hotkey regression items; none of this is CI-verifiable.
- `CLAUDE.md` — architecture table, hotkey design notes, dependency list.
