package agenthost_test

import (
	"context"
	"database/sql"
	"errors"
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

func TestPreparedSessionForkRecoveryReleasesSQLiteFences(t *testing.T) {
	driver := &sqliteSessionForkConformanceDriver{t: t}
	if err := driver.ResetSessionFork(t.Context(), hostconformance.SessionForkFixture{}); err != nil {
		t.Fatal(err)
	}
	sourceHash := sessionForkConformanceSourceHash(
		t, driver.store, "workspace-fork", "session-source",
	)
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
			DriverKind:           "codex-app-server",
			DriverVersion:        "1",
			ExpectedSourceHash:   sourceHash,
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
		operation.Status != storesqlite.SessionForkStatusFailed {
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
		t.Fatalf("source remained fenced after recovery: %v", err)
	}
	sourceHash = sessionForkConformanceSourceHash(
		t, driver.store, "workspace-fork", "session-source",
	)
	if _, _, err := driver.store.PrepareSessionFork(
		t.Context(),
		storesqlite.SessionForkPrepare{
			OperationID:          "operation-retry",
			WorkspaceID:          "workspace-fork",
			RequestID:            "request-retry",
			RequestHash:          "hash-retry",
			SourceAgentSessionID: "session-source",
			TargetAgentSessionID: "session-abandoned-target",
			SourceTurnID:         "turn-boundary",
			DriverKind:           "codex-app-server",
			DriverVersion:        "1",
			ExpectedSourceHash:   sourceHash,
			OccurredAtUnixMS:     60,
		},
	); err != nil {
		t.Fatalf("released target could not be reserved again: %v", err)
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
			WorkspaceID:        "workspace-fork",
			RootAgentSessionID: "session-source",
			RootTurnID:         "turn-boundary",
			ProviderTurnID:     "provider-turn",
			Phase:              storesqlite.RootProviderTurnPhaseRunning,
			OccurredAtUnixMS:   20,
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
			WorkspaceID:        "workspace-fork",
			RootAgentSessionID: "session-source",
			RootTurnID:         "turn-boundary",
			ProviderTurnID:     "provider-turn",
			Phase:              storesqlite.RootProviderTurnPhaseCompleted,
			Outcome:            storesqlite.TurnOutcomeCompleted,
			OccurredAtUnixMS:   30,
		},
	}); err != nil || !result.RootTurnAccepted {
		return errors.Join(err, errors.New("seed settled fork boundary was rejected"))
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
	if !fixture.RecoverProviderAccepted {
		return nil
	}
	source, found, err := d.store.GetSession(
		ctx, "workspace-fork", "session-source",
	)
	if err != nil || !found {
		return errors.Join(err, errors.New("seed source session was not found"))
	}
	sourceHash, err := storesqlite.SessionForkSourceHash(source)
	if err != nil {
		return err
	}
	operation, _, err := d.store.PrepareSessionFork(ctx, storesqlite.SessionForkPrepare{
		OperationID:          "operation-fork",
		WorkspaceID:          "workspace-fork",
		RequestID:            "request-fork",
		RequestHash:          "recovery-fixture",
		SourceAgentSessionID: "session-source",
		TargetAgentSessionID: "session-target",
		SourceTurnID:         "turn-boundary",
		DriverKind:           "codex-app-server",
		DriverVersion:        "1",
		ExpectedSourceHash:   sourceHash,
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
			OccurredAtUnixMS:        42,
		},
	)
	return err
}

func sessionForkConformanceSourceHash(
	t *testing.T,
	store *storesqlite.Store,
	workspaceID, sessionID string,
) string {
	t.Helper()
	source, found, err := store.GetSession(t.Context(), workspaceID, sessionID)
	if err != nil || !found {
		t.Fatalf("GetSession() found=%v error=%v", found, err)
	}
	hash, err := storesqlite.SessionForkSourceHash(source)
	if err != nil {
		t.Fatal(err)
	}
	return hash
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

func (r *sessionForkConformanceRuntime) ForkSession(
	_ context.Context,
	input agenthost.RuntimeSessionForkInput,
) (agenthost.RuntimeSessionForkResult, error) {
	r.forkCalls++
	targetTurnIDs := make([]string, 0, len(input.SourceProviderTurnIDs))
	for _, sourceID := range input.SourceProviderTurnIDs {
		targetTurnIDs = append(targetTurnIDs, "forked-"+sourceID)
	}
	return agenthost.RuntimeSessionForkResult{
		ProviderSessionID:     "provider-target",
		TargetProviderTurnIDs: targetTurnIDs,
		StateBindingMode:      agenthost.SessionForkStateBindingProviderOwned,
		StateBindingReceipt:   "conformance-provider-owned-receipt",
		DeliveryDisposition:   agenthost.SessionForkDeliveryAccepted,
	}, nil
}
