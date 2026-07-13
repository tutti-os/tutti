package api

import (
	"context"
	"strings"

	reporterevents "github.com/tutti-os/tutti/services/tuttid/service/reporter/events"
)

const deprecatedWorkspaceAppAgentAPIUsedEvent = "deprecated_workspace_app_agent_api_used"

func (api DaemonAPI) trackDeprecatedWorkspaceAppAgentAPI(
	ctx context.Context,
	route string,
	appID string,
	workspaceAppVersion string,
) {
	route = strings.TrimSpace(route)
	appID = strings.TrimSpace(appID)
	workspaceAppVersion = strings.TrimSpace(workspaceAppVersion)
	if route == "" || appID == "" {
		return
	}
	if workspaceAppVersion == "" {
		workspaceAppVersion = "unknown"
	}
	reporterevents.Track(ctx, api.AnalyticsReporter, deprecatedWorkspaceAppAgentAPIUsedEvent, map[string]any{
		"app_id":                appID,
		"migration_target":      "agent-acp-kit-tutti-cli-facade",
		"route":                 route,
		"workspace_app_version": workspaceAppVersion,
	})
}
