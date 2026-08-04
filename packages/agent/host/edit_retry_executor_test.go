package agenthost

import (
	"context"
	"errors"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func TestEditRetryPersistenceRetryRetriesOnlySQLiteContention(t *testing.T) {
	var calls int
	err := withEditRetryPersistenceRetry(context.Background(), func(context.Context) error {
		calls++
		if calls < 3 {
			return errors.New("database is locked")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("persistence transition returned error: %v", err)
	}
	if calls != 3 {
		t.Fatalf("expected two bounded retries and one successful transition, got %d calls", calls)
	}
}

func TestEditRetryPersistenceRetryDoesNotReplaySemanticFailure(t *testing.T) {
	var calls int
	wantErr := errors.New("runtime operation subject state conflict")
	err := withEditRetryPersistenceRetry(context.Background(), func(context.Context) error {
		calls++
		return wantErr
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("expected semantic failure to be returned unchanged, got %v", err)
	}
	if calls != 1 {
		t.Fatalf("semantic failure was retried %d times", calls)
	}
}

func TestEditRetryPersistenceRetryFinishesAfterAttemptCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var transitionCanceled bool
	err := withEditRetryPersistenceRetry(ctx, func(persistCtx context.Context) error {
		transitionCanceled = persistCtx.Err() != nil
		return nil
	})
	if err != nil {
		t.Fatalf("canceled attempt could not converge locally: %v", err)
	}
	if transitionCanceled {
		t.Fatal("local persistence transition inherited provider-attempt cancellation")
	}
}

func TestEditRetryExecutorBoundsProviderWorkspaceAndSessionWithoutConstrainingControl(t *testing.T) {
	executor := newEditRetryExecutor(4)
	retry := func(id, workspaceID, sessionID, providerKey string) storesqlite.RuntimeOperation {
		return storesqlite.RuntimeOperation{OperationID: id, WorkspaceID: workspaceID, AgentSessionID: sessionID, Kind: storesqlite.RuntimeOperationKindEditRetry, ProviderKey: providerKey}
	}
	busy := retry("busy-a", "workspace-a", "session-a", "provider-a")
	if !executor.reserve(busy) {
		t.Fatal("first edit-retry reservation was rejected")
	}
	defer executor.release(busy)
	if executor.reserve(retry("busy-b", "workspace-a", "session-b", "provider-a")) {
		t.Fatal("same provider exceeded the edit-retry cap")
	}
	if executor.reserve(retry("same-session", "workspace-a", "session-a", "provider-b")) {
		t.Fatal("same session was admitted concurrently")
	}
	healthySameWorkspace := retry("healthy-a", "workspace-a", "session-c", "provider-b")
	if !executor.reserve(healthySameWorkspace) {
		t.Fatal("healthy provider was blocked by another provider")
	}
	defer executor.release(healthySameWorkspace)
	healthyOtherWorkspace := retry("healthy-b", "workspace-b", "session-d", "provider-c")
	if !executor.reserve(healthyOtherWorkspace) {
		t.Fatal("healthy workspace was blocked")
	}
	defer executor.release(healthyOtherWorkspace)
	if executor.reserve(retry("workspace-over-cap", "workspace-a", "session-e", "provider-d")) {
		t.Fatal("workspace exceeded edit-retry cap")
	}
	if executor.reserve(busy) {
		t.Fatal("repeated tick reserved the same operation twice")
	}
}

func TestEditRetryExecutorUnknownProviderIsSessionScoped(t *testing.T) {
	executor := newEditRetryExecutor(2)
	first := storesqlite.RuntimeOperation{OperationID: "unknown-a", WorkspaceID: "workspace", AgentSessionID: "session-a", Kind: storesqlite.RuntimeOperationKindEditRetry}
	second := storesqlite.RuntimeOperation{OperationID: "unknown-b", WorkspaceID: "workspace", AgentSessionID: "session-b", Kind: storesqlite.RuntimeOperationKindEditRetry}
	if !executor.reserve(first) || !executor.reserve(second) {
		t.Fatal("missing provider keys were not isolated by session")
	}
	executor.release(second)
	executor.release(first)
}
