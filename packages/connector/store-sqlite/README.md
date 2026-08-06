# Connector SQLite Store

`packages/connector/store-sqlite` is the canonical local SQLite implementation
of the Connector Host repository and changed-event outbox contracts. Hosts own
the selected database path and process lifecycle; the module owns schema,
migration, transactions, revisions, leases, and operation persistence.

Active operations and pending outbox events are durable and never age-pruned.
The lifecycle cleanup contract removes bounded batches of expired terminal
operations and already-published events. Installed release evidence is stored
separately from operation history so runtime recovery does not depend on an
expired operation row.
