# ContextKey release validation

Use this checklist to validate a Windows release candidate with a real keyboard, an API endpoint, and the packaged app. Automated tests do not cover desktop focus, IME composition, display scaling, or capture behavior.

## Test record

Record the environment and results with the release candidate.

| Field | Value |
| --- | --- |
| Version and commit | |
| Test date and tester | |
| Windows version | |
| Monitor layout and scaling | |
| Text and vision models | |
| Result and issue references | |

Existing checkmarks record tests performed against v0.4.0 on 2026-07-27. They are historical evidence, not validation of the current build. An unchecked item has not been confirmed in this record and does not necessarily indicate a known failure.

The keyboard-hook rewrite requires a new pass through keyboard, IME, shortcut, and cursor-positioning checks. The ContextKey rename and replacement logo require packaging and data-migration checks. Re-run applicable checks for each candidate and record the results above or in the release record.

## Branding and upgrades

- [ ] The installer, Start menu entry, tray tooltip, window titles, and Settings use ContextKey. The standalone executable is `contextkey.exe`.
- [ ] After quitting the old app, launch ContextKey with only the legacy config and window-state files present. Confirm that credentials, custom prompts, hotkeys, and popup size carry over.
- [ ] Saving settings and resizing the popup write the ContextKey files without changing the legacy files.
- [ ] When both file sets exist, ContextKey uses its own settings and popup size.

## Core workflows

- [ ] `Ctrl+C` → `Space` opens chat with the copied text as context. `Ctrl+C` → `C` translates it. Each sequence triggers exactly once.
- [ ] Esc and the close button dismiss chat. Clearing context starts a new conversation. Clicking another application leaves chat open.
- [ ] A custom prompt loads, saves, and resets correctly. Saving a blank prompt restores the default, and the next translation uses the saved prompt.
- [x] `cargo tauri build` passes on Windows CI.
- [ ] The packaged app starts without an elevation prompt. Shortcuts work over ordinary windows; test elevated foreground windows separately with the app run as administrator.

## Screenshot and vision chat

- [ ] The default screenshot sequence, `Right Ctrl` → `Right Ctrl`, captures every monitor and shows a frozen image in each selection overlay.
- [x] The submitted crop matches the selected region without zoom or offset. Check at 125% and 150% scaling and on a secondary monitor.
- [ ] The highlighted selection follows the drag accurately.
- [ ] Esc and right-click cancel capture. A region smaller than five pixels is ignored.
- [ ] Completing a capture attaches a thumbnail without making an API request. A second capture is retained; a third evicts the oldest image.
- [ ] Capture an image, close chat without sending, and capture again. Only the new image is attached.
- [ ] Image requests use `vision_model` when configured and otherwise use the main model.
- [ ] Closing chat or cancelling capture releases retained captures. Use memory instrumentation to verify the result.

## Chat and request lifecycle

- [ ] A request log confirms that each question is sent once, including questions with image attachments.
- [x] Switching focus preserves chat history, unsent input, attachments, and an in-flight response.
- [x] Chat is accessible from the taskbar and Alt+Tab; the translation popup has no taskbar entry.
- [ ] Closing a popup during streaming cancels its request. Triggering translation twice does not mix content from the two requests.
- [ ] Closing translation does not cancel an independent chat request.
- [ ] Translation with an empty clipboard displays a brief notice near the cursor without taking focus. Successful requests show no extra notice.
- [ ] Authentication and missing-endpoint errors show a readable summary and expandable details without Retry. A recoverable connection failure offers Retry.
- [ ] A failed chat turn displays its error, re-enables Send, and retries without duplicating the user question.

Use a request proxy or provider diagnostics for duplicate-message and cancellation checks. UI behavior alone does not verify network cancellation.

## Keyboard input and IME

- [ ] Compare fast Vietnamese Telex input in Notepad with ContextKey stopped and running. Accents and composition must behave identically. Repeat with a CJK IME when available.
- [ ] Repeat the composition check inside the chat input.
- [ ] Synthetic input from AutoHotkey or `SendInput` does not trigger shortcuts.
- [ ] After choosing **Quit** from the tray, shortcuts no longer trigger the app.
- [ ] Holding Ctrl+C so that the key repeats does not trigger translation; a release between presses is required.

If the hook affects composition, record the reproduction details and consult the [input-hook design](changes/archive/2026-08-18-ime-safe-keyboard-hook/design.md) before changing the callback.

## Shortcut configuration

- [x] All three shortcuts can be changed in Settings and take effect without restarting. Previous bindings stop firing.
- [ ] The screenshot binding can be changed back to `Right Ctrl` → `Right Ctrl`.
- [ ] Unsupported keys, including left Ctrl, numpad keys, and arrows, are rejected by the capture control.
- [ ] Duplicate bindings cannot be saved. Invalid stored hotkey entries fall back to defaults.

## Runtime and display behavior

- [ ] The Evergreen MSIX launches on supported Windows 10/11 with the runtime installed, including offline, without a setup prompt. Its archive contains no runtime or installer and remains below the 25 MiB package budget.
- [ ] In a disposable Windows environment without WebView2, a native prompt appears before settings writes, tray creation, or hook installation. No exits without opening a browser; Yes opens Microsoft's download page and exits. A failed browser launch shows the URL. Installing Evergreen and relaunching restores normal startup. Repeat for the standalone EXE.
- [ ] Upgrading the old Fixed Version MSIX (`1.0.0.0`) to the Evergreen candidate (`1.0.1.0`) preserves settings and works without the old runtime directory. Test with and without shared Evergreen present; also check uninstall.
- [ ] Launching a second instance brings Settings forward instead of starting another active hook. A shortcut still produces one popup and one API request.
- [ ] Popups appear near the cursor on monitors with different scaling, including a secondary monitor.
- [ ] Saving an HTTP endpoint displays a transport warning; an HTTPS or empty URL does not.
- [ ] Shortcuts remain responsive during heavy typing, mouse activity, and an extended session.

## Interaction and accessibility

- [x] Moving the translation popup and using Copy, read-aloud, Details, or Retry keeps it open. Clicking another app closes it after the focus check; Esc and the close button also work.
- [ ] The translation popup can be resized. The source-text tooltip shows the full input. Copy is unavailable during streaming and copies plain text after completion.
- [ ] Enter and Ctrl+Enter send chat messages; Shift+Enter inserts a new line. Empty messages are ignored, and the input resets after sending.
- [ ] Sending a chat message reveals the pending reply once. Long replies preserve the reading position during streaming, completion, and errors. **Jump to latest** and manual scrolling to the bottom do not enable automatic following; growing the input, attaching a screenshot, and resizing do not pull the transcript down.
- [ ] Enter confirms an active Vietnamese or CJK composition without sending the message.
- [ ] Settings rejects malformed endpoint URLs. Empty credentials can be saved with a warning, and **Test connection** uses the current form values.

## Appearance

- [ ] In both popups, stream tables, nested lists, highlighted code, formulas, Markdown images, and Mermaid diagrams. Wide content scrolls within the response at minimum size and at 125%/150% scaling. Selected text, content scroll, and keyboard focus survive new chunks, completion, and a connection failure.
- [ ] Switch themes with a rendered diagram visible; its colors update and its source remains available. Invalid formulas or diagrams show readable source, and resetting chat while a diagram loads leaves the next conversation intact.
- [ ] Activate HTTP/HTTPS and email links with pointer and keyboard. The default browser/mail application opens, the popup webview does not navigate, and a failed launch displays an error. Executable, local-file, and app-protocol links remain inactive.
- [ ] Translation, chat, and Settings remain readable in both light and dark themes, with consistent focus and hover states.
- [ ] Settings → Appearance → Theme saves System/Light/Dark, updates open windows and the Settings title bar, and applies to newly opened popups/toasts and after restart. Light/Dark stay fixed when the Windows app theme changes; System resumes following it. Unsaved choices and failed saves do not change the active theme.
- [ ] Interface icons inherit their state colors, and loading indicators animate correctly.
- [ ] Rounded popup corners, shadows, topmost behavior, and positioning work together on Windows.
- [ ] Translation and chat have transparent corners without an extra white outline or clipped shadow in light/dark mode at 100%, 125%, and 200% scaling. Dragging and resizing still work after disabling native shadows.
- [ ] The app, tray, installer, Settings, popup headers, notifications, and chat welcome screen show the supplied ContextKey logo clearly, including at small icon sizes.

## Design review questions

Record observations separately from pass/fail checks:

- Does an always-on-top chat window remain useful during longer conversations?
- Is the approximately two-second notification duration readable without becoming intrusive?
- Do transparent popup windows need a rendering fallback on any supported Windows configuration?
