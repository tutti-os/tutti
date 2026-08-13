package storesqlite

import (
	"database/sql"
	"strings"
)

func isKnownGoalControlAction(action string) bool {
	switch action {
	case "pause", "resume", "clear", "set", "reconcile":
		return true
	default:
		return false
	}
}

func goalStateConverged(desired, observed map[string]any, tombstoned bool) bool {
	if tombstoned {
		return len(observed) == 0
	}
	if len(desired) == 0 || len(observed) == 0 {
		return len(desired) == 0 && len(observed) == 0
	}
	if strings.TrimSpace(asJSONMapString(desired, "objective")) != strings.TrimSpace(asJSONMapString(observed, "objective")) {
		return false
	}
	desiredStatus := strings.TrimSpace(asJSONMapString(desired, "status"))
	observedStatus := strings.TrimSpace(asJSONMapString(observed, "status"))
	if desiredStatus == observedStatus {
		return true
	}
	// Provider lifecycle is orthogonal to control convergence. A provider may
	// finish or limit the same objective without undoing the active control
	// command that selected it.
	if desiredStatus == "active" {
		switch observedStatus {
		case "complete", "completed", "blocked", "limited", "failed":
			return true
		}
	}
	return false
}

func goalExecutionPendingAfterObservation(current bool, observed map[string]any, syncStatus string) bool {
	if !current || (syncStatus != GoalSyncStatusApplying && syncStatus != GoalSyncStatusSynced) {
		return false
	}
	return strings.TrimSpace(asJSONMapString(observed, "status")) == "active"
}

// normalizeObservedGoalTiming keeps one durable clock for each Goal
// generation. Provider observations often omit timing, so preserve the
// canonical desired/observed start for the same objective and stamp only a
// genuinely provider-created Goal at its first observation.
func normalizeObservedGoalTiming(observed map[string]any, state SessionGoalState, occurredAt int64) map[string]any {
	if len(observed) == 0 {
		return nil
	}
	normalized := cloneJSONMap(observed)
	objective := strings.TrimSpace(asJSONMapString(normalized, "objective"))
	startedAt := jsonMapInt64(normalized, "startedAtUnixMs")
	if startedAt <= 0 && objective != "" {
		for _, candidate := range []map[string]any{state.Desired, state.Observed} {
			if objective == strings.TrimSpace(asJSONMapString(candidate, "objective")) {
				if candidateStart := jsonMapInt64(candidate, "startedAtUnixMs"); candidateStart > 0 {
					startedAt = candidateStart
					break
				}
			}
		}
	}
	if startedAt <= 0 {
		startedAt = occurredAt
	}
	normalized["startedAtUnixMs"] = startedAt
	status := strings.TrimSpace(asJSONMapString(normalized, "status"))
	if status != "" && status != "active" && jsonMapInt64(normalized, "durationMs") <= 0 {
		previousStatus := strings.TrimSpace(asJSONMapString(state.Observed, "status"))
		if objective == strings.TrimSpace(asJSONMapString(state.Observed, "objective")) && status == previousStatus {
			if previousDuration := jsonMapInt64(state.Observed, "durationMs"); previousDuration > 0 {
				normalized["durationMs"] = previousDuration
			}
		}
		if jsonMapInt64(normalized, "durationMs") <= 0 && occurredAt >= startedAt {
			normalized["durationMs"] = occurredAt - startedAt
		}
	}
	return normalized
}

func providerPhaseForCompletion(succeeded bool) string {
	if succeeded {
		return GoalProviderPhaseApplied
	}
	return GoalProviderPhaseUnknown
}

func asJSONMapString(value map[string]any, key string) string {
	text, _ := value[key].(string)
	return text
}

func nullableJSONMap(value map[string]any) any {
	if len(value) == 0 {
		return nil
	}
	encoded, _ := marshalJSONMap(value)
	return encoded
}

func marshalJSONMapOrEmpty(value map[string]any) string {
	encoded, err := marshalJSONMap(value)
	if err != nil || strings.TrimSpace(encoded) == "" {
		return "{}"
	}
	return encoded
}

func unmarshalNullableJSONMap(value sql.NullString) map[string]any {
	if !value.Valid || strings.TrimSpace(value.String) == "" {
		return nil
	}
	decoded, _ := unmarshalJSONMap(value.String)
	return decoded
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
