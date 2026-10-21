# ContextKey development guide

This guide covers building and maintaining ContextKey. For installation and everyday use, see the [README](../Readme.md).

## Prerequisites

Windows is the supported desktop target and the platform used by CI. Install:

- A stable Rust toolchain with the MSVC target.
- Microsoft C++ Build Tools with the **Desktop development with C++** workload.
- Microsoft Edge WebView2.
- Git.

Follow the [Tauri 2 Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows) for toolchain and native dependency setup.

Install the Tauri 2 CLI:

```sh
cargo install tauri-cli --version "^2" --locked
```

The frontend consists of static HTML, CSS, and JavaScript, so normal development does not require Node.js or an npm install. Python and Pillow are needed only when regenerating the app icons.

Non-Windows keyboard-hook stubs support development work, but they do not provide working desktop hotkeys. Building or testing the full crate on Linux still requires native GUI, capture, and speech dependencies. A `glib-2.0` or WebKit `pkg-config` error indicates missing system development packages; start with the [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux). Validate desktop behavior on Windows.

## Local development

Clone the repository:

```sh
git clone git@github.com:phungvanquy/ContextKey.git
cd ContextKey
```

Run the following commands from the repository root.

Start the app in development mode:

```sh
cargo tauri dev --config src-tauri/tauri.conf.json
```

The app opens Settings when no API key is configured. Use an endpoint and models available to your account, then select **Test connection** and **Save changes**. The development app uses the same user-profile settings files as the installed app.

Run the Rust unit tests:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --bins
```

The optional browser regression suite uses Node.js and Playwright. It serves the static frontend with simulated Tauri commands and events; it does not contact a model provider or read your saved settings.

```sh
npm ci
npx playwright install chromium
npm run test:ui
```

Tests run in light and dark themes and cover chat retry, attachment retention and eviction, context resets, scrolling, keyboard navigation, settings validation, theme selection/save/reload, and rendered popup edge transparency at normal/minimum sizes. Markdown tests cover tables, nesting, code literals, split streaming delimiters, text selection, content scrolling, links and images, math, diagram lifecycle, and unsafe content. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use an existing Chromium executable. Native Windows theme propagation, external browser launch, window reuse, focus, shortcuts, capture, and monitor scaling still require desktop validation.

The saved `theme` preference uses Tauri's [app-wide `set_theme`](https://docs.rs/tauri/latest/tauri/struct.AppHandle.html#method.set_theme) at startup and after saving. On Windows, this updates native windows and WebView2's color preference; `theme.css` continues to use `prefers-color-scheme`. Keep window-specific theme overrides unset so new and existing windows inherit the app preference. The browser suite mocks config persistence; it does not exercise the native theme API.

### Updating Markdown libraries

Rendering uses pinned npm dependencies bundled into committed files in `frontend/vendor/`. Ordinary Tauri builds still use static assets without Node.js. Markdown, math, highlighting, and diagram rendering require no CDN; Markdown image URLs can load external images. Mermaid loads only when a diagram is present. The generated assets total about 6 MiB before packaging compression.

After changing a rendering dependency or a vendor entry point:

```sh
npm ci
npm run build:vendor
npm run check:vendor
npm audit
npm run test:ui
```

Commit `package.json`, `package-lock.json`, and the regenerated assets together. The generator includes third-party licenses, local KaTeX fonts, package versions, and asset hashes. `check:vendor` rebuilds in memory and verifies that the committed output matches the pinned inputs.

Raw model HTML stays escaped. Links use explicit URL validation in both JavaScript and Rust; Windows opens them outside the privileged webview. KaTeX disables trusted commands and limits expansion. Mermaid uses strict mode with model-provided configuration disabled; its sanitized SVG is displayed as an inert image. Invalid formulas and diagrams retain readable source. Keep these boundaries and their regression tests when upgrading libraries.

### Windows build

Build the Windows executable and NSIS installer:

```sh
cargo tauri build --config src-tauri/tauri.conf.json
```

| Output | Location |
| --- | --- |
| Standalone executable | `src-tauri/target/release/contextkey.exe` |
| NSIS installer | `src-tauri/target/release/bundle/nsis/` |

The configured installer can download WebView2 when it is missing. This step requires internet access; see [Tauri's installer documentation](https://v2.tauri.app/distribute/windows-installer/#downloaded-bootstrapper).

## Repository layout

| Path | Responsibility |
| --- | --- |
| [`src-tauri/src/`](../src-tauri/src/) | Rust backend, input handling, windows, API requests, and persistence. |
| [`frontend/`](../frontend/) | Static interfaces for translation, chat, screenshots, notifications, and Settings. |
| [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json) | App identity, frontend assets, and installer configuration. |
| [`src-tauri/capabilities/default.json`](../src-tauri/capabilities/default.json) | Permissions available to the webview windows. |
| [`src-tauri/icons/`](../src-tauri/icons/) | Original logo, generated icons, and regeneration script. |
| [`.github/workflows/build.yml`](../.github/workflows/build.yml) | Windows tests, release builds, artifact uploads, and tagged releases. |
| [`openspec/specs/`](../openspec/specs/) | Feature requirements and expected behavior. |
| [`openspec/changes/`](../openspec/changes/) | Change proposals and archived implementation records. |
| [`CLAUDE.md`](../CLAUDE.md) | Detailed implementation decisions and maintenance constraints. |

## Runtime architecture

ContextKey runs as a single tray process and creates windows when needed. Translation popups are temporary; chat windows retain their conversation until explicitly closed.

| Modules | Role |
| --- | --- |
| `main.rs`, `windows.rs` | App lifecycle, commands, tray menu, and window creation. |
| `webview_runtime.rs` | Windows startup runtime detection and native recovery before any webview or keyboard hook. |
| `external_links.rs` | Validates web/email links and launches the Windows protocol handler without a command interpreter. |
| `keyhook.rs`, `hotkey.rs` | Windows keyboard hook and configurable two-step shortcut detection. |
| `clipboard.rs` | Reads the copied text used by translation and contextual chat. |
| `api.rs` | Shared HTTP client, streaming Chat Completions requests, errors, and request cancellation. |
| `screenshot.rs` | Monitor capture, image cropping, encoding, and in-memory capture storage. |
| `config.rs`, `storage.rs`, `window_state.rs` | Settings, legacy-file import, and popup-size persistence. |
| `popup_sizing.rs`, `tts.rs` | Translation-window sizing and system text-to-speech. |

The frontend owns chat history and passes it to the backend when sending a turn. Requests use the configured endpoint directly. Captured images are attached to a chat window first and are submitted only with a question.

### Maintenance constraints

- Keep the keyboard hook passive and fast. Do not perform Unicode conversion or alter IME state inside the hook callback.
- Keep frontend hotkey options and backend validation in sync.
- Register event listeners before starting streams. Deliver initial window payloads through an explicit readiness handshake or a frontend pull.
- Associate cancellation with the correct window instance so closing an old popup cannot cancel a replacement window's request.
- Keep the tray process running when a popup closes; exit deliberately through **Quit**.
- Use physical coordinates and the target monitor's scale when positioning or resizing windows.
- Preserve the current settings schema and legacy-file import behavior when changing persistence.

See [project memory](../CLAUDE.md) for the implementation details behind these constraints.

## Validation

The Rust suite covers behavior such as hotkey mappings, popup-size calculations, and saved-data migration. It does not replace a Windows desktop check of keyboard input, IME composition, focus, monitor scaling, screenshot selection, or streaming against a real endpoint.

Before a release, complete the [manual QA checklist](../openspec/QA-CHECKLIST.md) for the candidate build. Historical checkmarks record earlier testing and must not be treated as validation of a new release.

For documentation changes, verify relative links, commands, configuration defaults, and artifact paths against the current source. For icon changes, verify the PNG format and every ICO size, then inspect the icon in the packaged Windows app.

## CI and releases

The [build workflow](../.github/workflows/build.yml) runs Rust unit tests and builds the app on `windows-latest`.

| Trigger | Result |
| --- | --- |
| Push to `main` or `master`, or manual dispatch on a branch | Builds the app and uploads `ContextKey-Windows` and `ContextKey-Setup` artifacts with 30-day retention. |
| Push a `v*` tag | Builds the EXE and calls the reusable MSIX workflow, then publishes `ContextKey <tag>` after both pass. The release includes the installer, standalone EXE, MSIX, build metadata, and checksums. |

Before pushing a release tag, synchronize the versions in `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, add `docs/releases/<tag>.md`, and review the Windows branch-build result and manual QA record. Pushing the tag starts the publishing workflow. The publishing job checks the tag, versions, MSIX source commit, expected files, and checksums. It uploads to a draft before publication and refuses to overwrite an already published release.

For Microsoft Store distribution, the [MSIX workflow](../.github/workflows/microsoft-store.yml) builds an unsigned upload candidate using the owner's Partner Center identity and shared Evergreen WebView2. The executable checks runtime availability before initializing Tauri; missing runtimes produce a native Windows prompt offering Microsoft's download page. Packaging validates an explicit payload and a 25 MiB size budget, and records measured sizes in `build-info.json`. Branch and manual runs upload an Actions artifact; tag releases call the same workflow and attach its output to the GitHub release. Neither submits to Partner Center. See the [Store packaging guide](MICROSOFT-STORE.md) for versioning, local builds, runtime recovery, and the remaining Windows/listing checks. Microsoft signs Store packages after certification.

## App icon maintenance

The original supplied artwork is [`brand.png`](../src-tauri/icons/brand.png), a 1254×1254 image from the [current logo share](https://chatgpt.com/s/m_6ac9ab048d608191b153a164b7fffd0c). The committed generator produces:

| Asset | Format |
| --- | --- |
| `icon.png` | 512×512 RGBA PNG. |
| `icon.ico` | Windows ICO containing 16, 20, 24, 32, 40, 48, 64, 96, 128, and 256-pixel square images. |
| `frontend/brand.png` | 128×128 RGBA PNG for settings, popup headers, the chat welcome screen, notifications, and favicons. |
| `packaging/windows/Assets/*.png` | 50×50 Store logo and 44×44 / 150×150 application tiles for the MSIX manifest. |

To regenerate the icons, use a Python environment with Pillow:

```sh
python -m pip install Pillow
python src-tauri/icons/generate_icon.py
```

The script preserves the source artwork and aspect ratio. A non-square replacement is padded to fit the square canvas. Commit the source and all three generated outputs together. The app, tray, installer, and README consume the desktop assets; the UI uses the frontend copy. The build does not run Python.

## Contributing documentation and fixes

Keep changes focused on a specific behavior or documented issue. Describe the problem, the resulting behavior, and the validation performed. Include Windows-specific verification when changing input handling, window lifecycle, capture, or packaging.

Update the README for user-visible changes, this guide for development workflow changes, and the relevant behavior specifications for requirement changes. Preserve archived change records as historical evidence. Record implementation constraints in `CLAUDE.md` rather than duplicating detailed project memory across files.
