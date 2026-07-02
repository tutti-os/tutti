//nolint:unused // Retain migrated helpers until the next agent-daemon decomposition pass.
package agentsessionstore

import (
	"context"
	"fmt"
	"strings"
)

func ReportActivityAsSessionUpdates(
	ctx context.Context,
	reporter SessionActivityReporter,
	input ReportActivityInput,
) (ReportActivityReply, error) {
	reply := ReportActivityReply{
		AcceptedTimelineItemCount: 0,
	}
	if reporter == nil {
		return reply, nil
	}
	for _, stateInput := range SessionStateInputsFromActivity(input) {
		stateReply, err := reporter.ReportSessionState(ctx, stateInput)
		if err != nil {
			return reply, err
		}
		if stateReply.Accepted {
			reply.AcceptedStatePatchCount++
		}
		reply.RequestBodyBytes += stateReply.RequestBodyBytes
	}
	messageInputs, err := SessionMessageInputsFromActivity(input)
	if err != nil {
		return reply, err
	}
	for _, messagesInput := range messageInputs {
		messagesReply, err := reporter.ReportSessionMessages(ctx, messagesInput)
		if err != nil {
			return reply, err
		}
		reply.AcceptedMessageUpdateCount += messagesReply.AcceptedCount
		reply.RequestBodyBytes += messagesReply.RequestBodyBytes
	}
	return reply, nil
}

func SessionStateInputsFromActivity(input ReportActivityInput) []ReportSessionStateInput {
	if len(input.StatePatches) == 0 {
		return nil
	}
	source := input.Source
	source.SessionOrigin = canonicalSessionOriginValue(source.SessionOrigin)
	out := make([]ReportSessionStateInput, 0, len(input.StatePatches))
	for _, patch := range input.StatePatches {
		agentSessionID := strings.TrimSpace(firstNonEmptyString(
			patch.AgentSessionID,
			source.AgentID,
			source.ProviderSessionID,
		))
		if agentSessionID == "" {
			continue
		}
		out = append(out, ReportSessionStateInput{
			WorkspaceID:    input.WorkspaceID,
			AgentSessionID: agentSessionID,
			SessionOrigin:  source.SessionOrigin,
			Connector:      cloneConnector(input.Connector),
			Source:         source,
			State:          sessionStateUpdateFromPatch(patch),
		})
	}
	return out
}

func SessionMessageInputsFromActivity(input ReportActivityInput) ([]ReportSessionMessagesInput, error) {
	updates := mergeActivityMessageUpdates(nil, input.MessageUpdates)
	if len(updates) == 0 {
		return nil, nil
	}
	source := input.Source
	source.SessionOrigin = canonicalSessionOriginValue(source.SessionOrigin)
	indexBySession := make(map[string]int)
	out := make([]ReportSessionMessagesInput, 0)
	for _, update := range updates {
		agentSessionID := strings.TrimSpace(firstNonEmptyString(
			update.AgentSessionID,
			source.AgentID,
			source.ProviderSessionID,
		))
		if agentSessionID == "" {
			continue
		}
		converted := SessionMessageUpdateFromActivityUpdate(update)
		if strings.TrimSpace(converted.MessageID) == "" {
			continue
		}
		if strings.TrimSpace(converted.TurnID) == "" {
			return nil, fmt.Errorf("agent activity message_update %q is missing turnId", converted.MessageID)
		}
		index, ok := indexBySession[agentSessionID]
		if !ok {
			index = len(out)
			indexBySession[agentSessionID] = index
			out = append(out, ReportSessionMessagesInput{
				WorkspaceID:    input.WorkspaceID,
				AgentSessionID: agentSessionID,
				SessionOrigin:  source.SessionOrigin,
				Connector:      cloneConnector(input.Connector),
				Source:         source,
			})
		}
		out[index].Updates = append(out[index].Updates, converted)
	}
	return out, nil
}

func mergeActivityMessageUpdates(derived []WorkspaceAgentMessageUpdate, explicit []WorkspaceAgentMessageUpdate) []WorkspaceAgentMessageUpdate {
	if len(derived) == 0 {
		return append([]WorkspaceAgentMessageUpdate(nil), explicit...)
	}
	if len(explicit) == 0 {
		return derived
	}
	explicitIDs := make(map[string]struct{}, len(explicit))
	for _, update := range explicit {
		agentSessionID := strings.TrimSpace(update.AgentSessionID)
		messageID := strings.TrimSpace(update.MessageID)
		if agentSessionID == "" || messageID == "" {
			continue
		}
		explicitIDs[agentSessionID+"\x00"+messageID] = struct{}{}
	}
	out := make([]WorkspaceAgentMessageUpdate, 0, len(derived)+len(explicit))
	for _, update := range derived {
		key := strings.TrimSpace(update.AgentSessionID) + "\x00" + strings.TrimSpace(update.MessageID)
		if _, ok := explicitIDs[key]; ok {
			continue
		}
		out = append(out, update)
	}
	out = append(out, explicit...)
	return out
}

func SessionMessageUpdateFromActivityUpdate(update WorkspaceAgentMessageUpdate) WorkspaceAgentSessionMessageUpdate {
	payload := clonePayloadMap(update.Payload)
	if payload == nil {
		payload = map[string]any{}
	}
	if update.Seq > 0 {
		payload["seq"] = update.Seq
	}
	if callID := strings.TrimSpace(update.CallID); callID != "" {
		payload["callId"] = callID
	}
	if parentCallID := strings.TrimSpace(update.ParentCallID); parentCallID != "" {
		payload["parentCallId"] = parentCallID
	}
	if rootCallID := strings.TrimSpace(update.RootCallID); rootCallID != "" {
		payload["rootCallId"] = rootCallID
	}
	if title := strings.TrimSpace(update.Title); title != "" {
		payload["title"] = title
	}
	if len(payload) == 0 {
		payload = nil
	}
	return WorkspaceAgentSessionMessageUpdate{
		MessageID:         strings.TrimSpace(update.MessageID),
		TurnID:            strings.TrimSpace(update.TurnID),
		Role:              strings.TrimSpace(update.Role),
		Kind:              strings.TrimSpace(update.Kind),
		Status:            strings.TrimSpace(update.Status),
		Semantics:         cloneMessageSemantics(update.Semantics),
		Payload:           payload,
		OccurredAtUnixMS:  firstNonZeroInt64(update.OccurredAtUnixMS, update.StartedAtUnixMS, update.CompletedAtUnixMS),
		StartedAtUnixMS:   update.StartedAtUnixMS,
		CompletedAtUnixMS: update.CompletedAtUnixMS,
	}
}

func sessionStateUpdateFromPatch(patch WorkspaceAgentStatePatch) WorkspaceAgentSessionStateUpdate {
	currentPhase := strings.TrimSpace(patch.CurrentPhase)
	if currentPhase == "" {
		currentPhase = deriveCurrentPhaseFromEntityPatches(patch.Entities)
	}
	out := WorkspaceAgentSessionStateUpdate{
		AgentTargetID:      strings.TrimSpace(patch.AgentTargetID),
		Provider:           strings.TrimSpace(patch.Provider),
		ProviderSessionID:  strings.TrimSpace(patch.ProviderSessionID),
		Model:              strings.TrimSpace(patch.Model),
		Settings:           clonePayloadMap(patch.Settings),
		RuntimeContext:     clonePayloadMap(patch.RuntimeContext),
		TurnLifecycle:      cloneTurnLifecycle(patch.TurnLifecycle),
		SubmitAvailability: cloneSubmitAvailability(patch.SubmitAvailability),
		PendingInteractive: cloneInteractivePrompt(patch.PendingInteractive),
		CWD:                strings.TrimSpace(patch.CWD),
		Title:              strings.TrimSpace(patch.Title),
		LifecycleStatus:    strings.TrimSpace(patch.LifecycleStatus),
		CurrentPhase:       currentPhase,
		OccurredAtUnixMS:   patch.OccurredAtUnixMS,
	}
	if patch.Turn != nil {
		out.Turn = &WorkspaceAgentTurnStateUpdate{
			TurnID:             strings.TrimSpace(patch.Turn.TurnID),
			ActiveTurnID:       cloneStringPointer(patch.Turn.ActiveTurnID),
			Phase:              strings.TrimSpace(patch.Turn.Phase),
			Outcome:            strings.TrimSpace(patch.Turn.Outcome),
			Settling:           patch.Turn.Settling,
			CompletedCommand:   cloneCompletedCommand(patch.Turn.CompletedCommand),
			SubmitAvailability: cloneSubmitAvailability(patch.Turn.SubmitAvailability),
			FileChanges:        clonePayloadMap(patch.Turn.FileChanges),
			StartedAtUnixMS:    patch.Turn.StartedAtUnixMS,
			CompletedAtUnixMS:  patch.Turn.CompletedAtUnixMS,
		}
	}
	return out
}

func cloneMessageSemantics(value *WorkspaceAgentMessageSemantics) *WorkspaceAgentMessageSemantics {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func cloneStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	cloned := strings.TrimSpace(*value)
	return &cloned
}

func cloneCompletedCommand(value *WorkspaceAgentCompletedCommand) *WorkspaceAgentCompletedCommand {
	if value == nil {
		return nil
	}
	return &WorkspaceAgentCompletedCommand{
		Kind:   strings.TrimSpace(value.Kind),
		Status: strings.TrimSpace(value.Status),
	}
}

func cloneSubmitAvailability(value *WorkspaceAgentSubmitAvailability) *WorkspaceAgentSubmitAvailability {
	if value == nil {
		return nil
	}
	return &WorkspaceAgentSubmitAvailability{
		State:  strings.TrimSpace(value.State),
		Reason: strings.TrimSpace(value.Reason),
	}
}

func cloneTurnLifecycle(value *WorkspaceAgentTurnLifecycle) *WorkspaceAgentTurnLifecycle {
	if value == nil {
		return nil
	}
	return &WorkspaceAgentTurnLifecycle{
		ActiveTurnID:     cloneStringPointer(value.ActiveTurnID),
		Phase:            strings.TrimSpace(value.Phase),
		Settling:         value.Settling,
		Outcome:          cloneStringPointer(value.Outcome),
		CompletedCommand: cloneCompletedCommand(value.CompletedCommand),
	}
}

func cloneInteractivePrompt(value *WorkspaceAgentInteractivePrompt) *WorkspaceAgentInteractivePrompt {
	if value == nil {
		return nil
	}
	return &WorkspaceAgentInteractivePrompt{
		Kind:      strings.TrimSpace(value.Kind),
		RequestID: strings.TrimSpace(value.RequestID),
		ToolName:  strings.TrimSpace(value.ToolName),
		Status:    strings.TrimSpace(value.Status),
		Input:     clonePayloadMap(value.Input),
		Output:    clonePayloadMap(value.Output),
		Error:     clonePayloadMap(value.Error),
		Metadata:  clonePayloadMap(value.Metadata),
	}
}

func deriveCurrentPhaseFromEntityPatches(entities []WorkspaceAgentEntityPatch) string {
	for _, entity := range entities {
		switch strings.ToLower(strings.TrimSpace(entity.Status)) {
		case "waiting", "waiting_input", "waiting_approval", "awaiting_approval":
			return "waiting_input"
		case "running", "streaming", "in_progress":
			return "working"
		}
	}
	return ""
}

func stringValueFromPayloadMap(payload map[string]any, key string) string {
	if len(payload) == 0 {
		return ""
	}
	value, ok := payload[key]
	if !ok {
		return ""
	}
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return text
}

func cloneConnector(connector *ConnectorInfo) *ConnectorInfo {
	if connector == nil {
		return nil
	}
	cloned := *connector
	return &cloned
}
