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
		case "complete", "completed", "blocked", "limited", "usageLimited", "budgetLimited", "failed":
			return true
		}
	}
	return false
}

// ProjectEffectiveSessionGoal returns the single Goal projection exposed to
// Session consumers. Desired remains the user's control intent, while a
// matching, settled provider observation owns lifecycle fields such as
// completion and counters.
func ProjectEffectiveSessionGoal(state SessionGoalState) map[string]any {
	if state.Tombstoned {
		return nil
	}
	desired := canonicalSessionGoalMap(state.Desired)
	observed := canonicalSessionGoalMap(state.Observed)
	if len(desired) == 0 {
		return observed
	}
	if len(observed) == 0 || state.PendingOperationID != "" {
		return desired
	}
	if strings.TrimSpace(asJSONMapString(desired, "objective")) !=
		strings.TrimSpace(asJSONMapString(observed, "objective")) {
		return desired
	}
	switch strings.TrimSpace(asJSONMapString(observed, "status")) {
	case "active", "paused", "blocked", "usageLimited", "budgetLimited", "complete":
	default:
		return desired
	}
	return observed
}

// canonicalSessionGoalMap keeps every public Goal projection on the same
// typed validation boundary used when Session metadata is decoded.
func canonicalSessionGoalMap(raw map[string]any) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	raw = normalizeSessionGoalStatusAliases(raw)
	goal, err := DecodeSessionGoal(raw)
	if err != nil || goal == nil {
		return nil
	}
	result := map[string]any{
		"objective": goal.Objective,
		"status":    goal.Status,
	}
	if goal.Reason != "" {
		result["reason"] = goal.Reason
	}
	if goal.Iterations != 0 {
		result["iterations"] = goal.Iterations
	}
	if goal.DurationMS != 0 {
		result["durationMs"] = goal.DurationMS
	}
	if goal.Tokens != 0 {
		result["tokens"] = goal.Tokens
	}
	return result
}

func normalizeSessionGoalStatusAliases(raw map[string]any) map[string]any {
	normalized := cloneJSONMap(raw)
	switch strings.TrimSpace(asJSONMapString(normalized, "status")) {
	case "completed":
		normalized["status"] = "complete"
	case "limited":
		normalized["status"] = "usageLimited"
	case "failed":
		normalized["status"] = "blocked"
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
