# Agent Provider CLI Updates

Status: current implemented architecture

## Purpose

Provider CLI update discovery and execution are daemon-owned product behavior.
They are intentionally separate from local provider readiness and from the
existing install workflow:

- readiness answers whether the current local CLI, adapter, and auth state can
  launch;
- update discovery checks a trusted remote package source for a newer release;
- install supplies a missing runtime or repairs the minimum supported runtime;
- update is an explicit user action that moves an already installed,
  source-owned runtime to a discovered newer version.

## Ownership

`packages/agent/daemon/providerregistry` owns the provider-neutral update
descriptor: capability, source, execution strategy, package, binary, optional
dependency policy, and stable unsupported reason. The registry validates that a
supported update uses the same managed npm package and binary as the provider's
installer. Shared logic never selects an update strategy by provider id.

`services/tuttid/service/agentstatus` owns local source recognition, cached npm
metadata discovery, version comparison, the explicit update action, and the
mandatory post-update probe. `services/tuttid/api` only projects those domain
results through the OpenAPI contract.

## Read And Refresh Contract

`GET /v1/agent-providers/status` remains local by default:

- no flag: local readiness only; update capability and current version are
  projected without remote discovery;
- `refresh=true`: bypass only the local readiness cache;
- `includeUpdates=true`: opt into cached remote update discovery;
- `includeUpdates=true&refreshUpdates=true`: bypass only the update-metadata
  cache;
- `refreshUpdates=true` without `includeUpdates=true`: no remote discovery.

`includeNetwork` remains an independent opt-in for network diagnostics. Neither
update flag enables it.

Update discovery uses a six-hour daemon cache, including failed outcomes. A
registry timeout, invalid response, or unavailable mirror sets a non-fatal
`reasonCode` on the provider's update status; it does not fail or replace local
readiness.

## Automatic Discovery Scheduler

The daemon owns a separate background scheduler for update discovery. It starts
only after the daemon has published its listener metadata and is ready for
clients. In production, the first check is delayed by 90 seconds (within the
60–120 second startup window), followed by a six-hour interval. These durations
are injectable in scheduler tests.

The device-global `agentCliUpdateCheckEnabled` desktop preference controls the
scheduler and defaults to `true`. A persisted `false` value starts the scheduler
without a timer or remote request. Preference changes cancel an active check or
reschedule the next check from the startup delay. Failed discovery is non-fatal
and retries with bounded exponential backoff beginning at five minutes and
capped at one hour; a successful check restores the six-hour interval. Daemon
shutdown cancels any in-flight discovery and waits for the scheduler to exit.

Scheduled work calls the dedicated managed-provider discovery path directly. It
does not call the ordinary provider readiness/status endpoint, set
`includeNetwork`, request `refresh=true` or `refreshUpdates=true`, run an update
action, or install a package. The same descriptor and local-source gates apply:
only an installed CLI proven to belong to a supported managed npm package may
reach a remote npm registry. Unsupported, missing, and unmanaged runtimes are
local-only decisions.

The update status exposes:

- `capability` and `unsupportedReason`;
- `source`;
- `currentVersion` and `latestVersion`;
- nullable `updateAvailable` (`null` means unchecked, failed, or not safely
  comparable);
- `lastCheckedAt` and non-fatal `reasonCode`.

## Safe Source Gate

A provider descriptor declaring managed npm support is necessary but not
sufficient. For an installed CLI, tuttid must also prove that the resolved
launcher belongs to the descriptor's npm package by locating and validating its
package manifest and npm prefix. A standalone binary, package-manager install,
official-script install, or otherwise unknown origin is reported as
`unsupported` with `unmanaged_install_source`; tuttid does not install a second
copy and call it an update.

Current support matrix:

| Provider                              | Descriptor source                     | Runtime ownership requirement                | Update capability |
| ------------------------------------- | ------------------------------------- | -------------------------------------------- | ----------------- |
| Codex                                 | npm (`@openai/codex`)                 | resolved CLI must belong to that npm package | supported         |
| Tutti Agent                           | managed npm (`@tutti-os/tutti-agent`) | resolved CLI must belong to that npm package | supported         |
| Claude Code, Cursor, OpenCode, Hermes | official script                       | not safely attributable to managed npm       | unsupported       |
| OpenClaw                              | shell command / unknown source        | not safely attributable to managed npm       | unsupported       |
| Nexight                               | provider unavailable                  | no supported update source                   | unsupported       |

## Explicit Update Action

`POST /v1/agent-providers/{provider}/actions/update/run` is distinct from
`install`. The action:

1. verifies the descriptor capability and the installed runtime's managed npm
   ownership;
2. refreshes update metadata and selects the exact discovered version;
3. runs the controlled managed npm executor against the owning prefix;
4. invalidates readiness and update caches;
5. performs a fresh provider probe before reporting completion.

An npm exit failure or failed post-update probe returns a failed action result.
It never reports success solely from the package manager exit code.

## Desktop Interaction And State Projection

The Agents settings table is a compact discovery surface. It may show the
current/latest version summary and open the provider's environment panel, but it
does not execute updates inline. The environment panel owns update discovery,
the explicit Update action, progress/log presentation, post-update detection,
and re-login alongside the other provider setup operations. Keeping the command
in that panel prevents table rows from changing height and gives all environment
remediation one interaction owner.

`IAgentProviderStatusService` is the renderer module seam for this workflow. It
owns request/action orchestration and exposes separate operation signals:

- `isLoading` describes ordinary provider-status query activity;
- `isCheckingUpdates()` describes the complete lifetime of update discovery;
- `isActionPending(provider, "update")` describes the complete update mutation,
  including the refresh and post-action status projection.

UI must not infer update-operation state from `isLoading`: install/update status
polling legitimately toggles query loading between requests. Manual Check for
updates remains disabled while either update discovery or any update action is
pending, while unrelated environment detection does not lock that control.
