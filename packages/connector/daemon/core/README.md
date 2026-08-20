# Connector Daemon Core

`packages/connector/daemon/core` is the host-neutral Connector application core. It
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
never implies runtime publication: a prepared Candidate and Runtime Desired are
committed together, and Current is promoted only after the exact generation is
Observed by the current host boot. Runtime receipts carry structured per-interface readiness so a
CLI-only Connector can be ready without an MCP route. A successful enabled
reconcile also carries the bounded `ConnectorSummary` committed by that exact
route generation. Lifecycle observers consume this receipt projection even
while Agent publication is fenced; they must not perform a later key-only
lookup against the mutable published registry.

New Connector mutations use a per-Connector revision fence; the global Snapshot
revision remains the compatibility fallback for old clients. Private
runtime anti-entropy uses `RuntimeDesired` and `RuntimeObserved` instead of a
public Operation. The Host advances a scope-and-Connector generation only when
intent changes or an observer invalidates the current receipt. Workers claim
that generation with a renewable lease; Observed commits use an exact-generation
CAS so stale host results cannot overwrite newer authorization or release
intent.

Install/update/uninstall/authorization are phase state machines implemented as
short repository transactions around idempotent effects. Updates retain Current
and Candidate release evidence simultaneously. Disconnect and uninstall both
wait for a disabled Observed receipt before they complete or remove physical
content.
