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
	transport.conn.historyTurns = []any{
		map[string]any{
			"id": "provider-turn-1", "status": "completed",
			"items": []any{map[string]any{
				"type": "userMessage", "clientId": "canonical-turn-1",
			}},
		},
		map[string]any{"id": "provider-turn-2", "status": "failed", "items": []any{}},
	}
	transport.conn.rollbackHistoryTurns = []any{
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

func TestCodexEffectiveHistoryRollbackReportsExplicitRejection(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	transport.conn.rollbackUnsupported = true

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
	if got := asString(turnStart["clientUserMessageId"]); got != "replacement-turn-1" {
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
				ClientUserMessageID:       "replacement-turn-history",
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

func TestControllerHistoryReplacementAckTimeoutIsOutcomeUnknown(t *testing.T) {
	controller, adapter, sessionID := startedEditRetryController(t, func(
		adapter *CodexAppServerAdapter,
		transport *scriptedAppServerTransport,
	) {
		transport.conn.hangTurnStart = true
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
		transport.conn.turnStartError = true
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
		transport.conn.hangTurnStart = true
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
	if _, found := turnStart["clientUserMessageId"]; found {
		t.Fatalf("ordinary clientUserMessageId = %#v, want omitted", turnStart["clientUserMessageId"])
	}
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
	controller, _, sessionID := startedEditRetryController(t, func(
		_ *CodexAppServerAdapter,
		transport *scriptedAppServerTransport,
	) {
		connection = transport.conn
		transport.conn.holdTurn = true
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
	connection.completePendingTurn()
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
