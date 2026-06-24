package agentruntime

import (
	"reflect"
	"testing"
)

// appServerUserInputAnswers is the codex-specific translation of the GUI's
// interactive answer payload into codex's requestUserInput response. The GUI
// contract (packages/agent/gui shared/agentConversation/interactiveAnswerPayload.ts)
// keys answers under answersByQuestionId; `answers` is only a flat display list.
// These cases pin that contract so the adapter can't silently drift back to
// reading the wrong field (the bug that made codex ignore the user's choice).
func TestAppServerUserInputAnswers(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name      string
		params    map[string]any
		selection pendingACPResponse
		want      map[string]any
	}{
		{
			name: "canonical single-select from answersByQuestionId",
			selection: pendingACPResponse{
				payload: map[string]any{
					"answers":             []any{"Health check"},
					"answersByQuestionId": map[string]any{"plan-kind": "Health check"},
				},
			},
			want: map[string]any{
				"plan-kind": map[string]any{"answers": []string{"Health check"}},
			},
		},
		{
			name: "multi-select values preserved",
			selection: pendingACPResponse{
				payload: map[string]any{
					"answersByQuestionId": map[string]any{"areas": []any{"A", "B"}},
				},
			},
			want: map[string]any{
				"areas": map[string]any{"answers": []string{"A", "B"}},
			},
		},
		{
			name: "legacy answers-as-map still accepted",
			selection: pendingACPResponse{
				payload: map[string]any{
					"answers": map[string]any{"q1": "postgres"},
				},
			},
			want: map[string]any{
				"q1": map[string]any{"answers": []string{"postgres"}},
			},
		},
		{
			name:   "falls back to optionId keyed by the request's questions",
			params: map[string]any{"questions": []any{map[string]any{"id": "q1"}}},
			selection: pendingACPResponse{
				optionID: "Renderer A",
				payload:  map[string]any{},
			},
			want: map[string]any{
				"q1": map[string]any{"answers": []string{"Renderer A"}},
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := appServerUserInputAnswers(tc.params, tc.selection)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("appServerUserInputAnswers = %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestAppServerUserInputIncludesSkillAndMentionItems(t *testing.T) {
	t.Parallel()

	got := appServerUserInput([]PromptContentBlock{
		{Type: "text", Text: "use these"},
		{Type: "skill", Name: "review", Path: "/tmp/review/SKILL.md"},
		{Type: "mention", Name: "GitHub", Path: "app://github"},
	})
	want := []map[string]any{
		{"type": "text", "text": "use these"},
		{"type": "skill", "name": "review", "path": "/tmp/review/SKILL.md"},
		{"type": "mention", "name": "GitHub", "path": "app://github"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("appServerUserInput = %#v, want %#v", got, want)
	}
}

// TestCodexAppServerAdapterApplyTokenUsagePrefersLastRequest verifies that
// usedTokens reflects the most-recent request's context size ("last"), not the
// running sum across all requests in the thread ("total").  The two diverge
// quickly in agentic sessions: after ten 27 K-token calls the cumulative total
// hits 270 K and falsely saturates a 258 K context window even though each
// individual request was only 10 % full.
// TestCodexAppServerAdapterApplyTokenUsagePrefersInputTokens verifies the
// precedence chain: last.inputTokens > last.totalTokens > total.totalTokens.
// last.inputTokens is the most accurate context-fill indicator because it
// excludes response and reasoning tokens that don't occupy the context window.
func TestCodexAppServerAdapterApplyTokenUsagePrefersInputTokens(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	adapter.applyTokenUsage(session.AgentSessionID, map[string]any{
		"tokenUsage": map[string]any{
			"last": map[string]any{
				"inputTokens":           int64(1000),
				"outputTokens":          int64(150),
				"reasoningOutputTokens": int64(50),
				"totalTokens":           int64(1200),
			},
			"total":              map[string]any{"totalTokens": int64(4800)},
			"modelContextWindow": int64(272000),
		},
	})

	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if used, _ := acpInt64Value(contextWindow["usedTokens"]); used != 1000 {
		t.Fatalf("usedTokens = %v, want last.inputTokens (1000): context fill should exclude response/reasoning tokens", used)
	}
}

// TestCodexAppServerAdapterApplyTokenUsageFallsBackToLastTotalTokens verifies
// that last.totalTokens is used when last.inputTokens is absent — the schema
// guarantees totalTokens is always present in a TokenUsageBreakdown.
func TestCodexAppServerAdapterApplyTokenUsageFallsBackToLastTotalTokens(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	adapter.applyTokenUsage(session.AgentSessionID, map[string]any{
		"tokenUsage": map[string]any{
			"last":               map[string]any{"totalTokens": int64(1200)},
			"total":              map[string]any{"totalTokens": int64(4800)},
			"modelContextWindow": int64(272000),
		},
	})

	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if used, _ := acpInt64Value(contextWindow["usedTokens"]); used != 1200 {
		t.Fatalf("usedTokens = %v, want last.totalTokens (1200), not cumulative total (4800)", used)
	}
}

// TestCodexAppServerAdapterApplyTokenUsageCompactFrameUsesLastTotalTokens
// reproduces the post-compaction frame Codex app-server emits: last.inputTokens
// is explicitly 0 while last.totalTokens carries the real compacted context size
// (summary). The display must show the compacted size, not 0. (Captured live:
// seed last.inputTokens=26017 -> compact last.inputTokens=0/totalTokens=5763.)
func TestCodexAppServerAdapterApplyTokenUsageCompactFrameUsesLastTotalTokens(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)

	// Seed turn: window is full at 26017.
	adapter.applyTokenUsage(session.AgentSessionID, map[string]any{
		"tokenUsage": map[string]any{
			"last":               map[string]any{"inputTokens": int64(26017), "totalTokens": int64(26049)},
			"total":              map[string]any{"totalTokens": int64(26049)},
			"modelContextWindow": int64(258400),
		},
	})

	// Compact frame: inputTokens is explicitly 0, totalTokens=5763 is the real
	// post-compaction context size.
	adapter.applyTokenUsage(session.AgentSessionID, map[string]any{
		"tokenUsage": map[string]any{
			"last":               map[string]any{"inputTokens": int64(0), "totalTokens": int64(5763)},
			"total":              map[string]any{"totalTokens": int64(26049)},
			"modelContextWindow": int64(258400),
		},
	})

	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	if used, _ := acpInt64Value(contextWindow["usedTokens"]); used != 5763 {
		t.Fatalf("usedTokens = %v, want post-compact last.totalTokens (5763); a literal 0 inputTokens must not be shown as the context fill", used)
	}
}

// TestCodexAppServerAdapterApplyTokenUsageNoCumulativeFalsePositive verifies
// that repeated calls with the same per-request size do not inflate usedTokens
// beyond the context window, which would falsely trigger the compact alert.
func TestCodexAppServerAdapterApplyTokenUsageNoCumulativeFalsePositive(t *testing.T) {
	t.Parallel()

	adapter, _, session := startedAppServerAdapter(t)
	window := int64(258400)
	perRequest := int64(27000)

	// Simulate 10 tool calls, each sending ~27 K tokens.  The cumulative total
	// grows to 270 K (> window), but the per-request "last" stays at 27 K.
	for i := range 10 {
		adapter.applyTokenUsage(session.AgentSessionID, map[string]any{
			"tokenUsage": map[string]any{
				"last":               map[string]any{"totalTokens": perRequest},
				"total":              map[string]any{"totalTokens": perRequest * int64(i+1)},
				"modelContextWindow": window,
			},
		})
	}

	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)
	used, _ := acpInt64Value(contextWindow["usedTokens"])
	total, _ := acpInt64Value(contextWindow["totalTokens"])
	if used > total {
		t.Fatalf("usedTokens (%d) > totalTokens (%d): cumulative sum is leaking into context-window display", used, total)
	}
	if used != perRequest {
		t.Fatalf("usedTokens = %d, want per-request last (%d)", used, perRequest)
	}
}
