package eventstream

import (
	"encoding/json"
	"fmt"
	"strings"
)

type agentSessionLaunchModePatchRequestedPayload struct {
	WorkspaceID       string `json:"workspaceId"`
	ProjectSectionKey string `json:"projectSectionKey"`
	Mode              string `json:"mode"`
}

func validateAgentSessionLaunchModePatchRequestedPayload(payload []byte) error {
	var decoded agentSessionLaunchModePatchRequestedPayload
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	if strings.TrimSpace(decoded.WorkspaceID) == "" {
		return fmt.Errorf("workspaceId is required")
	}
	if strings.TrimSpace(decoded.ProjectSectionKey) == "" {
		return fmt.Errorf("projectSectionKey is required")
	}
	mode := strings.TrimSpace(decoded.Mode)
	if mode != "local" && mode != "worktree" {
		return fmt.Errorf("mode is unsupported")
	}
	return nil
}
