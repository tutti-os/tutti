package agentprovider

import (
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

const (
	ClaudeCode = providerregistry.ClaudeCodeProviderID
	Codex      = providerregistry.CodexProviderID
	Cursor     = "cursor"
	Hermes     = "hermes"
	Nexight    = "nexight"
	OpenClaw   = "openclaw"
	OpenCode   = "opencode"
	TuttiAgent = "tutti-agent"
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
	for _, provider := range []string{TuttiAgent, Cursor, Nexight, Hermes, OpenClaw, OpenCode} {
		appendProvider(provider)
	}
	return providers
}

func Normalize(provider string) string {
	if providerID, ok := providerregistry.ResolveProviderID(provider); ok {
		return providerID
	}
	switch strings.TrimSpace(strings.ToLower(provider)) {
	case TuttiAgent:
		return TuttiAgent
	case "cursor-agent", "cursor-cli", Cursor:
		return Cursor
	case "hermes-agent", Hermes:
		return Hermes
	case "tutti", Nexight:
		return Nexight
	case "open-claw", OpenClaw:
		return OpenClaw
	case "open-code", "opencode-ai", OpenCode:
		return OpenCode
	default:
		return ""
	}
}

func IsSupported(provider string) bool {
	return Normalize(provider) != ""
}
