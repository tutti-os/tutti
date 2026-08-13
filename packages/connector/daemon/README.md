# Connector Daemon

`packages/connector/daemon` composes the Connector Host application inside a
long-running desktop daemon. It owns bootstrap fencing, recovery ordering,
operation scheduling, catalog refresh/reconcile scheduling, and durable outbox
delivery. Bootstrap also calibrates releases with explicit MCP/CLI installation
probes before opening capability publication; catalog-only connectors are not
probed.

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

The active account scope also bounds authorization receipt polling. Snapshot
sync atomically converges the account Projection and surfaces matching private
receipts, but does not terminalize them or enqueue runtime work. The daemon is
the single scheduler for this recovery path: while holding the lifecycle fence
it atomically creates or joins one scoped Runtime Reconcile, awaits it, and only
then resolves those receipts. Joining existing work is not treated as proof of
current convergence: after that operation completes, the daemon ensures and
awaits a reconcile created from the latest Projection.
WebSocket events are only refresh hints; a five-minute level-triggered pass
reconciles every installed remote authorized Connector so a lost event or an
interrupted earlier pass cannot leave route state stale.
