---
"@tutti-os/connector-market": minor
"@tutti-os/desktop": minor
---

Integrate the signed Connector Market into tutt-id and the desktop renderer.
Connector releases are now verified, installed durably, exposed through the
workspace service, and executed as daemon-owned MCP or sandboxed Node/Python
CLI capabilities. Standardize the reusable surface as the
`@tutti-os/connector-market` `/core`, `/services`, and `/ui` entrypoints plus
the Connector Host, Daemon, SQLite Store, and Runtime Go modules.
