# Connector Runtime

`packages/connector/runtime` is the reusable same-machine Connector runtime
foundation. Tutti runs it on the desktop host; VM-backed products run it inside
the managed guest. It owns the latest-only `current + candidate` raw artifact
cache, a no-network importer for synchronized archives, secure artifact preparation, managed runtime
identity, runtime ABI verification, typed Node package installation, MCP
clients, the host-neutral ImplementationHost, RouteRegistry and MCPRegistry,
Connector discovery, stable CLI shims, verified Connector Skill discovery, and
the session-bound loopback MCP server used by native Agent MCP clients.

`ImplementationHost` validates the optional Skill tree before publishing a
route and commits its metadata into `RouteRegistry` as an immutable projection.
Agent discovery and routing hints read that projection directly; they never
rescan a mutable installation directory. MCP calls use `MCPRegistry`, while CLI
calls use the stable per-Connector shim. There is no generic Connector broker
or generic `connector.invoke` transport in the public runtime.

Every successful enabled `Reconcile` returns the bounded discovery summary for
the exact committed connection, release digest, and host generation. This
receipt projection is independent of the Agent publication switch. Cross-
machine hosts should serialize it directly into their observed-runtime
protocol instead of querying `RouteRegistry` by Connector key after reconcile.

Hosts supply the managed runtime resolver, implementation host, process
transport, `RemoteMCPClientFactory`, state roots, and product-facing command
transport. Runtime code must not import `services/tuttid` or expose host
filesystem paths as a cross-machine protocol. `ImplementationHost` owns remote
MCP bootstrap and route lifecycle, while the product factory owns the physical
connection path and request authorization. A desktop host may connect directly
to its Gateway; a VM-backed host may return a client for a typed desktop relay
without hiding target rewrites inside a generic HTTP transport.

`mcpserver.Start` projects one `implementationhost.MCPRegistry`, or a
product-supplied `mcpserver.SessionRouter`, through the stateless Connector
Streamable HTTP protocol on an ephemeral loopback port. A Session router
receives the Workspace, Agent Session, and optional Invocation identity derived
from the server-issued bearer; MCP arguments and request headers cannot replace
that scope. `MCPRegistry.CallProjectedValidated` lets a router select an
authority-specific validation schema while retaining the exact live downstream
binding. Its in-process Tool contract carries non-serialized Connector key and
release version provenance so hosts can enforce exact allowlists without
parsing namespaced Tool names. This lets products compose session-specific tool
catalogs without weakening the loopback transport boundary. The default
registry adapter preserves the original process-wide projection.
Hosts issue one bearer binding per Workspace/Agent Session or exact Invocation
and must revoke that binding when its scope ends. A backend may be rebound under
the same Invocation bearer after restart, but crossing an Invocation boundary
requires a new bearer and provider reprepare so delayed requests cannot inherit
new authority. Bindings carry transport authority only: they
never contain Connector credentials and must not be rendered into prompts or
logs. The server remains running when the registry is empty and relays
`tools/list_changed` notifications as routes are reconciled.

`DownloadCache` is intended for the machine that holds Market authority. It
keeps only the last installed archive and one replaceable candidate per
Connector. `Importer` is intended for a runtime machine: it accepts an absolute
path delivered by the host data plane, revalidates size, SHA, manifest, and
inventory, and never downloads. `ReleaseInstaller` composes same-machine import
and typed CLI installation behind the Host's single install port.

Physical installation inspection revalidates artifact and CLI receipts and
never executes Connector-owned commands. A managed CLI may separately provide
a bounded `readinessProbe`; it runs only after the release has been resolved
and affects runtime interface readiness, not installation truth.

Explicit Connector uninstall is connector-scoped rather than release-scoped.
The host fences all matching routes across connection IDs, cancels pending
credential-broker sessions, closes their execution snapshots, removes the
stable CLI shim, and deletes every prepared release and Connector-private Node
package tree. Shared package-manager stores, account authorization, and
user/workspace state are retained. On startup, `ImplementationHost` removes
orphan staging and ready execution snapshots left by an unclean shutdown.

Authorized `managed_stdio` Connectors declare a connector-owned
credential broker entrypoint. The broker translates its provider-specific
flow into the `tutti.connector.credentials.v1` event protocol. The final v1
contract includes typed `inspect` alongside `begin` and `disconnect`, so a runtime owner can
calibrate connected, disconnected, expired, and failed state after restart.
Tutti validates
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

Node package installation keeps the managed Node directory first on `PATH`,
then appends the desktop-resolved login-shell `PATH` so declared lifecycle
scripts can invoke host tools such as `curl` and `tar`. Only transport,
certificate, locale, and platform process variables are forwarded; private
home, temporary, package-manager cache, and package-manager home paths remain
owned by Tutti.
