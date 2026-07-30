package agentruntime

func appendClaudeSDKRetryDiagnostics(args []any, payload map[string]any) []any {
	if payloadBoolValue(payload, "apiRetry") {
		args = append(args, "api_retry", true)
	}
	if payloadBoolValue(payload, "sdkConnectionError") {
		args = append(args, "sdk_connection_error", true)
	}
	if retryAttempt := payloadInt64(payload, "sdkRetryAttempt"); retryAttempt > 0 {
		args = append(args, "sdk_retry_attempt", retryAttempt)
	}
	if maxRetries := payloadInt64(payload, "sdkMaxRetries"); maxRetries > 0 {
		args = append(args, "sdk_max_retries", maxRetries)
	}
	if retryDelayMS := payloadInt64(payload, "sdkRetryDelayMs"); retryDelayMS > 0 {
		args = append(args, "sdk_retry_delay_ms", retryDelayMS)
	}
	return args
}
