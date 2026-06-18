---
name: workspace-app
description: Use for `mention://workspace-app/<appId>?workspaceId=...` links to discover, inspect, or invoke CLI-enabled Tutti workspace app commands.
---

# Workspace App

Use this skill when the current user turn contains one or more `mention://workspace-app/<appId>?workspaceId=...` links.

Use the injected `tutti-cli` skill as the command reference for CLI syntax and available commands. This skill owns workspace app mention interpretation and decides how to use that CLI reference.

## Mention Contract

Treat a `mention://workspace-app/<appId>?workspaceId=...` link as the machine-readable source of truth for the referenced app. The mention uses the URL path as the app id and `workspaceId` as query scope.

- URL path: target workspace app id.
- `workspaceId`: workspace context for command discovery and invocation.

Do not infer app behavior from the mention label alone.

## Context Recovery

After reading the mention query, recover the smallest useful app context through Tutti CLI:

1. If `appId` is `agent-codex`, treat the mention as the Codex agent launcher and use `{{CLI_COMMAND}} codex start --model <model> --prompt <task> --show --json`.
2. If `appId` is `agent-claude-code`, treat the mention as the Claude Code agent launcher and use `{{CLI_COMMAND}} claude start --model <model> --prompt <task> --show --json`.
3. If `appId` is `issue-manager`, read and follow the injected `issue-manager` skill for issue/task context and workflows before using generic workspace app command matching.
4. When `--cwd` is not specified, tuttid inherits the caller agent session working directory.
5. For agent launcher mentions, ask for missing `model` or task prompt before invoking. Do not guess a model and do not start an empty task.
6. For other app ids, read the injected `tutti-cli` command guide and find commands whose description says they are provided by the mentioned workspace app.
7. If several apps have similar names, match by `appId` from the mention, not only by the visible label.
8. Use the listed `{{CLI_COMMAND}} <scope> <command>` examples to inspect or invoke the app.
9. Prefer `--json` when the command output is used as context for reasoning.

If the mentioned app has no visible CLI commands in the command guide, explain that the app is not currently exposing usable CLI capabilities instead of guessing an app-specific command.

## Invocation Rules

Read command summaries and required inputs before invoking an app command. Ask for missing required inputs when the user did not provide enough information.

Only invoke app commands when the current user turn asks you to use, run, inspect, query, or otherwise interact with the app. For general questions about what the app can do, summarize the visible app commands instead.

Keep user-visible prompts thin. App mention interpretation and CLI lookup structure belong in this skill rather than in the visible handoff prompt.
