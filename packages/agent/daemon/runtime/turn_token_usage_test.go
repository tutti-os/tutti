package agentruntime

import (
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func TestClaudeSDKTurnTokenUsageAccumulatesAcrossAPICalls(t *testing.T) {
	t.Parallel()
	counter := &claudeSDKTurnTokenUsage{}

	// First API call: input reported once, output accumulates per call.
	counter.applyMessageStart(1000)
	counter.applyMessageDelta(120)
	counter.applyMessageDelta(360)
	if input, output := counter.exposed(); input != 1000 || output != 360 {
		t.Fatalf("exposed after first call = (%d, %d), want (1000, 360)", input, output)
	}
	// Deltas are running totals, never additive.
	counter.applyMessageDelta(40)
	if _, output := counter.exposed(); output != 360 {
		t.Fatalf("regressing delta moved output to %d, want max semantics at 360", output)
	}

	// The next API call folds the previous call's output exactly once.
	counter.applyMessageStart(800)
	if input, output := counter.exposed(); input != 1800 || output != 360 {
		t.Fatalf("exposed after fold = (%d, %d), want (1800, 360)", input, output)
	}
	counter.applyMessageDelta(200)
	if input, output := counter.exposed(); input != 1800 || output != 560 {
		t.Fatalf("exposed mid second call = (%d, %d), want (1800, 560)", input, output)
	}

	// A message_start without input tokens still folds and tolerates the gap.
	counter.applyMessageStart(0)
	counter.applyMessageDelta(50)
	if input, output := counter.exposed(); input != 1800 || output != 610 {
		t.Fatalf("exposed after sparse start = (%d, %d), want (1800, 610)", input, output)
	}
}

func TestClaudeSDKTurnTokenUsageFlushThrottleAndFinal(t *testing.T) {
	t.Parallel()
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	// The first message_start flushes immediately so the turn shows counters early.
	input, output, ok := adapter.applyClaudeSDKTurnTokenUsage(adapterSession, "turn-1", map[string]any{
		"messageStart": true,
		"usage":        map[string]any{"input_tokens": 1000},
	})
	if !ok || input != 1000 || output != 0 {
		t.Fatalf("first flush = (%d, %d, %v), want (1000, 0, true)", input, output, ok)
	}
	// Deltas inside the throttle window update silently.
	if _, _, ok := adapter.applyClaudeSDKTurnTokenUsage(adapterSession, "turn-1", map[string]any{
		"usage": map[string]any{"output_tokens": 120},
	}); ok {
		t.Fatal("delta inside throttle window flushed, want suppressed")
	}
	// After the window the running total flushes.
	counter := adapterSession.turnTokenUsage["turn-1"]
	if counter == nil {
		t.Fatal("counter missing after message_start")
	}
	counter.lastFlushAt = time.Now().Add(-2 * tokenUsageFlushInterval)
	input, output, ok = adapter.applyClaudeSDKTurnTokenUsage(adapterSession, "turn-1", map[string]any{
		"usage": map[string]any{"output_tokens": 120},
	})
	if !ok || input != 1000 || output != 120 {
		t.Fatalf("post-window flush = (%d, %d, %v), want (1000, 120, true)", input, output, ok)
	}

	// Result/context payloads never feed the counters.
	if _, _, ok := adapter.applyClaudeSDKTurnTokenUsage(adapterSession, "turn-1", map[string]any{
		"usage":      map[string]any{"output_tokens": 9999},
		"modelUsage": map[string]any{"claude-sonnet-5": map[string]any{"contextWindow": 200000}},
	}); ok {
		t.Fatal("result usage payload produced a flush, want ignored")
	}
	if _, output := counter.exposed(); output != 120 {
		t.Fatalf("result usage moved output to %d, want 120", output)
	}

	// The final flush always fires and retires the counter.
	input, output, ok = adapter.takeClaudeSDKTurnTokenUsageFinal(adapterSession, "turn-1")
	if !ok || input != 1000 || output != 120 {
		t.Fatalf("final flush = (%d, %d, %v), want (1000, 120, true)", input, output, ok)
	}
	if _, _, ok := adapter.takeClaudeSDKTurnTokenUsageFinal(adapterSession, "turn-1"); ok {
		t.Fatal("second final flush reported values, want counter retired")
	}
	// A late delta for the settled turn cannot resurrect the counter.
	if _, _, ok := adapter.applyClaudeSDKTurnTokenUsage(adapterSession, "turn-1", map[string]any{
		"usage": map[string]any{"output_tokens": 500},
	}); ok {
		t.Fatal("late delta resurrected a settled turn counter")
	}
	if adapterSession.turnTokenUsage["turn-1"] != nil {
		t.Fatal("late delta recreated the counter")
	}
}

func TestClaudeSDKTurnTokenUsageSkipsSettledAndForeignPayloads(t *testing.T) {
	t.Parallel()
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		liveState:    newClaudeSDKLiveState(),
		settledTurns: map[string]string{"turn-1": "completed"},
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	if _, _, ok := adapter.applyClaudeSDKTurnTokenUsage(adapterSession, "turn-1", map[string]any{
		"messageStart": true,
		"usage":        map[string]any{"input_tokens": 10},
	}); ok {
		t.Fatal("message_start for a settled turn produced a flush")
	}
	if _, _, ok := adapter.applyClaudeSDKTurnTokenUsage(adapterSession, "turn-2", map[string]any{
		"usage":         map[string]any{"usedTokens": 10},
		"contextWindow": map[string]any{"usedTokens": 10, "totalTokens": 200000},
	}); ok {
		t.Fatal("context-window-only payload produced a flush")
	}
	if len(adapterSession.turnTokenUsage) != 0 {
		t.Fatalf("counters = %#v, want none created", adapterSession.turnTokenUsage)
	}
}

func TestSidecarTurnEventsUsageUpdatedEmitsTurnTokenFlush(t *testing.T) {
	t.Parallel()
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "usage_updated",
		Payload: map[string]any{
			"turnId":       "turn-1",
			"messageStart": true,
			"usage":        map[string]any{"input_tokens": 700},
		},
	})
	if err != nil || terminal {
		t.Fatalf("usage_updated terminal=%v err=%v", terminal, err)
	}
	var flush *activityshared.Event
	for index := range events {
		if events[index].Type == activityshared.EventTurnUpdated {
			flush = &events[index]
		}
	}
	if flush == nil {
		t.Fatalf("events = %#v, want a turn.updated token flush", events)
	}
	if flush.Payload.TurnID != "turn-1" || flush.Payload.TurnPhase != string(activityshared.TurnPhaseWorking) {
		t.Fatalf("flush turn identity = %q/%q", flush.Payload.TurnID, flush.Payload.TurnPhase)
	}
	tokenUsage := payloadMap(flush.Payload.Metadata, "tokenUsage")
	if got := payloadInt64(tokenUsage, "inputTokens"); got != 700 {
		t.Fatalf("flush inputTokens = %d, want 700", got)
	}
	if got := payloadInt64(tokenUsage, "outputTokens"); got != 0 {
		t.Fatalf("flush outputTokens = %d, want 0", got)
	}
}

func TestClaudeSDKFinishTurnLifecycleFlushesBeforeTerminalEvents(t *testing.T) {
	t.Parallel()
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{liveState: newClaudeSDKLiveState()}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	if _, _, ok := adapter.applyClaudeSDKTurnTokenUsage(adapterSession, "turn-1", map[string]any{
		"messageStart": true,
		"usage":        map[string]any{"input_tokens": 500},
	}); !ok {
		t.Fatal("seed message_start did not flush")
	}
	events := adapter.finishClaudeSDKTurnLifecycle(adapterSession, session, "turn-1", claudeSDKTurnFinishCompleted, "")
	if len(events) == 0 || events[0].Type != activityshared.EventTurnUpdated {
		t.Fatalf("finish events = %#v, want the token flush first", events)
	}
	tokenUsage := payloadMap(events[0].Payload.Metadata, "tokenUsage")
	if got := payloadInt64(tokenUsage, "inputTokens"); got != 500 {
		t.Fatalf("final flush inputTokens = %d, want 500", got)
	}
	// The counter retired with the flush; a second finish has nothing to say.
	if again := adapter.finishClaudeSDKTurnLifecycle(adapterSession, session, "turn-1", claudeSDKTurnFinishCompleted, ""); len(again) != 0 {
		t.Fatalf("second finish events = %#v, want none", again)
	}
}

func TestCodexTurnTokenUsageBaselineDiff(t *testing.T) {
	t.Parallel()
	adapter, _, session := startedAppServerAdapter(t)

	tokenParams := func(input int64, output int64, reasoning int64) map[string]any {
		return map[string]any{
			"threadId": "codex-thread-1",
			"tokenUsage": map[string]any{
				"last": map[string]any{"inputTokens": input, "totalTokens": input + output},
				"total": map[string]any{
					"inputTokens":           input,
					"outputTokens":          output,
					"reasoningOutputTokens": reasoning,
					"totalTokens":           input + output + reasoning,
				},
				"modelContextWindow": int64(272000),
			},
		}
	}

	// Prior thread history sets the cumulative totals before the turn starts.
	if _, _, ok := adapter.applyTokenUsage(session.AgentSessionID, "", tokenParams(1000, 200, 50)); ok {
		t.Fatal("turn-less token usage produced a flush")
	}
	adapter.snapshotCodexTurnTokenBaseline(session.AgentSessionID, "turn-1", "codex-thread-1")

	input, output, ok := adapter.applyTokenUsage(session.AgentSessionID, "turn-1", tokenParams(1600, 500, 100))
	if !ok || input != 600 || output != 350 {
		t.Fatalf("first diff flush = (%d, %d, %v), want (600, 350, true): output must include reasoning", input, output, ok)
	}
	if _, _, ok := adapter.applyTokenUsage(session.AgentSessionID, "turn-1", tokenParams(2000, 900, 100)); ok {
		t.Fatal("second notification inside the throttle window flushed")
	}

	appSession := adapter.getSession(session.AgentSessionID)
	counter := appSession.turnTokenUsage["turn-1"]
	if counter == nil {
		t.Fatal("turn counter missing")
	}
	counter.lastFlushAt = time.Now().Add(-2 * tokenUsageFlushInterval)
	input, output, ok = adapter.applyTokenUsage(session.AgentSessionID, "turn-1", tokenParams(2000, 900, 100))
	if !ok || input != 1000 || output != 750 {
		t.Fatalf("post-window flush = (%d, %d, %v), want (1000, 750, true)", input, output, ok)
	}

	input, output, ok = adapter.takeCodexTurnTokenUsageFinal(session.AgentSessionID, "turn-1")
	if !ok || input != 1000 || output != 750 {
		t.Fatalf("final flush = (%d, %d, %v), want (1000, 750, true)", input, output, ok)
	}
	if _, _, ok := adapter.takeCodexTurnTokenUsageFinal(session.AgentSessionID, "turn-1"); ok {
		t.Fatal("second final flush reported values, want counter retired")
	}
}

func TestCodexTurnTokenUsageClampsNegativeDiffOnStaleBaseline(t *testing.T) {
	t.Parallel()
	adapter, _, session := startedAppServerAdapter(t)

	totalParams := func(input int64, output int64) map[string]any {
		return map[string]any{
			"threadId": "codex-thread-1",
			"tokenUsage": map[string]any{
				"total": map[string]any{"inputTokens": input, "outputTokens": output},
			},
		}
	}

	adapter.snapshotCodexTurnTokenBaseline(session.AgentSessionID, "turn-1", "codex-thread-1")
	if _, _, ok := adapter.applyTokenUsage(session.AgentSessionID, "turn-1", totalParams(5000, 800)); !ok {
		t.Fatal("first total did not flush")
	}
	// A replayed/resumed thread reports lower cumulative totals than the
	// recorded baseline: reset the baseline and clamp the diff at zero.
	input, output, ok := adapter.takeCodexTurnTokenUsageFinal(session.AgentSessionID, "turn-1")
	if !ok || input != 5000 || output != 800 {
		t.Fatalf("pre-replay final = (%d, %d, %v), want (5000, 800, true)", input, output, ok)
	}

	adapter.snapshotCodexTurnTokenBaseline(session.AgentSessionID, "turn-2", "codex-thread-1")
	if _, _, ok := adapter.applyTokenUsage(session.AgentSessionID, "turn-2", totalParams(4000, 700)); !ok {
		t.Fatal("replayed lower total did not flush")
	}
	input, output, ok = adapter.takeCodexTurnTokenUsageFinal(session.AgentSessionID, "turn-2")
	if !ok || input != 0 || output != 0 {
		t.Fatalf("stale baseline diff = (%d, %d, %v), want clamped (0, 0, true)", input, output, ok)
	}
}

func TestCodexTurnTokenUsageLazyBaselineSkipsEarlierThreadHistory(t *testing.T) {
	t.Parallel()
	adapter, _, session := startedAppServerAdapter(t)

	params := func(input int64, output int64) map[string]any {
		return map[string]any{
			"threadId": "codex-thread-1",
			"tokenUsage": map[string]any{
				"total": map[string]any{"inputTokens": input, "outputTokens": output},
			},
		}
	}

	// No turn/started baseline: the first observed total becomes the baseline
	// instead of double counting earlier turns on the same thread.
	input, output, ok := adapter.applyTokenUsage(session.AgentSessionID, "turn-lazy", params(9000, 400))
	if !ok || input != 0 || output != 0 {
		t.Fatalf("lazy baseline first flush = (%d, %d, %v), want (0, 0, true)", input, output, ok)
	}
	appSession := adapter.getSession(session.AgentSessionID)
	appSession.turnTokenUsage["turn-lazy"].lastFlushAt = time.Now().Add(-2 * tokenUsageFlushInterval)
	input, output, ok = adapter.applyTokenUsage(session.AgentSessionID, "turn-lazy", params(9600, 500))
	if !ok || input != 600 || output != 100 {
		t.Fatalf("lazy baseline diff = (%d, %d, %v), want (600, 100, true)", input, output, ok)
	}
}

func TestStatePatchFromSessionEventMapsTokenUsage(t *testing.T) {
	t.Parallel()
	session := Session{
		RoomID: "room-1", AgentSessionID: "agent-1", Provider: ProviderClaudeCode,
		ProviderSessionID: "claude-1",
	}
	event := newTurnActivityEvent(session, EventTurnUpdated, "turn-1", SessionStatusWorking, "", "", map[string]any{
		// JSON-decoded metadata arrives as float64 numbers; the mapping must
		// decode them defensively.
		"tokenUsage": map[string]any{"inputTokens": float64(1200), "outputTokens": float64(340)},
	})
	patch, ok := statePatchFromSessionEvent(canonical.EventSource{Provider: ProviderClaudeCode}, event, "agent-1", 100)
	if !ok || patch.Turn == nil {
		t.Fatalf("turn.updated patch = %#v, want a turn patch", patch)
	}
	if patch.Turn.TokenUsage == nil || patch.Turn.TokenUsage.InputTokens != 1200 || patch.Turn.TokenUsage.OutputTokens != 340 {
		t.Fatalf("patch token usage = %#v, want {1200 340}", patch.Turn.TokenUsage)
	}
}
