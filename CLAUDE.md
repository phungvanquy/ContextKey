# ContextKey — Project Memory

## Overview
Desktop AI assistant in Rust + Tauri 2.x for translation, selected-text chat, and screenshot questions. Small binary, low idle footprint, compile-time safety. Tagline: "Understanding, a shortcut away."

Repository: `git@github.com:phungvanquy/ContextKey.git` (https://github.com/phungvanquy/ContextKey). Product name: `ContextKey`; Cargo package and executable: `contextkey`; Tauri identifier: `com.contextkey.desktop`. Archived change records retain the names and paths used when those changes shipped.

v0.4.0 shipped translate (Ctrl+C+C), chat (Ctrl+C+Space), TTS read-aloud, configurable hotkeys, and screenshot → vision chat; its features were exercised on real Windows without a failure. The ContextKey rename and saved-data import require the new Windows checks in `openspec/QA-CHECKLIST.md` before release.

## Documentation

- [README](Readme.md): installation, shortcuts, settings, storage, upgrades, and troubleshooting.
- [Development guide](docs/DEVELOPMENT.md): prerequisites, architecture, local commands, CI, and icon maintenance.
- [Microsoft Store preparation](docs/MICROSOFT-STORE.md): MSIX CI, the supplied Partner Center identity, shared Evergreen WebView2 recovery, and remaining Windows/listing validation. CI produces unsigned upload candidates; publication and certification happen in Partner Center.
- [Release validation](openspec/QA-CHECKLIST.md): manual Windows checks and historical results.
- [Behavior specifications](openspec/specs/): current feature requirements; archived changes preserve implementation history.

## Architecture

**Stack:** Rust + Tauri 2.x + tokio backend; plain static HTML/CSS/JS frontend (no JS build step); CI on `windows-latest` → `cargo tauri build` → NSIS installer.

**Store packaging:** `.github/workflows/microsoft-store.yml` builds an unsigned x64 MSIX for `ITMO.ContextKey`, publisher `CN=B4AAB21C-9EB8-42AA-87B3-8F966E39D731`, display publisher `ITMOvnteam` (Store ID `9PM8R305QRTK`). `packaging/windows/AppxManifest.xml` owns Store candidate version `1.0.2.0`, independent of Cargo/Tauri versions. The Store profile uses shared Evergreen WebView2 (`webviewInstallMode: skip`); no runtime or installer is bundled. `webview_runtime.rs` checks availability before settings migration/Tauri/tray/hooks and uses native Windows dialogs to offer the official download page and exit if unavailable. Standard NSIS still uses its download bootstrapper. The published v0.5.0 MSIX (`1.0.0.0`) retains its old Fixed Version payload. Packaging stages only the EXE, optional loader DLL, manifest, and three logos; archive validation enforces an allowed payload and a 25 MiB budget. Build metadata records the Evergreen mode and measured sizes. Tag releases call the MSIX workflow, wait for both builds, verify versions/source/runtime mode/checksums, and upload all files to a draft before publication. Release notes live in `docs/releases/<tag>.md`; published assets are never overwritten. MakeAppx validation is enabled; native packaged-app testing (including missing-runtime recovery and upgrades) and certification are still required. No workflow submits to Partner Center; Microsoft signs after Store certification.

### Backend (`src-tauri/src/`)
| Module | Responsibility |
|---|---|
| `main.rs` | Bootstrap: single-instance plugin, config load, tray, hook install, Tauri commands, translate/chat/screenshot triggers, overlay-select handler |
| `webview_runtime.rs` | Windows WebView2 availability check and native recovery dialog before app initialization; opens the official download page only on acceptance |
| `external_links.rs` | Validates HTTP/HTTPS/mailto URLs and opens them through the Windows protocol handler, outside the app webview |
| `config.rs` | `Config` struct, load/save (`~/.contextkey_config.json`), `ConfigState` (Mutex) |
| `storage.rs` | Imports legacy saved files when ContextKey files are absent; preserves existing files and original contents |
| `window_state.rs` | Validated popup-size persistence (`~/.contextkey_window_state.json`) |
| `keyhook.rs` | The app's whole input FFI: owns the `WH_KEYBOARD_LL` hook, VK constants, `cursor_pos()`, `ctrl_is_down()`. Non-Windows stubs so `cargo check` runs on Linux |
| `hotkey.rs` | Table-driven two-step state machine over `keyhook` events, hot-swapped from config via `ArcSwap`; unit-tested against the `SUPPORTED_THEN` contract |
| `clipboard.rs` | `get_clipboard_after_copy`: polls arboard up to 10 times at 20ms intervals for changed text |
| `api.rs` | reqwest + SSE to chat/completions; emits `<flow>://chunk\|done\|error`; routes to `vision_model` when the history carries an image; `StreamRegistry` holds per-window cancellation flags |
| `screenshot.rs` | xcap multi-monitor capture, crop, JPEG encode (q60 preview / q80 ≤1568px for API); `ScreenshotStore` holds captures in RAM only |
| `tts.rs` | Read-aloud via the `tts` crate (SAPI on Windows); single active utterance |
| `windows.rs` | `show_cursor_popup` (shared builder for both popups, differences in `PopupSpec`), settings, per-monitor selection overlays, and `show_toast` |

### Frontend (`frontend/`)
| File | Purpose |
|---|---|
| `theme.css` / `window.css` | Light/dark tokens, logo and icon helpers; shared transparent popup frame and contained shadow |
| `icons.js` | Inline SVG `<symbol>` sprite; injected as first `<body>` child |
| `popup.*` | Frameless translate popup: draggable, spinner, streaming, error+retry, Esc+blur close |
| `chat.*` | Frameless chat popup: context strip, transcript, input bar, streaming bubbles, per-turn error+retry. Esc/close only — NO blur close |
| `toast.*` | Transient cursor-anchored notice; message via query string, self-closes after 2s, never takes focus |
| `markdown.js` / `markdown.css` | Shared Markdown, math, highlighting, and inert diagram previews; preserves selection and content scrolling during streaming |
| `vendor/` | Committed local rendering libraries, fonts, licenses, and hashes; rebuilt with `npm run build:vendor`, Mermaid loaded only when needed |
| `overlay.*` | Fullscreen region-select overlay: frozen screenshot on a canvas, drag to select, Esc/right-click cancels |
| `settings.*` | Section navigation for Connection, Translation, Shortcuts, and Appearance; saved theme selector; API key reveal; persistent save/test actions |

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
- Chat retries retain the failed user-message identity and submit history only through that question; the replacement reply is inserted beside it. Pending screenshots are consumed when sending, while a separate session list enforces the two-image limit across turns and replaces evicted previews with visible placeholders.
- Chat scrolls to the pending reply once when sending. Streaming, completion, errors, composer growth, attachments, and resizing preserve the reading position. **Jump to latest** is a one-time action; reaching the bottom never enables automatic following.
- **Cancellation flags belong to the window, not the stream** (`api::StreamRegistry`). Popup labels are fixed constants, so keying by label alone let a closed window's late `Destroyed` cancel the *next* window's stream. `claim` (on window build) hands each window its own flag and retires the previous one. Checked between reads, never mid-parse.
- Errors ride `<flow>://error` with `{summary, detail, retryable}`, NOT the chunk event — on the chunk event they were indistinguishable from model output and couldn't be styled or retried. Auth/404 are non-retryable.
- Config keeps the old Python-compatible schema. On first load, `storage::read_with_legacy` copies `~/.quicktranslator_config.json` to `~/.contextkey_config.json` only if the new file is missing; popup size migrates similarly from `~/.quicktranslator_window_state.json` to `~/.contextkey_window_state.json`. Legacy files are never changed. Existing ContextKey files win even if malformed; import-write failures still allow legacy data to load for that session. `http://` base_url saves with a non-blocking "API key travels unencrypted" warning.

**Windows / UI (Tauri gotchas)**
- **Never `sleep()` then `emit()` at a window you just created.** This has shipped three times (translate chunks, overlay preview, chat image). Events are dropped, not queued, and WebView2 takes 100–300ms to start — the payload vanishes silently. Use a handshake (`popup://ready`) or better a **pull**: store the payload in managed state and let the frontend `invoke` for it once listeners are up (`get_overlay_preview`, `take_pending_image`). `take_pending_image` *takes* rather than clones, so a stale crop can't re-attach to a later session.
- **An "unfocused" event is not proof the user left.** Interactions *inside* the popup drop webview focus on Windows too, and closing on the raw event made the translate popup vanish on a header click. `data-tauri-drag-region` is the main offender: `ReleaseCapture()` + `WM_NCLBUTTONDOWN` hands the window to the OS move loop, which reports the webview unfocused mid-drag; native calls (TTS/SAPI, clipboard) flicker focus similarly. `installBlurToClose` in `popup.js` suppresses blur while a drag-region mousedown is live, otherwise waits 200ms and re-queries `isFocused()` (a query, so `core:window:default` already allows it). The drag flag needs a backstop timer as well as `mouseup`, because the move loop can swallow the mouseup and a stuck flag would kill blur-close permanently.
- **Popup chrome is a recoverability decision, expressed as data** (`PopupSpec` in `windows.rs`). Translate is ephemeral: blur-closes, `skip_taskbar(true)`, one hotkey press regenerates it. Chat is persistent: NO blur-close, `skip_taskbar(false)`, because it holds history and screenshots that can't be reconstructed and would be unreachable without a taskbar entry. That is also what makes `chat://closed` → drop captures correct: close is always deliberate.
- Repeated chat hotkeys focus the existing window. New selections are stored in `PendingChatSelection`, signalled with `chat://selection-available`, and consumed by `take_pending_chat_selection`; accepting a new selection explicitly resets the conversation. Existing windows also pull screenshots on `chat://image-available` instead of relying on an image payload delivered before listeners exist.
- Blur-to-close only fires after the window gained focus once (built `.focused(true)`).
- The toast is `focused(false)` on purpose — stealing focus from the app being typed in would be worse than the silence it replaces. It therefore has no blur or key events, so a timer is its only dismissal.
- **Tauri 2 ACL:** `core:window:default` grants read/query only. `window.close()` needs `core:window:allow-close`, `data-tauri-drag-region` needs `core:window:allow-start-dragging` — both in `capabilities/default.json` or the calls are silently denied. Custom commands and backend-side window calls are NOT ACL-gated.
- **DPI-safe positioning:** `keyhook::cursor_pos()` reports PHYSICAL px, the builder's `position()` takes LOGICAL px. Build hidden → `set_position(PhysicalPosition)` using the cursor monitor's `scale_factor()`/bounds (`monitor_from_point`) → `show()` + `set_focus()`. Never pass physical coords to `.position()`.
- **Overlay sizing:** size with `PhysicalSize` after build, not the builder's logical `inner_size` (which resolves against the creating monitor's scale, not the target's). `set_position` BEFORE `set_size` — moving across monitors makes Windows suggest a rescaled rect. Build `.resizable(true)` so `set_size` is honoured, then `set_resizable(false)`.
- **Don't trust `devicePixelRatio` for the crop.** It can disagree with the monitor's real scale factor; a factor off by 1.25× crops a smaller region that gets upscaled and looks "zoomed in". The overlay reports its canvas size and the backend derives `capture_width / viewport_width`, self-calibrating. Same trap inside the canvas: a rect in CSS px is not a valid `drawImage` *source* rect against a physical-res image.
- Tray icon is owned by code (`TrayIconBuilder`); `tauri.conf.json` must NOT declare `app.trayIcon` or two icons appear.

**Theme / assets**
- Indigo accent (`#AD9FFF` dark / `#6952D5` light); the saved `theme` preference is `system` (default for older configs), `light`, or `dark`. Settings → Appearance applies it on Save. `main.rs` calls `app.set_theme` before creating windows and after successful config updates; Windows propagates it to native title bars and WebView2's `prefers-color-scheme`, so every surface keeps using the same CSS tokens. Leave individual window themes unset so they inherit the app preference. No literal hex outside `theme.css` except `#ffffff` on colored buttons.
- Settings opens at 600×680 with a 360×420 minimum. Its four section links scroll one continuous form so validation can focus any field. Translation switches to compact chrome at 240px height; keep the initial size estimates in `popup_sizing.rs` aligned with `popup.css`.
- Functional glyphs use the inline-SVG `<symbol>` sprite (`icons.js`) with `currentColor`. Brand marks use the supplied artwork in `frontend/brand.png`, not a placeholder glyph.
- Translation, chat, and toast use `.transparent(true).shadow(false)`: native shadows add an unwanted white border on undecorated Windows windows. `window.css` keeps both html and body transparent and paints `.floating-window` inside an 8px gutter for the CSS shadow. Never put the translation background directly on body; Chromium propagates it to the canvas, creating opaque square corners. Browser pixel tests cover corners/edges in both themes; native Windows drag, resize, and DPI behavior still need desktop verification. Settings stays decorated.
- App assets come from `icons/generate_icon.py` and the supplied `icons/brand.png` logo (1254×1254 original; current share URL is recorded in the generator). It preserves the artwork and produces a 512×512 RGBA PNG, Windows ICO sizes from 16×16 to 256×256, and `frontend/brand.png` at 128×128. Tray uses `default_window_icon()`; the same assets brand the executable, installer, README, and UI.

## Manual QA
[Release validation](openspec/QA-CHECKLIST.md) requires a Windows desktop and an API endpoint for interactive checks. Checked items record v0.4.0 testing rather than a pass for the current build. Re-run affected checks before tagging, and use request logs, memory measurements, or provider diagnostics for checks that the UI cannot establish.

## Session Rules
- **Interrupted sessions:** audit `git status` + `git diff --stat` first, read changed/new files, continue from where it stopped — never start from scratch.
- **Codebase search — `auggie` first.** The `auggie` MCP server (`.mcp.json`) keeps a live semantic index. Call `codebase-retrieval` (`directory_path`: the absolute repository root from `git rev-parse --show-toplevel`) as the FIRST step for any "where/how does X work" question spanning files not yet read — one broad natural-language question beats several narrow ones or three rounds of grep. Do it unprompted before `/opsx:propose`, `/opsx:apply`, `/opsx:explore`, when resuming a session, and for any bug report naming a symptom rather than a file.
  - Skip it for a known symbol (`grep`), a known path (`Read`), or git history (not indexed). It reads the working tree only, so just-written edits may lag — confirm anything load-bearing with `Read` before editing.
  - `.augmentignore` excludes archived delta specs (verbatim duplicates of `openspec/specs/`, they crowded out real code), build output, and binary icons. It is read once at server start, so edits need an MCP restart (`/mcp` → reconnect).
- **All project memory lives in this file** — do NOT use `~/.claude/` memory files.
- **Dependencies — minimal, not zero.** Adding a crate is fine when it makes the project meaningfully better and is safe: actively maintained, widely used, trusted source, pinned version, checked against typosquatting. Prefer the lightest option; don't reinvent what a vetted crate does well.

## Roadmap / Known Gaps
Behavior requirements are maintained under `openspec/specs/`, with historical decisions under `openspec/changes/archive/`. Not built: persistent translation history and a dedicated source-language detection feature.
Known weak spots, unverified against current code — confirm before acting: clipboard capture is polling with a fixed retry budget (can return stale text); completion token cap is hardcoded (long replies truncate silently); the whole 50-message chat window is sent each turn; the API key sits in plaintext JSON (OS keychain would be better); unit tests cover hotkey mapping, popup sizing, and saved-data migration, while config behavior beyond migration, clipboard polling, and SSE parsing have limited coverage.
If a keyboard hook still perturbs typing after `keyhook.rs`, the next lever is moving the state machine off the hook thread (ring buffer + worker), leaving the callback as "record VK, return" — deliberately deferred as unmeasured, see `ime-safe-keyboard-hook/design.md` D7.
