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

Desktop AgentGUI reports quick-prompt engagement through the typed panel
engagement sink. Opening the picker from the Composer emits
`agent.quick_prompt_engagement` with `action=panel_opened` and
`source=composer_input`; successfully inserting a saved prompt or a saved
recommended template into the Composer emits the same event with
`action=prompt_used` and the corresponding `prompt_type`. Engagement is
buffered until the containing panel satisfies its exposure gate. The
action-discriminated contract forbids `prompt_type` on panel-open events.
Events carry only stable AgentGUI context and never prompt titles or prompt
bodies, while the action keeps picker exposure distinct from successful use.

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

The native Mobile new-conversation Composer presents Agent Target and working
directory as peer context selectors directly above the input. The Agent Target
catalog remains the launch authority. The working-directory selector reads the
daemon-owned registered project catalog through the exact read-only
`GET /v1/user-projects` DeviceLink route and also offers an explicit no-project
choice; Mobile does not browse the Desktop filesystem, accept arbitrary paths,
or mutate the registered project catalog. The authenticated-device scope keeps
the last loaded project metadata across workspace activity replacement, while
the selected path remains process-only draft state and disappears after
activation. Changing either selector reloads Composer options for the exact
Target and optional cwd; creation waits while those exact options are loading
and submits only sparse user-selected settings rather than cached effective
defaults. An outcome-unknown activation locks both context selectors so an
idempotent retry cannot change its launch identity. Activation with a
registered project carries both its path as `cwd` and its versioned canonical
project `railPlacement`; no-project activation omits `cwd` so the daemon
allocates an isolated Session directory and carries the canonical
`conversations` placement. Existing Sessions never expose these selectors as
mutable settings.

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
- canonical tool `output`/`error` bodies bound each `text`, `stdout`, and
  `stderr` field to 1 MiB, then fit formal output streams into a 768 KiB
  aggregate durable payload budget, including nested tool steps, by retaining
  a valid UTF-8 prefix and the fixed `[Output truncated]` marker
- terminal command snapshots may omit `text` only when it exactly equals the
  trimmed `stdout` or `stderr`; Reporter resolves the alias before independent
  field truncation and clears an earlier running `text`, while the raw stream
  remains canonical and explicit non-command tools retain provider-neutral
  `text`
- continuous, version-complete `message_update` events may merge inline
- terminal `message_update` is the durable confirmation; message version gaps,
  invalid/unanchored deltas, nonterminal deltas after known terminal message
  truth, reconnects, Turn, Interaction, and state changes trigger authoritative
  reconciliation
- event publication or observer failure cannot roll back a committed canonical transaction
- message projections preserve the original textual content, including leading
  and trailing whitespace; trimmed or whitespace-collapsed copies may decide
  emptiness, synthetic-control suppression, or duplicate identity, but must not
  replace the body passed to renderers. Markdown renderers continue to own
  soft-break presentation.

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

When authoritative identity, Turn, or Interaction is missing, return unsupported/loading/error. Capability presence is explicit: a null session capability snapshot means no authoritative session snapshot is available (not yet reported or legacy-ambiguous), while a non-null snapshot is complete and may explicitly contain no supported capabilities. Presentation may fall back from a null session snapshot to the authoritative provider composer descriptor, but an explicit session `false` always wins. Do not choose the first provider, manufacture a Turn, treat an ambiguous legacy empty array as loaded, or hide contract drift behind an ad hoc UI fallback.

Compatibility paths require evidence of existing data or a release window. Keep them isolated from canonical writes.

### 1.8 Contract first

Change OpenAPI before HTTP contracts, then generate Go and TypeScript types. Internal domain types cross layers through explicit projections; do not maintain handwritten transport mirrors.

Identity, time, and state use canonical representations. Unknown enum values produce an explicit unsupported/error path; widening them to arbitrary strings is not compatibility.

## 2. System shape

### 2.1 Command path

```text
AgentGUI / Message Center / host surface
  -> semantic AgentSessionEngine operation or typed intent
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

### 2.3 Session capability snapshots

Provider adapters report canonical session capabilities through a typed,
complete snapshot. They do not place capability ids in provider-private
`RuntimeContext`. A missing snapshot means no authoritative session snapshot
is available because it has not been reported yet or legacy data is ambiguous;
an empty reported snapshot means no canonical session capabilities are
supported. Partial state reports omit the snapshot and preserve the last
reported value.

Persistence uses a private JSON compatibility carrier for capability ids plus
explicit report presence, then exposes only the typed optional snapshot at the
store boundary. Legacy non-empty lists are reported snapshots; legacy empty
lists without presence evidence remain unknown. The daemon API projects
unknown as `null` and reported snapshots as a closed boolean record.
This does not require a database schema migration: the presence marker lives
inside the existing metadata JSON column, and decoding normalizes old rows.

`activity-core` owns the presentation resolution rule: a reported session
value overrides composer options, while a null session snapshot falls back to
the authoritative provider composer descriptor. AgentGUI consumes that result
and does not add provider-specific or control-specific fallback logic. Host and
runtime operation handlers remain authoritative when an action is submitted.

Runtime context transport also distinguishes a complete snapshot from an
explicit top-level `set`/`unset` patch. Omission preserves existing context;
patches may update only provider-private keys and must never replace unrelated
session metadata.

### New-session launch settings

Remembered composer defaults are target-scoped preferences, not active Session
state. AgentGUI reads them only while composing a new Session and sends the
resolved sparse settings through the normal activation command. A host-owned
entry capability may additionally hide or disable an experimental control; the
activation boundary must fail closed as well, so a remembered `true` value
cannot outlive a disabled host entry. Provider support comes from the resolved
composer descriptor rather than provider-name checks in shared UI code.
Extension-owned model catalogs can change independently of target-scoped
remembered defaults. On Create, the daemon treats such a default as a fallback
preference and resolves an obsolete value to the extension runtime's current
model. Non-explicit model-dependent settings, such as reasoning effort, resolve
against that effective model rather than remaining bound to the obsolete
preference. A model or dependent setting explicitly supplied by the caller
remains strict. If the runtime rejects an explicit model selection, startup
fails rather than continuing with an undisclosed provider default.

Settings that affect provider preparation are immutable after launch. The
daemon validates them against current product policy and resolved provider
capability before runtime preparation; an active Session cannot reinterpret
them through an in-place settings update.

### 2.4 Ownership map

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

### 2.5 Ephemeral observation gaps

A Host may expose an ephemeral observation gap for one exact Session and Turn
when its caller-side projection may be stale. The gap is presentation-only:
AgentGUI pauses the processing animation, keeps recovery chrome visible, and
blocks commands that require current state until the Host removes the gap. A
Host may additionally classify the gap as peer-offline or synchronizing; while
that classification is present, AgentGUI replaces the numeric live duration
with the matching status copy. An older Host that omits the classification
retains the frozen-duration fallback.

An observation gap does not settle, interrupt, or otherwise rewrite the
canonical Turn. The Host owns reconnect and catch-up fencing and must remove
the gap only after the same Turn is authoritative again. When the capability
is absent, AgentGUI preserves its existing lifecycle presentation.

An exact pending Interaction is a separate admission scope. When its Host
supplies interaction readiness, that exact result owns transport presentation
and early write admission for the pending card. An observation gap may still
govern the active Turn before or after that Interaction, but it cannot override
the exact ready or blocked readiness result while the card is presented.

When an exact Interaction is blocked, AgentGUI keeps the pending action visible
but disables its controls. The disabled action group remains focusable and
hoverable so the same readiness reason is discoverable in the conversation
chrome and Message Center; this is presentation only and does not change the
Host-owned admission decision.

Message Center and attention-card consumers preserve this separation in their
presentation contract: `isSubmitting` describes an in-flight response, while
an independently supplied interaction-disabled state blocks the nested prompt
controls without hiding the pending card or its conversation navigation. A
host-provided blocked reason is exposed through a focusable, hoverable
description so a blocked card remains understandable without making Tooltip
the command authority. If the Host omits the reason, the disabled wrapper stays
out of the tab order and does not create an empty Tooltip. The final semantic
command admission check remains in the consumer/controller path.

### 2.6 On-demand status

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
or transport diagnostics. The limits projection preserves stable codes such as
`auth_required`, `session_expired`, and `subscription_required` through
`AgentStatusValue.limitsErrorCode`; AgentGUI owns their localized presentation
and maps unknown codes to one generic failure label.

An explicit unsupported usage probe is a successful bounded read with no
quotas and `limitsState: unavailable`; it must not become a refresh failure.
Only real authentication, transport, parsing, timeout, or execution failures
project `limitsState: error`.

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

Authentication status is evidence-based and provider-neutral. A local status
command, marker, token, or API key proves only `configured`. A provider-backed
account probe or successful agent request proves `authenticated`. An explicit
remote authentication failure proves `required` and outranks stale local
credentials until credentials change or a later provider request succeeds.
`packages/agent/daemon/providerstatus` owns evidence reduction; `tuttid` owns
the live outcome store, cache invalidation, and public status projection. Tutti
Desktop management surfaces and AgentGUI consume that same status. They may
keep a `configured` provider launchable when availability is `ready`, but must
not relabel it as connected or authenticated.

For subscription OAuth, provider descriptors select the remote-auth strategy.
Claude Code uses `GET https://api.anthropic.com/api/oauth/usage`; Codex uses the
provider runtime's `account/rateLimits/read`. These checks are attempted on
ordinary status detection and become stale after 15 minutes. Visible, focused
Desktop windows reconcile stale providers on focus/visibility activation and
on the 15-minute poll. API-key configuration skips subscription OAuth checks.
Explicit authentication rejection is authoritative; rate limits, server
errors, and network failures leave the weaker `configured` state intact.
These checks validate current access but do not rotate refresh tokens; refresh
ownership requires a separate serialized credential lifecycle that can gate on
live provider processes.

### 2.6 Developer cassette replay

The developer-only `agent.sessionRecording` desktop preference defaults off.
When enabled, Desktop injects its recording and replay controls through generic
AgentGUI render slots. AgentGUI contains no recording/replay API, controller,
state, provider branch, component, or copy.

The provider-neutral renderer contract is published separately as
`@tutti-os/agent-session-replay`. It owns the portable activity event type and
interaction contract shared by Desktop and TSH; product adapters still own
scope mapping, persistence, HTTP/Electron integration, replay runners, and
provider/runtime setup.

`packages/agent/session-replay` owns the provider-neutral Recording/Cassette
workflow, status transitions, portable contracts, and validation policy.
`services/tuttid/service/agentsessionreplay` is Tutti's HTTP/product adapter and
composition surface; Desktop is the Electron/renderer adapter and composition
surface. Desktop reads the authoritative recording list after mounting and
projects commands; React state is never the source of an active Recording.
`packages/agent/daemon/runtime` retains only concrete recording and scripted
replay transport mechanics.

The default-off preference is a startup composition gate, not only a UI gate.
The renderer awaits initial persisted preference hydration before it constructs
the Workspace service container, so composition never reads transient in-memory
defaults. The preferences module owns this readiness seam; Replay remains a
consumer of the hydrated feature flag and does not add a parallel event center.
The main-process Replay composition module owns manager/access/control creation
and all Replay IPC bindings; general runtime IPC supplies only Electron and
daemon adapters. When disabled, Desktop main does not create the Replay process
manager, access adapters, control writer, or Replay IPC handlers, and the
renderer keeps the replay activity bridge inert: it creates no recording
binding, recorder map, or Engine observer. When enabled, the
`agent-session-replay` feature-local activity bridge owns the recording binding,
recorder map, and Engine observer fan-out; `WorkspaceAgentActivityService`
remains the Activity Engine/reconcile facade and delegates that replay boundary
to the bridge. The renderer creates recorder state only for the lifetime of an
active Recording and mounts isolated Replay observers only inside the Replay
runtime. Changing the preference does not claim to recompose a running daemon
or renderer; the next process composition applies the new value.

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
Recording and Cassette metadata. The list header can import one or more portable
Cassette directories through a native Desktop file selection. `tuttid`
validates every manifest, file inventory, hash, portable state, identity, and
size limit before copying the batch into daemon-owned storage and projecting
each valid Cassette as a completed Recording in the current Workspace. Invalid
or conflicting members report per-Cassette failures without rolling back other
successful imports; source directories are never mutated. The Desktop Replay
feature service owns the native import adapter call, loading and error state,
and the authoritative Recording refresh after any successful member. React
dispatches that semantic command and renders its localized outcome toast; it
does not compose preload and refresh operations. A completed recording exposes
Play directly in its list row. When at
least two distinct root Sessions are available, the
list may enter temporary batch-selection mode and submit their exact Cassette
IDs in one Replay Workspace launch. Selecting one Recording disables other
Recordings for the same root Session; this selection disappears when the list
closes and is never Recording or Cassette domain state. The primary workspace
recording list exposes Delete for inactive rows and requires a
portaled destructive confirmation dialog before removing the Recording and its
Cassette. Active rows remain protected by the daemon workflow. The primary
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
The isolated Replay Workspace reuses the Workspace window composition and
mounts one AgentGUI Workbench Node per Replay Cassette. Desktop installs one
Workspace replay binding, not one binding per Node. The binding maps generated
Engine `commandId` values to the exact Cassette; command results never fall back to
recorded correlation IDs across Cassettes.

Desktop mounts Cassette-scoped status observation and playback controls through
each AgentGUI Node's composer footer slot, while Replay runtime state keeps
them empty in normal windows. AgentGUI lays this accessory slot out as a
full-width wrapping row below the primary composer controls so Replay transport
does not compete with handoff, model, or reasoning controls in narrow Nodes.
Replay speed is a daemon-owned command. The
isolated Node resolves its Cassette from exact Node identity before reading or
updating playback through Desktop IPC.
Replay status remains visible independently of provider transport readiness:
the footer renders with disabled transport controls until playback becomes
active, and terminal completion produces a success toast in the isolated
Electron window.
The primary recording list asks for automatic or manual playback when Play is
selected. Automatic mode preserves continuous playback. Manual mode enters the
isolated runtime paused at the first inspectable checkpoint, so no initial
Activity interval can race a later renderer Pause command.
Pause, resume, and checkpoint movement use a versioned
`replay-control.json` handoff at
`TUTTI_AGENT_SESSION_REPLAY_CONTROL_PATH`, because pausing only the provider
transport would still allow the runner to dispatch later business stimuli.
The runner publishes daemon-confirmed semantic checkpoint state and playback
mode beside phase in `replay-status.json`; Desktop observes that file but does
not manufacture playback state in React. A checkpoint becomes inspectable only
after the exact Node is mounted, its logical Session is selected, current
detail is hydrated, and the renderer has observed the satisfying canonical
version. Controls remain forward-only;
Desktop does not expose previous-checkpoint or restart.
The primary window owns only Replay launch feedback. Main supervises the
runner by `(launchId, cassetteId)` and keeps Cassette milestones in memory plus
the temporary Surface-status handoff. It does not persist playback execution,
checkpoint, completion, failure, or cancellation into the primary daemon. The
cassette runner writes Cassette-scoped replay, verification, success, or failure
events, and a failure in one Surface keeps the Replay Workspace open while
other Cassettes continue.

The runner uses isolated daemon state and Electron `userData`. CDP opens
AgentGUI, selects the provider and exact Session, and verifies the rendered
result. Recorded business stimuli are sent through the isolated daemon HTTP
contract; they are not reconstructed from composer clicks. Cassette transport
selection is daemon composition and does not change Session, Turn, Interaction,
Goal, or runtime-operation lifecycle ownership in Host. The semantic Replay
runtime creates the isolated Workbench snapshot with onboarding already
auto-opened and no restored nodes, so the runner can open only AgentGUI.
Create-session stimuli persist the
effective launch settings returned by the recorded Session; Replay must not
recompute model, reasoning, permission, or speed defaults from the current
machine. The runner preserves lifecycle ordering by waiting for the canonical
Session to become idle before dispatching each recorded `session.send`; HTTP
status retries are not lifecycle authority.

Managed Replay launch has two Cassette-scoped milestones. `surface-ready` requires
the exact Node to be mounted, its root Session selected, and that Session's
detail hydrated; it closes launch feedback but does not complete the Cassette.
`replay-complete` is emitted only after that Cassette's stimuli, transport check,
and expected-state check succeed, and only that milestone resolves the
Cassette's local completion as `complete`. A create-session Replay restores its
recorded rail Project, waits
for the create command, and selects the exact canonical Session without
reloading the page.

## 3. Domain model

### 3.1 Session

A Session holds identity, target, provider metadata, cwd, title, settings, resume information, a Goal reference, and the current active Turn reference.

Session title has an explicit ownership rule in the runtime. A user title
(explicit rename) is immutable from the turn-execution path: a running turn may
fold provider/event titles as candidates, but the controller's current Session
is the only accepted state, and the turn-completion commit merges only the
turn-owned lifecycle/status fields back. A title the user set is never
overwritten by a late provider title or by a stale turn-completion snapshot,
and neither the stream projection nor the durable report may carry a stale
provider title over an established user title. On resume the runtime fails
closed and treats a persisted title as user-established.

A Session does not copy Turn phase/outcome, own pending Interactions, or persist lifecycle inferred from transcript.

If provider-native compaction fails because the current context is already over
its hard limit, the provider adapter projects one typed
`context-handoff-required` system notice with error severity. AgentGUI localizes
the failure and tells the user to start a new conversation and mention the
exhausted Session there. Tutti does not replace the provider session or
automatically redispatch the user's next message: the fresh root Session and
its canonical `agent-session` mention make the handoff explicit and preserve
the user's control over what continues.

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
identities are session-scoped and are remapped during the atomic clone. Fork
titles are allocated across the complete lineage family, so a source titled
`Session` produces `Session (2)`, `Session (3)`, and so on even when a later
Fork starts from an earlier child.

### 3.1.1 Session Fork

`throughTurn` means the boundary Turn and all earlier canonical history are
included. AgentGUI emits only the canonical Turn id. Host resolves its durable
provider root Turn id and invokes the exact provider adapter selected by the
runtime registry; shared UI and Host code never branch on provider names.

The projected Session capability is provider/runtime-level:

```text
provider registry declares native Session Fork
  AND the exact adapter/version attests throughTurn support
  AND provider state has an explicit host-copy or provider-owned binding mode
```

Only that conjunction projects `lifecycleCapabilities.forkThroughTurn=true`.
Projection consumes a live observation or persisted driver attestation only;
it does not prepare or launch a runtime. The full preparation and exact driver
revalidation happen after the user requests Fork.
Turn-level eligibility is the single
`providerForkBindingAvailable` fact projected from a non-empty canonical
`rootProviderTurnId`, plus the canonical Turn being `settled`. Host eligibility
remains optimistic and verifies only those selected-Turn facts. AgentGUI
exposes Fork only for settled, provider-bound Turns. This per-Turn presentation
rule is shared by every Agent provider. Source activity, pending Interactions,
descendants, and historical prefix provenance do not hide Fork actions for
earlier settled Turns. Only an in-flight Fork for that exact canonical Turn
disables its button.

Session Fork is also a default-off Developer capability. Desktop exposes its
persisted `lab.agentSessionFork` switch in Developer settings and maps it to an
explicit AgentGUI host opt-in, so provider support alone does not expose the
action. Tuttid independently enforces the same flag on new Fork writes;
disabling it leaves existing lineage, operation reads, and operation
acknowledgements available.

Execution accepts a worktree-isolated source. A provider-native Fork retains
the provider cwd, and Tutti freezes the same cwd and isolation coordinates into
the target snapshot without creating or transferring worktree ownership.
Other runtime facts are frozen into the target snapshot as well.
Only attachments referenced by that snapshot are staged into the target
namespace; the source attachment directory is never copied wholesale.

Fork is a durable Host-owned saga:

```text
prepared -> dispatching -> provider_accepted -> committed
                  \-> unknown
           \-------------------------> failed
```

`requestId` is the caller-stable replay identity and
`targetAgentSessionId` is reserved at prepare. Prepare freezes the complete
canonical snapshot through the selected Turn, the selected provider binding,
driver kind/version, runtime context, settings, and a deterministic attachment
manifest. Referenced attachments are staged into the target namespace before
provider dispatch. The source remains writable; only physical deletion retains
the frozen resources. A second explicit Fork from the same boundary is valid.
The provider call begins only after the `dispatching` marker commits.

The provider adapter verifies only that the selected provider Turn exists in
the provider source. Tutti deliberately trusts earlier provider and canonical
history to represent the same conversation. Provider acceptance and the child
provider Session id are persisted before host-copy binding and canonical
materialization. A binding or materialization failure therefore leaves
`provider_accepted`; retry continues only local work and never reissues the
provider mutation.

`prepared` recovery safely continues dispatch because the durable marker proves
the provider call has not begun. A crash in `dispatching` becomes `unknown` and
is never automatically redispatched. `provider_accepted` recovery retries only
local binding and materialization. The canonical commit consumes the frozen
snapshot without re-proving the live prefix, remaps all session-scoped ids,
normalizes a live boundary to `settled/interrupted`, supersedes copied pending
Interactions, persists lineage, and emits the complete committed delta.

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

A provider adapter must publish `interaction.requested` with the complete
immutable input required by the action surface. When a provider splits one
request across ordered wire frames—for example permission identity and options
first, then the matching question body in a tool update—the adapter correlates
them by exact Turn and tool-call identity and delays Interaction publication
until the input is complete. A later transcript tool update cannot repair an
already-persisted incomplete Interaction. The adapter must also validate that
the provider wire can represent every answer allowed by the published surface;
an unsupported shape fails before publication instead of exposing a lossy
Interaction. This publication gate applies equally to emitted events and
`SessionState.PendingInteractive`; a snapshot must not leak the incomplete
request while the adapter waits for the later frame.

A child Interaction may appear in the root conversation, but submission carries the exact `(agentSessionId, turnId, requestId)` tuple.
Every AgentGUI, Message Center, Desktop notification, and Mobile action submits
that tuple plus the user's current answer through
`engine.submitInteractionResponse`. The Engine allocates command identity,
applies the shared 30-second timeout, rejects non-pending or in-flight targets,
and recognizes an explicit exact repeat after a confirmed failure. It does not
silently reuse the previous answer when a caller omits fields, and it does not
retry delivery-unknown responses. Plan-implementation actions remain their
specialized plan-decision workflow rather than masquerading as ordinary
Interaction responses.

Free-text approval feedback is a non-terminal rejection. When an approval
offers both `deny` and a terminal `deny_and_stop`/abort option, the feedback
surface submits the non-terminal deny option and preserves the full feedback
payload; abort remains a separate stop action. A provider adapter first
acknowledges that exact approval response, then carries the feedback through
the provider's active-turn guidance protocol using the exact provider thread
and Turn identities. Waiting for that guidance acknowledgement must not turn a
successfully answered Interaction into a failed runtime operation.

### 3.4 Goal and operations

Goal is a Session-level durable entity, not a Turn command. It owns desired/observed state, revision, and an independent operation.

A Goal operation may produce zero or more provider Turns, but it cannot reserve or fabricate Turn IDs. Goal control bypasses the prompt pipeline and does not create a user transcript Turn message. AgentGUI dispatches `goal/controlRequested`; the workspace Engine owns the provider-neutral `goal/control` command, typed effect execution, and exact Session-scoped result reconciliation. AgentGUI may project its durable session audit as a dedicated `goal-control` timeline row; that row has no Turn ID and does not participate in Turn counts, processing ownership, cancellation, or settlement. When the audit carries a user-visible command body, the dedicated row also uses the shared user-message action surface, including copy.

When a session-level timeline row occurs chronologically between two rows from
the same Turn, transcript presentation keeps one Turn group and renders the
session-level row as an interstitial item. This presentation grouping does not
assign the row a Turn ID or make it lifecycle-owned by that Turn.

Host owns recovery for runtime operations, Goal operations, and the reconcile inbox. An adapter must not start a second worker or state machine.

On daemon restart, Host recovery first restores durable operations, then settles unrecoverable active Turns as `settled/interrupted` and supersedes pending Interactions.

Codex's restored Full access warning is presentation-only, device-local safety chrome. Show it only when an empty home composer restores an unacknowledged Full access target default; do not show it for another provider or permission mode, an active or historical Session, or while defaults are loading. Explicit Full access confirmation and “Don't show again” persist the same browser-local acknowledgement, while the close action affects only the current mount. This acknowledgement must not enter Session lifecycle, target defaults, Workbench node data, or `AgentGUIRuntime` state.

### 3.5 Edit retry and effective history

Edit retry is a Host-owned lifecycle operation, not a transcript mutation and
not a GUI-orchestrated pair of provider calls. It is available only for the
latest settled root user Turn when the provider exposes authoritative effective
history and the Session has no active or child work. The command carries the
exact Turn id, expected history revision, edited text, and a caller-stable
operation id.

```text
AgentGUI edit intent
  -> agent-activity-core typed command + stable client operation id
  -> Desktop transport adapter
  -> tuttid HTTP adapter
  -> Host durable edit-retry operation
  -> provider rollback/read/start capability
  -> SQLite effective-history transaction
  -> committed activity invalidation
  -> Desktop semantic event normalization
  -> agent-activity-core state-and-message reconcile
  -> AgentGUI canonical projection
```

Host checkpoints before provider mutation and treats provider `thread/read` as
the authority after an unknown result. Confirmed rollback retracts one complete
Turn from effective history but retains its audit row and file-change record.
The replacement reuses the persisted structured submission and changes only
its first text block, preserving attachments and other non-text input. Rollback
is never represented as natural-language model input.

AgentGUI projects only three presentation states: ready, processing, and
needs-action. It may expose edit controls only on the exact eligible Turn.
The workspace `AgentSessionEngine` owns command identity, pending/failure
state, recovery-action dispatch, and command-result reconciliation; React keeps
only the unsent editor draft and awaits the engine-owned command settlement.
An accepted transport result enters an engine-owned `reconciling` state and
does not overwrite canonical availability. Editing stays blocked until a
session-detail read confirms the returned history revision and recovery state;
Desktop must not manufacture recovery actions from the command response.
`resend_pending` and `recovery_required` are explicit recovery states rather
than indefinite loading. GUI recovery commands delegate to Host and never
choose whether rollback or replacement should be repeated. Completion and
terminal Turn events request both state and message reconciliation because
events are latency hints; the authoritative detail and message reads repair
missed WebSocket delivery without requiring a Session switch.

### 3.6 Messages and ordering

A durable message has two independent ordering values:

- `sequence`: presentation order assigned at creation; streaming updates do not change it
- `version`: per-session mutable change cursor used for incremental updates and gap detection

Lifecycle timestamps describe occurrence time; they do not replace durable sequence. A live message with unknown Turn ownership must be completed or rejected at the boundary, never assigned an owner in GUI.
Optimistic prompt and Goal-control echoes occupy a separate overlay ordering
domain. They remain after all currently durable messages until canonical
confirmation replaces them; their earlier submission timestamps must not move
them back through durable transcript history during message projection or
timeline merging.

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
- session mutation, Goal Control, settings, composer options, and operation
  state
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
can contain Sessions backed by different transports or access policies. The
host projects `available`, transport/capability blocking, or the explicit
`agent_sharing_revoked` state with the owner display label. The engine uses that
single fact to gate sends, cancellation, settings, and Interaction or plan
responses. AgentGUI preserves the composer draft content but disables editing
and runtime-dependent actions. A revoked shared Session keeps its history and
renders the package-owned owner-specific notice; it becomes available again
only when the host projects the sharing relationship as active. It must not
reuse the engine-wide connection state for this case, because one remote
Session losing its owner or access must not disable Local Agent or another
remote Session.

Mobile projects pending Interactions from the root conversation plus its child
Sessions and reads each exact Engine response record for submitting/failure
state. Native cards call `engine.submitInteractionResponse`; they do not
construct response intents, recover previous answer payloads, or keep a
parallel Promise lifecycle. After a confirmed failure, Mobile keeps the
canonical prompt and its explicit answer controls visible instead of replacing
them with a payload-free retry button. Missing provider-authored Plan options
fail closed, and runtime unavailability disables the exact response without
discarding composer drafts or Interaction identity.

Device connection presentation is target-scoped rather than Session-scoped.
The host exposes a target connection source keyed by `agentTargetId` with the
current status and retry attempt, and AgentGUI reads the active conversation
target or the selected Home target. This lets a new-conversation composer show
and enforce connection state before any Session exists. Session runtime
availability remains the independent command safety gate for existing
Sessions; it is not the source of device connection presentation.

Sharing eligibility is a parent gate for device connection. When an owner has
revoked a Session's shared Agent relationship, the host projects
`agent_sharing_revoked` and does not manufacture a target transport state for
that relationship. Device reconnect and automatic retry presentation begins
only while the sharing relationship is active.

Outside an exact pending Interaction, AgentGUI projects a blocked target
connection through the chrome above the composer and gives it precedence over
other non-interaction recovery notices because ordinary Composer writes cannot
complete while the target is blocked. An explicitly terminal `unavailable`
state appears immediately. Initial `connecting` appears only after a
300-millisecond controller delay so short background connections do not flash.
A recoverable host retry, including a dormant low-frequency retry, remains a
neutral `connecting` presentation and updates the visible retry attempt without
restarting the delay. During the initial delay, the raw target state already
blocks commands, but AgentGUI keeps the existing non-interaction recovery
chrome visible until the connection notice replaces it. Recovery removes the
notice without a success banner. The notice does not offer a manual retry
because transport recovery is host-owned.

When the Host supplies readiness for the exact approval or interactive prompt
being presented, that readiness result is the sole transport-chrome and early
write-admission authority for the card. Target connection and exact-Turn
observation gaps continue to gate ordinary Composer commands, but neither may
hide the card or override an exact ready or blocked interaction result.

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

Engine submitting and unconfirmed-submit selectors remain busy facts after a
canonical Session first appears. Session existence or an `available` runtime
must not create an idle frame before the exact Turn claims the submission. A
viable new-Session activation with `initialTurnExpected` remains the same busy
bridge while no canonical latest Turn exists. Goal-only activation deliberately
does not set `initialTurnExpected`, because Goal Control does not synchronously
create a Turn. A viable initial Goal `set` whose projected Goal is still active
remains a busy bridge only while the Goal is optimistic or the host supplies an
exact pending/applying/unknown `goalSyncState` with a pending operation
identity. A synced Goal proves only that the Goal mutation converged; it does
not prove that a future Turn will exist. The first canonical Turn, a synced or
non-active Goal,
`failed`/`diverged` synchronization, `pending`/`applying`/`unknown` without an operation identity,
or a canceled/failed activation releases the bridge; initial Goal `clear` never
creates it. A host that omits `goalSyncState` cannot prove post-create execution
and therefore fails closed to the canonical availability projection instead of
keeping the composer busy indefinitely. When a provider exposes an exact
session-level `running`/`idle` observation before Turn identity, the daemon
projects that
typed, non-persistent runtime activity through `agent.activity.updated` after
the associated state report wins canonical ordering. Desktop and Mobile Live
consume the same event variant. The workspace Engine uses its occurrence time
to reject reordering and prevents an older `running` observation from
overriding a settled Turn. A disconnect clears the ephemeral observation,
while canonical Turn state remains authoritative once it exists. AgentGUI
consumes the Engine's fenced Session display status after the canonical
Session exists; it must not recompute Composer busy state from the raw runtime
activity flag, because that would let an older `running` observation outlive a
completed or failed latest Turn. Raw runtime activity may bridge presentation
only before that canonical Session projection exists.

### 4.1 Read/write rules

- reads use exported selectors or memoized `AgentActivitySnapshot`
- an engine subscriber notification is an invalidation signal, not a render
  command. Concurrent AgentGUI surfaces subscribe through exact
  Session-family or target selectors; a selector preserves its selected
  reference when another root Session changes
- AgentGUI transcript presentation subscribes to projected messages for only
  the selected root Session and its current child Sessions. This projection
  includes optimistic `message_delta` text before durable confirmation, while
  preserving message-array references for every unrelated Session
- whole-workspace `AgentActivitySnapshot` projections remain valid for bounded
  aggregate reads, but do not belong in high-frequency AgentGUI render paths.
  Event callbacks that need current canonical data read the engine snapshot at
  event time instead of retaining a whole-workspace render snapshot
- lifecycle writes use semantic Engine operations or typed intents/commands
- composer-option reads use `engine.loadComposerOptions`; the Engine owns
  request identity, signature-aware cache reuse, identical in-flight joining,
  supersession, exact settlement, caller abort, and disposal. Desktop and
  Mobile retain transport execution in their `EngineExtensionCommand`
  adapters and delegate pure generated-DTO projection to
  `@tutti-os/agent-activity-tuttid-adapter`
- A composer-option failure with no signature-matching cached value remains an
  explicit Engine `error` state. AgentGUI renders a compact failure and retry
  action in the existing options slot instead of presenting an empty list or a
  stale/default selection; a last valid cached value remains renderable while
  its load status is reconciled. The retry is the same semantic
  `engine.loadComposerOptions` operation with `force` left false, so request
  identity, cache reuse, and identical in-flight joining remain Engine-owned;
  a view must not call the transport adapter directly.
- an acknowledged home Composer default remains an optimistic draft until a
  later authoritative Composer-options response reports the same effective
  field value. A successful read alone must not retire the draft because a
  slow or overlapping provider discovery may still return an older default.
  When a settled response omits that field, AgentGUI keeps the optimistic
  intent but releases its confirmation marker so providers that cannot project
  the field do not remain on permanent forced, uncached discovery. Concrete
  conflicting authority is retried only for a bounded number of confirmation
  reads; if a provider keeps normalizing, rejecting, or overriding the default,
  AgentGUI protects the optimistic intent from generic option sanitization only
  while that confirmation marker remains active. Releasing the marker lets later
  settled options apply normal sanitization and return to the Engine's
  signature-aware cache
- the Engine alone translates shared activation, prompt send, settings update,
  Goal Control, turn cancel, Interaction response, rename, pin, and
  batch-delete commands into `AgentSessionEffectPort` calls. Desktop and Mobile
  effect ports retain transport, product integration, and host-specific DTO
  mapping. Their create/send request and Turn response projections delegate to
  `@tutti-os/agent-activity-tuttid-adapter`; they must not duplicate a
  command-type switch for these shared effects. Host activity facades call
  `engine.activateSession`, `engine.submitPrompt`, `engine.controlGoal`,
  `engine.stopSession`, `engine.updateSessionSettings`, `engine.renameSession`,
  `engine.setSessionPinned`, and `engine.deleteSessions`; these deep methods own
  the applicable workspace projection, protocol or mutation identity, timeout,
  cancellation, settlement, and canonical result projection. Settings
  update is fire-and-observe intent admission rather than a settlement Promise:
  the existing settings-operation selector remains the source of pending,
  failed, and unknown state. Hosts must not reconstruct mutation protocol with
  reducer intents and snapshot reads or construct raw
  `session/settingsUpdateRequested` fields for an existing Session.
  Session stop is also fire-and-observe admission: the Engine owns its command
  identity, 30-second cancellation timeout, duplicate fence, and 30-second
  first-Turn waiting window. Desktop AgentGUI and Native Mobile call
  `engine.stopSession` and never construct raw `session/stopRequested` fields.
  Existing-Session Goal Control is also fire-and-observe admission. The caller
  proposes one stable `clientSubmitId`; the Engine admission returns the
  effective identity used for settlement. The Engine owns workspace scope,
  command identity, the 30-second transport timeout, one in-flight operation
  per Session, optimistic Goal projection, typed result validation, and
  delivery-unknown reconciliation. AgentGUI reads
  `selectSessionGoalControlPresentation` and never stores a parallel optimistic
  Goal or settles the transport Promise itself. Desktop and Mobile effects send
  the request and map the authoritative Session/Goal/operation evidence only.
  Session activation enters through `engine.activateSession`. Desktop AgentGUI
  and Native Mobile keep product-specific target selection, placement, initial
  content/settings, and stable request identities, while the Engine owns
  workspace scope, timestamps, construction of `activation/requested`, the
  accepted result, and one 120-second confirmation window. The confirmation
  deadline is later than the 90-second new-Session command timeout so a valid
  slow runtime startup cannot expire while the command may still succeed.
  The typed activation effect returns either the created authoritative Session
  or the resumed Session's authoritative detail aggregate. The Engine validates
  the versioned `activation-v1` result contract, result scope, mode, and every
  nested Session/Turn/Interaction entity, then projects the aggregate in its
  own drain. Desktop and Mobile effects retain transport, DTO mapping, and
  product-local integration/observability concerns, but must not pre-dispatch
  those projections.
  Canonical monotonicity guards prevent a late activation response from
  regressing newer realtime state.
  A failed new-Session activation is a rollback signal only when the Engine's
  canonical Session selector confirms that no Session entity exists. If the
  Session exists but runtime startup or the initial Goal failed, the Session
  remains selectable and the failure is rendered as Session detail state.
  An explicit historical-row selection has higher priority than stale
  activation failure metadata; it first requests detail reconciliation and
  only returns home after an authoritative not-found result.
  Surfaces clear a new-Session draft only after activation admission succeeds.
  If an admitted new-Session activation is canceled before canonical Session
  confirmation, the surface restores the submitted draft only while the
  current draft is still empty, releases the pending `clientSubmitId`, and
  allocates a fresh identity for the next explicit submission.
  Existing-Session Prompt submission enters through `engine.submitPrompt`.
  The surface keeps the stable `clientSubmitId` used by its draft-recovery and
  idempotent-retry bookkeeping; the Engine owns workspace scope, timestamps,
  routing protocol, the shared 120-second confirmation window, and the
  accepted/queued admission result. Desktop AgentGUI and Native Mobile clear a
  submitted draft only after that result confirms admission, and never
  construct raw `submit/requested` fields or rebuild admission from selectors.
  New-Session initial content continues to travel with activation.
  Provider acceptance protects provider-turn identity and fork safety, but it
  is not the prompt's durability boundary. If runtime delivery is explicitly
  rejected or times out with an unknown outcome, Host persists the submitted
  content and `clientSubmitId` independently of the canceled request. Existing
  sessions then receive a terminal failed Turn or an uncertain-delivery claim;
  only an unobserved provisional activation may be compensated away.
  Platform-only commands remain in each host's `EngineExtensionCommand`
  adapter. Every effect propagates its typed Engine origin and Engine-owned AbortSignal to its
  transport. Rename, pin, and delete settle through the shared Session-mutation
  state. Rename and pin may update canonical Session state only from a validated
  authoritative Session result. Delete may remove canonical Sessions only from
  a validated `SessionDeleteMutationResult`, projected as `session/removed`
  tombstone intents. Caller cancellation aborts the host effect, but an already
  accepted write remains delivery-unknown until later canonical reconciliation;
  it is never converted into a confirmed failure. Direct settings changes,
  post-activation persistence, and
  prompt-required settings share one per-Session Engine lane. Owner boundaries
  are serialization barriers rather than coalescing opportunities. A validated
  precondition updates canonical Session state before the Engine starts send,
  while a failed or timed-out precondition prevents delivery. A timed-out
  settings write remains delivery-unknown and does not release queued writes
  automatically. A fresh explicit settings selection is the user's retry:
  `engine.updateSessionSettings` recognizes the exact Engine
  settings-operation state, so Desktop AgentGUI and Native Mobile do not derive
  retry flags independently. Ordinary approval and question answers similarly
  enter through `engine.submitInteractionResponse`; the Engine owns exact
  Interaction identity, command identity, timeout, deduplication, and
  confirmed-failure retry admission. Surfaces submit the current explicit
  answer and never dispatch `interaction/responseRequested` or reconstruct a
  previous answer themselves
- consumers do not read reducer maps directly
- consumers do not create canonical session/message mirrors
- optimistic records define confirmation, rejection, timeout, and uncertain-delivery paths
- business command completion returns to the engine as a result intent; controllers do not rebuild lifecycle with Promise/effect chains

Edit-and-retry availability is an exact SessionEngine projection, not a fact
inferred from transcript order. AgentGUI edits only the authoritative eligible
latest Turn, preserves attachment and non-text blocks through the Host-owned
submission envelope, and never optimistically splices the transcript. After
the command is accepted, Desktop applies effective history through the
composite authoritative snapshot; AgentGUI only renders that canonical result.
An authoritatively retracted initial optimistic prompt is marked on its pending
activation so it cannot be materialized again while activation metadata and
turnless controls remain intact.

### 4.2 Historical pull and realtime push

- list/history reads use `session/snapshotReceived` and do not create unread completion
- newest-to-oldest reads attach their authoritative message-window coverage to
  the same snapshot intent; incremental/realtime updates preserve that coverage
- realtime authoritative entities use upsert intents
- optimistic `message_delta` updates invalidate the exact Session projection;
  they do not write an unconfirmed message into canonical Engine state.
  Terminal `message_update` reconciliation replaces that optimistic projection
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
  polling, and presentation side effects. A shared-agent detail open also
  re-materializes a durable binding into the local Engine when its cached
  binding exists but the local runtime projection is absent; this repairs local
  state and does not mutate historical data.
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
- a queued-prompt `Send next` action uses native guidance when the provider
  supports it, even when the provider also supports interruption; guidance
  stays on the same canonical Turn and follows the provider's native semantics
- Claude SDK guidance acknowledges delivery only after its SDK interrupt has
  succeeded and the guidance prompt has been enqueued; a failed interrupt is a
  failed guidance request and must not allow the old response to keep running.
  The confirmed interruption settles the old response's streaming projections
  while the canonical Turn remains active for the guidance response
- Codex/Tutti Agent guidance sends `turn/steer` with the exact active provider
  Turn identity. Steering inserts the guidance into the current provider Turn;
  it does not interrupt the response or start a replacement provider Turn. If
  the provider response has already ended while the canonical Turn remains
  active for child work, guidance may start a provider continuation with
  `turn/start` on that same canonical Turn
- guidance captures the canonical `activeTurnId` at the interaction boundary
  and carries it through the queue, activity adapter, daemon API, Agent Host,
  and runtime Controller; `turnId` is required for every cross-process
  guidance request and is never inferred from the latest Session snapshot
- Host and the runtime Controller compare that target with the live active
  Turn while holding the lifecycle admission lock. A mismatch is a typed
  pre-provider rejection (`NotDispatched`), and a prepared submit claim is
  removed so the failed guidance cannot strand the queue or be redirected to a
  newer Turn
- otherwise send-now performs exact cancel-then-send
- user Stop pauses the queue; cancellation must not leak the next prompt
- a prompt settings precondition is an explicit preparation stage, not a nested
  host effect. It serializes with direct and post-activation settings writes,
  updates the canonical Session on success, starts send before releasing later
  settings writes, and fails the logical prompt without delivery when the
  settings result is not valid
- a visible failed queue entry continues to own its submitted content for retry;
  draft settlement must not duplicate that content back into the composer
- uncertain delivery reconciles by `clientSubmitId` and exact `turnId`; it never resends merely because the Session appears idle
- editing a queued prompt restores its stable attachment references, then rehydrates missing image previews through `AgentGUIRuntime` with the exact workspace and Session identity; renderer-inaccessible paths never become image URLs, and late reads may update only the matching restored draft image
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

The full AgentGUI surface reads the optional
`AgentGUIRuntime.conversationRailQueryLimits.sectionRefreshLimitMax` backend
contract and passes it to that same controller. A host whose section endpoint
accepts less than AgentGUI's default refresh limit must declare its positive
maximum instead of relying on transport rejection or adapter-side truncation.

Resolved query results may be reused from the workspace cache. In-flight
first-page entity payloads are controller-generation scoped and must not be
shared across mounted controllers: detach, pause, or a scope change must fence
both Engine ingestion and cache writes from the obsolete request.
The canonical factory owns one resolved-query cache per workspace Engine, so
Desktop and Mobile receive the same remount semantics without exposing cache
access through `AgentGUIRuntime` or a host adapter.

Hosts own the transport adapter, DTO mapping, runtime-availability policy, and
surface lifecycle. For example, Mobile owns disconnected polling and
foreground/background pause-resume around the shared controller. Native hosts
also own their renderer, localized status projection, and interaction layout;
those host concerns must not leak back into the shared query controller.

Mobile DeviceLink recovery is application-scoped rather than screen-scoped.
`MobileApplicationService` is the single owner of the paired-device connection
phase (`idle`, `reconnecting`, `synchronizing`, `connected`, or `failed`).
Native stops Agent Live immediately on background entry while retaining the
underlying DeviceLink for its background grace interval. Every Native-to-JS
live delivery carries the caller-owned subscription generation; the bridge and
workspace live lane reject deliveries from a closed generation before they can
reach the coordinator. JavaScript records the background entry time and uses
elapsed time on foreground instead of relying on a timer that the runtime may
suspend. Foreground resume queues canonical workspace and selected-Session
reconciliation before opening the replacement live lane. An unexpected
live-lane disconnect first allows one bounded stream retry, then rebuilds
DeviceLink if the stream remains offline. Runtime commands stay blocked until
the replacement live lane reports ready.

Recovery retains the current device, workspace, navigation, and drafts behind a
global blocking presentation. A replacement workspace scope is started and
authoritatively hydrated before it atomically replaces the paused scope; a
failed candidate cannot clear the visible conversation. The App-root overlay
only projects the service phase and exposes retry or explicit return-to-device
commands. It does not own timers, transport checks, retry policy, or copied
connection state.

Cross-platform hosts may reuse the DOM-free canonical Rail summary projection
from `@tutti-os/agent-gui/conversation-rail-projection`. They must still obtain
ordered membership, project labels, totals, and cursors from the authoritative
section query and join those IDs to canonical engine Sessions. Native hosts own
their renderer and interaction layout; they must not import Desktop or Web
components, infer project membership from `cwd`, or create a second Session
lifecycle store.

AgentGUI's existing-Session project projection uses the authoritative
`railSectionKey` as its only join key: it matches that value exactly against a
registered user project's `sectionKey`. The key is immutable under runtime
reports, `cwd` changes, and user-project list updates. The `conversations` key,
a missing key, or an unknown key fails closed to no project
label even when the Session `cwd` equals or sits below a registered project
path. Conversely, a recognized project key keeps its project identity when the
runtime `cwd` is an isolated worktree or another detached execution directory.
Path matching is reserved for resolving the user's explicit project selection
before a new activation; it is not an existing-Session compatibility fallback.
The Remove project action delegates one awaited operation to the daemon. The
daemon deletes every unpinned root through the canonical Host batch path, keeps
pinned Session trees, atomically rehomes retained rows to Chats, and only then
removes the user-project row. Failure keeps the project visible for retry; the
renderer does not compose candidate-query, Session-delete, and metadata-delete
requests itself.
Native Mobile applies the same rule to Activity labels and Rail placement.
Section `sessionIds` remain query membership, page-boundary, initial-order, and
hydration data. After joining those memberships to current Engine entities,
hosts sort loaded ordinary sections by the canonical conversation sort key:
the latest Turn start time, falling back to Session creation time. Streaming
freshness, status, and completion updates do not change that key, so parallel
running Turns do not churn Rail positions. Pinned sections preserve the query's
pinned order. If a section disagrees with a Session's canonical
`railSectionKey`, the host rehomes the row by the Session key instead of
accepting the stale membership; presentation reordering must not mutate cached
memberships or pagination cursors.

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
`AgentSessionEngine` semantic operation keyed by the exact Agent Target. Both
Desktop and Mobile call `engine.loadComposerOptions`; the generated tuttid DTO
is mapped once by `@tutti-os/agent-activity-tuttid-adapter` into
`AgentActivityComposerOptions`, while the host extension adapter remains the
transport seam. Hosts render provider-authored options and use the shared
support projection, but keep Native/DOM menus and temporary open state local.
Existing-Session setting changes enter through
`engine.updateSessionSettings`. The Engine allocates command identity, fixes
timeout and retry policy, and translates the semantic call to its internal
`session/settingsUpdateRequested` intent. New-Session draft settings travel on
the activation intent instead; provider-independent draft projection and
Desktop-persisted defaults remain surface policy until activation. A renderer
must not call the settings endpoint from a component or invent a
provider-specific settings schema. Desktop and Mobile project the broader
Engine settings through one generated-contract allowlist before composer-option
or existing-Session settings requests. Both preserve supported fields such as
`browserUse`; neither sends `computerUse` until OpenAPI adds that request field.
Existing-Session Prompt sends similarly enter through `engine.submitPrompt`;
Desktop and Mobile provide content plus a stable client submit identity, while
the Engine owns common routing, confirmation expiry, and admission projection.
New- and existing-Session activation enters through `engine.activateSession`.
The surfaces retain target selection, placement, initial draft projection, and
stable request identity; the Engine derives workspace and timing fields,
projects the typed intent, and reports whether it was admitted. Actual Session
creation, resume, and initial Turn lifecycle remain owned by Agent Host behind
the host effect port.

An activation intent's shared Session settings are not an HTTP create-field
allowlist. Each host must construct a typed
`CreateWorkspaceAgentSessionRequest` and forward only fields present in the
generated contract. Both hosts preserve `browserUse`, which is a supported
create field. In contrast, `computerUse` is a default-on runtime setting but is
not currently a create-request field; neither host may add it as an extra
property. Supporting an explicit first-Turn opt-out requires changing OpenAPI
and the create adapters first.

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

### Conversation Rail Activity View

`AgentGUIRuntime.conversationActivityViewEnabled` is the fail-closed host
boundary for the Conversation Rail Activity View. Desktop opts in explicitly;
external hosts that omit or disable it retain the ordinary Rail unchanged.

The view is a presentation-only activation over the current workspace Engine:
it reads visible root Session summaries, each root Session's own lifecycle
status, root-conversation attention/read state, and already-cached Session
messages. Descendant lifecycle activity remains available in the conversation
detail and interaction surfaces, but it does not change the root row's Rail
status. A pending descendant Interaction still contributes canonical
root-conversation attention so an approval or question cannot disappear with
the filtered child row; submission retains the exact child identity. Opening
Activity View must not call list pagination or transcript hydration.
Its membership input is the canonical mounted Engine summary collection, never
the ordinary Rail's transient `runtimeRailConversations` overlay; stale page
projections therefore cannot leak into Activity View.
Membership and recency are snapshotted when the view opens; subsequent Engine
pushes reconcile incrementally, while deletion removes a member immediately.
The Activity controller owns that activation and its retained row cache;
React render only consumes the controller snapshot and projects live row facts.
Existing Priority member IDs and their relative order survive ordinary Rail
refreshes that temporarily omit a summary; the controller uses the last known
row summary until the next toggle or an explicit canonical tombstone. Selecting
a historical Session that is temporarily injected into the visible summary
list does not make an idle Session a newly discovered Activity task; only its
live waiting, unread, or active facts can admit it to Priority.
The Engine preserves this distinction at the Turn boundary: `turn/upserted`
uses `live` provenance. Historical detail hydration writes canonical Turns with
`live: false` and cannot create new unread attention; realtime projections and
live reconcile writes use `live: true`. Omitted `live` remains compatible with
older hosts and is treated as live, while historical producers must pass
`false`. Existing durable read and unread markers remain authoritative during
hydration; only a read marker synthesized by the current historical observation
may be upgraded by a later live observation for the same completion.
The activation is scoped by the workspace, authenticated user, rail filter,
AgentGUI node, and Engine identity, not by the currently selected Session's
provider or target; selecting a row must not rebuild a cross-provider Activity
queue.
Search temporarily takes over the content area and clearing search restores the
same activation. Closing the view discards the activation and its retained row
cache. Existing workspace, authenticated-user,
rail-filter, AgentGUI-node, and Engine identities fence the activation
internally; the selected Session's provider and target do not. No Activity
filter or additional host scope contract is introduced. Disabled hosts use an
empty Activity selector and do not scan root Sessions. Activity rows omit the
minute-clock subscription together with their hidden timestamp. The full
product contract is recorded in
`docs/specs/2026-08-05-agent-conversation-activity-view-prd.md`.

The full first-page query is the only Rail read that resolves a navigation
scope and clears its pending state. Targeted section refresh and pagination may
update only an already-resolved matching scope. A subordinate result must not
cancel the full query, publish partial membership for an unresolved scope, or
unlock Rail interactions.

When Activity View has a non-null in-memory projection, that projection remains
visible while the unrelated initial Rail membership query is pending; Rail
loading, empty, or failure placeholders must not replace it. A refresh or page
failure after Rail rows already exist preserves those rows and reports a
non-blocking error through the host toast capability, falling back to the UI
System toast when that optional capability is absent. An unresolved empty Rail
scope retains the centered error state and its retry action.

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
frame. A mounted detail view retains the scroll anchor and follow-end mode for
each exact Agent Session it visits. First selection follows the end; returning
to a detached Session restores its retained position, while returning to a
following Session stays at the end. This mounted-view memory retains at most 64
recently used Sessions and evicts the least recently used entry beyond that
limit. It expires with the mounted view and never enters navigation, Engine, or
Session state. Prompt submission, an explicit scroll-to-end request, or the
user actually reaching the end may reattach. Content growth, layout effects,
observers, virtualizer geometry, and near-end thresholds are sensors or
executors only; they must not transition the mode.

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

Structured user-prompt transcript images keep resource acquisition and browser
image decoding as separate presentation states. A URL or hydrated data source
is not proof that pixels are ready: AgentGUI reserves the final thumbnail
geometry and shows its loading treatment until the exact image element reports
`load`. `error` replaces that slot with the retryable failure treatment. A retry
of the same URL or a replacement effective source starts a new decode attempt
instead of reusing stale loaded or failed state. These loading and retry states
are UI-local and never enter canonical Message or workspace-engine state.

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

Standalone hosts rendering `AgentConversationFlow` may also pass the current
Agent target presentation catalog through the `agent-conversation` entrypoint.
The flow scopes that catalog to all historical rich-text rows, so `agent-target`
and `agent-session` mentions use the same provider icon and identity
presentation as the full AgentGUI node without copying the catalog into
canonical activity data. Omitting the catalog preserves an inherited AgentGUI
presentation context. The standalone flow also owns its visibility-aware
conversation clock, so a hidden host does not keep elapsed-time presentation
timers active.

Hosts whose action directories omit valid identities supply the complete
presentation-only catalog through `mentionAgentDirectory`. It retains exact
target IDs and unavailable Agents without making them launchable. Hosts that
omit this capability keep the existing union of provider-rail and handoff
targets. Interactive composer mentions, readonly rich text, and Markdown links
must resolve presentation through the shared target-presentation resolver.
They must not infer icons from target-id formats such as `local:*`; serialized
mention presentation is only the fallback when the current catalog no longer
contains a historical target.

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

For an active Session, the composer treats `agentSessionId`, `agentTargetId`,
and `provider` as one Engine-owned identity projection. It must not combine a
target id from the canonical Session with a provider from lagging Workbench
node data. If the Engine target is not yet available or belongs to a different
selected Session, composer-option loading waits instead of issuing a guessed
request. The home composer continues to use its selected Agent Target as one
atomic projection.

Trusted host/daemon code resolves a target-backed request through `agent_targets`, then derives provider and runtime reference. If a client supplies both target and provider, daemon rejects a mismatch.

### 5.2 Provider strategy

```text
provider ID
  -> daemon providerregistry descriptor
  -> typed strategy / capability
  -> provider-neutral consumer
```

An unknown provider produces explicit unsupported behavior. Provider adapters normalize their own wire; shared renderers consume canonical message/tool/notice contracts only.

Desktop managed-provider setup reads the generated provider catalog's
`statusKind` strategy before requesting a provider-specific runtime candidate
catalog. The setup service and view must not keep a second provider-id list or
branch directly on provider names.

Skill invocation follows the same boundary. Filesystem and runtime adapters
discover skill identity, source, and plugin ownership; `providerregistry`
projects the provider-authored trigger and invocation strategy. Composer and
host adapters consume that projection and must not rebuild `$` versus `/`,
plugin namespaces, or prompt-item versus text-trigger behavior from provider
names.

App-server-backed skill discovery follows the descriptor boundary. Tutti Agent
requests only `skills/list` and retains the ordinary Skill projection through
the shared app-server transport, capability contract, cache, and structured
prompt-item submission path.

Tutti Desktop's slash connector section is a local catalog projection,
not a Provider connector catalog. `services/tuttid/service/agent` reads the
daemon-owned connector-market application through its read-only snapshot port;
the Agent service never opens or receives the underlying repository directly.
It projects manifest presentation (including the catalog icon) plus installation,
authorization, and compatibility into a provider-neutral capability option, and
replaces any Provider-reported connector capabilities before returning composer
options. This keeps installable connectors visible in the slash menu while
ensuring that only installed and authorized connectors can be invoked. AgentGUI
does not scan external MCP, plugin, or package-manager configuration and does not
infer installation from a remote market response.

The device-global `lab.connectors` UI-preference flag controls whether that
projection is returned. The daemon fails closed when the preference is absent
or unreadable and removes Provider-reported connector entries as well as local
ones. Desktop invalidates cached Composer Options when the preference changes,
publishes the same invalidation through the AgentGUI host event bus, and
projects the host capability into the palette so stale cached connector rows
are hidden immediately. Workspace and standalone AgentGUI surfaces therefore
converge on the next canonical read without exposing stale entries. The flag
does not uninstall connectors, stop their runtimes, or reject an already
structured connector prompt.

Desktop also projects the flag through AgentGUI's existing host-owned
capability-menu state. The primary footer capability slot is mutually
exclusive: when `lab.connectors` is off it renders Tutti Mode, and when the
flag is on it renders only the Connectors menu. The same footer serves both the
home hero and existing-session dock, so the two AgentGUI contexts cannot drift.

### 5.3 Agent Directory and setup

The host provides a complete, ordered Agent Directory with this load lifecycle:

```text
idle | loading | ready | error
```

`ready` may contain an authoritative empty list. `error` may retain the last successful snapshot. Components must not infer loading from `agents.length`.

One-shot Desktop surfaces that emit Agent identity, such as outcome
notifications, start and await their own Agent Directory load attempt before
resolving presentation. They must not depend on an AgentGUI or Workbench React
effect to initialize the directory.

The provider descriptor's target sort order owns the default built-in Agent
order. Tutti Agent is the first built-in target; an explicit device-local
Provider Rail reorder remains a presentation preference and takes precedence
over that default.

Tutti Agent is also the first Desktop default Provider for ambiguous new
entries. An exact persisted Agent Target or an explicit launch request still
takes precedence. AgentGUI and launch surfaces that require readiness fall back
through the authoritative ready Agent Directory when that default is
unavailable.

The directory owns Agent presentation. `agents[].iconUrl` is the primary
presentation asset used by conversation identity, Message Center, mentions,
and the empty-home carousel and Provider Rail. It is decorative metadata:
an Agent with an exact `agentTargetId` and name remains selectable when the
icon is absent. `maskIconUrl` may supply the monochrome conversation-row glyph.
Desktop Workspace Agent projections first inherit the resolved icon of their
Harness target by exact target ID, then use the provider/icon catalog fallback.
Host projections preserve these roles independently and do not create
provider-specific renderer catalogs.

AgentGUI accepts separate directory projections for separate responsibilities:
`agentDirectory` owns the current runtime rail, `handoffAgentDirectory` owns
launch choices, and optional `mentionAgentDirectory` owns exact rendered
identity. The mention directory may include offline or otherwise unavailable
Agents and must not participate in selection, admission, setup, or handoff.
This keeps availability as action state instead of deleting identity metadata.

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

Provider-declared terminal authentication remains a Host capability, not React
or Session lifecycle. AgentGUI's target-setup controller owns the local
`idle`/`waiting`/`error` projection and terminal handle, while the Desktop host
launches the workspace terminal and monitors the authoritative target-setup
watch until it reports ready or the bounded wait expires. The view only renders
that controller state and dispatches start/cancel intent; it must not add its
own effect or timer polling loop, raise the AgentGUI degradation baseline, or
infer authentication from terminal output.

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

`@tutti-os/agent-gui/quick-composer` is the draft-only public entry for
launch surfaces that need the canonical DOM Composer without a Rail or
timeline. It may present rich text, image draft blocks, and an exact Agent
Target selector, but it owns no Session, Turn, option-loading, or recovery
state. The host receives its typed prompt envelope and must route new Session
creation through the workspace's existing `AgentSessionEngine`; the entry must
never construct a second Engine or call a lifecycle transport.

The embedding host owns target readiness and capability loading. It passes the
canonical `agentTargetId` plus a capability snapshot for each selectable
target. Quick Composer resolves only the exact identifier and fails closed for
unknown, disabled, or capability-less targets; it never falls back to array
position, legacy `targetId`, or an inferred provider. Structured image content
is accepted only when the selected target declares image support. Submit emits
the resolved target identity with the prompt envelope, preserving the target
the user actually selected across the host activation boundary.
The Quick Composer public target omits legacy `targetId` and AgentGUI-internal
`ref`; the adapter derives both from canonical `agentTargetId` for the shared
Composer VM. Provider-menu selection therefore cannot cross or collide with a
second identifier namespace.

When an embedding host supports pre-session settings, it passes one explicit
settings capability containing authoritative `AgentActivityComposerOptions`,
a controlled sparse settings draft, its change callback, and option-loading
state for the exact target and project. Omitting any persistence path means
omitting the whole capability, so Quick Composer fails closed instead of
rendering interactive no-op controls. It projects supported values into the
same model, reasoning, speed, permission, plan, and browser controls rendered
by the full Composer; it does not maintain a second menu implementation or
fetch options itself. `computerUse` and gated `codexSaverMode` remain hidden
until an embedding activation seam preserves and authorizes them end to end. A
settings change returns a typed patch to the host, which refreshes authority
and forwards the settled draft through its existing activation command. Only
the very first options load for a target locks settings controls and submit;
once a good options snapshot exists, background refreshes keep every control
interactive and a failed refresh keeps the last good snapshot instead of
blanking the menus.

`@tutti-os/agent-gui/composer-settings-core` is the host-agnostic policy for
that settings capability. `ComposerSettingsCore` is a headless controller
(`subscribe`/`getSnapshot`, no React, no Engine dependency) that owns the
sparse settings draft, a revision-fenced options lifecycle with last-good
retention, defaults seeding via the daemon's defaults-merged
`effectiveSettings`, and trailing-edge write-back of explicit picks into the
canonical per-target composer-defaults ledger through injected ports
(`fetchOptions`, `rememberDefaults`). `resolveSubmitSettings()` returns the
exact values the composer displays; hosts must submit them verbatim so the
daemon never re-interprets empty fields against another surface's memory. A
Quick Composer host embeds this core instead of hand-rolling fencing,
failure semantics, or a parallel settings store; the desktop capture window
is the first adopter.

The Quick Composer uses the Composer's `embedded` layout contract. Unlike
`dock`, which intentionally grows attachments and long drafts upward over a
conversation timeline, `embedded` keeps the entire draft in normal document
flow. Compact host surfaces must select that layout instead of compensating for
dock overhang with consumer-specific offsets or clipping.

Embedding hosts may inject the same `RichTextMentionService` and workspace
reference-picker callback used by a full AgentGUI surface. Quick Composer wraps
those inputs in the canonical mention-service boundary and delegates reference
insertion to `AgentComposer`; it does not own a parallel mention catalog or
picker. A constrained host may also declare a top viewport inset for portaled
menus. Provider Select collision padding and mention-palette geometry must
honor that inset so host chrome is never treated as usable menu space.
An embedding host may also opt into the canonical project selector with a
controlled selected path and an explicit `WorkspaceUserProjectApi`. That
capability supplies the real registered-project catalog, selection preparation,
native directory choice, and project registration. A native directory callback
alone is insufficient: Quick Composer does not invent a project registry or
Session state, so it hides the project selector when no real project capability
is available. The host carries the resulting path through its existing
activation command as `cwd`.
AgentGUI's standalone locale runtime includes the scoped defaults of package
surfaces it mounts, including workspace-user-project. A host-supplied app
runtime may override those keys, but a standalone Quick Composer must never
render an unresolved scoped key as user-visible copy.
Quick Composer also establishes the canonical AgentGUI semantic-token scope,
so embedded placeholder, foreground, border, and menu colors never fall back
to inherited host text styles. Hosts may provide a compact action accessory;
`AgentComposer` renders it immediately before the primary send/stop action in
non-hero layouts instead of requiring consumer CSS to position controls over
the Composer DOM. An embedding host with a definite block size may opt into
`fillAvailableHeight`; the embedded Composer then gives its input group and
each rich-text editor wrapper the remaining height while keeping attachment and
footer rows intrinsic. The entire assigned editor block remains a native
contenteditable hit target instead of relying on a host-level click-to-focus
proxy. This remains explicit so ordinary launch surfaces keep the default
content-sized behavior.

An embedded host may also choose `composerActionPlacement="footer"`. In that
mode the same primary action cluster (including an optional host accessory)
joins the canonical Composer footer instead of the prompt row. This keeps the
reference controls, Agent selector, host modifier, and send button on one
alignment baseline without host positioning CSS; the default remains `input`
for existing consumers.

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
aggregate Stop with Send. Sending from the ordinary composer always uses the
normal source-conversation submit path, including while the Issue and source
Turn are active; canonical busy-session availability therefore keeps the prompt
in the normal queue. Provider guidance capability only enables an explicit
guidance action and never changes ordinary Send semantics. Stop durably pauses
Issue dispatch and cancels its running task Sessions, and also sends the
ordinary source-Session stop only when that Session has stoppable work. The two
idempotent paths are independent because canceling an idle Session merely to
trigger the Issue cascade could capture a later Turn.

Task-level accept and rework controls in that projection prepare localized
instructions in the exact source Session composer; they preserve any existing
draft and never send automatically. They do not call generic Issue Task
mutations or impersonate the source Agent's CLI authority. Once the user sends
the draft, the normal source-conversation submit path applies and the
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

New-Session worktree launch is a fail-closed Host capability, not Session
lifecycle state in React. The host opts in with
`sessionWorktreeEnabled`, projects a launch preference map for the current
workspace keyed by the canonical project `sectionKey`, persists explicit
changes through `onSessionLaunchModePreferenceChange`, and supplies the exact
project-path probe through
`AgentHostApi.workspace.resolveSessionWorktreeSupport`. AgentGUI renders the
selector only when all four pieces exist, the selected target is explicitly
self-owned, a real project path and section key are selected, and the probe
succeeds. Existing Sessions and shared/remote targets never expose it.
Tutti Desktop carries the exact `agentTargetId` and project path through the
generated daemon support contract. Tuttid resolves that target through its
local launch authority and fails closed for shared-Agent identities. The
Session create boundary repeats the same target admission before allocating a
worktree and also requires a project `railPlacement` with a non-empty logical
project path. An unscoped `conversations` Session therefore cannot acquire
worktree isolation even through a direct API request, so React visibility is
presentation defense rather than the business authorization boundary.
The adapter records the selected repository-relative cwd and remaps it under
the isolated checkout, so a registered project below the repository root keeps
the same working-directory scope. A retry with the same Workspace, Session,
repository, and relative cwd reuses its exact metadata-backed checkout before
entering Host idempotency; a mismatched identity fails closed.

The stored `local | worktree` value records future launch intent; canonical
Session `isolation` records what actually launched. Probe failure, temporary
repository incompatibility, or a missing host capability makes the effective
mode `local` without overwriting a saved `worktree` intent. Visiting an old
Session also cannot write that preference. Tutti Desktop persists the nested
`workspaceId -> project.sectionKey -> mode` map in daemon-backed desktop
preferences and enables the capability. Each change uses the daemon-owned
`preferences.agent.session.launch.mode.patch.requested` workspace/project patch;
its SQLite transaction merges against the latest map, and full
desktop-preference updates preserve that field, so concurrent windows cannot
replace one another's choices. Renderer write failures roll back only
the still-current optimistic value and are consumed through the Workbench
diagnostic path. Published AgentGUI defaults the capability off so other hosts
may opt in independently. The composer only adds `isolation: "worktree"` to the
admitted activation input. Tutti's daemon adapter owns the filesystem checkout
and provider-preparation cwd, while Host continues to own the idempotent Session
create. The canonical Session projection later carries the created worktree
path, branch, and base commit. Rail rows render the worktree glyph from that
canonical isolation projection next to relative time in the unhovered row and
never infer it from `cwd`.

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
canonical user-message projection and its turnless Goal-control audit entries;
it does not persist a second history store. These sources are merged by their
timeline timestamps so Goal commands participate in the same Up/Down sequence
as ordinary prompts.
The host capability remains explicit so unsupported hosts can fail closed, but
Tutti Desktop always supplies `sessionInputHistoryEnabled: true`; historical
`lab.agentInputHistory` preference values do not hide or disable the feature.

Composer model recents and favorites are separate browser-local menu chrome.
The Composer presentation projects the exact Agent Target identity together
with narrow provider-native catalog testimony, and one focused controller owns
storage reads, writes, cross-window refresh, and reconciliation. An unresolved
active-Session target disables history instead of reading or writing a shared
fallback bucket. Only an authoritative, settled native catalog may retire a
recent model; loading, empty catalogs, requested-origin entries, and
selected-model-only echoes remain unverifiable. Favorites preserve explicit
user intent even when a model is currently unavailable. The legacy shared
`default` bucket migrates lazily to the first exact target: recents pass through
current authoritative testimony before migration, while favorites migrate
without availability filtering.
Quick Composer projects the same history identity and testimony from its exact
selected target and host-owned options capability. Host-level option loading
keeps that testimony unsettled, so a retained last-good catalog cannot retire
history while the embedding host is refreshing or changing targets.

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

Plain-text absolute path paste may enter an optional host-owned
`workspace.resolvePastedPath` boundary. AgentGUI applies only a strict sync
candidate gate (one trimmed absolute path with no whitespace or quotes). The
host returns a `WorkspaceFileReference` to insert as a file/folder mention, or
`null`/rejection to fall back to plain text. Hosts that omit the callback keep
the previous plain-text paste path; existence checks, host-namespace
projection, and Shared-Agent policy remain host-owned.

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

`AgentToolBrowserPanel` owns its BrowserNode feature, surface identity, and
tab state. It also owns the single browser chrome instance for that surface.
Its controller may activate an existing page by URL inside that one surface;
the product Host remains responsible for choosing among Browser surfaces and
focusing the owning top-level node or window.
Hosts compose window controls into the tab strip through `defaultActions`,
pass draggable-header semantics through `dragHandleProps`, and use
`navigationActions` for address-row actions. A host must not wrap the panel in
a second visible title bar or recreate the browser header outside the panel.

Host-issued `runtimeRequests.composerAppend` values are one-shot requests.
AgentGUI waits until the exact requested Session is the active conversation,
applies the append once, and then calls
`hostActions.onComposerAppendHandled(sequence)`. A Host that retains routed
requests must clear only the acknowledged sequence; it must not let an older
open-Session append mask a newer request.

Collaborative Hosts may supply
`hostCapabilities.interactionReadinessSource` for exact pending Interaction
write admission. The source is keyed by
`(workspaceId, agentSessionId, turnId, requestId)` and exposes only
`ready` or `blocked(synchronizing | owner_offline | binding_revoked)`.
AgentGUI does not compose presence, transport, or lifecycle facts. When the
capability exists, a missing exact record fails closed as synchronizing;
omitting the capability preserves ordinary local-Host behavior. AgentGUI reads
the same source for presentation and again at the event-time submission
boundary. This readiness is ephemeral Host policy and must not enter canonical
Session, Turn, Interaction, or Engine state.

While an exact approval or server-projected interactive prompt is presented,
this capability owns its transport chrome. Target connection and observation
gap sources still govern target discovery, ordinary composer writes, and
sessions without an exact Interaction, but they must not override an exact
ready or blocked result. Synchronizing and owner-offline results keep the
pending card visible while disabling its actions; binding revocation is the
terminal exception.

If an approval and a server-projected prompt coexist, AgentGUI reads readiness
for both exact identities. Each surface consumes only its own admission result;
selecting one as the active prompt must not reuse its readiness for the sibling
Interaction.

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
state without hiding workflow in the render slot. Returning no renderable
content keeps the provider account and quota block unchanged. Returning the
package-owned `AgentGUIConfigAccountFallbackSuppressed` marker suppresses those
generic fallback rows without adding Host content.

Tutti Desktop fills this seam only for its self-owned local Tutti Agent target.
The Desktop Account service remains the source of account, membership, credit,
and Commerce-link state; opening the target menu asks that service to refresh,
and the render slot stays request-free. Its compact Agent menu omits the
redundant Tutti account identity row while retaining credit, membership, and
account-center actions. A signed-out local Tutti Agent returns the suppression
marker because the generic provider-account and quota rows do not describe its
Host-owned account model. Other providers return `null` and retain AgentGUI's
default provider-account and quota presentation.
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

Unavailable Agent targets retain the standard empty-home identity. AgentGUI
projects offline transport and revoked-sharing states through the same Home
status chrome used by other runtime failures, immediately above the composer;
it does not expose a second Host-owned availability container. The canonical
composer gate blocks both editing and submission until the selected target is
available.
Host chrome that aligns to AgentGUI's internal layout must consume explicit
package signals such as `hostActions.onConversationRailLayoutChange`; it must
not observe package DOM, CSS variables, or class names with
`MutationObserver`. Composer affordances belong in AgentGUI itself or a
narrow `renderSlots` contract, not in host-owned portals inserted into package
DOM. During a Conversation Rail drag, AgentGUI emits this signal with
`resizing: true`; the Workbench and standalone desktop headers apply that
ephemeral width only to their own grid alignment, while the existing
`onUpdateNode` path remains the sole persistent width write. Hosts must not
write node state for each pointer movement. AgentGUI updates both its grid
track (`--agent-gui-conversation-rail-width`) and the Rail content width
(`--agent-gui-conversation-rail-content-width`) in that same pointer move;
updating only one leaves blank space when expanding or overflows detail content
when shrinking.

### 6.3 `AgentGUIRuntime` and `AgentHostApi`

`AgentGUIRuntime` is the runtime surface accepted by `AgentGUI`. It owns reads,
Rail queries, file/upload capabilities, subscriptions, diagnostics, and the
workspace `AgentSessionEngine` lookup. Shared lifecycle writes enter through
semantic Engine methods or typed intents; AgentGUI does not require duplicate
`activateSession`, `createSession`, `goalControl`, `sendInput`,
`submitInteractive`, `unactivateSession`, `updateSessionSettings`, or
`updateTuttiModeActivation` callbacks.

`AgentGUIRuntime` is the sole AgentGUI host contract. Hosts must not recreate
the removed lifecycle callbacks as no-op or forwarding adapters. Metadata
actions that AgentGUI still reads directly remain on this surface until their
Engine migration preserves all host observability and product integration.

AgentGUI performance correlation is package-owned through
`createAgentGUIPerformanceMonitor`. A host supplies the workspace Engine, the
existing Session-event subscription, a clock, and a product-neutral event
sink. The monitor joins AgentGUI's preserved `submittedAtUnixMs` and queue
diagnostics to exact Session and Turn identities, then emits activation
settlement, Prompt admission, first-token receipt, Turn settlement, and
Composer-options load facts. `trackComposerOptionsLoad` emits a start fact
before calling either the runtime `getComposerOptions` or exposed Engine
`loadComposerOptions` path, then emits a correlated completed or failed fact
with exact duration. An unmatched start therefore remains observable when a
Provider options request never settles. The facts distinguish runtime from
session-Engine entry, force refresh, directory presence, bounded error
category, and model count without carrying paths, settings, model names, or
error messages.
Hosts map those facts to their own analytics catalogs; they must not copy the
Turn-binding, early-event buffering, duration-bucket, or token-classification
logic.

First-token time ends when the renderer receives the first non-empty Agent
content `message_delta`; its bounded kind is text, reasoning, plan, or other.
It deliberately does not use the producer timestamp, infer a latest Turn,
count tool output, or inspect Prompt or response content. Early deltas are
retained only until the Engine supplies the exact Turn binding, duplicate
deltas emit once, and bounded caches prevent an abandoned Prompt from growing
runtime memory without limit. Exact `durationMs` accompanies the stable
buckets `lt_1s`, `1s_to_3s`, `3s_to_10s`, `10s_to_30s`, `30s_to_60s`, and
`gte_60s`.

`AgentHostApi` supplies host capabilities only: files, clipboard, project/account lookup, Agent Target setup/probes, diagnostics, and OS/Workbench helpers. It must not become a Session, Turn, timeline, or write source again.

Terminal authentication is one such Host capability. AgentGUI receives an
optional atomic `terminalStartupAction` containing a safe slash-command name
and literal readiness marker, then returns it unchanged through
`terminalLogin.run`; neither layer accepts or synthesizes raw terminal input.
Hosts must explicitly list supported startup action types; an older Host that
omits that capability may still expose the manual command fallback but cannot
silently launch a typed action it does not implement.
The Desktop Workbench presenter owns node launch, exact-session readiness
matching, slash submission, diagnostics, and close cleanup. Its startup result
must settle before the setup-readiness monitor starts, so timeout, cancellation,
or transport failure cannot leave a second polling lifecycle behind.

The optional quick-prompt library follows that host-capability boundary. Tutti
Desktop projects the device-global `tuttid` quick-prompt CRUD service through
`AgentHostApi.quickPrompts`; AgentGUI owns only the picker/editor presentation
and inserts a selected prompt into the current TipTap selection without
submitting it. The library snapshot, developer feature gate, and cross-window
invalidation are not Session or Turn state and must not enter
`AgentGUIRuntime` or the workspace engine. Hosts that omit the capability,
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
`AgentGUIRuntime`, the workspace engine, or Workbench node state.

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

Initial content is one user-owned submit flow, but provider acceptance is not the prompt's durability boundary. Once the submitted Turn and prompt are durably recorded, a deterministic provider rejection keeps the visible Session, failed Turn, and user prompt so the failure can be rendered as history. Host then discards the startup runtime without publishing canonical completion. AgentGUI may offer provider login for an authentication failure, but it does not offer manual activation retry for failed or canceled Sessions; the user starts a new conversation instead. Restarted Sessions already project their canonical canceled state, so this presentation rule does not require a separate provider-history query. Only a pre-dispatch startup/validation failure may compensate an empty provisional shell; an outcome-unknown delivery keeps its recovery claim instead of guessing whether the provider ran.
The rejected submit claim is terminal and remains bound to that failed Turn, so
replaying the same `clientSubmitId` is an idempotent read of the persisted
failure and never dispatches a second provider Turn.
The initiating composer snapshots Tutti activation plus effect and speed with
that submit. An explicit active or inactive submit snapshot is authoritative
over a later read of mutable home-draft state; non-composer callers may fall
back to the engine draft when no snapshot exists. `capabilityRefs` remain
independent audit provenance and must never substitute for
`initialTuttiModeActivation`.
An activation may instead carry `initialGoalControl`. In that branch the engine
and runtime adapter preserve the structured `{action, objective}` command.
Desktop and Mobile map it to the typed `initialGoalControl` Create field and
send an empty `initialContent`; the daemon delegates that field to Agent Host,
which creates a non-provisional Session and the durable Goal operation without
manufacturing a Turn. Typed initial Goal and non-empty initial content are
mutually exclusive. The structured field is authoritative; integrations must
not reparse the display prompt or forward `/goal ...` as backend command text
to recover Goal semantics. Host retains text parsing only for compatibility
callers that omit the structured field. AgentGUI represents the pending control
and its durable audit with the same client-submit presentation identity, so
canonical replacement does not remove and recreate the visible `goal-control`
row.
Hosts that can observe the durable Goal saga may additionally project the
optional Session `goalSyncState` (`revision`, `syncStatus`, and
`pendingOperationId`, plus optional `executionPending`). It is read evidence
owned by the Host, not Session-owned Goal lifecycle state. AgentGUI uses an
identified `pending`, `applying`, or `unknown` operation while the exact initial
Goal mutation remains pending. After mutation convergence, `synced` retains the
bridge only when the Host explicitly reports `executionPending=true`. The Host
clears that proof on the first canonical Turn with exact Goal provenance or on
terminal, diverged, failed, or non-active Goal evidence. Omission fails closed,
including across mixed-version hosts; AgentGUI never infers future execution
from `synced` alone or uses a UI timeout.
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
canonical project section resolves that section key back to the registered
project root; its runtime `cwd` may instead be a nested directory or isolated
worktree and is never reused as project identity. “Continue in new
conversation” uses the same resolution before moving the mention draft to
Home. A command already on the home composer preserves the user's explicit
project selection. Views only forward new-conversation intent; unresolved
active rail membership fails closed rather than guessing from composer
presentation fields.
For delegated/shared execution, the initiating caller remains the placement
authority: the adapter forwards that caller-selected `RailPlacement` through
the binding to the owner Host. The owner persists the same section key and does
not recompute it from the owner's user-project list.
The Agent CLI handoff adapter also inherits the caller Session's runtime `cwd`
so the delegate starts inside the same checkout or linked worktree. If a
project-backed caller has no runtime `cwd`, its canonical project path is the
fallback. A supplied caller Session ID that cannot be resolved fails the start
instead of creating a detached Session in an allocator directory.

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

AgentGUI-generated Prompt `clientSubmitId` values are canonical UUID v4
identities. They are opaque correlation and idempotency values because a host
may promote the same identity into a cross-device or shared-execution command.
Business meaning must not be encoded in or recovered from the UUID. In
particular, Plan feedback records its exact `turnId` and `requestId` in the
pending submit's typed `source`; Message Center reads that source through the
activity-core selector. Activity Core continues to accept caller-supplied
submit identities as opaque strings and does not reinterpret or rewrite them.

### 7.2.1 Existing conversation Goal Control

```text
AgentGUI goal action or structured /goal submit
  -> engine.controlGoal(action, clientSubmitId)
  -> Engine Goal operation + optimistic Goal projection
  -> Desktop or Mobile AgentSessionEffectPort.controlGoal
  -> tuttid HTTP request carrying the same clientSubmitId
  -> Agent Host durable Goal saga
  -> typed Session/Goal/operation result
  -> Engine validates Goal state and applies the returned canonical Session
```

Every admitted action reaches Host, even when the projected Goal already has
the requested value, because Host owns the durable revision, operation, and
audit. A typed response with `pending` or `applying` Goal state is `accepted`;
`synced` is `succeeded`; explicit `failed`, `diverged`, and `unknown` states
remain distinct. Only definitive protocol rejections become frontend
`failed`. Timeout, transport loss, or a malformed typed success remains
`unknown`; generic Session reconciliation does
not prove the outcome of a particular Goal operation. Retrying the same action
from `unknown` reuses its original `clientSubmitId`, so Host resolves the same
durable operation instead of creating a second one. A canonical Session Goal
cannot settle the operation by value equality because it carries no operation
identity. At most one operation record is retained per Session and Session
removal clears it. The package root exposes presentation and settlement
selectors, and the public Engine snapshot contains only their derived state,
not the raw Goal operation ledger. These maps are sparse and update only the
Session IDs whose Goal, Goal operation, or Goal-bearing activation changed, so
Turn streaming and unrelated Session changes preserve the Goal branch and
unaffected presentation references. The response `goal` is Host's durable
desired projection; provider observation remains in Goal state and may be
empty without clearing the visible Goal. Only a durable tombstone produces
`goal: null`. A definitive failure releases the old identity; only an unknown
result retains it for an explicit retry. Goal control enters only through the
workspace Engine; AgentGUI has no parallel runtime callback.

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
An optional Host interaction-readiness capability may block an owner-dependent
response while preserving the canonical pending Interaction. Synchronizing
uses the existing device-connecting presentation and disables mutation; it is
not a terminal Interaction or Session outcome. Host submission adapters must
recheck their authoritative projection immediately before transport dispatch;
AgentGUI's early check does not replace Host or provider admission.
An interactive provider callback must not block the transport's message reader
while waiting for user input. If the provider can emit follow-up frames during
that wait, the adapter keeps reading and joins them before publishing the
canonical Interaction. When the answer is delivered, local call resolution is
serialized ahead of provider terminal messages caused by that answer.
Codex app-server requests are classified explicitly against the generated
server-request surface. A request being schema-known does not make it a
background request that may be declined silently. Message-only MCP form
elicitations reuse the canonical approval Interaction and preserve the exact
`accept`, `decline`, `cancel`, and advertised persistence semantics in the
app-server response. Field-bearing forms, URL elicitations, and other request
shapes that AgentGUI cannot represent losslessly fail closed before publishing
an Interaction; adapters must not coerce them into a partial approval or
question surface.
When a standard ACP provider bridges a structured question through
one `session/request_permission` as the complete question transaction, one
selected permission option is that bridge's entire response capacity. The
one-shot adapter therefore publishes only an exact single-question,
single-select mapping whose question labels correspond one-to-one with the
provider's non-rejection options. It marks that surface as option-only,
rejects multi-question, multi-select, free-text, duplicate, or
malformed/mismatched shapes before canonical Interaction publication, and
never records them as answered. On submission, only the single scalar value
in `answersByQuestionId` is authoritative; the flat `answers` list is display
data and must not select a provider outcome. The adapter preserves the
accepted canonical answer payload for local projection but translates its
chosen label back to the provider's opaque option ID. The wire response
remains ACP-native (`outcome=selected` plus `optionId`); renderer actions such
as `submit` are not provider outcome values. A provider may model richer
questions as a correlated sequence of permission requests, but Tutti must
implement that sequence as an explicit transaction before publishing the
richer surface; it must not batch answers into request ids that have not
arrived.
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
one discriminated `AgentGuiWorkbenchCommand` protocol and the node resolves the
target session against canonical rail entities under the rail interaction
lock. While either row
menu is open the row keeps its hover layout (short title truncation, actions
visible) so titles cannot overlap the action cluster.
The existing package-owned AgentGUI external-request controller is the only
consumer of Workbench commands. It routes by exact Workbench instance and
executes new-conversation and Session actions directly, without a host hook,
React request state, or sequence projection. Product hosts provide only the
Workbench instance identity and an optional host-owned Rail response callback.
The reusable Workbench node-state source remains the only embedded Rail state
writer; its callback may record a host device preference but must not write the
same node state again. A standalone surface may use the callback as its sole
Rail state writer because it has no Workbench node-state source. The callback
contract contains no Tutti Desktop preference or product policy, so other hosts
such as TSH may persist their own Rail state without adopting Desktop behavior.

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
gated. The Agent Runtime tab renders built-in provider rows from the
authoritative identity catalog plus the live `IAgentProviderStatusService`.
Stable Agent Extension maturity is declared separately from Early Access
activation flags, and those rows consume their live `IAgentsService` Targets
and package-provided identity assets rather than becoming built-in provider
descriptors. Its Enable/Disable control reads all Agent Targets from
`IAgentsService` and persists the daemon-owned Agent Target `enabled` field.
Tutti Agent is the built-in exception: its target is always enabled, its row
cannot be disabled, and it has no separate developer visibility switch.
Other disabled targets remain in this settings control plane so they can be
re-enabled, but they are excluded from the AgentGUI agent projection and from
CLI discovery and launch. The device-global provider-rail preferences remain
presentation-only (ordering and optional sidebar personalization); they do not
authorize an Agent Target or replace daemon enablement. Staged
(Beta/Preview/in-progress) rows are gated by the `lab.previewAgents` switch via
the provider-neutral `agentGuiWorkbenchPreviewProviders` predicate; stable
built-in and Agent Extension rows always show in settings and launch surfaces.
Deep links publish the existing
`openWorkspaceSettingsPanel` intent with optional `pane`/`provider`; the
Desktop Settings service is the single adapter that resolves legacy aliases
and current destinations for workspace and standalone windows. An Agent
Runtime destination also bumps `agentFocus` to scroll and briefly highlight the row;
a link to a hidden preview agent surfaces an "enable Preview Agents" hint rather
than failing silently. This is a settings surface, not a second Agent Target
state store.

### 8.2 Deleted-conversation settings surface

Deleted conversations are maintained by a top-level desktop Settings section
immediately before About; they do not belong to the Agent subsection. The page
is scoped to the current Workspace, while its 15/30-day automatic-cleanup
preference is device-global. Its fixed header owns the title-only search,
project filter, retention selector, and destructive “delete all” action so the
controls remain discoverable while the list scrolls.

Each row represents one topmost deleted Session component—a canonical root or
a child whose parent is not deleted—and reuses the two-line Activity View
summary convention: title first, then original project identity and the
pre-delete `updated_at`. The row body is not navigation. Restore and
permanent delete are the only row actions; restore has no confirmation and does
not navigate, while permanent delete uses the ordinary destructive
confirmation. Legacy lossy tombstones explain why restore is unavailable.
“Delete all” ignores search/project filters, confirms against the Workspace
component count with a typed phrase, and remains subject to the daemon idle gate.

The list uses stable cursor paging plus virtual scrolling and automatically
loads near its end. Project options include the unscoped case and original
paths whose project registration has since disappeared. Renderer state may
optimistically remove a row only after a successful restore/purge response; it
does not copy lifecycle semantics out of Host or trigger provider resume. The
canonical restore commit emits `session_restored`; the workspace engine clears
only that Session's deletion tombstone and performs an authoritative detail
reconcile before AgentGUI renders it again. Generic activity events remain
unable to resurrect a deleted Session.

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
| `packages/agent/gui/agentGUIPerformanceMonitor.ts`        | product-neutral AgentGUI latency correlation        |
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
