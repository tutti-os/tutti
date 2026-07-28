{{if eq .Provider "codex"}}

- Codex: `{{.CLICommand}}` needs localhost/IPC. When running `{{.CLICommand}}` from a sandboxed exec tool, set `sandbox_permissions=require_escalated`. If `{{.CLICommand}}` reports `daemon is not reachable from this agent execution environment`, rerun once with `sandbox_permissions=require_escalated`.
  {{else if or (eq .Provider "claude") (eq .Provider "claude-code")}}
- Claude Code `Monitor` tool is disabled. Poll async Tutti jobs with one bounded shell/script.
- Claude Code: run `{{.CLICommand}}` only from a shell environment that can reach localhost/IPC. If the provider runtime cannot reach the local Tutti daemon, report that limitation; do not invent Codex `sandbox_permissions`.
  {{else if or (eq .Provider "cursor") (eq .Provider "cursor-agent") (eq .Provider "hermes") (eq .Provider "hermes-agent") (eq .Provider "nexight") (eq .Provider "tutti") (eq .Provider "openclaw") (eq .Provider "open-claw") (eq .Provider "opencode") (eq .Provider "open-code") (eq .Provider "tutti-agent")}}
- This provider must run `{{.CLICommand}}` from an execution environment with localhost/IPC access. If the daemon is unreachable from the provider runtime, report that limitation instead of retrying with provider-specific sandbox flags.
  {{end}}
