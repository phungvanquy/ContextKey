# reasoning-aware-api Specification

## Purpose

Defines request parameters used for reasoning-model compatibility and completion-token limits.

## Requirements

### Requirement: Model detection helper

The system SHALL provide a function `is_reasoning_model(model: &str) -> bool` that returns true when the model name (case-insensitive) starts with `gpt-5`, `o1-`, or `o3-`.

#### Scenario: GPT-5 model detected

- **WHEN** model is "gpt-5.4" or "GPT-5-nano" or "gpt-5"
- **THEN** `is_reasoning_model` returns true

#### Scenario: O-series model detected

- **WHEN** model is "o1-preview" or "o3-mini"
- **THEN** `is_reasoning_model` returns true

#### Scenario: Non-reasoning model

- **WHEN** model is "gpt-4o" or "gpt-4o-mini" or "claude-3-sonnet" or "llama-3"
- **THEN** `is_reasoning_model` returns false

### Requirement: Test connection token budget

The `test_connection` function SHALL use `max_completion_tokens: 50` in its probe request body.

#### Scenario: Test connection with reasoning model

- **WHEN** user clicks "Test connection" with model set to "gpt-5.4"
- **THEN** the API request uses `max_completion_tokens: 50` and receives a successful response

#### Scenario: Test connection with classic model

- **WHEN** user clicks "Test connection" with model set to "gpt-4o"
- **THEN** the API request uses `max_completion_tokens: 50` and receives a successful response

### Requirement: Translation disables reasoning

The `translate_stream` function SHALL include `"reasoning_effort": "none"` in the request body when `is_reasoning_model` returns true for the configured model.

#### Scenario: Translate with GPT-5 model

- **WHEN** a translation is triggered with model "gpt-5.4"
- **THEN** the request body includes `"reasoning_effort": "none"`

#### Scenario: Translate with non-reasoning model

- **WHEN** a translation is triggered with model "gpt-4o"
- **THEN** the request body does NOT include `"reasoning_effort"`

### Requirement: Increased token budget for streaming

The `translate_stream` and `chat_stream` functions SHALL use `max_completion_tokens: 4096`.

#### Scenario: Translation token budget

- **WHEN** a translation stream request is built
- **THEN** `max_completion_tokens` is 4096

#### Scenario: Chat token budget

- **WHEN** a chat stream request is built
- **THEN** `max_completion_tokens` is 4096

### Requirement: Chat uses the same reasoning parameter as translation

The `chat_stream` function SHALL include `"reasoning_effort": "none"` when `is_reasoning_model` returns true for the selected model, including a configured vision model. Other model names SHALL omit this field.

#### Scenario: Chat with reasoning model

- **WHEN** a chat request is triggered with model "gpt-5.4"
- **THEN** the request body includes `"reasoning_effort": "none"`
