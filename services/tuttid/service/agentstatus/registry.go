package agentstatus

import "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"

type Registry struct {
	Specs []ProviderSpec
}

type ProviderSupportStatus string

const (
	ProviderSupportStatusAvailable   ProviderSupportStatus = "available"
	ProviderSupportStatusUnsupported ProviderSupportStatus = "unsupported"
)

const DisabledReasonProviderTemporarilyUnsupported = "provider_temporarily_unsupported"
const codexServiceTierOverride = `service_tier="fast"`

type ProviderSpec struct {
	Provider                     string
	SupportStatus                ProviderSupportStatus
	DisabledReasonCode           string
	BinaryNames                  []string
	AdapterBinaryNames           []string
	AdapterCommand               []string
	AdapterEnv                   []string
	ExternalRegistryID           string
	AdapterUnavailableReasonCode string
	AdapterPackage               AdapterPackageRequirement
	AuthStatusCommand            []string
	AuthMarkerPaths              []string
	Install                      InstallerSpec
	AdapterInstall               InstallerSpec
	LoginArgs                    []string
}

type AdapterPackageRequirement struct {
	Name    string
	Version string
}

func (r Registry) Select(providers []string) ([]ProviderSpec, error) {
	specs := r.Specs
	if len(specs) == 0 {
		specs = DefaultRegistry().Specs
	}
	byProvider := make(map[string]ProviderSpec, len(specs))
	for _, spec := range specs {
		normalized := agentprovider.Normalize(spec.Provider)
		if normalized != "" {
			spec.Provider = normalized
			byProvider[normalized] = spec
		}
	}
	if len(providers) == 0 {
		result := make([]ProviderSpec, 0, len(specs))
		for _, spec := range specs {
			if normalized := agentprovider.Normalize(spec.Provider); normalized != "" {
				spec.Provider = normalized
				result = append(result, spec)
			}
		}
		return result, nil
	}

	seen := make(map[string]bool, len(providers))
	result := make([]ProviderSpec, 0, len(providers))
	for _, provider := range providers {
		normalized := agentprovider.Normalize(provider)
		spec, ok := byProvider[normalized]
		if !ok {
			return nil, ErrInvalidProvider
		}
		if seen[normalized] {
			continue
		}
		seen[normalized] = true
		result = append(result, spec)
	}
	return result, nil
}

func DefaultRegistry() Registry {
	specsByProvider := map[string]ProviderSpec{
		agentprovider.ClaudeCode: {
			Provider:          agentprovider.ClaudeCode,
			BinaryNames:       []string{"claude"},
			AuthStatusCommand: []string{"auth", "status"},
			AuthMarkerPaths:   []string{"~/.claude.json", "~/.claude/auth.json"},
			Install: InstallerSpec{
				Kind:           InstallerKindOfficialScript,
				DisplayCommand: "curl -fsSL https://claude.ai/install.sh | bash",
				ScriptURL:      "https://claude.ai/install.sh",
				ScriptShell:    "bash",
			},
			LoginArgs: []string{"auth", "login"},
		},
		agentprovider.Codex: {
			Provider:    agentprovider.Codex,
			BinaryNames: []string{"codex"},
			// Codex talks to the local codex binary's built-in app-server; there
			// is no separate ACP adapter. Resolve/probe that command directly so
			// availability reflects "codex app-server" rather than bare `codex`
			// (which is an interactive TUI and fails headless with
			// "stdin is not a terminal").
			AdapterBinaryNames: []string{"codex"},
			AdapterCommand:     []string{"codex", "app-server"},
			AuthStatusCommand:  []string{"login", "-c", codexServiceTierOverride, "status"},
			AuthMarkerPaths:    []string{"~/.codex/auth.json"},
			Install:            codexCLIInstallerSpec(),
			LoginArgs:          []string{"login", "-c", codexServiceTierOverride},
		},
		agentprovider.Nexight: {
			Provider:           agentprovider.Nexight,
			SupportStatus:      ProviderSupportStatusUnsupported,
			DisabledReasonCode: DisabledReasonProviderTemporarilyUnsupported,
			BinaryNames:        []string{"nexight"},
			AdapterBinaryNames: []string{"nexight-acp"},
			AdapterCommand:     []string{"nexight-acp"},
			AuthMarkerPaths:    []string{"~/.nexight/auth.json", "~/.tutti/nexight/auth.json"},
			LoginArgs:          []string{"login"},
		},
		agentprovider.Gemini: {
			Provider:           agentprovider.Gemini,
			SupportStatus:      ProviderSupportStatusUnsupported,
			DisabledReasonCode: DisabledReasonProviderTemporarilyUnsupported,
			BinaryNames:        []string{"gemini"},
			AdapterCommand:     []string{"gemini", "--acp"},
			AuthMarkerPaths:    []string{"~/.gemini/settings.json", "~/.gemini/oauth_creds.json"},
			Install: InstallerSpec{
				Kind:           InstallerKindShellCommand,
				DisplayCommand: "npm install -g @google/gemini-cli",
				ShellCommand:   "npm install -g @google/gemini-cli",
			},
			LoginArgs: []string{"auth", "login"},
		},
		agentprovider.Hermes: {
			Provider:           agentprovider.Hermes,
			SupportStatus:      ProviderSupportStatusUnsupported,
			DisabledReasonCode: DisabledReasonProviderTemporarilyUnsupported,
			BinaryNames:        []string{"hermes"},
			AdapterCommand:     []string{"hermes", "acp"},
			AuthMarkerPaths:    []string{"~/.hermes/auth.json", "~/.config/hermes/auth.json"},
			LoginArgs:          []string{"login"},
		},
		agentprovider.OpenClaw: {
			Provider:           agentprovider.OpenClaw,
			SupportStatus:      ProviderSupportStatusUnsupported,
			DisabledReasonCode: DisabledReasonProviderTemporarilyUnsupported,
			BinaryNames:        []string{"openclaw"},
			AdapterCommand:     []string{"openclaw", "acp", "-v"},
			AuthMarkerPaths:    []string{"~/.openclaw/auth.json", "~/.config/openclaw/auth.json"},
			Install: InstallerSpec{
				Kind:           InstallerKindShellCommand,
				DisplayCommand: "npm install -g openclaw",
				ShellCommand:   "npm install -g openclaw",
			},
			LoginArgs: []string{"login"},
		},
	}
	providers := agentprovider.All()
	specs := make([]ProviderSpec, 0, len(providers))
	for _, provider := range providers {
		spec, ok := specsByProvider[provider]
		if ok {
			specs = append(specs, spec)
		}
	}
	return Registry{Specs: specs}
}

// codexCLIInstallerSpec installs the first-party Codex npm package globally,
// including its platform-specific optional dependency binary.
func codexCLIInstallerSpec() InstallerSpec {
	return InstallerSpec{
		Kind:           InstallerKindCodexCLILatest,
		DisplayCommand: "npm install -g @openai/codex --include=optional",
		CodexCLI:       &CodexCLILatestInstallerSpec{},
	}
}
