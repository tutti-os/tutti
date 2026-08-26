package agentruntime

import "strings"

// standardACPResumeModeMatchesPersistedSelection reports whether the mode Tutti
// is about to request is the same selection that was active when this provider
// session was last attached. session/resume restores provider-owned state, so
// reasserting an unchanged selection is both unnecessary and unsafe for agents
// whose mode transitions are not idempotent.
func standardACPResumeModeMatchesPersistedSelection(session Session, targetModeID string) bool {
	targetModeID = strings.TrimSpace(targetModeID)
	if targetModeID == "" {
		return true
	}

	persistedPermissionModeID := strings.TrimSpace(asString(session.RuntimeContext["permissionModeId"]))
	if persistedPermissionModeID != "" && persistedPermissionModeID == strings.TrimSpace(session.PermissionModeID) {
		if persistedPlanMode, ok := session.RuntimeContext["planMode"].(bool); ok &&
			persistedPlanMode != session.SettingsValue().PlanMode {
			return false
		}
		return true
	}

	return strings.TrimSpace(asString(session.RuntimeContext["mode"])) == targetModeID
}
