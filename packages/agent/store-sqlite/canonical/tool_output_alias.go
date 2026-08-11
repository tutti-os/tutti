package canonical

import "strings"

type terminalCommandAliasMode uint8

const (
	terminalCommandAliasInspect terminalCommandAliasMode = iota
	terminalCommandAliasDelete
	terminalCommandAliasTombstone
)

var terminalCommandTokenReplacer = strings.NewReplacer(
	"_", "",
	"-", "",
	" ", "",
	".", "",
)

// CompactTerminalCommandOutputAliases removes only display text that is
// exactly reconstructible from a terminal command's canonical stdout or
// stderr. Running command bodies retain text because live tool-output deltas
// use it; terminal nested steps are evaluated by their own status. Non-command
// tools retain text as their provider-neutral display contract. The payload is
// mutated in place and the return value reports whether it changed.
func CompactTerminalCommandOutputAliases(
	status string,
	payload map[string]any,
) bool {
	_, changed := transformTerminalCommandOutputAliases(
		status,
		payload,
		terminalCommandAliasDelete,
	)
	return changed
}

// TombstoneTerminalCommandOutputAliases replaces reconstructible display text
// with nil before a reporter truncates or merges the payload. The explicit nil
// clears an earlier running output.text during the canonical deep merge; normal
// compaction then removes the tombstone before persistence.
func TombstoneTerminalCommandOutputAliases(
	status string,
	payload map[string]any,
) bool {
	_, changed := transformTerminalCommandOutputAliases(
		status,
		payload,
		terminalCommandAliasTombstone,
	)
	return changed
}

// HasTerminalCommandOutput reports whether the payload contains a root or
// nested command whose own effective status is terminal. It does not mutate
// the payload.
func HasTerminalCommandOutput(status string, payload map[string]any) bool {
	found, _ := transformTerminalCommandOutputAliases(
		status,
		payload,
		terminalCommandAliasInspect,
	)
	return found
}

func transformTerminalCommandOutputAliases(
	status string,
	payload map[string]any,
	mode terminalCommandAliasMode,
) (bool, bool) {
	if len(payload) == 0 {
		return false, false
	}

	found := false
	changed := false
	input := firstToolMapReference(payload["input"])
	if isTerminalToolStatus(status) && isTerminalCommandPayload(payload, input) {
		found = true
		changed = transformTerminalCommandBodyAlias(payload["output"], mode) || changed
		changed = transformTerminalCommandBodyAlias(payload["error"], mode) || changed
	}

	for _, value := range []any{
		payload["steps"],
		toolMapValue(payload["output"], "steps"),
		toolMapValue(payload["error"], "steps"),
		toolMapValue(payload["metadata"], "steps"),
	} {
		stepFound, stepChanged := transformTerminalCommandSteps(status, value, mode)
		found = stepFound || found
		changed = stepChanged || changed
	}
	return found, changed
}

func transformTerminalCommandSteps(
	parentStatus string,
	value any,
	mode terminalCommandAliasMode,
) (bool, bool) {
	steps, _ := value.([]any)
	found := false
	changed := false
	for _, item := range steps {
		step, _ := item.(map[string]any)
		if len(step) == 0 {
			continue
		}
		stepPayload := firstToolMapReference(step["payload"])
		stepStatus := firstToolString(
			step["status"],
			toolMapValue(step["toolResult"], "status"),
			toolMapValue(step["tool_result"], "status"),
			toolMapValue(step["toolError"], "status"),
			toolMapValue(step["tool_error"], "status"),
			stepPayload["status"],
			parentStatus,
		)
		stepInput := firstToolMapReference(
			step["toolInput"],
			step["tool_input"],
			step["input"],
			stepPayload["input"],
		)
		if isTerminalToolStatus(stepStatus) &&
			isTerminalCommandPayloadPair(step, stepPayload, stepInput) {
			found = true
			for _, body := range []any{
				step["toolResult"],
				step["tool_result"],
				step["toolError"],
				step["tool_error"],
				step["output"],
				step["error"],
				stepPayload["output"],
				stepPayload["error"],
			} {
				changed = transformTerminalCommandBodyAlias(body, mode) || changed
			}
		}

		for _, nested := range []any{
			step["steps"],
			toolMapValue(step["metadata"], "steps"),
			toolMapValue(step["toolResult"], "steps"),
			toolMapValue(step["tool_result"], "steps"),
			toolMapValue(step["toolError"], "steps"),
			toolMapValue(step["tool_error"], "steps"),
			stepPayload["steps"],
			toolMapValue(stepPayload["metadata"], "steps"),
			toolMapValue(stepPayload["output"], "steps"),
			toolMapValue(stepPayload["error"], "steps"),
		} {
			nestedFound, nestedChanged := transformTerminalCommandSteps(
				stepStatus,
				nested,
				mode,
			)
			found = nestedFound || found
			changed = nestedChanged || changed
		}
	}
	return found, changed
}

func isTerminalCommandPayload(payload, input map[string]any) bool {
	return isTerminalCommandPayloadPair(payload, nil, input)
}

func isTerminalCommandPayloadPair(
	primary, fallback, input map[string]any,
) bool {
	for _, payload := range []map[string]any{primary, fallback} {
		if command, present := explicitTerminalCommandIdentity(payload); present {
			return command
		}
	}
	for _, payload := range []map[string]any{primary, fallback} {
		if hasExplicitNonCommandTransport(payload) {
			return false
		}
	}
	for _, payload := range []map[string]any{primary, fallback} {
		metadata := firstToolMapReference(payload["metadata"])
		for _, value := range []any{
			payload["name"],
			payload["activityKind"],
			metadata["kind"],
		} {
			if isTerminalCommandToken(value) {
				return true
			}
		}
	}
	if len(input) > 0 && firstToolString(input["command"], input["cmd"]) != "" {
		return true
	}
	return firstToolString(primary["command"], fallback["command"]) != ""
}

func explicitTerminalCommandIdentity(payload map[string]any) (bool, bool) {
	if len(payload) == 0 {
		return false, false
	}
	metadata := firstToolMapReference(payload["metadata"])
	for _, value := range []any{
		payload["toolName"],
		metadata["toolName"],
		metadata["tool"],
	} {
		if firstToolString(value) == "" {
			continue
		}
		return isTerminalCommandToken(value), true
	}
	return false, false
}

func hasExplicitNonCommandTransport(payload map[string]any) bool {
	if len(payload) == 0 {
		return false
	}
	if strings.EqualFold(firstToolString(payload["callType"]), "mcp") {
		return true
	}
	metadata := firstToolMapReference(payload["metadata"])
	return firstToolString(
		metadata["server"],
		metadata["serverName"],
		metadata["mcpServer"],
	) != ""
}

func isTerminalCommandToken(value any) bool {
	token := strings.ToLower(toolString(value))
	token = terminalCommandTokenReplacer.Replace(token)
	switch token {
	case "bash", "exec", "execcommand", "runcommand", "runshellcommand", "shell", "shellcommand", "terminal", "commandexecution", "executecommand":
		return true
	default:
		return false
	}
}

func transformTerminalCommandBodyAlias(
	value any,
	mode terminalCommandAliasMode,
) bool {
	body, _ := value.(map[string]any)
	if body == nil {
		return false
	}
	text, ok := body["text"].(string)
	if !ok {
		return false
	}
	for _, key := range []string{"stdout", "stderr"} {
		stream, ok := body[key].(string)
		if !ok || text != strings.TrimSpace(stream) {
			continue
		}
		switch mode {
		case terminalCommandAliasDelete:
			delete(body, "text")
		case terminalCommandAliasTombstone:
			body["text"] = nil
		}
		return mode != terminalCommandAliasInspect
	}
	return false
}

func compactTerminalCommandBodyAlias(value any) bool {
	return transformTerminalCommandBodyAlias(
		value,
		terminalCommandAliasDelete,
	)
}

func firstToolMapReference(values ...any) map[string]any {
	for _, value := range values {
		if typed, ok := value.(map[string]any); ok && len(typed) > 0 {
			return typed
		}
	}
	return nil
}

func toolMapValue(value any, key string) any {
	valueMap, _ := value.(map[string]any)
	if valueMap == nil {
		return nil
	}
	return valueMap[key]
}

func isTerminalToolStatus(status string) bool {
	return isCompletedToolStatus(status) || isFailedToolStatus(status)
}
