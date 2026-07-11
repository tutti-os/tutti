# Dynamic Agent Provider Integration

Use this reference whenever an app exposes an Agent provider picker, default provider, runtime profile, or provider-specific composer UI.

## Ownership rule

The integration has three layers:

```text
Tutti CLI owns platform capability and enabled Agent Target visibility
  -> @tutti-os/agent-acp-kit/tutti owns execution, parsing, validation, and fallback
    -> the app owns product policy, API projection, persistence, and UI
```

An app must not call workspace-app Agent catalog HTTP routes, build daemon URLs, read an Agent catalog bearer token, pass an app ID to provider discovery, spawn `TUTTI_CLI`, parse CLI JSON, or maintain provider ID mappings. The kit does all of that.

Provider IDs are an open string set. Persist and return the canonical `providerId` supplied by the kit. Do not define a closed `"codex" | "claude-code"` union. The SDK accepts the legacy input `claude` internally and emits `claude-code`; it does not map `nexight`, `tutti`, or `tutti-agent` to each other.

## Runtime registration

Create the standard app-owned execution runtime once:

```ts
import { createDefaultLocalAgentRuntime } from "@tutti-os/agent-acp-kit";

export const localAgentRuntime = createDefaultLocalAgentRuntime();
```

Only construct a custom plugin list when the app has a documented provider transport extension. Customization must transform the full default list; it must not silently filter the catalog to Codex and Claude.

## Provider catalog

The app server exposes an app-owned endpoint such as `GET /api/agents/providers`. Its implementation calls the SDK facade directly:

```ts
import { loadTuttiAgentProviderCatalog } from "@tutti-os/agent-acp-kit/tutti";
import { localAgentRuntime } from "./local-agent-runtime.js";

export async function getAgentProviderCatalog() {
  return await loadTuttiAgentProviderCatalog({
    runtime: localAgentRuntime
  });
}
```

Do not pass `mode` or `required`, and do not check `process.env.TUTTI_CLI` in app code. The facade behavior is fixed:

- if `TUTTI_CLI` resolves, the kit calls `tutti --json agent providers`, validates schema version 2, preserves enabled Agent Target order, and marks catalog entries that this kit cannot execute as `kit_runtime_unavailable`;
- if `TUTTI_CLI` is absent, the kit automatically builds a `source: "standalone"` catalog from `runtime.listProviders()` and `runtime.detect()`;
- if `TUTTI_CLI` is configured but execution, timeout, cancellation, or schema validation fails, the kit throws `TuttiIntegrationError`; it does not invent a standalone catalog.

The app may project the returned browser-safe DTO into product-specific fields, but it must not copy the Tutti CLI schema. Frontend code may import guards and types without Node dependencies:

```ts
import {
  isTuttiAgentProviderCatalog,
  type TuttiAgentProviderCatalog
} from "@tutti-os/agent-acp-kit/tutti/contracts";
```

UI rules:

- render every returned provider;
- disable entries whose `availability.status` is not `available`;
- localize `availability.reasonCode` instead of displaying raw codes;
- prefer an available `defaultProviderId`, then the last persisted available selection, then the first available provider;
- use `displayName` for presentation, with app-owned icon overrides only;
- never use kit registration to add a provider omitted by the Tutti CLI catalog.

## Composer options

Load composer options lazily for the selected provider:

```ts
import { loadTuttiAgentComposerOptions } from "@tutti-os/agent-acp-kit/tutti";

const composer = await loadTuttiAgentComposerOptions({
  runtime: localAgentRuntime,
  providerId: selectedProviderId,
  cwd: appLocalCwd,
  locale,
  model,
  reasoningEffort
});
```

The kit first verifies that `providerId` is present in the canonical catalog. In Tutti it calls `tutti --json agent composer-options --provider <providerId>`; standalone mode derives conservative model options from runtime detection and marks unsupported controls `configurable: false`.

Workspace Apps do not expose, persist, or pass a permission choice. Do not project a permission option returned by composer metadata into App UI, and omit `permission` from runtime execution input. The kit applies the Workspace App default of full access when `permission` is omitted. Interactive choices such as `auto` belong to Tutti AgentGUI and the manual CLI, not to an App-owned provider picker or composer.

Do not eagerly load composer options for every provider. A failure belongs to the selected provider UI and must not delete other catalog entries.

## Persistence and host bridge

Persist the canonical catalog ID. A one-time migration may rewrite `claude` to `claude-code`. Do not migrate `nexight` and `tutti-agent` into each other.

When invoking a host feature such as:

```ts
window.tuttiExternal?.workspace?.openFeature({
  feature: "agent-chat",
  provider: selectedProviderId
});
```

pass the canonical selected ID unchanged. Browser bridge types must accept `string`, then validate against the latest app endpoint response.

## Model IDs

If an app needs globally unique model IDs, store the canonical provider separately or prefix the provider model:

```ts
const appModelId = `${providerId}:${providerModelId}`;
```

Do not infer a provider from a model name or assume only Codex and Claude models exist.

## Anti-patterns

Do not add:

- raw daemon or app-scoped Agent catalog clients;
- provider conversion helpers, cross-provider aliases, or app-owned alias tables;
- app-local CLI argv builders, subprocess wrappers, JSON schemas, timeouts, or fallback modes;
- daemon URL, server credential, workspace identity, or app identity reads for Agent provider catalog/composer discovery;
- fixed provider allowlists or synthetic fallback catalogs;
- eager composer requests for all providers;
- permission selectors, persisted permission modes, or run-level `permission` arguments;
- code that patches `node_modules/@tutti-os/agent-acp-kit` or its built `dist` files.

## Verification

Add app tests that verify:

- the app calls the kit facade and does not implement raw CLI/HTTP protocol handling;
- every facade provider is projected and unavailable providers remain visible but disabled;
- canonical IDs round-trip through endpoint, persistence, UI selection, host bridge, and runtime input;
- legacy persisted `claude` migrates once to `claude-code`, while `nexight` and `tutti-agent` remain distinct;
- composer loading is lazy and one-provider failure is isolated;
- App execution omits `permission` and relies on the kit's full-access Workspace App default;
- no `mode`, app ID, Agent catalog token, alias helper, or dependency patch script is present.
