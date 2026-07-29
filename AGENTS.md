# AGENTS.md

## Shape

`tutti` is a local-first desktop monorepo.

- `services/tuttid`: daemon product rules, durable local state, HTTP/query, and adapters
- `packages/agent/host`: provider-neutral agent lifecycle application core
- `apps/desktop`: Electron shell, preload, renderer UI, desktop integration
- `packages/clients/*`: generated and hand-written domain clients
- `packages/configs/*`: shared TypeScript and formatting config
- `config`: sources used to generate runtime defaults

Keep daemon/product-specific business logic in `services/tuttid`; keep extracted cross-consumer application cores in their owning package. Do not let `apps/desktop` become a second business core. Do not create vague packages such as `shared`, `common`, `utils`, or `client-sdk`.

## Routing

Read the closest `AGENTS.md` before editing:

- `apps/desktop/*` -> `apps/desktop/AGENTS.md`
- `services/tuttid/*` -> `services/tuttid/AGENTS.md`
- `packages/agent/gui/*` -> `packages/agent/gui/AGENTS.md`
- `packages/ui/*` -> `packages/ui/AGENTS.md`
- `packages/*` -> `packages/AGENTS.md`

Use this root file for repository-wide defaults only. Area-specific files win.

Route agent application-core requests to `packages/agent/host` first. If a
request mentions agent session, turn, goal, or runtime-operation lifecycle,
creation, resume, send, cancel, recovery, or the agent host boundary, read
`packages/agent/host/README.md` and the `Agent Host Boundary` section below
before planning or editing, then the nearest area `AGENTS.md`.

Also route by module name, not only by path. If a request mentions AgentGUI,
AgentGuiNode, Agent GUI, the agent conversation module, agent composer,
workspace agent timeline, agent approvals, or interactive agent prompts, read
`docs/architecture/agent-gui-node.md` first, then
`packages/agent/gui/AGENTS.md`, before planning or editing, even when no file
path is supplied.

## Agent Host Boundary

Agent application-core lifecycle semantics have a single owner:
`packages/agent/host`. That package owns when a session, turn, goal, or
runtime-operation is created, when it may be sent, when it reaches a terminal
state, and how it is recovered. `services/tuttid/service/agent` and other Host
consumers such as tsh `cmd/desktopd` are adapter surfaces that translate
HTTP, query, composer, analytics, transport, and provider-preparation concerns
and delegate lifecycle through `ApplicationHost()`.

Before adding or changing agent behavior, answer the decision rule:

> Does this change define or change the lifecycle semantics of a
> session/turn/goal/runtime-operation (when it is created, when it may be sent,
> when it is terminal, how it is recovered)?
>
> - Yes -> it must live in `packages/agent/host` (tuttid and tsh write only
>   delegate/adapter code).
> - No (transport, DTO, query, presentation, product policy) -> adapter.
> - Unsure -> answer in the PR description: "Does tsh (or another Host consumer)
>   also need this behavior?" If yes, it belongs in Host.

New lifecycle semantics must first gain a scenario in
`packages/agent/host/conformance`; scenarios may only program against the Host
contract. When a consumer finds a missing Host capability, add the Host API in
`packages/agent/host` and release it, rather than reimplementing it in the
adapter. The `GetSession`, `UpdateSettings`, `UpdatePin`, and `DeleteSession`
APIs were added to Host this way (PR #1329) after tsh's cutover surfaced them,
instead of being reimplemented in tsh.

`services/tuttid/service/agent/AGENTS.md` records the adapter-only rules for
that directory, and `pnpm check:agent-host-boundary` ratchets against new
`*Coordinator`/`*Worker`/`*Actor` orchestration surfaces landing in the
adapter.

## Contribution Workflow

Before preparing commits or pull requests, read `CONTRIBUTING.md` and follow it
for repository-wide contribution requirements, including Conventional Commits,
DCO sign-off, PR workflow, review gates, and multilingual documentation updates.

## Hard Rules

- Published workspace packages use `@tutti-os/*`; keep manifests, imports, docs, and release config aligned.
- All new requirements and features across Tutti projects must first reuse existing `@tutti-os/ui-system` components, semantic color tokens, typography, spacing, and other established UI conventions. Before introducing bespoke UI or raw color values, inspect the existing UI System exports and tokens; if the required capability is missing, prefer extending the shared UI System with a reusable primitive or token and document the rationale.
- User-visible copy must go through the relevant i18n layer. Do not hardcode UI text, dialog text, status labels, empty states, or user-facing errors.
- Chinese user-facing UI copy must not end with a Chinese full stop (。); keep this punctuation rule consistent across settings and other product surfaces.
- Change `services/tuttid/api/openapi/tuttid.v1.yaml` before daemon HTTP request/response contracts.
- Document new supported runtime/env overrides in the matching durable convention doc.
- Business-code files should stay at or below `800` lines. Prefer decomposition before adding more logic.
- When changing repository-managed checks, hooks, or static analysis, update `docs/conventions/local-git-hooks.md` or `docs/conventions/static-analysis.md`.
- When a fix captures a recurring debugging trap, route it through `docs/conventions/troubleshooting/README.md` and update the matching domain file.

## Self-Evolution Notes

After any code change, run a documentation impact check. If the change affects
module ownership, data flow, user-visible interaction, public API/CLI behavior,
runtime/config/env overrides, validation commands, troubleshooting paths, or
directory responsibility, update the corresponding durable documentation in the
same change.

When proposing a durable lesson from a completed fix or implementation, use the
AutoSkill-style decision set: `discard`, `improve`, `merge`, or `create`.
Record only reusable patterns backed by real implementation/debugging evidence.
Prefer improving or merging an existing note over creating duplicates, and
remove secrets, personal data, local paths, customer names, tokens, and one-off
issue details before writing any prompt, architecture, or troubleshooting
update. For `improve`, `merge`, or `create`, update the matching durable doc:
architecture docs for ownership/data-flow/interaction rules, convention docs
for repository-wide practices, README/package docs for usage or public
contracts, or troubleshooting docs for recurring symptom playbooks. Final
responses should mention which durable docs were updated, or state that no
documentation impact was found.

## Toolchain

- Package manager: `pnpm@10.11.0`
- TypeScript lint: `pnpm lint:ts` -> Oxlint
- TypeScript format: Oxfmt for TS/JS, Prettier for JSON/MD/YAML/CSS/HTML
- Typecheck: `pnpm typecheck` -> compact incremental native TypeScript `tsgo`
- Changed-aware local validation: `pnpm check:changed`
- Full local/CI validation: `pnpm check:full`
- Go lint requires the pinned `golangci-lint`; install with `pnpm install:golangci-lint`

## Common Checks

- UI-only exception: if a change modifies only UI presentation and does not alter logic or behavior, do not run any checks. This exception takes precedence over the checks below and includes tests, lint, typecheck, builds, boundary checks, and visual checks.
- For every other change, follow the single validation-selection policy in
  [Testing](docs/conventions/testing.md#validation-selection). Closest-area
  instructions may add a domain-specific check, but they do not redefine the
  repository workflow.

## Hooks

Local hooks use Husky.

- `pre-commit`: `lint-staged`, staged Electron/UI/renderer boundary checks
- `pre-push`: `pnpm check:changed -- --push-ready`

Changed-aware command behavior and rerun options are documented in
[Local Git Hooks](docs/conventions/local-git-hooks.md#changed-aware-validation).

## Conflict Workflows

For merge, rebase, cherry-pick, or manual conflict resolution, inspect both branch intents and never resolve source conflicts with `--ours` or `--theirs` unless explicitly asked. Review high-risk desktop, daemon API, generated contract, release, and shared test harness files manually. After conflicts, run `git diff --name-only --diff-filter=U` and targeted checks for the affected surface.

## Docs

Start from:

- `docs/conventions/README.md`
- `docs/architecture/README.md`
- nearest area `AGENTS.md`

## Logs

dev (when the feature is not in remote): ~/.tutti-dev/tuttid.db

prod: ~/.tutti/tuttid.db
