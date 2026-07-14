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
2. desktop creates the preferred Agent-only or OS workspace window for that
   workspace
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
3. desktop sizes the Agent-only window to 90% of the source window display's
   work area, excluding system UI such as the macOS menu bar and Dock, then
   centers it horizontally and vertically
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

## Current Renderer Shell Mapping

Current renderer shell mapping:

- dashboard window -> `view=dashboard`
- OS workspace window -> `view=workspace&workspaceId=<id>`
- Agent-only window -> `view=agent&workspaceId=<id>`

The renderer still shares one preload entry and one renderer bundle today. Separate window shells are resolved inside renderer bootstrap code rather than through fully separate apps.
Agent-only windows also share host-window preload capabilities; their
AgentGUI header close, minimize, and maximize controls call typed host window
IPC instead of relying on native traffic lights.
The Agent-only shell places Browser and other desktop-owned auxiliary tools in
a right sidebar, while Terminal opens in a bottom tray below the conversation.
Opening a right-sidebar tool expands the native content width first so the
sidebar is appended beside the existing message flow. Native right-edge growth
continues to grow the sidebar; when the screen cannot provide enough outward
room, the sidebar's full width stays reserved in the flex layout and the
message flow narrows instead of being covered. Width added from the sidebar's
left separator follows the same adjacent layout rule. Closing the sidebar
restores the pre-panel native width. This sizing remains renderer/main window
presentation state and never enters AgentGUI or workbench snapshots.
The renderer activates and animates the clipped panel shell before issuing the
native resize IPC on the next frame, so host latency cannot block visual
feedback. Heavy first-use tool bodies mount after the shell transition and
remain mounted for later opens. macOS requests Electron's native content-bounds
animation in parallel, while reduced-motion preferences disable the renderer
transition and mount delay.
Its Apps panel renders the App Center contribution body instead of mounting a
catalog-only copy. The shared `openAppId` view state selects which surface is
visible in both OS and Agent-only shells, but it does not own Browser Node
lifetime. The contribution keeps the catalog and one app-specific Browser Node
for every opened app mounted for the renderer lifetime. The back action clears
only the selection, marks every retained Browser Node hidden, and reveals the
already-mounted catalog; reopening an app reveals the same Browser Node so its
page, in-memory editor state, and in-page Agent continue from the previous
state. Every retained app uses a stable app-specific Browser Node id and
receives `hidden={true}` whenever it is inactive or its containing tool surface
is minimized. Retained instances are released only when a ready App Center
snapshot confirms that the app is no longer available or when the containing
host is torn down. An app open request activates the Apps sidebar
automatically. Both shells
must start the shared App Center polling lifecycle, so app runtime events update
the selected Browser Node from `starting` to `running` with its launch URL.
Both shells also mount the Workspace App external bridge and local
workspace-scoped launch handlers for the surfaces they expose. This keeps App
Center Agent actions and in-app Agent/session/issue reference links functional
in the Agent-only renderer, where module-local coordinator registrations from
an OS renderer are not visible. Draft launches open a second native Agent-only
window with the draft bootstrap intent, while existing-session navigation
reuses the current Agent-only window unless the caller explicitly requests a
new one. Issue Manager launches open the Tasks sidebar and forward the standard
issue activation so the embedded surface selects the requested issue and task.
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
- multi-window coordination beyond dashboard -> workspace
