package agenthost

import (
	"context"
	"errors"
	"testing"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// TestExecuteEditRetryRuntimeOperationRejectsLegacyProtocolBeforePorts proves
// the direct Host execution guard. Every provider and store port is nil here:
// reaching even a read would panic, while a V1 payload must stop at the
// protocol boundary with its caller-owned fence untouched.
func TestExecuteEditRetryRuntimeOperationRejectsLegacyProtocolBeforePorts(t *testing.T) {
	host := New(Config{})
	operation := storesqlite.RuntimeOperation{
		OperationID: "legacy-operation", WorkspaceID: "workspace", AgentSessionID: "session",
		Kind: storesqlite.RuntimeOperationKindEditRetry, Status: storesqlite.RuntimeOperationStatusLeased,
		Attempt: 1, CreatedAtUnixMS: time.Now().UnixMilli(),
		Payload: map[string]any{
			"clientOperationId": "legacy-client", "editedText": "replacement", "replacementTurnId": "replacement-turn",
			"clientSubmitId": "edit-retry:legacy-operation", "expectedHistoryRevision": float64(0), "step": "prepared",
		},
	}
	returned, err := host.executeEditRetryRuntimeOperation(context.Background(), operation, "owner", false)
	if !errors.Is(err, ErrEditRetryRecoveryRequired) || returned.OperationID != operation.OperationID {
		t.Fatalf("legacy execute returned=%#v error=%v", returned, err)
	}
}
