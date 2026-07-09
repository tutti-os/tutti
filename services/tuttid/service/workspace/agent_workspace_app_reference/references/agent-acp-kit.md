# Agent ACP Kit Integration

Use this reference only when the app needs local agent execution or a local agent runtime behind Tutti-owned dynamic provider catalog APIs.

## Rule

If the app involves local agents, depend on `@tutti-os/agent-acp-kit`. Do not hand-roll provider detection, ACP stream parsing, or local-agent adapters unless the kit lacks a required capability and the gap is documented.

For apps that must work in both local Tutti and cloud/managed Tutti, use an `@tutti-os/agent-acp-kit` version that provides managed-agent header context helpers. The app server should derive managed context from request headers and pass it directly to the kit runtime. The browser, request body, app state, and logs must not carry managed credentials.

## Runtime Shape

Keep app domain logic independent from providers:

```text
Application use-case
  -> Agent run service/orchestrator
    -> Runtime provider interface
      -> local-agent provider using @tutti-os/agent-acp-kit
        -> run-scoped MCP/tool gateway
```

Use provider IDs from Tutti's workspace-app scoped agent APIs. Do not keep app-local catalog allowlists such as `codex`/`claude` unless the app's product requirements explicitly document that a provider is unsupported. The app should show the provider set returned by Tutti, keep unavailable providers visible as disabled with a reason, and choose a usable default from the Tutti catalog.

Read `references/dynamic-agent-providers.md` for the full discovery, normalization, UI, and compatibility rules. Register the complete kit default provider set for execution; use `localAgentRuntime.detect(...)` only for standalone operation or the documented whole-catalog compatibility path, not to replace Tutti's app-scoped daemon API inside Tutti.

## Dynamic Provider Catalog

Workspace apps should converge on the `@tutti-os/agent-acp-kit/tutti` catalog helpers when that subpath is available. The catalog source of truth is Tutti's app-scoped daemon API, not the app package or kit version:

```ts
const catalog = await resolveTuttiAgentProviderCatalog({
  baseUrl: process.env.TUTTI_API_BASE_URL,
  token: process.env.TUTTI_APP_SERVER_TOKEN,
  workspaceId: process.env.TUTTI_WORKSPACE_ID,
  appId: process.env.TUTTI_APP_ID
});
```

The resolver must call:

- `GET /v1/workspaces/{workspaceID}/apps/{appID}/preferences/agent` for default provider and preference gates.
- `GET /v1/workspaces/{workspaceID}/apps/{appID}/agent-providers/status` without an app-local provider list. Tutti returns the Agent GUI-visible provider set from enabled daemon-owned Agent Targets.
- `POST /v1/workspaces/{workspaceID}/apps/{appID}/agent-providers/{provider}/composer-options` for provider model, reasoning, and speed options.

Tutti decides which providers are visible to workspace apps. The app and kit must not replace that set with `runtime.listProviders()`, static `WorkspaceAgentProvider` enum values, or hard-coded app allowlists. Adding a new Agent should require updating Tutti/Agent GUI support, not rebuilding every app package.

Keep only the minimal provider alias table needed to bridge kit and daemon IDs:

- kit to daemon: `claude` -> `claude-code`, `nexight` -> `tutti-agent`
- daemon to kit: `claude-code` -> `claude`, `tutti-agent` -> `nexight`

Display names should prefer Tutti target/status/composer labels. Fall back to title-casing the provider ID.

Add a thin version-compatibility fallback only around whole-catalog failure, such as an unavailable scoped app-server API, `404`/`405`, schema incompatibility, or a thrown kit helper. The fallback catalog is fixed to `codex` and `claude`, both `available: true`, both with `models: [{ id: "default", label: "default" }]`, and both with `defaultModelId: "default"`. This fallback is only for UI display and basic run entry; it should not participate in daemon enrichment.

Store runtime profiles with Tutti provider IDs such as `claude-code`, `codex`, `cursor`, or `opencode`, plus any future provider returned by the app-scoped status API. Store model selections as `${provider}:${modelId}` in app state, and strip the provider prefix before calling `localAgentRuntime.run(...)`. Use shared kit helpers for provider-specific translations such as Cursor `default` -> `default[]` when available.

## Provider Detection

Create the shared runtime once with the full default provider set. This snippet only registers execution plugins; each server run endpoint must still derive its managed context with `createManagedAgentRunContextFromHeaders(...)` as shown under Runtime Execution.

```ts
import {
  createDefaultLocalAgentProviderPlugins,
  createLocalAgentRuntime
} from "@tutti-os/agent-acp-kit";

const localAgentRuntime = createLocalAgentRuntime({
  providers: createDefaultLocalAgentProviderPlugins()
});

export { localAgentRuntime };
```

Map Tutti composer models to app model IDs with a provider prefix, such as `codex:gpt-5.1` or `claude-code:sonnet`.

For standalone kit detection, map detected provider models with the same prefix rule, such as `cursor:default` or `codex:gpt-5.1`. Build prefixes from the detected `provider` value; do not assume only Codex/Claude models exist.

When an app customizes provider behavior, transform the full default plugin list instead of filtering it:

```ts
const providers = createDefaultLocalAgentProviderPlugins().map((provider) =>
  provider.id === "claude"
    ? withAppClaudeStreamCompatibility(provider)
    : provider
);
```

Provider-specific wrappers are fine; app-local catalog allowlists are not.

Do not call a browser JSB API to fetch credentials for detection. Do not accept a credential field in the request body. If no managed credential header is present, the helper returns a local-compatible context and detection continues through the normal local path.

## Runtime Execution

For each agent run:

1. Generate a stable app run ID.
2. Derive managed run context on the server from request headers with `createManagedAgentRunContextFromHeaders(...)`.
3. Materialize app or workspace skills only when the app needs them, using paths under the returned `runContext.cwd` or app-owned runtime/data paths. Do not invent a separate managed cwd policy.
4. Build a prompt envelope with conversation identity, current user turn, attachments, current app state, collaboration rules, and tool gateway guidance.
5. Load Tutti dynamic skill context through `@tutti-os/agent-acp-kit/tutti` when the app runs inside Tutti and needs platform CLI skills.
6. Create a run-scoped tool gateway session and MCP config.
7. Call `localAgentRuntime.run(...)` with the returned managed invocation context.
8. Normalize ACP events into app stream events.
9. Persist provider session/resume metadata when the kit returns it, but never persist managed credentials.
10. Always revoke the gateway token and clean up app-owned temporary files in `finally`.

Tutti dynamic CLI skills should use the kit helper, not per-app subprocess and JSON parsing code:

```ts
import { loadTuttiAgentSkillContext } from "@tutti-os/agent-acp-kit/tutti";

const tuttiContext = await loadTuttiAgentSkillContext({
  provider,
  agentSessionId: runId,
  cwd: workspaceCwd
});

const systemPrompt = [
  appSystemPrompt,
  tuttiContext.recommendedSystemPrompt?.content
]
  .filter(Boolean)
  .join("\n\n");

const skillManifest = [...appSkillManifest, ...tuttiContext.skillManifest];
```

The app still owns policy. `tuttiContext.recommendedSystemPrompt?.content` is raw advisory prompt content: merge it, edit it, place it elsewhere, or ignore it according to the app's prompt strategy. Do not silently append the recommended prompt, and do not hand-roll `$TUTTI_CLI agent tutti-cli-skill-bundle --json` parsing unless the installed `@tutti-os/agent-acp-kit` version lacks the helper.

Skeleton:

```ts
import { createManagedAgentRunContextFromHeaders } from "@tutti-os/agent-acp-kit";

const runContext = createManagedAgentRunContextFromHeaders(req.headers, {
  providerId: provider,
  runId
});

for await (const event of localAgentRuntime.run({
  runId,
  provider,
  cwd: runContext.cwd,
  prompt,
  systemPrompt,
  model,
  runtimeKind: "local-agent",
  runtimeProvider: provider,
  mcpServers,
  resume,
  signal,
  skillManifest,
  timeoutMs,
  managedAgentInvocation: runContext.managedAgentInvocation
})) {
  yield adaptLocalAgentEvent(event);
}
```

Do not claim a file write, canvas edit, image generation, or other side effect happened unless the corresponding tool event succeeded.

Do not add these managed-agent anti-patterns:

- Browser-side JSB credential fallback.
- Request body fields such as `credential` or `managedAgentCredential`.
- Persisted credential state.
- Frontend events, logs, status APIs, or stored run metadata that expose managed credentials or managed cwd.
- Business-layer hard-coding of `/workspace`, `.agent-runs`, or `CODEX_HOME` strategy. The kit owns managed run context and Codex home behavior.

If the app sends agent instructions over WebSocket instead of HTTP POST, verify the Tutti/TSH host injects the managed credential header into that WebSocket route. The app should still read the credential from headers; it should not create a parallel credential transport.

## Event Mapping

Normalize at least:

- text deltas and final assistant text
- thinking/reasoning text
- tool calls and tool results
- status/progress updates
- file writes
- stderr/log events
- done, canceled, and error terminal events
- provider session ID or resume token

If a provider emits raw events differently, add a provider-specific compatibility adapter near provider setup, not in UI code.

## Tool Gateway

Expose app abilities through a run-scoped gateway:

- Mint one token per run.
- Pass the token only to the MCP server process or command bridge.
- Validate token, run, participant/session, tool name, and schema on every call.
- Revoke the token when the run completes, fails, or is canceled.
- Keep tools app-level: read context, inspect state, mutate app artifacts, start app jobs, persist outputs, read app-owned files.

MCP config pattern:

```ts
import type { LocalAgentMcpServerConfig } from "@tutti-os/agent-acp-kit";

export function createAppToolsMcpServerConfig(input: {
  gatewayBaseUrl: string;
  gatewayToken: string;
  packagedMcpPath: string;
}): LocalAgentMcpServerConfig {
  return {
    name: "app-tools",
    type: "stdio",
    command: process.execPath,
    args: [input.packagedMcpPath],
    env: {
      APP_TOOL_GATEWAY_URL: input.gatewayBaseUrl,
      APP_TOOL_TOKEN: input.gatewayToken
    }
  };
}
```

Package builders should bundle the MCP entrypoint and expose its path through an app-specific env var such as `AIMC_TOOLS_MCP_PATH`. Development runners may use a project-owned dev command such as `pnpm exec tsx ...` outside the packaged runtime, but package runtime MCP configs must not depend on bare `pnpm`, `node`, or source-tree TypeScript paths.

## Verification

Add tests for:

- Tutti app-scoped provider catalog resolution and model mapping
- app status queries that omit app-local provider allowlists
- provider visibility following the app-scoped status API rather than `runtime.listProviders()`
- whole-catalog failure returning the Codex/Claude `default` legacy catalog
- dynamic provider catalog exposure and default selection (see `references/dynamic-agent-providers.md`)
- provider filtering and model mapping
- SSR/server provider detection using `createManagedAgentDetectContextFromHeaders(...)`
- model-list detection using request-header managed context
- run creation using `createManagedAgentRunContextFromHeaders(...)`
- local no-header fallback behavior
- credential non-leakage in response DTOs, logs, frontend events, and persisted run state
- event normalization
- MCP config env and packaged path
- tool gateway token validation and revocation
- run cancellation cleanup
- resume metadata persistence

For real-agent smoke tests, start with detection, then run a narrow prompt with no irreversible side effects.
