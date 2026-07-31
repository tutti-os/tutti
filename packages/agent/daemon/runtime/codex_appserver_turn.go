package agentruntime

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (a *CodexAppServerAdapter) Exec(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	emitCommands CommandSnapshotSink,
) ([]activityshared.Event, error) {
	return a.execBlocking(
		ctx,
		session,
		content,
		displayPrompt,
		turnID,
		emit,
		emitCommands,
		codexTurnExecOptions{},
	)
}

func (a *CodexAppServerAdapter) ExecWithProviderAcceptance(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	emitCommands CommandSnapshotSink,
	reportDispatch ProviderDispatchSink,
) ([]activityshared.Event, error) {
	return a.execBlocking(
		ctx,
		session,
		content,
		displayPrompt,
		turnID,
		emit,
		emitCommands,
		codexTurnExecOptions{reportDispatch: reportDispatch},
	)
}

func (a *CodexAppServerAdapter) ExecAsync(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	emitCommands CommandSnapshotSink,
) error {
	return a.execAsync(ctx, session, content, displayPrompt, turnID, emit, emitCommands, nil)
}

type codexGuidanceContinuationAdmission struct {
	providerTurnID     string
	admitted           chan error
	provisionalStarted chan struct{}
}

func newCodexGuidanceContinuationAdmission(providerTurnID string) *codexGuidanceContinuationAdmission {
	return &codexGuidanceContinuationAdmission{
		providerTurnID:     providerTurnID,
		admitted:           make(chan error, 1),
		provisionalStarted: make(chan struct{}),
	}
}

func (a *codexGuidanceContinuationAdmission) published() bool {
	if a == nil {
		return false
	}
	select {
	case <-a.provisionalStarted:
		return true
	default:
		return false
	}
}

func (a *CodexAppServerAdapter) execAsync(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	emitCommands CommandSnapshotSink,
	continuation *codexGuidanceContinuationAdmission,
) error {
	go func() {
		events, err := a.execBlocking(
			ctx,
			session,
			content,
			displayPrompt,
			turnID,
			emit,
			emitCommands,
			codexTurnExecOptions{continuation: continuation},
		)
		if continuation != nil && !continuation.published() {
			return
		}
		if emit == nil {
			return
		}
		outcome := codexAsyncTerminalOutcome(events, err)
		terminalEvents := make([]activityshared.Event, 0, 2)
		if continuation != nil &&
			!codexAsyncProviderLifecycleSupersedes(events, continuation.providerTurnID) {
			metadata := map[string]any{
				"guidanceContinuation": true,
				"providerTurnStarted":  false,
			}
			if err != nil {
				metadata["error"] = err.Error()
			}
			terminalEvents = append(terminalEvents, appServerRootProviderTurnCompletedEvent(
				session,
				turnID,
				continuation.providerTurnID,
				outcome,
				metadata,
			))
		}
		if err != nil {
			if outcome == activityshared.TurnOutcomeCanceled {
				terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
					"error": err.Error(),
				}))
			} else {
				terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(err)))
			}
		}
		if len(terminalEvents) > 0 {
			emit(terminalEvents)
		}
	}()
	return nil
}

func codexAsyncProviderLifecycleSupersedes(events []activityshared.Event, provisionalProviderTurnID string) bool {
	for _, event := range events {
		if event.Type != activityshared.EventRootProviderTurnStarted &&
			event.Type != activityshared.EventRootProviderTurnCompleted {
			continue
		}
		providerTurnID := strings.TrimSpace(event.Payload.ProviderTurnID)
		if providerTurnID != "" && providerTurnID != provisionalProviderTurnID {
			return true
		}
	}
	return false
}

func codexAsyncTerminalOutcome(events []activityshared.Event, err error) activityshared.TurnOutcome {
	if errors.Is(err, context.Canceled) {
		return activityshared.TurnOutcomeCanceled
	}
	for _, event := range events {
		switch event.Type {
		case activityshared.EventTurnCanceled:
			return activityshared.TurnOutcomeCanceled
		case activityshared.EventTurnFailed:
			return activityshared.TurnOutcomeFailed
		}
	}
	if err != nil {
		return activityshared.TurnOutcomeFailed
	}
	return activityshared.TurnOutcomeCompleted
}

func (a *CodexAppServerAdapter) ExecHistoryReplacement(
	ctx context.Context,
	session Session,
	input HistoryReplacementExecInput,
	emit EventSink,
	emitCommands CommandSnapshotSink,
	reportDispatch ProviderDispatchSink,
) ([]activityshared.Event, error) {
	return a.execBlocking(
		ctx,
		session,
		input.Content,
		input.DisplayPrompt,
		input.TurnID,
		emit,
		emitCommands,
		codexTurnExecOptions{
			historyReplacement: true,
			reportDispatch:     reportDispatch,
		},
	)
}

type codexTurnExecOptions struct {
	historyReplacement bool
	reportDispatch     ProviderDispatchSink
	continuation       *codexGuidanceContinuationAdmission
}

func (options codexTurnExecOptions) report(result ProviderDispatchResult) {
	if options.reportDispatch != nil {
		options.reportDispatch(result)
	}
}

func reportCodexDispatchFailure(report ProviderDispatchSink, err error) {
	if report == nil {
		return
	}
	disposition := DispatchDispositionOutcomeUnknown
	var callErr *acpCallError
	if errors.As(err, &callErr) {
		disposition = DispatchDispositionRejected
	}
	report(ProviderDispatchResult{Disposition: disposition})
}

func reportCodexAppliedWithoutProviderTurn(report ProviderDispatchSink) {
	if report != nil {
		report(ProviderDispatchResult{
			Disposition: DispatchDispositionAppliedWithoutProviderTurn,
		})
	}
}

func reportCodexProviderTurnAccepted(
	report ProviderDispatchSink,
	providerSessionID string,
	providerTurnID string,
) {
	if report == nil {
		return
	}
	providerSessionID = strings.TrimSpace(providerSessionID)
	providerTurnID = strings.TrimSpace(providerTurnID)
	if providerSessionID == "" || providerTurnID == "" {
		report(ProviderDispatchResult{
			Disposition: DispatchDispositionOutcomeUnknown,
		})
		return
	}
	report(ProviderDispatchResult{
		Disposition: DispatchDispositionApplied,
		Acceptance: &ProviderAcceptanceReceipt{
			Source:            AcceptanceSourceTurnStartResponse,
			ProviderSessionID: providerSessionID,
			ProviderTurnID:    providerTurnID,
		},
	})
}

func (a *CodexAppServerAdapter) GuideActiveTurn(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	emitCommands CommandSnapshotSink,
) ([]activityshared.Event, error) {
	appSession := a.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		return nil, ErrSessionDisconnected
	}
	activeTurnID := a.sessionActiveTurnID(session.AgentSessionID)
	session.ProviderSessionID = appSession.threadID
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, displayPrompt)
	mentionRoutingApplied, mentionRoutingSkills := tuttiMentionRoutingSkills(visibleText)
	if activeTurnID != "" {
		providerContent := content
		if mentionRoutingApplied {
			providerContent = appendTuttiMentionRoutingContent(providerContent, mentionRoutingSkills)
		}
		var err error
		providerContent, err = materializeProviderPromptImagesAtBoundary(ctx, providerContent, a.promptImageMaterializer)
		if err != nil {
			return nil, err
		}
		return a.steerActiveTurn(ctx, appSession, session, content, providerContent, explicitDisplayPrompt, visibleText, turnID, activeTurnID, emit)
	}
	// The canonical root turn remains active while child sessions drain even
	// after the provider's root turn has ended. Guidance in that window starts
	// another provider turn on the same root thread and keeps the same
	// WorkspaceAgentTurn id.
	if a.sessionActiveTurn(session.AgentSessionID) != nil {
		// The provider turn exists but turn/started has not supplied its id yet;
		// starting another turn would race the existing one.
		return nil, ErrSessionNoActiveTurn
	}
	attemptID := "continuation:" + newID()
	eventContext, ok := activityEventContext(session, "root-provider-turn-started:"+attemptID, turnID)
	if !ok {
		return nil, ErrSessionDisconnected
	}
	started := activityshared.NewRootProviderTurnStarted(eventContext, turnID, attemptID)
	if binding, err := a.WriteProviderTurnBinding(
		ProviderTurnBindingWriteInput{
			Kind:           ProviderTurnBindingWriteStarted,
			ProviderTurnID: attemptID,
		},
	); err == nil {
		started.Payload.ProviderTurnBindingJSON = binding
	}
	started.Payload.Metadata = map[string]any{"guidanceContinuation": true}
	continuation := newCodexGuidanceContinuationAdmission(attemptID)
	if err := a.execAsync(
		context.WithoutCancel(ctx),
		session,
		content,
		displayPrompt,
		turnID,
		emit,
		emitCommands,
		continuation,
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

func (appTurn *codexAppServerActiveTurn) markTerminated() {
	appTurn.terminatedOnce.Do(func() { close(appTurn.terminated) })
}

// markTurnSettleEmits flips the turn to settle-path terminal emission just
// before the provider turn is submitted, under the adapter mutex so the
// notification loop observes it consistently.
func (a *CodexAppServerAdapter) markTurnSettleEmits(appTurn *codexAppServerActiveTurn) {
	if a == nil || appTurn == nil {
		return
	}
	a.mu.Lock()
	appTurn.settleEmits = true
	a.mu.Unlock()
}

// finalizeSettledTurn produces the settled turn's terminal events from the
// notification path, releases the active-turn slot, and signals terminated —
// terminal production no longer depends on a parked goroutine (ADR 0005 C).
// Classification mirrors the blocking shell exactly; the shell's turnClosed
// guard drops any duplicate.
func (a *CodexAppServerAdapter) finalizeSettledTurn(agentSessionID string, appTurn *codexAppServerActiveTurn, terminal codexAppServerTurnTerminal) {
	if a == nil || appTurn == nil || appTurn.emitTerminal == nil {
		return
	}
	providerTurnID := firstNonEmpty(asString(terminal.turn["id"]), appTurn.providerTurnID)
	appTurn.diagnostics.Finish(string(terminal.phase), providerTurnID)
	appTurn.processMu.Lock()
	appTurn.settleFinalized.Store(true)
	session := appTurn.session
	turnID := appTurn.turnID
	if terminal.err != nil {
		if errors.Is(terminal.err, context.Canceled) ||
			errors.Is(terminal.err, errPermissionRequestCanceled) ||
			a.turnForceCanceled(appTurn) ||
			terminal.phase == codexAppServerTurnPhaseCanceled {
			terminalEvents := a.pendingRequestFailureEvents(session, turnID, errPermissionRequestCanceled)
			terminalEvents = append(terminalEvents, appTurn.normalizer.FinishInterrupted(session, turnID, "interrupted")...)
			terminalEvents = append(terminalEvents, appServerRootProviderTurnCompletedEvent(
				session,
				turnID,
				appTurn.providerTurnID,
				activityshared.TurnOutcomeCanceled,
				map[string]any{"error": terminal.err.Error()},
			))
			appTurn.emitTerminal(terminalEvents)
		} else {
			terminalEvents := appTurn.normalizer.FinishFailed(session, turnID)
			terminalEvents = append(terminalEvents, appServerRootProviderTurnCompletedEvent(
				session,
				turnID,
				appTurn.providerTurnID,
				activityshared.TurnOutcomeFailed,
				acpFailureMetadata(terminal.err),
			))
			appTurn.emitTerminal(terminalEvents)
		}
	} else {
		appTurn.normalizer.ApplyAssistantFinalText(appServerTurnFinalAssistantText(terminal.turn))
		appTurn.emitTerminal(appServerTurnTerminalEvents(session, turnID, terminal.turn, appTurn.normalizer))
	}
	appTurn.processMu.Unlock()
	a.endActiveTurn(agentSessionID, appTurn)
	appTurn.markTerminated()
	if appTurn.kind == codexAppServerTurnKindGoalAdopted && appTurn.goalIdentity.valid() {
		a.armGoalContinuationClaim(agentSessionID, appTurn.goalIdentity)
	}
	// With an active goal, codex normally auto-starts the next turn; the
	// nudge covers the case where it does not. This must run regardless of
	// how the turn settled: a mid-goal turn can end failed (a transient tool
	// or model error) or externally canceled (client hiccup) while codex's
	// own thread state still reports the goal active, and if codex does not
	// resume on its own the goal would otherwise stop advancing for good
	// with no further signal. scheduleGoalContinuationNudge already no-ops
	// once the goal itself is no longer active (paused/complete/cleared) or
	// the app-server connection is gone, so calling it unconditionally here
	// cannot resume a goal that was legitimately stopped (for example Cancel
	// pauses the goal before interrupting the turn, so a user-initiated
	// cancellation settles with the goal already paused).
	a.scheduleGoalContinuationNudge(session)
}

// settleTurnExternal settles THIS turn (pointer match) from an external
// death signal — context cancellation or client death — as a first-class
// machine transition instead of a parked-goroutine select arm.
func (a *CodexAppServerAdapter) settleTurnExternal(agentSessionID string, appTurn *codexAppServerActiveTurn, terminal codexAppServerTurnTerminal) {
	if a == nil || appTurn == nil {
		return
	}
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(agentSessionID)]
	settled := false
	if appSession != nil && appSession.activeTurn == appTurn && !appTurn.phase.terminal() {
		appTurn.phase = terminal.phase
		appSession.activeTurnID = ""
		appSession.activeTurnStartConfirmed = false
		settled = true
	}
	emits := settled && appTurn.settleEmits
	a.mu.Unlock()
	if !settled {
		return
	}
	select {
	case appTurn.terminal <- terminal:
	default:
	}
	if emits {
		a.finalizeSettledTurn(agentSessionID, appTurn, terminal)
	}
}

// watchTurnExternalTermination translates external death signals (context
// cancellation, client death) into turn-machine transitions. It exits as
// soon as the turn terminates through any path.
func (a *CodexAppServerAdapter) watchTurnExternalTermination(appSession *codexAppServerSession, appTurn *codexAppServerActiveTurn) {
	select {
	case <-appTurn.terminated:
	case <-appTurn.ctx.Done():
		a.settleTurnExternal(appTurn.session.AgentSessionID, appTurn, codexAppServerTurnTerminal{
			err: appTurn.ctx.Err(), phase: codexAppServerTurnPhaseCanceled,
		})
	case <-appSession.client.Done():
		err := appSession.client.Err()
		if err == nil {
			err = ErrSessionDisconnected
		}
		a.settleTurnExternal(appTurn.session.AgentSessionID, appTurn, codexAppServerTurnTerminal{
			err: err, phase: codexAppServerTurnPhaseFailed,
		})
	}
}

func (a *CodexAppServerAdapter) execBlocking(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	emitCommands CommandSnapshotSink,
	options codexTurnExecOptions,
) ([]activityshared.Event, error) {
	execMetadata := execMetadataFromContext(ctx)
	continuation := options.continuation
	recordNotDispatched := func() {
		if options.reportDispatch != nil {
			options.report(ProviderDispatchResult{
				Disposition: DispatchDispositionNotDispatched,
			})
		}
	}
	execState, ok := a.snapshotExecState(session.AgentSessionID)
	if !ok {
		recordNotDispatched()
		if continuation != nil {
			continuation.admitted <- ErrSessionDisconnected
		}
		return nil, ErrSessionDisconnected
	}
	appSession := execState.liveSession
	effectiveSettings := codexAppServerEffectiveSettings(
		execState.models,
		codexAppServerExecSessionWithConfig(session, execState.config),
		nil,
	)
	session.Settings = &effectiveSettings
	session.ProviderSessionID = appSession.threadID
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, displayPrompt)
	mentionRoutingApplied, mentionRoutingSkills := tuttiMentionRoutingSkills(visibleText)

	if activeTurnID := a.sessionActiveTurnID(session.AgentSessionID); activeTurnID != "" {
		if continuation != nil {
			continuation.admitted <- ErrSessionActiveTurn
		}
		if continuation != nil || options.historyReplacement {
			recordNotDispatched()
			return nil, ErrSessionActiveTurn
		}
		if command, args := splitSlashCommand(visibleText); command == appServerSlashGoal {
			// Goal commands are thread-level control operations; steering them
			// would paste "/goal …" into the running turn as prompt text
			// instead of executing the RPC.
			return a.execGoalControlCommand(ctx, appSession, session, args, turnID, content, explicitDisplayPrompt, visibleText, emit, options.reportDispatch)
		}
		providerContent := content
		if mentionRoutingApplied {
			providerContent = appendTuttiMentionRoutingContent(providerContent, mentionRoutingSkills)
		}
		var err error
		providerContent, err = materializeProviderPromptImagesAtBoundary(ctx, providerContent, a.promptImageMaterializer)
		if err != nil {
			recordNotDispatched()
			return nil, err
		}
		events, err := a.steerActiveTurn(ctx, appSession, session, content, providerContent, explicitDisplayPrompt, visibleText, turnID, activeTurnID, emit)
		if err != nil {
			reportCodexDispatchFailure(options.reportDispatch, err)
			return events, err
		}
		reportCodexAppliedWithoutProviderTurn(options.reportDispatch)
		return events, nil
	}

	normalizer := newACPTurnNormalizer()
	// The emit mutex is held across the sink callback: after `turn/start`
	// responds, streaming notifications are emitted from the client read
	// loop while this goroutine waits, so emissions must be serialized.
	// Terminal events close the turn: anything a handler emits afterwards
	// (for example a rejected approval resolving during cancel) is dropped,
	// so the turn outcome event is always the last one the controller sees.
	var eventsMu sync.Mutex
	var events []activityshared.Event
	turnClosed := false
	emitLocked := func(next []activityshared.Event) {
		next = a.stampTurnLifecycleSnapshots(session.AgentSessionID, next)
		events = append(events, next...)
		if emit != nil {
			emit(next)
		}
	}
	emitEvents := func(next []activityshared.Event) {
		if len(next) == 0 {
			return
		}
		eventsMu.Lock()
		defer eventsMu.Unlock()
		if turnClosed {
			return
		}
		emitLocked(next)
	}
	emitTerminal := func(next []activityshared.Event) {
		eventsMu.Lock()
		defer eventsMu.Unlock()
		if turnClosed {
			return
		}
		turnClosed = true
		if len(next) > 0 {
			emitLocked(next)
		}
	}
	snapshotEvents := func() []activityshared.Event {
		eventsMu.Lock()
		defer eventsMu.Unlock()
		return append([]activityshared.Event(nil), events...)
	}
	startEvents := []activityshared.Event{
		newUserPromptActivityEvent(ctx, session, content, explicitDisplayPrompt, visibleText, turnID, nil),
		newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", nil),
	}

	appTurn := &codexAppServerActiveTurn{
		turnID:       turnID,
		session:      session,
		ctx:          ctx,
		normalizer:   normalizer,
		diagnostics:  newCodexAppServerTurnDiagnostics(nil, turnID),
		emit:         emitEvents,
		emitCommands: emitCommands,
		kind:         codexAppServerTurnKindNormal,
		phase:        codexAppServerTurnPhaseRunning,
		terminal:     make(chan codexAppServerTurnTerminal, 1),
		terminated:   make(chan struct{}),
	}
	appTurn.emitTerminal = emitTerminal
	// Signal turn termination once this goroutine returns (after terminal events
	// are emitted), so a concurrent Cancel only responds after the turn stopped.
	// The settle path may finalize first; the Once keeps the close single.
	defer appTurn.markTerminated()
	if !a.beginActiveTurn(session.AgentSessionID, appTurn) {
		recordNotDispatched()
		if continuation != nil {
			continuation.admitted <- ErrSessionActiveTurn
		}
		return nil, ErrSessionActiveTurn
	}
	defer a.endActiveTurn(session.AgentSessionID, appTurn)
	if continuation != nil {
		continuation.admitted <- nil
		<-continuation.provisionalStarted
	}
	emitEvents(startEvents)

	if !options.historyReplacement {
		if handled, err := a.execSlashCommand(ctx, appSession, session, visibleText, turnID, appTurn, normalizer, emitEvents, emitTerminal, emitCommands, options.reportDispatch); handled {
			return snapshotEvents(), err
		}
	}

	providerContent := content
	if mentionRoutingApplied {
		providerContent = appendTuttiMentionRoutingContent(providerContent, mentionRoutingSkills)
	}
	var err error
	providerContent, err = materializeProviderPromptImagesAtBoundary(ctx, providerContent, a.promptImageMaterializer)
	if err != nil {
		recordNotDispatched()
		return snapshotEvents(), err
	}

	// From here on the settle path (notification loop) owns terminal event
	// production; the blocking shell below only waits and returns.
	a.markTurnSettleEmits(appTurn)

	trace := newCodexAppServerTurnTrace(session, turnID, execMetadata)
	appTurn.diagnostics.Start(trace)
	turnParams := appServerTurnStartParams(
		session,
		appSession.threadID,
		providerContent,
		appSession.planModeMask,
		appSession.defaultModeMask,
		execState.defaultModel,
		renderTuttiModeHostContext(tuttiModeTurnSnapshotFromContext(ctx)),
		a.config.commandNetworkAccess,
	)
	if clientUserMessageID := metadataString(execMetadata, "clientSubmitId"); clientUserMessageID != "" {
		// clientSubmitId is an opaque, caller-stable recovery token. The
		// canonical Turn id stays Tutti-owned and is never used as Codex client
		// identity.
		turnParams["clientUserMessageId"] = clientUserMessageID
	}
	trace.Log("turn.start.params", codexAppServerTraceTurnStartParams(session, turnParams, providerContent))
	turnStartAckTimeout := a.turnStartAckTimeout
	if turnStartAckTimeout <= 0 {
		turnStartAckTimeout = defaultCodexAppServerTurnStartAckTimeout
	}
	logAgentSubmitTrace("turn.start.requested", session, turnID, execMetadata, map[string]any{
		"timeout_ms": turnStartAckTimeout.Milliseconds(),
	})
	turnStartedAt := time.Now()
	result, err := appSession.client.TurnStart(ctx, turnStartAckTimeout, turnParams)
	if err != nil {
		reportCodexDispatchFailure(options.reportDispatch, err)
		durationMS := time.Since(turnStartedAt).Milliseconds()
		appTurn.diagnostics.Finish("failed", "")
		trace.Log("turn.start.failed", map[string]any{
			"duration_ms": durationMS,
			"error":       err.Error(),
		})
		logAgentSubmitTrace("turn.start.failed", session, turnID, execMetadata, map[string]any{
			"duration_ms": durationMS,
			"error":       err.Error(),
		})
		invalidateClient := codexTurnStartClientUnhealthy(err, appSession.client)
		a.endActiveTurn(session.AgentSessionID, appTurn)
		if errors.Is(err, context.Canceled) || errors.Is(err, errPermissionRequestCanceled) {
			terminalEvents := a.pendingRequestFailureEvents(session, turnID, errPermissionRequestCanceled)
			terminalEvents = append(terminalEvents, normalizer.FinishInterrupted(session, turnID, "interrupted")...)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnCanceled, turnID, SessionStatusCanceled, "", "", map[string]any{
				"error": err.Error(),
			}))
			emitTerminal(terminalEvents)
		} else {
			terminalEvents := normalizer.FinishFailed(session, turnID)
			terminalEvents = append(terminalEvents, newTurnActivityEvent(session, EventTurnFailed, turnID, SessionStatusFailed, "", "", acpFailureMetadata(err)))
			emitTerminal(terminalEvents)
		}
		if invalidateClient && a.invalidateSessionClient(session.AgentSessionID, appSession.client) {
			slog.Warn(
				"agent session app-server client invalidated after turn/start failed",
				"event", "agent_session.app_server.turn_start.client_invalidated",
				"agent_session_id", session.AgentSessionID,
				"provider_session_id", appSession.threadID,
				"turn_id", turnID,
				"error", err.Error(),
			)
		}
		return snapshotEvents(), nil
	}
	durationMS := time.Since(turnStartedAt).Milliseconds()
	trace.Log("turn.start.succeeded", map[string]any{
		"duration_ms": durationMS,
		"result_size": len(result),
	})
	logAgentSubmitTrace("turn.start.succeeded", session, turnID, execMetadata, map[string]any{
		"duration_ms": durationMS,
		"result_size": len(result),
	})

	// The app-server responds to turn/start immediately with the inProgress
	// turn; the real output streams as notifications and the final turn
	// arrives with the turn/completed notification.
	initialTurn := appServerTurnFromResult(result)
	if providerTurnID := asString(initialTurn["id"]); providerTurnID != "" {
		if a.setSessionActiveTurnID(session.AgentSessionID, appTurn, providerTurnID) {
			a.interruptActiveTurnAsync(appSession, session, appTurn, providerTurnID, "queued cancel")
		}
		reportCodexProviderTurnAccepted(options.reportDispatch, appSession.threadID, providerTurnID)
	} else {
		reportCodexProviderTurnAccepted(options.reportDispatch, appSession.threadID, "")
	}
	go a.watchTurnExternalTermination(appSession, appTurn)
	finalTurn, finishErr := a.awaitTurnCompletion(ctx, appSession, appTurn, initialTurn)
	// The settle path finalizes AFTER delivering the terminal channel value:
	// wait for terminated (closed at the end of finalize) so the snapshot
	// includes the terminal events. The timeout is a safety net for any
	// settle hole; the shell classification below then covers it.
	select {
	case <-appTurn.terminated:
	case <-time.After(2 * time.Second):
	}
	a.endActiveTurn(session.AgentSessionID, appTurn)
	if appTurn.settleFinalized.Load() {
		// The settle path already produced the terminal events.
		return snapshotEvents(), nil
	}
	slog.Warn(
		"agent session app-server turn terminal produced by blocking shell (settle shadow miss)",
		"agent_session_id", session.AgentSessionID,
		"turn_id", turnID,
	)
	if finishErr != nil {
		outcome := "failed"
		if errors.Is(finishErr, context.Canceled) || errors.Is(finishErr, errPermissionRequestCanceled) || a.turnForceCanceled(appTurn) {
			outcome = "canceled"
		}
		appTurn.diagnostics.Finish(outcome, appTurn.providerTurnID)
	} else {
		appTurn.diagnostics.Finish("completed", appTurn.providerTurnID)
	}
	if finishErr != nil {
		if errors.Is(finishErr, context.Canceled) || errors.Is(finishErr, errPermissionRequestCanceled) || a.turnForceCanceled(appTurn) {
			terminalEvents := a.pendingRequestFailureEvents(session, turnID, errPermissionRequestCanceled)
			terminalEvents = append(terminalEvents, normalizer.FinishInterrupted(session, turnID, "interrupted")...)
			terminalEvents = append(terminalEvents, appServerRootProviderTurnCompletedEvent(session, turnID, appTurn.providerTurnID, activityshared.TurnOutcomeCanceled, map[string]any{"error": finishErr.Error()}))
			emitTerminal(terminalEvents)
		} else {
			terminalEvents := normalizer.FinishFailed(session, turnID)
			terminalEvents = append(terminalEvents, appServerRootProviderTurnCompletedEvent(session, turnID, appTurn.providerTurnID, activityshared.TurnOutcomeFailed, acpFailureMetadata(finishErr)))
			emitTerminal(terminalEvents)
		}
		return snapshotEvents(), nil
	}
	normalizer.ApplyAssistantFinalText(appServerTurnFinalAssistantText(finalTurn))
	emitTerminal(appServerTurnTerminalEvents(session, turnID, finalTurn, normalizer))
	return snapshotEvents(), nil
}

var _ ProviderAcceptanceExecAdapter = (*CodexAppServerAdapter)(nil)

func codexTurnStartClientUnhealthy(err error, client *codexAppServerClient) bool {
	if errors.Is(err, context.Canceled) ||
		errors.Is(err, context.DeadlineExceeded) ||
		errors.Is(err, ErrSessionDisconnected) {
		return true
	}
	if client == nil {
		return true
	}
	select {
	case <-client.Done():
		return true
	default:
		return false
	}
}

// pendingRequestFailureEvents resolves any still-pending approval or
// interactive requests as failed, so a canceled turn does not leave
// dangling approval cards. The handlers waiting on those requests emit
// their own resolution later, but the turn is closed by then and the
// duplicate emission is dropped.
func (a *CodexAppServerAdapter) pendingRequestFailureEvents(
	session Session,
	turnID string,
	cause error,
) []activityshared.Event {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(session.AgentSessionID)]
	pendings := make([]*pendingInteractiveRequest, 0)
	if appSession != nil {
		for _, pending := range appSession.pendingRequests {
			pendings = append(pendings, pending)
		}
	}
	a.mu.Unlock()
	var events []activityshared.Event
	for _, pending := range pendings {
		if !pending.supersede(cause) {
			continue
		}
		events = append(events, normalizedPermissionResolvedEvents(session, turnID, pending, pendingInteractiveResponse{}, cause)...)
	}
	return events
}

// awaitTurnCompletion blocks until the turn finishes. When the turn/start
// (or review/start) response already reports a terminal status it is used
// directly; otherwise the final turn payload comes from the turn/completed
// notification via the active turn context.
func (a *CodexAppServerAdapter) awaitTurnCompletion(
	ctx context.Context,
	appSession *codexAppServerSession,
	appTurn *codexAppServerActiveTurn,
	initialTurn map[string]any,
) (map[string]any, error) {
	if appServerTurnStatusTerminal(initialTurn) {
		a.completeActiveTurn(appTurn.session.AgentSessionID, initialTurn)
	}
	select {
	case terminal := <-appTurn.terminal:
		return terminal.turn, terminal.err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-appSession.client.Done():
		err := appSession.client.Err()
		if err == nil {
			err = ErrSessionDisconnected
		}
		return nil, err
	}
}

func appServerTurnStatusTerminal(turn map[string]any) bool {
	switch asString(turn["status"]) {
	case "completed", "failed", "interrupted", "canceled":
		return true
	default:
		return false
	}
}
