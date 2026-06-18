---
name: tutti-cli
description: Use for `mention://agent-session/<sessionId>?workspaceId=...` links, Tutti CLI command syntax, and daemon context lookup when no more specific Tutti skill applies; also serves as the command reference for injected Tutti skills.
---

# Tutti CLI

Use this skill as the router and operating contract for the local Tutti CLI. It tells you which command family to reach for, how to call commands safely, and where to look up exact flags as the CLI expands.

## Route First

Classify the request before invoking commands:

1. Workspace issue work uses `issue ...`. If the request is inspection, breakdown, execution, or run reporting for an issue, invoke the `issue-manager` skill and use this skill only as its CLI reference.
2. Workspace app work uses app scopes from the command guide. If the request comes from `mention://workspace-app/<appId>?workspaceId=...`, invoke the `workspace-app` skill.
3. Agent session work uses `agent ...`, `codex ...`, or `claude ...`. For `mention://agent-session/<sessionId>?workspaceId=...`, start with `agent session-summary --session-id <session-id> --json`.
4. Browser automation uses `browser ...`.
5. macOS desktop automation uses `computer ...`.
6. If none match, read the command guide below before guessing.

Completion criterion: every CLI call you make should be traceable to a routed family, a mention URI, prior command output, or a command-guide entry.

## Mention Links

Tutti mention links are internal handoffs. Parse them as data; do not open them with a browser, WebFetch, or web search.

- `mention://workspace-issue/<issueId>?workspaceId=...`: use `issue-manager`.
- `mention://workspace-app/<appId>?workspaceId=...`: use `workspace-app`.
- `mention://agent-session/<sessionId>?workspaceId=...`: use this skill and run `agent session-summary --session-id <session-id> --json`.
- Unknown `mention://...`: parse the URI and ask for clarification if no command family or skill matches.

Agent session summary JSON is compact and includes session context plus recent messages.

## Call Protocol

Use this protocol for every Tutti CLI command:

1. Read the command guide entry for the family or command. If exact flags are unclear, use CLI help for that family or command before guessing.
2. Prefer `--json` whenever output becomes reasoning context, workflow state, or input to another command.
3. Use IDs from mention URIs, prior command output, or list/get commands. Do not invent workspace ids, app scopes, issue ids, task ids, run ids, provider names, or session ids.
4. If a required input is missing, ask the user or run the relevant discovery command. Follow daemon recovery hints when an error includes one.
5. Treat unknown-input or invalid-input errors as a signal to re-read command help or the guide, not to retry with guessed flags.

Output rules:

- `--json` means machine-readable output, not every domain field.
- List JSON is compact by default.
- Get/detail JSON returns the fuller record shape.
- Action JSON returns a concise confirmation payload.
- External workspace app commands follow their own manifest and response contract; do not assume they have builtin summary/detail JSON views.
- Browser and computer commands usually return plain text.
- Do not expect JSON to include every domain record field. List commands are for discovery. Use list output to find ids, then use the matching get/detail command for full context.
- Save ids returned by create/start/run-create commands and reuse those exact ids in later commands.
- Table output uses short human labels such as `id` and `updatedAt`; JSON output uses typed entity keys such as `issueId`, `taskId`, `runId`, and `agentSessionId`. Timestamp keys should name their representation, such as `createdAtUnixMs` for Unix milliseconds or `createdAt` for timestamp values.

When you use a command guide example for reasoning, workflow state, or follow-up CLI input, add `--json` unless the command family normally returns plain text, such as `browser ...` or `computer ...`.

## Family Reference

`issue ...` covers issue topics, issues, tasks, and issue/task run reporting. Workflow sequencing belongs to `issue-manager`, not this skill.

`agent ...`, `codex ...`, and `claude ...` cover provider discovery, composer options, session start/open/send/cancel, active peers, and session context recovery.

`browser ...` drives the daemon-owned browser session. Prefer it over generic browser tooling when Tutti browser context is requested.

`computer ...` drives the daemon-owned macOS desktop session. Prefer it over generic desktop automation when Tutti computer context is requested.

Workspace app scopes are discovered from the command guide. Use `workspace-app` for app mention interpretation and command selection.

## Issue Guardrails

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
