# Activity Replication

`github.com/tutti-os/tutti/packages/agent/activity-replication` is the official
versioned JSON contract for uploading canonical agent activity snapshots to a
cloud projection.

The root package defines the wire batch, mutation, typed entity key, scopes,
five projection snapshots, validation, and acknowledgement/rejection
semantics. Canonical activity vocabulary comes from
`store-sqlite/canonical`; this module does not define a second set of turn or
interaction lifecycle values.

The `conformance` subpackage exposes backend-neutral fixtures through two
interfaces that match the direction of data flow:

- `ProjectionBuilder` seeds canonical state and builds the official mutations;
  the Tutti SQLite adapter and tsh local builder run `ProjectionFixtures`.
- `Sink` applies official mutations and reads the final projection; tsh-server
  MySQL runs `SinkFixtures`.

The sink fixtures verify that:

- an already committed mutation retried after its HTTP response was lost is
  accepted as a duplicate and returns its original cursor;
- a stale snapshot is an acknowledged no-op and does not block later ordered
  mutations;
- reusing a mutation ID for a different identity is a permanent rejection;
- schema rejection reports the failing mutation and transaction IDs.

The contract owns no database queries, room authorization, transport,
WebSocket behavior, or GUI-derived state. `runtimeOperation`,
`runtimeOperationEvent`, and `submitClaim` are retained only as entity names
for decoding tombstone deletes; new upserts are invalid.

The production module depends only on the nested, dependency-free
`store-sqlite/canonical` module. The SQLite conformance adapter lives in the
store module's tests, so importing this contract does not add the SQLite driver
or daemon to a consumer's module graph.

Consumers should validate an ordered batch with `ValidateBatch`, preserve the
original durable cursor for duplicate acknowledgements, count duplicate and
stale mutations in `acceptedCount`, and use `SummarizeAcknowledgements` to
produce the batch result.
