package agentruntime

import (
	"context"
	"fmt"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func (c *Controller) SubmitInteractive(ctx context.Context, input SubmitInteractiveInput) (SubmitInteractiveResult, error) {
	rootAgentSessionID := strings.TrimSpace(input.RootAgentSessionID)
	if rootAgentSessionID == "" {
		return SubmitInteractiveResult{}, fmt.Errorf("%w: root agent session id is required", ErrInteractiveResponseInvalid)
	}
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	if input.AgentSessionID == "" {
		return SubmitInteractiveResult{}, fmt.Errorf("%w: target agent session id is required", ErrInteractiveResponseInvalid)
	}
	session, adapter, err := c.sessionAndAdapter(input.RoomID, rootAgentSessionID)
	if err != nil {
		return SubmitInteractiveResult{}, err
	}
	if interactiveAdapter, ok := adapter.(InteractiveAdapter); ok {
		result, err := interactiveAdapter.SubmitInteractive(ctx, session, input)
		if result.Disposition == "" {
			if dispositionAdapter, ok := adapter.(InteractiveDispositionAdapter); ok {
				result.Disposition = dispositionAdapter.InteractiveDisposition(session, input.TurnID, input.RequestID)
			}
		}
		if isTerminalInteractiveDisposition(result.Disposition) {
			c.recordTerminalInteractiveDisposition(input.AgentSessionID, input.TurnID, input.RequestID, result.Disposition)
		}
		if err == nil {
			c.syncInteractiveSelectionState(adapter, session, result.OptionID)
			if adapterShouldReceiveInteractiveDenyFollowUp(adapter) {
				result.FollowUpPrompt = interactiveDenyFollowUpPrompt(input)
			}
		}
		return result, err
	}
	return SubmitInteractiveResult{}, fmt.Errorf("agent provider %q does not support interactive submission", session.Provider)
}

func (c *Controller) InteractiveDisposition(roomID string, rootAgentSessionID string, agentSessionID string, turnID string, requestID string) InteractiveDisposition {
	if disposition := c.terminalInteractiveDisposition(agentSessionID, turnID, requestID); disposition != InteractiveDispositionUnknown {
		return disposition
	}
	session, adapter, err := c.sessionAndAdapter(roomID, rootAgentSessionID)
	if err != nil {
		return InteractiveDispositionUnknown
	}
	interactiveAdapter, ok := adapter.(InteractiveDispositionAdapter)
	if targeted, targetedOK := adapter.(TargetedInteractiveDispositionAdapter); targetedOK {
		return targeted.InteractiveDispositionForTarget(session, agentSessionID, turnID, requestID)
	}
	if !ok || strings.TrimSpace(agentSessionID) != strings.TrimSpace(rootAgentSessionID) {
		return InteractiveDispositionUnknown
	}
	return interactiveAdapter.InteractiveDisposition(session, turnID, requestID)
}

func isTerminalInteractiveDisposition(disposition InteractiveDisposition) bool {
	return disposition == InteractiveDispositionAnswered ||
		disposition == InteractiveDispositionSuperseded ||
		disposition == InteractiveDispositionInterrupted
}

func (c *Controller) recordTerminalInteractiveDisposition(agentSessionID string, turnID string, requestID string, disposition InteractiveDisposition) {
	if c == nil || !isTerminalInteractiveDisposition(disposition) {
		return
	}
	c.mu.Lock()
	c.terminalInteractions.put(newInteractiveRequestKey(agentSessionID, turnID, requestID), disposition)
	c.mu.Unlock()
}

func (c *Controller) terminalInteractiveDisposition(agentSessionID string, turnID string, requestID string) InteractiveDisposition {
	if c == nil {
		return InteractiveDispositionUnknown
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.terminalInteractions.get(newInteractiveRequestKey(agentSessionID, turnID, requestID))
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
		AgentSessionID:      strings.TrimSpace(session.AgentSessionID),
		Provider:            strings.TrimSpace(session.Provider),
		ProviderSessionID:   strings.TrimSpace(session.ProviderSessionID),
		PermissionModeID:    strings.TrimSpace(settings.PermissionModeID),
		Settings:            sessionSettingsPayload(&settings),
		RuntimeContextPatch: &canonical.RuntimeContextPatch{Set: runtimeContext},
		OccurredAtUnixMS:    session.UpdatedAtUnixMS,
	}
}

func adapterShouldReceiveInteractiveDenyFollowUp(adapter Adapter) bool {
	if policy, ok := adapter.(InteractiveDenyFollowUpPolicyAdapter); ok {
		return policy.ControllerSendsInteractiveDenyFollowUp()
	}
	return true
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
