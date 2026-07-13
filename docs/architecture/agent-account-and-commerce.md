# Agent Account And Commerce

Status: current implemented architecture

This document describes the account, membership, credits, and registration
reward path used by the workspace account menu and Tutti Agent surfaces.

## Ownership

- `services/tuttid/service/account` owns login state, local auth access, remote
  account/Commerce calls, product-summary aggregation, and registration reward
  state.
- The daemon HTTP API and generated client expose sanitized account DTOs. They
  never expose the session cookie or provider tokens to the renderer.
- Desktop `AccountService` owns reactive renderer state, login polling,
  refresh deduplication, cache freshness, and stale-request protection.
- `WorkspaceAccountMenu` maps desktop state into host-supplied
  `AgentGUIAccountMenuState` and owns product-specific links and actions.
- `@tutti-os/agent-gui` owns reusable account-menu and reward-toast rendering;
  it does not perform account or Commerce requests.

Provider installation and Tutti Agent token bootstrap remain separate concerns
documented in [Tutti Agent Readiness Bootstrap](./tutti-agent-readiness-bootstrap.md).

## Data Flow

```text
local account session
  -> tuttid account service
  -> Commerce user/credits APIs
  -> GET /v1/account/product_summary
  -> generated TypeScript client
  -> desktop AccountService store
  -> WorkspaceAccountMenu state
  -> shared AgentGUI account-menu view
```

The daemon product summary combines sanitized user identity, membership,
available credits, partial-error information, registration reward state, and
profile links. A partial remote failure may preserve usable data; the desktop
menu should render cached values and a non-blocking partial-error state instead
of replacing the whole menu with an error.

## Refresh And Login Rules

- Desktop starts login through the daemon, opens the returned URL through the
  host, and polls the login attempt until completion, failure, or expiry.
- Successful login refreshes user information and forces a fresh product
  summary.
- Product-summary refreshes are single-flight and use a short TTL. Opening the
  menu may force a refresh while preserving the last successful snapshot.
- Logout cancels login polling and invalidates user/product-summary state so a
  stale request cannot repopulate the previous account.
- External account, plan, usage, and settings links open through the desktop
  host rather than directly from the shared package.

## Registration Credits Reward

The daemon decides whether a first-registration reward should be claimed and
persists pending/dismissed state. Daily-credit responses must not be presented
as registration rewards. `product_summary.registration_credits_reward` exposes
only the pending user-visible reward.

Desktop maps that reward into a toast with a stable id and calls the daemon
dismiss endpoint when the toast closes or auto-dismisses. Optimistic local
dismissal prevents the same reward from flashing again while the request is in
flight; daemon state remains authoritative across restarts.

## Security Invariants

- Account cookies, session ids, LLM refresh tokens, and raw Commerce responses
  never enter renderer or AgentGUI state.
- The daemon calls the configured trusted gateway with the local account
  session; renderer code must not manufacture user-id headers.
- Product links come from the daemon summary, with host-controlled defaults
  only as a display fallback.
- User-visible labels and errors use the desktop or AgentGUI i18n resources.

Runtime endpoint overrides are cataloged in
[Runtime Overrides](../conventions/runtime-overrides.md).
