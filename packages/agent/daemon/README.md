# Agent Daemon

`packages/agent/daemon` provides the reusable daemon-side agent runtime kit. Host
daemons use it to run agent sessions and emit agent activity while keeping their
own HTTP API, persistence, workspace/runtime lifecycle, and product integration.

## Minimal Host Wiring

```go
runtime, err := agentdaemon.NewRuntime(agentdaemon.Config{
    Reporter:         activityReporter,
    ProcessTransport: agentdaemon.NewLocalProcessTransport(),
    HostMetadata: agentdaemon.HostMetadata{
        ClientInfo: agentdaemon.ClientInfo{
            Name:    "my-desktop",
            Title:   "My Desktop",
            Version: "1.0.0",
        },
        WorkspaceEnvName:         "MY_WORKSPACE_ID",
        OpenClawSessionKeyPrefix: "agent:main:my-desktop-",
    },
})
if err != nil {
    return err
}

controller := runtime.Controller()
```

Hosts that need to prepare a provider launch immediately before process spawn
can set `ProviderLaunchPreparer`. The hook receives the provider, session,
command, environment, cwd, and direct-start mode; it returns the command,
environment, cwd, and optional cleanup function to use for `ProcessTransport`
startup.

Prepare errors fail session start before spawning a process. When prepare
succeeds, cleanup runs after the provider process is closed, including process
start or initialize failure, live-session close, idle release, and live process
replacement. Cleanup failures are logged and do not replace the original close
or start error.

Hosts that need unrestricted command networking while retaining a
Codex-compatible provider's permission-mode filesystem sandbox and approval UX
can construct the Codex or Tutti Agent adapter with
`CodexAppServerAdapterOptions{CommandNetworkAccess: true}`. The option sets
`sandboxPolicy.networkAccess` on read-only and workspace-write turns. It does
not change `approvalPolicy`, `approvalsReviewer`, writable roots, or
network-proxy policy. Full-access turns remain unrestricted by definition.

## Package Ownership

This package owns:

- agent session controller mechanics
- built-in provider adapters and ACP protocol handling
- process transport abstractions
- runtime-to-activity report emission
- provider descriptors for update capability, trusted source, and execution strategy

The host daemon owns:

- HTTP, IPC, or CLI APIs
- durable persistence and event publishing
- provider availability and install status
- update metadata caching, source-ownership verification, and update actions
- workspace attachment, runtime VM lifecycle, and product auth

## Live Session Recycling

Agent sessions are durable controller records. For providers that support live
session release, the runtime reaper may close an idle provider process without
closing the Tutti agent session. The provider session id remains attached to the
session, and the next `Exec` resumes the provider live session before starting a
new turn.

User-initiated `Close` is still destructive for the controller session: it
completes the session, publishes completion activity, and removes the in-memory
record. Idle live-session release must not emit completion activity, clear the
provider session id, remove runtime directories, or interrupt active turns and
pending interactive requests.

Claude Code SDK sessions keep the SDK `session_id` in `ProviderSessionID` and
mirror the opaque SDK resume cursor in `runtimeContext.resumeCursor`. The sidecar
owns SDK stream ordering, turn cancellation, orphan result draining, and cursor
updates; the Go adapter forwards requests, persists session state patches, and
restores the last cursor on resume.

## Cloud Projection Extension Points

External daemons (for example tsh desktopd) can project local agent activity to
a remote controlplane without forking any `activity/` code.

**Scope ID semantics (RFC hard constraint):** the scope identifier in these
shared contracts is opaque — on the tutti side it is the **workspace ID**, for
external daemons such as tsh it is the **control-plane room ID**. workspace ≡
room, one-to-one, with no implicit translation anywhere: `roomID` in the store
interfaces is exactly the `WorkspaceID` on report inputs and is sent on the
wire as `roomId`. External daemons must pass the control-plane room ID directly
and must not introduce a second mapping in between.

- **`SyncStateStore`** — inject persistence for per-session sync states
  (pending counts, failure counters, last error) via
  `agentsessionstore.WithSyncStateStore`. `FileAgentSyncStateStore` is a
  ready-made file-backed implementation.
- **`SessionActivityReporterAdapter`** — wraps any `SessionActivityReporter`
  (such as `agentsessionstore.Client` configured with the controlplane
  `BaseURL`) into an `ActivityReporter`. It converts `ReportActivityInput`
  into per-session state and message reports and tracks/persists sync state
  through a `SyncStateStore`.
- **Syncer backoff and cursor persistence** — `WithSyncBackoff`
  (`DefaultSyncBackoffConfig`: 10s initial, 5min cap, 2.0 multiplier) enables
  per-session exponential backoff for failed message syncs, and
  `WithMessageCursorStore` persists message sync cursors so pulls resume after
  a restart. Both are opt-in; without them behavior is unchanged.

`ActivityReporter` and `SessionActivityReporterAdapter` are compatibility
projection contracts; they are not sufficient to host a runtime controller
because their state and message writes may use separate transactions.
`agentdaemon.Config.Reporter` requires `DurableActivityReporter`, whose
`ReportSubmitProvenance` method must atomically persist the canonical
client-submit message against an already-durable Turn and return only after
that message can be queried by `clientSubmitId`. A host decorator embeds or
otherwise preserves this required interface; there is no optional capability
probe to forward manually.

The daemon service passes `ClientSubmitID` through typed create/send and runtime
inputs. After `Exec` reports provider acceptance, the service explicitly calls
the required `RuntimeController.DurablyReportSubmitProvenance` method before it
accepts any submit claim. The runtime adapter delegates that call to the
controller after `Exec` has released the session lifecycle lock; the controller
places the uncoalesced barrier behind earlier reports in the same FIFO. A
barrier failure is delivery-unknown, and provider work is never blindly
replayed.

```go
client := agentsessionstore.NewClient(agentsessionstore.Config{
    BaseURL: "https://controlplane.example.com",
    Token:   token,
})
fileStore := agentsessionstore.NewFileAgentSyncStateStore(stateDir)
reporter := agentsessionstore.NewSessionActivityReporterAdapter(
    client,
    agentsessionstore.WithReporterSyncStateStore(fileStore),
)
store := agentsessionstore.New(
    client,
    agentsessionstore.WithSyncStateStore(fileStore),
    agentsessionstore.WithMessageCursorStore(fileStore),
    agentsessionstore.WithSyncBackoff(agentsessionstore.DefaultSyncBackoffConfig()),
)
```

## Legacy Defaults

The legacy runtime constructors still default to `TUTTI_WORKSPACE_ID`,
`tsh-desktop` ACP client metadata, and `agent:main:tsh-` OpenClaw session keys
for compatibility. New host integrations must use `agentdaemon.NewRuntime` with
explicit `HostMetadata`; the root facade does not apply legacy host identity
defaults. `ProcessTransport` is also required when using the built-in provider
adapters; hosts that pass custom `Adapters` own that transport setup themselves.

State directory defaults still follow the historical `TUTTI_STATE_DIR` /
`.tutti` behavior. State-dir injection is intentionally left for a later
host-boundary pass.
