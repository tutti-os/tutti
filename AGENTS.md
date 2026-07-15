# AGENTS.md

## Shape

`tutti` is a local-first desktop monorepo.

- `services/tuttid`: business rules, durable local state, daemon workflows
- `apps/desktop`: Electron shell, preload, renderer UI, desktop integration
- `packages/clients/*`: generated and hand-written domain clients
- `packages/configs/*`: shared TypeScript and formatting config
- `config`: sources used to generate runtime defaults

Keep business logic in `services/tuttid`. Do not let `apps/desktop` become a second business core. Do not create vague packages such as `shared`, `common`, `utils`, or `client-sdk`.

## Routing

Read the closest `AGENTS.md` before editing:

- `apps/desktop/*` -> `apps/desktop/AGENTS.md`
- `services/tuttid/*` -> `services/tuttid/AGENTS.md`
- `packages/agent/gui/*` -> `packages/agent/gui/AGENTS.md`
- `packages/ui/*` -> `packages/ui/AGENTS.md`
- `packages/*` -> `packages/AGENTS.md`

Use this root file for repository-wide defaults only. Area-specific files win.

Also route by module name, not only by path. If a request mentions AgentGUI,
AgentGuiNode, Agent GUI, the agent conversation module, agent composer,
workspace agent timeline, agent approvals, or interactive agent prompts, read
`docs/architecture/agent-gui-node.md` first, then
`packages/agent/gui/AGENTS.md`, before planning or editing, even when no file
path is supplied.

## Contribution Workflow

Before preparing commits or pull requests, read `CONTRIBUTING.md` and follow it
for repository-wide contribution requirements, including Conventional Commits,
DCO sign-off, PR workflow, review gates, and multilingual documentation updates.

## Hard Rules

- Published workspace packages use `@tutti-os/*`; keep manifests, imports, docs, and release config aligned.
- Do not start subagents unless the user explicitly approves it first.
- Do not invoke or use Superdesign.
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

- Local iteration: `pnpm check:changed`
- TS/desktop/shared changes: `pnpm lint:ts` and `pnpm typecheck`
- Desktop-facing behavior: also `pnpm --filter @tutti-os/desktop build`
- UI-system exports, CSS, SVG/icon rules: `pnpm check:ui-boundaries`
- Renderer feature boundaries: `pnpm check:renderer-boundaries`
- User-visible copy or locale resources: `pnpm check:i18n`
- Defaults source under `config/tutti.defaults.json`: `pnpm generate:defaults` and `pnpm check:defaults-generated`
- Daemon changes: `pnpm lint:go` and `cd services/tuttid && go test ./... && go build ./...`
- TypeScript + Go surface changes: `pnpm lint`

Avoid full validation unless it is necessary for the risk or requested workflow.
For small UI-only changes, prefer focused tests, lint for touched files, or
`pnpm check:changed` over `pnpm check:full`.

## Hooks

Local hooks use Husky.

- `pre-commit`: `lint-staged`, staged Electron/UI/renderer boundary checks
- `pre-push`: `pnpm check:full`

Prefer `pnpm check:changed` before broader validation during normal AI iteration. It runs selected lanes concurrently, prints compact summaries, and stores full logs under `.tmp/check-runs`; use `--tail-lines <n>` to tune failure tails.

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
