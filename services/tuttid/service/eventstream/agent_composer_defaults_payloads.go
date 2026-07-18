package eventstream

import (
	"encoding/json"
	"fmt"
	"strings"

	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

type agentComposerDefaultsPatchRequestedPayload struct {
	AgentTargetID    string                                    `json:"agentTargetId"`
	Patch            preferencesbiz.AgentComposerDefaultsPatch `json:"patch"`
	ClientMutationID string                                    `json:"clientMutationId,omitempty"`
}

type agentComposerDefaultsChangedPayload struct {
	AgentTargetID string `json:"agentTargetId"`
}

func validateAgentComposerDefaultsPatchRequestedPayload(payload []byte) error {
	var decoded agentComposerDefaultsPatchRequestedPayload
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	if strings.TrimSpace(decoded.AgentTargetID) == "" {
		return fmt.Errorf("agentTargetId is required")
	}
	if len(decoded.Patch) == 0 {
		return fmt.Errorf("patch is required")
	}
	for field := range decoded.Patch {
		switch field {
		case preferencesbiz.AgentComposerDefaultsFieldModel,
			preferencesbiz.AgentComposerDefaultsFieldPermissionModeID,
			preferencesbiz.AgentComposerDefaultsFieldReasoningEffort,
			preferencesbiz.AgentComposerDefaultsFieldSpeed:
		default:
			return fmt.Errorf("patch contains unsupported field %q", field)
		}
	}
	return nil
}

func validateAgentComposerDefaultsChangedPayload(payload []byte) error {
	var decoded agentComposerDefaultsChangedPayload
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	if strings.TrimSpace(decoded.AgentTargetID) == "" {
		return fmt.Errorf("agentTargetId is required")
	}
	return nil
}
