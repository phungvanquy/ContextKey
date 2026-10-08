# translation-streaming Specification

## Purpose

Defines streaming translation requests, prompt substitution, completion events, and error presentation.

## Requirements

### Requirement: Streaming translation request

The application SHALL translate the captured text by calling an OpenAI-compatible `chat/completions` endpoint with streaming enabled, using `reqwest` + tokio and manual SSE parsing (not `async-openai`), so that any user-provided `base_url` is honored.

#### Scenario: Request shape

- **WHEN** a translation is requested for some captured text
- **THEN** the request targets `<base_url>/chat/completions` with `Authorization: Bearer <api_key>`
- **AND** the JSON body sets `model` to the configured model, `stream` to true, `max_completion_tokens` to 4096
- **AND** `messages` is `[{role: system, content: <system prompt>}, {role: user, content: <captured text>}]`

#### Scenario: System prompt formatting

- **WHEN** building the system prompt from the configured `custom_prompt`
- **THEN** the `{target_language}` placeholder is substituted with the configured `target_language`
- **AND** if substitution fails (e.g., the template has no/invalid placeholder), the raw `custom_prompt` string is used unchanged

### Requirement: Streaming delivery to the UI

The application SHALL stream response chunks to the translation popup as they arrive.

#### Scenario: Chunks parsed from SSE

- **WHEN** the endpoint returns Server-Sent Events
- **THEN** each `data:` line is parsed, the `choices[0].delta.content` string (when present and non-empty) is emitted as a chunk to the popup via a Tauri event
- **AND** a `data: [DONE]` line (or stream end) terminates the stream and signals completion to the popup

### Requirement: Error and missing-key handling

The application SHALL distinguish request failures from translated content and show a readable error state.

#### Scenario: No API key configured

- **WHEN** a translation is requested and the configured `api_key` is empty
- **THEN** no HTTP request is made
- **AND** the popup displays `⚠ No API key set.` followed by a line instructing the user to open Settings from the tray icon

#### Scenario: Request or stream error

- **WHEN** the HTTP request fails, returns a non-success status, or the stream errors
- **THEN** a `translate://error` event carries a summary, details, and retryability
- **AND** the popup displays the failure separately from translated content and offers Retry only for recoverable errors
