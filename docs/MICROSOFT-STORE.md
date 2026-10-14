# Microsoft Store packaging

## Current candidate — Evergreen WebView2

The MSIX manifest and Windows CI workflow use the owner's Partner Center identity. Starting with v0.5.1, the app builds a smaller candidate using shared Evergreen WebView2 and native startup recovery when the runtime is unavailable. The older v0.5.0 MSIX contains Fixed Version WebView2 and remains available unchanged. The [Store workflow runs](https://github.com/phungvanquy/ContextKey/actions/workflows/microsoft-store.yml) provide build results and unsigned upload candidates. **A successful build is not Store certification.** Desktop testing (including the missing-runtime and upgrade cases below) and the remaining listing details are still required before Store submission. The GitHub release notes record these outstanding checks.

For Store distribution, Microsoft signs MSIX packages after certification; a purchased signing certificate is not required. An unsigned upload candidate cannot be installed by double-clicking it. Direct EXE distribution has separate signing requirements. [Microsoft package and signing requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)

## Partner Center identity

These are public identifiers, not credentials. They can be committed to the repository. The first three values are used exactly, including case, in [`AppxManifest.xml`](../packaging/windows/AppxManifest.xml).

| Field | Value |
| --- | --- |
| Package/Identity/Name | `ITMO.ContextKey` |
| Package/Identity/Publisher | `CN=B4AAB21C-9EB8-42AA-87B3-8F966E39D731` |
| Package/Properties/PublisherDisplayName | `ITMOvnteam` |
| Package Family Name | `ITMO.ContextKey_grxcfkadteavc` |
| Package SID | `S-1-15-2-1330898448-299043417-2913935662-1554904130-3551478652-3415938233-1036317820` |
| Store ID | `9PM8R305QRTK` |

The family name and SID are derived identifiers, not extra manifest attributes. The Store ID identifies the reserved listing; it is not needed to assemble the MSIX. None of these values grants CI permission to submit or publish an app.

The **Store candidate version is `1.0.1.0`**, increased from `1.0.0.0` for the transition to Evergreen and maintained in the MSIX manifest. This is separate from the Cargo/Tauri app version (`0.5.1` in the current source). Store versions require a nonzero major component and a final component of zero. Increase the Store version for subsequent submitted updates; do not reuse it for different published packages. Normal GitHub releases still require synchronized Cargo/Tauri versions and a new tag. [Store version numbering](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements#package-version-numbering)

## CI flow

[`Build Microsoft Store MSIX`](../.github/workflows/microsoft-store.yml) runs on relevant pushes to `main`/`master`, pull requests, and manual dispatch. Tagged releases also call it as a reusable workflow. It uses a Windows runner and needs no signing or Partner Center secrets.

1. Validate packaging inputs and run Rust unit tests.
2. Build ContextKey using [`tauri.microsoftstore.conf.json`](../src-tauri/tauri.microsoftstore.conf.json), with the C runtime statically linked and no bundled WebView2 runtime or installer.
3. Stage only the executable, optional `WebView2Loader.dll`, three Store logo assets, and manifest. Old runtime folders, unrelated DLLs, settings, source files, and debug symbols are not selected as package inputs.
4. Run the Windows SDK's `MakeAppx.exe` with compression, semantic validation, and SHA-256 block hashes. Validate the archive's exact allowed payload and enforce a **25 MiB compressed size budget**.
5. Print measured compressed/unpacked sizes and the largest entries. Upload `ContextKey-MicrosoftStore-x64` as an Actions artifact containing the unsigned `.msix`, its `.sha256`, and `build-info.json` with the source commit, measured sizes, and `webview2: {"mode": "evergreen", "bundled": false}`. Release verification also checks this runtime mode.

Download and extract that artifact; upload the **`.msix` inside it** to the existing submission's Packages page. The artifact ZIP itself is not the submission package. On a release tag, the [release workflow](../.github/workflows/build.yml) waits for both Windows build jobs, checks versions and checksums, and attaches the MSIX alongside the EXE files to the GitHub release. You can download that `.msix` directly instead. Neither workflow calls Partner Center, and a GitHub release does not imply Store certification.

The candidate targets x64 Windows 10 build 19041 and later, including Windows 11. It declares the desktop `runFullTrust` capability for the native tray app, keyboard shortcuts, clipboard access, screenshot capture, and speech. This is medium-integrity desktop execution, not an administrator requirement. Explain this use when Partner Center asks about restricted capabilities. [Desktop package manifest guidance](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-manual-conversion)

## WebView2 and logos

The Store build uses the shared Evergreen WebView2 runtime. Its Tauri profile sets `webviewInstallMode.type` to `skip`: this custom MSIX flow does not run an NSIS bootstrapper. The ordinary NSIS installer still uses `downloadBootstrapper` to install WebView2 when needed.

Before settings migration, Tauri initialization, tray creation, or keyboard hooks, [`webview_runtime.rs`](../src-tauri/src/webview_runtime.rs) queries the runtime through Tauri's WebView2 loader. An available runtime allows normal startup with no prompt or network request. A failed query or empty version shows a native Windows message explaining how to install Evergreen and reopen ContextKey. **Yes** opens Microsoft's official download page in the default browser; **No** exits without opening a browser. Both paths exit without starting the app. If the browser cannot open, another native message displays the download URL. ContextKey does not download or run an installer itself. The same check protects the standalone EXE.

Evergreen is shared and updated by Microsoft. Devices without it still need a separate runtime download; offline or managed devices need the runtime provisioned before ContextKey can run. `win32dependencies:ExternalDependency` is only honored by App Installer, so it is not used to guarantee a Store installation's runtime. [Microsoft runtime distribution guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution#the-evergreen-runtime-distribution-mode), [external dependency limitations](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-win32dependencies-externaldependency)

The published v0.5.0 MSIX is 324,025,157 bytes, with 318,807,361 compressed bytes belonging to its bundled runtime. The first successful [Evergreen branch build](https://github.com/phungvanquy/ContextKey/actions/runs/38509164338), at commit `e07f4a5`, produced a 4,734,285-byte artifact ZIP containing the MSIX, checksum, and metadata. For the exact package size of a release, use its `build-info.json`. The 25 MiB budget leaves room for app growth while preventing a return to hundreds of megabytes. Review payload changes before increasing it.

The manifest's 50, 44, and 150-pixel PNG logos are generated from the existing ContextKey artwork by [`generate_icon.py`](../src-tauri/icons/generate_icon.py). They are committed under [`packaging/windows/Assets`](../packaging/windows/Assets), so CI needs no image-generation dependency. Listing screenshots and promotional artwork are separate Partner Center inputs.

## Build locally on Windows

Install the [normal development prerequisites](DEVELOPMENT.md), Python 3.11 or later, and the Windows 10/11 SDK with `MakeAppx.exe`. From the repository root in PowerShell:

```powershell
python -m unittest discover -s packaging/windows -p "test_*.py" -v
$env:RUSTFLAGS = '-C target-feature=+crt-static'
cargo tauri build --no-bundle --config src-tauri/tauri.microsoftstore.conf.json
python packaging/windows/build_msix.py package
```

The upload files are under `src-tauri/target/msix/output/`. The unpacked app is under `src-tauri/target/msix/stage/`. All build output is ignored by Git. Leftover `src-tauri/WebView2Runtime/` directories from earlier builds are also ignored and are never staged. Remove the session's `RUSTFLAGS` after building if you use different flags for other work.

For local testing without a signing certificate, enable Windows Developer Mode, quit any running ContextKey EXE installation, then register the staged package:

```powershell
Add-AppxPackage -Register "$PWD\src-tauri\target\msix\stage\AppxManifest.xml"
```

Launch **ContextKey from Start** so the test runs with package identity. To test an Actions artifact instead, first extract the MSIX with the Windows SDK's `makeappx unpack /p <file.msix> /d <folder>`, then register that folder's `AppxManifest.xml`. This is developer testing, not public installation; keep the registered files in place while testing. [Microsoft manual packaging and registration guidance](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-manual-conversion)

## Before submitting

- Require a successful Store workflow run on the exact intended commit. Local script tests do not establish native build or Store certification success.
- On Windows 10 and Windows 11 with Evergreen installed, verify normal launch without a prompt, first-run Settings, all three theme choices across windows, both popup borders, tray behavior, hotkeys, translation, chat, screenshots, speech, and saved settings. Check launch with the network disconnected too; runtime detection must not depend on connectivity.
- In disposable Windows test environments without a usable runtime, verify that the native prompt appears before any tray icon, hook, or webview; **No** exits without opening a browser; **Yes** opens the official page and exits. Verify the URL fallback when the browser cannot launch. Download failure, cancellation, offline operation, or a managed-device restriction must leave the app closed with settings untouched. After installing Evergreen, relaunch from Start and verify normal startup. Test the standalone EXE's recovery too.
- Test an upgrade from the old `1.0.0.0` package to `1.0.1.0`, both with and without shared Evergreen installed. The new executable must not depend on the old package's runtime folder. Verify saved settings and uninstall behavior. Quit a separately installed EXE before testing to avoid its single-instance handler intercepting launch. Complete the [desktop QA checklist](../openspec/QA-CHECKLIST.md) and run Windows App Certification Kit.
- Confirm the reserved display name is `ContextKey`, and review the generated package identity against Partner Center. If the submission already contains a higher package version, increase the manifest version before building.
- Provide a public privacy-policy URL, support contact, listing screenshots, age ratings, and the other requested listing information. The privacy policy needs to describe selected text/screenshots sent to the configured AI service, local credentials/settings, data sharing, and user controls. A dedicated policy URL is still missing.
- State that users supply a compatible API service and that provider charges may apply. Provide working test access privately in certification notes so reviewers can exercise API-dependent features. Do not put real API keys in the repository, screenshots, CI output, or public listing. [Store policies, sections 10.3 and 10.5](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies)

Passing MakeAppx validates packaging structure; it is not a substitute for Windows behavior checks or Microsoft certification. Publish only after the candidate and listing are complete.

## Earlier EXE audit

The last pushed [Windows build at `ad39312`](https://github.com/phungvanquy/ContextKey/actions/runs/38022134152) passed before the theme selector and MSIX changes. Its artifact required authenticated download, so its signature was not directly inspected here.

The public [v0.4.0 installer](https://github.com/phungvanquy/ContextKey/releases/tag/v0.4.0), `Quick.Translator_0.4.0_x64-setup.exe`, has no embedded Authenticode signature (empty PE security directory). It is 3,220,605 bytes, with SHA-256 `3bfc24393c170da934ea905f896f2b0cbf4c41d756bd29b43de2df837066c554`. That finding applies to this old public asset, not to a future MSIX candidate.

Submitting an EXE instead would still require trusted signing, an offline installer, silent installation, and an immutable HTTPS download URL. The new MSIX profile replaces the earlier uncommitted offline-NSIS proposal; it does not make the normal EXE release Store-ready. [EXE/MSI requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements)
