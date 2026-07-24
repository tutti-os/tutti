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
- `$workspace-app` is the mention kind and skill name, not a CLI scope. Do not invent `{{.CLICommand}} workspace-app ...` unless that exact command appears in the command guide.

Do not infer app behavior from the mention label alone.

## Context Recovery

After reading the mention query, recover the smallest useful app context through Tutti CLI:

1. If the user explicitly asks to open or show the mentioned app window, or confirms the app window should be opened, {{if has "workspace-apps.app.open"}}use `{{command "workspace-apps.app.open" (args "app-id" "<appId>")}}` for the mentioned app.{{else}}report that the current Host advertises no app-window command; do not guess one.{{end}}
2. Do not call {{if has "workspace-apps.app.open"}}`{{path "workspace-apps.app.open"}}`{{else}}an app-window command{{end}} or app-specific open commands such as `{{.CLICommand}} <scope> open` by default. For ordinary app work, prefer the app-specific CLI command that inspects, queries, updates, starts, or executes the requested operation. After generated media succeeds, render it inline with Markdown instead of opening the app, unless the user asked to open or show the app window.
3. Agent launching is not a workspace-app workflow. New agent references use `mention://agent-target/...` and `$tutti-handoff`; never translate an app id into a provider-specific agent command.
4. If `appId` is `issue-manager` and the user asks issue/task work, read and follow injected `$issue-manager` for issue/task context and workflows before using generic workspace app command matching.
5. For any workspace app mention, if the injected command guide exposes app-specific CLI capabilities for the requested operation, use those persisted app commands instead of provider-native or OS-native substitutes. The external app owns the exact command syntax, validation rules, and domain-specific restrictions through its capability metadata, command guide, and command handler errors.
6. App commands inherit the caller agent session working directory unless their advertised schema provides and the caller supplies another working directory.
7. For other app ids, read `command-guide.md`, find command entries whose metadata says `App id: <appId>`, then run the exact backticked command path shown there. The actual CLI prefix is `{{.CLICommand}}` and may be a production command or a local debug command. If no entry is listed, refresh the command guide or skill bundle capability reference that preserves `App id:` metadata before deciding the app command is unavailable.
8. If several apps have similar names, match by `appId` from the mention, not only by the visible label.
9. Use the listed `{{.CLICommand}} <scope> <command>` examples to inspect or invoke the app. Do not derive a command path from the skill slug.
10. Prefer JSON when the command entry advertises JSON support and output is used as context for reasoning.

If the mentioned app has no visible CLI commands after checking the injected `$tutti-cli` command guide and any refreshed capability reference that preserves `App id:` metadata, explain that the app is not currently exposing usable CLI capabilities instead of guessing an app-specific command.

## Invocation Rules

Read command summaries and required inputs before invoking an app command. Ask for missing required inputs when the user did not provide enough information.

Only invoke app commands when the current user turn asks you to use, run, inspect, query, or otherwise interact with the app. For general questions about what the app can do, summarize the visible app commands. Prefer command scopes that match the mentioned app id, app name, or CLI description. If the mentioned app exposes a no-required-input information command, run the exact command-guide entry first and answer from that output.

Keep user-visible prompts thin. App mention interpretation and CLI lookup structure belong in this skill rather than in the visible handoff prompt.
