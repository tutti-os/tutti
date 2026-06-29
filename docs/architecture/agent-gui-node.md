# AgentGuiNode Architecture and Troubleshooting

Status: living architecture and debugging playbook

Applies to:

- `packages/agent/gui/AgentGUI.tsx`
- `packages/agent/gui/agent-gui/agentGuiNode/**`
- `packages/agent/gui/contexts/workspace/presentation/renderer/agentGuiConversationList/**`
- Agent conversation, composer, approval, interactive prompt, and timeline
  rendering paths in `@tutti-os/agent-gui`

## Why This Exists

AgentGuiNode is a high-linkage UI surface. A local fix in one file can affect
session activation, conversation list projection, message synchronization,
composer state, bottom-dock prompts, approvals, generated file mentions,
provider capability menus, and workspace workbench node state.

Mature teams usually avoid this class of recurring AI-local-fix bugs with four
guardrails:

- a current architecture map that names the source of truth and ownership
  boundaries
- a "before editing" checklist that forces impact analysis before touching a
  local symptom
- focused troubleshooting playbooks for common broken chains
- a lightweight learning loop that turns repeated fixes into durable notes

This document is the AgentGuiNode version of those guardrails.

## Documentation Placement Decision

Use a two-level documentation model:

- `docs/architecture/agent-gui-node.md` is the durable architecture and
  troubleshooting source of truth.
- `packages/agent/gui/README.md` and `packages/agent/gui/AGENTS.md` are entry
  points that route agents and engineers here before changing AgentGUI or
  AgentGuiNode behavior.

Do not put the full architecture only in `AGENTS.md`. Agent instructions are
good for routing, but they are too easy to turn into a long, stale policy file.
Do not keep the only copy under `packages/agent/gui` either. AgentGuiNode spans
desktop adapter input, workbench activation, activity runtime contracts, and
package-local UI, so the enduring architecture belongs in `docs/architecture`.

## Mental Model

AgentGuiNode should be read as a pipeline, not as isolated components:

```text
desktop workbench activation / node state
  -> AgentGUI package boundary
  -> AgentGUINode shell
  -> useAgentGUINodeController
  -> AgentActivityRuntime snapshot and commands
  -> conversation list store and selected session view state
  -> projection helpers
  -> AgentGUINodeView
  -> composer / transcript / approval / prompt UI
```

The main rule is simple: durable agent activity belongs to
`AgentActivityRuntime` and the desktop `WorkspaceAgentActivityService`.
AgentGuiNode may own UI-local state such as selection, draft text, panel
visibility, scroll/loading/error state, temporary optimistic overlays, and
layout preferences.

## Architecture Verdict

The current AgentGUI architecture is directionally correct:

- `@tutti-os/agent-activity-core` is the deep module for durable activity
  semantics. Its interface is the host-agnostic `AgentActivityAdapter` and
  `AgentActivityController`; its implementation hides snapshot identity,
  message merge, event retention, composer options caching, and live updates.
- `apps/desktop` owns the concrete adapter and product integration. It knows
  about `tuttid`, Electron/preload APIs, user projects, analytics, provider
  status, desktop preferences, and workbench activation.
- `@tutti-os/agent-gui` owns reusable UI and UI-local state. Its public
  interface is `AgentGUI`, `AgentActivityRuntime`, host capability props, and
  the workbench contribution helpers.
- AgentGuiNode reads durable activity through `AgentActivityRuntime` and keeps
  only UI-local state such as drafts, selection, queued prompts, detail loading,
  prompt suppression, rail layout, and optimistic overlays.
- Transcript rendering is separated from the full node through the reusable
  `agent-conversation` path. Message Center also consumes the same activity and
  prompt projection vocabulary.

There are also real architectural debts:

- `useAgentGUINodeController.ts` is still a very large implementation module.
  It has a narrow outward interface (`{ viewModel, actions }`), but low
  internal locality. Changes inside it need stronger chain tracing and focused
  tests.
- `packages/agent/gui/contexts/workspace/presentation/renderer/**` is a
  migrated path name. Treat its stores as package-owned AgentGUI UI stores, not
  desktop renderer ownership.
- `packages/agent/gui/agent-gui/**` still contains more than AgentGuiNode
  (`RoomIssueNode`, `terminalNode`, `workspaceDesktop`, batch runner). Treat
  that folder as the legacy workspace-node area. Do not infer that all code
  inside it belongs to the conversation node.
- Some Host API compatibility types still exist for tests, projection, and old
  adapters. Production data flow must continue moving through
  `AgentActivityRuntime`.

These debts do not invalidate the current layering, but they explain why local
fixes often miss neighboring links. Future refactors should deepen existing
modules and improve locality without creating new generic packages.

## End-To-End Architecture Chain

```text
tuttid daemon APIs / event stream
  -> desktop AgentActivityAdapter
  -> WorkspaceAgentActivityService
  -> createDesktopAgentActivityRuntime
  -> AgentGUI
  -> AgentActivityHostProvider / AgentActivityRuntimeProvider
  -> useAgentGUINodeController
  -> AgentGUIConversationListStore + AgentSessionViewStore
  -> model/projection helpers
  -> AgentGUINodeViewModel + actions
  -> AgentGUINodeView
  -> AgentConversationFlow / composer / approval / picker UI
```

Workbench and desktop product integration wrap that chain:

```text
Workbench dock or external launch
  -> createAgentGuiWorkbenchLaunchDescriptor
  -> DesktopAgentGUIWorkbenchBody
  -> workbench node state + desktop preferences + mention providers
  -> <AgentGUI ... />
```

This means an AgentGUI bug can start at several different interfaces. Do not
assume that a visible UI symptom starts in the visible UI component.

## Runtime Data Chain

Durable activity state flows in one direction:

```text
AgentActivityAdapter
  -> AgentActivityController snapshot
  -> WorkspaceAgentActivityService
  -> AgentActivityRuntime.getSnapshot / subscribe / load / commands
  -> useAgentActivitySnapshot(workspaceId)
  -> conversation list and active session projections
```

Command flow returns through the same runtime interface:

```text
controller action
  -> AgentActivityRuntime command
  -> WorkspaceAgentActivityService
  -> adapter / tuttid client
  -> authoritative session or message update
  -> runtime snapshot refresh
  -> projection rebuild
```

Local overlays are allowed only to bridge UI latency:

- pending create/submit/delete state in `agentGuiConversationListStore`
- session overlay messages in `agentSessionViewStore`
- transient active conversation fallback while runtime data catches up
- optimistic pin or working status while a command is in flight

Every overlay must have a reconciliation path back to the runtime snapshot.
Optimistic prompt messages must stay overlay-owned even when they are used to
scope the selected detail window. Do not promote them into durable/detail
message bases: their local timestamp-derived versions can outrank lower
authoritative daemon versions and suppress the durable user prompt during merge.

## User-Facing Data Flows

Use these flows when debugging AgentGUI behavior. They are intentionally written
from the user's action back to the authoritative data source.

### Conversation List Loading

```text
AgentGUI / AgentGuiNode mount
  -> useAgentActivitySnapshot(workspaceId)
  -> AgentActivityRuntime.load(workspaceId)
  -> WorkspaceAgentActivityService.load
  -> AgentActivityController.load
  -> desktopAgentActivityAdapter.listSessions
  -> tuttid ListWorkspaceAgentSessions
  -> agent.Service.ListFiltered
  -> live RuntimeController sessions + persisted ActivityProjection sessions
  -> AgentActivityController snapshot
  -> conversation-list projection/store
  -> rail and active-session fallback selection
```

The session list is not owned by AgentGuiNode. AgentGuiNode may keep query,
selection, pending create/delete/submit overlays, and read-state UI metadata.
The session rows themselves come from the runtime snapshot and are refreshed
through `load`, event reconciliation, or explicit session fetches.
Conversation-list read-state metadata is notification-style UI state. Historical
imports that carry `runtimeContext.imported === true` should remain visible in
the rail, but they must not seed unread completion lamps as though they just
finished locally. Preserve the imported marker through conversation summaries
and summary-stabilization equality before deriving unread completion state.
If the conversation-list query cannot be constructed because workspace,
current-user, or provider identity is missing, clear the active conversation
selection and persisted active hint. Do not treat that state as a runtime
refresh gap. Temporary runtime/list catch-up should instead be represented by
an explicit pending create, transient conversation, or detail overlay that can
reconcile back to `AgentActivityRuntime`.

### Existing Session Detail Loading

```text
activeConversationId changes
  -> session view store / controller detail load
  -> AgentActivityRuntime.listSessionMessages
  -> WorkspaceAgentActivityService.listSessionMessages
  -> AgentActivityController.listSessionMessages
  -> desktopAgentActivityAdapter.listSessionMessages
  -> tuttid ListWorkspaceAgentSessionMessages
  -> ActivityProjection.ListSessionMessages
  -> AgentActivityController merges messages into snapshot
  -> transcript projection
  -> AgentGUINodeView / AgentConversationFlow
```

Detail loading is separate from list loading. A conversation can appear in the
rail before its messages are loaded. The detail panel should show message
loading from the session view store, not infer it from the send button state.
Older-history prefetch is opportunistic UI behavior. If a page load for a
specific `(agentSessionId, beforeVersion)` cursor fails, AgentGuiNode should
record that failed cursor and suppress automatic retries until the detail page
is reloaded or a different oldest durable version is reached. Do not let scroll
position and `isLoadingOlderMessages=false` form an immediate retry loop against
the same failing backend page.

### First Prompt In A New Conversation

```text
composer submit with no activeConversationId
  -> startConversation
  -> normalize prompt content and optional displayPrompt
  -> set local first-create busy state
  -> mark conversation-list create pending
  -> activation.activate(mode="new")
  -> AgentActivityRuntime.activateSession
  -> WorkspaceAgentActivityService.activateSession
  -> desktopAgentActivityAdapter.createSession
  -> tuttid CreateWorkspaceAgentSession
  -> agent.Service.Create
  -> provider install/check + prepareRuntime
  -> RuntimeController.Start
  -> RuntimeController.Exec when initialContent exists
  -> activation succeeds
  -> create/attach conversation summary
  -> record optimistic user message
  -> clear home draft and enter conversation detail
  -> ActivityProjection receives runtime reports
  -> agent.activity.updated events
  -> AgentActivityController snapshot update
  -> projection + UI refresh
```

For normal first-message creation, the UI stays on the home composer while
activation is pending. The home composer uses its existing busy/send-button
state; it does not show a separate "creating session" text and it does not enter
conversation detail just to show "connecting conversation". After activation
succeeds, the controller attaches the conversation and records the optimistic
user message before loading runtime projection. For Claude Code,
`desktopAgentActivityAdapter.createSession` may promote a pre-warmed hidden draft
session before calling `sendWorkspaceAgentSessionInput`.

### Sending To An Existing Conversation

```text
composer submit with activeConversationId
  -> executePrompt
  -> normalize prompt content and optional displayPrompt
  -> mark conversation-list submit pending
  -> patch local conversation status to working
  -> apply local state patch currentPhase=working
  -> AgentActivityRuntime.sendInput
  -> WorkspaceAgentActivityService.sendInput
  -> optimistic working session upsert
  -> desktopAgentActivityAdapter.sendInput
  -> tuttid SendWorkspaceAgentSessionInput
  -> agent.Service.SendInput
  -> validate/prepare prompt content
  -> RuntimeController.Exec
  -> authoritative session returned
  -> runtime reports publish agent.activity.updated
  -> snapshot/projection/UI refresh
```

The local working patch is a latency bridge only. If the runtime returns a
ready-looking session while the turn is still being processed, the desktop
service can preserve optimistic `working` until a later authoritative event
settles the session.

When an existing conversation is busy, normal composer submits may be captured
as local queued prompts so the next turn can run after the current one settles.
Composer guidance is different: `Cmd+Enter` on macOS, or `Ctrl+Enter` on other
platforms, sends the draft as active-turn guidance and bypasses the local queue.
For Codex app-server sessions this reaches `RuntimeController.Exec` while an
active provider turn is registered, so the adapter sends `turn/steer` and emits
a user message with `steered: true`. `Shift+Enter` remains the multiline
composer shortcut and must not submit either a normal prompt or guidance.

The submit target is not just a render detail. A detail-page composer must not
fall back to `startConversation` because a UI-local active conversation ref is
temporarily empty. If the view is not on the home composer, resolve the existing
session from the durable active-session hint and route through the existing
send path, or block/recover explicitly with diagnostics. Only an intentional
home-composer submit should create a new agent session.

### Resume Or Re-Attach Existing Session

```text
open existing conversation / retry activation / external launch
  -> activeConversationId selection
  -> activation.activate(mode="existing")
  -> AgentActivityRuntime.activateSession
  -> WorkspaceAgentActivityService.activateSession
  -> getSession from runtime/tuttid/persisted projection
  -> activation status already_attached or failed
  -> ensureSessionSynchronized / listSessionMessages
  -> reconcile stale persisted turn when needed
  -> snapshot/projection/UI refresh
```

Resume is not a new AgentGUI data source. It re-attaches UI to an existing
session identity and then reloads state/messages. If the session is marked
non-resumable or the provider returns a non-retryable resume error, the retry
path must stop instead of creating a shadow session.

### Agent Execution And Return Path

```text
tuttid agent.Service.Create or SendInput
  -> RuntimeController.Start / Exec
  -> provider adapter process or ACP connection
  -> provider emits lifecycle, phase, tool, message, prompt, and final events
  -> ActivityProjection.ReportSessionState / ReportSessionMessages
  -> SQLite agent activity tables
  -> AgentActivityPublisher.PublishAgentActivityUpdated
  -> event stream topic agent.activity.updated
  -> desktop WorkspaceAgentActivityService event handler
  -> AgentActivityController.applyActivityUpdatedEvent
  -> snapshot listener notification
  -> AgentGUI projection and render
```

The provider/runtime reports are the durable return path. AgentGUI should not
parse provider stdout, terminal text, or runtime internals directly. It consumes
normalized sessions, messages, state patches, and message pages through
`AgentActivityRuntime`.

### Event Reconcile And UI Refresh

```text
agent.activity.updated
  -> WorkspaceAgentActivityService batches update briefly
  -> state_patch can apply inline to AgentActivityController
  -> message_update/session_update triggers reconcile fetch when needed
  -> listSessionMessages and/or getSession updates snapshot
  -> conversation list projection updates rail
  -> session view store updates transcript loading/live state
  -> shared transcript projection updates rows/cards
  -> AgentGUINodeView renders the new view model
```

Inline state patches are fast-path updates; message and session updates may
require a fetch so the controller snapshot remains authoritative. UI code
should debug both the event payload and the reconcile fetch before treating a
missing transcript row as a rendering-only bug.

When a session status bug mentions "still processing", "queued", or a disabled
composer after a turn finishes, inspect the full runtime tuple:
`status`, `currentPhase`, and `turnLifecycle.phase`. The Agent Activity snapshot
may carry lifecycle status such as `active` while the visible state is derived
from `currentPhase` or turn lifecycle. Projection layers that bridge into legacy
Host DTOs must normalize the tuple together, or `active/idle` and
`active/working` sessions will render as the wrong conversation state.

### Message Parsing And Rendering

```text
AgentActivityMessage payloads
  -> AgentActivityController merge/dedupe by message identity/version
  -> sessionMessagesById snapshot bucket
  -> shared/agentConversation/projection
  -> transcript rows, tool calls, plans, approvals, interactive prompts
  -> AgentConversationFlow inside AgentGUINodeView
```

Message parsing belongs in shared projection/model helpers. React components
should render projected rows and fire actions. They should not own provider
message semantics, merge keys, prompt status resolution, or durable message
dedupe.

Transcript `message_update` events that reach `AgentActivityRuntime` are a
normalized runtime contract. Each transcript message must already carry a
stable `messageId`, positive `version`/`seq`, stable `turnId`, and positive
`occurredAtUnixMs`. Provider, adapter, desktop, or daemon ingestion layers must
derive missing turn/time data from real active-turn, submit-context, lifecycle,
or storage timestamps before AgentGUI sees the event. If a transcript message
has no reliable `turnId`, the boundary must reject it instead of synthesizing a
`message:<messageId>`, `seq:<seq>`, or similar ownership fallback. AgentGUI
must not retarget optimistic prompts from turnless or untimestamped live
messages.

### Layer Ownership Summary

| Layer                                   | Owns                                                                                                  | Must not own                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `tuttid` agent service                  | provider runtime start, exec, resume/cancel, validation, persistence reports                          | AgentGUI view state                            |
| `ActivityProjection`                    | persisted session/message projection and `agent.activity.updated` publication                         | React projection or local UI overlays          |
| desktop `WorkspaceAgentActivityService` | runtime adapter, snapshot controller, optimistic bridge, event reconcile, desktop/tuttid client calls | transcript rendering semantics                 |
| `AgentActivityRuntime`                  | AgentGUI-facing source of durable activity data and commands                                          | independent session/message storage            |
| AgentGuiNode controller/stores          | selection, drafts, loading/error state, pending overlays, command sequencing                          | authoritative session/message state            |
| shared projection/model helpers         | deterministic conversion from snapshots/messages to view models                                       | provider transport calls                       |
| React views                             | DOM interaction and rendering from `viewModel`/`actions`                                              | fetching or mutating durable activity directly |

## User-Visible Interaction Contracts

Use this section when the bug report is phrased as a visual symptom: "why is
this selected", "why is this loading", "why did the row move", "why is the send
button disabled", or "why is an approval still visible". Every visible AgentGUI
state should map to one owner and one clearing condition.

### Rail And Conversation List

```text
runtime snapshot sessions
  -> conversation list query/search/project filters
  -> local pending create/submit/delete overlays
  -> activeConversationId highlight
  -> row status, title, project, timestamp, badges
```

User-visible rules:

- The rail row list is projected from the runtime snapshot plus list-local
  overlays. Do not fetch or mutate durable session state from a row component.
- The selected row is controlled by `activeConversationId`, not by latest
  runtime update time.
- Search and project grouping are list-query concerns. They may hide a session
  from the rail, but must not delete or unactivate the session.
- A pending create row can appear before the daemon-created session is
  authoritative. It must be replaced by the authoritative session or removed on
  create failure.
- Working/error/attention badges should come from session status, pending
  interactive/approval projection, or explicit local pending state. Do not infer
  them from row text.

### Detail Pane And Transcript

```text
activeConversationId
  -> session view state
  -> message loading / detail error / live state
  -> sessionMessagesById snapshot bucket
  -> shared transcript projection
  -> skeleton, empty state, transcript rows, prompt cards
```

User-visible rules:

- A row can be selected while its transcript is still loading. Treat rail
  selection and detail message loading as separate states.
- Transcript rows are projected data. Rendering components should not parse
  provider-specific payloads ad hoc.
- The "processing" row in the transcript represents turn/progress projection.
  It is not the same state as the new-session activation loading button.
- Detail errors should be tied to the active session and cleared when a new
  active session is selected or a retry begins.
- Auto-scroll, bottom anchoring, and pending-row placement are visual behaviors
  layered on top of projected rows; they must not affect message merge/dedupe.

### Composer And Send Button

```text
composer draft + activeConversationId
  -> provider/composer settings/options
  -> prompt content normalization and upload state
  -> can submit / disabled reason / sending state
  -> startConversation or executePrompt
```

User-visible rules:

- Home composer submit with no active conversation starts activation. Detail
  composer submit with an active conversation sends input. First-message
  activation keeps the user on the home composer until activation succeeds.
- Treat active-session refs as controller caches, not the source of truth for
  whether a submit is new or existing. React effect cleanup, projection reloads,
  and conversation-list refreshes may temporarily disturb UI-local refs; they
  must not retarget the user's prompt to a newly created session.
- The send button spinner is local submit/approval response state. For
  first-message activation, this same busy state is the only normal pending
  indicator. The "connecting conversation" state belongs to existing-session
  activation/recovery. The transcript processing row is runtime turn state.
- Model, permission, plan mode, reasoning, speed, project, branch, prompt image,
  file mention, and skill/capability controls must read from composer settings
  and provider options. They should not be reconstructed from transcript rows.
- User composer defaults are owned by desktop preferences. AgentGUI may request
  a defaults write only from the home/new composer path, through an explicit host
  callback.
- Active session settings are session state. Opening, restoring, or editing an
  active session must not promote that session's model, permission mode, or
  reasoning setting into user defaults.
- Workbench node `composerOverrides` are UI-local home/new composer draft state,
  not an authoritative source for desktop preferences.
- Draft clearing happens only after the submitted content still matches the
  current draft. Do not clear a draft that the user edited while a send was in
  flight.
- Display prompt is for user-facing echo/title when content is collapsed or
  bundled. Expanded prompt blocks remain the runtime command input.

### Approval And Ask-User Prompts

```text
runtime message/state projection
  -> pendingApproval / pendingInteractivePrompt
  -> inline card + bottom dock attention
  -> submitInteractive or plan-decision sendInput
  -> runtime event update
  -> answered/superseded prompt filtered from UI
```

User-visible rules:

- Approval/ask-user cards are attention surfaces, not composer drafts.
- The same prompt may appear inline and in a bottom dock. Both surfaces must
  share request identity and submitting state.
- Answering a prompt should clear or supersede every visible surface for that
  request ID after the runtime update lands.
- Plan approval decisions can translate into settings updates and/or
  follow-up `sendInput`; do not assume every approval uses only
  `submitInteractive`.

### Loading State Taxonomy

| Visible state                  | Primary owner                    | Starts when                                             | Clears when                                                                    |
| ------------------------------ | -------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Rail skeleton or empty loading | conversation list query/store    | runtime list load starts                                | list load resolves or errors                                                   |
| Selected detail skeleton       | session view store/controller    | active session messages load starts                     | `listSessionMessages` resolves or active session changes                       |
| Home first-create busy         | controller local create state    | home `startConversation` begins                         | new-session activation succeeds, fails, or is abandoned as stale               |
| "Connecting conversation"      | existing-session activation      | existing session open/retry calls `activate`            | activation succeeds, fails, or is abandoned as stale                           |
| Transcript processing row      | transcript/session projection    | runtime reports working/turn phase                      | runtime reports ready/completed/failed or newer message projection replaces it |
| Send button spinner            | controller local submit state    | `executePrompt` or approval submit begins               | command promise settles                                                        |
| Composer settings loading      | composer options/settings model  | provider options load starts or settings source missing | options/settings resolve or fallback state is applied                          |
| Approval response spinner      | controller approval submit state | prompt/approval option submit begins                    | runtime command settles and prompt projection updates                          |

When a loading state is wrong, first identify which row in this table is
visible. Then debug that owner and clearing condition. Avoid moving a spinner
between surfaces to hide a state-source mismatch.

### Error, Retry, And Recovery

```text
runtime/command error
  -> controller reports diagnostic
  -> detail error or failed conversation projection
  -> retry path if resumable/retryable
  -> activation or message reload
```

User-visible rules:

- Failed new-session activation may keep a visible failed conversation so the
  user can understand where their prompt went.
- Non-resumable sessions or non-retryable resume errors should not offer a
  retry path that silently creates another session.
- Deleted or filtered sessions should clear selection only through the
  selection fallback path; do not let a hidden row leave a stale detail pane.
- Event-stream disconnect should not erase current transcript state. It should
  make live freshness uncertain until reconciliation succeeds.

### Visual Debug Checklist

For every AgentGUI visual bug, answer these before editing:

1. Which surface is wrong: rail, detail transcript, composer, approval/prompt,
   bottom dock, settings menu, project selector, or provider status?
2. Is the visible state from authoritative runtime data, projection, or a
   local overlay?
3. What starts the visible state, and what exact event/promise/fetch clears it?
4. Does the visual state survive selection changes, search filters, and stale
   async results correctly?
5. Which neighboring surface should update at the same time?

## UI Rendering Chain

The node UI is intentionally split into a shell, controller, view model, and
view:

```text
AgentGUI
  -> AgentGUINode
     - node chrome
     - labels/i18n assembly
     - rail layout and workbench frame props
     - provider status presentation props
  -> useAgentGUINodeController
     - subscribes to runtime snapshot
     - owns selected conversation and UI-local state
     - calls runtime commands
     - returns { viewModel, actions }
  -> AgentGUINodeView
     - renders rail, timeline, composer, menus, approval/prompt surfaces
     - owns DOM/UI-only state such as picker open state and resize interaction
  -> shared/agentConversation/components
     - renders transcript rows, tool calls, tasks, plans, approvals
```

`AgentGUINodeView` may use host capabilities for UI affordances such as file
references, workspace reference picker actions, and link actions. It must not
become a durable activity data source.

## Folder Guide

Use this map before editing:

| Path                                                                                                        | Layer                               | Notes                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/agent/activity-core/src/**`                                                                       | Durable activity core               | Host-agnostic adapter/controller/types. No React, Electron, or desktop clients.                                                                |
| `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.ts` | Desktop service implementation      | Owns the desktop adapter, `tuttid` calls, reconciliation, generated files, imports, event handling, and local optimistic service behavior.     |
| `apps/desktop/src/renderer/src/features/workspace-agent/services/createDesktopAgentActivityRuntime.ts`      | Runtime adapter                     | Wraps the desktop service into the `AgentActivityRuntime` interface and adds analytics/diagnostics.                                            |
| `apps/desktop/src/renderer/src/features/workspace-agent/ui/DesktopAgentGUIWorkbenchBody.tsx`                | Desktop product adapter             | Assembles workbench state, desktop preferences, provider status, mention providers, file references, and passes props into `AgentGUI`.         |
| `packages/agent/gui/AgentGUI.tsx`                                                                           | Package entry UI                    | Thin provider composition: i18n, tooltip, runtime/host providers, `AgentGUINode`.                                                              |
| `packages/agent/gui/agentActivityRuntime.tsx`                                                               | AgentGUI runtime interface          | Public React/context interface for durable activity data and commands.                                                                         |
| `packages/agent/gui/agentActivityHost.tsx` and `host/agentHostApi.ts`                                       | Host capability interface           | Files, clipboard, account/user projects, workspace helpers, probes, persistence. Legacy session APIs are not production data sources.          |
| `packages/agent/gui/workbench/**`                                                                           | Host-agnostic workbench integration | Dock entries, launch descriptor, provider mapping, workbench node state helpers. Desktop still owns product-specific body rendering.           |
| `packages/agent/gui/agent-gui/agentGuiNode/controller/**`                                                   | Node controller implementation      | UI orchestration and command sequencing. Prefer focused helper files over growing the main hook.                                               |
| `packages/agent/gui/agent-gui/agentGuiNode/model/**`                                                        | Node model and policy               | Pure status, provider, settings, draft, slash command, layout, project resolution, and conversation projection helpers.                        |
| `packages/agent/gui/agent-gui/agentGuiNode/agentRichText/**`                                                | Composer document layer             | Tiptap document, mentions, tokens, IME, prompt images, serialization helpers.                                                                  |
| `packages/agent/gui/agent-gui/agentGuiNode/AgentGUINodeView.tsx`                                            | Node view                           | Renders the rail/detail/composer and owns DOM-only state. Keep data fetching out.                                                              |
| `packages/agent/gui/shared/agentConversation/**`                                                            | Transcript module                   | Reusable contracts, projection, rules, and rendering components shared by AgentGuiNode, Message Center, and standalone conversation rendering. |
| `packages/agent/gui/contexts/workspace/presentation/renderer/agentGuiConversationList/**`                   | AgentGUI conversation-list UI store | Package-owned store despite the legacy path name. Owns query state, local pending overlays, read state, and runtime-snapshot projection.       |
| `packages/agent/gui/contexts/workspace/presentation/renderer/agentSessions/**`                              | Active session UI store             | Package-owned active-session view state, overlay messages, control state, watcher counts, and event retention.                                 |
| `packages/agent/gui/agent-message-center/**`                                                                | Message center surface              | Consumes activity/prompt projections to show attention items outside the full node.                                                            |
| `packages/agent/gui/agent-conversation/**`                                                                  | Standalone transcript export        | Reuses the same detail-to-conversation projection and transcript components without the full node.                                             |

## Layering Invariants

- Durable session and message state comes from `AgentActivityRuntime`, not
  component-local state.
- Host-specific transport, preload, `tuttid`, analytics, desktop preferences,
  and provider installation/login behavior stay in `apps/desktop`.
- `AgentHostApi` remains a host capability interface, not a second activity
  runtime.
- Projection helpers should be pure whenever possible; they convert snapshots,
  messages, timeline items, or session state into view models.
- UI stores may cache UI concerns and optimistic overlays, but each overlay
  needs a deterministic reconciliation path.
- React views should render `viewModel` and call `actions`; controller or model
  helpers own sequencing and derived state.
- Package exports should stay narrow. Do not export an internal helper only
  because another package or test finds it convenient.

## Source Of Truth

### Agent Activity Data

`AgentActivityRuntime` is the AgentGUI source for activity data and production
commands. It owns or delegates:

- session list snapshots
- paged session messages
- live event retention and synchronization
- create, activate, unactivate, send input, cancel, interactive response,
  delete, pin, settings update, and composer option operations
- diagnostics through `reportDiagnostic`

Production AgentGUI code should not call legacy `AgentHostApi.workspaceAgents`
or `AgentHostApi.agentSessions` as a list, timeline, message, or write source.
Use the runtime hooks and commands instead.

### Host Capabilities

`AgentHostApi` remains valid for host capabilities that are not the agent
activity data source:

- workspace file references
- clipboard
- runtime metadata and diagnostics outside the activity runtime
- account or user-project lookup
- local file picking, local file reading, and batch export helpers

### Provider Targets

AgentGUI distinguishes real provider identity from launch targets. `provider`
continues to mean the concrete provider family (`codex`, `claude-code`,
`nexight`, and so on) and remains the key for composer options, settings,
icons, probes, provider status, and adapter policy.

`providerTargets` lets a host expose multiple targets under that same provider.
AgentGUI owns only target display and passthrough:

- show `target.label` for new-session surfaces
- keep provider behavior keyed by `target.provider`
- persist `providerTargetId` / `providerTargetRef` in workbench node state
- pass `providerTargetRef` through `AgentActivityRuntime.activateSession`

`providerTargetRef` is an opaque host reference, not authority. AgentGUI must
not interpret `ref.kind`, mint invocation-control tokens, resolve invocation
plans, contact command gateways, or handle raw credentials. Host/trusted code
must re-authenticate the current user and workspace and resolve any invocation
plan before launching. A target may identify shared, local, remote, or other
host-owned launch mechanisms, but those meanings stay outside AgentGUI.

When `providerTargets` is omitted or empty, AgentGUI may synthesize local
targets from the static provider catalog for picker/display compatibility. Those
fallback targets do not change the legacy activation contract: AgentGUI does not
persist or send their `providerTargetRef`.

### Conversation Projection

Projection code converts runtime/session state into renderable view models.
Keep projection deterministic and testable. Prefer pure helpers under
`model/**` and `shared/agentConversation/projection/**` for grouping, sorting,
status selection, and timeline conversion.

### React Components

React components should render snapshots and handle DOM interaction. Avoid
putting cross-step orchestration into component effects when a controller,
store, selector, or pure helper can own it.

## Ownership Map

| Area                                      | Owns                                                                                            | Should not own                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `AgentGUI.tsx`                            | Package-level host provider composition and forwarding node props                               | Session data interpretation                             |
| `AgentGUINode.tsx`                        | Node chrome, package-to-node prop assembly, layout decisions                                    | Runtime data fetching internals                         |
| `controller/useAgentGUINodeController.ts` | UI orchestration, selected conversation flow, runtime command calls, error reporting            | Low-level rendering or durable activity cache ownership |
| `controller/*.ts` helpers                 | Focused controller decisions such as composer, session, interactive, prompt, and error handling | Broad unrelated feature branching                       |
| `model/*.ts`                              | Pure view-model and policy logic                                                                | React effects or host transport                         |
| `AgentGUINodeView.tsx`                    | Concrete UI composition and event wiring from `viewModel` and `actions`                         | Fetching session lists or mutating stores directly      |
| `agentGuiConversationListStore.ts`        | UI-facing conversation list query and local pending overlays                                    | Becoming a second durable activity store                |
| `shared/agentConversation/projection/**`  | Transcript, tool, approval, task, message projection                                            | Provider transport details                              |
| `agentRichText/**`                        | Composer document, mentions, IME, prompt image extraction                                       | Session lifecycle                                       |

## Change Impact Checklist

Before modifying AgentGuiNode or Agent conversation behavior, answer these
questions in the PR, commit notes, or working notes:

1. Which chain is being changed: activation, session list, selected session,
   message timeline, composer draft, submit, cancel, approval, interactive
   prompt, provider capability, generated files, mention resolution, or layout?
2. What is the source of truth for the data being changed?
3. Is the change touching only view rendering, or does it alter runtime command
   sequencing?
4. Does the same state appear in both a durable runtime snapshot and a local
   overlay? If yes, how are conflicts resolved?
5. Which tests prove the changed chain and its nearest neighbor still work?
6. Which user-visible surface owns the loading/error/disabled/selected state,
   and what exact condition clears it?
7. Is this a recurring bug pattern that should update this document or
   `docs/conventions/troubleshooting.md`?

If the answer to source of truth is unclear, stop and trace the chain before
editing.

## Common Chains

### Open Or Activate A Conversation

```text
workbench launch or open-session request
  -> AgentGUI
  -> AgentGUINode
  -> useAgentGUINodeController
  -> selected conversation state
  -> runtime activation or synchronization
  -> conversation detail projection
  -> AgentGUINodeView
```

Check both the request identity and the selected conversation fallback. Bugs in
this path often look like the wrong session opening, a blank detail panel, or a
selected session that is no longer present after refresh.

### Send A Prompt

```text
composer document
  -> prompt content normalization
  -> optional asset upload / mention serialization
  -> runtime send or create-session command
  -> pending local overlay
  -> runtime snapshot refresh and live events
  -> timeline projection
```

Never fix send bugs only in the composer UI. Also inspect the pending overlay,
runtime command input, and timeline merge path.

### Composer Mention References

```text
@ trigger range
  -> AgentRichTextEditor suggestion state
  -> AgentFileMentionPalette row action
  -> mention command OR reference picker launch
  -> composer document update
  -> prompt mention serialization
```

The `@` trigger range is the source of truth for replacing typed mention text.
Normal row selection replaces that range through the suggestion command. Any
side action inside a mention row that opens another picker and later inserts
files or `workspace-reference` mentions must clear the active trigger text
before launching the picker, otherwise the raw `@` query remains in the
composer before the inserted mention.

`workspace-reference` hrefs are the passive reference contract, not a visual
metadata store. Do not serialize app icons into the href just to render a chip.
For `source=app` references, readonly and markdown renderers should hydrate the
icon from the same `workspaceAppIcons` appId/workspaceId table used by ordinary
`workspace-app` mentions.

Quick check:

```sh
corepack pnpm --filter @tutti-os/agent-gui exec vitest run agent-gui/agentGuiNode/AgentComposer.spec.tsx -t "removes the active @ trigger"
corepack pnpm --filter @tutti-os/agent-gui exec vitest run shared/AgentRichTextReadonly.spec.tsx shared/AgentMessageMarkdown.spec.tsx
```

### Agent Generated File Mentions

```text
Agent activity messages
  -> generated-file collector in tuttid or AgentGUI fallback
  -> desktop mention provider
  -> mention palette grouping/count presentation
  -> composer file mention insertion
```

Generated-file counts must be computed from collector output, not from palette
rendering state. The collector owns the semantic filter: only successful
file-change tool messages should contribute paths, and failed, canceled,
running, or read-only tool calls must be ignored even when their payloads carry
`path`, `filePath`, `fileChanges`, or `changes` fields.

### Approval Or Ask-User Prompt

```text
runtime messages
  -> timeline projection
  -> prompt view model
  -> AgentInteractivePromptSurface or approval card
  -> runtime submitInteractive
  -> snapshot/message update
```

Check stale prompt IDs, answered prompt filtering, bottom dock state, and
selected conversation synchronization together.

### Composer Settings

```text
provider capability/options
  -> composer support model
  -> node default settings
  -> per-session settings
  -> runtime settings update or draft settings tracking
  -> menu rendering
```

Avoid fixing a menu label or disabled state without checking whether the same
setting is also used by prompt creation, session continuation, and runtime
tracking.

### Mention Or File Reference

```text
rich text document
  -> mention extension
  -> mention palette/search controller
  -> workspace reference adapter or source aggregator
  -> prompt serialization
  -> rendered transcript markdown/link actions
```

IME behavior, search state, serialization, and transcript rendering are separate
links. A local picker fix can break prompt serialization or rendered links.

Rendered transcript markdown should only promote explicit file targets to
workspace file actions: local absolute paths, home-relative paths, and Windows
absolute paths. Relative markdown links remain display text unless another
structured reference contract marks them as a workspace reference. Host adapters
that open workspace file nodes should validate explicit agent-command file
targets before launching the files surface, so a speculative or stale agent
path does not open a misleading workbench node.

Quick checks:

```sh
pnpm --filter @tutti-os/agent-gui test -- shared/AgentMessageMarkdown.spec.tsx
pnpm --filter @tutti-os/desktop test -- src/renderer/src/features/workspace-file-manager/services/internal/workspaceFileManagerService.test.ts src/renderer/src/features/workspace-workbench/services/workspaceFilesRevealIntent.test.ts
```

## Troubleshooting Playbook

### Blank Or Stale Conversation Detail

Quick checks:

- Confirm the selected `agentSessionId` still exists in the runtime snapshot.
- Check whether local deleted or locally created overlays are hiding or
  replacing the runtime conversation.
- Inspect message loading state and `ensureSessionSynchronized` calls.
- Check whether a React mounted ref or cleanup guard is dropping a successful
  async continuation.

Likely fix area:

- selection fallback helper
- conversation list store pending overlay
- session view store loading/error state
- controller synchronization effect

Validation:

```sh
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx
```

### Prompt Sends But Timeline Does Not Update

Quick checks:

- Confirm `AgentActivityRuntime.sendInput` or create-session command was called
  with the expected session ID and content blocks.
- Confirm pending overlay messages are inserted and later reconciled.
- Confirm live events or message page reload contains a newer version.
- Inspect timeline item merge and dedupe keys.
- Confirm `message_update` payloads already include `turnId`,
  `occurredAtUnixMs`, and a positive `version` or `seq`; missing fields belong
  in runtime/adapter/daemon normalization, not AgentGUI prompt retargeting.
- When the selected detail window only contains optimistic prompt messages,
  do not use their local timestamp-derived versions as durable message-window
  bounds; live runtime messages can have lower authoritative sequence versions
  and must still enter the transcript before a refresh.
- If user prompts appear below assistant replies until the conversation is
  reopened, inspect whether optimistic prompt messages were merged into
  `detailMessages` or another durable/base set. Reconciliation should split
  durable messages from optimistic overlays, then drop overlays that match a
  durable `messageId`, `clientSubmitId`, or prompt signature.
- When a live message or lifecycle patch reveals the real turn ID for a
  first-prompt create, retarget the optimistic prompt from its pending
  client-submit turn ID only after the event is known to belong to the current
  submit; retained history must not retarget that optimistic prompt. Do this
  before projecting rows so the user prompt stays grouped above the agent
  response.

Likely fix area:

- prompt content normalization
- pending submit overlay
- message merge helper
- timeline projection

Validation:

```sh
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/model/agentGuiConversationModel.spec.ts
```

### Approval Or Question Remains After Answering

Quick checks:

- Confirm the projected prompt status changes after the runtime response.
- Check whether answered/superseded prompts are filtered in both detail and
  bottom-dock surfaces.
- Inspect prompt IDs and turn IDs; local UI IDs must match runtime message
  identity.

Likely fix area:

- interactive projection
- approval projection
- bottom dock prompt selection
- runtime submit response handling

Validation:

```sh
pnpm --filter @tutti-os/agent-gui test -- shared/agentConversation/projection/agentInteractiveProjection.spec.ts
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx
```

### Provider Or Capability UI Looks Correct But Submit Uses Old Settings

Quick checks:

- Compare displayed settings with effective composer settings.
- Check node defaults, session settings, draft settings, and runtime options.
- Confirm setting changes call the runtime update or draft tracking method.

Likely fix area:

- `agentGuiController.composerHelpers.ts`
- `composerSettingsSupport.ts`
- `composerSettingsMenuModel.ts`
- controller settings update path

Validation:

```sh
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/controller/agentGuiController.composerHelpers.spec.ts
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/model/composerSettingsMenuModel.spec.ts
```

### Mention Search Or Picker Regresses IME

Quick checks:

- Check `isComposing` handling for Enter, Tab, Arrow keys, and search input.
- Confirm local composing text is not overwritten by async search state.
- Run both mention search and file mention palette tests.

Likely fix area:

- `AgentMentionSearchController.ts`
- `AgentFileMentionPalette.tsx`
- `agentRichText/agentRichTextIme.ts`

Validation:

```sh
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/AgentMentionSearchController.spec.ts
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/AgentFileMentionPalette.spec.tsx
pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/agentRichText/agentRichTextIme.spec.ts
```

## Boundary Checks

Run the runtime boundary check after changing AgentGUI data flow:

```sh
pnpm check:agent-activity-runtime-boundaries
```

Run package tests for focused AgentGUI changes:

```sh
pnpm --filter @tutti-os/agent-gui test
```

Run changed-aware checks before handing off a mixed surface change:

```sh
pnpm check:changed
```

Use broader validation when the change crosses into desktop workbench,
preload/host APIs, or daemon contracts.

## Self-Evolution And Documentation Impact

This loop borrows the useful parts of AutoSkill's skill-management pattern:
learn only from real interaction evidence, skip noisy one-off tasks, prefer
updating an existing reusable lesson over creating duplicates, and keep every
durable lesson reviewable as plain text.

Every AgentGUI change should end with this self-evolution and documentation
impact prompt, including bug fixes, feature additions, module extractions, and
flow refactors:

1. Did this change alter module ownership, data flow, user-visible interaction,
   runtime/API behavior, validation commands, or troubleshooting paths?
2. Did this bug or implementation happen because a local fix missed a
   neighboring chain?
3. Is there a stable quick check, invariant, or validation command worth
   repeating?
4. Does an existing lesson already cover the same capability? If yes, improve
   or merge into it instead of creating a near-duplicate note.
5. Can the lesson be written without project-instance secrets, personal data,
   local paths, customer names, tokens, or one-off issue details?

If a durable note is in scope for the requested change, record it directly. If
adding the note would broaden the requested scope, ask the user first. Suggested
wording:

> This change exposed a reusable AgentGUI pattern. Should I add it to
> `docs/architecture/agent-gui-node.md` or
> `docs/conventions/troubleshooting.md`?

Use these decisions:

- `discard`: the fix was one-off, too generic, unverified, or not reusable.
- `improve`: an existing section is right but needs a sharper invariant,
  source-of-truth note, or validation command.
- `merge`: two notes describe the same recurring capability and should become
  one clearer entry.
- `create`: no existing note covers the reusable pattern.

Update the matching durable document in the same change:

- architecture docs for ownership, data-flow, interaction-state, loading,
  resume, send, approval, timeline, or source-of-truth changes
- convention docs for repository-wide practices, package boundaries, release
  rules, config/env/runtime overrides, or validation policy
- package README/API docs for public usage, exported contracts, or integration
  behavior
- troubleshooting docs for recurring symptom playbooks

A durable lesson should include the affected chain, the source-of-truth rule,
the quick check, and at least one validation command when a command exists. Any
self-evolution decision other than `discard` must update the matching durable
document in the same change and the final response should name the document
that was updated. If the impact check is `discard`, the final response should
state that no durable documentation update was needed.

## What To Avoid

- Do not patch a visible component without tracing the controller and runtime
  chain that feeds it.
- Do not create another durable session cache in AgentGuiNode.
- Do not reintroduce production reads or writes through legacy Host API
  session methods when `AgentActivityRuntime` has the operation.
- Do not hide runtime errors in local UI state without reporting diagnostics.
- Do not solve provider-specific behavior by hardcoding it in generic
  transcript or composer rendering unless the provider identity is part of the
  intended model.
- Do not add broad abstractions to make one bug easier; first use the existing
  controller, model, projection, and store boundaries.

## Related Documents

- [Agent Activity Packages](./agent-activity-packages.md)
- [Agent Reference Mention Resolution](./agent-reference-mention-resolution.md)
- [Agent Reference Source Services](./agent-reference-source-services.md)
- [Desktop Layering](../conventions/desktop-layering.md)
- [Troubleshooting](../conventions/troubleshooting.md)
- [`@tutti-os/agent-gui` README](../../packages/agent/gui/README.md)
