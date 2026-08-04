package agenthost_test

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// TestEditRetryLoopbackSocketResponseLossNeverReplaysMutation puts the
// provider-side effect outside Host memory. The sidecar appends a stable
// mutation identity before closing the connection without a response. Closing
// and reopening SQLite/Host must not cause another rollback or replacement
// request to reach that independently durable ledger.
func TestEditRetryLoopbackSocketResponseLossNeverReplaysMutation(t *testing.T) {
	t.Run("rollback response loss", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "rollback-response-loss.db")
		sidecar := newEditRetryLoopbackSidecar(t, []string{"provider-original"})
		// The provider accepted the request, but its authoritative history read is
		// deliberately unavailable to this client view. This models response loss
		// without incorrectly treating the sidecar's durable mutation ledger as a
		// successful result receipt.
		sidecar.setHideMutationsFromReads(true)
		base := &hostEditRetryRuntime{}
		host, store, db := openEditRetryRestartFixture(t, path, base, true)
		_ = host
		runtime := &loopbackEditRetryRuntime{hostEditRetryRuntime: base, sidecar: sidecar, mode: "rollback"}
		host = newLoopbackEditRetryHost(store, runtime)

		result, err := host.EditRetry(t.Context(), editRetryRestartRef, "turn-original", agenthost.EditRetryInput{
			EditedText: "edited", ClientOperationID: "socket-rollback", ExpectedHistoryRevision: 0,
		})
		if !errors.Is(err, agenthost.ErrEditRetryInProgress) || result.OperationID == "" {
			t.Fatalf("EditRetry() result=%#v error=%v", result, err)
		}
		sidecar.assertCount(t, "rollback:workspace-1:session-1", 1)
		assertSocketFaultFencedCheckpoint(t, store, result.OperationID, storesqlite.EditRetryCheckpointRollbackDispatched)

		for restart := 0; restart < 2; restart++ {
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			_, store, db = openEditRetryRestartFixture(t, path, base, false)
			runtime = &loopbackEditRetryRuntime{hostEditRetryRuntime: base, sidecar: sidecar, mode: "rollback"}
			host = newLoopbackEditRetryHost(store, runtime)
			if err := host.RecoverCore(t.Context()); err != nil {
				t.Fatalf("restart %d RecoverCore()=%v", restart+1, err)
			}
			assertSocketFaultFencedCheckpoint(t, store, result.OperationID, storesqlite.EditRetryCheckpointRollbackDispatched)
			sidecar.assertCount(t, "rollback:workspace-1:session-1", 1)
		}
		defer db.Close()
	})

	t.Run("replacement response loss", func(t *testing.T) {
		fixture := newReplacementFaultFixture(t)
		defer fixture.db.Close()
		sidecar := newEditRetryLoopbackSidecar(t, nil)
		runtime := &loopbackEditRetryRuntime{hostEditRetryRuntime: fixture.runtime, sidecar: sidecar, mode: "replacement"}
		fixture.host = newLoopbackEditRetryHost(fixture.store, runtime)

		if err := fixture.host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
			t.Fatalf("StepRuntimeOperationWorker()=%v", err)
		}
		op, found, err := fixture.store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, fixture.operationID)
		if err != nil || !found {
			t.Fatalf("operation found=%v error=%v", found, err)
		}
		payload, err := storesqlite.DecodeEditRetryOperationPayload(op.Payload)
		if err != nil || payload.Checkpoint != storesqlite.EditRetryCheckpointReplacementDispatched {
			t.Fatalf("operation=%#v payload=%#v error=%v", op, payload, err)
		}
		sidecar.assertCount(t, "replacement:edit-retry:"+fixture.operationID, 1)
		assertSocketFaultFencedCheckpoint(t, fixture.store, fixture.operationID, storesqlite.EditRetryCheckpointReplacementDispatched)

		for restart := 0; restart < 2; restart++ {
			if err := fixture.db.Close(); err != nil {
				t.Fatal(err)
			}
			_, fixture.store, fixture.db = openEditRetryRestartFixture(t, fixture.dbPath, fixture.runtime, false)
			runtime = &loopbackEditRetryRuntime{hostEditRetryRuntime: fixture.runtime, sidecar: sidecar, mode: "replacement"}
			fixture.host = newLoopbackEditRetryHost(fixture.store, runtime)
			if err := fixture.host.RecoverCore(t.Context()); err != nil {
				t.Fatalf("restart %d RecoverCore()=%v", restart+1, err)
			}
			assertSocketFaultFencedCheckpoint(t, fixture.store, fixture.operationID, storesqlite.EditRetryCheckpointReplacementDispatched)
			sidecar.assertCount(t, "replacement:edit-retry:"+fixture.operationID, 1)
		}
	})
}

func newLoopbackEditRetryHost(store *storesqlite.Store, runtime *loopbackEditRetryRuntime) *agenthost.Host {
	return agenthost.New(agenthost.Config{
		CanonicalStore: sqliteCanonicalStore{Store: store}, TurnSubmissions: store,
		EffectiveHistory: store, RuntimeOperations: store, RuntimeOperationHealth: store,
		Runtime: runtime, HistoryRuntime: runtime, GoalRuntime: runtime, OperationOwner: "loopback-socket",
	})
}

func assertSocketFaultFencedCheckpoint(t *testing.T, store *storesqlite.Store, operationID string, checkpoint storesqlite.EditRetryCheckpoint) {
	t.Helper()
	op, found, err := store.GetRuntimeOperation(t.Context(), editRetryRestartRef.WorkspaceID, operationID)
	if err != nil || !found {
		t.Fatalf("operation found=%v error=%v", found, err)
	}
	payload, err := storesqlite.DecodeEditRetryOperationPayload(op.Payload)
	if err != nil || payload.Checkpoint != checkpoint || op.Status == storesqlite.RuntimeOperationStatusCompleted {
		t.Fatalf("operation=%#v payload=%#v error=%v", op, payload, err)
	}
	history, found, err := store.GetSessionHistory(t.Context(), editRetryRestartRef.WorkspaceID, editRetryRestartRef.AgentSessionID)
	if err != nil || !found || history.OperationID != operationID || history.RecoveryState == storesqlite.SessionHistoryRecoveryReady {
		t.Fatalf("history=%#v found=%v error=%v", history, found, err)
	}
}

type loopbackEditRetryRuntime struct {
	*hostEditRetryRuntime
	sidecar *editRetryLoopbackSidecar
	mode    string
}

func (*loopbackEditRetryRuntime) SupportsEffectiveHistory(context.Context, agenthost.RuntimeHistoryInput) (bool, error) {
	return true, nil
}

func (r *loopbackEditRetryRuntime) ReadEffectiveHistory(ctx context.Context, _ agenthost.RuntimeHistoryInput) (agenthost.RuntimeHistorySnapshot, error) {
	turns, err := r.sidecar.read(ctx)
	if err != nil {
		return agenthost.RuntimeHistorySnapshot{}, err
	}
	return agenthost.RuntimeHistorySnapshot{ProviderSessionID: "thread-1", Turns: turns}, nil
}

func (r *loopbackEditRetryRuntime) RollbackLatestTurn(ctx context.Context, input agenthost.RuntimeHistoryInput) (agenthost.RuntimeHistoryMutationResult, error) {
	if r.mode != "rollback" {
		return r.hostEditRetryRuntime.RollbackLatestTurn(ctx, input)
	}
	if err := r.sidecar.mutate(ctx, "ROLLBACK", "rollback:"+input.WorkspaceID+":"+input.AgentSessionID); err != nil {
		return agenthost.RuntimeHistoryMutationResult{}, err
	}
	return agenthost.RuntimeHistoryMutationResult{Disposition: agenthost.RuntimeDispatchDispositionOutcomeUnknown}, errors.New("loopback rollback response lost")
}

func (r *loopbackEditRetryRuntime) Exec(ctx context.Context, input agenthost.RuntimeExecInput) (agenthost.RuntimeExecResult, error) {
	if r.mode != "replacement" || !input.HistoryReplacement {
		return r.hostEditRetryRuntime.Exec(ctx, input)
	}
	if err := r.sidecar.mutate(ctx, "REPLACEMENT", "replacement:"+input.ClientSubmitID); err != nil {
		return agenthost.RuntimeExecResult{}, err
	}
	return agenthost.RuntimeExecResult{
		TurnID:           input.TurnID,
		ProviderDispatch: agenthost.RuntimeProviderDispatchResult{Disposition: agenthost.RuntimeDispatchDispositionOutcomeUnknown},
	}, errors.New("loopback replacement response lost")
}

type editRetryLoopbackSidecar struct {
	t                      *testing.T
	listener               net.Listener
	ledger                 string
	mu                     sync.Mutex
	turns                  []agenthost.RuntimeHistoryTurn
	hideMutationsFromReads bool
	closed                 chan struct{}
	closeOnce              sync.Once
}

func (s *editRetryLoopbackSidecar) setHideMutationsFromReads(value bool) {
	s.mu.Lock()
	s.hideMutationsFromReads = value
	s.mu.Unlock()
}

func newEditRetryLoopbackSidecar(t *testing.T, turns []string) *editRetryLoopbackSidecar {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &editRetryLoopbackSidecar{t: t, listener: listener, ledger: filepath.Join(t.TempDir(), "provider-ledger.log"), closed: make(chan struct{})}
	for _, turnID := range turns {
		s.turns = append(s.turns, agenthost.RuntimeHistoryTurn{ID: turnID})
	}
	go s.serve()
	t.Cleanup(s.close)
	return s
}

func (s *editRetryLoopbackSidecar) serve() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			select {
			case <-s.closed:
				return
			default:
				s.t.Errorf("loopback sidecar accept: %v", err)
				return
			}
		}
		go s.handle(conn)
	}
}

func (s *editRetryLoopbackSidecar) handle(conn net.Conn) {
	defer conn.Close()
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		return
	}
	parts := strings.Fields(line)
	if len(parts) == 1 && parts[0] == "READ" {
		s.mu.Lock()
		ids := make([]string, 0, len(s.turns))
		for _, turn := range s.turns {
			ids = append(ids, turn.ID)
		}
		s.mu.Unlock()
		_, _ = fmt.Fprintln(conn, strings.Join(ids, ","))
		return
	}
	if len(parts) != 2 || (parts[0] != "ROLLBACK" && parts[0] != "REPLACEMENT") {
		return
	}
	if err := appendLoopbackMutation(s.ledger, parts[1]); err != nil {
		s.t.Errorf("loopback sidecar ledger: %v", err)
		return
	}
	if parts[0] == "ROLLBACK" {
		s.mu.Lock()
		if !s.hideMutationsFromReads && len(s.turns) > 0 {
			s.turns = s.turns[:len(s.turns)-1]
		}
		s.mu.Unlock()
	}
	// Deliberately return no response after the independently durable effect.
}

func (s *editRetryLoopbackSidecar) read(ctx context.Context) ([]agenthost.RuntimeHistoryTurn, error) {
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", s.listener.Addr().String())
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if _, err := fmt.Fprintln(conn, "READ"); err != nil {
		return nil, err
	}
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		return nil, err
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return nil, nil
	}
	ids := strings.Split(line, ",")
	turns := make([]agenthost.RuntimeHistoryTurn, 0, len(ids))
	for _, id := range ids {
		turns = append(turns, agenthost.RuntimeHistoryTurn{ID: id})
	}
	return turns, nil
}

func (s *editRetryLoopbackSidecar) mutate(ctx context.Context, kind, identity string) error {
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", s.listener.Addr().String())
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := fmt.Fprintf(conn, "%s %s\n", kind, identity); err != nil {
		return err
	}
	_, err = bufio.NewReader(conn).ReadByte()
	if err == nil {
		return errors.New("loopback sidecar unexpectedly returned a response")
	}
	return nil
}

func (s *editRetryLoopbackSidecar) assertCount(t *testing.T, identity string, want int) {
	t.Helper()
	contents, err := os.ReadFile(s.ledger)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(contents), identity+"\n"); got != want {
		t.Fatalf("loopback ledger=%q count(%q)=%d want %d", contents, identity, got, want)
	}
}

func (s *editRetryLoopbackSidecar) close() {
	s.closeOnce.Do(func() {
		close(s.closed)
		_ = s.listener.Close()
	})
}

func appendLoopbackMutation(path, identity string) error {
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = fmt.Fprintln(file, identity)
	return err
}
