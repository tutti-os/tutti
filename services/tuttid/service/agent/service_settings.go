package agent

import (
	"context"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func (s *Service) clampReasoningEffortForModel(
	ctx context.Context,
	provider string,
	model string,
	selected string,
) string {
	selected = strings.TrimSpace(selected)
	// Only Codex-derived providers currently treat model-advertised reasoning
	// values as authoritative. OpenCode uses its model catalog for discovery but
	// keeps the static reasoning vocabulary.
	if !composerProviderUsesModelReasoningCatalog(provider) {
		return normalizeReasoningEffortForProvider(provider, selected)
	}
	if strings.TrimSpace(model) == "" && s.ModelCatalog != nil {
		model = composerDefaultModel(ctx, provider, "", s.ModelCatalog)
	}
	catalogOptions, ok := composerModelOptionsFromCatalog(ctx, s.ModelCatalog, provider, "", model)
	if !ok || !catalogOptions.Selection.ReasoningEffortsAdvertised {
		return normalizeReasoningEffortForProvider(provider, selected)
	}
	return resolveAdvertisedReasoningEffort(
		provider,
		selected,
		catalogOptions.Selection.DefaultReasoningEffort,
		catalogOptions.Selection.ReasoningEfforts,
	)
}

func (s *Service) clampReasoningEffortPointerForModel(
	ctx context.Context,
	provider string,
	model string,
	selected *string,
) *string {
	if selected == nil {
		return nil
	}
	clamped := s.clampReasoningEffortForModel(ctx, provider, model, *selected)
	return &clamped
}

func (s *Service) clampReasoningEffortPointerForLaunch(
	ctx context.Context,
	provider string,
	providerTargetRef map[string]any,
	model string,
	selected *string,
) *string {
	if selected == nil {
		return nil
	}
	if providerTargetRefKind(providerTargetRef) == "agent_extension" {
		value := strings.TrimSpace(*selected)
		return &value
	}
	return s.clampReasoningEffortPointerForModel(ctx, provider, model, selected)
}

func (s *Service) clampPersistedSessionReasoningEffortForResume(
	ctx context.Context,
	session PersistedSession,
) PersistedSession {
	if strings.TrimSpace(session.Settings.ReasoningEffort) == "" {
		return session
	}
	if agentprovider.Normalize(session.Provider) == "" {
		session.Settings.ReasoningEffort = strings.TrimSpace(session.Settings.ReasoningEffort)
		return session
	}
	session.Settings.ReasoningEffort = s.clampReasoningEffortForModel(
		ctx,
		session.Provider,
		session.Settings.Model,
		session.Settings.ReasoningEffort,
	)
	return session
}

func (s *Service) UpdateSettings(ctx context.Context, workspaceID string, agentSessionID string, settings ComposerSettingsPatch) (Session, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return Session{}, ErrInvalidArgument
	}
	release, err := s.acquireSessionSettingsLock(ctx, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, err
	}
	defer release()
	ref := agenthost.SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID}
	ctx = withServiceHeldSessionLock(ctx, s, ref)
	observed, err := s.ApplicationHost().GetSession(ctx, ref)
	if err != nil {
		return Session{}, err
	}
	provider := strings.TrimSpace(observed.Canonical.Provider)
	runtimeContext := observed.Canonical.InternalRuntimeContext
	currentSettings := composerSettingsFromPayload(observed.Canonical.Settings)
	if observed.Live {
		provider = strings.TrimSpace(observed.Session.Provider)
		runtimeContext = observed.Session.RuntimeContext
		if observed.Session.Settings != nil {
			currentSettings = *observed.Session.Settings
		}
	}
	if settings.Model != nil {
		if err := s.validateSessionModelAgainstRuntimeSnapshot(
			ctx,
			strings.TrimSpace(workspaceID),
			runtimeContext,
			strings.TrimSpace(*settings.Model),
		); err != nil {
			return Session{}, err
		}
	}
	selectedModel := currentSettings.Model
	selectedReasoningEffort := currentSettings.ReasoningEffort
	if settings.Model != nil {
		selectedModel = strings.TrimSpace(*settings.Model)
	}
	if settings.ReasoningEffort != nil {
		selectedReasoningEffort = *settings.ReasoningEffort
	}
	// A live Codex-derived runtime owns the freshest per-model reasoning
	// catalog. Let its adapter resolve active updates; the daemon-side catalog
	// remains the authority for pre-session create/resume only.
	if (settings.Model != nil || settings.ReasoningEffort != nil) &&
		!composerProviderUsesModelReasoningCatalog(provider) {
		clampedReasoningEffort := s.clampReasoningEffortForModel(
			ctx,
			provider,
			selectedModel,
			selectedReasoningEffort,
		)
		if settings.ReasoningEffort != nil || clampedReasoningEffort != selectedReasoningEffort {
			settings.ReasoningEffort = &clampedReasoningEffort
		}
	}
	if settings.Speed != nil {
		normalizedSpeed := normalizeSpeedForProvider(provider, *settings.Speed)
		settings.Speed = &normalizedSpeed
	}
	result, err := s.ApplicationHost().UpdateSettings(ctx, agenthost.UpdateSettingsInput{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID, Settings: settings,
	})
	if err != nil {
		return Session{}, err
	}
	return s.projectHostSessionResult(ctx, result.Canonical, result.Session, result.Live, result.Live)
}
