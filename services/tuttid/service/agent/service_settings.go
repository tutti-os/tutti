package agent

import (
	"context"
	"strings"
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
	if !ok || !catalogOptions.ReasoningEffortsAdvertised {
		return normalizeReasoningEffortForProvider(provider, selected)
	}
	return resolveAdvertisedReasoningEffort(
		provider,
		selected,
		catalogOptions.DefaultReasoningEffort,
		catalogOptions.ReasoningEfforts,
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

func (s *Service) clampPersistedSessionReasoningEffortForResume(
	ctx context.Context,
	session PersistedSession,
) PersistedSession {
	if strings.TrimSpace(session.Settings.ReasoningEffort) == "" {
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
	if _, live := s.controller().Session(workspaceID, agentSessionID); !live {
		return s.updatePersistedSessionSettings(ctx, workspaceID, agentSessionID, settings)
	}
	ensured, err := s.ensureRuntimeSessionResultLocked(ctx, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, err
	}
	provider := strings.TrimSpace(ensured.Session.Provider)
	selectedModel := ""
	selectedReasoningEffort := ""
	if ensured.Session.Settings != nil {
		selectedModel = ensured.Session.Settings.Model
		selectedReasoningEffort = ensured.Session.Settings.ReasoningEffort
	}
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
	if err := s.controller().UpdateSettings(ctx, RuntimeUpdateSettingsInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Settings:       settings,
	}); err != nil {
		return Session{}, normalizeRuntimeError(err)
	}
	session, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, err
	}
	return session, nil
}

func (s *Service) updatePersistedSessionSettings(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	patch ComposerSettingsPatch,
) (Session, error) {
	if s.SessionReader == nil {
		return Session{}, ErrSessionNotFound
	}
	persisted, ok := s.SessionReader.GetSession(workspaceID, agentSessionID)
	if !ok {
		return Session{}, ErrSessionNotFound
	}
	updater, ok := s.SessionReader.(SessionSettingsUpdater)
	if !ok {
		return Session{}, ErrSessionNotFound
	}
	settings := applyComposerSettingsPatch(persisted.Settings, patch)
	settings = normalizeObservedComposerSettingsForProvider(persisted.Provider, settings)
	if patch.Model != nil || patch.ReasoningEffort != nil {
		settings.ReasoningEffort = s.clampReasoningEffortForModel(
			ctx,
			persisted.Provider,
			settings.Model,
			settings.ReasoningEffort,
		)
	}
	updated, ok, err := updater.UpdateSessionSettings(
		ctx,
		workspaceID,
		agentSessionID,
		settings,
	)
	if err != nil {
		return Session{}, err
	}
	if !ok {
		return Session{}, ErrSessionNotFound
	}
	return s.withProtocolV2TurnState(ctx, workspaceID, sessionFromPersisted(
		updated,
		persistedSessionCanResume(s.controller(), updated),
	))
}

func applyComposerSettingsPatch(settings ComposerSettings, patch ComposerSettingsPatch) ComposerSettings {
	if patch.Model != nil {
		settings.Model = strings.TrimSpace(*patch.Model)
	}
	if patch.PermissionModeID != nil {
		settings.PermissionModeID = strings.TrimSpace(*patch.PermissionModeID)
	}
	if patch.PlanMode != nil {
		settings.PlanMode = *patch.PlanMode
	}
	if patch.BrowserUse != nil {
		value := *patch.BrowserUse
		settings.BrowserUse = &value
	}
	if patch.ComputerUse != nil {
		value := *patch.ComputerUse
		settings.ComputerUse = &value
	}
	if patch.ReasoningEffort != nil {
		settings.ReasoningEffort = strings.TrimSpace(*patch.ReasoningEffort)
	}
	if patch.Speed != nil {
		settings.Speed = strings.TrimSpace(*patch.Speed)
	}
	return settings
}
