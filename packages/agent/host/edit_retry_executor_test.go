package agenthost

import (
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

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
