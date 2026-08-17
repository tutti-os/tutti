package agentruntime

import "encoding/json"

func payloadInt64(payload map[string]any, key string) int64 {
	switch value := payload[key].(type) {
	case int64:
		return value
	case int:
		return int64(value)
	case float64:
		return int64(value)
	case json.Number:
		result, _ := value.Int64()
		return result
	default:
		return 0
	}
}

func isClaudeSDKTerminalEvent(eventType string) bool {
	switch eventType {
	case "turn_completed", "turn_canceled", "turn_failed",
		"goal_command_canceled", "goal_command_superseded":
		return true
	default:
		return false
	}
}

func claudeSDKSidecarTurnTerminal(eventType string) bool {
	switch eventType {
	case "turn_completed", "turn_canceled", "turn_failed":
		return true
	default:
		return false
	}
}

func validClaudeSDKCancelDispatchPhase(phase string) bool {
	switch phase {
	case "queued", "dispatched", "provider_observed", "resolving_identity",
		"identity_resolved", "streaming", "waiting_approval", "waiting_input",
		"running_tool", "terminal", "pending_goal", "unknown":
		return true
	default:
		return false
	}
}
