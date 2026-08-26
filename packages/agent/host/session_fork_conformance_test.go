package agenthost_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	hostconformance "github.com/tutti-os/tutti/packages/agent/host/conformance"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
)

func TestSessionForkConformance(t *testing.T) {
	for _, scenario := range hostconformance.SessionForkScenarios() {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			driver := &sqliteSessionForkConformanceDriver{t: t}
			if err := hostconformance.RunSessionFork(t.Context(), driver, scenario); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestPreparedSessionForkRecoveryKeepsSnapshotAndDoesNotFenceSourceWrites(t *testing.T) {
	driver := &sqliteSessionForkConformanceDriver{t: t}
	if err := driver.ResetSessionFork(t.Context(), hostconformance.SessionForkFixture{}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := driver.store.PrepareSessionFork(
		t.Context(),
		storesqlite.SessionForkPrepare{
			OperationID:          "operation-abandoned",
			WorkspaceID:          "workspace-fork",
			RequestID:            "request-abandoned",
			RequestHash:          "hash-abandoned",
			SourceAgentSessionID: "session-source",
			TargetAgentSessionID: "session-abandoned-target",
			SourceTurnID:         "turn-boundary",
			PointKind:            storesqlite.SessionForkPointThroughTurn,
			DriverKind:           "codex-app-server",
			DriverVersion:        "1",
			OccurredAtUnixMS:     40,
		},
	); err != nil {
		t.Fatal(err)
	}
	if err := driver.host.RecoverSessionForks(t.Context()); err != nil {
		t.Fatal(err)
	}
	operation, found, err := driver.store.GetSessionForkOperation(
		t.Context(), "workspace-fork", "operation-abandoned",
	)
	if err != nil || !found ||
		operation.Status != storesqlite.SessionForkStatusCommitted {
		t.Fatalf("recovered operation=%#v found=%v error=%v", operation, found, err)
	}
	if _, err := driver.store.ReportSessionState(
		t.Context(),
		storesqlite.SessionStateReport{
			WorkspaceID:       "workspace-fork",
			AgentSessionID:    "session-source",
			Kind:              storesqlite.SessionKindRoot,
			Provider:          "codex",
			ProviderSessionID: "provider-source",
			OccurredAtUnixMS:  50,
		},
	); err != nil {
		t.Fatalf("source write was fenced by prepared fork: %v", err)
	}
}

func TestHostColdRecoveryQuarantinesPermanentlyInconsistentAcceptedFork(t *testing.T) {
	driver := &sqliteSessionForkConformanceDriver{t: t}
	if err := driver.ResetSessionFork(t.Context(), hostconformance.SessionForkFixture{
		RecoverProviderAccepted:        true,
		RecoverPermanentlyInconsistent: true,
	}); err != nil {
		t.Fatal(err)
	}

	before, err := driver.store.ListSessionTurns(
		t.Context(), "workspace-fork", "session-source",
	)
	if err != nil || len(before) != 29 {
		t.Fatalf("source turns before recovery=%d error=%v, want 29", len(before), err)
	}
	if err := driver.host.Recover(t.Context()); err != nil {
		t.Fatalf("Host.Recover(): %v", err)
	}

	operation, found, err := driver.store.GetSessionForkOperation(
		t.Context(), "workspace-fork", "operation-fork",
	)
	if err != nil || !found || operation.Status != storesqlite.SessionForkStatusFailed {
		t.Fatalf("quarantined operation=%#v found=%v error=%v", operation, found, err)
	}
	if operation.TargetProviderSessionID != "provider-target" ||
		len(operation.TargetProviderTurnBindings) != 3 ||
		operation.StateBindingMode != string(agenthost.SessionForkStateBindingProviderOwned) ||
		operation.StateBindingReceipt != "conformance-provider-owned-receipt" {
		t.Fatalf("provider acceptance evidence was not retained: %#v", operation)
	}
	if !strings.Contains(operation.LastError, "returned 3 bindings for 29 provider-bound canonical turns") {
		t.Fatalf("quarantine diagnostic=%q", operation.LastError)
	}
	after, err := driver.store.ListSessionTurns(
		t.Context(), "workspace-fork", "session-source",
	)
	if err != nil || len(after) != 29 {
		t.Fatalf("source turns after recovery=%d error=%v, want 29", len(after), err)
	}
	if _, found, err := driver.store.GetSession(
		t.Context(), "workspace-fork", "session-target",
	); err != nil || found {
		t.Fatalf("incomplete target found=%v error=%v", found, err)
	}
	for _, table := range []string{
		"workspace_agent_session_fork_target_reservations",
		"workspace_agent_session_fork_boundary_barriers",
	} {
		var count int
		if err := driver.db.QueryRowContext(
			t.Context(),
			"SELECT COUNT(*) FROM "+table+" WHERE operation_id = ?",
			"operation-fork",
		).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s count=%d error=%v, want 0", table, count, err)
		}
	}

	nextAt := operation.CompletedAtUnixMS + 1
	next, created, err := driver.store.PrepareSessionFork(
		t.Context(),
		storesqlite.SessionForkPrepare{
			OperationID:          "operation-next",
			WorkspaceID:          "workspace-fork",
			RequestID:            "request-next",
			RequestHash:          "recovery-next",
			SourceAgentSessionID: "session-source",
			TargetAgentSessionID: "session-next-target",
			SourceTurnID:         "turn-boundary",
			PointKind:            storesqlite.SessionForkPointThroughTurn,
			DriverKind:           "codex-app-server",
			DriverVersion:        "1",
			OccurredAtUnixMS:     nextAt,
		},
	)
	if err != nil || !created {
		t.Fatalf("prepare following fork created=%v error=%v", created, err)
	}
	if _, _, err := driver.store.MarkSessionForkDispatching(
		t.Context(), next.WorkspaceID, next.OperationID, nextAt+1,
	); err != nil {
		t.Fatal(err)
	}
	bindings := make([]storesqlite.SessionForkProviderTurnBinding, 29)
	for index := range bindings {
		bindings[index] = storesqlite.SessionForkProviderTurnBinding{
			ProviderTurnID:          fmt.Sprintf("next-provider-turn-%02d", index+1),
			ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
		}
	}
	if _, _, err := driver.store.RecordSessionForkProviderResult(
		t.Context(),
		storesqlite.SessionForkProviderResult{
			WorkspaceID:                next.WorkspaceID,
			OperationID:                next.OperationID,
			Status:                     storesqlite.SessionForkStatusProviderAccepted,
			TargetProviderSessionID:    "provider-next-target",
			TargetProviderTurnBindings: bindings,
			StateBindingMode:           string(agenthost.SessionForkStateBindingProviderOwned),
			StateBindingReceipt:        "next-provider-owned-receipt",
			OccurredAtUnixMS:           nextAt + 2,
		},
	); err != nil {
		t.Fatal(err)
	}
	if err := driver.host.Recover(t.Context()); err != nil {
		t.Fatalf("Host.Recover() following operation: %v", err)
	}
	next, found, err = driver.store.GetSessionForkOperation(
		t.Context(), "workspace-fork", "operation-next",
	)
	if err != nil || !found || next.Status != storesqlite.SessionForkStatusCommitted {
		t.Fatalf("following operation=%#v found=%v error=%v", next, found, err)
	}
	if driver.runtime.forkCalls != 0 {
		t.Fatalf("provider ForkSession calls=%d, want 0", driver.runtime.forkCalls)
	}
}

func TestHostColdRecoveryFailsWhenAcceptedForkQuarantineCannotPersist(t *testing.T) {
	driver := &sqliteSessionForkConformanceDriver{t: t}
	if err := driver.ResetSessionFork(t.Context(), hostconformance.SessionForkFixture{
		RecoverProviderAccepted:        true,
		RecoverPermanentlyInconsistent: true,
	}); err != nil {
		t.Fatal(err)
	}
	persistErr := errors.New("injected accepted fork quarantine persistence failure")
	failingStore := &failAcceptedSessionForkStore{
		Store: driver.store,
		err:   persistErr,
	}
	driver.host = agenthost.New(agenthost.Config{
		SessionForks:        failingStore,
		SessionForkRecovery: failingStore,
		SessionForkRuntime:  driver.runtime,
	})
	if err := driver.host.Recover(t.Context()); !errors.Is(err, persistErr) {
		t.Fatalf("Host.Recover() error=%v, want persistence failure", err)
	}
	operation, found, err := driver.store.GetSessionForkOperation(
		t.Context(), "workspace-fork", "operation-fork",
	)
	if err != nil || !found || operation.Status != storesqlite.SessionForkStatusProviderAccepted {
		t.Fatalf("operation after failed quarantine=%#v found=%v error=%v", operation, found, err)
	}
}

type sqliteSessionForkConformanceDriver struct {
	t       *testing.T
	db      *sql.DB
	host    *agenthost.Host
	store   *storesqlite.Store
	runtime *sessionForkConformanceRuntime
}

func (d *sqliteSessionForkConformanceDriver) ResetSessionFork(
	ctx context.Context,
	fixture hostconformance.SessionForkFixture,
) error {
	db, err := sql.Open(
		"sqlite",
		filepath.Join(d.t.TempDir(), "session-fork-conformance.db"),
	)
	if err != nil {
		return err
	}
	d.t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	d.db = db
	d.store = storesqlite.New(db, storesqlite.Options{})
	if err := d.store.Migrate(ctx); err != nil {
		return err
	}
	if _, err := d.store.ReportSessionState(ctx, storesqlite.SessionStateReport{
		WorkspaceID:       "workspace-fork",
		AgentSessionID:    "session-source",
		Kind:              storesqlite.SessionKindRoot,
		Origin:            "user",
		Provider:          "codex",
		ProviderSessionID: "provider-source",
		Cwd:               "/workspace",
		OccurredAtUnixMS:  10,
	}); err != nil {
		return err
	}
	turnCount := 1
	if fixture.RecoverPermanentlyInconsistent {
		turnCount = 29
	}
	lastSeededAt := int64(0)
	for index := 0; index < turnCount; index++ {
		turnID := fmt.Sprintf("turn-history-%02d", index+1)
		providerTurnID := fmt.Sprintf("provider-turn-history-%02d", index+1)
		messageID := fmt.Sprintf("message-history-%02d", index+1)
		if index == turnCount-1 {
			turnID = "turn-boundary"
			providerTurnID = "provider-turn"
			messageID = "message-boundary"
		}
		runningAt := int64(20 + index*3)
		if result, err := d.store.ReportActivityState(ctx, storesqlite.ActivityStateReport{
			Session: storesqlite.SessionStateReport{
				WorkspaceID:       "workspace-fork",
				AgentSessionID:    "session-source",
				Kind:              storesqlite.SessionKindRoot,
				Origin:            "user",
				Provider:          "codex",
				ProviderSessionID: "provider-source",
				Cwd:               "/workspace",
				OccurredAtUnixMS:  runningAt,
			},
			Turn: &storesqlite.TurnTransition{
				WorkspaceID:      "workspace-fork",
				AgentSessionID:   "session-source",
				TurnID:           turnID,
				Phase:            storesqlite.TurnPhaseRunning,
				OccurredAtUnixMS: runningAt,
			},
			RootProviderTurn: &storesqlite.RootProviderTurnTransition{
				WorkspaceID:             "workspace-fork",
				RootAgentSessionID:      "session-source",
				RootTurnID:              turnID,
				ProviderTurnID:          providerTurnID,
				ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
				Phase:                   storesqlite.RootProviderTurnPhaseRunning,
				OccurredAtUnixMS:        runningAt,
			},
		}); err != nil || !result.TurnAccepted || !result.RootTurnAccepted {
			return errors.Join(err, fmt.Errorf("seed running fork turn %d was rejected", index+1))
		}
		if _, err := d.store.ReportSessionMessages(ctx, storesqlite.SessionMessageReport{
			WorkspaceID:    "workspace-fork",
			AgentSessionID: "session-source",
			Origin:         "runtime",
			Messages: []storesqlite.MessageUpdate{{
				MessageID:        messageID,
				TurnID:           turnID,
				Role:             "assistant",
				Kind:             "text",
				Status:           "completed",
				Payload:          map[string]any{"text": "complete"},
				OccurredAtUnixMS: runningAt + 1,
			}},
		}); err != nil {
			return err
		}
		lastSeededAt = runningAt + 2
		if result, err := d.store.ReportActivityState(ctx, storesqlite.ActivityStateReport{
			Session: storesqlite.SessionStateReport{
				WorkspaceID:       "workspace-fork",
				AgentSessionID:    "session-source",
				Kind:              storesqlite.SessionKindRoot,
				Origin:            "user",
				Provider:          "codex",
				ProviderSessionID: "provider-source",
				Cwd:               "/workspace",
				OccurredAtUnixMS:  lastSeededAt,
			},
			RootProviderTurn: &storesqlite.RootProviderTurnTransition{
				WorkspaceID:             "workspace-fork",
				RootAgentSessionID:      "session-source",
				RootTurnID:              turnID,
				ProviderTurnID:          providerTurnID,
				ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
				Phase:                   storesqlite.RootProviderTurnPhaseCompleted,
				Outcome:                 storesqlite.TurnOutcomeCompleted,
				OccurredAtUnixMS:        lastSeededAt,
			},
		}); err != nil || !result.RootTurnAccepted {
			return errors.Join(err, fmt.Errorf("seed settled fork turn %d was rejected", index+1))
		}
	}
	if fixture.KeepSourceActive {
		if result, err := d.store.ReportActivityState(ctx, storesqlite.ActivityStateReport{
			Session: storesqlite.SessionStateReport{
				WorkspaceID:       "workspace-fork",
				AgentSessionID:    "session-source",
				Kind:              storesqlite.SessionKindRoot,
				Origin:            "user",
				Provider:          "codex",
				ProviderSessionID: "provider-source",
				Cwd:               "/workspace",
				OccurredAtUnixMS:  lastSeededAt + 1,
			},
			Turn: &storesqlite.TurnTransition{
				WorkspaceID:      "workspace-fork",
				AgentSessionID:   "session-source",
				TurnID:           "turn-active",
				Phase:            storesqlite.TurnPhaseRunning,
				OccurredAtUnixMS: lastSeededAt + 1,
			},
			RootProviderTurn: &storesqlite.RootProviderTurnTransition{
				WorkspaceID:             "workspace-fork",
				RootAgentSessionID:      "session-source",
				RootTurnID:              "turn-active",
				ProviderTurnID:          "provider-turn-active",
				ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
				Phase:                   storesqlite.RootProviderTurnPhaseRunning,
				OccurredAtUnixMS:        lastSeededAt + 1,
			},
		}); err != nil || !result.TurnAccepted || !result.RootTurnAccepted {
			return errors.Join(err, errors.New("seed active source turn was rejected"))
		}
	}

	forkStore := &failOnceSessionForkStore{
		Store:          d.store,
		failNextCommit: fixture.FailFirstLocalCommit,
	}
	d.runtime = &sessionForkConformanceRuntime{}
	d.host = agenthost.New(agenthost.Config{
		SessionForks:        forkStore,
		SessionForkRecovery: forkStore,
		SessionForkRuntime:  d.runtime,
	})
	if fixture.KeepSourceActive {
		if _, supported, err := forkStore.CheckSessionForkThroughTurn(
			ctx, "workspace-fork", "session-source", "turn-boundary",
		); err != nil || !supported {
			session, sessionFound, sessionErr := forkStore.GetSession(
				ctx, "workspace-fork", "session-source",
			)
			turn, turnFound, turnErr := forkStore.GetTurn(
				ctx, "workspace-fork", "session-source", "turn-boundary",
			)
			return errors.Join(err, fmt.Errorf(
				"settled fork boundary became ineligible while source was active: sessionFound=%v session=%#v sessionErr=%v turnFound=%v turn=%#v turnErr=%v",
				sessionFound, session, sessionErr, turnFound, turn, turnErr,
			))
		}
	}
	if !fixture.RecoverProviderAccepted {
		return nil
	}
	operationAt := lastSeededAt + 10
	operation, _, err := d.store.PrepareSessionFork(ctx, storesqlite.SessionForkPrepare{
		OperationID:          "operation-fork",
		WorkspaceID:          "workspace-fork",
		RequestID:            "request-fork",
		RequestHash:          "recovery-fixture",
		SourceAgentSessionID: "session-source",
		TargetAgentSessionID: "session-target",
		SourceTurnID:         "turn-boundary",
		PointKind:            storesqlite.SessionForkPointThroughTurn,
		DriverKind:           "codex-app-server",
		DriverVersion:        "1",
		OccurredAtUnixMS:     operationAt,
	})
	if err != nil {
		return err
	}
	if _, _, err := d.store.MarkSessionForkDispatching(
		ctx, operation.WorkspaceID, operation.OperationID, operationAt+1,
	); err != nil {
		return err
	}
	targetBindings := []storesqlite.SessionForkProviderTurnBinding{{
		ProviderTurnID:          "forked-provider-turn",
		ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
	}}
	if fixture.RecoverPermanentlyInconsistent {
		targetBindings = append(targetBindings,
			storesqlite.SessionForkProviderTurnBinding{
				ProviderTurnID:          "forked-provider-turn-2",
				ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
			},
			storesqlite.SessionForkProviderTurnBinding{
				ProviderTurnID:          "forked-provider-turn-3",
				ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
			},
		)
	}
	_, _, err = d.store.RecordSessionForkProviderResult(
		ctx,
		storesqlite.SessionForkProviderResult{
			WorkspaceID:                operation.WorkspaceID,
			OperationID:                operation.OperationID,
			Status:                     storesqlite.SessionForkStatusProviderAccepted,
			TargetProviderSessionID:    "provider-target",
			TargetProviderTurnBindings: targetBindings,
			StateBindingMode:           string(agenthost.SessionForkStateBindingProviderOwned),
			StateBindingReceipt:        "conformance-provider-owned-receipt",
			OccurredAtUnixMS:           operationAt + 2,
		},
	)
	return err
}

func (d *sqliteSessionForkConformanceDriver) ForkSession(
	ctx context.Context,
	input agenthost.ForkSessionInput,
) (agenthost.ForkSessionResult, error) {
	return d.host.ForkSession(ctx, input)
}

func (d *sqliteSessionForkConformanceDriver) GetSessionForkOperation(
	ctx context.Context,
	workspaceID, operationID string,
) (agenthost.ForkSessionResult, bool, error) {
	return d.host.GetSessionForkOperation(ctx, workspaceID, operationID)
}

func (d *sqliteSessionForkConformanceDriver) RecoverSessionForks(
	ctx context.Context,
) error {
	return d.host.RecoverSessionForks(ctx)
}

func (d *sqliteSessionForkConformanceDriver) SessionForkMetrics() hostconformance.SessionForkMetrics {
	return hostconformance.SessionForkMetrics{
		ProviderForkCalls: d.runtime.forkCalls,
	}
}

type failOnceSessionForkStore struct {
	*storesqlite.Store
	failNextCommit bool
}

type failAcceptedSessionForkStore struct {
	*storesqlite.Store
	err error
}

func (s *failAcceptedSessionForkStore) FailAcceptedSessionFork(
	context.Context,
	string, string, string,
	int64,
) (storesqlite.SessionForkOperation, bool, error) {
	return storesqlite.SessionForkOperation{}, false, s.err
}

func (s *failOnceSessionForkStore) CommitSessionFork(
	ctx context.Context,
	workspaceID, operationID string,
	occurredAtUnixMS int64,
) (storesqlite.SessionForkCommitResult, error) {
	if s.failNextCommit {
		s.failNextCommit = false
		return storesqlite.SessionForkCommitResult{}, errors.New("injected local commit failure")
	}
	return s.Store.CommitSessionFork(ctx, workspaceID, operationID, occurredAtUnixMS)
}

type sessionForkConformanceRuntime struct {
	forkCalls int
}

func (*sessionForkConformanceRuntime) ResolveSessionFork(
	context.Context,
	agenthost.ProviderRuntimeSession,
) (agenthost.SessionForkDriverDescriptor, error) {
	return agenthost.SessionForkDriverDescriptor{
		Kind: "codex-app-server", Version: "1", ThroughTurn: true,
		StateBindingMode: agenthost.SessionForkStateBindingProviderOwned,
	}, nil
}

func (*sessionForkConformanceRuntime) CanForkProviderTurn(
	_ context.Context,
	input agenthost.RuntimeProviderTurnForkabilityInput,
) (bool, error) {
	return input.ProviderTurnID != "" &&
		len(input.ProviderTurnBindingJSON) > 0, nil
}

func (r *sessionForkConformanceRuntime) ForkSession(
	_ context.Context,
	input agenthost.RuntimeSessionForkInput,
) (agenthost.RuntimeSessionForkResult, error) {
	r.forkCalls++
	return agenthost.RuntimeSessionForkResult{
		ProviderSessionID: "provider-target",
		TargetProviderTurnBindings: []agenthost.SessionForkProviderTurnBinding{{
			ProviderTurnID:          "forked-" + input.SourceProviderTurnID,
			ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
		}},
		StateBindingMode:    agenthost.SessionForkStateBindingProviderOwned,
		StateBindingReceipt: "conformance-provider-owned-receipt",
		DeliveryDisposition: agenthost.SessionForkDeliveryAccepted,
	}, nil
}
