# AGENTS.md

## Scope

This module owns same-machine and managed-guest Connector execution: verified
artifacts, immutable execution snapshots, managed packages, MCP/CLI processes,
credential brokers, routes, and the loopback MCP server.

## Rules

- Depend on Daemon Core contracts; import no Daemon Application, SQLite,
  Control Plane, Desktop, AgentGUI, or tuttid implementation.
- Keep product endpoints, account authentication, state-root selection, and
  cross-machine transport in injected ports or product adapters.
- Treat artifact identity, executable path, process environment, bearer scope,
  output bounds, and cleanup as security boundaries.
- Keep paths and process behavior portable. Read
  [Windows Platform Support](../../../docs/architecture/windows-platform-support.md)
  before changing filesystem, executable, shell, signal, or process behavior.

Run `go test ./...` in this module after Runtime changes. Use
`pnpm check:connector-boundaries` for dependency ownership and follow the root
validation-selection policy for final gates.
