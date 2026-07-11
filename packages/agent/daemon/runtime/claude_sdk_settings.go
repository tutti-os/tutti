package agentruntime

import (
	"context"
	"strings"
)

func (a *ClaudeCodeSDKAdapter) ApplySessionSettings(
	ctx context.Context,
	session Session,
	patch SessionSettingsPatch,
) error {
	payload := map[string]any{
		"agentSessionId": session.AgentSessionID,
	}
	if patch.PlanMode != nil {
		payload["planMode"] = *patch.PlanMode
		payload["permissionMode"] = claudeSDKEffectivePermissionMode(session)
	}
	if patch.Model != nil {
		payload["model"] = strings.TrimSpace(*patch.Model)
	}
	if patch.ReasoningEffort != nil {
		payload["effort"] = strings.TrimSpace(*patch.ReasoningEffort)
	}
	if patch.Speed != nil {
		if speed := claudeSDKCanonicalSpeed(*patch.Speed); speed != "" {
			payload["speed"] = speed
		}
	}
	if len(payload) == 1 {
		return nil
	}
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil
	}
	request := claudeSDKSidecarRequest{
		ID:      newID(),
		Type:    "apply_settings",
		Payload: payload,
	}
	if err := a.roundTripClaudeSDK(ctx, session.AgentSessionID, adapterSession, request); err != nil {
		return err
	}
	adapterSession.applySettingsPayload(payload)
	return nil
}

func (a *ClaudeCodeSDKAdapter) ApplyPermissionMode(ctx context.Context, session Session) error {
	adapterSession := a.getSession(session.AgentSessionID)
	if adapterSession == nil {
		return nil
	}
	mode := claudeSDKEffectivePermissionMode(session)
	if mode == "" {
		return nil
	}
	request := claudeSDKSidecarRequest{
		ID:   newID(),
		Type: "apply_settings",
		Payload: map[string]any{
			"agentSessionId": session.AgentSessionID,
			"permissionMode": mode,
			"planMode":       session.SettingsValue().PlanMode,
		},
	}
	if err := a.roundTripClaudeSDK(ctx, session.AgentSessionID, adapterSession, request); err != nil {
		return err
	}
	adapterSession.applyPermissionMode(mode)
	return nil
}

func (*ClaudeCodeSDKAdapter) RequiresNewSessionForSettings(Session, SessionSettingsPatch) bool {
	return false
}
