# Connector Daemon

`packages/connector/daemon` composes the Connector Host application inside a
long-running desktop daemon. It owns bootstrap fencing, recovery ordering,
operation scheduling, catalog refresh/reconcile scheduling, and durable outbox
delivery.

The host also starts lifecycle maintenance immediately and repeats it hourly.
Defaults retain terminal operation lookup/idempotency results for 24 hours and
published outbox receipts for one hour, with bounded SQLite cleanup batches;
each run drains eligible backlog through repeated transactions. Active
operations and pending events are outside the cleanup contract.

The module provides the market catalog projection, while hosts inject their
HTTP client/proxy policy, request authorization, event publication,
persistence, and execution ports. Product account policy and generated HTTP
handlers remain in the consuming daemon.
