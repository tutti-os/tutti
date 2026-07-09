package agent

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

// Protocol v2 turn persistence (agent-gui refactor plan, slice P3).
//
// ReportSessionState used to drop TurnLifecycle on the floor; every turn
// phase transition now lands in the workspace_agent_turns table
// synchronously, and interaction prompts land in
// workspace_agent_interactions, so a daemon restart reconciles from
// persisted truth instead of lazy read-time guessing.

// persistTurnState writes the turn transition and pending interaction
// carried by one session state report, then emits the protocol v2
// turn_update / interaction_update events. Persistence failures are logged
// and swallowed: the legacy state patch path stays authoritative for the
// session row and must not fail because the v2 projection did.
func (p *ActivityProjection) persistTurnState(
	ctx context.Context,
	input agentsessionstore.ReportSessionStateInput,
) {
	if p == nil || p.repo == nil {
		return
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return
	}

	transition, ok := turnTransitionFromStateInput(input)
	var recordedTurnID string
	if ok {
		turn, accepted, err := p.repo.RecordTurnTransition(ctx, transition)
		if err != nil {
			slog.Warn("workspace agent turn transition persist failed",
				"event", "workspace.agent_turn.persist_failed",
				"workspace_id", workspaceID,
				"agent_session_id", agentSessionID,
				"turn_id", transition.TurnID,
				"phase", transition.Phase,
				"error", err,
			)
		} else if accepted {
			recordedTurnID = turn.TurnID
			p.publishActivityUpdated(ctx, workspaceID, agentSessionID, "turn_update",
				activityTurnUpdateEventPayload(workspaceID, agentSessionID, turn, input.State.OccurredAtUnixMS))
		}
	}

	p.persistPendingInteraction(ctx, input, recordedTurnID)
}

func (p *ActivityProjection) persistPendingInteraction(
	ctx context.Context,
	input agentsessionstore.ReportSessionStateInput,
	recordedTurnID string,
) {
	prompt := input.State.PendingInteractive
	if prompt == nil {
		return
	}
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	requestID := strings.TrimSpace(prompt.RequestID)
	if requestID == "" {
		return
	}
	turnID := firstNonEmptyString(recordedTurnID, activeTurnIDFromStateInput(input))
	if turnID == "" {
		// Last resort: the persisted session may still point at the turn.
		if session, ok, err := p.repo.GetSession(ctx, workspaceID, agentSessionID); err == nil && ok {
			turnID = strings.TrimSpace(session.ActiveTurnID)
		}
	}
	if turnID == "" {
		slog.Warn("workspace agent interaction persist skipped without turn attribution",
			"event", "workspace.agent_interaction.persist_skipped",
			"workspace_id", workspaceID,
			"agent_session_id", agentSessionID,
			"request_id", requestID,
		)
		return
	}
	interaction, accepted, err := p.repo.UpsertInteraction(ctx, agentactivitybiz.InteractionUpsert{
		WorkspaceID:      workspaceID,
		AgentSessionID:   agentSessionID,
		RequestID:        requestID,
		TurnID:           turnID,
		Kind:             interactionKindFromPrompt(prompt.Kind),
		Status:           agentactivitybiz.InteractionStatusPending,
		ToolName:         strings.TrimSpace(prompt.ToolName),
		Input:            clonePayload(prompt.Input),
		Output:           clonePayload(prompt.Output),
		Metadata:         clonePayload(prompt.Metadata),
		OccurredAtUnixMS: input.State.OccurredAtUnixMS,
	})
	if err != nil {
		slog.Warn("workspace agent interaction persist failed",
			"event", "workspace.agent_interaction.persist_failed",
			"workspace_id", workspaceID,
			"agent_session_id", agentSessionID,
			"request_id", requestID,
			"error", err,
		)
		return
	}
	if accepted {
		p.publishActivityUpdated(ctx, workspaceID, agentSessionID, "interaction_update",
			activityInteractionUpdateEventPayload(workspaceID, agentSessionID, interaction, input.State.OccurredAtUnixMS))
	}
}

// SettleTurnCanceled force-settles one turn with outcome=canceled and emits
// the turn_update event. It backs the cancelTurn endpoint: the runtime settle
// report may never arrive (dead process, stale turn), so cancellation writes
// persisted truth directly. Already-settled turns reject the transition, so
// the call is idempotent and never double-publishes.
func (p *ActivityProjection) SettleTurnCanceled(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turnID string,
) {
	if p == nil || p.repo == nil {
		return
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	turnID = strings.TrimSpace(turnID)
	if workspaceID == "" || agentSessionID == "" || turnID == "" {
		return
	}
	turn, accepted, err := p.repo.RecordTurnTransition(ctx, agentactivitybiz.TurnTransition{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		TurnID:         turnID,
		Phase:          agentactivitybiz.TurnPhaseSettled,
		Outcome:        agentactivitybiz.TurnOutcomeCanceled,
	})
	if err != nil {
		slog.Warn("workspace agent turn cancel settle failed",
			"event", "workspace.agent_turn.cancel_settle_failed",
			"workspace_id", workspaceID,
			"agent_session_id", agentSessionID,
			"turn_id", turnID,
			"error", err,
		)
		return
	}
	if accepted {
		p.publishActivityUpdated(ctx, workspaceID, agentSessionID, "turn_update",
			activityTurnUpdateEventPayload(workspaceID, agentSessionID, turn, 0))
	}
}

// MarkInteractionAnswered records that the user answered an interaction and
// emits the interaction_update event. Unknown request ids are a no-op: an
// answer racing a settle/supersede is not an error.
func (p *ActivityProjection) MarkInteractionAnswered(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	requestID string,
) {
	if p == nil || p.repo == nil {
		return
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	requestID = strings.TrimSpace(requestID)
	if workspaceID == "" || agentSessionID == "" || requestID == "" {
		return
	}
	pending, err := p.repo.ListSessionInteractions(ctx, agentactivitybiz.ListSessionInteractionsInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Status:         agentactivitybiz.InteractionStatusPending,
	})
	if err != nil {
		slog.Warn("workspace agent interaction answer lookup failed",
			"event", "workspace.agent_interaction.answer_lookup_failed",
			"workspace_id", workspaceID,
			"agent_session_id", agentSessionID,
			"request_id", requestID,
			"error", err,
		)
		return
	}
	for _, existing := range pending {
		if existing.RequestID != requestID {
			continue
		}
		answered, accepted, err := p.repo.UpsertInteraction(ctx, agentactivitybiz.InteractionUpsert{
			WorkspaceID:    workspaceID,
			AgentSessionID: agentSessionID,
			RequestID:      requestID,
			TurnID:         existing.TurnID,
			Kind:           existing.Kind,
			Status:         agentactivitybiz.InteractionStatusAnswered,
			ToolName:       existing.ToolName,
			Input:          existing.Input,
			Output:         existing.Output,
			Metadata:       existing.Metadata,
		})
		if err != nil {
			slog.Warn("workspace agent interaction answer persist failed",
				"event", "workspace.agent_interaction.answer_persist_failed",
				"workspace_id", workspaceID,
				"agent_session_id", agentSessionID,
				"request_id", requestID,
				"error", err,
			)
			return
		}
		if accepted {
			p.publishActivityUpdated(ctx, workspaceID, agentSessionID, "interaction_update",
				activityInteractionUpdateEventPayload(workspaceID, agentSessionID, answered, 0))
		}
		return
	}
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
