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

Hosts with an account-scoped runtime call `BootstrapForScope`; the daemon
reuses that explicit scope for recovery retries. The legacy `Bootstrap` method
retains Tutti's device-global behavior through the default runtime-binding
resolver.

Remote runtimes inject `CapabilityPublicationController`; bootstrap awaits its
fail-closed/open commands. Same-process Tutti runtimes remain compatible with
the synchronous implementation-host publication gate.

Account logout and switching use `Host.FenceForScope` to close remote
publication, fail-close all processes, and force a later bootstrap even when
the same account logs in again. The account-boundary fence never admits or
starts a runtime with retired authority; per-Connector deactivation remains a
normal uninstall/reconcile concern.
