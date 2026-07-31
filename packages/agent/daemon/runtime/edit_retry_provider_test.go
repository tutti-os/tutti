package agentruntime

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
)

type providerAcceptanceBarrierReporter struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

type historyMutationOnlyAdapter struct {
	Adapter
}

func (historyMutationOnlyAdapter) ReadEffectiveHistory(
	context.Context,
	Session,
) (EffectiveHistorySnapshot, error) {
	return EffectiveHistorySnapshot{}, nil
}

func (historyMutationOnlyAdapter) RollbackLatestTurn(
	context.Context,
	Session,
) (HistoryMutationResult, error) {
	return HistoryMutationResult{}, nil
}

func TestEffectiveHistoryCapabilityRequiresReplacementStart(t *testing.T) {
	var candidate any = historyMutationOnlyAdapter{}
	if _, supported := candidate.(EffectiveHistoryAdapter); supported {
		t.Fatal("history read/rollback without typed replacement start must not advertise edit-retry")
	}
}

func (reporter *providerAcceptanceBarrierReporter) Report(
	ctx context.Context,
	report agentsessionstore.ReportActivityInput,
) error {
	for _, patch := range report.StatePatches {
		if patch.RootProviderTurn == nil ||
			patch.RootProviderTurn.Phase != agentsessionstore.RootProviderTurnPhaseRunning {
			continue
		}
		reporter.once.Do(func() { close(reporter.entered) })
		select {
		case <-reporter.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (reporter *providerAcceptanceBarrierReporter) ReportSubmitProvenance(
	ctx context.Context,
	report agentsessionstore.ReportActivityInput,
) error {
	return reporter.Report(ctx, report)
}

func TestCodexEffectiveHistoryUsesNoHandlerTypedCommands(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.historyTurns = []any{
		map[string]any{
			"id": "provider-turn-1", "status": "completed",
			"items": []any{map[string]any{
				"type": "userMessage", "clientId": "canonical-turn-1",
			}},
		},
		map[string]any{"id": "provider-turn-2", "status": "failed", "items": []any{}},
	}
	transport.server.rollbackHistoryTurns = []any{
		map[string]any{"id": "provider-turn-1", "status": "completed", "items": []any{}},
	}

	read, err := adapter.ReadEffectiveHistory(t.Context(), session)
	if err != nil {
		t.Fatal(err)
	}
	if read.ProviderSessionID != "codex-thread-1" || len(read.Turns) != 2 ||
		read.Turns[0].ClientUserMessageID != "canonical-turn-1" {
		t.Fatalf("history read = %#v", read)
	}
	readParams := appServerRequestParams(t, transport.conn, appServerMethodThreadRead)
	if includeTurns, _ := readParams["includeTurns"].(bool); !includeTurns {
		t.Fatalf("thread/read params = %#v, want includeTurns=true", readParams)
	}

	rollback, err := adapter.RollbackLatestTurn(t.Context(), session)
	if err != nil {
		t.Fatal(err)
	}
	if rollback.Disposition != DispatchDispositionApplied || rollback.Snapshot == nil ||
		len(rollback.Snapshot.Turns) != 1 {
		t.Fatalf("rollback result = %#v", rollback)
	}
	rollbackParams := appServerRequestParams(t, transport.conn, appServerMethodThreadRollback)
	if numTurns, _ := int64Value(rollbackParams["numTurns"]); numTurns != 1 {
		t.Fatalf("thread/rollback params = %#v, want numTurns=1", rollbackParams)
	}
}

func TestCodexProviderTurnBindingRecoveryRequiresOneExactOpaqueToken(t *testing.T) {
	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.ProviderSessionID = "codex-thread-1"
	transport.server.historyTurns = []any{
		map[string]any{
			"id": "provider-turn-1", "status": "completed",
			"items": []any{map[string]any{
				"type": "userMessage", "clientId": "opaque-submit-1",
			}},
		},
		map[string]any{
			"id": "provider-turn-2", "status": "failed",
			"items": []any{map[string]any{
				"type": "userMessage", "clientId": "opaque-submit-2",
			}},
		},
	}
	recovered, err := adapter.RecoverProviderTurnBinding(
		t.Context(),
		ProviderTurnBindingRecoveryInput{
			Source: session, RecoveryToken: "opaque-submit-2",
		},
	)
	if err != nil ||
		recovered.ProviderSessionID != session.ProviderSessionID ||
		recovered.ProviderTurnID != "provider-turn-2" ||
		string(recovered.ProviderTurnBindingJSON) != `{"schemaVersion":1}` {
		t.Fatalf("recovered binding = %#v error=%v", recovered, err)
	}
	ambiguousHistory := append(
		[]any(nil),
		transport.server.historyTurns...,
	)
	ambiguousHistory = append(
		ambiguousHistory,
		map[string]any{
			"id": "provider-turn-3", "status": "completed",
			"items": []any{map[string]any{
				"type": "userMessage", "clientId": "opaque-submit-2",
			}},
		},
	)
	transport.conn, transport.server = newScriptedAppServerHarness()
	transport.server.historyTurns = ambiguousHistory
	if _, err := adapter.RecoverProviderTurnBinding(
		t.Context(),
		ProviderTurnBindingRecoveryInput{
			Source: session, RecoveryToken: "opaque-submit-2",
		},
	); err == nil {
		t.Fatal("ambiguous provider recovery token was accepted")
	}
}

func TestCodexEffectiveHistoryRollbackReportsExplicitRejection(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.rollbackUnsupported = true

	result, err := adapter.RollbackLatestTurn(t.Context(), session)
	if !errors.Is(err, ErrEffectiveHistoryUnsupported) {
		t.Fatalf("rollback error = %v, want ErrEffectiveHistoryUnsupported", err)
	}
	if result.Disposition != DispatchDispositionRejected || result.Snapshot != nil {
		t.Fatalf("rollback result = %#v, want rejected without snapshot", result)
	}
}

func TestControllerHistoryReplacementReturnsDurableDirectReceipt(t *testing.T) {
	var connection *scriptedAppServerConnection
	barrier := &providerAcceptanceBarrierReporter{
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
	controller, _, sessionID := startedEditRetryControllerWithReporter(t, barrier, func(
		_ *CodexAppServerAdapter,
		transport *scriptedAppServerTransport,
	) {
		connection = transport.conn
	})

	type execOutcome struct {
		result ExecResult
		err    error
	}
	completed := make(chan execOutcome, 1)
	go func() {
		result, err := controller.Exec(t.Context(), ExecInput{
			RoomID: "room-edit-retry", AgentSessionID: sessionID,
			TurnID: "replacement-turn-1", ClientSubmitID: "replacement-submit-1",
			CanonicalSubmitOccurredAtUnixMS: 1_001,
			Content:                         textPrompt("replacement"),
			HistoryReplacement:              true,
		})
		completed <- execOutcome{result: result, err: err}
	}()
	select {
	case <-barrier.entered:
	case <-time.After(time.Second):
		t.Fatal("provider acceptance durable report was not reached")
	}
	select {
	case outcome := <-completed:
		t.Fatalf("Exec returned before durable provider acceptance: %#v", outcome)
	default:
	}
	close(barrier.release)
	outcome := <-completed
	result, err := outcome.result, outcome.err
	if err != nil {
		t.Fatal(err)
	}
	if result.ProviderDispatch == nil ||
		result.ProviderDispatch.Disposition != DispatchDispositionApplied ||
		result.ProviderDispatch.Acceptance == nil ||
		result.ProviderDispatch.Acceptance.Source != AcceptanceSourceTurnStartResponse ||
		result.ProviderDispatch.Acceptance.ProviderSessionID != "codex-thread-1" ||
		result.ProviderDispatch.Acceptance.ProviderTurnID != "turn-1" {
		t.Fatalf("provider dispatch = %#v", result.ProviderDispatch)
	}
	turnStart := appServerRequestParams(t, connection, appServerMethodTurnStart)
	if got := asString(turnStart["clientUserMessageId"]); got != "replacement-submit-1" {
		t.Fatalf("replacement clientUserMessageId = %q", got)
	}
}

func TestControllerReconcilesHistoryAcceptanceThroughDurableBarrier(t *testing.T) {
	barrier := &providerAcceptanceBarrierReporter{
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
	controller, _, sessionID := startedEditRetryControllerWithReporter(
		t,
		barrier,
		nil,
	)
	completed := make(chan error, 1)
	go func() {
		completed <- controller.ReconcileProviderTurnAcceptance(
			t.Context(),
			ProviderTurnAcceptanceInput{
				RoomID: "room-edit-retry", AgentSessionID: sessionID,
				Provider: ProviderCodex, RootTurnID: "replacement-turn-history",
				ExpectedProviderSessionID: "codex-thread-1",
				ExpectedProviderTurnID:    "provider-turn-history",
				ClientUserMessageID:       "edit-retry:operation-history",
			},
		)
	}()
	select {
	case <-barrier.entered:
	case <-time.After(time.Second):
		t.Fatal("history acceptance durable report was not reached")
	}
	select {
	case err := <-completed:
		t.Fatalf("reconcile returned before durable provider acceptance: %v", err)
	default:
	}
	close(barrier.release)
	if err := <-completed; err != nil {
		t.Fatalf("ReconcileProviderTurnAcceptance() error = %v", err)
	}
}

func TestControllerRejectsCanonicalTurnIDAsProviderAcceptanceEvidence(t *testing.T) {
	controller, _, sessionID := startedEditRetryController(t, nil)

	err := controller.ReconcileProviderTurnAcceptance(
		t.Context(),
		ProviderTurnAcceptanceInput{
			RoomID: "room-edit-retry", AgentSessionID: sessionID,
			Provider: ProviderCodex, RootTurnID: "replacement-turn-history",
			ExpectedProviderSessionID: "codex-thread-1",
			ExpectedProviderTurnID:    "provider-turn-history",
			ClientUserMessageID:       "replacement-turn-history",
		},
	)
	if err == nil {
		t.Fatal("ReconcileProviderTurnAcceptance() error = nil, want invalid evidence")
	}
}

func TestControllerHistoryReplacementAckTimeoutIsOutcomeUnknown(t *testing.T) {
	controller, adapter, sessionID := startedEditRetryController(t, func(
		adapter *CodexAppServerAdapter,
		transport *scriptedAppServerTransport,
	) {
		transport.server.hangTurnStart = true
		adapter.turnStartAckTimeout = 20 * time.Millisecond
	})

	result, err := controller.Exec(t.Context(), ExecInput{
		RoomID: "room-edit-retry", AgentSessionID: sessionID,
		TurnID: "replacement-turn-timeout", ClientSubmitID: "replacement-submit-timeout",
		CanonicalSubmitOccurredAtUnixMS: 1_002,
		Content:                         textPrompt("replacement"),
		HistoryReplacement:              true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ProviderDispatch == nil ||
		result.ProviderDispatch.Disposition != DispatchDispositionOutcomeUnknown ||
		result.ProviderDispatch.Acceptance != nil {
		t.Fatalf("provider dispatch = %#v, want outcome_unknown", result.ProviderDispatch)
	}
	waitForCondition(t, func() bool { return adapter.getSession(sessionID) == nil })
}

func TestControllerHistoryReplacementExplicitRejectionIsTyped(t *testing.T) {
	controller, adapter, sessionID := startedEditRetryController(t, func(
		_ *CodexAppServerAdapter,
		transport *scriptedAppServerTransport,
	) {
		transport.server.turnStartError = true
	})

	result, err := controller.Exec(t.Context(), ExecInput{
		RoomID: "room-edit-retry", AgentSessionID: sessionID,
		TurnID: "replacement-turn-rejected", Content: textPrompt("replacement"),
		HistoryReplacement: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ProviderDispatch == nil ||
		result.ProviderDispatch.Disposition != DispatchDispositionRejected ||
		result.ProviderDispatch.Acceptance != nil {
		t.Fatalf("provider dispatch = %#v, want rejected", result.ProviderDispatch)
	}
	if adapter.getSession(sessionID) == nil {
		t.Fatal("explicit provider rejection invalidated a healthy client")
	}
}

func TestControllerOrdinarySendStillReturnsBeforeTurnStartAck(t *testing.T) {
	var connection *scriptedAppServerConnection
	controller, _, sessionID := startedEditRetryController(t, func(
		adapter *CodexAppServerAdapter,
		transport *scriptedAppServerTransport,
	) {
		connection = transport.conn
		transport.server.hangTurnStart = true
		adapter.turnStartAckTimeout = 200 * time.Millisecond
	})

	startedAt := time.Now()
	result, err := controller.Exec(t.Context(), ExecInput{
		RoomID: "room-edit-retry", AgentSessionID: sessionID,
		TurnID: "ordinary-turn-1", ClientSubmitID: "ordinary-submit-1",
		CanonicalSubmitOccurredAtUnixMS: 1_004,
		Content:                         textPrompt("ordinary"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(startedAt); elapsed >= 100*time.Millisecond {
		t.Fatalf("ordinary Exec waited %v for turn/start ACK", elapsed)
	}
	if result.ProviderDispatch != nil {
		t.Fatalf("ordinary provider dispatch = %#v, want nil", result.ProviderDispatch)
	}
	waitForCondition(t, func() bool {
		return len(appServerRequestParamsList(t, connection, appServerMethodTurnStart)) == 1
	})
	turnStart := appServerRequestParams(t, connection, appServerMethodTurnStart)
	if got := asString(turnStart["clientUserMessageId"]); got != "ordinary-submit-1" {
		t.Fatalf("ordinary clientUserMessageId = %#v, want opaque submit identity", turnStart["clientUserMessageId"])
	}
}

func TestControllerOrdinarySendRequiresDurableProviderAcceptance(t *testing.T) {
	var connection *scriptedAppServerConnection
	barrier := &providerAcceptanceBarrierReporter{
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
	controller, _, sessionID := startedEditRetryControllerWithReporter(
		t,
		barrier,
		func(_ *CodexAppServerAdapter, transport *scriptedAppServerTransport) {
			connection = transport.conn
		},
	)
	type execOutcome struct {
		result ExecResult
		err    error
	}
	completed := make(chan execOutcome, 1)
	go func() {
		result, err := controller.Exec(t.Context(), ExecInput{
			RoomID: "room-edit-retry", AgentSessionID: sessionID,
			TurnID: "ordinary-turn-durable", ClientSubmitID: "opaque-submit-durable",
			CanonicalSubmitOccurredAtUnixMS: 1_005,
			Content:                         textPrompt("ordinary durable"),
			RequireProviderAcceptance:       true,
		})
		completed <- execOutcome{result: result, err: err}
	}()
	select {
	case <-barrier.entered:
	case <-time.After(time.Second):
		t.Fatal("ordinary provider acceptance did not reach durable reporter")
	}
	select {
	case outcome := <-completed:
		t.Fatalf("Exec returned before binding durability: %#v", outcome)
	default:
	}
	close(barrier.release)
	outcome := <-completed
	if outcome.err != nil ||
		outcome.result.ProviderDispatch == nil ||
		outcome.result.ProviderDispatch.Disposition != DispatchDispositionApplied ||
		outcome.result.ProviderDispatch.Acceptance == nil ||
		outcome.result.ProviderDispatch.Acceptance.ProviderTurnID != "turn-1" {
		t.Fatalf("durable ordinary acceptance = %#v error=%v", outcome.result, outcome.err)
	}
	turnStart := appServerRequestParams(t, connection, appServerMethodTurnStart)
	if got := asString(turnStart["clientUserMessageId"]); got != "opaque-submit-durable" {
		t.Fatalf("ordinary recovery token = %q", got)
	}
}

func TestControllerCancelDoesNotWaitForProviderAcceptanceDurability(t *testing.T) {
	var connection *scriptedAppServerConnection
	barrier := &providerAcceptanceBarrierReporter{
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
	controller, _, sessionID := startedEditRetryControllerWithReporter(
		t,
		barrier,
		func(_ *CodexAppServerAdapter, transport *scriptedAppServerTransport) {
			connection = transport.conn
			transport.server.holdTurn = true
		},
	)
	type execOutcome struct {
		result ExecResult
		err    error
	}
	execCompleted := make(chan execOutcome, 1)
	go func() {
		result, err := controller.Exec(t.Context(), ExecInput{
			RoomID: "room-edit-retry", AgentSessionID: sessionID,
			TurnID: "ordinary-turn-cancel", ClientSubmitID: "opaque-submit-cancel",
			CanonicalSubmitOccurredAtUnixMS: 1_006,
			Content:                         textPrompt("ordinary durable"),
			RequireProviderAcceptance:       true,
		})
		execCompleted <- execOutcome{result: result, err: err}
	}()
	select {
	case <-barrier.entered:
	case <-time.After(time.Second):
		t.Fatal("ordinary provider acceptance did not reach durable reporter")
	}

	cancelCompleted := make(chan error, 1)
	go func() {
		_, err := controller.Cancel(
			context.Background(),
			rootCancelInput(
				"room-edit-retry",
				sessionID,
				"ordinary-turn-cancel",
				"user requested",
			),
		)
		cancelCompleted <- err
	}()
	select {
	case err := <-cancelCompleted:
		if err != nil {
			t.Fatalf("Cancel: %v", err)
		}
	case <-time.After(time.Second):
		close(barrier.release)
		<-execCompleted
		t.Fatal("Cancel waited for provider acceptance durability")
	}
	select {
	case outcome := <-execCompleted:
		t.Fatalf("Exec abandoned provider binding after Cancel: %#v", outcome)
	default:
	}
	close(barrier.release)
	outcome := <-execCompleted
	if outcome.err != nil ||
		outcome.result.ProviderDispatch == nil ||
		outcome.result.ProviderDispatch.Disposition != DispatchDispositionApplied ||
		outcome.result.ProviderDispatch.Acceptance == nil {
		t.Fatalf("provider binding after Cancel = %#v error=%v", outcome.result, outcome.err)
	}
	if requests := appServerRequestParamsList(
		t,
		connection,
		appServerMethodTurnInterrupt,
	); len(requests) != 1 {
		t.Fatalf("turn/interrupt requests = %#v, want one immediate cancel", requests)
	}
}

func TestControllerCompatibilityProviderDoesNotRequireForkTurnAcceptance(t *testing.T) {
	t.Parallel()

	adapter := &recordingStartAdapter{provider: ProviderOpenCode}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(t.Context(), StartInput{
		RoomID:         "room-compatibility-provider",
		AgentSessionID: "session-compatibility-provider",
		Provider:       ProviderOpenCode,
		CWD:            "/workspace",
		Title:          "OpenCode",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	result, err := controller.Exec(t.Context(), ExecInput{
		RoomID: "room-compatibility-provider", AgentSessionID: started.Session.AgentSessionID,
		TurnID: "turn-compatibility-provider", ClientSubmitID: "submit-compatibility-provider",
		CanonicalSubmitOccurredAtUnixMS: 1_006,
		Content:                         textPrompt("ordinary compatibility prompt"),
		RequireProviderAcceptance:       true,
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if result.ProviderDispatch != nil {
		t.Fatalf("provider dispatch = %#v, want ordinary compatibility execution", result.ProviderDispatch)
	}
}

func TestControllerForkCapableProviderCannotSkipTurnAcceptance(t *testing.T) {
	t.Parallel()

	adapter := &forkWithoutAcceptanceAdapter{
		recordingStartAdapter: recordingStartAdapter{provider: "fork-provider"},
	}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(t.Context(), StartInput{
		RoomID:         "room-fork-provider",
		AgentSessionID: "session-fork-provider",
		Provider:       "fork-provider",
		CWD:            "/workspace",
		Title:          "Fork Provider",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	result, err := controller.Exec(t.Context(), ExecInput{
		RoomID: "room-fork-provider", AgentSessionID: started.Session.AgentSessionID,
		TurnID: "turn-fork-provider", ClientSubmitID: "submit-fork-provider",
		CanonicalSubmitOccurredAtUnixMS: 1_007,
		Content:                         textPrompt("fork-capable prompt"),
		RequireProviderAcceptance:       true,
	})
	if err == nil {
		t.Fatal("Exec error = nil, want missing durable acceptance failure")
	}
	if result.ProviderDispatch == nil ||
		result.ProviderDispatch.Disposition != DispatchDispositionNotDispatched {
		t.Fatalf("provider dispatch = %#v, want not_dispatched", result.ProviderDispatch)
	}
}

type forkWithoutAcceptanceAdapter struct {
	recordingStartAdapter
}

func (*forkWithoutAcceptanceAdapter) ForkCapabilities(
	context.Context,
	Session,
) (SessionForkCapabilities, error) {
	return SessionForkCapabilities{ThroughTurn: true}, nil
}

func (*forkWithoutAcceptanceAdapter) Fork(
	context.Context,
	SessionForkInput,
) (SessionForkResult, error) {
	return SessionForkResult{}, nil
}

func TestControllerHistoryReplacementNeverUsesSlashFallback(t *testing.T) {
	var connection *scriptedAppServerConnection
	controller, _, sessionID := startedEditRetryController(t, func(
		_ *CodexAppServerAdapter,
		transport *scriptedAppServerTransport,
	) {
		connection = transport.conn
	})

	result, err := controller.Exec(t.Context(), ExecInput{
		RoomID: "room-edit-retry", AgentSessionID: sessionID,
		TurnID: "replacement-slash", ClientSubmitID: "replacement-slash-submit",
		CanonicalSubmitOccurredAtUnixMS: 1_003,
		Content:                         textPrompt("/compact"),
		HistoryReplacement:              true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ProviderDispatch == nil ||
		result.ProviderDispatch.Disposition != DispatchDispositionApplied {
		t.Fatalf("provider dispatch = %#v", result.ProviderDispatch)
	}
	if requests := appServerRequestParamsList(
		t,
		connection,
		appServerMethodThreadCompact,
	); len(requests) != 0 {
		t.Fatalf("history replacement used /compact fallback: %#v", requests)
	}
}

func TestControllerHistoryReplacementNeverSteersActiveTurn(t *testing.T) {
	var connection *scriptedAppServerConnection
	var server *fakeCodexAppServer
	controller, _, sessionID := startedEditRetryController(t, func(
		_ *CodexAppServerAdapter,
		transport *scriptedAppServerTransport,
	) {
		connection = transport.conn
		server = transport.server
		transport.server.holdTurn = true
	})

	if _, err := controller.Exec(t.Context(), ExecInput{
		RoomID: "room-edit-retry", AgentSessionID: sessionID,
		TurnID: "ordinary-active-turn", Content: textPrompt("keep working"),
	}); err != nil {
		t.Fatal(err)
	}
	waitForCondition(t, func() bool {
		return controller.HasActiveTurn("room-edit-retry", sessionID) &&
			len(appServerRequestParamsList(t, connection, appServerMethodTurnStart)) == 1
	})

	result, err := controller.Exec(t.Context(), ExecInput{
		RoomID: "room-edit-retry", AgentSessionID: sessionID,
		TurnID: "replacement-must-not-steer", Content: textPrompt("replacement"),
		HistoryReplacement: true,
	})
	if !errors.Is(err, ErrSessionActiveTurn) {
		t.Fatalf("replacement error = %v, want ErrSessionActiveTurn", err)
	}
	if result.ProviderDispatch == nil ||
		result.ProviderDispatch.Disposition != DispatchDispositionNotDispatched {
		t.Fatalf("replacement dispatch = %#v, want not_dispatched", result.ProviderDispatch)
	}
	requests := appServerRequestParamsList(t, connection, appServerMethodTurnStart)
	if len(requests) != 1 {
		t.Fatalf("turn/start requests = %d, want only the ordinary active turn", len(requests))
	}
	server.completePendingTurn()
}

func startedEditRetryController(
	t *testing.T,
	configure func(*CodexAppServerAdapter, *scriptedAppServerTransport),
) (*Controller, *CodexAppServerAdapter, string) {
	return startedEditRetryControllerWithReporter(t, &recordingReporter{}, configure)
}

func startedEditRetryControllerWithReporter(
	t *testing.T,
	reporter DurableActivityReporter,
	configure func(*CodexAppServerAdapter, *scriptedAppServerTransport),
) (*Controller, *CodexAppServerAdapter, string) {
	t.Helper()
	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	if configure != nil {
		configure(adapter, transport)
	}
	controller := NewController([]Adapter{adapter}, reporter)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID: "room-edit-retry", AgentSessionID: "session-edit-retry",
		Provider: ProviderCodex, CWD: "/workspace",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = controller.Close(context.Background(), CloseInput{
			RoomID: "room-edit-retry", AgentSessionID: started.Session.AgentSessionID,
		})
	})
	return controller, adapter, started.Session.AgentSessionID
}
