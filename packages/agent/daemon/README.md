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

Controller startup coordination is scoped to one Session. The legacy `Start`
form that omits `AgentSessionID` is scoped by room and provider while it
allocates and deduplicates the Session ID. Provider-specific credential
coordination belongs in the Host startup gate; provider I/O must not run under
a process-wide Controller startup lock.

`Controller.SubscribeWhenAvailable` is the observation-only stream attachment
for consumers that already have durable session identity but may race runtime
resume after a daemon restart. It waits for `Start`, `Resume`, or
`Host.EnsureRuntimeSession` to repopulate the runtime registry and then
subscribes with the current state snapshot. It never starts or resumes a
provider itself; lifecycle authority stays with Agent Host.

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
can set `Config.CommandNetworkAccessPolicy` when using the default adapters.
The host policy receives canonical provider IDs and should explicitly allow
only providers that require command networking. A nil policy denies command
network access. Hosts that construct adapters directly can instead use
`CodexAppServerAdapterOptions{CommandNetworkAccess: true}`.

Both forms set `sandboxPolicy.networkAccess` on read-only and workspace-write
turns. They do not change `approvalPolicy`, `approvalsReviewer`, writable roots,
or network-proxy policy. Full-access turns remain unrestricted by definition.

## Process Cassette Transport

`NewRecordingProcessTransport` decorates an existing `ProcessTransport` and
writes one versioned cassette manifest plus a JSONL stream of successful
outbound writes and observed stdout, stderr, and exit frames.
`NewReplayProcessTransport` loads a complete cassette and exposes the same
`ProcessConnection` contract without starting a provider process. Replay waits
for each expected outbound write before releasing later inbound frames and
waits for already-recorded inbound frames to be consumed before validating the
next outbound write. This preserves the recorded stream order without treating
normal reader/writer goroutine scheduling as a mismatch. Replay
fails closed on missing, additional, reordered, or different outbound JSON.
Its playback controller can pause before the next inbound frame, resume from
the same virtual time, or fast-forward recorded waits. Fast-forward never skips
frames or outbound assertions. It may temporarily pass a paused barrier for
checkpoint seeking; disabling fast-forward restores the requested paused state.

`NewSessionReplayProcessTransport` constructs one fixed replay router from
Cassette, root Session, and Cassette-directory registrations. It keeps one
`ReplayProcessTransport` per Cassette, routes process launches by
`RootAgentSessionID`, and exposes Cassette-scoped playback and verification. Duplicate
Cassette or root Session registrations fail construction. An unregistered root
Session launch fails closed.

`SessionRecordingProcessTransport` keeps lightweight wrappers around live
provider connections, so `continue-session` capture can attach after a process
has started. It also captures later root, parallel child, and nested child
connections in the same SessionGraph. Each connection is keyed by recorded
Session identity, provider, and Session-local launch ordinal; global sequence is
diagnostic only. `Arm` also freezes the owning Recording ID into every captured
frame and decoded Provider input unit, so a delayed callback cannot be
reattributed to a later capture generation.
Provider tape schema v4 marks every connection as
`process-start` or `attached-live-connection`. Provider adapters cold-bootstrap
the former and restore their initialized protocol checkpoint for the latter;
the checkpoint crosses the portable Host historical-state boundary as
`providerResumeCheckpoint`, while unrelated private runtime context stays out
of the Cassette. Missing or unknown origins fail closed. Provider probes and
setup commands use the normal local transport. A complete manifest records the exact frame count,
decoded payload bytes, stored bytes, largest frame, per-kind byte distribution,
and SHA-256 of `frames.jsonl`, so deletion or mutation fails before replay
starts. Recording fails before writing a decoded payload above 8 MiB or a tape
above 256 MiB; provider traffic is a protocol stream, not a bulk-file archive.
`Runtime.Close` closes live
provider sessions first and then finalizes a transport that exposes
`Finalize() error`, ensuring recording manifests are marked complete only after
connection shutdown and replay verifies every recorded connection and chunk
was consumed.

Schema v4 also requires `projectionVersion: 1`. Recording sends original bytes
to the live adapter and persists a protocol-aware projected copy: correlated
account email and recognized CWD path fields become portable, while
credential-bearing protocol methods and residual structured secrets or
unclassified absolute paths fail closed. Recognized HOME paths use
`${REPLAY_HOME}` and resolve against the isolated replay HOME. Projection
preserves the frame that completes a split protocol message. It does not scan
or rewrite ordinary prompt or Provider text.

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

## Provider Authentication Status

`providerregistry` owns each provider's auth status command, runner kind, and
parser kind. Hosts execute the descriptor-owned runner in their provider
runtime, then use `providerstatus.ParseAuthStatusOutput` for text-command
results. Codex uses the dedicated `codex_app_server_account` runner: it
initializes `codex app-server` and calls `account/read`, matching session
startup instead of trusting the shallower `codex login status` output.
The same package exposes narrow helpers for explicit Codex and Claude API
billing configuration. Credential-file or token presence must not be used as
proof that an OAuth session is still authenticated.

`providerstatus` also owns the provider-neutral evidence reduction contract.
Local status commands and credential files produce `configured`; a successful
provider request produces `authenticated`; an explicit remote auth failure
produces `required`. Remote evidence outranks stale local files until the host
crosses an explicit account, credential, or runtime boundary. Transient probe
failures preserve a settled observation.

`tuttid` consumes this reducer in its provider-status service. It combines the
local probe with real agent-run outcomes, owns freshness and credential-change
reset, and projects the same public status to Tutti Desktop and AgentGUI.
External hosts consume the same reducer only when their runtime cannot use the
`tuttid` status service. `DesktopIntegrationDescriptor` declares when such a
host must wait for credential projection before probing; the host maps that
semantic barrier to its own synchronization mechanism.

`StatusDescriptor.RemoteAuthProbe` owns the provider-backed strategy without
owning credential storage. Claude Code declares its OAuth usage request to
`https://api.anthropic.com/api/oauth/usage`; hosts resolve the OAuth access
token from their own credential authority and never send an API key or
`ANTHROPIC_AUTH_TOKEN` to that endpoint. Codex declares the provider-usage
strategy, which invokes `account/rateLimits/read` through the provider runtime
without publishing credential bytes. A successful request authenticates the
session, an explicit authentication rejection requires login, and throttling,
server, or transport failures preserve the local `configured` state. `tuttid`
expires this remote evidence after 15 minutes; Desktop asks again only while
its window is visible and focused. OAuth refresh-token rotation remains
credential-owner policy and is not performed by this status probe.

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

Standard ACP Agent Extensions participate in the default idle reaper only when
their live `initialize` handshake advertises `session/load` or
`session/resume`. After 30 minutes of inactivity, release closes only the ACP
transport and its CLI process; it does not send `session/close`. The next
`Exec` launches a replacement CLI process and restores the preserved provider
session. Extensions that do not advertise a restore method remain live, and a
pending interactive request makes the session busy rather than releasable.
Replacement processes continue the durable Session's lifecycle snapshot
sequence so restored activity cannot be rejected as stale. Release, resume,
and live settings RPCs (including permission changes) share the per-Session
lifecycle fence; a failed transport close keeps the live handle registered so
a later release can retry.
The local process transport serializes concurrent close attempts and retries
termination after a failed attempt instead of caching that failure forever.
An ACP client whose release failed remains owned as a physical handle but is
not considered usable. One replacement may reconnect the durable provider
session, but the old client's inbound handler is quarantined before close so
late output cannot enter the replacement Turn. If that old handle still cannot
close, later Start/Resume attempts spend one bounded cleanup attempt and return
`agent.process_cleanup_pending` without spawning another process while the
retired handle remains.
The Controller also sweeps adapter-owned retired handles independently of its
canonical Session registry, so provisional or preserve-state removal cannot
orphan cleanup ownership. Each sweep gives every cleanup-capable adapter at
most one failed Close budget across canonical and detached handles, and reports
resource counters separately from canonical idle-session release results.

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
client-submit message and the submitted Turn admission before provider
dispatch, and return only after that message can be queried by
`clientSubmitId`. A host decorator embeds or otherwise preserves this required
interface; there is no optional capability probe to forward manually.

The daemon service passes `ClientSubmitID` through typed create/send and runtime
inputs. `Exec` uses `ReportSubmitProvenance` as the pre-dispatch admission
barrier. After `Exec` returns, the service explicitly calls the required
`RuntimeController.DurablyReportSubmitProvenance` method as an idempotent
reconciliation barrier before it accepts any submit claim; this second call
does not represent a second provider admission. The runtime adapter delegates
that call to the controller after `Exec` has released the session lifecycle
lock; the controller places the uncoalesced barrier behind earlier reports in
the same FIFO. A barrier failure is delivery-unknown, and provider work is
never blindly replayed. Host-owned user submissions, including follow-up
submissions, carry a stable `ClientSubmitID`; standalone internal runtime
calls may retain their generated prompt-message identity.

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
