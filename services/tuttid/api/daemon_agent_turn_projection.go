package api

import (
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

// generatedWorkspaceAgentTurn is the HTTP transport projection for the
// canonical stored turn. Keeping it in api prevents OpenAPI DTO changes from
// implicitly changing the business event protocol.
func generatedWorkspaceAgentTurn(turn agentactivitybiz.Turn) tuttigenerated.WorkspaceAgentTurn {
	var capabilityRefs *[]tuttigenerated.WorkspaceAgentCapabilityReference
	if len(turn.CapabilityRefs) > 0 {
		projected := make([]tuttigenerated.WorkspaceAgentCapabilityReference, 0, len(turn.CapabilityRefs))
		for _, reference := range turn.CapabilityRefs {
			projected = append(projected, tuttigenerated.WorkspaceAgentCapabilityReference{
				Capability: tuttigenerated.WorkspaceAgentCapabilityReferenceCapability(strings.TrimSpace(reference.Capability)),
				Source:     tuttigenerated.WorkspaceAgentCapabilityReferenceSource(strings.TrimSpace(reference.Source)),
			})
		}
		capabilityRefs = &projected
	}
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
			Code:    optionalStringPointer(turn.ErrorCode),
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
		cloned := cloneAgentProjectionPayload(turn.FileChanges)
		fileChanges = &cloned
	}
	var settledAt *int64
	if turn.SettledAtUnixMS > 0 {
		value := turn.SettledAtUnixMS
		settledAt = &value
	}
	return tuttigenerated.WorkspaceAgentTurn{
		AgentSessionId:   strings.TrimSpace(turn.AgentSessionID),
		CapabilityRefs:   capabilityRefs,
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

func generatedWorkspaceAgentInteraction(interaction agentactivitybiz.Interaction) tuttigenerated.WorkspaceAgentInteraction {
	return tuttigenerated.WorkspaceAgentInteraction{
		AgentSessionId:  strings.TrimSpace(interaction.AgentSessionID),
		CreatedAtUnixMs: interaction.CreatedAtUnixMS,
		Input:           optionalAgentProjectionPayload(interaction.Input),
		Kind:            tuttigenerated.WorkspaceAgentInteractionKind(interaction.Kind),
		Metadata:        optionalAgentProjectionPayload(interaction.Metadata),
		Output:          optionalAgentProjectionPayload(interaction.Output),
		RequestId:       strings.TrimSpace(interaction.RequestID),
		Status:          tuttigenerated.WorkspaceAgentInteractionStatus(interaction.Status),
		ToolName:        optionalStringPointer(interaction.ToolName),
		TurnId:          strings.TrimSpace(interaction.TurnID),
		UpdatedAtUnixMs: interaction.UpdatedAtUnixMS,
	}
}

func optionalAgentProjectionPayload(payload map[string]any) *map[string]any {
	if len(payload) == 0 {
		return nil
	}
	cloned := cloneAgentProjectionPayload(payload)
	return &cloned
}

func cloneAgentProjectionPayload(payload map[string]any) map[string]any {
	if payload == nil {
		return nil
	}
	cloned := make(map[string]any, len(payload))
	for key, value := range payload {
		cloned[key] = value
	}
	return cloned
}
