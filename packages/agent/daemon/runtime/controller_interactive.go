package agentruntime

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func (c *Controller) SubmitInteractive(ctx context.Context, input SubmitInteractiveInput) (SubmitInteractiveResult, error) {
	session, adapter, err := c.sessionAndAdapter(input.RoomID, input.AgentSessionID)
	if err != nil {
		return SubmitInteractiveResult{}, err
	}
	if interactiveAdapter, ok := adapter.(InteractiveAdapter); ok {
		result, err := interactiveAdapter.SubmitInteractive(ctx, session, input)
		if err == nil {
			c.syncInteractiveSelectionState(adapter, session, result.OptionID)
			if adapterShouldReceiveInteractiveDenyFollowUp(adapter) {
				c.scheduleInteractiveDenyFollowUp(input)
			}
		}
		return result, err
	}
	return SubmitInteractiveResult{}, fmt.Errorf("agent provider %q does not support interactive submission", session.Provider)
}

// syncInteractiveSelectionState asks the adapter to interpret its protocol
// option id, then keeps the controller as the single session-state writer.
func (c *Controller) syncInteractiveSelectionState(adapter Adapter, session Session, optionID string) {
	if c == nil {
		return
	}
	stateAdapter, ok := adapter.(InteractiveSelectionStateAdapter)
	if !ok {
		return
	}
	state, ok := stateAdapter.StateAfterInteractiveSelection(session, optionID)
	if !ok {
		return
	}
	current, found := c.Session(session.RoomID, session.AgentSessionID)
	if !found {
		return
	}
	c.applyInteractiveSelectionState(current, state)
}

func (c *Controller) applyInteractiveSelectionState(current Session, state InteractiveSelectionState) {
	currentSettings := normalizeSessionSettings(current.Settings, current.Provider, current.PermissionModeID)
	nextPermission := strings.TrimSpace(state.PermissionMode)
	if nextPermission == "" {
		nextPermission = strings.TrimSpace(currentSettings.PermissionModeID)
	}
	if currentSettings.PlanMode == state.PlanMode &&
		strings.TrimSpace(currentSettings.PermissionModeID) == nextPermission &&
		strings.TrimSpace(current.PermissionModeID) == nextPermission {
		return
	}
	nextSession := current
	nextSession.PermissionModeID = nextPermission
	settings := normalizeSessionSettings(nextSession.Settings, nextSession.Provider, nextSession.PermissionModeID)
	settings.PlanMode = state.PlanMode
	settings.PermissionModeID = nextPermission
	nextSession.Settings = cloneSessionSettings(settings)
	nextSession.UpdatedAtUnixMS = unixMS(now())
	c.store(nextSession)
	patch := permissionModeStatePatch(nextSession)
	c.publishSessionStatePatch(nextSession, patch)
	c.enqueueSessionStatePatchReport(context.Background(), nextSession, patch)
}

// applySessionPlanModeOnly updates the orthogonal plan-mode flag without
// touching permission tiers or model selection.
func (c *Controller) applySessionPlanModeOnly(current Session, planMode bool) {
	if c == nil {
		return
	}
	c.mu.Lock()
	key := sessionKey(current.RoomID, current.AgentSessionID)
	latest, found := c.sessions[key]
	if !found {
		c.mu.Unlock()
		return
	}
	current = latest
	currentSettings := normalizeSessionSettings(current.Settings, current.Provider, current.PermissionModeID)
	if currentSettings.PlanMode == planMode {
		c.mu.Unlock()
		return
	}
	settings := normalizeSessionSettings(current.Settings, current.Provider, current.PermissionModeID)
	settings.PlanMode = planMode
	nextSession := current
	nextSession.Settings = cloneSessionSettings(settings)
	nextSession.UpdatedAtUnixMS = unixMS(now())
	c.sessions[key] = nextSession
	c.mu.Unlock()
	patch := permissionModeStatePatch(nextSession)
	c.publishSessionStatePatch(nextSession, patch)
	c.enqueueSessionStatePatchReport(context.Background(), nextSession, patch)
}

func (c *Controller) syncCursorPlanModeFromACPUpdate(session Session, modeID string) {
	if c == nil {
		return
	}
	descriptor, found := providerregistry.Find(session.Provider)
	if !found || !descriptor.Runtime.StandardACP.ProjectCurrentMode {
		return
	}
	planMode, ok := projectCurrentPlanModeFromACPModeID(descriptor.Runtime.StandardACP, modeID)
	if !ok {
		return
	}
	current, found := c.Session(session.RoomID, session.AgentSessionID)
	if !found || strings.TrimSpace(current.Provider) != descriptor.Identity.ID {
		return
	}
	c.applySessionPlanModeOnly(current, planMode)
}

func projectCurrentPlanModeFromACPModeID(descriptor providerregistry.StandardACPRuntimeDescriptor, modeID string) (bool, bool) {
	modeID = strings.TrimSpace(modeID)
	if modeID == "" {
		return false, false
	}
	for _, mode := range descriptor.PermissionModes {
		if strings.TrimSpace(mode.RuntimeID) == modeID {
			return modeID == strings.TrimSpace(descriptor.PlanModeRuntimeID), true
		}
	}
	return false, false
}

func (c *Controller) syncCursorPlanModeFromEvents(session Session, events []activityshared.Event) {
	for _, event := range events {
		if event.Type != activityshared.EventSessionUpdated {
			continue
		}
		if normalizedSessionUpdateKind(event.Payload.Metadata) != "current_mode_update" {
			continue
		}
		c.syncCursorPlanModeFromACPUpdate(session, asString(event.Payload.Metadata["acpModeId"]))
	}
}

func permissionModeStatePatch(session Session) agentsessionstore.WorkspaceAgentStatePatch {
	settings := normalizeSessionSettings(session.Settings, session.Provider, session.PermissionModeID)
	runtimeContext := map[string]any{
		"permissionModeId": strings.TrimSpace(settings.PermissionModeID),
		"planMode":         settings.PlanMode,
	}
	if strings.TrimSpace(session.CWD) != "" {
		runtimeContext["cwd"] = strings.TrimSpace(session.CWD)
	}
	if strings.TrimSpace(session.Title) != "" {
		runtimeContext["title"] = strings.TrimSpace(session.Title)
	}
	return agentsessionstore.WorkspaceAgentStatePatch{
		AgentSessionID:    strings.TrimSpace(session.AgentSessionID),
		Provider:          strings.TrimSpace(session.Provider),
		ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
		PermissionModeID:  strings.TrimSpace(settings.PermissionModeID),
		Settings:          sessionSettingsPayload(&settings),
		RuntimeContext:    runtimeContext,
		OccurredAtUnixMS:  session.UpdatedAtUnixMS,
	}
}

func adapterShouldReceiveInteractiveDenyFollowUp(adapter Adapter) bool {
	if policy, ok := adapter.(InteractiveDenyFollowUpPolicyAdapter); ok {
		return policy.ControllerSendsInteractiveDenyFollowUp()
	}
	return true
}

func (c *Controller) scheduleInteractiveDenyFollowUp(input SubmitInteractiveInput) {
	prompt := interactiveDenyFollowUpPrompt(input)
	if c == nil || prompt == "" {
		return
	}
	roomID := strings.TrimSpace(input.RoomID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if roomID == "" || agentSessionID == "" {
		return
	}
	go c.runInteractiveDenyFollowUp(roomID, agentSessionID, prompt)
}

func (c *Controller) runInteractiveDenyFollowUp(roomID string, agentSessionID string, prompt string) {
	deadline := time.Now().Add(interactiveDenyFollowUpStartTimeout)
	for {
		if _, ok := c.activeTurn(roomID, agentSessionID); !ok {
			break
		}
		if time.Now().After(deadline) {
			slog.Warn("agent interactive deny follow-up skipped because the active turn did not finish",
				"event", "agent_session.interactive.deny_follow_up.timeout",
				"room_id", roomID,
				"agent_session_id", agentSessionID,
			)
			return
		}
		time.Sleep(interactiveDenyFollowUpPollInterval)
	}
	if _, err := c.Exec(context.Background(), ExecInput{
		RoomID:         roomID,
		AgentSessionID: agentSessionID,
		Content:        []PromptContentBlock{{Type: "text", Text: prompt}},
	}); err != nil {
		slog.Warn("agent interactive deny follow-up failed to start",
			"event", "agent_session.interactive.deny_follow_up.failed",
			"room_id", roomID,
			"agent_session_id", agentSessionID,
			"error", err.Error(),
		)
	}
}

func interactiveDenyFollowUpPrompt(input SubmitInteractiveInput) string {
	if input.Payload == nil || !isInteractiveDenySelection(input) {
		return ""
	}
	return strings.TrimSpace(asString(input.Payload["denyMessage"]))
}

func isInteractiveDenySelection(input SubmitInteractiveInput) bool {
	for _, value := range []string{
		input.Action,
		input.OptionID,
		asString(input.Payload["optionId"]),
	} {
		if isDenyInteractiveSelectionValue(value) {
			return true
		}
	}
	return false
}

func isDenyInteractiveSelectionValue(value string) bool {
	token := normalizePermissionOptionToken(value)
	if token == "" {
		return false
	}
	if permissionOptionDecision(token) == "denied" {
		return true
	}
	switch token {
	case "abort", "aborted":
		return true
	default:
		return false
	}
}
