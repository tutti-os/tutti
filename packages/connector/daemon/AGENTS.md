# AGENTS.md

## Scope

This directory owns reusable Connector daemon behavior:

- `core`: lifecycle semantics and ports
- `application`: scheduling, recovery, reconciliation, and catalog adapter
- `adapters/sqlite`: canonical persistence and outbox
- `adapters/controlplane`: authorization HTTP/WebSocket protocol adapter

## Ownership

Put a rule in Core when every host must observe it. Put long-running process
orchestration in Application. Put protocol or storage mechanics in the named
adapter. Concrete account policy, endpoint selection, HTTP client construction,
filesystem roots, and composition remain with the product host.

Core imports no Application or adapter. Application depends on Core and may
compose adapters through Core ports. Adapters depend on Core, not Application.
Keep each existing `go.mod` independent.

For lifecycle or protocol changes, read
[Connector Architecture](../../../docs/architecture/connector.md). Run the
affected module's `go test ./...`; final validation follows repository
[Validation Selection](../../../docs/conventions/testing.md#validation-selection).
