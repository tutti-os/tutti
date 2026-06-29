---
name: workspace-app
description: Use for `mention://workspace-app/<appId>?workspaceId=...` links to discover, inspect, or invoke CLI-enabled Tutti workspace app commands.
---

# Workspace App

Use this skill when the current user turn contains one or more `mention://workspace-app/<appId>?workspaceId=...` links.

To discover the mentioned app's CLI commands, run `{{CLI_COMMAND}} app commands --app-id <appId> --json`. The always-on session policy lists only a compact app index (app name + id), not each app's commands, so look them up on demand with this command. For general Tutti CLI syntax you may also consult the injected `tutti-cli` skill; if you load it through a provider-native Skill tool, call the exact visible skill name with no arguments, such as `tutti-cli:tutti-cli` when that namespaced name is visible. Do not derive filesystem paths from the plugin directory, plugin name, or skill slug; materialized skill paths must come from the provider/runtime skill listing.

`{{CLI_COMMAND}} app commands` queries the live catalog, so it always reflects current state — workspace app commands can appear or disappear after app install, reload, start, stop, daemon restart, or session refresh. If the mentioned app should be active but the lookup returns no commands, the app currently exposes no usable CLI commands. Do not use CLI help alone to map a workspace app id to a CLI scope; use help only after the scope is known.

## Mention Contract

Treat a `mention://workspace-app/<appId>?workspaceId=...` link as the machine-readable source of truth for the referenced app. The mention uses the URL path as the app id and `workspaceId` as query scope.

- URL path: target workspace app id.
- `workspaceId`: workspace context for command discovery and invocation.
- The app id and CLI scope are separate. Do not assume they are equal. Run `{{CLI_COMMAND}} app commands --app-id <appId> --json` and use the exact listed command path from the result; the first path segment is the CLI scope.

Do not infer app behavior from the mention label alone.

## Context Recovery

After reading the mention query, recover the smallest useful app context through Tutti CLI:

1. If the user explicitly asks to open or show the mentioned app window, or confirms the app window should be opened, use `{{CLI_COMMAND}} app open --app-id <appId> --json` for the mentioned app. Built-in app ids include `agent-codex`, `agent-claude-code`, `issue-manager`, and `tutti-onboarding`.
2. Do not call `app open` or app-specific open commands such as `{{CLI_COMMAND}} <scope> open` by default. For ordinary app work, prefer the app-specific CLI command that inspects, queries, updates, starts, or executes the requested operation. After generated media succeeds, render it inline with Markdown instead of opening the app, unless the user asked to open or show the app window.
3. If `appId` is `agent-codex` and the user asks to start Codex work, use `{{CLI_COMMAND}} codex start --prompt <task> --show --json`. Add `--model <model>` only when the user explicitly requested a model or command output gives an exact model to reuse.
4. If `appId` is `agent-claude-code` and the user asks to start Claude Code work, use `{{CLI_COMMAND}} claude start --prompt <task> --show --json`. Add `--model <model>` only when the user explicitly requested a model or command output gives an exact model to reuse.
5. If `appId` is `issue-manager` and the user asks issue/task work, read and follow the injected `issue-manager` skill for issue/task context and workflows before using generic workspace app command matching.
6. When `--cwd` is not specified, tuttid inherits the caller agent session working directory.
7. For agent launcher mentions, ask for a missing task prompt before invoking. Do not ask for a missing model; when `--model` is omitted, tuttid uses the target provider's configured/default model. If the user provided a model and the command rejects it, use the error's available model list to ask for or select a valid value.
8. For other app ids, run `{{CLI_COMMAND}} app commands --app-id <appId> --json`, then use the listed command path and scope from the result. If it returns no commands, the app exposes no usable CLI commands.
9. If several apps have similar names, match by `appId` from the mention, not only by the visible label.
10. Use the listed `{{CLI_COMMAND}} <scope> <command>` examples to inspect or invoke the app.
11. Prefer `--json` when the command output is used as context for reasoning.

If `{{CLI_COMMAND}} app commands --app-id <appId> --json` returns no commands, explain that the app is not currently exposing usable CLI capabilities instead of guessing an app-specific command.

## Invocation Rules

Read command summaries and required inputs before invoking an app command. Ask for missing required inputs when the user did not provide enough information.

Only invoke app commands when the current user turn asks you to use, run, inspect, query, or otherwise interact with the app. For general questions about what the app can do, summarize the visible app commands. Prefer command scopes that match the mentioned app id, app name, or CLI description. If the mentioned app exposes a no-required-input information command such as `{{CLI_COMMAND}} <scope> read --json` or `{{CLI_COMMAND}} <scope> summary --json`, run it first and answer from that output.

Keep user-visible prompts thin. App mention interpretation and CLI lookup structure belong in this skill rather than in the visible handoff prompt.
