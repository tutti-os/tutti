---
name: workspace-app
description: Use for `mention://workspace-app/<appId>?workspaceId=...` links to map a workspace app id to exact entries in the injected Tutti command guide. This skill is not a CLI scope.
---

# Workspace App

Use this skill when the current user turn contains one or more `mention://workspace-app/<appId>?workspaceId=...` links.

Before choosing an app command, use injected `$tutti-cli` for CLI syntax and currently visible commands. Exact commands and `App id:` metadata live in its `command-guide.md` file. If you need to load `$tutti-cli` through a provider-native Skill tool, call the exact visible skill name with no arguments, such as `tutti-cli:tutti-cli` when that namespaced name is visible. Do not derive filesystem paths from the plugin directory, plugin name, or skill slug; materialized skill paths must come from the provider/runtime skill listing.

The injected `$tutti-cli` command guide is a snapshot rendered for the current agent runtime or skill bundle. Workspace app commands can appear or disappear after app install, reload, start, stop, daemon restart, or session refresh. If the mentioned app should be active but no matching command is listed, refresh the command guide or skill bundle capability reference that preserves `App id:` metadata before deciding the app has no usable CLI command. Do not use CLI help alone to map a workspace app id to a CLI scope; use help only after the scope is known.

## Mention Contract

Treat a `mention://workspace-app/<appId>?workspaceId=...` link as the machine-readable source of truth for the referenced app. The mention uses the URL path as the app id and `workspaceId` as query scope.

- URL path: target workspace app id.
- `workspaceId`: workspace context for command discovery and invocation.
- The app id and CLI scope are separate. Do not assume they are equal. In the injected `$tutti-cli` command guide, match command entries by `App id: <appId>`, then use the exact listed command path; the first path segment is the CLI scope.
- `$workspace-app` is the mention kind and skill name, not a CLI scope. Do not invent `{{CLI_COMMAND}} workspace-app ...` unless that exact command appears in the command guide.

Do not infer app behavior from the mention label alone.

## Context Recovery

After reading the mention query, recover the smallest useful app context through Tutti CLI:

1. If the user explicitly asks to open or show the mentioned app window, or confirms the app window should be opened, use `{{CLI_COMMAND}} app open --app-id <appId> --json` for the mentioned app. Built-in app ids include `agent-codex`, `agent-claude-code`, `issue-manager`, and `tutti-onboarding`.
2. Do not call `app open` or app-specific open commands such as `{{CLI_COMMAND}} <scope> open` by default. For ordinary app work, prefer the app-specific CLI command that inspects, queries, updates, starts, or executes the requested operation. After generated media succeeds, render it inline with Markdown instead of opening the app, unless the user asked to open or show the app window.
3. If `appId` is `agent-codex` and the user asks to start Codex work, use `{{CLI_COMMAND}} codex start --prompt <task> --show --json`. In the handoff prompt, express readable local file references as `[@filename](/absolute/path)` instead of a bare path or plain path sentence, so the launched agent receives file context close to the original `@file` intent. For images, choose one representation per image: use `--image <localPath>` when structured visual input is more important than prompt-order context, or use `[@filename](/absolute/path)` in the prompt when preserving the file reference's turn/order context is more useful. Do not send the same image through both representations unless the user explicitly asks. When image context may be useful, use `{{CLI_COMMAND}} agent session-summary --session-id <caller-session-id> --json` to discover candidate turn ids when needed, then use `{{CLI_COMMAND}} agent turn-resources --session-id <caller-session-id> --turn-id <turnId> --json` for the chosen turn ids and decide which returned images, if any, to represent as one `--image <localPath>` argument each. Usually inspect the active turn and, when the task refers to a recent screenshot or attachment, the previous one or two user turns. Do not scan files or reconstruct attachment paths yourself. Add `--model <model>` only when the user explicitly requested a model or command output gives an exact model to reuse.
4. If `appId` is `agent-claude-code` and the user asks to start Claude Code work, use `{{CLI_COMMAND}} claude start --prompt <task> --show --json`. In the handoff prompt, express readable local file references as `[@filename](/absolute/path)` instead of a bare path or plain path sentence, so the launched agent receives file context close to the original `@file` intent. For images, choose one representation per image: use `--image <localPath>` when structured visual input is more important than prompt-order context, or use `[@filename](/absolute/path)` in the prompt when preserving the file reference's turn/order context is more useful. Do not send the same image through both representations unless the user explicitly asks. When image context may be useful, use `{{CLI_COMMAND}} agent session-summary --session-id <caller-session-id> --json` to discover candidate turn ids when needed, then use `{{CLI_COMMAND}} agent turn-resources --session-id <caller-session-id> --turn-id <turnId> --json` for the chosen turn ids and decide which returned images, if any, to represent as one `--image <localPath>` argument each. Usually inspect the active turn and, when the task refers to a recent screenshot or attachment, the previous one or two user turns. Do not scan files or reconstruct attachment paths yourself. Add `--model <model>` only when the user explicitly requested a model or command output gives an exact model to reuse.
5. If `appId` is `issue-manager` and the user asks issue/task work, read and follow injected `$issue-manager` for issue/task context and workflows before using generic workspace app command matching.
6. For any workspace app mention, if the injected command guide exposes app-specific CLI capabilities for the requested operation, use those persisted app commands instead of provider-native or OS-native substitutes. The external app owns the exact command syntax, validation rules, and domain-specific restrictions through its capability metadata, command guide, and command handler errors.
7. When `--cwd` is not specified, tuttid inherits the caller agent session working directory.
8. For agent launcher mentions, ask for a missing task prompt before invoking. Do not ask for a missing model; when `--model` is omitted, tuttid uses the target provider's configured/default model. If the user provided a model and the command rejects it, use the error's available model list to ask for or select a valid value.
9. For other app ids, read `command-guide.md`, find command entries whose metadata says `App id: <appId>`, then run the exact backticked command path shown there. The actual CLI prefix is `{{CLI_COMMAND}}` and may be a production command or a local debug command. If no entry is listed, refresh the command guide or skill bundle capability reference that preserves `App id:` metadata before deciding the app command is unavailable.
10. If several apps have similar names, match by `appId` from the mention, not only by the visible label.
11. Use the listed `{{CLI_COMMAND}} <scope> <command>` examples to inspect or invoke the app. Do not derive a command path from the skill slug.
12. Prefer `--json` when the command output is used as context for reasoning.

If the mentioned app has no visible CLI commands after checking the injected `$tutti-cli` command guide and any refreshed capability reference that preserves `App id:` metadata, explain that the app is not currently exposing usable CLI capabilities instead of guessing an app-specific command.

## Helpers

### turn-resources

Use this helper only when the user asks to start or delegate work to `agent-codex` or `agent-claude-code` and the launched agent may need resources from a specific caller session turn.

Input: the current caller agent session id from runtime context and one selected `turnId`. Use `{{CLI_COMMAND}} agent session-summary --session-id <caller-session-id> --json` only to discover candidate turn ids such as `session.turnLifecycle.activeTurnId` or recent user message `turnId` values.

Command: `{{CLI_COMMAND}} agent turn-resources --session-id <caller-session-id> --turn-id <turnId> --json`.

Output: the matching turn's resource-bearing user messages, preserving message fields such as `messageId`, `turnId`, `text`, and each message's `images[]` array with `attachmentId`, `mimeType`, `name`, and `localPath` when present. Images remain grouped under their source message.

For current `codex start` and `claude start` commands, the calling agent decides which turn ids to query and how to represent each returned image. Add one `--image <localPath>` argument for each image chosen for structured visual input. If preserving prompt/turn ordering is more useful for an image reference, mention it in the prompt as `[@filename](/absolute/path)` instead. Do not send the same image both ways unless the user explicitly asks. If no selected image objects have usable `localPath` values, continue without image arguments. Do not scan the workspace, inspect attachment directories, or hand-build paths from `attachmentId`; `agent turn-resources` is the source of truth for turn resource metadata.

## Invocation Rules

Read command summaries and required inputs before invoking an app command. Ask for missing required inputs when the user did not provide enough information.

Only invoke app commands when the current user turn asks you to use, run, inspect, query, or otherwise interact with the app. For general questions about what the app can do, summarize the visible app commands. Prefer command scopes that match the mentioned app id, app name, or CLI description. If the mentioned app exposes a no-required-input information command such as `{{CLI_COMMAND}} <scope> read --json` or `{{CLI_COMMAND}} <scope> summary --json`, run it first and answer from that output.

Keep user-visible prompts thin. App mention interpretation and CLI lookup structure belong in this skill rather than in the visible handoff prompt.
