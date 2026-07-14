# AGENTS.md

## Scope

This file applies to `services/tuttid/*`.

`tuttid` is the primary business core of the repository.

If a change involves domain decisions, durable state, or local persistence ownership, it should usually land here.

## Setup commands

- Check daemon-side prerequisites from the repository root: `pnpm setup:dev`
- Check only the pinned Go lint tool version from the repository root: `pnpm check:golangci-version`
- Install pinned `golangci-lint` locally before running daemon lint commands: `pnpm install:golangci-lint`
- Generate builtin workspace apps before bare daemon Go commands: `pnpm generate:builtin-apps`
- Run daemon tests from the repository root: `pnpm test:go`
- Build daemon from the repository root: `pnpm build:go`

## Current top-level shape

Keep the current top-level structure unless there is a clear reason to change it:

```text
main.go
wiring.go
app/
api/
biz/
data/
integration/
server/
service/
types/
```

## Layering rules

- `main.go`: process bootstrap only
- `wiring.go`: hand-written dependency injection and composition root
- `app/`: process lifecycle around the HTTP server
- `server/`: HTTP server assembly
- `api/`: transport-facing handlers and DTOs
- `service/`: use-case orchestration
- `biz/`: small domain-local models shared across layers
- `data/`: persistence adapters
- `integration/`: daemon-wide black-box and process-level tests
- `types/`: cross-domain helpers only

## Agent CLI ownership

- `tuttid` owns agent provider availability, agent session workflows, and AgentGUI launch intent publication.
- `apps/cli` must remain a thin daemon client for `tutti agent`; it should parse terminal shape and render daemon output, not call desktopd, renderer-private APIs, or agent runtimes directly.
- AgentGUI launch requests from CLI or other local integrations should enter `tuttid` first and be published as business events on `/v1/events/ws`.
- Keep provider availability naming separate from session status naming. CLI launch surfaces use `agent list` and exact agent ids; provider availability is derived diagnostic metadata on each catalog entry, not the launch identity.

## Complexity guidance

- prefer the narrowest structure that keeps responsibility clear
- do not split small logic into several thin files unless the split creates a clearer boundary
- do not create a full domain slice until that domain has enough real behavior to justify it
- do not introduce a DI framework unless the dependency graph becomes meaningfully harder to manage

## Persistence and state rules

- daemon-owned local state defaults to `~/.tutti` in production and `~/.tutti-dev` in development
- prefer deriving new daemon-owned file paths from `TUTTI_STATE_DIR` helpers instead of writing directly under `$HOME`
- keep persistence ownership inside `data/*`

## Testing defaults

- Run `pnpm lint:go`
- Run `pnpm test:go && pnpm build:go` before finishing daemon changes
- Add or update tests when changing handlers, service logic, or persistence behavior
- Keep near-layer tests beside the package they exercise; place real-process or cross-layer daemon tests under `integration/`

## Related docs

- [docs/conventions/tuttid-layering.md](../../docs/conventions/tuttid-layering.md)
- [docs/conventions/workspace-domain.md](../../docs/conventions/workspace-domain.md)
- [docs/conventions/local-state-storage.md](../../docs/conventions/local-state-storage.md)
