# Dynamic Agent Provider Integration

Use this reference whenever an app exposes agent provider pickers, runtime profiles, default provider selection, or provider-specific UI.

## Rule

Never hard-code an agent provider catalog such as `codex` and `claude` only. Tutti host and `@tutti-os/agent-acp-kit` evolve together: new local providers such as `cursor` and `opencode` should appear in workspace apps automatically when the installed kit and machine environment support them.

The app owns presentation and policy, but provider registration and discovery come from the kit and optional Tutti daemon status APIs.

## Architecture

```text
createDefaultLocalAgentProviderPlugins()
  -> createLocalAgentRuntime({ providers })
    -> localAgentRuntime.detect(context)          // availability + models
    -> optional merge with tuttid provider status // cloud/managed enrichment
      -> app API: GET /api/agents/providers
        -> web UI renders detected providers dynamically
          -> user selects providerId from detection response
            -> localAgentRuntime.run({ provider: providerId, ... })
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

Expose one app-owned backend endpoint (for example `GET /api/agents/providers`) that returns the detected provider catalog. Build it from kit detection:

```ts
import { createManagedAgentDetectContextFromHeaders } from "@tutti-os/agent-acp-kit";

export async function listAppAgentProviders(
  headers: Headers | Record<string, string | string[] | undefined>
) {
  const context = createManagedAgentDetectContextFromHeaders(headers);
  const detections = await localAgentRuntime.detect(context);

  return detections.map(({ provider, displayName, result }) => ({
    provider,
    displayName: displayName ?? provider,
    available: Boolean(result && result.supported !== false),
    authState: result?.authState ?? "unknown",
    executablePath: result?.executablePath ?? "",
    version: result?.version ?? "not-installed",
    models: (result?.models ?? []).map((model) => ({
      id: `${provider}:${model.id}`,
      label: model.label,
      providerModelId: model.id
    })),
    reason:
      result && result.supported !== false
        ? undefined
        : (result?.unsupportedReason ??
          `${displayName ?? provider} is not installed or not discoverable.`)
  }));
}
```

UI rules:

- Render every detected provider from the API response.
- Show unavailable providers as disabled with the server-provided `reason`.
- Do not filter the list down to Codex/Claude in frontend code.
- Use `displayName` from detection for labels. Allowlist product names in i18n checks; do not hard-code label maps such as `if (provider === "codex")`.

Default provider selection:

- Prefer the user's last valid selection stored in app state/preferences.
- Otherwise choose the first available detected provider.
- Do not default to `codex` or `claude`.

Persisted runtime profiles must store the kit `provider` string from detection, not a fixed union such as `"codex" | "claude"`.

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

## Optional Tutti Daemon Enrichment

In cloud/managed Tutti, the app server may receive `TUTTI_API_BASE_URL` and `TUTTI_APP_SERVER_TOKEN`. When both are present, enrich kit detection with daemon provider status instead of replacing discovery with a hard-coded provider query.

Derive the query list from registered kit providers:

```ts
const registered = localAgentRuntime.listProviders().map((item) => item.id);
const url = new URL("/v1/agent-providers/status", baseUrl);
for (const providerId of registered.map(toDaemonAgentProviderId)) {
  url.searchParams.append("providers", providerId);
}
```

Merge daemon status back onto kit detection by normalized provider ID. Keep any kit-only provider that the daemon did not return. When daemon credentials are absent, return kit detection only.

Do not query only `providers=codex&providers=claude-code`.

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

Do not type the bridge provider as `"codex" | "claude-code"` only. Accept `string` and validate against the latest detected catalog when needed.

Host-owned provider lists are not injected into workspace apps. Do not expect desktop default-provider preferences to expand an app UI that still hard-codes Codex/Claude.

## Model IDs

Use provider-prefixed app model IDs built from detection output:

```ts
const appModelId = `${provider}:${model.id}`;
```

Resolve the provider runtime model by stripping the prefix or by storing `providerModelId` separately. Do not assume only `codex:*` and `claude:*` exist.

## Anti-Patterns

Do not:

- hard-code `["codex", "claude"]`, `Set(["codex", "claude"])`, or TypeScript unions limited to those providers for runtime state
- require "at least Claude Code and Codex" in UI copy or validation
- map display names with only Codex/Claude branches when detection already returns `displayName`
- query `/v1/agent-providers/status` with a fixed provider subset
- filter `createDefaultLocalAgentProviderPlugins()` to Codex/Claude unless documented as a temporary product constraint
- shell out to `$TUTTI_CLI agent ...` for provider discovery

## Verification

Add tests for:

- detection endpoint returns every registered kit provider entry
- UI/provider picker renders all detected providers and disables unavailable ones
- default provider comes from persisted preference or first available detection result
- provider ID normalization covers `claude-code` <-> `claude` and daemon-only IDs such as `cursor` / `opencode`
- optional daemon enrichment uses registered providers, not a static query list
- run creation accepts any detected available `providerId`

For smoke tests, run detection first, then execute one narrow turn on whichever provider is available. Do not assume Codex or Claude is installed.
