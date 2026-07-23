# Agent Account And Commerce

Status: current implemented architecture

This document describes the account, membership, credits, and registration
reward path used by the workspace account menu and Tutti Agent surfaces.

## Ownership

- `packages/auth` and `packages/commerce` are peer bounded contexts.
  `packages/commerce` owns the host-neutral Commerce client, response
  normalization, registration-reward coordination, and receipt-store contract.
- `services/tuttid/service/account` remains the Tutti host adapter: it owns
  login state, supplies the current Cookie authorizer and receipt-file store,
  and combines Account identity with the normalized Commerce summary.
- The daemon HTTP API and generated client expose sanitized account DTOs. They
  never expose the session cookie or provider tokens to the renderer.
- Desktop `AccountService` owns reactive renderer state, login polling,
  refresh deduplication, cache freshness, and stale-request protection.
- `WorkspaceAccountMenu` maps desktop state into host-supplied
  `AgentGUIAccountMenuState` and owns product-specific links and actions.
- `@tutti-os/agent-gui` owns reusable account-menu and reward-toast rendering;
  it does not perform account or Commerce requests. Copying a user id is an
  optional Host Action (`onCopyUserId`); clipboard access and success/error
  notifications remain host-owned.

Provider installation and Tutti Agent token bootstrap remain separate concerns
documented in [Tutti Agent Readiness Bootstrap](./tutti-agent-readiness-bootstrap.md).

## Data Flow

```text
local account session
  -> Tutti host Account adapter
  -> packages/commerce (host-supplied authorizer + receipt store)
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

The shared Commerce service decides whether a first-registration reward should
be claimed. Each host supplies its own receipt store, so Tutti and TSH do not
share dismissal state. Daily-credit responses must not be presented as
registration rewards. `product_summary.registration_credits_reward` exposes
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
- `packages/commerce` fails closed unless a request authorizer and reward
  receipt store are supplied. It never reads host session files or knows the
  Cookie format.
- Product links come from the daemon summary, with host-controlled defaults
  only as a display fallback.
- User-visible labels and errors use the desktop or AgentGUI i18n resources.

Runtime endpoint overrides are cataloged in
[Runtime Overrides](../conventions/runtime-overrides.md).
