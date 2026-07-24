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
	AuthOutputParserKind         providerregistry.AuthOutputParserKind
	AuthMarkerParserKind         providerregistry.AuthMarkerParserKind
	AuthCommandRunnerKind        providerregistry.AuthCommandRunnerKind
	StaticSpecResolverKind       providerregistry.StaticSpecResolverKind
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
	Update                       ProviderUpdateSpec
	AdapterInstall               InstallerSpec
	LoginArgs                    []string
	LoginActionKind              ActionKind
}

type ProviderUpdateStrategy string

const ProviderUpdateStrategyManagedNPM ProviderUpdateStrategy = "managed_npm"

type ProviderUpdateSpec struct {
	Capability        UpdateCapability
	Source            UpdateSource
	Strategy          ProviderUpdateStrategy
	PackageName       string
	BinaryName        string
	IncludeOptional   bool
	UnsupportedReason string
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
	specsByProvider := make(map[string]ProviderSpec, len(providerregistry.Migrated()))
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
		Kind:                   descriptor.Status.Kind,
		AuthOutputParserKind:   descriptor.Status.AuthOutputParserKind,
		AuthMarkerParserKind:   descriptor.Status.AuthMarkerParserKind,
		AuthCommandRunnerKind:  descriptor.Status.AuthCommandRunnerKind,
		StaticSpecResolverKind: descriptor.Status.StaticSpecResolverKind,
		Provider:               descriptor.Identity.ID,
		MinVersion:             descriptor.Status.MinVersion,
		NPMRegistryPackage:     descriptor.Status.NPMRegistryPackage,
		BinaryNames:            append([]string(nil), descriptor.Status.BinaryNames...),
		AdapterBinaryNames:     adapterBinaryNames,
		AdapterCommand:         append([]string(nil), descriptor.Runtime.Command...),
		AuthStatusCommand:      append([]string(nil), descriptor.Status.AuthStatusCommand...),
		AuthStatusCommandTimeout: time.Duration(
			descriptor.Status.AuthStatusCommandTimeoutSeconds,
		) * time.Second,
		AuthMarkerPaths: append([]string(nil), descriptor.Status.AuthMarkerPaths...),
		Install:         install,
		Update: ProviderUpdateSpec{
			Capability:        UpdateCapability(descriptor.Status.Update.Capability),
			Source:            UpdateSource(descriptor.Status.Update.Source),
			Strategy:          ProviderUpdateStrategy(descriptor.Status.Update.Strategy),
			PackageName:       descriptor.Status.Update.PackageName,
			BinaryName:        descriptor.Status.Update.BinaryName,
			IncludeOptional:   descriptor.Status.Update.IncludeOptional,
			UnsupportedReason: descriptor.Status.Update.UnsupportedReason,
		},
		LoginArgs:          append([]string(nil), descriptor.Status.LoginArgs...),
		LoginActionKind:    ActionKind(descriptor.Status.LoginActionKind),
		SupportStatus:      ProviderSupportStatus(descriptor.Status.SupportStatus),
		DisabledReasonCode: descriptor.Status.DisabledReasonCode,
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

func isOpenCodeStatusSpec(spec ProviderSpec) bool {
	kind := spec.Kind
	if kind == "" {
		if status, ok := migratedProviderStatus(spec.Provider); ok {
			kind = status.Kind
		}
	}
	return kind == providerregistry.StatusKindOpenCodeCLI
}

func migratedProviderStatus(provider string) (providerregistry.StatusDescriptor, bool) {
	descriptor, ok := providerregistry.Find(provider)
	if !ok {
		return providerregistry.StatusDescriptor{}, false
	}
	return descriptor.Status, true
}

func installerSpecFromProviderDescriptor(descriptor providerregistry.InstallerDescriptor) (InstallerSpec, error) {
	failureReasonMarkers := cloneInstallerFailureReasonMarkers(descriptor.FailureReasonMarkers)
	switch descriptor.Kind {
	case providerregistry.InstallerKindCodexCLILatest:
		return InstallerSpec{
			Kind:                 InstallerKindCodexCLILatest,
			DisplayCommand:       descriptor.DisplayCommand,
			FailureReasonMarkers: failureReasonMarkers,
			CodexCLI: &CodexCLILatestInstallerSpec{
				PackageName:     descriptor.PackageName,
				BinaryName:      descriptor.BinaryName,
				IncludeOptional: descriptor.IncludeOptional,
			},
		}, nil
	case providerregistry.InstallerKindOfficialScript:
		return InstallerSpec{
			Kind:                 InstallerKindOfficialScript,
			DisplayCommand:       descriptor.DisplayCommand,
			FailureReasonMarkers: failureReasonMarkers,
			ScriptURL:            descriptor.ScriptURL,
			ScriptShell:          descriptor.ScriptShell,
		}, nil
	case providerregistry.InstallerKindManagedNPM:
		return InstallerSpec{
			Kind:                 InstallerKindManagedNPMPackage,
			DisplayCommand:       descriptor.DisplayCommand,
			FailureReasonMarkers: failureReasonMarkers,
			ManagedNPM: &ManagedNPMPackageInstallerSpec{
				PackageName: descriptor.PackageName, PackageVersion: descriptor.RecommendedVersion, BinaryName: descriptor.BinaryName, IncludeOptional: descriptor.IncludeOptional,
			},
		}, nil
	case providerregistry.InstallerKindShellCommand:
		return InstallerSpec{Kind: InstallerKindShellCommand, DisplayCommand: descriptor.DisplayCommand, ShellCommand: descriptor.ShellCommand, FailureReasonMarkers: failureReasonMarkers}, nil
	case "":
		return InstallerSpec{}, nil
	default:
		return InstallerSpec{}, fmt.Errorf("unsupported installer kind %q", descriptor.Kind)
	}
}

func cloneInstallerFailureReasonMarkers(values map[string][]string) map[string][]string {
	if values == nil {
		return nil
	}
	result := make(map[string][]string, len(values))
	for reasonCode, markers := range values {
		result[reasonCode] = append([]string(nil), markers...)
	}
	return result
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
