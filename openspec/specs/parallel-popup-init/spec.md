# Popup initialization specification

## Purpose

Defines clipboard polling and popup initialization order so input capture does not block the async runtime and streaming begins after window setup.

## Requirements

### Requirement: Translation clipboard capture runs off the async runtime

The translation trigger SHALL start clipboard polling in a blocking task. It SHALL register the frontend readiness listener before creating the popup and SHALL await the clipboard result before constructing the window URL that carries the selected text.

#### Scenario: Normal translation trigger

- **WHEN** the translation shortcut fires
- **THEN** clipboard polling starts while the trigger prepares its readiness listener
- **AND** the popup is created after the captured text is available
- **AND** the trigger waits for `popup://ready`, with a two-second timeout, before starting the stream

#### Scenario: Empty clipboard

- **WHEN** polling returns an empty string
- **THEN** the readiness listener is removed and no translation window or API request is created
- **AND** a brief notice explains that no text was selected

### Requirement: Chat receives its context before window creation

The chat trigger SHALL start clipboard polling in a blocking task and await the result before opening the chat popup with its initial selected-text context.

#### Scenario: Chat with copied text

- **WHEN** the chat shortcut fires and clipboard text is available
- **THEN** the captured text is passed to the popup when it is created
- **AND** chat requests begin only when the frontend submits a question

#### Scenario: Chat with empty clipboard

- **WHEN** polling returns an empty string
- **THEN** the chat popup opens in free-chat mode

### Requirement: Clipboard polling has a bounded budget

The clipboard polling loop SHALL sleep 20 ms between attempts, with a maximum of 10 attempts. The first non-empty value that differs from the initial read SHALL be returned after trimming whitespace.

#### Scenario: Clipboard updates during polling

- **WHEN** the clipboard changes within the polling budget
- **THEN** the new text is returned on the next poll

#### Scenario: Clipboard does not update

- **WHEN** no different non-empty text is observed after 10 attempts
- **THEN** the trimmed value from the initial clipboard read is returned
