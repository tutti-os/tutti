package eventstream

import (
	"encoding/json"
	"fmt"
	"strings"

	eventsgenerated "github.com/tutti-os/tutti/services/tuttid/api/events/generated"
	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
)

func validateAgentCollaborationUpdatedPayload(payload []byte) error {
	var decoded eventsgenerated.AgentCollaborationUpdatedPayload
	if err := decodeJSONStrict(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	var requiredFields struct {
		OccurredAtUnixMs *int `json:"occurredAtUnixMs"`
	}
	if err := json.Unmarshal(payload, &requiredFields); err != nil {
		return fmt.Errorf("decode required fields: %w", err)
	}
	if requiredFields.OccurredAtUnixMs == nil {
		return fmt.Errorf("occurredAtUnixMs is required")
	}
	if strings.TrimSpace(decoded.WorkspaceId) == "" {
		return fmt.Errorf("workspaceId is required")
	}
	if strings.TrimSpace(decoded.RunId) == "" {
		return fmt.Errorf("runId is required")
	}
	if !collabrunbiz.IsMode(decoded.Mode) {
		return fmt.Errorf("mode is unsupported")
	}
	if !collabrunbiz.IsStatus(decoded.Status) {
		return fmt.Errorf("status is unsupported")
	}
	if !collabrunbiz.IsTriggerSource(decoded.TriggerSource) {
		return fmt.Errorf("triggerSource is unsupported")
	}
	if decoded.SourceSessionId != nil && strings.TrimSpace(*decoded.SourceSessionId) == "" {
		return fmt.Errorf("sourceSessionId must not be blank")
	}
	if decoded.TargetSessionId != nil && strings.TrimSpace(*decoded.TargetSessionId) == "" {
		return fmt.Errorf("targetSessionId must not be blank")
	}
	if decoded.ModelPlanId != nil && strings.TrimSpace(*decoded.ModelPlanId) == "" {
		return fmt.Errorf("modelPlanId must not be blank")
	}
	if decoded.Model != nil && strings.TrimSpace(*decoded.Model) == "" {
		return fmt.Errorf("model must not be blank")
	}
	if decoded.Adoption != nil && !collabrunbiz.IsAdoption(*decoded.Adoption) {
		return fmt.Errorf("adoption is unsupported")
	}
	if decoded.OccurredAtUnixMs < 0 {
		return fmt.Errorf("occurredAtUnixMs must not be negative")
	}
	return nil
}
