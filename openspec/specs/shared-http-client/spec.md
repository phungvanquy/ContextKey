# shared-http-client Specification

## Purpose

Defines reuse of the application HTTP client across translation, chat, and connection tests.

## Requirements

### Requirement: Single shared HTTP client for all API requests

The application SHALL create one `reqwest::Client` instance at startup and reuse it for all API calls (translate stream, chat stream, connection test).

#### Scenario: Translate request reuses client

- **WHEN** a translate stream is initiated
- **THEN** the request uses the shared client, not a newly-built one

#### Scenario: Chat request reuses client

- **WHEN** a chat stream is initiated
- **THEN** the request uses the same shared client instance

#### Scenario: Connection test reuses client

- **WHEN** the Settings UI triggers a connection test
- **THEN** the test uses the shared client instance

### Requirement: Client configuration

The shared client SHALL be configured with rustls TLS backend and a 15-second connect timeout at construction time. Individual requests MAY apply additional per-request timeouts (e.g., total timeout for connection test).

#### Scenario: Client TLS and timeout configuration

- **WHEN** the shared client is constructed at app startup
- **THEN** it uses rustls TLS and has a 15-second connect timeout

#### Scenario: Connection test applies total timeout

- **WHEN** a connection test request is made via the shared client
- **THEN** the request applies a per-request total timeout of 15 seconds (independent of the client's connect timeout)
