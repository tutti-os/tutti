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

Permanent deletion is intentionally distinct from the normal canonical delete
command. `Host.PurgeDeletedSessions` accepts a cutoff and bounded batch limits,
while `store-sqlite` selects tombstones globally by deletion time, fences every
candidate with its exact `deleted_at` value, and removes session-scoped rows in
one transaction. Candidate selection starts from current leaves, so large or
deep trees cannot let blocked ancestors starve unrelated tombstones. Ancestors
remain until every descendant has been safely removed, which preserves a
concurrently restored child tree. Host does not choose retention periods or
filesystem paths.
The `tuttid` maintenance adapter owns the device-global 15/30-day preference,
idle-aware scheduling, once-per-day durable eligibility marker, manual purge
route, and optional database compaction. This retention flow performs no
filesystem deletion.

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
- selectors for reusable derived state
- `selectNeedsAttentionCount`
- `selectNeedsAttentionItems`
- the workspace session engine (`createAgentSessionEngine` under
  `src/engine/`): intent dispatch loop, domain-composed pure reducers,
  command-description effect executor, expiry-intent clock, and intent frame
  batching, with scheduler/clock/command ports injected by the host
- the typed frontend effect seam for activation, prompt send, settings update,
  turn cancellation, Interaction response, pin, and batch delete, including
  lossless command projection and required-settings-before-send ordering; hosts
  retain transport, DTO mapping, AbortSignal propagation, and product-specific
  command extensions (see
  [Agent GUI Node](./agent-gui-node.md#4-workspace-frontend-engine))

The public seam is `AgentSessionEffectPort`. Prompt precondition ordering and
its helper port are Engine implementation details and are not exported from the
package root.

Edit retry follows the same frontend command rule as pin, delete, cancel, and
reconcile: the engine owns the stable client operation id, pending/failure
record, typed recovery intent, and authoritative state-and-message follow-up.
React may retain an unsent editor draft, but it must not subscribe to raw
transport events or sequence edit-retry HTTP calls itself. The Desktop command
port translates `turn/editRetry` and `turn/recoverEditRetry` to the injected
`TuttidClient`; the result re-enters the reducer as `reconciling`, while only
the authoritative session-detail projection may replace edit-retry
availability and release that fence.

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
and Session, Turn, Message, and Tutti-mode projections.
Current-user identity is mandatory mapper input from the application host:
Desktop supplies its local AgentGUI identity and Mobile supplies the immutable
authenticated account user id.

It may depend on the generated client and `agent-activity-core`, but must not
own HTTP execution, authentication, retries, event subscriptions, logging,
i18n, Electron/React Native APIs, DI scopes, or command orchestration. Those
remain application-host responsibilities. If a proposed extraction requires a
large callback surface for those concerns, keep it in the application adapter
instead.

### `@tutti-os/agent-gui`

`agent-gui` is the renamed successor of
`@tutti-os/agentactivity-renderer`.

It owns:

- `AgentGUI`
- `AgentActivityRuntime` provider and hooks
- Agent GUI workbench node UI
- session list and detail rendering
- timeline, tool call, approval, and interactive prompt presentation
- package-owned stylesheet entrypoint
- React-facing hooks or providers that are specific to Agent GUI
- Message Center snapshot model and UI while it shares AgentGUI activity and
  interaction ownership

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

Agent GUI must read and write agent session/activity data through
`AgentActivityRuntime`. The effective `AgentHostApi` is limited to host
capabilities such as files, clipboard, runtime metadata, account/project
lookup, diagnostics, setup, and OS/Workbench helpers. Its input type still
accepts a legacy `agentSessions` shape, but `toAgentHostRuntimeApi` strips that
shape; production AgentGUI must not use it as an activity source.
Device-global quick prompts are also an optional host capability rather than
activity data. The desktop adapter combines the developer-gated preference,
the generated `tuttid` client, and global invalidation events behind
`AgentHostApi.quickPrompts`. AgentGUI may subscribe to that capability to render
the composer picker and management dialogs, but quick-prompt entities must not
be copied into `AgentActivityRuntime`, a workspace engine, a Session, or a Turn.
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
Conversation rail sections are also an `AgentActivityRuntime` contract:
AgentGUI calls `listSessionSections` for the first page of every returned rail
section and `listSessionSectionPage` for Show more by `sectionKey` and cursor.
Hosts must pass those calls through to the daemon section endpoints so project
sections come from current user projects and session membership comes from
persisted `rail_section_key`, not frontend cwd grouping or project-root
filters.
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
the compatibility-named `AgentActivityRuntime` Rail aliases. The public
controller snapshot exposes memberships, ordered ids, pagination, search, and
request state only; Desktop joins it with Engine state for localized
conversation summaries outside the headless entrypoint. Resolved cache entries
are shared by controllers created for the same workspace Engine; the factory,
not `AgentActivityRuntime` or a host adapter, owns that registry. The cache
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
`railSectionKey` on that first persistence and preserves it for the lifetime of
the session, even if later runtime reports change `cwd` or the user-project list.
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
Pin and delete are engine mutations, not direct runtime calls from AgentGUI.
The engine records the pending mutation, emits one semantic command, and feeds
the command result back through its reducer loop. Successful pin results and
delete tombstones enter canonical state as follow-up intents in the same engine
drain. The desktop activity facade may await that engine record, but its command
port is the only transport executor. Settled mutation records use a bounded
window; they are workflow evidence, not an unbounded history store.
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
loading UI.
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
`agentSessions.submitInteractive`, or `agentSessions.pinSession`; use
`AgentActivityRuntime` instead. Legacy host DTOs are allowlisted only in the
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
- `IWorkspaceAgentActivityService` and the desktop
  `AgentActivityRuntime` wrapper
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
`EngineCommandPort.executePlanDecision` method. Its public
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

`AgentActivityRuntime.activateSession` requires `agentTargetId` for
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
or provider-declared draft-session prewarming.

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
anchor first and the retained prefix as `set`. An unmatched or oversized
prefix is dropped with diagnostics rather than inventing a tool row.
Completed, failed, canceled, and rewritten tool results remain full canonical
`message_update` snapshots.

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
`AttachmentCaughtUp` with the exact same binding, workspace, Session, Turn,
caller-Turn, and revision identity. Consumers reject a missing or mismatched
barrier. The protocol carries this fence but does not choose recovery state:
the host adapter must reread its canonical store, which remains the lifecycle
authority after a runtime or host-process restart.

Replay resumes the same epoch, so replayed attachment or caught-up controls may
precede the replacement RPC's newly emitted `StreamReady`. Consumers persist
the attachment projection together with the resume cursor. If disconnection
occurred after `AttachmentChanged` but before `AttachmentCaughtUp`, the
projection remains explicitly not caught up until the matching barrier is
replayed. A host must not publish `AttachmentCaughtUp` for a replacement
attachment until it has rerun the complete canonical baseline.

Frames are bounded but not fragmented. The publisher may coalesce only adjacent
pure `append_text` operations for the same message and Turn; tool-output
operations additionally require contiguous byte offsets. Status, payload,
semantic, or lifecycle mutations remain separate deliveries. A single delivery
over the configured safe limit (1 MiB by default, with a 2 MiB encoded-frame
ceiling and an 8 MiB replay-byte budget) is replaced with a `delivery_too_large`
discontinuity carrying reconcile keys, and the caller falls back to canonical
data. This avoids maintaining a second chunk assembly protocol while ensuring
that the final oversized event is not silently lost.

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
messages, owns Session deletion tombstones, and schedules authoritative
reconciliation after a gap, discontinuity, recovered connection, invalid
payload, or unanchored append. The Tutti desktop receives local deltas through
the business-event WebSocket; shared-device hosts receive the same live subset
through the framed Go protocol. UI consumers never retain transport
epoch/sequence state or distinguish local from shared activity sources.

For Personal paired devices, `services/tuttid/service/mobileremote` owns the
`agent_live` application-stream adapter. It subscribes to
`agent.activity.updated` with the requested workspace scope, projects only the
closed live event variants into `liveprotocol.Publisher`, converts canonical
message/reconcile variants into scoped discontinuities, and preserves an
explicit `session_deleted` reason plus Session reconcile key for the Mobile
adapter to normalize into the shared coordinator's removal path. That semantic
reason participates in `AGENT_ACTIVITY_LIVE_PROTOCOL_REVISION`; mismatched
builds are rejected instead of silently degrading deletion into an ordinary
reconcile. The adapter establishes the workspace subscription before
publishing `stream_ready`, so events produced during ready-frame delivery are
already buffered instead of falling through a subscribe gap. The Android
bridge keeps one long-lived DeviceLink stream and delegates frame decoding and
continuity checks to the Agent-owned Go mobile Subscriber before emitting
accepted deliveries to React Native. The Mobile Android host co-links that
Subscriber and DeviceLink into its own composite AAR; the transport package's
AAR and Java namespace remain Agent-free. Mobile disables its message and Rail
pollers after `stream_ready`; those pollers are disconnected-transport fallback
only.

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
while `session_deleted` retains typed deletion semantics across the adapter.

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
- reconcile `turn_update` and `interaction_update` through a full session pull
- preserve whether a reconcile was realtime-triggered until its authoritative
  session is applied; if the authoritative fetch fails, restore that provenance
  for the retry rather than silently downgrading it to historical
- dispatch `session/upserted` before realtime `turn/upserted` so attention can
  resolve the session identity
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
ephemeral transport coordination, not a canonical Session field. The engine
gates runtime-dependent commands and AgentGUI presents the same frozen/loading
interaction for every host; a host must not map one Session's transport loss to
the workspace-wide engine connection state.

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
  `AgentActivityRuntime` when provided

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
- Engine prompt commands use the activity-core prompt executor. Required
  settings are persisted before send, and a failed settings write prevents
  delivery; transport request mapping remains host-owned.
- External repository adoption should require implementing the adapter, not
  copying session merge or needs-attention logic.
