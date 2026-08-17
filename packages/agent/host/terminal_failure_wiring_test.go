package agenthost

import (
	"context"
	"slices"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type failingRuntimeOperationStore struct {
	RuntimeOperationStore
	operation storesqlite.RuntimeOperation
}

func (s failingRuntimeOperationStore) ReleaseOrFailRuntimeOperation(
	context.Context,
	storesqlite.ReleaseOrFailRuntimeOperationInput,
) (storesqlite.RuntimeOperation, bool, error) {
	return s.operation, true, nil
}

type failingEditRetryHistoryStore struct {
	EffectiveHistoryStore
	operation storesqlite.RuntimeOperation
}

func (s failingEditRetryHistoryStore) FailEditRetryRecovery(
	context.Context,
	storesqlite.FailEditRetryRecoveryInput,
) (storesqlite.RuntimeOperation, bool, error) {
	return s.operation, true, nil
}

// An adapter that wires failure analytics without a CommitObserver still needs
// the durable runtime, edit-retry, and goal failures that only reach an
// observer through the observed store wrappers.
func TestTerminalFailureObserverOnlyHostObservesDurableCommitFailures(t *testing.T) {
	observer := &recordingTerminalFailureObserver{}
	host := New(Config{
		TerminalFailureObserver: observer,
		RuntimeOperations: failingRuntimeOperationStore{operation: storesqlite.RuntimeOperation{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", OperationID: "op-interactive",
			Kind: storesqlite.RuntimeOperationKindInteractiveResponse, TurnID: "turn-1",
			LastError: "interactive submit rejected",
		}},
		EffectiveHistory: failingEditRetryHistoryStore{operation: storesqlite.RuntimeOperation{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", OperationID: "op-edit-retry",
			Kind: storesqlite.RuntimeOperationKindEditRetry, TurnID: "turn-1",
			LastError: "edit retry recovery failed",
		}},
		GoalStore: goalCommitStageStore{releaseOperation: storesqlite.GoalControlOperation{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", OperationID: "op-goal",
			LastError: "goal runtime unavailable",
		}},
	})

	ctx := context.Background()
	if _, _, err := host.operations.ReleaseOrFailRuntimeOperation(
		ctx, storesqlite.ReleaseOrFailRuntimeOperationInput{Fail: true},
	); err != nil {
		t.Fatal(err)
	}
	if _, _, err := host.effectiveHistory.FailEditRetryRecovery(
		ctx, storesqlite.FailEditRetryRecoveryInput{},
	); err != nil {
		t.Fatal(err)
	}
	if _, _, err := host.goals.ReleaseGoalControlOperation(
		ctx, storesqlite.ReleaseGoalControlOperationInput{Fail: true},
	); err != nil {
		t.Fatal(err)
	}

	flows := make([]string, 0, len(observer.failures))
	for _, failure := range observer.failures {
		flows = append(flows, failure.Flow)
	}
	want := []string{"interactive_response", "edit_retry", "goal_control"}
	if !slices.Equal(flows, want) {
		t.Fatalf("failure flows = %#v, want %#v", flows, want)
	}
}
