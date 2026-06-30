# Desktop Windows

This document describes the current window model for `apps/desktop`.

## Purpose

The desktop app currently has two user-facing shells:

- a launcher-style dashboard window for no-context startup
- a workspace window for an opened workspace

The window model is intentionally simple:

- restore a recent workspace when possible
- otherwise show a lightweight dashboard launcher
- keep workspace-specific behavior in the workspace window

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

The workspace window is the primary product surface for a single workspace.

Current responsibilities:

- load the selected workspace shell
- receive the active `workspaceId`
- provide the long-lived window that later feature work will build into

The current renderer content is intentionally minimal. The shell exists so the startup and window model can stabilize before in-workspace features are added.

## Startup Behavior

Desktop startup currently follows this sequence:

1. start or reconnect to `tuttid`
2. ask `tuttid` for the daemon-selected startup workspace
3. if a startup workspace exists, open the workspace window for it
4. otherwise open the dashboard window

On macOS activation with no open windows, the app follows the same startup resolution instead of always forcing the dashboard.

## Open Behavior

When a user opens a workspace from the dashboard:

1. desktop asks `tuttid` to mark that workspace as opened
2. desktop creates the workspace window for that workspace
3. desktop closes the dashboard window

When a user creates a workspace from the dashboard:

1. desktop asks `tuttid` to create a workspace record
2. the resulting workspace is marked as opened
3. desktop opens the workspace window
4. desktop closes the dashboard window

## Current Renderer Shell Mapping

Current renderer shell mapping:

- dashboard window -> `view=dashboard`
- workspace window -> `view=workspace&workspaceId=<id>`

The renderer still shares one preload entry and one renderer bundle today. Separate window shells are resolved inside renderer bootstrap code rather than through fully separate apps.

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

## App Quit Guard Behavior

App quit is gated before managed daemon shutdown. When Electron emits
`before-quit`, the main process sends a typed quit close request to every
workspace window and waits for the renderer response. Only after every
workspace approves the quit does the main process stop `tuttid`, destroy
remaining windows, and resume the app quit path.

The workspace renderer uses the same close-guard channel for quit as it uses
for native window close. Contributions that own long-running local work can
block quit from `prepareHostClose`; for example, the desktop AgentGUI
contribution prompts when local agent sessions are still running or waiting for
input. If the user keeps Tutti open, daemon shutdown is skipped and the running
agent sessions stay connected.

## Relationship To Layering

This window model follows the desktop layering rules:

- `renderer` may use the preload-provided backend config to call `tuttid` for business APIs
- `preload` exposes typed host capabilities and runtime bootstrap metadata
- `main` owns daemon supervision, startup resolution, window creation, and native host capabilities
- `tuttid` remains the source of truth for workspace catalog and recent-open semantics

## Near-Term Deferrals

The following are still intentionally deferred:

- in-workspace switching UX
- a dedicated settings window
- dashboard search
- keeping dashboard open after launching a workspace
- multi-window coordination beyond dashboard -> workspace
