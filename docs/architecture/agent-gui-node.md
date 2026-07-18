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

A Goal operation may produce zero or more provider Turns, but it cannot reserve or fabricate Turn IDs. Goal control bypasses the prompt pipeline and does not create a user transcript message.

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
- attention/read state and cross-surface selectors

The engine does not own daemon persistence, provider transport, DOM, or permanent UI layout.

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
- uncertain delivery reconciles by `clientSubmitId` and exact `turnId`; it never resends merely because the Session appears idle
- the delivery barrier serializes new-Turn sends only; a guidance head steering the running barrier Turn is exempt and may steer it repeatedly, while in-flight, uncertain-delivery, suspension, and failed-head blockers still gate guidance sends
- drain readiness is one pure decision over the queue record and canonical availability; a new blocker joins that single decision with an explicit priority against every existing blocker, never as another independent pre-check in the drain path

### 4.5 Rail query and presentation state

The Rail query cache stores section metadata, ordered Session IDs, cursors, and totals only. Session entities always come from the engine.

When runtime sections are enabled, projection unions IDs from the current section, search, and reconciliation, then joins canonical Sessions. Unchanged summaries preserve structural sharing so unrelated engine updates do not rebuild the whole Rail snapshot.

Scroll, section collapse, visible limits, and search query belong to mounted view scope. Non-search state is isolated by `workspaceId + agentTargetId/all`; search creates a temporary navigation scope. `activeConversationId` expresses selection only. Scrolling requires an explicit reveal intent.

Contain selection and presentation identity at the Rail boundary. Each section receives the active ID only when it owns the canonical or overlay row; unrelated sections receive `null` so their memoized props remain equal. Rail pane, section, and row receive a dedicated Rail-label projection whose identity changes for locale changes, not provider-specific detail copy. Event handlers shared by every section keep stable identities and read the current scope and lock state when invoked.

Keep section header/action chrome independent from changing item collections. A memoized header receives scalar presentation fields and stable event-time actions; it must not receive the section object or rebuild project/session semantics. Split the header into narrow render islands. Frequently changing derived booleans such as project drag disabled, project action locked, and batch deletion disabled may cross the Section presentation boundary through separate primitive Context projections. The Rail pane owns those providers outside the memoized Section so a projection-only update does not execute item projection; only the frame, forwarded-ref button leaf, or open menu content that renders the value may consume it. Do not combine those values into one Context object or copy them into persistent state. Menu disclosure is view-local state: keep each Radix root and trigger mounted for focus and keyboard behavior, but instantiate portaled content only while that menu is open. A closed menu has no availability-state consumer. The project header remains the native drag source, each project section updates the insertion position across its full area, and the Rail scroll viewport owns the final drop so section gaps cannot discard an already visible insertion target. This is a presentation boundary, not a second Rail or lifecycle store; stable event-time guards remain authoritative for action delivery.

Relative time uses one renderer-realm minute clock. Timestamp leaves subscribe directly; do not thread a tick prop through Rail pane/section/row and rerender the interactive subtree every minute.

### 4.6 Detail and transcript

Rail selection, detail hydration, older-page loading, and transcript projection are separate states.

A focused controller may own detail paging/loading/error. Canonical messages, Turns, Interactions, and optimistic prompts still come from the engine. An empty message list means neither hydrated nor not-found.

Timeline projection is pure, deterministic, and provider-neutral. React views render rows/cards and dispatch actions.

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

External OS file paste and drop create snapshot prompt attachments. AgentGUI owns clipboard/drop classification, inline mention position, and draft reconciliation. The injected `prepareExternalPromptFiles` host port owns native-path lookup, byte-size enforcement, persistence, and remote transport. Each input file has one `sourceIndex` result; one failure must not fail sibling files. A prepared result includes a provider-readable `path` or `url`, while a failure carries a typed error code. Host count and byte limits are enforced before expensive reads or persistence.

Workspace picker results and internal workspace-reference drags remain live references. They enter the rich-text document as mentions and never pass through external-file preparation. Removing an inline external-file mention removes its draft intent; a later async result must not revive it or lose its error reason when the draft is in another scope.

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

### 6.3 `AgentActivityRuntime` and `AgentHostApi`

`AgentActivityRuntime` is the AgentGUI activity-data and command boundary. Session, messages, activation, send, cancel, Interaction, Goal, settings, composer options, pin, and delete enter through it.

`AgentHostApi` supplies host capabilities only: files, clipboard, project/account lookup, Agent Target setup/probes, diagnostics, and OS/Workbench helpers. It must not become a Session, Turn, timeline, or write source again.

### 6.4 Multiple surfaces

AgentGUI, Message Center, dock/header, workspace window, and standalone Agent window consume the same workspace engine.

Opening a panel/window creates presentation state only. It does not clone a Session, copy engine entities, or start another event stream. Standalone tools are Desktop chrome, not AgentGUI lifecycle.

The reusable standalone-tool sidebar contract lives in `packages/agent/gui/workbench/tool-sidebar`. Hosts provide the supported panel catalog and render adapters; the shared component owns tab selection, picker, sizing, toolbar mechanics, and the boundary between draggable header space and interactive controls. Native Electron hosts keep the default native-window drag mode, while embedded Workbench hosts select host drag mode and provide their pointer and double-click handlers. The shared component disables native app-region handling in host mode so one header never has two competing drag owners.

## 7. Key flows

### 7.1 New conversation

```text
home composer submit
  -> engine pending activation + optimistic Session/message
  -> Host CreateSession(initial content, clientSubmitId)
  -> provisional runtime + canonical transaction
  -> first Turn accepted
  -> authoritative Session/Turn replaces optimistic projection
```

Initial-content create is one transaction. Failure compensates the provisional runtime/canonical shell; it must not leave a Turn-less Session.

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

Every surface shares request identity and submitting state.

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
