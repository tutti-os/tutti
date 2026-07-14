# Tutti CLI Commands

This reference is for code inside a generated workspace app at runtime. It is not the Agent's own Tutti CLI workflow guide.

Workspace apps may call local Tutti capabilities through the bundled Tutti CLI.

Do not use `$TUTTI_CLI agent ...`, provider-specific command families, or Agent session polling to implement app-owned local Agent execution. Apps that need local Agent execution, Tutti agent catalog/composer options, dynamic Tutti skills, or app-owned MCP tooling must load `$tutti-agent-workspace-app` and use `@tutti-os/agent-acp-kit` from a Node server. The kit may invoke Agent CLI commands internally; app code must not construct argv or parse their JSON:

```ts
import { createDefaultLocalAgentRuntime } from "@tutti-os/agent-acp-kit";
import { loadTuttiAgentCatalog } from "@tutti-os/agent-acp-kit/tutti";

const localAgentRuntime = createDefaultLocalAgentRuntime();
const catalog = await loadTuttiAgentCatalog({
  runtime: localAgentRuntime
});
```

The facade returns the enabled agent catalog inside Tutti and automatically returns a standalone runtime catalog when `TUTTI_CLI` is absent. Keep the exact agent target id as selection identity and load composer options lazily for that agent:

```ts
import { createDefaultLocalAgentRuntime } from "@tutti-os/agent-acp-kit";
import { loadTuttiAgentComposerOptions } from "@tutti-os/agent-acp-kit/tutti";

const localAgentRuntime = createDefaultLocalAgentRuntime();

export async function loadSelectedAgentOptions(agentTargetId: string) {
  return loadTuttiAgentComposerOptions({
    agentTargetId,
    runtime: localAgentRuntime
  });
}
```

Do not pass `mode`, read app ID/token/API environment, or filter either catalog to a memorized provider subset.

For non-agent app-to-app capability calls, always use the command path from `TUTTI_CLI`. `TUTTI_CLI` is the stable app-runtime contract across development and packaged production.

## Discovery

The CLI command set is dynamic. It includes daemon-owned commands plus commands exposed by installed workspace apps through `tutti.cli.json`.
When `TUTTI_CLI` runs inside a workspace app runtime, command discovery includes commands marked integration-only, including app commands with `visibility: "integration"`. Ordinary user CLI help and Agent command guides do not include those integration-only commands. App-runtime help labels integration-only commands and tells models not to expose or forward them as user or Agent actions.

Generated apps that integrate with another app should probe commands before depending on them:

- `[TUTTI_CLI, "--help"]`: list current top-level command groups.
- `[TUTTI_CLI, "<group>", "--help"]`: list commands under a group.
- `[TUTTI_CLI, "<group>", "<command>", "--help"]`: inspect flags and documentation hints.
- Add `--json` before the command path for machine-readable command results, for example `[TUTTI_CLI, "--json", "status"]` or `[TUTTI_CLI, "--json", "weather", "refresh"]`.

If a command is missing or returns a non-zero exit code, keep the app usable and show a local fallback state rather than failing startup.

## Command Discovery

The command set can differ by workspace and installed apps. Discover commands at runtime instead of hard-coding a static catalog. Common command groups may include:

- `status`: show local `tuttid` health.
- `doctor`: daemon and command-routing diagnostics.
- `agent`: start, list, send to, open, cancel, and inspect agent sessions and providers.
- `issue`: create, list, update, delete, and manage issue topics, tasks, and runs.
- App-provided groups such as `weather`, `automation`, or `news` may appear when those apps are installed and enabled in the workspace.

App-provided command groups are the important composition surface. For example, a dashboard app can call a weather app with `[TUTTI_CLI, "--json", "weather", "refresh"]` if that command exists, and can call a news app through whatever command group that app exposes, such as `[TUTTI_CLI, "--json", "news", "latest"]`.

## Example Weather Commands

When a compatible weather app is installed, it might expose commands like:

- `weather search --query <place>`: search locations.
- `weather add --name <name> --latitude <lat> --longitude <lon> [--admin1 <region>] [--country <country>] [--id <id>] [--timezone <tz>]`: save a location.
- `weather locations`: list saved locations.
- `weather refresh [--location <id-or-name>]`: fetch weather for a saved location.

Use help at runtime before assuming this shape. A different weather app may expose different paths.

## Composition Guidelines

- Call reusable local Tutti capabilities through `TUTTI_CLI`.
- Use `--json` for app-to-app calls so parsing stays stable.
- Keep timeouts short and handle failures gracefully.
- Keep command handlers acyclic when the app also exposes `tutti.cli.json` commands.
- Mention any CLI integrations in package `AGENTS.md`, including the command paths the app tries and the fallback behavior.
