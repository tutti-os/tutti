package agentruntime

import (
	"context"
	"strings"
)

func (a *ClaudeCodeSDKAdapter) dispatchClaudeSDKEvent(
	agentSessionID string,
	adapterSession *claudeSDKAdapterSession,
	event claudeSDKSidecarEvent,
) error {
	if a == nil || adapterSession == nil {
		return nil
	}
	// This exact-session mutex is the linearization point shared with registry
	// replacement and reader failure. Once dispatch wins it commits the whole
	// event against this generation; once replacement wins, this reader sees a
	// stale session before performing any canonical side effect.
	adapterSession.dispatchMu.Lock()
	defer adapterSession.dispatchMu.Unlock()
	eventCtx := context.Background()
	if event.inputUnit != nil {
		eventCtx = contextWithProviderInputUnit(eventCtx, *event.inputUnit)
	}
	endInputUnit := a.inputUnits.begin(eventCtx, agentSessionID)
	defer endInputUnit()
	a.logClaudeSDKLifecycleEvent(agentSessionID, adapterSession, event)
	// Protocol response waiters belong to the exact physical connection, not
	// to the current registry generation. Always settle them so a Close on a
	// replaced connection cannot deadlock behind stale-event suppression.
	if response := a.takeClaudeSDKResponseWaiter(adapterSession, event); response != nil {
		response <- event
		return completeClaudeSDKProviderInputUnit(
			context.Background(),
			adapterSession.conn,
			event,
		)
	}
	if !a.sessionMayDispatch(agentSessionID, adapterSession) {
		return completeClaudeSDKProviderInputUnit(
			context.Background(),
			adapterSession.conn,
			event,
		)
	}
	turnID := payloadString(event.Payload, "turnId")
	if turnID == "" {
		turnID = payloadString(event.Payload, "turnID")
	}
	waiter := a.claudeSDKTurnWaiter(adapterSession, turnID)
	if claudeSDKSidecarTurnTerminal(event.Type) {
		providerTurnID := firstNonEmptyString(
			payloadString(event.Payload, "providerTurnId"),
			turnID,
		)
		known := a.consumeClaudeSDKRootProviderTurn(adapterSession, providerTurnID)
		goalClearControlTurn := a.isGoalClearControlTurn(adapterSession, turnID)
		if waiter == nil && !known && !goalClearControlTurn {
			return completeClaudeSDKProviderInputUnit(
				context.Background(),
				adapterSession.conn,
				event,
			)
		}
	}
	session := a.claudeSDKSessionSnapshot(adapterSession)
	if strings.TrimSpace(session.AgentSessionID) == "" {
		session.AgentSessionID = agentSessionID
	}
	next, terminal, err := a.sidecarTurnEvents(adapterSession, session, turnID, event)
	next = a.stampTurnLifecycleSnapshots(adapterSession, next)
	next = a.inputUnits.stamp(agentSessionID, next)
	if err != nil && waiter == nil {
		next = append(next, newSessionActivityEvent(session, EventSessionFailed, SessionStatusFailed, map[string]any{
			"error": err.Error(),
		}))
	}
	if len(next) > 0 {
		a.updateClaudeSDKSessionSnapshot(adapterSession, next)
	}
	if waiter != nil {
		a.completeClaudeSDKWaiterEvent(adapterSession, waiter, turnID, next, terminal, err)
		return completeClaudeSDKProviderInputUnit(
			context.Background(),
			adapterSession.conn,
			event,
		)
	}
	a.emitClaudeSDKSessionEvents(agentSessionID, next)
	a.finishClaudeSDKGoalTurnPublication(adapterSession, next)
	return completeClaudeSDKProviderInputUnit(
		context.Background(),
		adapterSession.conn,
		event,
	)
}
