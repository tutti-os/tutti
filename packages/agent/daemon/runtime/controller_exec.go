package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

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
		return c.guideActiveTurn(ctx, session, adapter, content, displayPrompt, metadata)
	}
	titleUpdated := false
	if initialTitle := strings.TrimSpace(input.InitialTitle); initialTitle != "" &&
		!session.InitialTitleEstablished &&
		strings.TrimSpace(session.Title) == strings.TrimSpace(input.InitialTitleBase) {
		session.Title = initialTitle
		session = markInitialTitleEstablished(session)
		session.UpdatedAtUnixMS = unixMS(now())
		titleUpdated = true
	}
	turnID := newID()
	runCtx, cancel := context.WithCancel(context.Background())
	if len(metadata) > 0 {
		runCtx = context.WithValue(runCtx, execMetadataContextKey{}, metadata)
	}
	// beginTurn returns the zero session on failure; keep the real session
	// for the goal-control fallback below.
	startedSession, err := c.beginTurn(session, turnID, cancel)
	if err != nil {
		cancel()
		if errors.Is(err, ErrSessionActiveTurn) {
			// Goal control (/goal paused|active|clear) is a thread-level
			// operation like Cancel: it must act immediately while a turn is
			// running, exactly when the single-turn gate would reject it.
			if result, handled, controlErr := c.execGoalControlWithActiveTurn(ctx, session, adapter, content, displayPrompt, turnID, metadata, titleUpdated); handled {
				return result, controlErr
			}
		}
		return ExecResult{}, err
	}
	session = startedSession
	key := sessionKey(session.RoomID, session.AgentSessionID)
	c.mu.Lock()
	provisional := c.provisionalSessions[key]
	if provisional {
		delete(c.provisionalSessions, key)
	}
	c.mu.Unlock()
	submitEvents := submittedTurnActivityEvents(session, turnID)
	if titleUpdated {
		submitEvents = append([]activityshared.Event{newSessionTitleActivityEvent(session, session.Title)}, submitEvents...)
	}
	if len(submitEvents) > 0 {
		c.publish(session, submitEvents)
		c.enqueueSessionReport(ctx, session, submitEvents)
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
	events, err := guidanceAdapter.GuideActiveTurn(runCtx, session, content, displayPrompt, turnID, nil, nil)
	if err != nil {
		logAgentSubmitTrace("runtime.exec.guidance_failed", session, turnID, metadata, map[string]any{
			"error": err.Error(),
		})
		return ExecResult{}, err
	}
	c.applySessionEventsByAgentSessionID(session.AgentSessionID, events)
	logAgentSubmitTrace("runtime.exec.guidance", session, turnID, metadata, map[string]any{
		"activity_event_count": len(events),
	})
	if refreshed, ok := c.get(session.RoomID, session.AgentSessionID); ok {
		session = refreshed
	}
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
	RoomID         string
	AgentSessionID string
	Action         GoalControlAction
	Objective      string
}

type GoalControlResult struct {
	AgentSessionID string
	// Goal is the fresh goal snapshot after the action (nil after clear).
	Goal map[string]any
}

// GoalControl performs a direct goal action (banner buttons) as a
// session-level control operation — like Cancel, it never opens a turn, so it
// works regardless of what is currently running.
func (c *Controller) GoalControl(ctx context.Context, input GoalControlInput) (GoalControlResult, error) {
	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return GoalControlResult{}, err
	}
	goalAdapter, ok := adapter.(GoalControlAdapter)
	if !ok {
		return GoalControlResult{}, fmt.Errorf("agent provider does not support goals")
	}
	if err := c.ensureLiveAdapterSession(ctx, session, adapter); err != nil {
		return GoalControlResult{}, err
	}
	events, goal, err := goalAdapter.GoalControl(ctx, session, input.Action, input.Objective)
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
	c.applySessionEventsByAgentSessionID(session.AgentSessionID, events)
	slog.Info("agent session goal control accepted",
		"event", "agent_session.goal_control.accepted",
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"action", string(input.Action),
	)
	return GoalControlResult{AgentSessionID: session.AgentSessionID, Goal: goal}, nil
}

// execGoalControlWithActiveTurn runs a /goal control command while another
// turn holds the session's turn slot. The adapter executes it against the
// thread without opening a turn; the resulting events (steered user message,
// goal update, notice) are applied and published through the session-event
// path, and the running turn keeps owning the session lifecycle.
func (c *Controller) execGoalControlWithActiveTurn(
	ctx context.Context,
	session Session,
	adapter Adapter,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	metadata map[string]any,
	titleUpdated bool,
) (ExecResult, bool, error) {
	goalAdapter, ok := adapter.(GoalControlAdapter)
	if !ok {
		return ExecResult{}, false, nil
	}
	events, handled, err := goalAdapter.ExecGoalControl(ctx, session, content, displayPrompt, turnID)
	slog.Info("agent session goal control with active turn",
		"event", "agent_session.goal_control.with_active_turn",
		"room_id", session.RoomID,
		"agent_session_id", session.AgentSessionID,
		"handled", handled,
		"event_count", len(events),
		"error", fmt.Sprintf("%v", err),
	)
	if !handled {
		return ExecResult{}, false, nil
	}
	if err != nil {
		logAgentSubmitTrace("runtime.exec.goal_control_failed", session, turnID, metadata, map[string]any{
			"error": err.Error(),
		})
		return ExecResult{}, true, err
	}
	if titleUpdated {
		c.store(session)
		events = append(
			[]activityshared.Event{newSessionTitleActivityEvent(session, session.Title)},
			events...,
		)
	}
	c.applySessionEventsByAgentSessionID(session.AgentSessionID, events)
	logAgentSubmitTrace("runtime.exec.goal_control", session, turnID, metadata, map[string]any{
		"activity_event_count": len(events),
	})
	if refreshed, ok := c.get(session.RoomID, session.AgentSessionID); ok {
		session = refreshed
	}
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
	return result, true, nil
}
