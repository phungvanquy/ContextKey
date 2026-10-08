# config-store Specification

## Purpose

Defines settings, defaults, validation, persistence, and migration from the former application name.

## Requirements

### Requirement: Config file location and schema

The application SHALL persist configuration at `~/.contextkey_config.json`, retaining the schema and defaults compatible with earlier releases. When this file is absent, the application SHALL import `~/.quicktranslator_config.json` without changing the legacy file.

#### Scenario: Schema and defaults

- **WHEN** configuration is represented in memory or written to disk
- **THEN** it contains `api_key` (empty), `base_url` (`https://api.openai.com/v1`), `target_language` (`Vietnamese`), `model` (`gpt-4o-mini`), `vision_model` (empty), `custom_prompt` (the built-in translation template), and `hotkeys`
- **AND** the default hotkeys are translation `Ctrl+C` → `C` within 600 ms, chat `Ctrl+C` → `Space` within 600 ms, and screenshot `RCtrl` → `RCtrl` within 400 ms

#### Scenario: Existing Python config keeps working

- **WHEN** a config file previously written by the Python app is loaded
- **THEN** it loads without error and all previously stored values are preserved

#### Scenario: First ContextKey launch imports legacy settings

- **WHEN** the ContextKey config file is missing and the legacy config file is readable
- **THEN** its original text is copied to the new path and loaded with the existing parsing and hotkey-validation rules
- **AND** the legacy file is retained unchanged
- **AND** if the copy cannot be saved, the legacy data is still used for that session

#### Scenario: Existing ContextKey settings take priority

- **WHEN** the ContextKey config file already exists
- **THEN** the legacy config is not imported, even if the current file is malformed or unreadable
- **AND** the existing file is not overwritten during loading

### Requirement: Config load behavior

Loading SHALL merge file contents over the defaults so missing keys fall back to defaults.

#### Scenario: Partial config file

- **WHEN** the config file exists but is missing some keys
- **THEN** the missing keys take their default values and the present keys are used as stored

#### Scenario: Missing or malformed config file

- **WHEN** neither current nor legacy config exists, or the chosen file cannot be parsed as JSON
- **THEN** the in-memory config falls back to the full defaults
- **AND** when both files were absent, a default ContextKey config file is written to disk
- **AND** malformed file contents are preserved for recovery

### Requirement: Config save behavior

Saving SHALL write pretty-printed, UTF-8, non-ASCII-escaped JSON.

#### Scenario: Save format

- **WHEN** configuration is saved
- **THEN** the file is written as JSON indented for readability, encoded UTF-8, with non-ASCII characters preserved literally (not `\uXXXX`-escaped)

### Requirement: Settings window

The application SHALL provide a Settings window to view and edit the core credentials/target fields AND the `custom_prompt` field, and persist them to the config file. The `custom_prompt` field is already stored in config and used by the backend translate flow; the settings UI SHALL surface it so it is user-editable.

#### Scenario: Edit and save

- **WHEN** the user opens Settings, edits `api_key`, `base_url`, `model`, and/or `target_language`, and saves
- **THEN** the values are written to `~/.contextkey_config.json` in the save format above
- **AND** subsequent translations use the updated values (a new API client/credentials take effect without restarting the app)

#### Scenario: Edit custom prompt

- **WHEN** the user opens Settings, edits the custom prompt in a multi-line field, and saves
- **THEN** the `custom_prompt` value is written to `~/.contextkey_config.json`
- **AND** subsequent translations use the updated prompt (with `{target_language}` substituted where present)

#### Scenario: Reset custom prompt to default

- **WHEN** the user clicks the reset-to-default control for the custom prompt
- **THEN** the field is repopulated with the default translator template
- **WHEN** the user saves with the custom prompt left blank
- **THEN** the stored `custom_prompt` falls back to the default template rather than an empty string

### Requirement: Settings input validation

The Settings window SHALL validate inputs before saving and give the user clear, inline feedback for problems, rather than deferring failures to the translate/chat flow.

#### Scenario: Malformed base URL blocked

- **WHEN** the user saves with a non-empty `base_url` that is not a well-formed `http://` or `https://` URL
- **THEN** the save is blocked and an inline error identifies the base URL as the problem

#### Scenario: Empty base URL allowed

- **WHEN** the user saves with an empty `base_url`
- **THEN** the save proceeds (the backend falls back to the default OpenAI endpoint)

#### Scenario: Empty API key warned, not blocked

- **WHEN** the user saves with an empty `api_key`
- **THEN** the save proceeds AND a non-blocking warning notes that translation/chat will not work until a key is set

### Requirement: Connection test

The Settings window SHALL let the user test the configured endpoint, key, and model with a minimal live request and report the outcome inline, without opening a translate or chat popup.

#### Scenario: Successful test

- **WHEN** the user clicks "Test connection" with a reachable endpoint, valid key, and valid model
- **THEN** a minimal request is issued and a success indication is shown

#### Scenario: Failed test reports a clear reason

- **WHEN** the connection test fails (network error, non-success HTTP status, or auth failure)
- **THEN** a human-readable error is shown inline indicating the reason (e.g. the HTTP status or a connection error), and no popup is opened

#### Scenario: Test uses current form values

- **WHEN** the user edits fields and clicks "Test connection" before saving
- **THEN** the test uses the values currently in the form (not only the last-saved config)

### Requirement: Hotkeys stored in config

The config file SHALL hold a `hotkeys` object with one entry per action (`translate`, `chat`, `screenshot`), each carrying `prefix`, `then`, and `window_ms`. The object and each of its entries MUST be optional on read, defaulting to the built-in table when absent.

#### Scenario: Round-trip

- **WHEN** hotkeys are saved from Settings
- **THEN** they are written to `~/.contextkey_config.json` and reloaded on next start

#### Scenario: Partial hotkey block

- **WHEN** the stored `hotkeys` object names only some actions
- **THEN** the missing actions fall back to their defaults rather than failing the whole load

#### Scenario: Invalid table rejected on write

- **WHEN** Settings submits a hotkey table that fails validation
- **THEN** the save is rejected with the validation errors and the previously stored table is left intact

### Requirement: Vision model field

The config SHALL hold a `vision_model` string, optional on read and defaulting to empty. Settings MUST surface it as an editable field.

#### Scenario: Round-trip

- **WHEN** `vision_model` is saved from Settings
- **THEN** it is persisted and reloaded on next start

#### Scenario: Absent in an older config

- **WHEN** an existing config file predates this field
- **THEN** it loads as empty and image requests fall back to the main `model`

#### Scenario: Connection test covers both models

- **WHEN** the user tests the connection with a `vision_model` set
- **THEN** both the main model and the vision model are tested, since either can be misconfigured independently
