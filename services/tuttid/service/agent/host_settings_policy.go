package agent

import (
	"context"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

type serviceHostSettingsPolicy struct {
	catalog AgentModelCatalog
}

func (p serviceHostSettingsPolicy) NormalizePersistedSettings(
	ctx context.Context,
	session storesqlite.Session,
	settings agenthost.ComposerSettings,
	patch agenthost.ComposerSettingsPatch,
) agenthost.ComposerSettings {
	settings = normalizeObservedComposerSettingsForProvider(session.Provider, settings)
	if patch.Model != nil || patch.ReasoningEffort != nil {
		settings.ReasoningEffort = clampReasoningEffortForModelWithCatalog(
			ctx,
			p.catalog,
			session.Provider,
			session.Cwd,
			settings.Model,
			settings.ReasoningEffort,
		)
	}
	return settings
}

func (p serviceHostSettingsPolicy) NormalizeRuntimeSettingsPatch(
	ctx context.Context,
	session agenthost.ProviderRuntimeSession,
	settings agenthost.ComposerSettingsPatch,
) agenthost.ComposerSettingsPatch {
	provider := strings.TrimSpace(session.Provider)
	selectedModel := ""
	selectedReasoningEffort := ""
	if session.Settings != nil {
		selectedModel = session.Settings.Model
		selectedReasoningEffort = session.Settings.ReasoningEffort
	}
	if settings.Model != nil {
		selectedModel = strings.TrimSpace(*settings.Model)
	}
	if settings.ReasoningEffort != nil {
		selectedReasoningEffort = *settings.ReasoningEffort
	}
	// A live Codex-derived runtime owns the freshest per-model reasoning
	// catalog. Other providers keep tuttid's established catalog policy.
	if (settings.Model != nil || settings.ReasoningEffort != nil) &&
		!composerProviderUsesModelReasoningCatalog(provider) {
		clamped := strings.TrimSpace(selectedReasoningEffort)
		if agentprovider.Normalize(provider) != "" {
			clamped = clampReasoningEffortForModelWithCatalog(
				ctx,
				p.catalog,
				provider,
				session.Cwd,
				selectedModel,
				selectedReasoningEffort,
			)
		}
		if settings.ReasoningEffort != nil || clamped != selectedReasoningEffort {
			settings.ReasoningEffort = &clamped
		}
	}
	if settings.Speed != nil {
		normalized := strings.TrimSpace(*settings.Speed)
		if agentprovider.Normalize(provider) != "" {
			normalized = normalizeSpeedForProvider(provider, normalized)
		}
		settings.Speed = &normalized
	}
	return settings
}
