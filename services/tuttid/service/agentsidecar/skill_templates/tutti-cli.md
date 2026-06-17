---
name: tutti-cli
description: Use for `mention://agent-session/<sessionId>?workspaceId=...` links, Tutti CLI command syntax, and daemon context lookup when no more specific Tutti skill applies; also serves as the command reference for injected Tutti skills.
---

# Tutti CLI

Use this skill when you need the Tutti CLI command reference, need to inspect an AgentGUI session from a `mention://agent-session/<sessionId>?workspaceId=...` link, or need to inspect workspace context through the local Tutti daemon and no more specific Tutti skill applies.

## Mention Routing

Tutti mention links are internal handoffs. Route them by URI kind before guessing from the display label:

- `mention://workspace-issue/<issueId>?workspaceId=...` belongs to `issue-manager`. Use that skill first for inspection, execution, run reporting, and breakdown workflows.
- `mention://workspace-app/<appId>?workspaceId=...` belongs to `workspace-app`. Use that skill first for app discovery, inspection, and invocation.
- `mention://agent-session/<sessionId>?workspaceId=...` belongs to this `tutti-cli` skill. Start with `agent session-summary --session-id <session-id> --json`.
- Unknown `mention://...` links are still internal Tutti references. Do not open them with a browser, WebFetch, or web search; parse the URI and ask for clarification if no command or specific skill matches.

If you are actively executing or breaking down a workspace issue handoff, prefer the dedicated `issue-manager` skill for workflow guidance and use this skill as the CLI reference it depends on.

Issue execution sequencing belongs to the `issue-manager` skill. Do not use this command reference alone to decide whether an issue-level execution should call `issue run create` or iterate child tasks with `issue task run create`.

For workspace issue breakdowns, use issue/task inspection commands plus `issue task create` or `issue task update` to persist child tasks. `issue run create`, `issue task run create`, and their matching `complete` commands are execution-mode commands only; do not use them for breakdown-only work.

## Workspace Issue Run Reporting

When creating issue runs, use the current AgentGUI runtime metadata below for `--agent-provider` and `--agent-session-id`. Do not invent a provider or session id.

When completing issue runs, include `--outputs` whenever the execution created or materially updated deliverable files. `--outputs` is a JSON array string; each item must include `path`, and may also include `displayName`, `title`, `mediaType`, `sizeBytes`, or `outputId`.

Example complete payload:

```bash
--status completed --summary "<summary>" --outputs '[{"path":"<artifact-path>","displayName":"<artifact-name>"}]' --json
```

If the execution produced no file or URL artifact, complete the run with a clear `--summary` and omit `--outputs`.

## Execution Environment

The Tutti CLI communicates with the local Tutti daemon over localhost/IPC. Run Tutti CLI commands in an execution environment that can access the user's local host daemon and the injected Tutti CLI path. If your provider offers multiple command environments or permission modes, choose the one that permits localhost/IPC access for this CLI. Do not modify global sandbox settings yourself. If no such environment is available, explain that the local Tutti daemon is not accessible from the current execution environment.

## Commands

{{COMMAND_GUIDE}}

The current AgentGUI session is `{{AGENT_SESSION_ID}}`.
The current AgentGUI provider is `{{AGENT_PROVIDER}}`.
