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

// hangingProviderAcceptanceAdapter blocks inside ExecWithProviderAcceptance
// until the Exec context is canceled. It never reports an acceptance receipt,
// mirroring Claude cancel-before-identity-bound.
type hangingProviderAcceptanceAdapter struct {
	recordingStartAdapter
	entered chan struct{}
}

func (*hangingProviderAcceptanceAdapter) ForkCapabilities(
	context.Context,
	Session,
) (SessionForkCapabilities, error) {
	return SessionForkCapabilities{ThroughTurn: true}, nil
}

func (*hangingProviderAcceptanceAdapter) Fork(
	context.Context,
	SessionForkInput,
) (SessionForkResult, error) {
	return SessionForkResult{}, nil
}

func (a *hangingProviderAcceptanceAdapter) ExecWithProviderAcceptance(
	ctx context.Context,
	_ Session,
	_ []PromptContentBlock,
	_ string,
	_ string,
	_ EventSink,
	_ CommandSnapshotSink,
	_ ProviderDispatchSink,
	_ ProviderAcceptanceBarrier,
) ([]activityshared.Event, error) {
	if a.entered != nil {
		select {
		case a.entered <- struct{}{}:
		default:
		}
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

func (*hangingProviderAcceptanceAdapter) UsesRootProviderTurnLifecycle() bool {
	return true
}

func TestControllerCancelBeforeProviderAcceptanceDoesNotLeaveDeliveryUnknown(t *testing.T) {
	t.Parallel()

	entered := make(chan struct{}, 1)
	adapter := &hangingProviderAcceptanceAdapter{
		recordingStartAdapter: recordingStartAdapter{provider: ProviderClaudeCode},
		entered:               entered,
	}
	controller := NewController([]Adapter{adapter}, &recordingReporter{})
	if _, err := controller.Start(t.Context(), StartInput{
		RoomID: "room-1", AgentSessionID: "session-cancel-before-accept",
		Provider: ProviderClaudeCode, CWD: "/workspace", Provisional: true,
	}); err != nil {
		t.Fatal(err)
	}

	execDone := make(chan struct {
		result ExecResult
		err    error
	}, 1)
	go func() {
		result, err := controller.Exec(t.Context(), ExecInput{
			RoomID: "room-1", AgentSessionID: "session-cancel-before-accept",
			TurnID: "turn-cancel-before-accept", Content: textPrompt("sleep 60"),
			ClientSubmitID:                  "submit-cancel-before-accept",
			CanonicalSubmitOccurredAtUnixMS: 1_700_000_000_001,
			RequireProviderAcceptance:       true,
		})
		execDone <- struct {
			result ExecResult
			err    error
		}{result: result, err: err}
	}()

	select {
	case <-entered:
	case outcome := <-execDone:
		t.Fatalf("Exec finished before provider acceptance: err=%v result=%#v", outcome.err, outcome.result)
	case <-t.Context().Done():
		t.Fatal("provider acceptance never entered")
	}
	waitForCondition(t, func() bool {
		return controller.HasActiveTurn("room-1", "session-cancel-before-accept")
	})
	if _, err := controller.Cancel(t.Context(), rootCancelInput(
		"room-1",
		"session-cancel-before-accept",
		"turn-cancel-before-accept",
		"user requested turn cancellation",
	)); err != nil {
		t.Fatalf("Cancel: %v", err)
	}

	outcome := <-execDone
	if outcome.err != nil {
		t.Fatalf("Exec() error = %v, want nil after cancel-before-acceptance", outcome.err)
	}
	if outcome.result.ProviderDispatch == nil ||
		outcome.result.ProviderDispatch.Disposition != DispatchDispositionAppliedWithoutProviderTurn ||
		outcome.result.ProviderDispatch.Acceptance != nil {
		t.Fatalf(
			"provider dispatch = %#v, want applied_without_provider_turn",
			outcome.result.ProviderDispatch,
		)
	}
	if outcome.result.TurnID != "turn-cancel-before-accept" {
		t.Fatalf("turn id = %q, want turn-cancel-before-accept", outcome.result.TurnID)
	}
}

// preAcceptanceOutcomeUnknownAdapter reports outcome_unknown then returns
// without waiting for ctx cancel — matching Claude turn_canceled settling
// before Controller cancels runCtx.
type preAcceptanceOutcomeUnknownAdapter struct {
	recordingStartAdapter
	entered chan struct{}
}

func (*preAcceptanceOutcomeUnknownAdapter) ForkCapabilities(
	context.Context,
	Session,
) (SessionForkCapabilities, error) {
	return SessionForkCapabilities{ThroughTurn: true}, nil
}

func (*preAcceptanceOutcomeUnknownAdapter) Fork(
	context.Context,
	SessionForkInput,
) (SessionForkResult, error) {
	return SessionForkResult{}, nil
}

func (a *preAcceptanceOutcomeUnknownAdapter) ExecWithProviderAcceptance(
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
	if a.entered != nil {
		select {
		case a.entered <- struct{}{}:
		default:
		}
	}
	reportDispatch(ProviderDispatchResult{
		Disposition: DispatchDispositionOutcomeUnknown,
	})
	return nil, nil
}

func (*preAcceptanceOutcomeUnknownAdapter) UsesRootProviderTurnLifecycle() bool {
	return true
}

func TestControllerPreAcceptanceOutcomeUnknownDoesNotLeaveDeliveryUnknown(t *testing.T) {
	t.Parallel()

	adapter := &preAcceptanceOutcomeUnknownAdapter{
		recordingStartAdapter: recordingStartAdapter{provider: ProviderClaudeCode},
		entered:               make(chan struct{}, 1),
	}
	controller := NewController([]Adapter{adapter}, &recordingReporter{})
	if _, err := controller.Start(t.Context(), StartInput{
		RoomID: "room-1", AgentSessionID: "session-outcome-unknown",
		Provider: ProviderClaudeCode, CWD: "/workspace", Provisional: true,
	}); err != nil {
		t.Fatal(err)
	}

	result, err := controller.Exec(t.Context(), ExecInput{
		RoomID: "room-1", AgentSessionID: "session-outcome-unknown",
		TurnID: "turn-outcome-unknown", Content: textPrompt("sleep 60"),
		ClientSubmitID:                  "submit-outcome-unknown",
		CanonicalSubmitOccurredAtUnixMS: 1_700_000_000_002,
		RequireProviderAcceptance:       true,
	})
	if err != nil {
		t.Fatalf("Exec() error = %v, want nil", err)
	}
	if result.ProviderDispatch == nil ||
		result.ProviderDispatch.Disposition != DispatchDispositionAppliedWithoutProviderTurn ||
		result.ProviderDispatch.Acceptance != nil {
		t.Fatalf(
			"provider dispatch = %#v, want applied_without_provider_turn",
			result.ProviderDispatch,
		)
	}
}

func TestControllerCallerCancelDuringAcceptanceDoesNotLeaveDeliveryUnknown(t *testing.T) {
	t.Parallel()

	entered := make(chan struct{}, 1)
	adapter := &hangingProviderAcceptanceAdapter{
		recordingStartAdapter: recordingStartAdapter{provider: ProviderClaudeCode},
		entered:               entered,
	}
	controller := NewController([]Adapter{adapter}, &recordingReporter{})
	if _, err := controller.Start(t.Context(), StartInput{
		RoomID: "room-1", AgentSessionID: "session-caller-cancel",
		Provider: ProviderClaudeCode, CWD: "/workspace", Provisional: true,
	}); err != nil {
		t.Fatal(err)
	}

	callerCtx, callerCancel := context.WithCancel(t.Context())
	defer callerCancel()

	execDone := make(chan struct {
		result ExecResult
		err    error
	}, 1)
	go func() {
		result, err := controller.Exec(callerCtx, ExecInput{
			RoomID: "room-1", AgentSessionID: "session-caller-cancel",
			TurnID: "turn-caller-cancel", Content: textPrompt("sleep 60"),
			ClientSubmitID:                  "submit-caller-cancel",
			CanonicalSubmitOccurredAtUnixMS: 1_700_000_000_003,
			RequireProviderAcceptance:       true,
		})
		execDone <- struct {
			result ExecResult
			err    error
		}{result: result, err: err}
	}()

	select {
	case <-entered:
	case outcome := <-execDone:
		t.Fatalf("Exec finished before provider acceptance: err=%v result=%#v", outcome.err, outcome.result)
	case <-t.Context().Done():
		t.Fatal("provider acceptance never entered")
	}
	callerCancel()

	outcome := <-execDone
	if outcome.err != nil {
		t.Fatalf("Exec() error = %v, want nil after caller cancel", outcome.err)
	}
	if outcome.result.ProviderDispatch == nil ||
		outcome.result.ProviderDispatch.Disposition != DispatchDispositionAppliedWithoutProviderTurn ||
		outcome.result.ProviderDispatch.Acceptance != nil {
		t.Fatalf(
			"provider dispatch = %#v, want applied_without_provider_turn",
			outcome.result.ProviderDispatch,
		)
	}
}
