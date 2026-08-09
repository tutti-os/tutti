# Connector Host

`packages/connector/host` is the host-neutral Connector application core. It
owns catalog acceptance, device installation and account authorization projections, durable
operation transitions, compatibility evaluation, recovery, reconcile intent,
manifest validation, installation calibration, and the ports implemented by
daemon and runtime hosts. Calibration executes only an already-installed
release's bounded MCP/CLI probe and preserves durable state on indeterminate
results.

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
reconcile.
