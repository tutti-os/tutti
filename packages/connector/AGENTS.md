# AGENTS.md

## Scope

This file applies to `packages/connector/*`. Read the repository root and
`packages/AGENTS.md` first.

## Routing

- Wire schemas, authorization protocol, or OpenAPI fragment: read
  `contracts/AGENTS.md`.
- Lifecycle semantics, orchestration, catalog access, persistence, or control
  plane: read `daemon/AGENTS.md`.
- Artifact, process, MCP, CLI, credential broker, or route execution: read
  `runtime/AGENTS.md`.
- Frontend services, state, i18n, or Connector React: read
  `renderer/AGENTS.md`.

Read [Connector Architecture](../../docs/architecture/connector.md) when a
change crosses two of these owners or changes their dependency direction.

## Cross-owner invariants

- Contracts depends on no Renderer or product host.
- Renderer Application stays React-free; Renderer UI depends on Application.
- Daemon Core depends on no concrete adapter or Application.
- Runtime depends on Daemon Core, never Daemon Application or concrete
  adapters.
- Connector packages import no Desktop, AgentGUI, or tuttid implementation.
- Product transport, account policy, generated clients, state-root selection,
  and composition stay with the product adapter.

`pnpm check:connector-boundaries` is the executable ownership gate. Follow
[Validation Selection](../../docs/conventions/testing.md#validation-selection)
for the final check plan.
