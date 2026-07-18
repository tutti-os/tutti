# Provider-Native Subagents

Status: accepted architecture, implementation in progress

This spec covers provider-native child agents only:

- Codex app-server multi-agent child threads.
- Claude Code SDK `Task` / subagent sessions and turns.
- Claude Code SDK task-system background work that is not a subagent launch,
  such as `run_in_background` Bash shells. It follows the same child contract:
  it gates the root turn, projects as a child, and is individually cancelable.
- ACP providers that expose an equivalent nested/background agent concept.

It does not cover Tutti launching another top-level AgentGUI session with
`tutti-dev agent start`, handoff mentions, or another Codex/Claude Code process.
A background command that merely tracks such a top-level session (for example
`tutti agent wait` running in a background shell) is itself SDK task-system
work and is covered: the tracked session stays out of scope, but the tracking
task holds the root turn open for exactly as long as the wait runs.

## Product Contract

From the user's point of view, a root turn remains active while any
provider-native child agent created under that turn is still active.

- Root turn completion is gated by child-agent completion.
- User cancellation cancels the root turn and every child agent owned by that
  turn.
- A new user message submitted while the root turn is active is appended to
  the same in-flight work instead of creating a separate visible turn.
- Child-agent progress is presented under the root turn, not as a separate
  conversation.

The product model is closest to Codex app-server multi-agent UX: the user sees
one root turn that can delegate work internally. The implementation must not
depend on Codex-specific event shapes.

## Entity Decision

The existing `WorkspaceAgentTurn` remains the correct top-level user-visible
unit. Provider-native child agents are subordinate `WorkspaceAgentSession`
entities. Being non-navigable or non-resumable does not make a child agent less
session-like: it still has provider identity, turns, messages, context,
interactions, cancel/guide behavior, and possibly its own child sessions.

The existing session model currently also implies a top-level user
conversation. That implication must be separated from session identity. A
child session is hidden from ordinary conversation navigation and is reached
through its immutable parent relationship.

Target model:

```text
WorkspaceAgentSession (root, user-visible conversation)
  -> WorkspaceAgentTurn (root, user-visible turn)
    -> WorkspaceAgentSession[] (child, hidden subordinate sessions)
      -> WorkspaceAgentTurn[]
        -> messages / interactions
        -> WorkspaceAgentSession[] (nested child sessions)
```

Every session needs an explicit kind of `root` or `child`. A child
session also needs durable parent and root fields:

- `parent_agent_session_id`
- `parent_turn_id`
- `parent_tool_call_id`
- root `agent_session_id` and root `turn_id` for nested child lookup and
  cancellation
- provider handles and aliases such as `threadId`, `taskId`, `agentId`, and
  `parentToolUseId`

The parent relationship describes which session turn and delegation tool
created the child. It does not make child messages or interactions belong to
the root turn. Their canonical owner remains the exact child session and child
turn; root-turn projections join them through the recorded parent and root
fields.

There is no separate `WorkspaceAgentSubAgentRun` entity in the target model.
Each spawned child session has exactly one immutable creator relationship to
one parent session, parent turn, and delegation tool call. It is never
re-parented, reused by another parent turn, or split into multiple independently
settled delegations. Later guidance may create more turns inside that same child
session, but it does not create another ownership edge. A separate run entity
would therefore duplicate the child session's identity and lifecycle.

Child lifecycle uses the existing turn phase and outcome vocabulary. The
daemon creates a submitted child turn when delegation is accepted, before all
provider aliases are necessarily known, and binds later native identifiers to
that session/turn. Do not duplicate child lifecycle into a second child-agent
status field.

## Session And Turn Semantics

`WorkspaceAgentSession` is the identity and context boundary for one agent,
whether it is a root agent or a child agent. `WorkspaceAgentTurn` records one
turn inside that session.

- A root turn is initiated by a user submission and remains the user-visible
  turn.
- A child turn is initiated by delegation from its parent turn or by later
  guidance sent to that same child session.
- Root and child turns use the same phase, outcome, message, interaction, and
  exact-turn cancellation model. Trigger source does not create a second turn
  entity type.
- A child session may contain multiple sequential turns, but its immutable
  creator relationship does not change and every child turn remains under the
  same root session and root turn.
- Child messages and interactions belong to the exact child turn that produced
  them. The root turn aggregates them for lifecycle and presentation without
  rewriting their ownership.
- Claude SDK permission callbacks running inside a child must preserve the
  callback `agentID` as the provider `agentId` alias. The Claude adapter resolves
  that alias to the already-recorded child session and turn before emitting the
  canonical interaction. The callback's provider/root turn id is not sufficient
  evidence of interaction ownership.

The existing API description of `WorkspaceAgentTurn` as universally
"user-submission-driven" must therefore be broadened. That phrase describes a
root turn only, not the shared turn entity.

## Session Read Contract

The shared `WorkspaceAgentSessionResponse` continues to represent exactly one
session:

```text
WorkspaceAgentSessionResponse
  session: WorkspaceAgentSession
```

Create, update, interactive-response, and other commands reuse this response
and must not load or return an entire child-session tree. The session entity
itself carries its `root` or `child` kind and, for a child, the immutable root
and parent relationship fields.

Only the session detail read uses a larger response:

```text
WorkspaceAgentSessionDetailResponse
  session: WorkspaceAgentSession
  childSessions: WorkspaceAgentSession[]
```

`GET /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}` returns this
detail response. `childSessions` contains every nested child session below the
requested session as a flat collection. Clients reconstruct the tree from each
child's parent fields; the API does not define a recursive session DTO and does
not infer relationships from transcripts or display order. Reading a root
therefore restores its complete child-session tree in one durable snapshot,
while reading a leaf child returns an empty collection.

Messages remain independently addressable through the existing
`GET .../agent-sessions/{childSessionID}/messages` endpoint. Ordinary session
lists, section lists, pinned lists, search, and conversation navigation return
root sessions only. Child sessions are reached through the detail response or
by their exact session ID.

## Root Turn Lifecycle

The root turn lifecycle is controlled by both the root provider turn and every
nested child turn created under that root turn.

Rules:

- A root provider turn terminal event is not enough to settle the root
  `WorkspaceAgentTurn` if any nested child turn is still submitted, running,
  waiting, or settling.
- Normalize that provider terminal as an internal
  `root_provider_turn_completed` event. The event records only that the current
  root provider turn reached a terminal; it must not claim that the root
  `WorkspaceAgentTurn` completed or encode the transient condition "completed
  with children still running."
- The daemon reducer consumes this event and durably retains the root provider
  turn's pending outcome. If child turns are still active, the root turn remains
  `waiting`. This internal event does not need a separate AgentGUI projection
  or a new user-visible turn phase.
- Provider-native workflow state is orthogonal to this gate. In particular,
  Claude Goal `complete` means only that Claude considers its native goal met;
  it is valid for the durable state to be `goal=complete`, canonical root
  `turn=waiting`, and one or more child turns `running`.
- Composer availability, user-visible completion, and permission to create a
  new canonical turn derive only from the `services/tuttid` root turn. Goal
  status must not settle the root, clear its active-turn reference, or unlock
  those surfaces.
- A child terminal event settles only the exact child turn. It must not choose
  a root outcome by itself. After that child transition commits, the same
  transaction re-evaluates the root gate and may apply an already-retained
  root provider outcome when no active children remain.
- A failed child turn does not automatically fail the root turn. Child outcomes
  participate in the terminal-state gate, while the root outcome remains owned
  by the root agent. A root turn may complete successfully while one or more
  child lanes visibly report failure.
- When the root provider turn and all nested child turns are terminal, the root
  `WorkspaceAgentTurn` may apply the retained root provider turn outcome and
  settle. If the root agent continues later, its next provider turn remains
  attached to the same root `WorkspaceAgentTurn`; it does not create another
  root `WorkspaceAgentTurn`.
- If the user cancels, the root turn settles as canceled after cancellation
  has been requested for both root and child provider handles. Late child
  events after cancellation must be reconciled into terminal child state, not
  resurrect the root turn.
- A matching root provider terminal may arrive after the canonical root was
  atomically settled as canceled. Persist that late provider terminal into the
  root-provider lifecycle fields without changing, republishing, or reopening
  the canonical root turn. A settled/canceled canonical root must not retain a
  stale `root_provider_turn_phase=running` after that terminal is observed.
- If a child approval or interactive prompt is pending, its canonical identity
  remains the child session/turn/request tuple, while the root turn remains
  active and presents the interaction through its aggregate projection.
- Canonical interaction ownership and provider transport correlation are
  separate identities. Persist, render, submit, and settle the interaction by
  its canonical child session/turn/request tuple, but send the provider's
  original turn id back when its protocol uses that id to find the pending
  callback. A synthetic provider turn attached to the same canonical root turn
  follows the same rule; its provider id must not be replaced with the
  canonical root turn id on the response path.

The existing closed turn phase vocabulary can continue to expose the root turn
as `running` or `waiting`; the reason that it is still active should come from
child-session projections, not from inventing provider-specific turn phases in
the GUI.

## Root And Child Turn Ownership

Provider transports report provider facts; they do not decide whether a root
`WorkspaceAgentTurn` is complete.

- A provider sidecar emits its native root and child turn events without
  querying Tutti entities or applying root/child rules.
- A provider adapter identifies the root, parent, and child session/turn IDs and
  normalizes provider events. A root provider `turn_completed` becomes
  `root_provider_turn_completed`; it must never become a canonical root
  `turn.completed` inside the adapter.
- Root-provider lifecycle events are durable state inputs, not stream-only
  diagnostics. The runtime reporting filter must forward both
  `root_provider_turn_started` and `root_provider_turn_completed` to
  `services/tuttid`; otherwise the provider can finish visibly while the
  canonical root turn remains active forever.
- A persisted state patch mutates a canonical `WorkspaceAgentTurn` only when it
  carries an explicit structured `Turn` transition. Runtime `TurnLifecycle`
  and `SubmitAvailability` snapshots may enrich the live stream and a full
  session snapshot, but they must never be interpreted as fallback canonical
  turn facts. In particular, enriching a root-provider lifecycle event with a
  runtime snapshot must not replay `root=running` after the durable root has
  settled.
- `services/tuttid` owns the durable root/parent/child relationship and the root
  turn completion rule. It records the root provider turn outcome, checks all
  nested child turns, and emits the canonical root turn completion only when
  the root turn can actually settle.
- The SQLite repository provides one atomic write for the root provider turn
  outcome, child turn transition, root turn transition, active turn reference,
  and resulting outbox events. It does not contain Claude-, Codex-, or
  ACP-specific policy.
- Agent Activity and AgentGUI consume the resulting sessions, turns, messages,
  and interactions. They do not reconstruct or override root turn completion.
- Session deletion follows the same ownership tree. Deleting a root or child
  session atomically tombstones that session and all of its nested child
  sessions, then removes their turns and interactions. A child must never
  remain as an orphan after its ancestor is deleted.

This rule applies to every provider. When a root provider turn completes with
no active child turns, `services/tuttid` settles the root turn immediately. The
separate internal event exists so the same provider event remains correct when
child turns are active.

Event order must not change the result:

```text
root_provider_turn_completed -> active child turns remain -> root waiting
child turn terminal           -> last active child          -> root settles

child turn terminal           -> root provider turn active  -> root stays active
root_provider_turn_completed -> no active child turns       -> root settles
```

Creating a child session and its initial child turn must be persisted before a
later root provider terminal is applied. A child discovered only after the root
turn settled is an event-normalization or ordering bug; it must not be handled
by resurrecting the root turn.

## Sending While Children Run

When the user submits another message while the root turn is active, the
command targets the root agent and the same root turn.

Default behavior:

- Append/guide the root provider turn when one is active.
- Let the provider decide how the root agent uses the guidance.
- Do not fan the text out to every child agent.
- Direct user targeting of one child agent is not supported in the current
  product contract. It requires a separate future product decision rather than
  a provider-specific shortcut.

Provider adapters must expose whether root-turn guidance is supported while
only child agents are running. If a provider cannot safely send the guidance on
the root session, the command must produce a clear pending/unsupported result
rather than silently starting a new root `WorkspaceAgentTurn`.

## Cancellation

Cancel is a fan-out operation over one root turn:

```text
cancel(root_turn_id)
  -> cancel root provider turn when still live
  -> traverse every nested child session owned by the root turn
  -> cancel every non-terminal child provider handle / child turn
  -> settle confirmed child turns canceled
  -> settle unconfirmed child turns interrupted after timeout
  -> settle root turn canceled
```

The fan-out target set is decided before entering the provider runtime:

- `services/tuttid` reads the durable session tree and records the exact
  `(agentSessionId, turnId)` targets in the cancel operation.
- The runtime request carries `rootAgentSessionId` separately from `targets`.
  The root id locates the live provider runtime; each target identifies a
  canonical root or child turn.
- The runtime controller does not register or persist a second copy of child
  business state. It only routes child targets through the root live session.
- The controller invokes the bounded provider cancel while the adapter still
  owns the live root provider-turn handle. It cancels the local Exec context
  only after that provider call returns. Local context cancellation is cleanup,
  not a substitute for the native root interrupt.
- A provider adapter maps the supplied targets to native handles. It must not
  scan its private registry to decide which child sessions belong to the
  cancellation.
- The adapter returns the exact subset of supplied targets whose native cancel
  operation was acknowledged. The controller forwards that evidence; it does
  not translate a successful method call into turn settlement or synthesize a
  missing child confirmation.
- Codex maps each supplied child session to its native thread. Claude SDK uses
  its root-query cancel primitive when the target set includes the root; that
  native operation covers the Task executions in the same query. Standard ACP
  remains root-only until a provider explicitly supports child sessions.
- A Claude child-only target set does not interrupt the root query. The adapter
  resolves each child to its SDK task identity (task id, agent id, or launching
  tool-use id alias) and issues the SDK's targeted `stopTask`; the root provider
  turn and every other task keep running. A target whose task is unknown or
  already terminal is an idempotent no-op: it is simply not confirmed, and the
  durable operation records it through the generic unconfirmed path.

When a Codex target set includes the root, the adapter stops the root provider
turn before waiting on child-thread interrupts. This closes the source of new
serial spawns first. It then interrupts every supplied child thread whose
native handle is still available. The execution-local cancellation boundary
remains necessary for a child whose spawn was already in flight and becomes
visible only after the root interrupt.

Preparing the durable root cancel operation also closes child creation for
that root turn. This boundary exists before provider I/O starts and remains in
effect while the operation is prepared or leased. A child first revealed after
the target snapshot must be rejected by persistence even if its event races
ahead of the cancel completion transaction; otherwise it could escape the
recorded target set and remain active below a canceled root.

`services/tuttid` maps acknowledged child targets to `canceled`, maps
unacknowledged child targets to `interrupted` when the bounded provider call
returns, and always maps the root target to `canceled` to preserve the user's
intent. The durable cancel operation, every target transition, pending
interaction supersession, and outbox data commit together. Recovery replays
the same idempotent target set instead of assuming that an earlier provider
side effect completed. This keeps provider invocation recoverable without
introducing a child-agent run entity or making the runtime controller another
session authority.

A canonical `canceled` turn must not retain a transport error such as
`context canceled`. That message describes how a local runtime goroutine was
stopped, not a failed business outcome, and the activity event contract permits
turn errors only for `failed` or `interrupted`. Cancel completion clears such
errors atomically. Transport projection also omits an error from canceled turns
so historical dirty rows cannot wedge reliable outbox publication.

An exact child-only cancel uses the same durable target contract without adding
the root as a cancel target. If that child was the final active child and the
root provider outcome was already retained, the cancel transaction also settles
the root from that retained outcome. The outbox publishes both turn updates and
reconciles the root runtime view; it does not relabel the root as canceled.

Late child output after cancellation is allowed to arrive, but it is appended as
historical child-session progress only when it can be scoped to an existing
child session and turn. It must not clear the root cancellation or create a
new root turn. A provider terminal caused by cancel, such as Claude SDK
`task_completed(status=stopped)` followed by `tool_failed(user_interrupt)`, is
not historical progress: after the exact child target has been closed by the
cancel operation, the adapter drops that terminal projection rather than trying
to relabel the durable child as failed. The root outcome records the user's
cancellation intent and remains `canceled` even when one or more child provider
cancellations could not be confirmed. `interrupted` on those child turns records
the weaker provider fact without pretending that cancellation succeeded.

Provider adapters additionally keep an execution-local cancellation boundary
for the canceled root turn. It is routing state, not a second durable business
model, and a later explicit canonical root turn clears it. While active:

- a server-initiated root provider turn is interrupted instead of adopted;
- a newly revealed native child thread is interrupted without allocating or
  emitting a canonical child session/turn;
- output from the canceled root execution is dropped, while late output for an
  already durable child may remain historical child progress unless that exact
  child turn is itself a closed cancellation target;
- the matching root provider terminal is still normalized so persistence can
  close the provider lifecycle projection.

## Provider Adapter Contract

Each provider adapter normalizes native child-agent behavior into the existing
session, turn, message, call, and interaction events. Child creation is one
atomic session-and-initial-turn state transition. Progress, waiting, terminal,
and name changes then use the same event and state vocabulary as a root session
and turn. There is no parallel `subagent_*` lifecycle or status projection.

Each normalized event must carry:

- child `agentSessionId` and child `turnId` as the canonical event owner
- parent `agentSessionId`
- parent `turnId`
- parent tool call id when known
- root `agentSessionId` and root `turnId`
- provider-specific handles and aliases
- optional transcript payload or interaction payload

The adapter also needs command hooks:

- cancel a child session/turn by normalized identity
- cancel all nested child sessions for a root turn
- guide the root turn while child sessions are active, when supported

Provider-specific event routing stays inside the adapter. AgentGUI and
workspace engine projections consume only normalized session, turn, parent,
root, message, and interaction contracts.

## Codex App-Server Mapping

Native concepts:

- Root conversation: app-server `threadId` equal to
  `workspace_agent_sessions.provider_session_id`.
- Child agent: child app-server `threadId`.
- Spawn edge: `collabAgentToolCall` with `tool=spawnAgent` and
  `receiverThreadIds`.
- Control tools: `Wait` / `CloseAgent` style `collabAgentToolCall` entries.

Mapping:

- The spawn tool call creates one subordinate `WorkspaceAgentSession` per
  receiver thread id and a submitted child turn owned by that session.
- `threadId != root provider_session_id` events are child events only after
  the child thread has been registered from a spawn edge.
- App-server server requests use the same `threadId` ownership rule as
  notifications. An approval or user-input request emitted on a registered
  child thread is persisted against that child session and its canonical child
  turn; the provider `turnId` remains transport metadata and does not replace
  the canonical turn id. Requested, answered, superseded, and provider-resolved
  events all retain the same child owner and root/parent relations.
- A server request for an unknown non-root thread is rejected instead of being
  attributed to the root. Provider `serverRequest/resolved` notifications for
  registered children must reach the shared pending-request registry through
  the child target; they must not be discarded by child-notification filters.
- Unknown foreign-thread events must not update the root turn. They may be
  counted as early drops and reconciled if a spawn edge later registers that
  thread.
- Child session/turn parent and root fields are the only ownership contract. Remove
  `ownerThreadId` / `ownerCallId` projection paths; do not keep a parallel
  ownership structure.
- Child `turn/completed` maps to the corresponding child turn terminal. Root
  provider `turn/completed` maps to `root_provider_turn_completed`.
  `services/tuttid` applies the same root/child turn completion rule used for
  every provider; the Codex adapter does not hold or settle the root turn
  itself.
- Cancel interrupts the root thread and every nested child thread. The adapter
  interrupts only child threads named by the daemon-supplied target set; it
  does not independently enumerate linked children.
- After root cancellation, a later `turn/started` on the root thread is not an
  ordinary unowned turn: interrupt it immediately. A child thread first
  revealed by a late `spawnAgent` item is also interrupted immediately, but is
  not registered in the canonical child-thread map and emits no child
  session/turn creation events.

Known edge from current logs:

- A child thread can emit name/lifecycle events before `receiverThreadIds` is
  registered. The adapter must avoid starting a second root `WorkspaceAgentTurn` for the
  child provider turn id; early child markers should reconcile into the
  eventual child session/turn or remain diagnostics.

Guidance mapping:

- If the root provider turn is active, use app-server `turn/steer`.
- If no root provider turn is active but the root `WorkspaceAgentTurn` remains
  active because child turns are running, use app-server `turn/start` on the
  root thread and attach its events to the existing root `WorkspaceAgentTurn`.
- Do not create another root `WorkspaceAgentTurn` for either path.

## Claude Code SDK Mapping

The Claude continuation produced after a background child notification belongs
to the same canonical root turn. This is a product ownership rule, not an
assumption about native SDK event order. A live parallel-child run recorded the
final child terminal at `23:24:06.438`, its SDK task notification at
`23:24:06.442`, canonical root settlement at `23:24:06.447`, composer unlock at
`23:24:06.538`, and the root assistant continuation at `23:24:09.036`. The
sidecar-created synthetic provider turn did not start until `23:24:09.039`.
Therefore the adapter cannot wait for the root assistant message before
protecting the canonical root from settlement.

Native concepts:

- The root turn streams through the SDK session.
- Child agent work is represented by `Task` tool use, `parent_tool_use_id`,
  `task_id`, `agentId`, `TaskCreated`, `TaskCompleted`, `task_progress`, and
  `task_notification` variants.
- The root SDK turn may appear terminal while child agents are still
  running.

Mapping:

- A parent `Task` tool use creates a subordinate `WorkspaceAgentSession` and a
  submitted child turn, keyed initially by the parent tool-use id.
- The parent `Task` / `Agent` tool call remains owned by the session and turn
  that launched the child. Its started, updated, and terminal events must stay
  on that same parent turn even after the child session has been registered.
  Only tools and messages whose explicit `parent_tool_use_id` points into the
  child are child-turn events. For nested delegation, that explicit marker
  makes the launching child session/turn the direct parent.
- The child session and submitted child turn are emitted from the earliest
  parent `Task` tool-use event, before `task_started`, `TaskCreated`, or the root
  SDK `turn_completed` may arrive.
- Claude may reveal a generic tool name on the earliest event and provide the
  real description, prompt, or agent identity only on a later tool/task event.
  The adapter merges those later fields into the existing child session and
  emits an ordinary child session title update when the description becomes
  more specific. It must not create another child or move the parent tool
  completion into the child turn.
- A foreground `Task` may settle its child turn from the terminal parent tool
  result. An async/background `Task` does not settle from the launch tool
  result; it waits for the matching task lifecycle terminal.
- SDK task-system work that has no subagent launch result — most importantly a
  `run_in_background` Bash shell — announces itself only through `task_started`
  carrying a `tool_use_id` and `task_id`. The sidecar registers such an
  unclaimed task as delegated child work keyed by that launching tool-use id,
  so it gates the root turn, counts in the final-child continuation gate, and
  can be stopped individually. A task event without a launching tool-use id is
  not registered this way: it may be a racing alias for a not-yet-registered
  subagent launch, and binding it would poison the alias maps.
- Background task lifecycle events frequently arrive after the launching root
  provider turn already reached its terminal. The sidecar attributes them to
  the most recent turn instead of dropping them for lack of an active turn id.
- A terminal `task_notification` for a task the current sidecar instance never
  saw start — typically a task launched before a sidecar restart and reported
  as `stopped` on the next prompt — is registered and settled in one step so
  the child reaches a terminal state instead of the notice being dropped.
- `parent_tool_use_id` is the canonical child scope marker for nested messages.
- `taskId` and `agentId` are aliases. They must bind back to the existing child
  session/turn, never to "the only running task" when that would cross-bind
  concurrent children.
- Claude permission callbacks keep the provider turn id that owns the SDK
  callback even after `agentId` scopes the interaction to a canonical child
  session/turn. `submit_interactive` and `interactive_disposition` use that
  provider turn id for sidecar correlation; all durable and user-facing state
  continues to use the canonical child tuple.
- Scoping a Claude event to a child is atomic: the event's agent session id,
  child provider session id, session kind, root/parent relation, and turn id
  must all identify that child. A shared root runtime may deliver the event,
  but it must not emit a root-owned event decorated with child relation fields.
  This applies equally to provider-pushed resolution events and locally
  generated approval acknowledgment events.
- Child assistant messages are progress, not completion. Completion comes from
  child result, task notification, or SDK completion hooks.
- Child session/turn state is the only background-agent state. Remove
  `runtimeContext.backgroundAgents`; do not keep a parallel state projection.
- The root `WorkspaceAgentTurn` stays active while any nested child turn remains
  active, even if the SDK root provider turn produced a terminal event.
- The Claude SDK root `turn_completed` maps to
  `root_provider_turn_completed`, never directly to canonical root
  `turn.completed`.
- Claude Goal completion is a provider-native session metadata update, not a
  root-turn completion input. The SDK must be allowed to finish and return
  normally when it emits `turn_completed`, even when the canonical root remains
  `waiting` for a child.
- An adapter-generated Claude Goal command turn is internal control traffic,
  not a root provider turn. Its `turn_started`, assistant/thinking
  acknowledgement, and terminal event must not emit root-provider lifecycle
  facts or affect the canonical root gate. Goal/session updates still flow, and
  the terminal only releases the adapter's control-turn bookkeeping.
- A continuation caused by a child task notification is another root provider
  turn attached to the same canonical root `WorkspaceAgentTurn`. Its
  `synthetic-*` id remains a provider id; the adapter must not promote it into a
  `WorkspaceAgentTurn` id.
- When the final active async child is about to become terminal and no root
  provider turn is active, the Claude sidecar opens a synthetic provider turn
  before emitting the child terminal. This is a provider-specific ordering
  guarantee derived from the SDK task notification boundary. The generic
  `services/tuttid` root gate then remains unchanged: it observes a running
  provider turn when the last child becomes terminal and keeps the canonical
  root active.
- A `stopped` task terminal is the exception: a user-initiated stop needs no
  model follow-up, so the sidecar does not open the synthetic provider turn for
  it. The child settles, and the root gate resolves from the ordinary
  provider/child state without a reserved continuation or its timeout.
- Opening at the notification boundary reserves the provider lifecycle; it
  does not claim that Claude has already emitted assistant output. The sidecar
  waits at most 30 seconds for the first root stream or assistant event. Once
  root output begins, the timeout is disarmed and the provider turn follows its
  normal SDK lifecycle.
- If no root continuation begins within 30 seconds, the sidecar completes the
  reserved synthetic provider turn with a timeout stop reason and interrupts
  that pending SDK continuation. `services/tuttid` may then settle the
  canonical root from the ordinary provider/child gate. A later assistant,
  stream, result, or synthetic start from that timed-out continuation is stale
  and must be dropped by the Claude adapter; it cannot reopen the settled root
  or append output to a later canonical turn.
- A nested `Task` tool call belongs to its parent child session/turn. The new
  nested child session keeps the original root relation and records that parent
  child session/turn as its direct creator.
- Cancel stops the SDK root provider turn and every known child task/agent that
  the SDK can address.
- The synchronous adapter returning from `Exec` means only that the current SDK
  provider turn ended. The runtime controller retains the canonical active root
  turn until `services/tuttid` commits root settlement and reconciles it back.
- After the final child becomes terminal, `services/tuttid` applies the current
  root provider outcome only when no notification-reserved synthetic provider
  turn remains active. Claude Goal status is not re-evaluated as part of that
  settlement.
- Guidance always targets the root session. If no SDK root provider turn is
  active while child turns remain active, the sidecar may queue/fold in the
  guidance and open a `synthetic-*` provider turn; that continuation is attached
  to the existing canonical root turn.
- Guidance submitted during the notification wait remains part of the same
  canonical root and the same reserved synthetic provider turn. It does not
  create a new canonical turn or reset the 30-second hard wait boundary. If the
  boundary expires first, the pending continuation, including that guidance,
  is interrupted; a later user submission starts a new canonical root turn.
- Cancellation during the notification wait uses the existing root-query
  interrupt. It cancels the reserved synthetic provider turn, disarms its
  timeout, and follows the same durable root-plus-children cancellation
  operation as any other point in the root lifecycle. No timeout completion or
  late continuation may overwrite the canceled canonical outcome.
- Before sending that root-query interrupt, the Claude adapter records every
  exact `(agentSessionId, turnId)` supplied by `services/tuttid` as a closed
  projection boundary. Normal weak ordering remains supported: after an
  ordinary root provider completion, an active child may still report its own
  terminal. After targeted cancellation, however, late `stopped`,
  `tool_failed`, or equivalent events for a closed child are cancellation
  fallout and cannot emit a second child terminal or reclassify `canceled` as
  `failed`.
- Sending cancel is not a terminal fact. The adapter closes local in-flight UI
  streams, but root/child turns settle canceled only from provider confirmation;
  unconfirmed child turns use the generic interrupted timeout.

## ACP Provider Mapping

ACP does not currently give one guaranteed child-agent shape across providers.
Treat ACP as capability-driven:

- The current standard ACP adapter does not opt in. It does not infer child
  sessions from ordinary tool/progress updates and exposes no parallel
  background-agent runtime projection. Cursor and OpenCode therefore remain
  root-only until their ACP transports expose the required identity and
  lifecycle facts; a tool named `Task`, `Agent`, or similar is not enough.
- Cursor Agent `2026.07.01-41b2de7` also emits a private, non-blocking
  `cursor/task` extension containing `toolCallId`, `agentId`, task metadata,
  and optional duration after Task activity. This is stronger identity
  evidence than the ordinary Task card, but it does not supply one uniform
  child lifecycle. For a foreground Task, the extension follows the completed
  Task execution. For `run_in_background=true`, the Task result and extension
  acknowledge launch within the root prompt while the detached child continues
  running. Cursor records the later completion in its internal background-work
  registry, but this ACP version does not bridge that terminal back through a
  child event or a synthetic provider turn. Log only identifiers, field
  presence, enum/model values, durations, and text lengths; never log task
  prompt or description content.
- Until Cursor ACP exposes the detached child terminal, Tutti supports Cursor
  Task execution only in the foreground at the canonical-model level. Cursor
  Agent `2026.07.01-41b2de7` does not merge hooks from `--plugin-dir` into its
  ACP hook executor, so Tutti cannot currently enforce that restriction before
  launch without modifying user/project Cursor configuration. Runtimeprep keeps
  a tested `preToolUse` background-Task guard dormant, but deliberately omits it
  from the generated plugin manifest and runtime artifact. Do not claim that
  background Task is blocked, do not write the guard into user/project config,
  and do not invent a child terminal, keep the canonical root waiting, or
  settle from a guessed timeout when a detached Task is observed.
- An ACP provider may create child sessions only when it supplies a stable child
  id, the direct parent session/turn or parent tool-call id, and child turn
  terminal events.
- The parent/child link must be available early enough to persist the child
  session and submitted child turn before the root provider terminal is
  applied. If the provider cannot guarantee that ordering, its adapter must
  reconcile the explicit ids before emitting `root_provider_turn_completed`.
- Root provider terminal events map to `root_provider_turn_completed` and use
  the same `services/tuttid` root/child completion rule as Codex and Claude.
  Standard ACP adapters must not emit a canonical root `turn.completed`,
  `turn.failed`, or `turn.canceled` directly from the `session/prompt` result.
- Turn-scoped ACP message, thought, tool, and permission events are accepted
  only while their owning `session/prompt` call is active. A late notification
  after the prompt result must not be attached to a recently settled root turn,
  and the adapter must not fabricate a synthetic turn to make it persistable.
- If the provider only emits ordinary tool calls, display text, or progress
  without stable parent/child ids, treat them as ordinary tool calls, not child
  sessions.
- If the provider cannot confirm child cancellation, the generic cancellation
  timeout marks those child turns `interrupted` as already defined. Lack of a
  child cancel API does not justify a second completion model.
- Root-turn guidance support is declared by the provider. Direct user guidance
  to one child remains unsupported.
- Standard ACP cancellation is root-only. A failed `session/cancel` transport
  write is an operation failure, not provider confirmation; it must propagate
  to the durable cancel workflow instead of being reported as success.
- The same rule applies to automatic permission decisions: a failed ACP
  response write must be surfaced as an operation failure, never treated as a
  resolved approval while the provider is still waiting.

ACP adapters should not invent subagent identity from display text, tool title,
or message order alone.

The existing standard ACP `backgroundAgents` map and runtime-context projection
are removed. ACP providers that meet the rules above emit child session/turn
events directly; providers that do not meet them emit no child-session state.

## UI Projection

AgentGUI should render subordinate sessions under the parent delegation tool
card.

- Root transcript rows remain root-only.
- Child-session rows are lanes or nested progress sections under the
  spawn/delegate card. Nested child sessions follow recorded parent/root fields
  rather than being flattened into the root transcript.
- Spawn tool success means delegation was accepted, not that the child
  completed.
- Child terminal state comes from its canonical child turn, not from the parent
  tool call status.
- Display-only transcript rows must not become approval or prompt authority.
  Pending interactions remain daemon-owned canonical interaction entities on
  the exact child session and turn.
- The session detail reconcile loads the root plus every nested child session
  into the same workspace engine and loads messages through each session's
  existing message endpoint. It does not create a second child-session store.
- An interaction action routes by the exact child
  `(agentSessionId, turnId, requestId)` tuple. The controller uses the recorded
  root session only to find the shared live provider runtime.
- Historical rows that only contain `ownerThreadId`, `ownerCallId`, or
  `runtimeContext.backgroundAgents` are not reconstructed into the new model.
  Do not add dual reads, heuristic backfill, or parallel projection paths for
  those shapes.

## Open Questions

- Which ACP providers expose enough child-agent identity and cancellation
  handles to opt into this abstraction?

## Implementation Shape

Suggested order:

1. Extend the session contract with root/child kind and durable parent/root
   fields.
2. Make root turn settlement aggregate all nested child turns.
3. Adapt Codex app-server child-thread routing to create/update subordinate
   sessions and their turns.
4. Adapt Claude SDK task/background-agent routing to create/update subordinate
   sessions and their turns.
5. Project child sessions into AgentGUI lanes and remove the superseded
   `backgroundAgents`, `ownerThreadId`, and `ownerCallId` paths.
6. Add cancel and guide command paths that operate on the active root turn plus
   nested child sessions.

Validation should include concurrent children, early child events before spawn
registration, root terminal before child terminal, cancellation with late child
events, child creation racing a prepared root cancellation, a provider terminal
arriving after canonical cancellation, unowned provider turns after cancel,
child approvals, and user guidance while children are running.
