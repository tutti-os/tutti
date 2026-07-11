package agentstatus

import (
	"fmt"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

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
	Kind                         providerregistry.StatusKind
	Provider                     string
	MinVersion                   string
	NPMRegistryPackage           string
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
	AuthStatusCommandTimeout     time.Duration
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
		agentprovider.TuttiAgent: {
			Provider:    agentprovider.TuttiAgent,
			BinaryNames: []string{"tutti-agent"},
			// Tutti Agent is a Codex CLI fork and exposes the same built-in
			// app-server; probe that command directly because bare `tutti-agent`
			// is an interactive TUI and fails headless.
			AdapterBinaryNames: []string{"tutti-agent"},
			AdapterCommand:     []string{"tutti-agent", "app-server"},
			AuthStatusCommand:  []string{"login", "status"},
			AuthMarkerPaths:    []string{"~/.tutti-agent/auth.json"},
			Install:            tuttiAgentInstallerSpec(),
			LoginArgs:          []string{"login"},
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
		agentprovider.OpenCode: {
			Provider:          agentprovider.OpenCode,
			BinaryNames:       []string{"opencode"},
			AdapterCommand:    []string{"opencode", "acp"},
			AuthStatusCommand: []string{"auth", "list"},
			AuthMarkerPaths:   []string{"~/.local/share/opencode/auth.json"},
			Install: InstallerSpec{
				Kind:           InstallerKindOfficialScript,
				DisplayCommand: "curl -fsSL https://opencode.ai/install | bash",
				ScriptURL:      "https://opencode.ai/install",
				ScriptShell:    "bash",
			},
			LoginArgs: []string{"auth", "login"},
		},
	}
	for _, descriptor := range providerregistry.Migrated() {
		spec, err := providerSpecFromDescriptor(descriptor)
		if err != nil {
			panic(fmt.Sprintf("invalid migrated provider status descriptor: %v", err))
		}
		spec.Provider = descriptor.Identity.ID
		specsByProvider[descriptor.Identity.ID] = spec
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

func providerSpecFromDescriptor(descriptor providerregistry.ProviderDescriptor) (ProviderSpec, error) {
	if err := providerregistry.Validate(descriptor); err != nil {
		return ProviderSpec{}, err
	}
	install, err := installerSpecFromProviderDescriptor(descriptor.Status.Install)
	if err != nil {
		return ProviderSpec{}, fmt.Errorf("provider %q installer: %w", descriptor.Identity.ID, err)
	}
	adapterBinaryNames := append([]string(nil), descriptor.Status.AdapterBinaryNames...)
	if len(adapterBinaryNames) == 0 && len(descriptor.Runtime.Command) > 0 {
		adapterBinaryNames = []string{descriptor.Runtime.Command[0]}
	}
	return ProviderSpec{
		Kind:               descriptor.Status.Kind,
		Provider:           descriptor.Identity.ID,
		MinVersion:         descriptor.Status.MinVersion,
		NPMRegistryPackage: descriptor.Status.NPMRegistryPackage,
		BinaryNames:        append([]string(nil), descriptor.Status.BinaryNames...),
		AdapterBinaryNames: adapterBinaryNames,
		AdapterCommand:     append([]string(nil), descriptor.Runtime.Command...),
		AuthStatusCommand:  append([]string(nil), descriptor.Status.AuthStatusCommand...),
		AuthStatusCommandTimeout: time.Duration(
			descriptor.Status.AuthStatusCommandTimeoutSeconds,
		) * time.Second,
		AuthMarkerPaths: append([]string(nil), descriptor.Status.AuthMarkerPaths...),
		Install:         install,
		LoginArgs:       append([]string(nil), descriptor.Status.LoginArgs...),
	}, nil
}

func isCodexStatusSpec(spec ProviderSpec) bool {
	kind := spec.Kind
	if kind == "" {
		if status, ok := migratedProviderStatus(spec.Provider); ok {
			kind = status.Kind
		}
	}
	return kind == providerregistry.StatusKindCodexCLI
}

func isClaudeStatusSpec(spec ProviderSpec) bool {
	kind := spec.Kind
	if kind == "" {
		if status, ok := migratedProviderStatus(spec.Provider); ok {
			kind = status.Kind
		}
	}
	return kind == providerregistry.StatusKindClaudeCLI
}

func migratedProviderStatus(provider string) (providerregistry.StatusDescriptor, bool) {
	descriptor, ok := providerregistry.Find(provider)
	if !ok {
		return providerregistry.StatusDescriptor{}, false
	}
	return descriptor.Status, true
}

func installerSpecFromProviderDescriptor(descriptor providerregistry.InstallerDescriptor) (InstallerSpec, error) {
	switch descriptor.Kind {
	case providerregistry.InstallerKindCodexCLILatest:
		return InstallerSpec{
			Kind:           InstallerKindCodexCLILatest,
			DisplayCommand: descriptor.DisplayCommand,
			CodexCLI: &CodexCLILatestInstallerSpec{
				PackageName:     descriptor.PackageName,
				BinaryName:      descriptor.BinaryName,
				IncludeOptional: descriptor.IncludeOptional,
			},
		}, nil
	case providerregistry.InstallerKindOfficialScript:
		return InstallerSpec{
			Kind:           InstallerKindOfficialScript,
			DisplayCommand: descriptor.DisplayCommand,
			ScriptURL:      descriptor.ScriptURL,
			ScriptShell:    descriptor.ScriptShell,
		}, nil
	default:
		return InstallerSpec{}, fmt.Errorf("unsupported installer kind %q", descriptor.Kind)
	}
}

// codexCLIInstallerSpec remains as a focused test/injection helper. Its values
// come from the migrated provider descriptor; it is not a second registration.
func codexCLIInstallerSpec() InstallerSpec {
	descriptor, ok := providerregistry.Find(providerregistry.CodexProviderID)
	if !ok {
		panic("codex provider descriptor is missing")
	}
	install, err := installerSpecFromProviderDescriptor(descriptor.Status.Install)
	if err != nil {
		panic(fmt.Sprintf("invalid codex installer descriptor: %v", err))
	}
	return install
}

func tuttiAgentInstallerSpec() InstallerSpec {
	return InstallerSpec{
		Kind:           InstallerKindManagedNPMPackage,
		DisplayCommand: "npm install -g @tutti-os/tutti-agent --include=optional",
		ManagedNPM: &ManagedNPMPackageInstallerSpec{
			PackageName:     "@tutti-os/tutti-agent",
			BinaryName:      "tutti-agent",
			IncludeOptional: true,
		},
	}
}
