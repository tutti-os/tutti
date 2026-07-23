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

- continuous, version-complete `message_update` events may merge inline
- message version gaps, reconnects, Turn, Interaction, and state changes trigger authoritative reconciliation
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
  -> injected command port
  -> Desktop WorkspaceAgentActivityService / adapter
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
  -> Desktop event/reconcile bridge
  -> workspace AgentSessionEngine reducer
  -> memoized AgentActivitySnapshot
  -> selectors / pure projections
  -> AgentGUI / Message Center / host chrome
```

### 2.3 Ownership map

| Layer                           | Owns                                                                                       | Must not own                                |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `store-sqlite/canonical`        | canonical phase, outcome, origin, Interaction, capability vocabulary, and pure projections | HTTP, provider processes, React             |
| `store-sqlite`                  | canonical transactions, SQLite repositories, durable tombstones/outbox participation       | product UI, transport policy                |
| `packages/agent/host`           | create/resume/send/cancel, Interaction, Goal, operation, and recovery lifecycle            | HTTP DTOs, Electron, concrete provider wire |
| `packages/agent/daemon`         | provider registry, runtime mechanics, wire normalization                                   | AgentGUI policy, cross-provider UI branches |
| `services/tuttid/service/agent` | Host adapters, HTTP/query/composer/product policy, provider preparation                    | reimplementation of Host lifecycle          |
| tuttid `ActivityProjection`     | canonical read projection, commit observation, event publication/repair                    | lifecycle decisions, React state            |
| `agent-activity-core`           | workspace engine, canonical frontend entities, pending intents, queue, selectors           | HTTP, Electron, React                       |
| `agent-gui`                     | runtime contract, projections, controllers, views, UI-local state                          | daemon truth, a second session store        |
| `apps/desktop`                  | tuttid client, SSE, preload, Workbench, windows, file/OS capabilities, runtime injection   | a second Agent business core                |

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

## 3. Domain model

### 3.1 Session

A Session holds identity, target, provider metadata, cwd, title, settings, resume information, a Goal reference, and the current active Turn reference.

A Session does not copy Turn phase/outcome, own pending Interactions, or persist lifecycle inferred from transcript.

Provider-native subagents use child Sessions:

- `rootAgentSessionId` / `rootTurnId`: root execution
- `parentAgentSessionId` / `parentTurnId`: direct parent
- `parentToolCallId`: delegation card correlation
- child messages, Turns, and Interactions retain the child owner

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

Codex's restored Full access warning is presentation-only, device-local safety chrome. Show it only when an empty home composer restores an unacknowledged Full access target default; do not show it for another provider or permission mode, an active or historical Session, preview chrome, or while defaults are loading. Explicit Full access confirmation and “Don't show again” persist the same browser-local acknowledgement, while the close action affects only the current mount. This acknowledgement must not enter Session lifecycle, target defaults, Workbench node data, or `AgentActivityRuntime` state.

### 3.5 Messages and ordering

A durable message has two independent ordering values:

- `sequence`: presentation order assigned at creation; streaming updates do not change it
- `version`: per-session mutable change cursor used for incremental updates and gap detection

Lifecycle timestamps describe occurrence time; they do not replace durable sequence. A live message with unknown Turn ownership must be completed or rejected at the boundary, never assigned an owner in GUI.

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

Runtime command availability is session-scoped whenever one workspace engine
can contain Sessions backed by different transports. The host projects
`available`, `transport_reconnecting`, or `transport_unavailable`; the engine
uses that single fact to gate sends, cancellation, settings, and Interaction or
plan responses. AgentGUI preserves an editable composer draft, disables
runtime-dependent actions, and keeps an active Stop control visible but disabled
until the transport recovers. It must not reuse the engine-wide connection state
for this case, because one remote Session losing its owner must not disable Local
Agent or another remote Session.

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

### 4.1 Read/write rules

- reads use exported selectors or memoized `AgentActivitySnapshot`
- lifecycle writes use typed intents/commands
- consumers do not read reducer maps directly
- consumers do not create canonical session/message mirrors
- optimistic records define confirmation, rejection, timeout, and uncertain-delivery paths
- business command completion returns to the engine as a result intent; controllers do not rebuild lifecycle with Promise/effect chains

### 4.2 Historical pull and realtime push

- list/history reads use `session/snapshotReceived` and do not create unread completion
- realtime authoritative entities use upsert intents
- message updates fold inline only when unseen versions are continuous
- version gaps and reconnects trigger incremental message reconciliation for hydrated Sessions
- Turn, Interaction, and legacy state invalidation trigger authoritative Session reconciliation
- realtime provenance survives until the authoritative result reaches the engine; fetch failure must not downgrade it to historical

### 4.3 Root and child hydration

Workspace lists show root Sessions only. A root detail read also returns nested child Sessions; the engine stores every entity, Rail selects roots, and timeline/Message Center selectors aggregate descendants.

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

The Rail query cache stores section metadata, ordered Session IDs, cursors, and totals only. Session entities always come from the engine.

Hosts install the complete query/mutation cohort from
`@tutti-os/agent-gui/conversation-rail-runtime`; the shared factory owns the
workspace-scoped cache lifetime while transport adapters own only protocol
mapping and authorization. Batch deletion requires both authoritative section
candidate lookup and the batch mutation. AgentGUI fails that paired capability
closed when either method is absent, so the view cannot expose an action that
will resolve to an empty optional-method path.

Presentation-invisible Sessions remain canonical engine entities and stay
available through exact Session selectors for trusted open, reconcile, and
command flows. Plural consumer selectors exclude them before Rail and Message
Center collection projection; a hidden Session must not become a list row just
because it is resumable or receives later canonical updates.

When runtime sections are enabled, projection unions IDs from the current section, search, and reconciliation, then joins canonical Sessions. Unchanged summaries preserve structural sharing so unrelated engine updates do not rebuild the whole Rail snapshot.

Scroll, section collapse, visible limits, and search query belong to mounted view scope. Non-search state is isolated by `workspaceId + agentTargetId/all`; search creates a temporary navigation scope. `activeConversationId` expresses selection only. Scrolling requires an explicit reveal intent.

Rail scroll memory is captured by scroll events and explicit navigation. Effect cleanup must not synchronously read `scrollTop`: React may already have dirtied the document, turning that read into a full layout inside the interaction task.

Contain selection and presentation identity at the Rail boundary. Each section receives the active ID only when it owns the canonical or overlay row; unrelated sections receive `null` so their memoized props remain equal. Rail pane, section, and row receive a dedicated Rail-label projection whose identity changes for locale changes, not provider-specific detail copy. Event handlers shared by every section keep stable identities and read the current scope and lock state when invoked.

Keep section header/action chrome independent from changing item collections. A memoized header receives scalar presentation fields and stable event-time actions; it must not receive the section object or rebuild project/session semantics. Split the header into narrow render islands. Frequently changing derived booleans such as project drag disabled, project action locked, and batch deletion disabled may cross the Section presentation boundary through separate primitive Context projections. The Rail pane owns those providers outside the memoized Section so a projection-only update does not execute item projection; only the frame, forwarded-ref button leaf, or open menu content that renders the value may consume it. Do not combine those values into one Context object or copy them into persistent state. Menu disclosure is view-local state: keep each Radix root and trigger mounted for focus and keyboard behavior, but instantiate portaled content only while that menu is open. A closed menu has no availability-state consumer. The project header remains the native drag source, each project section updates the insertion position across its full area, and the Rail scroll viewport owns the final drop so section gaps cannot discard an already visible insertion target. This is a presentation boundary, not a second Rail or lifecycle store; stable event-time guards remain authoritative for action delivery.

Relative time uses one renderer-realm minute clock. Timestamp leaves subscribe directly; do not thread a tick prop through Rail pane/section/row and rerender the interactive subtree every minute.

### 4.6 Detail and transcript

Rail selection, detail hydration, older-page loading, and transcript projection are separate states.

A focused controller may own detail paging/loading/error. Canonical messages, Turns, Interactions, and optimistic prompts still come from the engine. An empty message list means neither hydrated nor not-found.

Timeline projection is pure, deterministic, and provider-neutral. React views render rows/cards and dispatch actions.

High-frequency transcript updates must not pair DOM mutation with unconditional synchronous reads of the timeline's full scroll geometry. Conversation switches, explicit submit-to-bottom requests, skeleton transitions, and older-page prepend restoration may perform pre-paint scroll correction; ordinary content growth preserves bottom lock and user scroll-away state from observed content and viewport geometry after layout.

A virtualized transcript derives message-locator selection from the virtualizer's measured turn positions and explicit transcript identity. The currently mounted DOM window is rendering output, not a selection source; range changes must not make the locator temporarily select a neighboring message.

Historical rich text renders from the canonical Tiptap document through a static schema renderer. Only interactive composer surfaces own a Tiptap Editor/ProseMirror EditorView; read-only transcript and title surfaces reuse the same mention/token presentation without mounting editor lifecycle.

Attachment-only fallback labels such as `[Image]` may provide title or summary
text, but they are not an additional transcript text block when the canonical
structured content already renders the same image. Explicit display prompts
remain transcript content and continue to replace expanded rich prompt text.

## 5. Agent identity and provider architecture

### 5.1 `agentTargetId` is UI identity

Use `agentTargetId` for:

- Agent selection and Rail filtering
- composer-options cache
- Workbench node state
- new-session launch
- Agent mentions and handoff targets

`provider` is execution metadata, not UI identity. Multiple Agents may share a provider; UI must not group, deduplicate, cache, or fall back by provider.

Trusted host/daemon code resolves a target-backed request through `agent_targets`, then derives provider and runtime reference. If a client supplies both target and provider, daemon rejects a mismatch.

### 5.2 Provider strategy

```text
provider ID
  -> daemon providerregistry descriptor
  -> typed strategy / capability
  -> provider-neutral consumer
```

An unknown provider produces explicit unsupported behavior. Provider adapters normalize their own wire; shared renderers consume canonical message/tool/notice contracts only.

### 5.3 Agent Directory and setup

The host provides a complete, ordered Agent Directory with this load lifecycle:

```text
idle | loading | ready | error
```

`ready` may contain an authoritative empty list. `error` may retain the last successful snapshot. Components must not infer loading from `agents.length`.

The directory owns Agent presentation. `agents[].iconUrl` is the primary
identity used by conversation identity, Message Center, mentions, and the
empty-home carousel and Provider Rail. `maskIconUrl` may supply the monochrome
conversation-row glyph. Host projections preserve these roles independently
and do not create provider-specific renderer catalogs.

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
visible text.

For a signed Agent Extension, package `icon` is the primary identity and
optional package `maskIcon` is the conversation-row glyph. All assets remain
pinned to the verified active installation.

Target-managed setup uses exact `agentTargetId`; daemon persists its state and actions. Setup gates only the empty new-conversation surface. Active/history conversations follow Session recovery and capability.

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

Home-composer project state distinguishes an unresolved durable default from an
explicit selection whose path may be null. The project selector may apply the
durable default only while that intent is unresolved. Entering the unscoped
conversation section resolves the intent to no project, so remounting the hero
composer or refreshing the project list cannot restore a previous project.

A locked Session cwd existence check is UI-local observation, not Session
truth. AgentGUI starts it only after pending creation has resolved, scopes its
result to the exact Session composer identity, and discards callbacks from a
previous selection. A host probe failure leaves existence unknown; only a
successful check that confirms absence may render missing-project chrome.

The empty-home carousel may measure its placeholder synchronously when live
alignment first activates. Later React updates coalesce alignment into the next
animation frame; ResizeObserver and MutationObserver keep layout roots current.

Composer text transactions may publish the current draft, but the draft value
must not drive synchronous pre-paint geometry reads. The dock observes the
actual editor, input area, and attachment containers; its initial and
subsequent `ResizeObserver` deliveries own height measurement after layout.
Viewport resizing is covered by those element observations and must not add a
duplicate global resize measurement source.

External OS file paste and drop enter one host-injected classification boundary before draft attachment creation. The synchronous `resolveExternalPromptEntries` port classifies each source index as a live `WorkspaceFileReference` or a snapshot requiring preparation. AgentGUI owns ordered mention insertion and draft reconciliation: references become ordinary file/folder mentions and never consume prompt-asset slots, while only `prepare` entries create pending attachment state and enter `prepareExternalPromptFiles`. A host without the resolver prepares every external entry. The preparer owns native-path or byte lookup, size enforcement, persistence, and remote transport; each prepared input has one `sourceIndex` result, one failure must not fail siblings, successful results include a provider-readable `path` or `url`, and failures carry typed error codes. Hosts that classify path-backed entries as references must reject any such entry that unexpectedly reaches preparation, so classification failure cannot silently create a duplicate snapshot.

Workspace picker results and internal workspace-reference drags remain live references. They enter the rich-text document as mentions and never pass through external-file preparation. A picker source whose selected locator is not yet consumer-readable may perform source-owned confirmation preparation before the mention is inserted; the picker waits in a loading state, publishes no partial result on failure, and remains open for retry. This confirmation transaction belongs to the reference source contract and is distinct from the external OS file preparation pipeline. Removing an inline external-file mention removes its draft intent; a later async result must not revive it or lose its error reason when the draft is in another scope.

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

Do not restore flat compatibility props or hide workflow inside a render slot.
Hosts that render capabilities owned by another device set
`hostCapabilities.capabilityControlsReadOnly`; AgentGUI keeps owner-supported
Browser/Computer entries visible but disables their mutation and setup actions.
Unsupported capabilities remain absent according to the authoritative composer
capability descriptor. A caller host must not open its local device settings as
a fallback for a remote owner.
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

The shared Workbench Header owns conversation-identity visibility. When no
Conversation exists, it ignores conversation titles, Agent titles, primary
icons, and fallback icons even if a host supplies them.

The reusable standalone-tool sidebar contract lives in `packages/agent/gui/workbench/tool-sidebar`. Hosts provide the supported panel catalog and render adapters; the shared component owns tab selection, picker, sizing, toolbar mechanics, and the boundary between draggable header space and interactive controls. Native Electron hosts keep the default native-window drag mode, while embedded Workbench hosts select host drag mode and provide their pointer and double-click handlers. The shared component disables native app-region handling in host mode so one header never has two competing drag owners.

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
The initiating composer snapshots Tutti activation and orchestration intensity
with that submit. An explicit active or inactive submit snapshot is authoritative
over a later read of mutable home-draft state; non-composer callers may fall back
to the engine draft when no snapshot exists. `capabilityRefs` remain independent
audit provenance and must never substitute for `initialTuttiModeActivation`.
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

The desktop settings panel's Agent section has four independently gated tabs:
General Settings, Agent Runtime, Custom Agents, and Automation. The Agent
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
