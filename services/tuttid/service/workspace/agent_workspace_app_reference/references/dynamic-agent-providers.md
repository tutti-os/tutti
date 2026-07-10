# Dynamic Agent Provider Integration

Use this reference whenever an app exposes agent provider pickers, runtime profiles, default provider selection, or provider-specific UI.

## Rule

Never hard-code an agent provider catalog such as `codex` and `claude` only. Inside Tutti, the workspace-app scoped daemon API is the provider catalog source of truth. New providers such as `cursor` and `opencode` should appear automatically when Tutti exposes an enabled Agent Target and the installed `@tutti-os/agent-acp-kit` can execute it.

The app owns presentation and policy. Tutti owns provider visibility, preferences, availability, and composer options; the kit owns runtime registration, standalone detection, and execution.

The workspace-app scoped provider APIs first ship in Tutti `0.1.19-rc.0`. Production app releases use stable compatibility floors, so set `min_tutti_version` to at least `0.1.19` for apps that use this integration.

## Architecture

```text
Tutti workspace-app scoped APIs
  -> preferences/agent                            // preferred provider + gates
  -> agent-providers/status                       // visible Agent Targets + availability
  -> agent-providers/{provider}/composer-options  // models + reasoning + speed
    -> app API: GET /api/agents/providers
      -> web UI renders the returned catalog dynamically
        -> user selects providerId from catalog response
          -> normalize daemon ID to kit runtime ID
            -> localAgentRuntime.run({ provider: runtimeProviderId, ... })

createDefaultLocalAgentProviderPlugins()
  -> createLocalAgentRuntime({ providers })       // execution + standalone detection
```

Do not maintain a parallel static provider list in web, shared, or server code unless the app has a documented, provider-specific capability gap.

## Registration

Always register providers from the kit default plugin set unless the app adds a documented custom ACP provider:

```ts
import {
  createDefaultLocalAgentProviderPlugins,
  createLocalAgentRuntime
} from "@tutti-os/agent-acp-kit";

const localAgentRuntime = createLocalAgentRuntime({
  providers: createDefaultLocalAgentProviderPlugins()
});
```

Upgrade `@tutti-os/agent-acp-kit` when Tutti adds providers. Do not copy provider IDs into the app repository to "stay compatible".

## Discovery

Expose one app-owned backend endpoint, such as `GET /api/agents/providers`, that returns the provider catalog. Inside Tutti, build it from the app-scoped daemon APIs. Keep the daemon token in the server process.

Define an app-owned client around the daemon fields used by the app:

```ts
type AvailabilityStatus =
  | "ready"
  | "not_installed"
  | "auth_required"
  | "unsupported"
  | "unknown";

interface ProviderStatus {
  provider: string;
  availability: { status: AvailabilityStatus; reasonCode?: string | null };
}

interface TuttiAppAgentCatalogClient {
  getAgentPreferences(): Promise<{ defaultAgentProvider: string }>;
  getAgentProviderStatuses(): Promise<{ providers: ProviderStatus[] }>;
  getAgentProviderComposerOptions(provider: string): Promise<unknown>;
}
```

Only request composer options for ready providers. Keep composer failures local to one provider:

```ts
async function getComposerOptions(
  tutti: TuttiAppAgentCatalogClient,
  status: ProviderStatus,
  available: boolean
) {
  if (!available) return null;
  try {
    return await tutti.getAgentProviderComposerOptions(status.provider);
  } catch {
    return null;
  }
}
```

Use the returned `providers` array and `defaultAgentProvider` field:

```ts
export async function listAppAgentProviders(
  tutti: TuttiAppAgentCatalogClient,
  registeredKitProviderIds: ReadonlySet<string>
) {
  const [preferences, snapshot] = await Promise.all([
    tutti.getAgentPreferences(),
    tutti.getAgentProviderStatuses()
  ]);

  return Promise.all(
    snapshot.providers.map(async (status) => {
      const runtimeProviderId = toKitAgentProviderId(status.provider);
      const runtimeSupported = registeredKitProviderIds.has(runtimeProviderId);
      const available =
        status.availability.status === "ready" && runtimeSupported;
      return {
        ...status,
        runtimeProviderId,
        available,
        reasonCode: runtimeSupported
          ? (status.availability.reasonCode ?? undefined)
          : "kit_runtime_unavailable",
        preferred: status.provider === preferences.defaultAgentProvider,
        composerOptions: await getComposerOptions(tutti, status, available)
      };
    })
  );
}
```

Build `registeredKitProviderIds` from `localAgentRuntime.listProviders()`. Use it only to disable catalog entries that the installed kit cannot execute; never use it to add or remove entries from Tutti's provider list.

The app-owned client must call these routes with `TUTTI_APP_SERVER_TOKEN` as a bearer credential:

- `GET /v1/workspaces/{workspaceID}/apps/{appID}/preferences/agent`
- `GET /v1/workspaces/{workspaceID}/apps/{appID}/agent-providers/status`
- `POST /v1/workspaces/{workspaceID}/apps/{appID}/agent-providers/{provider}/composer-options`

Omit an app-local `providers` filter from the status request. Use `TUTTI_API_BASE_URL`, `TUTTI_WORKSPACE_ID`, and `TUTTI_APP_ID` to build the routes. Never expose the token to browser code.

UI rules:

- Render every provider returned by the API response.
- Show unavailable providers as disabled. Map the returned `reasonCode` to localized UI copy; do not render the raw code.
- Do not filter the list down to Codex/Claude in frontend code.
- Derive display names from provider IDs with an app-owned formatter. Keep brand-casing overrides presentation-only; never use them to decide visibility or runtime support.

Default provider selection:

- Prefer the Tutti default provider when it is present and available, then the user's last valid app selection.
- Otherwise choose the first available catalog provider.
- Do not default to `codex` or `claude`.

Persisted runtime profiles must store the Tutti provider ID returned by the catalog, not a fixed union such as `"codex" | "claude-code"`. Normalize to a kit runtime ID only at the execution boundary.

## Provider ID Normalization

Tutti daemon/OpenAPI IDs and kit runtime IDs can differ. Normalize at boundaries only:

| Tutti daemon / OpenAPI                              | Kit runtime ID | Notes                               |
| --------------------------------------------------- | -------------- | ----------------------------------- |
| `claude-code`                                       | `claude`       | common alias                        |
| `tutti-agent`                                       | `nexight`      | only when the kit exposes `nexight` |
| `codex`, `cursor`, `opencode`, `hermes`, `openclaw` | same           | usually identical                   |

Use one small helper instead of scattered `if (provider === "codex")` branches:

```ts
const KIT_TO_DAEMON_PROVIDER: Record<string, string> = {
  claude: "claude-code",
  nexight: "tutti-agent"
};

export function toDaemonAgentProviderId(kitProviderId: string) {
  return KIT_TO_DAEMON_PROVIDER[kitProviderId] ?? kitProviderId;
}

export function toKitAgentProviderId(daemonProviderId: string) {
  const normalized = daemonProviderId.trim().toLowerCase();
  if (normalized === "claude-code") return "claude";
  if (normalized === "tutti-agent") return "nexight";
  return normalized;
}
```

Extend this map when Tutti documents a new alias. Do not rebuild a full static provider catalog in the app.

## Standalone development

When the app runs inside Tutti, do not replace the app-scoped catalog with `localAgentRuntime.listProviders()` or `localAgentRuntime.detect(...)`. Tutti's catalog controls which Agent Targets are visible to workspace apps.

For standalone development outside Tutti, use the full kit default plugin set and call runtime detection directly:

```ts
const detections = await localAgentRuntime.detect();
```

Treat standalone detection as a separate development mode. Inside Tutti, return an unavailable state when a catalog request fails. Show retry guidance and do not invent provider entries. Do not query the app-scoped status route with `providers=codex&providers=claude-code`, and do not treat kit registration as permission to expose a provider that Tutti omitted.

## Optional Capability Filtering

Some apps need provider-specific stream adapters (for example Claude `<reasoning>` splitting or Codex tagged reasoning). That is allowed, but it must be explicit:

```ts
function createAppLocalAgentProviderPlugins() {
  return createDefaultLocalAgentProviderPlugins().map((provider) => {
    if (provider.id === "claude")
      return withClaudeStreamCompatibility(provider);
    if (provider.id === "codex") return withCodexStreamCompatibility(provider);
    return provider;
  });
}
```

Rules:

- Add compatibility wrappers per provider ID; do not `.filter()` the default plugin list unless the product truly cannot run other providers.
- If the app must temporarily exclude a provider, document the gap in app `AGENTS.md` and remove the filter once the adapter exists.
- Never exclude `cursor`, `opencode`, or future kit providers by default.

## Host Bridge Integration

When opening Tutti host features such as `window.tuttiExternal?.workspace?.openFeature({ feature: "agent-chat", provider })`, pass the daemon/OpenAPI provider ID derived from the user's current selection:

```ts
openFeature({
  feature: "agent-chat",
  provider: toDaemonAgentProviderId(selectedProviderId)
});
```

Do not type the bridge provider as `"codex" | "claude-code"` only. Accept `string` and validate against the latest Tutti catalog or standalone detection result when needed.

Host-owned provider lists are exposed through the workspace-app scoped daemon APIs, not injected through the browser bridge. Desktop preferences cannot expand an app UI that still hard-codes Codex/Claude.

## Model IDs

Use provider-prefixed app model IDs built from catalog or standalone detection output:

```ts
const appModelId = `${provider}:${model.id}`;
```

Resolve the provider runtime model by stripping the prefix or by storing `providerModelId` separately. Do not assume only `codex:*` and `claude:*` exist.

## Anti-Patterns

Do not:

- hard-code `["codex", "claude"]`, `Set(["codex", "claude"])`, or TypeScript unions limited to those providers for runtime state
- require "at least Claude Code and Codex" in UI copy or validation
- map display names with only Codex/Claude branches when detection already returns `displayName`
- query the workspace-app scoped `agent-providers/status` route with a fixed provider subset
- synthesize a fixed provider catalog when Tutti catalog loading fails
- filter `createDefaultLocalAgentProviderPlugins()` to Codex/Claude unless documented as a temporary product constraint
- shell out to `$TUTTI_CLI agent ...` for provider discovery

## Verification

Add tests for:

- app status request omits app-local provider filters
- UI/provider picker renders every provider returned by Tutti and disables daemon-unavailable or kit-unsupported entries
- default provider comes from Tutti preferences, a valid persisted app selection, or the first available catalog result
- provider ID normalization covers `claude-code` <-> `claude` and daemon-only IDs such as `cursor` / `opencode`
- catalog failure exposes an unavailable state without synthetic providers
- standalone detection returns every registered kit provider entry
- local run creation accepts catalog providers that map to installed runtime plugins
- managed run creation accepts only `isManagedAgentInvocationProviderId(...)` providers

For smoke tests, load the Tutti catalog first (or run standalone detection), then execute one narrow turn on whichever provider is available. Do not assume Codex or Claude is installed.
