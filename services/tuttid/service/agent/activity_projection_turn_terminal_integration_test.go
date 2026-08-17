package agent

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentturnanalyticsbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentturnanalytics"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
)

func TestSettleStaleTurnsOnStartupDeliversDurableTerminalAnalyticsOnce(t *testing.T) {
	ctx := context.Background()
	store := openTerminalAnalyticsIntegrationStore(t, "ws-startup")
	seedTerminalAnalyticsIntegrationSession(t, store, "ws-startup", "root")
	seedTerminalAnalyticsIntegrationTurn(t, store, "ws-startup", "root", "turn-startup", 100)
	if _, created, err := store.PrepareSubmitClaim(ctx, agentactivitybiz.SubmitClaimPrepare{
		WorkspaceID: "ws-startup", AgentSessionID: "root", CanonicalTurnID: "turn-startup",
		ClientSubmitID: "submit-startup", MetadataJSON: `{"uiMode":"agent"}`, NowUnixMS: 110,
	}); err != nil || !created {
		t.Fatalf("PrepareSubmitClaim() created=%v err=%v", created, err)
	}
	reporter := newConcurrentTerminalAnalyticsReporter()
	projection := NewActivityProjection(store)
	projection.SetAnalyticsReporter(reporter)

	if err := projection.SettleStaleTurnsOnStartup(ctx); err != nil {
		t.Fatal(err)
	}
	events := reporter.snapshot()
	if len(events) != 1 || events[0].Name != "agent.turn_cancelled" {
		t.Fatalf("startup events=%#v", events)
	}
	params := events[0].Params
	if params["startup_reconciled"] != true || params["client_submit_id"] != "submit-startup" ||
		params["event_id"] != agentturnanalyticsbiz.StableEventID("ws-startup", "root", "turn-startup") {
		t.Fatalf("startup params=%#v", params)
	}
	if err := projection.SettleStaleTurnsOnStartup(ctx); err != nil {
		t.Fatal(err)
	}
	if got := len(reporter.snapshot()); got != 1 {
		t.Fatalf("startup replay event count=%d, want 1", got)
	}
}

func TestTerminalAnalyticsWorkerJoinsSettlementBeforeClaimAndStopsWithContext(t *testing.T) {
	ctx := context.Background()
	store := openTerminalAnalyticsIntegrationStore(t, "ws-late-claim")
	seedTerminalAnalyticsIntegrationSession(t, store, "ws-late-claim", "root")
	seedTerminalAnalyticsIntegrationTurn(t, store, "ws-late-claim", "root", "turn-late", 100)
	turn, accepted, err := store.AgentCanonicalStore().RecordTurnTransition(ctx, agentactivitybiz.TurnTransition{
		WorkspaceID: "ws-late-claim", AgentSessionID: "root", TurnID: "turn-late",
		Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeCompleted,
		SettledAtUnixMS: 200, OccurredAtUnixMS: 200,
	})
	if err != nil || !accepted {
		t.Fatalf("terminal transition accepted=%v err=%v", accepted, err)
	}

	reporter := newConcurrentTerminalAnalyticsReporter()
	projection := NewActivityProjection(store)
	projection.SetAnalyticsReporter(reporter)
	workerCtx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		projection.RunTurnTerminalAnalytics(workerCtx)
		close(done)
	}()
	if reporter.waitForCount(1, 150*time.Millisecond) {
		t.Fatal("terminal analytics delivered before durable submission provenance existed")
	}
	if _, created, err := store.PrepareSubmitClaim(ctx, agentactivitybiz.SubmitClaimPrepare{
		WorkspaceID: "ws-late-claim", AgentSessionID: "root", CanonicalTurnID: "turn-late",
		ClientSubmitID: "submit-late", MetadataJSON: `{"uiMode":"os"}`, NowUnixMS: 300,
	}); err != nil || !created {
		t.Fatalf("late PrepareSubmitClaim() created=%v err=%v", created, err)
	}
	// Do not send a wake hint: the periodic drain is the recovery path for a
	// crash between the durable claim commit and post-commit notification.
	if !reporter.waitForCount(1, 3*time.Second) {
		t.Fatal("periodic terminal analytics drain did not join the late claim")
	}
	events := reporter.snapshot()
	if len(events) != 1 || events[0].Params["event_id"] != agentturnanalyticsbiz.StableEventID("ws-late-claim", "root", "turn-late") {
		t.Fatalf("late-claim events=%#v", events)
	}
	if err := projection.ObserveCommitted(ctx, agenthost.CommittedDelta{
		RootTurnsSettled: []agenthost.RootTurnSettled{{
			WorkspaceID: "ws-late-claim", AgentSessionID: "root", Provider: "codex", Turn: turn,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if got := len(reporter.snapshot()); got != 1 {
		t.Fatalf("duplicate ObserveCommitted event count=%d, want 1", got)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("terminal analytics worker did not stop with context")
	}
}

func TestTerminalAnalyticsStartupRequeueWaitsForInFlightObserverDrain(t *testing.T) {
	store := &blockingTerminalAnalyticsStore{
		activityProjectionRepoStub: &activityProjectionRepoStub{},
		state:                      "pending",
		requeueCalled:              make(chan struct{}, 1),
		delivery: agentturnanalyticsbiz.Delivery{
			Settlement: agentturnanalyticsbiz.Settlement{
				WorkspaceID: "ws-race", AgentSessionID: "root", TurnID: "turn-1",
				EventID: agentturnanalyticsbiz.StableEventID("ws-race", "root", "turn-1"),
				Origin:  agentactivitybiz.TurnOriginUserPrompt, Outcome: agentactivitybiz.TurnOutcomeCompleted,
				StartedAtUnixMS: 100, SettledAtUnixMS: 200,
			},
			ClientSubmitID: "submit-1", MetadataJSON: `{"uiMode":"agent"}`,
		},
	}
	reporter := &blockingTerminalAnalyticsReporter{
		started: make(chan struct{}), release: make(chan struct{}),
	}
	projection := NewActivityProjection(store)
	projection.SetAnalyticsReporter(reporter)

	drainDone := make(chan struct{})
	go func() {
		projection.drainTurnTerminalAnalytics(context.Background(), store)
		close(drainDone)
	}()
	select {
	case <-reporter.started:
	case <-time.After(2 * time.Second):
		t.Fatal("observer drain did not enter Track")
	}
	workerCtx, cancel := context.WithCancel(context.Background())
	workerDone := make(chan struct{})
	go func() {
		projection.RunTurnTerminalAnalytics(workerCtx)
		close(workerDone)
	}()
	select {
	case <-store.requeueCalled:
		t.Fatal("startup requeue reset an in-flight observer lease")
	case <-time.After(150 * time.Millisecond):
	}
	close(reporter.release)
	select {
	case <-drainDone:
	case <-time.After(2 * time.Second):
		t.Fatal("observer drain did not finish")
	}
	select {
	case <-store.requeueCalled:
	case <-time.After(2 * time.Second):
		t.Fatal("startup requeue did not resume after observer drain")
	}
	cancel()
	select {
	case <-workerDone:
	case <-time.After(2 * time.Second):
		t.Fatal("worker did not stop")
	}
	if reporter.count() != 1 {
		t.Fatalf("Track count=%d, want 1", reporter.count())
	}
}

type concurrentTerminalAnalyticsReporter struct {
	mu     sync.Mutex
	events []reporterservice.Event
	wake   chan struct{}
}

type blockingTerminalAnalyticsReporter struct {
	mu      sync.Mutex
	tracked int
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (r *blockingTerminalAnalyticsReporter) Track(context.Context, ...reporterservice.Event) {
	r.mu.Lock()
	r.tracked++
	r.mu.Unlock()
	r.once.Do(func() { close(r.started) })
	<-r.release
}

func (*blockingTerminalAnalyticsReporter) Close() error { return nil }

func (r *blockingTerminalAnalyticsReporter) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.tracked
}

type blockingTerminalAnalyticsStore struct {
	*activityProjectionRepoStub
	mu            sync.Mutex
	state         string
	owner         string
	delivery      agentturnanalyticsbiz.Delivery
	requeueCalled chan struct{}
}

func (*blockingTerminalAnalyticsStore) PutAgentTurnTerminalAnalytics(context.Context, agentturnanalyticsbiz.Settlement, int64) (bool, error) {
	return false, nil
}

func (s *blockingTerminalAnalyticsStore) ClaimAgentTurnTerminalAnalytics(_ context.Context, owner string, _, _ int64) (agentturnanalyticsbiz.Delivery, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state != "pending" {
		return agentturnanalyticsbiz.Delivery{}, false, nil
	}
	s.state = "leased"
	s.owner = owner
	return s.delivery, true, nil
}

func (s *blockingTerminalAnalyticsStore) CompleteAgentTurnTerminalAnalytics(_ context.Context, _, _, _, owner string, _ int64) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state != "leased" || s.owner != owner {
		return false, nil
	}
	s.state = "delivered"
	s.owner = ""
	return true, nil
}

func (s *blockingTerminalAnalyticsStore) IgnoreAgentTurnTerminalAnalytics(_ context.Context, _, _, _, owner, _ string, _ int64) (bool, error) {
	return s.CompleteAgentTurnTerminalAnalytics(context.Background(), "", "", "", owner, 0)
}

func (s *blockingTerminalAnalyticsStore) RequeueAgentTurnTerminalAnalytics(context.Context, int64) (int64, error) {
	s.mu.Lock()
	var changed int64
	if s.state == "leased" {
		s.state = "pending"
		s.owner = ""
		changed = 1
	}
	s.mu.Unlock()
	select {
	case s.requeueCalled <- struct{}{}:
	default:
	}
	return changed, nil
}

func newConcurrentTerminalAnalyticsReporter() *concurrentTerminalAnalyticsReporter {
	return &concurrentTerminalAnalyticsReporter{wake: make(chan struct{}, 1)}
}

func (r *concurrentTerminalAnalyticsReporter) Track(_ context.Context, events ...reporterservice.Event) {
	r.mu.Lock()
	r.events = append(r.events, events...)
	r.mu.Unlock()
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

func (*concurrentTerminalAnalyticsReporter) Close() error { return nil }

func (r *concurrentTerminalAnalyticsReporter) snapshot() []reporterservice.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]reporterservice.Event(nil), r.events...)
}

func (r *concurrentTerminalAnalyticsReporter) waitForCount(want int, timeout time.Duration) bool {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		if len(r.snapshot()) >= want {
			return true
		}
		select {
		case <-r.wake:
		case <-deadline.C:
			return len(r.snapshot()) >= want
		}
	}
}

func openTerminalAnalyticsIntegrationStore(t *testing.T, workspaceID string) *workspacedata.SQLiteStore {
	t.Helper()
	store, err := workspacedata.OpenSQLiteStore(filepath.Join(t.TempDir(), "tuttid.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := store.Create(context.Background(), workspacebiz.Summary{ID: workspaceID, Name: workspaceID}); err != nil {
		t.Fatal(err)
	}
	return store
}

func seedTerminalAnalyticsIntegrationSession(t *testing.T, store *workspacedata.SQLiteStore, workspaceID, sessionID string) {
	t.Helper()
	if _, err := store.ReportSessionState(context.Background(), agentactivitybiz.SessionStateReport{
		WorkspaceID: workspaceID, AgentSessionID: sessionID, Kind: agentactivitybiz.SessionKindRoot,
		Origin: "runtime", Provider: "codex", Status: "active", CurrentPhase: "working",
		OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
}

func seedTerminalAnalyticsIntegrationTurn(t *testing.T, store *workspacedata.SQLiteStore, workspaceID, sessionID, turnID string, occurred int64) {
	t.Helper()
	if _, accepted, err := store.AgentCanonicalStore().RecordTurnTransition(context.Background(), agentactivitybiz.TurnTransition{
		WorkspaceID: workspaceID, AgentSessionID: sessionID, TurnID: turnID,
		Phase: agentactivitybiz.TurnPhaseSubmitted, Origin: agentactivitybiz.TurnOriginUserPrompt,
		StartedAtUnixMS: occurred, OccurredAtUnixMS: occurred,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition() accepted=%v err=%v", accepted, err)
	}
}
