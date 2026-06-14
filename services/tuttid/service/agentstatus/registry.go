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

type ProviderSpec struct {
	Provider           string
	SupportStatus      ProviderSupportStatus
	DisabledReasonCode string
	BinaryNames        []string
	AdapterBinaryNames []string
	AdapterCommand     []string
	AuthStatusCommand  []string
	AuthMarkerPaths    []string
	Install            InstallerSpec
	AdapterInstall     InstallerSpec
	LoginArgs          []string
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
			Provider:           agentprovider.ClaudeCode,
			BinaryNames:        []string{"claude"},
			AdapterBinaryNames: []string{"claude-agent-acp"},
			AdapterCommand:     []string{"claude-agent-acp"},
			AuthStatusCommand:  []string{"auth", "status"},
			Install: InstallerSpec{
				Kind:           InstallerKindOfficialScript,
				DisplayCommand: "curl -fsSL https://claude.ai/install.sh | bash",
				ScriptURL:      "https://claude.ai/install.sh",
				ScriptShell:    "bash",
			},
			AdapterInstall: InstallerSpec{
				Kind:           InstallerKindShellCommand,
				DisplayCommand: "npm install -g @agentclientprotocol/claude-agent-acp@0.42.0",
				ShellCommand:   "npm install -g @agentclientprotocol/claude-agent-acp@0.42.0",
				// Auto-apply the fast-mode bridge patch after a successful install.
				PostInstall: InstallerPostStepPatchClaudeAgentACP,
			},
			LoginArgs: []string{"auth", "login"},
		},
		agentprovider.Codex: {
			Provider:           agentprovider.Codex,
			BinaryNames:        []string{"codex"},
			AdapterBinaryNames: []string{"codex-acp"},
			AdapterCommand:     []string{"codex-acp"},
			AuthMarkerPaths:    []string{"~/.codex/auth.json"},
			Install: InstallerSpec{
				Kind:           InstallerKindOfficialScript,
				DisplayCommand: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
				ScriptURL:      "https://chatgpt.com/codex/install.sh",
				ScriptShell:    "sh",
			},
			AdapterInstall: codexACPInstallerSpec(),
			LoginArgs:      []string{"--login"},
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

func codexACPInstallerSpec() InstallerSpec {
	return InstallerSpec{
		Kind:           InstallerKindGitHubReleaseBinary,
		DisplayCommand: "Install codex-acp v0.15.0 from GitHub releases",
		ReleaseBinary: &ReleaseBinaryInstallerSpec{
			BinaryName: "codex-acp",
			Version:    "v0.15.0",
			Assets: map[string]ReleaseBinaryAsset{
				releaseBinaryPlatformKey("darwin", "arm64"): {
					URL:    "https://github.com/zed-industries/codex-acp/releases/download/v0.15.0/codex-acp-0.15.0-aarch64-apple-darwin.tar.gz",
					SHA256: "sha256:356b1faf3aa0feb15781d5c8a86c46e1ab623a2bf4908b251acb35df9af2fb79",
				},
				releaseBinaryPlatformKey("darwin", "amd64"): {
					URL:    "https://github.com/zed-industries/codex-acp/releases/download/v0.15.0/codex-acp-0.15.0-x86_64-apple-darwin.tar.gz",
					SHA256: "sha256:ffbd10e9a5f19fc4a22469b2dfeea6f8860286b50d2c00c906db06d7a03bb145",
				},
				releaseBinaryPlatformKey("linux", "arm64"): {
					URL:    "https://github.com/zed-industries/codex-acp/releases/download/v0.15.0/codex-acp-0.15.0-aarch64-unknown-linux-gnu.tar.gz",
					SHA256: "sha256:154bbb0e9d8549c6bc89b7c8d75fb745a3baace18a755bfd69cbc8c177458ba0",
				},
				releaseBinaryPlatformKey("linux", "amd64"): {
					URL:    "https://github.com/zed-industries/codex-acp/releases/download/v0.15.0/codex-acp-0.15.0-x86_64-unknown-linux-gnu.tar.gz",
					SHA256: "sha256:71dcf628a618a82f3b7f3b7383182cdf33dd41c1cbecaf7e3c833f36e44155d1",
				},
			},
		},
	}
}
