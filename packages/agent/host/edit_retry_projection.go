package agenthost

import (
	"encoding/json"
	"errors"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func editRetryProviderTurnIDs(turns []storesqlite.Turn, targetTurnID string) ([]string, error) {
	if len(turns) == 0 || turns[len(turns)-1].TurnID != strings.TrimSpace(targetTurnID) {
		return nil, ErrEditRetryNotEligible
	}
	result := make([]string, 0, len(turns))
	for _, turn := range turns {
		providerTurnID := strings.TrimSpace(turn.RootProviderTurnID)
		if providerTurnID == "" {
			return nil, errors.New("effective history contains a turn without provider provenance")
		}
		result = append(result, providerTurnID)
	}
	return result, nil
}

func runtimeHistoryTurnIDs(snapshot RuntimeHistorySnapshot) []string {
	result := make([]string, 0, len(snapshot.Turns))
	for _, turn := range snapshot.Turns {
		result = append(result, strings.TrimSpace(turn.ID))
	}
	return result
}

func equalEditRetryIDs(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if strings.TrimSpace(left[index]) != strings.TrimSpace(right[index]) {
			return false
		}
	}
	return true
}

func editRetryRequestMatches(operation storesqlite.RuntimeOperation, turnID string, input EditRetryInput) bool {
	payload, err := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	return err == nil &&
		operation.Kind == storesqlite.RuntimeOperationKindEditRetry &&
		operation.TurnID == strings.TrimSpace(turnID) &&
		operation.RequestID == strings.TrimSpace(input.ClientOperationID) &&
		payload.ClientOperationID == strings.TrimSpace(input.ClientOperationID) &&
		payload.EditedText == input.EditedText &&
		payload.ExpectedRevision == int64(input.ExpectedHistoryRevision)
}

func editRetryResult(operation storesqlite.RuntimeOperation, history storesqlite.SessionHistory) EditRetryResult {
	state := EditRetryStatePrepared
	switch {
	case operation.Status == storesqlite.RuntimeOperationStatusCompleted:
		state = EditRetryStateCompleted
	case history.RecoveryState == storesqlite.SessionHistoryRecoveryRequired:
		state = EditRetryStateRecoveryRequired
	case history.RecoveryState == storesqlite.SessionHistoryRecoveryResendPending:
		state = EditRetryStateResendPending
	case history.RecoveryState == storesqlite.SessionHistoryRecoveryRollbackPending:
		state = EditRetryStateRollingBack
	}
	payload, _ := storesqlite.DecodeEditRetryOperationPayload(operation.Payload)
	replacementTurnID := ""
	if state == EditRetryStateCompleted {
		replacementTurnID = payload.ReplacementTurnID
	}
	return EditRetryResult{
		OperationID: strings.TrimSpace(operation.OperationID),
		State:       state, RetractedTurnID: operation.TurnID,
		ReplacementTurnID: replacementTurnID, HistoryRevision: history.Revision,
		ReasonCode: editRetryReasonFromOperation(operation),
	}
}

func editRetryReplacementInput(
	envelope storesqlite.TurnSubmission,
	editedText string,
) (SendInput, error) {
	var content []PromptContentBlock
	if err := json.Unmarshal([]byte(envelope.ContentJSON), &content); err != nil {
		return SendInput{}, err
	}
	replaced := false
	for index := range content {
		if strings.TrimSpace(content[index].Type) == "text" {
			content[index].Text = editedText
			replaced = true
			break
		}
	}
	if !replaced {
		return SendInput{}, ErrEditRetryNotEligible
	}
	normalized, _, err := normalizePromptContent(content)
	if err != nil {
		return SendInput{}, err
	}
	var capabilityRefs []CapabilityReference
	if err := json.Unmarshal([]byte(envelope.CapabilityRefsJSON), &capabilityRefs); err != nil {
		return SendInput{}, err
	}
	var tuttiModeSnapshot *TuttiModeTurnSnapshot
	if err := json.Unmarshal([]byte(envelope.TuttiModeSnapshotJSON), &tuttiModeSnapshot); err != nil {
		return SendInput{}, err
	}
	var metadata map[string]any
	if strings.TrimSpace(envelope.MetadataJSON) != "" {
		if err := json.Unmarshal([]byte(envelope.MetadataJSON), &metadata); err != nil {
			return SendInput{}, err
		}
	}
	return SendInput{
		Content: normalized, DisplayPrompt: editedText,
		CapabilityRefs: capabilityRefs, Metadata: metadata, TuttiModeSnapshot: tuttiModeSnapshot,
	}, nil
}

func editRetryReasonFromOperation(operation storesqlite.RuntimeOperation) EditRetryReasonCode {
	reason := EditRetryReasonCode(strings.TrimSpace(operation.LastError))
	if reason.Validate() == nil {
		return reason
	}
	if operation.Status == storesqlite.RuntimeOperationStatusFailed {
		return EditRetryReasonCodeRecoveryRequired
	}
	return ""
}
