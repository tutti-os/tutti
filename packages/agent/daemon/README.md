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

## Package Ownership

This package owns:

- agent session controller mechanics
- built-in provider adapters and ACP protocol handling
- process transport abstractions
- runtime-to-activity report emission

The host daemon owns:

- HTTP, IPC, or CLI APIs
- durable persistence and event publishing
- provider availability and install status
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
