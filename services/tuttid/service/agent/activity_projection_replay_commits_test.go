package agent

import (
	"context"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
)

type replayCommitObserverStub struct {
	deltas          []agenthost.CommittedDelta
	contexts        []replay.ProviderObservationCommitContext
	lifecycleDeltas []agenthost.CommittedDelta
}

func (o *replayCommitObserverStub) ObserveCommitted(
	_ context.Context,
	delta agenthost.CommittedDelta,
) error {
	o.lifecycleDeltas = append(o.lifecycleDeltas, delta)
	return nil
}

func (o *replayCommitObserverStub) ObserveReplayCommitted(
	_ context.Context,
	delta agenthost.CommittedDelta,
	replayContext replay.ProviderObservationCommitContext,
) error {
	o.deltas = append(o.deltas, delta)
	o.contexts = append(o.contexts, replayContext)
	return nil
}

func TestActivityProjectionForwardsReportedGoalCommitOnce(t *testing.T) {
	projection := NewActivityProjection(&activityProjectionRepoStub{})
	observer := &replayCommitObserverStub{}
	projection.SetReplayCommitObserver(observer)
	delta := agenthost.CommittedDelta{
		TransactionID: "transaction-goal-reconciled",
		ActivityState: &agenthost.ActivityStateCommitted{},
		GoalOperation: &agenthost.GoalOperationCommitted{
			Stage: agenthost.GoalOperationReconciled,
		},
	}

	if err := projection.ObserveCommitted(context.Background(), delta); err != nil {
		t.Fatal(err)
	}
	if len(observer.lifecycleDeltas) != 1 {
		t.Fatalf("lifecycle commits = %d, want 1", len(observer.lifecycleDeltas))
	}
	if got := observer.lifecycleDeltas[0].TransactionID; got != delta.TransactionID {
		t.Fatalf("forwarded transaction = %q, want %q", got, delta.TransactionID)
	}
}

func TestActivityProjectionPairsReplayContextWithExactCommittedDelta(
	t *testing.T,
) {
	projection := NewActivityProjection(&activityProjectionRepoStub{})
	observer := &replayCommitObserverStub{}
	projection.SetReplayCommitObserver(observer)
	delta := agenthost.CommittedDelta{TransactionID: "transaction-1"}
	replayContext := replay.ProviderObservationCommitContext{
		RecordingID: "recording-1",
		Batches: []replay.ProviderObservationBatch{{
			RecordingID:  "recording-1",
			ConnectionID: "provider-1",
			ChunkSeq:     2,
			UnitIndex:    3,
			Events: []replay.ProviderObservationEvent{{
				EventIndex: 4,
				Type:       "turn.started",
				TurnID:     "turn-runtime",
			}},
		}},
	}

	projection.notifyReplayCommitted(
		context.Background(),
		delta,
		replayContext,
	)
	replayContext.Batches[0].Events[0].TurnID = "mutated"

	if len(observer.deltas) != 1 {
		t.Fatalf("Replay commits = %d, want 1", len(observer.deltas))
	}
	observedDelta := observer.deltas[0]
	observedContext := observer.contexts[0]
	if observedDelta.TransactionID != delta.TransactionID {
		t.Fatalf(
			"paired transaction = %q, want %q",
			observedDelta.TransactionID,
			delta.TransactionID,
		)
	}
	if observedContext.RecordingID != "recording-1" {
		t.Fatalf(
			"paired RecordingID = %q, want recording-1",
			observedContext.RecordingID,
		)
	}
	if got := observedContext.Batches[0].Events[0].TurnID; got != "turn-runtime" {
		t.Fatalf("Replay context was not cloned: TurnID=%q", got)
	}

	projection.notifyReplayCommitted(
		context.Background(),
		agenthost.CommittedDelta{TransactionID: "transaction-2"},
		replay.ProviderObservationCommitContext{},
	)
	if len(observer.deltas) != 1 {
		t.Fatalf(
			"empty Replay context emitted envelope: count=%d",
			len(observer.deltas),
		)
	}
}
