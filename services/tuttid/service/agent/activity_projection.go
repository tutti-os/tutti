package agent

import (
	"context"
	"log/slog"
	"strings"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	agentactivityprojection "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity/projection"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

type ActivityProjection struct {
	repo                   agentactivitybiz.Repository
	publisher              ActivityUpdatePublisher
	sessionMessageObserver SessionMessageObserver
	sessionStateObserver   SessionStateObserver
}

func NewActivityProjection(repo agentactivitybiz.Repository) *ActivityProjection {
	return &ActivityProjection{repo: repo}
}

type ActivityUpdatePublisher interface {
	PublishAgentActivityUpdated(
		context.Context,
		string,
		string,
		string,
		map[string]any,
	) error
}

type SessionStateObserver interface {
	ObserveAgentSessionState(context.Context, agentsessionstore.ReportSessionStateInput, agentsessionstore.ReportSessionStateReply)
}

type SessionMessageObserver interface {
	ObserveAgentSessionMessages(context.Context, agentsessionstore.ReportSessionMessagesInput, agentsessionstore.ReportSessionMessagesReply)
}

func (p *ActivityProjection) SetPublisher(publisher ActivityUpdatePublisher) {
	if p == nil {
		return
	}
	p.publisher = publisher
}

func (p *ActivityProjection) SetSessionMessageObserver(observer SessionMessageObserver) {
	if p == nil {
		return
	}
	p.sessionMessageObserver = observer
}

func (p *ActivityProjection) SetSessionStateObserver(observer SessionStateObserver) {
	if p == nil {
		return
	}
	p.sessionStateObserver = observer
}

func (p *ActivityProjection) Report(ctx context.Context, input agentsessionstore.ReportActivityInput) error {
	if p == nil || p.repo == nil {
		return nil
	}
	if strings.TrimSpace(input.Source.SessionOrigin) == "" {
		input.Source.SessionOrigin = agentsessionstore.WorkspaceAgentSessionOriginRuntime
	}
	_, err := agentsessionstore.ReportActivityAsSessionUpdates(ctx, p, input)
	return err
}

func (p *ActivityProjection) ReportSessionState(
	ctx context.Context,
	input agentsessionstore.ReportSessionStateInput,
) (agentsessionstore.ReportSessionStateReply, error) {
	if p == nil || p.repo == nil {
		return agentsessionstore.ReportSessionStateReply{}, nil
	}
	result, err := p.repo.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:       strings.TrimSpace(input.WorkspaceID),
		AgentSessionID:    strings.TrimSpace(input.AgentSessionID),
		Origin:            strings.TrimSpace(input.SessionOrigin),
		Provider:          strings.TrimSpace(firstNonEmptyString(input.State.Provider, input.Source.Provider)),
		ProviderSessionID: strings.TrimSpace(firstNonEmptyString(input.State.ProviderSessionID, input.Source.ProviderSessionID)),
		Model:             strings.TrimSpace(input.State.Model),
		Settings:          clonePayload(input.State.Settings),
		RuntimeContext:    clonePayload(input.State.RuntimeContext),
		Cwd:               strings.TrimSpace(input.State.CWD),
		Title:             strings.TrimSpace(input.State.Title),
		Status:            strings.TrimSpace(input.State.LifecycleStatus),
		CurrentPhase:      strings.TrimSpace(input.State.CurrentPhase),
		LastError:         strings.TrimSpace(input.State.LastError),
		OccurredAtUnixMS:  input.State.OccurredAtUnixMS,
		StartedAtUnixMS:   input.State.StartedAtUnixMS,
		EndedAtUnixMS:     input.State.EndedAtUnixMS,
	})
	if err != nil {
		return agentsessionstore.ReportSessionStateReply{}, err
	}
	reply := agentsessionstore.ReportSessionStateReply{
		Accepted:          result.Accepted,
		StateApplied:      result.StateApplied,
		LastEventAtUnixMS: result.LastEventUnixMS,
		RequestBodyBytes:  result.RequestBodyBytes,
	}
	if result.Accepted {
		if result.StateApplied {
			p.publishActivityUpdated(
				ctx,
				input.WorkspaceID,
				input.AgentSessionID,
				"state_patch",
				activityStatePatchEventPayload(input, result.LastEventUnixMS),
			)
		} else {
			p.publishActivityUpdated(
				ctx,
				input.WorkspaceID,
				input.AgentSessionID,
				"session_update",
				activitySessionUpdateEventPayload(input.WorkspaceID, input.AgentSessionID, result.LastEventUnixMS),
			)
		}
	}
	p.observeSessionState(ctx, input, reply)
	return reply, nil
}

func activityStatePatchEventPayload(
	input agentsessionstore.ReportSessionStateInput,
	lastEventUnixMS int64,
) map[string]any {
	state := input.State
	payload := map[string]any{
		"agentSessionId":   strings.TrimSpace(input.AgentSessionID),
		"eventType":        "state_patch",
		"lastEventUnixMs":  lastEventUnixMS,
		"occurredAtUnixMs": firstNonZeroInt64(state.OccurredAtUnixMS, lastEventUnixMS),
		"workspaceId":      strings.TrimSpace(input.WorkspaceID),
	}
	if provider := strings.TrimSpace(firstNonEmptyString(state.Provider, input.Source.Provider)); provider != "" {
		payload["provider"] = provider
	}
	if providerSessionID := strings.TrimSpace(firstNonEmptyString(state.ProviderSessionID, input.Source.ProviderSessionID)); providerSessionID != "" {
		payload["providerSessionId"] = providerSessionID
	}
	if model := strings.TrimSpace(state.Model); model != "" {
		payload["model"] = model
	}
	if cwd := strings.TrimSpace(state.CWD); cwd != "" {
		payload["cwd"] = cwd
	}
	if title := strings.TrimSpace(state.Title); title != "" {
		payload["title"] = title
	}
	if lifecycleStatus := strings.TrimSpace(state.LifecycleStatus); lifecycleStatus != "" {
		payload["lifecycleStatus"] = lifecycleStatus
	}
	if currentPhase := strings.TrimSpace(state.CurrentPhase); currentPhase != "" {
		payload["currentPhase"] = currentPhase
	}
	if lastError := strings.TrimSpace(state.LastError); lastError != "" {
		payload["lastError"] = lastError
	}
	if state.StartedAtUnixMS > 0 {
		payload["startedAtUnixMs"] = state.StartedAtUnixMS
	}
	if state.EndedAtUnixMS > 0 {
		payload["endedAtUnixMs"] = state.EndedAtUnixMS
	}
	if state.Turn != nil {
		turn := map[string]any{
			"turnId": strings.TrimSpace(state.Turn.TurnID),
		}
		if phase := strings.TrimSpace(state.Turn.Phase); phase != "" {
			turn["phase"] = phase
		}
		if outcome := strings.TrimSpace(state.Turn.Outcome); outcome != "" {
			turn["outcome"] = outcome
		}
		if state.Turn.FileChanges != nil {
			turn["fileChanges"] = clonePayload(state.Turn.FileChanges)
		}
		if state.Turn.StartedAtUnixMS > 0 {
			turn["startedAtUnixMs"] = state.Turn.StartedAtUnixMS
		}
		if state.Turn.CompletedAtUnixMS > 0 {
			turn["completedAtUnixMs"] = state.Turn.CompletedAtUnixMS
		}
		payload["turn"] = turn
	}
	return payload
}

func activitySessionUpdateEventPayload(workspaceID string, agentSessionID string, lastEventUnixMS int64) map[string]any {
	if lastEventUnixMS <= 0 {
		lastEventUnixMS = time.Now().UnixMilli()
	}
	return map[string]any{
		"agentSessionId":  strings.TrimSpace(agentSessionID),
		"eventType":       "session_update",
		"lastEventUnixMs": lastEventUnixMS,
		"workspaceId":     strings.TrimSpace(workspaceID),
	}
}

func activitySessionDeletedEventPayload(workspaceID string, agentSessionID string) map[string]any {
	return map[string]any{
		"agentSessionId":  strings.TrimSpace(agentSessionID),
		"deletedAtUnixMs": time.Now().UnixMilli(),
		"eventType":       "session_deleted",
		"workspaceId":     strings.TrimSpace(workspaceID),
	}
}

func (p *ActivityProjection) ReportSessionMessages(
	ctx context.Context,
	input agentsessionstore.ReportSessionMessagesInput,
) (agentsessionstore.ReportSessionMessagesReply, error) {
	if p == nil || p.repo == nil {
		return agentsessionstore.ReportSessionMessagesReply{}, nil
	}
	result, err := p.repo.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    strings.TrimSpace(input.WorkspaceID),
		AgentSessionID: strings.TrimSpace(input.AgentSessionID),
		Origin:         strings.TrimSpace(input.SessionOrigin),
		Messages:       activityMessageUpdates(input.Updates),
	})
	if err != nil {
		return agentsessionstore.ReportSessionMessagesReply{}, err
	}
	if result.AcceptedCount > 0 {
		p.publishActivityUpdated(ctx, input.WorkspaceID, input.AgentSessionID, "message_update", map[string]any{
			"acceptedCount":  result.AcceptedCount,
			"agentSessionId": strings.TrimSpace(input.AgentSessionID),
			"eventType":      "message_update",
			"latestVersion":  result.LatestVersion,
			"messages":       activityMessagesEventPayload(result.Messages),
			"workspaceId":    strings.TrimSpace(input.WorkspaceID),
		})
	}
	reply := agentsessionstore.ReportSessionMessagesReply{
		AcceptedCount:    result.AcceptedCount,
		LatestVersion:    result.LatestVersion,
		RequestBodyBytes: result.RequestBodyBytes,
	}
	p.observeSessionMessages(ctx, input, reply)
	return reply, nil
}

func (p *ActivityProjection) GetSession(workspaceID string, agentSessionID string) (PersistedSession, bool) {
	if p == nil || p.repo == nil {
		return PersistedSession{}, false
	}
	session, ok, err := p.repo.GetSession(context.Background(), workspaceID, agentSessionID)
	if err != nil {
		slog.Warn("read workspace agent session failed",
			"event", "workspace.agent_session.read_failed",
			"workspace_id", workspaceID,
			"agent_session_id", agentSessionID,
			"error", err,
		)
		return PersistedSession{}, false
	}
	if !ok {
		return PersistedSession{}, false
	}
	return persistedSessionFromActivity(session), true
}

func (p *ActivityProjection) ListSessions(workspaceID string) ([]PersistedSession, bool) {
	if p == nil || p.repo == nil {
		return nil, false
	}
	sessions, ok, err := p.repo.ListSessions(context.Background(), workspaceID)
	if err != nil {
		slog.Warn("list workspace agent sessions failed",
			"event", "workspace.agent_session.list_failed",
			"workspace_id", workspaceID,
			"error", err,
		)
		return nil, false
	}
	if !ok {
		return nil, false
	}
	out := make([]PersistedSession, 0, len(sessions))
	for _, session := range sessions {
		out = append(out, persistedSessionFromActivity(session))
	}
	return out, true
}

func (p *ActivityProjection) DeleteSession(ctx context.Context, workspaceID string, agentSessionID string) (bool, error) {
	if p == nil || p.repo == nil {
		return false, nil
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	removed, err := p.repo.DeleteSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		return false, err
	}
	if removed {
		p.publishActivityUpdated(ctx, workspaceID, agentSessionID, "session_deleted", activitySessionDeletedEventPayload(workspaceID, agentSessionID))
	}
	return removed, nil
}

func (p *ActivityProjection) UpdateSessionPinned(ctx context.Context, workspaceID string, agentSessionID string, pinned bool) (PersistedSession, bool, error) {
	if p == nil || p.repo == nil {
		return PersistedSession{}, false, nil
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	session, ok, err := p.repo.UpdateSessionPinned(ctx, workspaceID, agentSessionID, pinned)
	if err != nil {
		return PersistedSession{}, false, err
	}
	if !ok {
		return PersistedSession{}, false, nil
	}
	persisted := persistedSessionFromActivity(session)
	p.publishActivityUpdated(ctx, workspaceID, agentSessionID, "session_update", activitySessionUpdateEventPayload(workspaceID, agentSessionID, persisted.UpdatedAtUnixMS))
	return persisted, true, nil
}

func (p *ActivityProjection) ReconcileStaleTurnOnResume(ctx context.Context, session PersistedSession) error {
	if p == nil || p.repo == nil {
		return nil
	}
	workspaceID := strings.TrimSpace(session.WorkspaceID)
	agentSessionID := strings.TrimSpace(session.ID)
	if workspaceID == "" || agentSessionID == "" {
		return nil
	}
	now := time.Now().UnixMilli()
	page, ok := p.ListSessionMessages(agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Limit:          100,
		Order:          agentactivitybiz.MessageOrderDesc,
	})
	if ok {
		updates := staleResumeMessageUpdates(page.Messages, now)
		if len(updates) > 0 {
			if _, err := p.ReportSessionMessages(ctx, agentsessionstore.ReportSessionMessagesInput{
				WorkspaceID:    workspaceID,
				AgentSessionID: agentSessionID,
				SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
				Updates:        updates,
			}); err != nil {
				return err
			}
		}
	}
	_, err := p.ReportSessionState(ctx, agentsessionstore.ReportSessionStateInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			Provider:          strings.TrimSpace(session.Provider),
			ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
			CWD:               strings.TrimSpace(session.Cwd),
			Title:             strings.TrimSpace(session.Title),
			LifecycleStatus:   "active",
			CurrentPhase:      "idle",
			OccurredAtUnixMS:  now,
		},
	})
	return err
}

func (p *ActivityProjection) ListSessionMessages(
	input agentactivitybiz.ListSessionMessagesInput,
) (SessionMessagesPage, bool) {
	if p == nil || p.repo == nil {
		return SessionMessagesPage{}, false
	}
	page, ok, err := p.repo.ListSessionMessages(context.Background(), input)
	if err != nil {
		slog.Warn("list workspace agent session messages failed",
			"event", "workspace.agent_session.messages.list_failed",
			"workspace_id", input.WorkspaceID,
			"agent_session_id", input.AgentSessionID,
			"error", err,
		)
		return SessionMessagesPage{}, false
	}
	if !ok {
		return SessionMessagesPage{}, false
	}
	return SessionMessagesPage{
		AgentSessionID: page.AgentSessionID,
		Messages:       sessionMessagesFromActivity(page.Messages),
		LatestVersion:  page.LatestVersion,
		HasMore:        page.HasMore,
	}, true
}

func staleResumeMessageUpdates(messages []SessionMessage, occurredAtUnixMS int64) []agentsessionstore.WorkspaceAgentSessionMessageUpdate {
	turnID := latestStaleResumeTurnID(messages)
	if turnID == "" {
		return nil
	}
	updates := make([]agentsessionstore.WorkspaceAgentSessionMessageUpdate, 0)
	for _, message := range messages {
		if strings.TrimSpace(message.TurnID) != turnID {
			continue
		}
		if !isStaleResumeOpenToolCall(message) {
			continue
		}
		payload := staleResumeFailedPayload(message.Payload)
		updates = append(updates, agentsessionstore.WorkspaceAgentSessionMessageUpdate{
			MessageID:         strings.TrimSpace(message.MessageID),
			TurnID:            strings.TrimSpace(message.TurnID),
			Role:              strings.TrimSpace(message.Role),
			Kind:              strings.TrimSpace(message.Kind),
			Status:            "failed",
			Payload:           payload,
			OccurredAtUnixMS:  occurredAtUnixMS,
			CompletedAtUnixMS: occurredAtUnixMS,
		})
	}
	return updates
}

func latestStaleResumeTurnID(messages []SessionMessage) string {
	for _, message := range messages {
		if !isStaleResumeOpenMessage(message) {
			continue
		}
		if turnID := strings.TrimSpace(message.TurnID); turnID != "" {
			return turnID
		}
	}
	for _, message := range messages {
		if turnID := strings.TrimSpace(message.TurnID); turnID != "" {
			return turnID
		}
	}
	return ""
}

func isStaleResumeOpenToolCall(message SessionMessage) bool {
	return strings.TrimSpace(message.Kind) == "tool_call" && isStaleResumeOpenMessage(message)
}

func isStaleResumeOpenMessage(message SessionMessage) bool {
	status := strings.TrimSpace(message.Status)
	if status == "" {
		status = payloadString(message.Payload, "status")
	}
	switch status {
	case "completed", "failed", "canceled", "errored":
		return false
	default:
		return true
	}
}

func staleResumeFailedPayload(payload map[string]any) map[string]any {
	next := clonePayload(payload)
	if next == nil {
		next = map[string]any{}
	}
	next["status"] = "failed"
	errorPayload := map[string]any{
		"message": "request interrupted by application restart",
	}
	if requestID := requestIDFromMessagePayload(next); requestID != "" {
		errorPayload["requestId"] = requestID
	}
	next["error"] = errorPayload
	return next
}

func requestIDFromMessagePayload(payload map[string]any) string {
	if requestID := payloadString(payload, "requestId"); requestID != "" {
		return requestID
	}
	input, ok := payload["input"].(map[string]any)
	if !ok {
		return ""
	}
	return payloadString(input, "requestId")
}

func (p *ActivityProjection) publishActivityUpdated(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	eventType string,
	data map[string]any,
) {
	if p == nil || p.publisher == nil {
		return
	}
	if err := p.publisher.PublishAgentActivityUpdated(
		ctx,
		workspaceID,
		agentSessionID,
		eventType,
		data,
	); err != nil {
		slog.Warn("publish workspace agent activity update failed",
			"event", "workspace.agent_activity.publish_failed",
			"workspace_id", strings.TrimSpace(workspaceID),
			"agent_session_id", strings.TrimSpace(agentSessionID),
			"event_type", strings.TrimSpace(eventType),
			"error", err,
		)
	}
}

func (p *ActivityProjection) observeSessionState(
	ctx context.Context,
	input agentsessionstore.ReportSessionStateInput,
	reply agentsessionstore.ReportSessionStateReply,
) {
	if p == nil || p.sessionStateObserver == nil {
		return
	}
	p.sessionStateObserver.ObserveAgentSessionState(ctx, input, reply)
}

func (p *ActivityProjection) observeSessionMessages(
	ctx context.Context,
	input agentsessionstore.ReportSessionMessagesInput,
	reply agentsessionstore.ReportSessionMessagesReply,
) {
	if p == nil || p.sessionMessageObserver == nil {
		return
	}
	p.sessionMessageObserver.ObserveAgentSessionMessages(ctx, input, reply)
}

func activityMessageUpdates(updates []agentsessionstore.WorkspaceAgentSessionMessageUpdate) []agentactivitybiz.MessageUpdate {
	if len(updates) == 0 {
		return nil
	}
	out := make([]agentactivitybiz.MessageUpdate, 0, len(updates))
	for _, update := range updates {
		out = append(out, agentactivitybiz.MessageUpdate{
			MessageID:         strings.TrimSpace(update.MessageID),
			TurnID:            strings.TrimSpace(update.TurnID),
			Role:              strings.TrimSpace(update.Role),
			Kind:              strings.TrimSpace(update.Kind),
			Status:            strings.TrimSpace(update.Status),
			ContentDelta:      update.ContentDelta,
			Payload:           update.Payload,
			OccurredAtUnixMS:  update.OccurredAtUnixMS,
			StartedAtUnixMS:   update.StartedAtUnixMS,
			CompletedAtUnixMS: update.CompletedAtUnixMS,
		})
	}
	return out
}

func activityMessagesEventPayload(messages []agentactivitybiz.Message) []map[string]any {
	if len(messages) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		item := map[string]any{
			"agentSessionId": strings.TrimSpace(message.AgentSessionID),
			"id":             message.ID,
			"kind":           strings.TrimSpace(message.Kind),
			"messageId":      strings.TrimSpace(message.MessageID),
			"payload":        clonePayload(message.Payload),
			"role":           strings.TrimSpace(message.Role),
			"version":        message.Version,
		}
		if turnID := strings.TrimSpace(message.TurnID); turnID != "" {
			item["turnId"] = turnID
		}
		if status := strings.TrimSpace(message.Status); status != "" {
			item["status"] = status
		}
		if message.OccurredAtUnixMS > 0 {
			item["occurredAtUnixMs"] = message.OccurredAtUnixMS
		}
		if message.StartedAtUnixMS > 0 {
			item["startedAtUnixMs"] = message.StartedAtUnixMS
		}
		if message.CompletedAtUnixMS > 0 {
			item["completedAtUnixMs"] = message.CompletedAtUnixMS
		}
		if message.CreatedAtUnixMS > 0 {
			item["createdAtUnixMs"] = message.CreatedAtUnixMS
		}
		if message.UpdatedAtUnixMS > 0 {
			item["updatedAtUnixMs"] = message.UpdatedAtUnixMS
		}
		out = append(out, item)
	}
	return out
}

func persistedSessionFromActivity(session agentactivitybiz.Session) PersistedSession {
	return PersistedSession{
		ID:                strings.TrimSpace(session.ID),
		WorkspaceID:       strings.TrimSpace(session.WorkspaceID),
		Provider:          strings.TrimSpace(session.Provider),
		ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
		Cwd:               strings.TrimSpace(session.Cwd),
		Settings:          composerSettingsFromPayload(session.Settings),
		RuntimeContext:    clonePayload(session.RuntimeContext),
		Status:            agentActivitySessionStatus(session),
		CurrentPhase:      strings.TrimSpace(session.CurrentPhase),
		Visible:           visibleFromRuntimeContext(session.RuntimeContext, true),
		Title:             strings.TrimSpace(session.Title),
		LastError:         strings.TrimSpace(session.LastError),
		PinnedAtUnixMS:    session.PinnedAtUnixMS,
		CreatedAtUnixMS:   session.CreatedAtUnixMS,
		UpdatedAtUnixMS:   session.UpdatedAtUnixMS,
	}
}

func agentActivitySessionStatus(session agentactivitybiz.Session) string {
	return agentactivityprojection.CanonicalSessionStatus(session.Status, session.CurrentPhase)
}

func sessionMessagesFromActivity(messages []agentactivitybiz.Message) []SessionMessage {
	if len(messages) == 0 {
		return nil
	}
	out := make([]SessionMessage, 0, len(messages))
	for _, message := range messages {
		out = append(out, SessionMessage{
			ID:                message.ID,
			AgentSessionID:    strings.TrimSpace(message.AgentSessionID),
			MessageID:         strings.TrimSpace(message.MessageID),
			TurnID:            strings.TrimSpace(message.TurnID),
			Role:              strings.TrimSpace(message.Role),
			Kind:              strings.TrimSpace(message.Kind),
			Status:            strings.TrimSpace(message.Status),
			Payload:           message.Payload,
			OccurredAtUnixMS:  message.OccurredAtUnixMS,
			StartedAtUnixMS:   message.StartedAtUnixMS,
			CompletedAtUnixMS: message.CompletedAtUnixMS,
			CreatedAtUnixMS:   message.CreatedAtUnixMS,
			UpdatedAtUnixMS:   message.UpdatedAtUnixMS,
			Version:           message.Version,
		})
	}
	return out
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func firstNonZeroInt64(values ...int64) int64 {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}
