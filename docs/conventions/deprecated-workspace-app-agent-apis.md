# Deprecated Workspace App Agent APIs

Three workspace-app-scoped Agent HTTP routes remain as compatibility aliases
while apps migrate to `@tutti-os/agent-acp-kit/tutti` and the Tutti CLI facade:

| Route                                                                                        | Replacement                       |
| -------------------------------------------------------------------------------------------- | --------------------------------- |
| `GET /v1/workspaces/{workspaceID}/apps/{appID}/preferences/agent`                            | `loadTuttiAgentProviderCatalog()` |
| `GET /v1/workspaces/{workspaceID}/apps/{appID}/agent-providers/status`                       | `loadTuttiAgentProviderCatalog()` |
| `POST /v1/workspaces/{workspaceID}/apps/{appID}/agent-providers/{provider}/composer-options` | `loadTuttiAgentComposerOptions()` |

Do not add new consumers. The compatibility routes keep their current auth and
response contracts until the removal gate below is satisfied.

## Usage telemetry

Every authenticated request that resolves to an installed app emits
`deprecated_workspace_app_agent_api_used` with:

- `route`: one of the stable telemetry identifiers `preferences/agent`,
  `agent-providers/status`, or
  `agent-providers/{provider}/composer-options` (these are suffix identifiers,
  not the full HTTP route templates above);
- `app_id`: the installed app package id, used to identify the migration owner;
- `workspace_app_version`: the installed workspace app package version (or
  `unknown` for a legacy package without version metadata);
- `migration_target`: `agent-acp-kit-tutti-cli-facade`.

The reporter's normal `app_version` dimension is the Tutti daemon version, not
the workspace app package version. It also adds OS, device, and
analytics-session dimensions. Never add workspace ids, credentials, cwd values,
request bodies, provider selections, or other run data to this event.

Release owners must review a rolling 30-day production count grouped by
`route`, `app_id`, and `workspace_app_version`. A missing dashboard or disabled
telemetry is unknown usage, not zero usage.

## Removal gate

The tracking milestone is `workspace-app-agent-http-removal`. The routes may be
removed in the first breaking daemon API release on or after **2026-09-01** only
when all of these conditions are recorded in that release's tracking issue:

1. `@tutti-os/agent-acp-kit/tutti` has shipped in at least two consecutive
   stable Tutti releases.
2. Each route has zero production events for 30 consecutive days across all
   supported stable app versions.
3. Repository and organization-wide searches find no route consumers; every
   previously observed `app_id` has migrated or has an approved retirement.
4. The OpenAPI operations, generated handlers, route registrations, tests, and
   this document are removed together.

Any observed event resets the 30-day zero-usage window for that route. Until
all four gates pass, retain the routes and continue emitting telemetry.
