package agentruntime

import (
	"context"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *CodexAppServerAdapter) newGuidanceContinuation(
	session Session,
	turnID string,
) (activityshared.Event, *codexGuidanceContinuationAdmission, error) {
	attemptID := "continuation:" + newID()
	eventContext, ok := activityEventContext(session, "root-provider-turn-started:"+attemptID, turnID)
	if !ok {
		return activityshared.Event{}, nil, ErrSessionDisconnected
	}
	started := activityshared.NewRootProviderTurnStarted(eventContext, turnID, attemptID)
	if binding, err := a.WriteProviderTurnBinding(ProviderTurnBindingWriteInput{
		Kind:           ProviderTurnBindingWriteStarted,
		ProviderTurnID: attemptID,
	}); err == nil {
		started.Payload.ProviderTurnBindingJSON = binding
	}
	started.Payload.Metadata = map[string]any{"guidanceContinuation": true}
	return started, newCodexGuidanceContinuationAdmission(attemptID), nil
}

func (a *CodexAppServerAdapter) startGuidanceContinuation(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	emitCommands CommandSnapshotSink,
) ([]activityshared.Event, error) {
	started, continuation, err := a.newGuidanceContinuation(session, turnID)
	if err != nil {
		return nil, err
	}
	if err := a.execAsync(
		context.WithoutCancel(ctx), session, content, displayPrompt, turnID,
		emit, emitCommands, continuation,
	); err != nil {
		return nil, err
	}
	if err := <-continuation.admitted; err != nil {
		return nil, err
	}
	if emit != nil {
		emit([]activityshared.Event{started})
	}
	close(continuation.provisionalStarted)
	return []activityshared.Event{started}, nil
}

func (a *CodexAppServerAdapter) preemptActiveTurnAndStartGuidance(
	ctx context.Context,
	appSession *codexAppServerSession,
	activeTurn *codexAppServerActiveTurn,
	activeTurnID string,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	emitCommands CommandSnapshotSink,
) ([]activityshared.Event, error) {
	started, continuation, err := a.newGuidanceContinuation(session, turnID)
	if err != nil {
		return nil, err
	}

	// Replace the durable provider-turn identity before the old response emits
	// its interrupted terminal. That terminal closes its streams but cannot
	// settle the canonical Turn reserved for the guidance continuation.
	activeTurn.processMu.Lock()
	if !a.claimActiveTurnForGuidance(session.AgentSessionID, activeTurn, activeTurnID) {
		activeTurn.processMu.Unlock()
		return nil, ErrSessionNoActiveTurn
	}
	if emit != nil {
		emit([]activityshared.Event{started})
	}
	close(continuation.provisionalStarted)
	activeTurn.processMu.Unlock()

	a.rejectPendingRequests(session.AgentSessionID, errPermissionRequestCanceled)
	if err := a.interruptActiveTurn(
		context.WithoutCancel(ctx), appSession, session, activeTurn, activeTurnID,
		"active-turn guidance",
	); err != nil {
		return []activityshared.Event{started}, err
	}

	if err := a.execAsync(
		context.WithoutCancel(ctx), session, content, displayPrompt, turnID,
		emit, emitCommands, continuation,
	); err != nil {
		return []activityshared.Event{started}, err
	}
	if err := <-continuation.admitted; err != nil {
		return []activityshared.Event{started}, err
	}
	return []activityshared.Event{started}, nil
}

func (a *CodexAppServerAdapter) claimActiveTurnForGuidance(
	agentSessionID string,
	activeTurn *codexAppServerActiveTurn,
	activeTurnID string,
) bool {
	if a == nil || activeTurn == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	appSession := a.sessions[agentSessionID]
	if appSession == nil ||
		appSession.activeTurn != activeTurn ||
		appSession.activeTurnID != activeTurnID ||
		activeTurn.phase == codexAppServerTurnPhaseInterrupting ||
		activeTurn.phase.terminal() {
		return false
	}
	activeTurn.phase = codexAppServerTurnPhaseInterrupting
	return true
}
