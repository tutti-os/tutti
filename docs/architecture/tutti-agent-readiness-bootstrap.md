# Tutti Agent Readiness Bootstrap

Status: current implemented architecture

## Purpose

Tutti Agent is a first-party provider that the desktop prepares before the user
starts a conversation. Readiness spans three separate concerns:

1. the `tutti-agent` CLI and app-server adapter are installed;
2. the desktop Tutti account is signed in;
3. a Tutti LLM token bundle is written to the provider auth home.

The daemon owns provider discovery, installation, probing, and auth bootstrap.
The desktop owns the best-effort proactive install trigger and account login UI.
AgentGUI consumes provider readiness but does not install binaries or own Tutti
account credentials.

## Provider Registration

`services/tuttid/service/agentstatus/registry.go` registers `tutti-agent` with:

- binary: `tutti-agent`;
- adapter command: `tutti-agent app-server`;
- minimum package version: the daemon's `minTuttiAgentVersion`;
- auth marker: `~/.tutti-agent/auth.json`;
- installer: `InstallerKindManagedNPMPackage` for
  `@tutti-os/tutti-agent`, including optional dependencies.

Provider status is the source of truth for readiness. A successful npm command
is not enough: after installation, the daemon resolves the binary again and
probes the provider adapter.

## Managed NPM Installation

The managed installer places the package in a global prefix searched by the
daemon binary resolver. It also repairs an existing npm-owned installation in
place when the launcher or a platform package is broken.

The effective command has this shape:

```text
npm install -g --prefix <managed-or-existing-prefix> \
  @tutti-os/tutti-agent@<minimum-version> --include=optional
```

`--include=optional` is required because the CLI depends on platform-specific
optional packages. The installer verifies the resulting launcher instead of
trusting npm's exit status.

Registry selection follows the shared agent npm registry policy:

1. `TUTTI_AGENT_NPM_REGISTRY`, when set, pins one registry with no fallback;
2. otherwise the installer ranks and retries the configured official and mirror
   registries for the exact package being installed.

The mirrors must contain both the aggregate package and its matching platform
dependencies. A partially synchronized mirror can otherwise produce an npm
success followed by an unusable launcher.

## Desktop Proactive Install

`registerWorkspaceAgentServices` starts
`startTuttiAgentInstallBootstrap` once the desktop provider-status service is
available. The bootstrap:

1. loads only the `tutti-agent` provider status;
2. stops when the provider is already ready, is not `not_installed`, has no
   install action, or already has an install action pending;
3. runs the normal provider `install` action;
4. refreshes provider status after the action.

This path is best-effort and non-modal. It never auto-installs third-party
providers and it reuses the same daemon action exposed by manual setup UI.

Concurrent starts are coalesced. At most one install attempt is made per desktop
session. A failed automatic attempt is recorded under
`tutti.agentBootstrap.tutti-agent` in renderer local storage and suppresses
another automatic attempt for six hours. Manual retry remains available. A
successful probe clears the stored failure.

## Account And Provider Auth

Desktop account auth and provider auth are related but distinct:

- `IAccountService.startLogin()` establishes the desktop Tutti account session;
- the daemon exchanges that session for a `tutti_llm` token bundle;
- `tutti-agent login --with-tutti-llm-tokens` writes the provider auth marker.

The daemon wires account lifecycle callbacks at startup:

```text
account login completed
  -> BootstrapTuttiAgentUserAuth
  -> issue Tutti LLM token bundle
  -> tutti-agent login --with-tutti-llm-tokens
  -> ~/.tutti-agent/auth.json

account logout completed
  -> remove ~/.tutti-agent/auth.json synchronously
  -> revoke the removed LLM refresh token in the background
```

The same auth bootstrap runs once when the daemon starts and before each Tutti
Agent runtime preparation. These fallback entry points cover a login completed
before callback wiring, a transient token failure, or a stale provider auth
home. When no host account session exists, preparation removes stale Tutti Agent
auth instead of reporting the provider ready.

After bootstrap, Tutti Agent owns normal `tutti_llm` access-token refresh. It
calls the Account LLM refresh endpoint directly and never delegates this token
family to the app-server `account/chatgptAuthTokens/refresh` request. The daemon
pins the provider credential store to `file` so user and per-session homes share
the same durable credential source.

Credential mutation is coordinated by an OS file lock next to the durable auth
file (`auth.json.refresh.lock`). The daemon holds this lock while it removes or
reissues credentials; Tutti Agent holds the same lock while it reloads,
refreshes, and atomically replaces `auth.json`. Each daemon-issued bundle also
contains a `credential_generation`. Tutti Agent preserves that value across
refreshes and refuses to overwrite a newer generation installed by the daemon.
Older bundles without the field remain readable and use the previous app-id
comparison until the next bootstrap writes a generation.

Before submitting the one-time refresh token, Tutti Agent also writes a
non-secret fingerprint to `auth.json.refresh.pending`. It removes the marker
only after a deterministic rejection or after the rotated credentials are
durably stored. If a response or write outcome is ambiguous, the matching old
token is never replayed; the next preparation uses the daemon's invalidation
path to issue a fresh credential family. A marker for an older credential
generation is discarded when the shared auth file contains a different refresh
token.

The normal request path is therefore:

```text
Tutti LLM request or model-list request returns 401
  -> reload shared auth.json under the refresh lock
  -> retry if another process already replaced the token
  -> otherwise call Account /auth/v1/llm-token/refresh
  -> atomically persist the rotated bundle
  -> retry the original request with bounded recovery attempts
```

If structured runtime events show `account/chatgptAuthTokens/refresh` for the
`tutti-agent` provider, the daemon records an
`tutti.agent_auth.unexpected_external_refresh` warning. The method still returns
the app-server method-not-found response because it belongs to ChatGPT external
auth, not Tutti LLM auth. A structured auth failure also invalidates readiness;
the next preparation forces a host-side bootstrap instead of accepting a stale
auth marker.

This contract requires a paired Tutti desktop/tuttid and Tutti Agent rollout.
An old Tutti Agent still asks the host for ChatGPT token refresh, while an old
host does not participate in the shared credential lock or consume the new
structured invalidation signal. Upgrade both components and restart existing
Tutti Agent app-server sessions so they reload the managed-auth behavior. Roll
back both components together; rolling back only one side reintroduces the
mixed-version gap.

`TUTTI_ACCOUNT_BASE_URL` overrides the account service used for token issue and
revoke. `TUTTI_AGENT_LLM_APP_ID` overrides the LLM application id for controlled
development and test environments.

## Desktop Login Routing

When `tutti-agent` is selected and needs login, the desktop routes both setup
actions and conversation auth-failure actions to
`IAccountService.startLogin()`. Other providers continue through their own
provider `login` action.

This routing stays in `apps/desktop`; shared AgentGUI code must not depend on the
desktop account implementation. Account state changes trigger a provider-status
refresh so setup UI can move between `not_installed`, `auth_required`, and
`ready` without owning the auth workflow.

## Invariants

- Rendering an AgentGUI item never installs a provider.
- Only `tutti-agent` uses proactive installation.
- Installation completion is determined by a fresh provider probe.
- Desktop account credentials and Tutti LLM tokens never pass through renderer
  component state.
- Logout removes the local provider auth marker before the renderer observes the
  completed logout.
- User-visible setup and login copy goes through desktop i18n.

## Validation

The durable test surface covers:

- provider registry and managed-installer configuration;
- registry override and fallback behavior;
- managed prefix selection, optional dependencies, repair, and post-install
  probing;
- proactive install gating, coalescing, success refresh, and failure backoff;
- account token issue, provider login, stale-auth cleanup, and logout revocation;
- process-level lock release, same-file writer serialization, atomic writes,
  credential generation isolation, and Tutti LLM refresh-token rotation;
- 401 recovery for both model-list and normal managed-auth request paths;
- diagnostics for unexpected ChatGPT external-auth refresh requests;
- desktop routing of Tutti Agent login actions to the account service.

Related documents:

- [Agent Account And Commerce](./agent-account-and-commerce.md)
- [Agent GUI Node](./agent-gui-node.md)
- [Runtime Overrides](../conventions/runtime-overrides.md)
- [Agent Runtime Troubleshooting](../conventions/troubleshooting/agent-runtime.md)
