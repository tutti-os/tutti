# AGENTS.md

## Shape

`tutti` is a local-first desktop monorepo.

- `services/tuttid`: business rules, durable local state, daemon workflows
- `apps/desktop`: Electron shell, preload, renderer UI, desktop integration
- `packages/clients/*`: generated and hand-written domain clients
- `packages/configs/*`: shared TypeScript and formatting config
- `config`: sources used to generate runtime defaults

Keep business logic in `services/tuttid`. Do not let `apps/desktop` become a second business core. Move code into `packages/` only for a real shared boundary; do not create vague packages such as `shared`, `common`, `utils`, or `client-sdk`.

## Routing

Read the closest `AGENTS.md` before editing:

- `apps/desktop/*` -> `apps/desktop/AGENTS.md`
- `services/tuttid/*` -> `services/tuttid/AGENTS.md`
- `packages/ui/*` -> `packages/ui/AGENTS.md`
- `packages/*` -> `packages/AGENTS.md`

Use this root file for repository-wide defaults only. Area-specific files win.

## Hard Rules

- Published workspace packages use `@tutti-os/*`; keep manifests, imports, docs, and release config aligned.
- User-visible copy must go through the relevant i18n layer. Do not hardcode UI text, dialog text, status labels, empty states, or user-facing errors.
- Change `services/tuttid/api/openapi/tuttid.v1.yaml` before daemon HTTP request/response contracts.
- Document new supported runtime/env overrides in the matching durable convention doc.
- Business-code files should stay at or below `800` lines. Prefer decomposition before adding more logic.
- When changing repository-managed checks, hooks, or static analysis, update `docs/conventions/local-git-hooks.md` or `docs/conventions/static-analysis.md`.
- When a fix captures a recurring debugging trap, add the durable note to `docs/conventions/troubleshooting.md`.

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
