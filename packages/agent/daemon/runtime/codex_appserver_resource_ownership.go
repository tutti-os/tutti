package agentruntime

import (
	"context"
	"errors"
	"strings"
)

func codexProcessCleanupPendingError(cause error) error {
	debugMessage := "an earlier app-server process is still shutting down"
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

func (a *CodexAppServerAdapter) retainRetiredCodexSession(agentSessionID string, session *codexAppServerSession) {
	if a == nil || session == nil || session.client == nil {
		return
	}
	agentSessionID = strings.TrimSpace(agentSessionID)
	session.client.SetMessageHandler(nil)
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.retiredSessions == nil {
		a.retiredSessions = make(map[string][]*codexAppServerSession)
	}
	session.releasing = false
	session.releaseFailed = true
	for _, retained := range a.retiredSessions[agentSessionID] {
		if retained == session || (retained != nil && retained.client == session.client) {
			return
		}
	}
	a.retiredSessions[agentSessionID] = append(a.retiredSessions[agentSessionID], session)
}

func (a *CodexAppServerAdapter) closeOrRetainCodexSession(agentSessionID string, session *codexAppServerSession) {
	if session == nil || session.client == nil {
		return
	}
	session.client.SetMessageHandler(nil)
	if err := session.client.Close(); err != nil {
		a.retainRetiredCodexSession(agentSessionID, session)
	}
}

func (a *CodexAppServerAdapter) hasRetiredCodexSessions(agentSessionID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.retiredSessions[strings.TrimSpace(agentSessionID)]) > 0
}

// One close-failed current handle gets one replacement attempt. Once that
// replacement succeeds the old handle is retired, and later replacements are
// backpressured until one bounded cleanup attempt confirms closure.
func (a *CodexAppServerAdapter) admitCodexReplacementLocked(agentSessionID string) error {
	if !a.hasRetiredCodexSessions(agentSessionID) {
		return nil
	}
	_, err := a.retryOneCodexSessionLocked(agentSessionID)
	if err != nil {
		return codexProcessCleanupPendingError(err)
	}
	if a.hasRetiredCodexSessions(agentSessionID) {
		return codexProcessCleanupPendingError(errors.New("multiple earlier app-server processes still require cleanup"))
	}
	return nil
}

func (a *CodexAppServerAdapter) retryOneCodexSession(agentSessionID string) (bool, error) {
	if a == nil {
		return false, nil
	}
	agentSessionID = strings.TrimSpace(agentSessionID)
	a.mu.Lock()
	if agentSessionID == "" {
		for candidate, current := range a.sessions {
			if current != nil && current.client != nil && current.releaseFailed && !current.releasing {
				agentSessionID = candidate
				break
			}
		}
		if agentSessionID == "" {
			for candidate, retired := range a.retiredSessions {
				if len(retired) > 0 {
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
	unlock := a.lockSessionLifecycle(agentSessionID)
	defer unlock()
	return a.retryOneCodexSessionLocked(agentSessionID)
}

func (a *CodexAppServerAdapter) retryOneCodexSessionLocked(agentSessionID string) (bool, error) {
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
	var target *codexAppServerSession
	for _, candidate := range retired {
		if candidate != nil && !candidate.releasing {
			target = candidate
			break
		}
	}
	if target == nil {
		a.mu.Unlock()
		return false, nil
	}
	target.releasing = true
	target.client.SetMessageHandler(nil)
	a.mu.Unlock()
	if err := target.client.Close(); err != nil {
		a.mu.Lock()
		target.releasing = false
		a.mu.Unlock()
		return true, err
	}
	a.removeRetiredCodexSession(agentSessionID, target)
	return true, nil
}

func (a *CodexAppServerAdapter) removeRetiredCodexSession(agentSessionID string, target *codexAppServerSession) {
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

func (a *CodexAppServerAdapter) CleanupLiveSessionResources(ctx context.Context, limit int) LiveSessionResourceCleanupResult {
	var result LiveSessionResourceCleanupResult
	if limit <= 0 {
		return result
	}
	select {
	case <-ctx.Done():
		return result
	default:
	}
	attempted, err := a.retryOneCodexSession("")
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
