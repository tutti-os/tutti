package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

const (
	claudeSDKCancelInterruptTimeout = 10 * time.Second
	claudeSDKCancelDrainTimeout     = 8 * time.Second
	claudeSDKCancelCompletionGrace  = 7 * time.Second
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
	emitCommands CommandSnapshotSink,
) ([]activityshared.Event, error) {
	return a.exec(
		ctx,
		session,
		content,
		displayPrompt,
		turnID,
		emit,
		emitCommands,
		nil,
	)
}

func (a *ClaudeCodeSDKAdapter) exec(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	_ CommandSnapshotSink,
	reportDispatch ProviderDispatchSink,
) ([]activityshared.Event, error) {
	reportNotDispatched := func() {
		if reportDispatch != nil {
			reportDispatch(ProviderDispatchResult{
				Disposition: DispatchDispositionNotDispatched,
			})
		}
	}
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		reportNotDispatched()
		return nil, ErrSessionDisconnected
	}
	session.ProviderSessionID = adapterSession.providerSessionID
	promptCorrelationID := firstNonEmptyString(
		metadataString(execMetadataFromContext(ctx), "clientSubmitId"),
		newID(),
	)
	a.beginClaudeSDKRootTurn(adapterSession, turnID, "")
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
		newUserPromptActivityEvent(ctx, session, content, explicitDisplayPrompt, visibleText, turnID, map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
		}),
		newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", map[string]any{
			"adapter": claudeSDKSidecarAdapterName,
		}),
	}
	if event, ok := adapterSession.mirrorGoalSlashPrompt(session, visibleText); ok {
		startEvents = append(startEvents, event)
	}
	// Emit the compacting banner up front (same rationale as Codex silent
	// compact): Claude frequently finishes /compact without streaming
	// status/boundary to the query iterator, and even when the sidecar emits
	// compact_started immediately it arrives before provider-turn acceptance.
	if isClaudeSDKCompactPrompt(content, visibleText) {
		if compact, ok := a.compactMessageEvent(
			adapterSession,
			session,
			turnID,
			messageStreamStateStreaming,
			"running",
			"",
		); ok {
			startEvents = append(startEvents, compact)
		}
	}
	emitEvents(a.stampTurnLifecycleSnapshots(adapterSession, startEvents))

	providerContent, err := materializeProviderPromptImagesAtBoundary(ctx, content, a.promptImageMaterializer)
	if err != nil {
		reportNotDispatched()
		events = append(events, a.claudeSDKRootProviderFailureEvents(adapterSession, session, turnID, promptCorrelationID, err)...)
		return events, err
	}
	waiter := a.registerClaudeSDKTurn(adapterSession, turnID, emit)
	if err := a.startClaudeSDKReader(session.AgentSessionID, adapterSession); err != nil {
		reportNotDispatched()
		a.unregisterClaudeSDKTurn(adapterSession, turnID, waiter)
		events = append(events, a.claudeSDKRootProviderFailureEvents(adapterSession, session, turnID, promptCorrelationID, err)...)
		return events, err
	}
	payload := claudeSDKExecPayload(ctx, session, turnID, promptCorrelationID, providerContent, visibleText)
	if err := adapterSession.send(claudeSDKSidecarRequest{
		ID:      newID(),
		Type:    "exec",
		Payload: payload,
	}); err != nil {
		reportNotDispatched()
		a.unregisterClaudeSDKTurn(adapterSession, turnID, waiter)
		events = append(events, a.claudeSDKRootProviderFailureEvents(adapterSession, session, turnID, promptCorrelationID, err)...)
		return events, err
	}

	select {
	case result := <-waiter.done:
		if len(result.events) > 0 {
			events = append(events, result.events...)
		}
		if result.err != nil && !isClaudeSDKProviderRejectedError(result.err) {
			events = append(events, a.claudeSDKRootProviderFailureEvents(adapterSession, session, turnID, promptCorrelationID, result.err)...)
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

func (a *ClaudeCodeSDKAdapter) ExecWithProviderAcceptance(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	emitCommands CommandSnapshotSink,
	reportDispatch ProviderDispatchSink,
	acceptProviderTurn ProviderAcceptanceBarrier,
) ([]activityshared.Event, error) {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		if reportDispatch != nil {
			reportDispatch(ProviderDispatchResult{
				Disposition: DispatchDispositionNotDispatched,
			})
		}
		return nil, ErrSessionDisconnected
	}
	acceptanceCtx, cancelAcceptance := context.WithCancel(ctx)
	defer cancelAcceptance()
	var acceptanceOnce sync.Once
	var acceptanceErr error
	accepted := false
	acceptedProviderTurnID := ""
	preAcceptanceOutputViolation := false
	pendingEvents := make([]activityshared.Event, 0, 2)
	wrappedEmit := func(events []activityshared.Event) {
		if acceptanceErr != nil {
			return
		}
		observedAcceptance := false
		providerTurnID := ""
		for _, event := range events {
			if event.Type != activityshared.EventRootProviderTurnStarted ||
				strings.TrimSpace(event.Payload.TurnID) != strings.TrimSpace(turnID) {
				continue
			}
			providerTurnID = strings.TrimSpace(event.Payload.ProviderTurnID)
			if providerTurnID == "" {
				continue
			}
			if accepted &&
				acceptedProviderTurnID != "" &&
				providerTurnID != acceptedProviderTurnID {
				acceptanceErr = errors.New(
					"claude SDK changed provider Turn identity after acceptance",
				)
				cancelAcceptance()
				return
			}
			observedAcceptance = true
			receipt := ProviderAcceptanceReceipt{
				Source:            AcceptanceSourceTurnStartResponse,
				ProviderSessionID: strings.TrimSpace(adapterSession.providerSessionID),
				ProviderTurnID:    providerTurnID,
				ProviderInputUnit: event.ProviderInputUnit,
			}
			acceptanceOnce.Do(func() {
				if acceptProviderTurn == nil {
					acceptanceErr = errors.New(
						"provider acceptance barrier is unavailable",
					)
				} else {
					acceptanceErr = acceptProviderTurn(receipt)
				}
				a.completeClaudeSDKProviderAcceptance(
					adapterSession,
					turnID,
					acceptanceErr,
				)
				accepted = acceptanceErr == nil
				if accepted {
					acceptedProviderTurnID = providerTurnID
				}
			})
			if acceptanceErr != nil {
				cancelAcceptance()
				return
			}
		}
		if !accepted && !observedAcceptance {
			partition := partitionClaudeSDKPreAcceptanceEvents(turnID, events)
			if partition.safe() {
				pendingEvents = append(pendingEvents, events...)
				return
			}
			preAcceptanceOutputViolation = true
			acceptanceErr = errors.New(
				"claude SDK published provider output before durable acceptance",
			)
			if reportDispatch != nil {
				reportDispatch(ProviderDispatchResult{
					Disposition: DispatchDispositionOutcomeUnknown,
				})
			}
			cancelAcceptance()
			return
		}
		if emit != nil {
			if len(pendingEvents) > 0 {
				// acceptProviderTurn already recorded Replay observations at the
				// acceptance ProviderInputUnit (turn.working). Held pre-acceptance
				// events still carry earlier frame units (e.g. compact_started
				// before identity). Re-observing them either regresses the provider
				// cursor or coalesces compaction readiness onto turn.working with
				// conflicting compaction.status predicates. Strip input-unit
				// metadata so flush publishes transcript/state only.
				published := make([]activityshared.Event, 0, len(pendingEvents)+len(events))
				published = append(
					published,
					stripClaudeSDKHeldEventProviderInputUnits(pendingEvents)...,
				)
				published = append(published, events...)
				pendingEvents = nil
				emit(published)
				return
			}
			emit(events)
		}
	}
	events, err := a.exec(
		acceptanceCtx,
		session,
		content,
		displayPrompt,
		turnID,
		wrappedEmit,
		emitCommands,
		reportDispatch,
	)
	if !accepted {
		partition := partitionClaudeSDKPreAcceptanceEvents(turnID, events)
		if preAcceptanceOutputViolation || !partition.safe() {
			if !preAcceptanceOutputViolation && reportDispatch != nil {
				reportDispatch(ProviderDispatchResult{
					Disposition: DispatchDispositionOutcomeUnknown,
				})
			}
			if acceptanceErr == nil {
				acceptanceErr = errors.New(
					"claude SDK returned provider output before durable acceptance",
				)
			}
			// The exact canonical terminal and caller-owned pre-acceptance facts
			// remain authoritative. Provider-dependent output in the same batch
			// does not cross the acceptance barrier.
			if partition.hasDirectCanonicalTerminal {
				return partition.allowed, acceptanceErr
			}
			return nil, acceptanceErr
		}
	}
	if isClaudeSDKProviderRejectedError(err) {
		if !claudeSDKEventsContainTurnFailed(events) {
			metadata := map[string]any{
				"error":               err.Error(),
				"dispatchDisposition": string(DispatchDispositionRejected),
			}
			var appErr *AppError
			if errors.As(err, &appErr) && appErr != nil {
				metadata["code"] = appErr.Code
				if strings.TrimSpace(appErr.DebugMessage) != "" {
					metadata["error"] = appErr.DebugMessage
				}
			}
			events = append(events, newTurnActivityEvent(
				session, EventTurnFailed, turnID, SessionStatusFailed, "", "", metadata,
			))
		}
		if reportDispatch != nil {
			reportDispatch(ProviderDispatchResult{
				Disposition: DispatchDispositionRejected,
				Failure:     err,
			})
		}
		// The provider emitted the submitted lifecycle and terminal rejection
		// events before returning this typed error. Preserve those events so the
		// controller can settle the canonical Turn even though acceptance never
		// crossed the provider boundary.
		return events, err
	}
	if !accepted {
		if claudeSDKEventsContainTurnFailed(events) {
			if err == nil {
				err = errors.New("provider Turn failed before durable acceptance")
			}
			return events, err
		}
		// The submitted/user events are caller-owned facts, but publishing them
		// would commit a provisional Session before the provider delivery result
		// is known. Keep them behind the same acceptance barrier as provider
		// output; outcome-unknown recovery owns any later reconciliation.
		return nil, err
	}
	return events, err
}

func stripClaudeSDKHeldEventProviderInputUnits(
	events []activityshared.Event,
) []activityshared.Event {
	if len(events) == 0 {
		return events
	}
	stripped := make([]activityshared.Event, len(events))
	copy(stripped, events)
	for index := range stripped {
		stripped[index].ProviderInputUnit = nil
	}
	return stripped
}

type claudeSDKPreAcceptanceEventPartition struct {
	allowed                    []activityshared.Event
	providerDependent          []activityshared.Event
	hasDirectCanonicalTerminal bool
}

func (partition claudeSDKPreAcceptanceEventPartition) safe() bool {
	return len(partition.providerDependent) == 0
}

// partitionClaudeSDKPreAcceptanceEvents is the single acceptance-boundary
// classifier for Claude event batches. Only caller-owned local facts and an
// exact terminal for the canonical Turn may survive without provider identity;
// every other event remains provider-dependent even when it shares a batch
// with that terminal.
func partitionClaudeSDKPreAcceptanceEvents(
	turnID string,
	events []activityshared.Event,
) claudeSDKPreAcceptanceEventPartition {
	partition := claudeSDKPreAcceptanceEventPartition{
		allowed:           make([]activityshared.Event, 0, len(events)),
		providerDependent: make([]activityshared.Event, 0, len(events)),
	}
	for _, event := range events {
		if claudeSDKEventMayPrecedeProviderAcceptance(event) {
			partition.allowed = append(partition.allowed, event)
			continue
		}
		if classifyRootTurnCompletion(
			turnID,
			[]activityshared.Event{event},
		) == rootTurnCompletionDirectCanonical {
			partition.allowed = append(partition.allowed, event)
			partition.hasDirectCanonicalTerminal = true
			continue
		}
		partition.providerDependent = append(partition.providerDependent, event)
	}
	return partition
}

func claudeSDKEventMayPrecedeProviderAcceptance(event activityshared.Event) bool {
	if event.Type == EventTurnStarted {
		return true
	}
	if event.Type != activityshared.EventMessageAppended {
		return false
	}
	if strings.EqualFold(
		strings.TrimSpace(string(event.Payload.Role)),
		"user",
	) {
		return true
	}
	// Slash /compact progress banners are emitted as soon as exec is selected,
	// often before Claude persists a provider Turn identity. Hold them like the
	// local user prompt instead of treating them as premature provider output.
	command := strings.TrimSpace(payloadString(event.Payload.Metadata, "noticeCommand"))
	source := strings.TrimSpace(payloadString(event.Payload.Metadata, "source"))
	return command == "compact" || source == "compact"
}

func isClaudeSDKCompactPrompt(content []PromptContentBlock, visibleText string) bool {
	prompt := strings.ToLower(strings.TrimSpace(promptTextForClaudeSDK(content, visibleText)))
	return prompt == "/compact" || strings.HasPrefix(prompt, "/compact ")
}

func claudeSDKEventsContainTurnFailed(events []activityshared.Event) bool {
	for _, event := range events {
		if event.Type == activityshared.EventTurnFailed {
			return true
		}
	}
	return false
}

var _ ProviderAcceptanceExecAdapter = (*ClaudeCodeSDKAdapter)(nil)

func claudeSDKExecPayload(
	ctx context.Context,
	session Session,
	turnID string,
	promptCorrelationID string,
	content []PromptContentBlock,
	visibleText string,
) map[string]any {
	payload := map[string]any{
		"agentSessionId":      session.AgentSessionID,
		"turnId":              turnID,
		"promptCorrelationId": promptCorrelationID,
		"prompt":              promptTextForClaudeSDK(content, visibleText),
		"content":             promptContentForClaudeSDK(content, visibleText),
	}
	if hostContext := renderTuttiModeHostContext(tuttiModeTurnSnapshotFromContext(ctx)); hostContext != "" {
		payload["hostContext"] = hostContext
	}
	return payload
}

func (a *ClaudeCodeSDKAdapter) claudeSDKRootProviderFailureEvents(adapterSession *claudeSDKAdapterSession, session Session, turnID string, providerTurnID string, err error) []activityshared.Event {
	events := a.finishClaudeSDKTurnLifecycle(adapterSession, session, turnID, claudeSDKTurnFinishFailed, "provider_transport_failed")
	activeProviderTurnID := a.activeClaudeSDKRootProviderTurnID(adapterSession)
	if activeProviderTurnID != "" {
		providerTurnID = activeProviderTurnID
	}
	if !a.consumeClaudeSDKRootProviderTurn(adapterSession, providerTurnID) {
		a.mu.Lock()
		readerFailed := adapterSession != nil && adapterSession.invalid
		a.mu.Unlock()
		if readerFailed {
			return events
		}
	}
	metadata := map[string]any{"adapter": claudeSDKSidecarAdapterName}
	if err != nil {
		metadata["error"] = err.Error()
	}
	events = append(events, claudeSDKRootProviderTurnCompletedEvent(
		session,
		turnID,
		providerTurnID,
		activityshared.TurnOutcomeFailed,
		metadata,
	))
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
	return a.GuideActiveTurnWithProviderDispatch(
		ctx,
		session,
		content,
		displayPrompt,
		turnID,
		emit,
		nil,
		nil,
	)
}

func (a *ClaudeCodeSDKAdapter) GuideActiveTurnWithProviderDispatch(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	_ CommandSnapshotSink,
	reportDispatch ProviderDispatchSink,
) ([]activityshared.Event, error) {
	reportNotDispatched := func() {
		if reportDispatch != nil {
			reportDispatch(ProviderDispatchResult{
				Disposition: DispatchDispositionNotDispatched,
			})
		}
	}
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		reportNotDispatched()
		return nil, ErrSessionDisconnected
	}
	session.ProviderSessionID = adapterSession.providerSessionID
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, displayPrompt)
	providerContent, err := materializeProviderPromptImagesAtBoundary(ctx, content, a.promptImageMaterializer)
	if err != nil {
		reportNotDispatched()
		return nil, err
	}
	events := []activityshared.Event{
		newUserPromptActivityEvent(ctx, session, content, explicitDisplayPrompt, visibleText, turnID, map[string]any{
			"adapter":  claudeSDKSidecarAdapterName,
			"guidance": true,
			"steered":  true,
		}),
	}
	if err := a.startClaudeSDKReader(session.AgentSessionID, adapterSession); err != nil {
		reportNotDispatched()
		return events, err
	}
	ctx, cancel := context.WithTimeout(ctx, claudeSDKGoalCommandTimeout)
	defer cancel()
	if err := a.roundTripClaudeSDK(ctx, session.AgentSessionID, adapterSession, claudeSDKSidecarRequest{
		ID:   newID(),
		Type: "guide",
		Payload: map[string]any{
			"agentSessionId": session.AgentSessionID,
			"prompt":         promptTextForClaudeSDK(providerContent, visibleText),
			"content":        promptContentForClaudeSDK(providerContent, visibleText),
		},
	}); err != nil {
		if reportDispatch != nil {
			reportDispatch(ProviderDispatchResult{
				Disposition: DispatchDispositionOutcomeUnknown,
			})
		}
		return events, err
	}
	if reportDispatch != nil {
		reportDispatch(ProviderDispatchResult{
			Disposition: DispatchDispositionAppliedWithoutProviderTurn,
		})
	}
	if emit != nil {
		emit(events)
	}
	return events, nil
}

func (a *ClaudeCodeSDKAdapter) Cancel(ctx context.Context, session Session, _ string) ([]activityshared.Event, error) {
	return a.cancelClaudeSDKTurn(ctx, session, "", "")
}

func (a *ClaudeCodeSDKAdapter) cancelClaudeSDKTurn(
	ctx context.Context,
	session Session,
	turnID string,
	_ string,
) ([]activityshared.Event, error) {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil, ErrSessionDisconnected
	}
	turnID = strings.TrimSpace(turnID)
	if turnID == "" {
		turnID = a.claudeSDKRootTurnID(adapterSession, "")
	} else {
		_ = a.claudeSDKRootTurnID(adapterSession, turnID)
	}
	cancelCtx, cancel := context.WithTimeout(
		ctx,
		claudeSDKCancelInterruptTimeout+claudeSDKCancelDrainTimeout+claudeSDKCancelCompletionGrace,
	)
	defer cancel()
	payload := map[string]any{
		"agentSessionId":     session.AgentSessionID,
		"interruptTimeoutMs": claudeSDKCancelInterruptTimeout.Milliseconds(),
		"drainTimeoutMs":     claudeSDKCancelDrainTimeout.Milliseconds(),
	}
	if turnID != "" {
		payload["turnId"] = turnID
	}
	response, err := a.roundTripClaudeSDKResponse(cancelCtx, session.AgentSessionID, adapterSession, claudeSDKSidecarRequest{
		ID:      newID(),
		Type:    "cancel",
		Payload: payload,
	})
	if err != nil {
		return nil, err
	}
	disposition := strings.TrimSpace(payloadString(response.Payload, "disposition"))
	responseTurnID := strings.TrimSpace(payloadString(response.Payload, "turnId"))
	providerTurnID := strings.TrimSpace(payloadString(response.Payload, "providerTurnId"))
	dispatchPhase := strings.TrimSpace(payloadString(response.Payload, "dispatchPhase"))
	canceled := payloadBoolValue(response.Payload, "canceled")
	if responseTurnID != turnID {
		return nil, fmt.Errorf(
			"claude SDK cancel response turn mismatch: requested %q, received %q",
			turnID,
			responseTurnID,
		)
	}
	if !validClaudeSDKCancelDispatchPhase(dispatchPhase) {
		return nil, fmt.Errorf(
			"claude SDK returned unknown cancel dispatch phase %q",
			dispatchPhase,
		)
	}
	switch disposition {
	case "pre_accept":
		if !canceled || providerTurnID != "" {
			return nil, errors.New("claude SDK returned inconsistent pre-accept cancellation")
		}
	case "provider_active":
		if !canceled || providerTurnID == "" {
			return nil, errors.New("claude SDK returned inconsistent provider-active cancellation")
		}
		if dispatchPhase == "queued" || dispatchPhase == "pending_goal" || dispatchPhase == "unknown" {
			return nil, errors.New("claude SDK returned provider-active cancellation before dispatch")
		}
		if err := a.waitClaudeSDKProviderAcceptanceOutcome(cancelCtx, adapterSession, turnID); err != nil {
			return nil, fmt.Errorf("claude SDK durable provider acceptance: %w", err)
		}
	case "absent":
		if canceled || providerTurnID != "" {
			return nil, errors.New("claude SDK returned inconsistent absent cancellation")
		}
		return nil, ErrSessionNoActiveTurn
	case "mismatch":
		if canceled || providerTurnID != "" {
			return nil, errors.New("claude SDK returned inconsistent mismatched cancellation")
		}
		return nil, fmt.Errorf("%w: turn %q", ErrCancelTargetMismatch, turnID)
	default:
		return nil, fmt.Errorf("claude SDK returned unknown cancel disposition %q", disposition)
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
	a.markClaudeSDKTurnClosed(adapterSession, a.claudeSDKRootTurnID(adapterSession, turnID), "cancel_requested")
	return a.stampTurnLifecycleSnapshots(adapterSession, events), nil
}

func (a *ClaudeCodeSDKAdapter) CancelTargets(ctx context.Context, rootSession Session, targets []CancelTarget, reason string) (TargetedCancelResult, error) {
	for _, target := range targets {
		if strings.TrimSpace(target.AgentSessionID) == strings.TrimSpace(rootSession.AgentSessionID) {
			adapterSession := a.getSession(rootSession.AgentSessionID)
			if adapterSession == nil {
				return TargetedCancelResult{}, ErrSessionDisconnected
			}
			rootTurnID := strings.TrimSpace(target.TurnID)
			// Claude SDK exposes cancellation for the root query. That provider
			// operation stops its nested Task executions as part of the same
			// query; services/tuttid supplied the exact durable target set.
			events, err := a.cancelClaudeSDKTurn(ctx, rootSession, rootTurnID, reason)
			if err != nil {
				return TargetedCancelResult{}, err
			}
			// Commit projection fences only after the sidecar has confirmed its
			// exact disposition. Absent, mismatch, timeout, or protocol failure
			// must leave later provider evidence observable for reconciliation.
			for _, cancelTarget := range targets {
				a.markClaudeSDKTurnClosed(adapterSession, cancelTarget.TurnID, "cancel_requested")
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
