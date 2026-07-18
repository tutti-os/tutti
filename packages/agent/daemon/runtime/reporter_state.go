package agentruntime

import (
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func statePatchFromSessionEvent(source canonical.EventSource, event activityshared.Event, sessionID string, timestamp int64) (agentsessionstore.WorkspaceAgentStatePatch, bool) {
	switch event.Type {
	case activityshared.EventSessionStarted,
		activityshared.EventSessionUpdated,
		activityshared.EventSessionCompleted,
		activityshared.EventSessionFailed,
		activityshared.EventTurnStarted,
		activityshared.EventTurnUpdated,
		activityshared.EventTurnCompleted,
		activityshared.EventTurnFailed,
		activityshared.EventTurnCanceled,
		activityshared.EventRootProviderTurnStarted,
		activityshared.EventRootProviderTurnCompleted,
		activityshared.EventInteractionRequested,
		activityshared.EventInteractionSuperseded:
	default:
		return agentsessionstore.WorkspaceAgentStatePatch{}, false
	}
	patch := agentsessionstore.WorkspaceAgentStatePatch{
		AgentSessionID:       sessionID,
		Kind:                 strings.TrimSpace(event.SessionKind),
		RootAgentSessionID:   strings.TrimSpace(event.RootAgentSessionID),
		RootTurnID:           strings.TrimSpace(event.RootTurnID),
		ParentAgentSessionID: strings.TrimSpace(event.ParentAgentSessionID),
		ParentTurnID:         strings.TrimSpace(event.ParentTurnID),
		ParentToolCallID:     strings.TrimSpace(event.ParentToolCallID),
		Provider:             firstNonEmptyString(string(event.Provider), source.Provider),
		ProviderSessionID:    firstNonEmptyString(event.ProviderSessionID, source.ProviderSessionID),
		CWD:                  firstNonEmptyString(event.Payload.CWD, source.CWD),
		Title:                event.Payload.Title,
		CurrentPhase:         currentPhaseFromActivityEvent(event),
		LifecycleStatus:      event.Payload.LifecycleStatus,
		LastError:            statePatchLastError(event),
		OccurredAtUnixMS:     timestamp,
	}
	if transition := event.Payload.Interaction; transition != nil {
		patch.InteractionTransition = &canonical.WorkspaceAgentInteractionTransition{
			RequestID: strings.TrimSpace(transition.RequestID),
			TurnID:    strings.TrimSpace(transition.TurnID),
			Kind:      strings.TrimSpace(transition.Kind),
			Status:    strings.TrimSpace(transition.Status),
			ToolName:  strings.TrimSpace(transition.ToolName),
			Input:     clonePayload(transition.Input),
			Metadata:  clonePayload(transition.Metadata),
		}
	}
	if runtimeContext := payloadMap(event.Payload.Metadata, "runtimeContext"); len(runtimeContext) > 0 {
		patch.RuntimeContext = clonePayload(runtimeContext)
	}
	if turnID := strings.TrimSpace(event.Payload.TurnID); turnID != "" &&
		event.Type != activityshared.EventRootProviderTurnStarted &&
		event.Type != activityshared.EventRootProviderTurnCompleted {
		patch.Turn = &agentsessionstore.WorkspaceAgentTurnPatch{
			TurnID:                turnID,
			Origin:                stringFromPayload(event.Payload.Metadata, "turnOrigin"),
			SourceGoalOperationID: stringFromPayload(event.Payload.Metadata, "sourceGoalOperationId"),
			SourceGoalRevision:    payloadInt64(event.Payload.Metadata, "sourceGoalRevision"),
			SourceGoalRepairEpoch: payloadInt64(event.Payload.Metadata, "sourceGoalRepairEpoch"),
			Phase:                 strings.TrimSpace(event.Payload.TurnPhase),
			Outcome:               strings.TrimSpace(event.Payload.TurnOutcome),
		}
	}
	applyProviderInitiatedInteractionTurnToPatch(&patch, event)
	if patch.Turn != nil {
		if fileChanges := payloadMap(event.Payload.Metadata, "fileChanges"); len(fileChanges) > 0 {
			patch.Turn.FileChanges = clonePayload(fileChanges)
		}
	}
	if !applyLifecycleSnapshotToPatch(&patch, event) {
		applyExplicitTurnLifecycleToPatch(&patch, event)
	}
	if event.Type == activityshared.EventRootProviderTurnStarted || event.Type == activityshared.EventRootProviderTurnCompleted {
		// A provider lifecycle snapshot may update the controller/session view,
		// but root-provider aliases never create canonical Turns implicitly.
		// The verified Goal-start proposal below is the only exception. Completed
		// events retain their explicit RootProviderTurn identity below so the
		// compatibility writer can apply a per-Turn settlement barrier even though
		// this ordinary Turn patch is deliberately absent.
		patch.Turn = nil
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
	case activityshared.EventTurnCanceled:
		patch.LifecycleStatus = firstNonEmptyString(patch.LifecycleStatus, string(activityshared.SessionLifecycleStatusActive))
		patch.CurrentPhase = firstNonEmptyString(patch.CurrentPhase, string(activityshared.TurnPhaseIdle))
		if patch.Turn != nil {
			patch.Turn.CompletedAtUnixMS = timestamp
			patch.Turn.Phase = firstNonEmptyString(patch.Turn.Phase, string(activityshared.TurnPhaseSettled))
		}
	case activityshared.EventRootProviderTurnStarted, activityshared.EventRootProviderTurnCompleted:
		phase := agentsessionstore.RootProviderTurnPhaseRunning
		if event.Type == activityshared.EventRootProviderTurnCompleted {
			phase = agentsessionstore.RootProviderTurnPhaseCompleted
		}
		patch.RootProviderTurn = &canonical.WorkspaceAgentRootProviderTurnTransition{
			RootTurnID:     strings.TrimSpace(event.Payload.TurnID),
			ProviderTurnID: strings.TrimSpace(event.Payload.ProviderTurnID),
			Phase:          phase,
			Outcome:        strings.TrimSpace(event.Payload.TurnOutcome),
			ErrorMessage:   activityshared.BestEffortErrorMessage(event.Payload),
		}
		if event.Type == activityshared.EventRootProviderTurnStarted {
			applyProviderCreatedGoalTurnToPatch(&patch, event, timestamp)
		}
	}
	return patch, true
}

// applyProviderCreatedGoalTurnToPatch turns the provider's first authoritative
// Goal turn_started fact into one compound state report. ReportActivityState
// persists the canonical Turn before applying RootProviderTurn in the same
// SQLite transaction, so messages can never observe a provider alias without
// its owning Turn. Ordinary root-provider events remain unable to create Turns.
func applyProviderCreatedGoalTurnToPatch(
	patch *agentsessionstore.WorkspaceAgentStatePatch,
	event activityshared.Event,
	timestamp int64,
) {
	if patch == nil || patch.RootProviderTurn == nil {
		return
	}
	origin := strings.TrimSpace(stringFromPayload(event.Payload.Metadata, "turnOrigin"))
	if origin != "goal_arm" && origin != "goal_continuation" {
		return
	}
	turnID := strings.TrimSpace(event.Payload.TurnID)
	providerTurnID := strings.TrimSpace(event.Payload.ProviderTurnID)
	if turnID == "" || providerTurnID == "" {
		return
	}

	operationID := strings.TrimSpace(stringFromPayload(event.Payload.Metadata, "sourceGoalOperationId"))
	revision := payloadInt64(event.Payload.Metadata, "sourceGoalRevision")
	repairEpoch := payloadInt64(event.Payload.Metadata, "sourceGoalRepairEpoch")
	if operationID == "" || revision <= 0 || repairEpoch < 0 {
		// Legacy direct /goal prompts predate durable Goal identity. Their actual
		// provider start is safe to adopt, but it must not claim guessed Goal
		// provenance or participate in repair predicates.
		origin = "legacy_unknown"
		operationID = ""
		revision = 0
		repairEpoch = 0
	}
	activeTurnID := turnID
	patch.Turn = &agentsessionstore.WorkspaceAgentTurnPatch{
		TurnID:                turnID,
		Origin:                origin,
		SourceGoalOperationID: operationID,
		SourceGoalRevision:    revision,
		SourceGoalRepairEpoch: repairEpoch,
		ActiveTurnID:          &activeTurnID,
		Phase:                 "running",
		StartedAtUnixMS:       timestamp,
	}
	patch.TurnLifecycle = &canonical.WorkspaceAgentTurnLifecycle{
		ActiveTurnID: &activeTurnID,
		Phase:        "running",
	}
	patch.Turn.SubmitAvailability = submitAvailabilityForExplicitLifecyclePhase("running")
	patch.SubmitAvailability = cloneSubmitAvailability(patch.Turn.SubmitAvailability)
}

// applyProviderInitiatedInteractionTurnToPatch makes the Turn creation an
// explicit part of the provider event projection. ReportActivityState then
// commits this Turn and its first interaction atomically; the interaction
// repository is deliberately unable to synthesize a missing Turn.
func applyProviderInitiatedInteractionTurnToPatch(patch *agentsessionstore.WorkspaceAgentStatePatch, event activityshared.Event) {
	if patch == nil || event.Type != activityshared.EventInteractionRequested || patch.InteractionTransition == nil || patch.Turn == nil {
		return
	}
	if strings.TrimSpace(patch.Turn.Phase) == "" {
		patch.Turn.Phase = "waiting"
	}
	if strings.TrimSpace(patch.Turn.Origin) == "" {
		patch.Turn.Origin = "provider_initiated"
	}
	activeTurnID := strings.TrimSpace(patch.Turn.TurnID)
	patch.Turn.ActiveTurnID = &activeTurnID
}

func cloneStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	cloned := strings.TrimSpace(*value)
	return &cloned
}

func cloneCompletedCommand(value *canonical.WorkspaceAgentCompletedCommand) *canonical.WorkspaceAgentCompletedCommand {
	if value == nil {
		return nil
	}
	return &canonical.WorkspaceAgentCompletedCommand{
		Kind:   strings.TrimSpace(value.Kind),
		Status: strings.TrimSpace(value.Status),
	}
}

func cloneSubmitAvailability(value *canonical.WorkspaceAgentSubmitAvailability) *canonical.WorkspaceAgentSubmitAvailability {
	if value == nil {
		return nil
	}
	return &canonical.WorkspaceAgentSubmitAvailability{
		State:  strings.TrimSpace(value.State),
		Reason: strings.TrimSpace(value.Reason),
	}
}

func cloneTurnLifecycle(value *canonical.WorkspaceAgentTurnLifecycle) *canonical.WorkspaceAgentTurnLifecycle {
	if value == nil {
		return nil
	}
	return &canonical.WorkspaceAgentTurnLifecycle{
		ActiveTurnID:     cloneStringPointer(value.ActiveTurnID),
		Phase:            strings.TrimSpace(value.Phase),
		Settling:         value.Settling,
		Outcome:          cloneStringPointer(value.Outcome),
		CompletedCommand: cloneCompletedCommand(value.CompletedCommand),
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
	patch.TurnLifecycle = &canonical.WorkspaceAgentTurnLifecycle{
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

func submitAvailabilityPatchForSnapshotPhase(phase string) *canonical.WorkspaceAgentSubmitAvailability {
	switch {
	case phase == "settled":
		return &canonical.WorkspaceAgentSubmitAvailability{State: "available"}
	case activityshared.TurnLifecyclePhaseIsWaiting(phase):
		return &canonical.WorkspaceAgentSubmitAvailability{State: "blocked", Reason: "waiting"}
	case activityshared.TurnLifecyclePhaseIsLive(phase):
		return &canonical.WorkspaceAgentSubmitAvailability{State: "blocked", Reason: "active_turn"}
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
	patch.TurnLifecycle = &canonical.WorkspaceAgentTurnLifecycle{
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

func completedCommandFromEventMetadata(metadata map[string]any) *canonical.WorkspaceAgentCompletedCommand {
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
	return &canonical.WorkspaceAgentCompletedCommand{
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

func submitAvailabilityForExplicitLifecyclePhase(phase string) *canonical.WorkspaceAgentSubmitAvailability {
	switch phase {
	case "settled":
		return &canonical.WorkspaceAgentSubmitAvailability{State: "available"}
	case "waiting":
		return &canonical.WorkspaceAgentSubmitAvailability{State: "blocked", Reason: "waiting"}
	case "submitted", "running":
		return &canonical.WorkspaceAgentSubmitAvailability{State: "blocked", Reason: "active_turn"}
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
