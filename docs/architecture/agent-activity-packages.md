# Agent Activity Packages

Status: current implemented architecture

This document records the package split for reusable Agent Activity and Agent
GUI surfaces. The goal is to make the agent session data flow reusable by other
repositories while keeping host-specific transport and desktop integration out
of the shared packages.

System-wide ownership and flow rules live in
[Agent GUI Node](./agent-gui-node.md). This document is the detailed package
contract for activity-core/runtime/adapter changes, not required reading for a
presentation-only edit.

## Design Goals

- Put reusable agent session state, event merging, and attention selectors
  behind a host-agnostic core package.
- Keep `apps/desktop` responsible for `tuttid`, preload, Electron, local file,
  and runtime integration.
- Let Agent GUI and Message Center consume one shared Agent Activity snapshot
  instead of building separate session caches.
- Prepare for external repository adoption through a narrow adapter interface.

## Package Map

The current package family is:

```text
packages/agent/activity-core
  @tutti-os/agent-activity-core

packages/agent/activity-tuttid-adapter
  @tutti-os/agent-activity-tuttid-adapter

packages/agent/gui
  @tutti-os/agent-gui

packages/agent/activity-replication
  github.com/tutti-os/tutti/packages/agent/activity-replication

packages/agent/host
  github.com/tutti-os/tutti/packages/agent/host

packages/agent/store-sqlite
  github.com/tutti-os/tutti/packages/agent/store-sqlite

packages/agent/store-sqlite/canonical
  github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical
```

`packages/agent/store-sqlite/canonical` is the single authority for canonical
activity contracts. It owns phase, outcome, origin, interaction-kind and
interaction-status vocabulary; pure activity projection snapshots and merge
functions; commit-observer report types; and the provider identity,
capability, and plan-decision vocabulary needed by canonical persistence.
Daemon packages retain compatibility aliases, while runtime mechanics remain
daemon-owned.

New canonical messages always carry an explicit
`userVisibleAssistantResponse` classification. Runtime message producers
classify the message before reporter and local-store projections write it:
user-facing assistant text, plans, and visible failures are `true`; user input,
reasoning, tool calls, and system notices are `false`. Every projection preserves
that classification. Replication and read contracts continue to accept a
missing value from older stored messages, so compatibility stays at the read
boundary instead of being inferred by presentation code.

Canonical tool-call persistence also owns the replication-safe payload budget.
Provider `content` is projected into the formal output fields before MCP
`structuredContent` is normalized: exact string leaves that duplicate
`output.text` keep their map key or array position with an explicit duplicate
marker, while other structured string leaves are deterministically and
UTF-8-safely shortened with the standard truncation marker. Inputs and
non-string structured values are never shortened. The final encoded payload
must fit the 768 KiB canonical budget; if required data alone cannot fit, the
write returns an error and the transaction does not persist an unsynchronizable
message. A versioned store migration applies the same projection to retained
oversized tool calls, including MCP messages, and updates a row only after its
encoded replacement satisfies the budget. Replication consumers derive a new
fingerprint and mutation identity from that physical repair, which clears any
retry schedule tied to the obsolete oversized representation.

## Responsibilities

### `packages/agent/host`

`host` is the provider-neutral Go application boundary for canonical agent
session and turn lifecycle work. It owns lifecycle input/result contracts,
narrow canonical-store and runtime ports, runtime preparation and attachment
materialization ports, clock and scheduler ports, and post-commit observer
hooks. The `conformance` subpackage owns reusable typed lifecycle scenarios so
the legacy `tuttid` service, the extracted Host, and downstream adapters can be
checked against the same behavior baseline.

Session read and metadata commands follow the same boundary. `GetSession`
returns canonical truth with an optional live observation. Settings updates
are serialized with resume and split between historical persistence and live
runtime mutation; provider normalization stays in an adapter policy. Pin and
canonical delete are Host commands, while authorization, transport DTOs,
shared bindings, and local view cleanup remain adapter-owned.

Single and batch canonical delete are the same Host command shape. The store
plans the complete descendant closure, Host quiesces that exact closure under
the shared session-mutation lane, and the write transaction rejects a stale
plan. Renderer-side request loops are not an atomic batch-delete
implementation. `daemon/hostadapter` is the official daemon-runtime-to-Host
adapter, `host.SQLiteWorkspaceStore` is the workspace-routed canonical store,
and `daemon/modelcatalog` owns provider model/reasoning/speed normalization;
product daemons compose these modules instead of copying their mappings.

Canonical delete is a lossless tombstone transition. The transaction preserves
each selected root/child Session component, its Turns, Messages, Interactions,
effective history, turn submissions, provider resume identity, and attachment
references.
It terminalizes only work that cannot safely become live again: active Turns
are interrupted, pending Interactions are superseded, and runtime/Goal
operations are settled. Every member of one component receives the same
deletion timestamp, recoverable-deletion generation, and component size without
rewriting the Session's original `updated_at`, rail placement, project path, or
other metadata. Stable Goal and effective-history rows remain unchanged;
pending Goal work is terminalized without rewriting desired/observed Goal
content, revision, or tombstone meaning. Components are computed from
connectivity inside the exact delete set, rather than canonical root identity,
so sibling child subtrees in a
batch remain independently restorable. Repeating the same delete is a no-op and
does not extend retention. Deleting a new live ancestor absorbs any complete,
current recoverable descendant components into one fresh generation; those
already-deleted members are not counted or settled again. A legacy or
incomplete descendant is not upgraded, so the resulting topmost component
fails restore validation while remaining eligible for explicit permanent
deletion.

`Host.ListDeletedSessions` exposes topmost deleted Sessions in one Workspace—a
root or child tombstone whose parent is not tombstoned—with title/project
filtering and stable `updated_at DESC, session id ASC` cursor paging.
Deleted-session classification and filtering use the immutable persisted
`railSectionKey` exclusively. The read contract carries that key on every
Session and project option; `rail_project_path` remains optional presentation
metadata for labels and restore context and must not become a join or filter
identity. Transport adapters may resolve an explicit legacy project-path
filter to its canonical section key before calling Host, but must never infer a
deleted Session's section from that path or from `cwd`.
`Host.RestoreDeletedSession` clears the tombstone for the exact complete
component in one transaction and deliberately does not start or resume a
provider runtime. Tombstones created by the older lossy implementation remain
visible for permanent deletion but are explicitly not restorable. A restored
Session follows the ordinary resume policy only after a later user action. The
post-commit projection publishes one explicit `session_restored` wake hint per
restored member. A frontend engine may clear its late-event tombstone only for
that explicit event, then must hydrate authoritative Session detail before the
Session becomes visible again; an ordinary reconcile event cannot resurrect a
deleted Session.

Permanent deletion is intentionally distinct from the normal canonical delete
command. `Host.PurgeDeletedSessions` accepts a cutoff and bounded batch limits,
while `store-sqlite` selects each topmost tombstone with its complete descendant
tree, fences every member with its exact `deleted_at` value, and removes an
eligible tree in one transaction. A tree with any live or too-new member is
retained as a unit. The first eligible tree may exceed the normal row or payload
bound so that a large tree cannot permanently starve, while blocked trees do not
prevent unrelated eligible components from being cleaned. The Store transaction
seams let the Workspace wrapper remove canonical rows, Tutti Mode state, and a
durable resource-cleanup outbox item in the same commit. Host does not choose
retention periods or filesystem paths.
Explicit workspace-scoped purge validates the physical boundary instead of
recoverability metadata: every reachable descendant must already be
tombstoned, after which legacy or incomplete components can be removed
leaf-first in one transaction.
The `tuttid` maintenance adapter owns the device-global 15/30-day preference,
idle-aware scheduling, once-per-day durable eligibility marker, manual purge
route, and optional database compaction. Workspace-scoped manual purge uses the
same idle gate and deletes one complete topmost component or every topmost
tombstone in that Workspace, independent of renderer filters.

After that commit, the maintenance adapter first attempts cleanup immediately
and retries failed entries during later idle maintenance windows; cleanup
failure never resurrects the deleted row or changes a successful HTTP result.
The outbox key remains Workspace/Session for per-purge durability, while the
current runtime sidecar and copied-attachment paths are keyed only by Session
ID. A pending outbox row therefore fences insertion of that ID in every
Workspace, and the cleanup worker queries the full canonical database and skips
deletion if any live or tombstoned row still owns it. Multiple Workspace queue
rows for one ID are handled idempotently. Recoverable tombstones keep both
resources; Workspace-keyed runtime and Model Gateway cleanup still runs, while
the global Agent/browser releaser is skipped if another Workspace has a live
owner with that ID. Managed worktrees are independent Workspace resources:
soft deletion, hard deletion, restore, and purge do not retain or remove them.
They are removed only through the explicit managed-worktree operation.

Automatic maintenance starts ten minutes after daemon readiness, checks at
30-minute intervals, and records completion at most once per 24 hours. It runs
only while no Agent turn is active and stops between short batches when Agent
work begins. Manual cleanup uses the same serialized maintenance service but
targets every current tombstone.
Only an explicit manual sweep may request database compaction. The daemon
attempts it after the final idle batch only when the database is small and at
least one quarter of its pages are reclaimable; automatic maintenance never
runs a full-database compaction.

`store-sqlite` owns the transaction implementation. Its caller-owned
`TransactionParticipant` seam lets an adapter append a durable outbox marker
to the same transaction as runtime/goal operation intent, canonical facts, and
non-re-derivable deletion tombstones without exposing `*sql.Tx` to Host domain
code. The seam is reserved for facts that must commit or roll back together;
re-derivable projection gates are repaired by consumers instead.

For durable workspace activity reads, `store-sqlite.AgentStateReader` returns
the canonical root Sessions composed with each Session's latest Turn. It does
not copy entity fields into a presentation model and does not include online
Presence or host-owned execution attribution. Hosts that own those independent
authorities compose them only at their API or product-view boundary.

After commit, Host emits typed `CommittedDelta` values through one
`CommitObserver`. Activity state, messages, root settlement, runtime and goal
operation milestones, projection-dirty identities, and canonical view
invalidations all use that path. Observer failure cannot roll back an already
committed command. Reliable delivery therefore depends on the durable marker,
while event-stream publication and cache invalidation remain post-commit wake
hints.

The Host release module depends on `store-sqlite` and its `canonical` module,
not on daemon, sidecar, or `tuttid` packages. It exposes `Run` to supervise the
runtime-operation, goal-operation, and reconcile-inbox workers as one
lifecycle, while retaining the individual worker entrypoints. The module does
not own transport, authorization, room or device identity,
process or VM implementations, HTTP/OpenAPI shapes, Electron integration, or
control-plane DTOs. `tuttid` production wiring delegates lifecycle decisions
to Host and keeps only its adapter responsibilities.

### `packages/agent/activity-replication`

`activity-replication` is the versioned Go wire contract for projecting an
owner-local canonical activity store into a cloud read model. It owns batch,
mutation, entity-key, scope, and snapshot JSON shapes; structural validation;
duplicate and stale acknowledgement semantics; and backend-neutral
conformance fixtures. Source/projection and sink/acknowledgement harnesses are
separate: the SQLite canonical store runs the source fixtures in this
repository, while external builders and MySQL sinks consume the matching side
of the same wire cases.

It imports the canonical activity vocabulary from
`packages/agent/store-sqlite/canonical`; it must not redefine turn phase,
outcome, origin, interaction kind, or interaction status values. It contains
no SQL, transport, authorization, WebSocket, GUI state, or local command-state
upserts. Legacy command-state entity names remain decodable only for projection
tombstone deletes.

### `@tutti-os/agent-activity-core`

`agent-activity-core` is host-agnostic and must not import React, Electron,
desktop preload APIs, or the generated `tuttid` client.

The published Tutti Mode activation contract retains
`orchestrationIntensity` as a deprecated effect alias during the
effect/speed migration. New fields take precedence when both forms are
present; presentations and daemon responses continue to emit the alias with
the normalized effect value. The tuttid adapter also accepts an older response
that contains only the alias and assigns balanced speed (`50`). Removing the
alias or its selector requires an explicit breaking package/API release.

It owns:

- agent activity contracts used by UI packages and host adapters
- the host adapter interface
- canonical session, turn, interaction, message, composer-option, prompt-queue,
  attention, and edit-retry command state inside one workspace engine
- memoized projection from engine state to the `AgentActivitySnapshot` runtime
  contract
- message merge, immutable presentation-sequence ordering, mutable version
  cursor handling, and duplicate handling
- authoritative Session reconcile execution: scope selection, mapped detail
  aggregation, message cursor/window policy, bounded page draining, the
  discovery/detail race fence, and atomic Engine application
- a 50ms streaming message reconcile window, aligned with the daemon streaming
  report coalescer, for cached `message_update` observations whose inline
  message versions have a gap; explicit reads, lifecycle transitions, and state
  repair remain immediate, and the deferred read still uses the authoritative
  message cursor
- selectors for reusable derived state
- `selectNeedsAttentionCount`
- `selectNeedsAttentionItems`
- the workspace session engine (`createAgentSessionEngine` under
  `src/engine/`): intent dispatch loop, domain-composed pure reducers,
  command-description effect executor, expiry-intent clock, and intent frame
  batching, with scheduler/clock/command ports injected by the host
- the typed frontend effect seam for activation, prompt send, Goal Control,
  settings update, turn cancellation, Interaction response, rename, pin, and
  batch delete,
  including lossless command projection, authoritative Session result
  validation for rename and pin, validated delete-result tombstone projection,
  shared mutation settlement, and a serialized settings-precondition state
  machine
- semantic `AgentSessionEngine` methods for composer-option loading, Session
  activation, existing-Session Prompt submission, Goal Control, Session stop,
  Interaction response submission, existing-Session settings updates, rename,
  pin, and batch delete. Activation, Prompt, Goal Control, stop, Interaction,
  and settings updates are intent admission: the Engine owns workspace and
  protocol construction.
  Activation owns requested/expiry timestamps, the 120-second confirmation
  window, and the accepted result. This window contains the 90-second
  new-Session activation command instead of allowing presentation expiry to
  race a valid slow startup. The caller retains the stable activation request
  and client submit identities used by optimistic state, dismissal, draft
  recovery, and idempotent retry. While an activation record exists, its
  request identity is single-use: the semantic method reports acceptance only
  when the current dispatch creates a new record, not when a rejected duplicate
  finds an older record for the same Session and mode. Prompt submission owns
  routing, the same confirmation window, and the accepted/queued result while
  its caller retains the stable client submit identity. The queue send command
  uses a 90-second delivery timeout (aligned with new-Session activation) so
  inactive-session Resume/Start can finish inside the 120-second confirmation
  window. Stop, Interaction, and
  settings additionally own command identity plus the 30-second delivery
  timeout.
  The admitted request identity is also projected as the required
  `activationId` on the typed host effect. Pending activation state records the
  command settlement outcome and timestamp separately from the first canonical
  Session observation. Snapshot observations distinguish missing Session,
  workspace mismatch, stale new-Session evidence, and a matching Session.
  Consumers can therefore measure command and snapshot latency independently;
  repeated identical observations do not churn state, and a late command result
  cannot regress an already confirmed activation.
  Session stop owns the 30-second first-Turn waiting window and duplicate
  admission across Desktop and Mobile. Interaction submission owns canonical
  pending-target admission,
  in-flight deduplication, and exact failed-response retry; it never recovers
  omitted answer fields from a prior attempt. Settings updates own serialized
  patch merging and recognition of a fresh user update as retry after unknown
  delivery. Consumers observe the existing operation projections. The other
  methods additionally hide cache or mutation coordination, settlement
  waiting, and canonical result projection from product hosts. Mutation
  methods own timeout and cancellation policy; hosts retain transport, DTO
  mapping, AbortSignal propagation, and product-specific command extensions
  (see
  [Agent GUI Node](./agent-gui-node.md#4-workspace-frontend-engine))

The public host-effect seam is `AgentSessionEffectPort`; the public
application-write seam is the semantic `AgentSessionEngine` methods.
Product hosts call `updateSessionSettings` for an existing Session instead of
constructing `session/settingsUpdateRequested` protocol fields. Settings held
before Session activation remain part of the activation flow and do not pass
through this existing-Session method.
Desktop AgentGUI and Mobile call `activateSession` instead of constructing
`activation/requested` protocol fields. Product surfaces still choose target,
placement, initial settings/content, and durable request identities; the Engine
admits that domain request under one workspace scope and confirmation policy.
Only an admitted activation may clear the new-Session draft. Actual Session
creation, resume, and initial Turn lifecycle remain Agent Host semantics behind
the host effect port. The typed effect returns an authoritative Session for a
new activation and the complete authoritative detail aggregate for an existing
activation. The Engine validates activation mode plus workspace/Session
identity and nested Session/Turn/Interaction entities before applying that
result through its canonical reducers. Desktop and Mobile effects may retain
product-local integration and observability, but must not dispatch Session
state before returning. The effect executor marks activation results with the
versioned `activation-v1` result contract; commands whose result shape is not
authoritative remain opaque.
An admitted new-Session activation may additionally carry the provider-neutral
`isolation: "worktree"` launch request. Activity Core preserves that field
through pending intent and typed effect projection; the tuttid adapter maps it
through the generated Create Session contract. It does not allocate a worktree
or choose a repository. Before allocation, the tuttid product adapter resolves
the exact Agent Target and rejects shared/remote target identities; the same
target-aware rule protects its worktree-support probe, so a caller cannot
bypass the AgentGUI visibility gate through the public daemon API. Agent Host
resolves the selected `cwd`, creates the
worktree from the current `HEAD` even when the checkout is dirty, and returns
the authoritative Session with durable isolation metadata. The canonical
Session projection carries `mode`, `worktreePath`, `branch`, and `baseCommit`
through list/detail/event flows so renderers do not infer isolation from `cwd`.
The transport and published core field remain optional for compatibility;
canonical normalizers map omission to `null`. Omitting the create field retains
the existing local-checkout behavior, preserving older hosts and external
AgentGUI consumers.
New-Session Goal Control uses the same activation path. The Engine carries a
typed `initialGoalControl`; Desktop and Mobile send it through the typed Create
contract with empty initial content. Agent Host creates the Session and durable
Goal operation without creating a Turn. It establishes the canonical Session
title from the display prompt, or from a synthesized `/goal` command when the
display prompt is absent. Non-empty initial content and typed initial Goal are
mutually exclusive, and product adapters must not reconstruct the command from
display text.
The public Session contract optionally carries `goalSyncState` as a narrow
Host-owned observation: revision, sync status, pending operation identity, and
optional `executionPending` proof. It does not move Goal saga ownership into
Activity Core. Missing state means the host cannot prove progress; explicit
`null` clears prior evidence, and Session merge preserves prior evidence when a
compatible partial projection merely omits the field. AgentGUI may use an
identified pending/applying/unknown operation for initial-Goal loading
continuity without inventing a Turn or a UI timeout. `synced` alone is terminal
mutation evidence, not proof that a future Turn will exist; only explicit
Host-owned `executionPending=true` bridges convergence to the first exact Goal
Turn. Terminal/non-active Goal evidence and that Turn clear the proof.
Desktop AgentGUI and Mobile call `stopSession` instead of constructing
`session/stopRequested` protocol fields. The same method stops an active Turn
or records a bounded request that cancels the first Turn produced by an
in-flight activation. When an implicit stop observes a submit admission without
an active Turn, it retains only a submit that may still produce an unsettled
Turn: definitive admission failure and a known settled canonical Turn are not
stop targets. Missing or out-of-order canonical evidence remains eligible, and
late activity messages correlate the exact submit identity before issuing the
Turn cancel.
Desktop AgentGUI and Mobile call `submitPrompt` for an existing Session instead
of constructing `submit/requested` protocol fields or reading multiple Engine
selectors to infer whether the submission was admitted. The Engine fixes the
same confirmation window and routing semantics for both surfaces; each surface
uses the returned accepted/queued result to decide whether its submitted draft
may be cleared. New-Session initial content remains part of activation.
AgentGUI, Message Center, Desktop notifications, and Mobile call
`submitInteractionResponse` for a canonical pending Interaction instead of
constructing `interaction/responseRequested` protocol fields. A failed
submission becomes retryable only when the surface explicitly submits the same
answer again; a missing or changed answer fails closed.
AgentGUI calls `controlGoal` for an existing Session instead of calling the
runtime adapter or constructing `goal/controlRequested`. The caller proposes
a stable client-submit identity and admission returns the effective identity
used by the Engine; the Engine owns command identity, 30-second
timeout, one in-flight admission per Session, optimistic Goal projection,
typed result validation, and exact-identity retry after unknown delivery.
Desktop and Mobile `controlGoal` effects only forward transport and map the
authoritative Session, Goal, durable operation identity, and Goal state. Goal
Control responses carry `goal` as a required nullable field so a successful
clear is an explicit `null`, never an omitted value that can fall back to a
stale runtime Session projection. That field is Host's durable desired
projection, while provider output remains separately observable through Goal
state. An empty pause/resume observation therefore records divergence without
erasing the visible Goal; only a durable tombstone returns `null`. The daemon
overlays that Host-owned result onto `session.goal`, and the Engine applies the
same invariant when a synced typed result reaches its canonical Session state.
Daemon Session reads apply the same authority rule: unresolved durable state
projects `desired`; synchronized state projects `observed` progress; a durable
tombstone clears the Goal. The Goal-state timestamp advances the Session
envelope. Single-Session reads, batch lists, refreshes, and realtime-driven
reloads therefore cannot overwrite a newer Goal with an older provider snapshot
or resurrect a completed Goal as active.
After Session creation, any later Goal Control operation retires the initial
activation Goal as a presentation source. The operation result and canonical
Session projection then own the banner, so the creation-time objective cannot
shadow a replacement Goal.
Engine-originated requests always send their caller-stable identity through to
the existing Agent Host Goal saga.
Every admitted mutation reaches Host; frontend Goal equality is not a no-op
rule because Host owns durable revision and audit creation. Pending/applying
Host state settles the frontend request as accepted, while transport loss,
timeout, opaque/malformed success, or Host unknown/diverged state stays
unknown. A retry of the same unknown mutation reuses the original
`clientSubmitId`, while a definitive failure releases that identity so the
next explicit attempt is a new operation. Generic Session reconciliation and
Goal value equality cannot settle that operation because neither proves its
durable identity.
The public Goal presentation and settlement maps are sparse. The Engine
updates them only for Session identities whose canonical Goal, Goal operation,
or Goal-bearing activation changed; it indexes pending Goal activations once
per relevant drain. Turn streaming and unrelated Session metadata preserve
the Goal branch and unrelated per-Session presentation references.
Desktop and Mobile keep a submitted Goal draft until that settlement reaches
`accepted` or `succeeded`, and clear it only if the user has not edited the
draft in the meantime. A definitive failure retains the text but releases the
pending identity; an unknown result retains both the text and identity for
explicit retry.
Rename and pin effects return an authoritative Session envelope, and batch
delete returns the complete typed deletion result. Reducers still validate
those results before applying canonical state, while the public port prevents
hosts from inventing a different result shape.
The reducer mutation protocol remains an Engine implementation detail; product
hosts use the semantic mutation methods. Prompt precondition ordering and its
helper port are also not exported from the package root. Reducer-only prompt continuation intents are
absent from public `EngineIntent`; their bookkeeping is also absent from
`AgentSessionEngineState`, `getSnapshot()`, and subscription callbacks.

Edit retry follows the same frontend command rule as pin, delete, cancel, and
reconcile: the engine owns the stable client operation id, pending/failure
record, typed recovery intent, and authoritative state-and-message follow-up.
React may retain an unsent editor draft, but it must not subscribe to raw
transport events or sequence edit-retry HTTP calls itself. The Desktop command
port translates `turn/editRetry` and `turn/recoverEditRetry` to the injected
`TuttidClient`; the result re-enters the reducer as `reconciling`, while only
the authoritative session-detail projection may replace edit-retry
availability and release that fence.

Edit retry also requires deletion-capable history convergence. The engine keeps
the required history revision separate from the applied revision. An empty
cache may establish its initial revision through the ordinary detail-plus-page
read; once messages are cached, a changed or explicitly required revision must
use one composite authoritative snapshot that replaces Session, Turn, and
Message projections instead of incrementally merging them. Desktop serializes
same-Session events and reads, loads the complete descending history at a fixed
newest-page anchor, drains the ascending tail, fences the read with session
detail before and after, and retries transient projection failures while the
event stream is connected. Reconnect rechecks every cached Session.

That composite snapshot also reconciles settled optimistic submissions and
completion attention. It removes an optimistic row only when its stable Turn
and client-submit identity are both absent from effective history; unresolved
requests and turnless controls remain. Historical Turns are projection truth,
not live attention signals. Files changed by a retracted Turn remain real
filesystem effects and are not compensated by this renderer replacement.
The daemon Session-detail projection must therefore read effective Turns;
complete `ListSessionTurns` results remain available only to audit-oriented
queries. Terminal message-delta overlays use the same effective Turn and
client-submit identities when authoritative history makes omission meaningful.

It does not own:

- HTTP path construction
- authentication
- `EventSource` or fetch implementation details
- `tuttid` generated client usage
- workspace file access
- Electron IPC or preload APIs
- React hooks or UI components

### `@tutti-os/agent-activity-tuttid-adapter`

`agent-activity-tuttid-adapter` is the monorepo-private, narrow
platform-neutral mapping boundary between generated
`@tutti-os/client-tuttid-ts` workspace-agent DTOs and `agent-activity-core`
entities. Desktop and Mobile consume the same protocol-v2 contract assertions
and Session, Turn, Message, and Tutti-mode projections. The package also owns
the pure outbound create-Session and send-input projections into generated
tuttid request DTOs. Those projections use explicit allowlists: activity-only
prompt fields never cross the HTTP boundary, and Turn `capabilityRefs` survive
both immediate send results and later detail reconciliation.
Current-user identity is mandatory mapper input from the application host:
Desktop supplies its local AgentGUI identity and Mobile supplies the immutable
authenticated account user id.

It may depend on the generated client and `agent-activity-core`, but must not
own HTTP execution, authentication, retries, event subscriptions, logging,
i18n, Electron/React Native APIs, DI scopes, or command orchestration. Those
remain application-host responsibilities. Application hosts pass canonical
activity inputs to this package and execute the returned generated request;
for shared create/send/Turn contracts they do not maintain host-local request
mirrors, object-spread casts, or response-field allowlists. If a proposed
extraction requires a large callback surface for host concerns, keep it in the
application adapter instead.

### `@tutti-os/agent-gui`

`agent-gui` is the renamed successor of
`@tutti-os/agentactivity-renderer`.

It owns:

- `AgentGUI`
- the `AgentGUIRuntime` provider and hooks used by AgentGUI
- Agent GUI workbench node UI
- session list and detail rendering
- timeline, tool call, approval, and interactive prompt presentation
- package-owned stylesheet entrypoint
- React-facing hooks or providers that are specific to Agent GUI
- Message Center snapshot model and UI while it shares AgentGUI activity and
  interaction ownership

The published `@tutti-os/agent-gui/activity-list-projection` entrypoint is the
single high-level projection for compact Agent Activity cards. Hosts first map
transport DTOs to canonical Sessions, Presences, Messages, and Turn
file-change snapshots, then call this projection. Product hosts may enrich the
result with viewer-relative identity, avatars, board lanes, and navigation
actions; they must not rebuild status, title, summary, ordering, provider, or
artifact semantics.

Room-scoped attention consumers that need every actionable target use the
Agent GUI package's `selectWorkspaceAgentAttentionItems` projection. Unlike the
conversation-shaped Message Center model, this projection returns one entry per
canonical `(workspaceId, agentSessionId, turnId, requestId)` target, including
multiple pending interactions in one root conversation. The display item keeps
the root conversation identity for navigation, while the target keeps the exact
child interaction identity for commands. Hosts may enrich or filter these
entries for local owner/device authority, but must not rebuild prompts from
transcript rows or collapse them by root session id.

`WorkspaceAgentMessageCenterCard` keeps compact prompts and digest summaries by
default. Dense room boards may opt into its full prompt variant and suppress the
redundant digest only while a canonical prompt is present; both variants submit
through the same exact target and shared prompt surface.

It may depend on `@tutti-os/agent-activity-core`.

Agent GUI reads activity data and resolves the workspace Engine through
`AgentGUIRuntime`; lifecycle writes use semantic Engine methods or typed
intents. The runtime has no duplicate activation, submit, Goal, Interaction,
settings, Tutti Mode, or unactivation callbacks. The effective `AgentHostApi`
is limited to host
capabilities such as files, clipboard, runtime metadata, account/project
lookup, diagnostics, setup, and OS/Workbench helpers. The public
`AgentHostInputApi` no longer exposes the legacy `agentSessions` activity
lifecycle shape; production AgentGUI must not use the host capability contract
as an activity source.
Large pasted text is a separate runtime capability rather than an inference
from generic file upload. `stagePastedText` returns one provider-readable
locator: a local archive `path`, or an ordinary prepared remote-file `url`
with optional object-store identity metadata. AgentGUI keeps the local path
behavior as a read-file instruction, while a remote locator is emitted as an
ordinary prepared file so shared hosts use their existing attachment transport;
it must never be disguised as a local path. The conversation `displayPrompt`
for a remote pasted-text asset carries only its safe preview mention; short-
lived URLs and object-store locators remain in structured prompt content and
must not enter caller-visible transcript projections.
Device-global quick prompts are also an optional host capability rather than
activity data. The desktop adapter combines the developer-gated preference,
the generated `tuttid` client, and global invalidation events behind
`AgentHostApi.quickPrompts`. AgentGUI may subscribe to that capability to render
the composer picker and management dialogs, but quick-prompt entities must not
be copied into `AgentGUIRuntime`, a workspace engine, a Session, or a Turn.
The daemon remains authoritative for durable prompt records and optimistic
version conflicts; event payloads are content-free refresh hints.
Quick-prompt ordering follows the same boundary: `tuttid` stores a dense
integer `sort_order` and accepts one moved prompt plus a nullable
`beforePromptId` anchor and the moved prompt's expected version. Desktop may
project the resulting order optimistically, but it must replace that projection
with the daemon's authoritative list. AgentGUI only renders and requests moves;
hosts that omit the optional move capability keep the library read/write-only.
The v2 prompt-order schema is a forward-only daemon migration. After it is
applied, rollback means disabling the quick-prompt feature flag or reverting
the renderer surface; do not run an older daemon writer against that database.
Older writers do not maintain `sort_order`, so binary daemon downgrade followed
by create/delete is not a supported recovery path.
Conversation rail sections are also an `AgentGUIRuntime` contract:
AgentGUI calls `listSessionSections` for the first page of every returned rail
section and `listSessionSectionPage` for Show more by `sectionKey` and cursor.
Hosts must pass those calls through to the daemon section endpoints so project
sections come from current user projects and session membership comes from
persisted `rail_section_key`, not frontend cwd grouping or project-root
filters.
Hosts whose first-page section endpoint accepts less than AgentGUI's default
refresh limit declare the positive backend maximum through
`conversationRailQueryLimits.sectionRefreshLimitMax`; AgentGUI clamps adaptive
same-scope and scope-switch refreshes before calling `listSessionSections`.
The published `@tutti-os/agent-gui/conversation-rail-runtime` entrypoint owns
the host-neutral Rail query/mutation cohort. Its stable host surface is the
typed `createAgentConversationRailRuntime` factory plus the runtime/source
types; method-name manifests and UI capability inspection are package-internal.
Downstream hosts such as tsh compose the typed factory and do not import those
test or presentation helpers. The sibling
`@tutti-os/agent-gui/conversation-rail-controller` entrypoint owns the
controller interface, workspace-Engine-scoped query caches, and
`createAgentGUIConversationRailQueryController` factory. Product hosts provide
the canonical Rail queries and construct the controller with their workspace
Engine through that factory; they must not instantiate the package-internal
implementation or copy query scope, first-page refresh, cursor pagination,
stale-request fencing, membership reconciliation, Engine ingestion, forwarding
methods, or cache lifetime into app or renderer composition code.
Transport adapters still own HTTP/IPC DTO mapping, authorization, and protocol
errors. In particular, `listSessionSectionDeletionCandidates` and
`deleteSessionsBatch` are one atomic batch-deletion capability. AgentGUI disables
the action and reports
`agent.gui.conversation_batch_delete.capability_incomplete` when a host exposes
only one half, instead of accepting a click that cannot complete.
Desktop and Native Mobile use the same headless Rail controller. Generated
Session DTOs from first-page and pagination responses are transient adapter
input and are immediately upserted into the workspace Engine; they are never
retained in a second host Rail entity store. Hosts retain only transport
mapping, runtime-availability policy, surface lifecycle, presentation, and
host-specific refresh cadence such as Mobile disconnected polling.
The pure Rail contracts are the canonical source for both the controller and
the `AgentGUIRuntime` Rail aliases. The public
controller snapshot exposes memberships, ordered ids, pagination, search, and
request state only; Desktop joins it with Engine state for localized
conversation summaries outside the headless entrypoint. Resolved cache entries
are shared by controllers created for the same workspace Engine; the factory,
not `AgentGUIRuntime` or a host adapter, owns that registry. The cache
implementation has no published AgentGUI subpath. In-flight first-page entity
payloads stay scoped to one attached controller generation so an obsolete mount
cannot ingest or cache them.
Every daemon `WorkspaceAgentSession` response carries the persisted membership
as required `railSectionKey`. The desktop adapter rejects a missing or blank
value as a protocol contract error; it must not manufacture `conversations` or
derive a project key from `cwd`.
Agent-generated-file search follows the same membership contract. The daemon
reads a bounded window of recently settled `Turn.fileChanges` snapshots,
joins them to non-deleted sessions by exact required `sectionKey`, and combines
file state in Go. The desktop provider passes the active conversation's
`railSectionKey`, the selected project's persisted `sectionKey`, or the fixed
`conversations` key. It fails closed when that identity is unavailable.
Neither the daemon nor the renderer maintains a generated-file projection or
scans activity messages as a fallback, and pre-contract history is not
backfilled from messages.
The session service synchronously persists and reads back the initial runtime
session before returning a successful Create response, so the response never
races the runtime's asynchronous activity reporter. The store assigns
`railSectionKey` on that first persistence and preserves it across later runtime
reports, `cwd` changes, and user-project list refreshes. Removing a project is
an authoritative daemon operation. It repeatedly sends live unpinned root
Sessions through Host batch deletion, then uses one compare-and-finalize SQLite
transaction to rehome retained pinned trees and recoverable tombstones to
`conversations` and remove the user-project row. A concurrent initial Session
write validates an explicit project placement against the project rows in its
own transaction, so a stale placement cannot recreate an orphan section after
removal.
Section and pinned-page results include required `totalCount` for the complete
target-filtered scope before cursor pagination. AgentGUI uses it to subtract a
transient active-row overlay from remaining unseen rows; hosts must preserve the
field end to end instead of recomputing it from the bounded `sessions` array.
The `listSessionSections` bootstrap also carries the first pinned session page,
and pinned Show more uses the dedicated pinned page endpoint/runtime method.
Pinned is not a section kind; it is a session/rail-record projection derived
from `pinnedAtUnixMs` so pinned conversations can render on first load even
when they are older than the first ordinary project or Chats page.
When AgentGUI's provider rail is narrowed to one target, the runtime request
must include `agentTargetId`; hosts and the daemon apply it before section
pagination so `hasMore` describes the target-filtered rail, not the unfiltered
workspace history.
Conversation search uses the optional `listSessionsPage` runtime query backed
by `GET /v1/workspaces/{workspaceID}/agent-sessions`. The daemon applies
`searchQuery` and `agentTargetId` to the complete visible workspace session set
before cursor pagination; this is not a filter over already-loaded section
pages. Search pages follow the same normalized ownership rule as section pages:
returned sessions are upserted into the workspace engine, while the search
query retains only ordered ids, cursor, and request state. The UI joins those
ids to canonical engine entities. Search rows are placed by exact equality
between the session's `railSectionKey` and a daemon-returned section key;
`pinnedAtUnixMs` remains the independent pinned projection. Missing keys are
invalid desktop protocol data, not a signal to infer membership from cwd or a
resolved project. Hosts without this optional query may keep a
loaded-row-only local title filter for previews, but desktop hosts must pass the
backend query and pagination fields through unchanged.
The canonical SQLite repository owns the shared root-session query semantics
for conversation search, target filtering, visibility, stable ordering, and
cursor pagination. A composing host may pass an explicit authorized Session-id
set into that repository query; the repository applies it before pagination,
section totals, and batch-deletion candidate selection. Service and host
adapters may hydrate or authorize the returned entities, but must not copy the
filter/sort/page algorithm into transport-specific code.
Activating a conversation must not by itself call `listSessionSections` again.
Likewise, active detail provider changes should not reload section first pages.
Page sessions must be upserted into the workspace engine, while the rail query
cache retains only ordered session ids, cursors, totals, and section metadata.
The shared conversation-Rail controller factory keeps resolved cache entries
per workspace `AgentSessionEngine`, rather than exposing cache ownership through
a host runtime or mounted controller. Fresh first pages are reused for 30
seconds across controller remounts and repeated target switches. In-flight
request coalescing remains controller-local; the factory shares only resolved
entries across controllers. The cache never owns session entities, titles,
lifecycle, or interaction state.
Rename, pin, delete, and through-Turn Fork are Engine mutations, not direct
runtime calls from AgentGUI. Rename, pin, and delete enter through semantic
Engine operations rather than reducer-protocol assembly in a product host.
The engine records the pending mutation, emits one semantic command, and feeds
the command result back through its reducer loop. Successful rename and pin
Session results plus validated delete tombstones enter canonical state as
follow-up intents in the same engine drain. The product activity facade awaits
the semantic rename, pin, and delete methods and never allocates mutation
identity, chooses timeout policy, or reads mutation records. The command port is
the only transport executor. Settled mutation records use a bounded window;
they are workflow evidence, not an unbounded history store.
Goal Control follows the same single-core rule without becoming a Session
metadata mutation: `goalControl.operationsBySessionId` retains only the latest
frontend operation for each Session. A validated typed response applies its
Session through the canonical lifecycle reducer and retains Goal operation
identity/state as settlement evidence. Canonical Session Goal equality is only
presentation data and never confirms a pending or unknown operation. Durable
Goal revision, provider application, recovery, audit, and idempotency remain
owned by `packages/agent/host`. The package root exposes a narrow settlement
projection rather than the internal operation ledger, and `getSnapshot()` does
not carry that ledger at runtime.
Fork is long-lived: an HTTP `202 accepted` keeps the mutation in flight until
the canonical target Session with matching durable lineage is upserted. The
Engine disables only another Fork for that exact source Turn. Source activity,
pending Interactions, and an observation ACK for an already committed child do
not become Fork availability gates.
The Desktop activity adapter reconciles an accepted operation through the
durable operation GET endpoint with capped backoff. It never redispatches the
provider mutation. A committed result enters the Engine as the canonical child;
failed or delivery-unknown results terminate the mutation so the action can
report failure and be retried with the correct identity.
When one of those canonical commits changes page membership, the rail query
controller reloads only the affected first pages. Its public snapshot contains
daemon membership and query publication state, not derived Engine
conversations. The controller keeps committed membership visible while draft
page requests are pending, then publishes the resolved membership once. The
Desktop adapter independently subscribes to the Engine and joins that canonical
state with the headless snapshot to derive localized conversations; it does not
own a second Session or Rail query cache. The controller does not inspect Engine
mutation records. A failed targeted read leaves committed membership visible
and locks membership-sensitive actions until an authoritative scoped refresh
succeeds.
Attach compares current canonical membership with the last observed membership
and invalidates interrupted draft work before bootstrap, so changes completed
while every panel is closed are revalidated without mutation-history coupling.
Section first-page reloads should be tied to workspace, rail filter, user
project, or session membership changes.
Historical rows already owned by loaded section pages can be absent from a
later bounded list response. Snapshot omission is not deletion: the engine
keeps those entities until an explicit removal event. Hydrating or updating one
is an entity-detail change, not a rail membership change; loaded pages and
cursors must remain intact. Do not use raw engine session order or count as the
section query invalidation key.

`AgentActivity*` types are the canonical frontend agent activity data model.
Agent GUI must import `AgentActivitySession`, `AgentActivitySnapshot`, and
`AgentActivityPresence` from `agent-activity-core`; it must not recreate those
entities in a handwritten aggregate. GUI-only projections stay in focused
timeline, synchronization, summary, and message-overlay modules. Working and
completion decisions derive from canonical `activeTurn` and `latestTurn`
state, not from legacy session-level lifecycle mirrors.
Canonical sessions also carry typed `settings`, `permissionConfig`,
`capabilities`, `usage`, `goal`, `imported`, and root/parent relationship fields
from the daemon. Desktop adapters preserve those fields and must not recreate
them from `runtimeContext`, `lastError`, or module-global per-session defaults.
Provider-native child work is represented only by child sessions and their
turns; there is no parallel session metadata summary for it.
Create/send intents carry the provider `planMode` setting independently from a
Tutti-owned activation intent. `/plan` controls the boolean provider setting;
`/tutti` creates or advances a durable `TuttiModeActivation`. Pending draft
intent, creation, revision-checked updates, daemon projection, and canonical
Turn snapshots preserve both values without treating them as a mutually
exclusive mode enum. Historical `capabilityRefs` remain audit data and are
trimmed and deduplicated by source plus capability, but they do not own the
activation. Every submit route, including immediate sends, active-turn
guidance, queued delivery, and provider Plan feedback, preserves that audit
metadata when Tutti is active.

Pending submit records preserve business provenance separately from their
opaque `clientSubmitId`. Provider Plan feedback uses the typed
`plan-feedback` source with its exact Turn and request identities, and
host-agnostic consumers locate it through the activity-core selector rather
than parsing an ID prefix. AgentGUI-generated Prompt identities are UUID v4 so
hosts may safely reuse them at a stricter shared-execution boundary; Activity
Core itself keeps accepting opaque caller-owned identities.

A create timeout does not negate the optimistic Tutti activation: the draft
and badge remain pending until a canonical active revision arrives or the
operation reaches a definitive failure/confirmation expiry. Revision-checked
updates own their follow-up reconcile command. Unrelated hydration cannot clear
an uncertain update unless a newer revision with the requested status is
semantic proof; a failed or inconclusive owned reconcile becomes a retryable
failed update instead of permanently blocking the composer.

Capability references describe historical submission provenance; they are not
current activation and are not a workflow state machine. AgentSessionEngine
normalizes the independent `TuttiModeActivation` read projection separately
from Session entities, and uses an engine-owned pending draft intent before a
Session exists. Tutti Mode Plan state is created only by an Agent CLI invocation
and lives in daemon-owned workspace workflow entities. Renderer code must not
infer provider Plan intent, Tutti activation, or a Tutti workflow from the
latest Turn, transcript ordering, arbitrary assistant text, or compatibility
markers. The schema-first event definitions remain the authority for realtime
updates; OpenAPI-generated HTTP DTOs stay confined to API projections.

Runtime acceptance is not itself a durable submit receipt. The API, Agent
service, and runtime adapter carry `ClientSubmitID` through typed inputs; submit
claims and durability decisions never recover it from diagnostics metadata.
After `Exec` reports acceptance, the Agent service calls the required
`RuntimeController.DurablyReportSubmitProvenance` method before accepting the
Tutti snapshot or submit claim. The runtime reporter FIFO first persists the
ordinary submitted Turn, then executes that uncoalesced barrier. The barrier
atomically writes the enriched Session projection and a stable
`client-submit:user:<clientSubmitId>` user message that references the exact
canonical Turn; it requires the Turn to exist and never replays or regresses
its lifecycle. The service accepts a submit claim only after
`FindTurnByClientSubmitID` reads that same Turn back. Runtime hosts must provide
the required `DurableActivityReporter`; plain `ActivityReporter` compatibility
adapters do not satisfy this contract because state and message writes may be
separate transactions. Reporter decorators preserve the required interface by
construction instead of probing and forwarding an optional capability.

Source-session deletion is coordinated by the Tutti Mode Plan service, not by
the workspace data store. `DeleteSession`, `DeleteSessionsBatch`, and
`ClearSessions` delegate to that use-case boundary in production. The service
chooses which workflow, checkpoint, and operation states are cancellable and
supplies the actor, reason, target states, and transition time. The workspace
store only executes that explicit command, atomically removing the Agent
Session closure and Tutti activation/Turn snapshots while applying the
authorized workflow transitions. A persistence-only deletion must never infer
or repeat the policy.

The transaction result reports every removed Session and each affected
workflow/checkpoint identity. After commit, the Tutti Mode Plan service emits
the canonical workflow invalidations and the Agent service emits one
`session_deleted` invalidation per reported Session. The activity projection
does not perform a second deletion on that path. Persistence-only deleters and
standalone activation cleanup remain test/legacy-orphan fallbacks only; normal
daemon composition wires the coordinator so retries cannot split ownership or
publish duplicate deletion events.

Before a session exists, composer options carry the same typed capability
descriptor. The active session descriptor takes precedence once available.
Model composer options keep the selected value and provider-resolved value as
separate facts. An inherited `default` remains the selected value used for
future mutations; `effectiveModel` is presentation-only runtime evidence for
describing what Default currently resolves to. Activity adapters and AgentGUI
must not replace the selection with that resolved value or infer it from the
catalog's Default entry.
An omitted pre-session descriptor means the connected daemon predates the
typed composer capability contract and must remain an unknown/loading state.
Core capability booleans must not be reconstructed from private
`runtimeContext` fields or represented as plugin/tool entries in the composer
capability catalog.
The activity snapshot also exposes the composer-options request lifecycle per
opaque target key. Consumers use `loading` only for the initial request when no
cached options exist; background refreshes keep rendering the last successful
catalog, and failures transition to `error` instead of leaving indefinite
loading UI. Desktop and Mobile request options through the semantic
`AgentSessionEngine.loadComposerOptions` method. It owns request identity,
signature-aware cache reuse, identical in-flight joining, supersession, exact
settlement, caller abort, and engine disposal. The host extension adapter owns
only the transport call and DTO mapping; hosts must not reconstruct this
protocol with raw `composerOptions/loadRequested` dispatch plus snapshot
subscriptions.
Provider context-window and quota updates enter the daemon at the runtime
adapter boundary, are split into typed durable session metadata, and reach
Agent GUI through the protocol-v2 `usage` field. GUI projections must not read
provider-private runtime context to render usage. Existing
session control state is read from the daemon; pre-session edits remain in the
engine-owned activation/draft record until the daemon confirms the session.
`AgentHostWorkspaceAgent*` types may only appear in compatibility or projection
layers while the legacy Agent GUI internals are being migrated. Production read
paths must not call `workspaceAgents.list`,
`workspaceAgents.listSessionMessages`, `agentSessions.retainEventStream`, or
`agentSessions.subscribeEvents` directly. Production write paths must not call
`agentSessions.exec`, `agentSessions.cancel`,
`agentSessions.submitInteractive`, or `agentSessions.pinSession`; lifecycle
writes use the workspace `AgentSessionEngine`, while metadata actions still
exposed to AgentGUI use `AgentGUIRuntime`. Legacy host DTOs are allowlisted only in the
host API contract, explicit projection helpers, and message merge/page-loading
helpers that accept runtime-shaped adapters.

The desktop activity diagnostics module is the only narrow consumer allowed to
serialize legacy lifecycle fields while comparing old host events with the
canonical model. Those values are diagnostic evidence only and must never feed
session, turn, submit, or rendering decisions.

Slash command behavior is descriptor-authoritative. The provider catalog's
typed slash policy owns fallback commands and command effects; a missing policy
produces no provider slash commands or local command effects. Agent GUI must not
infer Cursor, Codex, Claude, or universal command behavior from provider names.

Runtime `provider` is open execution metadata. Agent GUI and Workbench must
preserve an unknown valid provider string and use `agentTargetId` for selection,
launch, grouping, and persisted composer state. They must not coerce an
extension provider to Codex. Verified Agent Extension presentation assets come
from the Agent Target contract; renderer packages do not add extension-specific
icon catalogs or provider branches.

The synthesized `plan-implementation` / `implement` decision crosses the
desktop boundary as one semantic, turn-and-request-scoped daemon command with
a caller-stable idempotency key. Desktop transport must not expand that command
into local settings or send operations. `tuttid` prepares a leased
`plan_decision` operation, checkpoints the idempotent plan-mode target write,
persists `send_dispatched` before provider execution, and confirms the result
only from a different durable turn/message carrying the operation's stable
`clientSubmitId`; an unknown send result is never blindly replayed. Completion
and its outbox event commit atomically. The `send_dispatched` checkpoint also
persists a session-level `agent_system_notice` with notice kind
`plan_implementation_pending_confirmation` and its message-update outbox event
in the same transaction, so an open client can observe the unknown window even
if the provider call hangs or the process exits. Completion upgrades the same
message to `plan_implementation_completed`, and its outbox publishes both the
confirmed turn and notice update. These payloads contain semantic IDs only;
user-visible copy belongs to consumer i18n. Provider-originated exit-plan
prompts remain ordinary durable interaction responses and use the existing
`interactive_response` operation rather than this synthetic-plan endpoint.
Until the user confirms or dismisses the plan, AgentGUI projects that wait
through one shared awaiting predicate into conversation-rail
`needsUserAction`, conversation-list awaiting sets, and Message Center
attention; it must not invent an active-session-only overlay for the same fact.

Provider interaction lifecycle is an explicit entity stream, independent of
transcript projection and runtime session snapshots:

```text
provider request
  -> interaction.requested
  -> runtime state report InteractionTransition(pending)
  -> durable Interaction(pending)
  -> interaction_update
  -> AgentSessionEngine selectors
```

`call.started` / `call.completed` / `call.failed` continue to own historical
tool-call messages, but they never create or restore an actionable Interaction.
When acknowledging an interactive response can make the provider immediately
settle its Turn, the adapter must serialize that acknowledgement and the
matching call-resolution event with Turn finalization. The terminal Turn event
must not overtake `call.completed` or `call.failed` and close the event stream
before the historical call row resolves.
Likewise, a runtime session snapshot may describe provider-local execution
state but must not enrich a report with an Interaction transition. Runtime
reports may submit only `pending` and `superseded`; `answered` belongs solely to
the durable `interactive_response` operation. Preparing that operation
atomically claims the interaction with a `pending` to `answered` transition and
stores the requested action, option, and payload. Completion still records the
typed runtime disposition (`pending`, `resolving`, `answered`, `superseded`, or
`interrupted`) and commits the completed operation and outbox event. Competing
responders compare against the claimed output and normalize to `answered` or
`superseded`; absence from an in-memory request map is not evidence of success.
The claim's provisional Interaction status must not overwrite the terminal
runtime disposition: the completed operation result follows the runtime even
when the claim already moved the Interaction to `answered`.

Activity compatibility projection uses a causal, segmented write barrier. It
scans state patches in provider order. Non-terminal state first creates the
session, Turn, and Interaction required by message foreign keys; immediately
before each terminal patch, it flushes that Turn's messages and the session
audits, then commits the terminal state. Later non-terminal patches are never
moved ahead of an earlier settlement. A completed root-provider transition is
also terminal because, when no child remains active, SQLite uses it to settle
the canonical root Turn. During the first SQLite settlement transaction, the
store selects the latest already persisted assistant text message for that Turn
and freezes its ID in the existing completed-command payload. A same-report
anchor is only a validated fast path; cross-report provider event batches
derive the same watermark from durable messages. The payload also records an
explicit resolution marker when settlement found no assistant text, so a late
message cannot become the result of an already settled Turn. Result readers use
the exact frozen message, return no message for a resolved-empty watermark, and
reserve the bounded fallback scan for legacy turns without resolution metadata.

Root-provider settlement notifications are a separate compatibility path
because provider adapters do not emit the legacy terminal Turn state patch.
Production composition must register every session-state observer through
`ConfigureSessionStateObservers` and explicitly choose whether it observes
canonical root-Turn settlements. An omitted choice is a configuration error.
Settlement delivery is at-least-once, so opted-in consumers must use the exact
canonical Turn ID for durable deduplication or otherwise serialize an
idempotent terminal transition. Choosing to ignore settlements requires an
explicit lifecycle ruling for that consumer.

Cancellation of the caller waiting on an interactive-response operation is not
a provider outcome and must not terminalize the runtime request. Before a
response is dispatched it remains `pending` for durable retry; after dispatch it
remains `resolving` until the provider response transport reports success,
failure, or an explicit provider-side interruption.

Runtime request identity is the full
`(workspace/session, turnId, requestId)` tuple. The turn ID must cross the
coordinator, runtime controller, provider adapter, live request registry, and
disposition lookup; a request ID alone is never sufficient because providers
may reuse it in a later turn. Live registries contain only `pending` and
`resolving` requests. The first terminal disposition is copied to a bounded
tombstone registry before the live request or provider session is removed, so a
durable retry can still distinguish `answered`, `superseded`, and `interrupted`
from `unknown`. Provider command transports that expose an acknowledgment (for
example a sidecar `ok`/`error` response) must consume it before reporting
success; writing bytes to the transport is not acceptance. A missing
acknowledgment is not an explicit provider rejection: Claude SDK interactive
submissions remain `resolving` while the daemon queries the sidecar's bounded,
idempotent disposition registry by `(turnId, requestId)`. Only an authoritative
`answered` or `superseded` result may terminalize the request; an identical
answered replay is accepted without resolving the provider promise twice, and
a changed replay is a conflict. A disposition-query error remains `resolving`,
while an authoritative `pending` result releases the claim back to `pending` so
the durable operation can retry. Once the provider session itself is confirmed
dead, both pending and resolving requests become `superseded` because they are
no longer actionable; preserving an exact applied result across process death
would require a persistent provider-side journal rather than an in-memory
tombstone. Provider session cleanup first detaches the exact adapter-session
object under the registry lock and only then terminalizes its pending requests
outside the lock, so a stale reader or close path cannot delete a concurrently
installed replacement session. Resume rollback restores a previous session
only when no replacement is current and the previous session has not been
marked failed or closed.

Interaction persistence returns `applied`, `already_applied`, or `conflict`.
Exact replays and late transitions after the first terminal state are
`already_applied`; a changed immutable identity (`kind`, `toolName`, `input`, or
`metadata`) is a hard `conflict` for the whole state report. A terminal state
never transitions back to `pending`. A settled owning Turn cannot acquire a new
pending Interaction: persistence treats that late provider report as an
idempotent stale transition and stores no actionable row. Terminal reports may
still be recorded for replay and reconciliation evidence.

Protocol-v2 session responses expose `activeTurnId` (required and nullable),
`pendingInteractions` (required and never null), independent `activeTurn` /
`latestTurn` projections, typed capabilities/usage/goal/import and child-session
fields, and Unix-millisecond timestamps. They do not expose legacy session
status, turn lifecycle, submit availability, last error, ISO timestamps, or
the raw runtime context. SQLite migrations split typed session metadata from
provider-private recovery context, remove the legacy status/current-phase/
last-error/runtime-context columns, and enforce nullable exact
`active_turn_id` ownership plus Turn/Interaction/message foreign keys. Public
activity events are version 2: full Turn and Interaction entities use
`turn_update`/`interaction_update`; a session invalidation that requires an
authoritative read is explicitly named `session_reconcile_required` and must
never be applied as a partial Session entity. The old public `state_patch` and
storage message row id are removed.

Message `turnId` is explicitly nullable. Runtime execution messages use the
exact durable Turn id. An external transcript importer may reconstruct stable
historical Turn ids only from trustworthy provider evidence: each retained real
user message starts one Turn and the following assistant/tool messages keep
that identity until the next retained user message. Persistence creates those
Turns as settled backfills in the same transaction as their messages. A
forward-only store migration repairs legacy imported turnless rows from the
same retained-user boundary; re-import applies the same stable identity.
Content before the first trustworthy boundary stays session-scoped
(`turnId = null`). AgentGUI never reconstructs canonical Turn ownership from
the currently loaded page, and import must not manufacture one Turn per
transcript message.

It should not know how a host connects to `tuttid`, subscribes to the
business-event WebSocket, resolves workspace paths, or talks to Electron.

### `apps/desktop`

The desktop app owns the concrete adapter from `tuttid` and Electron runtime
capabilities into `agent-activity-core`.

It owns:

- `tuttid` client calls
- business-event WebSocket connection implementation
- backend base URL and authentication details
- preload/runtime/file adapters
- `IWorkspaceAgentActivityService` and the desktop `AgentGUIRuntime` wrapper
- workspace chrome placement
- workbench contribution wiring
- desktop i18n overrides

`WorkspaceAgentActivityService` is the desktop renderer source for workspace
agent activity snapshots. Desktop chrome MessageCenter and AgentGUI workbench
nodes must subscribe to the same service instance for the same workspace.

## Core Engine And Adapter Shape

The host creates one engine for each workspace and runtime origin and supplies
its external command port. The adapter remains a transport boundary owned by
the host; it is not another state owner:

```ts
createAgentSessionEngine({
  identity: { workspaceId, origin },
  clock,
  scheduler,
  commandPort
});
```

`plan/submitDecision` uses the dedicated
`EngineTypedCommandPort.executePlanDecision` method. Its public
`PlanSubmitDecisionResult` contains the durable operation identity returned by
the Host. It must not pass through the generic `execute(): Promise<unknown>`
path or manufacture an operation id from a command id.

Durable daemon message pages and `message_update` payloads use
`AgentActivityDurableMessage`, whose immutable `sequence` is required. Local
optimistic and session-audit projections may use the separate transient
message shape; this must not weaken the durable page or realtime contract.
The generated daemon Session DTO also requires `messageVersion`. The shared
`@tutti-os/agent-activity-tuttid-adapter` validates and preserves that high-water
cursor for Desktop and Mobile; consumers must not replace a missing value with
zero or add an old-daemon fallback because both binaries upgrade together.
Every HTTP field in this cursor domain (`messageVersion`, message `version`,
page `latestVersion`, and `afterVersion`/`beforeVersion`) is bounded by
JavaScript's maximum safe integer. Durable message `sequence` has the same
transport bound. Store and service layers retain `uint64`; the daemon API owns
checked conversion and must fail response projection instead of emitting an
inexact JSON number.

The adapter exposes the HTTP operations used by that command port and by the
desktop reconcile bridge:

```ts
export interface AgentActivityAdapter {
  listSessions(input: {
    workspaceId: string;
    signal?: AbortSignal;
  }): Promise<AgentActivitySessionList>;

  listSessionMessages(input: {
    workspaceId: string;
    agentSessionId: string;
    afterVersion?: number;
    beforeVersion?: number;
    limit?: number;
    order?: AgentActivityMessageOrder;
    signal?: AbortSignal;
  }): Promise<AgentActivityMessagePage>;

  loadComposerOptions(
    input: AgentActivityLoadComposerOptionsInput
  ): Promise<AgentActivityComposerOptions>;

  createSession(
    input: AgentActivityCreateSessionInput
  ): Promise<AgentActivitySession>;
  sendInput(
    input: AgentActivitySendInput
  ): Promise<AgentActivitySendInputResult>;
  goalControl(
    input: AgentActivityGoalControlInput
  ): Promise<AgentActivityGoalControlResult>;
  submitInteractive(
    input: AgentActivitySubmitInteractiveInput
  ): Promise<AgentActivitySubmitInteractiveResult>;
  deleteSession(
    input: AgentActivityDeleteSessionInput
  ): Promise<AgentActivityDeleteSessionResult>;
  deleteSessions(
    input: AgentActivityDeleteSessionsInput
  ): Promise<AgentActivityDeleteSessionsResult>;
  renameSession(
    input: AgentActivityRenameSessionInput
  ): Promise<AgentActivitySession>;
  setSessionPinned(
    input: AgentActivitySetSessionPinnedInput
  ): Promise<AgentActivitySession>;
}
```

`AgentActivitySendInputResult` contains the authoritative canonical `turn` in
addition to its session and turn id. Desktop adapters must reject a successful
transport response that omits that turn; they must not reconstruct it from the
deprecated session-level lifecycle or submit-availability fields.

`AgentActivitySendInput.targetTurnId` is the exact canonical active Turn target
for guidance. AgentGUI captures it from the active Turn at the interaction
boundary; Activity Core preserves it through queued intents (and captures the
current active id when promoting an existing queued prompt to send-now) and
emits it only on the guidance request. The Tutti adapter maps it to the daemon's
`turnId`; ordinary new-Turn submits clear it. The daemon service, Host, and
runtime Controller fail closed when guidance has no target or when the target
is no longer active. That rejection is known `NotDispatched` provider
delivery, so no provider call occurs and any prepared submit claim is cleaned
up. A caller must not recover a target by reading a newer Session snapshot.

`AgentSessionActivateEffectInput` requires `agentTargetId` for
`mode: "new"`. Shared UI passes it through unchanged; trusted host or daemon code
resolves it against `agent_targets`, validates enabled state and launch ref
shape, and derives the execution `provider` and runtime `providerTargetRef`
from the resolved target. Target-backed create requests may omit `provider`; if
both fields are present, the daemon rejects provider mismatches. Client-provided
`providerTargetRef` is not allowed to override the daemon-derived runtime ref
when `agentTargetId` is present. The resulting
`AgentActivitySession` and session events should preserve `agentTargetId` when
present. State patch reducers must update the session when an event includes
`agentTargetId`, but a patch that omits the field must not clear an existing
target id because older runtimes and historical imports are provider-only.

Composer options use one cache key space: the resolved `agentTargetId` is passed
to activity-core as an opaque `targetKey`, round-tripped verbatim, and forwarded
to the daemon as `agentTargetId`. Activity-core must not parse or rewrite the
key. There is no provider-keyed fallback cache: two targets under the same
provider remain isolated. Provider-based invalidation filters on the provider
recorded for the active or most recent request rather than deriving provider
identity from the key or from possibly stale cached options. Invalidation
clears cache validity but must not detach an in-flight command from its caller:
that caller still receives a terminal result, and the next request performs a
fresh load.
While a live session refreshes its catalog, UI may continue presenting an
already loaded target snapshot, but a genuinely missing target snapshot remains
loading until target-scoped options arrive.

Each composer-options snapshot also carries its effective pre-session settings;
AgentGUI resolves displayed settings field by field in this order:
authoritative session settings, optimistic first-create settings, preloaded
effective settings, then home defaults. A partial session projection must not
erase a usable preloaded model or reasoning selection while live metadata is
still arriving. Because the effective settings are request-dependent,
composer-options cache freshness and in-flight reuse include normalized `cwd`
and normalized requested settings in addition to the target key.
Ordinary home-target and project switches use that signature-aware cache and
must not force a second transport request from the click handler. Forced loads
are reserved for explicit catalog invalidation, activation/creation settlement,
provider-declared draft-session prewarming, or a validated settings result whose
current target options declare `refreshModelOptionsAfterSettings`. The Engine
uses the authoritative returned Session to issue that target-scoped refresh;
Desktop and Mobile adapters must not upsert the Session or choose reload policy
themselves. Options refresh is independent of the current prompt continuation
and never blocks its send.

Composer-options loading may be suppressed while a new-session activation is
pending, but that guard follows the current engine state rather than a
mount-time snapshot. The transition from creating to settled must trigger a
fresh target-scoped load so model, reasoning, skill, and slash-command metadata
cannot remain absent for the lifetime of the node. Before the first
target-scoped composer-options snapshot arrives, configurable-setting support is
unknown rather than unsupported: the composer footer renders disabled loading
controls for permission and model/reasoning selection, then replaces or removes
them according to the authoritative snapshot. Slash command fallback and effect
policy remain provider-descriptor-owned; every supported provider that exposes
local fallback commands declares them in its registry descriptor.

`AgentActivityCreateSessionInput.providerTargetRef` is an optional opaque
host-owned legacy reference for selecting which target under the real provider
should launch the session. It is not authority, a credential, or an invocation
plan. New runtime launches must provide `agentTargetId`; `providerTargetRef`
must not be used as a provider-only launch fallback. Target-backed launches use
the daemon-derived ref shape from `agent_targets` instead. Adapters and trusted
launchers must re-authenticate and resolve it before using any concrete provider
invocation. UI packages must keep `provider` as the real provider identity and
must not synthesize providers for shared or remote targets.

The desktop service owns one business-event WebSocket at `/v1/events/ws`.
Canonical `message_update` snapshots remain the hydration, terminal
confirmation, and cloud-reconcile contract. During normalized provider
text/reasoning streaming, and for provider events that explicitly carry
ordered appendable tool output, the same `agent.activity.updated` topic carries
schema-backed `message_delta` events produced by the provider normalizer; the
transport must never derive deltas by comparing snapshots. The runtime
publishes each delta to the business-event bridge before its per-Session
runtime fan-out and before enqueueing the durable report, so a later committed
terminal confirmation cannot overtake the optimistic prefix. The post-commit
projection suppresses only a redundant nonterminal text/reasoning snapshot or
running tool-output snapshot already represented by that delta. Tool anchors,
structured tool mutations, audit, imported, unprojected, and terminal updates
retain their existing canonical publication semantics. Every `message_delta`
is scoped to a real persisted Turn; session-level notices continue to use
explicit audit or state semantics.

Provider normalizers must retain enough per-message state to preserve semantic
operations. The first cumulative text/reasoning snapshot uses `set`; a later
snapshot with the previous value as an exact prefix uses `append_text` with only
the suffix. Duplicate snapshots are dropped, while a rewrite or backtrack that
cannot prove the prefix relation uses `set`. Transport and renderer layers must
not rediscover this relationship by diffing full snapshots.

Tool output uses a separate `toolOutput` operation that mutates only the
provider-neutral `payload.output.text` display projection. A provider adapter
may emit it only from an explicit ordered output-delta event, or from a
cumulative textual output snapshot whose exact prefix relationship the adapter
has verified. It must not classify by tool name or inspect arbitrary structured
tool results. Every output operation uses the exact `messageId` of the
canonical tool-call anchor; provider-normalizer event ids are internal
lifecycle identities and must not create a second optimistic row. The first
output uses `set`; later `append_text` operations carry the prior UTF-8 byte
length as `offsetBytes`. A missing anchor or offset mismatch triggers canonical
reconciliation instead of guessed concatenation. When an explicit provider
output notification races immediately ahead of its `item/started`, the
provider normalizer may retain that prefix in a bounded pre-anchor buffer, but
it must emit nothing until the real anchor arrives; it then publishes the
anchor first and the retained prefix as `set`. Output beyond the canonical
1 MiB field budget becomes a valid UTF-8 prefix plus `[Output truncated]`; the
live projection expresses that bounded snapshot as one `set` followed by
contiguous `append_text` operations that fit the transport envelope. An
unmatched prefix, or one rejected by the aggregate pre-anchor call or byte
budget, is dropped with diagnostics rather than inventing a tool row.
Completed, failed, canceled, and rewritten tool results remain authoritative,
bounded canonical `message_update` snapshots.

Durable tool snapshots contain the business projection, not a provider-result
archive. Before `workspace_agent_messages.payload_json` is written, the
canonical projection promotes readable text to `output.text` or `error.text`,
tool references to `output.matches`, generated-image paths to
`output.savedPath`/`output.savedPaths`, and file mutations to `fileChanges`.
Provider envelopes and duplicate representations such as top-level `content`,
`output.content`, `rawInput`/`rawOutput`, Claude `toolResponse`, adapter
metadata, image base64, and unknown provider-only result keys are not retained.
Provider adapters may continue accepting those wire shapes, but shared
business code consumes only the explicit canonical fields. Each canonical
`output` or `error` `text`, `stdout`, and `stderr` field, including nested tool
steps, first receives a 1 MiB per-field bound by retaining a valid UTF-8 prefix
and the fixed `[Output truncated]` marker. Durable tool-call payloads then fit
those formal output streams into a 768 KiB aggregate JSON budget, leaving
deterministic headroom below the 1 MiB replication request limit for mutation
identity, scope, and batch framing. Inputs and structured results are never
discarded merely to satisfy that output budget.

A terminal command snapshot omits `text` only when it is exactly
reconstructible as `strings.TrimSpace(stdout)` or
`strings.TrimSpace(stderr)`; the raw stream remains canonical. The Reporter
recognizes that alias before per-field truncation and emits a tombstone so a
terminal snapshot also clears any `text` retained from its running snapshot.
Nested steps use their own lifecycle status, even beneath a running parent.
Explicit non-command tool identity wins over command-shaped input, so MCP and
other non-command tools retain `text` as their provider-neutral display
contract. Running command output retains `text` for ordered live deltas. Agent
reference/session output uses the same canonical projection rather than
depending on a retained raw tool result.

Canonical compaction is normally a forward-write rule. One bounded migration
also repairs retained terminal command rows, including deleted/tombstoned rows
that remain replication inputs, whose payload reaches the 768 KiB safe budget.
It removes only reconstructible aliases and refits formal output streams without
changing message versions or timestamps. Rows whose structured data cannot fit
without semantic loss remain unchanged for explicit handling.

The Go live-protocol adapter owns the complete fast-lane envelope on both sides
of a device link: schema validation, recipient identity projection,
protobuf-wire framing, batching, replay/resume, sequence-gap detection, and
typed rejection. Recipient projection rewrites only the closed workspace,
Session, and Turn identity fields. Opaque business values remain
`json.RawMessage`, including file paths and large JSON integers, so transport
does not sanitize or reinterpret renderer data. The exact protocol revision
covers the event schema, protobuf field numbers, delivery-kind values, and JSON
control shapes. A revision mismatch is an explicit rejection followed by
canonical reconciliation; it is not a compatibility conversion path.

`StreamReady` is transport-only and must not be interpreted as canonical
catch-up. `AttachmentChanged` starts a baseline for one positive attachment
revision; hosts publish their canonical baseline and then
`AttachmentCaughtUp` with the exact same binding, workspace, Session,
authorization set, explicit `currentInteractionRootTurnId`, caller-Turn, and
revision identity. `canonicalTurnIds` is an authorization set, never an ordered
current-Turn pointer. Every complete `interaction_snapshot` carries its
required exact `rootTurnId`, including an empty collection. Consumers reject a
snapshot whose root does not resolve to the controlled root and reject a
missing or mismatched barrier. The protocol carries this fence but does not
choose recovery state: the host adapter must reread its canonical store, which
remains the lifecycle authority after a runtime or host-process restart.

Replay resumes the same epoch, so replayed attachment or caught-up controls may
precede the replacement RPC's newly emitted `StreamReady`. Consumers persist
the attachment projection together with the resume cursor. If disconnection
occurred after `AttachmentChanged` but before `AttachmentCaughtUp`, the
projection remains explicitly not caught up until the matching barrier is
replayed. A host must not publish `AttachmentCaughtUp` for a replacement
attachment until it has rerun the complete canonical baseline.

Frames are bounded but not fragmented. Before publication, a canonical
tool-output operation that would consume the delivery budget is represented as
one `set` followed by contiguous `append_text` operations; this reuses the
existing semantic operation contract rather than introducing transport-frame
fragment assembly. The publisher may coalesce only adjacent pure `append_text`
operations for the same message and Turn; tool-output operations additionally
require contiguous byte offsets. Status, payload, semantic, or lifecycle
mutations remain separate deliveries. A single delivery over the configured
safe limit (1 MiB by default, with a 2 MiB encoded-frame ceiling and an 8 MiB
replay-byte budget) is replaced with a `delivery_too_large` discontinuity
carrying reconcile keys, and the caller falls back to canonical data. This
ensures that the final oversized event is not silently lost.

The publisher also keeps a bounded FIFO of the most recent settled Turn ids.
Those fences convert late text or tool deltas into scoped discontinuities
without allowing a long-lived stream to accumulate one permanent map entry per
historical Turn. The retention bound is independent of canonical history:
evicted Turns remain durable, and the activity-core overlay independently
rejects a nonterminal delta against known terminal message truth so any later
uncertainty still converges through authoritative reconciliation.

A host creates one activity-core workspace event coordinator per Engine. The
coordinator materializes accepted deltas in its optimistic overlay, projects
that overlay over the latest canonical message base, applies continuous inline
messages, owns Session deletion tombstones, admits only explicit
`session_restored` events through those tombstones, and schedules authoritative
reconciliation after a restore, gap, discontinuity, recovered connection,
invalid payload, or unanchored append. The Tutti desktop receives local deltas
through the business-event WebSocket; shared-device hosts receive the same live
subset through the framed Go protocol. UI consumers never retain transport
epoch/sequence state or distinguish local from shared activity sources.

For Personal paired devices, `services/tuttid/service/mobileremote` owns the
`agent_live` application-stream adapter. It subscribes to
`agent.activity.updated` with the requested workspace scope, projects only the
closed live event variants into `liveprotocol.Publisher`, converts canonical
message/reconcile variants into scoped discontinuities, and preserves an
explicit `session_deleted` or `session_restored` reason plus Session reconcile
key for the Mobile adapter to normalize into the shared coordinator's lifecycle
path. Those semantic reasons participate in
`AGENT_ACTIVITY_LIVE_PROTOCOL_REVISION`; mismatched builds are rejected instead
of silently degrading deletion or restore into an ordinary reconcile. The
adapter establishes the workspace subscription before publishing
`stream_ready`, so events produced during ready-frame delivery are already
buffered instead of falling through a subscribe gap. The Android
bridge keeps one long-lived DeviceLink stream and delegates frame decoding and
continuity checks to the Agent-owned Go mobile Subscriber before emitting
accepted deliveries to React Native. Each bridge subscription also carries a
caller-owned local generation that is independent of the wire epoch and
sequence cursor. Native stops the live stream immediately when the App enters
the background, and both the Native-to-JS adapter and workspace live lane reject
queued deliveries from a closed generation after foreground resume. The
underlying DeviceLink may remain open for its background grace interval. The
Mobile Android host co-links that Subscriber and DeviceLink into its own
composite AAR; the transport package's AAR and Java namespace remain Agent-free.
Mobile disables its message and Rail pollers after `stream_ready`; those pollers
are disconnected-transport fallback only.

After either transport is normalized, Desktop and Mobile call the same
`AgentActivityWorkspaceEventCoordinator`. Its package-internal rules derive
inline messages, validate envelope/data/message identity, require every
advertised message to parse, check the advertised count and latest-version
cursor, and validate version continuity. Any disagreement fails closed to
authoritative reconciliation. The coordinator emits Engine intents and owns
the optimistic projection, rather than exporting those leaf mechanisms for
hosts to assemble independently. Mobile does not widen its four-variant framed
live protocol to mirror Desktop: canonical `message_update` and
`session_reconcile_required` events converge through scoped discontinuities,
while `session_deleted` and `session_restored` retain typed lifecycle semantics
across the adapter.

Desktop and Mobile also call the same
`AgentActivitySessionReconcileExecutor` for authoritative Session reads. The
executor accepts only mapped activity-core detail aggregates and message pages;
it owns the three reconcile scopes, cancellation and deletion fences,
conversation-versus-durable cursors, pagination, the two-detail race closure,
and atomic Engine dispatch. A host selects either requested-Session or
Session-hierarchy message hydration according to the transcript surface it
renders. The executor labels its first combined read as `message_hydration`;
tuttid serves that projection without resolving provider-backed lifecycle
capabilities. The final read remains authoritative and resolves those
capabilities once. Hosts must preserve this distinction: caching provider
capabilities or removing the final race-closing read can return stale actions,
while using the full projection for discovery can launch an otherwise unused
provider capability probe. Each HTTP response echoes its projection and whether
lifecycle capability projection ran; clients fail closed on a mismatch, and
values from a deliberately unprojected hydration response must never clear
authoritative actions. Full projection remains fail-closed when a provider
probe fails, preserving existing detail availability while making the action
unavailable for that response. HTTP execution, generated DTO mapping,
absent/error interpretation, logging, polling, and legacy event fanout stay in
the host. The canonical detail aggregate type belongs to activity-core; the
tuttid adapter only maps the generated response into it.

Focused transcript paging is the adjacent AgentGUI application boundary.
Desktop and Mobile construct the same
`@tutti-os/agent-gui/conversation-message-controller`. It routes initial and
latest hydration through Engine reconcile intents, reads older history only
from the canonical Engine message window, fences in-flight pages when focus or
host availability changes, and dispatches accepted mapped pages into that
Engine. Mobile's disconnected poller and app lifecycle, Desktop diagnostics
and WebSocket integration, and both renderers' scroll behavior remain host
concerns. Hosts must not add a second older-message store or a host-local
cursor/retry state machine. Desktop conversation selection owns activation
guards and Rail projection coordination, then asks this controller to ensure
initial detail hydration. Automatic selection restoration is idempotent: it
must not reinterpret a repeated selection as a forced refresh or enqueue a
second reconcile while the first is pending. Explicit refresh remains a
separate command. Message paging adapters do not call back into selection or
Rail orchestration, and hosts do not maintain a second messages-only reconcile
entrypoint.

Event-stream continuity and command reachability are separate host facts.
`eventStreamConnectionChanged` belongs to the coordinator and triggers
authoritative reconnect hydration; `engine/connectionChanged` belongs to the
host command transport. Desktop's business-event WebSocket may drive both
because it shares the local service boundary. Mobile drives Engine connection
from application/service command reachability and coordinator connection from
`stream_ready`, disconnect, attachment rejection, and stream shutdown. Neither
signal may synthesize the other.

Realtime Turn provenance travels on the Engine-owned `session/reconcile`
command. If a live reconcile fails, the Engine retains that provenance for the
next exact retry. Both Desktop and Mobile preserve it on
`session/detailSnapshotReceived`, so an uncached completed Turn is replayed
after Session identity exists and produces the same attention/read semantics.
Hosts must not keep parallel “next reconcile is live” marker sets.

Hosts may accept older provider/runtime reports with missing transcript
ownership or ordering fields, but those gaps must be filled before events enter
`agent-activity-core` or `@tutti-os/agent-gui`. Session-level notices and
statuses should use canonical lifecycle events or explicit notice semantics;
they should not be published as ordinary assistant transcript messages without
a turn scope.
Activity reports may carry a host-defined user id before they reach the engine.
The local desktop adapter injects its stable local AgentGUI identity so
attention/read state has a deterministic partition without consulting account
login state. Cloud collaboration hosts may inject real account user ids so
downstream views can distinguish self-owned and peer-owned sessions. Identity
enrichment must use host-provided local state; it must not call account refresh
or user-info APIs that perform network round-trips or write refreshed auth
state.

## Event And Reconcile Lifecycle

Realtime transport lifecycle belongs to the host. Engine semantics define how
the normalized event is applied:

- keep one workspace event-stream subscription independent of mounted panels
- hydrate canonical `message_update` snapshots into the host-owned base
- materialize optimistic `message_delta` events before dispatching ordinary
  messages into the engine; never replay an append operation log over a newer
  canonical base
- scope every optimistic overlay operation by workspace and Session; a
  successful authoritative message read clears nonterminal optimistic state for
  that scope before accepting later deltas
- keep a newer optimistic terminal projection over a cloud nonterminal, and
  clear it when canonical terminal truth arrives
- after a gap, discontinuity, or reconnect, complete an authoritative read and
  reconcile the overlay; use an unconditional overlay reset only when removing
  or rebinding the Session
- validate each `turn_update` envelope and dispatch one atomic Engine
  projection that updates the Turn and the cached Session's `activeTurnId`
  together; a settled Turn may clear only its own active reference, so delayed
  events cannot clear a newer Turn
- after the host has fenced transport identity and ordering, it may explicitly
  mark settlement of that same immutable Turn as absorbing when the cached
  nonterminal projection belongs to another source version domain; unmarked
  realtime projections and generic Turn and Session upserts retain their
  canonical version guards
- use canonical Turn versions as the Engine-local fence against stale Session
  snapshots; event-envelope `occurredAtUnixMs` is transport metadata and must
  not advance canonical Session timestamps or participate in entity ordering
- reject inconsistent Turn projections without partially updating canonical
  state, then converge through a state-only session pull
- reconcile `turn_update` and `interaction_update` through a session pull to
  fill fields outside their realtime projections and hydrate an uncached
  Session; the pull is not the consistency boundary for a cached Turn and
  Session
- preserve whether a reconcile was realtime-triggered until its authoritative
  session is applied; if the authoritative fetch fails, restore that provenance
  for the retry rather than silently downgrading it to historical
- let the atomic realtime Turn projection drive attention immediately when
  Session identity is cached, but only from the Turn accepted by canonical
  lifecycle monotonicity; after hydrating an uncached Session, replay its latest
  Turn with realtime provenance so attention can resolve identity
- apply historical list pulls through `session/snapshotReceived`, which never
  creates a new unread completion
- let identity-dependent reducers observe both authoritative shapes: a pending
  activation is confirmed by either `session/snapshotReceived` or
  `session/upserted`, and message buckets are canonicalized as soon as either
  shape reveals a provider-session alias
- when a session is removed, use its pre-removal identity to delete both the
  canonical message bucket and any provider-session alias bucket
- deduplicate messages by stable message identity and version
- treat transcript `message_update` messages as normalized input: each message
  must have `messageId`, positive `version`/`seq`, nullable `turnId`, and
  `occurredAtUnixMs` before core merges it

The host owns:

- URL construction
- token or cookie usage
- `EventSource`, `fetch`, IPC, or another transport
- raw protocol decoding
- host-specific retry capability

When command reachability differs by Session, the host also projects
`session/runtimeAvailabilityChanged` into the shared engine. This state is
ephemeral command coordination, not a canonical Session field. In addition to
transport and capability reasons, a shared host may project
`agent_sharing_revoked` with the owner display label. The engine gates
runtime-dependent commands and AgentGUI presents the same blocked interaction
for every host; history remains canonical and readable. A host must not map one
Session's transport loss or revoked sharing relationship to the workspace-wide
engine connection state.

An interaction-scoped collaborative write gate is narrower than Session
runtime availability. A Host projects it through AgentGUI's optional
`interactionReadinessSource`, keyed by the exact canonical Interaction tuple,
and rechecks the same Host authority at submission. AgentGUI owns only the
generic blocked presentation and early event-time admission. The projection
must not be copied into activity-core, canonical Interaction lifecycle, or a
renderer transport-health store; a missing record from a supplied source is a
fail-closed synchronizing result.

## Needs Attention Contract

Agent Message Center counts user-actionable items, not all session messages.

The initial selector surface is:

```ts
selectNeedsAttentionCount(snapshot): number;
selectNeedsAttentionItems(snapshot): AgentActivityNeedsAttentionItem[];
```

`AgentActivityNeedsAttentionItem` should contain:

```ts
export interface AgentActivityNeedsAttentionItem {
  id: string;
  workspaceId: string;
  agentSessionId: string;
  provider: string;
  title: string;
  cwd: string;
  kind: "permission" | "question" | "constraint" | "other";
  summary: string;
  occurredAtUnixMs: number;
}
```

The selector should count pending actionable prompts such as permission
approvals, ask-user questions, and constraint confirmations. Completed,
canceled, superseded, or already answered prompts must not be counted.

Failed sessions are not automatically needs-attention items unless they expose a
specific user action that can resolve the failure.

## Validation

For `agent-activity-core`:

- unit tests for message merge ordering and deduplication
- unit tests for retained stream lifecycle
- unit tests for needs-attention selectors
- package typecheck

For desktop adapter integration:

- existing desktop workspace-agent tests
- adapter tests for `tuttid` response normalization
- live event merge tests using a fake subscription adapter

For Agent GUI behavior:

- existing Agent GUI component and projection tests
- focused tests for working, waiting, completed, failed, and needs-attention
  states
- tests that AgentGUI list/detail and write operations use
  `AgentGUIRuntime` when provided, with lifecycle writes asserted through the
  workspace Engine

For runtime boundary enforcement:

- `pnpm check:agent-activity-runtime-boundaries`
- `pnpm check:agent-provider-strategy-boundaries`
- `pnpm check:agent-gui-degradation`
- these checks are included in `pnpm check:full`

## Non-Goals

- Do not move desktop transport into a package.
- Do not create a vague `shared`, `common`, or `utils` package.
- Do not change daemon HTTP contracts without first updating
  `services/tuttid/api/openapi/tuttid.v1.yaml`.

## Review Rules

- New public exports in `agent-activity-core` should be stable contracts, not
  convenience exports for one host.
- A selector belongs in core when Agent GUI and another host-agnostic consumer can
  use it without knowing host details.
- A React hook belongs in `agent-gui` rather than in core.
- A pure generated-`tuttid` DTO projection shared by Desktop and Mobile belongs
  in `agent-activity-tuttid-adapter`. Host identity injection, transport,
  retries, event wiring, and orchestration remain in each application adapter.
- Root detail DTOs use the adapter's aggregate mapper so root Session, child
  Sessions, and Turns enter the Engine through one
  `session/detailSnapshotReceived` intent. The mapper verifies the requested
  Session identity, child hierarchy, and Turn ownership; a malformed nested
  entity rejects the aggregate instead of publishing a partial hierarchy.
- Engine prompt commands use the activity-core prompt state machine. Required
  settings enter the same serialized per-Session settings lane as direct
  updates and post-activation persistence. Settings from different owners form
  queue barriers and are not coalesced together; validated Session truth is
  applied before send, and a failed or timed-out settings write prevents
  delivery. Transport request mapping remains host-owned.
- External repository adoption should require implementing the adapter, not
  copying session merge or needs-attention logic.
