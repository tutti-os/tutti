# Connector SQLite Store

`packages/connector/daemon/application/adapters/sqlite` is the canonical local SQLite implementation
of the Connector Host repository and changed-event outbox contracts. Hosts own
the selected database path and process lifecycle; the module owns schema,
migration, transactions, revisions, leases, and operation persistence.

Device installation remains on the Connector row. Account authorization is
stored independently in `connector_market_authorization_projections`, keyed by
`account_id + connector_key`, so account switching cannot overwrite installed
truth. Local uninstall deletes installed-release evidence but never deletes the
account authorization Projection; disconnect is a separate authorization
operation.

Authorization Session receipts remain private inside completed Start operation
records. Snapshot application uses one SQLite transaction to advance the
account Projection and surface every matching unresolved receipt when the
server reports the Connector connected. Older Snapshot revisions never replace
newer Projection state; the daemon resolves a receipt only after its scoped
Runtime Reconcile completes.

Active operations and pending outbox events are durable and never age-pruned.
The lifecycle cleanup contract removes bounded batches of expired terminal
operations and already-published events. Installed release evidence is stored
separately from operation history so runtime recovery does not depend on an
expired operation row. A probe-detected missing implementation retains that
evidence while installation is failed, allowing repair or uninstall to keep
targeting the accepted release.
