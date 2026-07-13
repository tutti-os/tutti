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
  (`RoomIssueNode`, `terminalNode`, `workspaceDesktop`). Treat
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
  -> buildAgentGuiDockEntries
  -> createAgentGuiWorkbenchLaunchDescriptor
  -> DesktopAgentGUIWorkbenchBody
  -> workbench node state + desktop preferences + mention providers
  -> <AgentGUI ... />
```

`agentDockLayout` remains in the daemon desktop-preferences wire contract for
older stored values, but the desktop host pins it to `unified`. Unified is the
only Agent dock presentation: it exposes one Agent dock entry that matches Codex
and Claude Code AgentGUI nodes, while launches still create provider-specific
multi-instance AgentGUI nodes. The unified entry may choose a default target or
provider for its launch payload; that selection must not synthesize a provider
or replace the provider identity recorded on the node/session.
Workspace Launchpad is a broad launcher surface, not a mirror of the dock
entry list; it should show one generic Agent tile that resolves to the default
or first ready provider instead of duplicating provider-specific Agent dock
entries.
Agent launches from Launchpad/All must still use the unified Agent dock entry
identity (`agent-gui:unified`) so the resulting AgentGUI node appears under the
same Dock icon as direct Dock launches.
Empty launches from the unified Agent dock entry should set dock-entry reuse so
the second dock click restores/focuses the existing AgentGUI node; draft
prefill launches and explicit session launches keep their narrower reuse rules
so generated drafts and session navigation do not overwrite an unrelated
window.
The Dock popup's New window card is a distinct launch source and must bypass
dock-entry reuse for AgentGUI, otherwise it collapses into the normal
restore/focus behavior instead of opening a fresh Agent window.
Unified dock and launchpad chrome should keep the generic Agent title and
generic Agent artwork instead of provider-branded entries. Agent window headers
show the generic Agent title while the conversation rail is expanded. When the
conversation rail is collapsed, that title area switches to the active session
identity by showing the session's agent icon and conversation title.

AgentGuiNode may expose agent selection in multiple UI-local entry points,
including the conversation rail agent grid and the agent select next to the
composer add/reference control.
The composer agent select is a launch/default selection surface: it must
flow through the controller's home-composer agent-target selection action,
resolve an `AgentGUIAgent` by `agentTargetId`, return the node to the home composer when
switching targets, and preserve the real provider identity used by runtime
create/send commands. Once a session is active, the composer agent select is
display-only and must not switch the running session. The conversation rail
agent grid is a navigation surface: clicking an agent scopes the visible rail
list by its exact `agentTargetId` and reopens the first already-loaded matching
conversation. Only when no matching conversation is available should the click
enter that agent's empty home composer. Empty-home rail clicks may also sync the
home composer launch target.
In an active session, the composer footer may replace the display-only provider
select with a handoff affordance. Handoff is a workbench launch, not an
in-session provider switch: AgentGUI serializes the active session as a single
`agent-session` mention in a draft prompt, passes the selected provider target
through the host launch callback, and the desktop workbench opens a new empty
composer for that target via the existing draft prefill activation path. The
mention's visible label must use the source conversation title without
prefixing the source agent or provider name, because the submitted draft also
becomes the new conversation's initial title. Source agent identity stays in
the mention metadata instead of being duplicated into title text. The
prefill activation provider is authoritative for the new workbench panel's
initial provider chrome, so choosing Codex from a Claude Code session must open
a Codex panel before the draft prefill effect runs. The prefilled handoff panel
must also scope the conversation rail to the selected target instead of opening
on `All`; the target-specific rail selection is part of the handoff activation
state, not a later user filter choice.
External draft-prefill launchers that start separate work, such as Issue
Manager task execution and task breakdown, must request a new AgentGUI window
and must not reuse an existing dock-entry node. Reusing the dock entry can focus
or restore the previous active conversation before the new draft composer is
visible.
The handoff menu is a launch surface, so its options must come from ready entries
in the host-provided `agents` array. It must not synthesize a provider catalog
or infer runnable agents from provider metadata.
When provider selection happens from the empty-home composer or title control
while the rail is already scoped to a provider target in multi-provider scope,
it must update the rail conversation filter to the matching agent target so the
left rail selection follows the active empty composer target. When the rail is
in `All`, provider selection changes only the empty composer target and keeps
the aggregate rail selection intact.
Provider selection from either the empty-home title control or the composer
footer should also request focus for the composer input, matching provider rail
target clicks so users can continue typing immediately after switching agents.
The empty composer chrome and settings defaults must follow the selected agent
immediately, including host-provided name/artwork, model options,
and permission modes. Generic home composer overrides are single-target draft
state and must be cleared when the selected agent changes; provider-
or target-scoped defaults may still provide the next settings.
Host feature switches that disable an agent for new conversations should keep
the entry present with a non-ready `availability.status` when another surface
still needs to show it. Filter the entry out only for surfaces that should
completely hide it. All empty-home new-conversation affordances must read the
selected agent's availability so coming-soon entries remain inspectable but
cannot start sessions. Hosts may use `renderAgentUnavailableState` and
`renderAgentReadinessState` for product-specific presentation, with actions
routed through `onAgentAvailabilityAction`.
When an empty composer has an `agentTargetId`, model, permission, reasoning,
and speed options are target-scoped. Do not fall back to provider-level options
for that target; a missing target-scoped option snapshot should remain a
loading/missing state until the target options arrive.
If restored node data has a stale `provider` that disagrees with a resolvable
`agentTargetId`, the target's provider wins for empty-composer settings and
launch preparation.
UI affordances that aggregate across providers, such as rail provider filters
and composer provider switching, are always part of the unified AgentGUI
surface and do not belong to durable AgentGUI node data.
Provider rail containers and tiles are interactive workbench chrome: they must
explicitly release host/window drag regions with `nodrag` and
`-webkit-app-region: no-drag`, otherwise clicks near the window edge can be
captured as drag gestures before AgentGUI sees the provider filter action.
Agent rail ordering is also UI-local chrome state. Drag sorting may
persist a workspace-scoped order in browser-local storage, but must not write
that preference into controller state, session state, or durable AgentGUI node
data. The aggregate `All` entry exists only for multiple agents and stays fixed
above them.
Provider-scoped rail footer affordances, such as usage limits and environment
setup, follow the rail's active provider filter target in multi-provider scope;
when the rail filter is `All`, they should stay hidden because there is no
single provider target to inspect.
AgentGuiNode may also receive a neutral `renderSidebarFooter` slot for host or
product affordances that belong at the bottom of the far-left provider/sidebar
rail, not below the conversation-list configuration footer. This slot must stay
outside the provider tile scroll area so the footer keeps a fixed bottom
placeholder while overflowing provider tiles scroll above it with a bottom
fade. It must also stay outside the controller view model and conversation rail
valtio store: pass it as a direct function prop and give it only existing
neutral context such as `currentUserId` and `activeConversation`. Product
concepts such as sharing, ownership, availability, quota, or authorization live
entirely inside the React node supplied by the host.
Unified empty-home readiness is a host-projected, agent-scoped gate,
not a durable session rule. Desktop may subscribe to its
`agentProviderStatusService`, merge runtime status into `/agents` availability,
and pass install, login, or refresh callbacks into AgentGUI. AgentGUI resolves
the selected entry by exact `agentTargetId`; provider may supply runtime status
metadata but never selection fallback. A non-ready agent replaces only the
empty-home composer with a friendly gate; active/history conversations and
existing-session composer behavior remain outside this gate.
When the desktop status list returns an ambiguous startup result for a provider
whose runtime command is more authoritative than its lightweight status check
(for example Cursor), the desktop status service may run a provider-specific
runtime probe and fold a ready result back into the provider status snapshot
before projecting the empty-home readiness gate.
Startup provider detection should be progressive: desktop may publish the first
ready managed provider as soon as it is confirmed, then continue detecting the
remaining providers in the background. When the empty-home rail is still on
`All`, no user-selected composer target exists, and the current default target
is still gated, AgentGUI may move the home composer to that first ready target
so the user can start typing without waiting for every provider to finish
detection.
Progressive detection snapshots are partial by design. A provider missing from
the current snapshot means "not checked yet", not "install or login required".
Desktop AgentGUI hosts that project managed-agent readiness for an already-open
provider panel must wait until that provider appears in the status snapshot
before replacing the composer with setup UI or disabling active-session sends.
Auth-required local providers should remain selectable; product surfaces may
label the setup affordance as `Connect`, but the host action should still
dispatch the provider's `login` operation when that is the daemon-reported
action.

This means an AgentGUI bug can start at several different interfaces. Do not
assume that a visible UI symptom starts in the visible UI component.

Conversation rail "open in new window" actions are internal workbench-window
launches, not Electron `BrowserWindow` launches. The action should stay inside
the current Tutti workspace surface: `DesktopAgentGUIWorkbenchBody` calls
`requestWorkspaceAgentGuiLaunch`, the workspace launch handler calls
`host.launchNode`, and AgentGUI opens the requested session through an
`agent-gui:open-session` activation. Normal session launches may reuse an
already-open node only when workbench node state says that node is currently
showing the requested session. A session-keyed instance id from older snapshots
is only a legacy window identity hint, not proof of the node's current session.
If no current-session match exists, the launch should use a provider target or
panel-scoped AgentGUI container and then activate the durable session. The
explicit new-window action must pass `openInNewWindow` so the descriptor creates
a fresh panel-scoped AgentGUI instance while still activating the same durable
session.
The detached Agent button in desktop chrome is a different window boundary: it
asks main to create an Electron `BrowserWindow` with the `view=agent` renderer
intent. That window is Agent-only, but it is not a separate app bundle or a
separate data owner. It reuses the workspace renderer services, preload host
capabilities, `tuttid` client, `WorkspaceAgentActivityService`, account state,
provider status, and project/file services for the same `workspaceId`.
Standalone Agent window state may keep a minimal UI-local workbench node
context, but durable conversations, session activation, login, provider
readiness, and file/project data must still flow through the shared desktop
AgentGUI host input and activity runtime.
Opening an existing session is session-authoritative. If the launch payload has
no `agentTargetId`, workbench node state must clear any previous target
constraint instead of inheriting it from the reused node. When a
stale target resolves to a different provider than the launched session node,
desktop activation must drop that target before persisting `lastActiveAgentSessionId`;
otherwise the node can open the requested session while the conversation rail
stays scoped to the old provider and cannot select the active row.
The selected-session state must also honor an explicit open-session request
even when that session is outside the currently loaded rail page or section.
Missing from the visible rail is not proof the session is gone. AgentGUI should
project the requested session metadata into a node-local transient rail row and
run the normal cwd/user-project grouping so the selected row remains visible in
the matching project group. This overlay must stay out of canonical pagination
state and be de-duplicated by conversation id when the real paginated row later
arrives; session detail/state load owns true not-found handling.

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
Existing-session submit must record the optimistic user prompt before the
`sendInput` acknowledgement returns, then retarget or remove that prompt by
`clientSubmitId`; otherwise switching away during submit can leave only later
assistant stream events visible when the user returns.

### Turn Summary Undo/Reapply

The changed-files turn summary follows Codex-style patch semantics, but keeps
the implementation split across the existing Tutti ownership boundaries:

```text
agent fileChange/tool output
  -> AgentGUI turn summary projection stores executable patchBatches
  -> AgentTurnSummaryRow builds per-batch unified diffs
  -> AgentHost workspace.resolveGitPatchSupport
  -> tuttid GET /v1/workspaces/{workspaceID}/git-patch-support
  -> AgentHost workspace.applyGitPatch with cwd + diff + revert
  -> desktop tuttid client
  -> tuttid POST /v1/workspaces/{workspaceID}/git-patch
  -> services/tuttid Git patch service
  -> git apply / git apply -R against the Git repository resolved from cwd
```

The durable activity data is the original turn summary input:

- `patchBatches` with the tool call id, cwd, path, change type, and patch
  payload needed to reconstruct per-batch diffs.
- file-level unified diffs as a fallback for older or less structured activity.
  This fallback also applies when recorded `patchBatches` exist but reconstruct
  zero executable diffs; for absolute file paths with a synthetic `/` workspace
  root, use the file's containing directory as the Git cwd.

Claude SDK sidecars must not treat Edit/Write input text as authoritative patch
data. They should collect the `PostToolUse` `tool_response.structuredPatch`
hunks, convert them into file-level `changes[].diff` payloads, and only use
input-derived file metadata for optimistic display before the tool response
arrives.

Provider adapters that receive successful write/edit/apply_patch tool calls
without a native turn-level diff event must still normalize the executed tool
output into `fileChanges.files` and emit a `turn.updated` patch carrying those
`fileChanges`. The AgentGUI turn summary reads the turn state as the shared
source for the response-tail changed-file list; tool-only payloads are not a
substitute for that state.

Approval tool calls may wrap the pending Edit/Write input so the transcript can
preview what the user approved. Treat that nested input as preview-only data:
Approval rows must not contribute edit diff counts, changed-file summaries, or
undo/reapply patch batches. The executed file-change tool output remains the
source of truth for edit statistics and reversible patches.

Claude SDK interactive tools must preserve `callType: "interactive"` on the
top-level durable tool payload, not only inside `metadata`. Agent GUI and
Message Center both project approvals and prompts from the normalized top-level
call type. For `AskUserQuestion`, renderer payloads may keep
`answersByQuestionId` keyed by stable UI question ids, but the Claude SDK
permission callback must return `updatedInput.answers` keyed by the full
question text because current Claude SDK result rendering looks up answers by
question text. Legacy Claude ACP `AskUserQuestion` failures may be hidden only
when the recorded failure says the tool is unavailable; waiting or completed
Claude SDK `AskUserQuestion` calls must remain in the Agent GUI detail
projection so the composer prompt can render.

Runtime interactive prompts also travel through session state. Provider
adapters expose them as `SessionStateSnapshot.pendingInteractive`; runtime
state patches must preserve that field through `WorkspaceAgentStatePatch`,
`AgentActivityStatePatch`, and `AgentHostWorkspaceAgentStatePatch` so
AgentGuiNode can render prompts before any durable tool-call row completes.
This field is tri-state: omitted means "no change", an object means "show this
prompt", and explicit `null` means "clear the current prompt". Do not model it
as a persisted workspace session field or as a pointer-only JSON field that
cannot emit `null`.

Claude background agents are session-level runtime state for both ACP and SDK
adapters. Raw Claude `task_started`, `task_progress`, `task_notification`,
`task_updated`, and SDK sidecar `task_*` events should update
`runtimeContext.backgroundAgents` and emit activity timeline events, without
forcing the parent session into a working lifecycle state. Composer wait copy
such as "Waiting for 1 background agent to finish" must be derived from that
structured runtime context. Do not infer background agent waits from terminal
streaming state or from transcript text; persistent session readers can receive
task progress after the active prompt call has returned.

For Claude SDK background agents, treat the Agent tool call id
(`parentToolUseId`) as the canonical background-agent key. SDK `task_id` and
`agent_id` values are aliases that may arrive later or from hooks without a
parent id, and `task_id` frequently carries the agent id, so aliases must be
resolved against both maps. Do not bind any unscoped task event (`TaskCreated`,
`TaskCompleted`, `task_started`, `task_progress`, `task_notification`) to "the
only running" delegated task when its alias fails to resolve and another
registered task already has a known alias; concurrent launches can otherwise
attach one child task id to a different Agent tool call, fold two background
agents into one runtime entry, and leave the composer wait count stale or
cleared early. The daemon `backgroundAgents` map follows the same canonical
rule: an update carrying an explicit parent tool call id may merge through
weaker aliases only into an entry with an empty or identical recorded parent.
Delegated tasks settle only on the child `result` message, the
`task_notification` system message, or the `TaskCompleted` hook. Child
assistant messages tagged with `parent_tool_use_id` stream while the child is
still running and must not complete the task, and a trailing `task_progress`
after settlement must not flip the task back to running; only a new
`task_started` may restart it. Violating either rule makes the running
background-agent count oscillate without new launches.

Claude SDK manual `/compact` turns must publish a visible compact completion
activity when the SDK emits only a `compact_boundary` system message. The
boundary still updates context usage, but it can arrive before the SDK echoes
the user message or after the result settles; AgentGUI needs the sidecar to
attach a durable `compact_completed` event to the compact command turn rather
than only the currently active turn.

When Claude resumes parent work after a background agent completes, that resumed
work is a new synthetic turn for AgentGUI lifecycle purposes. The sidecar and
runtime adapter must publish a turn-start lifecycle patch before transcript or
tool updates for that synthetic turn; otherwise AgentGuiNode will correctly keep
the composer idle because the authoritative runtime state is still settled.

Do not persist the UI button state. A successful Undo only flips the local
button to Reapply for the current render. If the page reloads, the source of
truth is still the recorded diff plus the current worktree state; `git apply`
decides whether the operation can still apply cleanly.

The Undo/Reapply control uses an icon plus visible text. Before enabling the
control, AgentGUI resolves Git patch support for every cwd in the pending
batches. If any cwd is outside a Git repository, the control stays disabled and
uses an explanatory tooltip instead of letting the user click into a
`not-git-repo` failure. If the row cannot reconstruct executable patch data,
AgentGUI still renders the control disabled with a tooltip.

Patch batch cwd values may be runtime-projected paths such as `/workspace`.
AgentGUI must use those values to construct cwd-relative unified diffs, but map
them back to the host workspace root before calling Git support/apply APIs.
Although the daemon transport route is under `/v1/workspaces/{workspaceID}`,
turn-summary patch apply follows Codex App's host operation semantics: the
request supplies `cwd`, `diff`, and `revert`, and the daemon applies the patch
to the Git repository resolved from `cwd`. `workspaceID` is the desktop/tuttid
context for transport, eventing, and host integration; it is not a filesystem
boundary for this operation. The daemon Git patch service also treats a supplied
file path or not-yet-created target path as a path inside the candidate
repository by resolving from the nearest existing parent directory.

The Git mutation belongs in `services/tuttid`, not `apps/desktop` or
`@tutti-os/agent-gui`. The daemon creates a temporary `tutti-apply-*`
directory, writes `patch.diff`, optionally copies the Git index into that
directory for non-atomic unstaged `--3way` operations, executes `git apply` or
`git apply -R`, and removes the temporary directory on every exit path.
When reversing an added-file patch, the daemon has one narrow fallback for
less-structured summary diffs: if Git rejects the patch, the target is still
untracked, and the current file content only differs from the patch by trailing
newlines, it removes the file directly. Real content drift must continue to
fail instead of being deleted.

Undo uses reverse batch order. Reapply uses original batch order. A non-success
batch stops the remaining batches and is not automatically rolled back. This is
intentional: summary undo is a reverse patch against the current worktree, not a
snapshot restore.

Patch failures are surfaced through the host-provided short toast capability.
The desktop host wires that capability to the existing `Toast.Error` facade;
AgentGUI shared components should not call the sonner `toast.error` entrypoint
directly except as a last-resort fallback when no host toast capability exists.
The summary card does not keep an inline failure row or durable error state
because the source of truth remains the recorded diff plus the current worktree
state.

Codex invalidates Git query caches after this operation. Tutti currently has no
equivalent renderer Git cache group. The AgentGUI row emits a lightweight
`tutti-agent-git-patch-applied` browser event after a result that changed files
so desktop surfaces can attach targeted refresh behavior later, but this event
is not durable state and should not become the source of truth.

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
The desktop adapter should keep broad session-list loads bounded before they
enter `AgentActivityRuntime`; large workspaces can accumulate hundreds or
thousands of historical agent sessions, and pushing all of them through the
runtime snapshot forces AgentGuiNode to repeatedly project and reconcile data
the user is unlikely to inspect in the rail.
AgentGUI rail sections are loaded from the daemon section contract, not inferred
from conversation `cwd` values. The runtime exposes `listSessionSections` for
section first pages and `listSessionSectionPage` for Show more; both are backed
by `GET /v1/workspaces/{workspaceID}/agent-session-sections` and
`GET /v1/workspaces/{workspaceID}/agent-session-sections/page`. Project
sections come from current `userProjects` and use the stable
`project:/canonical/path` `sectionKey`; the Chats section uses
`conversations`. The daemon pages sessions by `rail_section_key`, so AgentGUI
must render returned section props and use backend `hasMore`/`nextCursor`
rather than cwd grouping, root filters, excluded project paths, or local
Show more heuristics. Local conversation-summary reconciliation may patch rows
already present in a returned section, but it must not synthesize project
sections or move rows between project sections from `cwd` or resolved
`userProjects`. Removing a project removes that rail section from the section
list; re-adding the same path reveals historical sessions with the same section
key.
Section-level actions must use the same backend section contract when their
scope is "everything in this section." For example, project batch delete cannot
derive its target set solely from the currently rendered `section.items`, because
those rows may only be the first page; it must use daemon section-scope
operations such as `count` and `delete` by `sectionKey` before reporting the
final target count or deleting the target set.
Pinned conversations are returned beside those sections as a separate pinned
page on the `listSessionSections` bootstrap response. AgentGUI may render that
page as a local `pinned` group, but pinned is not a daemon section kind and
must continue to be derived from session `pinnedAtUnixMs`. Pinned Show more
uses the dedicated pinned page runtime method instead of the section page
endpoint, because pinned has no daemon `sectionKey`.
Rail row actions that need row details must use the row from the displayed
section model, not re-resolve it from the activity snapshot. Section pages can
include historical sessions that are visible in the rail before they appear in
the current snapshot, so actions such as rename must carry the displayed
conversation through to their dialog or local interaction state.
When the provider rail is scoped to a specific agent target, AgentGUI must pass
that `agentTargetId` to both section endpoints. The daemon applies that filter
before `LIMIT` and `hasMore` calculation; frontend filtering after an unscoped
page is not equivalent and can leave sections with fewer visible rows but a
stale Show more affordance.
AgentGUI must not refetch section first pages merely because a user activates a
conversation, the active detail provider changes, or an existing conversation
summary receives detail/status/time updates. Those updates should refresh
already-rendered row props locally while preserving backend section membership.
First-page section refetches are reserved for workspace, rail filter, user
project, or session membership changes; Show more continues to use the section
page endpoint.
During rail-filter refetches, keep the previously rendered section chrome in
place for short reloads. Provider/agent switching should not briefly unmount
the project rail header or replace a populated rail with an empty/skeleton
rail; if the new first page takes longer than the rail skeleton delay, show the
skeleton so the user sees loading feedback. Only workspace changes may clear
the section cache immediately.
Conversation-list read-state metadata is notification-style UI state. Historical
imports that carry `runtimeContext.imported === true` should remain visible in
the rail, but they must not seed unread completion lamps as though they just
finished locally. Preserve the imported marker through conversation summaries
and summary-stabilization equality before deriving unread completion state.
Active-conversation ownership is a visibility/registration signal, not always a
new read action. Mark unread completions as read when an owner changes to a
different active conversation or when the user explicitly selects the
conversation, but do not clear a manual unread override when the same owner
re-registers the same active conversation during focus, query, or render
catch-up.
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

The selected detail window is a UI-local page cache, not proof that the full
durable transcript has loaded. If live updates or snapshot reconciliation seed a
detail window before the selected session's initial message page resolves, do
not treat that window as a complete cache just because it has renderable rows.
Either force the initial `listSessionMessages(order="desc")` page load, or mark
the window as having older history so top-of-transcript prefetch can request the
missing page. This is especially important when the oldest loaded durable
version is greater than the first persisted version: otherwise the visible top
row can be a later assistant/tool message even while the scroll container is
already at the top.

### First Prompt In A New Conversation

```text
composer submit with no activeConversationId
  -> startConversation
  -> normalize prompt content and optional displayPrompt
  -> set local first-create busy state
  -> mark conversation-list create pending
  -> create optimistic conversation id + user message
  -> enter optimistic conversation detail
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
  -> replace transient summary with durable conversation
  -> reconcile optimistic user message
  -> clear the submitted home draft if it was not edited in flight
  -> ActivityProjection receives runtime reports
  -> agent.activity.updated events
  -> AgentActivityController snapshot update
  -> projection + UI refresh
```

For normal first-message creation, the controller creates an optimistic
conversation id and enters that conversation surface immediately while
activation is pending. The optimistic session is not durable yet, so any
ordinary follow-up submit targeting `startingConversationIdRef.current` must
enter the local queued-prompt runtime instead of calling `sendInput` directly.
After activation succeeds, the controller attaches the durable conversation and
reconciles the optimistic user message before loading runtime projection. For
Claude Code,
`desktopAgentActivityAdapter.createSession` may promote a pre-warmed hidden draft
session before calling `sendWorkspaceAgentSessionInput`. Create-time-only launch
options must opt out of that promotion path because the hidden draft has already
created and prepared its runtime.

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
The submit request sets the daemon `guidance` flag so runtime handling can
dispatch to provider-specific active-turn guidance without opening a normal next
turn. Codex app-server maps this to `turn/steer`; Claude SDK maps it through the
sidecar live prompt queue. `Shift+Enter` remains the multiline composer shortcut
and must not submit either a normal prompt or guidance.
Active composer state must prefer a live `AgentActivityRuntime` turn lifecycle
over the selected session view/control state. `getState` and legacy state patch
paths can temporarily report a settled or available control state while the
runtime snapshot still has `turnLifecycle.activeTurnId` with a live phase. In
that split state, AgentGuiNode must keep the transcript/loading projection busy,
set normal `canSubmit` false, and let ordinary composer sends enter the local
queue. Only explicit guidance actions bypass that queue and steer the active
turn. Legacy `idle` turn patches clear `activeTurnId`; they must not leave a
stale active-turn block behind.

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
If a provider exposes final assistant text through a side-channel such as a
Claude SDK message rather than an ACP `agent_message_chunk`, the daemon adapter
must normalize that text into the same persisted message projection. AgentGUI
must not read provider transcript files or SDK-specific logs to recover missing
final output.
Tool output follows the same rule. Provider adapters may preserve raw fields
such as `stdout`, `output`, `content`, or SDK content blocks for diagnostics and
specialized renderers, but the daemon message projection must populate
canonical `output.text` when visible tool output exists. AgentGUI renderers
should prefer canonical fields and treat provider-specific output shapes only as
legacy persisted-message fallbacks.
Prompt image input is also part of the normalized runtime contract. Daemon
adapters that advertise `imageInput` must forward the structured prompt content
blocks to their runtime boundary; SDK sidecars may keep a text `prompt` fallback
for short-term IPC compatibility, but image execution must use the structured
`content` blocks instead of reconstructing input from display text. AgentGUI
enables prompt image drafts only when the provider/session capability advertises
`imageInput`. Providers that opt in to model-level image gating, currently
OpenCode and Cursor, must also have the selected model option carry
`supportsImageInput: true`; unknown model image capability is treated as
unsupported until the daemon resolves it from Models.dev or provider-specific
rules. Providers that have not opted in, such as Claude Code, must not be
blocked by a missing model-level field. Desktop prompt images must remain
structured image blocks and are not file mentions. Pasted images may start as
base64 UI draft data, but the
desktop runtime archives them through the host file capability before daemon
submission, then sends the managed desktop-local `path` as the image source.
Conversation previews for these path-backed images must use
`AgentActivityRuntime.readPromptAsset` to read the managed local asset; do not
keep base64 data in submitted prompt content just to render optimistic messages.
The daemon copies that source into the session prompt attachment store and
persists the normalized `attachmentId`. The managed source path must live under
the daemon state root's `agent-prompt-assets` directory, and the daemon must
re-check the resolved source path, symlink target, file type, and size before
copying it into the session attachment store.
Shared callers may instead supply a URL-backed image block when they already
uploaded the image. That source must be an absolute HTTPS URL without embedded
userinfo and must retain a supported PNG, JPEG, or WebP MIME type. `data` and
`url` are mutually exclusive; ambiguous blocks are rejected. URL-backed images
bypass the prompt attachment store and owner-side hydration. Until uploaded
images carry a stable read identity end to end, user-message activity content
retains the HTTPS URL so reloaded transcripts can render the resource directly;
diagnostics must still record only safe shape flags and never log prompt bytes
or the URL itself. UI-local composer drafts and optimistic overlays retain the
same URL for preview and submission; they must not convert it to base64 or
persist it as a local prompt attachment.
Provider transport adapters may materialize that HTTPS resource into inline
image data only at their final request boundary when the upstream protocol does
not accept remote image URLs. Codex app-server, standard ACP, and the Claude SDK
sidecar currently do this immediately before their turn/prompt request; the
AgentGUI draft, submitted content, and durable activity payload remain
URL-backed. When a provider gains native remote-image support, remove the
compatibility conversion only from that provider adapter rather than changing
the shared composer contract.
When `uploadPromptContent` returns an image, the composer upload continuation
must accept every normalized image reference shape: `url`, `attachmentId`,
`path`, or `data`. A URL-backed result replaces the pre-upload base64 runtime
source with the trimmed URL while retaining the original `previewUrl` only for
UI rendering. Submitted-draft reconciliation must compare normalized URLs so
an in-flight edit to a URL-backed image cannot be mistaken for the submitted
draft and cleared. Validate this handoff with the focused `AgentComposer` and
`useAgentGUINodeController` test suites listed under Boundary Checks.
Composer diagnostics expose this chain without recording prompt bytes or signed
URLs: `agent.gui.composer.image_upload.requested`, `.resolved`, and `.failed`
report upload availability and safe reference-shape flags, while
`agent.gui.composer.submit_state_changed` reports the exact send-button blocker
such as `submit_disabled`, `image_uploading`, or `image_upload_failed`. These
composer events use the same development console fallback as controller
diagnostics when the host runtime implements uploads but omits
`reportDiagnostic`.
Claude Code runtime options follow the same parity rule. The legacy ACP adapter
and the Claude SDK adapter must derive system prompt append text, Tutti detail
mode instructions, plan-mode instructions, plugin directory, custom model args,
disallowed tools, and the Claude Code built-in tool preset from one daemon-side
builder before they cross their runtime boundary. SDK sidecars should map that
structured payload into SDK `query` options; they should not rediscover plugin
dirs, infer tool availability from UI labels, or keep a separate prompt/options
contract from the ACP path.

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

Live display-only clocks in transcript rows, such as running sub-agent elapsed
time, are UI-local interaction state. Do not derive a running timer solely from
`latestActivityAt - startedAt`: `latestActivityAt` only changes when a durable
activity event arrives, so quiet but still-running work will appear frozen.
Running rows that need wall-clock elapsed text should own a local tick, while
completed, failed, or canceled rows should render a fixed terminal duration
from terminal/latest activity timestamps.

When a session status bug mentions "still processing", "queued", or a disabled
composer after a turn finishes, inspect the full runtime tuple:
`status`, `currentPhase`, and `turnLifecycle.phase`. The Agent Activity snapshot
may carry lifecycle status such as `active` while the visible state is derived
from `currentPhase` or turn lifecycle. Projection layers that bridge into legacy
Host DTOs must normalize the tuple together, or `active/idle` and
`active/working` sessions will render as the wrong conversation state.
Daemon terminal turn reports must settle the tuple atomically: clear
`turn.activeTurnId` and `turnLifecycle.activeTurnId`, set
`turnLifecycle.phase` to `settled`, set `currentPhase` to `idle`, and replace an
`active_turn` submit block with `submitAvailability.state = "available"`.
Message Center and AgentGUI should keep AgentActivityRuntime as the source of
truth instead of guessing that a completed turn with stale active-turn fields is
safe to treat as finished.

`submitAvailability` on the wire is host authority, while
`deriveSubmitAvailability` is a compatibility guard for missing or stale
derived block reasons. Consumers that make decisions (queued-prompt drain,
composer busy) should call `resolveSubmitAvailability` from
`@tutti-os/agent-activity-core`: an explicit wire `available` stays available,
unknown wire block reasons stay blocked, and locally derived `active_turn`,
`waiting`, or `background_agent` blocks fill the remaining gaps. A settled
turn lifecycle is terminal even if an older runtime forgot to clear
`activeTurnId`; hosts should still clear it when settling a turn. The Go/TS
derivations are pinned to each other by the parity tables in
`packages/agent/daemon/runtime/submit_availability_parity_test.go` and
`packages/agent/activity-core/src/selectors.test.ts`.
When a runtime snapshot regresses after a terminal turn, first inspect
`agent.activity.reconcile.trace` for the exact source that upserted the older
session state. Reconcile fixes should target that owner and ordering path; do
not add broad UI-side stale-active-turn exceptions that hide an upstream state
or reconciliation bug.

When the visible symptom is a sticky error badge on a rail row, dock preview, or
message-center trigger, also inspect the latest loaded turn messages. A
session-level `failed` status can be historical after a later turn starts or
completes. Outer status badges should keep authoritative non-error lifecycle
states, but when the outer projection is `failed`, they should let the latest
turn's message status clear or confirm that failure. Keep unrecoverable
activation/resume failures session-scoped; keep ordinary historical turn
failures on the transcript row that produced them.

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

Codex app-server sub-agent child-thread rows carry `payload.ownerThreadId` and
must stay out of the parent transcript. AgentGUI should project those rows only
through the parent collaboration tool card's sub-agent lanes. Child lifecycle
state is lane-owned: spawn-card success means only that delegation started
successfully, not that the child completed. The lane projection should treat
owner-thread `subAgentLifecycle` markers as terminal state, use
`agentsStates`/`statuses` from wait or close control-tool output as
corroborating terminal state, and keep the lane running while child output
continues without either signal.

### Layer Ownership Summary

| Layer                                   | Owns                                                                                                   | Must not own                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `tuttid` agent service                  | provider runtime start, exec, resume/cancel, validation, persistence reports                           | AgentGUI view state                                          |
| `ActivityProjection`                    | persisted session/message projection and `agent.activity.updated` publication                          | React projection or local UI overlays                        |
| desktop `WorkspaceAgentActivityService` | runtime adapter, snapshot controller, optimistic bridge, event reconcile, desktop/tuttid client calls  | transcript rendering semantics                               |
| `AgentActivityRuntime`                  | AgentGUI-facing source of durable activity data and commands                                           | independent session/message storage                          |
| `AgentQueuedPromptRuntime`              | ephemeral busy-session queued prompts keyed by workspace and agent session, drain claims, retry blocks | persisted node/session/message state                         |
| AgentGuiNode controller/stores          | selection, drafts, loading/error state, pending overlays, command sequencing                           | authoritative session/message state or queued prompt storage |
| shared projection/model helpers         | deterministic conversion from snapshots/messages to view models                                        | provider transport calls                                     |
| React views                             | DOM interaction and rendering from `viewModel`/`actions`                                               | fetching or mutating durable activity directly               |

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
- Conversation target filters are also list-query concerns. The All rail filter
  applies no `agentTargetId` constraint; provider target rail filters such as
  Codex and Claude Code match sessions by `session.agentTargetId`, not by
  `session.provider`. Filter normalization and list projection helpers must not
  mutate workbench node `provider`, provider target fields, composer drafts,
  desktop default provider, or composer-default preferences. All-filter clicks
  must only clear the `agentTargetId` constraint. Provider target rail clicks
  may update the home composer launch target only when there is no active
  conversation; active conversations keep owning their displayed target until
  the target-filtered list initializes. If that target list is empty, AgentGUI
  should unactivate the current conversation and show the selected target's
  new-conversation empty composer. React view components must not dispatch
  separate filter and home-composer target actions for one rail click.
  Apply them only for multi-provider conversation scopes. Single-provider
  panels should let the node provider constrain the query and collapse target
  filter actions back to All in the controller.
- A pending create row can appear before the daemon-created session is
  authoritative. It must be replaced by the authoritative session or removed on
  create failure.
- Working/error/attention badges should come from session status, pending
  interactive/approval projection, or explicit local pending state. Do not infer
  them from row text.
- Error badges are current-state indicators, not session-history indicators. If
  a session still reports `failed` but loaded messages show a newer successful
  or running turn, list/dock/message-center projections should follow that
  newer turn instead of keeping the whole session red forever.

### Conversation Titles Across Surfaces

```text
runtime snapshot session + cached messages
  -> Agent GUI title projection
  -> rail row / detail header / workbench header / dock popup / toast title
```

User-visible rules:

- AgentGUI conversation titles must use the shared title projection before they
  reach desktop-owned chrome, dock previews, message center cards, or toast
  notifications. Do not display raw `session.title.trim()` in those surfaces.
- Live runtime snapshot data is the source for workbench and dock titles. Do
  not persist or restore `lastActiveConversationTitle` from workbench node
  state.
- User rename flows must mutate the persisted runtime session title through
  `AgentActivityRuntime.renameSession` and then upsert the returned
  authoritative session into the runtime snapshot. Do not update only the rail
  list, otherwise the rail row, active detail header, workbench title, and dock
  surfaces can diverge.
- Title projection must normalize rich mention markdown, strip provider-only and
  untitled placeholders from workbench chrome, and use cached first-user-message
  content only when the session title is not displayable.

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
- A local composer submit is an explicit user navigation intent: after a normal
  or guidance prompt submit, the detail timeline should force one bottom scroll
  so the user's newly submitted message is visible even if the reader was
  previously in the middle of history. Streaming updates without a local submit
  should still respect the usual stick-to-bottom threshold.

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
  activation immediately enters an optimistic conversation so the submitted
  message is visible while the backend session is being created. Failure
  removes that optimistic conversation and restores the submitted home draft.
- New-conversation entry points that return the user to the home composer,
  including workbench header or external workbench events, should also issue a
  composer focus request so the empty input is ready for typing immediately.
- Treat active-session refs as controller caches, not the source of truth for
  whether a submit is new or existing. React effect cleanup, projection reloads,
  and conversation-list refreshes may temporarily disturb UI-local refs; they
  must not retarget the user's prompt to a newly created session.
- The send button spinner is local submit/approval response state. For
  first-message activation, the spinner and optimistic transcript are the
  normal pending indicators. The "connecting conversation" state belongs to
  existing-session activation/recovery. The transcript processing row is
  runtime turn state.
- Model, permission, plan mode, reasoning, speed, project, branch, prompt image,
  file mention, and skill/capability controls must read from composer settings
  and provider options. They should not be reconstructed from transcript rows.
- Reasoning options are model capabilities, not provider-wide constants. The
  daemon model catalog must preserve each model's advertised effort values and
  default, pre-session composer options must use the selected model's catalog
  entry, and active sessions must prefer the runtime's current model-specific
  options. Compatibility projections that only know persisted settings must not
  synthesize a full reasoning catalog. Composer-option cache freshness must
  include the requested settings as well as target and cwd, and an active model
  change must reload options with the active session settings. ACP owns option
  values and ordering; the relevant locale catalog owns user-visible labels and
  descriptions, including when live runtime options are the fresher source.
- Shift+Tab plan mode is a provider capability, not a frontend allowlist. The
  daemon's pre-session composer options and the live runtime
  `runtimeContext.capabilities` must both advertise `planMode` before AgentGUI
  enables the toggle for a provider.
- Browser/computer capability controls come from daemon composer options and
  live runtime capabilities. `computerUse` must not be advertised or injected
  unless the daemon can reach the local `cua-driver` and its read-only
  `permissions status --json` reports Accessibility and Screen Recording are
  granted. Installed/authorization UI is the setup surface and should guide
  missing macOS grants in order. It may try CuaDriver's grant command, but must
  keep that call single-flight and bounded by a timeout because macOS may not
  re-show TCC prompts after a denial. When prompts are unavailable, the UI should
  open the matching System Settings privacy pane and poll read-only status until
  the permission state changes. Runtime tool startup must fail fast on missing
  permission state instead of triggering CuaDriver authorization prompts. Treat
  `screen_recording=true` with `screen_recording_capturable=false` as a CuaDriver
  capture-availability problem, not as a promptable Screen Recording grant.
  Permission setup is a user-driven, linear five-step wizard (install → grant
  Accessibility → grant Screen Recording → check again → done). Guiding the
  user's own actions is primary; status reads are auxiliary (per-step chips
  and the initial-step guess) and must never gate navigation, because every
  status source is unreliable in some window: `AXIsProcessTrusted` is cached
  per-process (a fresh Accessibility grant stays invisible to the running
  daemon), Screen Recording capturability freezes per-process, and toggling
  Screen Recording kills the daemon outright. The grant command
  fires-and-forgets only behind the user's explicit "Open Settings" click —
  its only job is registering CuaDriver in the privacy panes and raising the
  TCC prompt when macOS still shows one, and because the CLI may open windows
  of its own it must never run on step entry; it is never awaited and never
  becomes a blocking operation. The "check
  again" step reconciles unconditionally: it always restarts the daemon
  (`cua-driver stop`, relaunch the app bundle via `open -g -a` so the daemon
  keeps its own TCC identity, then short-poll read-only status), which clears
  every staleness at once, and passes `force` so a still-confirming grant
  cannot make it hang. The restart itself must never call the grant command —
  grant waits on TCC confirmation and would hang a fresh install; prompting
  stays exclusive to the single-flight grant flow. Completing an install
  advances the wizard straight into the first grant step. Status reads
  in the Electron main process are coalesced so overlapping polls share one
  subprocess, and the renderer re-checks on window focus/visibility and keeps
  polling while the permission dialog is open and unauthorized.
- User composer defaults are owned by desktop preferences. AgentGUI may request
  a defaults write only from the home/new composer path, through an explicit host
  callback.
- Lab-mode AgentGUI affordances are desktop-preference driven through generic
  feature flags. AgentGUI must not receive experiment-specific props or create
  git worktrees itself; new experiments should add a desktop feature-flag
  catalog entry and keep any product-specific behavior in the owning desktop or
  daemon layer.
- Home/new composer defaults, overrides, options, and draft settings are keyed
  by a directory-resolved `agentTargetId`. They have no provider-keyed fallback,
  so two targets under the same provider cannot share model, permission,
  reasoning, speed, or draft state by accident.
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

### Provider Environment Setup

Provider setup state follows the same service/store/controller/view split as
other desktop feature orchestration:

- `@tutti-os/agent-gui` owns the pure setup flow and i18n-agnostic view model in
  `shared/agentEnv`.
- Desktop owns `agentEnvWizardStore`, `agentEnvWizardController`, and
  `useAgentEnvWizard`; these subscribe to the provider-status service, dedupe
  per-open automatic actions, and coordinate anomaly reporting and progressive
  reveal.
- `AgentEnvPanel` subscribes and renders. It must not duplicate readiness
  detection, installation, login, or reporting workflows in React effects.

The provider-status service remains the source of truth for installed,
authenticated, network, and active-action state. Wizard-local state is
ephemeral presentation state and resets with the panel lifecycle.

### Busy Queued Prompts

Busy-session queued prompts are AgentGUI-owned ephemeral interaction state. They
live in `AgentQueuedPromptRuntime`, not in Workbench node snapshots, not in
`AgentActivityRuntime` durable session/message snapshots, and not in
conversation-list or session-view compatibility stores.

The desktop activity-runtime-services helper reuses one queued-prompt runtime
for each workspace activity service and workspace id, then the AgentGUI
workbench host injects that runtime into every AgentGUI workbench node. Queue
identity is `(workspaceId, agentSessionId)`, so reopening a minimized node or
opening another workbench node for the same agent session sees the same queue
instead of forking by node id.

Draining is claim-based. Any drain owner must call
`claimNextToDrain({ workspaceId, agentSessionId, ownerId })` and may call
`AgentActivityRuntime.sendInput` only for the returned claim. Completion and
release are validated by `claimId`, which prevents a stale owner from deleting a
newer claim or sending the same queued prompt twice. A panel unmount must not
eagerly release an in-flight drain claim; the owner that already called
`sendInput` must complete or release that exact `claimId` when the send settles.
If the owner disappears before the send settles, the claim lease is the recovery
path so a queued prompt cannot stay permanently stuck at the head of the queue.

Queued prompts are session-scoped user intent, not active-detail UI intent. The
desktop activity-runtime-services helper keeps a workspace-level queued prompt
drain coordinator alive alongside the shared queued-prompt runtime, so target
sessions can drain even when every AgentGUI panel is closed. Desktop runtime
services are reused for the same workspace activity service and workspace id;
repeated host-input construction must not create competing queued-prompt
runtimes or drain owners. React controllers must not claim, drain, send, or
interrupt sessions for queued prompts; they only enqueue, display, promote,
edit, remove, and render claim state owned by the runtime/service. The
workspace-level coordinator owns both sending and the "send next" interrupt:
when the queue head is marked as send-next and the target session is still busy,
the coordinator cancels the active turn before waiting for activity to become
ready and then sending the queued prompt. Background drains must not clear the
active conversation's draft, detail error, or submit spinner. Drain readiness
must follow activity projection and retry-block timestamps instead of raw
`controlState` fields such as
`pendingInteractive`, because those fields are not guaranteed to be cleared by
every activity `state_patch`. Queued-prompt drainers must not locally decide
that an `active_turn` block or a lingering `turnLifecycle.activeTurnId` is
stale; they should wait until the shared activity projection reports
`submitAvailability.state = "available"` and no active turn remains. When a
drain attempt hits an active-turn conflict, the retry block must be recorded
from the ready activity version observed before calling `sendInput`, using the
same activity-version source that the next drain gate compares. Do not read a
mutable activity snapshot after the awaited send fails: the failure may arrive
with a newer settled/available activity update, and blocking that newer version
would strand the queued prompt until another unrelated activity event. The
retry block still prevents immediately re-claiming against the exact same
pre-send ready state.

A user stop is an intent, not just a turn cancel: `interruptCurrentTurn`
suspends the session's prompt queue (`suspendReason: "user_stop"`) before
issuing the cancel, so the drainer must not fire the next queued prompt the
moment the session becomes available. Only an explicit user send lifts the
hold — composer submit calls `resumeQueue`, and `promotePrompt` ("send now"
on a queued item) clears the suspension in the queue core. The drainer's own
send-next interrupt path never suspends: intent is captured at its source,
never inferred from the cancel outcome.

Preview-mode AgentGUI surfaces are read-only for this runtime: they may render an
existing queue if injected into the same context, but they must not enqueue,
claim, drain, promote, edit, or delete queued prompts.

Queued prompt previews must treat prompt image blocks as the same send contract
used by the composer and runtime: an image may be inline `data`, a staged
`path`, or an HTTPS `url`. Do not cast queued images to data-only blocks or build
thumbnail URLs from `image.data` without checking it. URL-backed queued images
must preserve the structured URL through edit and submission and may use it
directly for preview; they must not hydrate it through the prompt-asset reader.
Path-backed queued prompt thumbnails should use the activity runtime
prompt-asset reader when workspace/session context is available, and otherwise
avoid rendering a broken image while keeping the queued content unchanged for
sending.

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

| Visible state                  | Primary owner                    | Starts when                                                    | Clears when                                                                    |
| ------------------------------ | -------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Rail skeleton or empty loading | conversation list query/store    | runtime list load starts                                       | list load resolves or errors                                                   |
| Selected detail skeleton       | session view store/controller    | active session messages load starts                            | `listSessionMessages` resolves or active session changes                       |
| Home first-create busy         | controller local create state    | home `startConversation` begins                                | new-session activation succeeds, fails, or is abandoned as stale               |
| "Connecting conversation"      | existing-session activation      | existing session open/retry calls `activate`                   | activation succeeds, fails, or is abandoned as stale                           |
| Transcript processing row      | transcript/session projection    | runtime reports working/turn phase                             | runtime reports ready/completed/failed or newer message projection replaces it |
| Send button spinner            | controller local submit state    | `executePrompt` or approval submit begins                      | command promise settles                                                        |
| Composer settings loading      | composer options/settings model  | provider options load starts or settings source missing        | options/settings resolve or fallback state is applied                          |
| Provider setup notice          | desktop provider status adapter  | captured provider status says the active provider is not ready | captured status says provider is ready or user fixes setup                     |
| Approval response spinner      | controller approval submit state | prompt/approval option submit begins                           | runtime command settles and prompt projection updates                          |

When a loading state is wrong, first identify which row in this table is
visible. Then debug that owner and clearing condition. Avoid moving a spinner
between surfaces to hide a state-source mismatch.
Desktop restore must not project "not ready" from an uncaptured provider-status
snapshot. Until the first captured provider status exists, pass unknown provider
readiness into AgentGUI so startup does not flash a false "configure provider"
notice before local Codex or other provider detection returns.

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

Runtime capability declarations are also part of this contract. Missing
capability keys default to enabled for backwards compatibility. Hosts can set
`capabilities.canCancel`, `canSubmitInteractive`, `canGoalControl`, or
`canUploadAttachment` to `false` to hide and no-op the corresponding AgentGUI
UI affordance. `canUploadAttachment` applies to prompt attachment upload paths
(pasted images, pasted large text, dropped/host-local files) and must not hide
ordinary `@` references or workspace-reference mention selection.
When `reportDiagnostic` is omitted, development builds use a low-cost console
sink for AgentGUI diagnostics such as composer upload/submit state, message page
requests/resolutions, render-state changes, and caught errors. Hosts can set
`devDiagnosticConsoleSink: false` to keep a development runtime silent;
production remains silent by default.

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

### Agent Directory

AgentGUI distinguishes directory identity, launch authority, and runtime
provider metadata. The host must project its `/agents` snapshot into the public
`agents: AgentGUIAgent[]` prop. That array is the complete ordered UI directory:
AgentGUI must not synthesize provider-catalog entries, reorder by provider, or
replace a loaded-empty array with local defaults.

`agentTargetId` is the sole AgentGUI identity for selection, conversation
filtering, composer-option caches, workbench node state, and new-session
launches. The daemon resolves it against `agent_targets` and derives the
execution provider and runtime target reference from trusted target state.
Target-backed create requests may omit `provider`; if a request supplies both
`agentTargetId` and `provider`, the daemon rejects mismatches. Client-supplied
target-reference data must not override the daemon-derived launch data when
`agentTargetId` is present.

`provider` remains runtime metadata for provider-native composer behavior,
probes, capability checks, telemetry, and execution policy. It is not a UI
identity. AgentGUI must not group, deduplicate, name, icon, select, or cache
directory entries by provider. Multiple agents may share one provider and must
remain independently selectable by `agentTargetId`.

`agentTargetId` is a foreign key into the local target directory, not an opaque
identity supplied by a session. Session ingestion preserves an id only when it
resolves in `agent_targets`; a registered alias may be rewritten to its local
canonical id as defense in depth, while a definitive miss is cleared and the
original value is retained only in diagnostic runtime context. Shared-agent
owner-domain ids must be translated by the host projection layer before they
reach the caller's daemon. The daemon must not infer identity from
`providerTargetRef`, provider, or other session-carried metadata.

AgentGUI resolves active-session identity through the same directory. While the
directory is loading the composer stays neutral; after loading, an unresolved
target produces a session-scoped missing-agent state with a disabled composer
and read-only history. A legacy provider-only session resolves through the
registered `local:<provider>` target. This is still a directory lookup, not a
provider fallback.

Target-bearing launch and prefill requests follow the same foreign-key rule:
wait while the directory is loading, then require an exact `agentTargetId`
match. A missing explicit id must not fall back to a sibling that happens to use
the same provider or to the first directory entry.

Directory loading has three distinct outcomes: unknown/loading, successfully
loaded (including `[]`), and failed. Hosts may cache successful empty results,
but a failed request must clear its cache so a later load can retry; it must not
be converted into an authoritative empty directory. Window/bootstrap transport
must serialize an explicit `agents: []` so detached windows preserve this
distinction instead of reverting to loading.

The public directory entry owns its presentation and availability:

- render `agents[].name` and `agents[].iconUrl` as the primary identity
- render `owner.avatarUrl` separately as an ownership badge
- preserve host array order; normalization keeps the first valid occurrence of
  each `agentTargetId`
- use `availability.status` for ready, checking, coming-soon, install, login,
  and unavailable presentation
- show no aggregate `All` entry when exactly one agent exists
- show `All` plus the host-ordered rail and home carousel when multiple agents
  exist
- keep the multi-agent home carousel mounted when the selected agent changes;
  move the selected directory-owned node into the center without reordering the
  host array, including when the selected target enters or leaves a readiness
  gate; keep the carousel canvas outside the ready/gated body branch so its
  scroll position and animation are not reset; rotate the centered record by
  default, temporarily give playback to the record under the pointer, return
  playback to the current center when hover leaves, preserve each record's
  stopped angle when playback moves elsewhere, and fade records progressively
  by distance from the center while keeping the next outer record partially
  visible on each side; target
  changes should prime the wheel spring with an immediate directional impulse
  and avoid duplicate WebGL submissions from playback and wheel animation; use
  a shallow lit cylinder beneath the icon texture when rendering the record so
  thickness, rim reflection, and side perspective remain part of the same
  mounted Three.js scene instead of pre-rendered replacement assets; keep
  one-shot redraw and spring animation RAF handles separate so a pending resize
  or texture render cannot suppress a new interaction, let the spring frame own
  the single pose/render pass during movement, share record geometry, and cull
  repeated records outside the visible center range; start pointer-driven
  carousel movement on primary `pointerdown`, then suppress the matching click
  activation so the spring begins on press without double-selecting the target;
  selection updates the title, composer, and controls below the carousel;
  respect reduced motion by suppressing record playback animation; keep the
  empty-home content on a fixed top anchor so readiness and composer height
  changes grow downward instead of vertically re-centering the whole hero
- persist and pass only `agentTargetId` for target selection and launch
- use `agentTargetId` as the opaque activity-core composer `targetKey`; never
  derive a cache key from provider

The package-internal normalized target vocabulary is
`AgentGUIAgentTarget` / `agentTargets`. Do not reintroduce
`AgentGUIProviderTarget` or `providerTargets`: provider is execution metadata,
while `agentTargetId` is selection and launch identity. Agent avatar chrome is
projected once from an agent target into a shared avatar presentation containing
the resolved icon, label, and optional owner badge. The DOM rail, single-agent
empty state, and WebGL empty-home carousel consume that same presentation;
renderer adapters may differ, but they must not create parallel icon-only
models that can silently discard badge or identity fields.
The WebGL adapter owns badge image loading and GPU resource lifecycle. Remote
badge images must be requested with anonymous CORS before assigning `src`, and
the asset host must return an origin-clean response. The adapter must keep an
asset-independent visible owner marker until decode, canvas conversion, and
texture upload all succeed; any load, decode, conversion, or upload failure
keeps that fallback instead of leaving the badge material hidden. Scene disposal
must detach image callbacks, cancel owned loads, and release badge textures,
materials, and geometry alongside the primary avatar resources.

New-session surfaces, including the composer, batch runner, App Center, and
issue-manager launchers, must fail or disable launch when no `agentTargetId` is
available. They must not synthesize `local:<provider>` from a provider-only
selection as a compatibility fallback.

The removed public `providerTargets`, `providerRailMode`, provider-target
renderers, and `defaultProviderTargetId` fields have no runtime compatibility
alias. Workbench hydration may read legacy `providerTargetId` once and project
it to `agentTargetId`, but canonical state and every subsequent write must omit
legacy provider-target fields. Keep this read in a dedicated persisted-state
migration; current-state normalizers must reject the removed alias.
`providerTargetRef` remains daemon/runtime
implementation data and must not cross back into AgentGUI's public UI contract.

AgentGUI must not mint invocation-control tokens, resolve invocation plans,
contact command gateways, or handle raw credentials. Host/trusted code must
re-authenticate the current user and workspace and resolve launch authority.
An agent may represent shared, local, remote, or other host-owned launch
mechanisms, but those meanings stay outside AgentGUI.

Desktop workbench feeds the renderer `AgentsService` `/agents` snapshot into
AgentGUI. Product feature gates may filter that array before rendering; a
loaded empty result remains empty. Availability states that should stay visible
must remain in the array with the matching non-ready status instead of becoming
synthetic provider placeholders. OpenCode remains gated by the
`enableOpenCodeAgent` developer preference. Tutti Agent visibility is owned by
the daemon's `local:tutti-agent` Agent Target: disabled daemon targets stay in
the presentation snapshot for history and settings, but are omitted from the
new-session `agents` projection before the directory reaches AgentGUI.
Provider slash commands must come from the runtime command snapshot or an
explicit adapter-owned command seed. Do not add AgentGUI-only slash-command
fallbacks to make providers look aligned. For OpenCode, `/compact` and
`/review` are adapter-owned: the runtime seeds the command snapshot, and
`/review` also injects an OpenCode `command.review` config entry. AgentGUI may
surface these as OpenCode fallbacks. OpenCode may reuse the shared review
picker, but picker selections must still submit provider-native `/review ...`
text and must not call Codex's structured `review/start` protocol.
Legacy local hosts may keep AgentGUI's provider-default slash entries by
omitting `slashCommandFallbackMode`. Shared or remote-owner hosts that already
query slash commands from the owning runtime must pass
`slashCommandFallbackMode="none"` so AgentGUI does not mix caller-local command
defaults, local `/plan`, or local capability slash entries into the owner
snapshot. This mode controls command-list synthesis, not the semantics of
advertised commands: when the owner explicitly advertises a built-in name such
as `/plan`, `/fast`, or `/status`, AgentGUI may still handle it with the same
local composer behavior used for local sessions.
Desktop workbench may apply product entry gates before passing target data into
AgentGUI. The Tutti Agent settings switch writes only the daemon-owned
`local:tutti-agent.Enabled` field, then refreshes the shared Agent Target
snapshot. Renderer local storage is accepted only once as an upgrade migration
input and never remains a visibility source. When disabled, the target is
omitted from new-session targets, unified dock launch, launchpad, provider
rail/composer entry points, Workspace App provider catalogs, and workspace-app
mention candidates. The durable target record and session/activity snapshots
remain intact, so existing `tutti-agent` sessions stay readable and their
provider identity stays `tutti-agent`.

`nexight` remains a historical/runtime provider identity for old activity data
and compatibility code, but it is no longer a desktop new-entry AgentGUI
provider. Do not reintroduce `agent-nexight` or the old "Tutti" pseudo-app as a
launch surface; use the first-party `agent-tutti-agent` / `local:tutti-agent`
path instead.

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
   `docs/conventions/troubleshooting/agent-runtime.md`?

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

Composer toolbar affordances that open the `@` panel should insert the same
trigger text through `AgentRichTextEditor` at the current selection and let the
Tiptap suggestion plugin publish `AgentRichTextEditor` suggestion state. Do not
open the mention palette as a separate UI-only state path; the trigger range
still owns command replacement, keyboard handling, and panel anchoring.

Pasting text that contains an `@` must not be treated as active mention input
unless the paste leaves the caret immediately after the `@` trigger. A bare
`@` paste may open the mention panel; a complete pasted query such as `@readme`
should remain plain prompt text until the user explicitly places the caret in
an active trigger position.

`workspace-reference` hrefs are the passive reference contract, not a visual
metadata store. Do not serialize app icons into the href just to render a chip.
For `source=app` references, readonly and markdown renderers should hydrate the
icon from the same `workspaceAppIcons` appId/workspaceId table used by ordinary
`workspace-app` mentions.

System file drag-and-drop uses the same composer mention path as the reference
picker. `@tutti-os/agent-gui` receives a host-injected dropped-file resolver
that returns host-local `WorkspaceFileReference` values with `hostPath`,
`displayName`, `kind`, and `sourceId`; it must not import Electron or resolve
desktop `File` objects itself. The desktop host owns `File -> hostPath`
resolution through platform capabilities. Before insertion, AgentGUI sends
host-local file references through `AgentActivityRuntime.uploadPromptContent`
and only inserts the returned agent-readable path as a normal markdown file
mention. The original host path is an upload source, not prompt content.
The desktop runtime implements this upload by asking the host file capability
to archive the selected file under a Tutti-managed agent prompt assets
directory, then returns that managed absolute path to AgentGUI. Prompt images
use the separate daemon prompt attachment path: AgentGUI keeps pasted image
base64 data only as pre-upload draft state, desktop runtime archives the image
to a managed desktop-local path before submission, and the daemon copies that
path-backed source into the session attachment store before runtime execution.

Agent launch mentions use the external rich-text `agent-target` provider. The
`workspace-app` provider is reserved for real workspace apps and must not return
legacy `agent-codex` or `agent-claude-code` pseudo apps. New agent mentions
should serialize as `mention://agent-target/local:codex` or
`mention://agent-target/local:claude-code` with workspace scope only; they must
not serialize provider ids or icon hints into the href. Renderer display code
must resolve labels, providers, and icons by looking up the current
`agentTargetId` in `AgentsService`-derived presentation data, so future
user-defined icons and editable targets have one renderer source of truth.
Historical pseudo-app mentions may remain as display tokens but are not a new
insertion target.
Desktop AgentGUI host input must include the `agent-target` capability when it
builds composer context mention providers. Inside the AgentGUI mention palette,
the Apps tab queries only `workspace-app`; first-party launch targets appear in
a separate Agents tab that queries only `agent-target`. Do not use the Apps tab
as an agent fallback, because that recreates the old pseudo workspace-app
contract.

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
Active-session settings are first-class session state, not composer defaults.
The controller should submit the runtime settings patch and let the provider
adapter decide whether the change can be applied live or requires a new
session. Provider capability differences belong in the daemon runtime adapter:
for example, OpenCode model and reasoning-effort changes are live ACP
`session/set_config_option` updates, while spawn-time-only provider settings may
return the `agent.settings_require_new_session` reason. The UI should surface
that reason as guidance, not as an unhandled runtime error.

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

Provider host-app-context prompts should mirror that contract: when agents
reference code or workspace files in responses, instruct them to emit Markdown
links with filename labels and absolute filesystem targets such as
`[filename](/abs/path)`, not relative links, inline-code paths, or line-suffixed
paths.

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

### Mixed AgentGUI Language Or Date Labels

Quick checks:

- Check whether the surface is wrapped in `AgentGuiI18nProvider` through
  `AgentGUI`, `WorkspaceAgentMessageCenterPanel`, or a host-owned card wrapper.
- If a desktop surface passes a host `i18n` runtime into
  `AgentGuiI18nProvider`, pass the matching `locale` too. `t()` reads the
  runtime, while formatting helpers such as `formatAgentMessageTimestamp` read
  the AgentGUI locale bridge through `getActiveUiLanguage()`.
- Inspect workbench contribution plumbing when a card is rendered outside the
  main AgentGUI tree; `DesktopWorkbenchContributionContext` should carry both
  `appI18n` and `appLocale`.

Likely fix area:

- desktop contribution context / shell runtime locale propagation
- host-owned message center card wrappers
- direct `AgentGuiI18nProvider` call sites

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
> `docs/conventions/troubleshooting/agent-runtime.md`?

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
- [Agent Reference Sources](./agent-reference-sources.md)
- [Desktop Layering](../conventions/desktop-layering.md)
- [Agent Runtime Troubleshooting](../conventions/troubleshooting/agent-runtime.md)
- [`@tutti-os/agent-gui` README](../../packages/agent/gui/README.md)
