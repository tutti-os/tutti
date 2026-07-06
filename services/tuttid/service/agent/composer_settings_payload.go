package agent

import (
	"strings"

	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

// ComposerSettingsToMap serializes composer settings for activity persistence
// and API/CLI surfaces. browserUse is tri-state: only written when explicitly set.
func ComposerSettingsToMap(settings ComposerSettings) map[string]any {
	return composerSettingsToPayload(settings)
}

// composerSettingsToPayload is the internal alias for round-trip helpers in this package.
func composerSettingsToPayload(settings ComposerSettings) map[string]any {
	payload := map[string]any{}
	if model := strings.TrimSpace(settings.Model); model != "" {
		payload["model"] = model
	}
	if permissionModeID := strings.TrimSpace(settings.PermissionModeID); permissionModeID != "" {
		payload["permissionModeId"] = permissionModeID
	}
	if settings.PlanMode {
		payload["planMode"] = true
	}
	if reasoningEffort := strings.TrimSpace(settings.ReasoningEffort); reasoningEffort != "" {
		payload["reasoningEffort"] = reasoningEffort
	}
	if settings.BrowserUse != nil {
		payload["browserUse"] = *settings.BrowserUse
	}
	if settings.ComputerUse != nil {
		payload["computerUse"] = *settings.ComputerUse
	}
	if speed := strings.TrimSpace(settings.Speed); speed != "" {
		payload["speed"] = speed
	}
	if strings.TrimSpace(settings.ConversationDetailMode) != "" {
		payload["conversationDetailMode"] = preferencesbiz.NormalizeDesktopAgentConversationDetailMode(settings.ConversationDetailMode)
	}
	if len(payload) == 0 {
		return nil
	}
	return payload
}

func composerSettingsFromPayload(payload map[string]any) ComposerSettings {
	settings := ComposerSettings{
		Model:            payloadString(payload, "model"),
		PermissionModeID: payloadString(payload, "permissionModeId"),
		PlanMode:         payloadBool(payload, "planMode"),
		ReasoningEffort:  payloadString(payload, "reasoningEffort"),
		BrowserUse:       payloadBoolPointer(payload, "browserUse"),
		ComputerUse:      payloadBoolPointer(payload, "computerUse"),
		Speed:            payloadString(payload, "speed"),
	}
	if _, ok := payload["conversationDetailMode"]; ok {
		settings.ConversationDetailMode = preferencesbiz.NormalizeDesktopAgentConversationDetailMode(payloadString(payload, "conversationDetailMode"))
	}
	return settings
}

func composerSettingsIsEmpty(settings ComposerSettings) bool {
	return strings.TrimSpace(settings.Model) == "" &&
		strings.TrimSpace(settings.PermissionModeID) == "" &&
		strings.TrimSpace(settings.ReasoningEffort) == "" &&
		strings.TrimSpace(settings.Speed) == "" &&
		strings.TrimSpace(settings.ConversationDetailMode) == "" &&
		!settings.PlanMode &&
		settings.BrowserUse == nil &&
		settings.ComputerUse == nil
}

func payloadBoolPointer(payload map[string]any, key string) *bool {
	if len(payload) == 0 {
		return nil
	}
	value, ok := payload[key].(bool)
	if !ok {
		return nil
	}
	return &value
}

func createSessionInputFromPersisted(session PersistedSession) CreateSessionInput {
	input := CreateSessionInput{
		AgentSessionID: strings.TrimSpace(session.ID),
		Provider:       strings.TrimSpace(session.Provider),
	}
	if title := strings.TrimSpace(session.Title); title != "" {
		input.Title = &title
	}
	settings := session.Settings
	if model := strings.TrimSpace(settings.Model); model != "" {
		input.Model = &model
	}
	if permissionModeID := strings.TrimSpace(settings.PermissionModeID); permissionModeID != "" {
		normalizedPermissionModeID := normalizePermissionModeIDForProvider(input.Provider, permissionModeID)
		input.PermissionModeID = &normalizedPermissionModeID
	}
	if settings.PlanMode {
		input.PlanMode = boolPointer(true)
	}
	if settings.BrowserUse != nil {
		value := *settings.BrowserUse
		input.BrowserUse = &value
	}
	if settings.ComputerUse != nil {
		value := *settings.ComputerUse
		input.ComputerUse = &value
	}
	if reasoningEffort := strings.TrimSpace(settings.ReasoningEffort); reasoningEffort != "" {
		normalizedReasoningEffort := normalizeReasoningEffortForProvider(
			strings.TrimSpace(session.Provider),
			reasoningEffort,
		)
		input.ReasoningEffort = &normalizedReasoningEffort
	}
	if speed := strings.TrimSpace(settings.Speed); speed != "" {
		normalizedSpeed := normalizeSpeedForProvider(
			strings.TrimSpace(session.Provider),
			speed,
		)
		input.Speed = &normalizedSpeed
	}
	input.ConversationDetailMode = preferencesbiz.NormalizeDesktopAgentConversationDetailMode(settings.ConversationDetailMode)
	if sourcePath, ok := session.RuntimeContext["externalSourcePath"].(string); ok {
		input.ExternalRolloutSourcePath = strings.TrimSpace(sourcePath)
	}
	return input
}
