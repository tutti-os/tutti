package agenthost

import (
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func runtimeCancelTargetOutcomes(targets, confirmed []RuntimeCancelTarget) []storesqlite.CancelRuntimeOperationTargetOutcome {
	confirmedSet := make(map[string]struct{}, len(confirmed))
	for _, target := range confirmed {
		confirmedSet[runtimeCancelTargetKey(target)] = struct{}{}
	}
	result := make([]storesqlite.CancelRuntimeOperationTargetOutcome, 0, len(targets))
	for _, target := range targets {
		outcome := storesqlite.TurnOutcomeInterrupted
		if _, ok := confirmedSet[runtimeCancelTargetKey(target)]; ok {
			outcome = storesqlite.TurnOutcomeCanceled
		}
		result = append(result, storesqlite.CancelRuntimeOperationTargetOutcome{
			AgentSessionID: strings.TrimSpace(target.AgentSessionID),
			TurnID:         strings.TrimSpace(target.TurnID),
			Outcome:        outcome,
		})
	}
	return result
}

func runtimeCancelTargetUnknownOutcomes(targets []RuntimeCancelTarget) []storesqlite.CancelRuntimeOperationTargetOutcome {
	const errorCode = "execution_status_unknown"
	const errorMessage = "provider final status was unavailable after the provider turn state was lost"
	result := make([]storesqlite.CancelRuntimeOperationTargetOutcome, 0, len(targets))
	for _, target := range targets {
		result = append(result, storesqlite.CancelRuntimeOperationTargetOutcome{
			AgentSessionID: strings.TrimSpace(target.AgentSessionID),
			TurnID:         strings.TrimSpace(target.TurnID),
			Outcome:        storesqlite.TurnOutcomeFailed,
			ErrorCode:      errorCode,
			ErrorMessage:   errorMessage,
		})
	}
	return result
}

func runtimeCancelTargetKey(target RuntimeCancelTarget) string {
	return strings.TrimSpace(target.AgentSessionID) + "\x00" + strings.TrimSpace(target.TurnID)
}

func runtimeCancelTargetsPayload(targets []RuntimeCancelTarget) []any {
	result := make([]any, 0, len(targets))
	for _, target := range targets {
		result = append(result, map[string]any{"agentSessionId": strings.TrimSpace(target.AgentSessionID), "turnId": strings.TrimSpace(target.TurnID)})
	}
	return result
}

func runtimeCancelTargetsFromPayload(payload map[string]any) []RuntimeCancelTarget {
	raw, _ := payload["targets"].([]any)
	result := make([]RuntimeCancelTarget, 0, len(raw))
	for _, item := range raw {
		value, _ := item.(map[string]any)
		target := RuntimeCancelTarget{AgentSessionID: runtimeOperationPayloadText(value, "agentSessionId"), TurnID: runtimeOperationPayloadText(value, "turnId")}
		if target.AgentSessionID != "" && target.TurnID != "" {
			result = append(result, target)
		}
	}
	return result
}
