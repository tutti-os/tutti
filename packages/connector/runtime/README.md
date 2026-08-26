# Connector Runtime

`packages/connector/runtime` is the reusable same-machine Connector runtime
foundation. Tutti runs it on the desktop host; VM-backed products run it inside
the managed guest. It owns the latest-only `current + candidate` raw artifact
cache, a no-network importer for synchronized archives, secure artifact preparation, managed runtime
identity, runtime ABI verification, typed Node package installation, MCP
clients, the host-neutral ImplementationHost, RouteRegistry and MCPRegistry,
Connector discovery, stable CLI shims, exact CLI execution, verified Connector Skill discovery, and
the session-bound loopback MCP server used by native Agent MCP clients.

`ImplementationHost` validates the optional Skill tree before publishing a
route and commits its metadata into `RouteRegistry` as an immutable projection.
Agent discovery and routing hints read that projection directly; they never
rescan a mutable installation directory. MCP calls use `MCPRegistry`. Product-
owned CLI brokers use `ImplementationHost.StartCLI`, binding each launch to the
exact connection, Connector version, release digest, host generation, and
derived CLI contract hash published by `RouteRegistry`. Callers provide only
the absolute per-invocation working directory and user arguments; the host
resolves the verified executable, environment, state root, user home, and
artifact identities from the exact current route. Product brokers that accept
a logical or remote working directory must validate its allowed workspace
scope and map it to a local absolute path before calling `StartCLI`. Stable
per-Connector shims remain the same-machine compatibility surface and are not
an authorization boundary. There is no generic `connector.invoke` or
arbitrary-command transport in the public runtime.

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

`ManagedCLIContractHash` is derived from invocation semantics, not release
implementation details. Command ordering and descriptions do not affect the
digest; fixed arguments, command argument mappings, input schemas, and timeouts
do. Cross-machine products must authorize a public Connector key, version and
command in their own typed protocol. The receiving machine resolves and pins
its exact current route identity before calling `StartCLI`; boot epoch,
generation, release digest and contract hash are never trusted across machines.
Products must not serialize executable paths or treat an existing generic
command tunnel as a fine-grained Connector grant.

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
credentials and configuration remain in the Connector-private state directory;
the CLI itself is installed only in Tutti's private managed directory and is
never added to the system `PATH`.

An `authorization_url` event may include the V1 event's existing `code` field
when the provider requires a short-lived user-facing device code. The runtime
keeps that code only in the in-memory broker session and projects it into the
existing V1 `device_code` Authorization View. It is never persisted or written
to diagnostics. Brokers without a code and older hosts retain the external-link
fallback.

Credential-broker sessions are owned by the durable authorization operation,
not only by the Connector route. Repeating that operation may resume its
session; a different operation must first cancel the previous session and wait
for its process to exit. This exit confirmation is required before another
broker can use the same Connector state directory, including on Windows where
process-tree termination remains inside the injected process transport.

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
