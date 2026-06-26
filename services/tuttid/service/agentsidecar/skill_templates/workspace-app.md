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

1. If the user explicitly asks to open or show the mentioned app window, or confirms the app window should be opened, use `{{CLI_COMMAND}} app open --app-id <appId> --json` for the mentioned app. Built-in app ids include `agent-codex`, `agent-claude-code`, `issue-manager`, and `tutti-onboarding`.
2. Do not call `app open` by default. For ordinary app work, prefer the app-specific CLI command that inspects, queries, updates, starts, or executes the requested operation.
3. If `appId` is `agent-codex` and the user asks to start Codex work, use `{{CLI_COMMAND}} codex start --prompt <task> --show --json`. Add `--model <model>` only when the user explicitly requested a model or command output gives an exact model to reuse.
4. If `appId` is `agent-claude-code` and the user asks to start Claude Code work, use `{{CLI_COMMAND}} claude start --prompt <task> --show --json`. Add `--model <model>` only when the user explicitly requested a model or command output gives an exact model to reuse.
5. If `appId` is `issue-manager` and the user asks issue/task work, read and follow the injected `issue-manager` skill for issue/task context and workflows before using generic workspace app command matching.
6. When `--cwd` is not specified, tuttid inherits the caller agent session working directory.
7. For agent launcher mentions, ask for a missing task prompt before invoking. Do not ask for a missing model; when `--model` is omitted, tuttid uses the target provider's configured/default model. If the user provided a model and the command rejects it, use the error's available model list to ask for or select a valid value.
8. For other app ids, read the injected `tutti-cli` command guide and find commands whose description says they are provided by the mentioned workspace app.
9. If several apps have similar names, match by `appId` from the mention, not only by the visible label.
10. Use the listed `{{CLI_COMMAND}} <scope> <command>` examples to inspect or invoke the app.
11. Prefer `--json` when the command output is used as context for reasoning.

If the mentioned app has no visible CLI commands in the command guide, explain that the app is not currently exposing usable CLI capabilities instead of guessing an app-specific command.

## Invocation Rules

Read command summaries and required inputs before invoking an app command. Ask for missing required inputs when the user did not provide enough information.

Only invoke app commands when the current user turn asks you to use, run, inspect, query, or otherwise interact with the app. For general questions about what the app can do, summarize the visible app commands instead.

Keep user-visible prompts thin. App mention interpretation and CLI lookup structure belong in this skill rather than in the visible handoff prompt.
