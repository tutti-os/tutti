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
	eventCtx := context.Background()
	if event.inputUnit != nil {
		eventCtx = contextWithProviderInputUnit(eventCtx, *event.inputUnit)
	}
	endInputUnit := a.inputUnits.begin(eventCtx, agentSessionID)
	defer endInputUnit()
	a.logClaudeSDKLifecycleEvent(agentSessionID, adapterSession, event)
	if response := a.takeClaudeSDKResponseWaiter(adapterSession, event); response != nil {
		response <- event
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
	if err != nil {
		next = append(next, newSessionActivityEvent(session, EventSessionFailed, SessionStatusFailed, map[string]any{
			"error": err.Error(),
		}))
	}
	a.emitClaudeSDKSessionEvents(agentSessionID, next)
	a.finishClaudeSDKGoalTurnPublication(adapterSession, next)
	return completeClaudeSDKProviderInputUnit(
		context.Background(),
		adapterSession.conn,
		event,
	)
}
