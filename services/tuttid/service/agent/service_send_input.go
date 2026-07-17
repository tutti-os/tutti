package agent

import (
	"context"
	"strings"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func (s *Service) SendInput(ctx context.Context, workspaceID string, agentSessionID string, input SendInput) (SendInputResult, error) {
	logAgentSubmitTrace("service.send.entered", workspaceID, agentSessionID, input.Metadata, nil)
	nodeStartedAt := time.Now()
	normalizedContent, normalizedPromptText, err := normalizePromptContent(input.Content)
	if err != nil {
		s.reportAgentServiceNodeFailure(ctx, agentSessionID, "message_send", "content_normalized", "", nodeStartedAt, err)
		return SendInputResult{}, err
	}
	s.reportAgentServiceNodeSuccess(ctx, agentSessionID, "message_send", "content_normalized", "", nodeStartedAt)
	visiblePrompt := firstNonEmptyString(strings.TrimSpace(input.DisplayPrompt), normalizedPromptText)
	if goal, ok := parseTypedGoalControl(normalizedContent, visiblePrompt, input.Guidance); ok {
		result, err := s.goalControl(ctx, workspaceID, agentSessionID, goal.Action, goal.Objective, input.Metadata)
		if err != nil {
			return SendInputResult{}, err
		}
		return SendInputResult{Session: result.Session, Kind: "goalControl", GoalControl: &result}, nil
	}
	logAgentSubmitTrace("service.send.content_normalized", workspaceID, agentSessionID, input.Metadata, map[string]any{
		"content_block_count": len(normalizedContent),
	})
	hostResult, err := s.applicationHost(serviceHostPreparation{service: s}).SendInput(ctx,
		agenthost.SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID},
		agenthost.SendInput{Content: normalizedContent, DisplayPrompt: input.DisplayPrompt, Metadata: input.Metadata, Guidance: input.Guidance},
	)
	if err != nil {
		return SendInputResult{}, err
	}
	turnID := hostResult.TurnID
	provider := strings.TrimSpace(hostResult.Session.Provider)
	logAgentSubmitTrace("service.send.runtime_session_ready", workspaceID, agentSessionID, input.Metadata, nil)
	logAgentSubmitTrace("service.send.prompt_validated", workspaceID, agentSessionID, input.Metadata, nil)
	logAgentSubmitTrace("service.send.prompt_prepared", workspaceID, agentSessionID, input.Metadata, map[string]any{"content_block_count": len(normalizedContent)})
	logAgentSubmitTrace("service.send.exec_resolved", workspaceID, agentSessionID, input.Metadata, map[string]any{
		"turn_id": turnID, "session_status": hostResult.Session.Status, "turn_phase": hostResult.TurnLifecycle.Phase,
	})
	nodeStartedAt = time.Now()
	session, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		s.reportAgentServiceNodeFailure(ctx, agentSessionID, "message_send", "session_refreshed", provider, nodeStartedAt, err)
		return SendInputResult{}, err
	}
	turn, err := s.exactSubmittedTurn(ctx, workspaceID, agentSessionID, turnID, session)
	if err != nil {
		s.reportAgentServiceNodeFailure(ctx, agentSessionID, "message_send", "turn_refreshed", provider, nodeStartedAt, err)
		return SendInputResult{}, err
	}
	s.reportAgentServiceNodeSuccess(ctx, agentSessionID, "message_send", "session_refreshed", provider, nodeStartedAt)
	return SendInputResult{
		Session:            session,
		Kind:               "turn",
		TurnID:             turnID,
		Turn:               turn,
		TurnLifecycle:      hostResult.TurnLifecycle,
		SubmitAvailability: hostResult.SubmitAvailability,
	}, nil
}

func (s *Service) exactSubmittedTurn(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turnID string,
	session Session,
) (*agentactivitybiz.Turn, error) {
	if s.TurnStore != nil {
		turn, ok, err := s.TurnStore.GetTurn(ctx, workspaceID, agentSessionID, turnID)
		if err != nil {
			return nil, err
		}
		if !ok || strings.TrimSpace(turn.TurnID) != turnID {
			return nil, ErrSubmitDeliveryUnknown
		}
		return &turn, nil
	}
	// Standalone service tests may omit the durable store. Prefer an exact
	// entity already attached to the session, but never synthesize one.
	for _, turn := range []*agentactivitybiz.Turn{session.ActiveTurn, session.LatestTurn} {
		if turn != nil && strings.TrimSpace(turn.TurnID) == turnID {
			return turn, nil
		}
	}
	return nil, nil
}
