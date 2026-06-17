package agentsidecar

import (
	"strings"
)

func tuttiCLIPolicy(input PrepareInput) string {
	return strings.TrimSpace(renderProviderSkillTemplate(
		"policy_templates/tutti-runtime.md",
		map[string]string{
			"{{COMMAND_GUIDE}}":                     commandGuide(input),
			"{{CLI_COMMAND}}":                       normalizeCLICommandName(input.CLICommand),
			"{{AGENT_SESSION_ID}}":                  strings.TrimSpace(input.AgentSessionID),
			"{{PROVIDER}}":                          strings.TrimSpace(input.Provider),
			"{{PROVIDER_SPECIFIC_MENTION_ROUTING}}": providerSpecificMentionRouting(input.Provider),
			"{{BROWSER_USE_SKILL_LINES}}":           browserUseSkillPolicyLines(input),
			"{{BROWSER_USE_HANDOFF_LINES}}":         browserUseHandoffPolicyLines(input),
		},
	)) + "\n\n" + strings.TrimSpace(renderProviderSkillTemplate("policy_templates/host-app-context.md", nil))
}

func browserUseSkillPolicyLines(input PrepareInput) string {
	if !input.BrowserUse || !BrowserUseDefaultEnabled() {
		return ""
	}
	return "- `browser-use`: browser automation through the daemon-owned `tutti browser` CLI. Prefer this over any generic `browser` skill or direct CDP scripts.\n"
}

func browserUseHandoffPolicyLines(input PrepareInput) string {
	if !input.BrowserUse || !BrowserUseDefaultEnabled() {
		return ""
	}
	return "- For browser tasks — visiting URLs, reading pages, clicking, filling forms, or screenshots — use `browser-use` and `tutti browser` only; do not use provider-native `browser` skills or direct CDP automation.\n"
}

func providerSpecificMentionRouting(provider string) string {
	switch strings.TrimSpace(provider) {
	case "claude-code":
		return strings.TrimSpace(`
Claude Code mention routing:

- Claude Code skill names may be namespaced. The same injected plugin skills may appear as ` + "`tutti-cli:tutti-cli`" + `, ` + "`tutti-cli:issue-manager`" + `, and ` + "`tutti-cli:workspace-app`" + `; treat those names as the authoritative injected Tutti skills when they are visible.
- Claude Code skill listings can omit descriptions for project or plugin skills. When a Tutti skill name appears without a description, this runtime policy is still authoritative for what the skill does and when to use it.
- If the current user turn contains ` + "`mention://workspace-issue?...`" + `, your first tool call MUST be ` + "`Skill(skill=\"issue-manager\", args=\"<full mention URI>\")`" + `. Do not call Bash, Read, ls, WebFetch, browser, MCP lookup, file search, or raw CLI commands before this skill call.
- If the current user turn contains ` + "`mention://workspace-app?...`" + `, your first tool call MUST be ` + "`Skill(skill=\"workspace-app\", args=\"<full mention URI>\")`" + `. Do not call Bash, Read, ls, WebFetch, browser, MCP lookup, file search, or raw CLI commands before this skill call.
- If the current user turn contains ` + "`mention://agent-session?...`" + `, your first tool call MUST be ` + "`Skill(skill=\"tutti-cli\", args=\"<full mention URI>\")`" + `. Do not call Bash, Read, ls, WebFetch, browser, MCP lookup, file search, or raw CLI commands before this skill call.
- If the exact plain skill name is not available but a namespaced Claude Code plugin skill is visible, use the matching namespaced skill instead: ` + "`tutti-cli:issue-manager`" + `, ` + "`tutti-cli:workspace-app`" + `, or ` + "`tutti-cli:tutti-cli`" + `.`)
	default:
		return ""
	}
}

func commandGuide(input PrepareInput) string {
	guide := strings.TrimSpace(input.CommandGuide)
	if guide == "" {
		return fallbackCommandGuide(input.CLICommand)
	}
	return guide
}
