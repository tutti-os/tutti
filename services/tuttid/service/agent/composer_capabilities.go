package agent

import (
	"context"
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
		if path := strings.TrimSpace(root.Path); path != "" {
			roots = append(roots, path)
		}
	}
	return roots
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

func clampComposerBrowserUseForProvider(provider string, browserUse *bool) bool {
	if !composerProviderSupportsBrowserUse(agentprovider.Normalize(provider)) {
		return false
	}
	return browserUse == nil || *browserUse
}

func composerProviderSupportsBrowserUse(provider string) bool {
	return composerProviderSupportsCapability(provider, "browserUse")
}

func clampComposerComputerUseForProvider(provider string, computerUse *bool) bool {
	if !composerProviderSupportsComputerUse(agentprovider.Normalize(provider)) {
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
