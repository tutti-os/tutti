package main

import (
	"context"

	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	userprojectservice "github.com/tutti-os/tutti/services/tuttid/service/userproject"
)

func configureUserProjectSessionDeletion(
	projects *userprojectservice.Service,
	sessions *agentservice.Service,
) {
	projects.DeleteProjectSessions = func(ctx context.Context, workspaceID string, sectionKey string, sessionIDs []string) (int, error) {
		result, err := sessions.DeleteSessionsBatch(ctx, workspaceID, agentservice.DeleteSessionsBatchInput{
			SessionIDs:                 sessionIDs,
			RequiredRootRailSectionKey: sectionKey,
			ExcludePinnedRoots:         true,
		})
		return result.RemovedSessions, err
	}
}
