# Desktop Transport

This document describes the current desktop-to-daemon transport path.

The matching backend access model is documented in
[Desktop Backend Access](./desktop-backend-access.md).
The planned shared business-stream protocol is documented in
[Business Event Stream](./business-event-stream.md).

## Purpose

`tuttid` is the only business layer in the local product.

The desktop app must use a controlled local access path that keeps:

- business logic in `tuttid`
- Electron-specific capabilities in `apps/desktop`
- transport details out of renderer code

## Access Flow

Current desktop access follows these paths:

```text
renderer -> managed localhost tuttid
renderer -> preload typed host API -> main IPC -> tuttid
```

Each layer has one job:

- `renderer` handles UI and interaction, and talks to the local backend for business API traffic
- `preload` exposes typed host capabilities and narrow runtime bootstrap metadata
- `main` owns Electron-specific bridge behavior, daemon supervision, and startup composition
- transport owns the managed local backend lifecycle details
- `tuttid` owns business semantics

## Why Renderer Does Not Discover Transport Directly

Renderer code does not discover daemon endpoints on its own for three reasons:

1. `main` remains the only daemon supervisor
2. desktop can issue the backend capability token at startup instead of hardcoding long-lived credentials
3. renderer features still consume a typed backend client instead of ad hoc endpoint discovery logic

Renderer should not know:

- how to boot or monitor `tuttid`
- how the daemon selected its final port
- any Electron-only recovery or lifecycle behavior

## Transport Strategy

Desktop-to-daemon communication is managed loopback transport over one resolved
daemon endpoint.

Current default strategy:

- desktop asks `tuttid` to bind `127.0.0.1:0`
- the daemon publishes the actual bound address and per-run bearer auth to `<state-dir>/run/tuttid.listener.json`
- `main` reads that listener info and exposes the resolved backend config to renderer windows
- renderer and `main` both use a desktop-issued bearer token for daemon requests

Renderer constructs one canonical `@tutti-os/client-tuttid-ts` client and keeps
that object stable. Its custom restart-aware fetch resolves backend config
immediately before every HTTP request, replaces only the request origin, and
overrides `Authorization` with the current per-run bearer token. Request path,
query, method, body, other headers, and cancellation signal remain intact.
Body-bearing requests materialize the canonical client's already-serialized
body before rebuilding the request. Passing the original `Request` as
`RequestInit` would preserve a streaming upload that Chromium only sends over
HTTP/2 or QUIC, while the managed loopback daemon serves HTTP/1.1.

Do not copy the `TuttidClient` method table into desktop wrappers, use `Proxy`,
or maintain a second compatibility client. Daemon restart handling belongs in
the request transport so new canonical client methods are available to desktop
without manual forwarding changes.

This keeps the daemon under desktop supervision while giving renderer and CLI
clients a stable local backend contract.

The managed loopback endpoint may carry more than one transport family:

- HTTP request-response APIs
- terminal-specific WebSocket streams
- dedicated business-event WebSocket streams

Those families share endpoint discovery and bearer-token auth, but they do not
share one catch-all application protocol.

## Agent Activity Updates

Workspace agent activity uses a signal-and-reconcile model.

The live update signal is the shared business-event WebSocket. `tuttid` emits
workspace-scoped `agent.activity.updated` events when a workspace agent session
or its messages changed. These events are intentionally small dirty signals.
They do not replace the authoritative HTTP read model.

Renderer clients reconcile through the normal agent-session HTTP APIs:

- session state is read through the workspace agent session endpoints
- messages are read through the session message list endpoint with
  `afterVersion`
- reconnect handling must reload the active workspace/session state before
  trusting local renderer memory

Do not add a per-session SSE route or a workspace-scoped SSE route for agent
activity. If a new agent activity update needs to be delivered live, add it to
the business-event protocol and keep durable state in `tuttid` HTTP-backed
projection reads.

## Current Endpoint Rules

Desktop and daemon resolve loopback endpoint intent from the same shared defaults.

Supported endpoint-specific overrides:

- `TUTTID_ACCESS_TOKEN`
- `TUTTID_ADDR`
- `TUTTID_LISTENER_INFO_PATH`

These transport variables are override-only controls for development, test, packaging, and diagnostics.
They are not the primary source of the default transport policy.

Current transport override surface:

- `TUTTID_ACCESS_TOKEN`
- `TUTTID_ADDR`
- `TUTTID_LISTENER_INFO_PATH`

Rules:

- prefer the generated repository defaults when no override is required
- do not add a new transport environment variable if an existing endpoint override or shared state-root rule already covers the use case
- when a new transport override is truly necessary, update this document and [Local State Storage](../conventions/local-state-storage.md) if the change touches default local paths
- treat `TUTTID_ACCESS_TOKEN` as a per-run desktop-issued capability token, not a long-lived product setting

## Local State Integration

Default local transport runtime files derive from the shared local state root.

Examples:

- CLI shim: `<state-dir>/bin/tutti`
- development CLI shim: `<state-dir>/bin/tutti-dev`
- listener info: `<state-dir>/run/tuttid.listener.json`
- daemon pid file: `<state-dir>/run/tuttid.pid`

The listener-info file is also the user-level CLI endpoint file. It is written
with restrictive permissions and contains the daemon loopback address plus the
current per-run bearer token. CLI clients should read it directly and send the
token in the HTTP `Authorization` header.

The packaged desktop app repairs the canonical user-level CLI shim during
startup. The canonical shim path derives from the same state root. To expose the
command to external shells on macOS and Linux, desktop may also install or
repair a Tutti-owned forwarding shim in `~/.local/bin` or `~/bin`, but only
when that directory is already present in the user's login-shell `PATH` and
writable. It must not overwrite a non-Tutti command, mutate shell profiles, or
write to global locations such as `/usr/local/bin`. PATH exposure is a
best-effort background startup task and must not delay desktop window creation.

Local development scripts install a separate `tutti-dev` command so developer
shells can target the development daemon without shadowing a packaged `tutti`
installation.

The state root rules are defined in [Local State Storage](../conventions/local-state-storage.md).

## Desktop-Side Rules

In `apps/desktop`:

- only `main` owns daemon endpoint resolution
- only `main` transport code knows how to bootstrap the managed loopback endpoint
- `main` startup composition assembles daemon runtime and host services before IPC registration
- `main` lifecycle handling waits for managed daemon shutdown before the final app quit path continues
- `preload` exposes typed APIs and narrow transport bootstrap helpers, not
  arbitrary transport policy surfaces or generic relay APIs
- `renderer` consumes typed backend clients, typed business-stream adapters, and typed host capabilities

This means transport changes should not require renderer feature rewrites.

Current acceptable preload bootstrap helpers include:

- resolved backend config for managed loopback HTTP access
- resolved terminal stream URL helpers for terminal-specific WebSocket routes
- resolved business-event stream URL helpers for `/v1/events/ws`

## Daemon-Side Rules

In `services/tuttid`:

- server setup binds a loopback TCP listener
- the daemon writes its actual bound address to the shared listener-info file
- browser-originated requests require the desktop-issued bearer token
- direct daemon startup must provide `TUTTID_ACCESS_TOKEN`; desktop-managed startup generates and injects it automatically
- local HTTP requests keep browser-facing CORS behavior because renderer uses standard `fetch`
- route-local streaming protocols such as terminal and business-event WebSockets should keep their own typed contracts instead of sharing ad hoc frame shapes

## Validation

The repository includes a transport smoke test:

- `pnpm smoke:desktop-transport`

The smoke test starts `tuttid`, reads the listener-info file, probes `/v1/health` through the current managed loopback path, and shuts the daemon down again.

Use this test when changing:

- transport resolution
- daemon listener setup
- desktop transport client behavior
- local state path derivation
