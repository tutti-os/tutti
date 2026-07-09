---
name: tutti-agent-workspace-app
description: "Build or evolve a complex agent-enabled Tutti workspace app repository. Use for Tutti apps with web/server/shared monorepos, @tutti-os/agent-acp-kit local agent runtimes, Tutti app-scoped agent provider APIs, dynamic provider catalogs (Codex, Claude Code, Cursor, OpenCode, and future supported providers), run-scoped MCP tool gateways, app-owned package builders, Tutti CLI/reference surfaces, web-first debugging, i18n harnesses, and production package validation. For simple package creation or repair, use tutti-workspace-app-factory instead."
---

# Tutti Agent Workspace App

Use this skill when the task is to create or evolve a full Tutti app repository, not just a final package directory. The target app is usually a local-first web app with a server, shared contracts, optional local agent runtime, and an app-owned `scripts/package-tutti-app.mjs`.

For the final package contract, defer to `$tutti-workspace-app-factory` and its references. This skill owns app architecture patterns; the factory skill owns `tutti.app.json`, `tutti.cli.json`, `bootstrap.sh`, runtime env, storage, i18n harness, and static package validation rules.

## When To Use

Use this skill for:

- New agent-enabled Tutti app repositories.
- Existing web/server apps being converted into maintainable Tutti app repos.
- Apps that need `@tutti-os/agent-acp-kit` for local agent runtime execution behind Tutti-owned dynamic provider catalog APIs.
- App-specific MCP or command gateways that expose domain tools to local agents.
- Multi-package `pnpm` workspaces with `apps/web`, `apps/server`, and `packages/shared`.
- App-owned packaging, smoke tests, i18n enforcement, and CLI/reference endpoints.
- GitHub Actions release workflows for publishing Tutti app releases and staging/production catalogs.

Use `$tutti-workspace-app-factory` instead for a small standalone package, package repair, or manifest-only validation.

## Required References

Read only the references needed for the task:

- `references/app-architecture.md` for repository layout, web/server/shared boundaries, and dependency choices.
- `references/agent-acp-kit.md` when implementing local agent providers, ACP event mapping, or run-scoped MCP tools.
- `references/dynamic-agent-providers.md` when implementing the Tutti app-scoped provider catalog, standalone detection, provider pickers, default provider selection, or provider ID normalization. Read this before hard-coding any provider list.
- `references/package-builder.md` when adding `scripts/package-tutti-app.mjs`, `bootstrap.sh`, Tutti CLI output docs, or package validation.
- `references/github-actions-release.md` when creating or changing `.github/workflows/publish-tutti-app.yml`, `.github/workflows/publish-tutti-app-staging.yml`, release variables, or catalog publishing.
- `references/i18n-and-web-debugging.md` when changing UI copy, language handling, web-first debug flow, or smoke/e2e checks.

Also read `$tutti-workspace-app-factory` before changing final package files or package runtime behavior.

## Workflow

1. Inspect the existing app shape, scripts, runtime dependencies, build output, storage, i18n, and agent surfaces.
2. Choose the smallest architecture that can stay maintainable: do not add local agents, WebSocket, MCP, CLI, or background workers unless the product needs them.
3. Define shared contracts before wiring web/server calls. Keep domain DTOs, WebSocket messages, CLI-visible shapes, and runtime profile types in `packages/shared`.
4. Build the web UI as the primary development surface. Keep the server as local API/static host and app orchestration layer.
5. If agents are needed, add `@tutti-os/agent-acp-kit`, Tutti app-scoped provider catalog integration, dynamic runtime provider registration, event normalization, and a run-scoped tool gateway.
   Follow `references/dynamic-agent-providers.md`: inside Tutti, derive provider options from the workspace-app scoped `preferences/agent`, `agent-providers/status`, and `agent-providers/{provider}/composer-options` APIs; keep the kit's default plugin set available for runtime execution and standalone detection. Render every provider returned by Tutti, keep unavailable entries disabled with their reason, choose one usable default, and never maintain a Codex/Claude-only app catalog.
   For apps that must run both locally and in cloud/managed Tutti, follow `references/agent-acp-kit.md` exactly: managed credentials come from request headers on the server, never from browser JSB fallback or request body fields.
6. Add package generation only after the local dev app runs. Package the built web assets, bundled server, `tutti.app.json`, optional `tutti.cli.json`, executable `bootstrap.sh`, assets, locales, and package-local `AGENTS.md`.
7. If the user asks to connect to the Tutti app ecosystem, treat ecosystem integration as required: expose app capabilities through `tutti.cli.json`, make the app callable by other Tutti apps and agents, and use `TUTTI_CLI` for any calls to other installed Tutti apps.
8. For GitHub-hosted app repositories that should publish releases, add staging and production release workflows after the package builder is stable.
9. Verify with the repo's targeted checks first, then package checks.

## Cloud-Compatible Local Agent Checklist

When adapting an existing local-first agent app for cloud/managed Tutti, the app must keep the local path working while removing app-owned credential plumbing:

1. Upgrade `@tutti-os/agent-acp-kit` to a version that exports managed-agent header context helpers.
2. In server-side detect/model endpoints, call `createManagedAgentDetectContextFromHeaders(req.headers)` and pass the returned context to `localAgentRuntime.detect(...)`.
3. In server-side run creation, call `createManagedAgentRunContextFromHeaders(req.headers, { providerId, runId })`.
4. Pass only `cwd: runContext.cwd` and `managedAgentInvocation: runContext.managedAgentInvocation` into `localAgentRuntime.run(...)`.
5. Delete browser JSB credential fallback code.
6. Delete request body credential fields and client-side credential forwarding.
7. Never persist managed credentials.
8. Never expose managed cwd or credentials through frontend events, logs, status APIs, or stored app state.
9. Do not hard-code `/workspace`, `.agent-runs`, or `CODEX_HOME` policy in the app business layer. Let the kit derive managed run context from headers and runtime env.
10. If agent instructions are sent over WebSocket, confirm the Tutti/TSH host injects the managed credential into that WebSocket route too; do not invent a second credential channel inside the app.
11. Add or update the cloud zip/package script so the packaged app contains the built server, web assets, MCP/tool entrypoints, and runtime metadata needed by Tutti.
12. Add tests covering SSR/server detect, model detect, run context creation, credential non-leakage, and local no-header fallback behavior.

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
