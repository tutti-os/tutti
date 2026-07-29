package agent

import (
	"context"
	"path/filepath"
	"strings"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func (s *Service) extensionComposerProfileForLaunch(ctx context.Context, providerTargetRef map[string]any) (ExtensionComposerProfile, error) {
	if providerTargetRefKind(providerTargetRef) != "agent_extension" {
		return ExtensionComposerProfile{}, nil
	}
	installationID := strings.TrimSpace(stringFromAny(providerTargetRef["extensionInstallationId"]))
	if s.ExtensionComposerProfiles == nil || installationID == "" {
		return ExtensionComposerProfile{}, nil
	}
	return s.ExtensionComposerProfiles.ResolveExtensionComposerProfile(ctx, installationID)
}

// resolveExtensionSkillRoots returns the workspace-scope skill root paths an
// agent extension declared in its composer profile. Native tutti skills are
// materialized into these roots so acp: extension agents load the same
// tutti-handoff/tutti-cli content as built-in providers. Returns nil for
// non-extension providers or profiles without skills.
func (s *Service) resolveExtensionSkillRoots(ctx context.Context, providerTargetRef map[string]any) []string {
	profile, err := s.extensionComposerProfileForLaunch(ctx, providerTargetRef)
	if err != nil || profile.Skills == nil {
		return nil
	}
	roots := make([]string, 0, len(profile.Skills.Roots))
	for _, root := range profile.Skills.Roots {
		if strings.TrimSpace(root.Scope) != "workspace" {
			continue
		}
		if path, ok := safeExtensionSkillRootPath(root.Path); ok {
			roots = append(roots, path)
		}
	}
	return roots
}

func safeExtensionSkillRootPath(path string) (string, bool) {
	cleaned := filepath.Clean(strings.TrimSpace(path))
	if cleaned == "." || filepath.IsAbs(cleaned) || cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", false
	}
	return cleaned, true
}

func (s *Service) resolveExtensionRuntimePrep(ctx context.Context, providerTargetRef map[string]any) *runtimeprep.ExtensionRuntimePrep {
	profile, err := s.extensionComposerProfileForLaunch(ctx, providerTargetRef)
	if err != nil {
		return nil
	}
	return profile.RuntimePrep
}

func composerProviderCapabilities(provider string, computerUseAvailable bool) []string {
	if !composerProfileKnown(provider) {
		return nil
	}
	capabilities := append([]string(nil), composerProfileFor(provider).Capabilities...)
	if runtimeprep.BrowserUseDefaultEnabled() {
		capabilities = append(capabilities, "browserUse")
	}
	if computerUseAvailable && runtimeprep.ComputerUseDefaultEnabled() {
		capabilities = append(capabilities, "computerUse")
	}
	return capabilities
}

func (s *Service) computerUseAvailable() bool {
	return s != nil && s.ComputerUseAvailable != nil && s.ComputerUseAvailable()
}

func composerProviderSupportsPlanMode(provider string) bool {
	return composerProviderSupportsCapability(provider, "planMode")
}

func (s *Service) clampComposerBrowserUseForLaunch(ctx context.Context, provider string, providerTargetRef map[string]any, browserUse *bool) bool {
	if composerProviderSupportsBrowserUse(agentprovider.Normalize(provider)) {
		return browserUse == nil || *browserUse
	}
	profile, err := s.extensionComposerProfileForLaunch(ctx, providerTargetRef)
	if err != nil || !extensionProfileDeclaresCapability(profile, "browserUse") {
		return false
	}
	if !runtimeprep.BrowserUseDefaultEnabled() {
		return false
	}
	return browserUse == nil || *browserUse
}

func clampComposerBrowserUseForProvider(provider string, browserUse *bool) bool {
	if !composerProviderSupportsBrowserUse(agentprovider.Normalize(provider)) {
		return false
	}
	return browserUse == nil || *browserUse
}

func composerProviderSupportsBrowserUse(provider string) bool {
	return composerProviderSupportsCapability(provider, "browserUse")
}

func (s *Service) clampComposerComputerUseForLaunch(ctx context.Context, provider string, providerTargetRef map[string]any, computerUse *bool) bool {
	if composerProviderSupportsComputerUse(agentprovider.Normalize(provider)) {
		return computerUse == nil || *computerUse
	}
	profile, err := s.extensionComposerProfileForLaunch(ctx, providerTargetRef)
	if err != nil || !extensionProfileDeclaresCapability(profile, "computerUse") {
		return false
	}
	if !s.computerUseAvailable() || !runtimeprep.ComputerUseDefaultEnabled() {
		return false
	}
	return computerUse == nil || *computerUse
}

func composerProviderSupportsComputerUse(provider string) bool {
	return composerProviderSupportsCapability(provider, "computerUse")
}

func composerProviderSupportsCapability(provider string, capability string) bool {
	if !composerProfileKnown(provider) {
		return false
	}
	if capability == "browserUse" {
		return runtimeprep.BrowserUseDefaultEnabled()
	}
	if capability == "computerUse" {
		return runtimeprep.ComputerUseDefaultEnabled()
	}
	for _, advertised := range composerProfileFor(provider).Capabilities {
		if advertised == capability {
			return true
		}
	}
	return false
}

func extensionProfileDeclaresCapability(profile ExtensionComposerProfile, capability string) bool {
	capability = strings.TrimSpace(capability)
	if capability == "" {
		return false
	}
	for _, declared := range profile.Capabilities {
		if strings.TrimSpace(declared) == capability {
			return true
		}
	}
	return false
}
