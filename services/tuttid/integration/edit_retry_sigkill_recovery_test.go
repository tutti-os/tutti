//go:build tuttid_integration_test

package integration_test

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

// TestTuttidBlackBoxEditRetrySIGKILLAfterSidecarEffect is a real daemon
// process boundary: the sidecar fsyncs its mutation ledger and holds the
// provider connection open. The parent then SIGKILLs the child before it can
// persist a provider result. Two cold restarts must reconcile the same fenced
// operation without sending another mutation, while the separate healthy
// session continues through the ordinary worker.
func TestTuttidBlackBoxEditRetrySIGKILLAfterSidecarEffect(t *testing.T) {
	stateDir := t.TempDir()
	dbPath := filepath.Join(stateDir, "tuttid.db")
	seedEditRetryDaemonEnabledFixture(t, dbPath)
	sidecar := newEditRetrySIGKILLSidecar(t)
	childEnv := []string{
		"TUTTID_INTEGRATION_TEST_CHILD=1",
		"TUTTID_TEST_ENABLE_EDIT_RETRY_SAGA=1",
		"TUTTID_TEST_EDIT_RETRY_SIDECAR_ADDR=" + sidecar.Addr(),
	}

	first := startEditRetryDaemonAtWithEnv(t, stateDir, childEnv)
	sidecar.waitForIdentity(t, "rollback:ws-enabled-saga:session-a-retry", 1)
	// The operation checkpoint committed before the sidecar call; the held
	// connection means there is no result transaction to observe before kill.
	assertDaemonEditRetryDispatchedFence(t, dbPath)
	waitForEditRetryDaemonOperationStatus(t, dbPath, "ws-enabled-saga", "operation-b-healthy", storesqlite.RuntimeOperationStatusCompleted)
	if err := first.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("SIGKILL first daemon: %v", err)
	}
	if err := waitForEditRetryDaemonExit(t, first); err == nil {
		t.Fatal("first daemon exit error=nil after SIGKILL")
	}

	for restart := 1; restart <= 2; restart++ {
		daemon := startEditRetryDaemonAtWithEnv(t, stateDir, childEnv)
		// startEditRetryDaemonAtWithEnv observes real listener publication and health.
		mustRequestJSON[tuttigenerated.ListWorkspacesResponse](t, daemon, "GET", "/v1/workspaces", nil, 200)
		waitForDaemonEditRetryReconciledUnknown(t, dbPath)
		assertEditRetryDaemonUnknownIsReconcileOnly(t, dbPath)
		waitForEditRetryDaemonOperationStatus(t, dbPath, "ws-enabled-saga", "operation-b-healthy", storesqlite.RuntimeOperationStatusCompleted)
		sidecar.assertOnlyIdentity(t, "rollback:ws-enabled-saga:session-a-retry", 1)
		if daemon.cmd.ProcessState != nil && daemon.cmd.ProcessState.Exited() {
			t.Fatalf("restart %d exited\nstdout:\n%s\nstderr:\n%s", restart, daemon.stdout.String(), daemon.stderr.String())
		}
		if err := daemon.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			t.Fatalf("SIGKILL restart %d daemon: %v", restart, err)
		}
		if err := waitForEditRetryDaemonExit(t, daemon); err == nil {
			t.Fatalf("restart %d daemon exit error=nil after SIGKILL", restart)
		}
	}
}

func assertDaemonEditRetryDispatchedFence(t *testing.T, dbPath string) {
	t.Helper()
	store, err := openDaemonEditRetryStore(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	op, found, err := store.AgentCanonicalStore().GetRuntimeOperation(t.Context(), "ws-enabled-saga", "operation-a-retry")
	if err != nil || !found {
		t.Fatalf("operation found=%v error=%v", found, err)
	}
	payload, err := storesqlite.DecodeEditRetryOperationPayload(op.Payload)
	if err != nil || payload.Checkpoint != storesqlite.EditRetryCheckpointRollbackDispatched || op.Status != storesqlite.RuntimeOperationStatusLeased {
		t.Fatalf("post-effect pre-kill operation=%#v payload=%#v error=%v", op, payload, err)
	}
	history, found, err := store.AgentCanonicalStore().GetSessionHistory(t.Context(), "ws-enabled-saga", "session-a-retry")
	if err != nil || !found || history.OperationID != op.OperationID || history.RecoveryState != storesqlite.SessionHistoryRecoveryRollbackPending {
		t.Fatalf("post-effect pre-kill history=%#v found=%v error=%v", history, found, err)
	}
}

func waitForDaemonEditRetryReconciledUnknown(t *testing.T, dbPath string) {
	t.Helper()
	deadline := time.NewTimer(daemonStartTimeout)
	defer deadline.Stop()
	poll := time.NewTicker(healthPollInterval)
	defer poll.Stop()
	for {
		store, err := openDaemonEditRetryStore(dbPath)
		if err == nil {
			op, found, getErr := store.AgentCanonicalStore().GetRuntimeOperation(t.Context(), "ws-enabled-saga", "operation-a-retry")
			_ = store.Close()
			if getErr == nil && found {
				payload, decodeErr := storesqlite.DecodeEditRetryOperationPayload(op.Payload)
				if decodeErr == nil && payload.Checkpoint == storesqlite.EditRetryCheckpointRollbackDispatched && op.Status == storesqlite.RuntimeOperationStatusPrepared && op.NextAttemptAtMS > time.Now().UnixMilli() {
					return
				}
			}
		}
		select {
		case <-deadline.C:
			t.Fatalf("timed out waiting for unknown rollback reconciliation: %s", readEditRetryOptionalFile(filepath.Join(filepath.Dir(dbPath), "logs", "tuttid.log")))
		case <-poll.C:
		}
	}
}

func openDaemonEditRetryStore(path string) (*workspacedata.SQLiteStore, error) {
	return workspacedata.OpenSQLiteStore(path)
}

type editRetrySIGKILLSidecar struct {
	t        *testing.T
	listener net.Listener
	ledger   string
	recorded chan struct{}
	closed   chan struct{}
	once     sync.Once
	wg       sync.WaitGroup
}

func newEditRetrySIGKILLSidecar(t *testing.T) *editRetrySIGKILLSidecar {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	sidecar := &editRetrySIGKILLSidecar{
		t: t, listener: listener, ledger: filepath.Join(t.TempDir(), "sidecar-mutations.log"),
		recorded: make(chan struct{}, 1), closed: make(chan struct{}),
	}
	sidecar.wg.Add(1)
	go sidecar.serve()
	t.Cleanup(sidecar.close)
	return sidecar
}

func (s *editRetrySIGKILLSidecar) Addr() string { return s.listener.Addr().String() }

func (s *editRetrySIGKILLSidecar) serve() {
	defer s.wg.Done()
	for {
		connection, err := s.listener.Accept()
		if err != nil {
			select {
			case <-s.closed:
				return
			default:
				s.t.Errorf("edit-retry sidecar accept: %v", err)
				return
			}
		}
		s.wg.Add(1)
		go s.handle(connection)
	}
}

func (s *editRetrySIGKILLSidecar) handle(connection net.Conn) {
	defer s.wg.Done()
	defer connection.Close()
	line, err := bufio.NewReader(connection).ReadString('\n')
	if err != nil {
		return
	}
	parts := strings.Fields(line)
	if len(parts) != 2 || parts[0] != "ROLLBACK" {
		s.t.Errorf("edit-retry sidecar protocol=%q", line)
		return
	}
	file, err := os.OpenFile(s.ledger, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		s.t.Errorf("open sidecar ledger: %v", err)
		return
	}
	if _, err := fmt.Fprintln(file, parts[1]); err != nil {
		_ = file.Close()
		s.t.Errorf("write sidecar ledger: %v", err)
		return
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		s.t.Errorf("sync sidecar ledger: %v", err)
		return
	}
	_ = file.Close()
	select {
	case s.recorded <- struct{}{}:
	default:
	}
	// Keep the socket open without a response. SIGKILL closes the child end;
	// therefore no Host result checkpoint can run after this durable effect.
	_, _ = io.Copy(io.Discard, connection)
}

func (s *editRetrySIGKILLSidecar) waitForIdentity(t *testing.T, identity string, want int) {
	t.Helper()
	timer := time.NewTimer(daemonStartTimeout)
	defer timer.Stop()
	for {
		if s.count(identity) == want {
			return
		}
		select {
		case <-timer.C:
			t.Fatalf("sidecar ledger=%q, want %q count %d", readEditRetryOptionalFile(s.ledger), identity, want)
		case <-s.recorded:
		}
	}
}

func (s *editRetrySIGKILLSidecar) assertOnlyIdentity(t *testing.T, identity string, want int) {
	t.Helper()
	identities := s.identities()
	if got := s.count(identity); got != want || len(identities) != want {
		t.Fatalf("sidecar identity %q count=%d total=%d, want %d ledger=%q", identity, got, len(identities), want, readEditRetryOptionalFile(s.ledger))
	}
	for _, recorded := range identities {
		if recorded != identity {
			t.Fatalf("sidecar recorded unexpected identity %q, want only %q ledger=%q", recorded, identity, readEditRetryOptionalFile(s.ledger))
		}
	}
}

func (s *editRetrySIGKILLSidecar) count(identity string) int {
	count := 0
	for _, recorded := range s.identities() {
		if recorded == identity {
			count++
		}
	}
	return count
}

func (s *editRetrySIGKILLSidecar) identities() []string {
	contents, err := os.ReadFile(s.ledger)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		s.t.Errorf("read sidecar ledger: %v", err)
		return nil
	}
	var identities []string
	for _, line := range strings.Split(strings.TrimSpace(string(contents)), "\n") {
		if strings.TrimSpace(line) != "" {
			identities = append(identities, line)
		}
	}
	return identities
}

func (s *editRetrySIGKILLSidecar) close() {
	s.once.Do(func() {
		close(s.closed)
		_ = s.listener.Close()
		done := make(chan struct{})
		go func() { s.wg.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(requestTimeout):
			s.t.Errorf("timed out closing edit-retry SIGKILL sidecar")
		}
	})
}
