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

`packages/agent/daemon/providerregistry/providers.go` registers `tutti-agent`
with:

- binary: `tutti-agent`;
- adapter command: `tutti-agent app-server`;
- minimum CLI version: the registry's `TuttiAgentMinVersion`;
- tested install version: the registry's `TuttiAgentRecommendedVersion`;
- auth marker: `~/.tutti-agent/auth.json`;
- installer: registry kind `InstallerKindManagedNPM` (mapped to agentstatus
  `InstallerKindManagedNPMPackage`) for
  `@tutti-os/tutti-agent`, including optional dependencies.

Provider status is the source of truth for readiness. A successful npm command
is not enough: after installation, the daemon resolves the binary again and
probes the provider adapter.

## Managed NPM Installation

The managed installer places the package in a global prefix searched by the
daemon binary resolver. It also repairs an existing npm-owned installation in
place when the launcher or a platform package is broken.

New installs and minimum-version repairs install the descriptor's exact tested
`RecommendedVersion`. `MinVersion` remains the compatibility floor: an existing
runtime at or above it is reused without contacting npm. Keeping these values
separate makes installation reproducible and permits an explicit downgrade
during rollback. The effective command has this shape:

```text
npm install -g --prefix <managed-or-existing-prefix> \
  @tutti-os/tutti-agent@<recommended-version> --include=optional
```

`--include=optional` is required because the CLI depends on platform-specific
optional packages. The installer verifies the resulting launcher instead of
trusting npm's exit status.

Registry selection follows the shared agent npm registry policy:

1. `TUTTI_AGENT_NPM_REGISTRY`, when set, pins one registry with no fallback;
2. otherwise the installer ranks and retries the configured official and mirror
   registries for the exact package being installed.

The shared `packages/agent/daemon/managednpm` policy ranks registries in the
runtime's own network. A registry is eligible only when it contains the exact
aggregate version and the matching optional platform package. A fast but
partially synchronized mirror is ranked behind complete sources. Installation
still verifies the binary, native payload, and app-server rather than trusting
metadata or npm's exit status.

## Desktop Proactive Install

`registerWorkspaceAgentServices` starts `startManagedAgentInstallBootstraps`
once the desktop provider-status service is available. The bootstrap:

1. loads only the `tutti-agent` provider status;
2. treats a missing CLI and a CLI below `TuttiAgentMinVersion` as installable
   `not_installed` states;
3. stops when the provider is already ready, is not `not_installed`, has no
   install action, or already has an install action pending;
4. runs the normal provider `install` action;
5. refreshes provider status after the action.

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

The host-neutral ordering and compensation rules live in
`packages/agent/daemon/tuttiagentauth`; the Tutti daemon supplies the Account,
credential-file, and local CLI adapters. Another host may supply VM-backed
adapters without importing Tutti product paths or account-session storage. One
reconciler instance serializes mutations of one canonical credential file.
Hosts must run local cleanup on logout/account switch before reconciling the
next account; this does not require a user ID in the credential path.

Reconciliation only establishes usable credential material. It does not prove
that the provider accepts the credential and must not be treated as an
authenticated or ready product state. Every host must run a provider probe
after reconciliation and publish readiness from that authoritative probe.

The same auth bootstrap runs once when the daemon starts and before each Tutti
Agent runtime preparation. These fallback entry points cover a login completed
before callback wiring, a transient token failure, or a stale provider auth
home. When no host account session exists, preparation removes stale Tutti Agent
auth instead of reporting the provider ready.

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
- Missing, unknown, or below-floor versions install the exact recommended
  version; compatible versions do not contact a registry.
- Registry ranking happens where npm will run and rejects incomplete platform
  packages before comparing speed.
- A Tutti Agent below `TuttiAgentMinVersion` is not ready and is repaired by
  the same proactive install path as a missing CLI.
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
- desktop routing of Tutti Agent login actions to the account service.

Related documents:

- [Agent Account And Commerce](./agent-account-and-commerce.md)
- [Agent GUI Node](./agent-gui-node.md)
- [Runtime Overrides](../conventions/runtime-overrides.md)
- [Agent Runtime Troubleshooting](../conventions/troubleshooting/agent-runtime.md)
