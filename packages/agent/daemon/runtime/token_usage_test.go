package agentruntime

import "testing"

func TestAppServerTokenUsageStateKeepsNormalizedRequestBreakdown(t *testing.T) {
	state, ok := appServerTokenUsageState(map[string]any{
		"tokenUsage": map[string]any{
			"last": map[string]any{
				"inputTokens":       int64(1_000),
				"outputTokens":      int64(200),
				"cachedInputTokens": int64(300),
			},
			"modelContextWindow": int64(200_000),
		},
	})
	if !ok {
		t.Fatal("appServerTokenUsageState() ok = false")
	}
	if !state.tokens.known || state.tokens.inputTokens != 700 || state.tokens.outputTokens != 200 || state.tokens.cacheReadTokens != 300 {
		t.Fatalf("tokens = %#v, want uncached input plus separate cache read", state.tokens)
	}
	context := acpUsageRuntimeContext(state)
	if context["inputTokens"] != int64(700) || context["cacheReadTokens"] != int64(300) {
		t.Fatalf("runtime context = %#v", context)
	}
}

func TestClaudeSDKUsageUpdateKeepsCacheBreakdown(t *testing.T) {
	update := claudeSDKUsageUpdate(map[string]any{
		"usage": map[string]any{
			"input_tokens":                int64(100),
			"output_tokens":               int64(20),
			"cache_read_input_tokens":     int64(30),
			"cache_creation_input_tokens": int64(40),
		},
		"modelContextWindow": int64(200_000),
	}, claudeSDKUsageState{}, "claude-test")
	state, ok := claudeSDKUsageStateFromPayload(update)
	if !ok {
		t.Fatal("claudeSDKUsageStateFromPayload() ok = false")
	}
	if !state.tokens.known || state.tokens.inputTokens != 100 || state.tokens.outputTokens != 20 || state.tokens.cacheReadTokens != 30 || state.tokens.cacheWriteTokens != 40 {
		t.Fatalf("tokens = %#v", state.tokens)
	}
}
