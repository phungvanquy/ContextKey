## MODIFIED Requirements

### Requirement: Graceful shutdown

The application SHALL release its OS-level resources on exit.

#### Scenario: Shutdown releases the keyboard hook

- **WHEN** the application exits (via tray Quit)
- **THEN** the low-level keyboard hook is explicitly uninstalled so no global hook is left dangling
- **AND** the process terminates without leaving orphaned windows
