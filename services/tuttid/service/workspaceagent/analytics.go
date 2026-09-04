package workspaceagent

import (
	"context"
	"strings"

	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
	reporterevents "github.com/tutti-os/tutti/services/tuttid/service/reporter/events"
)

const workspaceAgentConfigurationChangedEvent = "workspace_agent.configuration_changed"

func (s *Service) reportConfigurationChanged(
	ctx context.Context,
	action string,
	agent workspaceagentbiz.Agent,
) {
	if s == nil || s.AnalyticsReporter == nil {
		return
	}
	switch action {
	case "created", "updated", "deleted":
	default:
		return
	}
	modelConfigSource := "provider_native"
	if strings.TrimSpace(agent.ModelPlanID) != "" {
		modelConfigSource = "model_plan"
	}
	reporterevents.Track(ctx, s.AnalyticsReporter, workspaceAgentConfigurationChangedEvent, map[string]any{
		"action":              action,
		"model_config_source": modelConfigSource,
	})
}
