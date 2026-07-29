// Package titletext preserves the historical daemon import path. Canonical
// title derivation is owned by the Agent Host application core.
package titletext

import agenthost "github.com/tutti-os/tutti/packages/agent/host"

const MaxSessionTitleRunes = agenthost.MaxSessionTitleRunes

func Normalize(value string) string {
	return agenthost.NormalizeTitle(value)
}

func DeriveInitial(currentTitle, visiblePrompt string) string {
	return agenthost.DeriveInitialTitle(currentTitle, visiblePrompt)
}

func IsLegacyPlaceholder(value, provider string, targetAliases ...string) bool {
	return agenthost.IsLegacyTitlePlaceholder(value, provider, targetAliases...)
}
