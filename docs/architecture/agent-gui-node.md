# Agent GUI Node Architecture

Status: durable target architecture

Applies to:

- `services/tuttid` agent APIs, workflows, and durable state
- `packages/agent/daemon` provider runtimes and provider registry
- `packages/agent/activity-core` workspace agent engine
- `packages/agent/gui` Agent GUI presentation
- `apps/desktop` Agent GUI host integration

This document defines ownership and dependency direction. It does not track
refactor completion; implementation status belongs in the active refactor plan
and review handoff.

## System Shape

```text
provider runtime
  -> tuttid command/event boundary
  -> daemon entities + workflow saga/outbox
  -> workspace AgentSessionEngine
  -> selectors and commands
  -> Agent GUI vertical modules
  -> view components
```

Desktop supplies host capabilities and embeds the GUI. It is not a second agent
business core. Agent GUI renders engine projections and emits commands. It does
not reconstruct durable session or turn truth from panels, transcript rows, or
provider-specific payloads.

## Daemon Ownership

`services/tuttid` owns durable agent entities and workflows:

- session identity, metadata, settings, and resumability
- turn lifecycle, outcome, and exact-turn cancellation
- interactions, approvals, and interactive prompt responses
- prompt submission identity and idempotency
- goal state and long-running workflow state
- durable event ordering and recovery

Session and turn are separate entities. A session may exist without a running
turn and may contain many settled turns. Running, waiting, completed, failed,
and canceled are turn lifecycle states; they must not be copied onto the
session as a competing lifecycle field.

Conversation lists order a session by the latest user turn: each turn's time is
the earliest user message in that turn, and the session time is the maximum of
those turn times. The renderer uses the projected latest turn directly rather
than loading message history just to calculate this key. A session with no user
message uses its creation time.

Commands that cross process or persistence boundaries use a saga/outbox flow:

```text
validated command
  -> persist intent and outbox record atomically
  -> dispatch to provider runtime
  -> ingest correlated provider events
  -> reduce entity state
  -> mark or retry outbox work
```

Each command carries stable correlation identity. Submit uses a client submit
ID; turn commands identify the exact turn. Retries must be idempotent. Recovery
must resume persisted work rather than infer intent from UI state or the latest
transcript row.

OpenAPI contracts change before daemon HTTP request or response code. Generated
clients and event contracts are projections of that schema, not independent
models.

## Workspace Engine Ownership

One `AgentSessionEngine` instance owns agent state for one workspace and runtime
origin. It is the only frontend owner of canonical sessions, turns,
interactions, pending intents, prompt queue state, and workflow operation state.

```text
daemon snapshot/events -> engine reducers -> canonical entity indexes
GUI command             -> engine command -> runtime adapter -> daemon
engine selectors        -> stable GUI projections
```

Consumers must not create parallel stores for canonical agent data. They must
not read reducer maps directly or derive lifecycle from transcript messages.
All reads go through exported selectors; all writes go through engine commands.
The engine reconciles optimistic intent with authoritative events by correlation
ID.

Historical pull and realtime push are distinct engine inputs. Workspace/session
list pulls dispatch `session/snapshotReceived`; these hydrate history without
creating unread completion attention. Realtime `message_update` events may fold
their normalized append-only messages inline. Realtime turn, interaction, and
legacy state invalidations perform an authoritative session pull, then dispatch
`session/upserted` followed by `turn/upserted` for the realtime turn. The desktop
bridge keeps the one-shot realtime provenance outside reducer state while that
pull is in flight. `AgentActivitySnapshot` is a memoized projection of the
engine state, not a separately mutable controller snapshot.

Actionable interaction UI has one read path:

```text
durable Interaction(pending)
  -> interaction_update
  -> AgentSessionEngine pendingInteractions selector
  -> approval / question / exit-plan presentation
```

The workspace shell and standalone Agent window share one decision-notification
controller and card presentation. When a new pending interaction arrives while
the current window is foregrounded and its Message Center is closed, that
window may surface the actionable card as a persistent top-right toast. Initial
pending interactions are recorded without replaying historical toasts, and a
resolved interaction dismisses its active toast. The workspace shell suppresses
that toast when the same AgentGUI session is already open, while the standalone
Agent window intentionally keeps the top-right card in addition to the inline
prompt. The standalone window does not emit a second OS notification; the
workspace shell remains the owner of the background-only OS face. Toast actions
dispatch the same canonical
`interaction/responseRequested` command as AgentGUI and Message Center instead
of deriving actionability or response identity from transcript messages.

Transcript messages are historical presentation only. A tool-call row with a
`waiting_input` status must not create an approval dialog, question composer,
exit-plan prompt, attention item, or pending-interaction view model. Session
snapshots also must not create or recover an Interaction. If canonical
`pendingInteractions` is empty, stale transcript rows have no actionability;
other independent presentation, including plan implementation confirmation,
continues under its existing priority rules.

Historical timeline projection must not expose selectors or row fields that
materialize transcript payloads as actionable approval or prompt objects.
Timeline-specific parsing may produce display-only card content, while request
identity, options, and response commands come only from canonical pending
Interaction projections.

Protocol-v2 host adapters must require `activeTurnId`,
`latestTurnInteractions`, and `pendingInteractions`. Missing fields are a
contract error at the desktop boundary, not an empty-list/default-value case.
The engine and GUI consume these fields without `?? []` compatibility reads.

The engine identity is explicit. A consumer resolves the injected engine for
its workspace and runtime origin; module-global runtime slots and hidden origin
registries are forbidden.
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
generic Agent artwork instead of provider-branded entries. Workbench Agent node
headers show the generic Agent title while the conversation rail is expanded;
standalone native Agent window headers omit that redundant app title. When the
conversation rail is collapsed, the title area shows the active conversation's
agent icon and directory name as soon as a local session id exists; it must not
wait for provider-side session creation or conversation-title persistence. An
empty new-conversation home does not show this header identity. The conversation
title remains the detail title while the rail is expanded and the identity used
by Dock previews; after submission, the expanded detail title area shows the
agent icon immediately even before conversation-title persistence.

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
list by its exact `agentTargetId`. If the active conversation belongs to that
target, it remains active. Otherwise the click enters that agent's empty home
composer; it must not implicitly activate another matching history item.
Empty-home rail clicks may also sync the home composer launch target.
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
Every renderer shell that exposes one of those launchers must register the
workspace-scoped AgentGUI launch coordinator locally. The OS workspace handler
launches a workbench node. The standalone Agent handler opens draft-prefill and
explicit new-window requests in another native Agent window, carrying the
target, provider, draft, auto-submit flag, and user-project path through the
typed window intent. The standalone route injects that immutable launch draft
as the AgentGUI body's first-render prefill bootstrap request; it must not depend
on a mount effect to copy and clear a synthetic workbench activation. An
existing-session request without a new-window flag activates that session in the
current standalone window. That activation clears the previous
`agentTargetId` when the request omits a target, so session-authoritative
navigation cannot inherit an unrelated managed-agent rail constraint.
Workspace App external bridges and App Center actions use the same coordinator
instead of maintaining a second Agent launch path. When the standalone shell
also embeds Issue Manager, it registers the workspace-scoped Issue Manager
launch coordinator locally and translates issue links into the standard
`open-workspace-issue` activation for its Tasks sidebar.
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
Daemon-managed extension targets use this same host-projected availability.
Their signed target name, icon URL, and open provider identity flow through the
host `agents` array; AgentGUI must not add extension keys, provider fallbacks,
or extension-specific artwork. A missing compatible local runtime projects as
`not-installed`, while historical sessions keep their recorded target and
remain outside the empty-home readiness gate.
When an empty composer has an `agentTargetId`, model, permission, reasoning,
and speed options are target-scoped. Do not fall back to provider-level options
for that target; a missing target-scoped option snapshot should remain a
loading/missing state until the target options arrive.
When a model catalog advertises model-specific reasoning profiles, the composer
must derive the reasoning options from the currently presented model and
re-resolve an unsupported prior effort to that model's advertised default.
Do not render the provider-level reasoning list when a profile exists for the
selected model.
Reasoning values are an extensible provider vocabulary. Known shared values may
use AgentGUI's canonical labels, while unrecognized values must preserve the
localized option label supplied by the composer-options contract instead of
rendering the raw protocol value or adding provider/model branches in the UI.
If restored node data has a stale `provider` that disagrees with a resolvable
`agentTargetId`, the target's provider wins for empty-composer settings and
launch preparation.
UI affordances that aggregate across providers, such as rail provider filters
and composer provider switching, are always part of the unified AgentGUI
surface and do not belong to durable AgentGUI node data.
Provider rail containers, tiles, and management dialogs are interactive
workbench chrome: they must explicitly release host/window drag regions with `nodrag` and
`-webkit-app-region: no-drag`, otherwise clicks near the window edge can be
captured as drag gestures before AgentGUI sees the provider filter action.
Agent rail ordering and visibility are also UI-local chrome state. Drag sorting
and the rail management dialog persist one device-local order and hidden-target
set in browser-local storage; they must not write those preferences into
controller state, session state, or durable AgentGUI node data. The management
dialog changes only presentation and never installs, removes, enables, or
disables a real agent target. The provider rail and empty-home new-conversation
carousel and agent selector consume the same ordered visible-target projection,
so manager changes update all new-conversation affordances immediately. If the
selected empty-home target becomes hidden, the home composer moves to the first
remaining visible target; active sessions keep their recorded target identity.
Targets with a canonical `working` or `waiting` conversation cannot be hidden;
the manager blocks the remove action and immediately shows a deduplicated,
localized explanation when the target enters the hidden drop zone, without
writing the local preference. Hiding the selected rail target otherwise returns
the rail filter to `All`. The manager
presents available and hidden targets as separate icon grids. A long press
enters a local edit mode for removal. Both grids are drop zones: same-grid drops
reorder, and cross-grid drops atomically change local visibility and order. The
pending drop position mirrors the provider rail by shifting the target tile
aside and showing the same brand-color insertion line; the previewed
before/after position is also the position committed on drop. At least one
target must remain available, so both the remove action and an
available-to-hidden drop enforce that invariant. These gestures still update
only the same local chrome preference. The manager keeps each target tile's
outer hit box layout-stable, shifts only its inner visual content, and renders a
separate insertion-line element. Cross-grid midpoint decisions use hysteresis
so a stationary pointer cannot make the target and insertion line oscillate.
Starting a drag must not exit edit mode: the manager pauses the edit wiggle only
while a drag is active, then resumes it after same-grid reorder or cross-grid
visibility changes. Blank-space clicks, Escape, and closing the dialog remain
the explicit edit-mode exit paths.
While edit mode is active, the first Escape leaves edit mode without dismissing
the manager; a second Escape closes the dialog. Both grids use the same compact
five-column icon layout.
Visibility controls stay hidden in the default state; entering edit mode shows
red remove controls for available targets and green restore controls for hidden
targets together. The aggregate `All` entry stays fixed above agents and cannot
be hidden or reordered.
Provider-scoped rail footer affordances, such as usage limits and environment
setup, follow the rail's active provider filter target in multi-provider scope;
when the rail filter is `All`, they should stay hidden because there is no
single provider target to inspect.
AgentGuiNode may also receive a neutral `renderSidebarFooter` slot for host or
product affordances that belong at the bottom of the far-left provider/sidebar
rail, below the system-settings control and not below the conversation-list
configuration footer. This slot must stay outside the provider tile scroll area
so the footer keeps a fixed bottom placeholder while overflowing provider tiles
scroll above it with a bottom fade. It must also stay outside the controller
view model and conversation rail valtio store: pass it as a direct function
prop and give it only existing neutral context such as `currentUserId` and
`activeConversation`. Product concepts such as sharing, ownership,
availability, quota, or authorization live entirely inside the React node
supplied by the host.
Standalone Agent windows keep right-side tools as UI-local panel tabs. The
window chrome exposes one right-panel toggle plus quick actions for apps and
messages while the panel is closed; those quick actions open the right panel
and mount/select the corresponding tab. Once open, the panel header owns the
active tab strip and its add menu for files, terminal, browser, apps, and
messages.
Opening a tool mounts it as a tab and selecting another tab only changes the
visible projection; this state is not durable AgentGUI session data.
The Files tool tab remains the file-navigation surface. Double-clicking a file
from a standalone Agent window delegates to the desktop host's system-default
file opener, matching Finder double-click behavior instead of mounting a second
preview implementation in the tool tabs. Directories continue to navigate
inside the Files tool. Its Open With submenu likewise omits Tutti's internal
file-viewer and in-app-browser actions while keeping system applications,
default-browser handling, and the system application picker. The regular
workspace window keeps its existing workbench file-preview contribution and
the full Open With menu.
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
If the standalone route already identifies a required provider or target, its
provider-scoped status request is the foreground request. It must not wait for
an unrelated all-provider scan, and a later targeted request may run alongside
an older catalog scan. Merge concurrent responses by provider and reject stale
per-provider results so an older full response cannot regress newer readiness.
The remaining provider catalog continues as background work after the required
provider resolves.
Progressive detection snapshots are partial by design. A provider missing from
the current snapshot means "not checked yet", not "install or login required".
Desktop AgentGUI hosts that project managed-agent readiness for an already-open
provider panel must wait until that provider appears in the status snapshot
before replacing the composer with setup UI or disabling active-session sends.
Auth-required local providers should remain selectable; product surfaces may
label the setup affordance as `Connect`, but the host action should still
dispatch the provider's `login` operation when that is the daemon-reported
action.

UI-local state may include draft text, selected panel, rail layout, open menus,
scroll position, and temporary presentation focus. UI-local state must not own
session lifecycle, turn lifecycle, queue delivery, or durable workflow status.

## Agent GUI Module Shape

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
The standalone Agent header reuses that button to duplicate its current native
window. It hands off the active session, agent target, provider, agents, and
provider-status snapshot, and explicitly keeps the source standalone window
visible. The duplicate reconstructs UI from the shared durable activity source;
it must not clone or fork AgentGUI session state in the renderer.
When the conversation rail collapses, the standalone Agent header remains a
full-width window control surface and keeps its secondary tool actions anchored
to the right window edge. Content-width caps belong to the conversation body,
not to the header control row.
Standalone Agent window state may keep a minimal UI-local workbench node
context, but durable conversations, session activation, login, provider
readiness, and file/project data must still flow through the shared desktop
AgentGUI host input and activity runtime.
Standalone-window tools are desktop host chrome, not AgentGUI state.
The desktop host owns tool identity, toolbar buttons and reminder badges,
Browser/Terminal grouping, panel placement, lazy mounting, and tool content
adapters. Browser, Files, Apps, and Message Center use the right sidebar; the
Terminal opens as a bottom tray below the conversation, matching the Codex
layout and preserving enough height for a usable shell. File panels start wide
enough for their embedded location, list, and detail columns. Browser and Apps
share the same roomy default width so switching between them does not move the
panel boundary. Message Center aligns its default host width with its standard
embedded content width so it neither clips card content nor leaves unused
right-side space. Browser and Terminal share one dropdown trigger in the header:
the entire tool control opens the menu, and choosing an item opens that tool.
Do not split the control into a primary action and a separate menu-arrow action.
The standalone
right-sidebar tools form one exclusive selection: opening any one of Browser,
Files, Apps, or Message Center hides the previously active right-sidebar tool,
including any embedded Electron webview. Terminal visibility is orthogonal to
that selection and may coexist with any right-sidebar tool because its tray is
in the separate bottom region. The standalone
Agent renderer route uses `view=agent`, so the desktop preload must expose the
same browser and workspace-app APIs for both `view=workspace` and `view=agent`;
gating those APIs to only the workspace route leaves direct BrowserNode and app
webview panels with no host bridge. The standalone
host owns its outer resize handle and minimum Agent content width, while the
reusable file manager owns its two internal draggable column boundaries; all
resize state remains local to the visible window. It composes that chrome around the existing
`AgentGuiWorkbenchHeader` and `DesktopAgentGUIWorkbenchBody`; it must not add
tool commands, visibility state, or product-specific panel contracts to
AgentGUI runtime, controller, node state, or composer state. Panel state may be
kept mounted while hidden so switching tools does not discard local UI state,
but durable data continues to come from the existing desktop services.
Opening a right-sidebar tool captures the current Agent content width, then
uses the typed host-window width capability to append the panel beside that
content. Main grows the native content bounds toward the right edge of the
active display and shifts the window left only when the right-side work area is
insufficient. The renderer assigns native width added beyond the captured
baseline to the sidebar, so dragging the native right window edge grows the
whole app and the sidebar without reflowing the message flow. The sidebar's
full resolved width must always participate in the flex layout. When the
display cannot provide the preferred native growth, the Agent content narrows
and the sidebar remains adjacent; it must not become an absolutely positioned
overlay above the transcript. Width added from the panel's left separator is
also reserved by layout and does not change the native window bounds. Closing
the panel restores the captured baseline width.
Opening must be renderer-first: update the active panel immediately, let the
clipped width transition begin, and defer the host-window resize request until
the next animation frame. Do not await native IPC before showing the panel.
Files, Browser, Apps, and other expensive first-use bodies mount after the
outer width transition, then remain mounted while hidden for instant later
switches. macOS may use Electron's native bounds animation in parallel; other
platforms apply the same resolved bounds without requesting unsupported native
animation. Respect `prefers-reduced-motion` by removing the CSS transition and
the content-mount delay.
Lazy mounting also applies to module loading. The standalone shell may derive a
small reminder count from the activity engine, but it must not statically import
BrowserNode, TerminalNode, File Manager, App Center, or the full Message Center
presentation graph. Import each tool body when that tool first opens. Workspace
App polling and runtime preparation begin when Apps first opens or an explicit
app launch targets the window, not when the standalone Agent window mounts.
Header tool actions must use the workbench header's secondary accessory slot so
the session title and controls share one layout row. Do not absolutely position
those actions over the title; narrow windows must truncate the title before any
control can overlap it.
Right-sidebar panel chrome starts below the standalone workbench header. Keep
the panel title, expand action, and close action out of the global header row so
they cannot collide with Files, Tools, Apps, or Message Center launch buttons.
The outer right-sidebar container owns the shared panel stacking level for its
separator and panel-local popovers, while the panel body remains a normal
sibling of the message flow rather than relying on stacking to cover it.
The Files panel uses the same roomy adjacent default width as Browser and Apps,
then keeps its wider resize range for the embedded location, list, and detail
columns. On the minimum native window width, preserving the standalone
header's combined provider/conversation rail boundary takes precedence over the
Files panel's nominal minimum width so host-owned rail controls are never
covered by tool-panel chrome. The panel may narrow below its nominal minimum
on a constrained display, but it remains in the same side-by-side layout.
Every right-side panel exposes a title-bar expand control that temporarily uses
the full width available beside the minimum Agent rail boundary without
changing the native window size. While expanded, the control switches to the
restore glyph and its next activation restores the panel's previous width.
Application updates remain desktop-global `AppUpdateService` state. In the
standalone Agent header, present that state as a compact non-drag control: an
available update downloads, downloading shows progress, and a downloaded update
offers restart-and-install. Do not keep an update-check failure permanently in
the focused Agent header.
Desktop renderer startup is route-split. OS workspace chrome and the standalone
Agent window are separate dynamic entries; neither route may statically import
the other route's body through a feature barrel. Workbench Agent contribution
registration keeps only its lightweight node and dock descriptor on the OS
cold path. The full `DesktopAgentGUIWorkbenchBody`, rich-text editor, mention
search controller, and AgentGUI presentation graph remain outside the common
desktop shell entry. Both the OS workspace route and standalone Agent route
statically own the body inside their already-lazy route chunks. This avoids a
second body-level import waterfall after either route begins rendering while
keeping non-workspace desktop routes outside the AgentGUI graph.
Every blocking boundary before the real AgentGUI controller mounts uses that
same startup-shell geometry: the route-level Suspense fallback, workspace
catalog hydration, and workbench host-session binding.
The reusable body geometry is owned by the narrow
`@tutti-os/agent-gui/startup-shell` entry. The primitive is runtime-source
agnostic: local/shared ownership, directory loading, and launch routing remain
host concerns. Desktop owns the optional standalone-window chrome around that
body; another host may compose the same primitive at its own loading boundary
without adding host identity to the AgentGUI presentation package.
The full-window variant keeps the header, provider rail, conversation-rail
skeleton, and empty-home hero composer visible; after the real header mounts,
the body-only variant preserves that new-conversation geometry without
duplicating chrome. The hero placeholder mirrors the real composer's input
shell, control footer, project row, and prompt-tips row so its height does not
jump when AgentGUI takes over. It also preserves the real centered-timeline
wrapper, the multi-agent carousel slot used before target resolution, and the
home-suggestion wrapping geometry; approximating only the inner card causes the
whole hero group to shift when AgentGUI takes over. Startup must not imply that
a conversation is already active by showing the bottom-docked history composer
or a message timeline.
The startup hero composer is visibly present but non-interactive until the real
controller owns draft and send state. Do not introduce a second temporary draft
owner just to make the fallback editable. Optional right-side
tool bodies show a local busy state during their intentional mount delay,
dynamic import, and runtime/session startup instead of exposing an empty panel.
Standalone-only settings, environment, import, and account surfaces are also
non-critical to the conversation first frame. Load their presentation modules
behind local Suspense boundaries; panel-host listeners may mount immediately
after the shell's first animation frame so they remain available before a user
can invoke them without extending the initial black-screen interval.
While that body is still suspended, keep the standalone header's
conversation-rail and right-panel toggles hidden; reveal them only after the
body commits so loading chrome cannot target unavailable content.
Startup optimizations such as mention browse warming must begin from the
mounted AgentGUI lifecycle, never from workspace contribution registration.
Local AgentGUI startup before the body module evaluates is module loading, not
workspace or session hydration. Reserve hydration terminology for injecting or
reconciling runtime state after the relevant controller exists.
File activation in the standalone Agent window must use the host-owned right
Files sidebar. Conversation links and workspace-reference preview requests open
that panel and pass a reveal intent so the reusable file manager selects and
previews the requested path. The standalone route registers this panel command
as its Canvas preview launcher; it must not create a workspace floating preview
above the conversation or send the primary open action directly to the
operating system. Do not show the workspace preview-unsupported notification
for this handled route.
The standalone Message Center must reuse
`WorkspaceAgentMessageCenterPanel` and build its model from that window's
`WorkspaceAgentActivityService` snapshot. Opening it may load bounded session
summaries for its cards; submitting a prompt must use the existing
`submitPlanDecision` service path, and opening a card must activate that
session in the current standalone Agent window rather than creating another
native window. It must use the panel's embedded presentation so the host-owned
title, expand, and close chrome remains visible; the default fixed drawer
presentation remains reserved for workspace overlays.
Its header trigger must reuse the OS Message Center status-pet asset while
`model.counts.working` is positive and show that working count in the top-right
badge; zero working sessions restore the static Message icon and omit the badge.
The workspace-owned activity service starts one canonical reconcile when its
engine is created, before Message Center opens, so a separately created Agent
window immediately reconciles already-running sessions. Panels and sidebars do
not start a second initial load; concurrent explicit loads share one in-flight
result. Outcome notification subscriptions must also start that workspace's
activity event stream. They remain in baseline mode until the first
authoritative workspace reconcile reaches `ready`, seed all historical settled
turn ids without notifying, and only then emit notifications for settled turns
backed by a live `turn_update`. A session-level reconcile can hydrate historical
settled turns after that bounded baseline; first appearance in the engine is not
notification causality. When an event arrives before the session is cached and
requires HTTP reconciliation, preserve the original `state_patch` for
session-event consumers; rebuilding it from session state can discard
`turn.outcome` or `turnId` and suppress the completed/failed foreground toast.
Browser and Terminal tool bodies must mount the existing OS node UI directly:
`BrowserNode` in the right panel and `TerminalNode` in the bottom tray. Do not
nest another `WorkbenchHost` inside the standalone shell; the nested canvas can
collapse during panel animation and report a near-zero terminal viewport even
while its PTY is healthy. The desktop terminal contribution exposes the same
feature and adapter runtime used by the OS workbench, so direct mounting still
retains the normal PTY, output hydration, link handling, close guard, and
termination paths. Agent mode must not create another browser lifecycle,
terminal implementation, or PTY adapter. A lightweight synthetic host record
exposes the directly mounted terminal session to native-window close-effect and
cleanup coordination without owning layout or snapshots. Both surfaces remain
mounted after first use so hiding and reopening a tool preserves its UI-local
session state. The standalone Browser must render `BrowserNode`'s shared header
so back, forward, reload, address entry, external-open, and overflow actions use
the same controller and runtime state as the webview. The Terminal tray's close
control only collapses the tray; it
must not terminate or unmount the active terminal session.
Electron main may create one of two native workspace shells. `OS` mode keeps
the existing workspace window and its `ReadyWorkspaceWorkbench`
desktop/window/dock surface, while `Agent` mode creates the frameless Agent
window and loads the explicit `view=agent` route. This is a main-process window
creation decision only: the preference must not enter AgentGUI state, and an
existing native window must not be made to impersonate the other window kind
by swapping renderer content. Desktop persists the selection through the
generic preference flag `workspace.standaloneAgentMode`; absence of that flag
means OS mode, while explicit `true` and `false` values retain the user's Agent
or OS selection respectively.
Settings destinations remain host-local presentation behavior. The standalone
Agent settings control opens the global panel on General, the Agent settings
control embedded in OS mode opens the Agent section, and the OS workspace's
top-right global settings control opens General.
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
The selected summary and ordinary rail summaries must use the same
cwd/user-project projection. When both are available, the rail resolves the
selected id from its projected entity list before falling back to the
controller's active summary, then merges that one entity into the displayed
sections by id. This keeps provider-filter changes from moving the selected row
into an unrelated unscoped section.
Once a user selection becomes the active intent, rail pagination or bounded-list
absence must not demote it into requested/resolving fallback. Only an explicit
replacement, home transition, deletion, or authoritative not-found result may
clear that selection.
Restoring `lastActiveAgentSessionId` after a renderer or client restart follows
the same rule: activate that persisted intent, request the engine-owned session
state-and-messages reconcile, and keep its transient rail row outside canonical
pagination until the session arrives or reconcile proves it unavailable.
Selecting any rail row whose detail is not cached must enter the engine-owned
session reconcile lifecycle and request state plus messages as one semantic
load. Detail availability is explicit: `loading`, `ready`, `not_found`, or
`error`. The skeleton follows the reconcile record, `ready` with zero rows is a
valid empty detail, and only an authoritative tombstone/not-found result may
show the unavailable state. Once authoritative not-found wins, presentation
must suppress any previously projected transcript rows instead of mixing stale
content with unavailable-state layout. An empty message projection is not
evidence that loading finished or that the session is gone.

Agent GUI is organized by vertical behavior rather than one controller with
horizontal helper piles. A vertical module owns its projection, commands,
UI-local state, and focused tests. Typical modules include:

- conversation navigation and session selection
- composer and prompt queue
- transcript and turn presentation
- approval and interactive prompt handling
- provider target selection and readiness presentation
- goal presentation and control
- files, mentions, and turn summaries

The node shell composes modules. It does not orchestrate their workflows.
Controller code may bind selectors and commands, but it must not become a
second state machine or a registry of panel-specific effects. When a controller
grows across multiple behaviors, extract a complete vertical module instead of
moving lines into generic `helpers`, `shared`, or `utils` files.

Business-code files stay at or below the repository line limit. After a
refactor, remove superseded stores, adapters, effects, and compatibility paths;
do not leave two active ownership models.

## Public Node Contract

`AgentGUINodeProps` exposes semantic responsibility objects only:

| Object             | Responsibility                                                    |
| ------------------ | ----------------------------------------------------------------- |
| `identity`         | node, workspace, user, and title identity                         |
| `workspace`        | workspace path, references, project selection, and agent settings |
| `frame`            | position, size, activation, embedding, and preview layout         |
| `state`            | persisted Agent GUI node data                                     |
| `runtimeRequests`  | focus, launch, prefill, and provider probe requests               |
| `hostCapabilities` | host-projected catalogs, readiness, menus, and icons              |
| `hostActions`      | host mutations and workbench/window actions                       |
| `renderSlots`      | narrow host presentation slots                                    |

These groups are required even when a group has no optional values. Do not add
flat compatibility props. Add a field to the object that owns its meaning, or
create a new responsibility object only when it represents a genuinely separate
boundary.

Render slots receive narrow neutral context. Product authorization, transport,
or workflow behavior must not be hidden inside a render slot.

## Provider Architecture

The daemon `providerregistry` is the source of truth for provider identity and
behavior descriptors. A descriptor declares typed strategies and capabilities
for runtime, status/auth, composer behavior, events, sidecars, external import,
desktop integration, and CLI integration.

Cross-provider consumers follow this shape:

```text
provider ID
  -> providerregistry descriptor
  -> typed strategy/capability selector
  -> provider-neutral consumer behavior
```

Consumers must not branch on Codex, Claude Code, Cursor, Hermes, Nexight,
OpenClaw, OpenCode, or Tutti Agent identity to select behavior. Provider-owned
wire adapters may translate their own protocol, but shared policy belongs in a
typed descriptor or selector. Unknown providers produce an explicit unsupported
result; they do not silently inherit another provider's behavior.
Reasoning-option ownership, configured-model override behavior, and native
skill config-directory suffixes are descriptor strategies as well. Composer
and model-catalog services dispatch on those typed strategies; they must not
recover the same policy from provider-name comparisons or path literals.

Generated GUI identity data is presentation metadata only. A provider target
is host-supplied launch authority with a real provider identity and opaque target
reference. Agent GUI displays and selects targets but does not invent runnable
targets when the host catalog is absent.

Standard ACP adapters normalize provider wire events before persistence. A tool
call keeps one stable canonical identity, such as `Bash`, `Edit`, `Read`, or
`TodoWrite`, from start through terminal updates even when the provider changes
its human-readable title to a command, path, or result summary. Provider
envelopes such as `rawInput`, `rawOutput`, and output metadata are projected into
the canonical tool payload consumed by shared renderers. Agent GUI may normalize
historical persisted envelopes for display compatibility, but it must not add
provider-specific rendering branches.

Conversation file links use the selected project root when one exists. For a
no-project session, the durable session cwd is the file-resolution root. This
keeps link navigation attached to session identity instead of requiring project
selection state. Every transcript file surface, including markdown links and
turn-summary projection/actions, must pass the selected project root as
`workspaceRoot` and the durable session cwd as `basePath`; do not substitute a
synthetic `/` root or drop the cwd when no project root is selected.

## Desktop Host Boundary

`apps/desktop` owns Electron/workbench integration and concrete host
capabilities:

- workspace window and node lifecycle
- provider status and login actions
- file/reference adapters and project selection
- desktop preferences, notifications, and app icons
- construction and injection of the workspace activity runtime

Desktop passes grouped Agent GUI props and runtime interfaces. It must not
mirror engine entities, implement provider policy switches, or derive session
truth to make a panel render correctly.

Opening a conversation activates a durable session through the engine. Opening
it in another panel creates workbench presentation state around the same durable
session; it does not clone the session. Provider handoff starts a new session
with an explicit target and prompt reference rather than mutating the running
session's provider.

## No Panel Orchestration

Panels and components are presentation boundaries. They may:

- render selector output
- hold ephemeral interaction state
- dispatch typed actions
- report narrow layout or focus events

They may not:

- subscribe directly to daemon event streams
- own timers that advance durable workflows
- coordinate create/activate/send/cancel sequences
- reconcile optimistic and authoritative entity state
- inspect provider identity to select business behavior
- read another panel's internal store to decide workflow state

Multi-step behavior belongs in daemon workflows or engine commands. If a panel
needs several durable mutations, expose one semantic command rather than
sequencing transport calls in React effects.

## Submit And Startup Transactions

`clientSubmitId` is the daemon-owned idempotency key, not merely a diagnostic
field. Before invoking a provider, the daemon persists a submit claim scoped by
workspace, session, and client submit ID. A duplicate accepted claim returns
the existing turn; a prepared claim reports delivery as unknown/confirming and
must never invoke the provider again.

Creating a session with initial content is one transaction. Provider startup
may create provisional runtime state, but the Session is not published or
persisted until the first Turn is accepted. Validation or execution failure
rolls the provisional runtime and its pending command/config snapshots back;
it must not leave a turnless Session or a synthetic message without a Turn.

The session engine owns activation deadlines. It passes one cancellation signal
through the desktop command port and HTTP adapter. Adapters must not race the
engine with an independent timeout budget; command timeout, cancellation, and
uncertain-delivery reconciliation are one engine workflow.

## Validation

Use focused tests while iterating, then the repository checks for the changed
surface. Command flow returns through the same runtime interface:

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
The same adapter path must also publish that synthetic turn's
completed/failed/canceled terminal through the session event sink. Synthetic
turns are not submitted through `Exec()`/`ExecAsync()`, so they have no turn
waiter; dropping waiter-less terminals as "untracked orphans" leaves durable
`activeTurn` stuck in `running` and AgentGUI keeps showing the processing row
after the assistant content has already finished.

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

### External History Import

```text
desktop ZIP picker or local-history source selection
  -> ExternalAgentSessionImportWizard
  -> WorkspaceAgentActivityService scanExternalSessionImports
  -> tuttid external-import scan endpoint
  -> local JSONL scanner or Claude data-export ZIP parser
  -> selectable import session summaries
  -> WorkspaceAgentActivityService importExternalSessions
  -> tuttid external-import import endpoint
  -> ActivityProjection persisted sessions/messages
  -> desktop activity load + user-project refresh
  -> AgentActivityRuntime snapshot
  -> AgentGUI rail and transcript
```

The daemon owns archive validation and conversation parsing. Desktop passes the
absolute path selected through the native picker, and both scan and import must
carry the same `archivePath`; import reopens and revalidates the archive rather
than trusting scan-time state. The wizard must bind a completed scan to its
normalized local/archive source identity and invalidate it before a source
change or failed rescan, so sessions from one scan cannot be submitted with a
different archive path. Claude exports are read directly from the exact root
`conversations.json` ZIP entry. Preflight the ZIP central directory and bound
conversation JSON depth, container counts, token counts, and retained messages
before expanding untrusted data. Do not extract the archive, execute tool
payloads, fetch citation URLs, or treat referenced files as locally available.

Claude export `message.text` is not a safe visible-body source: rich messages
can include hidden thinking and tool material there. Import ordered
`content[type=text]` blocks into visible transcript text; only legacy user
messages with no structured content may fall back to `message.text`, and
assistant messages never may. Ignore control blocks,
and retain file-only messages as unavailable references without claiming that
the ZIP contains their payloads. Stable source message UUIDs make repeat imports
idempotent even when a later export inserts earlier messages. Claude exports may
contain mutually exclusive edit/retry branches. Build the parent-message graph
and import the deterministic latest leaf's root-to-leaf path; never flatten
sibling branches into one transcript. Namespace the imported session with a
fingerprint of the selected sibling choices: ordinary appends stay in the same
session, while a later export that selects a different retry branch lands in a
separate session instead of accumulating incompatible messages. Preserve the
branch fingerprint and chosen leaf UUID in message payloads so that branch
selection remains auditable.

claude.ai exports do not carry a coding-project cwd or a Claude Code runtime
session id. Persist them in the no-project Chats section with
`runtimeContext.imported`, `externalImportNoProject`, and a false
`externalImportResumeSupported` marker. They may use the Claude Code target for
presentation, but AgentGUI must keep the imported history read-only and route
continued work through the existing "continue in a new conversation" flow.

### Conversation List Loading

```text
AgentGUI / AgentGuiNode mount
  -> useAgentActivitySnapshot(workspaceId)
  -> AgentActivityRuntime.load(workspaceId)
  -> WorkspaceAgentActivityService.load
  -> AgentSessionEngine workspace/reconcileRequested
  -> desktopAgentActivityAdapter.listSessions
  -> tuttid ListWorkspaceAgentSessions
  -> agent.Service.ListPage
  -> live RuntimeController sessions + persisted ActivityProjection sessions
  -> AgentSessionEngine session/snapshotReceived (historical)
  -> memoized AgentActivitySnapshot projection
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
Show more heuristics. Page responses upsert their session entities into the
workspace engine; the rail query cache stores only ordered session ids,
section metadata, cursors, and totals. A pure projection joins those ids back
to engine entities. Do not keep a second summary cache or manually patch
section rows from conversation summaries. Removing a project removes that rail
section from the section list; re-adding the same path reveals historical
sessions with the same section key.
Rail search is a separate UI-local query over
`GET /v1/workspaces/{workspaceID}/agent-sessions`. Its `searchQuery` and active
`agentTargetId` are applied by the daemon before cursor pagination, so results
cover every visible session in the workspace rather than only the loaded rail
sections. Each returned session is upserted into the same workspace engine;
the search controller stores only result ids, cursor, and request state, then
the rail joins those ids to canonical entities. It must not recreate the old
conversation-summary cache. Search grouping renders only sections containing
matching rows; empty user-project and Chats sections remain hidden. Hosts without `listSessionsPage`, including
preview-only hosts, may fall back to local title filtering of loaded rows.
Ordinary section pages and backend search pages share one deterministic order:
`latestTurn.startedAtUnixMs DESC`, falling back to
`session.createdAtUnixMs DESC`, then `session.id ASC`. Their cursors encode
that resolved conversation sort time plus session id. Renderer canonical
projection and active-row overlays must consume the same resolved sort key;
`session.updatedAtUnixMs` and `latestTurn.updatedAtUnixMs` are entity freshness,
not conversation-list order.
Every section page and pinned page also carries `totalCount` for the full
target-filtered scope before cursor pagination. Ordinary section pages exclude
pinned sessions because those rows belong only to the dedicated pinned page;
filtering pinned rows after section pagination corrupts page size and totals.
The active conversation is a
display overlay, not a pageable row: it may render beside the first five rows,
but it must not consume the local visible-item limit or advance the cursor.
Pending-activation rows follow the same rule and stay excluded from pageable
item counts until runtime reconciliation makes them canonical sessions.
Show more compares distinct rendered ids, including that overlay, with
`totalCount` before using `hasMore`/`nextCursor`. This prevents both false
controls when five page rows plus the active overlay already cover all six
sessions and no-op first clicks when the next local slot is the already-visible
active session.
Section-level actions must use the same backend section contract when their
scope is "everything in this section." For example, project batch delete cannot
derive its target set solely from the currently rendered `section.items`, because
those rows may only be the first page. Batch deletion uses a two-step snapshot
flow: AgentGUI requests deletion candidate IDs by `sectionKey`, optional exact
`agentTargetId`, and `excludePinned=true`; the confirmation count is the
returned `sessionIds.length`; confirmation then sends that immutable ID list to
the exact batch-delete endpoint. The delete command must not re-resolve section,
target, or pinned membership. Sessions added after candidate selection are not
deleted, while a selected session that is pinned or moved before confirmation
is still deleted under the chosen snapshot semantics.
Pinned conversations are returned beside those sections as a separate pinned
page on the `listSessionSections` bootstrap response. AgentGUI may render that
page as a local `pinned` group, but pinned is not a daemon section kind and
must continue to be derived from session `pinnedAtUnixMs`. Pinned Show more
uses the dedicated pinned page runtime method instead of the section page
endpoint, because pinned has no daemon `sectionKey`. Ordinary project and Chats
section pages must exclude pinned sessions before pagination and `hasMore`
calculation, so the pinned page and ordinary section pages are mutually
exclusive. Section action disabled state therefore uses only the ordinary
section's `items` and `hasMore`; pinned rows never make an otherwise empty
ordinary section deletable.
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
Section pages may contain historical sessions outside a bounded workspace list
response. Their entities still enter the engine's normalized session store;
later bounded snapshots merge monotonically and explicit removal events own
deletion, so omission cannot evict a page-loaded or selected entity. Detail
reconciliation of one of those entities is not new rail membership and must
preserve every loaded section page and cursor. Entity-list order or count must
not serve directly as a section-query invalidation key; rail invalidation must
account for membership already owned by loaded section pages.
First-page section refetches are reserved for workspace, rail filter, user
project, or session membership changes; Show more continues to use the section
page endpoint.
Pending activation becoming canonical is one of those session membership
changes, even while that session remains active. The rail query controller must
retain the session id as reconciliation metadata, refetch section first pages,
and let the pure display projection join and sort the canonical engine entity
until a successful daemon response replaces the membership cache. Active
selection alone must never suppress this invalidation; historical active-detail
hydration without pending-activation provenance remains an entity update and
must preserve loaded pages and cursors.
During rail-filter refetches, keep the previously rendered section chrome in
place for short reloads. Provider/agent switching should not briefly unmount
the project rail header or replace a populated rail with an empty/skeleton
rail; if the new first page takes longer than the rail skeleton delay, show the
skeleton so the user sees loading feedback. Only workspace changes may clear
the section cache immediately. Local Show more/Show less expansion belongs to
the workspace-plus-filter query scope, not the backend section id alone. Reset
its visible-item limit in the filter-change render so stale section chrome
cannot flash pagination controls from the previous provider scope. Keep the
previous section page metadata paired with that stale chrome until the new
first page resolves; clearing `hasMore` independently makes the pagination row
disappear and reappear. Disable paging actions while the replacement request is
pending so a stale cursor cannot enter the new provider scope.
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
  -> desktopAgentActivityAdapter.listSessionMessages
  -> tuttid ListWorkspaceAgentSessionMessages
  -> ActivityProjection.ListSessionMessages
  -> AgentSessionEngine message/snapshotReceived
  -> memoized AgentActivitySnapshot projection
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
  -> AgentSessionEngine intents and canonical state update
  -> projection + UI refresh
```

For normal first-message creation, the controller creates an optimistic
conversation id and enters that conversation surface immediately while
activation is pending. The optimistic session is not durable yet, so any
ordinary follow-up submit targeting `startingConversationIdRef.current` must
enter the workspace engine's prompt queue instead of calling `sendInput`
directly.
Pending new-session activation is request- and session-scoped, not a
workspace-wide creation lock. A workspace may have multiple pending new
activations, and the conversation rail projects every optimistic session.
The engine's `pendingIntents` is the only owner. The conversation-list selector
projects each missing session once and marks its row as a pending-activation
projection. Runtime section pagination caches canonical session ids only; a pure
rail display projection overlays the complete pending set into matching
project/conversations sections and sorts it by conversation time. Pending rows
must never be written into section pages, cursors, or membership invalidation,
and the rail must not rely on the currently active row as its only optimistic
overlay.
The pending row itself does not invalidate membership. Its transition to a
canonical engine session does, and the query controller may keep only that
session id—not a duplicate summary—as temporary reconciliation metadata.
Starting another draft, switching provider targets, or returning to the home
composer must not unactivate an earlier pending new session. The submit action
selects its own optimistic session explicitly; later activation confirmation,
failure, or list reconciliation must never select another session or steal
focus from the user's current draft/conversation.
Submitting the first prompt transfers its normalized content into the pending
activation record. The submit/composer module—not activation or selection—owns
clearing the matching target-level home draft, so a later New action starts
empty. The same module reconstructs the home draft after activation failure,
only when the user has not already typed a replacement home draft.
The pending prompt envelope preserves normalized `content` plus the optional
`displayPrompt` used for presentation. Materialized `runtimeContent` exists only
on the requested intent and transport command; it must not replace presentation
content in the pending record. Activation and existing-session submit share this
contract. Their optimistic user messages use the authoritative payload shape:
`content`, optional `displayPrompt`, and `text` resolved from `displayPrompt`
before content-derived text.
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

When an existing conversation is busy, normal composer submits enter the
workspace engine's prompt queue so the next turn can run after the current one
settles. `Cmd+Enter` on macOS, `Ctrl+Enter` on other platforms, and “send now”
on an existing queued prompt all express the same higher-level intent: deliver
this prompt before waiting for the current turn to finish normally. The engine
resolves that intent from the canonical session capabilities, never from the
provider name:

- `activeTurnGuidance = true`: send the queued prompt with `guidance = true`.
  Codex app-server maps this to `turn/steer`; Claude SDK maps it to the sidecar
  `guide` request. The current turn remains active. The accepted submit claim,
  returned turn identity, and durable user-message event all reference that
  exact active turn; native guidance must not allocate a second synthetic turn.
  The authoritative message keeps the guidance submit's `clientSubmitId` so the
  engine can reconcile and remove its optimistic prompt without losing the
  visible user message after the turn settles or the transcript reloads. A
  guidance message is a mid-turn transcript event, not another opening prompt:
  the conversation projection must interleave it with assistant, thinking, and
  tool rows by authoritative sequence (falling back to occurrence time) while
  keeping the same canonical `turnId`.
- otherwise, `interrupt = true`: keep the prompt in the frontend queue, cancel
  the exact active turn, and send the prompt as a normal prompt only after a
  validated cancel result or an authoritative settled-turn update.

The submit-and-send-now transition is atomic inside `AgentSessionEngine`. The
controller must not first send a normal prompt and then try to promote it, and
the daemon must not own a second prompt queue. `Shift+Enter` remains the
multiline composer shortcut and must not submit either a normal prompt or a
send-now intent.
Active composer state must prefer a live `AgentActivityRuntime` turn lifecycle
over the selected session view/control state. `getState` and legacy state patch
paths can temporarily report a settled or available control state while the
runtime snapshot still has `turnLifecycle.activeTurnId` with a live phase. In
that split state, AgentGuiNode must keep the transcript/loading projection busy,
set normal `canSubmit` false, and let ordinary composer sends enter the local
queue. Only an explicit send-now action may select native guidance or
exact-turn cancel-then-send. Legacy `idle` turn patches clear `activeTurnId`;
they must not leave a stale active-turn block behind.

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
  -> inline message intent or authoritative session reconcile
  -> AgentSessionEngine listener notification
  -> memoized AgentActivitySnapshot projection
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
Image validation is intentionally two-phase. The preflight that runs before
attachment persistence may accept a managed `path` as an ingress source so it
can check provider image capability without writing files. That does not make
the path valid provider content. After the daemon copies and hydrates the
source, `Controller.Exec` applies the strict runtime validator to the resulting
`data`, `url`, or `attachmentId` representation. Keep runtime execution strict,
and do not move attachment persistence ahead of capability preflight merely to
make path-backed drafts pass validation; unsupported providers must still fail
without creating session attachment files.
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
  -> message_update parses and batches append-only messages inline
  -> turn_update / interaction_update triggers authoritative session reconcile
  -> legacy state_patch triggers authoritative state reconcile
  -> live reconcile dispatches session/upserted then turn/upserted
  -> historical pull dispatches session/snapshotReceived
  -> engine projection updates the runtime snapshot
  -> conversation list projection updates rail
  -> session view store updates transcript loading/live state
  -> shared transcript projection updates rows/cards
  -> AgentGUINodeView renders the new view model
```

Only append-only `message_update` payloads use the inline fast path. Turn,
interaction, and state changes reconcile through the authoritative session
endpoint so `activeTurnId`, pending interactions, and turn provenance stay
consistent. UI code should debug both the event payload and the reconcile fetch
before treating a missing transcript row as a rendering-only bug.

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
  -> AgentSessionEngine merge/dedupe by message identity/version
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

| Layer                                    | Owns                                                                                                                | Must not own                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `tuttid` agent service                   | provider runtime start, exec, resume/cancel, validation, persistence reports                                        | AgentGUI view state                                                       |
| `ActivityProjection`                     | persisted session/message projection and `agent.activity.updated` publication                                       | React projection or local UI overlays                                     |
| desktop `WorkspaceAgentActivityService`  | activity facade, canonical engine/controller access, mutation/reconcile coordination                                | transcript rendering semantics or large query/import adapters             |
| desktop activity query/import operations | normalized daemon query projection and external-session import refresh workflow                                     | engine/controller ownership or independent activity state                 |
| `AgentActivityRuntime`                   | AgentGUI-facing source of durable activity data and commands                                                        | independent session/message storage                                       |
| workspace `AgentSessionEngine`           | canonical frontend session/turn/interaction entities, pending intents, ephemeral prompt queues, correlated commands | daemon persistence or provider transport implementation                   |
| AgentGuiNode controller/stores           | selection, drafts, loading/error state, pending overlays                                                            | authoritative session/message state, queued prompts, or provider strategy |
| shared projection/model helpers          | deterministic conversion from snapshots/messages to view models                                                     | provider transport calls                                                  |
| React views                              | DOM interaction and rendering from `viewModel`/`actions`                                                            | fetching or mutating durable activity directly                            |

The standalone Agent window follows the same composition rule: the sidebar
shell owns panel selection, width, and mount timing; file/app/message routing,
BrowserNode lifecycle, and TerminalNode lifecycle live in focused panel
components. Extracting those panels must not move Message Center session state
or terminal/browser runtime state into the shell.

## User-Visible Interaction Contracts

Use this section when the bug report is phrased as a visual symptom: "why is
this selected", "why is this loading", "why did the row move", "why is the send
button disabled", or "why is an approval still visible". Every visible AgentGUI
state should map to one owner and one clearing condition.

### Rail And Conversation List

```text
runtime snapshot sessions
  -> conversation list query/search/project filters
  + engine pending-intent projections
  + daemon section membership ids/cursors/totals
  -> pure rail display overlays
  -> activeConversationId highlight
  -> row status, title, project, timestamp, badges
```

User-visible rules:

- The rail row list is projected from canonical engine sessions plus
  daemon-owned section membership ids and engine-owned pending intents. The
  controller query owns requests and ID-only pagination state; the pane owns
  only search, collapse, and visible-item UI state. Pending rows are
  presentation values, not a second list store or pagination-cache membership.
  Do not fetch or mutate durable session state from a row component.
- The selected row is controlled by `activeConversationId`, not by latest
  runtime update time.
- Search and project grouping are list-query concerns. Desktop search is a
  backend, target-scoped, cursor-paged query across all visible sessions; its
  results are engine entities joined through ID-only query state. These queries
  may hide a session from the rail, but must not delete or unactivate it.
- Conversation search matches only the user-visible session title. Session ids,
  providers, and working directories are routing or runtime metadata and must
  not produce title-search results.
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
  -> canonical session.title from the daemon
  -> rail row / detail header / workbench header / dock popup / toast title
```

User-visible rules:

- `session.title` is a shared, user-visible canonical plain-text field. The
  daemon converts rich title input once before session state is persisted, and
  the SQLite store backfills existing rows during migration without changing
  session creation/update timestamps. CLI, Agent, and desktop surfaces consume
  this same field and must not independently parse title Markdown or add
  mention prefixes.
- AgentGUI projection may still handle UI-local concerns such as provider-only
  placeholders and localized fallback labels, but it must not be the source of
  title syntax normalization.
- Live runtime snapshot data is the source for workbench and dock titles. Do
  not persist or restore `lastActiveConversationTitle` from workbench node
  state.
- User rename flows must mutate the persisted runtime session title through
  `AgentActivityRuntime.renameSession` and then upsert the returned
  authoritative session into the runtime snapshot. Do not update only the rail
  list, otherwise the rail row, active detail header, workbench title, and dock
  surfaces can diverge.
- Title projection strips provider-only and untitled placeholders from workbench
  chrome. First-user-message fallback is compatibility behavior for snapshots
  that predate the canonical title write boundary; new session writes should
  establish the title before persistence.

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

- Transcript message bodies and copy payloads retain their rich-text
  serialization. Compact presentation derived from those messages, including
  the user-message locator, activity summaries, and tooltips, converts rich
  links to human-readable labels in the frontend projection without mutating
  the source message. This display formatter is separate from session-title
  canonicalization: new and migrated `session.title` values remain daemon-owned
  plain text and must not depend on renderer parsing.
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

An unsent composer message is one UI-local `AgentComposerDraftContent` block
array with exactly one leading text block. Text (including mention/skill
syntax), images, regular files, and pasted text belong to that same atomic
value; pasted text is a discriminated file block whose `kind` is
`pasted-text` and whose in-memory text field is always present. Attachment ids
and upload progress/errors remain UI metadata on their corresponding blocks.
Only the submit boundary converts this array to the existing
`AgentPromptContentBlock[]` runtime contract, so queue, runtime, daemon, and
persistence protocols do not own a second draft representation.

Draft content identity is independent from provider, model, and the other
composer settings. On the home composer, content is cached under one shared
scope (`home`) for every selected project, including no project. An existing
conversation uses `session:<agentSessionId>`. Switching providers or projects
on home therefore preserves the whole message; returning home from a session
restores the shared home draft instead of the session draft. Provider/target
default settings, session settings, optimistic setting updates, model
inheritance, validation, and fallback keep their existing ownership and keys;
project identity must not be added to those setting caches or to the home draft
scope.

Attachment upload work also owns the draft scope where it started. If the user
switches sessions (or leaves home for a session) before an image or pasted-text
upload settles, the completion or failure updates the latest draft in the
original scope by block id; it must not read attachment projections from, or
write results into, the newly selected scope. Switching projects on home does
not change draft scope. Derived attachment arrays used by the composer are
memoized from the atomic content value and synchronized together so rerenders
cannot overwrite an optimistic attachment update with an older projection.

Each composer submit records a lightweight snapshot of the source scope and its
full content array, correlated by `clientSubmitId`; existing-session sends also
record the destination session because a recovered submit can send a home draft
to a previously active session. A successful first-message activation clears
its home scope; an accepted/confirmed existing-session send, including a queued
or recovered send, clears its recorded source scope. Failure or an uncertain
state retains the draft. Before clearing, the controller compares the complete
current array with the snapshot, including attachment upload metadata, so edits
made while a request is pending are retained as one new message. Terminal
results, immediate engine rejection, and conversation deletion discard
snapshots that can no longer resolve. Non-composer control sends must not
participate in this draft cleanup.

User-visible rules:

- Home composer submit with no active conversation starts activation. Detail
  composer submit with an active conversation sends input. First-message
  activation immediately enters an optimistic conversation so the submitted
  message is visible while the backend session is being created. Failure
  removes that optimistic conversation and restores the submitted home draft.
- New-conversation entry points that return the user to the home composer,
  including workbench header or external workbench events, should also issue a
  composer focus request so the empty input is ready for typing immediately.
  Their navigation affordances remain available while another session is being
  created; agent-target availability may block submit, but another session's
  activation or turn lifecycle must not block opening a new draft.
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
  When a provider does not advertise configurable reasoning (for example
  Cursor, which embeds effort inside parameterized model ids), the composer
  must clear draft/default `reasoningEffort` for that target and must not
  render a stale effort label next to the model trigger.
- Shift+Tab plan mode is a provider capability, not a frontend allowlist. The
  daemon's typed pre-session composer capabilities and typed live session
  capabilities must both advertise `planMode` before AgentGUI enables the
  toggle for a provider.
- The slash palette opens immediately when an initial composer capability
  request is in flight, even before selectable entries exist. The capability
  section renders a non-selectable loading row driven by the activity snapshot
  request lifecycle; it must not infer loading from an empty catalog.
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
live in the workspace `AgentSessionEngine` prompt-queue reducer, not in
Workbench node snapshots, daemon session/message persistence, conversation-list
compatibility stores, or a second server-side queue. Queue identity is the
engine workspace identity plus `agentSessionId`, so every AgentGUI surface using
the same injected workspace engine observes the same queue.

Queued prompts are session-scoped user intent, not active-detail UI state.
React controllers may dispatch typed queue intents and render selectors, but
must not decide provider strategy, call provider transports, or maintain a
parallel queue. The engine claims one head prompt with an in-flight command ID;
command result correlation and uncertain-delivery state prevent duplicate sends
when acknowledgements, timeouts, and authoritative activity events race.

Drain readiness comes only from canonical session/turn entities. A normal queue
head sends when availability becomes `available`. A send-now prompt is resolved
from runtime capabilities: native active-turn guidance may send while the exact
turn remains blocked; cancel-then-send records the selected prompt as
`sendNextPromptId`, issues an exact `turn/cancel`, and sends a normal prompt only
after the cancel result validates or the canonical turn settles. Metadata-only
session patches and locally inferred idle states cannot unlock the queue.

A user stop is an intent, not just a turn cancel: `interruptCurrentTurn`
suspends the session's prompt queue (`suspendReason: "user_stop"`) before
issuing the cancel, so the drainer must not fire the next queued prompt the
moment the session becomes available. Only an explicit user send lifts the
hold — composer submit resumes the queue, and a send-now intent clears the
suspension in the queue core. The send-now cancel path never suspends: intent is
captured at its source, never inferred from the cancel outcome.

Queue suspension must also remain visible in the presentation projection.
AgentGUI controllers map the queue record's `suspendReason` to the internal
`queueStatus` (`active` or `paused_by_user`) and carry it through the composer
view model. React queue components render that projection directly; they must
not infer a paused queue from cancel request state or turn settlement. A paused
queue keeps its count, expansion, edit, delete, and send-now controls available,
and returns to the ordinary queued label as soon as the queue core resumes it.

Reducer transitions that resume and then enqueue are compositional: the final
state and every command from both stages must be preserved. In particular, a
normal submit after a user stop sends the existing FIFO head and appends the new
prompt at the tail; it must not retain an `inFlight` claim after dropping the
corresponding `queue/sendPrompt` command. Send-now continues to use its atomic
promotion transition so it clears suspension, preserves priority semantics, and
emits only one delivery command.

Preview-mode AgentGUI surfaces are read-only for this runtime: they may render an
existing queue if injected into the same context, but they must not enqueue,
send now, edit, or delete queued prompts.

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
Their async reader has an explicit request owner keyed by runtime,
workspace, session, queue item, attachment/path, MIME type, name, and URL/data
identity. Context changes cancel the old logical request, and late results must
not update the current preview. DOM callback refs and element connectivity are
not request lifecycle or cancellation primitives.

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

| Visible state                  | Primary owner                    | Starts when                                                                            | Clears when                                                                    |
| ------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Rail skeleton or empty loading | conversation list query/store    | runtime list load starts                                                               | list load resolves or errors                                                   |
| Selected detail skeleton       | session view store/controller    | active session messages load starts                                                    | `listSessionMessages` resolves or active session changes                       |
| Home first-create busy         | active session activation record | home `startConversation` begins                                                        | that new-session activation succeeds, fails, or is abandoned as stale          |
| "Connecting conversation"      | existing-session activation      | existing session open/retry calls `activate`                                           | activation succeeds, fails, or is abandoned as stale                           |
| Transcript processing row      | transcript/session projection    | runtime reports working/turn phase                                                     | runtime reports ready/completed/failed or newer message projection replaces it |
| Send button spinner            | controller local submit state    | `executePrompt` or approval submit begins                                              | command promise settles                                                        |
| Composer settings loading      | composer options/settings model  | provider options load starts or settings source missing                                | options/settings resolve or fallback state is applied                          |
| Provider setup notice          | desktop provider status adapter  | captured provider status says the active provider is not ready after a settled recheck | captured status says provider is ready or user fixes setup                     |
| Approval response spinner      | controller approval submit state | prompt/approval option submit begins                                                   | runtime command settles and prompt projection updates                          |

When a loading state is wrong, first identify which row in this table is
visible. Then debug that owner and clearing condition. Avoid moving a spinner
between surfaces to hide a state-source mismatch.
Desktop restore must not project "not ready" from an uncaptured provider-status
snapshot. Until the first captured provider status exists, pass unknown provider
readiness into AgentGUI so startup does not flash a false "configure provider"
notice before local Codex or other provider detection returns.
When the active Agent GUI provider already has a cached not-ready status (for
example a background catalog probe that raced ahead of Cursor auth), desktop
must refresh that provider once and keep readiness unknown while the recheck is
pending. Otherwise switching into the provider flashes the setup notice even
though the composer can already send after auto-connect settles.

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

| Path                                                                                                        | Layer                                 | Notes                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/agent/activity-core/src/**`                                                                       | Durable activity core                 | Host-agnostic adapter/controller/types. No React, Electron, or desktop clients.                                                                                            |
| `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.ts` | Desktop activity facade               | Owns engine access, mutation/reconcile coordination, event handling, and local optimistic service behavior; focused query/import collaborators own those daemon workflows. |
| `apps/desktop/src/renderer/src/features/workspace-agent/services/createDesktopAgentActivityRuntime.ts`      | Runtime adapter                       | Wraps the desktop service into the `AgentActivityRuntime` interface and adds analytics/diagnostics.                                                                        |
| `apps/desktop/src/renderer/src/features/workspace-agent/ui/DesktopAgentGUIWorkbenchBody.tsx`                | Desktop product adapter               | Assembles workbench state, desktop preferences, provider status, mention providers, file references, and passes props into `AgentGUI`.                                     |
| `packages/agent/gui/AgentGUI.tsx`                                                                           | Package entry UI                      | Thin provider composition: i18n, tooltip, runtime/host providers, `AgentGUINode`.                                                                                          |
| `packages/agent/gui/agentActivityRuntime.tsx`                                                               | AgentGUI runtime interface            | Public React/context interface for durable activity data and commands.                                                                                                     |
| `packages/agent/gui/agentActivityHost.tsx` and `host/agentHostApi.ts`                                       | Host capability interface             | Files, clipboard, account/user projects, workspace helpers, probes, persistence. Legacy session APIs are not production data sources.                                      |
| `packages/agent/gui/workbench/**`                                                                           | Host-agnostic workbench integration   | Dock entries, launch descriptor, provider mapping, workbench node state helpers. Desktop still owns product-specific body rendering.                                       |
| `packages/agent/gui/agent-gui/agentGuiNode/controller/**`                                                   | Node controller implementation        | UI orchestration, command sequencing, and rail section query lifecycle. Prefer focused helper files over growing the main hook.                                            |
| `packages/agent/gui/agent-gui/agentGuiNode/model/**`                                                        | Node model and policy                 | Pure status, provider, settings, draft, slash command, layout, project resolution, and conversation projection helpers.                                                    |
| `packages/agent/gui/agent-gui/agentGuiNode/agentRichText/**`                                                | Composer document layer               | Tiptap document, mentions, tokens, IME, prompt images, serialization helpers.                                                                                              |
| `packages/agent/gui/agent-gui/agentGuiNode/AgentGUINodeView.tsx`                                            | Node view                             | Renders the rail/detail/composer and owns DOM-only state. Keep data fetching out.                                                                                          |
| `packages/agent/gui/app/renderer/i18n/locales/*.agentGui.ts`                                                | AgentGUI locale vertical              | Owns the complete `agentHost.agentGui` dictionary per locale and composes smaller provider/runtime/slash fragments internally.                                             |
| `packages/agent/gui/shared/agentConversation/**`                                                            | Transcript module                     | Reusable contracts, projection, rules, and rendering components shared by AgentGuiNode, Message Center, and standalone conversation rendering.                             |
| `packages/agent/gui/contexts/workspace/presentation/renderer/agentGuiConversationList/**`                   | AgentGUI conversation-list projection | Engine selector boundary despite the legacy path name. Projects canonical sessions plus engine-owned pending intents; owns no durable or local pending store.              |
| `packages/agent/gui/contexts/workspace/presentation/renderer/agentSessions/**`                              | Active session UI store               | Package-owned active-session view state, overlay messages, control state, watcher counts, and event retention.                                                             |
| `packages/agent/gui/agent-message-center/**`                                                                | Message center surface                | Consumes activity/prompt projections to show attention items outside the full node.                                                                                        |
| `packages/agent/gui/agent-conversation/**`                                                                  | Standalone transcript export          | Reuses the same detail-to-conversation projection and transcript components without the full node.                                                                         |

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
UI affordance. `canUploadAttachment` applies to prompt attachment paths and
must not hide ordinary `@` references or workspace-reference mention
selection. Large pasted text also requires the explicit optional
`AgentActivityRuntime.stagePastedText` operation; generic file upload support
is not sufficient evidence that a host can persist in-memory text.
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

The host directory port publishes an explicit `idle | loading | ready | error`
lifecycle. `ready` may contain an authoritative empty `agents: []`; `error`
retains the last successful directory while exposing the failure, and the
directory service—not a shell focus effect or React component—owns retry and
refresh policy. Workbench dock payload resolution, new-launch validation, body
rendering, and detached-window handoff must read the same live port snapshot.
They must not combine static `agents/agentsLoading` inputs with a second dynamic
resolver.

The public `AgentGUI` wrapper accepts that lifecycle snapshot as its single
directory input. Normalized `agentTargets`, their loading flag, provider-rail
mode/presentation, and the internal rail-empty slot are private node inputs and
must not remain writable alongside the public directory.

Detached-window bootstrap transport serializes the complete directory
snapshot, including lifecycle, capture time, presentation entries, and trusted
target presentations. The new window hydrates its local canonical directory
service before first paint, subscribes to that service, and refreshes the same
owner. It must not copy the bootstrap array into React state or infer loading
from `agents.length`/a missing timestamp. A failed or loading snapshot therefore
remains distinguishable from an authoritative ready-empty directory across the
window boundary.

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
  scroll position and animation are not reset; pin the overlaid carousel layer
  to the rendered placeholder slot and resynchronize it when the hero body
  resizes or the ready/gated subtree changes, so wrapped titles and growing
  composers cannot move beneath the records; size the WebGL canvas from integer
  layout dimensions instead of transformed bounds, and dissolve records beyond
  the immediate neighbours to avoid fractional edge seams; rotate the centered
  record by default, temporarily give playback to the record under the pointer,
  return playback to the current center when hover leaves, preserve each
  record's stopped angle when playback moves elsewhere, and fade records
  progressively by distance from the center while keeping the next outer record
  partially visible on each side; target
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
Conversation rail rows render icons through a monochrome CSS mask. Built-in
providers therefore use their mask-safe flat catalog artwork before consulting
the Target presentation; using a square colorful Target asset there collapses
to a solid block. When an open extension provider has no built-in flat asset,
the row resolves the signed Target `iconUrl` through the conversation's
`agentTargetId`. Open providers must not require a renderer icon catalog entry.
One carousel image-load owner fetches and decodes icon, vinyl-cover, and badge
images for a complete item generation. Remote badge images must be requested
with anonymous CORS before assigning `src`, and the asset host must return an
origin-clean response. Replacing or unmounting a generation cancels all of its
pending image callbacks and clears unfinished sources. The Three.js scene must
receive decoded images and must never create a fallback `Image` loader of its
own; it owns only GPU texture/material/geometry lifetime. It keeps an
asset-independent visible owner marker until texture upload succeeds, so any
load, decode, conversion, or upload failure leaves the fallback visible. Scene
disposal releases textures, materials, and geometry after the component has
detached the scene from its decoded-image generation.

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
Standard ACP command snapshots also project their detailed catalog into the
session runtime context. Composer options may reuse that catalog when the
renderer subscribed after the startup update or after a restart; a live engine
snapshot remains authoritative whenever it is present. This recovery path must
preserve provider-advertised names, descriptions, and input hints and must not
invent an extension-specific fallback list.
Open Agent Extensions declare Skill discovery roots, invocation mode, and
trigger prefix in their validated composer profile. The daemon resolves only
safe relative workspace/user roots and projects the resulting Skill options;
AgentGUI must not infer Skill behavior from an open provider identifier.
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
launch surface; use the first-party `local:tutti-agent` Agent Target instead.

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
| `useAgentGuiConversationList.ts`          | UI-facing projection of canonical sessions plus engine-owned pending intents                    | Becoming a second durable or pending-intent store       |
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

Plain-text paste classification happens before structured mention-HTML
delegation. Once the trimmed plain-text representation reaches 5,000
characters, every editor paste entry point must classify it as large text and
must not insert it inline. The composer creates one `pasted-text` draft item,
then calls the dedicated `AgentActivityRuntime.stagePastedText` host boundary
with raw text. The host owns local persistence and returns a managed absolute
path, display name, and byte size. Do not encode pasted text as a generic
`uploadPromptContent` file block or infer text-staging support from
`promptContentUploadSupport.file`; external hosts may accept host paths while
rejecting inline file bytes.

The pasted-text state machine is `detected -> staging -> landed | failed`.
Missing host support is a failed attachment state, not an inline fallback. The
draft keeps the original text in memory so the user may explicitly restore it
through “Show in text field”; automatic failure recovery must not violate the
large-paste invariant. Uploading and failed pasted-text items block submission.
The desktop runtime implements `stagePastedText` through the host prompt-asset
archive and returns only the managed path metadata to AgentGUI.

`workspace-reference` hrefs are the passive reference contract, not a visual
metadata store. Do not serialize app icons into the href just to render a chip.
For `source=app` references, readonly and markdown renderers should hydrate the
icon from the same `workspaceAppIcons` appId/workspaceId table used by ordinary
`workspace-app` mentions.

After an app artifact reference is submitted into the conversation timeline,
clicking its readonly or markdown chip routes the reference's app id through the
existing `open-workspace-app` host action. The composer keeps its narrower draft
behavior: clicking the same reference before submission reopens the artifact
picker at that source instead of launching the app.

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
must serialize the exact current Agent Target id, for example
`mention://agent-target/local:codex?workspaceId=<workspace-id>`. Examples are
non-exhaustive; callers must discover the current target list instead of
assuming a fixed provider catalog. Mentions must not serialize provider ids or
icon hints into the href. Renderer display code
must resolve labels, providers, and icons by looking up the current
`agentTargetId` in `AgentsService`-derived presentation data, so future
user-defined icons and editable targets have one renderer source of truth.
The same rule applies to Agent Session mention rows and message-center cards:
`provider` remains runtime/protocol identity, while user-visible Agent name and
artwork come from the session's `agentTargetId`. Open extension providers must
not be filtered through the built-in provider catalog. Historical sessions
without an `agentTargetId` may use the provider presentation as their legacy
display identity.
Historical pseudo-app mentions may remain as display tokens but are not a new
insertion target.
Desktop AgentGUI host input must include the `agent-target` capability when it
builds composer context mention providers. Inside the AgentGUI mention palette,
the Apps tab queries only `workspace-app`; first-party launch targets appear in
a separate Agents tab that queries only `agent-target`. Do not use the Apps tab
as an agent fallback, because that recreates the old pseudo workspace-app
contract.
Workspace-app search in the Apps tab matches only the localized display name.
App ids, descriptions, scopes, and CLI command metadata may enrich presentation
or routing, but they must not produce search results that the visible app name
cannot explain.

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
pnpm check:agent-provider-strategy-boundaries
pnpm check:agent-gui-degradation
pnpm check:renderer-boundaries
pnpm lint:ts
pnpm typecheck
pnpm --filter @tutti-os/agent-gui test
pnpm --filter @tutti-os/desktop build
pnpm check:changed
```

Contract tests should lock:

- session and turn entity separation
- command correlation and idempotent replay
- selector behavior for running and settled turns
- grouped public props without flat regressions
- provider descriptor coverage for every registered provider
- render budgets for common GUI interactions

## Diagnostics

Diagnostics follow one command or event across boundaries using stable IDs:

- `workspaceId`
- `agentSessionId`
- `turnId`
- `clientSubmitId` or command ID
- provider ID and provider session ID when available

Submit correlation and submit diagnostics are separate typed contracts.
`clientSubmitId` remains a top-level idempotency identity; optional timing and
content-shape evidence travels as `submitDiagnostics` with the same field names
as the OpenAPI request schema. Generic metadata bags must not cross the engine
or daemon command seam because conditional object spreads can otherwise hide
request-contract drift from TypeScript.

For one investigated problem, every diagnostic log uses the same prefix and
serializes its payload with `JSON.stringify`. Investigation logs remain enabled
until the root cause is established. Unknown state requires more boundary
evidence before behavior changes.

> This change exposed a reusable AgentGUI pattern. Should I add it to
> `docs/architecture/agent-gui-node.md` or
> `docs/conventions/troubleshooting/agent-runtime.md`?

Debug in ownership order:

1. Verify daemon command acceptance, persisted intent, and correlated events.
2. Verify engine reduction and selector output for the same IDs.
3. Verify the vertical GUI module receives that selector output.
4. Verify the view renders it without adding workflow interpretation.

If evidence ends at a boundary, add diagnostics at both sides of that boundary.
Fix the first broken ownership transition.

## Documentation Impact

Update this document when ownership, entity flow, public node responsibilities,
provider strategy dispatch, validation, or diagnostic conventions change.
User-visible interaction details belong in product documentation; recurring
symptom playbooks belong in the relevant document under
`docs/conventions/troubleshooting/`.

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
