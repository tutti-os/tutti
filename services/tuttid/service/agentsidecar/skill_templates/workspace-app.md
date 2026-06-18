---
name: workspace-app
description: Use for `mention://workspace-app/<appId>?workspaceId=...` links to discover, inspect, or invoke CLI-enabled Tutti workspace app commands.
---

# Workspace App

Use this skill when a turn contains `mention://workspace-app/<appId>?workspaceId=...`.

Use the injected `tutti-cli` skill as the command reference for CLI syntax and available commands. This skill owns workspace app mention interpretation and decides how to use that CLI reference.

## Protocol

1. Parse the mention. The URL path is `appId`; `workspaceId` is the command scope. Do not infer app behavior from the visible label.
2. If `appId` is `agent-codex`, use `{{CLI_COMMAND}} codex start --model <model> --prompt <task> --show --json`.
3. If `appId` is `agent-claude-code`, use `{{CLI_COMMAND}} claude start --model <model> --prompt <task> --show --json`.
4. When `--cwd` is not specified, tuttid inherits the caller agent session working directory.
5. For agent launcher mentions, ask for a missing `model` or task prompt. Do not guess a model or start an empty task.
6. For other app ids, read the `tutti-cli` command guide and match commands provided by that exact app id.
7. Use guide examples in the form `{{CLI_COMMAND}} <scope> <command>`.
8. Prefer `--json` when output becomes reasoning context or input to another command.

## Invocation Rules

- Invoke app commands only when the user asks to use, run, inspect, query, or otherwise interact with the app.
- For general questions about app capability, summarize visible app commands instead of invoking them.
- Read command summaries and required inputs before invoking. Ask for missing required inputs.
- If the mentioned app has no visible CLI commands in the command guide, say it is not currently exposing usable CLI capabilities.

Keep user-facing explanations about routing brief. This skill carries the mention parsing and CLI lookup burden.
