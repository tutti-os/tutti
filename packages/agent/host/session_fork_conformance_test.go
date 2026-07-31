package agenthost_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
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

type sqliteSessionForkConformanceDriver struct {
	t       *testing.T
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
	if result, err := d.store.ReportActivityState(ctx, storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID:       "workspace-fork",
			AgentSessionID:    "session-source",
			Kind:              storesqlite.SessionKindRoot,
			Origin:            "user",
			Provider:          "codex",
			ProviderSessionID: "provider-source",
			Cwd:               "/workspace",
			OccurredAtUnixMS:  20,
		},
		Turn: &storesqlite.TurnTransition{
			WorkspaceID:      "workspace-fork",
			AgentSessionID:   "session-source",
			TurnID:           "turn-boundary",
			Phase:            storesqlite.TurnPhaseRunning,
			OccurredAtUnixMS: 20,
		},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{
			WorkspaceID:             "workspace-fork",
			RootAgentSessionID:      "session-source",
			RootTurnID:              "turn-boundary",
			ProviderTurnID:          "provider-turn",
			ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
			Phase:                   storesqlite.RootProviderTurnPhaseRunning,
			OccurredAtUnixMS:        20,
		},
	}); err != nil || !result.TurnAccepted || !result.RootTurnAccepted {
		return errors.Join(err, errors.New("seed running fork boundary was rejected"))
	}
	if _, err := d.store.ReportSessionMessages(ctx, storesqlite.SessionMessageReport{
		WorkspaceID:    "workspace-fork",
		AgentSessionID: "session-source",
		Origin:         "runtime",
		Messages: []storesqlite.MessageUpdate{{
			MessageID:        "message-boundary",
			TurnID:           "turn-boundary",
			Role:             "assistant",
			Kind:             "text",
			Status:           "completed",
			Payload:          map[string]any{"text": "complete"},
			OccurredAtUnixMS: 29,
		}},
	}); err != nil {
		return err
	}
	if result, err := d.store.ReportActivityState(ctx, storesqlite.ActivityStateReport{
		Session: storesqlite.SessionStateReport{
			WorkspaceID:       "workspace-fork",
			AgentSessionID:    "session-source",
			Kind:              storesqlite.SessionKindRoot,
			Origin:            "user",
			Provider:          "codex",
			ProviderSessionID: "provider-source",
			Cwd:               "/workspace",
			OccurredAtUnixMS:  30,
		},
		RootProviderTurn: &storesqlite.RootProviderTurnTransition{
			WorkspaceID:             "workspace-fork",
			RootAgentSessionID:      "session-source",
			RootTurnID:              "turn-boundary",
			ProviderTurnID:          "provider-turn",
			ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
			Phase:                   storesqlite.RootProviderTurnPhaseCompleted,
			Outcome:                 storesqlite.TurnOutcomeCompleted,
			OccurredAtUnixMS:        30,
		},
	}); err != nil || !result.RootTurnAccepted {
		return errors.Join(err, errors.New("seed settled fork boundary was rejected"))
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
				OccurredAtUnixMS:  31,
			},
			Turn: &storesqlite.TurnTransition{
				WorkspaceID:      "workspace-fork",
				AgentSessionID:   "session-source",
				TurnID:           "turn-active",
				Phase:            storesqlite.TurnPhaseRunning,
				OccurredAtUnixMS: 31,
			},
			RootProviderTurn: &storesqlite.RootProviderTurnTransition{
				WorkspaceID:             "workspace-fork",
				RootAgentSessionID:      "session-source",
				RootTurnID:              "turn-active",
				ProviderTurnID:          "provider-turn-active",
				ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
				Phase:                   storesqlite.RootProviderTurnPhaseRunning,
				OccurredAtUnixMS:        31,
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
		OccurredAtUnixMS:     40,
	})
	if err != nil {
		return err
	}
	if _, _, err := d.store.MarkSessionForkDispatching(
		ctx, operation.WorkspaceID, operation.OperationID, 41,
	); err != nil {
		return err
	}
	_, _, err = d.store.RecordSessionForkProviderResult(
		ctx,
		storesqlite.SessionForkProviderResult{
			WorkspaceID:             operation.WorkspaceID,
			OperationID:             operation.OperationID,
			Status:                  storesqlite.SessionForkStatusProviderAccepted,
			TargetProviderSessionID: "provider-target",
			TargetProviderTurnBindings: []storesqlite.SessionForkProviderTurnBinding{{
				ProviderTurnID:          "forked-provider-turn",
				ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
			}},
			StateBindingMode:    string(agenthost.SessionForkStateBindingProviderOwned),
			StateBindingReceipt: "conformance-provider-owned-receipt",
			OccurredAtUnixMS:    42,
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
