package agent

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

// Protocol v2 turn persistence (agent-gui refactor plan, slice P3).
//
// ReportSessionState used to drop TurnLifecycle on the floor. Session, turn,
// and interaction state now commit through ReportActivityState as one SQLite
// transaction, so a daemon restart reconciles from persisted truth and no
// protocol v2 child write can fail after the session row has committed.

// publishPersistedTurnState emits protocol v2 events only after the atomic
// session/turn/interaction transaction has committed.
func (p *ActivityProjection) publishPersistedTurnState(
	ctx context.Context,
	input canonical.ReportSessionStateInput,
	result agentactivitybiz.ActivityStateReportResult,
) {
	if p == nil {
		return
	}
	if result.TurnAccepted {
		p.publishActivityUpdated(ctx, input.WorkspaceID, input.AgentSessionID, "turn_update",
			activityTurnUpdateEventPayload(input.WorkspaceID, input.AgentSessionID, result.Turn, input.State.OccurredAtUnixMS))
	}
	if result.RootTurnAccepted {
		p.publishActivityUpdated(ctx, input.WorkspaceID, result.RootTurn.AgentSessionID, "turn_update",
			activityTurnUpdateEventPayload(input.WorkspaceID, result.RootTurn.AgentSessionID, result.RootTurn, input.State.OccurredAtUnixMS))
	}
	if result.InteractionResult == agentactivitybiz.InteractionTransitionApplied {
		p.publishActivityUpdated(ctx, input.WorkspaceID, input.AgentSessionID, "interaction_update",
			activityInteractionUpdateEventPayload(input.WorkspaceID, input.AgentSessionID, result.Interaction, input.State.OccurredAtUnixMS))
	}
}

func rootProviderTurnTransitionFromStateInput(
	input canonical.ReportSessionStateInput,
) (agentactivitybiz.RootProviderTurnTransition, bool) {
	root := input.State.RootProviderTurn
	if root == nil || strings.TrimSpace(root.RootTurnID) == "" || strings.TrimSpace(root.ProviderTurnID) == "" {
		return agentactivitybiz.RootProviderTurnTransition{}, false
	}
	transition := agentactivitybiz.RootProviderTurnTransition{
		WorkspaceID:        strings.TrimSpace(input.WorkspaceID),
		RootAgentSessionID: strings.TrimSpace(input.AgentSessionID),
		RootTurnID:         strings.TrimSpace(root.RootTurnID),
		ProviderTurnID:     strings.TrimSpace(root.ProviderTurnID),
		Phase:              strings.TrimSpace(root.Phase),
		Outcome:            normalizeTurnOutcomeV2(root.Outcome),
		ErrorMessage:       strings.TrimSpace(root.ErrorMessage),
		ErrorCode:          strings.TrimSpace(root.ErrorCode),
		OccurredAtUnixMS:   input.State.OccurredAtUnixMS,
	}
	if root.CompletedCommand != nil {
		transition.CompletedCommandKind = strings.TrimSpace(root.CompletedCommand.Kind)
		transition.CompletedCommandStatus = strings.TrimSpace(root.CompletedCommand.Status)
	}
	return transition, true
}

func interactionTransitionFromStateInput(
	input canonical.ReportSessionStateInput,
) (*agentactivitybiz.InteractionUpsert, error) {
	transition := input.State.InteractionTransition
	if transition == nil {
		return nil, nil
	}
	status := strings.TrimSpace(transition.Status)
	if status != agentactivitybiz.InteractionStatusPending && status != agentactivitybiz.InteractionStatusSuperseded {
		return nil, ErrInvalidArgument
	}
	if strings.TrimSpace(transition.RequestID) == "" || strings.TrimSpace(transition.TurnID) == "" {
		return nil, ErrInvalidArgument
	}
	return &agentactivitybiz.InteractionUpsert{
		WorkspaceID:      strings.TrimSpace(input.WorkspaceID),
		AgentSessionID:   strings.TrimSpace(input.AgentSessionID),
		RequestID:        strings.TrimSpace(transition.RequestID),
		TurnID:           strings.TrimSpace(transition.TurnID),
		Kind:             normalizeInteractionKind(transition.Kind),
		Status:           status,
		ToolName:         strings.TrimSpace(transition.ToolName),
		Input:            clonePayload(transition.Input),
		Metadata:         clonePayload(transition.Metadata),
		OccurredAtUnixMS: input.State.OccurredAtUnixMS,
	}, nil
}

// turnTransitionFromStateInput derives one closed-vocabulary canonical turn
// transition from an explicit structured Turn patch. TurnLifecycle is a
// runtime/session snapshot for presentation and must not implicitly mutate a
// WorkspaceAgentTurn.
func turnTransitionFromStateInput(
	input canonical.ReportSessionStateInput,
) (agentactivitybiz.TurnTransition, bool) {
	state := input.State
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)

	if turn := state.Turn; turn != nil && strings.TrimSpace(turn.TurnID) != "" {
		phase := normalizeTurnPhaseV2(turn.Phase, turn.Settling)
		if phase == "" {
			return agentactivitybiz.TurnTransition{}, false
		}
		transition := agentactivitybiz.TurnTransition{
			WorkspaceID:             workspaceID,
			AgentSessionID:          agentSessionID,
			TurnID:                  strings.TrimSpace(turn.TurnID),
			Phase:                   phase,
			Outcome:                 normalizeTurnOutcomeV2(turn.Outcome),
			FileChanges:             clonePayload(turn.FileChanges),
			StartedAtUnixMS:         turn.StartedAtUnixMS,
			SettledAtUnixMS:         turn.CompletedAtUnixMS,
			OccurredAtUnixMS:        state.OccurredAtUnixMS,
			Origin:                  strings.TrimSpace(turn.Origin),
			SourceGoalOperationID:   strings.TrimSpace(turn.SourceGoalOperationID),
			SourceGoalRevision:      turn.SourceGoalRevision,
			SourceGoalRepairEpoch:   turn.SourceGoalRepairEpoch,
			FinalAssistantMessageID: strings.TrimSpace(turn.FinalAssistantMessageID),
		}
		if turn.CompletedCommand != nil {
			transition.CompletedCommandKind = strings.TrimSpace(turn.CompletedCommand.Kind)
			transition.CompletedCommandStatus = strings.TrimSpace(turn.CompletedCommand.Status)
		}
		if phase == agentactivitybiz.TurnPhaseSettled && transition.Outcome == agentactivitybiz.TurnOutcomeFailed {
			transition.ErrorMessage = strings.TrimSpace(state.LastError)
		}
		return transition, true
	}

	return agentactivitybiz.TurnTransition{}, false
}

// normalizeTurnPhaseV2 maps the open runtime phase vocabulary onto the
// closed protocol v2 enum. Unknown phases return "" and are skipped rather
// than guessed.
func normalizeTurnPhaseV2(phase string, settling bool) string {
	normalized := strings.ToLower(strings.TrimSpace(phase))
	if normalized == "settled" {
		return agentactivitybiz.TurnPhaseSettled
	}
	if settling {
		return agentactivitybiz.TurnPhaseSettling
	}
	switch normalized {
	case "submitted":
		return agentactivitybiz.TurnPhaseSubmitted
	case "running", "working", "streaming", "in_progress", "active":
		return agentactivitybiz.TurnPhaseRunning
	case "waiting", "waiting_approval", "waiting_input", "awaiting_approval":
		return agentactivitybiz.TurnPhaseWaiting
	case "settling":
		return agentactivitybiz.TurnPhaseSettling
	default:
		return ""
	}
}

// normalizeTurnOutcomeV2 maps runtime outcome spellings onto the closed
// protocol v2 enum; unknown outcomes return "".
func normalizeTurnOutcomeV2(outcome string) string {
	switch strings.ToLower(strings.TrimSpace(outcome)) {
	case "completed", "complete", "success", "succeeded":
		return agentactivitybiz.TurnOutcomeCompleted
	case "failed", "failure", "error", "errored":
		return agentactivitybiz.TurnOutcomeFailed
	case "canceled", "cancelled":
		return agentactivitybiz.TurnOutcomeCanceled
	case "interrupted":
		return agentactivitybiz.TurnOutcomeInterrupted
	default:
		return ""
	}
}

// normalizeInteractionKind maps the explicit runtime transition vocabulary
// onto the closed protocol v2 interaction kind enum. Unknown kinds stay
// invalid so the atomic report fails instead of silently becoming approval.
func normalizeInteractionKind(kind string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "ask-user", "question":
		return agentactivitybiz.InteractionKindQuestion
	case "exit-plan", "plan":
		return agentactivitybiz.InteractionKindPlan
	case "approval":
		return agentactivitybiz.InteractionKindApproval
	default:
		return ""
	}
}

// GeneratedWorkspaceAgentTurn is the completeness-guarded projection from the
// stored turn record to the generated transport type (refactor plan rule
// six): every WorkspaceAgentTurn field is assigned explicitly, and
// TestGeneratedTurnFromStoredCoversAllFields fails when the generated type
// grows a field this projection does not populate.
func GeneratedWorkspaceAgentTurn(turn agentactivitybiz.Turn) tuttigenerated.WorkspaceAgentTurn {
	var outcome *tuttigenerated.WorkspaceAgentTurnOutcome
	if trimmed := strings.TrimSpace(turn.Outcome); trimmed != "" {
		value := tuttigenerated.WorkspaceAgentTurnOutcome(trimmed)
		outcome = &value
	}
	var turnError *tuttigenerated.WorkspaceAgentTurnError
	if message := strings.TrimSpace(turn.ErrorMessage); message != "" &&
		(turn.Outcome == agentactivitybiz.TurnOutcomeFailed || turn.Outcome == agentactivitybiz.TurnOutcomeInterrupted) {
		turnError = &tuttigenerated.WorkspaceAgentTurnError{
			Message: message,
			Code:    optionalStringPointerValue(turn.ErrorCode),
		}
	}
	var completedCommand *tuttigenerated.WorkspaceAgentCompletedCommand
	if kind := strings.TrimSpace(turn.CompletedCommandKind); kind != "" {
		completedCommand = &tuttigenerated.WorkspaceAgentCompletedCommand{
			Kind:   tuttigenerated.WorkspaceAgentCompletedCommandKind(kind),
			Status: tuttigenerated.WorkspaceAgentCompletedCommandStatus(strings.TrimSpace(turn.CompletedCommandStatus)),
		}
	}
	var fileChanges *map[string]any
	if len(turn.FileChanges) > 0 {
		cloned := clonePayload(turn.FileChanges)
		fileChanges = &cloned
	}
	var settledAt *int64
	if turn.SettledAtUnixMS > 0 {
		value := turn.SettledAtUnixMS
		settledAt = &value
	}
	origin := tuttigenerated.WorkspaceAgentTurnOrigin(strings.TrimSpace(turn.Origin))
	var sourceGoalOperationID *string
	if value := strings.TrimSpace(turn.SourceGoalOperationID); value != "" {
		sourceGoalOperationID = &value
	}
	var sourceGoalRevision *int64
	if turn.SourceGoalRevision > 0 {
		value := turn.SourceGoalRevision
		sourceGoalRevision = &value
	}
	var sourceGoalRepairEpoch *int64
	if sourceGoalOperationID != nil {
		value := turn.SourceGoalRepairEpoch
		sourceGoalRepairEpoch = &value
	}
	return tuttigenerated.WorkspaceAgentTurn{
		AgentSessionId:        strings.TrimSpace(turn.AgentSessionID),
		CompletedCommand:      completedCommand,
		Error:                 turnError,
		FileChanges:           fileChanges,
		Outcome:               outcome,
		Origin:                origin,
		Phase:                 tuttigenerated.WorkspaceAgentTurnPhase(turn.Phase),
		SettledAtUnixMs:       settledAt,
		StartedAtUnixMs:       turn.StartedAtUnixMS,
		SourceGoalOperationId: sourceGoalOperationID,
		SourceGoalRevision:    sourceGoalRevision,
		SourceGoalRepairEpoch: sourceGoalRepairEpoch,
		TurnId:                strings.TrimSpace(turn.TurnID),
		UpdatedAtUnixMs:       turn.UpdatedAtUnixMS,
	}
}

// GeneratedWorkspaceAgentInteraction is the completeness-guarded projection from
// the stored interaction record to the generated transport type; see
// GeneratedWorkspaceAgentTurn.
func GeneratedWorkspaceAgentInteraction(interaction agentactivitybiz.Interaction) tuttigenerated.WorkspaceAgentInteraction {
	return tuttigenerated.WorkspaceAgentInteraction{
		AgentSessionId:  strings.TrimSpace(interaction.AgentSessionID),
		CreatedAtUnixMs: interaction.CreatedAtUnixMS,
		Input:           optionalPayloadPointer(interaction.Input),
		Kind:            tuttigenerated.WorkspaceAgentInteractionKind(interaction.Kind),
		Metadata:        optionalPayloadPointer(interaction.Metadata),
		Output:          optionalPayloadPointer(interaction.Output),
		RequestId:       strings.TrimSpace(interaction.RequestID),
		Status:          tuttigenerated.WorkspaceAgentInteractionStatus(interaction.Status),
		ToolName:        optionalStringPointerValue(interaction.ToolName),
		TurnId:          strings.TrimSpace(interaction.TurnID),
		UpdatedAtUnixMs: interaction.UpdatedAtUnixMS,
	}
}

func activityTurnUpdateEventPayload(
	workspaceID string,
	agentSessionID string,
	turn agentactivitybiz.Turn,
	occurredAtUnixMS int64,
) map[string]any {
	var activeTurnID any
	if turn.Phase != agentactivitybiz.TurnPhaseSettled {
		activeTurnID = strings.TrimSpace(turn.TurnID)
	}
	return map[string]any{
		"workspaceId":      strings.TrimSpace(workspaceID),
		"agentSessionId":   strings.TrimSpace(agentSessionID),
		"eventType":        "turn_update",
		"occurredAtUnixMs": firstNonZeroInt64(occurredAtUnixMS, turn.UpdatedAtUnixMS),
		"activeTurnId":     activeTurnID,
		"turn":             generatedTypePayload(GeneratedWorkspaceAgentTurn(turn)),
	}
}

func activityInteractionUpdateEventPayload(
	workspaceID string,
	agentSessionID string,
	interaction agentactivitybiz.Interaction,
	occurredAtUnixMS int64,
) map[string]any {
	return map[string]any{
		"workspaceId":      strings.TrimSpace(workspaceID),
		"agentSessionId":   strings.TrimSpace(agentSessionID),
		"eventType":        "interaction_update",
		"occurredAtUnixMs": firstNonZeroInt64(occurredAtUnixMS, interaction.UpdatedAtUnixMS),
		"interaction":      generatedTypePayload(GeneratedWorkspaceAgentInteraction(interaction)),
	}
}

// generatedTypePayload projects a generated transport struct into the
// map-based publisher payload through its canonical JSON encoding, so event
// payload shapes come from the generated types instead of hand-built maps.
func generatedTypePayload(value any) map[string]any {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		return nil
	}
	return payload
}

func optionalStringPointerValue(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func optionalPayloadPointer(payload map[string]any) *map[string]any {
	if len(payload) == 0 {
		return nil
	}
	cloned := clonePayload(payload)
	return &cloned
}
