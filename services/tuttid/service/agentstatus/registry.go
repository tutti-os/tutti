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
		agentprovider.Cursor: {
			Provider: agentprovider.Cursor,
			// Cursor's official installer has shipped the CLI as `cursor-agent`
			// and, more recently, as `agent`; probe both names.
			BinaryNames:       []string{"cursor-agent", "agent"},
			AdapterCommand:    []string{"cursor-agent", "acp"},
			AuthStatusCommand: []string{"status"},
			AuthMarkerPaths:   []string{"~/.cursor/cli-config.json"},
			Install: InstallerSpec{
				Kind:           InstallerKindOfficialScript,
				DisplayCommand: "curl https://cursor.com/install -fsS | bash",
				ScriptURL:      "https://cursor.com/install",
				ScriptShell:    "bash",
			},
			LoginArgs: []string{"login"},
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
		agentprovider.Antigravity: {
			Provider:           agentprovider.Antigravity,
			BinaryNames:        []string{"agy"},
			AdapterBinaryNames: []string{"agy-acp"},
			AdapterCommand:     []string{"agy-acp"},
			// agy login is an interactive TUI (`agy`, no subcommand); there is
			// no non-interactive auth-status command, so rely on the marker.
			AuthMarkerPaths: []string{"~/.gemini/antigravity-cli/jetski_state.pbtxt"},
			Install: InstallerSpec{
				Kind:           InstallerKindOfficialScript,
				DisplayCommand: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
				ScriptURL:      "https://antigravity.google/cli/install.sh",
				ScriptShell:    "bash",
			},
			AdapterInstall: InstallerSpec{
				Kind:           InstallerKindGitHubReleaseBinary,
				DisplayCommand: "download agy-acp from tutti-os/antigravity-acp@v1.0.0-tutti.1",
				ReleaseBinary: &ReleaseBinaryInstallerSpec{
					BinaryName: "agy-acp",
					Version:    "v1.0.0-tutti.1",
					// InstallDir left empty → installer default location.
					Assets: map[string]ReleaseBinaryAsset{
						"darwin-arm64": {
							URL:    "https://github.com/tutti-os/antigravity-acp/releases/download/v1.0.0-tutti.1/agy-acp-darwin-arm64",
							SHA256: "7936bd5fd662e6514755a8e8b19aba88b2f01b94d082d93bbc238cb4bdc9c2e8",
						},
						"darwin-amd64": {
							URL:    "https://github.com/tutti-os/antigravity-acp/releases/download/v1.0.0-tutti.1/agy-acp-darwin-x64",
							SHA256: "4265454974b67142061539270fb6401229034098590762b2b0c30be68ff5ebdc",
						},
						"linux-arm64": {
							URL:    "https://github.com/tutti-os/antigravity-acp/releases/download/v1.0.0-tutti.1/agy-acp-linux-arm64",
							SHA256: "7eec158411e1939c6ad6298b52ee2691425b666a448ee12c07ccf59b55067652",
						},
						"linux-amd64": {
							URL:    "https://github.com/tutti-os/antigravity-acp/releases/download/v1.0.0-tutti.1/agy-acp-linux-x64",
							SHA256: "ed900c0ebb72ff505ec5c64296b534472927140514aacad607af645320e6a3d1",
						},
						"windows-arm64": {
							URL:    "https://github.com/tutti-os/antigravity-acp/releases/download/v1.0.0-tutti.1/agy-acp-windows-arm64.exe",
							SHA256: "c55280bb358e4b9ea18091e955341ffc43057ef2babfdba7ebe1c31b9bb2f6d1",
						},
						"windows-amd64": {
							URL:    "https://github.com/tutti-os/antigravity-acp/releases/download/v1.0.0-tutti.1/agy-acp-windows-x64.exe",
							SHA256: "f58efda098e9df50a15a9efe3c965f954e0f508838e0665ba9471ee29efe3503",
						},
					},
				},
			},
			LoginArgs: nil,
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
