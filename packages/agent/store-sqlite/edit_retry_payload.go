package storesqlite

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

type EditRetryCheckpoint string

const (
	EditRetryCheckpointPrepared              EditRetryCheckpoint = "prepared"
	EditRetryCheckpointRollbackDispatched    EditRetryCheckpoint = "rollback_dispatched"
	EditRetryCheckpointRollbackConfirmed     EditRetryCheckpoint = "rollback_confirmed"
	EditRetryCheckpointReplacementDispatched EditRetryCheckpoint = "replacement_dispatched"
	EditRetryCheckpointRollbackAborted       EditRetryCheckpoint = "rollback_aborted"
)

type EditRetryReasonCode = canonical.EditRetryReasonCode

const (
	EditRetryReasonProviderUnsupported        = canonical.EditRetryReasonProviderUnsupported
	EditRetryReasonTurnNotFound               = canonical.EditRetryReasonTurnNotFound
	EditRetryReasonTurnNotLatest              = canonical.EditRetryReasonTurnNotLatest
	EditRetryReasonTurnNotSettled             = canonical.EditRetryReasonTurnNotSettled
	EditRetryReasonHistoryRevisionConflict    = canonical.EditRetryReasonHistoryRevisionConflict
	EditRetryReasonOperationConflict          = canonical.EditRetryReasonOperationConflict
	EditRetryReasonRecoveryRequired           = canonical.EditRetryReasonRecoveryRequired
	EditRetryReasonProviderOutcomeUnknown     = canonical.EditRetryReasonProviderOutcomeUnknown
	EditRetryReasonReplacementNotProvenAbsent = canonical.EditRetryReasonReplacementNotProvenAbsent
)

// EditRetryOperationPayload is the typed durable edit-retry checkpoint.
// RuntimeOperation keeps payload_json as its shared storage representation;
// edit-retry transitions must decode through this type before interpreting it.
type EditRetryOperationPayload struct {
	ClientOperationID  string              `json:"clientOperationId"`
	EditedText         string              `json:"editedText"`
	ReplacementTurnID  string              `json:"replacementTurnId"`
	ClientSubmitID     string              `json:"clientSubmitId"`
	ExpectedRevision   int64               `json:"expectedHistoryRevision"`
	Checkpoint         EditRetryCheckpoint `json:"step"`
	BeforeProviderIDs  []string            `json:"beforeProviderTurnIds,omitempty"`
	ProviderSessionID  string              `json:"providerSessionId,omitempty"`
	RedispatchProofIDs []string            `json:"recoveryRedispatchProofProviderTurnIds,omitempty"`
	RedispatchProofSID string              `json:"recoveryRedispatchProofProviderSessionId,omitempty"`
	RedispatchProofAt  int64               `json:"recoveryRedispatchProofAtUnixMs,omitempty"`
	DispatchAttempt    int64               `json:"replacementDispatchAttempt,omitempty"`
	DiscardedMessages  int64               `json:"lastDiscardedLocalMessageCount,omitempty"`
	DiscardedOutcome   string              `json:"lastDiscardedLocalOutcome,omitempty"`
	DiscardedError     string              `json:"lastDiscardedLocalError,omitempty"`
}

func (payload EditRetryOperationPayload) Validate(operationID string) error {
	if strings.TrimSpace(payload.ClientOperationID) == "" ||
		strings.TrimSpace(payload.EditedText) == "" ||
		strings.TrimSpace(payload.ReplacementTurnID) == "" ||
		strings.TrimSpace(payload.ClientSubmitID) != "edit-retry:"+strings.TrimSpace(operationID) ||
		payload.ExpectedRevision < 0 {
		return errors.New("edit retry identity payload is invalid")
	}
	switch payload.Checkpoint {
	case EditRetryCheckpointPrepared:
		if payload.BeforeProviderIDs != nil {
			return errors.New("prepared edit retry must not carry provider history")
		}
	case EditRetryCheckpointRollbackDispatched,
		EditRetryCheckpointRollbackConfirmed,
		EditRetryCheckpointReplacementDispatched:
		if err := validateEditRetryProviderIDs(payload.BeforeProviderIDs); err != nil {
			return err
		}
	case EditRetryCheckpointRollbackAborted:
		return nil
	default:
		return errors.New("edit retry checkpoint is invalid")
	}
	return nil
}

func EncodeEditRetryOperationPayload(payload EditRetryOperationPayload) (map[string]any, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode edit retry operation payload: %w", err)
	}
	var result map[string]any
	if err := json.Unmarshal(encoded, &result); err != nil {
		return nil, fmt.Errorf("decode encoded edit retry operation payload: %w", err)
	}
	return result, nil
}

func DecodeEditRetryOperationPayload(payload map[string]any) (EditRetryOperationPayload, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return EditRetryOperationPayload{}, fmt.Errorf("encode stored edit retry operation payload: %w", err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(encoded)))
	decoder.DisallowUnknownFields()
	var result EditRetryOperationPayload
	if err := decoder.Decode(&result); err != nil {
		return EditRetryOperationPayload{}, fmt.Errorf("decode edit retry operation payload: %w", err)
	}
	return result, nil
}

func validateEditRetryOperationPayload(operationID string, payload map[string]any) error {
	decoded, err := DecodeEditRetryOperationPayload(payload)
	if err != nil {
		return err
	}
	return decoded.Validate(operationID)
}

func editRetryPayloadMap(operationID string, payload EditRetryOperationPayload) (map[string]any, error) {
	if err := payload.Validate(operationID); err != nil {
		return nil, err
	}
	return EncodeEditRetryOperationPayload(payload)
}

func validateEditRetryProviderIDs(values []string) error {
	if values == nil {
		return errors.New("edit retry provider history is invalid")
	}
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			return errors.New("edit retry provider history is invalid")
		}
	}
	return nil
}

func editRetryReason(code EditRetryReasonCode, legacy string) (EditRetryReasonCode, error) {
	if code == "" {
		code = EditRetryReasonCode(strings.TrimSpace(legacy))
	}
	if err := code.Validate(); err != nil {
		return "", err
	}
	return code, nil
}

func payloadInt64(payload map[string]any, key string) int64 {
	switch value := payload[key].(type) {
	case int:
		return int64(value)
	case int64:
		return value
	case uint64:
		if value <= uint64(^uint64(0)>>1) {
			return int64(value)
		}
	case float64:
		return int64(value)
	case json.Number:
		result, _ := value.Int64()
		return result
	}
	return -1
}
