# Agent ACP Kit Integration

Use this reference only when the app needs local Codex/Claude execution or a local agent runtime.

## Rule

If the app involves local agents, depend on `@tutti-os/agent-acp-kit`. Do not hand-roll provider detection, ACP stream parsing, or local-agent adapters unless the kit lacks a required capability and the gap is documented.

## Runtime Shape

Keep app domain logic independent from providers:

```text
Application use-case
  -> Agent run service/orchestrator
    -> Runtime provider interface
      -> local-agent provider using @tutti-os/agent-acp-kit
        -> run-scoped MCP/tool gateway
```

Use provider IDs from the kit or an explicit allowlist such as `codex` and `claude`. Detect providers before showing them as available.

## Provider Detection

Create a small discovery wrapper:

```ts
import {
  createDefaultLocalAgentProviderPlugins,
  createLocalAgentRuntime
} from "@tutti-os/agent-acp-kit";

const localAgentRuntime = createLocalAgentRuntime({
  providers: createDefaultLocalAgentProviderPlugins()
});

export async function detectLocalAgents() {
  return localAgentRuntime.detect();
}
```

Map detected provider models to app model IDs with a provider prefix, such as `codex:gpt-5.1` or `claude:sonnet`.

## Runtime Execution

For each agent run:

1. Create a temporary run directory.
2. Materialize any app or workspace skills under that directory using relative paths.
3. Build a prompt envelope with conversation identity, current user turn, attachments, current app state, collaboration rules, and tool gateway guidance.
4. Create a run-scoped tool gateway session and MCP config.
5. Call `localAgentRuntime.run(...)`.
6. Normalize ACP events into app stream events.
7. Persist provider session/resume metadata when the kit returns it.
8. Always revoke the gateway token and remove the temporary run directory in `finally`.

Skeleton:

```ts
for await (const event of localAgentRuntime.run({
  runId,
  provider,
  cwd: runDir,
  prompt,
  systemPrompt,
  model,
  runtimeKind: "local-agent",
  runtimeProvider: provider,
  mcpServers,
  resume,
  signal,
  skillManifest,
  timeoutMs
})) {
  yield adaptLocalAgentEvent(event);
}
```

Do not claim a file write, canvas edit, image generation, or other side effect happened unless the corresponding tool event succeeded.

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
  packagedMcpPath?: string;
}): LocalAgentMcpServerConfig {
  if (input.packagedMcpPath) {
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

  return {
    name: "app-tools",
    type: "stdio",
    command: "pnpm",
    args: ["exec", "tsx", "src/agent/local-agent-host/tools-mcp.ts"],
    env: {
      APP_TOOL_GATEWAY_URL: input.gatewayBaseUrl,
      APP_TOOL_TOKEN: input.gatewayToken
    }
  };
}
```

Package builders should bundle the MCP entrypoint and expose its path through an app-specific env var such as `AIMC_TOOLS_MCP_PATH`.

## Verification

Add tests for:

- provider filtering and model mapping
- event normalization
- MCP config env and packaged path
- tool gateway token validation and revocation
- run cancellation cleanup
- resume metadata persistence

For real-agent smoke tests, start with detection, then run a narrow prompt with no irreversible side effects.
