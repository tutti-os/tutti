package agentruntime

import (
	"context"
	"errors"
	"log/slog"
	"strings"
)

func (a *standardACPAdapter) retainRetiredSession(agentSessionID string, session *standardACPSession) {
	if a == nil || session == nil || session.client == nil {
		return
	}
	agentSessionID = strings.TrimSpace(agentSessionID)
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.retiredSessions == nil {
		a.retiredSessions = make(map[string][]*standardACPSession)
	}
	for _, retained := range a.retiredSessions[agentSessionID] {
		if retained == session || (retained != nil && retained.client == session.client) {
			return
		}
	}
	a.retiredSessions[agentSessionID] = append(a.retiredSessions[agentSessionID], session)
}

func (a *standardACPAdapter) closeOrRetainSession(session Session, acpSession *standardACPSession) {
	if a == nil || acpSession == nil || acpSession.client == nil {
		return
	}
	// Once ownership is being retired, no late provider frame may be attributed
	// to a replacement session or its recent Turn.
	acpSession.client.SetMessageHandler(nil)
	if err := acpSession.client.Close(); err != nil {
		a.retainRetiredSession(session.AgentSessionID, acpSession)
		a.logACPCloseDiagnostics("failed_client.transport_close.failed", session, acpSession, err)
		return
	}
	a.logACPCloseDiagnostics("failed_client.transport_close.succeeded", session, acpSession, nil)
}

func (a *standardACPAdapter) hasRetiredSessionsLocked(agentSessionID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.retiredSessions[strings.TrimSpace(agentSessionID)]) > 0
}

func (*standardACPAdapter) processCleanupPendingError(cause error) error {
	debugMessage := "an earlier ACP process is still shutting down"
	if cause != nil {
		debugMessage = cause.Error()
	}
	return &AppError{
		Code:         AppErrorProcessCleanupPending,
		Message:      "agent process cleanup is still pending",
		DebugMessage: debugMessage,
		Cause:        cause,
	}
}

// admitReplacementLocked applies bounded backpressure before another process
// is spawned. A failed current release is allowed one replacement attempt; it
// becomes retired when that replacement succeeds. From then on, each user
// retry spends at most one Close budget and starts no process while any retired
// handle remains owned by the adapter.
func (a *standardACPAdapter) admitReplacementLocked(agentSessionID string) error {
	agentSessionID = strings.TrimSpace(agentSessionID)
	if !a.hasRetiredSessionsLocked(agentSessionID) {
		return nil
	}
	_, err := a.retryOneTrackedSessionLocked(agentSessionID)
	if err != nil {
		return a.processCleanupPendingError(err)
	}
	if a.hasRetiredSessionsLocked(agentSessionID) {
		return a.processCleanupPendingError(errors.New("multiple earlier ACP processes still require cleanup"))
	}
	return nil
}

func (a *standardACPAdapter) isUsableCurrentClient(agentSessionID string, client *acpClient) bool {
	if a == nil || client == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	current := a.sessions[strings.TrimSpace(agentSessionID)]
	return current != nil && current.client == client && !current.releasing && !current.releaseFailed
}

func (a *standardACPAdapter) hasTrackedLiveSession(session Session) bool {
	if a == nil {
		return false
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	a.mu.Lock()
	defer a.mu.Unlock()
	current := a.sessions[agentSessionID]
	return (current != nil && current.client != nil) || len(a.retiredSessions[agentSessionID]) > 0
}

func (a *standardACPAdapter) CanReleaseLiveSession(session Session) bool {
	if a == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	acpSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	// Let the live-session probe classify an already released session as not
	// live. A live process is releasable only when its handshake proved that
	// the provider session can be restored by a replacement process.
	return acpSession == nil || acpSession.client == nil || strings.TrimSpace(acpSession.resumeMethod) != ""
}

// ReleaseLiveSession disconnects the ACP transport without sending
// session/close. The latter is a destructive provider-history operation for
// providers that implement it and therefore cannot be used by idle
// reprepare/reconnect flows.
func (a *standardACPAdapter) ReleaseLiveSession(_ context.Context, session Session) error {
	if a == nil || a.transport == nil {
		return nil
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	unlockLifecycle := a.lockSessionLifecycle(agentSessionID)
	defer unlockLifecycle()

	a.mu.Lock()
	acpSession := a.sessions[agentSessionID]
	if acpSession == nil || acpSession.client == nil {
		a.mu.Unlock()
		return nil
	}
	if strings.TrimSpace(acpSession.resumeMethod) == "" {
		a.mu.Unlock()
		return errors.New("ACP live session cannot be released without resume support")
	}
	for _, approval := range acpSession.pendingApprovals {
		if approval == nil {
			continue
		}
		state := approval.disposition()
		if state == pendingInteractiveRequestStatePending || state == pendingInteractiveRequestStateResolving {
			a.mu.Unlock()
			return ErrLiveSessionBusy
		}
	}
	acpSession.releasing = true
	acpSession.client.SetMessageHandler(nil)
	a.mu.Unlock()

	// Do not send session/close here: the durable provider session id must stay
	// valid so the next Exec can start a new CLI process and load/resume it.
	if err := acpSession.client.Close(); err != nil {
		a.mu.Lock()
		if a.sessions[agentSessionID] == acpSession {
			acpSession.releasing = false
			acpSession.releaseFailed = true
		}
		a.mu.Unlock()
		a.logACPCloseDiagnostics("live_release.transport_close.failed", session, acpSession, err)
		return err
	}
	a.mu.Lock()
	if a.sessions[agentSessionID] == acpSession {
		delete(a.sessions, agentSessionID)
	}
	a.mu.Unlock()
	a.logACPCloseDiagnostics("live_release.succeeded", session, acpSession, nil)
	return nil
}

func (a *standardACPAdapter) Close(ctx context.Context, session Session) error {
	if a == nil || a.transport == nil {
		return nil
	}
	agentSessionID := strings.TrimSpace(session.AgentSessionID)
	unlockLifecycle := a.lockSessionLifecycle(agentSessionID)
	defer unlockLifecycle()
	a.rejectPendingApprovals(agentSessionID, errPermissionRequestCanceled)
	a.mu.Lock()
	acpSession := a.sessions[agentSessionID]
	delete(a.sessions, agentSessionID)
	a.mu.Unlock()
	if acpSession != nil && acpSession.client != nil {
		a.closeProviderSession(ctx, session, acpSession)
		acpSession.client.SetMessageHandler(nil)
		closeErr := acpSession.client.Close()
		if closeErr != nil {
			a.logACPCloseDiagnostics("transport_close.failed", session, acpSession, closeErr)
			a.retainRetiredSession(agentSessionID, acpSession)
		} else {
			a.logACPCloseDiagnostics("closed", session, acpSession, nil)
		}
		return closeErr
	}
	return nil
}

func (a *standardACPAdapter) closeProviderSession(ctx context.Context, session Session, acpSession *standardACPSession) {
	if a == nil || acpSession == nil || acpSession.client == nil || !acpSession.sessionClose {
		return
	}
	providerSessionID := strings.TrimSpace(firstNonEmptyString(acpSession.providerSessionID, session.ProviderSessionID))
	if providerSessionID == "" {
		a.logACPCloseDiagnostics("protocol_close.skipped_missing_session_id", session, acpSession, nil)
		return
	}
	params := map[string]any{"sessionId": providerSessionID}
	if _, err := acpSession.client.CallNoHandlerWithTimeout(ctx, acpCloseCallTimeout, acpMethodCloseSession, params); err != nil {
		a.logACPCloseDiagnostics("protocol_close.failed", session, acpSession, err)
		return
	}
	a.logACPCloseDiagnostics("protocol_close.succeeded", session, acpSession, nil)
	a.waitForACPClientDone(acpSession.client, acpCloseGraceTimeout)
}

func (a *standardACPAdapter) closeReplacedSession(agentSessionID string, previousSession *standardACPSession, currentClient *acpClient) {
	if previousSession == nil || previousSession.client == nil || previousSession.client == currentClient {
		return
	}
	previousSession.client.SetMessageHandler(nil)
	if err := previousSession.client.Close(); err != nil {
		a.retainRetiredSession(agentSessionID, previousSession)
		slog.Warn("agent session ACP replaced client close failed",
			"event", "agent_session.acp.replaced_client.close_failed",
			"provider", a.config.provider,
			"error", err.Error(),
		)
	}
}

func (a *standardACPAdapter) retryOneTrackedSession(agentSessionID string) (bool, error) {
	if a == nil {
		return false, nil
	}
	agentSessionID = strings.TrimSpace(agentSessionID)
	a.mu.Lock()
	if agentSessionID == "" {
		for candidate, session := range a.sessions {
			if session != nil && session.client != nil && session.releaseFailed && !session.releasing {
				agentSessionID = candidate
				break
			}
		}
		if agentSessionID == "" {
			for candidate, sessions := range a.retiredSessions {
				if len(sessions) > 0 {
					agentSessionID = candidate
					break
				}
			}
		}
	}
	a.mu.Unlock()
	if agentSessionID == "" {
		return false, nil
	}
	unlockLifecycle := a.lockSessionLifecycle(agentSessionID)
	defer unlockLifecycle()
	return a.retryOneTrackedSessionLocked(agentSessionID)
}

func (a *standardACPAdapter) retryOneTrackedSessionLocked(agentSessionID string) (bool, error) {
	a.mu.Lock()
	current := a.sessions[agentSessionID]
	if current != nil && current.client != nil && current.releaseFailed && !current.releasing {
		current.releasing = true
		current.client.SetMessageHandler(nil)
		a.mu.Unlock()
		if err := current.client.Close(); err != nil {
			a.mu.Lock()
			if a.sessions[agentSessionID] == current {
				current.releasing = false
			}
			a.mu.Unlock()
			return true, err
		}
		a.mu.Lock()
		if a.sessions[agentSessionID] == current {
			delete(a.sessions, agentSessionID)
		}
		a.mu.Unlock()
		return true, nil
	}
	retired := a.retiredSessions[agentSessionID]
	var session *standardACPSession
	for _, candidate := range retired {
		if candidate != nil && !candidate.releasing {
			session = candidate
			break
		}
	}
	if session == nil {
		a.mu.Unlock()
		return false, nil
	}
	session.releasing = true
	if session.client != nil {
		session.client.SetMessageHandler(nil)
	}
	a.mu.Unlock()
	if session.client == nil {
		a.removeRetiredSession(agentSessionID, session)
		return true, nil
	}
	if err := session.client.Close(); err != nil {
		a.mu.Lock()
		session.releasing = false
		a.mu.Unlock()
		return true, err
	}
	a.removeRetiredSession(agentSessionID, session)
	return true, nil
}

func (a *standardACPAdapter) removeRetiredSession(agentSessionID string, target *standardACPSession) {
	a.mu.Lock()
	defer a.mu.Unlock()
	retired := a.retiredSessions[agentSessionID]
	for index, session := range retired {
		if session != target {
			continue
		}
		retired = append(retired[:index], retired[index+1:]...)
		if len(retired) == 0 {
			delete(a.retiredSessions, agentSessionID)
		} else {
			a.retiredSessions[agentSessionID] = retired
		}
		return
	}
}

func (a *standardACPAdapter) CleanupLiveSessionResources(ctx context.Context, limit int) LiveSessionResourceCleanupResult {
	var result LiveSessionResourceCleanupResult
	if limit <= 0 {
		return result
	}
	select {
	case <-ctx.Done():
		return result
	default:
	}
	attempted, err := a.retryOneTrackedSession("")
	if !attempted {
		return result
	}
	result.Attempted = 1
	if err != nil {
		result.Failed = 1
	} else {
		result.Cleaned = 1
	}
	return result
}
