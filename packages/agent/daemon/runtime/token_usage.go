package agentruntime

// runtimeTokenUsage is the provider-neutral breakdown for the most recent
// model request. Context-window fill and account quota remain separate: the
// former is not a reliable substitute for billable run usage.
type runtimeTokenUsage struct {
	inputTokens      int64
	outputTokens     int64
	cacheReadTokens  int64
	cacheWriteTokens int64
	known            bool
}

func runtimeTokenUsageFromPayload(payload map[string]any) runtimeTokenUsage {
	if len(payload) == 0 {
		return runtimeTokenUsage{}
	}
	usage := payload
	if nested := payloadObject(payload["usage"]); len(nested) > 0 {
		usage = nested
	}
	if nested := payloadObject(usage["last"]); len(nested) > 0 {
		usage = nested
	}
	input, inputOK := firstInt64Value(usage, "inputTokens", "input_tokens")
	output, outputOK := firstInt64Value(usage, "outputTokens", "output_tokens")
	cacheRead, cacheReadOK := firstInt64Value(usage,
		"cacheReadTokens",
		"cache_read_tokens",
		"cachedInputTokens",
		"cached_input_tokens",
		"cacheReadInputTokens",
		"cache_read_input_tokens",
	)
	cacheWrite, cacheWriteOK := firstInt64Value(usage,
		"cacheWriteTokens",
		"cache_write_tokens",
		"cacheCreationInputTokens",
		"cache_creation_input_tokens",
	)
	if !inputOK && !outputOK && !cacheReadOK && !cacheWriteOK {
		return runtimeTokenUsage{}
	}
	return runtimeTokenUsage{
		inputTokens:      maxRuntimeTokenCount(input),
		outputTokens:     maxRuntimeTokenCount(output),
		cacheReadTokens:  maxRuntimeTokenCount(cacheRead),
		cacheWriteTokens: maxRuntimeTokenCount(cacheWrite),
		known:            true,
	}
}

func (usage runtimeTokenUsage) runtimeContextFields() map[string]any {
	if !usage.known {
		return nil
	}
	return map[string]any{
		"inputTokens":      usage.inputTokens,
		"outputTokens":     usage.outputTokens,
		"cacheReadTokens":  usage.cacheReadTokens,
		"cacheWriteTokens": usage.cacheWriteTokens,
	}
}

func maxRuntimeTokenCount(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}
