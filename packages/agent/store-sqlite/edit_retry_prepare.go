package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
)

// PrepareEditRetry makes the V2 protocol identity durable before Host performs
// any provider read. The companion fence is installed in the same transaction.
func (s *Store) PrepareEditRetry(ctx context.Context, input RuntimeOperationPrepare) (RuntimeOperation, bool, error) {
	if input.Kind != RuntimeOperationKindEditRetry {
		return RuntimeOperation{}, false, ErrRuntimeOperationSubjectState
	}
	payload, err := DecodeEditRetryOperationPayload(input.Payload)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	payload.SagaVersion = EditRetrySagaVersionCurrent
	input.Payload, err = EncodeEditRetryOperationPayload(payload)
	if err != nil {
		return RuntimeOperation{}, false, err
	}
	return s.prepareRuntimeOperation(ctx, input)
}

func prepareEditRetryFenceTx(ctx context.Context, tx *sql.Tx, input RuntimeOperationPrepare, now int64) error {
	if input.Kind != RuntimeOperationKindEditRetry {
		return nil
	}
	payload, err := DecodeEditRetryOperationPayload(input.Payload)
	if err != nil {
		return err
	}
	if payload.Checkpoint != EditRetryCheckpointPrepared {
		return ErrRuntimeOperationSubjectState
	}
	fence, err := tx.ExecContext(ctx, `UPDATE workspace_agent_session_history SET recovery_state='rollback_pending', operation_id=?, updated_at_unix_ms=? WHERE workspace_id=? AND agent_session_id=? AND recovery_state='ready' AND history_revision=?`, input.OperationID, now, input.WorkspaceID, input.AgentSessionID, payload.ExpectedRevision)
	if err != nil {
		return fmt.Errorf("prepare edit retry session fence: %w", err)
	}
	if changed, err := rowsWereAffected(fence, "prepare edit retry session fence"); err != nil || !changed {
		return ErrRuntimeOperationSubjectState
	}
	return nil
}

func prepareRuntimeOperationMutations(input RuntimeOperationPrepare, operation RuntimeOperation, now int64) []TransactionMutation {
	mutations := []TransactionMutation{transactionMutation(input.WorkspaceID, input.AgentSessionID, MutationEntityRuntimeOperation, input.OperationID, "prepare", operation.Version)}
	if input.Kind == RuntimeOperationKindEditRetry {
		mutations = append(mutations, transactionMutation(input.WorkspaceID, input.AgentSessionID, MutationEntitySession, input.AgentSessionID, "history_edit_retry_prepared", now))
	}
	return mutations
}
