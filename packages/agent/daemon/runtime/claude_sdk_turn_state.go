package agentruntime

import "strings"

// turnAlreadySettled reports whether a terminal event for the turn already
// left this adapter.
func (a *ClaudeCodeSDKAdapter) turnAlreadySettled(adapterSession *claudeSDKAdapterSession, turnID string) bool {
	if a == nil || adapterSession == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	_, settled := adapterSession.settledTurns[strings.TrimSpace(turnID)]
	return settled
}

func (a *ClaudeCodeSDKAdapter) markClaudeSDKTurnClosed(adapterSession *claudeSDKAdapterSession, turnID string, outcome string) {
	if a == nil || adapterSession == nil || strings.TrimSpace(turnID) == "" {
		return
	}
	a.mu.Lock()
	if adapterSession.settledTurns == nil {
		adapterSession.settledTurns = make(map[string]string)
	}
	adapterSession.settledTurns[strings.TrimSpace(turnID)] = strings.TrimSpace(outcome)
	a.mu.Unlock()
}
