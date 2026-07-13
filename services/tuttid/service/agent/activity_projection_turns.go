package agent

import (
	"context"
	"encoding/json"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
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
	input agentsessionstore.ReportSessionStateInput,
	result agentactivitybiz.ActivityStateReportResult,
) {
	if p == nil {
		return
	}
	if result.TurnAccepted {
		p.publishActivityUpdated(ctx, input.WorkspaceID, input.AgentSessionID, "turn_update",
			activityTurnUpdateEventPayload(input.WorkspaceID, input.AgentSessionID, result.Turn, input.State.OccurredAtUnixMS))
	}
	if result.InteractionAccepted {
		p.publishActivityUpdated(ctx, input.WorkspaceID, input.AgentSessionID, "interaction_update",
			activityInteractionUpdateEventPayload(input.WorkspaceID, input.AgentSessionID, result.Interaction, input.State.OccurredAtUnixMS))
	}
}

func pendingInteractionFromStateInput(
	input agentsessionstore.ReportSessionStateInput,
	transition *agentactivitybiz.TurnTransition,
) (*agentactivitybiz.InteractionUpsert, error) {
	prompt := input.State.PendingInteractive
	if prompt == nil {
		return nil, nil
	}
	if strings.TrimSpace(prompt.RequestID) == "" {
		return nil, ErrInvalidArgument
	}
	turnID := activeTurnIDFromStateInput(input)
	if transition != nil && transition.Phase != agentactivitybiz.TurnPhaseSettled {
		turnID = strings.TrimSpace(transition.TurnID)
	}
	if turnID == "" {
		return nil, ErrInvalidArgument
	}
	return &agentactivitybiz.InteractionUpsert{
		WorkspaceID:      strings.TrimSpace(input.WorkspaceID),
		AgentSessionID:   strings.TrimSpace(input.AgentSessionID),
		RequestID:        strings.TrimSpace(prompt.RequestID),
		TurnID:           turnID,
		Kind:             interactionKindFromPrompt(prompt.Kind),
		Status:           agentactivitybiz.InteractionStatusPending,
		ToolName:         strings.TrimSpace(prompt.ToolName),
		Input:            clonePayload(prompt.Input),
		Output:           clonePayload(prompt.Output),
		Metadata:         clonePayload(prompt.Metadata),
		OccurredAtUnixMS: input.State.OccurredAtUnixMS,
	}, nil
}

// turnTransitionFromStateInput derives one closed-vocabulary turn transition
// from a session state report. The structured Turn patch wins; a bare
// TurnLifecycle is the fallback carrier. Reports without turn information
// produce no transition.
func turnTransitionFromStateInput(
	input agentsessionstore.ReportSessionStateInput,
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
			WorkspaceID:      workspaceID,
			AgentSessionID:   agentSessionID,
			TurnID:           strings.TrimSpace(turn.TurnID),
			Phase:            phase,
			Outcome:          normalizeTurnOutcomeV2(turn.Outcome),
			FileChanges:      clonePayload(turn.FileChanges),
			StartedAtUnixMS:  turn.StartedAtUnixMS,
			SettledAtUnixMS:  turn.CompletedAtUnixMS,
			OccurredAtUnixMS: state.OccurredAtUnixMS,
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

	if lifecycle := state.TurnLifecycle; lifecycle != nil {
		turnID := ""
		if lifecycle.ActiveTurnID != nil {
			turnID = strings.TrimSpace(*lifecycle.ActiveTurnID)
		}
		if turnID == "" {
			return agentactivitybiz.TurnTransition{}, false
		}
		phase := normalizeTurnPhaseV2(lifecycle.Phase, lifecycle.Settling)
		if phase == "" {
			return agentactivitybiz.TurnTransition{}, false
		}
		outcome := ""
		if lifecycle.Outcome != nil {
			outcome = normalizeTurnOutcomeV2(*lifecycle.Outcome)
		}
		transition := agentactivitybiz.TurnTransition{
			WorkspaceID:      workspaceID,
			AgentSessionID:   agentSessionID,
			TurnID:           turnID,
			Phase:            phase,
			Outcome:          outcome,
			OccurredAtUnixMS: state.OccurredAtUnixMS,
		}
		if lifecycle.CompletedCommand != nil {
			transition.CompletedCommandKind = strings.TrimSpace(lifecycle.CompletedCommand.Kind)
			transition.CompletedCommandStatus = strings.TrimSpace(lifecycle.CompletedCommand.Status)
		}
		return transition, true
	}

	return agentactivitybiz.TurnTransition{}, false
}

func activeTurnIDFromStateInput(input agentsessionstore.ReportSessionStateInput) string {
	if turn := input.State.Turn; turn != nil {
		if phase := normalizeTurnPhaseV2(turn.Phase, turn.Settling); phase != "" && phase != agentactivitybiz.TurnPhaseSettled {
			return strings.TrimSpace(turn.TurnID)
		}
	}
	if lifecycle := input.State.TurnLifecycle; lifecycle != nil && lifecycle.ActiveTurnID != nil {
		return strings.TrimSpace(*lifecycle.ActiveTurnID)
	}
	return ""
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

// interactionKindFromPrompt maps runtime interactive prompt kinds onto the
// closed protocol v2 interaction kind enum.
func interactionKindFromPrompt(kind string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "ask-user", "question":
		return agentactivitybiz.InteractionKindQuestion
	case "exit-plan", "plan":
		return agentactivitybiz.InteractionKindPlan
	default:
		return agentactivitybiz.InteractionKindApproval
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
	if message := strings.TrimSpace(turn.ErrorMessage); message != "" {
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
	return tuttigenerated.WorkspaceAgentTurn{
		AgentSessionId:   strings.TrimSpace(turn.AgentSessionID),
		CompletedCommand: completedCommand,
		Error:            turnError,
		FileChanges:      fileChanges,
		Outcome:          outcome,
		Phase:            tuttigenerated.WorkspaceAgentTurnPhase(turn.Phase),
		SettledAtUnixMs:  settledAt,
		StartedAtUnixMs:  turn.StartedAtUnixMS,
		TurnId:           strings.TrimSpace(turn.TurnID),
		UpdatedAtUnixMs:  turn.UpdatedAtUnixMS,
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
