# Microsoft Store packaging

## Current status — October 10, 2026

The MSIX manifest and Windows CI workflow use the owner's Partner Center identity. Local packaging tests and workflow lint pass. The [Store workflow runs](https://github.com/phungvanquy/ContextKey/actions/workflows/microsoft-store.yml) provide build results and unsigned upload candidates. **A successful build is not Store certification.** Windows desktop testing and the remaining listing details below are required before publication.

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

The initial **Store package version is `1.0.0.0`**, maintained in the MSIX manifest. This is a separate version from the existing Cargo/Tauri app version (`0.4.0`). Store versions require a nonzero major component and a final component of zero. Increase the Store version for subsequent submitted updates, for example `1.0.1.0`; do not automatically reuse it for different published packages. Normal GitHub releases still require synchronized Cargo/Tauri versions and a new tag. [Store version numbering](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements#package-version-numbering)

## CI flow

[`Build Microsoft Store MSIX`](../.github/workflows/microsoft-store.yml) runs on relevant pushes to `main`/`master`, pull requests, and manual dispatch. It uses a Windows runner and needs no signing or Partner Center secrets.

1. Validate packaging inputs and run Rust unit tests.
2. Download the pinned x64 WebView2 runtime and check its SHA-256 before extraction.
3. Build ContextKey using [`tauri.microsoftstore.conf.json`](../src-tauri/tauri.microsoftstore.conf.json), with the C runtime statically linked.
4. Stage the executable, adjacent DLLs, Store logo assets, manifest, and complete WebView2 runtime. Settings, API keys, source files, and debug symbols are not selected as package inputs.
5. Run the Windows SDK's `MakeAppx.exe` with semantic validation enabled and SHA-256 block hashes.
6. Upload `ContextKey-MicrosoftStore-x64` as an Actions artifact containing the unsigned `.msix`, its `.sha256`, and `build-info.json` with the source commit and runtime pin.

Download and extract that artifact; upload the **`.msix` inside it** to the existing submission's Packages page. The artifact ZIP itself is not the submission package. This workflow does not call Partner Center or create a GitHub release. The existing [EXE release workflow](../.github/workflows/build.yml) remains separate.

The candidate targets x64 Windows 10 build 19041 and later, including Windows 11. It declares the desktop `runFullTrust` capability for the native tray app, keyboard shortcuts, clipboard access, screenshot capture, and speech. This is medium-integrity desktop execution, not an administrator requirement. Explain this use when Partner Center asks about restricted capabilities. [Desktop package manifest guidance](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-manual-conversion)

## WebView2 and logos

The Store build includes the Fixed Version WebView2 runtime under `WebView2Runtime` beside `contextkey.exe`. Tauri selects that directory at startup. The ordinary EXE build continues to use its existing Evergreen bootstrapper configuration.

Bundling avoids relying on WebView2 being preinstalled. `win32dependencies:ExternalDependency` is only honored by App Installer, so it is not used to guarantee a Store installation's runtime. [External dependency limitations](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-win32dependencies-externaldependency)

The pinned download is recorded in [`webview2.json`](../packaging/windows/webview2.json): version `155.0.4283.45`, x64. Its Microsoft-hosted CAB was downloaded and hashed when preparing this flow (310,544,938 bytes). Fixed Version adds substantial package size and **does not update itself**. Before each Store release, review Microsoft's current runtime, update the version, URL, and verified SHA-256 together, then rebuild and test. Never substitute the Evergreen installer EXE for the Fixed Version CAB. [Microsoft runtime distribution guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution#the-fixed-version-runtime-distribution-mode)

The manifest's 50, 44, and 150-pixel PNG logos are generated from the existing ContextKey artwork by [`generate_icon.py`](../src-tauri/icons/generate_icon.py). They are committed under [`packaging/windows/Assets`](../packaging/windows/Assets), so CI needs no image-generation dependency. Listing screenshots and promotional artwork are separate Partner Center inputs.

## Build locally on Windows

Install the [normal development prerequisites](DEVELOPMENT.md), Python 3.11 or later, and the Windows 10/11 SDK with `MakeAppx.exe`. From the repository root in PowerShell:

```powershell
python -m unittest discover -s packaging/windows -p "test_*.py" -v
python packaging/windows/build_msix.py runtime
$env:RUSTFLAGS = '-C target-feature=+crt-static'
cargo tauri build --no-bundle --config src-tauri/tauri.microsoftstore.conf.json
python packaging/windows/build_msix.py package
```

The upload files are under `src-tauri/target/msix/output/`. The unpacked app is under `src-tauri/target/msix/stage/`. Downloaded runtime files and all build output are ignored by Git. Remove the session's `RUSTFLAGS` after building if you use different flags for other work.

For local testing without a signing certificate, enable Windows Developer Mode, quit any running ContextKey EXE installation, then register the staged package:

```powershell
Add-AppxPackage -Register "$PWD\src-tauri\target\msix\stage\AppxManifest.xml"
```

Launch **ContextKey from Start** so the test runs with package identity. To test an Actions artifact instead, first extract the MSIX with the Windows SDK's `makeappx unpack /p <file.msix> /d <folder>`, then register that folder's `AppxManifest.xml`. This is developer testing, not public installation; keep the registered files in place while testing. [Microsoft manual packaging and registration guidance](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-manual-conversion)

## Before submitting

- Require a successful Store workflow run on the exact intended commit. Local script tests do not establish native build or Store certification success.
- Test the packaged app on clean supported Windows systems without an installed Evergreen WebView2 runtime. Check first launch, all three theme choices across windows, both popup borders, tray behavior, hotkeys, translation, chat, screenshots, speech, saved settings, upgrade, and uninstall. Quit a separately installed EXE before testing to avoid its single-instance handler intercepting launch. Complete the [desktop QA checklist](../openspec/QA-CHECKLIST.md) and run Windows App Certification Kit.
- Confirm the reserved display name is `ContextKey`, and review the generated package identity against Partner Center. If the submission already contains a higher package version, increase the manifest version before building.
- Provide a public privacy-policy URL, support contact, listing screenshots, age ratings, and the other requested listing information. The privacy policy needs to describe selected text/screenshots sent to the configured AI service, local credentials/settings, data sharing, and user controls. A dedicated policy URL is still missing.
- State that users supply a compatible API service and that provider charges may apply. Provide working test access privately in certification notes so reviewers can exercise API-dependent features. Do not put real API keys in the repository, screenshots, CI output, or public listing. [Store policies, sections 10.3 and 10.5](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies)

Passing MakeAppx validates packaging structure; it is not a substitute for Windows behavior checks or Microsoft certification. Publish only after the candidate and listing are complete.

## Earlier EXE audit

The last pushed [Windows build at `ad39312`](https://github.com/phungvanquy/ContextKey/actions/runs/38022134152) passed before the theme selector and MSIX changes. Its artifact required authenticated download, so its signature was not directly inspected here.

The public [v0.4.0 installer](https://github.com/phungvanquy/ContextKey/releases/tag/v0.4.0), `Quick.Translator_0.4.0_x64-setup.exe`, has no embedded Authenticode signature (empty PE security directory). It is 3,220,605 bytes, with SHA-256 `3bfc24393c170da934ea905f896f2b0cbf4c41d756bd29b43de2df837066c554`. That finding applies to this old public asset, not to a future MSIX candidate.

Submitting an EXE instead would still require trusted signing, an offline installer, silent installation, and an immutable HTTPS download URL. The new MSIX profile replaces the earlier uncommitted offline-NSIS proposal; it does not make the normal EXE release Store-ready. [EXE/MSI requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements)
