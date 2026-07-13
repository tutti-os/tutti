# Desktop Windows

This document defines the native-window model for `apps/desktop`.

## Product Contract

Tutti has two desktop presentation modes over the same workspace and daemon
data:

- **Workspace Workbench** is the default. One Workspace window hosts the
  Workbench surface and its nodes.
- **Fusion Mode** is an opt-in Labs mode. A floating Tutti Dock, the macOS
  menu-bar item, and the ordinary Tutti application icon in the system Dock
  are application entry points. Product surfaces open in separate native
  windows; there is no user-facing Workspace container window.

The durable interaction boundary is:

- **macOS manages visible windows**: title bars, traffic lights, moving,
  resizing, minimizing, full screen, displays, Spaces, Mission Control, App
  Exposé, and the Window menu.
- **Tutti manages launching and background work**: launcher identity, native
  window/resource association, Agent sessions, PTYs, Workspace App runtimes,
  reconnect, explicit Stop, and application shutdown.

Workspace remains the daemon ownership and data-isolation boundary in Fusion
Mode. It is not presented as a window hierarchy to the user.

`lab.fusionMode` is persisted in desktop preferences and defaults to `false`.
The mode is selected during desktop startup and remains fixed for that Electron
process. When an authoritative preference update selects the other mode, main
offers a localized native restart. **Later** suppresses repeat prompts for the
same target until the preference returns to the current mode. **Restart Now**
re-reads the durable preference before calling `app.relaunch()` and
`app.quit()`, so a reverted setting cannot restart into an unwanted mode.

On macOS the restart prompt is attached to the focused or a visible Tutti
`BrowserWindow` after activating the app. A parentless modal alert can otherwise
be hidden behind the window that changed the flag. The default Workspace path
must remain usable when Fusion Mode is disabled.

## Three Lifecycle Layers

### Tutti application

Electron main owns the application lifecycle. In Fusion Mode, the macOS
menu-bar item remains resident even when the floating Dock and every product
window are hidden or closed.

- Closing every product window does not quit Tutti.
- Hiding the floating Dock does not quit Tutti.
- Closing the Dock control means **hide**, not destroy the application.
- Only **Quit Tutti**, or the confirmed `Cmd+Q` flow, begins app shutdown.
- Shutdown stops managed `tuttid`, including its live PTYs and Workspace App
  runtimes, before native windows are destroyed.

### Native window

`FusionWindowCoordinator` in Electron main owns native window creation,
focus, visibility, and destruction. `FusionWindowRegistry` records only live
native windows. Each descriptor has a `windowInstanceId`, kind, workspace,
optional resource ID, title, visibility, and most-recent-focus timestamp.

Closing a native window removes its registry descriptor and launch metadata. A
closed window must never be retained as a hidden `BrowserWindow` to represent
background work. Closing one window does not close any sibling window or quit
Tutti.

The coordinator supports these window kinds:

- Agent
- terminal
- browser
- files and file preview
- Workspace App and App Center
- settings
- Issue Manager

Each product kind can have multiple native instances. A normal activation
focuses the most-recent matching window. If there is no live window, it
reconnects the most-recent matching background resource when one exists, then
creates a new instance only when neither exists. An explicit **New Window**
request sets `forceNew` and always creates another view or independent
instance. A request for an exact resource never falls back to a different
resource of the same kind.

### Background resource

Background resources are daemon-owned and independent of native windows:

- Agent session: `agentSessionId`
- terminal session: `terminalId`
- Workspace App runtime: `appId` within a workspace

The Dock obtains these resources from `tuttid` list APIs and joins them to live
window descriptors by `(workspaceId, kind, resourceId)`. Resource IDs are not
globally unique across workspaces, so omitting workspace identity can attach a
task to an unrelated window. This dual-source model is intentional: the
main-process registry is authoritative for windows, while `tuttid` is
authoritative for tasks.

Closing an Agent, terminal, or Workspace App window detaches its renderer view
and leaves the daemon resource running. Reconnect creates a native window for
that resource. Stop is a separate explicit command:

- Agent Stop cancels the active turn; the conversation remains resumable when
  the domain state permits it.
- terminal Stop terminates the PTY session and still honors the terminal close
  guard.
- Workspace App Stop stops that app runtime through its daemon API.

Browser, files, file preview, App Center, Issue Manager, and settings have no
separate background entity. Closing one of those windows ends that instance.

## Startup And Application Activation

Startup starts or reconnects to `tuttid` and asks it for the startup workspace.

- Workspace Workbench mode opens the existing Workspace window.
- Fusion Mode starts the coordinator for that workspace, creates the menu-bar
  item and floating Dock, and does not create a Workspace window.

The Fusion coordinator is application-scoped and idempotent. Starting the same
workspace again does not create another Dock. Opening a different workspace
recreates the Dock window with that workspace's launcher catalog so its
immutable renderer intent does not change, while already open product windows
from other workspaces may remain alive. Each product renderer continues to
receive only its own workspace projection.

macOS application activation, including selecting the Tutti icon in the system
Dock, uses this policy:

1. focus and restore the most-recent Fusion product window when one exists
2. otherwise show and focus the floating Dock

This is distinct from the floating Dock's launcher activation policy. The
system Dock continues to show one Tutti application icon; it does not claim
that every native window is a separate installed app.

Agent-only launch requests continue to use the existing detached Agent shell
in Workspace mode. In Fusion Mode they are routed through the coordinator and
become ordinary Agent resource windows.

## Floating Dock And Launcher Catalog

The floating Dock is a frameless, rounded, transparent Electron
`BrowserWindow`. It floats above normal windows, does not reserve desktop work
area, and is visible across macOS Spaces and full-screen apps. It is excluded
from Mission Control and the system Window menu because it is an application
launcher rather than a product window.

The renderer owns the single inset glass surface, its light semantic border,
and its elevation. The transparent `BrowserWindow` must not add a second native
shadow around its full bounds. The Fusion Dock route also resets the shared
renderer page canvas to a transparent background and removes its normal
`320px` minimum width. Otherwise the application canvas becomes a clipped,
opaque outer shell around the `88px` Dock and hides the right-hand panel
corners. The launcher rail inherits the shared Workbench Dock metrics (`43.2px`
icons and the canonical gap, badge, indicator, and separator geometry) through
`desktop-dock--fixed-metrics`; using Dock child classes without that metrics
owner lets intrinsic image sizes stretch the rail.

Do not set the Dock `BrowserWindow` type to `panel`: Electron 35 applies an
invalid macOS nonactivating-panel style and can report the Dock visible without
placing it on screen. Floating level and cross-Space behavior come from
`setAlwaysOnTop` and `setVisibleOnAllWorkspaces` instead.

The default collapsed bounds are `88x520`, centered vertically at the left edge
of the primary display work area. The renderer keeps an `8px` transparent inset
for elevation, leaving a `72px` visible panel and a `70px` content rail inside
its one-pixel border. This gives a `43.2px` icon roughly `13px` of visual space
on each side. The renderer constrains the collapsed surface to that `72px`
width, while main reconciles every reused Dock window to the current native
presentation width before showing it. This prevents renderer hot reload from
combining a compact rail with stale native bounds. Search expands the same
window inward to `420x520`; it does not create another panel. Dragged bounds and
display identity are persisted. On display removal or work-area changes, bounds
are clamped to an available display; an unavailable saved display falls back to
the primary display. When a saved Dock width differs after an upgrade or an
expanded-state restart, restoration preserves the nearest display edge instead
of reusing a stale left coordinate.

The Labs visibility choices are:

- always visible, which is the default
- automatically hide after focus leaves the Dock
- shortcut only

Regardless of that choice, the Dock's close control and `Command+W` both mean
Hide, not application quit. A hidden Dock is recoverable through the menu-bar
item, the global shortcut, or **Show Dock** in the system Dock menu.

### Canonical launchers

The collapsed Dock is a narrow launcher rail. It does not contain a persistent
window list or background-task panel.

Fusion resolves its entries from the same canonical Workspace launcher catalog
as the legacy Workbench Dock. The catalog merges contribution entries and
explicit host entries, then applies the shared section/order, retention,
visibility, launch payload, icon, badge, and dynamic-state rules. Installed
Workspace Apps come from the existing App Center projection and retain their
exact `appId` resource identity. Fusion must not maintain a parallel hardcoded
list of primary launch kinds or duplicate Workspace App installation state.

The rail reuses the existing Workbench Dock icon presentation, including any
border or squircle that belongs to the canonical icon asset itself; Fusion does
not wrap entries in another card. It keeps the live native-window count
separate from the unattached background-task count so the two lifecycles remain
visually distinguishable. These indicators are compact status signals, not
replacements for their authoritative sources. A launcher's normal click follows
the MRU/resource/new policy above. Its explicit **New Window** affordance always
creates another instance.

### Temporary search

The configured global shortcut behaves like a temporary command surface:

- hidden Dock -> show the Dock with search expanded
- visible narrow Dock -> expand search and focus its input
- expanded search -> hide the Dock on the next shortcut press

Leaving the expanded surface collapses it. In auto-hide and shortcut-only modes
the Dock then hides; in always-visible mode the narrow launcher rail remains.
`Escape` hides the Dock.

Search covers functions, canonical launchers and installed apps, live native
windows, daemon background resources, and resumable Agent sessions. With an
empty normal query it shows launch commands rather than a permanent dump of all
windows and tasks. **Background Tasks** in the menu-bar or system Dock menu
opens the same temporary search surface in a resource-only scope.

Search results can focus a window, reconnect a resource, create another
instance, close a window, stop a task, or open settings. `Enter` performs normal
activation for the selected result. `Cmd+Enter` or `Ctrl+Enter` performs an
explicit New Window action. For a selected background resource or its attached
Agent, terminal, or Workspace App window, New Window preserves the composite
resource identity and creates another view. For a launcher, it creates a fresh
independent instance in the Dock's current workspace.

Window counts come from the native registry. Task statuses come from daemon
responses. Search labels those states separately and includes workspace context
when more than one workspace is represented.

### Resident renderer duties

Periodic resource refresh runs only while the Dock is visible. Showing the
Dock performs full workspace discovery; fast polling then refreshes the current
workspace plus workspaces already represented by a live window or background
resource. Full discovery runs once per minute, with bounded workspace
concurrency.

Launcher activation may focus an existing MRU window immediately. When no live
window matches, it waits for any current resource refresh before choosing
between reconnect and new, including the first refresh after a hidden Dock is
shown. Explicit **New Window** remains independent of resource discovery.

Because Fusion Mode has no resident Workspace renderer, the Dock renderer owns
the small set of integrations that must stay alive independently of product
windows:

- managed-Agent readiness published as the `agentBound` Workspace App context
  value
- Agent outcome, waiting-approval, and interactive-prompt notifications
- installed Workspace App projection and native App-window launch binding
- compact application-update status and its primary action

Agent notification navigation matches
`(workspaceId, "agent", agentSessionId)`: it focuses the attached window or
reconnects that session in its owning workspace. The Dock maintains
notification owners only for its current workspace and workspaces represented
by an Agent resource or native Agent window. Standalone Agent and tool windows
must not duplicate these resident owners. Workspace Workbench keeps its
existing owners when Fusion Mode is disabled.

## macOS Entry Points

Fusion Mode creates one resident macOS menu-bar item:

- ordinary click toggles the floating Dock
- its menu offers **Show Dock**, **New Window**, **Background Tasks**,
  **Settings**, and **Quit Tutti**

Fusion also installs a contextual menu on the ordinary Tutti icon in the macOS
system Dock. It offers **Show Dock**, **New Window**, **Background Tasks**, and
**Settings**. macOS owns ordinary application Quit outside that supplemental
menu. Main handles these menu actions as window/desktop integration and does not
copy daemon task state into a native menu.

The Dock shortcut is stored as `workbenchShortcuts.toggleFusionDock`. An absent
value in an old preferences record migrates to `Meta+Shift+Space`; an explicit
`null` means unbound. Preference changes unregister the old accelerator and
apply the new accelerator and visibility policy without changing the active
desktop mode. Registration conflicts and invalid accelerators are reported
through typed Fusion state and localized in both narrow and expanded Dock
presentations.

Together these entry points provide three recovery paths after Hide:

1. invoke the configured global shortcut to show expanded search
2. click the menu-bar item, or choose its **Show Dock** item
3. open the Tutti system Dock menu and choose **Show Dock**

## Native Product Windows

Fusion product windows use the standard AppKit frame and title bar. They expose
native traffic lights and remain ordinary movable, resizable, minimizable, and
full-screen windows. They participate in display movement, per-window Spaces,
Mission Control, App Exposé, and macOS window cycling without a renderer-drawn
outer frame.

The macOS application menu uses Electron's native `windowMenu` role, so
minimize, zoom, front, and titled product-window selection follow system
behavior. Product windows are explicitly included in that menu and Mission
Control; the floating Dock is explicitly excluded. Renderer tools may retain
their useful in-content toolbar, but they must not render duplicate traffic
lights, outer title bars, modal backdrops, or dialog cards. Settings uses a
window presentation for the same reason.

Renderer shells update the native title with the current resource or content
title. Titles must distinguish multiple same-kind instances because macOS uses
them in the Window menu, Mission Control, and App Exposé.

Normal product-window bounds are persisted separately from floating-Dock
placement in `fusion-business-window-bounds.json`. The key is a workspace-scoped
`(kind, resourceId)` identity. Reopening a resource restores its last normal
size, position, and display; reopening a kind without an exact resource may use
that kind's fallback bounds. Explicit New Window cascades away from an occupied
restored origin. Display removal and work-area changes clamp normal windows to
an available display. Fusion temporarily caps the native minimum size to a
narrow target work area so Electron cannot re-expand restored bounds
off-screen. This does not force a maximized or full-screen window back to normal
state.

## Renderer, Preload, And Security Boundaries

All shells share one renderer bundle and a typed preload surface. Window intent
selects the shell:

- `view=workspace` -> Workspace Workbench
- `view=agent` -> detached/Fusion Agent window
- `view=fusion-dock` -> floating Dock
- `view=fusion-tool` -> one standalone Workbench contribution or settings

Fusion tool windows reuse existing Workbench contribution definitions and
domain services. They do not reimplement terminal, browser, files, App Center,
Workspace App, Issue Manager, or settings business behavior.

`desktopApi.fusion` is a narrow typed bridge for state subscription and
window/Dock operations. The main IPC adapter delegates to the coordinator.
Renderer code does not import Electron, and Electron main does not interpret
feature launch payloads beyond the minimum resource bootstrap fields required
by the selected renderer shell.

Electron main authorizes Fusion IPC by sender `WebContents`. The Dock is the
trusted cross-workspace coordinator; a tool window may update or focus only
itself and may open children only in its own workspace. Unknown senders,
malformed payloads, and unauthorized cross-workspace requests fail closed.
Privileged preload APIs are exposed only in the top-level frame, and every
typed IPC handler independently verifies that the caller is that sender's main
frame. A compromised or navigated child frame therefore cannot inherit desktop
authority from its containing window.

Each Workspace, Dock, and Fusion product `WebContents` is bound to one exact
renderer document URL, including its query-encoded window intent. Electron main
rejects every other top-level navigation and all redirects, denies popup window
creation, and may pass an explicitly safe HTTP(S) link to the operating system
browser. A renderer must never gain a different shell or resource authority by
changing its query parameters after its original load.

Workspace App and Browser webviews retain their existing guest security and
preload rules. Workspace Apps continue to use
`persist:tutti-app:<workspace>:<app>` partitions, so replacing a native window
does not create another app identity or session store. Main decodes this
partition defensively and requires its workspace identity to match the owning
native window before attachment, preload installation, or guest-context
signing; malformed encodings and cross-workspace partitions fail closed.

The browser guest-security layer carries validated attach parameters with the
matching `did-attach-webview` guest. It keys pending attachments by the exact
Electron `Session` object resolved from the requested partition, then matches
that object to `guestContents.session`; attachment order is not an identity.
Hosts must use that paired partition identity rather than a FIFO, because
ordinary browser and App webviews can attach concurrently in Workspace
Workbench mode. Missing or mismatched session identities fail closed.

## Close, Reload, And Quit

The two presentation modes intentionally have different view-close effects:

- Closing a Workspace Workbench terminal node runs its close guard and
  terminates the terminal, preserving existing behavior.
- Closing a Fusion terminal window releases its renderer lease and detaches
  transport. Explicit Stop performs termination.
- Closing a Fusion Agent or Workspace App window likewise removes only the
  view; daemon work continues.

Renderer code must not infer native close intent from `beforeunload`.
Development reload shortcuts remain main-owned and are enabled only for a
development renderer session.

`Cmd+Q` uses the desktop confirmation window. In Fusion Mode the first press
shows the Dock before sending the localized confirmation toast, so a hidden
Dock cannot make the feedback invisible. A second press within the confirmation
interval begins the normal quit path. The quit gate stops managed `tuttid` and
therefore its Agent turns, PTYs, and Workspace App runtimes before destroying
windows and exiting.

## Legacy Compatibility

When `lab.fusionMode=false`, startup, the Workspace Workbench shell, its Dock,
Workbench node close semantics, update behavior, and quit behavior stay on the
existing path. The legacy detached Agent window also keeps its renderer-drawn
frameless controls; native chrome is selected explicitly only for
Fusion-coordinated Agent and tool windows. Fusion renderer owners, Tray, global
shortcut, registry, and floating Dock do not become a second implementation of
Workspace Workbench.

## Deferred Application Identity

Phase one intentionally keeps one Electron application, one bundle identifier,
one system Dock icon, and many standard Tutti windows. macOS therefore groups
those windows under Tutti in App Exposé.

PWA-style installed launchers or App Shims may later give a stable Workspace
App or tool its own application identity, icon, and launch contract. Such a shim
would represent an installed app/tool, not one shim per transient window. Phase
one does not spawn multiple Electron applications or processes merely to fake a
separate system Dock icon for every native window.

## Ownership Rules

- `main/windows/*` owns Electron windows, the registry, Dock and product-window
  placement, menu-bar integration, system Dock menu, global shortcuts, and OS
  lifecycle integration.
- `main/ipc/*` is a thin typed adapter to that coordinator.
- `preload/api/*` exposes named Fusion capabilities, never generic channel
  invocation.
- Agent window intents expose only workspace, native-window, and optional
  daemon-resource identity to Electron main. The Agent launch payload remains
  opaque through IPC and main, then is validated and interpreted by the
  renderer-owned standalone Agent boundary.
- renderer features own UI-local composition and call existing domain clients.
- `tuttid` owns Agent, terminal, Workspace App, and workspace business truth.
- A native window descriptor is never proof that a background task exists, and
  a background task is never represented by a hidden native window.
