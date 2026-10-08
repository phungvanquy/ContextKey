# chat-streaming Specification

## Purpose

Defines the request format, streaming events, and conversation-history rules for text and contextual chat.

## Requirements

### Requirement: Chat request with context and history

The backend SHALL POST to `<base_url>/chat/completions` with `stream: true`. Messages SHALL contain a system prompt followed by the frontend-provided history. That history already includes the current user question, which MUST NOT be appended a second time.

#### Scenario: System prompt varies by selected text

- **WHEN** a chat request is issued with non-empty selected text
- **THEN** the system prompt instructs the assistant that the user has selected that text (embedded in the prompt) and to answer questions about it concisely, permitting Markdown formatting
- **WHEN** selected text is empty (free chat)
- **THEN** the system prompt is the general concise-assistant prompt permitting Markdown, with no embedded selection

#### Scenario: History is included as context

- **WHEN** a chat request is issued and prior turns exist
- **THEN** the frontend-provided messages, including the current question exactly once, follow the system prompt in their original order

#### Scenario: Model and credentials from config

- **WHEN** a chat request is issued
- **THEN** it uses credentials and the endpoint from the current config; text-only requests use `model`, while requests containing images use a non-empty `vision_model` when configured

#### Scenario: Missing API key

- **WHEN** a chat request is issued but no API key is configured
- **THEN** no network request is made and the popup shows a message directing the user to set an API key in Settings

### Requirement: Streaming assistant response to the popup

The chat request SHALL stream assistant tokens to the popup as they arrive, using the same SSE parsing approach as the translate flow, and signal completion.

#### Scenario: Tokens stream into the bubble

- **WHEN** the assistant response is being generated
- **THEN** each content delta is delivered to the popup and appended to the current assistant bubble as it arrives

#### Scenario: Completion and error signaling

- **WHEN** the stream ends normally
- **THEN** a completion signal is delivered so the popup can finalize the bubble (e.g. render markdown) and re-enable Send
- **WHEN** the request fails or the stream errors
- **THEN** a `chat://error` event carries a summary, details, and retryability so the popup can display the failure and re-enable Send

### Requirement: Conversation history is bounded

The chat session SHALL retain history across turns within the popup's lifetime and retain at most the last 50 messages after each completed response.

#### Scenario: History capped at 50 messages

- **WHEN** appending a completed user/assistant turn causes the history to exceed 50 messages
- **THEN** the oldest messages are dropped so at most the last 50 remain

#### Scenario: Clearing context resets history

- **WHEN** the user clears the selected-text context
- **THEN** the conversation history is also cleared and subsequent turns start fresh in free-chat mode
