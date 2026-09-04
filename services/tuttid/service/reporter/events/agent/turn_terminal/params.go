package turn_terminal

import "strings"

const (
	unknownErrorCode = "agent_unknown_error"

	AgentConfigSourceAgentTarget    = "agent_target"
	AgentConfigSourceUnknown        = "unknown"
	AgentConfigSourceWorkspaceAgent = "workspace_agent"
	ModelConfigSourceModelPlan      = "model_plan"
	ModelConfigSourceProviderNative = "provider_native"
	ModelConfigSourceUnknown        = "unknown"
	TuttiModeStateActive            = "active"
	TuttiModeStateInactive          = "inactive"
	TuttiModeStateUnknown           = "unknown"
)

type Input struct {
	AgentSessionID    string
	AgentConfigSource string
	ClientSubmitID    string
	ErrorCode         string
	Mode              string
	ModelConfigSource string
	TuttiModeState    string
	Outcome           string
	Origin            string
	Provider          string
	StartupReconciled bool
	StartedAtUnixMS   int64
	SettledAtUnixMS   int64
	TurnID            string
}

func Build(input Input) (string, Params, bool) {
	mode := strings.TrimSpace(input.Mode)
	if mode != "os" && mode != "agent" {
		return "", nil, false
	}
	outcome := strings.TrimSpace(input.Outcome)
	eventName, status := terminalEvent(outcome)
	if eventName == "" {
		return "", nil, false
	}
	provider := strings.TrimSpace(input.Provider)
	if provider == "" {
		provider = "unknown"
	}
	turnID := strings.TrimSpace(input.TurnID)
	params := Params{
		"agent_config_source": normalizeAgentConfigSource(input.AgentConfigSource),
		"agent_kind":          "local-agent",
		"agent_session_id":    strings.TrimSpace(input.AgentSessionID),
		"client_submit_id":    strings.TrimSpace(input.ClientSubmitID),
		"event_source":        "canonical_turn_settled",
		"interaction_source":  "user",
		"invocation_id":       turnID,
		"is_child_session":    false,
		"mode":                mode,
		"model_config_source": normalizeModelConfigSource(input.ModelConfigSource),
		"operation_id":        turnID,
		"provider":            provider,
		"startup_reconciled":  input.StartupReconciled,
		"status":              status,
		"surface":             "direct_session",
		"tutti_mode_state":    normalizeTuttiModeState(input.TuttiModeState),
		"turn_id":             turnID,
		"turn_origin":         strings.TrimSpace(input.Origin),
		"turn_outcome":        outcome,
		"viewer_relationship": "self",
		"viewer_role":         "owner",
	}
	if durationMS, ok := terminalDuration(input.StartedAtUnixMS, input.SettledAtUnixMS); ok {
		params["duration_ms"] = durationMS
		params["duration_bucket"] = durationBucket(durationMS)
	}
	switch eventName {
	case EventCompleted:
		params["value_enum"] = "completed"
	case EventFailed:
		params["error_category"] = "runtime"
		params["error_code"] = safeErrorCode(input.ErrorCode)
		params["failure_stage"] = "settled"
	case EventCancelled:
		if input.StartupReconciled {
			params["source"] = "startup_reconciliation"
		} else {
			params["source"] = "runtime_event"
		}
	}
	return eventName, params, true
}

func normalizeTuttiModeState(value string) string {
	switch strings.TrimSpace(value) {
	case TuttiModeStateActive:
		return TuttiModeStateActive
	case TuttiModeStateInactive:
		return TuttiModeStateInactive
	default:
		return TuttiModeStateUnknown
	}
}

func normalizeAgentConfigSource(value string) string {
	switch strings.TrimSpace(value) {
	case AgentConfigSourceAgentTarget:
		return AgentConfigSourceAgentTarget
	case AgentConfigSourceWorkspaceAgent:
		return AgentConfigSourceWorkspaceAgent
	default:
		return AgentConfigSourceUnknown
	}
}

func normalizeModelConfigSource(value string) string {
	switch strings.TrimSpace(value) {
	case ModelConfigSourceModelPlan:
		return ModelConfigSourceModelPlan
	case ModelConfigSourceProviderNative:
		return ModelConfigSourceProviderNative
	default:
		return ModelConfigSourceUnknown
	}
}

func terminalEvent(outcome string) (string, string) {
	switch outcome {
	case "completed":
		return EventCompleted, "completed"
	case "failed":
		return EventFailed, "failed"
	case "canceled", "interrupted":
		return EventCancelled, "cancelled"
	default:
		return "", ""
	}
}

func terminalDuration(startedAtUnixMS, settledAtUnixMS int64) (int64, bool) {
	if startedAtUnixMS <= 0 || settledAtUnixMS < startedAtUnixMS {
		return 0, false
	}
	return settledAtUnixMS - startedAtUnixMS, true
}

func durationBucket(durationMS int64) string {
	switch {
	case durationMS < 1_000:
		return "lt_1s"
	case durationMS < 3_000:
		return "1s_to_3s"
	case durationMS < 10_000:
		return "3s_to_10s"
	case durationMS < 30_000:
		return "10s_to_30s"
	case durationMS < 60_000:
		return "30s_to_60s"
	default:
		return "gte_60s"
	}
}

func safeErrorCode(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 {
		return unknownErrorCode
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			character == '_' || character == '-' || character == '.' || character == ':' {
			continue
		}
		return unknownErrorCode
	}
	return value
}
