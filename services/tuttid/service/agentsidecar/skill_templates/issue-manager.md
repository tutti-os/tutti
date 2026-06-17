---
name: issue-manager
description: Use for `mention://workspace-issue/<issueId>?workspaceId=...` links and Tutti issue/task inspection, execution, run reporting, or breakdown workflows.
---

# Issue Manager

Use this skill when the user asks you to execute, inspect, or break down a Tutti workspace issue, especially when the handoff contains one or more `mention://workspace-issue/<issueId>?workspaceId=...` links.

Use the injected `tutti-cli` skill as the command reference for the CLI syntax and available commands. This skill owns the issue workflow semantics and decides how to use that CLI reference.

## Mention Contract

Treat a `mention://workspace-issue/<issueId>?workspaceId=...` link as the machine-readable source of truth for issue handoff context. The mention uses the URL path as the issue id and the query string for scope and workflow context. It must include `workspaceId` and may also include `topicId`, `taskId`, `runId`, legacy `outputDir`, and `mode`.

- URL path: issue id, for example `mention://workspace-issue/issue-123?workspaceId=workspace-1`.
- `workspaceId`: workspace id.
- `topicId`: topic id for additional background lookup when the issue or task detail is not enough.
- `taskId`: legacy or manually authored field that targets a specific task under the issue. New AgentGUI execution handoffs omit it so issue-level execution can decide the correct task workflow.
- `runId`: legacy handoff field. New AgentGUI execution handoffs should not include it; if it appears, inspect it as historical context only and still follow the execution rules below unless the user explicitly asks for manual control-plane inspection.
- `outputDir`: legacy artifact hint. Do not rely on it for new executions; use the current AgentGUI working directory and report actual outputs on completion.
- `mode=breakdown`: task-breakdown handoff; inspect the issue context and create or update child tasks when appropriate, without executing work.

Do not infer execution intent from the mention label alone. Use the current user turn to decide whether the request is execution, inspection, or planning.

## Context Recovery

After reading the mention query, recover the smallest useful issue context through Tutti CLI:

1. Start with `issue get --issue-id <issue-id> --json`.
2. If `taskId` is present, also read `issue task get --issue-id <issue-id> --task-id <task-id> --json`.
3. If `runId` is present, you may inspect the historical run for context. When `taskId` is present, use `issue task run get --issue-id <issue-id> --task-id <task-id> --run-id <run-id> --json`. When `taskId` is absent, use `issue run get --issue-id <issue-id> --run-id <run-id> --json`.
4. If the issue or task detail still lacks enough background and `topicId` is present, use `issue topic list --json` and read the matching topic title and summary as context.

Read issue and task context before mutating records. Only update Tutti state when the user asked you to do so or the workflow requires reporting completion.

## Inspection Mode

If the current turn asks you to inspect, summarize, explain status, review progress, or answer questions about the issue or task without doing the work, stay in inspection mode.

In inspection mode, recover the relevant issue, task, topic, and run context as needed, then answer from that context. Do not create or complete runs, do not update issue or task status, and do not edit code unless the current turn explicitly changes into execution mode.

## Execution Mode

If the current turn explicitly asks you to implement, fix, execute, process, complete, or otherwise do the work, treat that as execution mode after recovering the referenced issue or task context.

Create the run yourself before doing the work, capture the returned `runId` and `taskId` from JSON, and complete that same run when execution ends.

- When `taskId` is present, use `issue task run create --issue-id <issue-id> --task-id <task-id> --agent-provider {{AGENT_PROVIDER}} --agent-session-id {{AGENT_SESSION_ID}} --json`, then complete with `issue task run complete --issue-id <issue-id> --task-id <task-id> --run-id <run-id> --status completed --summary "<summary>" --outputs '[{"path":"<artifact-path>"}]' --json` when artifacts were created or updated.
- If the mention does not include `taskId`, inspect the issue tasks before creating a run. When the issue has no child tasks, use `issue run create --issue-id <issue-id> --agent-provider {{AGENT_PROVIDER}} --agent-session-id {{AGENT_SESSION_ID}} --json`; the service will create or select the execution task and return `taskId`; complete with `issue run complete --issue-id <issue-id> --run-id <run-id> --status completed --summary "<summary>" --outputs '[{"path":"<artifact-path>"}]' --json` when artifacts were created or updated.
- If the mention does not include `taskId` and the issue has child tasks, execute each child task in issue order. For each task, create one task run with `issue task run create --issue-id <issue-id> --task-id <task-id> --agent-provider {{AGENT_PROVIDER}} --agent-session-id {{AGENT_SESSION_ID}} --json`, do that task's work, then complete that same run with `issue task run complete --issue-id <issue-id> --task-id <task-id> --run-id <run-id> --status completed --summary "<summary>" --outputs '[{"path":"<artifact-path>"}]' --json` when artifacts were created or updated before moving to the next task.

Use the current AgentGUI session id `{{AGENT_SESSION_ID}}` and current provider `{{AGENT_PROVIDER}}` as the run metadata. Do not guess or substitute a different `--agent-provider`.

When the execution creates or materially updates deliverable files, include those file paths in `--outputs` on run complete so the issue records the actual artifacts. `--outputs` is a JSON array; each item must include `path`, while `outputId`, `displayName`, `title`, `mediaType`, and `sizeBytes` are optional.

Do not mechanically update issue or task status immediately after run complete; the daemon owns the run-driven status transition. Use issue or task status update commands only for later explicit workflow overrides.

## Breakdown Mode

If `mode=breakdown` is present, stay in task-breakdown mode: inspect the issue, existing tasks, references, and recent runs as needed, then generate the child-task breakdown. When the user intent is to persist the breakdown, use task create or update commands to write those child tasks back to Tutti.

Do not edit code, do not execute the task, and do not create or complete runs in breakdown mode. Breakdown activity does not enter the issue/task execution state machine.

## User-visible Prompt Hygiene

Keep user-visible prompts thin. Workflow details, run semantics, mention interpretation, and CLI lookup structure belong in this skill rather than in the visible handoff prompt.
