---
name: tutti-agent-workspace-app
description: "Build or evolve a complex agent-enabled Tutti workspace app repository. Use for Tutti apps with web/server/shared monorepos, @tutti-os/agent-acp-kit local agent runtimes, kit-owned TUTTI_CLI agent/composer discovery, dynamic agent catalogs, run-scoped MCP tool gateways, app-owned package builders, web-first debugging, i18n harnesses, and production package validation. For simple package creation or repair, use tutti-workspace-app-factory instead."
---

# Tutti Agent Workspace App

Use this skill when the task is to create or evolve a full Tutti app repository, not just a final package directory. The target app is usually a local-first web app with a server, shared contracts, optional local agent runtime, and an app-owned `scripts/package-tutti-app.mjs`.

For the final package contract, defer to `$tutti-workspace-app-factory` and its references. This skill owns app architecture patterns; the factory skill owns `tutti.app.json`, `tutti.cli.json`, `bootstrap.sh`, runtime env, storage, i18n harness, and static package validation rules.

## When To Use

Use this skill for:

- New agent-enabled Tutti app repositories.
- Existing web/server apps being converted into maintainable Tutti app repos.
- Apps that need `@tutti-os/agent-acp-kit` for app-owned local Agent execution and `@tutti-os/agent-acp-kit/tutti` for auto CLI-backed/standalone platform context.
- App-specific MCP or command gateways that expose domain tools to local agents.
- Multi-package `pnpm` workspaces with `apps/web`, `apps/server`, and `packages/shared`.
- App-owned packaging, smoke tests, i18n enforcement, and CLI/reference endpoints.
- GitHub Actions release workflows for publishing Tutti app releases and staging/production catalogs.

Use `$tutti-workspace-app-factory` instead for a small standalone package, package repair, or manifest-only validation.

## Required References

Read only the references needed for the task:

- `references/app-architecture.md` for repository layout, web/server/shared boundaries, and dependency choices.
- `references/agent-acp-kit.md` when implementing local agent providers, ACP event mapping, or run-scoped MCP tools.
- `references/dynamic-agent-providers.md` when implementing agent catalog/composer endpoints, standalone behavior, agent pickers, default selection, or canonical agent-id persistence. Read this before hard-coding any agent or provider list.
- `references/package-builder.md` when adding `scripts/package-tutti-app.mjs`, `bootstrap.sh`, Tutti CLI output docs, or package validation.
- `references/github-actions-release.md` when creating or changing `.github/workflows/publish-tutti-app.yml`, `.github/workflows/publish-tutti-app-staging.yml`, release variables, or catalog publishing.
- `references/i18n-and-web-debugging.md` when changing UI copy, language handling, web-first debug flow, or smoke/e2e checks.

Also read `$tutti-workspace-app-factory` before changing final package files or package runtime behavior.

## Workflow

1. Inspect the existing app shape, scripts, runtime dependencies, build output, storage, i18n, and agent surfaces.
2. Choose the smallest architecture that can stay maintainable: do not add local agents, WebSocket, MCP, CLI, or background workers unless the product needs them.
3. Define shared contracts before wiring web/server calls. Keep domain DTOs, WebSocket messages, CLI-visible shapes, and runtime profile types in `packages/shared`.
4. Build the web UI as the primary development surface. Keep the server as local API/static host and app orchestration layer.
5. If agents are needed, add an exact released `@tutti-os/agent-acp-kit`, use its default app-owned runtime, call the `/tutti` auto facade for catalog/composer/skill context, normalize events, and add a run-scoped tool gateway.
   Follow `references/dynamic-agent-providers.md`: do not pass mode, check `TUTTI_CLI`, call Agent catalog HTTP routes, read app ID/token/API environment, parse CLI JSON, or maintain provider aliases. Render every facade agent, persist exact agent target ids, keep unavailable entries disabled with their reason, and never maintain a fixed provider catalog.
   For apps that must run both locally and in cloud/managed Tutti, follow `references/agent-acp-kit.md` exactly: managed credentials come from request headers on the server, never from browser JSB fallback or request body fields.
6. Add package generation only after the local dev app runs. Package the built web assets, bundled server, `tutti.app.json`, optional `tutti.cli.json`, executable `bootstrap.sh`, assets, locales, and package-local `AGENTS.md`.
7. If the user asks to connect to the Tutti app ecosystem, treat ecosystem integration as required: expose app capabilities through `tutti.cli.json`, make the app callable by other Tutti apps and agents, and use `TUTTI_CLI` for any calls to other installed Tutti apps.
8. For GitHub-hosted app repositories that should publish releases, add staging and production release workflows after the package builder is stable.
9. Verify with the repo's targeted checks first, then package checks.

## Managed and standalone agent checklist

Keep Tutti-hosted and standalone behavior behind the kit's fixed auto facade while sharing the same runtime execution layer:

1. Pin an exact kit version that exports the auto catalog/composer/skill facade and managed header context helper.
2. Call `loadTuttiAgentCatalog({ runtime })`; do not use the deprecated provider-catalog projection, pass mode, or inspect `TUTTI_CLI`.
3. Load composer options lazily for one exact agent target id and expose only app/domain DTO projections.
4. Persist only canonical agent target ids returned by the facade. Migrate legacy provider-only state only when it maps unambiguously to one current agent; never retain provider as selection identity.
5. Await `createManagedAgentRunContextFromHeaders(...)` directly. Do not pre-read credentials or pre-check provider support in app code.
6. Without a managed header, use an app-owned local cwd. Pass the provider derived from the selected agent entry, selected cwd, and optional `managedAgentInvocation` into runtime execution.
7. Delete raw Agent HTTP/CLI clients, browser credential fallbacks, request-body credential fields, alias maps, and dependency patch scripts.
8. Never persist managed credentials or expose managed cwd and credentials through frontend events, logs, status APIs, or stored app state.
9. Do not hard-code `/workspace`, `.agent-runs`, or `CODEX_HOME`; the kit derives managed context.
10. If instructions arrive over WebSocket, confirm the host injects the managed credential into that route; do not create a second credential channel.
11. Package the built server, web assets, MCP/tool entrypoints, and runtime metadata needed by Tutti.
12. Test CLI-backed auto, standalone auto, configured CLI failure, canonical IDs, managed/local run context, and secret non-leakage.

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
