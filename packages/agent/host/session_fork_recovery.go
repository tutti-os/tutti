package agenthost

import (
	"context"
	"errors"
	"fmt"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

const sessionForkRecoveryPageSize = 100

func (h *Host) RecoverSessionForks(ctx context.Context) error {
	if h == nil || h.sessionForks == nil || h.sessionForkRecovery == nil {
		return nil
	}
	var recoveryErrors []error
	handleOperation := func(operation storesqlite.SessionForkOperation) {
		if operation.Status == storesqlite.SessionForkStatusPrepared {
			// No dispatch marker proves the provider call never started. Mark
			// the abandoned request failed so its durable source fence cannot
			// freeze the session after the caller/UI process has restarted.
			_, _, err := h.sessionForks.FailPreparedSessionFork(
				ctx,
				operation.WorkspaceID,
				operation.OperationID,
				"prepared session fork was abandoned during restart",
				h.now().UnixMilli(),
			)
			if err != nil {
				recoveryErrors = append(recoveryErrors, err)
			}
			return
		}
		if _, err := h.processSessionForkOperation(ctx, operation); err != nil &&
			!errors.Is(err, ErrSessionForkDeliveryUnknown) &&
			!errors.Is(err, ErrSessionForkFailed) {
			recoveryErrors = append(recoveryErrors,
				fmt.Errorf("recover session fork %s: %w", operation.OperationID, err))
		}
	}
	cursor := storesqlite.SessionForkRecoveryCursor{}
	for {
		operations, err := h.sessionForkRecovery.ListRecoverableSessionForkOperationsPage(
			ctx, cursor, sessionForkRecoveryPageSize,
		)
		if err != nil {
			return errors.Join(append(recoveryErrors, err)...)
		}
		for _, operation := range operations {
			handleOperation(operation)
		}
		if len(operations) < sessionForkRecoveryPageSize {
			break
		}
		last := operations[len(operations)-1]
		cursor = storesqlite.SessionForkRecoveryCursor{
			CreatedAtUnixMS: last.CreatedAtUnixMS,
			OperationID:     last.OperationID,
		}
	}
	return errors.Join(recoveryErrors...)
}
