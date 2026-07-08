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

func opencodeACPEnv(session Session, host HostMetadata) []string {
	env := standardACPEnv(session, host)
	if configContent := opencodeConfigContent(session); configContent != "" {
		env = append(env, "OPENCODE_CONFIG_CONTENT="+configContent)
	}
	return env
}

func opencodeConfigContent(session Session) string {
	model := strings.TrimSpace(session.SettingsValue().Model)
	if model == "" {
		return ""
	}
	data, err := json.Marshal(map[string]string{
		"model": model,
	})
	if err != nil {
		return ""
	}
	return string(data)
}
