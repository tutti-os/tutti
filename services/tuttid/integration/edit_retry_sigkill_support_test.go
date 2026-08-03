//go:build tuttid_integration_test

package integration_test

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

var (
	buildEditRetryBinaryOnce sync.Once
	builtEditRetryBinaryPath string
	buildEditRetryBinaryErr  error
)

func startEditRetryDaemonAtWithEnv(t *testing.T, stateDir string, extraEnv []string) *testDaemon {
	t.Helper()
	accessToken := "test-access-token"
	cmd := exec.Command(mustBuildEditRetryDaemonBinary(t))
	cmd.Dir = serviceRoot(t)
	cmd.Env = append(os.Environ(),
		"TUTTI_ENV=development", "TUTTI_STATE_DIR="+stateDir,
		"TUTTID_ACCESS_TOKEN="+accessToken, "TUTTID_ADDR=127.0.0.1:0", "TUTTID_LOG_OUTPUT=tee",
	)
	cmd.Env = append(cmd.Env, extraEnv...)
	daemon := &testDaemon{accessToken: accessToken, cmd: cmd, logPath: filepath.Join(stateDir, "logs", "tuttid.log"), stateDir: stateDir}
	cmd.Stdout, cmd.Stderr = &daemon.stdout, &daemon.stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start edit-retry tuttid: %v", err)
	}
	t.Cleanup(func() { stopTestDaemon(t, daemon) })
	daemon.baseURL = "http://" + waitForListenerInfo(t, daemon)
	waitForHealth(t, daemon)
	return daemon
}

func mustBuildEditRetryDaemonBinary(t *testing.T) string {
	t.Helper()
	buildEditRetryBinaryOnce.Do(func() {
		directory, err := os.MkdirTemp("", "tuttid-edit-retry-blackbox-")
		if err != nil {
			buildEditRetryBinaryErr = fmt.Errorf("create daemon build directory: %w", err)
			return
		}
		name := "tuttid"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		builtEditRetryBinaryPath = filepath.Join(directory, name)
		cmd := exec.Command("go", "build", "-tags=tuttid_integration_test", "-o", builtEditRetryBinaryPath, ".")
		cmd.Dir = serviceRoot(t)
		output, err := cmd.CombinedOutput()
		if err != nil {
			buildEditRetryBinaryErr = fmt.Errorf("build tagged edit-retry daemon: %w\n%s", err, strings.TrimSpace(string(output)))
		}
	})
	if buildEditRetryBinaryErr != nil {
		t.Fatal(buildEditRetryBinaryErr)
	}
	return builtEditRetryBinaryPath
}

func waitForEditRetryDaemonExit(t *testing.T, daemon *testDaemon) error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- daemon.cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(daemonStartTimeout):
		_ = daemon.cmd.Process.Kill()
		<-done
		t.Fatal("timed out waiting for edit-retry daemon exit")
		return nil
	}
}

func waitForEditRetryDaemonOperationStatus(t *testing.T, path, workspaceID, operationID, want string) {
	t.Helper()
	deadline := time.Now().Add(daemonStartTimeout)
	for time.Now().Before(deadline) {
		store, err := workspacedata.OpenSQLiteStore(path)
		if err == nil {
			op, found, getErr := store.AgentCanonicalStore().GetRuntimeOperation(t.Context(), workspaceID, operationID)
			_ = store.Close()
			if getErr == nil && found && op.Status == want {
				return
			}
		}
		time.Sleep(healthPollInterval)
	}
	t.Fatalf("edit-retry operation %q did not reach %q", operationID, want)
}

func seedEditRetryDaemonEnabledFixture(t *testing.T, path string) {
	t.Helper()
	store, err := workspacedata.OpenSQLiteStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := store.Create(t.Context(), workspacebiz.Summary{ID: "ws-enabled-saga", Name: "Enabled saga fixture"}); err != nil {
		t.Fatal(err)
	}
	canonical := store.AgentCanonicalStore()
	seedEditRetryDaemonOperation(t, canonical, "ws-enabled-saga", "session-a-retry", "operation-a-retry", time.Now().UnixMilli())
	seedEditRetryHealthyCancel(t, canonical, "ws-enabled-saga", "session-b-healthy", "operation-b-healthy")
}

func seedEditRetryDaemonOperation(t *testing.T, canonical *storesqlite.Store, workspaceID, sessionID, operationID string, occurredAtMS int64) {
	t.Helper()
	turnID := "turn-" + sessionID
	if _, err := canonical.ReportSessionState(t.Context(), storesqlite.SessionStateReport{WorkspaceID: workspaceID, AgentSessionID: sessionID, Kind: storesqlite.SessionKindRoot, Provider: "codex", ProviderSessionID: "thread-" + sessionID, OccurredAtUnixMS: 1}); err != nil {
		t.Fatal(err)
	}
	for _, report := range []storesqlite.ActivityStateReport{
		{Session: storesqlite.SessionStateReport{WorkspaceID: workspaceID, AgentSessionID: sessionID, Kind: storesqlite.SessionKindRoot, Provider: "codex", ProviderSessionID: "thread-" + sessionID, OccurredAtUnixMS: 2}, Turn: &storesqlite.TurnTransition{WorkspaceID: workspaceID, AgentSessionID: sessionID, TurnID: turnID, Phase: storesqlite.TurnPhaseRunning, Origin: storesqlite.TurnOriginUserPrompt, StartedAtUnixMS: 2, OccurredAtUnixMS: 2}, RootProviderTurn: &storesqlite.RootProviderTurnTransition{WorkspaceID: workspaceID, RootAgentSessionID: sessionID, RootTurnID: turnID, ProviderTurnID: "provider-" + sessionID, Phase: storesqlite.RootProviderTurnPhaseRunning, OccurredAtUnixMS: 2}},
		{Session: storesqlite.SessionStateReport{WorkspaceID: workspaceID, AgentSessionID: sessionID, Kind: storesqlite.SessionKindRoot, Provider: "codex", ProviderSessionID: "thread-" + sessionID, OccurredAtUnixMS: 3}, Turn: &storesqlite.TurnTransition{WorkspaceID: workspaceID, AgentSessionID: sessionID, TurnID: turnID, Phase: storesqlite.TurnPhaseSettled, Outcome: storesqlite.TurnOutcomeCompleted, Origin: storesqlite.TurnOriginUserPrompt, SettledAtUnixMS: 3, OccurredAtUnixMS: 3}, RootProviderTurn: &storesqlite.RootProviderTurnTransition{WorkspaceID: workspaceID, RootAgentSessionID: sessionID, RootTurnID: turnID, ProviderTurnID: "provider-" + sessionID, Phase: storesqlite.RootProviderTurnPhaseCompleted, Outcome: storesqlite.TurnOutcomeCompleted, OccurredAtUnixMS: 3}},
	} {
		if _, err := canonical.ReportActivityState(t.Context(), report); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := canonical.RecordTurnSubmission(t.Context(), storesqlite.TurnSubmission{WorkspaceID: workspaceID, AgentSessionID: sessionID, TurnID: turnID, ContentJSON: `[{"type":"text","text":"original"}]`, DisplayPrompt: "original", CapabilityRefsJSON: `[]`, TuttiModeSnapshotJSON: `null`, ClientSubmitID: "submit-" + sessionID, CreatedAtUnixMS: 3, UpdatedAtUnixMS: 3}); err != nil {
		t.Fatal(err)
	}
	payload, err := storesqlite.EncodeEditRetryOperationPayload(storesqlite.EditRetryOperationPayload{ClientOperationID: "sigkill-" + operationID, EditedText: "edited", ReplacementTurnID: "replacement-" + sessionID, ClientSubmitID: "edit-retry:" + operationID, ExpectedRevision: 0, Checkpoint: storesqlite.EditRetryCheckpointPrepared})
	if err != nil {
		t.Fatal(err)
	}
	if _, changed, err := canonical.PrepareEditRetry(t.Context(), storesqlite.RuntimeOperationPrepare{WorkspaceID: workspaceID, AgentSessionID: sessionID, OperationID: operationID, Kind: storesqlite.RuntimeOperationKindEditRetry, TurnID: turnID, RequestID: "sigkill-" + operationID, Payload: payload, OccurredAtMS: occurredAtMS}); err != nil || !changed {
		t.Fatalf("prepare edit retry changed=%v error=%v", changed, err)
	}
}

func seedEditRetryHealthyCancel(t *testing.T, canonical *storesqlite.Store, workspaceID, sessionID, operationID string) {
	t.Helper()
	turnID := "turn-" + sessionID
	if _, err := canonical.ReportActivityState(t.Context(), storesqlite.ActivityStateReport{Session: storesqlite.SessionStateReport{WorkspaceID: workspaceID, AgentSessionID: sessionID, Kind: storesqlite.SessionKindRoot, Provider: "codex", ProviderSessionID: "thread-" + sessionID, OccurredAtUnixMS: 2}, Turn: &storesqlite.TurnTransition{WorkspaceID: workspaceID, AgentSessionID: sessionID, TurnID: turnID, Phase: storesqlite.TurnPhaseRunning, Origin: storesqlite.TurnOriginUserPrompt, StartedAtUnixMS: 2, OccurredAtUnixMS: 2}, RootProviderTurn: &storesqlite.RootProviderTurnTransition{WorkspaceID: workspaceID, RootAgentSessionID: sessionID, RootTurnID: turnID, ProviderTurnID: "provider-" + sessionID, Phase: storesqlite.RootProviderTurnPhaseRunning, OccurredAtUnixMS: 2}}); err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"reason": "fixture", "rootAgentSessionId": sessionID, "targets": []any{map[string]any{"agentSessionId": sessionID, "turnId": turnID}}}
	if _, changed, err := canonical.PrepareRuntimeOperation(t.Context(), storesqlite.RuntimeOperationPrepare{WorkspaceID: workspaceID, AgentSessionID: sessionID, OperationID: operationID, Kind: storesqlite.RuntimeOperationKindCancelTurn, TurnID: turnID, Payload: payload, OccurredAtMS: 3}); err != nil || !changed {
		t.Fatalf("prepare healthy cancel changed=%v error=%v", changed, err)
	}
}

func assertEditRetryDaemonUnknownIsReconcileOnly(t *testing.T, path string) {
	t.Helper()
	store, err := workspacedata.OpenSQLiteStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	op, found, err := store.AgentCanonicalStore().GetRuntimeOperation(t.Context(), "ws-enabled-saga", "operation-a-retry")
	if err != nil || !found {
		t.Fatalf("get retry operation found=%v error=%v", found, err)
	}
	payload, err := storesqlite.DecodeEditRetryOperationPayload(op.Payload)
	if err != nil || payload.Checkpoint != storesqlite.EditRetryCheckpointRollbackDispatched || op.Status != storesqlite.RuntimeOperationStatusPrepared {
		t.Fatalf("unknown retry operation=%#v payload=%#v error=%v", op, payload, err)
	}
	history, found, err := store.AgentCanonicalStore().GetSessionHistory(t.Context(), "ws-enabled-saga", "session-a-retry")
	if err != nil || !found || history.OperationID != "operation-a-retry" || history.RecoveryState != storesqlite.SessionHistoryRecoveryRollbackPending {
		t.Fatalf("unknown retry history=%#v found=%v error=%v", history, found, err)
	}
}

func readEditRetryOptionalFile(path string) string {
	contents, _ := os.ReadFile(path)
	return string(contents)
}
