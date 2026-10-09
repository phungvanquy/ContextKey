<p align="center">
  <img src="src-tauri/icons/icon.png" alt="ContextKey logo" width="112" height="112" />
</p>

# ContextKey

**Understanding, a shortcut away.**

ContextKey brings translation and AI assistance to your Windows desktop. Select text or capture a screen region, invoke a shortcut, and work with the result in a popup beside your cursor.

[Download](https://github.com/phungvanquy/ContextKey/releases) · [Getting started](#getting-started) · [Configuration](#configuration) · [Development](docs/DEVELOPMENT.md) · [Report an issue](https://github.com/phungvanquy/ContextKey/issues)

## Features

| Capability | What you can do |
| --- | --- |
| Text translation | Translate copied text into your preferred language, with streamed results, copy, and read-aloud controls. |
| Contextual chat | Ask follow-up questions about selected text, or clear the context to start a general conversation. |
| Screenshot questions | Capture a region on any monitor, review the preview, and ask a vision-capable model about it. |
| Configurable shortcuts | Customize the keyboard sequences for translation, chat, and screen capture. |
| Provider settings | Use a compatible API endpoint, choose your models, and customize the translation prompt. |
| Desktop integration | Keep the app in the system tray and use a light or dark theme that follows Windows settings. |

Windows is the current desktop target. The global keyboard hook is implemented with Windows APIs; macOS and Linux desktop support is not implemented.

## Getting started

1. Open [Releases](https://github.com/phungvanquy/ContextKey/releases) and download the Windows installer attached to a release.
2. Install and launch the app. ContextKey runs in the system tray; Settings opens automatically when no API key is configured.
3. Enter your **API Key**, **Base URL**, and **Model**. Choose a **Target Language** for translation.
4. Select **Test connection**, then **Save**. You can reopen Settings from the tray menu at any time.
5. Select text in another application and try a shortcut below.

The installer can download the WebView2 runtime when needed; that installation step requires an internet connection. See [Tauri's WebView2 installation documentation](https://v2.tauri.app/distribute/windows-installer/#downloaded-bootstrapper).

Earlier releases may still use the **Quick Translator** name. See [upgrading](#upgrading-from-quick-translator) for how existing settings carry over to ContextKey.

## Keyboard shortcuts

| Action | Default sequence | How to use it |
| --- | --- | --- |
| Translate | `Ctrl+C` → `C` | Select text, hold Ctrl, and press C twice within 600 ms. Release C between presses. |
| Chat | `Ctrl+C` → `Space` | Select text, press Ctrl+C, then press Space within 600 ms while continuing to hold Ctrl. |
| Screenshot | `Right Ctrl` → `Right Ctrl` | Press and release Right Ctrl twice within 400 ms, then drag to select a screen region. |

These are two-step sequences. Change the bindings in **Settings → Hotkeys** and select **Save** to apply them immediately. Shortcut keystrokes also reach the foreground application, so choose bindings that work well with your other tools. With a modifier-only prefix, copy the text before invoking translation or chat.

## Using ContextKey

### Translate text

Select and copy text with the translation shortcut. The result streams into a popup near the cursor. Use **Copy** after the response finishes, or the speaker button to read the translation aloud.

Drag the header to move the popup, or resize its edges to adjust the reading area. Manual sizes are remembered. Press **Esc** or click outside the popup to close it.

### Ask about selected text

Use the chat shortcut to open a conversation with the copied text as context. Press **Enter** or **Ctrl+Enter** to send; use **Shift+Enter** for a new line.

Chat stays open when you switch applications and is accessible from the taskbar. Invoking the chat shortcut again brings back the existing conversation, including your draft. If you copied different text, choose **New chat with selection** to use it. **New chat** starts a general conversation; clearing the selected-text context also resets the visible conversation and switches to free chat. A confirmation protects existing messages and screenshots. Closing the window ends the session.

Expand the selected-text strip to read the full source. While a reply is streaming, scroll up to read earlier messages; **Jump to latest** resumes following the reply. Retrying a failed reply keeps it beside its original question.

### Ask about a screenshot

Use the screenshot shortcut and drag across the area you want to capture. ContextKey opens the chat window with a preview attached. Enter a question and send it to submit the image to your configured endpoint.

Click a thumbnail to inspect it, or choose **Remove** before sending. Submitted screenshots stay beside their messages. A screenshot captured while a reply is streaming is kept for your next question.

Press **Esc** or right-click to cancel a capture. A chat session retains at most two screenshots; adding a third removes the oldest image and marks its removal in the conversation history.

## Configuration

Open **Settings** from the system tray.

| Setting | Purpose | Default |
| --- | --- | --- |
| API Key | Credential sent to your configured API endpoint. | Empty; required for requests. |
| Base URL | Root URL of an OpenAI-compatible Chat Completions API. | `https://api.openai.com/v1` |
| Model | Model used for translation and text chat. | `gpt-4o-mini` |
| Vision Model | Optional model used when a conversation contains images. | Empty; uses the main model. |
| Target Language | Language used by the translation prompt. | `Vietnamese` |
| Custom Prompt | Instructions for translation; `{target_language}` is replaced with the configured language. | Translation-only instructions. |
| Hotkeys | Keyboard sequences for translation, chat, and screenshots. | See [Keyboard shortcuts](#keyboard-shortcuts). |

Choose model identifiers supported by your endpoint. Screenshot questions require an image-capable model. Compatibility depends on the endpoint's support for streaming Chat Completions requests and the configured model.

**Test connection** uses the values currently entered in the form, including a separate vision model when provided. It sends a text-only probe, so a successful test does not by itself confirm image support. Select **Save** to apply settings without restarting.

The app requires a non-empty API Key even for a local endpoint. If your local server ignores authentication, a placeholder value can satisfy this field; otherwise use the credential required by that server.

An example translation prompt:

```text
Translate the user's text to {target_language}.
Reply with only the translation. Preserve the original formatting where possible.
```

Leave the prompt blank or use **Reset to default** to restore the built-in instructions.

## Data and storage

| File in your user profile directory | Contents |
| --- | --- |
| `.contextkey_config.json` | API credentials, models, language, prompt, and hotkeys. |
| `.contextkey_window_state.json` | The translation popup's saved manual size. |

On Windows, these files are normally under `%USERPROFILE%`, for example `C:\Users\YourName\.contextkey_config.json`.

Selected text, conversation messages, and submitted screenshots are sent to the endpoint you configure. Capturing a screenshot alone does not send it; transmission starts when you submit a question. ContextKey holds captures in memory and does not write screenshot files to disk. Conversation history lasts only for the current chat window, with at most 50 messages retained after each completed response.

The API key is stored in plain JSON rather than an operating-system credential vault. Exclude configuration files and credentials from issue reports. Remote endpoints should use HTTPS; Settings warns when an HTTP URL would send the key without transport encryption.

## Upgrading from Quick Translator

Quit Quick Translator before starting ContextKey so both apps do not respond to the same shortcuts.

When a ContextKey data file is missing, the app imports its legacy equivalent:

| Legacy file | ContextKey file |
| --- | --- |
| `.quicktranslator_config.json` | `.contextkey_config.json` |
| `.quicktranslator_window_state.json` | `.contextkey_window_state.json` |

The original files remain intact. Existing ContextKey files take priority, including when their contents are malformed. Subsequent settings and size changes are saved to the ContextKey files.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| A shortcut does nothing | Confirm the app is running in the tray, check the saved binding, and complete both steps within its time window. |
| Shortcuts fail in an elevated window | The app normally runs without administrator privileges. If you need to use it with an elevated application, quit and run ContextKey as administrator for that session. |
| The wrong text appears | ContextKey reads the clipboard. Confirm that the foreground application copied your selection; otherwise earlier clipboard text may be used. |
| Translation or chat fails | Check the API key, endpoint URL, model access, and **Test connection** result. Expand **Details** in the error display for more information. |
| Text chat works but screenshots fail | Configure an image-capable model and confirm that the endpoint accepts image input. |
| Settings appear to reset | Check `.contextkey_config.json` for malformed JSON. The app uses defaults in memory when loading fails and preserves the file for recovery. |
| A Linux build reports missing GLib or WebKit libraries | See [development prerequisites](docs/DEVELOPMENT.md#prerequisites). Native dependencies are required even when running the Rust test suite. |

To report a problem, open an [issue](https://github.com/phungvanquy/ContextKey/issues) with the app version, Windows version, steps to reproduce, and relevant error details. For display issues, include monitor scaling. Remove API keys and private text from logs or screenshots.

## Development

ContextKey uses Rust, Tauri 2, and static HTML/CSS/JavaScript. No Node.js build pipeline is required.

- [Development guide](docs/DEVELOPMENT.md): prerequisites, local builds, architecture, tests, releases, and icon maintenance.
- [Manual QA checklist](openspec/QA-CHECKLIST.md): Windows validation before a release.
- [Behavior specifications](openspec/specs/): requirements for the app's features.
- [Project memory](CLAUDE.md): implementation constraints and decisions for ongoing maintenance.
