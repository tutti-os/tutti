package agentprovider

import (
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

const (
	ClaudeCode = providerregistry.ClaudeCodeProviderID
	Codex      = providerregistry.CodexProviderID
	Cursor     = providerregistry.CursorProviderID
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

// ModelPlanProtocol resolves the model API protocol declared by the provider's
// runtime strategy. The returned value is transport-neutral so model-plan
// ownership remains in the tuttid modelplan business package.
func ModelPlanProtocol(provider string) (string, bool) {
	protocol, ok := providerregistry.ResolveModelPlanProtocol(provider)
	return string(protocol), ok
}

// ModelPlanModelAddressingProviderPrefixed reports whether the provider's
// runtime strategy addresses bound plan models with the injected provider
// namespace ("<provider>/<model>") in composer and settings values.
func ModelPlanModelAddressingProviderPrefixed(provider string) bool {
	addressing, ok := providerregistry.ResolveModelPlanModelAddressing(provider)
	return ok && addressing == providerregistry.ModelPlanModelAddressingProviderPrefixed
}

// ModelPlanUsesResponsesToChatGateway reports whether the provider runtime
// strategy requires the daemon's local Responses-to-Chat endpoint adapter.
func ModelPlanUsesResponsesToChatGateway(provider string) bool {
	adapter, ok := providerregistry.ResolveModelPlanEndpointAdapter(provider)
	return ok && adapter == providerregistry.ModelPlanEndpointAdapterResponsesToChatGateway
}

func IsSupported(provider string) bool {
	return Normalize(provider) != ""
}
