package agentruntime

import (
	"context"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (*ClaudeCodeSDKAdapter) ValidatePromptContent(_ Session, content []PromptContentBlock) error {
	return validatePromptContentImagesForPreflight(content)
}

func (a *ClaudeCodeSDKAdapter) Exec(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	_ CommandSnapshotSink,
) ([]activityshared.Event, error) {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil, ErrSessionDisconnected
	}
	session.ProviderSessionID = adapterSession.providerSessionID
	a.beginClaudeSDKRootTurn(adapterSession, turnID, turnID)
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, displayPrompt)
	events := make([]activityshared.Event, 0, 4)
	emitEvents := func(next []activityshared.Event) {
		if len(next) == 0 {
			return
		}
		events = append(events, next...)
		if emit != nil {
			emit(next)
		}
	}
	startEvents := []activityshared.Event{
		newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, visibleText, userPromptActivityPayload(content, explicitDisplayPrompt, userPromptActivityPayloadExtraFromExecMetadata(ctx, map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
		}))),
		newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
		}),
		claudeSDKRootProviderTurnStartedEvent(session, turnID, turnID, map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
		}),
	}
	if event, ok := adapterSession.mirrorGoalSlashPrompt(session, visibleText); ok {
		startEvents = append(startEvents, event)
	}
	emitEvents(a.stampTurnLifecycleSnapshots(adapterSession, startEvents))

	waiter := a.registerClaudeSDKTurn(adapterSession, turnID, emit)
	if err := a.startClaudeSDKReader(session.AgentSessionID, adapterSession); err != nil {
		a.unregisterClaudeSDKTurn(adapterSession, turnID, waiter)
		events = append(events, a.claudeSDKRootProviderFailureEvents(adapterSession, session, turnID, err)...)
		return events, err
	}
	payload := claudeSDKExecPayload(ctx, session, turnID, content, visibleText)
	if err := adapterSession.send(claudeSDKSidecarRequest{
		ID:      newID(),
		Type:    "exec",
		Payload: payload,
	}); err != nil {
		a.unregisterClaudeSDKTurn(adapterSession, turnID, waiter)
		events = append(events, a.claudeSDKRootProviderFailureEvents(adapterSession, session, turnID, err)...)
		return events, err
	}

	select {
	case result := <-waiter.done:
		if len(result.events) > 0 {
			events = append(events, result.events...)
		}
		if result.err != nil {
			events = append(events, a.claudeSDKRootProviderFailureEvents(adapterSession, session, turnID, result.err)...)
		}
		return events, result.err
	case <-ctx.Done():
		// Controller cancel interrupts this context before adapter.Cancel.
		// Close the turn lifecycle here too so dangling tool calls are not
		// stranded if Cancel later finds no live waiter.
		events = append(events, a.finishClaudeSDKTurnLifecycle(
			adapterSession,
			session,
			turnID,
			claudeSDKTurnFinishInterrupted,
			"user_interrupt",
		)...)
		a.unregisterClaudeSDKTurn(adapterSession, turnID, waiter)
		return events, ctx.Err()
	}
}

func claudeSDKExecPayload(
	ctx context.Context,
	session Session,
	turnID string,
	content []PromptContentBlock,
	visibleText string,
) map[string]any {
	payload := map[string]any{
		"agentSessionId": session.AgentSessionID,
		"turnId":         turnID,
		"prompt":         promptTextForClaudeSDK(content, visibleText),
		"content":        promptContentForClaudeSDK(content, visibleText),
	}
	if hostContext := renderTuttiModeHostContext(tuttiModeTurnSnapshotFromContext(ctx)); hostContext != "" {
		payload["hostContext"] = hostContext
	}
	return payload
}

func (a *ClaudeCodeSDKAdapter) claudeSDKRootProviderFailureEvents(adapterSession *claudeSDKAdapterSession, session Session, turnID string, err error) []activityshared.Event {
	events := a.finishClaudeSDKTurnLifecycle(adapterSession, session, turnID, claudeSDKTurnFinishFailed, "provider_transport_failed")
	metadata := map[string]any{"adapter": claudeSDKSidecarAdapterName}
	if err != nil {
		metadata["error"] = err.Error()
	}
	events = append(events, claudeSDKRootProviderTurnCompletedEvent(
		session,
		turnID,
		turnID,
		activityshared.TurnOutcomeFailed,
		metadata,
	))
	a.consumeClaudeSDKRootProviderTurn(adapterSession, turnID)
	return events
}

func (a *ClaudeCodeSDKAdapter) GuideActiveTurn(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	_ CommandSnapshotSink,
) ([]activityshared.Event, error) {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil, ErrSessionDisconnected
	}
	session.ProviderSessionID = adapterSession.providerSessionID
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, displayPrompt)
	events := []activityshared.Event{
		newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, visibleText, userPromptActivityPayload(content, explicitDisplayPrompt, userPromptActivityPayloadExtraFromExecMetadata(ctx, map[string]any{
			"adapter":  claudeSDKSidecarAdapterName,
			"guidance": true,
			"steered":  true,
		}))),
	}
	if err := a.startClaudeSDKReader(session.AgentSessionID, adapterSession); err != nil {
		return events, err
	}
	ctx, cancel := context.WithTimeout(ctx, claudeSDKGoalCommandTimeout)
	defer cancel()
	if err := a.roundTripClaudeSDK(ctx, session.AgentSessionID, adapterSession, claudeSDKSidecarRequest{
		ID:   newID(),
		Type: "guide",
		Payload: map[string]any{
			"agentSessionId": session.AgentSessionID,
			"prompt":         promptTextForClaudeSDK(content, visibleText),
			"content":        promptContentForClaudeSDK(content, visibleText),
		},
	}); err != nil {
		return events, err
	}
	if emit != nil {
		emit(events)
	}
	return events, nil
}

func (a *ClaudeCodeSDKAdapter) Cancel(ctx context.Context, session Session, _ string) ([]activityshared.Event, error) {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil, ErrSessionDisconnected
	}
	cancelCtx, cancel := context.WithTimeout(ctx, claudeSDKGoalCommandTimeout)
	defer cancel()
	if err := a.roundTripClaudeSDK(cancelCtx, session.AgentSessionID, adapterSession, claudeSDKSidecarRequest{
		ID:   newID(),
		Type: "cancel",
		Payload: map[string]any{
			"agentSessionId": session.AgentSessionID,
		},
	}); err != nil {
		return nil, err
	}
	events := a.claudeSDKPendingRequestFailureEvents(adapterSession, session, "", errPermissionRequestCanceled)
	// Finish open turn lifecycles by normalizer ownership, not by the live
	// waiter registry. The provider cancel response and local Exec cleanup can
	// unregister the waiter independently of event projection. If we only
	// finished live waiters, open Write/tool cards could stay "running" after
	// the turn already settled canceled.
	events = append(events, a.finishAllClaudeSDKTurnLifecycles(
		adapterSession,
		session,
		claudeSDKTurnFinishInterrupted,
		"user_interrupt",
	)...)
	a.markClaudeSDKTurnClosed(adapterSession, a.claudeSDKRootTurnID(adapterSession, ""), "cancel_requested")
	return a.stampTurnLifecycleSnapshots(adapterSession, events), nil
}

func (a *ClaudeCodeSDKAdapter) CancelTargets(ctx context.Context, rootSession Session, targets []CancelTarget, reason string) (TargetedCancelResult, error) {
	for _, target := range targets {
		if strings.TrimSpace(target.AgentSessionID) == strings.TrimSpace(rootSession.AgentSessionID) {
			adapterSession := a.getSession(rootSession.AgentSessionID)
			if adapterSession == nil {
				return TargetedCancelResult{}, ErrSessionDisconnected
			}
			// services/tuttid owns the exact durable cancellation target set.
			// Close those projection boundaries before asking the SDK to stop so
			// cancellation-caused task/tool terminal events cannot race the
			// durable canceled state and reinterpret a child as failed.
			for _, cancelTarget := range targets {
				a.markClaudeSDKTurnClosed(adapterSession, cancelTarget.TurnID, "cancel_requested")
			}
			// Claude SDK exposes cancellation for the root query. That provider
			// operation stops its nested Task executions as part of the same
			// query; services/tuttid supplied the exact durable target set.
			events, err := a.Cancel(ctx, rootSession, reason)
			if err != nil {
				return TargetedCancelResult{}, err
			}
			return TargetedCancelResult{
				Events:           events,
				ConfirmedTargets: append([]CancelTarget(nil), targets...),
			}, nil
		}
	}
	return a.stopClaudeSDKChildTargets(ctx, rootSession, targets)
}

// stopClaudeSDKChildTargets stops individual background delegated tasks via
// the SDK's targeted stopTask, leaving the root query and any other running
// tasks untouched. The stopped task settles asynchronously through its own
// task_notification, which projects the child turn canceled; a target whose
// task is unknown or already settled is skipped, making the child cancel an
// idempotent no-op (TargetAbsent) rather than an error.
func (a *ClaudeCodeSDKAdapter) stopClaudeSDKChildTargets(ctx context.Context, rootSession Session, targets []CancelTarget) (TargetedCancelResult, error) {
	adapterSession := a.getSession(rootSession.AgentSessionID)
	if adapterSession == nil {
		return TargetedCancelResult{}, ErrSessionDisconnected
	}
	confirmed := make([]CancelTarget, 0, len(targets))
	for _, target := range targets {
		a.mu.Lock()
		child, ok := adapterSession.claudeSDKChildByAgentSessionID(target.AgentSessionID)
		a.mu.Unlock()
		if !ok {
			continue
		}
		taskID := firstNonEmptyString(child.TaskID, child.AgentID, child.ParentToolUseID, child.Key)
		if taskID == "" {
			continue
		}
		stopped, err := a.StopTask(ctx, rootSession, taskID)
		if err != nil {
			return TargetedCancelResult{}, err
		}
		if stopped {
			confirmed = append(confirmed, target)
		}
	}
	return TargetedCancelResult{ConfirmedTargets: confirmed}, nil
}
