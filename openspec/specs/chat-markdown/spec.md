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

#### Scenario: Rendering finalized on completion

- **WHEN** a response is still streaming
- **THEN** partial content is shown as it arrives (may be plain/interim text)
- **WHEN** the response completes
- **THEN** the full message is rendered with final Markdown formatting

#### Scenario: Untrusted content is not executable

- **WHEN** assistant output contains HTML-like or script-like text
- **THEN** it is rendered as text/markdown and NOT executed as live HTML/script in the webview
