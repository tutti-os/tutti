package eventstream

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentgui"
	workbenchbiz "github.com/tutti-os/tutti/services/tuttid/biz/workbench"
)

type AgentGUILaunchPublisher struct {
	Service *Service
}

func (p AgentGUILaunchPublisher) PublishAgentGUILaunchRequested(
	ctx context.Context,
	request agentgui.LaunchRequest,
) error {
	if p.Service == nil {
		return nil
	}
	request = agentgui.NormalizeLaunchRequest(request)
	if request.WorkspaceID == "" || request.AgentSessionID == "" || request.Provider == "" {
		return fmt.Errorf("agent gui launch request requires workspaceId, agentSessionId, and provider")
	}
	payload, err := json.Marshal(agentGUIWorkbenchLaunchPayload{
		AgentSessionID: request.AgentSessionID,
		AgentTargetID:  request.AgentTargetID,
		Provider:       request.Provider,
	})
	if err != nil {
		return fmt.Errorf("marshal agent gui workbench launch payload: %w", err)
	}
	return WorkbenchNodeLaunchPublisher(p).PublishWorkbenchNodeLaunchRequested(ctx, workbenchbiz.NodeLaunchRequest{
		WorkspaceID:  request.WorkspaceID,
		TypeID:       "agent-gui",
		Source:       firstNonEmptyString(request.Source, "cli"),
		LaunchSource: firstNonEmptyString(request.Source, "cli"),
		RequestID:    strings.TrimSpace(request.RequestID),
		Payload:      payload,
	})
}

type agentGUIWorkbenchLaunchPayload struct {
	AgentSessionID string `json:"agentSessionId"`
	AgentTargetID  string `json:"agentTargetId,omitempty"`
	Provider       string `json:"provider"`
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
