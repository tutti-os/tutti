---
name: issue-manager
description: Issue-manager for Tutti workspace issues — `mention://workspace-issue/...` handoffs, issue inspection, execution, breakdown (`mode=breakdown`, persist child tasks), or run reporting. Reach `$tutti-cli` for CLI syntax only.
---

# Issue Manager

Owns issue **handoff** interpretation, **mode** selection, and **run** lifecycle. Before choosing issue commands, use injected `$tutti-cli`; exact syntax and flags live in its `command-guide.md` file.

{{if or (has "issue-manager.issue.run.create") (has "issue-manager.issue.task.run.create")}}
Run creation syntax comes from the current Host command snapshot.
{{if has "issue-manager.issue.run.create"}}

- Issue run: `{{if hasInput "issue-manager.issue.run.create" "agent-target-id"}}{{command "issue-manager.issue.run.create" (args "agent-target-id" .AgentTargetID)}}{{else if hasInput "issue-manager.issue.run.create" "agent-provider"}}{{command "issue-manager.issue.run.create" (args "agent-provider" .Provider)}}{{else}}{{command "issue-manager.issue.run.create"}}{{end}}`
  {{end}}
  {{if has "issue-manager.issue.task.run.create"}}
- Task run: `{{if hasInput "issue-manager.issue.task.run.create" "agent-target-id"}}{{command "issue-manager.issue.task.run.create" (args "agent-target-id" .AgentTargetID)}}{{else if hasInput "issue-manager.issue.task.run.create" "agent-provider"}}{{command "issue-manager.issue.task.run.create" (args "agent-provider" .Provider)}}{{else}}{{command "issue-manager.issue.task.run.create"}}{{end}}`
  {{end}}
  {{else}}
  The current Host does not advertise issue-run creation. Inspection and breakdown remain available, but do not invent run commands.
  {{end}}

{{if has "workspace-apps.app.open"}}
If the user explicitly asks to open or show the Task Manager app window, use `{{command "workspace-apps.app.open" (args "app-id" "issue-manager")}}`. Do not use app opening for issue work.
{{else}}
The current Host advertises no Task Manager app-window command. Do not guess one; issue work uses the advertised issue capabilities.
{{end}}

## Entry Protocol

Run this on every invocation:

1. Resolve the target issue. Parse `mention://workspace-issue/<issueId>?workspaceId=...` when present; otherwise use explicit issue id, issue title, or issue-panel context when the turn clearly targets one issue.
   - **Done when:** you have `<issue-id>` and any query fields: `workspaceId`, `topicId`, `taskId`, `runId`, `mode`.
2. Recover minimal context. {{if has "issue-manager.issue.get"}}Start with `{{command "issue-manager.issue.get"}}`; add task, run, or topic reads only when query fields or the user request require them.{{else}}The current Host advertises no issue-get command; do not guess one.{{end}}
   - Inspect only fields actually returned by the Host. The command capability schema describes inputs, not guaranteed output fields; do not assume `detail.references` unless it is present in the response.
   - **Done when:** you can answer or choose inspection, execution, or breakdown without guessing issue state.
3. Pick one mode and keep later CLI calls inside that mode.
   - **Done when:** you can name the active mode and no planned command violates it.

## Inspection Mode

Use when the turn inspects, summarizes, explains status, or reviews progress.

1. Recover context (Entry step 2).
2. Answer from recovered records.

**Done when:** the user has a grounded answer and no run, status update, or code edit happened unless the user explicitly switched to execution.

## Execution Mode

Use when the turn asks you to implement, fix, execute, process, complete, or otherwise do the work.

1. Recover context (Entry step 2).
2. **Open a run before work.** Create the run yourself before doing the work. Capture returned `runId` and `taskId` from JSON.
3. Do the work.
4. Complete that same run when execution ends. {{if or (hasInput "issue-manager.issue.run.complete" "outputs") (hasInput "issue-manager.issue.task.run.complete" "outputs")}}Include the advertised outputs input whenever deliverable files were created or updated.{{end}}

**Run open:**

{{if has "issue-manager.issue.task.run.create"}}

- Handoff includes `taskId` → `{{if hasInput "issue-manager.issue.task.run.create" "agent-target-id"}}{{command "issue-manager.issue.task.run.create" (args "agent-target-id" .AgentTargetID)}}{{else if hasInput "issue-manager.issue.task.run.create" "agent-provider"}}{{command "issue-manager.issue.task.run.create" (args "agent-provider" .Provider)}}{{else}}{{command "issue-manager.issue.task.run.create"}}{{end}}`
  {{end}}
  {{if has "issue-manager.issue.run.create"}}
- Handoff omits `taskId` → inspect issue tasks; with no child tasks use `{{if hasInput "issue-manager.issue.run.create" "agent-target-id"}}{{command "issue-manager.issue.run.create" (args "agent-target-id" .AgentTargetID)}}{{else if hasInput "issue-manager.issue.run.create" "agent-provider"}}{{command "issue-manager.issue.run.create" (args "agent-provider" .Provider)}}{{else}}{{command "issue-manager.issue.run.create"}}{{end}}`; with child tasks execute them in order using the task-run command above.
  {{end}}
  {{if not (or (has "issue-manager.issue.task.run.create") (has "issue-manager.issue.run.create"))}}
- Run creation is unavailable in the current Host command snapshot. Do not enter execution mode by guessing a command.
  {{end}}

**Run complete:**

{{if has "issue-manager.issue.task.run.complete"}}
{{if and (hasInput "issue-manager.issue.task.run.complete" "summary") (hasInput "issue-manager.issue.task.run.complete" "outputs")}}

- Scoped task run → `{{command "issue-manager.issue.task.run.complete" (args "status" "completed" "summary" "<summary>" "outputs" "'[{\"path\":\"<artifact-path>\"}]'")}}` when artifacts exist.
  {{else if hasInput "issue-manager.issue.task.run.complete" "summary"}}
- Scoped task run → `{{command "issue-manager.issue.task.run.complete" (args "status" "completed" "summary" "<summary>")}}`.
  {{else}}
- Scoped task run → `{{command "issue-manager.issue.task.run.complete" (args "status" "completed")}}`.
  {{end}}
  {{end}}
  {{if has "issue-manager.issue.run.complete"}}
  {{if and (hasInput "issue-manager.issue.run.complete" "summary") (hasInput "issue-manager.issue.run.complete" "outputs")}}
- Issue-level run → `{{command "issue-manager.issue.run.complete" (args "status" "completed" "summary" "<summary>" "outputs" "'[{\"path\":\"<artifact-path>\"}]'")}}` when artifacts exist.
  {{else if hasInput "issue-manager.issue.run.complete" "summary"}}
- Issue-level run → `{{command "issue-manager.issue.run.complete" (args "status" "completed" "summary" "<summary>")}}`.
  {{else}}
- Issue-level run → `{{command "issue-manager.issue.run.complete" (args "status" "completed")}}`.
  {{end}}
  {{end}}
  {{if not (or (has "issue-manager.issue.task.run.complete") (has "issue-manager.issue.run.complete"))}}
- Run completion is unavailable in the current Host command snapshot.
  {{end}}

{{if or (hasInput "issue-manager.issue.run.complete" "outputs") (hasInput "issue-manager.issue.task.run.complete" "outputs")}}
The advertised outputs input is a JSON array; each item needs `path`. `outputId`, `displayName`, `title`, `mediaType`, and `sizeBytes` are optional.

**Done when:** every opened run is completed and every material artifact path is listed in that input.
{{else}}
**Done when:** every opened run is completed. This Host does not advertise artifact output reporting on run completion.
{{end}}

Do not mechanically update issue or task status after run complete; the daemon owns the run-driven status transition.

## Breakdown Mode

Use when the handoff includes `mode=breakdown`, or the turn breaks an issue into tasks without executing them.

A breakdown handoff is a **persist** request. Treat `mode=breakdown` or an explicit breakdown ask as permission to write child tasks back — do not stop at a draft and wait for the user to say continue.

1. Recover context (Entry step 2).
2. Draft child tasks from issue context, existing tasks, references, and recent runs.
3. {{if and (has "issue-manager.issue.task.create-batch") (hasInput "issue-manager.issue.task.create-batch" "tasks-json")}}**Persist by default.** Write multiple new tasks with `{{command "issue-manager.issue.task.create-batch" (args "tasks-json" "'[{\"title\":\"<title>\",\"content\":\"<content>\"}]'")}}`; use the advertised single-create or update commands for one task or existing tasks.{{else if has "issue-manager.issue.task.create"}}**Persist by default.** The Host has no usable batch-create capability. Create child tasks in issue order with {{if hasInput "issue-manager.issue.task.create" "content"}}`{{command "issue-manager.issue.task.create" (args "title" "<title>" "content" "<content>")}}`{{else}}`{{command "issue-manager.issue.task.create" (args "title" "<title>")}}`{{end}}; use the advertised task-update command for existing tasks.{{else}}**Persistence is unavailable.** The current Host advertises no child-task create capability; return a draft and state that it could not be saved.{{end}}
4. Report what was created or updated (ids/titles), not whether the user wants you to continue.

**Persist without asking when:**

- the handoff includes `mode=breakdown`
- the turn asks to break down, decompose, split, or create child/sub tasks for the issue

**Do not persist (draft only) only when** the turn explicitly asks for a draft, preview, proposal, or plan without saving — for example "just show the breakdown" or "don't write tasks yet".

**Done when:** child tasks are written back (default) or a draft-only answer was explicitly requested.

Do not end breakdown work with permission prompts such as "如果你要我继续…", "要不要我写回", or "tell me if you want me to persist". Either persist (default) or state clearly that the user asked for draft-only.

Do not edit code, do not execute the task, and do not create or complete runs in breakdown mode. Breakdown activity does not enter the issue/task execution state machine.

## Handoff Reference

`mention://workspace-issue/<issueId>?workspaceId=...` is authoritative over display labels. Do not infer execution intent from the mention label alone; use the current turn to choose **mode**.

Fields:

- path: issue id
- `workspaceId`: required scope
  {{if has "issue-manager.issue.topic.list"}}- `topicId`: optional background via `{{command "issue-manager.issue.topic.list"}}`
  {{end}}- `taskId`: task scope when present; execution handoffs may omit it
- `runId`: history/control-plane context; inspect only when needed
- `outputDir`: legacy artifact hint; report actual outputs on complete instead
- `mode=breakdown`: breakdown mode

Extra reads:

{{if has "issue-manager.issue.task.get"}}- `taskId`: `{{command "issue-manager.issue.task.get"}}`
{{end}}{{if has "issue-manager.issue.task.run.get"}}- `runId` with `taskId`: `{{command "issue-manager.issue.task.run.get"}}`
{{end}}{{if has "issue-manager.issue.run.get"}}- `runId` without `taskId`: `{{command "issue-manager.issue.run.get"}}`
{{end}}{{if has "issue-manager.issue.topic.list"}}- `topicId`: `{{command "issue-manager.issue.topic.list"}}`
{{end}}{{if not (or (has "issue-manager.issue.task.get") (has "issue-manager.issue.task.run.get") (has "issue-manager.issue.run.get") (has "issue-manager.issue.topic.list"))}}- No additional issue read commands are advertised. Do not guess one.
{{end}}

Only mutate Tutti state when the user asked, the active mode requires it, or breakdown mode calls for persist-by-default above.
