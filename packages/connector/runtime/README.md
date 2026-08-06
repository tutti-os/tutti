# Connector Runtime

`packages/connector/runtime` is the reusable same-machine Connector runtime
foundation. Tutti runs it on the desktop host; VM-backed products run it inside
the managed guest. It owns secure artifact preparation, managed runtime
identity, runtime ABI verification, typed Node package installation, the MCP
stdio client, the host-neutral ImplementationHost/CommandRegistry, Connector
Broker discovery/invocation, and verified Connector Skill reading.

Hosts supply the managed runtime resolver, implementation host, process
transport, HTTP client/proxy policy, state roots, and product-facing command
transport. Runtime code must not import `services/tuttid` or expose host
filesystem paths as a cross-machine protocol.

Authorized `managed_stdio` Connectors declare a connector-owned
credential broker entrypoint. The broker translates its provider-specific
flow into the `tutti.connector.credentials.v1` event protocol. Tutti validates
every authorization URL against the manifest's exact HTTPS host allowlist and
keeps one broker session alive while the provider emits multiple steps. CLI
credentials remain user-global in the real user home, while the CLI itself is
installed only in Tutti's private managed directory and is never added to the
system `PATH`.

Connector installation, MCP, CLI, and credential-broker processes intentionally
do not use an OS process sandbox. `NewConnectorProcessTransport()` preserves
the security boundary through pinned packages, verified artifact receipts,
immutable execution snapshots, executable SHA-256/size verification, an
explicit environment, process groups, timeouts, and bounded output.
