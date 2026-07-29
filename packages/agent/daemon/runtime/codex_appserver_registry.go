package agentruntime

import "strings"

func (a *CodexAppServerAdapter) lockSessionLifecycle(agentSessionID string) func() {
	if a == nil {
		return func() {}
	}
	key := strings.TrimSpace(agentSessionID)
	a.lifecycleMu.Lock()
	lock := a.lifecycleLocks[key]
	if lock == nil {
		lock = &codexAppServerSessionLock{}
		a.lifecycleLocks[key] = lock
	}
	lock.refs++
	a.lifecycleMu.Unlock()

	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()
		a.lifecycleMu.Lock()
		lock.refs--
		if lock.refs <= 0 && a.lifecycleLocks[key] == lock {
			delete(a.lifecycleLocks, key)
		}
		a.lifecycleMu.Unlock()
	}
}

func (a *CodexAppServerAdapter) storeSession(agentSessionID string, session *codexAppServerSession) {
	a.mu.Lock()
	if session != nil {
		session.ensureInitialized()
		if session.serverInfo == nil {
			session.serverInfo = map[string]any{}
		}
		if session.pendingRequests == nil {
			session.pendingRequests = make(map[string]*pendingInteractiveRequest)
		}
	}
	key := strings.TrimSpace(agentSessionID)
	// Replacing a stored session must never orphan its app-server process:
	// when the new entry does not carry the existing client forward, that
	// client (and its OS process) would otherwise leak without an owner.
	var replacedClient *codexAppServerClient
	if existing := a.sessions[key]; existing != nil && existing != session && existing.client != nil &&
		(session == nil || existing.client != session.client) {
		replacedClient = existing.client
	}
	a.sessions[key] = session
	a.mu.Unlock()
	if replacedClient != nil {
		_ = replacedClient.Close()
	}
}

func (a *CodexAppServerAdapter) removeSession(agentSessionID string) {
	if a == nil {
		return
	}
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	pending := make([]*pendingInteractiveRequest, 0)
	if appSession != nil {
		for _, request := range appSession.pendingRequests {
			pending = append(pending, request)
		}
	}
	a.mu.Unlock()
	for _, request := range pending {
		request.supersede(errPermissionRequestCanceled)
	}
	a.mu.Lock()
	delete(a.sessions, strings.TrimSpace(agentSessionID))
	a.mu.Unlock()
}

// invalidateSessionClient removes and closes only the client that failed its
// turn/start acknowledgement. The identity check prevents a late failure from
// closing a replacement process that another lifecycle operation installed.
func (a *CodexAppServerAdapter) invalidateSessionClient(
	agentSessionID string,
	expectedClient *codexAppServerClient,
) bool {
	if a == nil || expectedClient == nil {
		return false
	}
	key := strings.TrimSpace(agentSessionID)
	a.mu.Lock()
	appSession := a.sessions[key]
	if appSession == nil || appSession.client != expectedClient {
		a.mu.Unlock()
		return false
	}
	pending := make([]*pendingInteractiveRequest, 0, len(appSession.pendingRequests))
	for _, request := range appSession.pendingRequests {
		pending = append(pending, request)
	}
	delete(a.sessions, key)
	a.mu.Unlock()

	for _, request := range pending {
		request.supersede(errPermissionRequestCanceled)
	}
	_ = expectedClient.Close()
	return true
}

func (a *CodexAppServerAdapter) getSession(agentSessionID string) *codexAppServerSession {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessions[strings.TrimSpace(agentSessionID)]
}

func (a *CodexAppServerAdapter) beginActiveTurn(
	agentSessionID string,
	turn *codexAppServerActiveTurn,
) bool {
	if a == nil || turn == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil || appSession.activeTurn != nil {
		return false
	}
	canonicalTurnID := strings.TrimSpace(turn.turnID)
	if appSession.canceledRootTurnID != "" && canonicalTurnID != appSession.canceledRootTurnID {
		appSession.canceledRootTurnID = ""
		appSession.canceledProviderThreads = nil
	}
	if canonicalTurnID != "" {
		appSession.lastCanonicalTurnID = canonicalTurnID
	}
	appSession.activeTurn = turn
	return true
}

func (a *CodexAppServerAdapter) endActiveTurn(agentSessionID string, turn *codexAppServerActiveTurn) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil || appSession.activeTurn != turn {
		return
	}
	providerTurnID := strings.TrimSpace(appSession.activeTurnID)
	appSession.activeTurn = nil
	appSession.activeTurnID = ""
	appSession.activeTurnStartConfirmed = false
	if providerTurnID != "" {
		delete(appSession.goalTurnEvidence, providerTurnID)
	}
	a.pruneGoalProvenanceLocked(appSession)
}

func (a *CodexAppServerAdapter) sessionActiveTurn(agentSessionID string) *codexAppServerActiveTurn {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return nil
	}
	return appSession.activeTurn
}

func (a *CodexAppServerAdapter) sessionActiveTurnID(agentSessionID string) string {
	if a == nil {
		return ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return ""
	}
	return strings.TrimSpace(appSession.activeTurnID)
}

func (a *CodexAppServerAdapter) requestActiveTurnCancel(agentSessionID string) (string, bool) {
	if a == nil {
		return "", false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return "", false
	}
	if activeTurnID := strings.TrimSpace(appSession.activeTurnID); activeTurnID != "" {
		if appSession.activeTurn != nil {
			appSession.activeTurn.phase = codexAppServerTurnPhaseInterrupting
		}
		return activeTurnID, false
	}
	if appSession.activeTurn == nil {
		return "", false
	}
	if appSession.activeTurn.ctx != nil && appSession.activeTurn.ctx.Err() != nil {
		return "", false
	}
	appSession.activeTurn.cancelRequested = true
	appSession.activeTurn.phase = codexAppServerTurnPhaseInterrupting
	return "", true
}

func (a *CodexAppServerAdapter) setSessionActiveTurnID(
	agentSessionID string,
	expectedTurn *codexAppServerActiveTurn,
	turnID string,
) bool {
	if a == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	// A fast terminal notification can settle and clear this turn before the
	// turn/start RPC result reaches its caller. Do not let that stale result
	// rebind the provider id after the slot is already empty or reused.
	if appSession != nil && appSession.activeTurn == expectedTurn {
		appSession.activeTurnID = strings.TrimSpace(turnID)
		if expectedTurn != nil {
			expectedTurn.providerTurnID = appSession.activeTurnID
		}
		// The binding starts unconfirmed; a matching turn/started notification
		// confirms it via confirmSessionActiveTurnStarted.
		appSession.activeTurnStartConfirmed = false
		if appSession.activeTurn != nil &&
			appSession.activeTurnID != "" &&
			appSession.activeTurn.cancelRequested &&
			!appSession.activeTurn.cancelInterruptSent {
			appSession.activeTurn.cancelInterruptSent = true
			return true
		}
	}
	return false
}

// confirmSessionActiveTurnStarted marks the recorded provider turn id as
// confirmed by a turn/started notification. Stub ids from a steered
// turn/start never receive turn/started, so they stay unconfirmed and the
// settle path may adopt the running turn's terminal for them. The
// confirmation is scoped to the turn the notification named: a concurrent
// rebinding (steered turn/start racing the read loop) must not get its stub
// id confirmed by another turn's start.
func (a *CodexAppServerAdapter) confirmSessionActiveTurnStarted(agentSessionID string, providerTurnID string) {
	if a == nil {
		return
	}
	providerTurnID = strings.TrimSpace(providerTurnID)
	if providerTurnID == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession != nil && strings.TrimSpace(appSession.activeTurnID) == providerTurnID {
		appSession.activeTurnStartConfirmed = true
	}
}

func (a *CodexAppServerAdapter) sessionActiveTurnStartConfirmed(agentSessionID string) bool {
	if a == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	return appSession != nil && appSession.activeTurnStartConfirmed
}

// sessionMarkerTurnID resolves the turn id to stamp on child lifecycle
// markers: the active turn when one is running, else the last settled turn.
func (a *CodexAppServerAdapter) sessionMarkerTurnID(agentSessionID string) string {
	if a == nil {
		return ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return ""
	}
	if appSession.activeTurn != nil && strings.TrimSpace(appSession.activeTurn.turnID) != "" {
		return strings.TrimSpace(appSession.activeTurn.turnID)
	}
	return strings.TrimSpace(appSession.lastCanonicalTurnID)
}

func (a *CodexAppServerAdapter) markRootTurnCanceled(agentSessionID string, rootTurnID string) {
	if a == nil {
		return
	}
	agentSessionID = strings.TrimSpace(agentSessionID)
	rootTurnID = strings.TrimSpace(rootTurnID)
	if agentSessionID == "" || rootTurnID == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[agentSessionID]
	if appSession == nil {
		return
	}
	appSession.canceledRootTurnID = rootTurnID
	if appSession.canceledProviderThreads == nil {
		appSession.canceledProviderThreads = make(map[string]struct{})
	}
}

func (a *CodexAppServerAdapter) rootTurnCanceled(agentSessionID string) (string, bool) {
	if a == nil {
		return "", false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return "", false
	}
	rootTurnID := strings.TrimSpace(appSession.canceledRootTurnID)
	return rootTurnID, rootTurnID != ""
}

func (a *CodexAppServerAdapter) canceledProviderThread(agentSessionID string, providerThreadID string) bool {
	if a == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil || appSession.canceledProviderThreads == nil {
		return false
	}
	_, ok := appSession.canceledProviderThreads[strings.TrimSpace(providerThreadID)]
	return ok
}

func (a *CodexAppServerAdapter) storePendingRequest(pending *pendingInteractiveRequest) {
	if a == nil || pending == nil {
		return
	}
	pending.onTerminal = a.recordTerminalInteractiveRequest
	a.mu.Lock()
	_, appSession := a.appServerSessionForAgentSessionIDLocked(pending.agentSessionID)
	if appSession != nil {
		if appSession.pendingRequests == nil {
			appSession.pendingRequests = make(map[string]*pendingInteractiveRequest)
		}
		appSession.pendingRequests[strings.TrimSpace(pending.requestID)] = pending
	}
	a.mu.Unlock()
}

func (a *CodexAppServerAdapter) getPendingRequest(agentSessionID string, turnID string, requestID string) *pendingInteractiveRequest {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	_, appSession := a.appServerSessionForAgentSessionIDLocked(agentSessionID)
	if appSession == nil || appSession.pendingRequests == nil {
		return nil
	}
	pending := appSession.pendingRequests[strings.TrimSpace(requestID)]
	if pending == nil || strings.TrimSpace(pending.agentSessionID) != strings.TrimSpace(agentSessionID) ||
		strings.TrimSpace(pending.turnID) != strings.TrimSpace(turnID) {
		return nil
	}
	return pending
}

func (a *CodexAppServerAdapter) recordTerminalInteractiveRequest(pending *pendingInteractiveRequest, state pendingInteractiveRequestState) {
	if a == nil || pending == nil {
		return
	}
	disposition := interactiveDispositionFromState(state)
	key := newInteractiveRequestKey(pending.agentSessionID, pending.turnID, pending.requestID)
	a.mu.Lock()
	_, appSession := a.appServerSessionForAgentSessionIDLocked(key.agentSessionID)
	if appSession != nil && appSession.pendingRequests != nil {
		if appSession.pendingRequests[key.requestID] == pending {
			delete(appSession.pendingRequests, key.requestID)
		}
	}
	a.terminalInteractions.put(key, disposition)
	sink := a.interactiveDispositionSink
	a.mu.Unlock()
	if sink != nil {
		sink(key.agentSessionID, key.turnID, key.requestID, disposition)
	}
}

// appServerSessionForAgentSessionIDLocked resolves a canonical child session
// to the root app-server session that owns the shared provider connection.
// Durable child state remains outside the adapter; this is only a runtime
// handle lookup and must be called with a.mu held.
func (a *CodexAppServerAdapter) appServerSessionForAgentSessionIDLocked(agentSessionID string) (string, *codexAppServerSession) {
	agentSessionID = strings.TrimSpace(agentSessionID)
	if appSession := a.sessions[agentSessionID]; appSession != nil {
		return agentSessionID, appSession
	}
	for rootAgentSessionID, appSession := range a.sessions {
		if appSession == nil {
			continue
		}
		for _, child := range appSession.childThreads {
			if child != nil && strings.TrimSpace(child.agentSessionID) == agentSessionID {
				return rootAgentSessionID, appSession
			}
		}
	}
	return "", nil
}

func (a *CodexAppServerAdapter) SetInteractiveDispositionSink(sink InteractiveDispositionSink) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.interactiveDispositionSink = sink
	a.mu.Unlock()
}

func (a *CodexAppServerAdapter) terminalInteractiveDisposition(agentSessionID string, turnID string, requestID string) InteractiveDisposition {
	if a == nil {
		return InteractiveDispositionUnknown
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.terminalInteractions.get(newInteractiveRequestKey(agentSessionID, turnID, requestID))
}

func (a *CodexAppServerAdapter) hasLiveSessionWork(agentSessionID string) bool {
	if a == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return false
	}
	for _, pending := range appSession.pendingRequests {
		state := pending.disposition()
		if state == pendingInteractiveRequestStatePending || state == pendingInteractiveRequestStateResolving {
			return true
		}
	}
	return appSession.activeTurn != nil || strings.TrimSpace(appSession.activeTurnID) != ""
}

func (a *CodexAppServerAdapter) rejectPendingRequests(agentSessionID string, err error) {
	if a == nil {
		return
	}
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	pending := make([]*pendingInteractiveRequest, 0)
	if appSession != nil && appSession.pendingRequests != nil {
		for _, request := range appSession.pendingRequests {
			pending = append(pending, request)
		}
	}
	a.mu.Unlock()
	for _, request := range pending {
		request.reject(err)
	}
}

func (a *CodexAppServerAdapter) emitCommandSnapshot(snapshot AgentSessionCommandSnapshot) {
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
