# Desktop Screenshot To Qute

The desktop can send an arbitrary rectangular screen region directly to an
Agent as a multimodal prompt. The Agent can optionally be instructed to create
and manage a Qute Task while it works. The default global shortcut is
`CommandOrControl+Shift+S`, and it works while another application has focus as
long as Tutti is running and can resolve a current or startup workspace. The
binding is adjustable in Settings → General: it persists as the
`captureScreenshot` workbench-shortcut preference, where null keeps the
built-in default rather than meaning unbound. The recorder and the
main-process accelerator resolver both require a Meta/Ctrl/Alt modifier, and
an unregisterable binding falls back to the last working accelerator so a bad
preference can never disable capture.

## Ownership And Flow

The feature follows the existing desktop/daemon boundary:

```text
Electron main process
  global shortcut -> display capture -> trusted selection crop
        |
        v
restricted capture preload + renderer
  region selection -> AgentGUI quick composer
        |
        v
workspace renderer
  existing AgentSessionEngine activation
        |
        v
Agent Host
  create Session + initial Turn from text and image blocks
```

- `apps/desktop` owns the operating-system shortcut, screen capture, crop,
  floating window, and narrow IPC bridge. The capture surface does not create a
  second activity Engine. Its main-process adapter sends typed launch requests
  to the renderer that already owns the workspace Engine.
- `packages/agent/gui` owns the reusable `quick-composer` entry. It reuses the
  canonical rich-text Composer, image preview, Agent Target selector, keyboard
  submission behavior, and localized copy while owning no Session lifecycle.
- `packages/workspace/issue-manager` owns the reusable Issue Manager contract,
  attachment presentation, and localized labels.
- `services/tuttid/service/workspace` owns validation, ContextRef lifecycle,
  and projection into an Issue Run launch. `services/tuttid/data/workspace`
  owns the managed attachment-file persistence adapter. The tuttid-local
  immutable launch snapshot and codec live in `services/tuttid/biz/workspace`
  so service and data share an explicit contract without exposing host paths
  through reusable workspace packages.
- `packages/agent/host` remains the lifecycle owner. Screenshot launch uses the
  existing `AgentSessionEngine.activateSession` path, which delegates to Host
  with provider-neutral text and image blocks. The separate explicit
  `startWorkspaceIssueRun` use case resolves attachments and creates the Issue
  Run plus a durable launch intent before the existing adapter delegates Agent
  session/turn creation to Host with provider-neutral text and image prompt
  blocks.

The capture targets the display nearest the pointer. Electron captures that
display before the transparent selection window is shown. The selection window
then enters native full-screen on that display; macOS uses simple full-screen so
the selector covers the menu bar and Dock without creating a separate Space.
Electron's `simpleFullscreen` constructor option selects the macOS full-screen
implementation but does not enter that state by itself. The capture adapter
therefore requests `fullscreen` and explicitly verifies or enters simple
full-screen before showing the selector. It records the selected display bounds,
work area, resulting window bounds, and native full-screen state so a future
WindowServer or Electron regression is diagnosable from Desktop logs.
After selection it exits full-screen before becoming the floating Composer.
On macOS, requesting `setSimpleFullScreen(false)` is not the exit boundary:
native fullscreen transitions are asynchronous. The adapter waits for
Electron's `leave-full-screen` event before changing resizability or bounds, so
the WindowServer cannot defer the compact geometry until a later Escape key.
This keeps the captured pixels and selection viewport on the same full-display
geometry instead of scaling the screenshot into the smaller work area. The
selected rectangle is cropped using the display scale factor, preserving
Retina/HiDPI pixels while the selection UI uses display-independent
coordinates. The shortcut contains exactly three keys and avoids shifted
number-row symbols, whose interpretation varies by keyboard layout. Agent
metadata loads concurrently with screen capture but does not delay showing or
leaving the selector. The first valid pointer-up freezes selection and
immediately changes the same native window into a compact preparing surface;
the metadata join controls only when the interactive Composer replaces that
surface. Renderer and main process both coalesce repeated selection requests.
Every native capture also has a unique capture ID, and every asynchronous
continuation must prove that ID still owns the active, live window before or
after changing native presentation. Replacing or cancelling a capture therefore
invalidates its pending metadata result instead of allowing a late result to
present a second floating Composer. The heavy AgentGUI Composer chunk is not
part of the selector's initial module graph. It starts preloading on pointer-down
so the drag interval hides most of the transition cost without delaying the
first capture frame.

The capture service retains only the most recently focused workspace identity,
not a renderer reference. If the user closes every visible Tutti window, the
next shortcut resolves that retained identity (or the daemon's startup
workspace) and asks `WorkspaceLaunch` to prepare an invisible standalone Agent
window as the workspace Engine owner. Composer metadata starts loading through
that owner concurrently with screen capture, so closing the main window does
not disable the shortcut or force a visible workspace window back onto the
screen. Main-process requests wait for an explicit renderer-ready signal emitted
only after the React workspace-external request handler is installed;
`did-finish-load` alone is not a sufficient application-readiness boundary.
Successful submission may then reveal that Agent window; cancellation leaves it
hidden. Submission activates with the external contract's `reveal` request, so
the workspace owner opens its Agent GUI on the created session before the
window is focused; a failed navigation never fails the activation result.

## Floating Composer

After selection, the same frameless window becomes a compact AgentGUI Composer.
The window is transparent from creation, removes outer padding that could reveal
the native background, and avoids a clipped CSS shadow at the window boundary.
The Composer window requests a `760 × 520` DIP surface and clamps that request
to the current display work area. This gives the portaled mention and Agent
menus enough usable height without allowing them to escape the native window.
Only the expanding title portion of the post-selection header is an Electron
drag region, so the full-screen selection surface stays fixed while the compact
Composer can move. The close action is a sibling outside that native hit-test
region, and editor controls remain no-drag regions. The drag region publishes
`grab`/`grabbing` cursor feedback instead of relying on the native drag region
alone. The
Composer uses its in-flow `embedded` layout; timeline-oriented dock overhang is
not valid inside the fixed native window. Portaled Composer menus receive the
header's viewport inset, so collision handling keeps Agent and mention menus
inside the usable window instead of placing them behind the title bar.
The screenshot host opts into the embedded Composer's full-height contract, so
the input surface consumes all space below the draggable header while
attachments and footer controls keep their intrinsic height. The TipTap surface
and content wrappers fill that editor row as well, making the whole empty area
a native input target rather than only the placeholder line. Other embedded
hosts remain content-sized unless they make the same explicit request. The
floating window owns the visible perimeter, so this host also selects the
Quick Composer's borderless input-surface variant instead of rendering a
redundant nested outline.

The capture host does not override the Composer placeholder; it uses the same
AgentGUI-owned default wording as the normal new-conversation Composer. The
main-process window adapter persists only the last manually dragged Composer
coordinates in the Desktop user-data directory. Later captures restore that
position and clamp it into the active display work area, so a removed monitor
or changed resolution cannot place the Composer off-screen. Before the first
manual move, selection-relative placement remains the fallback. This placement
record is native presentation state, not an AgentGUI preference or business
fact.

The screenshot appears as an image draft block. The user chooses an Agent,
adds or edits prompt text, and sends with the Composer button or its existing
keyboard behavior. Send creates and starts a visible Agent Session; it does not
create an Issue directly.

The bottom toolbar keeps `+`, `@`, the exact Agent Target selector, the project
selector, the **Create Task and track** switch, and the primary send action on
one alignment baseline. The Quick Composer hides the connector capability
control: quick-composer hosts expose no capability-settings channel, so it
could only render as a dead trigger and pushed the toolbar onto a second line. The project selector reuses AgentGUI's canonical
no-project/existing-project control. The capture preload proxies the workspace
owner's real `WorkspaceUserProjectApi` for catalog reads, selection preparation,
and project registration; only the directory dialog itself remains native to
the capture window. Quick Composer never fabricates a directory-only catalog.
The switch is a submit modifier, not an editor mutation. When selected, the capture
controller prepends a localized
instruction to the typed Agent prompt only at submission, while the visible
draft and transcript display prompt remain the user's own text. The instruction
requires the Agent to create a Qute Task as the work record, immediately carry
out the request, and keep the Task status and notes updated; creating the Task
is not a terminal action. This preserves one Agent execution path and does not
give the desktop capture surface a second Task workflow.

The Quick Composer's `+` control opens the operating system's native file
picker through the existing desktop file-dialog adapter. The restricted capture
preload returns only the selected local-file references, which re-enter the
canonical Composer as ordinary file mentions. The `@` control continues to use
the workspace owner rather than a capture-local reference catalog: its typed
`at.query`, `at.queryDirectory`, and `at.resolve` requests travel through the
existing workspace external bridge.

The selected Agent Target is remembered per workspace in a versioned capture UI
preference. A later capture restores the exact Target only while it remains in
the ready catalog; a deleted or unavailable Target falls back to the first ready
entry. The selected project path is remembered by a separate versioned,
workspace-scoped capture preference; choosing no project clears it. Submission
passes a non-empty selected path as the existing activation `cwd`, so the
workspace Engine and Agent Host remain the only Session lifecycle owners.
Storage failures remain non-blocking and never prevent capture. The native title
is the product name, `Tutti`, in every locale.

If Agent activation fails, the composer stays open with its draft intact so the
user can retry. Escape is observed at the window capture phase so a portaled
Composer menu cannot consume it before the window; Escape and the close button
cancel before submission. Cancellation destroys this ephemeral BrowserWindow
instead of permitting renderer close handlers to strand it in a closing state.
When the shortcut was invoked from another application on macOS, cancellation
destroys the capture window first and hides Tutti from the window's `closed`
event, so a hidden-but-live capture cannot swallow the next shortcut. A
closing, destroyed, or unexpectedly hidden capture is replaced rather than
focused. A repeated shortcut while a live capture remains visible focuses that
same capture; it does not create another selector. A shortcut invoked from a
focused Tutti window keeps Tutti active. At least one ready Agent is required.
The capture window closes only after the workspace Engine confirms activation.
The main process then restores macOS's regular application activation policy,
unhides and foregrounds Tutti, and finally shows and focuses the workspace
window. Application activation and window focus are one shared host operation;
showing a `BrowserWindow` alone is not a sufficient menu-bar or Dock contract.
Like cancellation, the submitted window is destroyed rather than closed, so a
renderer close handler cannot strand a submitted capture on screen.

## Attachment Contract And Storage

The Issue Manager attachment contract remains available for Task workflows
created by Agents or other callers. `CreateIssueManagerIssueRequest.attachments`
accepts up to eight inline PNG,
JPEG, or WebP images. Each decoded image is limited to 20 MiB. `tuttid`
validates the declared MIME type against the file signature, allocates or
validates a UUID, and creates the restricted file exclusively so a supplied ID
can never overwrite an existing attachment.

Attachment metadata uses the existing ContextRef relationship instead of a
parallel attachment model:

- `refType` is the image MIME type;
- `displayName` is shown in Issue and Task attachment sections;
- `contextRefId` is prefixed with `attachment-`;
- public responses set `accessKind` to `managed_attachment` and omit `path`.

Inside `tuttid`, the persistence adapter retains the daemon-managed absolute
source path for validation, cleanup, and Agent delivery. That path does not
cross the Issue Manager or reusable package boundary. A host opens a managed
attachment by its workspace, Issue, and ContextRef IDs, fetches validated bytes,
materializes them in its own trusted attachment store, and opens the local copy.
Ordinary project files use `accessKind: workspace_path`. This makes the same
contract safe for local Desktop and VM consumers whose filesystem roots differ.
`tuttid` service orchestration classifies managed access through the concrete
attachment adapter's safe-path policy; the HTTP mapper never guesses from a
caller-controlled ContextRef ID or MIME type.

Issue-level images are inherited by each Issue Run. Task-level image ContextRefs
are appended for task Runs. The Issue adapter projects both as
`PromptContentBlock{Type: "image"}` alongside the textual prompt. The existing
Agent prompt attachment store then copies each validated source into the
session-scoped attachment directory before provider preparation.

Deleting the Issue or Task is rejected while its explicit launch intent is
prepared or leased; after delivery resolves, deleting the Issue, Task, or
individual ContextRef removes only files inside the daemon-managed Issue
attachment root. External ContextRef paths are never deleted. Cleanup failures are returned instead of discarded. Image bytes are
staged first, then the Issue, all image ContextRefs, and topic activity are
committed in one SQLite transaction. A failed transaction removes the staged
files; a committed Issue is therefore never visible without its attachments.
Before the daemon serves requests, the file adapter reconciles the managed root
against SQLite ContextRefs and removes files orphaned before the transaction,
plus cleanup left behind by a prior delete. This reconciliation runs before
Agent Host and background workers start. Attachment files are synced on all
platforms; directory-entry syncing is used where supported and is intentionally
a no-op on Windows, where portable directory `fsync` is unavailable. ContextRef
removal and Run admission share the Issue mutation lock. Automatic Runs retain
a transient attachment pin until the Agent adapter has copied each source;
explicit prepared and leased intents retain a durable pin across retry and
restart.

The explicit create-and-run path atomically commits any required implicit Task,
the Run, and a prepared launch intent containing stable Agent
session/client-submit identities plus an immutable prompt and attachment-path
snapshot. Preparation is side-effect free; if intent admission fails, no Task,
Run, or Issue projection survives. Prepared or leased snapshots pin their
managed attachment files even if the user later edits the Issue or removes its
ContextRef. Delivery first leases that intent. A confirmed delivery marks it
dispatched; authoritative evidence that no Agent turn started settles the
intent, Run, task projection, Issue projection, and topic activity in one
transaction. An unknown delivery result releases it to prepared instead of
falsely failing the task. Startup and periodic workspace recovery re-deliver
the snapshot with the same identities, so Agent Host can reconcile or
deduplicate the attempt. The same recovery pass retries automatic Issue
dispatch after transient ContextRef reads. If a parallel pass already committed
earlier Runs before a later lookup fails, those Runs are still published and
delivered before the error is retried, so no running claim is stranded.

The plan-materialization request uses a separate issue schema without inline
attachments. This prevents the API from accepting attachment bytes that the
atomic Issue-and-task materializer does not own.

Agent image capability and Composer options are resolved with the same target,
controlled settings draft, and selected project directory (`cwd`) signature
used by the full Composer. The capture controller delegates that settings
policy to the shared `composer-settings-core`: the core owns the sparse
draft, a revision-fenced options lifecycle, and last-good retention, so a
failed or slow refresh never blanks the model menu, and only the first load
for a target locks settings and submit. Display seeds from the daemon's
defaults-merged `effectiveSettings` — the same per-target composer-defaults
ledger the full Composer reads — and explicit picks are written back to that
ledger through the workspace owner (`agentActivity.rememberComposerDefaults`),
so a capture pick is remembered exactly like a main-composer pick. Submission
always carries the core's resolved settings — the values the panel displays —
so the daemon never re-interprets empty fields against another surface's
memory; the main process logs the submitted settings as the durable record of
what the panel showed. Both refresh and submit query only the selected
target, so an unrelated VM-backed target cannot delay the active local
target, and the selected target's capabilities derive from the same fenced
options snapshot. Main re-resolves the selected target with the actual
settings and `cwd` immediately before activation, so a stale renderer
snapshot cannot send an image to a text-only effective model.

## Open-Source Component Evaluation

The implementation uses Electron's built-in APIs and adds no screenshot
dependency:

- [Electron `globalShortcut`](https://www.electronjs.org/docs/latest/api/global-shortcut)
  provides operating-system shortcuts while Tutti is unfocused.
- [Electron `desktopCapturer`](https://www.electronjs.org/docs/latest/api/desktop-capturer)
  returns display sources and full-resolution thumbnails. `NativeImage.crop`
  performs the trusted main-process crop.

The following open-source options were evaluated:

| Option                                                                                                                | Strength                                                                                  | Reason not selected                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [`nashaofu/screenshots`](https://github.com/nashaofu/screenshots) (`electron-screenshots` + `react-screenshots`, MIT) | Ready-made region editor with arrows, shapes, text, mosaic, and i18n                      | Brings a second React editing surface plus `node-screenshots`; this first slice needs selection and Qute composition, not annotation tooling  |
| [`nashaofu/node-screenshots`](https://github.com/nashaofu/node-screenshots) (MIT)                                     | Native cross-platform capture, including macOS, Windows, X11, and Wayland implementations | Native/Rust binding increases packaging, ABI, signing, and architecture verification work while Electron already supplies the required pixels |
| [`bencevans/screenshot-desktop`](https://github.com/bencevans/screenshot-desktop) (MIT)                               | Small Promise API for full displays                                                       | It captures whole displays rather than owning region selection, and its Linux path requires an external screenshot utility                    |

`nashaofu/screenshots` is the preferred follow-up if Qute later needs rich
annotation before submission. For the current interaction, Electron primitives
keep the capture path inside the already shipped runtime and let the floating
composer reuse Tutti's UI System.

## Platform Notes

- macOS requires Screen Recording consent for desktop capture.
- On Linux, Electron documents that PipeWire may expose only one selected
  source. Wayland global shortcuts additionally depend on the environment's
  shortcut portal support.
- Global shortcut registration can fail when another application owns the same
  accelerator. The desktop logs that failure and re-registers the previous
  working accelerator (or the built-in default) so capture stays reachable.
  The accelerator is a durable user preference under Settings → General.
- Region selection currently stays within the display nearest the pointer when
  the shortcut is pressed; it does not span display boundaries.
