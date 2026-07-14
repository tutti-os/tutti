# Dynamic Agent Integration

Use this reference whenever an app exposes an Agent picker, default agent, runtime profile, or agent-specific composer UI.

## Ownership rule

The integration has three layers:

```text
Tutti CLI owns platform capability and enabled Agent Target visibility
  -> @tutti-os/agent-acp-kit/tutti owns execution, parsing, validation, and fallback
    -> the app owns product policy, API projection, persistence, and UI
```

An app must not call workspace-app Agent catalog HTTP routes, build daemon URLs, read an Agent catalog bearer token, pass an app ID to agent discovery, spawn `TUTTI_CLI`, parse CLI JSON, or maintain provider ID mappings. The kit does all of that.

Agent IDs are the selection identity and are an open string set. Persist and return the exact `agentTargetId` supplied by the kit; do not reconstruct it from a provider name. `providerId` is derived runtime metadata and may be shared by several agents. Do not define closed agent or provider unions such as `"codex" | "claude-code"`.

## Runtime registration

Create the standard app-owned execution runtime once:

```ts
import { createDefaultLocalAgentRuntime } from "@tutti-os/agent-acp-kit";

export const localAgentRuntime = createDefaultLocalAgentRuntime();
```

Only construct a custom plugin list when the app has a documented provider transport extension. Customization must transform the full default list; it must not silently filter the catalog to a memorized provider subset.

## Agent catalog

The app server exposes an app-owned endpoint such as `GET /api/agent-targets`. Its implementation calls the SDK facade directly:

```ts
import { loadTuttiAgentCatalog } from "@tutti-os/agent-acp-kit/tutti";
import { localAgentRuntime } from "./local-agent-runtime.js";

export async function getAgentCatalog() {
  return await loadTuttiAgentCatalog({
    runtime: localAgentRuntime
  });
}
```

Do not pass `mode` or `required`, and do not check `process.env.TUTTI_CLI` in app code. The facade behavior is fixed:

- if `TUTTI_CLI` resolves, the kit calls `tutti --json agent list`, validates agent catalog schema version 1, preserves every enabled Agent Target in order, and marks catalog entries that this kit cannot execute as `kit_runtime_unavailable`;
- if `TUTTI_CLI` is absent, the kit automatically builds a `source: "standalone"` catalog from `runtime.listProviders()` and `runtime.detect()`;
- if `TUTTI_CLI` is configured but execution, timeout, cancellation, or schema validation fails, the kit throws `TuttiIntegrationError`; it does not invent a standalone catalog.

The app may project the returned browser-safe DTO into product-specific fields, but it must not copy the Tutti CLI schema. Frontend code may import guards and types without Node dependencies:

```ts
import {
  isTuttiAgentCatalog,
  type TuttiAgentCatalog
} from "@tutti-os/agent-acp-kit/tutti/contracts";
```

UI rules:

- render every returned agent, including several agents backed by the same provider;
- key selection and persistence by `agentTargetId` and disable entries whose `availability.status` is not `available`;
- localize `availability.reasonCode` instead of displaying raw codes;
- prefer the last persisted available agent id, then the available `defaultAgentTargetId`, then the first available agent; do not use provider identity to break ties;
- use `displayName` for presentation, with app-owned icon overrides only;
- never use kit registration to add an agent omitted by the Tutti CLI catalog.

## Composer options

Load composer options lazily for the selected agent:

```ts
import { loadTuttiAgentComposerOptions } from "@tutti-os/agent-acp-kit/tutti";

const composer = await loadTuttiAgentComposerOptions({
  runtime: localAgentRuntime,
  agentTargetId: selectedAgentTargetId,
  cwd: appLocalCwd,
  locale,
  model,
  reasoningEffort
});
```

The kit first verifies that `agentTargetId` is present in the canonical catalog. In Tutti it calls `tutti --json agent composer-options --agent-id <agentTargetId>`; standalone mode derives conservative model options from runtime detection and marks unsupported controls `configurable: false`.

Workspace Apps do not expose, persist, or pass a permission choice. Do not project a permission option returned by composer metadata into App UI, and omit `permission` from runtime execution input. The kit applies the Workspace App default of full access when `permission` is omitted. Interactive choices such as `auto` belong to Tutti AgentGUI and the manual CLI, not to an App-owned agent picker or composer.

Do not eagerly load composer options for every agent. A failure belongs to the selected agent UI and must not delete other catalog entries.

## Persistence and host bridge

Persist the canonical `agentTargetId`. Legacy provider-only state may be used once to select a matching current catalog entry only when exactly one target in the full current catalog uses that provider. The migrated value must be that exact agent id. For zero or multiple matches, leave the legacy preference unresolved and require an explicit exact Agent Target selection; product defaults must not guess the identity.

When invoking a host feature such as:

```ts
window.tuttiExternal?.workspace?.openFeature({
  feature: "agent-chat",
  provider: selectedAgent.providerId
});
```

derive the legacy bridge provider from the selected catalog entry. Do not use that provider value as the app's persisted agent selection.
Use a provider-only bridge only when exactly one target in the full current catalog uses that provider. If the provider is shared, require an exact-agent host API instead of collapsing several Agent Targets into one launch identity.

## Model IDs

If an app needs model IDs that remain unique across Agent Targets, include the selection identity and store the canonical provider separately:

```ts
const appModelId = JSON.stringify([agentTargetId, providerModelId]);
```

The tuple encoding stays unambiguous even when either open-string component contains punctuation. Use `JSON.stringify([providerId, providerModelId])` only when the product intentionally treats the same provider model from multiple Agent Targets as one shared choice.

Do not infer a provider from a model name or assume a fixed model/provider catalog.

## Anti-patterns

Do not add:

- raw daemon or app-scoped Agent catalog clients;
- provider conversion helpers, cross-provider aliases, or app-owned alias tables;
- app-local CLI argv builders, subprocess wrappers, JSON schemas, timeouts, or fallback modes;
- daemon URL, server credential, workspace identity, or app identity reads for Agent catalog/composer discovery;
- fixed agent/provider allowlists or synthetic fallback catalogs;
- eager composer requests for all agents;
- permission selectors, persisted permission modes, or run-level `permission` arguments;
- code that patches `node_modules/@tutti-os/agent-acp-kit` or its built `dist` files.

## Verification

Add app tests that verify:

- the app calls the kit facade and does not implement raw CLI/HTTP protocol handling;
- every facade agent is projected and unavailable agents remain visible but disabled;
- exact agent target ids round-trip through endpoint, persistence, and UI selection while provider remains derived runtime metadata;
- legacy provider-only persisted state is migrated to an unambiguous current agent id rather than kept as selection identity;
- composer loading is lazy and one-agent failure is isolated;
- App execution omits `permission` and relies on the kit's full-access Workspace App default;
- no `mode`, app ID, Agent catalog token, alias helper, or dependency patch script is present.
