# chat-markdown Specification

## Purpose

Defines shared rendering of chat and translation responses while treating model-provided HTML as text.

## Requirements

### Requirement: Markdown rendering in assistant messages

Assistant messages SHALL render Markdown as styled HTML: emphasis, strikethrough, literal inline code, fenced and indented code blocks, all six heading levels, nested lists, blockquotes, hard breaks, horizontal rules, disabled task checkboxes, links, images, and pipe tables. Untrusted HTML content SHALL remain escaped. Chat and translation SHALL use the same parser and styles.

#### Scenario: Inline formatting

- **WHEN** an assistant message contains bold, italic, bold+italic, or inline-code spans
- **THEN** each is rendered with the corresponding visual style in the message bubble
- **AND** escaped punctuation and code-span contents remain literal, including multi-backtick code spans

#### Scenario: Block formatting

- **WHEN** an assistant message contains headings, fenced code blocks, or bullet/ordered lists
- **THEN** headings render at their level, code blocks render in a monospaced block with distinct background, and lists render with appropriate markers and indentation
- **AND** ordered lists preserve their starting number and nested lists preserve continuation content
- **AND** backtick and tilde code fences honor delimiter lengths; known languages receive syntax highlighting and unknown languages remain plain code

#### Scenario: Links and images

- **WHEN** output includes links, references, autolinks, or Markdown images
- **THEN** web/email links can be activated by pointer or keyboard and open through the system protocol handler outside the app webview
- **AND** a failed launch displays an actionable error without navigating the popup
- **AND** only HTTP/HTTPS image URLs and embedded PNG/JPEG/GIF/WebP images load, with alt text and constrained width
- **AND** executable URLs, local files, relative paths, app protocols, and credential-bearing web URLs are not active links or images

#### Scenario: Math and diagrams

- **WHEN** a response includes dollar/bracket-delimited formulas or math/latex/tex code fences
- **THEN** formulas render using local assets with trusted commands disabled and bounded expansion, or retain readable source on failure
- **WHEN** a Mermaid fence closes or the response completes
- **THEN** a local library renders its diagram in strict mode with model-provided configuration disabled
- **AND** the sanitized result is displayed as an inert image, with source available in an expandable disclosure
- **AND** invalid diagrams show their source and do not prevent later diagrams from rendering
- **AND** wide diagrams remain readable through keyboard/pointer scrolling, and rendered colors follow theme changes
- **AND** delayed work cannot populate a response removed by reset or retry, or hide source text being read

#### Scenario: Markdown renders during streaming

- **WHEN** a response is still streaming
- **THEN** the accumulated content is rendered as Markdown as chunks arrive, without waiting for completion
- **AND** delimiters split across chunks are interpreted from the accumulated source; incomplete syntax may remain literal until more text arrives

#### Scenario: Pipe tables

- **WHEN** Markdown contains a pipe-separated header followed by a matching delimiter row
- **THEN** it renders as a table with column headers, body rows, and the indicated left, center, or right alignment
- **AND** outer pipes are optional, escaped pipes remain cell content, and cells support inline formatting while escaping HTML
- **AND** missing body cells are empty and extra cells beyond the header width are ignored
- **AND** table-like text without a valid delimiter row and tables inside fenced code remain literal
- **AND** following headings, lists, rules, quotes, and code fences terminate the table according to Markdown block rules

#### Scenario: Tables fit popup windows

- **WHEN** a rendered table is wider than the available chat or translation content area
- **THEN** the table can be scrolled horizontally with pointer or keyboard input without widening the popup content
- **AND** streaming updates and completion preserve the table's horizontal scroll position and keyboard focus
- **AND** table headers, borders, and rows use the active light or dark theme

#### Scenario: Reading during streaming

- **WHEN** new chunks arrive or a stream completes or fails
- **THEN** text selection, keyboard focus, and horizontal/vertical scrolling inside code, tables, formulas, and diagrams are preserved
- **AND** unchanged rendered blocks, loaded images, and completed diagrams are reused

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
