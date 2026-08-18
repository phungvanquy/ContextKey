## Context

The hotkey engine needs one fact per keystroke: *which key went down or up*. `rdev` computes far more than that.

Per keystroke, inside the LL hook, before the key reaches the app the user is typing into:

```
rdev 0.5.3                              this change
─────────────────────────────────────   ────────────────────────────────
convert() → EventType                   read vkCode + flags from
KEYBOARD.lock()          (mutex)          KBDLLHOOKSTRUCT
GetForegroundWindow                     bail if LLKHF_INJECTED
GetWindowThreadProcessId                ≤3 integer compares
AttachThreadInput(TRUE)  ← harmful      (GetAsyncKeyState only when a
GetKeyboardState                         binding needs Ctrl)
AttachThreadInput(FALSE) ← harmful      CallNextHookEx
GetKeyboardLayout
ToUnicodeEx              ← harmful
  └ dead key → while len < 0 { … }  ← unbounded
String::from_utf16       (heap alloc)
SystemTime::now()
callback → state machine
CallNextHookEx
                                        + no WH_MOUSE_LL installed
```

Everything in the left column above `callback` exists to fill `Event::name`, which `hotkey.rs` never reads.

Two calls are not merely slow, they mutate shared input state:

- `AttachThreadInput` alters key state per its own documentation. [MS Q&A 1605020](https://learn.microsoft.com/en-us/answers/questions/1605020/attachthreadinput-in-the-callback-of-setwindowshoo) reports a TSF IME (Pinyin) fragmenting fast input when it is called from a hook callback — matching the reported symptom, and matching why it only shows up at speed.
- `ToUnicodeEx` mutates the kernel-mode keyboard buffer holding dead-key/composition state.

Windows enforces `LowLevelHooksTimeout` (~300ms, `HKCU\Control Panel\Desktop`): a callback that overruns may be skipped or the hook silently removed. An unbounded `ToUnicodeEx` loop inside that budget is a latent hang, and it sits upstream of our code where we cannot guard it.

## Goals / Non-Goals

**Goals**
- No `ToUnicodeEx`, `AttachThreadInput`, `GetKeyboardState`, or `GetKeyboardLayout` on the keystroke path.
- No heap allocation, no unbounded loop, no global mutex before our state machine.
- No mouse hook installed at all.
- Byte-identical config and identical observable hotkey behavior.
- Fewer dependencies than before.

**Non-Goals**
- Removing the keyboard hook (inherent to double-tap detection).
- Moving the state machine off the hook thread (see D7).
- Suppressing keystrokes; the listener stays passive.

## Decisions

**D1: Own the hook instead of forking or patching rdev.**
The surface we use is `listen`, `Event`, `EventType::{KeyPress,KeyRelease}`, and ~55 `Key` variants. Everything else rdev offers — `simulate`, `grab`, macOS/X11 backends, a cross-platform keycode table — is dead weight we cannot configure away. A fork would mean maintaining a patched crate to delete code we never call; `[patch.crates-io]` also complicates the CI build. Writing the ~150 lines we need deletes a dependency instead of adding a maintenance burden. Net line count is roughly flat: `keyhook.rs` arrives, but `map_then_key`'s 55-arm `Key` table collapses to VK constants.

**D2: `windows-sys`, not hand-written `extern` blocks.**
`hotkey.rs` currently declares `GetCursorPos`/`GetAsyncKeyState` by hand — fine for two functions taking scalars, but `KBDLLHOOKSTRUCT`, `MSG`, and `HHOOK` are layout-sensitive, and a wrong field offset is silent UB in a callback that sees every keystroke. `windows-sys` is published by Microsoft, is `-sys`-only (raw bindings, no wrapper layer), and is feature-gated so we compile three modules rather than all of Win32. It also replaces `winapi`, which rdev depended on and which is unmaintained — so the dependency count and the maintained-ness both improve.

**D3: Key identity is the raw virtual-key code (`u32`).**
The hook hands us `vkCode`. rdev translated VK → `Key`, and `map_then_key` translated a config string → `Key`; both existed only to meet in the middle. Using VK directly removes one translation and makes `no_reset_keys` a `HashSet<u32>`.

The invariant CLAUDE.md flags — `SUPPORTED_THEN` (`settings.js`) must agree with `is_supported_then` (backend) or a binding saves and silently never fires — is unchanged in shape and still lives in exactly two places. The failure mode is if anything improves: an unmapped name previously became `Key::Unknown(0)`, a value no event carries; now `map_then_key` returns `Option<u32>` and `parse_then` falls back to `0`, which is not a valid VK, so it is equally unmatchable and equally gated by `HotkeyConfig::validate`.

**D4: Ignore `LLKHF_INJECTED`.**
rdev does not test this flag, so `SendInput` from any process looks like typing. Two reasons to filter: a hotkey is a physical gesture, and any IME or automation tool that injects keys (Telex-style helpers do this — send Backspace, send the composed character) would otherwise drive our state machine on every accented character. Cost is one bit test. Trade-off: an automation tool cannot trigger our hotkeys programmatically. That is not a supported use case and the security posture is better without it.

**D5: Keep the existing thread and lock shape.**
`spawn_hotkey_listener` still owns a named thread; it installs the hook and runs `GetMessageW`, which is required — an LL hook is dispatched to the installing thread's message queue, so without a pump the callback never fires. `HotkeyState` stays behind `Mutex` with recover-on-poison (from `harden-runtime-footprint` D4), and the table stays behind `ArcSwap` for wait-free reads. This change is about what the callback *does*, not restructuring what already works.

**D6: Unhook explicitly on teardown, keep the callback panic-safe.**
`UnhookWindowsHookEx` on shutdown, so `tray-lifecycle`'s "no dangling hook" requirement is satisfied by an owned handle rather than by trusting a dependency. The callback is `extern "system"`; a panic unwinding across that boundary is UB, so the state machine call is wrapped in `catch_unwind` and `CallNextHookEx` is reached on every path. In practice the body cannot panic (integer compares, poison-recovering lock), which is exactly why the guard is cheap.

**D7: Do not move the state machine off the hook thread yet.**
The tempting next step is a lock-free ring buffer with a worker thread, leaving the callback as "push VK, return". After this change the callback is a few integer compares over at most three entries — the expensive work is what we are removing, not the matching. Adding a queue now would add a thread, a buffer, and a failure mode (drops under burst) to optimise something unmeasured. Deferred, recorded here so the option is not lost if the A/B check still shows symptoms.

## Rejected / Deferred

**R1: Fork rdev and patch out `get_name` + the mouse hook.**
Fewer lines written, but it means owning a fork of a crate to delete code, plus a `[patch.crates-io]` entry in the build. We would still ship rdev's `winapi` dependency and its unused backends. Rejected in favour of D1.

**R2: Look for an existing keyboard-only crate.**
Considered. Anything general-purpose enough to publish tends to offer name translation (the exact feature that causes the harm) and simulation. Our requirement is unusually narrow — VK codes, passive, no synthesis — so a dependency would be mostly surface we do not want. Rejected; revisit only if this module grows beyond a single hook.

**R3: `RegisterHotKey` instead of a hook.**
The correct API for global hotkeys, and it needs no hook at all. It cannot express a two-step sequence or a double-tap, which is the reason `translate-hotkey` rejected the Tauri global-shortcut plugin. Still rejected, for the same reason.

**R4: Raw Input (`WM_INPUT`) instead of a hook.**
Delivers physical key events without an LL hook, so it would not sit in the keystroke path at all — genuinely attractive. But it reports device-level scancodes and does not observe layout, so mapping to VK means re-implementing what the hook gives us free; it also does not see keys while another app has foreground focus in the way we need. Deferred as a larger investigation, not part of this change.

## Risks / Trade-offs

- **Unverifiable in CI.** The Windows CI build is a compile gate only; nothing here can be tested headless. The A/B check (quit the app from the tray, type Vietnamese fast, relaunch, repeat) is the primary confirmation and goes in `QA-CHECKLIST.md`. **OQ1:** if symptoms persist with the app running after this change, the cause is the hook's mere presence, not its body → D7 becomes the next step.
- **The diagnosis is inferred, not measured.** We read rdev's source and matched it to a documented IME defect with the same signature; we have not profiled the user's machine. The change stands on its own regardless: it deletes a dependency, removes an unbounded loop from the hook path, and drops a hook we do not use. Worst case it does not fix the symptom and we have a leaner input path plus a narrowed hypothesis.
- **Hand-rolled FFI in the hottest callback on the system.** Mitigated by D2 (typed bindings, no hand-written structs) and D6 (`catch_unwind`, unconditional `CallNextHookEx`). The blast radius of a mistake is system-wide input, so this module warrants review attention out of proportion to its size.
- **`GetAsyncKeyState` for Ctrl keeps its existing quirk.** AltGr synthesises LCtrl+RAlt, so AltGr reads as Ctrl-down. Pre-existing (`harden-runtime-footprint` kept it deliberately over a cached flag that a missed KeyRelease would desync); not introduced or changed here. Worth noting for Vietnamese users specifically: AltGr is unused by Telex, so no new interaction.
- **Windows-only becomes structural.** Already true in practice; the non-Windows stubs exist so `cargo check` runs in the Linux dev environment, not as a portability claim.
