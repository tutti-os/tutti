# Connector

Connector code is organized by architectural ownership:

- `contracts`: versioned wire schemas and OpenAPI resources
- `daemon/core`: lifecycle semantics and host ports
- `daemon/application`: scheduling, recovery, reconciliation, and catalog access
- `daemon/adapters`: reusable SQLite and Control Plane adapters
- `runtime`: verified artifact and process execution
- `renderer/application`: React-free frontend services and state
- `renderer/ui`: shared Connector React, icons, and presentation

Product-specific composition remains in `services/tuttid`, `apps/desktop`, and
the AgentGUI integration boundary. See
[Connector Architecture](../../docs/architecture/connector.md) for ownership
and data flow.
