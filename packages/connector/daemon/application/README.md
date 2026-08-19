# Connector Daemon Application

`packages/connector/daemon/application/application` composes Connector Daemon Core inside a
long-running desktop daemon. It owns bootstrap fencing, recovery ordering,
operation scheduling, catalog refresh/reconcile scheduling, and durable outbox
delivery. Bootstrap fail-closes stale authority and recovers durable global
state before opening capability publication, but it does not wait for
Connector-local installation probes or runtime startup. Those workflows run
independently with bounded cross-Connector concurrency; catalog-only
connectors are not probed.

The host also starts lifecycle maintenance immediately and repeats it hourly.
Defaults retain terminal operation lookup/idempotency results for 24 hours and
published outbox receipts for one hour, with bounded SQLite cleanup batches;
each run drains eligible backlog through repeated transactions. Active
operations and pending events are outside the cleanup contract.

Accepted/running Operations are also scanned every 500 ms. The in-memory
scheduler is a wake-up optimization only: losing a schedule call or restarting
after an external effect cannot strand durable work.

The `adapters/catalog` package provides the Market catalog projection, while hosts inject their
HTTP client/proxy policy, request authorization, event publication,
persistence, and execution ports. Product account policy and generated HTTP
handlers remain in the consuming daemon.

The catalog projection consumes the market-neutral generated protocol from
`packages/clients/market-go` and fixes `itemType=connector` only at this
adapter boundary. Category IDs remain opaque and are returned unchanged as
pagination section IDs; future Skill consumers reuse the client without
importing this Connector daemon module.

Hosts with an account-scoped runtime call `BootstrapForScope`; the daemon
reuses that explicit scope for recovery retries. The legacy `Bootstrap` method
retains Tutti's device-global behavior through the default runtime-binding
resolver.

Remote runtimes inject `CapabilityPublicationController`; bootstrap awaits its
fail-closed/open commands. Same-process Tutti runtimes remain compatible with
the synchronous implementation-host publication gate.

For one Connector, recovery preserves the safety order `installation
calibration -> Desired planning -> Observed convergence`. A slow or invalid
Connector therefore remains starting/failed without delaying unrelated
Connectors or daemon readiness. Account-authorized remote routes remain
fail-closed behind `AuthorizationReadiness` until a fresh account snapshot is
applied asynchronously; device-local authorization-free routes may recover
immediately.

Account logout and switching use `Host.FenceForScope` to close remote
publication, fail-close all processes, and force a later bootstrap even when
the same account logs in again. The account-boundary fence never admits or
starts a runtime with retired authority; per-Connector deactivation remains a
normal uninstall/reconcile concern.

The active account scope also bounds authorization receipt polling. Snapshot
sync atomically converges the account Projection and surfaces matching private
receipts, but does not terminalize them. The daemon is the single scheduler for
this recovery path: while holding the lifecycle fence it updates the scoped
Runtime Desired and waits until Observed records that exact generation before
resolving those receipts. Runtime convergence is private durable state and does
not consume the public one-active-Operation slot.
WebSocket events are only refresh hints; a five-minute level-triggered pass
reconciles every installed remote authorized Connector so a lost event or an
interrupted earlier pass cannot leave route state stale.

A continuous scanner also claims due Runtime Desired rows with bounded
cross-Connector concurrency. Same-Connector duplication is prevented by the
durable lease and desired-generation CAS; different Connectors may reconcile in
parallel. A new daemon boot treats every older-boot Observed receipt as stale.
Planning and each Observed success/failure append a Connector Market changed
event transactionally with their projection update, so clients can render
`starting`, `started`, or `failed` independently without polling for the end of
an aggregate bootstrap batch.
The implementation host combines a global admission/fence barrier with a
Connector-keyed lifecycle lane: account switching and FailClosed wait for every
in-flight route transition, while different Connectors may install, authorize,
or reconcile concurrently. Shared download and package-install resources use a
bounded semaphore rather than a long global lifecycle lock.
