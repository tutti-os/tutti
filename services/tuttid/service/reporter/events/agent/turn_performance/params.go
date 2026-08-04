package turn_performance

import "strings"

// Input is deliberately content-free. Keep BuildParams as the only event
// boundary so prompt text, response text, paths, commands, URLs, and opaque
// runtime payloads cannot accidentally enter analytics.
type Input struct {
	FirstProgressMS     *int64
	HadLongIdle         bool
	HadReconnect        *bool
	HadRetry            *bool
	HadToolCall         bool
	MaxIdleMS           int64
	Model               string
	Outcome             string
	Provider            string
	ReconnectCount      *int64
	RetryCount          *int64
	SessionState        string
	TTFTMS              *int64
	TimingStartSource   string
	TokenUsageAvailable bool
	ToolCallCount       *int64
	TotalDurationMS     int64
	WasQueued           *bool
	InputTokens         *int64
	OutputTokens        *int64
}

func BuildParams(input Input) Params {
	params := Params{
		"first_progress_ms":     nullableInt64(input.FirstProgressMS),
		"had_long_idle":         input.HadLongIdle,
		"had_reconnect":         nullableBool(input.HadReconnect),
		"had_retry":             nullableBool(input.HadRetry),
		"had_tool_call":         input.HadToolCall,
		"max_idle_ms":           nonNegative(input.MaxIdleMS),
		"model":                 normalizedDimension(input.Model, "unknown"),
		"outcome":               normalizedDimension(input.Outcome, "failure"),
		"provider":              normalizedDimension(input.Provider, "unknown"),
		"reconnect_count":       nullableInt64(input.ReconnectCount),
		"retry_count":           nullableInt64(input.RetryCount),
		"session_state":         normalizedDimension(input.SessionState, "unknown"),
		"timing_start_source":   normalizedDimension(input.TimingStartSource, "canonical_turn"),
		"token_usage_available": input.TokenUsageAvailable,
		"tool_call_count":       nullableInt64(input.ToolCallCount),
		"total_duration_ms":     nonNegative(input.TotalDurationMS),
		"ttft_ms":               nullableInt64(input.TTFTMS),
		"was_queued":            nullableBool(input.WasQueued),
	}
	if input.TokenUsageAvailable && input.InputTokens != nil && input.OutputTokens != nil {
		params["input_tokens"] = nonNegative(*input.InputTokens)
		params["output_tokens"] = nonNegative(*input.OutputTokens)
	}
	return params
}

func normalizedDimension(value string, fallback string) string {
	if value = strings.TrimSpace(value); value != "" {
		return value
	}
	return fallback
}

func nullableInt64(value *int64) any {
	if value == nil {
		return nil
	}
	return nonNegative(*value)
}

func nullableBool(value *bool) any {
	if value == nil {
		return nil
	}
	return *value
}

func nonNegative(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}
