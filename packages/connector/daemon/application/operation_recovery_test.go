package daemon

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	marketdata "github.com/tutti-os/tutti/packages/connector/daemon/adapters/sqlite"
	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

func TestOperationRecoveryReschedulesDurableRunningWorkAfterWakeLoss(t *testing.T) {
	ctx := context.Background()
	store, err := marketdata.Open(ctx, filepath.Join(t.TempDir(), "tuttid.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	operation := market.Operation{
		OperationID: "install-1", ClientRequestID: "request-1", ConnectorKey: "github",
		Kind: market.OperationKindInstall, State: market.OperationStateRunning, Stage: market.OperationStageInstalling,
		CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(2, 0).UTC(),
	}
	if err := store.Transaction(ctx, func(tx market.Transaction) error {
		return tx.SaveOperation(operation)
	}); err != nil {
		t.Fatal(err)
	}
	executor := &recordingOperationExecutor{}
	scheduler := NewOperationScheduler(ctx)
	if err := scheduler.Bind(executor); err != nil {
		t.Fatal(err)
	}
	host := &Host{repository: store, scheduler: scheduler}
	if err := host.scheduleRecoverableOperations(ctx); err != nil {
		t.Fatal(err)
	}
	scheduler.Wait()
	if calls := executor.operationIDs(); len(calls) != 1 || calls[0] != operation.OperationID {
		t.Fatalf("recovered operations = %#v", calls)
	}
}

type recordingOperationExecutor struct {
	mu    sync.Mutex
	calls []string
}

func (executor *recordingOperationExecutor) ExecuteOperation(_ context.Context, operationID string) error {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	executor.calls = append(executor.calls, operationID)
	return nil
}

func (executor *recordingOperationExecutor) operationIDs() []string {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	return append([]string(nil), executor.calls...)
}
