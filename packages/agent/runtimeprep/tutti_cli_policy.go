package runtimeprep

import (
	"context"
	"sort"
	"strings"
)

func tuttiCLIPolicy(input PrepareInput) string {
	if input.resolved == nil {
		if resolved, err := resolveCapabilities(context.Background(), input, StandardProfile(), nil); err == nil {
			input.resolved = resolved
		}
	}
	return tuttiRuntimePolicy(input)
}

func hostAppContextPolicy() string {
	return strings.TrimSpace(renderProviderSkillTemplate("policy_templates/host-app-context.md", nil))
}

func tuttiRuntimePolicy(input PrepareInput) string {
	return strings.TrimSpace(renderProviderSkillTemplate(
		"policy_templates/tutti-runtime.md",
		map[string]string{
			"{{PROFILE_TITLE}}":                           resolvedProfileTitle(input),
			"{{PROFILE_INTRO}}":                           resolvedProfileIntro(input),
			"{{COMMAND_GUIDE}}":                           commandGuide(input),
			"{{COMMAND_SUMMARY}}":                         commandGuideSummary(input),
			"{{CLI_COMMAND}}":                             normalizeCLICommandName(input.CLICommand),
			"{{AGENT_SESSION_ID}}":                        strings.TrimSpace(input.AgentSessionID),
			"{{PROVIDER}}":                                strings.TrimSpace(input.Provider),
			"{{PROVIDER_SPECIFIC_MENTION_ROUTING}}":       providerSpecificMentionRouting(input.Provider),
			"{{PROVIDER_SPECIFIC_EXECUTION_ENVIRONMENT}}": "",
			"{{ENVIRONMENT_POLICY_SECTIONS}}":             renderPolicySections(input, PolicyAnchorEnvironment, PolicyDeliveryProviderRuntime),
			"{{TOOLS_POLICY_SECTIONS}}":                   capabilityPolicyLines(input, PolicyDeliveryProviderRuntime),
			"{{SKILL_STRATEGY_POLICY_SECTIONS}}":          renderPolicySections(input, PolicyAnchorSkillStrategy, PolicyDeliveryProviderRuntime),
			"{{SPECIALIZED_POLICY_SECTIONS}}":             renderPolicySections(input, PolicyAnchorSpecialized, PolicyDeliveryProviderRuntime),
		},
	))
}

func resolvedProfileTitle(input PrepareInput) string {
	if input.resolved != nil && strings.TrimSpace(input.resolved.Title) != "" {
		return input.resolved.Title
	}
	return "Tutti Runtime"
}

func resolvedProfileIntro(input PrepareInput) string {
	if input.resolved != nil && strings.TrimSpace(input.resolved.Intro) != "" {
		return input.resolved.Intro
	}
	return "This directory is being used by a Tutti AgentGUI session."
}

func tuttiSkillBundleRecommendedPolicy(input PrepareInput) string {
	return strings.TrimSpace(renderProviderSkillTemplate(
		"policy_templates/skill-bundle-routing.md",
		map[string]string{
			"{{COMMAND_GUIDE}}":                           commandGuide(input),
			"{{COMMAND_SUMMARY}}":                         commandGuideSummary(input),
			"{{CLI_COMMAND}}":                             normalizeCLICommandName(input.CLICommand),
			"{{AGENT_SESSION_ID}}":                        strings.TrimSpace(input.AgentSessionID),
			"{{PROVIDER}}":                                strings.TrimSpace(input.Provider),
			"{{PROVIDER_SPECIFIC_MENTION_ROUTING}}":       providerSpecificMentionRouting(input.Provider),
			"{{PROVIDER_SPECIFIC_EXECUTION_ENVIRONMENT}}": "",
			"{{ENVIRONMENT_POLICY_SECTIONS}}":             renderPolicySections(input, PolicyAnchorEnvironment, PolicyDeliverySkillBundle),
			"{{TOOLS_POLICY_SECTIONS}}":                   capabilityPolicyLines(input, PolicyDeliverySkillBundle),
			"{{SKILL_STRATEGY_POLICY_SECTIONS}}":          renderPolicySections(input, PolicyAnchorSkillStrategy, PolicyDeliverySkillBundle),
			"{{SPECIALIZED_POLICY_SECTIONS}}":             renderPolicySections(input, PolicyAnchorSpecialized, PolicyDeliverySkillBundle),
		},
	))
}

func capabilityPolicyLines(input PrepareInput, delivery PolicyDelivery) string {
	if input.resolved != nil {
		return renderPolicySections(input, PolicyAnchorTools, delivery)
	}
	return strings.TrimSpace(browserUseHandoffPolicyLines(input) + computerUseHandoffPolicyLines(input))
}

func browserUseHandoffPolicyLines(input PrepareInput) string {
	if !input.BrowserUse || !BrowserUseDefaultEnabled() {
		return ""
	}
	return "- For browser tasks — visiting URLs, reading pages, clicking, filling forms, or screenshots — use `$browser-use` and `" + normalizeCLICommandName(input.CLICommand) + " browser` only; do not use provider-native `browser` skills or direct CDP automation.\n"
}

func computerUseHandoffPolicyLines(input PrepareInput) string {
	if !input.ComputerUse || !ComputerUseDefaultEnabled() {
		return ""
	}
	return "- For desktop tasks — taking screenshots, clicking UI elements, typing, pressing keys, or scrolling on the macOS desktop — use `$computer-use` and `" + normalizeCLICommandName(input.CLICommand) + " computer` only; do not use provider-native computer-use tools or accessibility scripts.\n"
}

func providerSpecificMentionRouting(provider string) string {
	switch strings.TrimSpace(provider) {
	case "claude", "claude-code":
		return strings.TrimSpace(`
## Provider Notes

Claude Code mention routing:

- Claude Code skill names may be namespaced. Injected $tutti-cli, $issue-manager, $workspace-app, and $reference may appear as ` + "`tutti-cli:tutti-cli`" + `, ` + "`tutti-cli:issue-manager`" + `, ` + "`tutti-cli:workspace-app`" + `, and ` + "`tutti-cli:reference`" + `; treat visible provider names as authoritative.
- Claude Code skill listings can omit descriptions for project or plugin skills. When a Tutti skill name appears without a description, this runtime policy is still authoritative for what the skill does and when to use it.
- Before calling the Claude Code ` + "`Skill`" + ` tool, choose the exact visible skill name for the matching injected Tutti skill. Use a plain skill name such as ` + "`workspace-app`" + ` only if that exact name is visible; if the visible name is namespaced, call that exact name, for example ` + "`Skill(skill=\"tutti-cli:workspace-app\")`" + `. Do not call a plain skill name that is not visible. Do not pass arguments to Skill; the skill reads the mention URI from the current user turn.
- When falling back to files, read the materialized ` + "`SKILL.md`" + ` that corresponds to the injected Tutti skill in the provider's visible skill listing or plugin metadata. Do not guess a directory from the plain skill slug; materialized directories may be suffixed to avoid collisions with user skills.
- If the current user turn contains ` + "`mention://workspace-issue/<issueId>?workspaceId=...`" + `, first use $issue-manager. Call the exact visible Skill tool when available and successful; if no exact visible Skill tool is available or it fails, fall back to that materialized skill file before any Bash, WebFetch, browser, MCP lookup, file search, or raw CLI commands.
- If the current user turn contains ` + "`mention://workspace-app/<appId>?workspaceId=...`" + `, first use $workspace-app. Call the exact visible Skill tool when available and successful; if no exact visible Skill tool is available or it fails, fall back to that materialized skill file before any Bash, WebFetch, browser, MCP lookup, file search, or raw CLI commands.
- If the current user turn contains ` + "`mention://workspace-reference/<id>?source=...&workspaceId=...`" + `, first use $reference. Call the exact visible Skill tool when available and successful; if no exact visible Skill tool is available or it fails, fall back to that materialized skill file before any Bash, WebFetch, browser, MCP lookup, file search, or raw CLI commands.
- If the current user turn contains ` + "`mention://agent-session/<sessionId>?workspaceId=...`" + `, first use $tutti-handoff. Call the exact visible Skill tool when available and successful; if no exact visible Skill tool is available or it fails, fall back to that materialized skill file before any Bash, WebFetch, browser, MCP lookup, file search, or raw CLI commands.
- If the current user turn contains ` + "`mention://agent-target/<targetId>?workspaceId=...`" + `, first use $tutti-handoff. Call the exact visible Skill tool when available and successful; if no exact visible Skill tool is available or it fails, fall back to that materialized skill file before any Bash, WebFetch, browser, MCP lookup, file search, or raw CLI commands. Follow the handoff skill's current-catalog workflow; do not infer provider-specific commands or assume a fixed agent catalog.`)
	default:
		return ""
	}
}

func providerSpecificExecutionEnvironment(provider string, cliCommand string) string {
	command := normalizeCLICommandName(cliCommand)
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "codex":
		return "- Codex: `" + command + "` needs localhost/IPC. When running `" + command + "` from a sandboxed exec tool, set `sandbox_permissions=require_escalated`. If `" + command + "` reports `daemon is not reachable from this agent execution environment`, rerun once with `sandbox_permissions=require_escalated`.\n"
	case "claude", "claude-code":
		return "- Claude Code `Monitor` tool is disabled. Poll async Tutti jobs with one bounded shell/script.\n- Claude Code: run `" + command + "` only from a shell environment that can reach localhost/IPC. If the provider runtime cannot reach the local Tutti daemon, report that limitation; do not invent Codex `sandbox_permissions`.\n"
	case "cursor", "cursor-agent", "hermes", "hermes-agent", "nexight", "tutti", "openclaw", "open-claw", "opencode", "open-code", "tutti-agent":
		return "- This provider must run `" + command + "` from an execution environment with localhost/IPC access. If the daemon is unreachable from the provider runtime, report that limitation instead of retrying with provider-specific sandbox flags.\n"
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

func commandGuideReference(input PrepareInput) string {
	return "# Tutti CLI Command Guide\n\n" + commandGuide(input) + "\n"
}

func commandGuideSummary(input PrepareInput) string {
	cliName := normalizeCLICommandName(input.CLICommand)
	scopes := commandGuideScopeSummaries(commandGuide(input), cliName)
	if len(scopes) == 0 {
		return "- `" + cliName + " ...` - CLI commands; use help for details."
	}
	lines := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		lines = append(lines, "- `"+cliName+" "+scope.Name+" ...` - "+scope.Description)
	}
	return strings.Join(lines, "\n")
}

type commandScopeSummary struct {
	Name        string
	Description string
}

type commandScopeInfo struct {
	appIDs           map[string]bool
	appNames         map[string]bool
	commandSummaries map[string]bool
}

func commandGuideScopeSummaries(guide string, cliName string) []commandScopeSummary {
	byScope := make(map[string]*commandScopeInfo)
	for _, line := range strings.Split(guide, "\n") {
		command := firstBacktickedCommand(line)
		if command == "" {
			continue
		}
		fields := strings.Fields(command)
		if len(fields) < 2 || fields[0] != cliName {
			continue
		}
		scope := strings.TrimSpace(fields[1])
		if scope == "" {
			continue
		}
		info := byScope[scope]
		if info == nil {
			info = &commandScopeInfo{
				appIDs:           make(map[string]bool),
				appNames:         make(map[string]bool),
				commandSummaries: make(map[string]bool),
			}
			byScope[scope] = info
		}
		if summary := commandGuideLineSummary(line); summary != "" {
			info.commandSummaries[summary] = true
		}
		if appName := commandGuideLineAppName(line); appName != "" {
			info.appNames[appName] = true
		}
		if appID := commandGuideLineAppID(line); appID != "" {
			info.appIDs[appID] = true
		}
	}
	if len(byScope) == 0 {
		return nil
	}
	scopeNames := make([]string, 0, len(byScope))
	for scope := range byScope {
		scopeNames = append(scopeNames, scope)
	}
	sort.Strings(scopeNames)
	summaries := make([]commandScopeSummary, 0, len(scopeNames))
	for _, scope := range scopeNames {
		summaries = append(summaries, commandScopeSummary{
			Name:        scope,
			Description: commandScopeDescription(scope, byScope[scope]),
		})
	}
	return summaries
}

func commandScopeDescription(scope string, info *commandScopeInfo) string {
	const codexCommandScope = "codex"

	switch strings.TrimSpace(scope) {
	case "agent":
		return "agent discovery, launches, sessions, waits, summaries, turn resources, active peers."
	case "app":
		return "open/show installed app windows only when explicitly requested."
	case "browser":
		return "daemon-owned browser automation."
	case "claude", codexCommandScope, "tutti-agent":
		return "legacy provider-specific commands."
	case "computer":
		return "daemon-owned macOS desktop automation."
	case "issue":
		return "issue/topic/task/run inspection and execution state."
	case "reference":
		return "workspace reference artifact lookup."
	}
	if info != nil && (len(info.appNames) > 0 || len(info.appIDs) > 0) {
		names := sortedSetValues(info.appNames)
		ids := sortedSetValues(info.appIDs)
		if len(names) > 0 && len(ids) > 0 {
			return "workspace app commands for " + strings.Join(names, ", ") + " (App id: " + strings.Join(ids, ", ") + ")."
		}
		if len(names) > 0 {
			return "workspace app commands for " + strings.Join(names, ", ") + "."
		}
		return "workspace app commands for App id: " + strings.Join(ids, ", ") + "."
	}
	if info != nil && len(info.commandSummaries) > 0 {
		return compactCommandSummaryDescription(info.commandSummaries)
	}
	return "CLI commands; use help for details."
}

func firstBacktickedCommand(text string) string {
	start := strings.Index(text, "`")
	if start < 0 {
		return ""
	}
	text = text[start+1:]
	end := strings.Index(text, "`")
	if end < 0 {
		return ""
	}
	return strings.TrimSpace(text[:end])
}

func commandGuideLineAppName(line string) string {
	const prefix = "Provided by workspace app "
	start := strings.Index(line, prefix)
	if start < 0 {
		return ""
	}
	rest := line[start+len(prefix):]
	if end := strings.Index(rest, "."); end >= 0 {
		rest = rest[:end]
	}
	return strings.TrimSpace(rest)
}

func commandGuideLineSummary(line string) string {
	start := strings.Index(line, "- ")
	if start >= 0 {
		line = line[start+2:]
	}
	end := strings.Index(line, ": `")
	if end < 0 {
		return ""
	}
	return strings.TrimSpace(line[:end])
}

func commandGuideLineAppID(line string) string {
	const prefix = "App id: "
	start := strings.Index(line, prefix)
	if start < 0 {
		return ""
	}
	rest := line[start+len(prefix):]
	if end := strings.Index(rest, "."); end >= 0 {
		rest = rest[:end]
	}
	return strings.TrimSpace(rest)
}

func compactCommandSummaryDescription(summaries map[string]bool) string {
	values := sortedSetValues(summaries)
	if len(values) == 0 {
		return "CLI commands; use help for details."
	}
	if len(values) > 2 {
		values = values[:2]
	}
	for i, value := range values {
		values[i] = strings.TrimSuffix(strings.TrimSpace(value), ".")
	}
	return strings.Join(values, "; ") + "."
}

func sortedSetValues(set map[string]bool) []string {
	values := make([]string, 0, len(set))
	for value := range set {
		if strings.TrimSpace(value) != "" {
			values = append(values, strings.TrimSpace(value))
		}
	}
	sort.Strings(values)
	return values
}
