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

Read `references/dynamic-agent-providers.md` for the full discovery, normalization, UI, and runtime rules. Register the complete kit default provider set for execution; use `localAgentRuntime.detect(...)` for standalone operation, not to replace Tutti's app-scoped daemon API inside Tutti.

## Dynamic Provider Catalog

Follow `references/dynamic-agent-providers.md` for the server environment, scoped routes, response mapping, catalog failure behavior, and persisted provider IDs. Tutti controls provider visibility. The kit controls runtime registration and execution.

Use the `@tutti-os/agent-acp-kit/tutti` subpath for Tutti CLI skill context. Do not assume it exports a provider catalog resolver. Keep the app-owned catalog client separate from the kit runtime, then normalize the selected Tutti provider id at the execution boundary.

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

Do not call a browser JSB API to fetch credentials for detection. Do not accept a credential field in the request body. Standalone detection requires no managed credential; call `localAgentRuntime.detect()` without a context unless the app has a trusted local detection context.

## Runtime Execution

For each agent run:

1. Generate a stable app run ID.
2. Normalize the Tutti provider id to the kit runtime id.
3. Check for a managed credential on the server. Reject unsupported managed provider ids, then await `createManagedAgentRunContextFromHeaders(...)` only for `isManagedAgentInvocationProviderId(...)` providers. Without a managed credential, use an app-owned local cwd.
4. Materialize app or workspace skills only when the app needs them, using paths under the selected cwd or app-owned runtime/data paths. Do not invent a separate managed cwd policy.
5. Build a prompt envelope with conversation identity, current user turn, attachments, current app state, collaboration rules, and tool gateway guidance.
6. Load Tutti dynamic skill context through `@tutti-os/agent-acp-kit/tutti` when the app runs inside Tutti and needs platform CLI skills.
7. Create a run-scoped tool gateway session and MCP config.
8. Call `localAgentRuntime.run(...)` with the normalized provider id and optional managed invocation context.
9. Normalize ACP events into app stream events.
10. Persist provider session/resume metadata when the kit returns it, but never persist managed credentials.
11. Always revoke the gateway token and clean up app-owned temporary files in `finally`.

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
import {
  createManagedAgentRunContextFromHeaders,
  getManagedAgentInvocationCredentialFromHeaders,
  isManagedAgentInvocationProviderId
} from "@tutti-os/agent-acp-kit";
import { toKitAgentProviderId } from "./provider-id.js";

const runtimeProviderId = toKitAgentProviderId(provider);
const managedCredential = getManagedAgentInvocationCredentialFromHeaders(
  req.headers
);
if (
  managedCredential &&
  !isManagedAgentInvocationProviderId(runtimeProviderId)
) {
  throw new Error(`Managed execution does not support ${runtimeProviderId}`);
}
const runContext = isManagedAgentInvocationProviderId(runtimeProviderId)
  ? await createManagedAgentRunContextFromHeaders(req.headers, {
      providerId: runtimeProviderId,
      runId
    })
  : undefined;
const cwd = runContext?.cwd ?? appLocalRunCwd;

for await (const event of localAgentRuntime.run({
  runId,
  provider: runtimeProviderId,
  cwd,
  prompt,
  systemPrompt,
  model,
  runtimeKind: "local-agent",
  runtimeProvider: runtimeProviderId,
  mcpServers,
  resume,
  signal,
  skillManifest,
  timeoutMs,
  managedAgentInvocation: runContext?.managedAgentInvocation
})) {
  yield adaptLocalAgentEvent(event);
}
```

Derive `appLocalRunCwd` from app-owned local policy. Do not accept a browser-provided cwd for managed runs. Do not claim a file write, canvas edit, image generation, or other side effect happened unless the corresponding tool event succeeded.

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
- catalog failure returning an unavailable state without synthetic providers
- dynamic provider catalog exposure and default selection (see `references/dynamic-agent-providers.md`)
- provider plugin transformation and model mapping
- standalone provider detection with the full default plugin set
- awaited run context creation using the normalized kit provider id
- rejection when a managed credential targets an unsupported provider id
- local run context behavior when no managed header is present
- credential non-leakage in response DTOs, logs, frontend events, and persisted run state
- event normalization
- MCP config env and packaged path
- tool gateway token validation and revocation
- run cancellation cleanup
- resume metadata persistence

For real-agent smoke tests inside Tutti, load the scoped catalog before running a narrow prompt. For standalone smoke tests, run detection first. Do not use irreversible side effects.
