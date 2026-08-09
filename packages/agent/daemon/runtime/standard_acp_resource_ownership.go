package agentruntime

import (
	"errors"
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
