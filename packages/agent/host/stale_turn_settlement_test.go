package agenthost

import (
	"context"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type recordingStaleTurnFailureObserver struct {
	failures []TerminalFailure
}

func (o *recordingStaleTurnFailureObserver) ObserveTerminalFailure(_ context.Context, failure TerminalFailure) {
	o.failures = append(o.failures, failure)
}

func TestStaleTurnSettlementDeltaDoesNotReportInterruptedAsFailure(t *testing.T) {
	delta := StaleTurnSettlementDelta([]storesqlite.StaleTurnSettlement{
		{WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-stale"},
		{WorkspaceID: "ws-1", AgentSessionID: "session-2", TurnID: ""},
	})
	if len(delta.RootTurnsSettled) != 1 {
		t.Fatalf("root turns settled = %#v, want only the settlement carrying a turn", delta.RootTurnsSettled)
	}
	settled := delta.RootTurnsSettled[0]
	if settled.Turn.Phase != storesqlite.TurnPhaseSettled || settled.Turn.Outcome != storesqlite.TurnOutcomeInterrupted {
		t.Fatalf("settled turn = %#v, want settled phase with interrupted outcome", settled.Turn)
	}
	if !settled.StartupReconciled {
		t.Fatalf("settled turn = %#v, want the startup reconciliation marker", settled)
	}

	observer := &recordingStaleTurnFailureObserver{}
	ObserveTerminalFailuresFromDelta(context.Background(), observer, delta)
	if len(observer.failures) != 0 {
		t.Fatalf("terminal failures = %#v, want interrupted settlement excluded", observer.failures)
	}
}

func TestStaleTurnSettlementDeltaKeepsChildSessionIdentityFromStore(t *testing.T) {
	delta := StaleTurnSettlementDelta([]storesqlite.StaleTurnSettlement{
		{WorkspaceID: "ws-1", AgentSessionID: "child-1", TurnID: "turn-stale", IsChildSession: true},
	})
	if len(delta.RootTurnsSettled) != 1 || !delta.RootTurnsSettled[0].IsChildSession {
		t.Fatalf("root turns settled = %#v, want persisted child identity", delta.RootTurnsSettled)
	}

	observer := &recordingStaleTurnFailureObserver{}
	ObserveTerminalFailuresFromDelta(context.Background(), observer, delta)
	if len(observer.failures) != 0 {
		t.Fatalf("terminal failures = %#v, want interrupted child settlement excluded", observer.failures)
	}
}
