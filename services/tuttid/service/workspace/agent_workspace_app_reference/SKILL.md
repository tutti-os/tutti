---
name: tutti-agent-workspace-app
description: "Build or evolve a complex agent-enabled Tutti workspace app repository. Use for Tutti apps with web/server/shared monorepos, @tutti-os/agent-acp-kit local agent runtimes, Codex or Claude provider detection, run-scoped MCP tool gateways, app-owned package builders, Tutti CLI/reference surfaces, web-first debugging, i18n harnesses, and production package validation. For simple package creation or repair, use tutti-workspace-app-factory instead."
---

# Tutti Agent Workspace App

Use this skill when the task is to create or evolve a full Tutti app repository, not just a final package directory. The target app is usually a local-first web app with a server, shared contracts, optional local agent runtime, and an app-owned `scripts/package-tutti-app.mjs`.

For the final package contract, defer to `$tutti-workspace-app-factory` and its references. This skill owns app architecture patterns; the factory skill owns `tutti.app.json`, `tutti.cli.json`, `bootstrap.sh`, runtime env, storage, i18n harness, and static package validation rules.

## When To Use

Use this skill for:

- New agent-enabled Tutti app repositories.
- Existing web/server apps being converted into maintainable Tutti app repos.
- Apps that need `@tutti-os/agent-acp-kit` for local Codex or Claude runtime execution.
- App-specific MCP or command gateways that expose domain tools to local agents.
- Multi-package `pnpm` workspaces with `apps/web`, `apps/server`, and `packages/shared`.
- App-owned packaging, smoke tests, i18n enforcement, and CLI/reference endpoints.
- GitHub Actions release workflows for publishing Tutti app releases and staging/production catalogs.

Use `$tutti-workspace-app-factory` instead for a small standalone package, package repair, or manifest-only validation.

## Required References

Read only the references needed for the task:

- `references/app-architecture.md` for repository layout, web/server/shared boundaries, and dependency choices.
- `references/agent-acp-kit.md` when implementing local agent providers, provider detection, ACP event mapping, or run-scoped MCP tools.
- `references/package-builder.md` when adding `scripts/package-tutti-app.mjs`, `bootstrap.sh`, Tutti CLI output docs, or package validation.
- `references/github-actions-release.md` when creating or changing `.github/workflows/publish-tutti-app.yml`, `.github/workflows/publish-tutti-app-staging.yml`, release variables, or catalog publishing.
- `references/i18n-and-web-debugging.md` when changing UI copy, language handling, web-first debug flow, or smoke/e2e checks.

Also read `$tutti-workspace-app-factory` before changing final package files or package runtime behavior.

## Workflow

1. Inspect the existing app shape, scripts, runtime dependencies, build output, storage, i18n, and agent surfaces.
2. Choose the smallest architecture that can stay maintainable: do not add local agents, WebSocket, MCP, CLI, or background workers unless the product needs them.
3. Define shared contracts before wiring web/server calls. Keep domain DTOs, WebSocket messages, CLI-visible shapes, and runtime profile types in `packages/shared`.
4. Build the web UI as the primary development surface. Keep the server as local API/static host and app orchestration layer.
5. If agents are needed, add `@tutti-os/agent-acp-kit`, provider detection, runtime provider abstraction, event normalization, and a run-scoped tool gateway.
   The main app flow must offer at least Claude Code and Codex as provider options when they are detected as available. Pick one available provider as the default; do not hard-code a single provider.
6. Add package generation only after the local dev app runs. Package the built web assets, bundled server, `tutti.app.json`, optional `tutti.cli.json`, executable `bootstrap.sh`, assets, locales, and package-local `AGENTS.md`.
7. If the user asks to connect to the Tutti app ecosystem, treat ecosystem integration as required: expose app capabilities through `tutti.cli.json`, make the app callable by other Tutti apps and agents, and use `TUTTI_CLI` for any calls to other installed Tutti apps.
8. For GitHub-hosted app repositories that should publish releases, add staging and production release workflows after the package builder is stable.
9. Verify with the repo's targeted checks first, then package checks.

## Validation

Prefer app-local scripts when they exist:

```bash
pnpm check
pnpm test
pnpm typecheck
pnpm check:i18n
pnpm package:tutti
```

For final package validation, run the validator from `$tutti-workspace-app-factory` when available:

```bash
python3 <factory-skill>/scripts/validate_tutti_app_package.py <generated-package-root>
```

If the app includes real local agent execution, add or run a smoke check that starts with provider detection before launching a real turn.
