package agent

var claudeCodeStaticModels = []AgentModelOption{
	{
		ID:          "default",
		DisplayName: "default",
		Description: "Claude Code default model alias",
		IsDefault:   true,
	},
	{
		ID:          "sonnet",
		DisplayName: "sonnet",
		Description: "Claude Code model alias",
	},
	{
		ID:          "opus",
		DisplayName: "opus",
		Description: "Claude Code model alias",
	},
	{
		ID:          "haiku",
		DisplayName: "haiku",
		Description: "Claude Code model alias",
	},
	{
		ID:          "sonnet[1m]",
		DisplayName: "sonnet[1m]",
		Description: "Claude Code model alias",
	},
	{
		ID:          "opusplan",
		DisplayName: "opusplan",
		Description: "Claude Code model alias",
	},
}

func listClaudeCodeModels() []AgentModelOption {
	return applyConfiguredDefaultModel(
		claudeCodeStaticModels,
		readClaudeCodeConfiguredDefaultModel(),
		"Claude Code model alias",
	)
}
