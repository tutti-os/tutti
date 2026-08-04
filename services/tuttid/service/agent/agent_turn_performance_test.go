package agent

import (
	"context"
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
	summary := buildAgentTurnPerformanceSummary(turn, []agentactivitybiz.Message{
		{
			MessageID: "user", Role: "user", Kind: "text", OccurredAtUnixMS: 2_000,
			Payload: map[string]any{
				"clientSubmittedAtUnixMs": int64(1_000), "queued": true,
				"sessionState": "new", "content": "must stay local",
			},
		},
		{MessageID: "thinking", Role: "assistant", Kind: "reasoning", OccurredAtUnixMS: 6_000, Payload: map[string]any{"text": "private reasoning"}},
		{MessageID: "notice", Role: "assistant", Kind: "text", OccurredAtUnixMS: 7_000, Payload: map[string]any{"kind": "agent_system_notice", "text": "retrying"}},
		{MessageID: "toolcall:1", Role: "assistant", Kind: "tool_call", OccurredAtUnixMS: 8_000, Payload: map[string]any{"input": map[string]any{"path": "/private/file"}}},
		{MessageID: "answer", Role: "assistant", Kind: "text", OccurredAtUnixMS: 18_000, Payload: map[string]any{"content": "private answer"}},
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
	}, nil)
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

func TestActivityProjectionClaimsTurnPerformanceOncePerProcess(t *testing.T) {
	projection := NewActivityProjection(nil)
	if !projection.claimTurnPerformanceReport("turn") || projection.claimTurnPerformanceReport("turn") {
		t.Fatal("turn performance report was not deduplicated")
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
			Payload: map[string]any{
				"clientSubmittedAtUnixMs": int64(500), "queued": false,
				"sessionState": "new", "text": "private prompt",
			},
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

	turn, found, err := store.GetTurn(ctx, "ws-performance", "session-1", "turn-1")
	if err != nil || !found {
		t.Fatalf("read settled turn: found=%v error=%v", found, err)
	}
	projection.scheduleAgentTurnPerformance(ctx, "ws-performance", "session-1", turn)
	select {
	case duplicate := <-reporter.events:
		t.Fatalf("duplicate terminal event = %#v", duplicate)
	case <-time.After(50 * time.Millisecond):
	}
}
