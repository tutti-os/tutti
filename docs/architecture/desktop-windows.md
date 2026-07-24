# Desktop Windows

This document describes the current window model for `apps/desktop`.

## Purpose

The desktop app currently has three user-facing shells:

- a launcher-style dashboard window for no-context startup
- a workspace window for an opened workspace
- an Agent-only window used as an optional focused Agent experience

The window model is intentionally simple:

- restore a recent workspace when possible
- otherwise show a lightweight dashboard launcher
- keep workspace-specific behavior in the workspace window
- keep Agent-only windows tied to the same workspace, preload, renderer
  bundle, daemon session, and persisted account state as the workspace window

## Current Window Types

### Dashboard Window

The dashboard is a small launch surface.

It is responsible for:

- listing known workspaces
- allowing the user to open a workspace
- allowing the user to create a workspace

It is not responsible for:

- acting as a persistent app hub
- serving as the in-workspace switcher model
- duplicating workspace-window functionality

### Workspace Window

The workspace window is the full Tutti OS product surface for a single
workspace when the user selects OS mode.

Current responsibilities:

- load the selected workspace shell
- receive the active `workspaceId`
- provide the long-lived window that later feature work will build into
- remain the only durable Workbench snapshot writer for that workspace

The main process permits at most one OS workspace window per `workspaceId`.
Repeated or concurrent open requests reuse the registered window and restore,
show, and focus it instead of creating another renderer/repository. The window
registry also rejects a second durable owner if a future caller bypasses the
normal launch coordinator. Agent-only windows may still coexist because their
Workbench snapshot repositories are read-seeded and window-local.

The current renderer content is intentionally minimal. The shell exists so the startup and window model can stabilize before in-workspace features are added.

### Agent-Only Window

The Agent-only window is the focused product shell for users who select Agent
mode and want AgentGUI without the full workspace desktop around it.

It is responsible for:

- loading the selected workspace's AgentGUI surface directly
- using a frameless native window and the AgentGUI header controls instead of
  platform-provided titlebar buttons
- preserving shared workspace, account, provider, project, and activity state
  through the same renderer services and `tuttid` APIs used by the workspace
  window
- hosting AgentGUI-triggered settings, external import, and environment
  detection panels without mounting the full workspace chrome
- exposing shared workspace tools such as task management from compact header
  actions and rendering them in the Agent window's resizable right sidebar
- opening an existing session when launched with an `agentSessionId`

It is not responsible for:

- becoming a separate packaged macOS application or bundle identifier
- owning a second login state, database, or provider runtime
- mounting the full workspace shell, launchpad, or app dock

## Startup Behavior

Desktop startup currently follows this sequence:

1. start or reconnect to `tuttid`
2. ask `tuttid` for the daemon-selected startup workspace
3. if a startup workspace exists, read the desktop startup-interface preference
4. create the OS workspace window by default, or the Agent-only window when the
   user explicitly selected Agent mode
5. otherwise open the dashboard window

On macOS activation with no open windows, the app follows the same startup resolution instead of always forcing the dashboard.

## Open Behavior

When a user opens a workspace from the dashboard:

1. desktop asks `tuttid` to mark that workspace as opened
2. desktop creates the preferred Agent-only window, or reuses/creates the one
   OS workspace window registered for that workspace
3. desktop closes the dashboard window

When a user creates a workspace from the dashboard:

1. desktop asks `tuttid` to create a workspace record
2. the resulting workspace is marked as opened
3. desktop opens the workspace window
4. desktop closes the dashboard window

When a user opens the Agent-only window from a workspace window:

1. desktop creates the Agent-only window for the same workspace
2. desktop passes the source window's Agent provider target and provider status
   snapshots as bootstrap data so the detached window does not start from an
   unknown availability state
3. desktop sizes the Agent-only window to 90% of the source workspace window's
   visible area after its top bar and bottom Dock are removed, then centers it
   within that area; when there is no workspace opener, it falls back to 90% of
   the display work area excluding system UI such as the macOS menu bar and Dock
4. once the Agent-only window is ready and shown, desktop minimizes the source
   workspace window

When the same open-window control is used inside an Agent-only window, desktop
opens another Agent-only window for the current session and agent target while
keeping the source Agent window visible. Provider status and agent snapshots are
handed off through the same bootstrap path; the new window remains a second view
over shared durable activity rather than a copied activity store.

When a user changes the startup interface in Settings, desktop persists the
preference and immediately replaces the current native window with the selected
Agent-only or OS workspace window. The replacement request carries the selected
window kind explicitly, so it does not depend on asynchronous preference-event
delivery in the main process. Desktop waits until the replacement is ready
before closing the source window. An absent preference resolves to OS mode;
manual selections persist `true` for Agent mode and `false` for OS mode.
If the requested OS window already exists, desktop reuses it and does not close
that same window as the handoff owner.

## Current Renderer Shell Mapping

Current renderer shell mapping:

- dashboard window -> `view=dashboard`
- OS workspace window -> `view=workspace&workspaceId=<id>`
- Agent-only window -> `view=agent&workspaceId=<id>`

The renderer still shares one preload entry and one renderer bundle today. Separate window shells are resolved inside renderer bootstrap code rather than through fully separate apps.
Agent-only windows also share host-window preload capabilities; their
AgentGUI header close, minimize, and maximize controls call typed host window
IPC instead of relying on native traffic lights.
The shared maximize capability preserves each native shell's semantics:
Agent-only windows toggle fullscreen because native zoom is disabled, while OS
workspace windows toggle BrowserWindow maximize and unmaximize.
The Agent-only shell places Browser and other desktop-owned auxiliary tools in
a right sidebar, while Terminal opens in a bottom tray below the conversation.
The sidebar projects a structured Header layout into the shared
`AgentGuiWorkbenchHeader`; native Agent windows and embedded Workbench hosts
therefore keep one authoritative Header row rather than moving open-panel
controls into a second panel Header. Header owner and body layout are separate
contract dimensions: both current surfaces use `overlay`, even though one is
window-owned and the other is host-owned. Both surfaces also consume the one
AgentGUI-owned Rail breakpoint and borderless Header presentation; Desktop does
not provide a standalone-only collapse threshold or use window mode to select
Header spacing and separators.
When the sidebar is closed, its Apps and Message Center quick actions expose
localized hover tooltips alongside the Tasks action.
Opening a right-sidebar tool expands the native content width first so the
sidebar is appended beside the existing message flow. Native right-edge growth
continues to grow the sidebar; when the screen cannot provide enough outward
room, the sidebar's full width stays reserved in the flex layout and the
message flow narrows instead of being covered. Width added from the sidebar's
left separator follows the same adjacent layout rule. Closing the sidebar
restores the pre-panel native width. This sizing remains renderer/main window
presentation state and never enters AgentGUI or workbench snapshots.
An Agent-only right sidebar with no mounted tool uses a compact picker width at
60% of the Files panel default. The picker lists Files, Terminal, Browser,
Tasks, Apps, and Messages in the same tool hierarchy used by the panel header.
Selecting a tool switches the reserved layout and requested native width to
that tool's normal default. While the picker is visible, its sole header toggle
stays right-anchored to the same window edge as the collapsed sidebar control,
avoiding a horizontal jump when the panel opens.
The renderer commits the panel shell's final layout width before issuing the
native resize IPC on the next frame, so host latency cannot block visual
feedback. The shell must not animate layout width before a heavy first-use tool
body mounts. The lightweight empty picker and width changes for an already
mounted tool use the same 260ms ease-in-out transition. On macOS, empty-picker
open and close start the matching native content-bounds animation in the same
frame; the close transition only clears its retained layout baseline after the
panel width reaches zero, so it never triggers a second terminal window resize.
Other optional first-use entrances stay inside the fixed-size panel and use
only compositor-friendly transform and opacity. Heavy first-use tool bodies
mount after that brief entrance and remain mounted for later opens. Native
content bounds otherwise change without a parallel bounds animation, while
reduced-motion preferences disable transitions, the inner entrance, and the
mount delay.
Its Apps panel renders the App Center contribution body instead of mounting a
catalog-only copy. App open, close, and open-state checks cross a feature-owned
workspace App surface host. Both OS and Agent-only presenters add the prepared
app to the shared ordered `openAppIds` view state and select it through
`openAppId` before runtime preparation completes, so startup progress appears in
the app tab itself. The OS presenter then opens or focuses the singleton App
Center Workbench Node instead of creating an app-specific Workbench window.
Dock launches resolve to the same singleton node and carry route activation to
the selected inline app. A failed preparation restores the previous tab state.
The presenter registration is renderer-window scoped and is bound to the actual
Workbench host and workspace lifecycle, not App Center snapshot or revision
updates. Replacing or disposing a presenter cancels and rolls back its pending
attempts before releasing it; disposable identity checks also ensure an old
Shell cleanup cannot remove a newer presenter. In the Agent-only shell, only the
latest attempt whose App is still selected may report successful presentation;
stale completions cannot claim success for a newer or cleared inline selection.

Workspace file previews use the same ownership direction without sharing the
App Center's attempt protocol. File Manager owns file activation, preview-kind
resolution, system fallback, and opened-file reporting. A feature-owned file
preview surface host routes the placement decision by workspace. The OS shell
registers a presenter that launches the matching Workbench preview Node; the
standalone Agent shell registers a presenter that opens the file through the
desktop system host. Unsupported-preview notification policy belongs to that
presenter registration, so disposing the Agent shell restores the default OS
policy automatically. Registrations use identity-checked cleanup, preventing an
old Shell effect cleanup from removing a newer presenter. A presentation started
under one registration may still report success after that registration is
replaced or disposed if its presenter eventually completes successfully. Unlike
App Center preparation, it has no reversible pending attempt, and reporting
failure would trigger a duplicate system fallback. When presentation fails, its
fallback notification policy also comes from the registration that started the
attempt, rather than a replacement registered while the attempt was in flight.

The App Center contribution keeps the catalog and one app-specific Browser Node
for every id in `openAppIds` mounted in both shells. The catalog is a permanent
first tab. Selecting it clears only `openAppId`, marks every open app Browser
Node hidden, and reveals the already-mounted catalog. Selecting another tab
reveals the same keyed Browser Node, so its page, in-memory editor state, and
in-page Agent continue from the previous state. Closing an app tab removes its
id from `openAppIds`, releases that Browser Node, and selects the adjacent app
tab or catalog fallback. Every open app uses a stable app-specific Browser Node
id and receives `hidden={true}` whenever it is inactive or its containing tool
surface is minimized. A ready App Center snapshot may also close tabs for apps
that are no longer available. An Agent-only app open request activates the Apps
sidebar automatically. Both shells must start the shared App Center polling
lifecycle, so app runtime events update the active app surface from `starting`
to `running` with its launch URL.
Both shells also mount the Workspace App external bridge and local
workspace-scoped launch handlers for the surfaces they expose. This keeps App
Center Agent actions and in-app Agent/session/issue reference links functional
in the Agent-only renderer, where module-local coordinator registrations from
an OS renderer are not visible. Draft launches open a second native Agent-only
window with the draft bootstrap intent, while existing-session navigation
reuses the current Agent-only window unless the caller explicitly requests a
new one. Issue Manager launches open the Tasks sidebar and forward the standard
issue activation so the embedded surface selects the requested issue and task.
Issue Manager placement is selected through a workspace-scoped presenter
coordinator rather than by mode checks in the request source. The OS shell
registers a presenter that launches and activates the Workbench Node, while the
standalone Agent shell registers a presenter that opens the Tasks sidebar
inline. Presenter registrations use registration identity for cleanup, so an
old shell disposer cannot remove a newer presenter, including when both
registrations reuse the same presenter object.
Other simple workspace launch coordinators keep their domain-specific request
normalization and public handler APIs, but share the same private registration
primitive for workspace key normalization, latest-registration routing, and
identity-safe disposal. This applies to Browser, Files, Message Center,
Workbench Node, and Group Chat routing without turning those distinct handlers
into a generic Shell service.
The OS Files floating window opens wide by default so its location, list, and
detail columns begin at approximately 26%, 55%, and 19% of the content width;
each splitter remains user-resizable within its minimum-content constraints.
The tray reuses the OS `workspace-terminal` contribution and therefore the same
PTY adapter, terminal output recovery, and close guard as the OS workspace.
Its ephemeral panel-local host does not read or overwrite the OS workbench
snapshot, and its close effects remain part of the native window close flow.
When Files is selected, the sidebar starts at a wide desktop-safe width and the
reusable file manager exposes two local column boundaries: locations/list and
list/details. Those widths are presentation state only and never enter the OS
workbench snapshot. Conversation file links and reference preview requests
activate this Files sidebar with a reveal intent, so the requested file opens
beside the conversation instead of in a floating overlay or external app.

## Workspace Close And Reload Behavior

Workspace window close is a native window lifecycle intent. The main process
intercepts the Electron `close` event and sends a typed close request to the
renderer through preload. Renderer code may collect workbench close effects,
show product close guards, and clean up renderer-owned sessions. Once that
work has completed, renderer calls the approved-close host capability and main
destroys the window.

Renderer workspace code should not infer native close intent from
`beforeunload`. Reload and close are distinct intents, and `beforeunload`
cannot reliably distinguish Electron menu accelerators, keyboard shortcuts,
and native window close events.

Development reload shortcuts such as `Cmd+R`, `Ctrl+R`, and `F5` are owned by
the workspace window shell in main. They are enabled only for development
renderer sessions and are intercepted without entering the close-guard flow.
Packaged builds intercept those shortcuts without reloading the product window.

## Relationship To Layering

This window model follows the desktop layering rules:

- `renderer` may use the preload-provided backend config to call `tuttid` for business APIs
- `preload` exposes typed host capabilities and runtime bootstrap metadata
- `main` owns daemon supervision, startup resolution, window creation, and native host capabilities
- `tuttid` remains the source of truth for workspace catalog and recent-open semantics

## Near-Term Deferrals

The following are still intentionally deferred:

- a dedicated settings window
- dashboard search
- keeping dashboard open after launching a workspace
- advanced multi-window coordination beyond the enforced per-workspace durable
  Workbench owner
