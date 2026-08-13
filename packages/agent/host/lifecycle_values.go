package agenthost

import (
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func normalizeOptionalPromptContent(content []PromptContentBlock) ([]PromptContentBlock, string, error) {
	if len(content) == 0 {
		return nil, "", nil
	}
	return normalizePromptContent(content)
}

func createPreparationInput(workspaceID string, input CreateSessionInput) RuntimePreparationInput {
	return RuntimePreparationInput{
		WorkspaceID: workspaceID, AgentSessionID: input.AgentSessionID, AgentTargetID: input.AgentTargetID,
		Provider: input.Provider, Cwd: value(input.Cwd), Title: value(input.Title), PermissionModeID: value(input.PermissionModeID),
		PlanMode: valueBool(input.PlanMode), BrowserUse: valueBoolDefault(input.BrowserUse, true), ComputerUse: valueBoolDefault(input.ComputerUse, true), CodexSaverMode: valueBool(input.CodexSaverMode),
		ProviderTargetRef: cloneMap(input.ProviderTargetRef), Model: value(input.Model), ReasoningEffort: value(input.ReasoningEffort),
		ConversationDetailMode: input.ConversationDetailMode, Metadata: cloneMap(input.Metadata), RuntimeContext: cloneMap(input.RuntimeContext),
	}
}

func resumePreparationInput(session storesqlite.Session, settings ComposerSettings) RuntimePreparationInput {
	return RuntimePreparationInput{
		WorkspaceID: session.WorkspaceID, AgentSessionID: session.ID, AgentTargetID: session.AgentTargetID,
		Provider: session.Provider, Cwd: session.Cwd, Title: session.Title, PermissionModeID: settings.PermissionModeID,
		PlanMode: settings.PlanMode, BrowserUse: valueBoolDefault(settings.BrowserUse, true), ComputerUse: valueBoolDefault(settings.ComputerUse, true), CodexSaverMode: settings.CodexSaverMode,
		Model: settings.Model, ReasoningEffort: settings.ReasoningEffort, ConversationDetailMode: settings.ConversationDetailMode,
		RuntimeContext: cloneMap(session.InternalRuntimeContext), SessionOrigin: session.Origin,
		ProviderSessionID: session.ProviderSessionID, CreatedAtUnixMS: session.CreatedAtUnixMS,
		UpdatedAtUnixMS: session.UpdatedAtUnixMS, Visible: session.Metadata.Visible, Settings: settings,
		SessionMetadata: session.Metadata,
	}
}

func overlayRuntimeContext(base map[string]any, overlay map[string]any) map[string]any {
	result := cloneMap(base)
	if len(overlay) == 0 {
		return result
	}
	if result == nil {
		result = make(map[string]any, len(overlay))
	}
	for key, value := range cloneMap(overlay) {
		baseMap, baseIsMap := result[key].(map[string]any)
		overlayMap, overlayIsMap := value.(map[string]any)
		if baseIsMap && overlayIsMap {
			result[key] = overlayRuntimeContext(baseMap, overlayMap)
			continue
		}
		result[key] = value
	}
	return result
}

func composerSettingsFromMap(values map[string]any) ComposerSettings {
	result := ComposerSettings{}
	result.CodexSaverMode, _ = values["codexSaverMode"].(bool)
	result.Model, _ = values["model"].(string)
	result.PermissionModeID, _ = values["permissionModeId"].(string)
	result.PlanMode, _ = values["planMode"].(bool)
	if value, ok := values["browserUse"].(bool); ok {
		result.BrowserUse = &value
	}
	if value, ok := values["computerUse"].(bool); ok {
		result.ComputerUse = &value
	}
	result.ReasoningEffort, _ = values["reasoningEffort"].(string)
	result.Speed, _ = values["speed"].(string)
	result.ConversationDetailMode, _ = values["conversationDetailMode"].(string)
	return result
}

func lifecycleFromTurn(turn storesqlite.Turn) TurnLifecycle {
	result := TurnLifecycle{Phase: turn.Phase}
	if turnID := strings.TrimSpace(turn.TurnID); turnID != "" && turn.Phase != "settled" {
		result.ActiveTurnID = &turnID
	}
	if turn.Outcome != "" {
		outcome := turn.Outcome
		result.Outcome = &outcome
	}
	if turn.CompletedCommandKind != "" || turn.CompletedCommandStatus != "" {
		result.CompletedCommand = &CompletedCommand{Kind: turn.CompletedCommandKind, Status: turn.CompletedCommandStatus}
	}
	return result
}

func imageOnlyDisplayText(content []PromptContentBlock) string {
	count := 0
	for _, block := range content {
		if block.Type == "image" {
			count++
		}
	}
	if count == 1 {
		return "[Image]"
	}
	if count > 1 {
		return "[Images]"
	}
	return ""
}

func value(input *string) string {
	if input == nil {
		return ""
	}
	return strings.TrimSpace(*input)
}

func valueBool(input *bool) bool { return input != nil && *input }

func valueBoolDefault(input *bool, fallback bool) bool {
	if input == nil {
		return fallback
	}
	return *input
}

func boolPointer(value bool) *bool { return &value }

func firstMap(values ...map[string]any) map[string]any {
	for _, value := range values {
		if len(value) > 0 {
			return value
		}
	}
	return nil
}
