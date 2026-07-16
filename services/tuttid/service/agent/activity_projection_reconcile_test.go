package agent

import (
	"context"
	"errors"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

type recordingStartupStateObserver struct {
	inputs []agentsessionstore.ReportSessionStateInput
}

func (o *recordingStartupStateObserver) ObserveAgentSessionState(_ context.Context, input agentsessionstore.ReportSessionStateInput, _ agentsessionstore.ReportSessionStateReply) {
	o.inputs = append(o.inputs, input)
}

func TestSettleStaleTurnsOnStartupReturnsRepositoryFailure(t *testing.T) {
	want := errors.New("settle stale turns failed")
	projection := NewActivityProjection(&activityProjectionRepoStub{settleStaleErr: want})
	if err := projection.SettleStaleTurnsOnStartup(context.Background()); !errors.Is(err, want) {
		t.Fatalf("SettleStaleTurnsOnStartup() error = %v, want %v", err, want)
	}
}

func TestSettleStaleTurnsOnStartupNotifiesSessionStateObserver(t *testing.T) {
	repo := &activityProjectionRepoStub{
		settlements: []agentactivitybiz.StaleTurnSettlement{{WorkspaceID: "ws", AgentSessionID: "session-target", TurnID: "turn-1"}},
		turnFound:   true,
		turnResult: agentactivitybiz.Turn{
			WorkspaceID:     "ws",
			AgentSessionID:  "session-target",
			TurnID:          "turn-1",
			Phase:           agentactivitybiz.TurnPhaseSettled,
			Outcome:         agentactivitybiz.TurnOutcomeInterrupted,
			ErrorMessage:    "daemon restarted",
			StartedAtUnixMS: 1700000000000,
			SettledAtUnixMS: 1700000002500,
		},
	}
	projection := NewActivityProjection(repo)
	observer := &recordingStartupStateObserver{}
	projection.SetSessionStateObserver(observer)
	if err := projection.SettleStaleTurnsOnStartup(context.Background()); err != nil {
		t.Fatalf("SettleStaleTurnsOnStartup() error = %v", err)
	}
	if len(observer.inputs) != 1 {
		t.Fatalf("observer inputs = %#v", observer.inputs)
	}
	state := observer.inputs[0].State
	if state.Turn == nil || state.Turn.Outcome != agentactivitybiz.TurnOutcomeInterrupted || state.LastError != "daemon restarted" {
		t.Fatalf("observer state = %#v", state)
	}
}
