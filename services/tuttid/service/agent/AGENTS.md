# AGENTS.md

## Scope

This file applies to `services/tuttid/service/agent/*`.

This directory is an **adapter** onto `packages/agent/host`. It translates
HTTP, query, composer, analytics, transport, and provider-preparation concerns
and delegates agent lifecycle through `ApplicationHost()`. It is not the agent
application core. Read the root `Agent Host Boundary` section and
`packages/agent/host/README.md` before editing here.

## Decision rule

> Does this change define or change the lifecycle semantics of a
> session/turn/goal/runtime-operation (when it is created, when it may be sent,
> when it is terminal, how it is recovered)?
>
> - Yes -> it belongs in `packages/agent/host`. Only delegate/adapter code
>   lands here.
> - No (transport, DTO, query, presentation, product policy) -> it may land
>   here.
> - Unsure -> answer in the PR description: "Does tsh (or another Host consumer)
>   also need this behavior?" If yes, it belongs in Host.

New lifecycle semantics must first gain a scenario in
`packages/agent/host/conformance`. Conformance scenarios may only program
against the Host contract, never against this adapter.

## When Host is missing a capability

Do not reimplement the missing behavior here. Add the API in
`packages/agent/host`, cover it with a conformance scenario, release the Host
package, then delegate to it from this adapter.

`GetSession`, `UpdateSettings`, `UpdatePin`, and `DeleteSession` were missed
during tsh's `cmd/desktopd` cutover. The correct fix was to add those Host APIs
in `packages/agent/host` (PR #1329) so both tuttid and tsh delegate to one
implementation, not to reimplement them in either adapter.

## Forbidden patterns

- Introducing a new `*Coordinator`, `*Worker`, or `*Actor` production type or
  file that orchestrates session/turn/goal/runtime-operation lifecycle. These
  belong in `packages/agent/host`. `pnpm check:agent-host-boundary` enforces a
  ratchet: the current allowlist is a snapshot, and a new orchestration surface
  fails the check until it is either moved to Host or explicitly added to the
  allowlist with a reviewed ownership reason.
- Bypassing `ApplicationHost()` to orchestrate lifecycle directly (open a
  session, decide sendability, drive resume/cancel/recovery, or advance a goal
  saga) inside this package.
- Calling a canonical store write interface directly to make a lifecycle
  decision. Semantic writes go through Host; adapters only repair re-derivable
  projections while consuming canonical state.

## Checks

- `pnpm check:agent-host-boundary` runs the boundary ratchet for this
  directory. It also runs in `pnpm check:full`, in the `check:changed`
  `boundary:agent-host` lane when files here change, and in PR CI.
- Daemon Go validation for this package follows `services/tuttid/AGENTS.md`.
