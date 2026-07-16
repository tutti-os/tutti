package agent

import (
	"context"
	"strings"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
)

type sessionStateReporter interface {
	ReportSessionState(
		context.Context,
		agentsessionstore.ReportSessionStateInput,
	) (agentsessionstore.ReportSessionStateReply, error)
}

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
		model = composerDefaultModel(ctx, provider, s.ModelCatalog)
	}
	catalogOptions, ok := composerModelOptionsFromCatalog(ctx, s.ModelCatalog, provider, model)
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
	ensured, err := s.ensureRuntimeSessionResult(ctx, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, err
	}
	if settings.Model != nil {
		if err := s.validateSessionModelAgainstRuntimeSnapshot(
			ctx,
			strings.TrimSpace(workspaceID),
			ensured.Session.RuntimeContext,
			strings.TrimSpace(*settings.Model),
		); err != nil {
			return Session{}, err
		}
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
	if err := s.persistUpdatedRuntimeSettings(ctx, workspaceID, agentSessionID); err != nil {
		return Session{}, err
	}
	session, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, err
	}
	return session, nil
}

func (s *Service) persistUpdatedRuntimeSettings(ctx context.Context, workspaceID string, agentSessionID string) error {
	reporter, ok := s.SessionReader.(sessionStateReporter)
	if !ok {
		return nil
	}
	session, ok := s.controller().Session(workspaceID, agentSessionID)
	if !ok || session.Settings == nil {
		return nil
	}
	_, err := reporter.ReportSessionState(ctx, agentsessionstore.ReportSessionStateInput{
		WorkspaceID:    strings.TrimSpace(workspaceID),
		AgentSessionID: strings.TrimSpace(agentSessionID),
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			AgentTargetID:     strings.TrimSpace(session.AgentTargetID),
			Provider:          strings.TrimSpace(session.Provider),
			ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
			Model:             strings.TrimSpace(session.Settings.Model),
			Settings:          composerSettingsToStatePayload(*session.Settings),
			CWD:               strings.TrimSpace(session.Cwd),
			Title:             strings.TrimSpace(session.Title),
			OccurredAtUnixMS:  time.Now().UnixMilli(),
		},
	})
	return err
}
