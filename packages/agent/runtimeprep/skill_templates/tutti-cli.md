---
name: tutti-cli
description: Use for `mention://agent-session/<sessionId>?workspaceId=...` links, `mention://agent-target/<targetId>?workspaceId=...` links, Tutti CLI command syntax, and daemon context lookup when no more specific Tutti skill applies; also serves as the command reference for injected Tutti skills.
---

# Tutti CLI

Use this skill as the routing and operating contract for the local Tutti CLI. It tells you which command family to reach for, how to call commands safely, and how to handle the dynamic command snapshot rendered for this agent runtime.

## Route First

Classify the request before invoking any Tutti CLI command:

1. Workspace issue work uses the Host-advertised `issue ...` commands. If the request is inspection, breakdown, execution, or run reporting for an issue, invoke `$issue-manager` and use this skill only as its CLI reference.
2. Workspace app work uses app scopes from the command guide. If the request comes from `mention://workspace-app/<appId>?workspaceId=...`, invoke `$workspace-app` and use this skill as its command reference.
   {{if hasFamily "agent"}}3. Agent work uses the Host-advertised `agent ...` commands. Handoff decisions belong to `$tutti-handoff`; use this skill only as its CLI reference.
   {{end}}{{if hasFamily "browser"}}4. Browser automation uses the Host-advertised `browser ...` commands.
   {{end}}{{if hasFamily "computer"}}5. macOS desktop automation uses the Host-advertised `computer ...` commands.
   {{end}}6. If none match, read `command-guide.md` before guessing.

Completion criterion: every Tutti CLI call must be traceable to a routed family, a mention URI, prior command output, current CLI help, or a command-guide entry.

## Mention Links

Tutti mention links are internal handoffs. Parse them as data; do not open them with a browser, WebFetch, or web search.

- `mention://workspace-issue/<issueId>?workspaceId=...`: use `$issue-manager`.
- `mention://workspace-app/<appId>?workspaceId=...`: use `$workspace-app`.
  {{if has "agent-context.agent.wait"}}- `mention://agent-session/<sessionId>?workspaceId=...`: a context reference to an existing session, not a work order. Use `{{command "agent-context.agent.wait"}}` to await its next stop point. {{if has "agent-context.agent.session-summary"}}Use `{{command "agent-context.agent.session-summary"}}` for conversation recovery. {{end}}{{if has "agent-context.agent.get"}}Use `{{command "agent-context.agent.get"}}` only for the context exposed by this Host.{{end}}
  {{end}}{{if has "agent-context.agent.list"}}- `mention://agent-target/<targetId>?workspaceId=...`: behavior per `$tutti-handoff`. Verify the id with `{{if hasInput "agent-context.agent.list" "agent-id"}}{{command "agent-context.agent.list" (args "agent-id" "<targetId>")}}{{else}}{{command "agent-context.agent.list"}}{{end}}`, then use the generic agent workflow. An instruction for the mentioned agent is handed off, not absorbed.
  {{end}}- Unknown `mention://...`: parse the URI and ask for clarification if no command family or skill matches.

{{if and (has "agent-context.agent.get") (hasInput "agent-context.agent.get" "view")}}
Agent get JSON is progressive. Use `{{command "agent-context.agent.get"}}` for recent conversation context, `{{command "agent-context.agent.get" (args "view" "turns")}}` for Turn discovery, and add an exact `turn-id` with the Host-advertised trace view only when tool-call detail is needed.
{{else if has "agent-context.agent.session-summary"}}
This Host separates conversation recovery from session state. Use `{{command "agent-context.agent.session-summary"}}` for messages and {{if has "agent-context.agent.get"}}`{{command "agent-context.agent.get"}}` only for state.{{else}}do not guess a session-state command.{{end}}
{{end}}

{{if has "agent-context.agent.wait"}}
`{{path "agent-context.agent.wait"}}` blocks until the session's next stop point and does not fetch execution messages. Invoke it once and let the CLI handle internal observation continuations; do not poll conversation commands while a session is running. Omit its timeout input to wait until a stop point.
{{end}}

## Agent Host Command Contract

{{if has "agent-context.agent.cancel-turn"}}- Cancellation is Turn-scoped: `{{command "agent-context.agent.cancel-turn"}}`.
{{else if has "agent-context.agent.cancel"}}- Cancellation is session-scoped: `{{command "agent-context.agent.cancel"}}`.
{{else}}- The current Host advertises no Agent cancellation command.
{{end}}{{if has "agent-context.agent.respond"}}- Pending approvals, choices, and input are answered with `{{command "agent-context.agent.respond"}}`; use identifiers returned by the wait command.
{{else}}- The current Host advertises no Agent interaction-response command. Report pending interaction instead of inventing one.
{{end}}{{if eq .HostFacts.WorkspaceScope "room"}}- Agent sessions are room-scoped by the trusted runtime environment. Do not add a room flag unless the Agent-facing command snapshot advertises it.
{{else}}- Agent sessions are scoped by the injected workspace environment. Do not invent workspace ids or add Host-private scope flags.
{{end}}{{if eq .HostFacts.TargetContinuation.Mode "except-prefixes"}}- Targets whose ids start with {{range .HostFacts.TargetContinuation.UnsupportedTargetIDPrefixes}}`{{.}}` {{end}}can be started, but their sessions do not support continuation commands. Do not promise a follow-up or result-fetch loop for those targets.
{{end}}

## Call Protocol

Use this protocol for every Tutti CLI command:

1. Read `command-guide.md` for the family or command. Treat the guide as a snapshot, not a complete or permanent CLI manual.
2. If exact flags are unclear for a known command, re-check current CLI help such as `{{.CLICommand}} <scope> --help` before guessing.
3. If app-specific commands look missing or stale, refresh the command guide or skill bundle capability reference that preserves `App id:` metadata before deciding the app has no CLI support. Do not use CLI help alone to map a workspace app id to a CLI scope.
4. Prefer JSON output whenever the capability advertises it and output becomes reasoning context, workflow state, or input to another command.
5. Use IDs from mention URIs, prior command output, or list/get commands. {{if has "agent-context.agent.list"}}Before an Agent start, use `{{command "agent-context.agent.list"}}`. {{end}}Do not invent workspace ids, app scopes, issue ids, task ids, run ids, agent ids, provider names, or session ids.
6. If a required input is missing, ask the user or run the relevant discovery command. Follow daemon recovery hints when an error includes one.
7. Treat unknown-input or invalid-input errors as a signal to re-read current command help or the guide, not to retry with guessed flags.

App window opening:

{{if has "workspace-apps.app.open"}}

- `{{command "workspace-apps.app.open" (args "app-id" "<app-id>")}}` is allowed only when the user explicitly asks to open or show an app window, or confirms one should be opened.
- Do not use `{{path "workspace-apps.app.open"}}` or app-specific open commands as the default way to inspect, query, update, or execute app work.
  {{else}}
  The current Host does not advertise an app-window command. Do not guess one; use app-specific capabilities for app work.
  {{end}}

Output rules:

- Follow each capability's advertised default output mode and JSON support.
- Save ids returned by create/start/run-create commands and reuse them.
  {{if .OutputModes}}- Advertised default modes in this snapshot: {{range .OutputModes}}`{{.}}` {{end}}
  {{end}}

## Dynamic Command Snapshot

`command-guide.md` is rendered when this Agent runtime or skill bundle is prepared. It is a current snapshot, not a stable inventory of every command the Host may expose later.

Builtin command families are relatively stable. Workspace app command families are dynamic: an app command appears only after the app is installed, enabled, and active enough for the Host to register its CLI capabilities. App commands may change after app install, reload, start, stop, daemon restart, or Agent session refresh.

If a user mentions a workspace app or asks for app-specific work and the expected command is missing from this guide:

1. Prefer a freshly rendered skill bundle or current capability reference that preserves `App id:` metadata over an older materialized command guide.
2. Use CLI help only after a guide or capability entry has matched the workspace app id to a CLI scope/path; help output is for syntax and flags, not app-id matching.
3. If the command is still unavailable, explain that the app is not currently exposing usable CLI capabilities; do not guess an app-specific command from app files, labels, or source code.

## Family Reference

{{if hasFamily "issue"}}`issue ...` covers the issue operations advertised in the current command guide. Workflow sequencing belongs to `$issue-manager`, not this skill.
{{end}}
{{if hasFamily "agent"}}`agent ...` covers the Agent operations advertised in the current command guide. Discover exact Agent ids and supported flags from that guide or current help; provider-specific start shortcuts must not be assumed.
{{end}}
{{if hasFamily "browser"}}`browser ...` drives the Host-advertised browser session.
{{end}}
{{if hasFamily "computer"}}`computer ...` drives the Host-advertised desktop session.
{{end}}

Workspace app scopes are discovered from command-guide entries carrying `App id:` metadata. Use `$workspace-app` for mention interpretation and command selection; `$workspace-app` is a skill and mention kind, not a CLI scope.

## Issue Guardrails

Issue execution sequencing belongs to `$issue-manager`. Do not use this command reference alone to decide whether an issue-level execution should create an issue run or iterate child tasks.

For workspace issue breakdowns: {{if and (has "issue-manager.issue.task.create-batch") (hasInput "issue-manager.issue.task.create-batch" "tasks-json")}}persist multiple tasks with `{{command "issue-manager.issue.task.create-batch" (args "tasks-json" "'[{\"title\":\"<title>\",\"content\":\"<content>\"}]'")}}`.{{else if has "issue-manager.issue.task.create"}}the Host has no usable batch-create command; persist tasks in order with {{if hasInput "issue-manager.issue.task.create" "content"}}`{{command "issue-manager.issue.task.create" (args "title" "<title>" "content" "<content>")}}`{{else}}`{{command "issue-manager.issue.task.create" (args "title" "<title>")}}`{{end}}.{{else}}the current Host advertises no task-create command; return a draft and state that it could not be saved.{{end}}

## Workspace Issue Run Reporting

{{if has "issue-manager.issue.run.create"}}- Issue run creation: `{{if hasInput "issue-manager.issue.run.create" "agent-target-id"}}{{command "issue-manager.issue.run.create" (args "agent-target-id" .AgentTargetID)}}{{else if hasInput "issue-manager.issue.run.create" "agent-provider"}}{{command "issue-manager.issue.run.create" (args "agent-provider" .Provider)}}{{else}}{{command "issue-manager.issue.run.create"}}{{end}}`
{{end}}{{if has "issue-manager.issue.task.run.create"}}- Task run creation: `{{if hasInput "issue-manager.issue.task.run.create" "agent-target-id"}}{{command "issue-manager.issue.task.run.create" (args "agent-target-id" .AgentTargetID)}}{{else if hasInput "issue-manager.issue.task.run.create" "agent-provider"}}{{command "issue-manager.issue.task.run.create" (args "agent-provider" .Provider)}}{{else}}{{command "issue-manager.issue.task.run.create"}}{{end}}`
{{end}}{{if not (or (has "issue-manager.issue.run.create") (has "issue-manager.issue.task.run.create"))}}The current Host does not advertise issue-run creation. Do not invent run commands.
{{end}}

{{if or (hasInput "issue-manager.issue.run.complete" "outputs") (hasInput "issue-manager.issue.task.run.complete" "outputs")}}
When completing issue runs, include the advertised outputs input whenever execution created or materially updated deliverable files. Each output item must include `path`.
{{end}}

{{if and (has "issue-manager.issue.run.complete") (hasInput "issue-manager.issue.run.complete" "summary") (hasInput "issue-manager.issue.run.complete" "outputs")}}Example issue-run completion:

```bash
{{command "issue-manager.issue.run.complete" (args "status" "completed" "summary" "<summary>" "outputs" "'[{\"path\":\"<artifact-path>\",\"displayName\":\"<artifact-name>\"}]'")}}
```

{{end}}

If execution produced no artifact, complete the run with a clear summary when the command schema accepts one.

## Execution Environment

The Tutti CLI communicates with the local Tutti daemon over localhost/IPC. Run commands in an execution environment that can access the daemon and injected CLI path. Do not modify global sandbox settings yourself. If no such environment is available, explain that the daemon is inaccessible.

## Command Reference

Available first-level `{{.CLICommand}}` subcommands:

{{range .CommandFamilies}}- `{{$.CLICommand}} {{.}} ...`
{{else}}- No agent-facing command families were advertised by the current Host.
{{end}}

For syntax and flags, use `{{.CLICommand}} <scope> --help` or `{{.CLICommand}} <scope> <command> --help`.

For app id mapping, read this skill's `command-guide.md`; it preserves `App id:` metadata.

The current AgentGUI session is `{{.AgentSessionID}}`.
The current AgentGUI agent target id is `{{.AgentTargetID}}`.
The current AgentGUI provider is `{{.Provider}}`.
