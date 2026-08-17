package main

import (
	"context"
	"fmt"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

func recoverIssueExecutionsAtStartup(
	ctx context.Context,
	workspaces workspaceservice.CatalogService,
	executions *workspaceservice.IssueExecutionCoordinator,
	tuttiModeExecutions *tuttimodeexecutionservice.Service,
) ([]workspacebiz.Summary, error) {
	summaries, err := workspaces.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list workspaces for Issue Run startup recovery: %w", err)
	}
	for _, summary := range summaries {
		if _, err := executions.ReconcileIssueExecutions(ctx, summary.ID); err != nil {
			return nil, fmt.Errorf(
				"recover Issue executions at startup for workspace %q: %w",
				summary.ID,
				err,
			)
		}
		repairTuttiModeMainWakesAtStartup(ctx, tuttiModeExecutions, summary.ID)
	}
	return summaries, nil
}
