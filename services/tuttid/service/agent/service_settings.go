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
	result, err := s.ApplicationHost().UpdateSettings(ctx, agenthost.UpdateSettingsInput{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID, Settings: settings,
	})
	if err != nil {
		return Session{}, err
	}
	return s.projectHostSessionResult(ctx, result.Canonical, result.Session, result.Live, result.Live)
}
