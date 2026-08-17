package agentruntime

import (
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *ClaudeCodeSDKAdapter) isGoalClearControlTurn(
	adapterSession *claudeSDKAdapterSession,
	turnID string,
) bool {
	if a == nil || adapterSession == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	_, ok := adapterSession.goalClearControlTurns[strings.TrimSpace(turnID)]
	return ok
}

func (a *ClaudeCodeSDKAdapter) forgetGoalClearControlTurn(
	adapterSession *claudeSDKAdapterSession,
	turnID string,
) {
	if a == nil || adapterSession == nil {
		return
	}
	a.mu.Lock()
	delete(adapterSession.goalClearControlTurns, strings.TrimSpace(turnID))
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) restoreClaudeGoalArmIfCurrent(
	adapterSession *claudeSDKAdapterSession,
	operationID string,
	revision int64,
	repairEpoch int64,
	assignedArm string,
	previousArm string,
) {
	a.mu.Lock()
	defer a.mu.Unlock()
	currentOperationID := strings.TrimSpace(adapterSession.goalOperationID)
	operationID = strings.TrimSpace(operationID)
	identityMatches := operationID == "" && revision == 0 ||
		currentOperationID == operationID && adapterSession.goalRevision == revision && adapterSession.goalRepairEpoch == repairEpoch
	if identityMatches && adapterSession.goalArmTurnID == assignedArm {
		adapterSession.goalArmTurnID = previousArm
	}
}

// goalEventsOnArmTurnFailed rolls back the optimistic mirror only when the
// /goal arm command itself never completes. Ordinary terminal Turn events are
// not Goal evidence; only normalized provider Goal observations are.
func (a *ClaudeCodeSDKAdapter) goalEventsOnArmTurnFailed(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	turnID string,
) []activityshared.Event {
	trimmed := strings.TrimSpace(turnID)
	a.mu.Lock()
	goal := adapterSession.liveState.goal
	armTurnID := adapterSession.goalArmTurnID
	if len(goal) == 0 || asString(goal["status"]) != "active" {
		a.mu.Unlock()
		return nil
	}
	if armTurnID != "" && trimmed != armTurnID {
		// The queued /goal set has not run yet; this settle belongs to an
		// earlier turn and says nothing about the goal.
		a.mu.Unlock()
		return nil
	}
	if armTurnID != "" && trimmed == armTurnID {
		adapterSession.goalArmTurnID = ""
		adapterSession.liveState.goal = nil
		a.mu.Unlock()
		return a.goalMirrorEvents(session, "thread_goal_cleared")
	}
	a.mu.Unlock()
	return nil
}

func (a *ClaudeCodeSDKAdapter) forgetClaudeSDKPendingGoalCommand(
	adapterSession *claudeSDKAdapterSession,
	turnID string,
) {
	if a == nil || adapterSession == nil {
		return
	}
	a.mu.Lock()
	delete(adapterSession.pendingGoalCommands, strings.TrimSpace(turnID))
	a.mu.Unlock()
}

func (a *ClaudeCodeSDKAdapter) markClaudeSDKPendingGoalCommandStarted(
	adapterSession *claudeSDKAdapterSession,
	event claudeSDKSidecarEvent,
) {
	if a == nil || adapterSession == nil {
		return
	}
	turnID := strings.TrimSpace(payloadString(event.Payload, "turnId"))
	identity := goalOperationIdentity{
		operationID: strings.TrimSpace(payloadString(event.Payload, "operationId")),
		revision:    payloadInt64(event.Payload, "revision"),
		repairEpoch: payloadInt64(event.Payload, "repairEpoch"),
	}
	action := strings.TrimSpace(payloadString(event.Payload, "action"))
	a.mu.Lock()
	defer a.mu.Unlock()
	pending, ok := adapterSession.pendingGoalCommands[turnID]
	if !ok || pending.identity != identity || pending.action != action {
		return
	}
	pending.started = true
	adapterSession.pendingGoalCommands[turnID] = pending
}

// finishClaudeSDKPendingGoalCommandLocked closes the optimistic command
// transaction for one exact sidecar Turn. A successful provider observation or
// completion commits the mirror; cancellation/failure restores the previous
// mirror only while this command's immutable Goal identity remains current.
// The caller holds a.mu.
func finishClaudeSDKPendingGoalCommandLocked(
	adapterSession *claudeSDKAdapterSession,
	turnID string,
	expected *claudeSDKPendingGoalCommand,
	rollback bool,
	forgetClearControl bool,
) string {
	if adapterSession == nil {
		return ""
	}
	turnID = strings.TrimSpace(turnID)
	pending, ok := adapterSession.pendingGoalCommands[turnID]
	if !ok || expected != nil && (pending.identity != expected.identity || pending.action != expected.action) {
		return ""
	}
	delete(adapterSession.pendingGoalCommands, turnID)
	if adapterSession.goalArmTurnID == turnID {
		adapterSession.goalArmTurnID = ""
	}
	if forgetClearControl {
		delete(adapterSession.goalClearControlTurns, turnID)
	}
	if !rollback {
		return ""
	}
	currentIdentity := goalOperationIdentity{
		operationID: strings.TrimSpace(adapterSession.goalOperationID),
		revision:    adapterSession.goalRevision,
		repairEpoch: adapterSession.goalRepairEpoch,
	}
	if currentIdentity != pending.identity {
		return ""
	}
	adapterSession.liveState.goal = clonePayload(pending.previousGoal)
	if len(pending.previousGoal) == 0 {
		return "thread_goal_cleared"
	}
	return "thread_goal_update"
}

func (a *ClaudeCodeSDKAdapter) finishClaudeSDKPendingGoalTurn(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	turnID string,
	rollback bool,
	forgetClearControl bool,
) []activityshared.Event {
	if a == nil || adapterSession == nil {
		return nil
	}
	a.mu.Lock()
	updateType := finishClaudeSDKPendingGoalCommandLocked(
		adapterSession,
		turnID,
		nil,
		rollback,
		forgetClearControl,
	)
	a.mu.Unlock()
	if updateType == "" {
		return nil
	}
	return a.goalMirrorEvents(session, updateType)
}

func (a *ClaudeCodeSDKAdapter) finishClaudeSDKPendingGoalCommand(
	adapterSession *claudeSDKAdapterSession,
	session Session,
	event claudeSDKSidecarEvent,
) []activityshared.Event {
	if a == nil || adapterSession == nil {
		return nil
	}
	turnID := strings.TrimSpace(payloadString(event.Payload, "turnId"))
	identity := goalOperationIdentity{
		operationID: strings.TrimSpace(payloadString(event.Payload, "operationId")),
		revision:    payloadInt64(event.Payload, "revision"),
		repairEpoch: payloadInt64(event.Payload, "repairEpoch"),
	}
	action := strings.TrimSpace(payloadString(event.Payload, "action"))
	a.mu.Lock()
	updateType := finishClaudeSDKPendingGoalCommandLocked(
		adapterSession,
		turnID,
		&claudeSDKPendingGoalCommand{identity: identity, action: action},
		true,
		true,
	)
	a.mu.Unlock()
	if updateType == "" {
		return nil
	}
	return a.goalMirrorEvents(session, updateType)
}
