# Tutti Dynamic Skill Routing

Host provided a Tutti dynamic skill bundle.

{{ENVIRONMENT_POLICY_SECTIONS}}

No-mention default:

- Without `mention://...`, do not treat this bundle alone as intent.
- Use Tutti only when the user explicitly asks for Tutti, a Tutti workspace/app/issue/session capability, or a command described in this bundle.

Required mention routing:

- Route any `mention://...` URI by type before files, repo search, shell, browser/web tools, MCP, or raw CLI.
- `mention://workspace-issue/<id>?workspaceId=...` → `$issue-manager`
- `mention://workspace-app/<appId>?workspaceId=...` → `$workspace-app`
- `mention://workspace-reference/<id>?source=...&workspaceId=...` → `$reference`
- `mention://agent-session/<id>?workspaceId=...` → `$tutti-cli`
- `mention://agent-target/<targetId>?workspaceId=...` → `$tutti-handoff`
- Treat `mention://...` as internal references, not web URLs or paths.

Skill usage:

- If provider-native Skill tools exist, call the exact visible name for the matching Skill.
- Otherwise read the materialized `SKILL.md` selected by provider/plugin metadata.
- Do not infer fixed filesystem paths from slugs.
- Do not read app source or run shell commands before matching the Tutti Skill.

{{PROVIDER_SPECIFIC_MENTION_ROUTING}}

Execution:

- `{{.CLICommand}}` needs local daemon localhost/IPC access; if unavailable, explain the limitation.
- Runtime context: session `{{.AgentSessionID}}`, provider `{{.Provider}}`.

Fallback only when the matching Skill is unavailable:

{{if has "issue-manager.issue.get"}}- Issue mention: `{{command "issue-manager.issue.get"}}`
{{else}}- Issue mention: unavailable; do not guess a command.
{{end}}- App mention: match `App id: <appId>` in `command-guide.md`.
{{if has "references.task.list"}}- Reference mention: `{{command "references.task.list" (args "source" "task" "id" "<id>")}}`
{{else if has "references.reference.list"}}- Reference mention: `{{command "references.reference.list" (args "source" "<source>" "id" "<id>")}}`
{{else}}- Reference mention: unavailable; do not guess a command.
{{end}}{{if has "workspace-apps.app.open"}}- Explicit app open/show: `{{command "workspace-apps.app.open" (args "app-id" "<appId>")}}`
{{end}}{{if has "agent-context.agent.wait"}}- Agent-session mention: `{{command "agent-context.agent.wait"}}` for the next stop point.
{{end}}{{if has "agent-context.agent.session-summary"}}- Agent conversation recovery: `{{command "agent-context.agent.session-summary"}}`.
{{else if has "agent-context.agent.get"}}- Agent conversation recovery: `{{command "agent-context.agent.get"}}`.
{{end}}{{if hasAll "agent-context.agent.list" "agent-context.agent.start"}}- Agent-target mention: verify with `{{command "agent-context.agent.list"}}`, then start with `{{command "agent-context.agent.start"}}`.
{{end}}{{if eq .HostFacts.TargetContinuation.Mode "except-prefixes"}}- Targets whose ids start with {{range .HostFacts.TargetContinuation.UnsupportedTargetIDPrefixes}}`{{.}}` {{end}}are start-only.
{{end}}

{{TOOLS_POLICY_SECTIONS}}

{{SKILL_STRATEGY_POLICY_SECTIONS}}

CLI reference:

Available first-level `{{.CLICommand}}` subcommands:

{{range .CommandFamilies}}- `{{$.CLICommand}} {{.}} ...`
{{else}}- No agent-facing command families were advertised by the current Host.
{{end}}

- For syntax and flags, use `{{.CLICommand}} <scope> --help` or `{{.CLICommand}} <scope> <command> --help`.
- App id mapping comes from `command-guide.md` in `$tutti-cli`.

{{SPECIALIZED_POLICY_SECTIONS}}
