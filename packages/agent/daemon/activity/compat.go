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
	if len(input.GoalReconcileRequests) > 0 {
		goalReporter, ok := reporter.(GoalReconcileRequestReporter)
		if !ok {
			return reply, fmt.Errorf("agent activity reporter does not support goal reconcile requests")
		}
		for _, request := range input.GoalReconcileRequests {
			requestReply, err := goalReporter.ReportGoalReconcileRequired(ctx, ReportGoalReconcileRequiredInput{
				WorkspaceID: input.WorkspaceID,
				Request:     request,
			})
			if err != nil {
				return reply, err
			}
			if requestReply.Accepted {
				reply.AcceptedGoalReconcileRequestCount++
			}
		}
	}
	auditInputs := SessionAuditInputsFromActivity(input)
	messageInputs, err := SessionMessageInputsFromActivity(input)
	if err != nil {
		return reply, err
	}
	reportState := func(stateInput ReportSessionStateInput) error {
		stateReply, err := reporter.ReportSessionState(ctx, stateInput)
		if err != nil {
			return err
		}
		if stateReply.Accepted {
			reply.AcceptedStatePatchCount++
		}
		reply.RequestBodyBytes += stateReply.RequestBodyBytes
		return nil
	}
	reportMessages := func(messagesInput ReportSessionMessagesInput, audit bool) error {
		messagesReply, err := reporter.ReportSessionMessages(ctx, messagesInput)
		if err != nil {
			return err
		}
		if audit {
			reply.AcceptedSessionAuditCount += messagesReply.AcceptedCount
		} else {
			reply.AcceptedMessageUpdateCount += messagesReply.AcceptedCount
		}
		reply.RequestBodyBytes += messagesReply.RequestBodyBytes
		return nil
	}
	flushAuditsForSession := func(agentSessionID string) error {
		agentSessionID = strings.TrimSpace(agentSessionID)
		for index := range auditInputs {
			if strings.TrimSpace(auditInputs[index].AgentSessionID) != agentSessionID || len(auditInputs[index].Updates) == 0 {
				continue
			}
			pending := auditInputs[index]
			auditInputs[index].Updates = nil
			if err := reportMessages(pending, true); err != nil {
				return err
			}
		}
		return nil
	}
	flushMessagesForTurn := func(agentSessionID string, turnID string) ([]ReportSessionMessagesInput, error) {
		agentSessionID = strings.TrimSpace(agentSessionID)
		turnID = strings.TrimSpace(turnID)
		flushed := make([]ReportSessionMessagesInput, 0, 1)
		for index := range messageInputs {
			if strings.TrimSpace(messageInputs[index].AgentSessionID) != agentSessionID || len(messageInputs[index].Updates) == 0 {
				continue
			}
			matching := make([]WorkspaceAgentSessionMessageUpdate, 0, len(messageInputs[index].Updates))
			remaining := make([]WorkspaceAgentSessionMessageUpdate, 0, len(messageInputs[index].Updates))
			for _, update := range messageInputs[index].Updates {
				if strings.TrimSpace(update.TurnID) == turnID {
					matching = append(matching, update)
				} else {
					remaining = append(remaining, update)
				}
			}
			messageInputs[index].Updates = remaining
			if len(matching) == 0 {
				continue
			}
			pending := messageInputs[index]
			pending.Updates = matching
			if err := reportMessages(pending, false); err != nil {
				return nil, err
			}
			flushed = append(flushed, pending)
		}
		return flushed, nil
	}

	// Preserve state-patch causality. A terminal patch locally flushes only its
	// own Turn's messages before settlement; later non-terminal patches remain
	// after that settlement instead of being globally moved ahead of it.
	stateInputs := SessionStateInputsFromActivity(input)
	for index := range stateInputs {
		stateInput := &stateInputs[index]
		if turnID, terminal := settlementBarrierTurnID(*stateInput); terminal {
			if err := flushAuditsForSession(stateInput.AgentSessionID); err != nil {
				return reply, err
			}
			flushed, err := flushMessagesForTurn(stateInput.AgentSessionID, turnID)
			if err != nil {
				return reply, err
			}
			anchorFinalAssistantMessages(stateInputs[index:index+1], flushed)
		}
		if err := reportState(*stateInput); err != nil {
			return reply, err
		}
	}
	for _, auditInput := range auditInputs {
		if len(auditInput.Updates) > 0 {
			if err := reportMessages(auditInput, true); err != nil {
				return reply, err
			}
		}
	}
	for _, messagesInput := range messageInputs {
		if len(messagesInput.Updates) > 0 {
			if err := reportMessages(messagesInput, false); err != nil {
				return reply, err
			}
		}
	}
	return reply, nil
}

func settlementBarrierTurnID(input ReportSessionStateInput) (string, bool) {
	if root := input.State.RootProviderTurn; root != nil &&
		strings.EqualFold(strings.TrimSpace(root.Phase), RootProviderTurnPhaseCompleted) {
		return strings.TrimSpace(root.RootTurnID), strings.TrimSpace(root.RootTurnID) != ""
	}
	turn := input.State.Turn
	if turn == nil {
		return "", false
	}
	phase := strings.ToLower(strings.TrimSpace(turn.Phase))
	terminal := turn.Settling || phase == "settling" || phase == "settled"
	return strings.TrimSpace(turn.TurnID), terminal && strings.TrimSpace(turn.TurnID) != ""
}

func anchorFinalAssistantMessages(states []ReportSessionStateInput, messages []ReportSessionMessagesInput) {
	anchors := make(map[string]string)
	for _, input := range messages {
		for _, update := range input.Updates {
			if !strings.EqualFold(strings.TrimSpace(update.Role), "assistant") ||
				!strings.EqualFold(strings.TrimSpace(update.Kind), "text") {
				continue
			}
			turnID := strings.TrimSpace(update.TurnID)
			messageID := strings.TrimSpace(update.MessageID)
			if turnID != "" && messageID != "" {
				anchors[strings.TrimSpace(input.AgentSessionID)+"\x00"+turnID] = messageID
			}
		}
	}
	for index := range states {
		turn := states[index].State.Turn
		if turn == nil || !strings.EqualFold(strings.TrimSpace(turn.Phase), "settled") {
			continue
		}
		turn.FinalAssistantMessageID = anchors[strings.TrimSpace(states[index].AgentSessionID)+"\x00"+strings.TrimSpace(turn.TurnID)]
	}
}

func SessionAuditInputsFromActivity(input ReportActivityInput) []ReportSessionMessagesInput {
	if len(input.SessionAudits) == 0 {
		return nil
	}
	source := input.Source
	source.SessionOrigin = canonicalSessionOriginValue(source.SessionOrigin)
	indexBySession := make(map[string]int)
	out := make([]ReportSessionMessagesInput, 0)
	for _, audit := range input.SessionAudits {
		agentSessionID := strings.TrimSpace(firstNonEmptyString(source.AgentID, source.ProviderSessionID))
		auditID := strings.TrimSpace(audit.AuditID)
		if agentSessionID == "" || auditID == "" {
			continue
		}
		index, ok := indexBySession[agentSessionID]
		if !ok {
			index = len(out)
			indexBySession[agentSessionID] = index
			out = append(out, ReportSessionMessagesInput{
				WorkspaceID: input.WorkspaceID, AgentSessionID: agentSessionID,
				SessionOrigin: source.SessionOrigin, Connector: cloneConnector(input.Connector), Source: source,
			})
		}
		payload := clonePayloadMap(audit.Payload)
		if payload == nil {
			payload = map[string]any{}
		}
		if strings.TrimSpace(audit.Content) != "" {
			payload["content"] = audit.Content
			payload["text"] = audit.Content
		}
		out[index].Updates = append(out[index].Updates, WorkspaceAgentSessionMessageUpdate{
			MessageID: auditID, Role: strings.TrimSpace(audit.Role), Kind: "session_audit",
			Status: "completed", Payload: payload, OccurredAtUnixMS: audit.OccurredAtUnixMS,
		})
	}
	return out
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
		turnID := strings.TrimSpace(converted.TurnID)
		kind := strings.TrimSpace(converted.Kind)
		if kind == "session_audit" {
			return nil, fmt.Errorf("agent activity session_audit %q must use SessionAudits", converted.MessageID)
		}
		if turnID == "" && kind != "session_audit" {
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
		Kind:                  strings.TrimSpace(patch.Kind),
		RootAgentSessionID:    strings.TrimSpace(patch.RootAgentSessionID),
		RootTurnID:            strings.TrimSpace(patch.RootTurnID),
		ParentAgentSessionID:  strings.TrimSpace(patch.ParentAgentSessionID),
		ParentTurnID:          strings.TrimSpace(patch.ParentTurnID),
		ParentToolCallID:      strings.TrimSpace(patch.ParentToolCallID),
		AgentTargetID:         strings.TrimSpace(patch.AgentTargetID),
		DeviceID:              strings.TrimSpace(patch.DeviceID),
		Provider:              strings.TrimSpace(patch.Provider),
		ProviderSessionID:     strings.TrimSpace(patch.ProviderSessionID),
		Model:                 strings.TrimSpace(patch.Model),
		Settings:              clonePayloadMap(patch.Settings),
		RuntimeContext:        clonePayloadMap(patch.RuntimeContext),
		TurnLifecycle:         cloneTurnLifecycle(patch.TurnLifecycle),
		SubmitAvailability:    cloneSubmitAvailability(patch.SubmitAvailability),
		InteractionTransition: cloneInteractionTransition(patch.InteractionTransition),
		CWD:                   strings.TrimSpace(patch.CWD),
		Title:                 strings.TrimSpace(patch.Title),
		LifecycleStatus:       strings.TrimSpace(patch.LifecycleStatus),
		CurrentPhase:          currentPhase,
		LastError:             strings.TrimSpace(patch.LastError),
		OccurredAtUnixMS:      patch.OccurredAtUnixMS,
		RootProviderTurn:      cloneRootProviderTurnTransition(patch.RootProviderTurn),
	}
	if patch.Turn != nil {
		out.Turn = &WorkspaceAgentTurnStateUpdate{
			TurnID:                  strings.TrimSpace(patch.Turn.TurnID),
			Origin:                  strings.TrimSpace(patch.Turn.Origin),
			SourceGoalOperationID:   strings.TrimSpace(patch.Turn.SourceGoalOperationID),
			SourceGoalRevision:      patch.Turn.SourceGoalRevision,
			SourceGoalRepairEpoch:   patch.Turn.SourceGoalRepairEpoch,
			ActiveTurnID:            cloneStringPointer(patch.Turn.ActiveTurnID),
			Phase:                   strings.TrimSpace(patch.Turn.Phase),
			Outcome:                 strings.TrimSpace(patch.Turn.Outcome),
			Settling:                patch.Turn.Settling,
			CompletedCommand:        cloneCompletedCommand(patch.Turn.CompletedCommand),
			SubmitAvailability:      cloneSubmitAvailability(patch.Turn.SubmitAvailability),
			FileChanges:             clonePayloadMap(patch.Turn.FileChanges),
			StartedAtUnixMS:         patch.Turn.StartedAtUnixMS,
			CompletedAtUnixMS:       patch.Turn.CompletedAtUnixMS,
			FinalAssistantMessageID: strings.TrimSpace(patch.Turn.FinalAssistantMessageID),
		}
	}
	return out
}

func cloneRootProviderTurnTransition(value *WorkspaceAgentRootProviderTurnTransition) *WorkspaceAgentRootProviderTurnTransition {
	if value == nil {
		return nil
	}
	cloned := *value
	cloned.CompletedCommand = cloneCompletedCommand(value.CompletedCommand)
	return &cloned
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

func cloneInteractionTransition(value *WorkspaceAgentInteractionTransition) *WorkspaceAgentInteractionTransition {
	if value == nil {
		return nil
	}
	return &WorkspaceAgentInteractionTransition{
		RequestID: strings.TrimSpace(value.RequestID),
		TurnID:    strings.TrimSpace(value.TurnID),
		Kind:      strings.TrimSpace(value.Kind),
		Status:    strings.TrimSpace(value.Status),
		ToolName:  strings.TrimSpace(value.ToolName),
		Input:     clonePayloadMap(value.Input),
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

func int64ValueFromPayloadMap(payload map[string]any, key string) int64 {
	if len(payload) == 0 {
		return 0
	}
	switch value := payload[key].(type) {
	case int:
		return int64(value)
	case int64:
		return value
	case float64:
		return int64(value)
	default:
		return 0
	}
}

func cloneConnector(connector *ConnectorInfo) *ConnectorInfo {
	if connector == nil {
		return nil
	}
	cloned := *connector
	return &cloned
}
