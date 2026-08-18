## 1. Dependencies

- [ ] 1.1 In `src-tauri/Cargo.toml`, remove `rdev = "0.5"` and add `windows-sys = { version = "0.61", features = ["Win32_Foundation", "Win32_UI_Input_KeyboardAndMouse", "Win32_UI_WindowsAndMessaging"] }` as a Windows-only target dependency (`[target.'cfg(windows)'.dependencies]`) so the Linux `cargo check` path stays clean.

## 2. New `keyhook` module

- [ ] 2.1 Create `src-tauri/src/keyhook.rs` with a module doc comment stating the one rule: the callback reads `vkCode` and returns — no `ToUnicodeEx`, no `AttachThreadInput`, no `GetKeyboardState`, no `GetKeyboardLayout`, no allocation, no mouse hook. Explain *why* (IME composition + `LowLevelHooksTimeout`), citing the design decision.
- [ ] 2.2 Add `pub type Vk = u32;` and the VK constants the hotkey table needs: `VK_CONTROL/LCONTROL/RCONTROL`, `VK_SHIFT/LSHIFT/RSHIFT`, `VK_MENU/LMENU/RMENU`, `VK_LWIN/RWIN`, `VK_CAPITAL`, `VK_SPACE`, `VK_INSERT`, plus helpers for `A`–`Z` (`0x41 + n`), `0`–`9` (`0x30 + n`), `F1`–`F12` (`0x70 + n`).
- [ ] 2.3 Implement `pub fn install<F>(on_event: F)` (Windows): store the callback in a module-level `OnceLock`, call `SetWindowsHookExW(WH_KEYBOARD_LL, Some(raw_callback), None, 0)`, keep the returned `HHOOK` in a static for teardown, then run a `GetMessageW` pump. Document that the pump is mandatory — an LL hook is dispatched to the installing thread's message queue.
- [ ] 2.4 Implement `raw_callback`: if `code == HC_ACTION`, read `*(lparam as *const KBDLLHOOKSTRUCT)`; skip when `flags & LLKHF_INJECTED != 0`; map `wparam` to press (`WM_KEYDOWN`/`WM_SYSKEYDOWN`) or release (`WM_KEYUP`/`WM_SYSKEYUP`); invoke the stored callback inside `catch_unwind`. Call `CallNextHookEx` on **every** path including early returns and a caught panic.
- [ ] 2.5 Add `pub fn uninstall()` calling `UnhookWindowsHookEx` on the stored handle if present, and clear it.
- [ ] 2.6 Move `cursor_pos()` and `ctrl_is_down()` here from `hotkey.rs`, reimplemented on `windows-sys` (`GetCursorPos`, `GetAsyncKeyState`) so no hand-written `extern` blocks remain. Keep `ctrl_is_down` querying `VK_CONTROL` — pre-existing AltGr behavior, unchanged.
- [ ] 2.7 Add the `#[cfg(not(target_os = "windows"))]` stubs: `install` parks the thread, `uninstall` is a no-op, `cursor_pos` returns `(100.0, 100.0)`, `ctrl_is_down` returns `false`, and the VK constants/helpers are shared (they are plain integers, not OS-gated). Comment that these exist for `cargo check` in the Linux dev env, not as a portability claim.
- [ ] 2.8 Register `mod keyhook;` in `src-tauri/src/main.rs`.

## 3. Port `hotkey.rs` to virtual-key codes

- [ ] 3.1 Replace `use rdev::{...}` with `use crate::keyhook::{self, Vk}` and the VK constants; update the module doc comment (it currently describes `rdev::listen`) to describe the owned hook and keep the "once per process" and "Ctrl queried live" notes.
- [ ] 3.2 Change `ParsedPrefix.key`, `ParsedEntry.then_key`, `no_reset_keys: HashSet<Vk>`, and `HotkeyState.armed_prefix` from `rdev::Key` to `Vk`.
- [ ] 3.3 Rewrite `parse_prefix` against VK constants, preserving the whitelist exactly: `Ctrl+C`, `Ctrl+Insert`, `RCtrl`, `RShift`, same fallback.
- [ ] 3.4 Rewrite `map_then_key` to return `Option<Vk>` using the range helpers from 2.2 instead of a 55-arm match — parse a single letter/digit/`F<n>` by pattern. Keep `Space` and `Insert`. Keep the supported set byte-identical to `SUPPORTED_THEN` in `frontend/settings.js`; do not widen it.
- [ ] 3.5 Update `parse_then`'s unmappable fallback from `Key::Unknown(0)` to `0` (not a valid VK, so equally unmatchable) and update the comment. `is_supported_then` keeps its signature so `config.rs:104` needs no change.
- [ ] 3.6 Update the modifier list seeded into `no_reset_keys` to VK constants, covering both left and right variants of Ctrl/Shift/Alt/Win plus CapsLock — matching the current rdev list.
- [ ] 3.7 Rewrite `spawn_hotkey_listener` to call `keyhook::install(...)` with a closure dispatching to `on_key_press`/`on_key_release`; rename the thread from `rdev-listener` to `keyhook-listener`. Leave `on_key_press`/`on_key_release` logic, the 400ms debounce, the per-entry window check, and the double-tap release filter untouched.
- [ ] 3.8 Delete the now-moved `cursor_pos`/`ctrl_is_down` from `hotkey.rs` and re-export or update call sites (`main.rs` uses `hotkey::cursor_pos()`); prefer updating call sites to `keyhook::cursor_pos()` so the FFI lives in one module.

## 4. Teardown

- [ ] 4.1 Call `keyhook::uninstall()` on tray Quit / app exit, alongside the existing exit handling in `main.rs`, so `tray-lifecycle`'s "no dangling hook" requirement is met by an owned handle. Do not disturb the `prevent_exit` logic for window-close (`RunEvent::ExitRequested { code: None, .. }`).

## 5. Docs

- [ ] 5.1 CLAUDE.md: update the `hotkey.rs` row and add a `keyhook.rs` row to the backend module table; rewrite the "Hotkey / input" bullets — owned `WH_KEYBOARD_LL` (no rdev), no mouse hook, injected events ignored, keys identified by VK, and why `ToUnicodeEx`/`AttachThreadInput` are banned from the callback. Note the callback is now genuinely allocation-free (previously only true of our own code).
- [ ] 5.2 CLAUDE.md: update the dependency mention so `rdev` is gone and `windows-sys` is listed.
- [ ] 5.3 `openspec/QA-CHECKLIST.md`: add the A/B IME check — quit from tray, type a long Vietnamese passage fast in Notepad, relaunch, retype the same passage at the same speed, compare. Add regression items: all three hotkeys still fire; double-tap still needs a real release (key-repeat does not trigger); hotkeys do not fire from synthesised input; popup still anchors at the cursor on high-DPI/multi-monitor; no dangling hook after Quit (hotkey stops working once exited).

## 6. Verify

- [ ] 6.1 `cargo check`/`cargo build` — delegated to Windows CI (`.github/workflows/build.yml`); no local Rust toolchain in this dev env, same as prior changes. Confirm no leftover `rdev` references anywhere in `src-tauri/` and no unused imports after the port.
- [ ] 6.2 Manual QA per 5.3 — cannot be verified in CI; needs a real Windows session with the hook active and a Vietnamese IME.
