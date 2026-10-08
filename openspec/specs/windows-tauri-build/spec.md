# Windows build and distribution specification

## Purpose

Defines Windows builds, distribution artifacts, product identity, and application execution privileges.

## Requirements

### Requirement: Windows CI validates the application

The GitHub Actions workflow SHALL run Rust unit tests and build the Tauri application on `windows-latest`. Interactive input and window behavior SHALL be validated separately on a Windows desktop.

#### Scenario: Workflow triggers

- **WHEN** code is pushed to `main` or `master`, a `v*` tag is pushed, or the workflow is manually dispatched
- **THEN** the Windows build job runs

#### Scenario: Compilation and unit-test gate

- **WHEN** the job runs
- **THEN** it installs a stable Rust toolchain, runs `cargo test --bins` in `src-tauri`, and builds the application in release mode
- **AND** a test or compilation failure fails the job

#### Scenario: Branch artifacts

- **WHEN** a build completes for a non-tag reference
- **THEN** `contextkey.exe` is uploaded as `ContextKey-Windows` and the NSIS installer is uploaded as `ContextKey-Setup`
- **AND** both artifacts have a 30-day retention period

#### Scenario: Tagged release

- **WHEN** a build completes for a version tag
- **THEN** a non-draft GitHub release titled `ContextKey <tag>` is published in `phungvanquy/ContextKey` with the installer attached
- **AND** separate Actions artifact uploads are skipped

### Requirement: Application execution privileges

The Windows application SHALL use the `asInvoker` execution level and SHALL NOT require administrator privileges for ordinary operation.

#### Scenario: Normal launch

- **WHEN** the packaged application is launched normally
- **THEN** the executable does not request administrator elevation

#### Scenario: Elevated foreground application

- **WHEN** an elevated application is in the foreground
- **THEN** shortcuts may be unavailable to a normally launched ContextKey process
- **AND** running ContextKey as administrator is a user-selected option for that session

### Requirement: Tauri bundle configuration

The application SHALL bundle the static frontend and app icons without a JavaScript build step.

#### Scenario: ContextKey product identity

- **WHEN** the app is built
- **THEN** the product name is `ContextKey`, the Cargo package and binary are `contextkey`, and the Tauri identifier is `com.contextkey.desktop`
- **AND** the Windows manifest uses `com.contextkey.app` and describes the app as `ContextKey`
- **AND** the versions in the Cargo manifest and Tauri configuration match

#### Scenario: Frontend and icon assets

- **WHEN** the app is built
- **THEN** the HTML, CSS, and JavaScript under `frontend/` are bundled without an npm build step
- **AND** the committed `icons/icon.png` and `icons/icon.ico` provide the app artwork without running the Python icon generator during the build

#### Scenario: WebView2 installation

- **WHEN** the installer needs to install WebView2
- **THEN** it uses the configured `downloadBootstrapper` mode
