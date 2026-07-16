package agent

import (
	"context"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/titletext"
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
	submitClaim, claimPending, err := s.prepareSubmitClaim(ctx, workspaceID, agentSessionID, input.Metadata)
	if err != nil {
		return SendInputResult{}, err
	}
	if submitClaim.ClientSubmitID != "" && !claimPending {
		if submitClaim.Status == "accepted" {
			return s.acceptedSubmitResult(ctx, workspaceID, agentSessionID, submitClaim)
		}
		return SendInputResult{}, ErrSubmitDeliveryUnknown
	}
	defer func() {
		if claimPending {
			s.abandonSubmitClaim(workspaceID, agentSessionID, submitClaim.ClientSubmitID)
		}
	}()
	logAgentSubmitTrace("service.send.content_normalized", workspaceID, agentSessionID, input.Metadata, map[string]any{
		"content_block_count": len(normalizedContent),
	})
	nodeStartedAt = time.Now()
	runtimeSession, err := s.ensureRuntimeSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		s.reportAgentServiceNodeFailure(ctx, agentSessionID, "message_send", "runtime_session_ready", "", nodeStartedAt, err)
		return SendInputResult{}, err
	}
	provider := strings.TrimSpace(runtimeSession.Provider)
	s.reportAgentServiceNodeSuccess(ctx, agentSessionID, "message_send", "runtime_session_ready", provider, nodeStartedAt)
	logAgentSubmitTrace("service.send.runtime_session_ready", workspaceID, agentSessionID, input.Metadata, nil)
	nodeStartedAt = time.Now()
	if err := s.validatePromptContentForExec(ctx, workspaceID, agentSessionID, normalizedContent); err != nil {
		s.reportAgentServiceNodeFailure(ctx, agentSessionID, "message_send", "prompt_validated", provider, nodeStartedAt, err)
		return SendInputResult{}, err
	}
	s.reportAgentServiceNodeSuccess(ctx, agentSessionID, "message_send", "prompt_validated", provider, nodeStartedAt)
	logAgentSubmitTrace("service.send.prompt_validated", workspaceID, agentSessionID, input.Metadata, nil)
	nodeStartedAt = time.Now()
	content, preparedDisplayPrompt, err := s.prepareNormalizedPromptContentForExec(workspaceID, agentSessionID, normalizedContent, "")
	if err != nil {
		s.reportAgentServiceNodeFailure(ctx, agentSessionID, "message_send", "prompt_prepared", provider, nodeStartedAt, err)
		return SendInputResult{}, err
	}
	s.reportAgentServiceNodeSuccess(ctx, agentSessionID, "message_send", "prompt_prepared", provider, nodeStartedAt)
	logAgentSubmitTrace("service.send.prompt_prepared", workspaceID, agentSessionID, input.Metadata, map[string]any{
		"content_block_count": len(content),
	})
	displayPrompt := strings.TrimSpace(input.DisplayPrompt)
	initialTitle := ""
	if !input.Guidance && !runtimeSession.InitialTitleEstablished {
		visiblePrompt := firstNonEmptyString(displayPrompt, normalizedPromptText, preparedDisplayPrompt)
		initialTitle = titletext.DeriveInitial(runtimeSession.Title, visiblePrompt)
	}
	logAgentSubmitTrace("service.send.exec_requested", workspaceID, agentSessionID, input.Metadata, nil)
	nodeStartedAt = time.Now()
	// Exec may have to resume an idle-released Claude process inside the runtime
	// controller. Hold the same startup slot used by Create/Resume while Exec
	// performs that ensure-live step.
	releaseStartup, err := s.awaitClaudeStartupSlot(ctx, provider)
	if err != nil {
		s.reportAgentServiceNodeFailure(ctx, agentSessionID, "message_send", "runtime_exec", provider, nodeStartedAt, err)
		return SendInputResult{}, err
	}
	result, err := func() (RuntimeExecResult, error) {
		defer releaseStartup()
		return s.controller().Exec(ctx, RuntimeExecInput{
			WorkspaceID:      workspaceID,
			AgentSessionID:   agentSessionID,
			Content:          content,
			DisplayPrompt:    displayPrompt,
			InitialTitle:     initialTitle,
			InitialTitleBase: runtimeSession.Title,
			Guidance:         input.Guidance,
			Metadata:         cloneMetadata(input.Metadata),
		})
	}()
	if err != nil {
		normalizedErr := normalizeRuntimeError(err)
		s.reportAgentServiceNodeFailure(ctx, agentSessionID, "message_send", "runtime_exec", provider, nodeStartedAt, normalizedErr)
		return SendInputResult{}, normalizedErr
	}
	turnID := strings.TrimSpace(result.TurnID)
	if turnID == "" {
		return SendInputResult{}, ErrSubmitDeliveryUnknown
	}
	if submitClaim.ClientSubmitID != "" {
		claimPending = false
		if err := s.acceptSubmitClaim(workspaceID, agentSessionID, submitClaim.ClientSubmitID, turnID); err != nil {
			return SendInputResult{}, err
		}
	}
	s.reportAgentServiceNodeSuccess(ctx, agentSessionID, "message_send", "runtime_exec", provider, nodeStartedAt)
	logAgentSubmitTrace("service.send.exec_resolved", workspaceID, agentSessionID, input.Metadata, map[string]any{
		"turn_id":        result.TurnID,
		"session_status": result.SessionStatus,
		"turn_phase":     result.TurnLifecycle.Phase,
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
		TurnLifecycle:      result.TurnLifecycle,
		SubmitAvailability: result.SubmitAvailability,
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

func (s *Service) validatePromptContentForExec(ctx context.Context, workspaceID, agentSessionID string, content []PromptContentBlock) error {
	if err := s.controller().ValidatePromptContent(ctx, RuntimeExecInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Content:        content,
	}); err != nil {
		return normalizeRuntimeError(err)
	}
	return nil
}

func (s *Service) prepareNormalizedPromptContentForExec(workspaceID, agentSessionID string, content []PromptContentBlock, displayPrompt string) ([]PromptContentBlock, string, error) {
	store := s.PromptAttachmentStore
	persisted, err := store.PersistRequestContent(workspaceID, agentSessionID, content)
	if err != nil {
		return nil, "", err
	}
	hydrated, err := store.HydrateRuntimeContent(workspaceID, agentSessionID, persisted)
	if err != nil {
		return nil, "", err
	}
	if strings.TrimSpace(displayPrompt) == "" {
		displayPrompt = promptImageOnlyDisplayText(persisted)
	}
	return hydrated, displayPrompt, nil
}
