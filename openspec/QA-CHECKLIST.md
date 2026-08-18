# Pre-release Manual QA Checklist

Requires a Windows run with a global keyboard hook + API key (not headless/CI). Verify before tagging.

Ticked items were confirmed on real Windows against v0.4.0 (2026-07-27) — nothing failed. Unticked items are simply not exercised yet, not known-broken. The ones still open mostly need instrumentation rather than clicking: the duplicate-question check wants a proxy or verbose server log, the capture-release check wants an RSS watch, and cancellation wants provider usage visible.

The keyboard-hook rewrite (`ime-safe-keyboard-hook`) invalidated the input-path ticks: the whole hook is new code, so re-run **Keyboard hook / IME** plus the hotkey and cursor-anchoring items even where they were ticked for v0.4.0.

## Core
- [ ] Ctrl+C+Space opens chat with selection as context; Ctrl+C+C still translates; neither double-fires
- [ ] Esc / close button close the chat popup; clearing context switches to Free Chat. Clicking OUTSIDE must NOT close it
- [ ] Custom prompt loads, saves, resets to default; blank-save falls back to default template; a subsequent translate uses the saved prompt
- [x] `cargo tauri build` passes on Windows CI
- [ ] Packaged exe shows NO UAC prompt; hotkeys work over normal windows; inactive over an elevated foreground window unless the app itself runs as admin

## Screenshot → vision chat
- [ ] Screenshot hotkey (default RCtrl RCtrl) freezes the screen and shows the dimmed overlay on EVERY monitor; the frozen image is the real screen, not black
- [x] **Crop fidelity:** the region sent matches the region dragged — no zoom, no offset. Check at 125%/150% scaling and on a non-primary monitor, where the CSS→physical factor goes wrong
- [ ] The bright cutout under the cursor tracks the drag accurately
- [ ] Esc and right-click cancel with no popup; a <5px drag is ignored
- [ ] Crop opens chat with the thumbnail attached and NOTHING sent until a question is typed; a 2nd capture attaches a 2nd thumbnail; a 3rd evicts the oldest
- [ ] Capture → close chat without sending → capture again: only the NEW image appears
- [ ] Vision request routes to `vision_model` when set, falls back to `model` when blank
- [ ] Closing chat / cancelling frees the captures (watch RSS — images are RAM-only)

## Chat correctness + window lifecycle
- [ ] **No duplicate question:** with a proxy or verbose server log, a 2-turn chat sends the question ONCE per turn; an image turn sends one multimodal entry
- [x] Chat survives a focus change: transcript, typed-but-unsent input, and thumbnails intact; an in-flight response keeps streaming
- [x] Chat is alt-tab-able / in the taskbar; translate popup is not
- [ ] **Cancellation:** close a popup mid-stream → the request stops. Two translate triggers in a row → the second popup shows only its own tokens
- [ ] Closing the translate popup mid-stream does NOT kill an in-flight chat stream
- [ ] **Empty-clipboard toast:** translate hotkey with nothing selected → a notice near the cursor that does NOT steal focus and self-dismisses. Nothing appears on success
- [ ] Bad API key → readable summary (not raw JSON), Details expands the raw body, no Retry. Unreachable base_url → Retry offered and re-issues
- [ ] Chat error: the failed turn shows the error in its bubble, Send re-enables, Retry replaces the bubble without duplicating history
- [ ] **OQ:** does chat `always_on_top` still feel right now that it persists? If intrusive, drop it and record the decision
- [ ] **OQ:** is the ~2s toast duration right? Tune `DISMISS_MS` in `toast.js` if not

## Keyboard hook / IME (the reason `keyhook.rs` exists)
- [ ] **A/B typing check — do this first.** Quit from the tray (not just closing a popup), type a long Vietnamese passage FAST in Notepad, relaunch, retype the same passage at the same speed. Accents must compose identically both times. If the app-running pass is worse, the hook body is still at fault → `design.md` D7 (move the state machine off the hook thread). Repeat with a CJK IME if one is available
- [ ] Same A/B at speed inside the chat input (a WebView2 text field, not a native one)
- [ ] Hotkeys do NOT fire from synthesised input: send the bound sequence via AutoHotkey or `SendInput` → nothing should trigger (`LLKHF_INJECTED` is ignored by design)
- [ ] After tray Quit, the hotkeys stop working immediately — the hook is uninstalled, not orphaned
- [ ] Double-tap still needs a real release: HOLD Ctrl+C so it key-repeats → must NOT trigger translate

## Configurable hotkeys
- [x] All three hotkeys re-bind from Settings and take effect WITHOUT restart; the old binding stops firing
- [ ] Re-capturing the screenshot binding to RCtrl RCtrl works (a modifier is a legal "then")
- [ ] An unsupported key (Left Ctrl, numpad, arrows) is refused at capture rather than saved-and-dead
- [ ] Duplicate combos are blocked inline; a hand-corrupted `hotkeys` block falls back to defaults

## Runtime footprint
- [ ] **Single instance:** second launch does NOT start a second process (surfaces Settings); one hotkey press → exactly ONE popup + ONE API request
- [ ] Both popups anchor next to the cursor on high-DPI and multi-monitor (incl. non-primary at a different scale)
- [ ] `http://…` base_url saves but warns; `https://`/empty shows no warning
- [ ] Hotkey stays responsive under heavy mouse/typing and still fires after long uptime

## UX
- [x] **Translate popup survives its own chrome:** drag the header repeatedly, then click Copy / speaker / Details / Retry — it must NOT close. Clicking a different app still closes it within ~200ms; Esc and the close button are unaffected
- [ ] Translate popup resizes by dragging its edge; truncated original shows full text on hover; Copy is disabled while streaming, then copies plain text with "Copied ✓". If it shows "Copy failed" (WebView2 blocks `navigator.clipboard`), switch to the Tauri clipboard-manager plugin + grant write permission in `capabilities/default.json`
- [ ] Chat input: Enter sends, Shift+Enter newline (auto-grows ~120px then scrolls), Ctrl+Enter sends, whitespace-only does nothing, textarea resets after send
- [ ] Chat input with a Vietnamese/CJK IME: Enter to CONFIRM a composition does NOT send
- [ ] Settings: malformed/scheme-less base_url blocked inline; empty base_url saves; empty api_key saves with a warning; "Test connection" uses the current (possibly unsaved) form values

## UI theme
- [ ] Both popups + Settings render correctly in dark and light; indigo accent for primary/link/focus; nothing washed-out or invisible
- [ ] All glyphs are SVG (no emoji); icons tint per hover/disabled/theme; spinner spins
- [ ] Popups show rounded corners + drop shadow. **OQ:** confirm `transparent:true` didn't break shadow / always-on-top / positioning; else take the opaque + CSS-radius fallback and note it
- [ ] Tray icon + installer show the two-arrows indigo icon, crisp at small sizes
