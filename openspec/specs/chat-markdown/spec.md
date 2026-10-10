# chat-markdown Specification

## Purpose

Defines how assistant responses render readable Markdown while treating model-provided HTML as text.

## Requirements

### Requirement: Markdown rendering in assistant messages

Assistant messages SHALL render Markdown as styled HTML: bold, italic, combined bold and italic, inline code, fenced code blocks, headings, and bullet or ordered lists. Untrusted HTML content SHALL be escaped before formatting.

#### Scenario: Inline formatting

- **WHEN** an assistant message contains bold, italic, bold+italic, or inline-code spans
- **THEN** each is rendered with the corresponding visual style in the message bubble

#### Scenario: Block formatting

- **WHEN** an assistant message contains headings, fenced code blocks, or bullet/ordered lists
- **THEN** headings render at their level, code blocks render in a monospaced block with distinct background, and lists render with appropriate markers and indentation

#### Scenario: Markdown renders during streaming

- **WHEN** a response is still streaming
- **THEN** the accumulated content is rendered as Markdown as chunks arrive, without waiting for completion
- **AND** delimiters split across chunks are interpreted from the accumulated source; incomplete syntax may remain literal until more text arrives

#### Scenario: Rendering finalized on completion

- **WHEN** the response completes
- **THEN** any pending render is flushed immediately so the full message is visible with final Markdown formatting
- **AND** chat history retains the original Markdown source

#### Scenario: Failure with a pending render

- **WHEN** a stream fails before its latest chunk has been painted
- **THEN** the partial response is rendered alongside the error, and a queued update cannot overwrite the error or a later retry

#### Scenario: Untrusted content is not executable

- **WHEN** assistant output contains HTML-like or script-like text
- **THEN** it is rendered as text/markdown and NOT executed as live HTML/script in the webview
