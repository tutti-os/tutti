package agentsidecar

import (
	"strings"
)

func tuttiCLIPolicy(input PrepareInput) string {
	return tuttiRuntimePolicy(input) + "\n\n" + strings.TrimSpace(renderProviderSkillTemplate("policy_templates/host-app-context.md", nil))
}

func tuttiRuntimePolicy(input PrepareInput) string {
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
			"{{COMPUTER_USE_SKILL_LINES}}":          computerUseSkillPolicyLines(input),
			"{{COMPUTER_USE_HANDOFF_LINES}}":        computerUseHandoffPolicyLines(input),
		},
	))
}

func tuttiSkillBundleRecommendedPolicy(input PrepareInput) string {
	return strings.TrimSpace(renderProviderSkillTemplate(
		"policy_templates/skill-bundle-routing.md",
		map[string]string{
			"{{COMMAND_GUIDE}}":                     commandGuide(input),
			"{{CLI_COMMAND}}":                       normalizeCLICommandName(input.CLICommand),
			"{{AGENT_SESSION_ID}}":                  strings.TrimSpace(input.AgentSessionID),
			"{{PROVIDER}}":                          strings.TrimSpace(input.Provider),
			"{{PROVIDER_SPECIFIC_MENTION_ROUTING}}": providerSpecificMentionRouting(input.Provider),
			"{{BROWSER_USE_SKILL_LINES}}":           browserUseSkillPolicyLines(input),
			"{{BROWSER_USE_HANDOFF_LINES}}":         browserUseHandoffPolicyLines(input),
			"{{COMPUTER_USE_SKILL_LINES}}":          computerUseSkillPolicyLines(input),
			"{{COMPUTER_USE_HANDOFF_LINES}}":        computerUseHandoffPolicyLines(input),
		},
	))
}

func browserUseSkillPolicyLines(input PrepareInput) string {
	if !input.BrowserUse || !BrowserUseDefaultEnabled() {
		return ""
	}
	return "- `browser-use`: browser automation through the daemon-owned `" + normalizeCLICommandName(input.CLICommand) + " browser` CLI. Prefer this over any generic `browser` skill or direct CDP scripts.\n"
}

func browserUseHandoffPolicyLines(input PrepareInput) string {
	if !input.BrowserUse || !BrowserUseDefaultEnabled() {
		return ""
	}
	return "- For browser tasks — visiting URLs, reading pages, clicking, filling forms, or screenshots — use `browser-use` and `" + normalizeCLICommandName(input.CLICommand) + " browser` only; do not use provider-native `browser` skills or direct CDP automation.\n"
}

func computerUseSkillPolicyLines(input PrepareInput) string {
	if !input.ComputerUse || !ComputerUseDefaultEnabled() {
		return ""
	}
	return "- `computer-use`: macOS desktop automation through the daemon-owned `" + normalizeCLICommandName(input.CLICommand) + " computer` CLI. Prefer this over any generic computer-use or accessibility scripts.\n"
}

func computerUseHandoffPolicyLines(input PrepareInput) string {
	if !input.ComputerUse || !ComputerUseDefaultEnabled() {
		return ""
	}
	return "- For desktop tasks — taking screenshots, clicking UI elements, typing, pressing keys, or scrolling on the macOS desktop — use `computer-use` and `" + normalizeCLICommandName(input.CLICommand) + " computer` only; do not use provider-native computer-use tools or accessibility scripts.\n"
}

func providerSpecificMentionRouting(provider string) string {
	switch strings.TrimSpace(provider) {
	case "claude", "claude-code":
		return strings.TrimSpace(`
Claude Code mention routing:

- Claude Code skill names may be namespaced. The same injected plugin skills may appear as ` + "`tutti-cli:tutti-cli`" + `, ` + "`tutti-cli:issue-manager`" + `, ` + "`tutti-cli:workspace-app`" + `, and ` + "`tutti-cli:reference`" + `; treat those names as the authoritative injected Tutti skills when they are visible.
- Claude Code skill listings can omit descriptions for project or plugin skills. When a Tutti skill name appears without a description, this runtime policy is still authoritative for what the skill does and when to use it.
- Before calling the Claude Code ` + "`Skill`" + ` tool, choose the exact visible skill name for the matching injected Tutti skill. Use a plain skill name such as ` + "`workspace-app`" + ` only if that exact name is visible; if the visible name is namespaced, call that exact name, for example ` + "`Skill(skill=\"tutti-cli:workspace-app\")`" + `. Do not call a plain skill name that is not visible. Do not pass arguments to Skill; the skill reads the mention URI from the current user turn.
- When falling back to files, read the materialized ` + "`SKILL.md`" + ` that corresponds to the injected Tutti skill in the provider's visible skill listing or plugin metadata. Do not guess a directory from the plain skill slug; materialized directories may be suffixed to avoid collisions with user skills.
- If the current user turn contains ` + "`mention://workspace-issue/<issueId>?workspaceId=...`" + `, first use the ` + "`issue-manager`" + ` skill. Call the exact visible Skill tool for ` + "`issue-manager`" + ` when available and successful; if no exact visible Skill tool is available or it fails, fall back to that materialized skill file before any Bash, WebFetch, browser, MCP lookup, file search, or raw CLI commands.
- If the current user turn contains ` + "`mention://workspace-app/<appId>?workspaceId=...`" + `, first use the ` + "`workspace-app`" + ` skill. Call the exact visible Skill tool for ` + "`workspace-app`" + ` when available and successful; if no exact visible Skill tool is available or it fails, fall back to that materialized skill file before any Bash, WebFetch, browser, MCP lookup, file search, or raw CLI commands.
- If the current user turn contains ` + "`mention://workspace-reference/<id>?source=...&workspaceId=...`" + `, first use the ` + "`reference`" + ` skill. Call the exact visible Skill tool for ` + "`reference`" + ` when available and successful; if no exact visible Skill tool is available or it fails, fall back to that materialized skill file before any Bash, WebFetch, browser, MCP lookup, file search, or raw CLI commands.
- If the current user turn contains ` + "`mention://agent-session/<sessionId>?workspaceId=...`" + `, first use the ` + "`tutti-cli`" + ` skill. Call the exact visible Skill tool for ` + "`tutti-cli`" + ` when available and successful; if no exact visible Skill tool is available or it fails, fall back to that materialized skill file before any Bash, WebFetch, browser, MCP lookup, file search, or raw CLI commands.`)
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
