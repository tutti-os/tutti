# Agent ACP Kit Integration

Use this reference whenever a workspace app owns local Agent execution.

## Rule

Depend on a released exact version of `@tutti-os/agent-acp-kit`. The kit owns provider plugins, detection, canonical provider aliases, managed header handling, ACP lifecycle/event parsing, permission responses, MCP normalization, Tutti CLI execution, timeout/cancellation, and schema validation.

The app owns product orchestration, its backend endpoint, prompt policy, app tools, persistence, and UI. It must not patch kit build output or copy platform protocol code.

Daemon-owned Agent Session apps are a different execution model: they may use Tutti CLI session commands and must not instantiate an app-owned local runtime merely for consistency. They must begin discovery with `tutti agent list --json`, select an exact returned `agentTargetId`, and pass it to `tutti agent start --agent-id <agentTargetId> ...` for starts or handoffs. Provider-specific launch families and provider-only starts are legacy compatibility, not new-session authority.

## Runtime shape

```text
App use case
  -> app Agent service
    -> @tutti-os/agent-acp-kit/tutti catalog/composer/skill facade
    -> app-owned @tutti-os/agent-acp-kit runtime execution
      -> run-scoped app MCP/tool gateway
```

Create the full default runtime once:

```ts
import { createDefaultLocalAgentRuntime } from "@tutti-os/agent-acp-kit";

export const localAgentRuntime = createDefaultLocalAgentRuntime();
```

Provider IDs are canonical opaque strings. Built-in runtime examples include
`codex`, `claude-code`, and `tutti-agent`, but this is not an exhaustive agent
catalog: discover selectable agents and their exact ids from the current Tutti
catalog. The runtime accepts legacy `claude` input internally. `nexight` is
historical activity compatibility only: apps must not register it as a new
provider or map it to/from `tutti-agent`.

Read `references/dynamic-agent-providers.md` for catalog, composer, persistence, UI, and standalone behavior.

## Platform context

The `@tutti-os/agent-acp-kit/tutti` subpath exposes three auto-detecting server-side functions:

```ts
import {
  loadTuttiAgentComposerOptions,
  loadTuttiAgentCatalog,
  loadTuttiAgentSkillContext
} from "@tutti-os/agent-acp-kit/tutti";
```

Do not pass a mode. When `TUTTI_CLI` is absent, catalog/composer use standalone runtime discovery and skill context is empty with `source: "standalone"`. When `TUTTI_CLI` exists, the kit uses it. A configured CLI failure is a typed error and never silently falls back.

In a Tutti-hosted process, daemon Agent Targets own agent visibility. A disabled target is omitted by the CLI catalog, and the kit must not add it back from local runtime detection. Composer and Skill requests for a disabled agent id fail before discovery or materialization. Standalone detection is used only when Tutti CLI is genuinely absent.

The app does not use daemon URL, server credential, workspace identity, or app identity for Agent catalog/composer queries. Those values may still be required for unrelated app-scoped resources.

## Runtime execution

For each run:

1. Generate a stable run ID, select an exact agent target id from the facade, and derive its runtime provider from that catalog entry.
2. Await `createManagedAgentRunContextFromHeaders(...)` directly. It reads and validates the managed credential, canonicalizes supported legacy input internally, creates a safe managed cwd, and rejects unsupported managed providers. The app must not pre-read the credential or perform a separate provider-support precheck.
3. When no managed header exists, use an app-owned local cwd.
4. Load Tutti skill context when platform skills are useful. Omit browser/computer capability flags unless the app actually wires those tools and trusted server-side policy enables them.
5. Create a run-scoped MCP/tool gateway and prompt envelope.
6. Call the local runtime with the same canonical provider ID. Always omit
   `permission`: Workspace Apps do not expose a permission selector. The SDK
   owns the `full-access` default and provider-specific bypass mapping.
7. Adapt events to the app stream and persist only session/resume metadata.
8. Revoke gateway tokens and clean app-owned temporary files in `finally`.

Workspace apps do not present, persist, or pass a permission selection. Omit `permission` from every run input; the kit applies the Workspace App default of full access. Permission choices such as `auto` remain part of Tutti AgentGUI and interactive CLI, not the Workspace App integration surface. Never add a permission picker to an app to mirror daemon composer options.

Skeleton:

```ts
import {
  createDefaultLocalAgentRuntime,
  createManagedAgentRunContextFromHeaders
} from "@tutti-os/agent-acp-kit";
import { loadTuttiAgentSkillContext } from "@tutti-os/agent-acp-kit/tutti";

const localAgentRuntime = createDefaultLocalAgentRuntime();

const runContext = await createManagedAgentRunContextFromHeaders(req.headers, {
  providerId,
  runId
});
const cwd = runContext?.cwd ?? appLocalRunCwd;

const tuttiContext = await loadTuttiAgentSkillContext({
  agentTargetId,
  agentSessionId: runId,
  cwd,
  signal
});

const systemPrompt = [
  appSystemPrompt,
  tuttiContext.recommendedSystemPrompt?.content
]
  .filter(Boolean)
  .join("\n\n");

for await (const event of localAgentRuntime.run({
  runId,
  provider: providerId,
  runtimeProvider: providerId,
  runtimeKind: "local-agent",
  cwd,
  prompt,
  systemPrompt,
  model,
  reasoning,
  mcpServers,
  resume,
  signal,
  skillManifest: [...appSkills, ...tuttiContext.skillManifest],
  timeoutMs,
  managedAgentInvocation: runContext?.managedAgentInvocation
})) {
  yield adaptLocalAgentEvent(event);
}
```

`recommendedSystemPrompt` is advisory content. The app decides whether and where to merge it. Do not append it invisibly in a generic transport layer.

Derive `appLocalRunCwd` from trusted server-side app policy. Never accept a browser-provided cwd for a managed run. Never put a credential or managed cwd in request bodies, browser state, DTOs, logs, persistence, or error text.

The runtime call intentionally omits `permission`. Workspace Apps default to
SDK-owned `full-access`: Claude receives `bypassPermissions`, Codex receives its
unrestricted mode, and ACP permission requests are approved. Do not reproduce
those mappings or inject a default mode in app code. If an App exposes a
permission selector, remove it. Provider permission modes belong to Tutti's
host-owned Agent GUI and manual CLI flows, not the Workspace App integration
contract.

### Optional browser and computer capabilities

Most apps should use the minimal skill-context call above. If an app really
provides browser or computer-use tools, it may declare those capabilities to
the Skill bundle loader:

```ts
const tuttiContext = await loadTuttiAgentSkillContext({
  agentTargetId,
  agentSessionId: runId,
  cwd,
  browserUse: browserToolsAreWiredAndAllowed,
  computerUse: computerToolsAreWiredAndAllowed,
  signal
});
```

Only pass `true` from trusted server-side capability policy. These booleans
filter the Skill guidance returned by Tutti; they do **not** install a tool,
grant an OS permission, launch a browser, or bypass the app's authorization.
Omit the fields when the capability is unavailable. Do not add placeholder
policy variables merely to satisfy this example.

## Event mapping

Normalize at least:

- text deltas and final assistant text;
- thinking/reasoning text;
- tool calls and tool results;
- status/progress and usage;
- file writes;
- stderr/log events;
- completed, canceled, and failed terminal events;
- provider session ID or resume token.

General ACP lifecycle, Cursor update parsing, permission result shape, config-option/model fallback, prompt content blocks, and MCP env conversion belong in the kit. An app may retain only explicit product-specific presentation or orchestration adapters.

## Tool gateway

Expose app abilities through a run-scoped gateway:

- mint one token per run;
- pass it only to the MCP server process or command bridge;
- validate token, run/session identity, tool name, and schema on every call;
- revoke it when the run completes, fails, or is canceled;
- keep tools app-level: read app context, inspect state, mutate app artifacts, start app jobs, persist outputs, or read app-owned files.

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

Package builders must bundle the MCP entrypoint. Production MCP configs must not depend on bare `pnpm`, system `node`, source-tree TypeScript paths, or runtime dependency installation.

## Verification

Add tests for:

- auto CLI-backed and standalone catalog/composer/skill behavior without a mode input;
- configured-but-failing CLI returning a typed error without standalone fallback;
- disabled Agent Targets staying absent without SDK detection adding them back;
- full dynamic Agent Target projection and lazy composer loading;
- exact agent ids and provider-only legacy state migration only when the current catalog has one unambiguous matching target;
- direct awaited managed run context creation, with no app credential precheck;
- no managed secret/cwd leakage;
- event normalization, cancellation, and resume metadata;
- MCP env/path packaging and gateway token revocation;
- absence of raw Agent catalog clients, provider alias helpers, and dependency patch scripts.
- absence of app permission selectors, permission persistence, and run-level permission arguments.

For a real smoke test inside Tutti, load the catalog, one agent's composer options, and skill context before running a narrow cancellable prompt with no irreversible side effects.
