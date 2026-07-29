package agentruntime

import (
	"context"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func (c *Controller) Subscribe(roomID, agentSessionID string) (<-chan StreamEvent, func(), bool) {
	roomID = strings.TrimSpace(roomID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if c == nil || roomID == "" || agentSessionID == "" {
		return closedStreamSubscription()
	}
	c.mu.Lock()
	events, unsubscribe, ok := c.subscribeLocked(roomID, agentSessionID)
	c.mu.Unlock()
	return events, unsubscribe, ok
}

// SubscribeWhenAvailable waits for a runtime session to enter the Controller
// registry and then subscribes atomically with its initial state snapshot.
// It is observation-only: it never starts or resumes a provider. The lifecycle
// owner must call Start, Resume, or Host.EnsureRuntimeSession.
func (c *Controller) SubscribeWhenAvailable(
	ctx context.Context,
	roomID string,
	agentSessionID string,
) (<-chan StreamEvent, func(), error) {
	roomID = strings.TrimSpace(roomID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if c == nil || roomID == "" || agentSessionID == "" {
		events, unsubscribe, _ := closedStreamSubscription()
		return events, unsubscribe, ErrSessionNotFound
	}
	if ctx == nil {
		ctx = context.Background()
	}
	key := sessionKey(roomID, agentSessionID)
	for {
		if err := ctx.Err(); err != nil {
			events, unsubscribe, _ := closedStreamSubscription()
			return events, unsubscribe, err
		}
		c.mu.Lock()
		if events, unsubscribe, ok := c.subscribeLocked(roomID, agentSessionID); ok {
			c.mu.Unlock()
			return events, unsubscribe, nil
		}
		if c.sessionAvailabilityWaiters == nil {
			c.sessionAvailabilityWaiters = make(map[string]*sessionAvailabilityWaiter)
		}
		waiter := c.sessionAvailabilityWaiters[key]
		if waiter == nil {
			waiter = &sessionAvailabilityWaiter{changed: make(chan struct{})}
			c.sessionAvailabilityWaiters[key] = waiter
		}
		waiter.refs++
		c.mu.Unlock()

		select {
		case <-ctx.Done():
			c.releaseSessionAvailabilityWaiter(key, waiter)
			events, unsubscribe, _ := closedStreamSubscription()
			return events, unsubscribe, ctx.Err()
		case <-waiter.changed:
			c.releaseSessionAvailabilityWaiter(key, waiter)
		}
	}
}

func (c *Controller) subscribeLocked(roomID, agentSessionID string) (<-chan StreamEvent, func(), bool) {
	key := sessionKey(roomID, agentSessionID)
	session, ok := c.sessions[key]
	var initial []StreamEvent
	if ok {
		initial = append(initial, sessionStateSnapshotStreamEvent(session))
	}
	if snapshot, hasSnapshot := c.commands[key]; hasSnapshot {
		snapshot.Commands = cloneAgentSessionCommands(snapshot.Commands)
		initial = append(initial, commandSnapshotStreamEvent(snapshot))
	}
	if update, hasUpdate := c.configOptionsUpdates[key]; hasUpdate {
		initial = append(initial, configOptionsUpdateStreamEvent(update))
	}
	if !ok {
		return closedStreamSubscription()
	}
	events, unsubscribe := c.hub.SubscribeWithInitial(roomID, agentSessionID, initial)
	return events, unsubscribe, true
}

func (c *Controller) releaseSessionAvailabilityWaiter(key string, waiter *sessionAvailabilityWaiter) {
	c.mu.Lock()
	defer c.mu.Unlock()
	current := c.sessionAvailabilityWaiters[key]
	if current != waiter {
		return
	}
	waiter.refs--
	if waiter.refs == 0 {
		delete(c.sessionAvailabilityWaiters, key)
	}
}

func closedStreamSubscription() (<-chan StreamEvent, func(), bool) {
	ch := make(chan StreamEvent)
	close(ch)
	return ch, func() {}, false
}

func sessionStateSnapshotStreamEvent(session Session) StreamEvent {
	occurredAtUnixMS := session.UpdatedAtUnixMS
	if occurredAtUnixMS <= 0 {
		occurredAtUnixMS = unixMS(now())
	}
	lifecycleStatus, currentPhase := sessionSnapshotLifecycleAndPhase(session.Status)
	return StreamEvent{
		EventType: StreamEventStatePatch,
		Data: agentsessionstore.WorkspaceAgentStatePatch{
			AgentSessionID:    strings.TrimSpace(session.AgentSessionID),
			AgentTargetID:     strings.TrimSpace(session.AgentTargetID),
			Provider:          strings.TrimSpace(session.Provider),
			ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
			CWD:               strings.TrimSpace(session.CWD),
			Title:             strings.TrimSpace(session.Title),
			LifecycleStatus:   lifecycleStatus,
			CurrentPhase:      currentPhase,
			TurnLifecycle:     activityTurnLifecycleFromRuntime(session.TurnLifecycle),
			SubmitAvailability: activitySubmitAvailabilityFromRuntime(
				session.SubmitAvailability,
			),
			OccurredAtUnixMS: occurredAtUnixMS,
		},
	}
}

func statePatchFromSessionStateSnapshot(snapshot SessionStateSnapshot) agentsessionstore.WorkspaceAgentStatePatch {
	runtimeContext := clonePayload(snapshot.RuntimeContext)
	return agentsessionstore.WorkspaceAgentStatePatch{
		AgentSessionID:    strings.TrimSpace(snapshot.AgentSessionID),
		AgentTargetID:     strings.TrimSpace(snapshot.AgentTargetID),
		Provider:          strings.TrimSpace(snapshot.Provider),
		ProviderSessionID: strings.TrimSpace(snapshot.ProviderSessionID),
		Model:             strings.TrimSpace(runtimeContextString(runtimeContext, "model")),
		PermissionModeID:  strings.TrimSpace(snapshot.PermissionModeID),
		Settings:          sessionSettingsPayload(snapshot.Settings),
		RuntimeContext:    runtimeContext,
		TurnLifecycle:     activityTurnLifecycleFromRuntime(snapshot.TurnLifecycle),
		SubmitAvailability: activitySubmitAvailabilityFromRuntime(
			snapshot.SubmitAvailability,
		),
		CWD:              strings.TrimSpace(runtimeContextString(runtimeContext, "cwd")),
		Title:            strings.TrimSpace(runtimeContextString(runtimeContext, "title")),
		LifecycleStatus:  string(activityshared.SessionLifecycleStatusActive),
		CurrentPhase:     snapshotStatusPhase(snapshot.Status),
		OccurredAtUnixMS: snapshot.UpdatedAtUnixMS,
	}
}

func activityTurnLifecycleFromRuntime(value *TurnLifecycle) *canonical.WorkspaceAgentTurnLifecycle {
	if value == nil {
		return nil
	}
	var activeTurnID *string
	if value.ActiveTurnID != nil {
		active := strings.TrimSpace(*value.ActiveTurnID)
		activeTurnID = &active
	}
	var outcome *string
	if value.Outcome != nil {
		next := strings.TrimSpace(*value.Outcome)
		outcome = &next
	}
	return &canonical.WorkspaceAgentTurnLifecycle{
		ActiveTurnID:     activeTurnID,
		Phase:            strings.TrimSpace(value.Phase),
		Settling:         value.Settling,
		Outcome:          outcome,
		CompletedCommand: activityCompletedCommandFromRuntime(value.CompletedCommand),
	}
}

func activityCompletedCommandFromRuntime(value *CompletedCommand) *canonical.WorkspaceAgentCompletedCommand {
	if value == nil {
		return nil
	}
	return &canonical.WorkspaceAgentCompletedCommand{
		Kind:   strings.TrimSpace(value.Kind),
		Status: strings.TrimSpace(value.Status),
	}
}

func activitySubmitAvailabilityFromRuntime(value *SubmitAvailability) *canonical.WorkspaceAgentSubmitAvailability {
	if value == nil {
		return nil
	}
	return &canonical.WorkspaceAgentSubmitAvailability{
		State:  strings.TrimSpace(value.State),
		Reason: strings.TrimSpace(value.Reason),
	}
}

func sessionSettingsPayload(settings *SessionSettings) map[string]any {
	if settings == nil {
		return nil
	}
	payload := map[string]any{
		"model":            strings.TrimSpace(settings.Model),
		"permissionModeId": strings.TrimSpace(settings.PermissionModeID),
		"planMode":         settings.PlanMode,
		"reasoningEffort":  strings.TrimSpace(settings.ReasoningEffort),
	}
	if settings.BrowserUse != nil {
		payload["browserUse"] = *settings.BrowserUse
	}
	if settings.ComputerUse != nil {
		payload["computerUse"] = *settings.ComputerUse
	}
	return payload
}

func sessionSettingsFromPayload(payload map[string]any) *SessionSettings {
	if len(payload) == 0 {
		return nil
	}
	settings := &SessionSettings{
		Model:            strings.TrimSpace(payloadStringValue(payload, "model")),
		PermissionModeID: strings.TrimSpace(payloadStringValue(payload, "permissionModeId")),
		PlanMode:         payloadBoolValue(payload, "planMode"),
		ReasoningEffort:  strings.TrimSpace(payloadStringValue(payload, "reasoningEffort")),
	}
	if value, ok := payload["browserUse"].(bool); ok {
		settings.BrowserUse = &value
	}
	if value, ok := payload["computerUse"].(bool); ok {
		settings.ComputerUse = &value
	}
	if strings.TrimSpace(settings.Model) == "" &&
		strings.TrimSpace(settings.PermissionModeID) == "" &&
		strings.TrimSpace(settings.ReasoningEffort) == "" &&
		!settings.PlanMode &&
		settings.BrowserUse == nil &&
		settings.ComputerUse == nil {
		return nil
	}
	return settings
}

func payloadStringValue(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return value
}

func payloadBoolValue(payload map[string]any, key string) bool {
	value, _ := payload[key].(bool)
	return value
}

func runtimeContextString(runtimeContext map[string]any, key string) string {
	value, _ := runtimeContext[key].(string)
	return strings.TrimSpace(value)
}

func snapshotStatusPhase(status string) string {
	switch strings.TrimSpace(status) {
	case SessionStatusWorking:
		return string(activityshared.TurnPhaseWorking)
	case SessionStatusWaiting:
		return string(activityshared.TurnPhaseWaitingInput)
	case SessionStatusFailed:
		return string(activityshared.TurnPhaseFailed)
	default:
		return string(activityshared.TurnPhaseIdle)
	}
}

func sessionSnapshotLifecycleAndPhase(status string) (string, string) {
	switch strings.TrimSpace(strings.ToLower(status)) {
	case SessionStatusWorking:
		return string(activityshared.SessionLifecycleStatusActive), string(activityshared.TurnPhaseWorking)
	case SessionStatusWaiting:
		return string(activityshared.SessionLifecycleStatusActive), SessionStatusWaiting
	case SessionStatusFailed:
		return string(activityshared.SessionLifecycleStatusFailed), SessionStatusFailed
	case SessionStatusCompleted, SessionStatusCanceled:
		return string(activityshared.SessionLifecycleStatusEnded), string(activityshared.TurnPhaseIdle)
	default:
		return string(activityshared.SessionLifecycleStatusActive), string(activityshared.TurnPhaseIdle)
	}
}
