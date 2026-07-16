package agentruntime

import "strings"

type codexGoalContinuationClaim struct {
	identity goalOperationIdentity
	ready    bool
}

// armGoalContinuationClaim establishes a single-use compatibility claim for
// the next unowned provider turn. Codex orders external Goal mutation as:
// response, session-scoped goal update, then any continuation turn. Current
// releases omit turnId from that update, so the successful RPC plus the
// immutable durable operation identity is the narrowest available causal
// boundary. Claims never survive adapter restart and cannot cross a newer Goal
// operation identity.
func (a *CodexAppServerAdapter) armGoalContinuationClaim(agentSessionID string, identity goalOperationIdentity) {
	if a == nil || !identity.valid() {
		return
	}
	agentSessionID = strings.TrimSpace(agentSessionID)
	a.mu.Lock()
	appSession := a.sessions[agentSessionID]
	if appSession == nil || appSession.provenanceDegraded {
		a.mu.Unlock()
		return
	}
	current := goalOperationIdentity{
		operationID: appSession.goalOperationID,
		revision:    appSession.goalRevision,
		repairEpoch: appSession.goalRepairEpoch,
	}
	if current != identity || strings.TrimSpace(asString(appSession.goal["status"])) != "active" {
		a.mu.Unlock()
		return
	}
	appSession.goalContinuationClaim = &codexGoalContinuationClaim{
		identity: identity,
		ready:    true,
	}
	pendingTurnIDs := make([]string, 0, len(appSession.pendingGoalTurns))
	for providerTurnID := range appSession.pendingGoalTurns {
		pendingTurnIDs = append(pendingTurnIDs, providerTurnID)
	}
	a.mu.Unlock()
	for _, providerTurnID := range pendingTurnIDs {
		a.tryResolvePendingGoalTurn(agentSessionID, providerTurnID)
	}
}

// prepareGoalContinuationClaim keeps an unowned turn buffered while the
// triggering Goal RPC response and durable generation binding are still in
// flight. A prepared claim is never adoptable; armGoalContinuationClaim is the
// only transition that makes it consumable.
func (a *CodexAppServerAdapter) prepareGoalContinuationClaim(agentSessionID string, identity goalOperationIdentity) {
	if a == nil || !identity.valid() {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil || appSession.provenanceDegraded {
		return
	}
	current := goalOperationIdentity{
		operationID: appSession.goalOperationID,
		revision:    appSession.goalRevision,
		repairEpoch: appSession.goalRepairEpoch,
	}
	if current == identity {
		appSession.goalContinuationClaim = &codexGoalContinuationClaim{identity: identity}
	}
}

func (a *CodexAppServerAdapter) clearPreparedGoalContinuationClaim(agentSessionID string, identity goalOperationIdentity) {
	if a == nil || !identity.valid() {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	if appSession == nil {
		return
	}
	claim := appSession.goalContinuationClaim
	if claim != nil && claim.identity == identity && !claim.ready {
		appSession.goalContinuationClaim = nil
	}
}
