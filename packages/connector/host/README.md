# Connector Host

`packages/connector/host` is the host-neutral Connector application core. It
owns catalog acceptance, device installation and account authorization projections, durable
operation transitions, compatibility evaluation, recovery, reconcile intent,
manifest validation, installation calibration, and the ports implemented by
daemon and runtime hosts. Calibration reads verified physical installation
receipts only; Connector-owned commands never determine installation truth.

The package contains no HTTP client, SQLite driver, product account state,
Electron API, absolute state root, or operating-system process policy.
Lifecycle behavior belongs here when Tutti and another daemon host must observe
the same result.

`OperationScope` freezes the account authority used by a durable command.
`RuntimeBindingResolver` derives the connection ID, active/inactive intent and
one-shot credential grant from that scope. Grants are passed directly to the
implementation host and cleared after the call; they are never operation
state. `ReleaseInstallationManager` is the single physical install/uninstall
boundary. Same-machine hosts compose artifact import plus optional CLI
installation; cross-machine hosts may download and cache on the control-plane
machine, sync the verified candidate, and install it on the runtime machine.
Receipts may use opaque references when execution is remote. Installation
never implies runtime publication: authorization observation drives a separate
reconcile. Runtime receipts carry structured per-interface readiness so a
CLI-only Connector can be ready without an MCP route. A successful enabled
reconcile also carries the bounded `ConnectorSummary` committed by that exact
route generation. Lifecycle observers consume this receipt projection even
while Agent publication is fenced; they must not perform a later key-only
lookup against the mutable published registry.

External Connector mutations retain snapshot-revision CAS semantics.
Level-triggered daemon repair uses `EnsureRuntimeReconcile` instead: the Host
atomically creates a reconcile from current durable state or joins the active
reconcile for the same Connector and account scope. This keeps internal repair
independent from unrelated Connector revision changes without weakening the
public mutation contract. A caller that joins older work waits for it and then
ensures again, because the older operation may already have resolved its
runtime binding before the caller persisted newer desired state.
