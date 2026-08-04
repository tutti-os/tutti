package storesqlite

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// CaptureEditRetryPreEffectSnapshot records provider history only after the
// operation and its session fence are durable. It does not authorize a
// provider mutation and deliberately leaves the checkpoint prepared.
func (s *Store) CaptureEditRetryPreEffectSnapshot(ctx context.Context, input CaptureEditRetryPreEffectSnapshotInput) (RuntimeOperation, bool, error) {
	if s == nil || s.db == nil {
		return RuntimeOperation{}, false, errors.New("workspace database is not initialized")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.OperationID = strings.TrimSpace(input.OperationID)
	input.LeaseOwner = strings.TrimSpace(input.LeaseOwner)
	input.ProviderSessionID = strings.TrimSpace(input.ProviderSessionID)
	if input.WorkspaceID == "" || input.OperationID == "" || input.LeaseOwner == "" || input.ProviderSessionID == "" || input.NowUnixMS <= 0 || validateEditRetryProviderIDs(input.ProviderTurnIDs) != nil {
		return RuntimeOperation{}, false, errors.New("valid edit retry pre-effect snapshot input is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("begin edit retry pre-effect snapshot: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	op, found, err := getRuntimeOperationTx(ctx, tx, input.WorkspaceID, input.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	if !validEditRetryLease(op, found, input.LeaseOwner, input.NowUnixMS) {
		return op, false, ErrRuntimeOperationLeaseLost
	}
	payload, err := DecodeEditRetryOperationPayload(op.Payload)
	if err != nil || payload.Checkpoint != EditRetryCheckpointPrepared {
		if err != nil {
			return op, false, err
		}
		return op, false, ErrRuntimeOperationSubjectState
	}
	if len(payload.BeforeProviderIDs) != 0 {
		if payload.ProviderSessionID != input.ProviderSessionID || !equalStringValues(payload.BeforeProviderIDs, input.ProviderTurnIDs) {
			return op, false, ErrRuntimeOperationSubjectState
		}
		if _, err := s.commitTransaction(ctx, tx, op.WorkspaceID, nil); err != nil {
			return RuntimeOperation{}, false, fmt.Errorf("commit duplicate edit retry pre-effect snapshot: %w", err)
		}
		committed = true
		return op, false, nil
	}
	payload.ProviderSessionID = input.ProviderSessionID
	payload.BeforeProviderIDs = append([]string(nil), input.ProviderTurnIDs...)
	payloadMap, err := EncodeEditRetryOperationPayload(payload)
	if err != nil {
		return op, false, err
	}
	payloadJSON, err := marshalJSONMap(payloadMap)
	if err != nil {
		return op, false, err
	}
	updated, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET payload_json=?, version=version+1, updated_at_unix_ms=?
WHERE workspace_id=? AND operation_id=? AND status='leased' AND lease_owner=?
`, payloadJSON, input.NowUnixMS, op.WorkspaceID, op.OperationID, input.LeaseOwner)
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("capture edit retry pre-effect snapshot: %w", err)
	}
	if changed, err := rowsWereAffected(updated, "capture edit retry pre-effect snapshot"); err != nil || !changed {
		return op, false, ErrRuntimeOperationLeaseLost
	}
	op, _, err = getRuntimeOperationTx(ctx, tx, op.WorkspaceID, op.OperationID)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	delta, err := s.commitTransaction(ctx, tx, op.WorkspaceID, []TransactionMutation{
		transactionMutation(op.WorkspaceID, op.AgentSessionID, MutationEntityRuntimeOperation, op.OperationID, "pre_effect_snapshot", op.Version),
	})
	if err != nil {
		return RuntimeOperation{}, false, fmt.Errorf("commit edit retry pre-effect snapshot: %w", err)
	}
	committed = true
	op.CommitTransactionID, op.CommitDelta = delta.TransactionID, delta
	return op, true, nil
}
