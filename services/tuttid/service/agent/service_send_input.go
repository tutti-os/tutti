package agent

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	tuttimodeactivationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
)

func (s *Service) SendInput(ctx context.Context, workspaceID string, agentSessionID string, input SendInput) (SendInputResult, error) {
	if input.Guidance && strings.TrimSpace(input.TurnID) == "" {
		// The service is the cross-process boundary. Guidance must carry the
		// canonical Turn captured by the caller. A durable claim can recover a
		// retry only when that target is retained; it must not make a new request
		// without an explicit target look valid.
		return SendInputResult{}, ErrActiveTurnTargetRequired
	}
	input.ClientSubmitID = strings.TrimSpace(input.ClientSubmitID)
	if input.ClientSubmitID == "" {
		legacyClientSubmitID, _ := input.Metadata["clientSubmitId"].(string)
		input.ClientSubmitID = strings.TrimSpace(legacyClientSubmitID)
	}
	if input.ClientSubmitID == "" {
		// 同 CreateWithResult：调用方未提供提交幂等标识时生成一个，满足下游
		// submit provenance 对 ClientSubmitID 非空的要求。
		input.ClientSubmitID = uuid.NewString()
	}
	logAgentSubmitTrace("service.send.entered", workspaceID, agentSessionID, input.ClientSubmitID, input.Metadata, nil)
	nodeStartedAt := time.Now()
	normalizedContent, _, err := normalizePromptContent(input.Content)
	if err != nil {
		s.reportAgentServiceNodeFailure(ctx, agentSessionID, "message_send", "content_normalized", "", nodeStartedAt, err)
		return SendInputResult{}, err
	}
	if err := s.validatePromptConnectors(ctx, normalizedContent); err != nil {
		s.reportAgentServiceNodeFailure(ctx, agentSessionID, "message_send", "connectors_validated", "", nodeStartedAt, err)
		return SendInputResult{}, err
	}
	s.reportAgentServiceNodeSuccess(ctx, agentSessionID, "message_send", "content_normalized", "", nodeStartedAt)
	logAgentSubmitTrace("service.send.content_normalized", workspaceID, agentSessionID, input.ClientSubmitID, input.Metadata, map[string]any{
		"content_block_count": len(normalizedContent),
	})
	hostInput := agenthost.SendInput{
		CapabilityRefs: append([]CapabilityReference(nil), input.CapabilityRefs...),
		Content:        normalizedContent, DisplayPrompt: input.DisplayPrompt,
		Metadata: cloneMetadata(input.Metadata), ClientSubmitID: input.ClientSubmitID, Guidance: input.Guidance,
		TurnID: input.TurnID,
	}
	connectorRoutingUpdate, connectorRoutingChanged := "", false
	if !input.Guidance {
		connectorRoutingUpdate, connectorRoutingChanged = s.pendingConnectorRoutingUpdate(workspaceID, agentSessionID)
		if connectorRoutingChanged {
			hostInput.ConnectorRoutingUpdate = &connectorRoutingUpdate
		}
	}
	var preparedTurnID string
	var preparedSnapshot tuttimodeactivationbiz.TurnSnapshot
	if _, typedGoal := agenthost.ParseTypedGoalControl(normalizedContent, input.Guidance); !typedGoal {
		runtimeSession, _ := s.controller().Session(workspaceID, agentSessionID)
		existingCanonicalTurnID, claimErr := s.existingSubmitCanonicalTurnID(ctx, workspaceID, agentSessionID, input.ClientSubmitID, input.Metadata)
		if claimErr != nil {
			return SendInputResult{}, claimErr
		}
		if existingCanonicalTurnID != "" {
			// A durable claim already owns this submit: reuse its canonical
			// turn so a retry reconciles instead of redispatching.
			if input.Guidance && strings.TrimSpace(input.TurnID) != existingCanonicalTurnID {
				return SendInputResult{}, ErrActiveTurnTargetMismatch
			}
			preparedTurnID = existingCanonicalTurnID
			hostInput.TurnID = existingCanonicalTurnID
		} else {
			preparedTurnID, preparedSnapshot, err = s.prepareTuttiModeExec(ctx, workspaceID, agentSessionID, input.Guidance, runtimeSession, input.TurnID)
			if err != nil {
				return SendInputResult{}, err
			}
			hostInput.TurnID = preparedTurnID
			hostInput.TuttiModeSnapshot = runtimeTuttiModeTurnSnapshot(preparedSnapshot)
		}
	}
	hostResult, err := s.ApplicationHost().SendInput(ctx,
		agenthost.SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID},
		hostInput,
	)
	if err != nil {
		if preparedTurnID != "" {
			abandonErr := s.abandonPreparedTuttiModeExec(context.WithoutCancel(ctx), workspaceID, agentSessionID, preparedTurnID, preparedSnapshot, input.Guidance)
			if abandonErr != nil {
				return SendInputResult{}, deliveryUnknownError(abandonErr)
			}
		}
		return SendInputResult{}, err
	}
	if hostResult.Kind == "goalControl" && hostResult.GoalControl != nil {
		session, getErr := s.Get(ctx, workspaceID, agentSessionID)
		if getErr != nil {
			return SendInputResult{}, getErr
		}
		goal := GoalControlSessionResult{
			Session: session, Goal: clonePayload(hostResult.GoalControl.Goal),
			OperationID: hostResult.GoalControl.OperationID, GoalState: hostResult.GoalControl.GoalState,
		}
		return SendInputResult{Session: session, Kind: "goalControl", GoalControl: &goal}, nil
	}
	if preparedTurnID != "" && strings.TrimSpace(hostResult.TurnID) != preparedTurnID {
		return SendInputResult{}, ErrSubmitDeliveryUnknown
	}
	if connectorRoutingChanged {
		// The provider observed the routing update with this turn; later turns
		// only need another update after the index diverges again. Ambiguous
		// delivery outcomes above skip this commit and re-inject next turn.
		s.connectorRoutingBaselines.commit(workspaceID, agentSessionID, connectorRoutingUpdate)
	}
	turnID := hostResult.TurnID
	provider := strings.TrimSpace(hostResult.Session.Provider)
	logAgentSubmitTrace("service.send.runtime_session_ready", workspaceID, agentSessionID, input.ClientSubmitID, input.Metadata, nil)
	logAgentSubmitTrace("service.send.prompt_validated", workspaceID, agentSessionID, input.ClientSubmitID, input.Metadata, nil)
	logAgentSubmitTrace("service.send.prompt_prepared", workspaceID, agentSessionID, input.ClientSubmitID, input.Metadata, map[string]any{"content_block_count": len(normalizedContent)})
	logAgentSubmitTrace("service.send.exec_resolved", workspaceID, agentSessionID, input.ClientSubmitID, input.Metadata, map[string]any{
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
	s.observeTuttiModeSourceUserTurn(
		ctx, workspaceID, agentSessionID,
		input.ClientSubmitID, input.Metadata, turn,
	)
	return SendInputResult{
		Session:            session,
		Kind:               "turn",
		TurnID:             turnID,
		Turn:               turn,
		TurnLifecycle:      hostResult.TurnLifecycle,
		SubmitAvailability: hostResult.SubmitAvailability,
	}, nil
}

func (s *Service) observeTuttiModeSourceUserTurn(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	clientSubmitID string,
	metadata map[string]any,
	turn *agentactivitybiz.Turn,
) {
	if s == nil || s.TuttiModeSourceActivity == nil || turn == nil ||
		strings.TrimSpace(turn.TurnID) == "" {
		return
	}
	internalWake, _ := metadata["tuttiModeExecutionWake"].(bool)
	if internalWake {
		return
	}
	message, ok := s.canonicalSubmittedUserMessage(
		workspaceID, agentSessionID, turn.TurnID, clientSubmitID, metadata,
	)
	if !ok || message.OccurredAtUnixMS <= 0 {
		return
	}
	if err := s.TuttiModeSourceActivity.ObserveTuttiModeSourceActivity(
		ctx,
		TuttiModeSourceActivity{
			WorkspaceID:      strings.TrimSpace(workspaceID),
			SessionID:        strings.TrimSpace(agentSessionID),
			Kind:             "user_turn",
			ActivityID:       strings.TrimSpace(message.MessageID),
			OccurredAtUnixMS: message.OccurredAtUnixMS,
		},
	); err != nil {
		slog.WarnContext(
			ctx,
			"observe Tutti mode source user Turn failed",
			"event", "tutti_mode_execution.source_user_turn_observation_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"error", err,
		)
	}
}

func (s *Service) canonicalSubmittedUserMessage(
	workspaceID string,
	agentSessionID string,
	turnID string,
	clientSubmitID string,
	metadata map[string]any,
) (SessionMessage, bool) {
	if s == nil || s.MessageReader == nil {
		return SessionMessage{}, false
	}
	clientSubmitID = strings.TrimSpace(clientSubmitID)
	if clientSubmitID == "" {
		legacyClientSubmitID, _ := metadata["clientSubmitId"].(string)
		clientSubmitID = strings.TrimSpace(legacyClientSubmitID)
	}
	page, ok := s.MessageReader.ListSessionMessages(
		agentactivitybiz.ListSessionMessagesInput{
			WorkspaceID:    strings.TrimSpace(workspaceID),
			AgentSessionID: strings.TrimSpace(agentSessionID),
			TurnID:         strings.TrimSpace(turnID),
			Limit:          defaultListMessagesLimit,
			Order:          agentactivitybiz.MessageOrderDesc,
		},
	)
	if !ok {
		return SessionMessage{}, false
	}
	for _, message := range page.Messages {
		if strings.TrimSpace(message.TurnID) != strings.TrimSpace(turnID) ||
			strings.TrimSpace(message.Role) != "user" ||
			message.OccurredAtUnixMS <= 0 {
			continue
		}
		if clientSubmitID != "" {
			messageClientSubmitID, _ := message.Payload["clientSubmitId"].(string)
			if strings.TrimSpace(messageClientSubmitID) != clientSubmitID {
				continue
			}
		}
		return message, true
	}
	return SessionMessage{}, false
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
