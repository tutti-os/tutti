# Connector SQLite Store

`packages/connector/store-sqlite` is the canonical local SQLite implementation
of the Connector Host repository and changed-event outbox contracts. Hosts own
the selected database path and process lifecycle; the module owns schema,
migration, transactions, revisions, leases, and operation persistence.

Device installation remains on the Connector row. Account authorization is
stored independently in `connector_market_authorization_projections`, keyed by
`account_id + connector_key`, so account switching cannot overwrite installed
truth.

Active operations and pending outbox events are durable and never age-pruned.
The lifecycle cleanup contract removes bounded batches of expired terminal
operations and already-published events. Installed release evidence is stored
separately from operation history so runtime recovery does not depend on an
expired operation row. A probe-detected missing implementation retains that
evidence while installation is failed, allowing repair or uninstall to keep
targeting the accepted release.
