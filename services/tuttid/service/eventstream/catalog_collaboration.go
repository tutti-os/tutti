package eventstream

import (
	"fmt"
	"strings"

	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
)

type agentCollaborationUpdatedPayload struct {
	WorkspaceID      string `json:"workspaceId"`
	RunID            string `json:"runId"`
	Mode             string `json:"mode"`
	Status           string `json:"status"`
	SourceSessionID  string `json:"sourceSessionId,omitempty"`
	TargetSessionID  string `json:"targetSessionId,omitempty"`
	ModelPlanID      string `json:"modelPlanId,omitempty"`
	Model            string `json:"model,omitempty"`
	TriggerSource    string `json:"triggerSource"`
	Adoption         string `json:"adoption,omitempty"`
	OccurredAtUnixMS int64  `json:"occurredAtUnixMs"`
}

func collaborationTopicDefinitions() []TopicDefinition {
	return []TopicDefinition{
		{
			Name:               TopicAgentCollaborationUpdated,
			ClientCanPublish:   false,
			ClientCanSubscribe: true,
			Version:            1,
			directions:         []Direction{DirectionServerToClient},
			validators: map[Direction]PayloadValidator{
				DirectionServerToClient: validateAgentCollaborationUpdatedPayload,
			},
		},
	}
}

func validateAgentCollaborationUpdatedPayload(payload []byte) error {
	var decoded agentCollaborationUpdatedPayload
	if err := decodeJSONStrict(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	if strings.TrimSpace(decoded.WorkspaceID) == "" {
		return fmt.Errorf("workspaceId is required")
	}
	if strings.TrimSpace(decoded.RunID) == "" {
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
	if decoded.SourceSessionID != "" && strings.TrimSpace(decoded.SourceSessionID) == "" {
		return fmt.Errorf("sourceSessionId must not be blank")
	}
	if decoded.TargetSessionID != "" && strings.TrimSpace(decoded.TargetSessionID) == "" {
		return fmt.Errorf("targetSessionId must not be blank")
	}
	if decoded.ModelPlanID != "" && strings.TrimSpace(decoded.ModelPlanID) == "" {
		return fmt.Errorf("modelPlanId must not be blank")
	}
	if decoded.Model != "" && strings.TrimSpace(decoded.Model) == "" {
		return fmt.Errorf("model must not be blank")
	}
	if decoded.Adoption != "" && !collabrunbiz.IsAdoption(decoded.Adoption) {
		return fmt.Errorf("adoption is unsupported")
	}
	if decoded.OccurredAtUnixMS <= 0 {
		return fmt.Errorf("occurredAtUnixMs is required")
	}
	return nil
}
