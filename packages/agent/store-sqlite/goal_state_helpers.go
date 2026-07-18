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
