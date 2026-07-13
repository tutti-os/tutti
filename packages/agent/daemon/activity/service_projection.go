package agentsessionstore

import (
	"log/slog"
	"strconv"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (*Store) applyEventLocked(entry *sessionEntry, _ string, source EventSource, event activityshared.Event, now int64) {
	sessionID := firstNonEmptyString(event.AgentSessionID, source.AgentID, event.ProviderSessionID, source.ProviderSessionID)
	if sessionID == "" {
		return
	}
	if isHiddenAgentSession(entry, sessionID) {
		return
	}
	timestamp := event.OccurredAtUnixMS
	if timestamp <= 0 {
		timestamp = now
	}
	if isAgentStatusEvent(event.Type) {
		index := findSessionIndex(entry.state.Sessions, sessionID, event.ProviderSessionID, source.ProviderSessionID, source.SessionOrigin)
		if index < 0 {
			session := ProviderActivitySessionProjection{
				AgentSessionID:    sessionID,
				UserID:            strings.TrimSpace(source.UserID),
				Provider:          firstNonEmptyString(string(event.Provider), source.Provider),
				ProviderSessionID: firstNonEmptyString(event.ProviderSessionID, source.ProviderSessionID),
				SessionOrigin:     strings.TrimSpace(source.SessionOrigin),
				CWD:               firstNonEmptyString(event.Payload.CWD, source.CWD),
				Status:            string(activityshared.SessionStatusIdle),
				LifecycleStatus:   string(activityshared.SessionLifecycleStatusActive),
				TurnPhase:         string(activityshared.TurnPhaseIdle),
				EffectiveStatus:   string(activityshared.SessionStatusIdle),
				StartedAtUnixMS:   timestamp,
				CreatedAtUnixMS:   timestamp,
				UpdatedAtUnixMS:   timestamp,
				Title:             strings.TrimSpace(event.Payload.Title),
			}
			entry.state.Sessions = append(entry.state.Sessions, session)
			slog.Info("agent activity local event created session",
				"event", "agent_activity.local_event.created",
				"source_agent_session_id", strings.TrimSpace(source.AgentID),
				"source_provider_session_id", strings.TrimSpace(source.ProviderSessionID),
				"source_origin", strings.TrimSpace(source.SessionOrigin),
				"activity_event_summary", summarizeWorkspaceAgentEventForLog(event),
				"session_after", summarizeWorkspaceAgentSessionForLog(session),
			)
			index = len(entry.state.Sessions) - 1
		}

		session := entry.state.Sessions[index]
		before := session
		if strings.TrimSpace(session.UserID) == "" {
			session.UserID = strings.TrimSpace(source.UserID)
		}
		if event.OccurredAtUnixMS > 0 && session.UpdatedAtUnixMS > event.OccurredAtUnixMS {
			entry.state.Sessions[index] = session
			slog.Info("agent activity local event ignored stale session update",
				"event", "agent_activity.local_event.ignored_stale",
				"source_agent_session_id", strings.TrimSpace(source.AgentID),
				"source_provider_session_id", strings.TrimSpace(source.ProviderSessionID),
				"source_origin", strings.TrimSpace(source.SessionOrigin),
				"activity_event_summary", summarizeWorkspaceAgentEventForLog(event),
				"session_before", summarizeWorkspaceAgentSessionForLog(before),
			)
			return
		}
		session.AgentSessionID = firstNonEmptyString(session.AgentSessionID, event.AgentSessionID, source.AgentID, event.ProviderSessionID, source.ProviderSessionID)
		session.Provider = firstNonEmptyString(string(event.Provider), session.Provider, source.Provider)
		session.ProviderSessionID = firstNonEmptyString(event.ProviderSessionID, session.ProviderSessionID, source.ProviderSessionID)
		session.SessionOrigin = firstNonEmptyString(strings.TrimSpace(source.SessionOrigin), session.SessionOrigin)
		session.CWD = firstNonEmptyString(event.Payload.CWD, session.CWD, source.CWD)
		if title := strings.TrimSpace(event.Payload.Title); title != "" {
			session.Title = title
		}
		if session.CreatedAtUnixMS <= 0 {
			session.CreatedAtUnixMS = timestamp
		}
		if session.StartedAtUnixMS <= 0 {
			session.StartedAtUnixMS = timestamp
		}

		applyStatusPayload(&session, event)
		syncCanonicalSessionStatus(&session)
		if shouldAdvanceSessionUpdatedAtFromActivityEvent(event) {
			session.UpdatedAtUnixMS = timestamp
		}
		entry.state.Sessions[index] = session
		slog.Info("agent activity local event updated session",
			"event", "agent_activity.local_event.updated",
			"source_agent_session_id", strings.TrimSpace(source.AgentID),
			"source_provider_session_id", strings.TrimSpace(source.ProviderSessionID),
			"source_origin", strings.TrimSpace(source.SessionOrigin),
			"activity_event_summary", summarizeWorkspaceAgentEventForLog(event),
			"session_before", summarizeWorkspaceAgentSessionForLog(before),
			"session_after", summarizeWorkspaceAgentSessionForLog(session),
		)
	}
	if update, ok := sessionMessageUpdateFromActivityEvent(sessionID, event, timestamp); ok {
		appendMessageUpdatesLocked(entry, source, []WorkspaceAgentMessageUpdate{update})
	}
}

func sessionMessageUpdateFromActivityEvent(
	sessionID string,
	event activityshared.Event,
	timestamp int64,
) (WorkspaceAgentMessageUpdate, bool) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" || timestamp <= 0 {
		return WorkspaceAgentMessageUpdate{}, false
	}
	switch event.Type {
	case activityshared.EventMessageAppended, activityshared.EventMessageCreated:
		messageID := firstNonEmptyString(payloadFirstStringValue(event.Payload.Metadata, "messageId"), event.EventID)
		if strings.TrimSpace(messageID) == "" {
			return WorkspaceAgentMessageUpdate{}, false
		}
		role := strings.TrimSpace(string(event.Payload.Role))
		if role == "" {
			role = string(activityshared.MessageRoleAssistant)
		}
		kind := "text"
		if role == string(activityshared.MessageRoleAssistantThinking) {
			role = string(activityshared.MessageRoleAssistant)
			kind = "reasoning"
		}
		payload := clonePayloadMap(event.Payload.Metadata)
		if payload == nil {
			payload = map[string]any{}
		}
		if event.Payload.Content != "" {
			if _, ok := payload["content"]; !ok {
				payload["content"] = event.Payload.Content
			}
			payload["text"] = event.Payload.Content
		}
		return WorkspaceAgentMessageUpdate{
			AgentSessionID:   sessionID,
			MessageID:        messageID,
			TurnID:           strings.TrimSpace(event.Payload.TurnID),
			Role:             role,
			Kind:             kind,
			Status:           firstNonEmptyString(payloadFirstStringValue(event.Payload.Metadata, "streamState"), event.Payload.Status),
			Payload:          payload,
			OccurredAtUnixMS: timestamp,
		}, true
	case activityshared.EventCallStarted, activityshared.EventCallCompleted, activityshared.EventCallFailed:
		callID := strings.TrimSpace(event.Payload.CallID)
		if callID == "" {
			return WorkspaceAgentMessageUpdate{}, false
		}
		status := firstNonEmptyString(payloadFirstStringValue(event.Payload.Metadata, "status"), event.Payload.Status)
		if status == "" {
			switch event.Type {
			case activityshared.EventCallStarted:
				status = string(activityshared.ActivityStatusRunning)
			case activityshared.EventCallCompleted:
				status = string(activityshared.ActivityStatusCompleted)
			case activityshared.EventCallFailed:
				status = string(activityshared.ActivityStatusFailed)
			}
		}
		payload := clonePayloadMap(event.Payload.Metadata)
		if payload == nil {
			payload = map[string]any{}
		}
		switch event.Type {
		case activityshared.EventCallStarted:
			payload["input"] = clonePayloadMap(event.Payload.Input)
		case activityshared.EventCallCompleted:
			payload["output"] = clonePayloadMap(event.Payload.Output)
		case activityshared.EventCallFailed:
			payload["error"] = clonePayloadMap(event.Payload.Error)
		}
		return WorkspaceAgentMessageUpdate{
			AgentSessionID:   sessionID,
			MessageID:        "toolcall:" + callID,
			TurnID:           strings.TrimSpace(event.Payload.TurnID),
			Role:             string(activityshared.MessageRoleAssistant),
			Kind:             "tool_call",
			Status:           status,
			CallID:           callID,
			Title:            strings.TrimSpace(event.Payload.Name),
			Payload:          payload,
			OccurredAtUnixMS: timestamp,
		}, true
	default:
		return WorkspaceAgentMessageUpdate{}, false
	}
}

func applyStatePatchLocked(entry *sessionEntry, source EventSource, patch WorkspaceAgentStatePatch, now int64) {
	sessionID := firstNonEmptyString(patch.AgentSessionID, source.AgentID)
	if sessionID != "" {
		sessionID = resolveKnownOrProviderAliasSessionID(
			entry.state.Sessions,
			sessionID,
			firstNonEmptyString(patch.Provider, source.Provider),
			patch.ProviderSessionID,
			source.ProviderSessionID,
			source.SessionOrigin,
		)
	}
	if sessionID == "" {
		sessionID = findUniqueSessionIDByProvider(
			entry.state.Sessions,
			firstNonEmptyString(patch.Provider, source.Provider),
			patch.ProviderSessionID,
			source.ProviderSessionID,
			source.SessionOrigin,
		)
	}
	if sessionID == "" || isHiddenAgentSession(entry, sessionID) {
		return
	}
	patch.AgentSessionID = sessionID
	timestamp := patch.OccurredAtUnixMS
	if timestamp <= 0 {
		timestamp = now
	}
	index := findSessionIndex(entry.state.Sessions, sessionID, patch.ProviderSessionID, source.ProviderSessionID, source.SessionOrigin)
	if index < 0 {
		effectiveStatus := firstNonEmptyString(
			effectiveStatusFromStatePatch(patch),
			string(activityshared.SessionStatusIdle),
		)
		session := ProviderActivitySessionProjection{
			AgentSessionID:     sessionID,
			AgentTargetID:      firstNonEmptyString(patch.AgentTargetID, source.AgentTargetID),
			DeviceID:           firstNonEmptyString(patch.DeviceID, source.DeviceID),
			UserID:             strings.TrimSpace(source.UserID),
			Provider:           firstNonEmptyString(patch.Provider, source.Provider),
			ProviderSessionID:  firstNonEmptyString(patch.ProviderSessionID, source.ProviderSessionID),
			SessionOrigin:      strings.TrimSpace(source.SessionOrigin),
			CWD:                firstNonEmptyString(patch.CWD, source.CWD),
			Status:             effectiveStatus,
			TurnLifecycle:      cloneTurnLifecycle(patch.TurnLifecycle),
			SubmitAvailability: cloneSubmitAvailability(patch.SubmitAvailability),
			LifecycleStatus:    firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive)),
			TurnPhase:          firstNonEmptyString(statePatchPhase(patch), string(activityshared.TurnPhaseIdle)),
			EffectiveStatus:    effectiveStatus,
			StartedAtUnixMS:    timestamp,
			CreatedAtUnixMS:    timestamp,
			UpdatedAtUnixMS:    timestamp,
			Title:              strings.TrimSpace(patch.Title),
		}
		entry.state.Sessions = append(entry.state.Sessions, session)
		slog.Info("agent activity local state patch created session",
			"event", "agent_activity.local_state_patch.created",
			"source_agent_session_id", strings.TrimSpace(source.AgentID),
			"source_provider_session_id", strings.TrimSpace(source.ProviderSessionID),
			"source_origin", strings.TrimSpace(source.SessionOrigin),
			"patch_summary", summarizeWorkspaceAgentStatePatchForLog(patch),
			"session_after", summarizeWorkspaceAgentSessionForLog(session),
		)
		index = len(entry.state.Sessions) - 1
	}

	session := entry.state.Sessions[index]
	before := session
	if strings.TrimSpace(session.UserID) == "" {
		session.UserID = strings.TrimSpace(source.UserID)
	}
	if patch.OccurredAtUnixMS > 0 && session.UpdatedAtUnixMS > patch.OccurredAtUnixMS {
		entry.state.Sessions[index] = session
		slog.Info("agent activity local state patch ignored stale session update",
			"event", "agent_activity.local_state_patch.ignored_stale",
			"source_agent_session_id", strings.TrimSpace(source.AgentID),
			"source_provider_session_id", strings.TrimSpace(source.ProviderSessionID),
			"source_origin", strings.TrimSpace(source.SessionOrigin),
			"patch_summary", summarizeWorkspaceAgentStatePatchForLog(patch),
			"session_before", summarizeWorkspaceAgentSessionForLog(before),
		)
		return
	}
	session.AgentSessionID = firstNonEmptyString(session.AgentSessionID, sessionID)
	session.AgentTargetID = firstNonEmptyString(patch.AgentTargetID, session.AgentTargetID, source.AgentTargetID)
	session.DeviceID = firstNonEmptyString(patch.DeviceID, session.DeviceID, source.DeviceID)
	session.Provider = firstNonEmptyString(patch.Provider, session.Provider, source.Provider)
	session.ProviderSessionID = firstNonEmptyString(patch.ProviderSessionID, session.ProviderSessionID, source.ProviderSessionID)
	session.SessionOrigin = firstNonEmptyString(strings.TrimSpace(source.SessionOrigin), session.SessionOrigin)
	session.CWD = firstNonEmptyString(patch.CWD, session.CWD, source.CWD)
	if title := strings.TrimSpace(patch.Title); title != "" {
		session.Title = title
	}
	if lifecycle := strings.TrimSpace(patch.LifecycleStatus); lifecycle != "" {
		session.LifecycleStatus = lifecycle
	}
	if patch.TurnLifecycle != nil {
		session.TurnLifecycle = cloneTurnLifecycle(patch.TurnLifecycle)
	}
	if patch.SubmitAvailability != nil {
		session.SubmitAvailability = cloneSubmitAvailability(patch.SubmitAvailability)
	}
	if phase := statePatchPhase(patch); phase != "" {
		session.TurnPhase = phase
	}
	if effectiveStatus := effectiveStatusFromStatePatch(patch); effectiveStatus != "" {
		session.EffectiveStatus = effectiveStatus
	}
	if patch.Turn != nil {
		if patch.Turn.StartedAtUnixMS > 0 && session.StartedAtUnixMS <= 0 {
			session.StartedAtUnixMS = patch.Turn.StartedAtUnixMS
		}
		if patch.Turn.CompletedAtUnixMS > 0 {
			session.EndedAtUnixMS = patch.Turn.CompletedAtUnixMS
		}
	}
	if session.EndedAtUnixMS <= 0 && statePatchSettledEffectiveStatus(patch) != "" {
		session.EndedAtUnixMS = timestamp
	}
	if session.CreatedAtUnixMS <= 0 {
		session.CreatedAtUnixMS = timestamp
	}
	if session.StartedAtUnixMS <= 0 {
		session.StartedAtUnixMS = timestamp
	}
	syncCanonicalSessionStatus(&session)
	if shouldAdvanceSessionUpdatedAtFromStatePatch(patch) {
		session.UpdatedAtUnixMS = timestamp
	}
	entry.state.Sessions[index] = session
	canonicalizeSessionMessageBucketsLocked(entry)
	slog.Info("agent activity local state patch updated session",
		"event", "agent_activity.local_state_patch.updated",
		"source_agent_session_id", strings.TrimSpace(source.AgentID),
		"source_provider_session_id", strings.TrimSpace(source.ProviderSessionID),
		"source_origin", strings.TrimSpace(source.SessionOrigin),
		"patch_summary", summarizeWorkspaceAgentStatePatchForLog(patch),
		"session_before", summarizeWorkspaceAgentSessionForLog(before),
		"session_after", summarizeWorkspaceAgentSessionForLog(session),
	)
}

func statePatchTurnPhase(patch WorkspaceAgentStatePatch) string {
	if patch.Turn == nil {
		return ""
	}
	return strings.TrimSpace(patch.Turn.Phase)
}

func statePatchPhase(patch WorkspaceAgentStatePatch) string {
	phase := strings.ToLower(strings.TrimSpace(firstNonEmptyString(
		patch.CurrentPhase,
		statePatchTurnPhase(patch),
		statePatchPhaseFromEntities(patch),
	)))
	switch phase {
	case "ready":
		return string(activityshared.TurnPhaseIdle)
	default:
		return firstNonEmptyString(
			patch.CurrentPhase,
			statePatchTurnPhase(patch),
			statePatchPhaseFromEntities(patch),
		)
	}
}

func effectiveStatusFromStatePatch(patch WorkspaceAgentStatePatch) string {
	if terminal := statePatchTerminalEffectiveStatus(patch); terminal != "" {
		return terminal
	}
	phase := strings.ToLower(strings.TrimSpace(statePatchPhase(patch)))
	switch phase {
	case "submitted", "working", "running", "streaming":
		return string(activityshared.SessionStatusWorking)
	case "awaiting_approval", "waiting", "waiting_approval", "waiting_input":
		return string(activityshared.SessionStatusWaiting)
	case "failed":
		return string(activityshared.SessionStatusFailed)
	case "completed", "idle", "ready":
		return string(activityshared.SessionStatusIdle)
	}
	return ""
}

func statePatchPhaseFromEntities(patch WorkspaceAgentStatePatch) string {
	for _, entity := range patch.Entities {
		switch strings.ToLower(strings.TrimSpace(entity.Status)) {
		case "waiting", "waiting_input", "waiting_approval", "awaiting_approval":
			return "waiting_input"
		case "running", "streaming", "in_progress":
			return "working"
		}
	}
	return ""
}

func statePatchTerminalEffectiveStatus(patch WorkspaceAgentStatePatch) string {
	switch strings.ToLower(strings.TrimSpace(patch.LifecycleStatus)) {
	case "failed":
		return string(activityshared.SessionStatusFailed)
	case "completed", "ended":
		return string(activityshared.SessionStatusCompleted)
	case "canceled":
		return string(activityshared.SessionStatusCanceled)
	default:
		return ""
	}
}

func syncCanonicalSessionStatus(session *ProviderActivitySessionProjection) {
	if session == nil {
		return
	}
	status := canonicalWorkspaceAgentSessionStatus(*session)
	session.Status = status
	if shouldProjectCanonicalStatusToEffectiveStatus(*session, status) {
		session.EffectiveStatus = status
	}
}

func canonicalWorkspaceAgentSessionStatus(session ProviderActivitySessionProjection) string {
	switch normalizeSessionStatusToken(session.LifecycleStatus) {
	case "failed":
		return string(activityshared.SessionStatusFailed)
	case "completed", "ended":
		return string(activityshared.SessionStatusCompleted)
	case "canceled":
		return string(activityshared.SessionStatusCanceled)
	}

	switch normalizeSessionStatusToken(firstNonEmptyString(session.EffectiveStatus, session.Status)) {
	case "failed":
		return string(activityshared.SessionStatusFailed)
	case "completed", "ended", "end":
		return string(activityshared.SessionStatusCompleted)
	case "canceled":
		return string(activityshared.SessionStatusCanceled)
	case "waiting", "waiting_approval", "waiting_input":
		return string(activityshared.SessionStatusWaiting)
	case "submitted", "working", "running", "streaming":
		return string(activityshared.SessionStatusWorking)
	}

	switch normalizeSessionStatusToken(session.TurnPhase) {
	case "waiting", "waiting_approval", "waiting_input":
		return string(activityshared.SessionStatusWaiting)
	case "working", "running", "streaming":
		return string(activityshared.SessionStatusWorking)
	case "failed":
		return string(activityshared.SessionStatusFailed)
	default:
		return string(activityshared.SessionStatusIdle)
	}
}

func shouldProjectCanonicalStatusToEffectiveStatus(session ProviderActivitySessionProjection, status string) bool {
	effectiveStatus := normalizeSessionStatusToken(session.EffectiveStatus)
	if effectiveStatus == "" {
		return true
	}
	if status == string(activityshared.SessionStatusWaiting) {
		return true
	}
	if status == string(activityshared.SessionStatusCompleted) ||
		status == string(activityshared.SessionStatusFailed) ||
		status == string(activityshared.SessionStatusCanceled) {
		return true
	}
	return false
}

func normalizeSessionStatusToken(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func statePatchSettledEffectiveStatus(patch WorkspaceAgentStatePatch) string {
	if terminal := statePatchTerminalEffectiveStatus(patch); terminal != "" {
		return terminal
	}
	switch strings.ToLower(strings.TrimSpace(statePatchPhase(patch))) {
	case "failed":
		return string(activityshared.SessionStatusFailed)
	case "completed":
		return string(activityshared.SessionStatusCompleted)
	default:
		return ""
	}
}

func shouldAdvanceSessionUpdatedAtFromActivityEvent(event activityshared.Event) bool {
	switch event.Type {
	case activityshared.EventTurnStarted,
		activityshared.EventTurnCompleted,
		activityshared.EventTurnFailed:
		return true
	case activityshared.EventTurnUpdated:
		switch normalizeSessionStatusToken(event.Payload.TurnPhase) {
		case string(activityshared.SessionStatusWaiting),
			string(activityshared.TurnPhaseWaitingApproval),
			string(activityshared.TurnPhaseWaitingInput):
			return true
		}
	default:
		return false
	}
	return false
}

func shouldAdvanceSessionUpdatedAtFromStatePatch(patch WorkspaceAgentStatePatch) bool {
	switch normalizeSessionStatusToken(statePatchPhase(patch)) {
	case string(activityshared.SessionStatusWaiting),
		string(activityshared.TurnPhaseWaitingApproval),
		string(activityshared.TurnPhaseWaitingInput):
		return true
	}
	if patch.Turn == nil {
		return false
	}
	if patch.Turn.StartedAtUnixMS > 0 || patch.Turn.CompletedAtUnixMS > 0 {
		return true
	}
	switch normalizeSessionStatusToken(statePatchPhase(patch)) {
	case string(activityshared.TurnPhaseWorking),
		string(activityshared.TurnPhaseFailed):
		return true
	default:
		return false
	}
}

func isAgentStatusEvent(eventType activityshared.EventType) bool {
	switch eventType {
	case activityshared.EventSessionStarted,
		activityshared.EventSessionUpdated,
		activityshared.EventSessionCompleted,
		activityshared.EventSessionFailed,
		activityshared.EventTurnStarted,
		activityshared.EventTurnUpdated,
		activityshared.EventTurnCompleted,
		activityshared.EventTurnFailed:
		return true
	default:
		return false
	}
}

func summarizeWorkspaceAgentSessionForLog(session ProviderActivitySessionProjection) string {
	return strings.Join([]string{
		"agent_session_id=" + strings.TrimSpace(session.AgentSessionID),
		"provider_session_id=" + strings.TrimSpace(session.ProviderSessionID),
		"origin=" + strings.TrimSpace(session.SessionOrigin),
		"lifecycle=" + strings.TrimSpace(session.LifecycleStatus),
		"turn=" + strings.TrimSpace(session.TurnPhase),
		"effective=" + strings.TrimSpace(session.EffectiveStatus),
		"title=" + strings.TrimSpace(session.Title),
	}, " ")
}

func summarizeWorkspaceAgentStatePatchForLog(patch WorkspaceAgentStatePatch) string {
	entitySummaries := make([]string, 0, len(patch.Entities))
	for _, entity := range patch.Entities {
		entitySummaries = append(entitySummaries, strings.Join([]string{
			"name=" + strings.TrimSpace(entity.Name),
			"call=" + strings.TrimSpace(entity.CallID),
			"status=" + strings.TrimSpace(entity.Status),
			"turn=" + strings.TrimSpace(entity.TurnID),
		}, " "))
	}
	return strings.Join([]string{
		"agent_session_id=" + strings.TrimSpace(patch.AgentSessionID),
		"provider_session_id=" + strings.TrimSpace(patch.ProviderSessionID),
		"lifecycle=" + strings.TrimSpace(patch.LifecycleStatus),
		"current_phase=" + strings.TrimSpace(patch.CurrentPhase),
		"turn_phase=" + strings.TrimSpace(statePatchTurnPhase(patch)),
		"inferred_phase=" + strings.TrimSpace(statePatchPhaseFromEntities(patch)),
		"title=" + strings.TrimSpace(patch.Title),
		"entities=[" + strings.Join(entitySummaries, " || ") + "]",
	}, " ")
}

func summarizeWorkspaceAgentEventForLog(event activityshared.Event) string {
	return strings.Join([]string{
		"type=" + strings.TrimSpace(string(event.Type)),
		"agent_session_id=" + strings.TrimSpace(event.AgentSessionID),
		"provider_session_id=" + strings.TrimSpace(event.ProviderSessionID),
		"occurred_at_unix_ms=" + strconv.FormatInt(event.OccurredAtUnixMS, 10),
		"lifecycle=" + strings.TrimSpace(event.Payload.LifecycleStatus),
		"effective=" + strings.TrimSpace(event.Payload.EffectiveStatus),
		"turn_id=" + strings.TrimSpace(event.Payload.TurnID),
		"turn_phase=" + strings.TrimSpace(event.Payload.TurnPhase),
		"turn_outcome=" + strings.TrimSpace(event.Payload.TurnOutcome),
		"title=" + strings.TrimSpace(event.Payload.Title),
	}, " ")
}

func findSessionIndex(
	sessions []ProviderActivitySessionProjection,
	sessionID,
	providerSessionID,
	sourceProviderSessionID,
	sessionOrigin string,
) int {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID != "" {
		for index, session := range sessions {
			if strings.TrimSpace(session.AgentSessionID) == sessionID {
				return index
			}
		}
		return -1
	}

	providerSessionID = strings.TrimSpace(firstNonEmptyString(providerSessionID, sourceProviderSessionID))
	if providerSessionID == "" {
		return -1
	}
	sessionOrigin = NormalizeSessionOrigin(sessionOrigin)
	if sessionOrigin == "" {
		return -1
	}
	for index, session := range sessions {
		if strings.TrimSpace(session.ProviderSessionID) != providerSessionID {
			continue
		}
		if NormalizeSessionOrigin(session.SessionOrigin) != sessionOrigin {
			continue
		}
		return index
	}
	return -1
}

func applyStatusPayload(session *ProviderActivitySessionProjection, event activityshared.Event) {
	if session == nil {
		return
	}
	switch event.Type {
	case activityshared.EventSessionStarted:
		session.LifecycleStatus = firstNonEmptyString(event.Payload.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		session.EffectiveStatus = firstNonEmptyString(event.Payload.EffectiveStatus, string(activityshared.SessionStatusIdle))
		session.TurnPhase = firstNonEmptyString(event.Payload.TurnPhase, string(activityshared.TurnPhaseIdle))
	case activityshared.EventSessionUpdated:
		if event.Payload.LifecycleStatus != "" {
			session.LifecycleStatus = event.Payload.LifecycleStatus
		}
		if event.Payload.EffectiveStatus != "" {
			session.EffectiveStatus = event.Payload.EffectiveStatus
			if event.Payload.EffectiveStatus == string(activityshared.SessionStatusIdle) {
				session.TurnPhase = string(activityshared.TurnPhaseIdle)
			}
		}
		if event.Payload.TurnPhase != "" {
			session.TurnPhase = event.Payload.TurnPhase
		}
	case activityshared.EventSessionCompleted:
		session.LifecycleStatus = firstNonEmptyString(event.Payload.LifecycleStatus, string(activityshared.SessionLifecycleStatusEnded))
		session.EffectiveStatus = firstNonEmptyString(event.Payload.EffectiveStatus, string(activityshared.SessionStatusCompleted))
		session.TurnPhase = string(activityshared.TurnPhaseIdle)
		if event.OccurredAtUnixMS > 0 {
			session.EndedAtUnixMS = event.OccurredAtUnixMS
		}
	case activityshared.EventSessionFailed:
		session.LifecycleStatus = firstNonEmptyString(event.Payload.LifecycleStatus, string(activityshared.SessionLifecycleStatusFailed))
		session.EffectiveStatus = firstNonEmptyString(event.Payload.EffectiveStatus, string(activityshared.SessionStatusFailed))
		session.TurnPhase = string(activityshared.TurnPhaseFailed)
		if event.OccurredAtUnixMS > 0 {
			session.EndedAtUnixMS = event.OccurredAtUnixMS
		}
	case activityshared.EventTurnStarted:
		session.LifecycleStatus = firstNonEmptyString(session.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		session.EffectiveStatus = string(activityshared.SessionStatusWorking)
		session.TurnPhase = firstNonEmptyString(event.Payload.TurnPhase, string(activityshared.TurnPhaseWorking))
	case activityshared.EventTurnUpdated:
		session.LifecycleStatus = firstNonEmptyString(session.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		if event.Payload.TurnPhase != "" {
			session.TurnPhase = event.Payload.TurnPhase
		}
		switch session.TurnPhase {
		case string(activityshared.TurnPhaseWaitingApproval), string(activityshared.TurnPhaseWaitingInput):
			session.EffectiveStatus = string(activityshared.SessionStatusWaiting)
		case string(activityshared.TurnPhaseIdle):
			session.EffectiveStatus = string(activityshared.SessionStatusIdle)
		default:
			session.EffectiveStatus = string(activityshared.SessionStatusWorking)
		}
	case activityshared.EventTurnCompleted:
		session.TurnPhase = firstNonEmptyString(event.Payload.TurnPhase, string(activityshared.TurnPhaseIdle))
		session.EffectiveStatus = string(activityshared.SessionStatusIdle)
	case activityshared.EventTurnFailed:
		session.TurnPhase = firstNonEmptyString(event.Payload.TurnPhase, string(activityshared.TurnPhaseFailed))
		session.EffectiveStatus = string(activityshared.SessionStatusFailed)
	}
}
