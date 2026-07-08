package agentruntime

// OpenCode's ACP provider config (`opencode acp`). OpenCode documents model
// selection through config/env, not an ACP CLI flag, so session model overrides
// are injected with OPENCODE_CONFIG_CONTENT at process start.

import (
	"encoding/json"
	"strings"
)

func NewOpenCodeAdapter(transport ProcessTransport) *standardACPAdapter {
	return NewOpenCodeAdapterWithHostMetadata(transport, LegacyHostMetadata())
}

func NewOpenCodeAdapterWithHostMetadata(transport ProcessTransport, host HostMetadata) *standardACPAdapter {
	return &standardACPAdapter{
		config: standardACPConfig{
			provider:            ProviderOpenCode,
			adapterName:         "opencode-acp",
			command:             []string{"opencode", "acp"},
			defaultTitle:        "OpenCode",
			defaultTitleAliases: []string{"OpenCode", ProviderOpenCode, "opencode"},
			authRequiredMessage: "OpenCode ACP requires authentication; run `opencode auth login` on the host, then retry this session.",
			permissionModeID:    opencodeACPModeID,
			initializeParams:    func() map[string]any { return defaultACPInitializeParams(host) },
			env:                 func(session Session) []string { return opencodeACPEnv(session, host) },
		},
		transport: transport,
		host:      host,
		sessions:  make(map[string]*standardACPSession),
	}
}

func opencodeACPModeID(mode string) string {
	switch strings.TrimSpace(mode) {
	case "plan":
		return "plan"
	case "", "build":
		return "build"
	default:
		return ""
	}
}

func opencodeACPCommands() []AgentSessionCommand {
	return []AgentSessionCommand{
		{
			Name:        "compact",
			Description: "Compact the conversation context",
		},
		{
			Name:        "review",
			Description: "Review code changes",
			InputHint:   "instructions (optional)",
		},
	}
}

func opencodeACPEnv(session Session, host HostMetadata) []string {
	env := standardACPEnv(session, host)
	if configContent := opencodeConfigContent(session); configContent != "" {
		env = append(env, "OPENCODE_CONFIG_CONTENT="+configContent)
	}
	return env
}

func opencodeConfigContent(session Session) string {
	model := strings.TrimSpace(session.SettingsValue().Model)
	config := map[string]any{
		"command": map[string]any{
			"review": map[string]any{
				"template":    "Review the requested code scope. Interpret empty arguments or `uncommitted` as uncommitted changes; `base:<branch>` as comparing current work with that branch; `commit:<sha>` as reviewing that commit; and `custom:<text>` as custom review instructions. Focus on correctness bugs, behavioral regressions, missing tests, and security risks.\n\nArguments: $ARGUMENTS",
				"description": "Review code changes",
			},
		},
	}
	if model != "" {
		config["model"] = model
	}
	data, err := json.Marshal(config)
	if err != nil {
		return ""
	}
	return string(data)
}
