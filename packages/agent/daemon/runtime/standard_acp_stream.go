package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *standardACPAdapter) handleACPMessage(
	ctx context.Context,
	client *acpClient,
	session Session,
	turnID string,
	message acpMessage,
	normalizer *acpTurnNormalizer,
	emit EventSink,
	emitCommands CommandSnapshotSink,
) ([]activityshared.Event, error) {
	slog.Info("agent session ACP handle message",
		"event", "agent_session.acp.handle_message",
		"provider", a.config.provider,
		"adapter", a.config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", session.ProviderSessionID,
		"turn_id", turnID,
		"message_method", message.Method,
		"message_id", rawMessageLogValue(message.ID),
	)
	if diagnostics := a.config.messageDiagnostics; diagnostics != nil &&
		message.Method == diagnostics.method {
		if diagnostics.observeMessage != nil {
			diagnostics.observeMessage(a.config, session, turnID, message, normalizer)
		}
		// Provider diagnostic extensions are observational until their ordering
		// and lifecycle semantics are deliberately mapped to durable entities.
		if len(message.ID) > 0 {
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32601, Message: "method not supported"})
		}
		return nil, nil
	}
	switch message.Method {
	case acpMethodUpdate:
		if !a.standardACPUpdateMatchesProviderSession(session, message.Params) {
			return nil, nil
		}
		if snapshot := a.applyACPUpdate(session.AgentSessionID, message.Params); snapshot != nil {
			if emitCommands != nil {
				emitCommands(*snapshot)
			} else {
				a.emitCommandSnapshot(*snapshot)
			}
		}
		a.emitConfigOptionsUpdate(session, message.Params)
		events := standardACPUpdateEvents(a.config, session, turnID, message.Params, normalizer)
		slog.Info("agent session ACP update projected events",
			"event", "agent_session.acp.handle_message.update",
			"provider", a.config.provider,
			"adapter", a.config.adapterName,
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", session.ProviderSessionID,
			"turn_id", turnID,
			"event_count", len(events),
			"event_type_counts", activityEventTypeCounts(events),
		)
		if len(events) > 0 {
			if emit == nil || hasACPCurrentModeUpdatedEvent(events) {
				a.emitSessionEvents(session.AgentSessionID, events)
			}
		}
		return events, nil
	case acpMethodPermission:
		// A permission callback is actionable only while the session/prompt call
		// that owns its canonical turn is active. The global client handler has no
		// normalizer; binding such a late callback to recentTurnID would reopen a
		// settled turn, while fabricating a synthetic turn would violate durable
		// turn ownership.
		if normalizer == nil || strings.TrimSpace(turnID) == "" {
			err := errors.New("permission request arrived outside an active prompt turn")
			slog.Warn("agent session ACP rejected permission outside active prompt",
				"event", "agent_session.acp.permission.turn_scope_missing",
				"provider", a.config.provider,
				"adapter", a.config.adapterName,
				"room_id", session.RoomID,
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", session.ProviderSessionID,
				"recent_turn_id", strings.TrimSpace(turnID),
				"request_id", rawMessageLogValue(message.ID),
			)
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32000, Message: err.Error()})
			return nil, err
		}
		// Automatic tiers resolve the request from the live permission tier
		// without prompting; the tool call still streams its own activity via
		// session/update.
		if decision := a.automaticPermissionDecision(session.AgentSessionID); decision != "" {
			if optionID, ok := acpPermissionRequestDecisionOptionID(
				message.Params,
				decision,
				a.config.filterPermissionOptions,
			); ok {
				if err := client.Respond(ctx, message.ID, acpPermissionResponseResult(optionID), nil); err != nil {
					slog.Warn("agent session ACP automatic permission response failed",
						"event", "agent_session.acp.permission.automatic_response_failed",
						"provider", a.config.provider,
						"adapter", a.config.adapterName,
						"room_id", session.RoomID,
						"agent_session_id", session.AgentSessionID,
						"provider_session_id", session.ProviderSessionID,
						"turn_id", turnID,
						"request_id", rawMessageLogValue(message.ID),
						"error", err.Error(),
					)
					return nil, err
				}
				return nil, nil
			}
		}
		events, pending, err := standardACPPermissionRequested(a, session, turnID, message.ID, message.Params, normalizer)
		if err != nil {
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32602, Message: err.Error()})
			return events, err
		}
		if len(events) > 0 && emit != nil {
			emit(events)
		}
		selection, err := pending.wait(ctx)
		if err != nil {
			pending.finish(pendingInteractiveRequestStateInterrupted)
			events := normalizedPermissionResolvedEvents(session, turnID, pending, pendingInteractiveResponse{}, err)
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32000, Message: err.Error()})
			return events, err
		}
		result := selection.result
		if result == nil {
			result = acpPermissionResponseResult(selection.optionID)
		}
		if err := client.Respond(ctx, message.ID, result, nil); err != nil {
			events := []activityshared.Event(nil)
			if pending.finish(pendingInteractiveRequestStateSuperseded) {
				events = normalizedPermissionResolvedEvents(session, turnID, pending, selection, err)
			}
			return events, err
		}
		if pending.finish(pendingInteractiveRequestStateAnswered) {
			events = normalizedPermissionResolvedEvents(session, turnID, pending, selection, nil)
		}
		return events, nil
	default:
		slog.Warn("agent session ACP ignored unsupported message",
			"event", "agent_session.acp.handle_message.unsupported",
			"provider", a.config.provider,
			"adapter", a.config.adapterName,
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"provider_session_id", session.ProviderSessionID,
			"turn_id", turnID,
			"message_method", message.Method,
			"message_id", rawMessageLogValue(message.ID),
		)
		if len(message.ID) > 0 {
			_ = client.Respond(ctx, message.ID, nil, &acpError{Code: -32601, Message: "method not supported"})
		}
		return nil, nil
	}
}

func (a *standardACPAdapter) standardACPUpdateMatchesProviderSession(session Session, raw json.RawMessage) bool {
	updateSessionID, ok := acpUpdateProviderSessionID(raw)
	if !ok {
		return true
	}
	liveSessionID := ""
	if acpSession := a.getSession(session.AgentSessionID); acpSession != nil {
		liveSessionID = strings.TrimSpace(acpSession.providerSessionID)
	}
	currentSessionID := firstNonEmptyString(liveSessionID, strings.TrimSpace(session.ProviderSessionID))
	if liveSessionID == "" && currentSessionID == strings.TrimSpace(session.AgentSessionID) {
		currentSessionID = ""
	}
	if currentSessionID == "" || updateSessionID == currentSessionID {
		return true
	}
	slog.Debug("agent session ACP ignored update for foreign provider session",
		"event", "agent_session.acp.update.foreign_provider_session_ignored",
		"provider", a.config.provider,
		"adapter", a.config.adapterName,
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"provider_session_id", currentSessionID,
		"update_provider_session_id", updateSessionID,
	)
	return false
}

func acpUpdateProviderSessionID(raw json.RawMessage) (string, bool) {
	var params struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return "", false
	}
	sessionID := strings.TrimSpace(params.SessionID)
	return sessionID, sessionID != ""
}

func (a *standardACPAdapter) SetConfigOptionsUpdateSink(sink ConfigOptionsUpdateSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.configSink = sink
	a.mu.Unlock()
}

func (a *standardACPAdapter) emitConfigOptionsUpdate(session Session, raw json.RawMessage) {
	configOptionKey, ok := acpConfigOptionsUpdateKey(raw)
	if !ok {
		return
	}
	a.mu.Lock()
	sink := a.configSink
	a.mu.Unlock()
	if sink == nil {
		return
	}
	update := AgentSessionConfigOptionsUpdate{
		RoomID:            session.RoomID,
		AgentSessionID:    session.AgentSessionID,
		Provider:          session.Provider,
		ProviderSessionID: session.ProviderSessionID,
		ConfigOptionKey:   configOptionKey,
		OccurredAtUnixMS:  unixMS(now()),
	}
	sink(update)
}

func (a *standardACPAdapter) emitSessionEvents(agentSessionID string, events []activityshared.Event) {
	if a == nil || len(events) == 0 {
		return
	}
	a.mu.Lock()
	sink := a.eventSink
	a.mu.Unlock()
	if sink == nil {
		return
	}
	sink(agentSessionID, events)
}

func activityEventTypeCounts(events []activityshared.Event) []string {
	if len(events) == 0 {
		return nil
	}
	out := make([]string, 0, len(events))
	for _, event := range events {
		out = append(out, string(event.Type))
	}
	return summarizeLogValueCounts(out)
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (a *standardACPAdapter) logHermesStartupDiagnostics(stage string, payload map[string]any) {
	if a == nil || !a.config.startupDiagnostics {
		return
	}
	if payload == nil {
		payload = map[string]any{}
	}
	payload["stage"] = stage
	payload["provider"] = a.config.provider
	payload["adapter"] = a.config.adapterName
	slog.Info("agent session Hermes startup diagnostics",
		"event", "agent_session.hermes_startup_diagnostics."+stage,
		"payload_json", jsonStringForLog(payload),
	)
}

func jsonStringForLog(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf(`{"marshal_error":%q}`, err.Error())
	}
	return string(raw)
}

func rawMessageLogValue(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return ""
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return strings.TrimSpace(asString)
	}
	return trimmed
}

func (a *standardACPAdapter) storeSession(agentSessionID string, session *standardACPSession) {
	a.mu.Lock()
	if session != nil && session.agentInfo == nil {
		session.agentInfo = map[string]any{}
	}
	if session != nil {
		session.ensureInitialized()
	}
	if session != nil && session.pendingApprovals == nil {
		session.pendingApprovals = make(map[string]*pendingACPApproval)
	}
	a.sessions[agentSessionID] = session
	a.mu.Unlock()
}

func (a *standardACPAdapter) getSession(agentSessionID string) *standardACPSession {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions[agentSessionID]
}

func (a *standardACPAdapter) rememberSessionTurn(agentSessionID string, turnID string) {
	turnID = strings.TrimSpace(turnID)
	if a == nil || turnID == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	acpSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if acpSession == nil {
		return
	}
	acpSession.recentTurnID = turnID
	acpSession.recentTurnExpiry = time.Now().Add(standardACPRecentTurnTTL)
}

func (a *standardACPAdapter) sessionRecentTurnID(agentSessionID string) string {
	if a == nil {
		return ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	acpSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if acpSession == nil || strings.TrimSpace(acpSession.recentTurnID) == "" {
		return ""
	}
	if !acpSession.recentTurnExpiry.IsZero() && time.Now().After(acpSession.recentTurnExpiry) {
		acpSession.recentTurnID = ""
		acpSession.recentTurnExpiry = time.Time{}
		return ""
	}
	return strings.TrimSpace(acpSession.recentTurnID)
}

func (a *standardACPAdapter) sessionConfigOptionMatches(agentSessionID string, configID string, value string) bool {
	if a == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session == nil {
		return false
	}
	return acpConfigOptionMatches(session.acpLiveState, configID, value)
}

func (a *standardACPAdapter) sessionConfigOptionAdvertisesValue(agentSessionID string, configID string, value string) bool {
	if a == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session == nil {
		return false
	}
	return acpConfigOptionAdvertisesValue(session.acpLiveState, configID, value)
}

func (a *standardACPAdapter) removeSession(agentSessionID string) {
	if a == nil {
		return
	}
	a.mu.Lock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	pending := make([]*pendingACPApproval, 0)
	if session != nil {
		for _, approval := range session.pendingApprovals {
			pending = append(pending, approval)
		}
	}
	a.mu.Unlock()
	for _, approval := range pending {
		approval.finish(pendingInteractiveRequestStateSuperseded)
	}
	a.mu.Lock()
	delete(a.sessions, strings.TrimSpace(agentSessionID))
	a.mu.Unlock()
}

func (a *standardACPAdapter) emitCommandSnapshot(snapshot AgentSessionCommandSnapshot) {
	if a == nil {
		return
	}
	a.mu.Lock()
	sink := a.commandSink
	a.mu.Unlock()
	if sink != nil {
		sink(snapshot)
	}
}

func (a *standardACPAdapter) SessionCommandSnapshot(session Session) (AgentSessionCommandSnapshot, bool) {
	if a == nil {
		return AgentSessionCommandSnapshot{}, false
	}
	a.mu.Lock()
	acpSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	if acpSession == nil {
		a.mu.Unlock()
		return AgentSessionCommandSnapshot{}, false
	}
	snapshot, ok := commandSnapshotFromACPLiveState(session.AgentSessionID, acpSession.acpLiveState)
	a.mu.Unlock()
	return snapshot, ok
}

func (a *standardACPAdapter) applyACPUpdate(agentSessionID string, raw json.RawMessage) *AgentSessionCommandSnapshot {
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session == nil {
		return nil
	}
	return applyACPUpdateToLiveState(&session.acpLiveState, agentSessionID, raw)
}

func (a *standardACPAdapter) storePendingApproval(pending *pendingACPApproval) {
	if a == nil || pending == nil {
		return
	}
	pending.onTerminal = a.recordTerminalInteractiveRequest
	a.mu.Lock()
	session := a.sessions[pending.agentSessionID]
	if session != nil {
		if session.pendingApprovals == nil {
			session.pendingApprovals = make(map[string]*pendingACPApproval)
		}
		session.pendingApprovals[strings.TrimSpace(pending.requestID)] = pending
	}
	a.mu.Unlock()
}

func (a *standardACPAdapter) recordTerminalInteractiveRequest(pending *pendingInteractiveRequest, state pendingInteractiveRequestState) {
	if a == nil || pending == nil {
		return
	}
	disposition := interactiveDispositionFromState(state)
	key := newInteractiveRequestKey(pending.agentSessionID, pending.turnID, pending.requestID)
	a.mu.Lock()
	if session := a.sessions[key.agentSessionID]; session != nil && session.pendingApprovals != nil {
		if session.pendingApprovals[key.requestID] == pending {
			delete(session.pendingApprovals, key.requestID)
		}
	}
	a.terminalInteractions.put(key, disposition)
	sink := a.interactiveDispositionSink
	a.mu.Unlock()
	if sink != nil {
		sink(key.agentSessionID, key.turnID, key.requestID, disposition)
	}
}

func (a *standardACPAdapter) SetInteractiveDispositionSink(sink InteractiveDispositionSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.interactiveDispositionSink = sink
	a.mu.Unlock()
}

func (a *standardACPAdapter) terminalInteractiveDisposition(agentSessionID string, turnID string, requestID string) InteractiveDisposition {
	if a == nil {
		return InteractiveDispositionUnknown
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.terminalInteractions.get(newInteractiveRequestKey(agentSessionID, turnID, requestID))
}

func (a *standardACPAdapter) rejectPendingApprovals(agentSessionID string, err error) {
	if a == nil {
		return
	}
	a.mu.Lock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	pending := make([]*pendingACPApproval, 0)
	if session != nil && session.pendingApprovals != nil {
		for _, approval := range session.pendingApprovals {
			state := approval.disposition()
			if state == pendingInteractiveRequestStatePending || state == pendingInteractiveRequestStateResolving {
				pending = append(pending, approval)
			}
		}
	}
	a.mu.Unlock()
	for _, approval := range pending {
		approval.reject(err)
	}
}

func (a *standardACPAdapter) getPendingApproval(agentSessionID string, turnID string, requestID string) *pendingACPApproval {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session == nil || session.pendingApprovals == nil {
		return nil
	}
	pending := session.pendingApprovals[strings.TrimSpace(requestID)]
	if pending == nil || strings.TrimSpace(pending.turnID) != strings.TrimSpace(turnID) {
		return nil
	}
	return pending
}
