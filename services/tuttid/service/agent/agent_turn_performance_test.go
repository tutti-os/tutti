package agent

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
	turnperformance "github.com/tutti-os/tutti/services/tuttid/service/reporter/events/agent/turn_performance"
)

func TestBuildAgentTurnPerformanceSummaryUsesCanonicalContentWithoutUploadingIt(t *testing.T) {
	turn := agentactivitybiz.Turn{
		Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeCompleted,
		StartedAtUnixMS: 2_000, SettledAtUnixMS: 22_000,
	}
	queued := true
	summary := buildAgentTurnPerformanceSummary(turn, []agentactivitybiz.Message{
		{
			MessageID: "user", Role: "user", Kind: "text", OccurredAtUnixMS: 2_000,
			Payload: map[string]any{"content": "must stay local"},
		},
		{MessageID: "thinking", Role: "assistant", Kind: "reasoning", OccurredAtUnixMS: 6_000, Payload: map[string]any{"text": "private reasoning"}},
		{MessageID: "notice", Role: "assistant", Kind: "text", OccurredAtUnixMS: 7_000, Payload: map[string]any{"kind": "agent_system_notice", "text": "retrying"}},
		{MessageID: "toolcall:1", Role: "assistant", Kind: "tool_call", OccurredAtUnixMS: 8_000, Payload: map[string]any{"input": map[string]any{"path": "/private/file"}}},
		{MessageID: "answer", Role: "assistant", Kind: "text", OccurredAtUnixMS: 18_000, Payload: map[string]any{"content": "private answer"}},
	}, agentTurnPerformanceProvenance{
		clientSubmittedAtUnixMS: 1_000,
		sessionState:            "new",
		wasQueued:               &queued,
	})
	if summary.timingStartSource != "client_submit" || summary.totalDurationMS != 21_000 {
		t.Fatalf("timing = source %q duration %d", summary.timingStartSource, summary.totalDurationMS)
	}
	if summary.firstProgressMS == nil || *summary.firstProgressMS != 5_000 {
		t.Fatalf("first progress = %#v", summary.firstProgressMS)
	}
	if summary.ttftMS == nil || *summary.ttftMS != 17_000 {
		t.Fatalf("ttft = %#v", summary.ttftMS)
	}
	if !summary.hadToolCall || summary.toolCallCount != 1 || !summary.hadLongIdle || summary.maxIdleMS != 10_000 {
		t.Fatalf("tool/idle summary = %#v", summary)
	}
	if summary.wasQueued == nil || !*summary.wasQueued || summary.sessionState != "new" || summary.outcome != "success" {
		t.Fatalf("dimensions = %#v", summary)
	}
}

func TestBuildAgentTurnPerformanceSummaryLeavesUnavailableFactsNull(t *testing.T) {
	summary := buildAgentTurnPerformanceSummary(agentactivitybiz.Turn{
		Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeInterrupted,
		StartedAtUnixMS: 1_000, SettledAtUnixMS: 2_000,
	}, nil, agentTurnPerformanceProvenance{})
	if summary.firstProgressMS != nil || summary.ttftMS != nil || summary.wasQueued != nil {
		t.Fatalf("unavailable fields = %#v", summary)
	}
	if summary.outcome != "failure" || summary.sessionState != "unknown" {
		t.Fatalf("fallback dimensions = %#v", summary)
	}
}

func TestAgentTurnAnalyticsOutcomeUsesStructuredErrorCodeOnly(t *testing.T) {
	turn := agentactivitybiz.Turn{
		Outcome:      agentactivitybiz.TurnOutcomeFailed,
		ErrorCode:    "provider_turn_timeout",
		ErrorMessage: "arbitrary user-visible text",
	}
	if got := agentTurnAnalyticsOutcome(turn); got != "timeout" {
		t.Fatalf("outcome = %q", got)
	}
	turn.ErrorCode = "provider_failure"
	turn.ErrorMessage = "deadline exceeded"
	if got := agentTurnAnalyticsOutcome(turn); got != "failure" {
		t.Fatalf("text-inferred outcome = %q, want failure", got)
	}
}

type turnPerformanceModelCatalog struct {
	result AgentModelCatalogResult
	err    error
}

func (c turnPerformanceModelCatalog) ListModels(context.Context, AgentModelCatalogInput) (AgentModelCatalogResult, error) {
	return c.result, c.err
}

func TestResolveAgentTurnAnalyticsModelRedactsNonCatalogValues(t *testing.T) {
	catalog := turnPerformanceModelCatalog{result: AgentModelCatalogResult{
		Source: "codex-cli", Models: []AgentModelOption{{ID: "gpt-5"}},
	}}
	if got := resolveAgentTurnAnalyticsModel(context.Background(), catalog, agentactivitybiz.Session{Provider: "codex", Model: "gpt-5"}); got != "gpt-5" {
		t.Fatalf("catalog model = %q", got)
	}
	if got := resolveAgentTurnAnalyticsModel(context.Background(), catalog, agentactivitybiz.Session{Provider: "codex", Model: "private-model-name"}); got != "custom" {
		t.Fatalf("custom model = %q", got)
	}
	unsafeCatalog := turnPerformanceModelCatalog{result: AgentModelCatalogResult{
		Source: "extension", Models: []AgentModelOption{{ID: "https://private.example/model"}},
	}}
	if got := resolveAgentTurnAnalyticsModel(context.Background(), unsafeCatalog, agentactivitybiz.Session{Provider: "acp:example", Model: "https://private.example/model"}); got != "unknown" {
		t.Fatalf("unsafe catalog model = %q", got)
	}
	if got := normalizeAgentTurnProvider("acp:gemini"); got != "acp:gemini" {
		t.Fatalf("extension provider = %q", got)
	}
}

func TestActivityProjectionClaimsTurnPerformanceOnceWithinRetentionWindow(t *testing.T) {
	projection := NewActivityProjection(nil)
	now := time.Now()
	if _, claimed := projection.claimTurnPerformanceReport("turn", now); !claimed {
		t.Fatal("first turn performance report was not claimed")
	}
	if _, claimed := projection.claimTurnPerformanceReport("turn", now); claimed {
		t.Fatal("turn performance report was not deduplicated")
	}
}

func TestActivityProjectionTurnPerformanceAttemptsExpire(t *testing.T) {
	projection := NewActivityProjection(nil)
	base := time.Now()
	if _, claimed := projection.claimTurnPerformanceReport("turn", base); !claimed {
		t.Fatal("first turn performance attempt was not claimed")
	}
	if _, claimed := projection.claimTurnPerformanceReport(
		"turn",
		base.Add(agentTurnPerformanceStateTTL+agentTurnPerformancePruneInterval),
	); !claimed {
		t.Fatal("expired turn performance attempt was not claimable")
	}
	if got := len(projection.turnPerformanceState.attempted); got != 1 {
		t.Fatalf("attempted entries = %d, want 1", got)
	}
}

func TestActivityProjectionTurnPerformanceAttemptsAreBounded(t *testing.T) {
	projection := NewActivityProjection(nil)
	base := time.Now()
	for index := 0; index <= agentTurnPerformanceStateMaxEntries; index++ {
		key := fmt.Sprintf("turn-%d", index)
		if _, claimed := projection.claimTurnPerformanceReport(
			key,
			base.Add(time.Duration(index)*time.Millisecond),
		); !claimed {
			t.Fatalf("turn performance attempt %q was not claimed", key)
		}
	}
	if got := len(projection.turnPerformanceState.attempted); got != agentTurnPerformanceStateMaxEntries {
		t.Fatalf("attempted entries = %d, want %d", got, agentTurnPerformanceStateMaxEntries)
	}
	if _, exists := projection.turnPerformanceState.attempted["turn-0"]; exists {
		t.Fatal("oldest turn performance attempt was not evicted")
	}
	if _, exists := projection.turnPerformanceState.attempted[fmt.Sprintf("turn-%d", agentTurnPerformanceStateMaxEntries)]; !exists {
		t.Fatal("newest turn performance attempt was not retained")
	}
}

func TestActivityProjectionClaimsTurnPerformanceOnceConcurrently(t *testing.T) {
	projection := NewActivityProjection(nil)
	const count = 100
	claimed := make(chan struct{}, count)
	var group sync.WaitGroup
	for index := 0; index < count; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			if _, ok := projection.claimTurnPerformanceReport("turn", time.Now()); ok {
				claimed <- struct{}{}
			}
		}()
	}
	group.Wait()
	close(claimed)
	if got := len(claimed); got != 1 {
		t.Fatalf("concurrent claims = %d, want 1", got)
	}
}

type typedNilTurnPerformanceReporter struct{}

func (*typedNilTurnPerformanceReporter) Track(context.Context, ...reporterservice.Event) {}

func (*typedNilTurnPerformanceReporter) Close() error { return nil }

func TestActivityProjectionDoesNotClaimTurnPerformanceWhenReporterDisabled(t *testing.T) {
	tests := []struct {
		name     string
		reporter reporterservice.Reporter
	}{
		{name: "missing"},
		{name: "noop pointer", reporter: &reporterservice.NoopReporter{}},
		{name: "nil noop pointer", reporter: (*reporterservice.NoopReporter)(nil)},
		{name: "noop value", reporter: reporterservice.NoopReporter{}},
		{name: "typed nil reporter", reporter: (*typedNilTurnPerformanceReporter)(nil)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			projection := NewActivityProjection(nil)
			projection.SetAnalyticsReporter(tt.reporter)
			projection.RecordTurnPerformanceProvenance("workspace-1", "session-1", "turn-1", map[string]any{
				"clientSubmittedAtUnixMs": int64(1_000),
			})
			projection.scheduleAgentTurnPerformance(t.Context(), "workspace-1", "session-1", agentactivitybiz.Turn{
				TurnID: "turn-1",
				Phase:  agentactivitybiz.TurnPhaseSettled,
			})

			key := agentTurnPerformanceKey("workspace-1", "session-1", "turn-1")
			projection.turnPerformanceState.mu.Lock()
			defer projection.turnPerformanceState.mu.Unlock()
			if got := len(projection.turnPerformanceState.attempted); got != 0 {
				t.Fatalf("attempted entries = %d, want 0", got)
			}
			if _, exists := projection.turnPerformanceState.provenance[key]; !exists {
				t.Fatal("disabled reporter consumed turn performance provenance")
			}
		})
	}
}

func TestActivityProjectionAnalyticsReporterSnapshotIsConcurrentSafe(t *testing.T) {
	projection := NewActivityProjection(nil)
	reporterA := &turnPerformanceEventReporter{events: make(chan reporterservice.Event, 1)}
	reporterB := &turnPerformanceEventReporter{events: make(chan reporterservice.Event, 1)}
	start := make(chan struct{})
	var group sync.WaitGroup
	group.Add(2)
	go func() {
		defer group.Done()
		<-start
		for index := 0; index < 10_000; index++ {
			if index%2 == 0 {
				projection.SetAnalyticsReporter(reporterA)
			} else {
				projection.SetAnalyticsReporter(reporterB)
			}
		}
	}()
	go func() {
		defer group.Done()
		<-start
		for index := 0; index < 10_000; index++ {
			reporter := projection.analyticsReporterSnapshot()
			if reporter != nil && reporter != reporterA && reporter != reporterB {
				t.Errorf("unexpected analytics reporter snapshot %T", reporter)
				return
			}
		}
	}()
	close(start)
	group.Wait()
}

type unavailableTurnPerformanceRepository struct {
	agentactivitybiz.Repository
	getSessionCalls chan struct{}
}

func (r *unavailableTurnPerformanceRepository) GetSession(
	context.Context,
	string,
	string,
) (agentactivitybiz.Session, bool, error) {
	r.getSessionCalls <- struct{}{}
	return agentactivitybiz.Session{}, false, nil
}

func TestActivityProjectionFailedTurnPerformanceAttemptRemainsDeduplicatedUntilTTL(t *testing.T) {
	reporter := &turnPerformanceEventReporter{events: make(chan reporterservice.Event, 1)}
	repo := &unavailableTurnPerformanceRepository{getSessionCalls: make(chan struct{}, 2)}
	projection := NewActivityProjection(repo)
	projection.SetAnalyticsReporter(reporter)
	turn := agentactivitybiz.Turn{TurnID: "turn-1", Phase: agentactivitybiz.TurnPhaseSettled}
	projection.scheduleAgentTurnPerformanceWithLauncher(
		t.Context(), "workspace-1", "session-1", turn, func(report func()) { report() },
	)
	if got := len(repo.getSessionCalls); got != 1 {
		t.Fatalf("failed turn performance repository reads = %d, want 1", got)
	}

	key := agentTurnPerformanceKey("workspace-1", "session-1", "turn-1")
	projection.turnPerformanceState.mu.Lock()
	attemptedAt, exists := projection.turnPerformanceState.attempted[key]
	projection.turnPerformanceState.mu.Unlock()
	if !exists {
		t.Fatal("failed turn performance report did not retain a bounded attempt")
	}

	projection.scheduleAgentTurnPerformanceWithLauncher(
		t.Context(), "workspace-1", "session-1", turn, func(report func()) { report() },
	)
	projection.turnPerformanceState.mu.Lock()
	if got := len(projection.turnPerformanceState.attempted); got != 1 {
		projection.turnPerformanceState.mu.Unlock()
		t.Fatalf("attempted entries after duplicate failure = %d, want 1", got)
	}
	if got := projection.turnPerformanceState.attempted[key]; !got.Equal(attemptedAt) {
		projection.turnPerformanceState.mu.Unlock()
		t.Fatalf("duplicate failure replaced attempted timestamp: got %v want %v", got, attemptedAt)
	}
	projection.turnPerformanceState.mu.Unlock()
	if got := len(repo.getSessionCalls); got != 1 {
		t.Fatalf("failed turn performance repository reads within TTL = %d, want 1", got)
	}

	if _, claimed := projection.claimTurnPerformanceReport(
		key,
		attemptedAt.Add(agentTurnPerformanceStateTTL+agentTurnPerformancePruneInterval),
	); !claimed {
		t.Fatal("failed turn performance attempt was not claimable after TTL")
	}
}

type readableTurnPerformanceRepository struct {
	agentactivitybiz.Repository
}

func (*readableTurnPerformanceRepository) GetSession(
	context.Context,
	string,
	string,
) (agentactivitybiz.Session, bool, error) {
	return agentactivitybiz.Session{Provider: "codex"}, true, nil
}

func (*readableTurnPerformanceRepository) ListSessionMessages(
	context.Context,
	agentactivitybiz.ListSessionMessagesInput,
) (agentactivitybiz.MessagePage, bool, error) {
	return agentactivitybiz.MessagePage{}, true, nil
}

func TestActivityProjectionCapturesTurnPerformanceReporterBeforeLaunch(t *testing.T) {
	first := &turnPerformanceEventReporter{events: make(chan reporterservice.Event, 1)}
	second := &turnPerformanceEventReporter{events: make(chan reporterservice.Event, 1)}
	projection := NewActivityProjection(&readableTurnPerformanceRepository{})
	projection.SetAnalyticsReporter(first)
	turn := agentactivitybiz.Turn{TurnID: "turn-1", Phase: agentactivitybiz.TurnPhaseSettled}
	var report func()
	projection.scheduleAgentTurnPerformanceWithLauncher(
		t.Context(),
		"workspace-1",
		"session-1",
		turn,
		func(scheduled func()) { report = scheduled },
	)
	if report == nil {
		t.Fatal("turn performance report was not scheduled")
	}
	projection.SetAnalyticsReporter(second)
	report()
	select {
	case <-first.events:
	default:
		t.Fatal("captured reporter did not receive turn performance event")
	}
	select {
	case event := <-second.events:
		t.Fatalf("replacement reporter received captured event: %#v", event)
	default:
	}
}

type panickingTurnPerformanceReporter struct {
	calls chan struct{}
}

func (r *panickingTurnPerformanceReporter) Track(context.Context, ...reporterservice.Event) {
	r.calls <- struct{}{}
	panic("turn performance reporter failure")
}

func (*panickingTurnPerformanceReporter) Close() error { return nil }

func TestActivityProjectionPanickingTurnPerformanceReporterRemainsDeduplicated(t *testing.T) {
	reporter := &panickingTurnPerformanceReporter{calls: make(chan struct{}, 2)}
	projection := NewActivityProjection(&readableTurnPerformanceRepository{})
	projection.SetAnalyticsReporter(reporter)
	turn := agentactivitybiz.Turn{TurnID: "turn-1", Phase: agentactivitybiz.TurnPhaseSettled}
	projection.scheduleAgentTurnPerformanceWithLauncher(
		t.Context(), "workspace-1", "session-1", turn, func(report func()) { report() },
	)
	if got := len(reporter.calls); got != 1 {
		t.Fatalf("panicking turn performance reporter calls = %d, want 1", got)
	}

	projection.scheduleAgentTurnPerformanceWithLauncher(
		t.Context(), "workspace-1", "session-1", turn, func(report func()) { report() },
	)
	if got := len(reporter.calls); got != 1 {
		t.Fatalf("panicking turn performance reporter calls within TTL = %d, want 1", got)
	}
}

func TestActivityProjectionTurnPerformanceProvenanceIsMemoryOnlyAndConsumed(t *testing.T) {
	projection := NewActivityProjection(nil)
	projection.RecordTurnPerformanceProvenance("workspace-1", "session-1", "turn-1", map[string]any{
		"clientSubmittedAtUnixMs": int64(1_000),
		"sessionState":            "existing",
		"queued":                  false,
	})
	key := agentTurnPerformanceKey("workspace-1", "session-1", "turn-1")
	provenance, claimed := projection.claimTurnPerformanceReport(key, time.Now())
	if !claimed || provenance.clientSubmittedAtUnixMS != 1_000 || provenance.sessionState != "existing" ||
		provenance.wasQueued == nil || *provenance.wasQueued {
		t.Fatalf("consumed provenance = %#v claimed=%v", provenance, claimed)
	}
	if _, ok := projection.turnPerformanceState.provenance[key]; ok {
		t.Fatal("terminal claim did not remove in-memory performance provenance")
	}
}

func TestActivityProjectionTurnPerformanceProvenanceExpires(t *testing.T) {
	projection := NewActivityProjection(nil)
	key := agentTurnPerformanceKey("workspace-1", "session-1", "turn-expired")
	old := time.Now().Add(-agentTurnPerformanceStateTTL - time.Minute)
	projection.turnPerformanceState.record(key, agentTurnPerformanceProvenance{
		clientSubmittedAtUnixMS: 1_000,
		recordedAt:              old,
		sessionState:            "new",
	})
	provenance, claimed := projection.claimTurnPerformanceReport(key, time.Now())
	if !claimed {
		t.Fatal("expired turn should still claim terminal reporting")
	}
	if provenance.clientSubmittedAtUnixMS != 0 || provenance.sessionState != "" || provenance.wasQueued != nil {
		t.Fatalf("expired provenance was not discarded: %#v", provenance)
	}
}

func TestActivityProjectionTurnPerformanceStateIsBounded(t *testing.T) {
	projection := NewActivityProjection(nil)
	base := time.Now()
	for index := 0; index <= agentTurnPerformanceStateMaxEntries; index++ {
		key := fmt.Sprintf("turn-%d", index)
		projection.turnPerformanceState.record(key, agentTurnPerformanceProvenance{
			clientSubmittedAtUnixMS: int64(index + 1),
			recordedAt:              base.Add(time.Duration(index) * time.Millisecond),
		})
	}
	if got := len(projection.turnPerformanceState.provenance); got != agentTurnPerformanceStateMaxEntries {
		t.Fatalf("provenance entries = %d, want %d", got, agentTurnPerformanceStateMaxEntries)
	}
	if _, exists := projection.turnPerformanceState.provenance["turn-0"]; exists {
		t.Fatal("oldest provenance entry was not evicted")
	}
}

func TestActivityProjectionTurnPerformanceStateIsConcurrentSafe(t *testing.T) {
	projection := NewActivityProjection(nil)
	const count = 100
	var recorded sync.WaitGroup
	for index := 0; index < count; index++ {
		recorded.Add(1)
		go func(index int) {
			defer recorded.Done()
			projection.RecordTurnPerformanceProvenance("workspace-1", "session-1", fmt.Sprintf("turn-%d", index), map[string]any{
				"clientSubmittedAtUnixMs": int64(index + 1),
				"sessionState":            "existing",
				"queued":                  false,
			})
		}(index)
	}
	recorded.Wait()

	var claimed sync.WaitGroup
	results := make(chan agentTurnPerformanceProvenance, count)
	for index := 0; index < count; index++ {
		claimed.Add(1)
		go func(index int) {
			defer claimed.Done()
			key := agentTurnPerformanceKey("workspace-1", "session-1", fmt.Sprintf("turn-%d", index))
			if provenance, ok := projection.claimTurnPerformanceReport(key, time.Now()); ok {
				results <- provenance
			}
		}(index)
	}
	claimed.Wait()
	close(results)
	if got := len(results); got != count {
		t.Fatalf("claimed provenance entries = %d, want %d", got, count)
	}
	if got := len(projection.turnPerformanceState.provenance); got != 0 {
		t.Fatalf("unconsumed provenance entries = %d", got)
	}
}

func TestBuildAgentTurnPerformanceSummaryFallsBackAfterRestart(t *testing.T) {
	summary := buildAgentTurnPerformanceSummary(agentactivitybiz.Turn{
		Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeCompleted,
		StartedAtUnixMS: 2_000, SettledAtUnixMS: 5_000,
	}, []agentactivitybiz.Message{{
		Role: "user", Kind: "text", OccurredAtUnixMS: 2_000,
		Payload: map[string]any{
			"clientSubmittedAtUnixMs": int64(1_000),
			"sessionState":            "new",
			"queued":                  true,
		},
	}}, agentTurnPerformanceProvenance{})
	if summary.timingStartSource != "canonical_turn" || summary.totalDurationMS != 3_000 ||
		summary.sessionState != "unknown" || summary.wasQueued != nil {
		t.Fatalf("restart fallback summary = %#v", summary)
	}
}

type turnPerformanceEventReporter struct {
	events chan reporterservice.Event
}

func (r *turnPerformanceEventReporter) Track(_ context.Context, events ...reporterservice.Event) {
	for _, event := range events {
		r.events <- event
	}
}

func (*turnPerformanceEventReporter) Close() error { return nil }

func TestActivityProjectionReportsOneTerminalTurnPerformanceEvent(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-performance", Name: "Performance"}); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	reporter := &turnPerformanceEventReporter{events: make(chan reporterservice.Event, 2)}
	projection := NewActivityProjection(store)
	projection.SetAnalyticsReporter(reporter)
	projection.RecordTurnPerformanceProvenance("ws-performance", "session-1", "turn-1", map[string]any{
		"clientSubmittedAtUnixMs": int64(500),
		"queued":                  false,
		"sessionState":            "new",
	})
	activeTurnID := "turn-1"
	if err := projection.Report(ctx, agentsessionstore.ReportActivityInput{
		WorkspaceID: "ws-performance",
		Source: canonical.EventSource{
			AgentID: "session-1", Provider: "codex",
			SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		},
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
			AgentSessionID: "session-1", Kind: agentactivitybiz.SessionKindRoot,
			Provider: "codex", LifecycleStatus: "active", CurrentPhase: "working", OccurredAtUnixMS: 1_000,
			Turn: &agentsessionstore.WorkspaceAgentTurnPatch{
				TurnID: "turn-1", Origin: agentactivitybiz.TurnOriginUserPrompt,
				ActiveTurnID: &activeTurnID, Phase: agentactivitybiz.TurnPhaseRunning,
			},
		}},
		MessageUpdates: []agentsessionstore.WorkspaceAgentMessageUpdate{{
			AgentSessionID: "session-1", TurnID: "turn-1", MessageID: "user-1",
			Role: "user", Kind: "text", Status: "completed",
			Payload:          map[string]any{"text": "private prompt"},
			OccurredAtUnixMS: 1_000,
		}},
	}); err != nil {
		t.Fatalf("report running turn: %v", err)
	}
	if err := projection.Report(ctx, agentsessionstore.ReportActivityInput{
		WorkspaceID: "ws-performance",
		Source: canonical.EventSource{
			AgentID: "session-1", Provider: "codex",
			SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		},
		MessageUpdates: []agentsessionstore.WorkspaceAgentMessageUpdate{{
			AgentSessionID: "session-1", TurnID: "turn-1", MessageID: "assistant-1",
			Role: "assistant", Kind: "text", Status: "completed",
			Payload: map[string]any{"text": "private response"}, OccurredAtUnixMS: 3_000,
		}},
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
			AgentSessionID: "session-1", Kind: agentactivitybiz.SessionKindRoot,
			Provider: "codex", LifecycleStatus: "ready", CurrentPhase: "idle", OccurredAtUnixMS: 5_000,
			Turn: &agentsessionstore.WorkspaceAgentTurnPatch{
				TurnID: "turn-1", Phase: agentactivitybiz.TurnPhaseSettled,
				Outcome: agentactivitybiz.TurnOutcomeCompleted, CompletedAtUnixMS: 5_000,
			},
		}},
	}); err != nil {
		t.Fatalf("report settled turn: %v", err)
	}

	var event reporterservice.Event
	select {
	case event = <-reporter.events:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for terminal performance event")
	}
	if event.Name != turnperformance.EventName {
		t.Fatalf("event name = %q", event.Name)
	}
	if event.Params["ttft_ms"] != int64(2_500) || event.Params["total_duration_ms"] != int64(4_500) ||
		event.Params["timing_start_source"] != "client_submit" || event.Params["session_state"] != "new" ||
		event.Params["was_queued"] != false {
		t.Fatalf("timing params = %#v", event.Params)
	}
	for _, forbidden := range []string{"workspace_id", "agent_session_id", "turn_id", "prompt", "response", "content"} {
		if _, ok := event.Params[forbidden]; ok {
			t.Fatalf("event contains forbidden key %q: %#v", forbidden, event.Params)
		}
	}
	page, found, err := store.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID: "ws-performance", AgentSessionID: "session-1", TurnID: "turn-1",
		Limit: 100, Order: agentactivitybiz.MessageOrderAsc,
	})
	if err != nil || !found {
		t.Fatalf("read persisted messages: found=%v error=%v", found, err)
	}
	for _, message := range page.Messages {
		for _, forbidden := range []string{"clientSubmittedAtUnixMs", "sessionState", "queued"} {
			if _, ok := message.Payload[forbidden]; ok {
				t.Fatalf("persisted message contains in-memory field %q: %#v", forbidden, message.Payload)
			}
		}
	}

	turn, found, err := store.GetTurn(ctx, "ws-performance", "session-1", "turn-1")
	if err != nil || !found {
		t.Fatalf("read settled turn: found=%v error=%v", found, err)
	}
	projection.scheduleAgentTurnPerformanceWithLauncher(
		ctx, "ws-performance", "session-1", turn, func(report func()) { report() },
	)
	select {
	case duplicate := <-reporter.events:
		t.Fatalf("duplicate terminal event = %#v", duplicate)
	default:
	}
}
