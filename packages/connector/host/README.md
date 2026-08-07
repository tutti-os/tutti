# Connector Host

`packages/connector/host` is the host-neutral Connector application core. It
owns catalog acceptance, device installation and account authorization projections, durable
operation transitions, compatibility evaluation, recovery, reconcile intent,
manifest validation, and the ports implemented by daemon and runtime hosts.

The package contains no HTTP client, SQLite driver, product account state,
Electron API, absolute state root, or operating-system process policy.
Lifecycle behavior belongs here when Tutti and another daemon host must observe
the same result.

`OperationScope` freezes the account authority used by a durable command.
`RuntimeBindingResolver` derives the connection ID, active/inactive intent and
one-shot credential grant from that scope. Grants are passed directly to the
implementation host and cleared after the call; they are never operation
state. Artifact and CLI ports may return opaque references when execution is
owned by another machine, while same-machine runtimes may use local paths.
