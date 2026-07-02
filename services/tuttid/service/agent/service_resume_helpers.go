package agent

import (
	"context"
	"encoding/json"
	"strings"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

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
	switch strings.TrimSpace(phase) {
	case "submitted", "working", "running", "streaming",
		"waiting", "waiting_approval", "waiting_input", "awaiting_approval":
		return true
	default:
		return false
	}
}

func (s *Service) prepareRuntimeForResume(ctx context.Context, session PersistedSession) (preparedRuntime, error) {
	input := createSessionInputFromPersisted(session)
	return s.prepareRuntime(ctx, strings.TrimSpace(session.WorkspaceID), strings.TrimSpace(session.Cwd), input)
}
