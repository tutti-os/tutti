# App Architecture

Use this reference for full app repositories. Keep the final package contract in `$tutti-workspace-app-factory`.

## Repository Shape

Prefer this shape for agent-enabled apps:

```text
app-name/
  apps/
    web/
      src/
      package.json
    server/
      src/
      package.json
  packages/
    shared/
      src/
      package.json
  docs/
  locales/
  scripts/
    package-tutti-app.mjs
  COMMANDS.md
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  tutti.app.json
  tutti.cli.json
```

For a multi-app catalog repository, use `apps/<app-id>/` with each app owning its source, i18n config, and `tutti-package/` inputs. Keep shared repository scripts under root `scripts/`.

## Boundaries

- `apps/web`: React/Next/Vite UI, UI state, API/WS client, host bridge wrappers. Do not place core orchestration here.
- `apps/server`: local HTTP runtime, static asset hosting, WebSocket, storage, domain use-cases, local agent runtime providers, tool gateway, Tutti CLI/reference endpoints.
- `packages/shared`: stable contracts consumed by web and server: DTOs, WebSocket messages, command output envelopes, runtime profile types, and schema helpers.
- `scripts`: deterministic build, validation, and package generation.
- `docs`: plans and architecture notes. Keep executable contracts in code and package manifests.

## Dependency Defaults

Use `pnpm` workspaces by default. Common choices:

- Server: Fastify, `@fastify/static`, `@fastify/websocket`, zod or ajv for schemas.
- Web: React with Vite, Next, or TanStack Start, matching the repo's current stack.
- Agent runtime: `@tutti-os/agent-acp-kit` when local Codex/Claude execution is required.
- I18n: `i18next`, `react-i18next`, and `i18next-cli` for larger web apps.
- Tests: Vitest or Node test runner for packages, Playwright only for cross-boundary UI flows.

Avoid introducing monorepo tooling, background workers, WebSocket, local agents, or MCP gateways unless the app workflow needs them.

## Server Runtime Conventions

Local development:

- Root `pnpm dev` should build `packages/shared` first, then run `apps/server` and `apps/web`.
- Keep the app server bound to `127.0.0.1`.
- Provide a health endpoint such as `/api/health`.
- Provide a bootstrap/snapshot endpoint when the web UI needs initial state.
- Add `/api/ws` only when real-time state or streaming is required.
- Add `/tutti/cli/*` and `/tutti/references/*` only for external agent or CLI surfaces.

Tutti package startup:

- `bootstrap.sh` takes no arguments.
- Bind to `$TUTTI_APP_HOST:$TUTTI_APP_PORT`.
- Use `$TUTTI_APP_NODE`, `$TUTTI_APP_PYTHON`, and `$TUTTI_APP_NPM`; do not rely on system runtime names.
- Treat `$TUTTI_APP_PACKAGE_DIR` as read-only after startup.
- Store durable data under `$TUTTI_APP_DATA_DIR`.
- Store scratch files under `$TUTTI_APP_RUNTIME_DIR`.
- Write file logs under `$TUTTI_APP_LOG_DIR` only when needed.
- Read `$TUTTI_WORKSPACE_ROOT` only for explicit workspace features.

## Host Bridge

Use one narrow browser wrapper for Tutti host calls. The web app must continue to run in a normal browser.

```ts
export interface TuttiWorkspaceAppBridge {
  app?: {
    getContext(): Promise<{ workspaceId?: string; locale?: string }>;
    subscribe?(
      listener: (context: { workspaceId?: string; locale?: string }) => void
    ): () => void;
  };
  files?: {
    open(input: {
      path: string;
      name?: string;
      mode?: "auto" | "preview" | "reveal";
    }): Promise<void>;
  };
  workspace?: {
    openFeature(input: {
      feature:
        | "app-center"
        | "issue-manager"
        | "message-center"
        | "agent-connect"
        | "agent-chat";
      provider?: string;
    }): Promise<void>;
  };
}

declare global {
  interface Window {
    tuttiExternal?: TuttiWorkspaceAppBridge;
  }
}
```

Host-only actions should fail softly or fall back to a local browser behavior.
