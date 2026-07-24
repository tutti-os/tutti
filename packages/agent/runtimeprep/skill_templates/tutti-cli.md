---
name: tutti-cli
description: Use for `mention://agent-session/<sessionId>?workspaceId=...` links, `mention://agent-target/<targetId>?workspaceId=...` links, Tutti CLI command syntax, and daemon context lookup when no more specific Tutti skill applies; also serves as the command reference for injected Tutti skills.
---

# Tutti CLI

Use this skill as the routing and operating contract for the local Tutti CLI. It tells you which command family to reach for, how to call commands safely, and how to handle the dynamic command snapshot rendered for this agent runtime.

## Route First

Classify the request before invoking any Tutti CLI command:

1. Workspace issue work uses `issue ...`. If the request is inspection, breakdown, execution, or run reporting for an issue, invoke `$issue-manager` and use this skill only as its CLI reference.
2. Workspace app work uses app scopes from the command guide. If the request comes from `mention://workspace-app/<appId>?workspaceId=...`, invoke `$workspace-app` and use this skill as its command reference.
   {{AGENT_ROUTE_FIRST_GUIDANCE}}

Completion criterion: every Tutti CLI call must be traceable to a routed family, a mention URI, prior command output, current CLI help, or a command-guide entry.

## Mention Links

Tutti mention links are internal handoffs. Parse them as data; do not open them with a browser, WebFetch, or web search.

- `mention://workspace-issue/<issueId>?workspaceId=...`: use `$issue-manager`.
- `mention://workspace-app/<appId>?workspaceId=...`: use `$workspace-app`.
  {{AGENT_SESSION_MENTION_GUIDANCE}}
- `mention://agent-target/<targetId>?workspaceId=...`: behavior per `$tutti-handoff` (an instruction for the mentioned agent is handed off, not absorbed). Verify the id with `agent list --agent-id <targetId> --json`, then use the generic `agent` workflow. This can mean starting a new session, inspecting active peers or historical sessions, or another agent workflow; it is not launch-only.
- Unknown `mention://...`: parse the URI and ask for clarification if no command family or skill matches.

{{AGENT_SESSION_CONTEXT_GUIDANCE}}

## Call Protocol

Use this protocol for every Tutti CLI command:

1. Read `command-guide.md` for the family or command. Treat the guide as a snapshot, not a complete or permanent CLI manual.
2. If exact flags are unclear for a known command, re-check current CLI help such as `{{CLI_COMMAND}} <scope> --help` before guessing.
3. If app-specific commands look missing or stale, refresh the command guide or skill bundle capability reference that preserves `App id:` metadata before deciding the app has no CLI support. Do not use CLI help alone to map a workspace app id to a CLI scope.
4. Prefer `--json` whenever output becomes reasoning context, workflow state, or input to another command.
5. Use IDs from mention URIs, prior command output, or list/get commands. Before an agent start, prefer a fresh `agent list --json` result. Do not invent workspace ids, app scopes, issue ids, task ids, run ids, agent ids, provider names, or session ids.
6. If a required input is missing, ask the user or run the relevant discovery command. Follow daemon recovery hints when an error includes one.
7. Treat unknown-input or invalid-input errors as a signal to re-read current command help or the guide, not to retry with guessed flags.

App window opening:

{{APP_OPEN_GUIDANCE}}

Output rules:

{{OUTPUT_RULES}}

## Dynamic Command Snapshot

`command-guide.md` is rendered when this agent runtime or skill bundle is prepared. It is a current snapshot, not a stable inventory of every command the daemon may expose later.

Builtin command families are relatively stable. Workspace app command families are dynamic: an app command appears only after the app is installed, enabled, and active enough for Tutti to register its CLI capabilities. App commands may change after app install, reload, start, stop, daemon restart, or agent session refresh.

If a user mentions a workspace app or asks for app-specific work and the expected command is missing from this guide:

1. Prefer a freshly rendered skill bundle or current capability reference that preserves `App id:` metadata over an older materialized command guide.
2. Use CLI help only after a guide or capability entry has matched the workspace app id to a CLI scope/path; help output is for syntax and flags, not app-id matching.
3. If the command is still unavailable, explain that the app is not currently exposing usable CLI capabilities; do not guess an app-specific command from app files, labels, or source code.

## Family Reference

{{FAMILY_REFERENCE}}

## Issue Guardrails

Issue execution sequencing belongs to `$issue-manager`. Do not use this command reference alone to decide whether an issue-level execution should call `issue run create` or iterate child tasks with `issue task run create`.

For workspace issue breakdowns: {{ISSUE_BREAKDOWN_GUIDANCE}}

## Workspace Issue Run Reporting

{{ISSUE_RUN_METADATA_GUIDANCE}}

When completing issue runs, include `--outputs` whenever the execution created or materially updated deliverable files. `--outputs` is a JSON array string; each item must include `path`, and may also include `displayName`, `title`, `mediaType`, `sizeBytes`, or `outputId`.

Example complete payload:

```bash
--status completed --summary "<summary>" --outputs '[{"path":"<artifact-path>","displayName":"<artifact-name>"}]' --json
```

If the execution produced no file or URL artifact, complete the run with a clear `--summary` and omit `--outputs`.

## Execution Environment

The Tutti CLI communicates with the local Tutti daemon over localhost/IPC. Run Tutti CLI commands in an execution environment that can access the user's local host daemon and the injected Tutti CLI path. If your provider offers multiple command environments or permission modes, choose the one that permits localhost/IPC access for this CLI. Do not modify global sandbox settings yourself. If no such environment is available, explain that the local Tutti daemon is not accessible from the current execution environment.

## Command Reference

Available first-level `{{CLI_COMMAND}}` subcommands:

{{COMMAND_SUMMARY}}

For syntax/flags, use `{{CLI_COMMAND}} <scope> --help` or `{{CLI_COMMAND}} <scope> <command> --help`.

For app id mapping, read this skill's `command-guide.md`; it preserves `App id:` metadata.

The current AgentGUI session is `{{AGENT_SESSION_ID}}`.
The current AgentGUI agent target id is `{{AGENT_TARGET_ID}}`.
The current AgentGUI provider is `{{AGENT_PROVIDER}}`.
