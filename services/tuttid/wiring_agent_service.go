package main

import (
	"context"
	"log/slog"

	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

type workspaceAgentTargetResolverSetter interface {
	SetWorkspaceAgentTargetResolver(agentservice.WorkspaceAgentTargetResolver)
}

func configureWorkspaceAgentProjection(
	activityProjection workspaceAgentTargetResolverSetter,
	workspaceAgentTargets agentservice.WorkspaceAgentTargetResolver,
) {
	if workspaceAgentTargets != nil {
		activityProjection.SetWorkspaceAgentTargetResolver(workspaceAgentTargets)
	}
}

func startAgentModelInvalidationAuthWatcher(
	replayComposition bool,
	modelCatalog *agentservice.CachedAgentModelCatalog,
	sessions *agentservice.Service,
	events *eventstreamservice.Service,
) *agentservice.ProviderAuthWatcher {
	// External credential switchers (for example cc-switch) rewrite provider
	// auth/config files without notifying tuttid. Watch those files so cached
	// model catalogs are dropped and the GUI hears about it immediately.
	publisher := eventstreamservice.AgentModelCatalogPublisher{Service: events}
	return startProviderAuthWatcher(replayComposition, func(providers []string) {
		modelCatalog.Invalidate(providers...)
		for _, provider := range providers {
			sessions.InvalidateLiveComposerModels(provider)
		}
		if err := publisher.PublishAgentModelCatalogInvalidated(context.Background(), providers); err != nil {
			slog.Warn("agent model catalog invalidation publish failed",
				"event", "agent.model_catalog.invalidation_publish_failed",
				"providers", providers,
				"error", err,
			)
			return
		}
		slog.Info("agent provider auth files changed; model catalog invalidated",
			"event", "agent.model_catalog.invalidated",
			"providers", providers,
		)
	})
}

func agentWorkspaceIDs(
	store workspacedata.CatalogStore,
) func(context.Context) ([]string, error) {
	return func(ctx context.Context) ([]string, error) {
		workspaces, err := store.List(ctx)
		if err != nil {
			return nil, err
		}
		ids := make([]string, 0, len(workspaces))
		for _, workspace := range workspaces {
			ids = append(ids, workspace.ID)
		}
		return ids, nil
	}
}
