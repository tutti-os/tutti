package agentruntime

import (
	"context"
	"strings"
)

func (a *standardACPAdapter) ApplyPermissionMode(ctx context.Context, session Session) error {
	if a != nil && a.config.launchPermission != nil {
		return nil
	}
	acpSession := a.getSession(session.AgentSessionID)
	if acpSession == nil || acpSession.client == nil {
		return nil
	}
	if strings.TrimSpace(session.ProviderSessionID) == "" {
		session.ProviderSessionID = acpSession.providerSessionID
	}
	// Track the live tier so automatic decisions (for example full-access
	// approval or read-only denial) affect subsequent requests without respawn.
	a.setSessionPermissionModeID(session.AgentSessionID, session.PermissionModeID)
	if a.config.permissionModeID == nil || a.config.permissionModeID(session.PermissionModeID) == "" {
		return nil
	}
	return a.applyACPMode(ctx, acpSession.client, session, a.effectiveModeID(session))
}

func (a *standardACPAdapter) effectiveWorkflowModeConfigOptionID() string {
	if a == nil {
		return ""
	}
	if a.config.planModeRuntimeID != "" && a.config.planModeDisabledRuntimeID != "" {
		return "mode"
	}
	return a.effectivePermissionConfigOptionID()
}

func (a *standardACPAdapter) setSessionPermissionModeID(agentSessionID string, permissionModeID string) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if session := a.sessions[strings.TrimSpace(agentSessionID)]; session != nil {
		session.permissionModeID = strings.TrimSpace(permissionModeID)
	}
}

func (a *standardACPAdapter) setSessionPlanMode(agentSessionID string, enabled bool) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if session := a.sessions[strings.TrimSpace(agentSessionID)]; session != nil {
		session.planMode = enabled
	}
}

// automaticPermissionDecision resolves the decision the provider's live
// permission tier applies to a permission request, or "" to prompt the user.
func (a *standardACPAdapter) automaticPermissionDecision(agentSessionID string) string {
	if a == nil {
		return ""
	}
	a.mu.Lock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	permissionModeID := ""
	planMode := false
	if session != nil {
		permissionModeID = session.permissionModeID
		planMode = session.planMode
	}
	a.mu.Unlock()
	if planMode {
		return "denied"
	}
	if a.config.automaticPermissionDecision == nil {
		return ""
	}
	return a.config.automaticPermissionDecision(permissionModeID)
}

func (a *standardACPAdapter) effectiveModeID(session Session) string {
	if a == nil || a.config.permissionModeID == nil {
		return ""
	}
	if session.SettingsValue().PlanMode {
		if a.config.planModeRuntimeID != "" {
			return a.config.planModeRuntimeID
		}
		if modeID := a.config.permissionModeID("plan"); modeID != "" {
			return modeID
		}
		if a.config.launchPermission != nil {
			return ""
		}
	}
	if a.config.planModeDisabledRuntimeID != "" {
		return a.config.planModeDisabledRuntimeID
	}
	if a.config.launchPermission != nil {
		return ""
	}
	return a.config.permissionModeID(session.PermissionModeID)
}
