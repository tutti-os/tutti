package turn_performance

import (
	"reflect"
	"sort"
	"testing"
)

func TestBuildParamsUsesContentFreeWhitelist(t *testing.T) {
	params := BuildParams(Input{
		HadLongIdle: true, HadToolCall: true, MaxIdleMS: 12_000,
		Model: "gpt-5", Outcome: "success", Provider: "codex",
		SessionState: "new", TimingStartSource: "client_submit",
		TokenUsageAvailable: false, TotalDurationMS: 20_000,
	})
	got := make([]string, 0, len(params))
	for key := range params {
		got = append(got, key)
	}
	sort.Strings(got)
	want := []string{
		"first_progress_ms", "had_long_idle", "had_reconnect", "had_retry",
		"had_tool_call", "max_idle_ms", "model", "outcome", "provider",
		"reconnect_count", "retry_count", "session_state", "timing_start_source",
		"token_usage_available", "tool_call_count", "total_duration_ms", "ttft_ms",
		"was_queued",
	}
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parameter keys = %v, want strict whitelist %v", got, want)
	}
	for _, forbidden := range []string{
		"prompt", "response", "content", "thinking", "path", "command",
		"tool_arguments", "url", "workspace_id", "agent_session_id", "turn_id",
	} {
		if _, ok := params[forbidden]; ok {
			t.Fatalf("forbidden parameter %q present", forbidden)
		}
	}
	if _, ok := params["input_tokens"]; ok {
		t.Fatal("unavailable token count must be omitted")
	}
}

func TestBuildParamsIncludesReliableTurnTokensOnly(t *testing.T) {
	inputTokens, outputTokens := int64(12), int64(3)
	params := BuildParams(Input{
		TokenUsageAvailable: true,
		InputTokens:         &inputTokens,
		OutputTokens:        &outputTokens,
	})
	if params["input_tokens"] != int64(12) || params["output_tokens"] != int64(3) {
		t.Fatalf("token parameters = %#v", params)
	}
}
