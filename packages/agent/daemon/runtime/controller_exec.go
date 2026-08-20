package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (c *Controller) Exec(ctx context.Context, input ExecInput) (result ExecResult, err error) {
	if input.Guidance || input.HistoryReplacement || input.RequireProviderAcceptance {
		defer func() {
			if err != nil && result.ProviderDispatch == nil {
				result.ProviderDispatch = &ProviderDispatchResult{
					Disposition: DispatchDispositionNotDispatched,
				}
			}
		}()
	}
	releaseLifecycleLock := c.acquireLifecycleLock(input.RoomID, input.AgentSessionID)
	lifecycleLockHeld := true
	defer func() {
		if lifecycleLockHeld {
			releaseLifecycleLock()
		}
	}()

	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return ExecResult{}, err
	}
	var canonicalSubmit canonicalSubmitFact
	if session.IsSideConversation() {
		// Side submissions have a caller-stable transient identity, but no
		// canonical SubmitClaim or durable occurrence. Keep the identity in
		// execution metadata for provider correlation and the ephemeral
		// projector; never manufacture a canonical submit fact for this lane.
		if input.CanonicalSubmitOccurredAtUnixMS > 0 {
			return ExecResult{}, errors.New(
				"side conversation cannot carry a canonical submit occurrence",
			)
		}
	} else {
		canonicalSubmit, err = newCanonicalSubmitFact(
			input.ClientSubmitID,
			input.CanonicalSubmitOccurredAtUnixMS,
		)
		if err != nil {
			return ExecResult{}, err
		}
	}
	if canonicalSubmit.occurredAtUnixMS > 0 {
		observeEventUnixMS(canonicalSubmit.occurredAtUnixMS)
		ctx = withCanonicalSubmitFact(ctx, canonicalSubmit)
	}
	var historyAdapter EffectiveHistoryAdapter
	if input.HistoryReplacement {
		if input.Guidance {
			return ExecResult{
				ProviderDispatch: &ProviderDispatchResult{
					Disposition: DispatchDispositionNotDispatched,
				},
			}, errors.New("history replacement cannot guide an active turn")
		}
		var ok bool
		historyAdapter, ok = adapter.(EffectiveHistoryAdapter)
		if !ok {
			return ExecResult{
				ProviderDispatch: &ProviderDispatchResult{
					Disposition: DispatchDispositionNotDispatched,
				},
			}, ErrEffectiveHistoryUnsupported
		}
	}
	var acceptanceAdapter ProviderAcceptanceExecAdapter
	if input.RequireProviderAcceptance && !input.HistoryReplacement {
		if _, forkCapable := adapter.(SessionForkAdapter); forkCapable {
			var ok bool
			acceptanceAdapter, ok = adapter.(ProviderAcceptanceExecAdapter)
			if !ok {
				return ExecResult{
					ProviderDispatch: &ProviderDispatchResult{
						Disposition: DispatchDispositionNotDispatched,
					},
				}, errors.New("fork-capable agent provider does not expose durable turn acceptance")
			}
		}
	}
	metadata := cloneExecMetadata(input.Metadata)
	delete(metadata, "clientSubmitId")
	if clientSubmitID := strings.TrimSpace(input.ClientSubmitID); clientSubmitID != "" {
		if metadata == nil {
			metadata = make(map[string]any)
		}
		// Runtime adapters still consume execution context metadata internally;
		// derive this compatibility projection from the typed host contract.
		metadata["clientSubmitId"] = clientSubmitID
	}
	logAgentSubmitTrace("runtime.exec.entered", session, "", metadata, map[string]any{
		"content_block_count": len(input.Content),
	})
	if err := c.ensureLiveAdapterSession(ctx, session, adapter); err != nil {
		logAgentSubmitTrace("runtime.exec.ensure_live_failed", session, "", metadata, map[string]any{
			"error": err.Error(),
		})
		return ExecResult{}, err
	}
	logAgentSubmitTrace("runtime.exec.adapter_session_ready", session, "", metadata, nil)
	if refreshed, ok := c.get(session.RoomID, session.AgentSessionID); ok {
		session = refreshed
	}
	if err := validateRuntimePromptContentImages(input.Content); err != nil {
		return ExecResult{}, err
	}
	content := normalizeRuntimePromptContent(input.Content)
	if len(content) == 0 {
		return ExecResult{}, fmt.Errorf("prompt is required")
	}
	providerContent := prependConnectorRoutingUpdate(
		projectRuntimeConnectorPromptContent(content),
		input.ConnectorRoutingUpdate,
	)
	displayPrompt := strings.TrimSpace(input.DisplayPrompt)
	if promptAdapter, ok := adapter.(PromptContentAdapter); ok {
		if err := promptAdapter.ValidatePromptContent(session, providerContent); err != nil {
			return ExecResult{}, err
		}
	}
	if input.Guidance {
		return c.guideActiveTurn(ctx, session, adapter, providerContent, displayPrompt, metadata, input.CapabilityRefs, input.TurnID)
	}
	previousSession := session
	// Keep the initial title on the submitted Turn patch so owner admission
	// persists the title, turn, and prompt as one state/message transaction.
	submittedTitle := ""
	if initialTitle := strings.TrimSpace(input.InitialTitle); initialTitle != "" &&
		!session.InitialTitleEstablished &&
		strings.TrimSpace(session.Title) == strings.TrimSpace(input.InitialTitleBase) {
		session.Title = initialTitle
		session = markInitialTitleEstablished(session)
		session.UpdatedAtUnixMS = unixMS(now())
		submittedTitle = session.Title
	}
	turnID := strings.TrimSpace(input.TurnID)
	if turnID == "" {
		// Internal callers that do not cross the daemon service boundary retain
		// backwards-compatible allocation. External service submissions always
		// preallocate and durably bind this canonical id before dispatch.
		turnID = newID()
	}
	runCtx, cancel := context.WithCancel(context.Background())
	if len(metadata) > 0 {
		runCtx = context.WithValue(runCtx, execMetadataContextKey{}, metadata)
	}
	runCtx = withCanonicalSubmitFact(runCtx, canonicalSubmit)
	runCtx = withCanonicalPromptContent(runCtx, content)
	if canonicalSubmit.clientSubmitID == "" {
		runCtx = withPromptActivityMessageID(runCtx, newTurnUserPromptActivityMessageID())
	}
	tuttiModeSnapshot := normalizeTuttiModeTurnSnapshot(input.TuttiModeSnapshot)
	runCtx = withTuttiModeTurnSnapshot(runCtx, tuttiModeSnapshot)
	var dispatchObserver *providerDispatchObserver
	if historyAdapter != nil || acceptanceAdapter != nil {
		dispatchObserver = newProviderDispatchObserver()
	}
	// beginTurn returns the zero session on failure; keep the real session
	// for the goal-control fallback below.
	startedSession, err := c.beginTurnWithTuttiModeSnapshot(session, turnID, cancel, tuttiModeSnapshot)
	if err != nil {
		cancel()
		return ExecResult{}, err
	}
	session = startedSession
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	provisional := c.provisionalSessions[key]
	c.mu.Unlock()
	submitEvents := submittedTurnActivityEvents(
		runCtx,
		session,
		content,
		displayPrompt,
		turnID,
		input.CapabilityRefs,
		submittedTitle,
	)
	// The submitted Turn is a durable user intent, not provider output. Keep
	// the Session visible while the provider-identity acceptance barrier is
	// pending so an explicit provider rejection cannot erase the prompt.
	if err := c.reportSubmittedTurnDurable(ctx, session, submitEvents, false); err != nil {
		cancel()
		c.rollbackSubmittedTurn(previousSession, turnID)
		logAgentSubmitTrace("runtime.exec.submitted_report_failed", session, turnID, metadata, map[string]any{
			"error": err.Error(),
		})
		return ExecResult{}, fmt.Errorf("persist submitted agent turn: %w", err)
	}
	if provisional {
		c.mu.Lock()
		delete(c.provisionalSessions, key)
		c.mu.Unlock()
	}
	if len(submitEvents) > 0 {
		c.publish(session, submitEvents)
	}
	if provisional {
		c.publishPendingConfigOptionsUpdates(session)
		if !c.publishPendingCommandSnapshot(session) {
			c.publishAdapterCommandSnapshot(session, adapter)
		}
	}
	logAgentSubmitTrace("runtime.submitted", session, turnID, metadata, map[string]any{
		"phase": "submitted",
	})
	if historyAdapter != nil {
		go c.runHistoryReplacementTurn(
			runCtx,
			session,
			historyAdapter,
			HistoryReplacementExecInput{
				Content:       providerContent,
				DisplayPrompt: displayPrompt,
				TurnID:        turnID,
			},
			dispatchObserver.Report,
		)
	} else if acceptanceAdapter != nil {
		acceptProviderTurn := func(receipt ProviderAcceptanceReceipt) error {
			dispatch := ProviderDispatchResult{
				Disposition:           DispatchDispositionApplied,
				Acceptance:            &receipt,
				AcceptanceDiagnostics: codexProviderAcceptanceDiagnostics(receipt.ProviderSessionID, receipt.ProviderTurnID, ""),
			}
			confirmed, confirmErr := c.confirmProviderDispatchDurable(
				// Provider acceptance persistence must finish even when the
				// caller concurrently cancels the submitted request.
				context.WithoutCancel(runCtx),
				session,
				turnID,
				dispatch,
			)
			if confirmErr != nil {
				cancel()
			}
			// The waiting Exec caller is released only after the acceptance receipt
			// has crossed the durable reporter (or has a typed rejection).
			dispatchObserver.ReportWithError(confirmed, confirmErr)
			return confirmErr
		}
		go c.runProviderAcceptanceTurn(
			runCtx,
			session,
			acceptanceAdapter,
			providerContent,
			displayPrompt,
			turnID,
			dispatchObserver.Report,
			acceptProviderTurn,
		)
	} else {
		go c.runExecTurn(runCtx, session, adapter, providerContent, displayPrompt, turnID)
	}
	result = ExecResult{
		AgentSessionID:     session.AgentSessionID,
		Status:             ExecStatusStarted,
		TurnID:             turnID,
		Accepted:           true,
		SessionStatus:      session.Status,
		TurnLifecycle:      *session.TurnLifecycle,
		SubmitAvailability: *session.SubmitAvailability,
	}
	// The lifecycle lock protects canonical admission through durable submit
	// and provider goroutine launch. Provider acceptance may arrive later (or
	// never); keeping the lock while waiting would prevent Cancel from
	// interrupting the active provider operation during that window.
	releaseLifecycleLock()
	lifecycleLockHeld = false
	if dispatchObserver == nil {
		return result, nil
	}
	select {
	case observation := <-dispatchObserver.result:
		dispatch := observation.dispatch
		confirmErr := observation.err
		if acceptanceAdapter == nil {
			dispatch, confirmErr = c.confirmProviderDispatchDurable(
				// Once the provider has positively accepted a Turn, user
				// cancellation must not abort persistence of that identity.
				context.WithoutCancel(runCtx),
				session,
				turnID,
				dispatch,
			)
		}
		result.ProviderDispatch = &dispatch
		if confirmErr != nil {
			return result, confirmErr
		}
		if dispatch.Disposition == DispatchDispositionRejected ||
			dispatch.Disposition == DispatchDispositionNotDispatched {
			// The provider supplied a definite negative delivery result. The
			// submitted Turn and prompt stay canonical so the failure is visible;
			// runBlockingExecTurn settles the in-memory Turn without waiting for a
			// provider-root aggregation that can never arrive.
			cancel()
		}
		if dispatch.Disposition == DispatchDispositionAppliedWithoutProviderTurn &&
			dispatch.Acceptance == nil {
			return result, nil
		}
		if dispatch.Disposition != DispatchDispositionApplied || dispatch.Acceptance == nil {
			if input.RequireProviderAcceptance {
				// Durable submit already published the Turn. Any outcome that
				// never bound a provider Turn identity (cancel-before-accept,
				// pre-acceptance interrupt races where adapter cancel settles
				// before runCtx is canceled, caller disconnect) must not become
				// delivery-unknown — that locks the Session for the next submit.
				// An explicit acceptance diagnostic is different: it identifies a
				// deterministic provider-boundary failure and must remain visible.
				if dispatch.Acceptance == nil &&
					dispatch.AcceptanceDiagnostics == nil &&
					dispatch.Disposition != DispatchDispositionRejected &&
					dispatch.Disposition != DispatchDispositionNotDispatched {
					result.ProviderDispatch = &ProviderDispatchResult{
						Disposition: DispatchDispositionAppliedWithoutProviderTurn,
					}
					return result, nil
				}
				if dispatch.Failure != nil {
					return result, dispatch.Failure
				}
				if diagnostics := dispatch.AcceptanceDiagnostics; diagnostics != nil &&
					strings.TrimSpace(diagnostics.FailureReason) != "" {
					return result, &AppError{
						Code:    AppErrorProviderAcceptanceMissingIdentity,
						Message: "provider turn was not durably accepted",
						Cause:   errors.New(diagnostics.FailureReason),
					}
				}
				return result, errors.New("provider turn was not durably accepted")
			}
			return result, nil
		}
		return result, nil
	case <-ctx.Done():
		// Caller context can end (HTTP cancel / stall) while provider acceptance
		// is still pending. The Turn is already durable; do not leave
		// OutcomeUnknown on the claim fence.
		if input.RequireProviderAcceptance {
			result.ProviderDispatch = &ProviderDispatchResult{
				Disposition: DispatchDispositionAppliedWithoutProviderTurn,
			}
			return result, nil
		}
		result.ProviderDispatch = &ProviderDispatchResult{
			Disposition: DispatchDispositionOutcomeUnknown,
		}
		return result, ctx.Err()
	}
}

func (c *Controller) guideActiveTurn(
	ctx context.Context,
	session Session,
	adapter Adapter,
	content []PromptContentBlock,
	displayPrompt string,
	metadata map[string]any,
	capabilityRefs []activityshared.CapabilityReference,
	expectedTurnID string,
) (ExecResult, error) {
	guidanceAdapter, ok := adapter.(ActiveTurnGuidanceAdapter)
	if !ok {
		return ExecResult{}, ErrActiveTurnGuidanceUnsupported
	}
	expectedTurnID = strings.TrimSpace(expectedTurnID)
	turnID, ok := c.activeTurnID(session.RoomID, session.AgentSessionID)
	if !ok {
		if expectedTurnID != "" {
			return ExecResult{
					AgentSessionID: session.AgentSessionID,
					Status:         ExecStatusStarted,
					TurnID:         expectedTurnID,
					ProviderDispatch: &ProviderDispatchResult{
						Disposition: DispatchDispositionNotDispatched,
					},
				}, errors.Join(
					fmt.Errorf("%w: expected %q, current turn is inactive", ErrActiveTurnTargetMismatch, expectedTurnID),
					ErrSessionNoActiveTurn,
				)
		}
		return ExecResult{}, ErrSessionNoActiveTurn
	}
	// The lifecycle lock held by Exec makes this comparison and the provider
	// admission below one serialized decision. A guidance request is allowed to
	// use the legacy empty target only for direct internal Controller callers;
	// Host consumers must provide the target and are checked before reaching
	// this method. When a target is present, never retarget to whichever turn is
	// current when the request happens to arrive.
	if expectedTurnID != "" && expectedTurnID != turnID {
		return ExecResult{
			AgentSessionID: session.AgentSessionID,
			Status:         ExecStatusStarted,
			TurnID:         expectedTurnID,
			ProviderDispatch: &ProviderDispatchResult{
				Disposition: DispatchDispositionNotDispatched,
			},
		}, fmt.Errorf("%w: expected %q, current %q", ErrActiveTurnTargetMismatch, expectedTurnID, turnID)
	}
	runCtx := ctx
	if len(metadata) > 0 {
		runCtx = context.WithValue(ctx, execMetadataContextKey{}, metadata)
	}
	// Guidance belongs to the already-running canonical turn. Reuse the
	// snapshot frozen when that turn began rather than observing a later badge
	// toggle from the session.
	runCtx = withTuttiModeTurnSnapshot(runCtx, c.activeTurnTuttiModeSnapshot(session.RoomID, session.AgentSessionID))
	var emittedMu sync.Mutex
	var emitted []activityshared.Event
	emit := func(next []activityshared.Event) {
		if len(next) == 0 {
			return
		}
		emittedMu.Lock()
		emitted = append(emitted, next...)
		emittedMu.Unlock()
		c.applySessionEventsByAgentSessionID(session.AgentSessionID, next)
	}
	emitCommands := func(snapshot AgentSessionCommandSnapshot) {
		c.applyCommandSnapshotByAgentSessionID(snapshot)
	}
	var providerDispatch *ProviderDispatchResult
	var providerDispatchOnce sync.Once
	reportProviderDispatch := func(result ProviderDispatchResult) {
		providerDispatchOnce.Do(func() {
			copy := result
			providerDispatch = &copy
		})
	}
	var events []activityshared.Event
	var err error
	if dispatchAdapter, ok := adapter.(ActiveTurnGuidanceProviderDispatchAdapter); ok {
		events, err = dispatchAdapter.GuideActiveTurnWithProviderDispatch(
			runCtx,
			session,
			content,
			displayPrompt,
			turnID,
			emit,
			emitCommands,
			reportProviderDispatch,
		)
	} else {
		events, err = guidanceAdapter.GuideActiveTurn(
			runCtx,
			session,
			content,
			displayPrompt,
			turnID,
			emit,
			emitCommands,
		)
	}
	if err != nil {
		logAgentSubmitTrace("runtime.exec.guidance_failed", session, turnID, metadata, map[string]any{
			"error": err.Error(),
		})
		// Untyped adapters retain the conservative legacy boundary. Typed
		// adapters can prove a local preflight rejection, while any error after
		// provider I/O remains outcome-unknown.
		if providerDispatch == nil {
			providerDispatch = &ProviderDispatchResult{
				Disposition: DispatchDispositionOutcomeUnknown,
			}
		}
		return ExecResult{
			AgentSessionID:   session.AgentSessionID,
			Status:           ExecStatusStarted,
			TurnID:           turnID,
			ProviderDispatch: providerDispatch,
		}, err
	}
	emittedMu.Lock()
	remaining := unemittedActivityEvents(events, emitted)
	emittedMu.Unlock()
	c.applySessionEventsByAgentSessionID(session.AgentSessionID, remaining)
	if refreshed, ok := c.get(session.RoomID, session.AgentSessionID); ok {
		session = refreshed
	}
	if provenancePatch, ok := guidanceTurnCapabilityReferenceStatePatch(session, turnID, capabilityRefs); ok {
		// Capability provenance is metadata on the existing turn, not a
		// lifecycle event. Persist it through the reporter and let the
		// post-commit canonical turn_update invalidate AgentGUI.
		c.enqueueSessionStatePatchReport(ctx, session, provenancePatch)
	}
	logAgentSubmitTrace("runtime.exec.guidance", session, turnID, metadata, map[string]any{
		"activity_event_count": len(events),
	})
	result := ExecResult{
		AgentSessionID:   session.AgentSessionID,
		Status:           ExecStatusStarted,
		TurnID:           turnID,
		Accepted:         true,
		SessionStatus:    session.Status,
		ProviderDispatch: providerDispatch,
	}
	if session.TurnLifecycle != nil {
		result.TurnLifecycle = *session.TurnLifecycle
	}
	if session.SubmitAvailability != nil {
		result.SubmitAvailability = *session.SubmitAvailability
	}
	return result, nil
}

type GoalControlInput struct {
	RoomID             string
	AgentSessionID     string
	Action             GoalControlAction
	Objective          string
	OperationID        string
	GoalRevision       int64
	RepairEpoch        int64
	SubmissionMetadata map[string]any
	RequireLive        bool
}

type GoalControlResult struct {
	AgentSessionID string
	// Goal is the fresh goal snapshot after the action (nil after clear).
	Goal             map[string]any
	Evidence         map[string]any
	ProviderPhase    string
	ExecutionPending bool
}

// GoalControl performs a direct goal action (banner buttons) as a
// session-level control operation — like Cancel, it never opens a turn, so it
// works regardless of what is currently running.
func (c *Controller) GoalControl(ctx context.Context, input GoalControlInput) (GoalControlResult, error) {
	releaseLifecycleLock, err := c.acquireLifecycleLockContext(ctx, input.RoomID, input.AgentSessionID)
	if err != nil {
		return GoalControlResult{}, err
	}
	defer releaseLifecycleLock()
	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return GoalControlResult{}, err
	}
	if session.IsSideConversation() {
		return GoalControlResult{}, ErrSideConversationUnsupported
	}
	goalAdapter, ok := adapter.(GoalAdapter)
	if !ok {
		return GoalControlResult{}, fmt.Errorf("agent provider does not support goals")
	}
	if input.RequireLive {
		if probe, ok := adapter.(LiveSessionProbeAdapter); ok && !probe.HasLiveSession(session) {
			return GoalControlResult{}, ErrSessionDisconnected
		}
	} else {
		if err := c.ensureLiveAdapterSession(ctx, session, adapter); err != nil {
			return GoalControlResult{}, err
		}
	}
	adapterResult, err := goalAdapter.ApplyGoal(ctx, session, GoalApplyInput{
		Action: input.Action, Objective: input.Objective,
		OperationID: input.OperationID, Revision: input.GoalRevision, RepairEpoch: input.RepairEpoch,
		SubmissionMetadata: cloneExecMetadata(input.SubmissionMetadata),
	})
	if err != nil {
		slog.Warn("agent session goal control failed",
			"event", "agent_session.goal_control.failed",
			"room_id", session.RoomID,
			"agent_session_id", session.AgentSessionID,
			"action", string(input.Action),
			"error", err.Error(),
		)
		return GoalControlResult{}, err
	}
	c.applySessionEventsByAgentSessionID(session.AgentSessionID, adapterResult.Events)
	slog.Info("agent session goal control accepted",
		"event", "agent_session.goal_control.accepted",
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"action", string(input.Action),
	)
	return GoalControlResult{
		AgentSessionID:   session.AgentSessionID,
		Goal:             goalAdapter.NormalizeGoalObservation(adapterResult.Observation),
		Evidence:         clonePayload(adapterResult.Evidence),
		ProviderPhase:    adapterResult.ProviderPhase,
		ExecutionPending: adapterResult.ExecutionPending,
	}, nil
}
