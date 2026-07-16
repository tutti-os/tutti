package agentruntime

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func (c *Controller) Exec(ctx context.Context, input ExecInput) (ExecResult, error) {
	releaseLifecycleLock := c.acquireLifecycleLock(input.RoomID, input.AgentSessionID)
	defer releaseLifecycleLock()

	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return ExecResult{}, err
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
	displayPrompt := strings.TrimSpace(input.DisplayPrompt)
	if promptAdapter, ok := adapter.(PromptContentAdapter); ok {
		if err := promptAdapter.ValidatePromptContent(session, content); err != nil {
			return ExecResult{}, err
		}
	}
	if input.Guidance {
		return c.guideActiveTurn(ctx, session, adapter, content, displayPrompt, metadata, input.CapabilityRefs)
	}
	previousSession := session
	titleUpdated := false
	if initialTitle := strings.TrimSpace(input.InitialTitle); initialTitle != "" &&
		!session.InitialTitleEstablished &&
		strings.TrimSpace(session.Title) == strings.TrimSpace(input.InitialTitleBase) {
		session.Title = initialTitle
		session = markInitialTitleEstablished(session)
		session.UpdatedAtUnixMS = unixMS(now())
		titleUpdated = true
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
	tuttiModeSnapshot := normalizeTuttiModeTurnSnapshot(input.TuttiModeSnapshot)
	runCtx = withTuttiModeTurnSnapshot(runCtx, tuttiModeSnapshot)
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
	submitEvents := submittedTurnActivityEvents(session, turnID, input.CapabilityRefs)
	if titleUpdated {
		submitEvents = append([]activityshared.Event{newSessionTitleActivityEvent(session, session.Title)}, submitEvents...)
	}
	if err := c.reportSubmittedTurnDurable(ctx, session, submitEvents); err != nil {
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
	go c.runExecTurn(runCtx, session, adapter, content, displayPrompt, turnID)
	return ExecResult{
		AgentSessionID:     session.AgentSessionID,
		Status:             ExecStatusStarted,
		TurnID:             turnID,
		Accepted:           true,
		SessionStatus:      session.Status,
		TurnLifecycle:      *session.TurnLifecycle,
		SubmitAvailability: *session.SubmitAvailability,
	}, nil
}

func (c *Controller) guideActiveTurn(
	ctx context.Context,
	session Session,
	adapter Adapter,
	content []PromptContentBlock,
	displayPrompt string,
	metadata map[string]any,
	capabilityRefs []activityshared.CapabilityReference,
) (ExecResult, error) {
	guidanceAdapter, ok := adapter.(ActiveTurnGuidanceAdapter)
	if !ok {
		return ExecResult{}, ErrActiveTurnGuidanceUnsupported
	}
	turnID, ok := c.activeTurnID(session.RoomID, session.AgentSessionID)
	if !ok {
		return ExecResult{}, ErrSessionNoActiveTurn
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
	events, err := guidanceAdapter.GuideActiveTurn(runCtx, session, content, displayPrompt, turnID, emit, emitCommands)
	if err != nil {
		logAgentSubmitTrace("runtime.exec.guidance_failed", session, turnID, metadata, map[string]any{
			"error": err.Error(),
		})
		return ExecResult{}, err
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
		AgentSessionID: session.AgentSessionID,
		Status:         ExecStatusStarted,
		TurnID:         turnID,
		Accepted:       true,
		SessionStatus:  session.Status,
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
}

type GoalControlResult struct {
	AgentSessionID string
	// Goal is the fresh goal snapshot after the action (nil after clear).
	Goal          map[string]any
	Evidence      map[string]any
	ProviderPhase string
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
	goalAdapter, ok := adapter.(GoalAdapter)
	if !ok {
		return GoalControlResult{}, fmt.Errorf("agent provider does not support goals")
	}
	if err := c.ensureLiveAdapterSession(ctx, session, adapter); err != nil {
		return GoalControlResult{}, err
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
		AgentSessionID: session.AgentSessionID,
		Goal:           goalAdapter.NormalizeGoalObservation(adapterResult.Observation),
		Evidence:       clonePayload(adapterResult.Evidence),
		ProviderPhase:  adapterResult.ProviderPhase,
	}, nil
}
