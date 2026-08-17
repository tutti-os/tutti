package agentruntime

import (
	"context"
	"errors"
	"sort"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *ClaudeCodeSDKAdapter) failAllClaudeSDKRootProviderTurns(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	err error,
) []activityshared.Event {
	if a == nil || adapterSession == nil {
		return nil
	}
	a.mu.Lock()
	rootTurnID := strings.TrimSpace(adapterSession.rootTurnID)
	providerTurnIDs := make([]string, 0, len(adapterSession.rootProviderTurns))
	for providerTurnID := range adapterSession.rootProviderTurns {
		providerTurnID = strings.TrimSpace(providerTurnID)
		if providerTurnID != "" {
			providerTurnIDs = append(providerTurnIDs, providerTurnID)
		}
	}
	adapterSession.rootProviderTurns = make(map[string]struct{})
	a.mu.Unlock()
	if rootTurnID == "" || len(providerTurnIDs) == 0 {
		return nil
	}
	sort.Strings(providerTurnIDs)
	metadata := map[string]any{"adapter": claudeSDKSidecarAdapterName}
	if err != nil {
		metadata["error"] = err.Error()
	}
	events := make([]activityshared.Event, 0, len(providerTurnIDs))
	for _, providerTurnID := range providerTurnIDs {
		events = append(events, claudeSDKRootProviderTurnCompletedEvent(
			session,
			rootTurnID,
			providerTurnID,
			activityshared.TurnOutcomeFailed,
			metadata,
		))
	}
	return events
}

func (a *ClaudeCodeSDKAdapter) lockClaudeSDKSessionLifecycle(agentSessionID string) func() {
	if a == nil {
		return func() {}
	}
	key := strings.TrimSpace(agentSessionID)
	a.lifecycleMu.Lock()
	lock := a.lifecycleLocks[key]
	if lock == nil {
		lock = &claudeSDKSessionLock{}
		a.lifecycleLocks[key] = lock
	}
	lock.refs++
	a.lifecycleMu.Unlock()
	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()
		a.lifecycleMu.Lock()
		lock.refs--
		if lock.refs == 0 && a.lifecycleLocks[key] == lock {
			delete(a.lifecycleLocks, key)
		}
		a.lifecycleMu.Unlock()
	}
}

func claudeSDKProcessCleanupPendingError(cause error) error {
	debugMessage := "an earlier Claude sidecar process is still shutting down"
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

func (a *ClaudeCodeSDKAdapter) retainRetiredClaudeSDKSession(agentSessionID string, session *claudeSDKAdapterSession) {
	if a == nil || session == nil || session.conn == nil {
		return
	}
	agentSessionID = strings.TrimSpace(agentSessionID)
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.retiredSessions == nil {
		a.retiredSessions = make(map[string][]*claudeSDKAdapterSession)
	}
	session.invalid = true
	for _, retained := range a.retiredSessions[agentSessionID] {
		if retained == session || (retained != nil && retained.conn == session.conn) {
			return
		}
	}
	a.retiredSessions[agentSessionID] = append(a.retiredSessions[agentSessionID], session)
}

func (a *ClaudeCodeSDKAdapter) closeOrRetainClaudeSDKSession(agentSessionID string, session *claudeSDKAdapterSession) {
	if session == nil || session.conn == nil {
		return
	}
	if err := session.conn.Close(); err != nil {
		a.retainRetiredClaudeSDKSession(agentSessionID, session)
	}
}

func (a *ClaudeCodeSDKAdapter) hasRetiredClaudeSDKSessions(agentSessionID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.retiredSessions[strings.TrimSpace(agentSessionID)]) > 0
}

func (a *ClaudeCodeSDKAdapter) admitClaudeSDKReplacementLocked(agentSessionID string) error {
	if !a.hasRetiredClaudeSDKSessions(agentSessionID) {
		return nil
	}
	_, err := a.retryOneClaudeSDKSessionLocked(agentSessionID)
	if err != nil {
		return claudeSDKProcessCleanupPendingError(err)
	}
	if a.hasRetiredClaudeSDKSessions(agentSessionID) {
		return claudeSDKProcessCleanupPendingError(errors.New("multiple earlier Claude sidecar processes still require cleanup"))
	}
	return nil
}

func (a *ClaudeCodeSDKAdapter) retryOneClaudeSDKSession(agentSessionID string) (bool, error) {
	if a == nil {
		return false, nil
	}
	agentSessionID = strings.TrimSpace(agentSessionID)
	a.mu.Lock()
	if agentSessionID == "" {
		for candidate, current := range a.sessions {
			if current != nil && current.conn != nil && current.invalid {
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
	unlock := a.lockClaudeSDKSessionLifecycle(agentSessionID)
	defer unlock()
	return a.retryOneClaudeSDKSessionLocked(agentSessionID)
}

func (a *ClaudeCodeSDKAdapter) retryOneClaudeSDKSessionLocked(agentSessionID string) (bool, error) {
	a.mu.Lock()
	current := a.sessions[agentSessionID]
	if current != nil && current.conn != nil && current.invalid {
		a.mu.Unlock()
		if err := current.conn.Close(); err != nil {
			return true, err
		}
		a.removeSession(agentSessionID, current)
		return true, nil
	}
	retired := a.retiredSessions[agentSessionID]
	var target *claudeSDKAdapterSession
	for _, candidate := range retired {
		if candidate != nil {
			target = candidate
			break
		}
	}
	a.mu.Unlock()
	if target == nil {
		return false, nil
	}
	if err := target.conn.Close(); err != nil {
		return true, err
	}
	a.removeRetiredClaudeSDKSession(agentSessionID, target)
	return true, nil
}

func (a *ClaudeCodeSDKAdapter) removeRetiredClaudeSDKSession(agentSessionID string, target *claudeSDKAdapterSession) {
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

func (a *ClaudeCodeSDKAdapter) CleanupLiveSessionResources(ctx context.Context, limit int) LiveSessionResourceCleanupResult {
	var result LiveSessionResourceCleanupResult
	if limit <= 0 {
		return result
	}
	select {
	case <-ctx.Done():
		return result
	default:
	}
	attempted, err := a.retryOneClaudeSDKSession("")
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
