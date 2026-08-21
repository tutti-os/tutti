---
"@tutti-os/connector-renderer": minor
"@tutti-os/desktop": minor
---

Integrate the signed Connector Market into tutt-id and the desktop renderer.
Connector releases are now verified, installed durably, exposed through the
workspace service, and executed as daemon-owned MCP or sandboxed Node/Python
CLI capabilities. Standardize the reusable surface as the
`@tutti-os/connector-renderer` `/application`, `/i18n`, and `/ui` entrypoints
plus the Connector Daemon Core, Application, SQLite Adapter, Control Plane
Adapter, and Runtime Go modules.
