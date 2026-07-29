# Agent GUI Node Architecture

Status: current implemented architecture

This document defines the durable architecture of the Agent GUI system: ownership, dependency direction, core entities, critical flows, and change-routing rules. It is not an implementation plan, feature inventory, or troubleshooting log.

Scope:

- `packages/agent/host`: provider-neutral Agent application core
- `packages/agent/store-sqlite` and `store-sqlite/canonical`: canonical contracts and transactional local storage
- `packages/agent/daemon`: provider runtimes, adapters, and registry
- `services/tuttid`: HTTP, queries, product policy, and Host adapters
- `packages/agent/activity-core`: frontend workspace engine
- `packages/agent/gui`: Agent GUI, Message Center, and conversation presentation
- `apps/desktop`: Electron, Workbench, transport, and concrete host capabilities
- `apps/mobile`: React Native presentation, DeviceLink transport adapter, and
  mobile lifecycle integration

Implementation progress belongs in Git history or an active spec. Debugging procedures belong in [Agent Runtime Troubleshooting](../conventions/troubleshooting/agent-runtime.md).

## 1. Architectural taste

### 1.1 One fact, one owner

- durable lifecycle: `packages/agent/host`
- canonical vocabulary: `packages/agent/store-sqlite/canonical`
- canonical frontend state: workspace `AgentSessionEngine`
- DOM, focus, scroll, menus, and temporary disclosure: UI only

Do not solve cross-layer coordination by copying state. Consumers read projections/selectors and write semantic commands.

Device-global quick prompts are not Session or Turn state. AgentGUI consumes
the optional `AgentHostApi.quickPrompts` capability, preserves the host's
canonical list order, and delegates create/update/delete/move effects to the
host adapter. Reordering is presentation plus intent only: AgentGUI emits a
moved prompt, nullable `beforePromptId` anchor, and moved version; Desktop may
show an optimistic projection, while `tuttid` remains the durable order owner.
Hosts that omit the capability must hide the entire entry rather than expose a
partial or disabled library.

The native Mobile composer consumes the same device-global list through its
authenticated Desktop connection rather than creating Mobile-owned prompt
state. Its authenticated-device service reads the stored
`agent.quickPromptLibrary` desktop feature gate and the canonical quick-prompt
list through the generated tuttid client. When enabled, the Mobile `+` menu
offers a searchable, read-only selector; choosing a prompt adds its text at the
current plain-text input position without replacing the existing draft,
restores input focus, and never sends automatically. Create, edit, delete, and
reorder remain Desktop management actions. DeviceLink permits only exact
`GET /v1/preferences/desktop` and `GET /v1/agent-quick-prompts` reads for this
flow; mutation and per-prompt routes remain blocked.

Use the closed-surface test when assigning ownership: if state must survive or continue progressing after every Agent GUI surface closes, it belongs to Host/store or the workspace engine. State that should disappear with the surface belongs to UI.

### 1.2 Semantics before screens

Session, Turn, Interaction, Goal, and operation are domain facts. Rail, timeline, dock, toast, and Message Center are projections of those facts; they do not define lifecycle.

Transcript is historical presentation. It is not authoritative for approvals, questions, Turn state, or submit availability.

### 1.3 Ports and adapters

Core layers declare narrow contracts and ports. HTTP, Electron, filesystem, provider wire, authorization, VM, and process details stay in adapters.

A reusable boundary needs a real responsibility and consumer. Do not create vague `common`, `utils`, or `shared core` modules merely to look reusable.

### 1.4 Provider-neutral does not mean provider-blind

A provider adapter may understand its own wire protocol. Shared business code reads descriptors, strategies, capabilities, and canonical payloads.

AgentGUI, Message Center, composer, and shared services must not choose behavior by names such as Codex, Claude Code, Cursor, or OpenCode.

### 1.5 Events are hints; canonical reads reconcile

Realtime events reduce latency but are not automatically complete truth:

- normalized provider text/reasoning streams and explicitly appendable textual
  tool output arrive as optimistic `message_delta` payloads on the
  `/v1/events/ws` business-event WebSocket
- continuous, version-complete `message_update` events may merge inline
- terminal `message_update` is the durable confirmation; message version gaps,
  invalid/unanchored deltas, nonterminal deltas after known terminal message
  truth, reconnects, Turn, Interaction, and state changes trigger authoritative
  reconciliation
- event publication or observer failure cannot roll back a committed canonical transaction

### 1.6 Identity and correlation are explicit

Cross-boundary work uses stable identifiers:

- workspace: `workspaceId`
- session: `agentSessionId`
- Turn: `turnId`
- Interaction: `requestId`
- submit: `clientSubmitId`
- UI Agent: `agentTargetId`

Never infer identity from titles, timestamps, array positions, provider names, the latest transcript row, or runtime instance IDs.

### 1.7 Fail closed

When authoritative identity, capability, Turn, or Interaction is missing, return unsupported/loading/error. Do not choose the first provider, manufacture a Turn, treat an empty array as loaded, or hide contract drift behind a UI fallback.

Compatibility paths require evidence of existing data or a release window. Keep them isolated from canonical writes.

### 1.8 Contract first

Change OpenAPI before HTTP contracts, then generate Go and TypeScript types. Internal domain types cross layers through explicit projections; do not maintain handwritten transport mirrors.

Identity, time, and state use canonical representations. Unknown enum values produce an explicit unsupported/error path; widening them to arbitrary strings is not compatibility.

## 2. System shape

### 2.1 Command path

```text
AgentGUI / Message Center / host surface
  -> typed intent or AgentActivityRuntime command
  -> workspace AgentSessionEngine
  -> shared typed lifecycle effect projection
  -> Desktop or Mobile AgentSessionEffectPort
     (host-only commands use the narrow EngineExtensionCommand adapter)
  -> tuttid HTTP and product adapter
  -> packages/agent/host
  -> canonical store transaction + provider runtime port
```

### 2.2 Observation path

```text
provider runtime observation
  -> packages/agent/host + store-sqlite canonical transaction
  -> CommittedDelta / CommitObserver
  -> tuttid ActivityProjection and event publication
  -> Desktop business-event bridge or Mobile DeviceLink live lane
  -> workspace AgentSessionEngine reducer
  -> memoized AgentActivitySnapshot
  -> selectors / pure projections
  -> AgentGUI / Message Center / host chrome
```

### 2.3 Ownership map

| Layer                           | Owns                                                                                          | Must not own                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `store-sqlite/canonical`        | canonical phase, outcome, origin, Interaction, capability vocabulary, and pure projections    | HTTP, provider processes, React                   |
| `store-sqlite`                  | canonical transactions, SQLite repositories, durable tombstones/outbox participation          | product UI, transport policy                      |
| `packages/agent/host`           | create/resume/send/cancel/fork, lineage, Interaction, Goal, operation, and recovery lifecycle | HTTP DTOs, Electron, concrete provider wire       |
| `packages/agent/daemon`         | provider registry, runtime mechanics, wire normalization                                      | AgentGUI policy, cross-provider UI branches       |
| `services/tuttid/service/agent` | Host adapters, HTTP/query/composer/product policy, provider preparation                       | reimplementation of Host lifecycle                |
| tuttid `ActivityProjection`     | canonical read projection, commit observation, event publication/repair                       | lifecycle decisions, React state                  |
| `agent-activity-core`           | workspace engine, canonical frontend entities, pending intents, queue, selectors              | HTTP, Electron, React                             |
| `agent-gui`                     | runtime contract, projections, controllers, views, UI-local state                             | daemon truth, a second session store              |
| `apps/desktop`                  | tuttid client, business-event WebSocket, preload, Workbench, windows, file/OS capabilities    | a second Agent business core                      |
| `apps/mobile`                   | DeviceLink adapter, Native renderer, app lifecycle, navigation and drafts                     | a second Agent business core or Session DTO cache |

`services/tuttid/api/openapi/tuttid.v1.yaml` is authoritative for HTTP request/response contracts. It projects the canonical domain; it does not replace `store-sqlite/canonical`.

### 2.4 On-demand status

AgentGUI owns one provider-neutral `AgentStatusController` for `/status`, Agent
Info, and Agent Config. These surfaces are explicit bounded reads; mounting an
AgentGUI node must not start background status polling.

The host injects an `AgentStatusSource`. AgentGUI treats `scopeKey` as opaque
and never resolves provider, account, local-vs-remote transport, or owner
identity. The controller owns only loading/ready/error presentation,
30-second request cancellation, a one-hour retained UI snapshot, 5-second
manual-refresh debounce, and fencing callbacks from closed or replaced
requests. Opening any status surface uses the same controller snapshot so the
three views cannot drift into separate state machines.

Every production host, including Tutti Desktop, injects this controller. A
host adapter resolves the exact Agent Target to its provider, verifies an
optional Session belongs to the same workspace/target/provider, and performs
the bounded status read. AgentGUI has no legacy probe-backed status state or
provider-derived fallback. The active conversation id is the request Session
identity because it exists before detail hydration; raw Session chrome remains
presentation data.

Tutti Desktop creates one status source per workspace renderer and injects it
into every AgentGUI surface in that workspace. The source shares the one-hour
Provider snapshot, five-second refresh debounce, and in-flight Provider probe
by provider, while each surface keeps its own controller and therefore its own
query, loading, close, and stale-response state. Sharing the controller itself
is invalid because one surface could replace or close another surface's active
request. Standalone renderer processes have their own source; the Electron main
process remains the cross-window short-lived Provider cache.

A source emits at most one cached `snapshot` followed by at most one
`refreshed` value, then completes. Backend probing may continue independently
to fill a host-owned cache after the presentation request is canceled; late
frames from the canceled request must not mutate AgentGUI. Errors crossing the
port are structured codes, never provider stderr, account material, endpoints,
or transport diagnostics.

Closing `/status`, Agent Info, or Agent Config cancels only the request owned
by that surface. Replaced requests remain fenced. A stream that completes
without a frame is a failed refresh: a retained value may remain visible, but
the UI must show the refresh failure rather than treating the old value as a
new success.

Desktop availability analytics reads the renderer's loaded managed-provider
snapshot and must not turn a pageview or focus event into a daemon request. A
stale visibility snapshot may reconcile through a non-forced tuttid status
read; tuttid owns cache validity, credential-fingerprint checks, and
single-flight probing. Forced detection is reserved for explicit provider
refresh and the provider-scoped confirmation after an install, login, or
update action. A confirmed new-conversation creation failure is the only
analytics exception: Desktop force-refreshes only the exact target's provider,
then reports the fresh availability snapshot with a failure-specific trigger.

Cold workspace initialization may request all managed providers together so the
first useful snapshot arrives quickly. tuttid may detect different providers in
parallel, but it applies one process-wide limit to auth, version, and adapter
probe subprocesses because a single provider can otherwise fan out into several
CLI processes. Later visible-window stale reconciliation is best-effort
background work and checks providers serially; another focus cannot overlap the
same reconciliation run.

Provider detection separates volatile readiness from stable executable facts.
An ordinary read may reuse the full provider snapshot. A forced read bypasses
that snapshot and rechecks current authentication/readiness, including the
provider credential marker, but may reuse a successful CLI version or adapter
launch result while the resolved executable fingerprint is unchanged. Failed
version reads and failed adapter launches are never cached. OpenCode and
Tutti Agent use their validated local credential files as the primary auth
signal; malformed files may fall back to one CLI check. Cursor's single
`about --format json` result supplies both auth and version when available.

### 2.5 Developer cassette replay

The developer-only `agent.sessionRecording` desktop preference defaults off.
When enabled, Desktop injects its recording and replay controls through generic
AgentGUI render slots. AgentGUI contains no recording/replay API, controller,
state, provider branch, component, or copy.

`services/tuttid/service/agentsessionreplay` is the application owner for both
Recording and Replay Run state. Desktop reads its authoritative recording list
after mounting and projects commands; React state is never the source of an
active Recording or Replay Run. `packages/agent/daemon/runtime` retains only
the concrete recording and scripted replay transport mechanics.

A Recording captures a time window over the root SessionGraph. Root Turn
settlement, child creation, and Goal continuation do not complete it. Explicit
stop waits for a stable boundary, detaches every graph connection, and exports
expected graph state. Daemon restart recovery marks an interrupted capture
`incomplete` and exposes it through the same recording list.

The cassette runner drives these controls through a real Electron AgentGUI.
Replay mode keeps the current provider adapter but replaces only its Agent
SessionGraph `ProcessConnection` set; current adapter outbound bytes must match
the recorded Session/provider/launch-ordinal connection before inbound frames
are released.
The Desktop feature
`apps/desktop/src/renderer/src/features/agent-session-replay` owns the recording
toolbar, recording list, replay-window controls, feature gating, product copy,
and daemon client adapter. Recording names default to their UTC creation
timestamp. A completed row supports inline rename; the daemon writes the name
into `cassette.json`, recalculates the manifest hash, and commits matching
Recording and Cassette metadata. A completed recording exposes Play directly
in its list row; selecting a recording is not a domain or UI state. The primary
workspace window never renders Replay pause or checkpoint controls. Those
controls belong only to the isolated Replay Electron surface and become enabled
only when the daemon core exposes the corresponding stable commands; the UI
must not simulate them by dropping chunks or changing a local cursor.

While a Recording is active, Desktop observes the workspace
`AgentSessionEngine` boundary rather than AgentGUI. Public replayable intents
enter a synchronous renderer buffer; matching external command settlements
become `effect` events linked to the intent that caused them. Reducer-generated
follow-up intents are not recorded a second time, and effects without a
recorded cause are discarded. Desktop flushes this ordered stream through the
recording API before asking the daemon to complete the Recording, and drops the
buffer after a successful cancellation. AgentGUI remains unaware of recording
and replay contracts.
The isolated Replay surface may reuse the Workspace window composition.
Desktop mounts status observation and playback controls through AgentGUI's
composer footer slot, while Replay runtime state keeps it empty in normal windows.
Replay speed is a daemon-owned command. The isolated surface reads and updates
it through Desktop IPC; ordinary Workspace and standalone Agent windows hide
the control when the daemon reports that Replay playback is unavailable.
Pause, resume, and checkpoint movement use a versioned
`replay-control.json` handoff at
`TUTTI_AGENT_SESSION_REPLAY_CONTROL_PATH`, because pausing only the provider
transport would still allow the runner to dispatch later business stimuli.
The runner publishes the reached checkpoint and playback mode beside phase in
`replay-status.json`; Desktop observes that file but does not manufacture
playback state in React.
The primary window owns only Replay launch feedback. The cassette runner writes
Replay, verification, success, or failure status into its isolated runtime, and
the isolated Electron surface reads that status through Desktop IPC. A failure
after the target Session is visible keeps the isolated window open; the primary
window does not render its completion or verification result. That failed
surface continues accepting restart, previous-checkpoint, and Cassette
replacement commands. Pause, next-checkpoint, and speed remain disabled because
there is no active playback transport to control.

The runner uses isolated daemon state and Electron `userData`. CDP opens
AgentGUI, selects the provider and exact Session, and verifies the rendered
result. Recorded business stimuli are sent through the isolated daemon HTTP
contract; they are not reconstructed from composer clicks. Cassette transport
selection is daemon composition and does not change Session, Turn, Interaction,
Goal, or runtime-operation lifecycle ownership in Host. The isolated Workbench
snapshot records onboarding as already auto-opened without restoring any nodes,
so the runner can open only AgentGUI. Create-session stimuli persist the
effective launch settings returned by the recorded Session; Replay must not
recompute model, reasoning, permission, or speed defaults from the current
machine. The runner preserves lifecycle ordering by waiting for the canonical
Session to become idle before dispatching each recorded `session.send`; HTTP
status retries are not lifecycle authority.

Managed Replay launch has two distinct milestones. `surface-ready` means the
isolated AgentGUI has selected the exact replay Session; it closes launch
feedback but does not complete the Replay Run. `replay-complete` is emitted only
after every stimulus, transport check, and expected-state check succeeds, and
only that milestone may move the Replay Run to `complete`. A create-session
Replay restores its recorded rail Project into the isolated User Project
catalog, waits for the create command to return, reloads the AgentGUI
projection, and selects the exact canonical conversation row before later
stimuli run. It does not wait for the first Turn's outcome or its notification
before exposing the created Session.

## 3. Domain model

### 3.1 Session

A Session holds identity, target, provider metadata, cwd, title, settings, resume information, a Goal reference, and the current active Turn reference.

A Session does not copy Turn phase/outcome, own pending Interactions, or persist lifecycle inferred from transcript.

Provider-native subagents use child Sessions:

- `rootAgentSessionId` / `rootTurnId`: root execution
- `parentAgentSessionId` / `parentTurnId`: direct parent
- `parentToolCallId`: delegation card correlation
- child messages, Turns, and Interactions retain the child owner

A provider adapter must normalize explicit spawn evidence into both the parent
delegation call and the canonical child Session/Turn. AgentGUI attaches the
child lane only through the immutable `parentToolCallId`; it must not parse
provider-native spawn events, invent a missing parent card, or create a
presentation-only child lane.

User-initiated Fork creates a new root Session rather than a provider-native
subagent. The child records durable lineage to the source Session and inclusive
boundary Turn, but receives a caller-reserved canonical Session id and a
provider-created Session id. Canonical Session, Turn, Message, and Interaction
identities are session-scoped and are remapped during the atomic clone.

### 3.1.1 Session Fork

`throughTurn` means the boundary Turn and all earlier canonical history are
included. AgentGUI emits only the canonical Turn id. Host resolves its durable
provider root Turn id and invokes the exact provider adapter selected by the
runtime registry; shared UI and Host code never branch on provider names.

The projected Session capability is an exact, fail-closed provider/runtime
conjunction:

```text
provider registry declares native Session Fork
  AND the exact adapter/version attests throughTurn support
  AND product-owned Session context can be transferred safely
  AND provider state has an explicit host-copy or provider-owned binding mode
```

Only that conjunction projects `lifecycleCapabilities.forkThroughTurn=true`.
The Codex adapter reads the initialized version from an exact live process when
one exists. For a historical, detached, or newly forked Session it performs one
cached short-lived initialize probe against the same resolved adapter/runtime;
that probe neither resumes the provider thread nor creates a canonical Turn.
AgentGUI renders an action only when the capability response contains a known
canonical Turn-id allowlist and the settled root Turn is in that list; an
unknown or absent list is fail-closed. Boundary availability is deliberately
separate: execution
transactionally rejects an unverified prefix, descendant lane, or
session-scoped local attachment. This prevents a later unavailable Turn from
hiding an earlier valid Turn while preserving a fail-closed commit.

Tuttid currently rejects worktree-isolated sources at the Session capability
layer. A provider-native thread Fork keeps the provider cwd; copying the
source worktree ownership or silently selecting another checkout would be
incorrect. Non-isolated stable runtime facts are frozen into the target
snapshot. Session-scoped local attachments are also fail-closed until a
versioned through-Turn resource manifest and atomic resource binding exist;
the implementation never copies the whole source attachment directory.

Fork is a durable Host-owned saga:

```text
prepared -> dispatching -> provider_accepted -> committed
                  \-> unknown
           \-------------------------> failed
```

`requestId` is the caller-stable replay identity and
`targetAgentSessionId` is reserved at prepare. The prepared snapshot freezes
the source provider Session, provider Turn boundary, driver kind/version, and
canonical prefix proof. A source Fork fence prevents reporting, goal/runtime
mutations, deletion, or another Fork from changing that source while provider
and canonical state are being matched. The provider call begins only after the
`dispatching` marker commits. Once provider acceptance is known, all
checkpoints and the local clone use a detached bounded context so an HTTP
disconnect cannot lose the child identity.

Before `provider_accepted`, Host requires typed binding evidence. `host_copy`
requires a configured binder that explicitly supports the source provider;
otherwise capability is unavailable and a direct request is rejected before
provider dispatch. A binder failure after provider acceptance is `unknown`,
never an implicit success. Codex validates every JSONL record plus the accepted
child `session_meta.id`, verifies source/target size and SHA-256, and atomically
copies only that rollout from the source run-scoped `CODEX_HOME` into the
target run-scoped `CODEX_HOME`. File and directory fsync make the rename
crash-durable before the Host checkpoint where directory fsync is supported;
Windows retains file fsync plus atomic rename because its portable filesystem
API does not expose directory fsync. The target therefore owns resumable
provider state independently of source cleanup. Claude uses `provider_owned`:
the official SDK writes the child into its shared session store, and the
short-lived sidecar proves it is independently readable with `getSessionInfo`
and `getSessionMessages`. It returns a verification receipt plus the
source-to-child provider Turn UUID mapping. Store persists that evidence at
`provider_accepted` and rewrites cloned Turns to the child UUIDs in the
canonical commit.
Claude's official `forkSession` allocates the provider child UUID, so this
driver does not attest deterministic provider identity. Host still reserves a
deterministic canonical target Session ID, dispatches the provider mutation
once, and fails closed without replay when delivery becomes `unknown`.
For live Claude Turns, a daemon-generated prompt UUID is correlation only:
Claude Code may rewrite it before persisting the transcript. The sidecar binds
provider Turn identity from the observed root user-message UUID and emits
`provider_turn_started`; the daemon must not publish canonical provider
identity before that observation.
Binding failure becomes `unknown`; Host neither commits the canonical child nor
reissues `thread/fork`.

`provider_accepted` recovery retries only the atomic local clone, never the
provider call. A crash in `dispatching` becomes `unknown` and is never
automatically redispatched. On startup, a `prepared` operation is safely marked
failed because its durable state proves provider dispatch never began; this
releases the abandoned source fence and target reservation without requiring a
live runtime. Terminal `unknown`, `failed`, and `committed` states release the source fence.
The canonical commit re-proves the frozen prefix, clones the inclusive history
and lineage in one transaction, and emits the complete committed delta.

### 3.2 Turn

One user submission or provider continuation belongs to one canonical Turn.

```text
submitted -> running -> waiting -> running -> settling -> settled
```

Terminal outcome is independent from phase:

```text
completed | failed | canceled | interrupted
```

Cancellation targets an exact Turn. `cancel_requested`, provider confirmation, and canonical settlement are distinct facts; UI must not manufacture an early terminal outcome.

### 3.3 Interaction

An Interaction represents an approval, question, or plan confirmation that requires user handling:

```text
pending -> answered | superseded
```

Actionable UI reads canonical pending Interactions only. A transcript tool row showing `waiting_input` does not create answerable state.

A child Interaction may appear in the root conversation, but submission carries the exact `(agentSessionId, turnId, requestId)` tuple.

### 3.4 Goal and operations

Goal is a Session-level durable entity, not a Turn command. It owns desired/observed state, revision, and an independent operation.

A Goal operation may produce zero or more provider Turns, but it cannot reserve or fabricate Turn IDs. Goal control bypasses the prompt pipeline and does not create a user transcript Turn message. AgentGUI may project its durable session audit as a dedicated `goal-control` timeline row; that row has no Turn ID and does not participate in Turn counts, processing ownership, cancellation, or settlement.

When a session-level timeline row occurs chronologically between two rows from
the same Turn, transcript presentation keeps one Turn group and renders the
session-level row as an interstitial item. This presentation grouping does not
assign the row a Turn ID or make it lifecycle-owned by that Turn.

Host owns recovery for runtime operations, Goal operations, and the reconcile inbox. An adapter must not start a second worker or state machine.

On daemon restart, Host recovery first restores durable operations, then settles unrecoverable active Turns as `settled/interrupted` and supersedes pending Interactions.

Codex's restored Full access warning is presentation-only, device-local safety chrome. Show it only when an empty home composer restores an unacknowledged Full access target default; do not show it for another provider or permission mode, an active or historical Session, or while defaults are loading. Explicit Full access confirmation and “Don't show again” persist the same browser-local acknowledgement, while the close action affects only the current mount. This acknowledgement must not enter Session lifecycle, target defaults, Workbench node data, or `AgentActivityRuntime` state.

### 3.5 Messages and ordering

A durable message has two independent ordering values:

- `sequence`: presentation order assigned at creation; streaming updates do not change it
- `version`: per-session mutable change cursor used for incremental updates and gap detection

Lifecycle timestamps describe occurrence time; they do not replace durable sequence. A live message with unknown Turn ownership must be completed or rejected at the boundary, never assigned an owner in GUI.

Neither value is a history-coverage signal. A newest-to-oldest message read
projects an explicit Session message window into the frontend engine:
`oldestLoadedVersion` is the next paging cursor and the response's `hasMore`
becomes `hasOlderMessages`. AgentGUI may request an older page only from that
authoritative window. It must not infer older history from a non-one minimum
version, a version gap, `sequence`, timestamps, or transcript shape; streaming
updates can raise a message version without creating any older row.

The same rule applies to imported transcripts. When the provider transcript
contains trustworthy user-message boundaries, the import adapter persists
stable settled Turn identities before the data reaches AgentGUI. A page that
starts midway through a long imported Turn must therefore retain that Turn id;
AgentGUI must not depend on the leading user message being present in the
currently loaded window. Imported content before the first trustworthy
boundary remains explicitly session-scoped.

## 4. Workspace frontend engine

One `(workspaceId, runtime origin)` maps to one `AgentSessionEngine`. Panel unmount, Workbench node reconstruction, and standalone window switching must not change its lifecycle.

The engine owns:

- canonical Session, Turn, Interaction, and Message indexes
- pending activation/submit intents and optimistic projections
- prompt queue, send-now, and cancel-then-send coordination
- session mutation, settings, composer options, and operation state
- workspace/session reconciliation state
- ephemeral per-Session runtime command availability projected by the host
- attention/read state and cross-surface selectors

The engine does not own daemon persistence, provider transport, DOM, or permanent UI layout.

When a model change invalidates canonical context-window usage, AgentGUI keeps
the last rendered usage for that exact Session visible until a fresh canonical
usage value arrives. This retained value is presentation-only: it is keyed by
Session, never crosses into another conversation, and is never written back to
the workspace engine.

Runtime command availability is session-scoped whenever one workspace engine
can contain Sessions backed by different transports. The host projects
`available`, `transport_reconnecting`, or `transport_unavailable`; the engine
uses that single fact to gate sends, cancellation, settings, and Interaction or
plan responses. AgentGUI preserves the composer draft content but disables
editing and runtime-dependent actions, and keeps an active Stop control visible
but disabled until the transport recovers. It must not reuse the engine-wide
connection state for this case, because one remote Session losing its owner must
not disable Local Agent or another remote Session.

Mobile projects pending Interactions from the root conversation plus its child
Sessions and reads each exact Engine response record for submitting/failure
state. Native cards dispatch semantic response intents only; they do not keep a
parallel Promise lifecycle. Missing provider-authored Plan options fail closed,
and runtime unavailability disables the exact response without discarding
composer drafts or Interaction identity.

Device connection presentation is target-scoped rather than Session-scoped.
The host exposes a target connection source keyed by `agentTargetId` with the
current status and retry attempt, and AgentGUI reads the active conversation
target or the selected Home target. This lets a new-conversation composer show
and enforce connection state before any Session exists. Session runtime
availability remains the independent command safety gate for existing
Sessions; it is not the source of device connection presentation.

AgentGUI projects a blocked target connection through the chrome above the
composer and gives it precedence over other recovery, approval, or prompt
notices because those actions cannot complete while the target is blocked.
An explicitly terminal `unavailable` state appears immediately. Initial
`connecting` appears only after a 300-millisecond controller delay so short
background connections do not flash. A recoverable host retry, including a
dormant low-frequency retry, remains a neutral `connecting` presentation and
updates the visible retry attempt without restarting the delay. During the
initial delay, the raw target state already blocks commands, but AgentGUI keeps
the existing recovery, approval, or prompt chrome visible until the connection
notice replaces it. Recovery removes the notice without a success banner. The
notice does not offer a manual retry because transport recovery is host-owned.

Session presentation derives one canonical Composer gate from target
connection, Session runtime availability, provider readiness, ownership,
activation, Interaction, and busy/queue facts. The gate is one atomic
projection with separate editor, submission, and runtime-command decisions;
AgentGUI must not place `canSubmit`, target-connection blocking, or
Session-runtime blocking in independent memoized view slices and recombine them
later. The editor, send action, keyboard submit paths, Stop availability, and
Interaction submission consume that same gate snapshot. Busy work may project
queue submission while keeping the editor editable. Draft emptiness, upload
progress/failure, project existence, and other draft-local conditions may
disable submission, but must not change editor editability.

### 4.1 Read/write rules

- reads use exported selectors or memoized `AgentActivitySnapshot`
- an engine subscriber notification is an invalidation signal, not a render
  command. Concurrent AgentGUI surfaces subscribe through exact
  Session-family or target selectors; a selector preserves its selected
  reference when another root Session changes
- whole-workspace `AgentActivitySnapshot` projections remain valid for bounded
  aggregate reads, but do not belong in high-frequency AgentGUI render paths.
  Event callbacks that need current canonical data read the engine snapshot at
  event time instead of retaining a whole-workspace render snapshot
- lifecycle writes use typed intents/commands
- the Engine alone translates shared activation, prompt send, settings update,
  turn cancel, Interaction response, pin, and batch-delete commands into
  `AgentSessionEffectPort` calls. Desktop and Mobile implement those semantic
  methods and must not duplicate a command-type switch for them. Platform-only
  commands remain in each host's `EngineExtensionCommand` adapter. Every effect
  propagates the Engine-owned AbortSignal to its transport; a required settings
  precondition rechecks cancellation before prompt send
- consumers do not read reducer maps directly
- consumers do not create canonical session/message mirrors
- optimistic records define confirmation, rejection, timeout, and uncertain-delivery paths
- business command completion returns to the engine as a result intent; controllers do not rebuild lifecycle with Promise/effect chains

### 4.2 Historical pull and realtime push

- list/history reads use `session/snapshotReceived` and do not create unread completion
- newest-to-oldest reads attach their authoritative message-window coverage to
  the same snapshot intent; incremental/realtime updates preserve that coverage
- realtime authoritative entities use upsert intents
- an authoritative Session detail result enters through
  `session/detailSnapshotReceived`; `agent-activity-core` expands the root
  Session, Turns, child Sessions, and optional message coverage in one engine
  drain and one subscriber notification. Desktop and Mobile use the same
  `@tutti-os/agent-activity-tuttid-adapter` aggregate mapper and must not
  dispatch each entity independently
- Desktop and Mobile execute Engine-owned `session/reconcile` commands through
  the same activity-core Session reconcile executor. The executor owns scope,
  cursor/window, pagination, double-detail race closure, cancellation/deletion
  fences, and atomic application; hosts own transport, DTO mapping, diagnostics,
  polling, and presentation side effects
- every daemon Session response carries the required `messageVersion`
  high-water cursor. Daemon and renderer ship as one protocol unit, so the
  shared adapter rejects a missing or invalid cursor instead of fabricating
  zero or entering a compatibility read path
- Desktop and Mobile use the same host-neutral event-observation helper to
  decide whether normalized entities can apply inline and whether the exact
  Session needs an authoritative state or message reconcile; partial parsing,
  identity mismatch, count mismatch, or cursor disagreement always reconciles
- message updates fold inline only when unseen versions are continuous
- version gaps and reconnects trigger incremental message reconciliation for hydrated Sessions
- Turn, Interaction, and legacy state invalidation trigger authoritative Session reconciliation
- realtime provenance survives until the authoritative result reaches the engine; fetch failure must not downgrade it to historical

### 4.3 Root and child hydration

Workspace lists show root Sessions only. A root detail read also returns nested child Sessions; the engine stores every entity, Rail selects roots, and timeline/Message Center selectors aggregate descendants.

Child Session discovery does not require every host to prefetch child transcript
pages. A surface that does not render child conversations keeps the hierarchy
and pending Interaction state canonical without paying for unused child message
history.

The shared reconcile executor exposes an explicit message-hydration policy.
Desktop selects Session-hierarchy hydration for its aggregate projections;
Mobile selects requested-Session hydration while it does not render child
transcripts. The first read remains a bounded newest-first page. Later detail
reconciliation compares each hydrated Session's required `messageVersion` with
the largest locally cached durable message version; an unchanged child performs
no message request. Newly discovered children use the bounded newest-first
read, while already hydrated children that advanced use incremental reads. A
known empty child window is an authoritative durable cursor at zero, so its
first later messages are drained incrementally from `afterVersion=0`; it is not
treated as an unknown window. The second detail read catches a root or child
that advances while the first message pass is in flight. Transient optimistic
rows never advance this cursor. This child policy is separate from the root
conversation's user-boundary repair policy, which may intentionally restart an
incremental read at zero.

The discovery detail request uses the daemon's `messageHydration` projection.
That projection retains the hierarchy and `messageVersion` cursors needed by
the shared executor but does not resolve provider-backed lifecycle
capabilities. The final detail request uses the full projection and is the only
read in one combined reconcile that may perform a historical provider
capability probe. Desktop and Mobile derive this choice from the same
activity-core request purpose; host adapters must not infer it from timing or
add a TTL cache for capability results. The detail response echoes the selected
projection and an explicit lifecycle-capability projection flag. The shared
tuttid client rejects mismatched responses, and consumers must not treat
false-valued capabilities from an unresolved hydration projection as
authoritative.

A `waiting` Turn does not imply user action. Only a pending Interaction produces approval/question attention.

### 4.4 Prompt queue

The busy-session prompt queue is ephemeral durable-intent coordination in the workspace engine. It is neither a daemon queue nor component state.

- a normal prompt waits for canonical availability
- a provider with native guidance capability may guide the active Turn
- otherwise send-now performs exact cancel-then-send
- user Stop pauses the queue; cancellation must not leak the next prompt
- a visible failed queue entry continues to own its submitted content for retry;
  draft settlement must not duplicate that content back into the composer
- uncertain delivery reconciles by `clientSubmitId` and exact `turnId`; it never resends merely because the Session appears idle
- editing a queued prompt restores its stable attachment references, then rehydrates missing image previews through `AgentActivityRuntime` with the exact workspace and Session identity; renderer-inaccessible paths never become image URLs, and late reads may update only the matching restored draft image
- the delivery barrier serializes new-Turn sends only; a guidance head steering the running barrier Turn is exempt and may steer it repeatedly, while in-flight, uncertain-delivery, suspension, and failed-head blockers still gate guidance sends
- drain readiness is one pure decision over the queue record and canonical availability; a new blocker joins that single decision with an explicit priority against every existing blocker, never as another independent pre-check in the drain path

### 4.5 Rail query and presentation state

The headless `AgentGUIConversationRailQueryController` is the single
cross-platform owner of Rail query scope, first-page refresh, cursor
pagination, stale-request fences, membership reconciliation, and Engine
ingestion. Desktop and Native Mobile both construct it through
`createAgentGUIConversationRailQueryController`, the canonical factory
exported by `@tutti-os/agent-gui/conversation-rail-controller`; a host must not
instantiate the internal implementation or recreate that state machine in its
app layer.

The Rail query cache stores section metadata, ordered Session IDs, cursors, and
totals only. Each first-page or pagination response passes Session DTOs
transiently through the host mapper into Engine upserts, while the Rail
snapshot retains only memberships, ordered IDs, cursors, totals, loading, and
failure state. Refreshing a bounded Rail page is not deletion evidence and
must not replace or prune canonical Engine entities.

The public headless snapshot contains query and membership state only.
Desktop-localized conversation summaries are projected from the snapshot plus
canonical Engine state outside the controller, so the Native entrypoint does
not depend on Desktop presentation or locale bundles. The public factory
accepts only the Engine, active-conversation identity getter, canonical runtime
queries, workspace identity, and small scheduling/page-size ports; cache
records, diagnostic trackers, and request-generation seams remain package
internals. Surface identity such as a Desktop AgentGUI `nodeId` is
adapter-owned diagnostic context: the Desktop runtime adapter enriches
diagnostic payloads instead of passing it into the headless controller
interface.

Resolved query results may be reused from the workspace cache. In-flight
first-page entity payloads are controller-generation scoped and must not be
shared across mounted controllers: detach, pause, or a scope change must fence
both Engine ingestion and cache writes from the obsolete request.
The canonical factory owns one resolved-query cache per workspace Engine, so
Desktop and Mobile receive the same remount semantics without exposing cache
access through `AgentActivityRuntime` or a host adapter.

Hosts own the transport adapter, DTO mapping, runtime-availability policy, and
surface lifecycle. For example, Mobile owns disconnected polling and
foreground/background pause-resume around the shared controller. Native hosts
also own their renderer, localized status projection, and interaction layout;
those host concerns must not leak back into the shared query controller.

Cross-platform hosts may reuse the DOM-free canonical Rail summary projection
from `@tutti-os/agent-gui/conversation-rail-projection`. They must still obtain
ordered membership, project labels, totals, and cursors from the authoritative
section query and join those IDs to canonical engine Sessions. Native hosts own
their renderer and interaction layout; they must not import Desktop or Web
components, infer project membership from `cwd`, or create a second Session
lifecycle store.

Cross-platform hosts may also reuse the DOM-free canonical transcript
projection from `@tutti-os/agent-gui/conversation-projection`. It accepts the
canonical activity snapshot, selected Session id, and known Turns. The
projection derives both the Session and its messages from that one snapshot,
hides intermediate AgentGUI activity-card/timeline-item construction, then
returns the same `AgentConversationVM` that AgentGUI renders for message
merging, thinking, tool groups, processing, notices, and turn summaries. Its
portable navigation resolver covers only external URLs and Agent Session
mentions and depends on focused host-neutral parsing primitives shared with the
broader Workspace resolver; file, local-asset, app, issue, and custom-mention
actions remain host capabilities. Projection code in this entry must depend on
focused pure helpers for persisted pasted-text presentation and file-path
validation; importing the interactive Composer model or the broad Workspace
link resolver would pull Web-only editor, UI System, issue, and file-manager
types into Native consumers. Native hosts own their renderer, localized
fallback copy, scroll position, and temporary disclosure state; they do not
reinterpret raw message kinds or import the DOM transcript. Approvals, Plan
choices, and questions remain canonical pending Interactions, are projected
through the shared Interaction-to-Prompt seam, and continue to submit exact
option ids through semantic Engine commands rather than through transcript
rows.

Cross-platform hosts may reuse the DOM-free Composer policy from
`@tutti-os/agent-gui/composer-projection`. Composer-option loading remains an
`AgentSessionEngine` command keyed by the exact Agent Target; the generated
tuttid DTO is mapped once by `@tutti-os/agent-activity-tuttid-adapter` into
`AgentActivityComposerOptions`. Hosts render provider-authored options and use
the shared support projection, but keep Native/DOM menus and temporary open
state local. Existing-session setting changes enter the engine as
`session/settingsUpdateRequested`; new-session draft settings travel on the
activation intent. A renderer must not call the settings endpoint from a
component or invent a provider-specific settings schema.

An activation intent's shared Session settings are not an HTTP create-field
allowlist. Each host must construct a typed
`CreateWorkspaceAgentSessionRequest` and forward only fields present in the
generated contract. In particular, `computerUse` is a default-on runtime
setting but is not currently a create-request field; Mobile must not add it as
an extra property. Supporting an explicit first-Turn opt-out requires changing
OpenAPI and the create adapter first.

Desktop and Mobile construct the headless controller through
`@tutti-os/agent-gui/conversation-rail-controller` and supply its narrow
query/diagnostic runtime port. The shared factory owns the workspace-scoped
cache lifetime while transport adapters own only protocol mapping,
authorization, and host-specific diagnostic context. Hosts that expose the
full AgentGUI mutation surface additionally install the complete query/mutation
cohort from `@tutti-os/agent-gui/conversation-rail-runtime`. Batch deletion
requires both authoritative section candidate lookup and the batch mutation.
AgentGUI fails that paired capability closed when either method is absent, so
the view cannot expose an action that will resolve to an empty optional-method
path.

Conversation deletion is transactional from the renderer's perspective. The
canonical delete command must succeed before AgentGUI clears the active
Session, changes Rail selection, unactivates runtime state, removes rows, or
discards local drafts. The same rule applies to batch deletion: a protected
Tutti execution conflict leaves the whole selection and local collection
unchanged. The conflict parser recognizes only the daemon's typed
`tutti_execution_active` payload; archive/view commands remain an optional
host capability until the generated execution adapter is present.

The full first-page query is the only Rail read that resolves a navigation
scope and clears its pending state. Targeted section refresh and pagination may
update only an already-resolved matching scope. A subordinate result must not
cancel the full query, publish partial membership for an unresolved scope, or
unlock Rail interactions.

Presentation-invisible Sessions remain canonical engine entities and stay
available through exact Session selectors for trusted open, reconcile, and
command flows. Plural consumer selectors exclude them before Rail and Message
Center collection projection; a hidden Session must not become a list row just
because it is resumable or receives later canonical updates.

When runtime sections are enabled, projection unions IDs from the current section, search, and reconciliation, then joins canonical Sessions. Unchanged summaries preserve structural sharing so unrelated engine updates do not rebuild the whole Rail snapshot.

Scroll, section collapse, visible limits, and search query belong to mounted view scope. Non-search state is isolated by `workspaceId + agentTargetId/all`; search creates a temporary navigation scope. `activeConversationId` expresses selection only. Scrolling requires an explicit reveal intent.

On the Home composer, a single-Agent Rail filter follows the effective composer
Agent Target whether the change originates inside AgentGUI or from host-owned
node data. The `all` filter remains broad, an open Session keeps its current
Rail filter, and unresolved/loading targets neither rewrite presentation state
nor expose placeholder target labels in Home chrome.

Rail scroll memory is captured by scroll events and explicit navigation. Effect cleanup must not synchronously read `scrollTop`: React may already have dirtied the document, turning that read into a full layout inside the interaction task.

An empty bounded Rail result must not unactivate an active or persisted Session.
Only an explicit Agent target selection may move the detail to that target's
Home composer.

Contain selection and presentation identity at the Rail boundary. Each section receives the active ID only when it owns the canonical or overlay row; unrelated sections receive `null` so their memoized props remain equal. Rail pane, section, and row receive a dedicated Rail-label projection whose identity changes for locale changes, not provider-specific detail copy. Event handlers shared by every section keep stable identities and read the current scope and lock state when invoked.

Keep section header/action chrome independent from changing item collections. A memoized header receives scalar presentation fields and stable event-time actions; it must not receive the section object or rebuild project/session semantics. Split the header into narrow render islands. Frequently changing derived booleans such as project drag disabled, project action locked, and batch deletion disabled may cross the Section presentation boundary through separate primitive Context projections. The Rail pane owns those providers outside the memoized Section so a projection-only update does not execute item projection; only the frame, forwarded-ref button leaf, or open menu content that renders the value may consume it. Do not combine those values into one Context object or copy them into persistent state. Menu disclosure is view-local state. A conversation row keeps its context-menu root mounted so right-click remains immediate, but may defer its normally hidden direct actions and dropdown root until the row is first hovered, focused, or opened by context menu. Once activated, those controls stay mounted for stable focus and keyboard behavior. Portaled menu content exists only while that menu is open, and a closed menu has no availability-state consumer. The project header remains the native drag source, each project section updates the insertion position across its full area, and the Rail scroll viewport owns the final drop so section gaps cannot discard an already visible insertion target. This is a presentation boundary, not a second Rail or lifecycle store; stable event-time guards remain authoritative for action delivery.

Relative time uses one renderer-realm minute clock. Timestamp leaves subscribe
directly; do not thread a tick prop through Rail pane/section/row and rerender
the interactive subtree every minute. Fully occluded AgentGUI surfaces do not
subscribe to that minute cadence. They retain the last clock snapshot while
hidden and refresh from current time when visual exposure resumes.

### 4.6 Detail and transcript

Rail selection, detail hydration, older-page loading, and transcript projection are separate states.

Desktop and Mobile use the same renderer-neutral AgentGUI conversation-message
controller for focused detail message queries. Initial hydration and latest
refresh enter the Engine as Session reconcile intents; explicit older-page
loads read only the Engine's authoritative message window, share one
in-flight/retry/stale-request fence, and apply mapped durable pages back to the
same Engine. Switching the focused Session or pausing the host aborts and
generation-fences the obsolete older-page request. A failed request remains
retryable at the same cursor.

The host owns mapped transport, foreground/background and disconnected-polling
triggers, diagnostics enrichment, scrolling, and rendering. Canonical messages,
Turns, Interactions, and optimistic prompts still come from the Engine; neither
Desktop view state nor Mobile services keep an older-message entity store. An
empty message list means neither hydrated nor not-found.
Selecting an already hydrated Session must not start another detail reconcile;
the selection controller alone decides whether hydration is missing. Composer
option synchronization does not own Session detail reloads. On Desktop the
selection controller also owns activation guards and Rail projection
coordination before requesting idempotent initial hydration. A repeated
automatic selection restoration must not become a forced refresh or append
pending demand to the in-flight reconcile; explicit user refresh is a separate
intent. The message paging adapter owns only focused message-controller
lifetime, transport mapping, diagnostics, and initial/older commands; it does
not call back into selection or Rail state. There is no separate messages-only
Engine reconcile helper.

Timeline projection is pure, deterministic, and provider-neutral. React views render rows/cards and dispatch actions.
Transcript Turn membership and order come only from timeline items in the
hydrated message window. Session-wide canonical Turn metadata may enrich an
already projected Turn by exact `turnId`—for example, by adding a view-only
terminal error when the provider emitted no error message—but it must not
create a transcript Turn that has no item in that window. The missing item
normally belongs to an older page; the projection adds the error when that
page is hydrated. A `user_prompt` Turn that still has no transcript item after
authoritative full hydration is an invariant or data-repair case, not an empty
row to manufacture. Goal and provider-initiated activity without transcript
items use their dedicated presentation surfaces.
Canonical reducers preserve entity and collection references when an accepted
Session snapshot is semantically unchanged, while still merging changed Turns
and Interactions at the same Session version. The legacy activity snapshot
projector preserves each unchanged domain-slice projection so reconcile
bookkeeping or composer-option updates do not rebuild transcript inputs.

Turn elapsed-time presentation starts at the client submission timestamp carried
by the canonical user-message payload, not at provider runtime start. Historical
activity without that timestamp falls back to the leading user-message
timestamp.

Completed Turn disclosure collapses only process-oriented rows such as thinking,
tool groups, progress, turn-boundary messages, and transient processing.
Ordinary assistant content, user messages, and the response-tail file summary
remain visible. The file summary owns the diff panel and stays at the end of its
canonical Turn after the final assistant reply.

High-frequency transcript updates must not pair DOM mutation with unconditional synchronous reads of the timeline's full scroll geometry. Conversation switches, explicit submit-to-bottom requests, skeleton transitions, and older-page prepend restoration may perform pre-paint scroll correction.

Transcript end-following is one UI-local state machine shared by DOM, TanStack
Virtual, and React Native adapters. It has only `following` and `detached`
modes. User scroll-away intent detaches synchronously, before the first scroll
frame. Conversation selection, prompt submission, an explicit scroll-to-end
request, or the user actually reaching the end may reattach. Content growth,
layout effects, observers, virtualizer geometry, and near-end thresholds are
sensors or executors only; they must not transition the mode.

Turn-level virtualization has one geometry owner. When the transcript is
virtualized and the state machine is `following`, TanStack Virtual owns append
following, streaming size adjustments, prepend anchoring, end detection, list
height, and item transforms. While `detached`, AgentGUI disables append
following so TanStack cannot bypass the shared intent owner, but retains
stable-item mutation anchoring so prepending an older page preserves the
visible viewport without reattaching to the end. AgentGUI retains Session
selection, explicit user intent, top-page loading, bottom-dock safe-area
measurement, and the non-virtualized short-transcript branch. It must not apply
native `scrollHeight`-delta prepend compensation or a content-resize bottom
write after the virtualizer accepts ownership.

The detail view reaches that owner through a narrow controller containing the
exact `agentSessionId`, `isAtEnd`, and `scrollToEnd`. Every read or write checks
the current Session identity; a stale controller is inert. Controller readiness
is reported back to the detail scroll controller so initial end positioning
still runs when the virtualizer acquires its scroll element after the first
detail layout. Virtual measurement keys also include the exact Agent Session
id, so replacing a conversation cannot reuse another Session's measured Turn
height. The virtual list measures its offset from the timeline scroll origin as
`scrollMargin`, including changes caused by the older-page loading indicator.
Direct DOM transform mode owns the virtual sizer height and item transforms;
React keeps only row content, measurement refs, cross-axis sizing, and
disclosure spacing.

Virtualizer- or layout-driven scroll events do not change the end-following
mode or trigger older-page loading without explicit user scroll-away intent. A
settled timeline that is too short to fill its viewport may still request older
pages.

Composer draft updates cross the view boundary through the stable `shell`,
`rail`, `detail`, `composer`, `interaction`, `readiness`, and `operations`
projections rather than one aggregate Detail prop. The active Timeline
`ScrollArea` is a memoized render island and does not consume draft state.
TipTap treats a controlled value as a local acknowledgement only when its
draft scope and local edit revision match; a scope change or other external
replacement may rebuild the document.

A virtualized transcript derives message-locator selection from the virtualizer's measured turn positions and explicit transcript identity. The currently mounted DOM window is rendering output, not a selection source; range changes must not make the locator temporarily select a neighboring message. Recent wheel and keyboard direction fences locator selection from reversing because of estimate-to-measurement scroll compensation or an item-list identity shift; the previous stable locator index is reconciled in a layout effect before paint. A genuine opposite input replaces that intent.

Historical rich text renders from the canonical Tiptap document through a static schema renderer. Only interactive composer surfaces own a Tiptap Editor/ProseMirror EditorView; read-only transcript surfaces reuse the same mention/token presentation without mounting editor lifecycle. Settled transcript messages reuse a bounded cache of pure Markdown ASTs and Tiptap JSON documents keyed by message identity and exact parser input; rendered React elements are never cached, and streaming Markdown bypasses this cache. Conversation titles are a separate plain-text projection: Markdown mention links are normalized to their `@label` text and never render mention SVGs or interactive rich-text tokens.

Fenced Markdown blocks whose exact language is `mermaid` use the bundled
Mermaid renderer only in non-inline transcript surfaces. While the owning
message is streaming, AgentGUI renders a stable diagram frame and placeholder;
it does not expose the growing source or repeatedly lay out the diagram. Once
the message settles, AgentGUI renders with Mermaid's strict security mode and
bounded text and edge limits. Active Turn lifecycle is authoritative over an
individual message or tool status: a completed tool must not settle a Mermaid
block while the owning Turn is still active. Oversized, invalid, or failed
diagrams render a compact failure state with an explicit source-copy action;
they do not automatically expose the source in the transcript. A rendered
diagram may open a presentation-local viewer with zoom,
reset, wheel input, and Space-modified pointer panning. Viewer transform,
disclosure, and theme-refresh state are UI-only and must not enter Message,
Turn, Session, activity-runtime, or workspace-engine state. The renderer is
packaged with AgentGUI and performs no runtime network fetch.

Attachment-only fallback labels such as `[Image]` may provide title or summary
text, but they are not an additional transcript text block when the canonical
structured content already renders the same image. Explicit display prompts
remain transcript content and continue to replace expanded rich prompt text.

Standalone hosts may opt a transcript into participant avatars through the
`agent-conversation` entrypoint's explicit presentation contract. Omitted or
disabled presentation preserves the existing transcript DOM. Enabled
presentation has distinct `loading` and `ready` states, so the renderer never
infers identity readiness from a missing image URL. The host supplies user and
Agent names and optional avatar URLs; AgentGUI owns the UI System Avatar,
fixed-size loading slot, fallback initial, and user-right/Agent-left layout.
Participant-header placement is projected from presentation turns rather than
individual message, tool-progress, or canonical Turn rows. A presentation turn
starts at a user message and continues until the next user message, so recovery
or provider continuation may span canonical Turns without duplicating the
participant header. Each speaker renders at most one header per presentation
turn, and a collapsed completed canonical Turn keeps the Agent header on visible
reply content.
This presentation input is view data only and must not enter canonical Session,
Turn, Message, activity-runtime, or workspace-engine state.

## 5. Agent identity and provider architecture

### 5.1 `agentTargetId` is UI identity

Use `agentTargetId` for:

- Agent selection and Rail filtering
- composer-options cache
- Workbench node state
- new-session launch
- Agent mentions and handoff targets

`provider` is execution metadata, not UI identity. Multiple Agents may share a provider; UI must not group, deduplicate, cache, or fall back by provider.
Ordinary Session selection reads composer options through the existing
target/cwd/settings request cache. It does not force a refresh; force is
reserved for explicit invalidation, completed Session creation, and documented
provider prewarm behavior.

Trusted host/daemon code resolves a target-backed request through `agent_targets`, then derives provider and runtime reference. If a client supplies both target and provider, daemon rejects a mismatch.

### 5.2 Provider strategy

```text
provider ID
  -> daemon providerregistry descriptor
  -> typed strategy / capability
  -> provider-neutral consumer
```

An unknown provider produces explicit unsupported behavior. Provider adapters normalize their own wire; shared renderers consume canonical message/tool/notice contracts only.

Skill invocation follows the same boundary. Filesystem and runtime adapters
discover skill identity, source, and plugin ownership; `providerregistry`
projects the provider-authored trigger and invocation strategy. Composer and
host adapters consume that projection and must not rebuild `$` versus `/`,
plugin namespaces, or prompt-item versus text-trigger behavior from provider
names.

### 5.3 Agent Directory and setup

The host provides a complete, ordered Agent Directory with this load lifecycle:

```text
idle | loading | ready | error
```

`ready` may contain an authoritative empty list. `error` may retain the last successful snapshot. Components must not infer loading from `agents.length`.

The directory owns Agent presentation. `agents[].iconUrl` is the primary
presentation asset used by conversation identity, Message Center, mentions,
and the empty-home carousel and Provider Rail. It is decorative metadata:
an Agent with an exact `agentTargetId` and name remains selectable when the
icon is absent. `maskIconUrl` may supply the monochrome conversation-row glyph.
Desktop Workspace Agent projections first inherit the resolved icon of their
Harness target by exact target ID, then use the provider/icon catalog fallback.
Host projections preserve these roles independently and do not create
provider-specific renderer catalogs.

Agent presentation images decoded for a canvas-backed texture must use
anonymous CORS loading before assigning `src`. Any host-owned custom protocol
that serves those images must return an `Access-Control-Allow-Origin` response
header so the decoded image cannot taint the texture canvas.

When the Desktop host projects built-in Agent mentions into a workspace app,
it replaces host-local file URLs with bounded 64px WebP data URLs. The external
bridge is the serialization owner: workspace apps must not read host paths,
register an Electron-only asset protocol, or re-encode the icon. Remote and
already-inline extension icons retain their authoritative URL.

Handoff target menus are an AgentGUI presentation contract. The shared
`AgentHandoffMenu` renders exact `agentTargetId` rows, ownership metadata, and
optional host-resolved `ownerDeviceLabel` metadata directly from the same
target, plus temporary disclosure/icon-motion state; a host supplies its
authoritative ready target projection and retains launch orchestration in
`onSelect`. Host surfaces must not reconstruct a second handoff row model,
observe the portaled menu DOM, or infer target identity from provider or
visible text. The current conversation's composer input availability is
independent from this launch surface: a target connection may disable input
while Handoff remains available when the host supplies the launch callback.
Handoff preserves canonical Rail placement: a source in the Chats section
omits its runtime `cwd` from the destination project selection, while a source
in a project section carries that project's path.
AgentGUI DOM surfaces render the target's owner badge through the shared UI
System Avatar primitive. A failed owner image falls back to the supplied owner
label initial instead of exposing a browser broken-image glyph.

For a signed Agent Extension, package `icon` is the primary identity and
optional package `maskIcon` is the conversation-row glyph. All assets remain
pinned to the verified active installation.

Target-managed setup uses exact `agentTargetId`; daemon persists its state and actions. Setup gates only the empty new-conversation surface. Active/history conversations follow host-projected Session runtime availability for exact-target capability and transport reachability. A blocked Session runtime disables both composer editing and submit until the host reports the Session available again.

The built-in managed-environment wizard and Agent Extension setup have different owners. Shared UI must not combine their lifecycles by provider name.

See [Agent Extensions](./agent-extensions.md) for the detailed setup contract.

## 6. Agent GUI composition

### 6.1 UI chain

```text
AgentGUI
  -> AgentGUINode shell
  -> useAgentGUINodeController
  -> { viewModel, actions }
  -> AgentGUINodeView
  -> shared conversation components
```

Code uses stable horizontal layers and behavior-oriented vertical modules:

- shell: host/runtime/i18n/layout composition
- controller: selector binding, UI-local state, typed command dispatch
- model/projection: pure derivation
- view: DOM, focus, scroll, animation, event wiring
- vertical module: navigation, composer, timeline, Interaction, readiness, Goal, files/mentions

A controller may compose flows but cannot become a second lifecycle state machine. Extract complete behavior first; do not scatter it into a pile of domainless helpers.

Activation and existing-Session submit share a canonical prompt envelope. Submit eligibility includes text and renderable structured content; an individual composer does not redefine it.

The canonical Composer gate belongs to the Session-presentation projection and
travels through the Composer view-model slice as one object. View-local
transition or workflow locks may layer on top as explicit presentation locks;
they do not copy or reinterpret runtime, connection, provider, ownership, or
queue readiness.

The conversation composer area is a stable `AgentComposerRegion` with explicit
floating-control, lifted-interaction, accessory, and primary-composer slots.
Workflow features compose through the accessory slot instead of adding another
bottom-dock layout or reaching into composer DOM. A disclosure accessory owns
only presentation and expanded state; its domain controller owns phase
selection and commands.

Tutti plan review and Issue execution project into one
composer-anchored `TuttiWorkflowDock`. The same banner shell expands upward and
moves through `review`, UI-local `materializing`, `execution`, or `error`;
there is no top-level Plan/Task tab and no duplicate full plan or Issue card in
the conversation timeline. Accepting a plan stores only the checkpoint identity
and title needed to bridge the read-model handoff, not an accepted-plan copy.
That UI-local marker is scoped by exact Session, workflow, and checkpoint, and
is cleared when the matching Issue or materialization failure arrives, the
decision fails, or a newer actionable checkpoint supersedes it. It must not
survive a completed handoff and later turn an ordinary Session re-entry into a
false materializing phase. During a genuine handoff the draft remains editable
while submit is disabled. The arrival of a newer actionable plan takes
presentation priority over an existing Issue. Each newly identified actionable
review starts expanded once; an explicit user collapse remains authoritative
for that review, while the disclosure's current expanded state survives
materialization and execution handoffs so the UI does not jump. The expanded
plan panel starts with the plan title and body; it does not repeat mode,
review-kind, or pending-state badges already communicated by the workflow
banner.

Task-assignment directories and target option catalogs are workspace query
projections, not Plan, Session, or Turn state. The Desktop assignment source
retains them in the shared bounded workspace query cache: directories are keyed
by workspace, while target options use exact workspace, Agent Target, and
provider identity. AgentGUI may synchronously reuse the last successful value,
including a stale value, while the source performs a deduplicated refresh.
Provider catalog and workspace model-configuration events invalidate only the
affected target entries; a generation fence prevents a pre-invalidation
response from becoming current. Composer options remain a separate
cwd/settings-sensitive projection and do not share this cache instance.

The materialized Issue is also a Tutti-owned aggregate-work projection for the
source composer. While dispatch is not paused and any task is nonterminal, an
empty composer shows the normal running Stop control even when the source
Session has no active Turn; this is presentation state and must not manufacture
an Agent Turn or change Host submit availability. Typed input replaces that
aggregate Stop with Send. An exact active source Turn with
`activeTurnGuidance` receives the input as guidance/steer; an idle source starts
a normal Turn, and an active source without guidance support keeps the normal
queue path instead of cancel-then-send. Stop durably pauses Issue dispatch and
cancels its running task Sessions, and also sends the ordinary source-Session
stop only when that Session has stoppable work. The two idempotent paths are
independent because canceling an idle Session merely to trigger the Issue
cascade could capture a later Turn.

Task-level accept and rework controls in that projection prepare localized
instructions in the exact source Session composer; they preserve any existing
draft and never send automatically. They do not call generic Issue Task
mutations or impersonate the source Agent's CLI authority. Once the user sends
the draft, the normal source-conversation submit/guidance path applies and the
Agent inspects the canonical Tutti execution before issuing checkpoint- and
revision-fenced commands. Other plan-panel interactions should use this
prompt-action pattern only when their intended effect requires source-Agent
judgment; navigation and existing daemon-owned commands remain direct semantic
actions.

An independent-review failure is a distinct workflow presentation, not a
generic retry loop. The dock may offer an explicitly user-triggered self-review
fallback through an optional host command and shows its pending, success, or
failure result together with the audit identifier. It never switches review
mode automatically.

An active Tutti Mode composer badge is a preference-settings entry, not a
destructive toggle. Clicking it opens the UI-local `TuttiBudgetPopover`, seeded
from the engine-projected `effect` and `speed` preferences. Every slider
movement sends its selected value directly through the existing Tutti Mode
activation command -- there is no draft/confirm step. Turning Tutti Mode off
remains a separate adjacent action, and all controls stay disabled while an
activation update is unresolved. The Desktop command host and HTTP adapter must
preserve the optimistic CAS revision and both optional preferences; dropping
any field turns a valid UI intent into a stale or semantically mismatched
response. Tutti Desktop always advertises the Tutti Mode host capability;
historical `lab.tuttiMode` preference values do not hide or disable it.

The preference popup uses two independent 0-100 sliders. `effect` raises the
minimum model capability and task-verification breadth. `speed` asks the
planning Agent to choose the fastest model that still satisfies that effect
floor and maps into an upper parallel target: `0-24 -> 1`, `25-49 -> 2`,
`50-74 -> 3`, and `75-100 -> 4`. They are combined, never averaged: high effect
plus high speed means "fastest suitable powerful model" with a target of up to
four parallel Agents, not a mid-tier model.

The popup previews a short model strategy and that parallel target. The target
is not a concurrency promise: the planning Agent may shape real independent
workstreams toward it, while actual scheduling remains bounded by dependencies,
ownership, safe isolation, ready work, budget, and the workspace-wide
four-Run ceiling. Exact models still come from the live composer catalog.
Effect-scaled verification remains planning policy but is not shown as a
primary preview metric.

Plan review reads the additive `execution.effect` and `execution.speed`
snapshots from current `tutti-mode-plan/v1` documents. A legacy v1 document
without those fields maps its single `orchestrationIntensity` value to effect
and uses the balanced speed default. The existing execution fields keep their
original Issue semantics; AgentGUI must not reinterpret
`orchestrationIntensity` as speed.

Home-composer project state distinguishes an unresolved durable default from an
explicit selection whose path may be null. The project selector may apply the
durable default only while that intent is unresolved. Entering the unscoped
conversation section resolves the intent to no project, so remounting the hero
composer or refreshing the project list cannot restore a previous project.

A locked Session cwd existence check is UI-local observation, not Session
truth. AgentGUI starts it only after pending creation has resolved, scopes its
result to the normalized selected path, and discards callbacks from a previous
path. Switching between Sessions that share the same cwd must not repeat the
same mounted probe. A host probe failure leaves existence unknown; only a
successful check that confirms absence may render missing-project chrome.

The empty-home carousel may measure its placeholder synchronously when live
alignment first activates. Later React updates coalesce alignment into the next
animation frame; ResizeObserver and MutationObserver keep layout roots current.

Composer text transactions may publish the current draft, but the draft value
must not drive synchronous pre-paint geometry reads or an urgent AgentGUI tree
render. The rich-text editor DOM owns the urgent input transaction. The latest
prompt ref updates synchronously for submit and attachment reconciliation,
while palette and controlled-draft projections publish in a React transition.
The editor recognizes stale controlled echoes from that transition so an older
projection cannot overwrite newer local input; a value not emitted locally
remains an authoritative external replacement.

An existing-Session composer derives input history from that Session's
canonical user-message projection; it does not persist a second history store.
The host must opt in explicitly; Desktop maps the default-off
`lab.agentInputHistory` Lab preference to that capability.
Bare Up/Down recalls older/newer structured drafts only from an empty composer
or an unchanged recalled entry, and only when the collapsed caret is at a
whole-document boundary. Palette handling and IME composition take precedence,
while editing a recalled draft exits history navigation. Moving past the newest
entry clears the composer. Adjacent equivalent submissions collapse, persisted
attachments are restored with exact workspace and Session identity, and
reaching the oldest loaded entry requests the existing authoritative older-page
read while preserving the timeline prepend scroll anchor. The history cursor
is UI-local and resets when the draft Session scope changes; Home has no
Session history.

The dock observes geometry through one coalesced animation-frame measurement
entry point. Editor document updates, attachment membership or intrinsic
attachment size changes, and changes to the stable input-shell width may
invalidate that entry point.
`ResizeObserver` must not observe the animated input area or editor block size:
their height transition is an output of measurement and must never feed back
into another measurement cycle. Width observations compare inline size before
invalidating, while attachment observers cover asynchronous chip and preview
sizes without a duplicate global resize listener.

The measurement pass is read-only. It derives natural text height from the
editor document blocks, reads attachment heights, and publishes one atomic
composer-metrics snapshot only when the snapshot changes. It must not
temporarily collapse or restyle either the editor or transitioned input
container. The dock input area establishes a local layout-containment boundary
so a composer read cannot invalidate the conversation root. Composer paragraphs
and the viewport calculation share the same line-height token so the 3.5-line
cap remains exact. Regression coverage must expand across explicit newline
rows, delete back to one row, and verify stable action-button placement.

Dynamic Agent surfaces must not use `:has()` on `.workbench-window`, the
timeline, or transcript rows. Composer and streaming DOM mutations would make
those relational subjects candidates for subtree style invalidation. Window
header layout and render-error state are projected onto the owning window or
header; message footer, speaker, thinking-edge, and row-kind state are projected
onto the owning message flow or transcript row. Small, self-contained controls
may still use local relational selectors when their subject and mutation scope
are bounded.

Composer mention providers own entity presentation metadata, including an
optional `iconUrl`, through their insertion result. AgentGUI mention
projections must preserve that metadata for every supported entity kind, and
the shared mention row renders the icon only when supplied. A provider-level
icon assertion is not sufficient coverage: presentation changes require both a
projection assertion and a consuming-row DOM assertion so an intermediate
view-model cannot silently discard the icon.

Composer copy and cut write both the canonical prompt Markdown as
`text/plain` and schema-serialized mention markup as `text/html`. Pasting that
markup reparses it through the AgentGUI editor schema, so built-in and
currently registered custom mentions retain their canonical href and chip
identity without a host DOM event interceptor.

External OS file paste and drop enter one host-injected classification boundary before draft attachment creation. The synchronous `resolveExternalPromptEntries` port classifies each source index as a live `WorkspaceFileReference` or a snapshot requiring preparation. AgentGUI owns ordered mention insertion and draft reconciliation: references become ordinary file/folder mentions and never consume prompt-asset slots, while only `prepare` entries create pending attachment state and enter `prepareExternalPromptFiles`. A host without the resolver prepares every external entry. The preparer owns native-path or byte lookup, size enforcement, persistence, and remote transport; each prepared input has one `sourceIndex` result, one failure must not fail siblings, successful results include a provider-readable `path` or `url`, and failures carry typed error codes. Hosts that classify path-backed entries as references must reject any such entry that unexpectedly reaches preparation, so classification failure cannot silently create a duplicate snapshot.

Workspace picker results and internal workspace-reference drags remain live references. They enter the rich-text document as mentions and never pass through external-file preparation. A picker source whose selected locator is not yet consumer-readable may perform source-owned confirmation preparation before the mention is inserted; the picker waits in a loading state, publishes no partial result on failure, and remains open for retry. This confirmation transaction belongs to the reference source contract and is distinct from the external OS file preparation pipeline. Removing an inline external-file mention removes its draft intent; a later async result must not revive it or lose its error reason when the draft is in another scope.

A host may map a reference-source content error to a labeled recovery action
through the optional workspace contract. AgentGUI passes that policy through to
the shared picker without copying error state. The picker owns centered error
presentation and retries the failed browse or search; the host remains the
authority for deciding which structured errors can request authorization or
otherwise recover interactively.

### 6.2 Public node contract

`AgentGUINodeProps` groups fields by semantic responsibility:

| Object             | Responsibility                            |
| ------------------ | ----------------------------------------- |
| `identity`         | node, workspace, user, title identity     |
| `workspace`        | path, reference, project, Agent settings  |
| `frame`            | position, size, visibility, embedding     |
| `state`            | persisted Agent GUI node data             |
| `runtimeRequests`  | focus, launch, prefill, probe requests    |
| `hostCapabilities` | host catalog, readiness, menus, icons     |
| `hostActions`      | host mutations, Workbench/window actions  |
| `renderSlots`      | narrow product-neutral presentation slots |

Host-issued `runtimeRequests.composerAppend` values are one-shot requests.
AgentGUI waits until the exact requested Session is the active conversation,
applies the append once, and then calls
`hostActions.onComposerAppendHandled(sequence)`. A Host that retains routed
requests must clear only the acknowledged sequence; it must not let an older
open-Session append mask a newer request.

Do not restore flat compatibility props or hide workflow inside a render slot.
The optional `renderSlots.projectDirectoryPickerHeaderActions` slot is limited
to host presentation beside the directory picker's title. AgentGUI owns picker
state and supplies refresh plus source-located target selection after host
mutations; the host owns the action's side effects and must not duplicate
picker navigation or selection state.
Hosts that render capabilities owned by another device set
`hostCapabilities.capabilityControlsReadOnly`; AgentGUI keeps owner-supported
Browser/Computer entries visible but disables their mutation and setup actions.
Unsupported capabilities remain absent according to the authoritative composer
capability descriptor. A caller host must not open its local device settings as
a fallback for a remote owner.
Account and Commerce UI is Host chrome rendered through
`@tutti-os/commerce/react`; it is not an AgentGUI node capability. AgentGUI
accepts only generic `hostCapabilities.visibleErrorPresentationOverrides` for
structured product errors. The host owns Account/Commerce requests,
login/logout, external navigation, reward receipt persistence, clipboard
writes, notifications, localization, feature gating, and menu lifecycle.
Neither AgentGUI nor the frontend Commerce package may receive a Cookie or
start a Commerce request.
The optional `renderSlots.agentConfigAccount` is a presentation-only Host
chrome seam for the exact selected Agent Target. Its paired
`hostActions.onAgentConfigMenuOpen` notification lets the Host refresh account
state without hiding workflow in the render slot. Returning no content keeps
the provider account and quota block unchanged. AgentGUI never derives billing
ownership from provider identity.

Tutti Desktop fills this seam only for its self-owned local Tutti Agent target.
The Desktop Account service remains the source of account, membership, credit,
and Commerce-link state; opening the target menu asks that service to refresh,
and the render slot stays request-free. Signed-out, shared, and non-Tutti
targets return no Host content and retain AgentGUI's provider account and quota
presentation.
The optional `renderSlots.agentTargetInfo` seam enriches the exact target icon
in the provider Rail and Conversation Rail. The same
`AgentGUIAgentTargetInfoRenderer` may be passed to
`AgentGuiWorkbenchHeader.renderAgentTargetInfo` with its exact
`conversationAgentTarget`. AgentGUI owns Tooltip disclosure, positioning,
focus behavior, and the built-in label fallback; the Host renderer receives
only `{ target, surface }`, remains presentation-only, and is invoked lazily
while the Tooltip content is mounted. Conversation rows resolve the target by
canonical `agentTargetId` from the current Host directory and fail closed when
it is absent. They do not copy owner, device, availability, or other target
metadata into Session state.
Host chrome that aligns to AgentGUI's internal layout must consume explicit
package signals such as `hostActions.onConversationRailLayoutChange`; it must
not observe package DOM, CSS variables, or class names with
`MutationObserver`. Composer affordances belong in AgentGUI itself or a
narrow `renderSlots` contract, not in host-owned portals inserted into package
DOM.

### 6.3 `AgentActivityRuntime` and `AgentHostApi`

`AgentActivityRuntime` is the AgentGUI activity-data and command boundary. Session, messages, activation, send, cancel, Interaction, Goal, settings, composer options, pin, and delete enter through it.

`AgentHostApi` supplies host capabilities only: files, clipboard, project/account lookup, Agent Target setup/probes, diagnostics, and OS/Workbench helpers. It must not become a Session, Turn, timeline, or write source again.

The optional quick-prompt library follows that host-capability boundary. Tutti
Desktop projects the device-global `tuttid` quick-prompt CRUD service through
`AgentHostApi.quickPrompts`; AgentGUI owns only the picker/editor presentation
and inserts a selected prompt into the current TipTap selection without
submitting it. The library snapshot, developer feature gate, and cross-window
invalidation are not Session or Turn state and must not enter
`AgentActivityRuntime` or the workspace engine. Hosts that omit the capability,
and hosts whose capability reports the developer gate disabled, render no
quick-prompt composer entry. AgentGUI may also present a small, localized set
of recommended templates; those only prefill the existing editor and remain
client-local until the user explicitly saves them through the CRUD capability.

### 6.4 Multiple surfaces

AgentGUI, Message Center, dock/header, workspace window, and standalone Agent window consume the same workspace engine.

Opening a panel/window creates presentation state only. It does not clone a Session, copy engine entities, or start another event stream. Standalone tools are Desktop chrome, not AgentGUI lifecycle.

Workbench previews must not mount a second AgentGUI tree. Genie capture prefers
the host-provided native image and clones the visible node DOM into a texture
only after native capture fails or exceeds its bounded wait. Electron hosts
pass the sanitized node region directly to `webContents.capturePage`, retain
the returned region for Genie, and resize a copy for the Dock. The Genie path
must not reuse an undersized Dock image. Dock popup
cards and minimized slots use the bounded image and its cache. A background or
minimized popup node must not request a fresh DOM snapshot: AgentGUI may be
unhydrated, and `surface.isVisible=false` deactivates imperative resources such
as the hero Canvas. Those nodes reuse only a previously successful image. If no
captured image exists, the Dock shows a static terminal placeholder rather than
an in-flight skeleton; it does not mount AgentGUI or render a conversation
summary as a fallback. Capture failure is not cached across popup lifetimes, so
a later foreground attempt may still populate the image. AgentGUI therefore
has no preview-mode rendering contract.
When a minimized node has a cached Genie texture, Workbench completes the
restore animation before launching the host node, then replaces the final
texture frame only after launch settles. The expensive AgentGUI reconstruction
therefore stays outside the animation. Workbench also prepares the Genie canvas
during browser idle time with representative scanline, scaling, and glow
operations, and commits the final minimize state in a later task instead of
extending the last animation frame. A later minimize may start from that
retained texture while the host refreshes its native capture asynchronously;
a native image replaces the retained Genie texture only when it can cover the
current window without upscaling. Low-resolution thumbnails update only the
Dock preview cache. A late native result updates that Dock cache immediately,
but Workbench decodes its full-size image only after the active Genie animation
settles and the browser is idle. Without a reusable full-resolution texture,
Workbench falls back to the visible DOM capture. The retained Canvas cache is bounded by
both entry count and estimated RGBA bytes. Restored nodes keep their texture for
the next minimize; controller state changes remove textures only after their
nodes are closed. Eviction leaves the separate Dock image cache intact.

Genie node hiding uses a per-node operation token. A newer operation for the
same node may supersede an older reveal, but another node's animation may not
leave the first node hidden. The global animation generation controls only the
shared Genie Canvas.

The empty AgentGUI Hero renders its existing DOM player before initializing the
optional WebGL carousel. A host projects whether the normal window presentation
is currently visible; the carousel waits for that visibility and then browser
idle time before creating its WebGL renderer. This keeps Genie restore work out
of the WebGL creation task without exposing Genie state to AgentGUI. A fully
occluded presentation releases its scene, decoded images, observer, and wheel
listener; exposure restores them after the reveal interaction settles. Once
initialized, WebGL renders only for texture or size changes and carousel
selection changes; the spring stops requesting frames after it settles. The DOM
turntable record uses a compositor animation only in the active visible
AgentGUI, and composer prompt tips follow the same active-surface rule.
Empty-Hero entry animations may fill backwards across their delay, but must
release their final identity transform after completion so every mounted
AgentGUI does not retain decorative compositor layers. An embedded AgentGUI
skips those internal entry animations because the Workbench shell already owns
its appearance transition. Background Workbench AgentGUI bodies remain mounted
so drafts and local conversation presentation survive focus changes. Focus does
not determine visibility. Workbench frame geometry and z-order classify bodies
as fully occluded or visually exposed; partial exposure counts as visible.
While Genie replaces a real node with Canvas output, or scale minimize marks
the node as pending, Workbench excludes that departing node from geometric
occlusion. Covered windows therefore resume presentation during minimize; a
restoring Genie node stays non-occluding until its real node is revealed.
Scale restore, shell frame transitions, and onboarding entry keep the moving
node's own presentation visible while temporarily excluding it as an occluder;
DOM transition and animation completion release that state. Portal-backed
`dialog-popover` nodes sort above default-layer nodes before Workbench applies
normal stack order.
Only fully occluded bodies pause descendant animations and use
`content-visibility: hidden`. Visible Empty-Hero surfaces may own carousel
images, alignment observers, wheel input, and a Three.js/WebGL scene.
Occlusion releases those resources; exposure restores the DOM presentation
immediately and defers WebGL reconstruction until after the reveal interaction
settles. Detail timelines follow the same geometric boundary: fully occluded
surfaces disconnect dock/timeline resize observation and scroll listeners,
while exposure reattaches them and resynchronizes the retained bottom lock.
Elapsed Turn, compaction, subagent, and Goal labels subscribe to one shared
renderer-realm second clock only while their containing presentation is
visible; exposure catches the displayed value up from canonical timestamps.
Focus alone must not stop either behavior because multiple exposed AgentGUI
windows remain live at the same time.
On workspace restore, Desktop mounts the focused AgentGUI body immediately and
hydrates inactive bodies sequentially after browser idle, one animation frame
at a time. Window shells and persisted geometry remain synchronous; this
staging is Desktop presentation work and does not enter engine or Session
lifecycle state.
WebGL scene readiness remains local presentation state; it must not enter
`AgentActivityRuntime`, the workspace engine, or Workbench node state.

The shared Workbench Header owns conversation-identity visibility. When no
Conversation exists, it ignores conversation titles, Agent titles, primary
icons, exact Agent targets, target-information renderers, and fallback icons
even if a host supplies them. When target information is enabled, only the
session icon becomes a no-drag Tooltip trigger; the surrounding title remains
owned by the Header's existing drag and menu behavior.

The reusable tool-sidebar contract lives in
`packages/agent/gui/workbench/tool-sidebar`. Hosts provide the supported panel
catalog and render adapters; the shared component owns tab selection, picker,
sizing, toolbar mechanics, and a structured `AgentToolSidebarHeaderLayout`.
Hosts may hide the shared toolbar toggle through the explicit
`showToggleButton` presentation input; omission preserves the standard visible
entry. Hiding the entry does not duplicate or override sidebar behavior in the
host.
That layout carries the actions, open state, and reserved width into the one
authoritative `AgentGuiWorkbenchHeader`.

The standalone Files tool reuses the Desktop file-manager pane and its complete
context menu. Its Open With submenu keeps Tutti's file viewer and in-app browser
alongside system applications, default-browser handling, and the system
application picker. Double-clicking a file still delegates to the desktop
host's system-default opener; directories continue to navigate inside Files.

Header ownership is explicit. A native standalone window selects the
window-owned contract, so the shared sidebar composes the Workbench Header and
body frame. An embedded Workbench selects the host-owned contract and projects
the same header layout into its existing Header. The sidebar never creates a
second visible panel Header. Interactive controls stop host drag gestures,
while blank host-owned Header space bubbles to the host drag owner; native
window ownership alone uses Electron app-region dragging.

Header layout is independent from ownership. `overlay` means the Header is
layered above a full-height body, so open tool-panel content reserves the shared
Header height and the Header stacks above `--z-panel`. `stacked` means the host
has already placed the body below the Header and no panel spacer is added.

The package owns one responsive Rail presentation policy for every surface.
`resolveAgentGUIConversationRailPresentation` derives the effective Rail width,
automatic collapse, and combined collapsed state from container width plus the
persisted user preference. Hosts must not supply an alternative breakpoint,
copy Rail dimension constants, or restyle `AgentGuiWorkbenchHeader` to move its
controls. The shared Workbench contribution selects an overlay Header with no
bottom border, and native standalone composition projects that same explicit
window presentation state. Standalone identity remains relevant only to native
window ownership such as Electron drag regions and full-viewport sizing; it is
not a Header layout or separator switch.

## 7. Key flows

### 7.1 New conversation

```text
home composer submit
  -> engine pending activation + optimistic Session/message
     (including the resolved immutable railSectionKey)
  -> Host CreateSession(initial content, clientSubmitId)
  -> provisional runtime + canonical transaction
  -> first Turn accepted
  -> authoritative Session/Turn replaces optimistic projection
```

Initial-content create is one transaction. Failure compensates the provisional runtime/canonical shell; it must not leave a Turn-less Session.
The initiating composer snapshots Tutti activation plus effect and speed with
that submit. An explicit active or inactive submit snapshot is authoritative
over a later read of mutable home-draft state; non-composer callers may fall
back to the engine draft when no snapshot exists. `capabilityRefs` remain
independent audit provenance and must never substitute for
`initialTuttiModeActivation`.
An activation may instead carry `initialGoalControl`. In that branch the engine
and runtime adapter preserve the structured `{action, objective}` command, the
host integration creates a non-provisional Session without initial content,
and Goal control completes without manufacturing a Turn. The structured field
is authoritative; integrations must not reparse the display prompt to recover
Goal semantics. AgentGUI represents the pending control and its durable audit
with the same client-submit presentation identity, so canonical replacement
does not remove and recreate the visible `goal-control` row.
The pending activation carries the same resolved project section key as the
create command. Exact rail projection therefore shows the conversation as soon
as the intent is accepted; it does not wait for provider startup or invent a
temporary catch-all section.
AgentGUI may select that optimistic conversation in mounted UI immediately,
but it must not persist the provisional Session ID into Workbench navigation
state. The selection becomes durable only after the workspace engine confirms
the activation from an authoritative Session snapshot. On restart, absence
from a bounded Rail page is not deletion evidence. A host that proves the
selected Session is absent returns typed `session.not_found`; the activity
engine retains that code, and AgentGUI clears only the matching global and
per-target navigation memories before returning Home. Timeout, transport, and
other reconcile failures preserve the remembered selection.
The controller's new-conversation command must distinguish rail placement from
the active Session's runtime working directory before entering the home
composer. A Session in the Chats section may have a generated `cwd`, but that
path is not a selected user project and must be cleared. A Session in a
canonical project section keeps its working directory, while a command already
on the home composer preserves the user's explicit project selection. Views
only forward new-conversation intent; unresolved active rail membership fails
closed rather than guessing from composer presentation fields.
For delegated/shared execution, the initiating caller remains the placement
authority: the adapter forwards that caller-selected `RailPlacement` through
the binding to the owner Host. The owner persists the same section key and does
not recompute it from the owner's user-project list.

### 7.2 Existing conversation submit

```text
composer submit
  -> engine pending submit / queue
  -> Host SendInput(clientSubmitId)
  -> durable submit claim
  -> provider execution
  -> exact authoritative Turn acknowledgement
  -> event/reconcile confirmation
```

A successful response includes the exact Turn. Clients must not repair a missing Turn by polling, sleeping, or synthesizing an entity.

### 7.3 Interaction response

```text
canonical Interaction(pending)
  -> selector projection
  -> inline / Message Center / toast surface
  -> exact interaction response command
  -> Host idempotent transition
  -> answered or superseded projection
```

Every surface shares the exact interaction identity
`(workspaceId, agentSessionId, turnId, requestId)` and submitting state.
Provider request ids remain unchanged and may repeat across Turns; no adapter
may recover a missing Turn by scanning for a session-wide request-id match.
Non-DOM hosts such as React Native reuse the pure
`agent-conversation/interactive-answer` entrypoint for canonical ask-user
payload construction and own-property-safe question-id access. Presentation
components remain platform-specific, but they must not copy or reinterpret
this cross-provider answer contract.

A synthesized plan decision uses a durable `plan_decision` operation. A provider-native plan Interaction continues through `interactive_response`. Similar UI does not justify merging their write paths.

### 7.4 Resume

```text
select/open existing Session
  -> engine session reconcile
  -> Host GetSession / EnsureRuntimeSession
  -> canonical state + optional live observation
  -> messages/detail hydration
```

If resume is unavailable, return an explicit state. Do not create a shadow Session.

### 7.5 Conversation actions and copy

```text
rail row More menu / row context menu / workbench header menu
  -> one shared action-group contract (AgentGUIConversationActionsMenu)
  -> rename | copy as reference | copy as Markdown | open window | mark unread
```

All three surfaces render the same action groups; the header dispatches
through `sessionActions.ts` and the node resolves the target session against
canonical rail entities under the rail interaction lock. While either row
menu is open the row keeps its hover layout (short title truncation, actions
visible) so titles cannot overlap the action cluster.

Attention state preserves explicit user intent: marking the currently selected
Session unread keeps its unread indicator while that selection remains open.
Selecting the Session again marks it read. A new live completion or a durable
unread completion discovered by hydration is still marked read immediately when
its Session is already selected.

Read-only host surfaces reuse the complete workbench header and declare the
session actions they support. Omitting that capability list preserves the full
rename-and-copy menu; a copy-only surface does not render rename or an empty
separator. Hosts that already own a complete canonical message projection may
reuse the pure transcript serializer exported by the `agent-conversation`
entrypoint, while clipboard access, toasts, and session loading remain
host-owned capabilities. Window-level Agent chrome applies only when that Header
is rendered through the Workbench window's own header slot; a complete Header
nested in another host window's body remains ordinary embedded content and must
not alter the outer window's layout or drag layer.

Copy as reference copies the session-mention markdown link the @ panel
produces, so pasting into any composer reconstructs the session chip; it is
synchronous and only requires a writable host clipboard. Copy as Markdown
loads every canonical message page and serializes a lean transcript: user
inputs blockquoted in full, per-turn final agent replies plain, interim
narration collapsed in a `<details>` block; tool payloads (except image
outputs), thinking, `agent_system_notice` messages, and JSON fallbacks are
dropped. The clipboard write is dual-format: `text/plain` keeps short image
references and never carries base64, while `text/html` embeds images as
data URIs hydrated from inline data, the attachment store, and host
`workspace.readFile` — verified empirically: rich-paste targets (Feishu
docs) consume data URIs and re-upload them, but never fetch local paths or
localhost URLs. Images over the per-image embed cap, or with failed reads,
keep the lean reference and surface a toast that counts the omissions and
points at per-image copy. Because history loading and image hydration take
a noticeable moment on long conversations, selecting copy as Markdown opens
one toast immediately (`AgentHostToastApi.loading`): it shows busy with a
spinner and never auto-dismisses, and the handle it returns settles that
same toast in place to success, the omitted-images info tone, or failure —
at which point it starts auto-dismissing like any other toast. This is one
continuous toast, not a loading toast followed by a separate result toast.
Hosts without the `loading` capability get the prior plain info toast
instead, and the result lands as an ordinary second toast.

## 8. Change routing

Answer before editing:

| Question                                                                            | Owner                                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Change when Session/Turn/Goal/operation is created, sent, terminated, or recovered? | `packages/agent/host`; add a conformance scenario first |
| Change canonical phase/outcome/Interaction vocabulary?                              | `store-sqlite/canonical`                                |
| Change an HTTP request/response?                                                    | OpenAPI first, then generated clients                   |
| Change provider wire normalization?                                                 | provider-owned daemon adapter                           |
| Change cross-provider behavior?                                                     | registry descriptor/strategy/capability                 |
| Change frontend async, optimistic, queue, or reconciliation semantics?              | `agent-activity-core` engine                            |
| Change projection, interaction, or loading behavior?                                | focused AgentGUI model/controller                       |
| Change DOM, focus, scroll, or animation?                                            | view/UI-local hook                                      |
| Change Electron, Workbench, OS, file, or window capability?                         | Desktop host adapter                                    |

Diagnose in owner order:

1. Did the canonical command accept and commit?
2. Did Host produce the correct lifecycle result/`CommittedDelta`?
3. Do tuttid events match the authoritative read?
4. Did Desktop reconciliation emit the correct engine intent?
5. Did the engine reducer/selector derive the correct state?
6. Did projection/view render only its input?

Do not start by adding a fallback to the visible component.

### 8.1 Agent settings surface

The desktop settings panel's Agent section has General Settings, Agent Runtime,
and Custom Agents available by default; Automation remains independently
gated. The Agent
Runtime tab renders provider rows from the authoritative
identity catalog plus the live `IAgentProviderStatusService`; it does not copy
a provider registry. Its Enable/Disable control reads all Agent Targets from
`IAgentsService` and persists the daemon-owned Agent Target `enabled` field.
Disabled targets remain in this settings control plane so they can be
re-enabled, but they are excluded from the AgentGUI agent projection and from
CLI discovery and launch. The device-global provider-rail preferences remain
presentation-only (ordering and optional sidebar personalization); they do not
authorize an Agent Target or replace daemon enablement. Staged
(Beta/Preview/in-progress) rows are gated by the `lab.previewAgents` switch via
the provider-neutral `agentGuiWorkbenchPreviewProviders` predicate; stable rows
always show in settings. Deep links publish the existing
`openWorkspaceSettingsPanel` intent with optional `pane`/`provider`; the
Desktop Settings service is the single adapter that resolves legacy aliases
and current destinations for workspace and standalone windows. An Agent
Runtime destination also bumps `agentFocus` to scroll and briefly highlight the row;
a link to a hidden preview agent surfaces an "enable Preview Agents" hint rather
than failing silently. This is a settings surface, not a second Agent Target
state store.

## 9. Folder guide

| Path                                                      | Responsibility                                      |
| --------------------------------------------------------- | --------------------------------------------------- |
| `packages/agent/host/**`                                  | provider-neutral lifecycle application core         |
| `packages/agent/store-sqlite/**`                          | canonical SQLite transactions/repositories          |
| `packages/agent/store-sqlite/canonical/**`                | canonical vocabulary and projection contracts       |
| `packages/agent/daemon/**`                                | provider runtime, registry, wire adapters           |
| `services/tuttid/service/agent/**`                        | Host adapters, queries, HTTP/product preparation    |
| `services/tuttid/api/openapi/tuttid.v1.yaml`              | daemon HTTP contract                                |
| `packages/agent/activity-core/src/engine/**`              | frontend workspace engine                           |
| `packages/agent/gui/agentActivityRuntime.tsx`             | AgentGUI runtime interface                          |
| `packages/agent/gui/agent-gui/agentGuiNode/controller/**` | focused controller modules                          |
| `packages/agent/gui/agent-gui/agentGuiNode/model/**`      | pure node projection/policy                         |
| `packages/agent/gui/shared/agentConversation/**`          | reusable transcript projections/components          |
| `packages/agent/gui/agent-message-center/**`              | Message Center projection/presentation              |
| `apps/desktop/**/workspace-agent/**`                      | desktop activity service, adapter, host integration |

## 10. Validation

Follow the repository [Validation Selection](../conventions/testing.md#validation-selection).
The Agent architecture boundary commands available to that workflow are:

```sh
pnpm check:agent-host-boundary
pnpm check:agent-activity-runtime-boundaries
pnpm check:agent-provider-strategy-boundaries
pnpm check:agent-gui-degradation
pnpm check:renderer-boundaries
```

`check:agent-gui-degradation` is executable architecture. Its business-file 800-line limit and budgets for effects, memoization, render-mirror refs, provider branches, timers, component stores, and module globals may only stay level or decrease. Tighten the baseline when a metric drops; never raise it to merge new drift.

Any change to an owner, data flow, public contract, or recurring trap requires documentation impact:

- durable architecture rules update this or an adjacent architecture document
- implementation plans belong in `docs/specs` or `docs/plans`
- symptoms and investigation steps belong in troubleshooting
- historical migration records do not return to this document

## 11. Related documents

- [Agent Activity Packages](./agent-activity-packages.md)
- [Agent Host contracts](../../packages/agent/host/README.md)
- [Agent Extensions](./agent-extensions.md)
- [Provider-native Subagents](../specs/2026-07-15-provider-native-subagents.md)
- [Agent Reference Sources](./agent-reference-sources.md)
- [Agent Reference Mention Resolution](./agent-reference-mention-resolution.md)
- [Desktop Layering](../conventions/desktop-layering.md)
- [Agent Runtime Troubleshooting](../conventions/troubleshooting/agent-runtime.md)
- [Agent GUI Refactor History](./agent-gui-refactor-plan.md)
