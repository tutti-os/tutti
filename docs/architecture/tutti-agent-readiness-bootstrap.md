# Tutti Agent Readiness Bootstrap

## Purpose

Tutti Agent should feel immediately available when a user opens the desktop app.
The integration exposes `tutti-agent` as a provider, installs it through the
daemon-managed npm installer, and can start setup before the user explicitly
opens the provider. This note describes the intended architecture for:

- a Codex-like managed npm installer for `@tutti-os/tutti-agent`;
- proactive installation when the app opens;
- selected-provider account login CTAs that let signed-out users log in quickly.

This document extends the broader [Tutti Agent Integration Plan](./tutti-agent-integration-plan.md).

## Current Chain

`tutti-agent` is declared in `services/tuttid/service/agentstatus/registry.go`
as a first-party provider:

- binary: `tutti-agent`
- adapter command: `tutti-agent app-server`
- auth marker: `~/.tutti-agent/auth.json`
- installer: `InstallerKindManagedNPMPackage` for `@tutti-os/tutti-agent`
  with `--include=optional`

Desktop reads provider status through `DesktopAgentProviderStatusService`.
When the daemon reports `not_installed`, the status includes an `install`
daemon action. The environment wizard, Manage dialog, launchpad, and workbench
setup entry all run the same `agentProviderStatusService.runAction(provider,
"install")` path, which maps to:

```text
desktop runAction
  -> tuttidClient.runAgentProviderAction(provider, "install")
  -> POST /v1/agent-providers/{provider}/actions/install/run
  -> agentstatus.Service.RunAction
  -> ProviderSpec.Install
  -> post-install Probe(provider)
```

The important distinction is that rendering an AgentGUI rail item does not
install anything. Installation starts only when the install action is run.

## Managed NPM Installer

### Problem

`tutti-agent` must not use `InstallerKindShellCommand` with a bare global npm
command. That shape is weaker than the Codex installer:

- the launcher can be installed into a global npm prefix that the daemon binary
  resolver does not search;
- npm may use a user-level cache with permission problems;
- platform optional dependencies may be skipped unless `--include=optional` is
  passed;
- registry access may be slow or blocked in mainland China unless the installer
  ranks mirrors and retries;
- the displayed command is unpinned, while the original integration plan called
  out `@tutti-os/tutti-agent@0.0.1` pending release-shape confirmation.

### Direction

Use the reusable managed npm installer instead of a one-off shell command. The
installer spec is:

```go
type ManagedNPMPackageInstallerSpec struct {
    PackageName     string
    PackageVersion  string
    BinaryName      string
    IncludeOptional bool
    InstallDir      string
}
```

with `InstallerKindManagedNPMPackage`.

`codexCLIInstallerSpec()` can become a thin wrapper over this generic installer:

```go
managedNPMPackageInstallerSpec(ManagedNPMPackageInstallerSpec{
    PackageName: "@openai/codex",
    BinaryName: "codex",
    IncludeOptional: true,
})
```

`tutti-agent` uses:

```go
managedNPMPackageInstallerSpec(ManagedNPMPackageInstallerSpec{
    PackageName: "@tutti-os/tutti-agent",
    BinaryName: "tutti-agent",
    IncludeOptional: true,
})
```

Version pinning should be a product/release decision:

- use unpinned latest only if `@tutti-os/tutti-agent` is intended to be updated
  independently of the desktop app;
- use a pinned version or desktop-bundled default version when desktop and CLI
  compatibility must move together.

### Registry Strategy

The installer should reuse the existing agent npm registry chain:

1. `TUTTI_AGENT_NPM_REGISTRY`, when set, pins a single operator-provided
   registry and disables fallback.
2. Otherwise rank and retry:
   - `https://registry.npmjs.org`
   - `https://repo.huaweicloud.com/repository/npm/`
   - `https://mirrors.cloud.tencent.com/npm/`

This is appropriate for `tutti-agent`. The package is first-party, but the npm
dependency graph still needs reliable access from China and from enterprise
networks. Ranking should probe metadata for the exact package being installed,
then attempt install per registry with the existing per-registry timeout.
Mirrors must carry the aggregate package and its platform optional dependency
versions; a registry that only syncs the aggregate package can make npm exit
successfully while leaving the installed launcher unable to start.

The command shape should match Codex's robust behavior:

```text
npm install -g --prefix <managed-prefix> @tutti-os/tutti-agent --include=optional
```

where `<managed-prefix>` is derived from `selectInstallDir()` so the resulting
launcher lands in a directory the daemon resolver already searches, such as
`~/.local/bin`.

### Repair Behavior

The generic installer should support repair-in-place:

- if an existing `tutti-agent` launcher is found, detect the owning npm global
  prefix;
- reinstall into that prefix when the existing package is broken or missing its
  platform dependency;
- otherwise install into the managed prefix.

After install or repair, the daemon must resolve the binary again and run the
normal provider probe. Success is not "npm exited 0"; success is
`tutti-agent app-server` becoming probe-ready.

### Tests

Add daemon tests covering:

- `tutti-agent` registry spec uses the managed npm installer, not
  `InstallerKindShellCommand`;
- command includes `--prefix <managed-prefix>` and `--include=optional`;
- `TUTTI_AGENT_NPM_REGISTRY` pins a single registry;
- mirror ranking uses `@tutti-os/tutti-agent` as the metadata package;
- successful install is followed by a provider probe;
- install success with missing binary returns the existing
  `provider CLI is still unavailable after install` failure.

## Proactive Install on App Open

### Goal

When the desktop app opens, start preparing `tutti-agent` immediately so a user
can select it and begin with minimal waiting.

### Scope

Only `tutti-agent` should use proactive install. Do not auto-install external
or third-party providers such as Claude Code, Cursor, Gemini, Hermes, or
OpenClaw.

The flow should be best-effort and non-modal:

- no blocking splash screen;
- no unexpected terminal window;
- no repeated retry loop on every render;
- visible progress in the existing provider setup surface when the user opens
  AgentGUI.

### Trigger

Add a desktop-level bootstrap coordinator near the existing provider status
service wiring:

```text
workspace/desktop app mounted
  -> ensureDesktopManagedAgentProviderStatuses(...)
  -> if tutti-agent status is not_installed and install action exists
  -> runAction("tutti-agent", "install", context)
```

The coordinator should wait until:

- the daemon connection is available;
- provider statuses have completed the first load;
- the `tutti-agent` provider is enabled for this desktop build/user;
- no `tutti-agent` install action is already pending.

### Idempotency and Backoff

Persist a small local bootstrap state keyed by provider and desired package
version:

```text
tutti.agentBootstrap.tutti-agent = {
  packageVersion: "latest",
  lastAttemptAt: 1780000000000,
  lastStatus: "failed",
  failureReason: "registry timeout"
}
```

Recommended rules:

- run automatically once per app session when the status is `not_installed`;
- after a failure, wait at least several hours before the next automatic retry;
- always allow manual retry from the setup UI;
- clear the failed state after a successful probe.

The bootstrap state belongs in the desktop renderer/local preference layer,
not in AgentGUI package state. The daemon remains the source of truth for
actual provider readiness.

### UX

If the user opens AgentGUI while the proactive install is running, show the
normal setup/progress state, for example "正在准备 Tutti Agent...". Do not show
a separate app-wide dialog.

If install fails, show the same actionable setup surface the manual install path
uses. The failure should include the daemon-provided reason when available.

### Observability

Track separate analytics for:

- proactive install attempted;
- proactive install skipped because already ready;
- proactive install skipped because recently failed;
- proactive install completed;
- proactive install failed.

Do not reuse a user-clicked install event for the proactive path. Product needs
to know whether fast-start readiness is working without hiding explicit user
actions.

## Account Login CTAs

### Problem

When `tutti-agent` is selected and there are no conversations, a signed-out
desktop user currently has no direct account login affordance in the empty
state. The settings page has the correct account login button, but the AgentGUI
empty state is the place where the user discovers the blocked provider.

The same rule applies to visible auth failure cards inside an existing
conversation. A `tutti-agent` request can fail with a 401 from the Tutti LLM API
when the desktop account session or derived `tutti_llm` token is missing. The
inline `登录` action on that error card must start the desktop Tutti account
login flow, not the generic provider terminal-login action.

### Auth Layers

There are two auth layers and Tutti Agent CTAs must target the correct one:

1. Desktop Tutti account login:
   - implemented by `IAccountService.startLogin()`;
   - starts a daemon account login attempt;
   - opens `login_url` with `hostFilesApi.openExternal`;
   - polls login status and refreshes account user info.
2. `tutti-agent` provider auth:
   - represented by `tutti-agent login status` and `~/.tutti-agent/auth.json`;
   - bootstrapped by the sidecar using `tutti-agent login --with-tutti-llm-tokens`
     after the desktop account has a valid session.

The empty state login button and visible auth-failure login button should use
layer 1. They should not run the provider `login` action directly, because the
user needs the desktop Tutti account session before the sidecar can issue LLM
tokens for `tutti-agent`.

### UI Behavior

When the selected provider is `tutti-agent`, no session is selected, and
`accountState.user` is null:

- show the Tutti Agent empty state;
- show a primary `登录` button;
- while `accountState.signingIn` is true, show the same pending label/spinner
  as settings;
- when `accountState.loginStatus === "pending"`, clicking the button should
  reopen the active login URL by calling `accountService.startLogin()` again;
- after login completes, refresh provider status so the runtime can move toward
  `ready` or provider-level `auth_required`.

When a conversation-visible auth failure belongs to `tutti-agent`, route its
`登录` action through `accountService.startLogin()` as well. Other providers
should continue to use the provider status service's `login` action, because
their login flow is provider-specific.

The implementation should reuse `IAccountService` through `useAccountService()`.
Do not duplicate `startAccountLogin`, `openExternal`, or polling logic inside
AgentGUI.

### Placement

The selected-provider empty state lives at the workbench/desktop composition
layer, not in the daemon. The AgentGUI package can expose a hook or render prop
for a provider setup CTA, but the actual account service dependency should stay
inside `apps/desktop`.

If the shared AgentGUI component needs text, route labels through the existing
i18n layer. Do not hardcode Chinese or English UI strings in component code.

### State Refresh

On login completion:

- call `accountService.refreshUserInfo()` through the existing service flow;
- let daemon account service trigger the best-effort Tutti Agent auth bootstrap
  callback once `LoginStatus` observes `completed`;
- the callback exchanges the desktop account session for a `tutti_llm` token
  bundle and runs `tutti-agent login --with-tutti-llm-tokens`, which writes
  `~/.tutti-agent/auth.json`;
- refresh `tutti-agent` provider status;
- keep `TuttiAgentPreparer`'s runtime-prepare bootstrap as a fallback for cases
  where login completed before the callback was wired or the first bootstrap
  failed.

On logout completion:

- let daemon account service trigger best-effort Tutti Agent auth cleanup;
- remove `~/.tutti-agent/auth.json` synchronously before the logout response is
  surfaced to the renderer, because the auth marker must not keep provider
  readiness in the ready state after the host account is gone;
- use the removed auth payload to revoke the LLM refresh token in the
  background via `/auth/v1/llm-token/revoke`;
- refresh `tutti-agent` provider status when the renderer account state enters
  or leaves `completed`, or when the persisted account user appears/disappears.

## Rollout Order

1. Replace the `tutti-agent` shell installer with a generic managed npm package
   installer and tests.
2. Add proactive desktop bootstrap for `tutti-agent` install with backoff and
   analytics.
3. Add the selected-provider signed-out login CTAs using
   `IAccountService.startLogin()`.
4. Add end-to-end manual QA:
   - fresh machine, no `tutti-agent` binary;
   - slow/blocked npm official registry;
   - signed-out Tutti account;
   - signed-in account with no `~/.tutti-agent/auth.json`;
   - failed install followed by manual retry.

## Non-Goals

- Do not auto-install third-party providers.
- Do not remove historical `nexight` provider identity from daemon/API storage
  until a separate migration plan exists.
- Do not make AgentGUI depend directly on desktop account implementation.
- Do not treat npm command success as provider readiness.
