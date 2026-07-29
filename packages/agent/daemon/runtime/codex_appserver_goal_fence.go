package agentruntime

import (
	"context"
	"errors"
	"strings"
)

func (a *CodexAppServerAdapter) FenceGoalGeneration(
	_ context.Context,
	session Session,
	input GoalGenerationFenceInput,
) error {
	identity := goalOperationIdentity{
		operationID: strings.TrimSpace(input.OperationID),
		revision:    input.Revision,
		repairEpoch: input.RepairEpoch,
	}
	if !identity.valid() {
		return errors.New("valid Goal generation fence identity is required")
	}
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	if appSession == nil || appSession.client == nil {
		a.mu.Unlock()
		return ErrSessionDisconnected
	}
	if appSession.fencedGoalIdentities == nil {
		appSession.fencedGoalIdentities = make(map[goalOperationIdentity]struct{})
	}
	appSession.fencedGoalIdentities[identity] = struct{}{}
	if claim := appSession.goalContinuationClaim; claim != nil && claim.identity == identity {
		appSession.goalContinuationClaim = nil
	}
	active := appSession.activeTurn
	client, threadID := appSession.client, appSession.threadID
	activeMatches := active != nil && active.goalIdentity == identity
	providerTurnID := ""
	if activeMatches {
		providerTurnID = active.providerTurnID
	}
	a.mu.Unlock()
	if activeMatches && strings.TrimSpace(providerTurnID) != "" {
		return exactQuiesceGoalTurn(client, threadID, providerTurnID)
	}
	return nil
}

func goalIdentityFencedLocked(appSession *codexAppServerSession, identity goalOperationIdentity) bool {
	if appSession == nil || !identity.valid() {
		return false
	}
	_, fenced := appSession.fencedGoalIdentities[identity]
	return fenced
}

func (a *CodexAppServerAdapter) quiesceFencedGoalTurn(session Session, providerTurnID string) {
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		return
	}
	_ = exactQuiesceGoalTurn(appSession.client, appSession.threadID, providerTurnID)
}
