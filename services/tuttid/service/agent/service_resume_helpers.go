package agent

import (
	"context"
	"encoding/json"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/events"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func (s *Service) ensureRuntimeSession(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (RuntimeSession, error) {
	ensured, err := s.ensureRuntimeSessionResult(ctx, workspaceID, agentSessionID)
	return ensured.Session, err
}

type ensuredRuntimeSession struct {
	Session             RuntimeSession
	StaleTurnReconciled bool
}

func (s *Service) ensureRuntimeSessionResult(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (ensuredRuntimeSession, error) {
	if session, ok := s.controller().Session(workspaceID, agentSessionID); ok {
		staleTurnReconciled := false
		shouldReconcile, err := s.shouldReconcilePersistedStaleTurn(session, workspaceID, agentSessionID)
		if err != nil {
			return ensuredRuntimeSession{}, err
		}
		if shouldReconcile {
			staleTurnReconciled, err = s.reconcilePersistedStaleTurn(ctx, workspaceID, agentSessionID)
			if err != nil {
				return ensuredRuntimeSession{}, err
			}
		}
		return ensuredRuntimeSession{Session: session, StaleTurnReconciled: staleTurnReconciled}, nil
	}
	if s.SessionReader == nil {
		return ensuredRuntimeSession{}, ErrSessionNotFound
	}
	persisted, ok := s.SessionReader.GetSession(workspaceID, agentSessionID)
	if !ok || strings.TrimSpace(persisted.Provider) == "" {
		return ensuredRuntimeSession{}, ErrSessionNotFound
	}
	// Imported sessions used to be rejected here, which is what surfaced the
	// "can't resume on this device, start a new conversation" dead-end. They now
	// resume in place (same-device) or, when the provider session can't be
	// restored locally, get a fresh provider session created on demand. The
	// recreate is opt-in (RecreateIfMissing) so it stays scoped to imported
	// conversations and doesn't change restore-error handling for normal ones.
	imported := strings.TrimSpace(persisted.Origin) == WorkspaceAgentSessionOriginImported
	prepared, err := s.prepareRuntimeForResume(ctx, persisted)
	if err != nil {
		return ensuredRuntimeSession{}, err
	}
	session, err := s.controller().Resume(ctx, RuntimeResumeInput{
		WorkspaceID:       strings.TrimSpace(persisted.WorkspaceID),
		AgentSessionID:    strings.TrimSpace(persisted.ID),
		Provider:          strings.TrimSpace(persisted.Provider),
		ProviderSessionID: strings.TrimSpace(persisted.ProviderSessionID),
		Cwd:               strings.TrimSpace(prepared.Cwd),
		Env:               append([]string(nil), prepared.Env...),
		Title:             strings.TrimSpace(persisted.Title),
		Status:            strings.TrimSpace(persisted.Status),
		Settings:          cloneComposerSettings(persisted.Settings),
		CreatedAtUnixMS:   persisted.CreatedAtUnixMS,
		UpdatedAtUnixMS:   persisted.UpdatedAtUnixMS,
		Visible:           boolPointer(visibleFromRuntimeContext(persisted.RuntimeContext, true)),
		RuntimeContext:    clonePayload(persisted.RuntimeContext),
		RecreateIfMissing: imported,
	})
	if err != nil {
		return ensuredRuntimeSession{}, normalizeRuntimeError(err)
	}
	staleTurnReconciled, err := s.reconcileStaleTurnOnResume(ctx, persisted)
	if err != nil {
		return ensuredRuntimeSession{}, err
	}
	return ensuredRuntimeSession{Session: session, StaleTurnReconciled: staleTurnReconciled}, nil
}

func (s *Service) reconcilePersistedStaleTurn(ctx context.Context, workspaceID string, agentSessionID string) (bool, error) {
	if s.SessionReader == nil {
		return false, nil
	}
	persisted, ok := s.SessionReader.GetSession(workspaceID, agentSessionID)
	if !ok {
		return false, nil
	}
	return s.reconcileStaleTurnOnResume(ctx, persisted)
}

func (s *Service) shouldReconcilePersistedStaleTurn(session RuntimeSession, workspaceID string, agentSessionID string) (bool, error) {
	if !runtimeSessionHasLiveTurn(session) {
		return true, nil
	}
	return s.shouldReconcileGhostOpenApprovals(session, workspaceID, agentSessionID)
}

func (s *Service) shouldReconcileGhostOpenApprovals(session RuntimeSession, workspaceID string, agentSessionID string) (bool, error) {
	if runtimeSessionHasLivePendingInteractive(session) {
		return false, nil
	}
	if runtimeSessionHasLiveWaitingInteractiveTurn(session) {
		return false, nil
	}
	if s == nil || s.MessageReader == nil {
		return false, nil
	}
	page, ok := s.MessageReader.ListSessionMessages(agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    strings.TrimSpace(workspaceID),
		AgentSessionID: strings.TrimSpace(agentSessionID),
		Limit:          100,
		Order:          agentactivitybiz.MessageOrderDesc,
	})
	if !ok {
		return false, nil
	}
	return hasStaleResumeGhostApproval(page.Messages), nil
}

func (s *Service) reconcileStaleTurnOnResume(ctx context.Context, session PersistedSession) (bool, error) {
	shouldReconcile, err := s.shouldReconcileStaleTurn(session)
	if err != nil {
		return false, err
	}
	if !shouldReconcile {
		return false, nil
	}
	reconciler, ok := s.SessionReader.(StaleTurnResumeReconciler)
	if !ok || reconciler == nil {
		return false, nil
	}
	if err := reconciler.ReconcileStaleTurnOnResume(ctx, session); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Service) shouldReconcileStaleTurn(session PersistedSession) (bool, error) {
	if strings.TrimSpace(session.Origin) == WorkspaceAgentSessionOriginImported {
		return false, nil
	}
	if isResumeStaleTurnStatus(session.Status) || isResumeStaleTurnStatus(session.CurrentPhase) {
		return true, nil
	}
	if s == nil || s.MessageReader == nil {
		return false, nil
	}
	page, ok := s.MessageReader.ListSessionMessages(agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    strings.TrimSpace(session.WorkspaceID),
		AgentSessionID: strings.TrimSpace(session.ID),
		Limit:          100,
		Order:          agentactivitybiz.MessageOrderDesc,
	})
	if !ok {
		return false, nil
	}
	return hasStaleResumeOpenToolCall(page.Messages), nil
}

func hasStaleResumeOpenToolCall(messages []SessionMessage) bool {
	for _, message := range messages {
		if isStaleResumeOpenToolCall(message) {
			return true
		}
	}
	return false
}

func hasStaleResumeGhostApproval(messages []SessionMessage) bool {
	for _, message := range messages {
		if isStaleResumeGhostApproval(message) {
			return true
		}
	}
	return false
}

func isStaleResumeGhostApproval(message SessionMessage) bool {
	if strings.TrimSpace(message.Kind) != "tool_call" {
		return false
	}
	status := strings.TrimSpace(message.Status)
	if status == "" {
		status = payloadString(message.Payload, "status")
	}
	switch status {
	case "waiting_approval", "waiting_input", "awaiting_approval":
		return true
	default:
		return false
	}
}

func isResumeStaleTurnStatus(status string) bool {
	switch strings.TrimSpace(status) {
	case "running", "streaming", "submitted", "working", "waiting":
		return true
	default:
		return false
	}
}

func isRuntimeActiveTurnStatus(status string) bool {
	switch strings.TrimSpace(status) {
	case "working":
		return true
	default:
		return false
	}
}

func runtimeSessionHasLiveTurn(session RuntimeSession) bool {
	if isRuntimeActiveTurnStatus(session.Status) {
		return true
	}
	if runtimeSessionHasLivePendingInteractive(session) {
		return true
	}
	if runtimeSessionHasLiveBackgroundAgent(session) {
		return true
	}
	if session.TurnLifecycle == nil {
		return false
	}
	activeTurnID := ""
	if session.TurnLifecycle.ActiveTurnID != nil {
		activeTurnID = strings.TrimSpace(*session.TurnLifecycle.ActiveTurnID)
	}
	return activeTurnID != "" && isRuntimeActiveTurnPhase(session.TurnLifecycle.Phase)
}

func runtimeSessionHasLivePendingInteractive(session RuntimeSession) bool {
	if session.PendingInteractive == nil {
		return false
	}
	if strings.TrimSpace(session.PendingInteractive.RequestID) == "" {
		return false
	}
	switch strings.TrimSpace(session.PendingInteractive.Status) {
	case "completed", "failed", "canceled", "cancelled", "stopped":
		return false
	default:
		return true
	}
}

func runtimeSessionHasLiveWaitingInteractiveTurn(session RuntimeSession) bool {
	if session.TurnLifecycle == nil {
		return false
	}
	activeTurnID := ""
	if session.TurnLifecycle.ActiveTurnID != nil {
		activeTurnID = strings.TrimSpace(*session.TurnLifecycle.ActiveTurnID)
	}
	if activeTurnID == "" {
		return false
	}
	switch strings.TrimSpace(session.TurnLifecycle.Phase) {
	case "waiting_approval", "waiting_input", "awaiting_approval":
		return true
	default:
		return false
	}
}

func runtimeSessionHasLiveBackgroundAgent(session RuntimeSession) bool {
	backgroundAgents, ok := session.RuntimeContext["backgroundAgents"].(map[string]any)
	if !ok {
		return false
	}
	if runtimeContextPositiveCount(backgroundAgents["count"]) {
		return true
	}
	items, _ := backgroundAgents["items"].([]any)
	for _, item := range items {
		agent, ok := item.(map[string]any)
		if !ok {
			continue
		}
		status := strings.TrimSpace(payloadString(agent, "status"))
		if status == "" {
			status = "running"
		}
		switch status {
		case "completed", "failed", "canceled", "cancelled", "stopped":
			continue
		default:
			return true
		}
	}
	return false
}

func runtimeContextPositiveCount(value any) bool {
	switch typed := value.(type) {
	case int:
		return typed > 0
	case int64:
		return typed > 0
	case float64:
		return typed > 0
	case json.Number:
		count, err := typed.Int64()
		return err == nil && count > 0
	default:
		return false
	}
}

func isRuntimeActiveTurnPhase(phase string) bool {
	// Delegates to the canonical predicate in activityshared; do not add
	// phase tokens here.
	return activityshared.TurnLifecyclePhaseIsLive(phase)
}

func (s *Service) prepareRuntimeForResume(ctx context.Context, session PersistedSession) (preparedRuntime, error) {
	input := createSessionInputFromPersisted(session)
	return s.prepareRuntime(ctx, strings.TrimSpace(session.WorkspaceID), strings.TrimSpace(session.Cwd), input)
}
