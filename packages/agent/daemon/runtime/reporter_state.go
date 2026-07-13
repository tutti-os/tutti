package agentruntime

import (
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func statePatchFromSessionEvent(source agentsessionstore.EventSource, event activityshared.Event, sessionID string, timestamp int64) (agentsessionstore.WorkspaceAgentStatePatch, bool) {
	switch event.Type {
	case activityshared.EventSessionStarted,
		activityshared.EventSessionUpdated,
		activityshared.EventSessionCompleted,
		activityshared.EventSessionFailed,
		activityshared.EventTurnStarted,
		activityshared.EventTurnUpdated,
		activityshared.EventTurnCompleted,
		activityshared.EventTurnFailed:
	default:
		return agentsessionstore.WorkspaceAgentStatePatch{}, false
	}
	patch := agentsessionstore.WorkspaceAgentStatePatch{
		AgentSessionID:    sessionID,
		Provider:          firstNonEmptyString(string(event.Provider), source.Provider),
		ProviderSessionID: firstNonEmptyString(event.ProviderSessionID, source.ProviderSessionID),
		CWD:               firstNonEmptyString(event.Payload.CWD, source.CWD),
		Title:             event.Payload.Title,
		CurrentPhase:      currentPhaseFromActivityEvent(event),
		LifecycleStatus:   event.Payload.LifecycleStatus,
		LastError:         statePatchLastError(event),
		OccurredAtUnixMS:  timestamp,
	}
	if runtimeContext := payloadMap(event.Payload.Metadata, "runtimeContext"); len(runtimeContext) > 0 {
		patch.RuntimeContext = clonePayload(runtimeContext)
	}
	if turnID := strings.TrimSpace(event.Payload.TurnID); turnID != "" {
		patch.Turn = &agentsessionstore.WorkspaceAgentTurnPatch{
			TurnID:  turnID,
			Phase:   strings.TrimSpace(event.Payload.TurnPhase),
			Outcome: strings.TrimSpace(event.Payload.TurnOutcome),
		}
	}
	if !applyLifecycleSnapshotToPatch(&patch, event) {
		applyExplicitTurnLifecycleToPatch(&patch, event)
	}
	switch event.Type {
	case activityshared.EventSessionStarted:
		patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseIdle))
	case activityshared.EventSessionCompleted:
		patch.LifecycleStatus = string(activityshared.SessionStatusCompleted)
		patch.CurrentPhase = string(activityshared.TurnPhaseIdle)
	case activityshared.EventSessionUpdated:
		if event.Payload.EffectiveStatus == string(activityshared.SessionStatusPaused) {
			patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusEnded))
			patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseIdle))
		}
	case activityshared.EventSessionFailed:
		patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusFailed))
		patch.CurrentPhase = string(activityshared.TurnPhaseFailed)
	case activityshared.EventTurnStarted:
		patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseWorking))
		if patch.Turn != nil {
			patch.Turn.StartedAtUnixMS = timestamp
			patch.Turn.Phase = firstNonEmptyString(patch.Turn.Phase, patch.CurrentPhase)
		}
	case activityshared.EventTurnCompleted:
		patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseIdle))
		if patch.Turn != nil {
			patch.Turn.CompletedAtUnixMS = timestamp
			patch.Turn.Phase = firstNonEmptyString(patch.Turn.Phase, patch.CurrentPhase)
		}
	case activityshared.EventTurnFailed:
		patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseIdle))
		if patch.Turn != nil {
			patch.Turn.CompletedAtUnixMS = timestamp
			patch.Turn.Phase = firstNonEmptyString(patch.Turn.Phase, patch.CurrentPhase)
		}
	}
	return patch, true
}

func cloneStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	cloned := strings.TrimSpace(*value)
	return &cloned
}

func cloneCompletedCommand(value *agentsessionstore.WorkspaceAgentCompletedCommand) *agentsessionstore.WorkspaceAgentCompletedCommand {
	if value == nil {
		return nil
	}
	return &agentsessionstore.WorkspaceAgentCompletedCommand{
		Kind:   strings.TrimSpace(value.Kind),
		Status: strings.TrimSpace(value.Status),
	}
}

func cloneSubmitAvailability(value *agentsessionstore.WorkspaceAgentSubmitAvailability) *agentsessionstore.WorkspaceAgentSubmitAvailability {
	if value == nil {
		return nil
	}
	return &agentsessionstore.WorkspaceAgentSubmitAvailability{
		State:  strings.TrimSpace(value.State),
		Reason: strings.TrimSpace(value.Reason),
	}
}

func cloneTurnLifecycle(value *agentsessionstore.WorkspaceAgentTurnLifecycle) *agentsessionstore.WorkspaceAgentTurnLifecycle {
	if value == nil {
		return nil
	}
	return &agentsessionstore.WorkspaceAgentTurnLifecycle{
		ActiveTurnID:     cloneStringPointer(value.ActiveTurnID),
		Phase:            strings.TrimSpace(value.Phase),
		Settling:         value.Settling,
		Outcome:          cloneStringPointer(value.Outcome),
		CompletedCommand: cloneCompletedCommand(value.CompletedCommand),
	}
}

func cloneInteractivePrompt(value *agentsessionstore.WorkspaceAgentInteractivePrompt) *agentsessionstore.WorkspaceAgentInteractivePrompt {
	if value == nil {
		return nil
	}
	return &agentsessionstore.WorkspaceAgentInteractivePrompt{
		Kind:      strings.TrimSpace(value.Kind),
		RequestID: strings.TrimSpace(value.RequestID),
		ToolName:  strings.TrimSpace(value.ToolName),
		Status:    strings.TrimSpace(value.Status),
		Input:     clonePayload(value.Input),
		Output:    clonePayload(value.Output),
		Error:     clonePayload(value.Error),
		Metadata:  clonePayload(value.Metadata),
	}
}

// applyLifecycleSnapshotToPatch copies a stamped TurnLifecycle snapshot
// (ADR 0008) into the state patch, provider-agnostic: the patch is a pure
// copy of the turn owner's statement plus derived views. Returns false when
// the event carries no snapshot and therefore cannot authoritatively reshape
// the persisted turn lifecycle.
func applyLifecycleSnapshotToPatch(patch *agentsessionstore.WorkspaceAgentStatePatch, event activityshared.Event) bool {
	if patch == nil {
		return false
	}
	snapshot, ok := activityshared.TurnLifecycleSnapshotFromEvent(event)
	if !ok {
		return false
	}
	turnID := firstNonEmptyString(strings.TrimSpace(snapshot.ActiveTurnID), strings.TrimSpace(event.Payload.TurnID))
	var turnActive *string
	if snapshot.Phase != "settled" && strings.TrimSpace(snapshot.ActiveTurnID) != "" {
		activeTurnID := strings.TrimSpace(snapshot.ActiveTurnID)
		turnActive = &activeTurnID
	}
	// The persisted store historically records interrupted turns as
	// "canceled"; keep that vocabulary for outcome.
	outcome := strings.TrimSpace(snapshot.Outcome)
	if outcome == string(activityshared.TurnOutcomeInterrupted) {
		outcome = "canceled"
	}
	if patch.Turn == nil {
		patch.Turn = &agentsessionstore.WorkspaceAgentTurnPatch{TurnID: turnID}
	}
	patch.Turn.Phase = snapshot.Phase
	patch.Turn.ActiveTurnID = turnActive
	patch.Turn.Outcome = outcome
	patch.Turn.SubmitAvailability = submitAvailabilityPatchForSnapshotPhase(snapshot.Phase)
	if command := completedCommandFromEventMetadata(event.Payload.Metadata); command != nil {
		patch.Turn.CompletedCommand = command
	}
	patch.SubmitAvailability = cloneSubmitAvailability(patch.Turn.SubmitAvailability)
	patch.TurnLifecycle = &agentsessionstore.WorkspaceAgentTurnLifecycle{
		ActiveTurnID:     turnActive,
		Phase:            snapshot.Phase,
		Outcome:          nil,
		CompletedCommand: cloneCompletedCommand(patch.Turn.CompletedCommand),
	}
	if outcome != "" {
		patch.TurnLifecycle.Outcome = &outcome
	}
	if snapshot.Phase != "" {
		patch.CurrentPhase = currentPhaseForSnapshotPhase(snapshot.Phase, outcome)
	}
	return true
}

func submitAvailabilityPatchForSnapshotPhase(phase string) *agentsessionstore.WorkspaceAgentSubmitAvailability {
	switch {
	case phase == "settled":
		return &agentsessionstore.WorkspaceAgentSubmitAvailability{State: "available"}
	case activityshared.TurnLifecyclePhaseIsWaiting(phase):
		return &agentsessionstore.WorkspaceAgentSubmitAvailability{State: "blocked", Reason: "waiting"}
	case activityshared.TurnLifecyclePhaseIsLive(phase):
		return &agentsessionstore.WorkspaceAgentSubmitAvailability{State: "blocked", Reason: "active_turn"}
	default:
		return nil
	}
}

func currentPhaseForSnapshotPhase(phase string, outcome string) string {
	switch {
	case phase == "settled":
		if outcome == "failed" {
			return "failed"
		}
		return "idle"
	case activityshared.TurnLifecyclePhaseIsWaiting(phase):
		// Preserve the persisted vocabulary: waiting variants are stored
		// verbatim (waiting_approval / waiting_input).
		return phase
	case phase == string(activityshared.TurnPhaseSubmitted):
		return "submitted"
	case activityshared.TurnLifecyclePhaseIsLive(phase):
		return "working"
	default:
		return ""
	}
}

func applyExplicitTurnLifecycleToPatch(patch *agentsessionstore.WorkspaceAgentStatePatch, event activityshared.Event) {
	if patch == nil || !providerUsesExplicitTurnLifecyclePatch(patch.Provider) {
		return
	}
	turnID := strings.TrimSpace(event.Payload.TurnID)
	if turnID == "" {
		return
	}
	lifecyclePhase := explicitTurnLifecyclePhaseFromActivityEvent(event)
	if lifecyclePhase == "" {
		return
	}
	activeTurnID := turnID
	turnActive := &activeTurnID
	outcome := strings.TrimSpace(event.Payload.TurnOutcome)
	if lifecyclePhase == "settled" {
		turnActive = nil
		outcome = explicitTurnLifecycleOutcomeFromActivityEvent(event)
		patch.CurrentPhase = string(activityshared.TurnPhaseIdle)
	}
	if patch.Turn == nil {
		patch.Turn = &agentsessionstore.WorkspaceAgentTurnPatch{TurnID: turnID}
	}
	patch.Turn.Phase = lifecyclePhase
	patch.Turn.ActiveTurnID = turnActive
	patch.Turn.Outcome = outcome
	patch.Turn.SubmitAvailability = submitAvailabilityForExplicitLifecyclePhase(lifecyclePhase)
	if command := completedCommandFromEventMetadata(event.Payload.Metadata); command != nil {
		patch.Turn.CompletedCommand = command
	}
	patch.SubmitAvailability = cloneSubmitAvailability(patch.Turn.SubmitAvailability)
	patch.TurnLifecycle = &agentsessionstore.WorkspaceAgentTurnLifecycle{
		ActiveTurnID:     turnActive,
		Phase:            lifecyclePhase,
		Outcome:          nil,
		CompletedCommand: cloneCompletedCommand(patch.Turn.CompletedCommand),
	}
	if outcome != "" {
		patch.TurnLifecycle.Outcome = &outcome
	}
}

func providerUsesExplicitTurnLifecyclePatch(provider string) bool {
	if resolved, ok := providerregistry.ResolveEventProvider(provider); ok {
		return resolved.TurnLifecycleProjection == providerregistry.TurnLifecycleProjectionExplicit
	}
	return false
}

func completedCommandFromEventMetadata(metadata map[string]any) *agentsessionstore.WorkspaceAgentCompletedCommand {
	kind := firstNonEmptyString(
		stringFromPayload(metadata, "completedCommandKind"),
		stringFromPayload(metadata, "noticeCommand"),
	)
	status := firstNonEmptyString(
		stringFromPayload(metadata, "completedCommandStatus"),
		stringFromPayload(metadata, "noticeCommandStatus"),
	)
	if kind == "" || status == "" {
		return nil
	}
	return &agentsessionstore.WorkspaceAgentCompletedCommand{
		Kind:   kind,
		Status: status,
	}
}

func explicitTurnLifecyclePhaseFromActivityEvent(event activityshared.Event) string {
	switch event.Type {
	case activityshared.EventTurnStarted:
		return "running"
	case activityshared.EventTurnUpdated:
		switch strings.TrimSpace(event.Payload.TurnPhase) {
		case "submitted":
			return "submitted"
		case string(activityshared.TurnPhaseWaiting), string(activityshared.TurnPhaseWaitingApproval), string(activityshared.TurnPhaseWaitingInput):
			return "waiting"
		case string(activityshared.TurnPhaseRunning), string(activityshared.TurnPhaseWorking):
			return "running"
		}
	case activityshared.EventTurnCompleted, activityshared.EventTurnFailed:
		return "settled"
	}
	return ""
}

func explicitTurnLifecycleOutcomeFromActivityEvent(event activityshared.Event) string {
	switch event.Type {
	case activityshared.EventTurnFailed:
		return "failed"
	case activityshared.EventTurnCompleted:
		if strings.TrimSpace(event.Payload.TurnOutcome) == string(activityshared.TurnOutcomeInterrupted) {
			return "canceled"
		}
		return "completed"
	default:
		return strings.TrimSpace(event.Payload.TurnOutcome)
	}
}

func submitAvailabilityForExplicitLifecyclePhase(phase string) *agentsessionstore.WorkspaceAgentSubmitAvailability {
	switch phase {
	case "settled":
		return &agentsessionstore.WorkspaceAgentSubmitAvailability{State: "available"}
	case "waiting":
		return &agentsessionstore.WorkspaceAgentSubmitAvailability{State: "blocked", Reason: "waiting"}
	case "submitted", "running":
		return &agentsessionstore.WorkspaceAgentSubmitAvailability{State: "blocked", Reason: "active_turn"}
	default:
		return nil
	}
}

func statePatchLastError(event activityshared.Event) string {
	if event.Type != activityshared.EventSessionFailed && event.Type != activityshared.EventTurnFailed {
		return ""
	}
	detail := visibleFailureDetail(event)
	if detail == "" {
		return ""
	}
	code := visibleFailureCode(detail)
	switch code {
	case "provider_concurrency_limit",
		"provider_config_timeout",
		"provider_stream_disconnected",
		"quota_or_rate_limit",
		"request_timed_out":
		phase := "turn"
		if event.Type == activityshared.EventSessionFailed {
			phase = "start"
		}
		return visibleFailureContent(string(event.Provider), phase, code)
	default:
		return detail
	}
}

func currentPhaseFromActivityEvent(event activityshared.Event) string {
	if phase := strings.TrimSpace(event.Payload.TurnPhase); phase != "" {
		return phase
	}
	switch strings.ToLower(strings.TrimSpace(event.Payload.EffectiveStatus)) {
	case string(activityshared.SessionStatusWorking), "running", "streaming":
		return string(activityshared.TurnPhaseWorking)
	case "waiting", string(activityshared.TurnPhaseWaitingApproval), string(activityshared.TurnPhaseWaitingInput):
		return strings.TrimSpace(event.Payload.EffectiveStatus)
	case string(activityshared.SessionStatusFailed):
		return string(activityshared.TurnPhaseFailed)
	case string(activityshared.SessionStatusCompleted), string(activityshared.SessionStatusIdle), "ready":
		return string(activityshared.TurnPhaseIdle)
	default:
		return ""
	}
}
