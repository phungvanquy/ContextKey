# Quick Translator — Project Memory

## Overview
Desktop translator & AI chat assistant in Rust + Tauri 2.x. Highlight text, press a hotkey, get a streaming translation or a chat popup. Small binary, low idle footprint, compile-time safety.

Everything is built and CI-green: translate (Ctrl+C+C), chat (Ctrl+C+Space), TTS read-aloud, configurable hotkeys, screenshot → vision chat. v0.4.0 is released and its features were exercised on real Windows without a failure.

## Architecture

**Stack:** Rust + Tauri 2.x + tokio backend; plain static HTML/CSS/JS frontend (no JS build step); CI on `windows-latest` → `cargo tauri build` → NSIS installer.

### Backend (`src-tauri/src/`)
| Module | Responsibility |
|---|---|
| `main.rs` | Bootstrap: single-instance plugin, config load, tray, hook install, Tauri commands, translate/chat/screenshot triggers, overlay-select handler |
| `config.rs` | `Config` struct, load/save (`~/.quicktranslator_config.json`), `ConfigState` (Mutex) |
| `keyhook.rs` | The app's whole input FFI: owns the `WH_KEYBOARD_LL` hook, VK constants, `cursor_pos()`, `ctrl_is_down()`. Non-Windows stubs so `cargo check` runs on Linux |
| `hotkey.rs` | Table-driven two-step state machine over `keyhook` events, hot-swapped from config via `ArcSwap`; unit-tested against the `SUPPORTED_THEN` contract |
| `clipboard.rs` | `get_clipboard_after_copy`: polls arboard ≤10× @50ms for changed text |
| `api.rs` | reqwest + SSE to chat/completions; emits `<flow>://chunk\|done\|error`; routes to `vision_model` when the history carries an image; `StreamRegistry` holds per-window cancellation flags |
| `screenshot.rs` | xcap multi-monitor capture, crop, JPEG encode (q60 preview / q80 ≤1568px for API); `ScreenshotStore` holds captures in RAM only |
| `tts.rs` | Read-aloud via the `tts` crate (SAPI on Windows); single active utterance |
| `windows.rs` | `show_cursor_popup` (shared builder for both popups, differences in `PopupSpec`), settings, per-monitor selection overlays, and `show_toast` |

### Frontend (`frontend/`)
| File | Purpose |
|---|---|
| `theme.css` | Indigo tokens (dark+light via `prefers-color-scheme`), `.ic` icon helper, spinner keyframes |
| `icons.js` | Inline SVG `<symbol>` sprite; injected as first `<body>` child |
| `popup.*` | Frameless translate popup: draggable, spinner, streaming, error+retry, Esc+blur close |
| `chat.*` | Frameless chat popup: context strip, transcript, input bar, streaming bubbles, per-turn error+retry. Esc/close only — NO blur close |
| `toast.*` | Transient cursor-anchored notice; message via query string, self-closes after 2s, never takes focus |
| `markdown.js` | Minimal XSS-safe markdown→HTML for chat |
| `overlay.*` | Fullscreen region-select overlay: frozen screenshot on a canvas, drag to select, Esc/right-click cancels |
| `settings.*` | Form: api_key, base_url, model, vision_model, target_language, custom_prompt, hotkey capture |

### Key design decisions

**Hotkey / input**
- We own the hook (`keyhook.rs`): one `SetWindowsHookExW(WH_KEYBOARD_LL)`, passive, plus a `GetMessageW` pump on the installing thread (mandatory — an LL hook is dispatched to that thread's queue, so without it the hook installs and observes nothing). The Tauri global-shortcut plugin can't express a double-tap. No mouse hook is installed at all.
- **The callback must never call `ToUnicodeEx`, `AttachThreadInput`, `GetKeyboardState`, or `GetKeyboardLayout`.** This is why `rdev` was dropped: it made all four per keystroke, system-wide, to fill an `Event::name` we never read. `ToUnicodeEx` rewrites the kernel keyboard buffer holding dead-key/composition state; `AttachThreadInput` alters key state and is documented to fragment TSF IME composition from a hook callback ([MS Q&A 1605020](https://learn.microsoft.com/en-us/answers/questions/1605020/attachthreadinput-in-the-callback-of-setwindowshoo)). It surfaced as Vietnamese Telex dropping accents while typing fast — Telex needs 2-3 keystrokes per character, so it hits that window far more often than Latin typing. rdev also had an unbounded `while len < 0 { ToUnicodeEx(...) }` on dead keys, inside a ~300ms budget.
- Keys are identified by raw VK code (`u32`), which is what the hook delivers — no enum translation in either direction.
- **Injected keystrokes (`LLKHF_INJECTED`) are ignored.** A hotkey is a physical gesture, and IMEs synthesise input while composing. Trade-off: automation tools can't trigger hotkeys programmatically.
- Arm-reset is lazy (no timer thread): both fire paths re-check the window against the arm timestamp. `LowLevelHooksTimeout` (~300ms) skips or unhooks a slow callback, so the callback is genuinely allocation-free now (previously only *our* half was — rdev allocated upstream of it).
- The callback wraps the state machine in `catch_unwind` (a panic across `extern "system"` is UB) and calls `CallNextHookEx` on *every* path, including a skipped event — swallowing one drops a keystroke system-wide.
- Hook state lock recovers on poison, so a transient panic can't permanently kill the hotkey. Ctrl state comes from `GetAsyncKeyState`, not a cached flag that a missed KeyRelease would desync. Note AltGr synthesises LCtrl+RAlt so it reads as Ctrl-down; harmless, no whitelisted prefix uses AltGr.
- **Hotkey "then" keys must round-trip.** `SUPPORTED_THEN` (`settings.js`) and `is_supported_then` (backend, enforced in `HotkeyConfig::validate`) must stay in sync — an unmapped name resolves to VK `0`, which no real event carries, so the binding saves fine and then silently never fires. The `hotkey.rs` tests assert every `SUPPORTED_THEN` name maps to a non-zero VK; update both sides plus the test list together. Keep RCtrl/RShift in all of them: double-tap uses a modifier as its "then".

**Process / lifecycle**
- **Single instance** via `tauri-plugin-single-instance`, registered FIRST. A second process would install a second hook set and double-fire every hotkey; instead it surfaces Settings.
- Tray-app lifecycle: Tauri exits on last-window-close, so `main.rs` calls `api.prevent_exit()` on `RunEvent::ExitRequested { code: None, .. }` (window close) and lets `Some(_)` through (tray Quit). Without it, closing a popup kills the app. The `Some(_)` branch also calls `keyhook::uninstall()` so the global hook is released explicitly, not left to process teardown.
- No elevation: `app.manifest` requests `asInvoker`. Windows UIPI means the hook is blind while an elevated window is foreground; running as admin is the per-session workaround.

**API / clipboard / config**
- `arboard` polling; the app only *reads* the clipboard and does not restore prior contents (would need continuous monitoring — rejected).
- `reqwest` + manual SSE parsing (not async-openai) so any base_url works. Connect timeout + per-chunk idle timeout, so a hung server surfaces an error instead of an eternal spinner.
- **The frontend owns chat history and is the ONLY source of the question.** `chat_send` deliberately takes no `question` parameter — the history's last entry *is* the question. Passing both made every turn send it twice.
- **Cancellation flags belong to the window, not the stream** (`api::StreamRegistry`). Popup labels are fixed constants, so keying by label alone let a closed window's late `Destroyed` cancel the *next* window's stream. `claim` (on window build) hands each window its own flag and retires the previous one. Checked between reads, never mid-parse.
- Errors ride `<flow>://error` with `{summary, detail, retryable}`, NOT the chunk event — on the chunk event they were indistinguishable from model output and couldn't be styled or retried. Auth/404 are non-retryable.
- Config is interoperable with the old Python app (`~/.quicktranslator_config.json`). `http://` base_url saves with a non-blocking "API key travels unencrypted" warning.

**Windows / UI (Tauri gotchas)**
- **Never `sleep()` then `emit()` at a window you just created.** This has shipped three times (translate chunks, overlay preview, chat image). Events are dropped, not queued, and WebView2 takes 100–300ms to start — the payload vanishes silently. Use a handshake (`popup://ready`) or better a **pull**: store the payload in managed state and let the frontend `invoke` for it once listeners are up (`get_overlay_preview`, `take_pending_image`). `take_pending_image` *takes* rather than clones, so a stale crop can't re-attach to a later session.
- **An "unfocused" event is not proof the user left.** Interactions *inside* the popup drop webview focus on Windows too, and closing on the raw event made the translate popup vanish on a header click. `data-tauri-drag-region` is the main offender: `ReleaseCapture()` + `WM_NCLBUTTONDOWN` hands the window to the OS move loop, which reports the webview unfocused mid-drag; native calls (TTS/SAPI, clipboard) flicker focus similarly. `installBlurToClose` in `popup.js` suppresses blur while a drag-region mousedown is live, otherwise waits 200ms and re-queries `isFocused()` (a query, so `core:window:default` already allows it). The drag flag needs a backstop timer as well as `mouseup`, because the move loop can swallow the mouseup and a stuck flag would kill blur-close permanently.
- **Popup chrome is a recoverability decision, expressed as data** (`PopupSpec` in `windows.rs`). Translate is ephemeral: blur-closes, `skip_taskbar(true)`, one hotkey press regenerates it. Chat is persistent: NO blur-close, `skip_taskbar(false)`, because it holds history and screenshots that can't be reconstructed and would be unreachable without a taskbar entry. That is also what makes `chat://closed` → drop captures correct: close is always deliberate.
- Blur-to-close only fires after the window gained focus once (built `.focused(true)`).
- The toast is `focused(false)` on purpose — stealing focus from the app being typed in would be worse than the silence it replaces. It therefore has no blur or key events, so a timer is its only dismissal.
- **Tauri 2 ACL:** `core:window:default` grants read/query only. `window.close()` needs `core:window:allow-close`, `data-tauri-drag-region` needs `core:window:allow-start-dragging` — both in `capabilities/default.json` or the calls are silently denied. Custom commands and backend-side window calls are NOT ACL-gated.
- **DPI-safe positioning:** rdev reports PHYSICAL px, the builder's `position()` takes LOGICAL px. Build hidden → `set_position(PhysicalPosition)` using the cursor monitor's `scale_factor()`/bounds (`monitor_from_point`) → `show()` + `set_focus()`. Never pass rdev coords to `.position()`.
- **Overlay sizing:** size with `PhysicalSize` after build, not the builder's logical `inner_size` (which resolves against the creating monitor's scale, not the target's). `set_position` BEFORE `set_size` — moving across monitors makes Windows suggest a rescaled rect. Build `.resizable(true)` so `set_size` is honoured, then `set_resizable(false)`.
- **Don't trust `devicePixelRatio` for the crop.** It can disagree with the monitor's real scale factor; a factor off by 1.25× crops a smaller region that gets upscaled and looks "zoomed in". The overlay reports its canvas size and the backend derives `capture_width / viewport_width`, self-calibrating. Same trap inside the canvas: a rect in CSS px is not a valid `drawImage` *source* rect against a physical-res image.
- Tray icon is owned by code (`TrayIconBuilder`); `tauri.conf.json` must NOT declare `app.trayIcon` or two icons appear.

**Theme / assets**
- Indigo accent (`#7C6BFF` dark / `#6D5AE6` light); dark+light comes purely from `@media (prefers-color-scheme)` in `theme.css` — one token set, no toggle, no JS. No literal hex outside `theme.css` except `#ffffff` on colored buttons.
- All glyphs are one inline-SVG `<symbol>` sprite (`icons.js`) used via `<use href="#ic-…"/>` with `currentColor`, so they re-tint per theme/state. Paths adapted from MIT Lucide.
- Popups use `.transparent(true)` for rounded corners + shadow via CSS (Settings stays decorated). **Unverified:** confirm on real Windows that transparency keeps shadow + always-on-top + positioning; else fall back to opaque + CSS `border-radius` and record it here.
- App icon generated by committed `icons/generate_icon.py`. Tray uses `default_window_icon()`.

## Manual QA
`openspec/QA-CHECKLIST.md` (needs a real keyboard hook + API key; none of it is CI-verifiable). Work through it before tagging. As of v0.4.0 the interactive paths pass on real Windows; what remains unticked needs instrumentation — a proxy log for duplicate requests, an RSS watch for capture release, provider usage for cancellation.

## Session Rules
- **Interrupted sessions:** audit `git status` + `git diff --stat` first, read changed/new files, continue from where it stopped — never start from scratch.
- **Codebase search — `auggie` first.** The `auggie` MCP server (`.mcp.json`) keeps a live semantic index. Call `codebase-retrieval` (`directory_path: /root/coding/quick-translator`) as the FIRST step for any "where/how does X work" question spanning files not yet read — one broad natural-language question beats several narrow ones or three rounds of grep. Do it unprompted before `/opsx:propose`, `/opsx:apply`, `/opsx:explore`, when resuming a session, and for any bug report naming a symptom rather than a file.
  - Skip it for a known symbol (`grep`), a known path (`Read`), or git history (not indexed). It reads the working tree only, so just-written edits may lag — confirm anything load-bearing with `Read` before editing.
  - `.augmentignore` excludes archived delta specs (verbatim duplicates of `openspec/specs/`, they crowded out real code), build output, and binary icons. It is read once at server start, so edits need an MCP restart (`/mcp` → reconnect).
- **All project memory lives in this file** — do NOT use `~/.claude/` memory files.
- **Dependencies — minimal, not zero.** Adding a crate is fine when it makes the project meaningfully better and is safe: actively maintained, widely used, trusted source, pinned version, checked against typosquatting. Prefer the lightest option; don't reinvent what a vetted crate does well.

## Roadmap / Known Gaps
All shipped behavior is specced under `openspec/specs/`. Not built: translation history/log, source-language auto-detection.
Known weak spots, unverified against current code — confirm before acting: clipboard capture is polling with a fixed retry budget (can return stale text); completion token cap is hardcoded (long replies truncate silently); the whole 50-message chat window is sent each turn; the API key sits in plaintext JSON (OS keychain would be better); the Settings window is fixed-size; test coverage is thin (`hotkey.rs` unit tests cover the VK/`SUPPORTED_THEN` contract — config/clipboard/SSE untested; CLAUDE.md previously claimed a Node markdown test, which is not in the tree).
If a keyboard hook still perturbs typing after `keyhook.rs`, the next lever is moving the state machine off the hook thread (ring buffer + worker), leaving the callback as "record VK, return" — deliberately deferred as unmeasured, see `ime-safe-keyboard-hook/design.md` D7.
