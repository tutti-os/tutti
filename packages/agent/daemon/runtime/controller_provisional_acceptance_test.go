package agentruntime

import (
	"context"
	"errors"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type rejectingProviderAcceptanceAdapter struct {
	recordingStartAdapter
	failure error
}

func (*rejectingProviderAcceptanceAdapter) ForkCapabilities(
	context.Context,
	Session,
) (SessionForkCapabilities, error) {
	return SessionForkCapabilities{ThroughTurn: true}, nil
}

func (*rejectingProviderAcceptanceAdapter) Fork(
	context.Context,
	SessionForkInput,
) (SessionForkResult, error) {
	return SessionForkResult{}, nil
}

func (a *rejectingProviderAcceptanceAdapter) ExecWithProviderAcceptance(
	_ context.Context,
	_ Session,
	_ []PromptContentBlock,
	_ string,
	_ string,
	_ EventSink,
	_ CommandSnapshotSink,
	reportDispatch ProviderDispatchSink,
	_ ProviderAcceptanceBarrier,
) ([]activityshared.Event, error) {
	reportDispatch(ProviderDispatchResult{
		Disposition: DispatchDispositionRejected,
		Failure:     a.failure,
	})
	return nil, a.failure
}

func (*rejectingProviderAcceptanceAdapter) UsesRootProviderTurnLifecycle() bool {
	return true
}

func TestControllerProvisionalSessionPublishesPromptAndSettlesRejectedFirstTurn(t *testing.T) {
	t.Parallel()

	providerFailure := &AppError{
		Code:    "auth_required",
		Message: "Claude Code needs authentication",
	}
	adapter := &rejectingProviderAcceptanceAdapter{
		recordingStartAdapter: recordingStartAdapter{provider: ProviderClaudeCode},
		failure:               providerFailure,
	}
	reporter := &recordingReporter{}
	controller := NewController([]Adapter{adapter}, reporter)
	if _, err := controller.Start(t.Context(), StartInput{
		RoomID: "room-1", AgentSessionID: "session-rejected",
		Provider: ProviderClaudeCode, CWD: "/workspace", Provisional: true,
	}); err != nil {
		t.Fatal(err)
	}

	result, err := controller.Exec(t.Context(), ExecInput{
		RoomID: "room-1", AgentSessionID: "session-rejected",
		TurnID: "turn-rejected", Content: textPrompt("hello"),
		RequireProviderAcceptance: true,
	})
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Code != "auth_required" {
		t.Fatalf("Exec() error = %#v, want auth_required AppError", err)
	}
	if result.ProviderDispatch == nil ||
		result.ProviderDispatch.Disposition != DispatchDispositionRejected ||
		result.ProviderDispatch.Acceptance != nil {
		t.Fatalf("provider dispatch = %#v, want rejected", result.ProviderDispatch)
	}
	waitForCondition(t, func() bool {
		return !controller.HasActiveTurn("room-1", "session-rejected")
	})
	sessions := controller.Sessions("room-1")
	if len(sessions) != 1 || sessions[0].AgentSessionID != "session-rejected" {
		t.Fatalf("visible sessions = %#v, want rejected session retained", sessions)
	}
	if sessions[0].Status != SessionStatusFailed {
		t.Fatalf("rejected session status = %q, want failed", sessions[0].Status)
	}

	reports := reporter.waitForCalls(t, 2)
	var foundSubmitted, foundFailed bool
	for _, report := range reports {
		for _, patch := range report.report.StatePatches {
			if patch.Turn == nil || patch.Turn.TurnID != "turn-rejected" {
				continue
			}
			if patch.Turn.Phase == "submitted" && patch.RuntimeContext["visible"] == true {
				foundSubmitted = true
			}
			if patch.Turn.Phase == "settled" && patch.Turn.Outcome == "failed" {
				foundFailed = true
			}
		}
	}
	if !foundSubmitted || !foundFailed {
		t.Fatalf("reports = %#v, want visible submitted and failed Turn reports", reports)
	}
}
