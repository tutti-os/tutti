---
name: issue-manager
description: Issue-manager for Tutti workspace issues — `mention://workspace-issue/...` handoffs, issue inspection, execution, breakdown (`mode=breakdown`, persist child tasks), or run reporting. Reach `$tutti-cli` for CLI syntax only.
---

# Issue Manager

Owns issue **handoff** interpretation, **mode** selection, and **run** lifecycle. Before choosing issue commands, use injected `$tutti-cli`; exact syntax and flags live in its `command-guide.md` file.

{{ISSUE_RUN_METADATA_GUIDANCE}}

{{ISSUE_APP_OPEN_GUIDANCE}}

## Entry Protocol

Run this on every invocation:

1. Resolve the target issue. Parse `mention://workspace-issue/<issueId>?workspaceId=...` when present; otherwise use explicit issue id, issue title, or issue-panel context when the turn clearly targets one issue.
   - **Done when:** you have `<issue-id>` and any query fields: `workspaceId`, `topicId`, `taskId`, `runId`, `mode`.
2. Recover minimal context. Start with `{{ISSUE_GET_COMMAND}}`; add task, run, or topic reads only when query fields or the user request require them.
   - {{ISSUE_REFERENCE_GUIDANCE}}
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
4. complete that same run when execution ends. Include `--outputs` whenever deliverable files were created or updated.

**Run open:**

{{ISSUE_RUN_OPEN_GUIDANCE}}

**Run complete:**

{{ISSUE_RUN_COMPLETE_GUIDANCE}}

`--outputs` is a JSON array; each item needs `path`. `outputId`, `displayName`, `title`, `mediaType`, and `sizeBytes` are optional.

**Done when:** every opened run is completed and every material artifact path is listed in `--outputs`.

Do not mechanically update issue or task status after run complete; the daemon owns the run-driven status transition.

## Breakdown Mode

Use when the handoff includes `mode=breakdown`, or the turn breaks an issue into tasks without executing them.

A breakdown handoff is a **persist** request. Treat `mode=breakdown` or an explicit breakdown ask as permission to write child tasks back — do not stop at a draft and wait for the user to say continue.

1. Recover context (Entry step 2).
2. Draft child tasks from issue context, existing tasks, references, and recent runs.
3. {{ISSUE_BREAKDOWN_GUIDANCE}}
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
- `topicId`: optional background via `issue topic list --json`
- `taskId`: task scope when present; execution handoffs may omit it
- `runId`: history/control-plane context; inspect only when needed
- `outputDir`: legacy artifact hint; report actual outputs on complete instead
- `mode=breakdown`: breakdown mode

Extra reads:

{{ISSUE_EXTRA_READ_GUIDANCE}}

Only mutate Tutti state when the user asked, the active mode requires it, or breakdown mode calls for persist-by-default above.
