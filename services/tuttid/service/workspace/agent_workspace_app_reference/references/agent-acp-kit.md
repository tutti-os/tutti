# Agent ACP Kit Integration

Use this reference only when the app needs local Codex/Claude execution or a local agent runtime.

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

Use provider IDs from the kit or an explicit allowlist such as `codex` and `claude`. Detect providers before showing them as available. The app's primary agent flow must support both Claude Code and Codex as provider choices when available, hide or disable unavailable providers, and choose a usable default from the detected providers.

## Provider Detection

Create a small discovery wrapper. Server detect/model endpoints should derive a context from request headers:

```ts
import {
  createManagedAgentDetectContextFromHeaders,
  createDefaultLocalAgentProviderPlugins,
  createLocalAgentRuntime
} from "@tutti-os/agent-acp-kit";

const localAgentRuntime = createLocalAgentRuntime({
  providers: createDefaultLocalAgentProviderPlugins()
});

export async function detectLocalAgents(
  headers: Headers | Record<string, string | string[] | undefined>
) {
  const context = createManagedAgentDetectContextFromHeaders(headers);
  return localAgentRuntime.detect(context);
}
```

Map detected provider models to app model IDs with a provider prefix, such as `codex:gpt-5.1` or `claude:sonnet`.

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
