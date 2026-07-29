package agent

import (
	"encoding/json"
	"log/slog"
)

const claudeModelCatalogInvalidationDebugPrefix = "CLAUDE_MODEL_CATALOG_INVALIDATION_DEBUG"
const agentExtensionComposerDebugPrefix = "AGENT_EXTENSION_COMPOSER_DEBUG"

func logAgentExtensionComposerDebug(stage string, payload map[string]any) {
	payload["stage"] = stage
	encoded, err := json.Marshal(payload)
	if err != nil {
		encoded = []byte(`{"stage":"debug_payload_unavailable"}`)
	}
	slog.Info(agentExtensionComposerDebugPrefix, "payload_json", string(encoded))
}

var claudeModelCatalogDebugSafeFields = map[string]struct{}{
	"agentSessionId":        {},
	"checkedAtUnixMs":       {},
	"createdAtUnixMs":       {},
	"deletedAttemptMarkers": {},
	"deletedCacheEntries":   {},
	"hiddenDiscovery":       {},
	"invalidatedAtUnixMs":   {},
	"modelOptionCount":      {},
	"modelSource":           {},
	"occurredAtUnixMs":      {},
	"provider":              {},
	"status":                {},
	"updatedAtUnixMs":       {},
	"visible":               {},
	"workspaceId":           {},
}

func logClaudeModelCatalogInvalidationDebug(stage string, payload map[string]any) {
	safePayload := claudeModelCatalogDebugPayload(stage, payload)
	encoded, err := json.Marshal(safePayload)
	if err != nil {
		encoded = []byte(`{"stage":"debug_payload_unavailable"}`)
	}
	slog.Debug(claudeModelCatalogInvalidationDebugPrefix, "payload_json", string(encoded))
}

func claudeModelCatalogDebugPayload(stage string, payload map[string]any) map[string]any {
	safePayload := make(map[string]any, len(payload)+1)
	for key, value := range payload {
		if _, ok := claudeModelCatalogDebugSafeFields[key]; ok {
			safePayload[key] = value
		}
	}
	safePayload["stage"] = stage
	if _, hasError := payload["error"]; hasError {
		safePayload["errorClass"] = "discovery_failed"
	}
	return safePayload
}
