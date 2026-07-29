# Context

## Terms

### Workspace Catalog

Desktop renderer concept that owns the local workspace list, the current
workspace summary, workspace-window startup context, daemon health shown beside
workspace navigation, and catalog actions such as create, open, rename, delete,
and show-dashboard.

### Workspace Catalog Session

One workspace-scoped renderer module interface for Workspace Catalog behavior.
Dashboard and workspace-window views both consume this module. Workbench node
layout persistence is not part of this module.

### Workspace Workbench Session

Renderer concept that owns workbench node layout, snapshot load/save, and node
open/reveal behavior for one workspace window. It depends on Workspace Catalog
for the current workspace context but does not own catalog actions.

### Workbench Node Minimization

A presentation transition that removes a Workbench Node from the visible
workspace while retaining it as a restorable Dock entry. It does not close the
Node or change its display mode.

### Workbench Node Restoration

A presentation transition that returns a minimized Workbench Node from the Dock
to its prior visible Workbench state. It is not maximization or fullscreen.

### Restoration Animation Completion

The point at which a restoring Workbench Node's visual representation reaches
its visible workspace frame. It does not imply that the Node is ready for input.

### Restored Node Readiness

The point after Restoration Animation Completion when the restored Workbench
Node presents current content and can accept user input.

### Minimization Snapshot

An immutable visual capture retained for Workbench Node minimization and
restoration animation. It may be older than current business state and is not a
source of business truth.

### Genie Preview Fidelity

The visual similarity between a Minimization Snapshot and the corresponding
live Workbench Node. AgentGUI snapshots should preserve the full visible
structure and content as closely as practical; performance work must not
intentionally replace them with a skeleton or generic shell. Snapshot content
may still be stale.

### Restoration Snapshot Fallback

The recovery path used when an in-memory Minimization Snapshot is unavailable.
AgentGUI captures the restored live Node DOM when it exists; if it cannot
produce a texture, the Node becomes visible without a restoration animation.
Its persisted Dock preview is not a restoration texture source.

### Dock Preview

A decorative, non-interactive representation of a minimized Workbench Node.
AgentGUI Dock surfaces render the captured preview image from memory or
persistent cache. When no image is available, they render a placeholder rather
than mounting another AgentGUI tree.

### Browser Node

Reusable workspace workbench node capability for embedding HTTP and HTTPS browser
surfaces inside a desktop workspace. The Browser Node owns browser lifecycle,
navigation state, session/profile behavior, guest bridge mechanics, and webview
security policy. Product-specific actions exposed to guest pages are host
adapters, not Browser Node business logic.

### Agent Session Recording

A mutable capture task over one root Agent Session graph. A Recording produces
at most one Agent Session Cassette; failed or canceled Recordings produce none.
Its state is independent of any toolbar lifetime.
_Avoid_: UI recording, composer recording

### Agent Session Replay Run

One isolated execution of exactly one Agent Session Cassette. A Cassette may
have many Replay Runs. A Replay Run owns execution status and verification
outcome; its operational state may be discarded after the run is closed.
_Avoid_: replay terminal, replay button

### Agent Session Cassette

The minimal, immutable, portable output of a completed Agent Session Recording,
containing only the selected SessionGraph baseline, accepted external stimuli,
required provider tape, explicitly referenced blobs, and expected state. It
does not depend on the recording machine's database and never contains
unreferenced Workspace, Session, credential, log, or runtime data.
_Avoid_: recording state, replay state

### Agent Session Checkpoint

A stable Replay Run position that can be restored without inventing Agent,
provider, or canonical state. It is not an arbitrary UI cursor offset.

### Agent Session Replay Surface

An isolated developer surface that presents at most one active Agent Session
Replay Run. Restarting, moving backward, or switching Cassette replaces the
active Run instead of rewinding it.
_Avoid_: Replay Run window, replay terminal

### Agent Session Replay Playback State

The temporary playing, paused, seeking, or verifying state of an active Agent
Session Replay Run. It is not the Run's durable execution status or verification
outcome.
_Avoid_: Replay Run status, Agent Session status
