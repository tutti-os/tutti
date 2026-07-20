package agentprovider

import (
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

const (
	ClaudeCode = providerregistry.ClaudeCodeProviderID
	Codex      = providerregistry.CodexProviderID
	Cursor     = providerregistry.CursorProviderID
	Hermes     = providerregistry.HermesProviderID
	Nexight    = providerregistry.NexightProviderID
	OpenClaw   = providerregistry.OpenClawProviderID
	OpenCode   = providerregistry.OpenCodeProviderID
	TuttiAgent = providerregistry.TuttiAgentProviderID
)

func All() []string {
	providers := make([]string, 0, 8)
	seen := make(map[string]struct{}, 8)
	appendProvider := func(provider string) {
		if _, ok := seen[provider]; ok {
			return
		}
		seen[provider] = struct{}{}
		providers = append(providers, provider)
	}
	for _, descriptor := range providerregistry.Migrated() {
		appendProvider(descriptor.Identity.ID)
	}
	return providers
}

func Normalize(provider string) string {
	if providerID, ok := providerregistry.ResolveProviderID(provider); ok {
		return providerID
	}
	return ""
}

// NormalizeOpen preserves registered-provider alias handling while accepting
// extension-owned runtime provider identities such as acp:gemini. Open
// identities are metadata, not authority: callers must still resolve an Agent
// Target before they can start a runtime.
func NormalizeOpen(provider string) string {
	if normalized, ok := providerregistry.NormalizeOpenProviderID(provider); ok {
		return normalized
	}
	return ""
}

func IsSupported(provider string) bool {
	return Normalize(provider) != ""
}
