# AGENTS.md

## Scope

This file applies to `packages/*`.

`packages/` is for real shared boundaries, not as a default home for reusable-looking code.

If you are editing `packages/agent/gui/*`, read
[docs/architecture/agent-gui-node.md](../docs/architecture/agent-gui-node.md)
first, then [packages/agent/gui/AGENTS.md](agent/gui/AGENTS.md).

If you are editing Agent session, Turn, Goal, runtime-operation, or recovery
lifecycle under `packages/agent/*`, read the root `Agent Host Boundary` and
[packages/agent/host/README.md](agent/host/README.md) first.

If the task mentions AgentGUI, AgentGuiNode, Agent GUI, the agent conversation
module, agent composer, workspace agent timeline, agent approvals, or
interactive agent prompts, read
[docs/architecture/agent-gui-node.md](../docs/architecture/agent-gui-node.md)
first, then [packages/agent/gui/AGENTS.md](agent/gui/AGENTS.md), before planning
or editing even when the target files are not known.

If you are editing `packages/ui/*`, also read [packages/ui/AGENTS.md](ui/AGENTS.md).

## Package groups

- `clients/*`: shared domain-specific clients
- `device-link`: shared ICE/QUIC peer transport and gomobile boundary
- `events/*`: shared schema-first business event protocol contracts and generated transport metadata
- `agent/*`: Agent lifecycle Host, canonical store, frontend activity engine, replication contract, and GUI boundaries
- `browser/*`: reusable browser/workbench node mechanics for desktop hosts
- `configs/*`: shared TypeScript and formatting config
- `ui/*`: shared frontend-foundation packages
- `workbench/*`: shared Workbench host lifecycle, snapshot contract, and reusable surface packages for the open-source desktop and TSH
- `workspace/*`: narrow workspace-domain contracts and feature surfaces intended for reuse across the open-source desktop, TSH, and TACH

## Package rules

- name packages by responsibility, not by audience
- avoid vague names such as `shared`, `common`, `utils`, or `client-sdk`
- keep `clients/*` focused on domain-specific access patterns
- keep `device-link` transport-only: it may own candidate selection, authenticated peer streams, and platform build boundaries, but not account, pairing, rendezvous, Relay product policy, or Agent/Workspace DTOs
- keep `events/*` focused on repository-owned business event protocol contracts, topic catalogs, generated validators, and transport metadata rather than socket lifecycle or daemon business workflows
- keep `browser/*` focused on browser mechanics, workbench node integration, bridge shape, Electron webview guest management, and package-local i18n defaults; host product globals, backend-token access, preview proxy behavior, and business bridge methods stay in host adapters
- keep `ui/*` focused on shared frontend-foundation concerns such as tokens, icons, styles, primitives, and host-agnostic i18n runtime support
- keep `workbench/*` focused on product-neutral host lifecycle, snapshot compatibility, and Workbench interaction mechanics, not product-specific node UI or app workflows
- keep `workspace/*` focused on reusable workspace-domain semantics and state; concrete host adapters stay in the owning service, app, or integration
- a reusable frontend workspace-domain package may still own shared session orchestration, view-model derivation, and React-facing interaction state when those behaviors are intentionally shared across hosts
- a reusable frontend package that owns optional UI may also own narrow default i18n resources for that shared surface; keep those defaults in the owning package and let hosts override them through their app-level i18n or i18n runtime
- keep host-specific transport wiring, desktop preload calls, daemon client construction, host absolute paths, and product-specific integration details out of `workspace/*`
- keep host-specific transport wiring, product global names such as `__tutti` or `__tsh`, and product bridge methods out of `browser/*`
- do not move code into `packages/` until there is a real multi-consumer boundary
- treat a public npm package as an explicit external contract, not as automatic proof that the package already has multiple in-repository consumers
- when a package is intended for public npm release before a second in-repository host exists, document that external contract in the npm release conventions and review the package as a deliberate published boundary rather than as speculative pre-extraction
- keep package root exports narrow; do not export internal helpers, test
  fixtures, demo data, or implementation-specific hooks just because they are
  convenient inside the package

## Extraction guidance

Keep code local by default:

- TypeScript code used only by desktop stays in `apps/desktop`
- Go code used only by the daemon stays in `services/tuttid`

Move code into `packages/` only when:

- it defines a cross-boundary contract
- it has more than one real consumer
- the extracted API can be named narrowly by responsibility

Exception:

An intentionally published public npm package may live in `packages/` before it
has two in-repository consumers, but only when the package has an explicit
external contract and is included in the durable npm release conventions.

## Testing defaults

Packages do not override the repository validation workflow. Follow
[Validation Selection](../docs/conventions/testing.md#validation-selection)
and add only checks required by the closest package `AGENTS.md`.

## Related docs

- [docs/conventions/README.md](../docs/conventions/README.md)
