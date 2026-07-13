# Workspace Terminal

This document records the intended frontend and host boundary for workspace
terminal nodes shared by the personal Tutti desktop and the collaborative TSH
desktop.

The key architectural decision is:

- the terminal workbench experience is shared
- the terminal execution substrate is host-specific

Tutti should run local host terminals. TSH should keep running terminals in its
managed VM/runtime path.

## Decision Summary

This migration has three parallel goals for the current Tutti landing:

1. preserve TSH terminal behavior as reference material by porting first into a
   package-internal quarantine
2. extract only host-agnostic terminal behavior into
   `@tutti-os/workspace-terminal`
3. prove the shared package through the Tutti local-terminal vertical before
   treating the package API as stable

Decisions already made:

| Topic              | Decision                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| Shared scope       | Share terminal UI/runtime mechanics, not process execution.                                         |
| Tutti execution    | Run local pty sessions through `services/tuttid`.                                                   |
| TSH execution      | Keep VM, guest-agent, relay, room, and collaboration behavior in TSH adapters.                      |
| Session identity   | A terminal workbench node cannot switch to another `sessionId`. New process means new session/node. |
| Close semantics    | Close terminates the terminal session; if work is running, ask through close guard first.           |
| Minimize semantics | Minimize hides the node and keeps the session running.                                              |
| Agent terminal     | Agent terminal is a specialization/wrapper around terminal, not a branch in terminal core.          |
| WebGL renderer     | Omit from V1; reserve only a future narrow option if an active host needs it.                       |
| Drag/drop          | Shared UI exposes a hook; host decides accepted payloads, path mapping, and shell quoting.          |
| Diagnostics        | Shared package emits product-neutral events; hosts decide logging sinks.                            |

The current landing stops at the Tutti local-terminal vertical. TSH adoption is
documented only as a future integration shape, not as work required before this
branch can be considered complete.

The Tutti landing now has implementation and verification evidence. Future
work should reopen these architecture decisions only when implementation or
runtime evidence exposes a concrete mismatch.

## Context

Both Tutti and TSH are expected to use the shared workbench surface as their
workspace shell. They differ in where terminal commands actually execute:

| Host  | Product mode                    | Execution authority                                                         |
| ----- | ------------------------------- | --------------------------------------------------------------------------- |
| Tutti | personal local-first desktop    | the user's local machine, shell, environment, and default working directory |
| TSH   | collaborative workspace desktop | the managed VM/runtime and guest-agent terminal stream                      |

The shared code should therefore sit above the execution boundary. It should own
the terminal node experience and state machine, but not the process launcher.

## Layer Model

```text
packages/workbench/surface
  WorkbenchHost, dock, frame, layout, shell snapshot, instance resolution,
  intent routing, and external-state render plumbing.

packages/workspace/terminal
  Shared terminal contracts, xterm surface, renderer runtime state, hydration,
  scrollback, input queue, default terminal copy, and workbench node helpers.

apps/desktop terminal adapter
  Tutti-specific workbench registration, tuttid client wiring, local pty
  session creation, file-link handling, app i18n merge, and user-facing host
  integration.

apps/tsh-desktop terminal adapter
  TSH-specific workbench registration, desktopd client wiring, VM transport,
  room/collaboration metadata, runtime-lost projection, and agent/room behavior.

services/tuttid terminal service
  Local host pty session lifecycle, output replay, snapshots, resize/write,
  and WebSocket attach for Tutti.

tsh desktopd/runtime
  VM, guest-agent, relay, routing, and collaborative terminal execution.
```

`packages/workbench/*` must not learn about terminal semantics.
`WorkbenchHost` can own generic shell behavior such as node instance resolution,
intent targeting, frame layout, dock state, and shell snapshot persistence. It
should only consume terminal behavior through host-provided
`WorkbenchHostNodeDefinition` objects and optional `externalStateSource`
lookups.

`packages/workspace/terminal` should not learn whether a session is backed by a
local pty, VM stream, remote SSH session, or another host-owned source.

## Current Execution State

The Tutti vertical is implemented and verified. The package, daemon API, and
desktop adapter exist, and the terminal node is a real xterm surface registered
in `apps/desktop`. Electron runtime passes have verified the local terminal
path, including the idle and foreground-command close semantics.

| Area                    | State                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package skeleton        | Done                          | `packages/workspace/terminal` exports contracts, React, workbench, i18n, and CSS entrypoints.                                                                                                                                                                                                                                                                                                                                                                     |
| TSH quarantine          | Removed                       | The temporary copied TSH terminal renderer source has been deleted after the Tutti V1 shared package surface landed.                                                                                                                                                                                                                                                                                                                                              |
| Ledger                  | Folded back                   | Durable package-boundary decisions now live in this document instead of a package-internal quarantine ledger.                                                                                                                                                                                                                                                                                                                                                     |
| Shared contracts        | Done                          | Transport, launch, close guard, diagnostics, link, drop, output transform, limits, theme, and external state contracts exist.                                                                                                                                                                                                                                                                                                                                     |
| Pure shared helpers     | Done for V1                   | Scrollback, string overlap, dimensions, session projection, link detection, close flow, and screen cache helpers have package-local tests.                                                                                                                                                                                                                                                                                                                        |
| tuttid HTTP routes      | Implemented for V1            | OpenAPI, generated clients, and handlers exist for list/create/get/terminate/close-guard/resize/snapshot.                                                                                                                                                                                                                                                                                                                                                         |
| tuttid WebSocket attach | Implemented for V1            | The route now upgrades through a custom route because strict generated handlers do not receive `http.ResponseWriter` and `*http.Request`. It supports `input`, `resize`, `detach`, `ping`, replay after `afterSeq`, live output, and exit/error frames.                                                                                                                                                                                                           |
| Shared xterm surface    | Runtime verified for Tutti V1 | `TerminalNode` mounts xterm with fit/search/serialize/web-links addons, hydrates from snapshot, attaches by `afterSeq`, writes transport output through a bounded scheduler, queues input until attach, sends resize, exposes find UI with case-sensitive and regex options, routes drops through the host hook, detects URL and file-path links, uses the committed screen-state cache on remount, and has a shared close-guard dialog for direct header closes. |
| Desktop adapter         | Runtime verified for Tutti V1 | `apps/desktop` registers the terminal node and maps tuttid HTTP/WebSocket APIs into launch, snapshot, write, resize, detach, terminate, close-guard, default workbench close, URL/file link handling, and drop-input contracts. Runtime testing verified launch, requested/default cwd behavior, input/output, minimize, remount, stale-session projection, and close guard.                                                                                      |
| TSH adapter             | Out of scope for this landing | TSH can adopt the package later, but this plan does not require migrating TSH now.                                                                                                                                                                                                                                                                                                                                                                                |

Post-landing follow-up order:

1. harden any new edge cases found from continued desktop use, especially
   replay, backpressure, close-guard precision, and stale-session UX
2. keep future TSH adoption work in host adapters or wrappers instead of
   restoring copied renderer source
3. leave TSH adapter migration to a later, separate plan

## Shared Package Boundary

The shared package is named by responsibility and exported as
`@tutti-os/workspace-terminal`.

Current public entrypoints:

```text
@tutti-os/workspace-terminal
@tutti-os/workspace-terminal/contracts
@tutti-os/workspace-terminal/react
@tutti-os/workspace-terminal/workbench
@tutti-os/workspace-terminal/i18n
@tutti-os/workspace-terminal/styles.css
```

The root export should stay narrow. It should expose the stable package-level
contract and high-level React/workbench helpers, not internal implementation
files.

The package may own:

- terminal transport TypeScript contracts
- terminal node external-state and launch intent contracts
- xterm lifecycle and renderer setup
- terminal attach, detach, hydration, and replay state machines
- scrollback, committed-screen-state, input queue, resize, find, and link
  helpers
- optional React body/header components for a workbench terminal node
- a helper that creates a `WorkbenchHostNodeDefinition`
- narrow default i18n resources for shared terminal UI
- package-local structural styles needed by the shared terminal surface

The package must not own:

- tuttid or desktopd client construction
- Electron preload calls
- WorkbenchHost snapshot repository construction
- local host pty spawning
- TSH VM, guest-agent, relay, or LD_PRELOAD routing behavior
- room, collaboration, or agent-provider business rules
- product-specific copy, toasts, settings, or permission policy
- durable daemon storage

## Public API

The package exposes one small public surface with multiple entrypoints. Type
names may still evolve during V1 verification, but only when runtime evidence
shows the current contract does not fit a real host integration.

Current and intended stable exports:

```text
@tutti-os/workspace-terminal
  closeTerminalSession
  createTerminalNodeFeature
  defaultTerminalNodeLimits
  type TerminalNodeFeature

@tutti-os/workspace-terminal/contracts
  terminal transport, launch, close guard, diagnostics, link, drop, and state
  contracts

@tutti-os/workspace-terminal/react
  TerminalNode
  TerminalNodeHeader
  TerminalCloseGuardDialog

@tutti-os/workspace-terminal/workbench
  createTerminalWorkbenchNodeDefinition
  createTerminalWorkbenchLaunchHandler
  defaultTerminalWorkbenchTypeId

@tutti-os/workspace-terminal/i18n
  terminalNodeI18nResources
  createTerminalNodeI18nRuntime
```

The root export should be enough for ordinary host integration. Deep entrypoints
exist to keep workbench, React, contracts, and i18n dependencies explicit.

### Feature Factory

The terminal package should be configured through a feature object, following
the same broad pattern as the Browser Node package:

```ts
export interface CreateTerminalNodeFeatureInput {
  closeGuard: TerminalCloseGuardService;
  diagnostics?: TerminalDiagnostics;
  dropInput?: TerminalDropInputResolver;
  i18n?: I18nRuntime<string>;
  launchService: TerminalLaunchService;
  limits?: TerminalNodeLimits;
  linkHandler?: TerminalLinkHandler;
  outputTransform?: TerminalOutputTransform;
  resolveTheme?: TerminalThemeResolver;
  transport: TerminalTransport;
}

export interface TerminalNodeFeature {
  closeGuard: TerminalCloseGuardService;
  diagnostics: TerminalDiagnostics;
  dropInput?: TerminalDropInputResolver;
  i18n: TerminalNodeI18nRuntime;
  launchService: TerminalLaunchService;
  limits: TerminalNodeLimits;
  linkHandler?: TerminalLinkHandler;
  outputTransform?: TerminalOutputTransform;
  resolveTheme: TerminalThemeResolver;
  transport: TerminalTransport;
}

export function createTerminalNodeFeature(
  input: CreateTerminalNodeFeatureInput
): TerminalNodeFeature;
```

Feature creation should not create sessions, attach transports, read globals, or
construct daemon clients. It only normalizes host capabilities for the shared
terminal surface.

### Launch And Lifecycle

Session creation and termination are host-owned:

```ts
export interface TerminalLaunchInput {
  cwd?: string | null;
  initialInput?: string | null;
  profileId?: string | null;
  reason: "dock" | "intent" | "restore";
  workspaceId: string;
}

export interface TerminalSessionDescriptor {
  cwd: string | null;
  profileId: string | null;
  runtimeKind: TerminalRuntimeKind;
  sessionId: string;
  status: TerminalSessionStatus;
  title: string;
}

export interface TerminalLaunchService {
  create(input: TerminalLaunchInput): Promise<TerminalSessionDescriptor>;
  get?(sessionId: string): Promise<TerminalSessionDescriptor | null>;
  terminate(input: { sessionId: string }): Promise<void>;
}
```

The shared package may call `create(...)` when a workbench dock item launches a
new terminal. Closing a terminal calls host-provided close guard and termination
capabilities; it must not be implemented as transport `detach(...)`.

### Close Guard

Closing a terminal means terminating the session. The shared UI owns the
confirmation flow, while the host owns process inspection and termination:

```ts
export type TerminalCloseGuardReason =
  | "foreground-process"
  | "not-running"
  | "running"
  | "unknown";

export interface TerminalCloseGuardResult {
  leaderCommand?: string | null;
  reason: TerminalCloseGuardReason;
  requiresConfirmation: boolean;
  status: TerminalSessionStatus;
}

export interface TerminalCloseGuardService {
  check(input: { sessionId: string }): Promise<TerminalCloseGuardResult>;
}
```

### Links, Drops, Diagnostics, And Output Hooks

Small extension hooks let hosts keep product policy outside the terminal core:

```ts
export interface TerminalLinkTarget {
  column?: number;
  line?: number;
  path?: string;
  url?: string;
}

export interface TerminalLinkHandler {
  open(target: TerminalLinkTarget): Promise<void> | void;
}

export interface TerminalDropInput {
  cwd: string | null;
  dataTransfer: DataTransfer;
  sessionId: string;
}

export type TerminalDropInputResolver = (
  input: TerminalDropInput
) => Promise<string | null> | string | null;

export type TerminalOutputTransform = (input: {
  data: string;
  sessionId: string;
}) => string | null;

export type TerminalDiagnosticEvent =
  | "attach-complete"
  | "attach-error"
  | "attach-start"
  | "close-confirmed"
  | "close-requested"
  | "dispose"
  | "hydration-complete"
  | "hydration-gap"
  | "hydration-start"
  | "mount"
  | "resize"
  | "snapshot-complete"
  | "snapshot-start"
  | "write-error";

export interface TerminalDiagnostics {
  log(
    event: TerminalDiagnosticEvent,
    details?: Record<string, string | number | boolean | null>
  ): void;
}
```

Diagnostics must avoid raw terminal input, environment values, tokens, and other
secrets. Output transforms are optional and host-provided; the shared package
must not bake in TSH agent or query cleanup rules.

### Workbench Helper

Workbench integration should be thin helpers around the current
`WorkbenchHost` model:

```ts
export interface CreateTerminalWorkbenchNodeDefinitionInput {
  dockIcon?: ReactNode;
  feature: TerminalNodeFeature;
  frame?: WorkbenchFrame;
  title?: string;
  typeId?: string;
}

export function createTerminalWorkbenchNodeDefinition(
  input: CreateTerminalWorkbenchNodeDefinitionInput
): WorkbenchHostNodeDefinition<TerminalWorkbenchIntent>;

export function createTerminalWorkbenchLaunchHandler(
  input: CreateTerminalWorkbenchLaunchHandlerInput
): (
  request: WorkbenchHostLaunchRequest
) => Promise<WorkbenchHostLaunchResult | null>;
```

The node-definition helper creates a multi-instance `WorkbenchHostNodeDefinition`
and renders the shared terminal body/header. The launch handler is optional but
recommended for host integration: it plugs into `WorkbenchHost`'s
`onLaunchRequest`, calls `TerminalLaunchService.create(...)`, and stores the
returned stable `sessionId` in both `instanceId` and `instanceKey`.

This split matches the current `packages/workbench/surface` API. A node
definition does not directly receive dock launch requests; launch authority is a
host-level `WorkbenchHost` callback. Neither helper should construct the
Workbench snapshot repository or own product routing.

## Transport Contract

The shared terminal surface should depend on a host-provided transport instead
of directly calling `window` globals or daemon clients.

```ts
export type TerminalRuntimeKind = "local" | "vm" | "remote" | string;

export type TerminalWriteEncoding = "utf8" | "binary";

export interface TerminalTransport {
  attach(input: TerminalTransportAttachInput): Promise<void>;
  detach(input: TerminalTransportDetachInput): Promise<void>;
  write(input: TerminalTransportWriteInput): Promise<void>;
  resize(input: TerminalTransportResizeInput): Promise<void>;
  snapshot(input: TerminalTransportSnapshotInput): Promise<TerminalSnapshot>;
  onData(listener: (event: TerminalDataEvent) => void): () => void;
  onExit(listener: (event: TerminalExitEvent) => void): () => void;
  onMetadata?(listener: (event: TerminalMetadataEvent) => void): () => void;
  onState(listener: (event: TerminalStateEvent) => void): () => void;
}

export interface TerminalTransportAttachInput {
  sessionId: string;
  clientId?: string;
  afterSeq?: number;
}

export interface TerminalTransportDetachInput {
  sessionId: string;
}

export interface TerminalTransportWriteInput {
  sessionId: string;
  data: string;
  encoding?: TerminalWriteEncoding;
  provenance?: "user" | "auto";
}

export interface TerminalTransportResizeInput {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalTransportSnapshotInput {
  sessionId: string;
}

export interface TerminalSnapshot {
  data: string;
  fromSeq?: number;
  toSeq?: number;
  truncated?: boolean;
  updatedAt?: number;
}

export interface TerminalMetadataEvent {
  sessionId: string;
  cwd?: string | null;
  profileId?: string | null;
  resumeSessionId?: string | null;
  runtimeKind?: TerminalRuntimeKind;
  title?: string | null;
}
```

The transport may be backed by HTTP plus WebSocket, direct IPC, or another
host-owned stream. The package should only rely on the interface.

Recommended stream frame semantics for daemon-backed hosts:

Server-to-client frames:

| Frame      | Meaning                                                              |
| ---------- | -------------------------------------------------------------------- |
| `output`   | terminal output chunk with optional sequence number                  |
| `state`    | session state update such as running, detached, exited, or failed    |
| `metadata` | title, cwd, profile, runtime, or other non-secret session metadata   |
| `gap`      | replay could not provide all requested sequence numbers              |
| `exit`     | terminal process exited with an exit code or signal                  |
| `error`    | attach or stream failure that should be surfaced through diagnostics |

Client-to-server frames:

| Frame    | Meaning                                                     |
| -------- | ----------------------------------------------------------- |
| `input`  | terminal input bytes from the renderer                      |
| `resize` | terminal dimensions in columns and rows                     |
| `detach` | renderer stream is going away; do not terminate the session |
| `ping`   | optional liveness probe if the host transport needs one     |

This frame shape is already close to the TSH desktop transport and is a good
candidate for reuse by tuttid, but the shared React package should consume the
typed transport events, not raw WebSocket frames.

Close is intentionally not a stream frame. Closing a workbench terminal flows
through `TerminalCloseGuardService.check(...)` and
`TerminalLaunchService.terminate(...)` so that close and detach cannot be
confused.

## Session State Contract

Current `WorkbenchHost` snapshots store shell state: nodes, frames, stack order,
display mode, and `WorkbenchHostNodeData` fields such as `typeId`,
`instanceId`, and `instanceKey`. They should not become the durable store for
terminal process state, scrollback, host runtime metadata, or product business
state.

The shared terminal package should define a portable terminal session state
shape that can be read from package runtime state, a host-owned
`externalStateSource`, or a host-backed session repository. A workbench node may
use `instanceKey` for a stable terminal session id or launch key, but the
terminal state itself remains outside the generic Workbench snapshot.

A terminal workbench node must not switch to a different terminal session after
it has been bound. The `sessionId` is part of the node identity. If the backing
process exits or is lost, the node should project that terminal state rather
than silently reusing the same node for a new process. Opening a new terminal
creates a new session and, for multi-instance workbench integration, a new
terminal node or instance.

```ts
export type TerminalSessionStatus =
  | "created"
  | "starting"
  | "running"
  | "detached"
  | "exited"
  | "failed";

export interface TerminalNodeExternalState<
  THostMetadata extends Record<string, unknown> = Record<string, unknown>
> {
  sessionId: string | null;
  title: string;
  cwd: string | null;
  profileId: string | null;
  runtimeKind: TerminalRuntimeKind;
  status: TerminalSessionStatus;
  createdAt: string | null;
  updatedAt: string | null;
  endedAt: string | null;
  lastError: string | null;
  host: THostMetadata | null;
}
```

Scrollback and replay data should flow through `TerminalTransport.snapshot(...)`
or a host-owned terminal session store, not through `WorkbenchHost` node data.

Tutti host metadata can include local profile details such as shell path or
environment profile id.

TSH host metadata can include room id, agent provider hints, runtime session
metadata, or collaborative context. Those fields should remain host-owned unless
both products need the same behavior through the shared package.

## Recovery Model

The shared package should follow TSH's recovery split:

- the host daemon owns live terminal truth, including session state, process
  lifecycle, output sequencing, ring-buffer replay, and snapshot reads
- the renderer or app persistence layer may keep node hints, shell layout, and
  optional scrollback placeholders for a smoother reopen
- a reopened renderer should match persisted terminal node hints to live daemon
  sessions by `sessionId`; unmatched runtime hints are stale and must not be
  treated as live terminals
- a host may preserve scrollback for display after a session is gone, but that
  is not the same as restoring the process

Tutti should mirror this model for the first implementation. `tuttid` should
own live local pty sessions and output replay. Workbench snapshots should
recover shell layout. Any durable terminal history beyond the live daemon
session should be modeled as terminal history or placeholder state, not as proof
that the original process still exists.

## Agent Specialization

Agent nodes should be modeled as a specialization of terminal behavior rather
than as a branch inside the shared terminal core. The terminal package should
not learn agent providers, room collaboration, agent resume rules, or provider
session recovery.

If shared agent-terminal behavior becomes necessary later, build it as a wrapper
around `@tutti-os/workspace-terminal`: the wrapper can translate agent launch,
resume, provider status, and product metadata into terminal feature inputs while
leaving the core terminal surface host-agnostic.

The wrapper may own agent launch commands, provider settings, resume metadata,
agent-specific status projection, history placeholders, room/task/issue
linkage, and product chrome. It should compose the terminal package through
generic extension points such as launch services, external state, close guards,
diagnostics, title/status mapping, and optional header accessories. The terminal
core must not expose provider-specific branches such as `agentProvider` or
agent resume policy.

## Workbench Integration Contract

The shared package should provide a helper that creates a terminal node
definition for `WorkbenchHost`, while the consuming host supplies all authority
and integration points.

```ts
const terminalFeature = createTerminalNodeFeature({
  closeGuard,
  diagnostics,
  dropInput,
  i18n,
  launchService,
  linkHandler,
  resolveTheme,
  transport
});

createTerminalWorkbenchNodeDefinition({
  feature: terminalFeature,
  typeId: "workspace-terminal"
});

const onLaunchRequest = createTerminalWorkbenchLaunchHandler({
  feature: terminalFeature,
  typeId: "workspace-terminal"
});
```

The helper should return a `WorkbenchHostNodeDefinition` with shared body/header
rendering. The launch handler should be passed to `WorkbenchHost` or composed
inside the host's existing launch callback. The host remains responsible for
adding the definition to its workbench host service, passing any needed
`externalStateSource` to `WorkbenchHost`, and deciding when to launch or focus a
terminal.

Host responsibilities:

- create terminal sessions
- decide initial cwd and profile
- map daemon session state into terminal external state or package runtime state
- persist WorkbenchHost shell snapshots through the existing host repository
- persist terminal session state separately when a host needs durable terminal
  recovery beyond shell layout
- implement close-guard checks and terminal termination behind the shared close
  flow
- open file links in the host's file manager or editor surface
- merge package i18n defaults into the app-level runtime
- handle product-specific errors and notifications

## Tutti Local Terminal Path

Tutti uses local host pty terminals.

`services/tuttid` owns:

- local pty process lifecycle
- session ids and state transitions
- workspace-scoped session ownership without a catalog-stored host-path lookup
- cwd resolution from an explicit request or the daemon's default local home
  directory
- environment/profile selection policy
- output ring buffer and sequence replay
- snapshot data
- WebSocket attach, resize, write, detach, close, and exit/lost behavior

The exact HTTP contract must be added to
`services/tuttid/api/openapi/tuttid.v1.yaml` before generated clients or
daemon handlers are changed.

Current route family:

```text
GET    /v1/workspaces/{workspaceID}/terminals
POST   /v1/workspaces/{workspaceID}/terminals
GET    /v1/workspaces/{workspaceID}/terminals/{terminalID}
DELETE /v1/workspaces/{workspaceID}/terminals/{terminalID}
POST   /v1/workspaces/{workspaceID}/terminals/{terminalID}/resize
GET    /v1/workspaces/{workspaceID}/terminals/{terminalID}/snapshot
GET    /v1/workspaces/{workspaceID}/terminals/{terminalID}/ws
```

Tutti does not import TSH VM or routing code. Terminal execution is a local
desktop capability mediated by tuttid.

## TSH VM Terminal Path

This section is future-facing only. TSH can adopt the same shared package later
after its workbench migration, but no TSH app migration is part of the current
Tutti landing.

TSH should keep:

- desktopd terminal session APIs
- VM/runtime ownership
- guest-agent shell stream
- relay path resolution
- terminal routing environment and LD_PRELOAD behavior
- room, collaboration, and agent-provider rules

A future TSH adapter should translate desktopd's existing terminal API and
WebSocket frames into the shared `TerminalTransport` contract. That would let
TSH share the terminal node experience without changing its execution authority.

## Current V1 Boundaries

These are deliberate boundaries for the current implementation:

- renderer selection uses xterm's default renderer; dormant TSH WebGL and pixel
  snapping code stays out of V1
- Windows ConPTY-specific behavior is deferred until Tutti needs local Windows
  terminal support
- file link detection is shared, but cwd resolution, VM/local path mapping, and
  open policy stay in host adapters
- drag/drop is a shared UI event hook only; each host decides accepted payloads,
  path mapping, and quoting
- output transforms are host-provided hooks; TSH-specific agent/query cleanup
  is not package behavior
- screen cache improves remount smoothness, but daemon snapshot and replay are
  still the authority for live terminal truth
- agent terminal behavior should be implemented as a wrapper or host adapter,
  not as branches inside terminal core

If runtime verification proves one of these boundaries is wrong, update this
document first with the reason, then adjust package contracts.

## Current Implementation

The current Tutti vertical is complete and runtime verified:

- `@tutti-os/workspace-terminal` owns host-neutral contracts, core recovery,
  xterm React surfaces, workbench helpers, package i18n, and styles.
- `services/tuttid` owns local pty lifecycle, snapshots, close guards, and the
  terminal HTTP/WebSocket API.
- Desktop owns the concrete tuttid adapter, host link/drop policies, workbench
  registration, and close confirmation wiring.
- Snapshot and sequence replay remain authoritative after renderer remount or
  daemon reconnect; screen cache is presentation acceleration only.
- Browser WebSocket attach may use the terminal-only `access_token` query
  parameter because browser clients cannot set `Authorization` headers.
- The temporary TSH source quarantine and migration ledger have been removed.
  Future TSH adoption requires a separate host adapter and must not restore
  copied product source inside the shared package.

## Validation

For shared package changes, run package typecheck, tests, and build. Desktop
adapter or workbench changes also require desktop typecheck/tests and renderer/UI
boundary checks. Daemon contract or pty changes require generated API checks and
focused `services/tuttid` Go tests/build. Runtime-sensitive changes should be
verified in Electron against create, attach, replay, resize, close guard, and
renderer-reload recovery.
