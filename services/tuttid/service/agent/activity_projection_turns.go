package agent

import (
	"context"
	"encoding/json"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
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
	if result.RootTurnAccepted {
		p.publishActivityUpdated(ctx, input.WorkspaceID, result.RootTurn.AgentSessionID, "turn_update",
			activityTurnUpdateEventPayload(input.WorkspaceID, result.RootTurn.AgentSessionID, result.RootTurn, input.State.OccurredAtUnixMS))
		if result.RootTurn.Phase == agentactivitybiz.TurnPhaseSettled {
			p.observeRootTurnSettled(ctx, input.WorkspaceID, result.RootTurn.AgentSessionID, result.RootTurn)
		}
	}
	if result.InteractionResult == agentactivitybiz.InteractionTransitionApplied {
		p.publishActivityUpdated(ctx, input.WorkspaceID, input.AgentSessionID, "interaction_update",
			activityInteractionUpdateEventPayload(input.WorkspaceID, input.AgentSessionID, result.Interaction, input.State.OccurredAtUnixMS))
	}
}

func rootProviderTurnTransitionFromStateInput(
	input agentsessionstore.ReportSessionStateInput,
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
	input agentsessionstore.ReportSessionStateInput,
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
// transition from an explicit structured Turn patch. A phase-less patch is
// accepted only when it carries capability provenance for a metadata-only
// merge. TurnLifecycle is a runtime/session snapshot for presentation and
// must not implicitly mutate a WorkspaceAgentTurn.
func turnTransitionFromStateInput(
	input agentsessionstore.ReportSessionStateInput,
) (agentactivitybiz.TurnTransition, bool) {
	state := input.State
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)

	if turn := state.Turn; turn != nil && strings.TrimSpace(turn.TurnID) != "" {
		capabilityRefs := capabilityReferencesFromTurnPatch(turn.CapabilityRefs)
		rawPhase := strings.TrimSpace(turn.Phase)
		phase := normalizeTurnPhaseV2(turn.Phase, turn.Settling)
		if phase == "" {
			if rawPhase != "" || len(capabilityRefs) == 0 {
				return agentactivitybiz.TurnTransition{}, false
			}
			return agentactivitybiz.TurnTransition{
				WorkspaceID:      workspaceID,
				AgentSessionID:   agentSessionID,
				TurnID:           strings.TrimSpace(turn.TurnID),
				CapabilityRefs:   capabilityRefs,
				OccurredAtUnixMS: state.OccurredAtUnixMS,
			}, true
		}
		transition := agentactivitybiz.TurnTransition{
			WorkspaceID:      workspaceID,
			AgentSessionID:   agentSessionID,
			TurnID:           strings.TrimSpace(turn.TurnID),
			CapabilityRefs:   capabilityRefs,
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

	return agentactivitybiz.TurnTransition{}, false
}

func capabilityReferencesFromTurnPatch(
	references []agentsessionstore.WorkspaceAgentCapabilityReference,
) []agentactivitybiz.CapabilityReference {
	if len(references) == 0 {
		return nil
	}
	mapped := make([]agentactivitybiz.CapabilityReference, 0, len(references))
	for _, reference := range references {
		mapped = append(mapped, agentactivitybiz.CapabilityReference{
			Capability: strings.TrimSpace(reference.Capability),
			Source:     strings.TrimSpace(reference.Source),
		})
	}
	return mapped
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

type activityTurnUpdateEventTurn struct {
	TurnID           string                                 `json:"turnId"`
	AgentSessionID   string                                 `json:"agentSessionId"`
	CapabilityRefs   []agentactivitybiz.CapabilityReference `json:"capabilityRefs,omitempty"`
	Phase            string                                 `json:"phase"`
	Outcome          *string                                `json:"outcome"`
	Error            *activityTurnUpdateEventError          `json:"error"`
	FileChanges      map[string]any                         `json:"fileChanges"`
	CompletedCommand *activityTurnUpdateCompletedCommand    `json:"completedCommand"`
	StartedAtUnixMS  int64                                  `json:"startedAtUnixMs"`
	SettledAtUnixMS  *int64                                 `json:"settledAtUnixMs"`
	UpdatedAtUnixMS  int64                                  `json:"updatedAtUnixMs"`
}

type activityTurnUpdateEventError struct {
	Message string  `json:"message"`
	Code    *string `json:"code,omitempty"`
}

type activityTurnUpdateCompletedCommand struct {
	Kind   string `json:"kind"`
	Status string `json:"status"`
}

type activityInteractionUpdateEventInteraction struct {
	RequestID       string         `json:"requestId"`
	AgentSessionID  string         `json:"agentSessionId"`
	TurnID          string         `json:"turnId"`
	Kind            string         `json:"kind"`
	Status          string         `json:"status"`
	ToolName        *string        `json:"toolName"`
	Input           map[string]any `json:"input"`
	Output          map[string]any `json:"output"`
	Metadata        map[string]any `json:"metadata"`
	CreatedAtUnixMS int64          `json:"createdAtUnixMs"`
	UpdatedAtUnixMS int64          `json:"updatedAtUnixMs"`
}

func activityTurnUpdateEventTurnFromStored(turn agentactivitybiz.Turn) activityTurnUpdateEventTurn {
	var outcome *string
	if value := strings.TrimSpace(turn.Outcome); value != "" {
		outcome = &value
	}
	var turnError *activityTurnUpdateEventError
	if message := strings.TrimSpace(turn.ErrorMessage); message != "" &&
		(turn.Outcome == agentactivitybiz.TurnOutcomeFailed || turn.Outcome == agentactivitybiz.TurnOutcomeInterrupted) {
		turnError = &activityTurnUpdateEventError{Message: message, Code: optionalStringPointerValue(turn.ErrorCode)}
	}
	var completedCommand *activityTurnUpdateCompletedCommand
	if kind := strings.TrimSpace(turn.CompletedCommandKind); kind != "" {
		completedCommand = &activityTurnUpdateCompletedCommand{
			Kind:   kind,
			Status: strings.TrimSpace(turn.CompletedCommandStatus),
		}
	}
	var settledAt *int64
	if turn.SettledAtUnixMS > 0 {
		value := turn.SettledAtUnixMS
		settledAt = &value
	}
	return activityTurnUpdateEventTurn{
		TurnID:           strings.TrimSpace(turn.TurnID),
		AgentSessionID:   strings.TrimSpace(turn.AgentSessionID),
		CapabilityRefs:   append([]agentactivitybiz.CapabilityReference(nil), turn.CapabilityRefs...),
		Phase:            strings.TrimSpace(turn.Phase),
		Outcome:          outcome,
		Error:            turnError,
		FileChanges:      clonePayload(turn.FileChanges),
		CompletedCommand: completedCommand,
		StartedAtUnixMS:  turn.StartedAtUnixMS,
		SettledAtUnixMS:  settledAt,
		UpdatedAtUnixMS:  turn.UpdatedAtUnixMS,
	}
}

func activityInteractionUpdateEventInteractionFromStored(
	interaction agentactivitybiz.Interaction,
) activityInteractionUpdateEventInteraction {
	return activityInteractionUpdateEventInteraction{
		RequestID:       strings.TrimSpace(interaction.RequestID),
		AgentSessionID:  strings.TrimSpace(interaction.AgentSessionID),
		TurnID:          strings.TrimSpace(interaction.TurnID),
		Kind:            strings.TrimSpace(interaction.Kind),
		Status:          strings.TrimSpace(interaction.Status),
		ToolName:        optionalStringPointerValue(interaction.ToolName),
		Input:           clonePayload(interaction.Input),
		Output:          clonePayload(interaction.Output),
		Metadata:        clonePayload(interaction.Metadata),
		CreatedAtUnixMS: interaction.CreatedAtUnixMS,
		UpdatedAtUnixMS: interaction.UpdatedAtUnixMS,
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
		"turn":             typedEventPayload(activityTurnUpdateEventTurnFromStored(turn)),
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
		"interaction":      typedEventPayload(activityInteractionUpdateEventInteractionFromStored(interaction)),
	}
}

// typedEventPayload preserves the event-specific JSON field contract while the
// publisher seam remains map-based.
func typedEventPayload(value any) map[string]any {
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
