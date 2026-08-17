package agent

import (
	"context"
	"log/slog"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/modelcatalog"
)

type composerModelCatalogProjection struct {
	Selection         modelcatalog.ModelSelection
	ModelOptions      []ComposerConfigOptionValue
	ReasoningProfiles map[string]modelcatalog.ReasoningProfile
	Source            string
	Stale             bool
}

type composerModelCatalogLoadResult struct {
	projection composerModelCatalogProjection
	ok         bool
}

func startComposerModelCatalogLoad(
	ctx context.Context,
	catalog AgentModelCatalog,
	provider string,
	cwd string,
	selectedModel string,
	waitForFresh bool,
) <-chan composerModelCatalogLoadResult {
	result := make(chan composerModelCatalogLoadResult, 1)
	go func() {
		projection, ok := composerModelOptionsFromCatalog(ctx, catalog, provider, cwd, selectedModel, waitForFresh)
		result <- composerModelCatalogLoadResult{projection: projection, ok: ok}
	}()
	return result
}

func composerModelOptionsFromCatalog(ctx context.Context, catalog AgentModelCatalog, provider string, cwd string, selectedModel string, waitForFresh ...bool) (composerModelCatalogProjection, bool) {
	if catalog == nil {
		return composerModelCatalogProjection{}, false
	}
	result, err := catalog.ListModels(ctx, AgentModelCatalogInput{
		Provider:     provider,
		Cwd:          cwd,
		WaitForFresh: len(waitForFresh) > 0 && waitForFresh[0],
	})
	if err != nil {
		// The model list drives the composer's model selector; when it fails the
		// selector renders empty. Surface the cause instead of swallowing it so a
		// "no model options" report is diagnosable from the daemon logs.
		slog.Warn("composer model catalog lookup failed",
			"provider", provider,
			"error", err,
		)
		return composerModelCatalogProjection{}, false
	}
	catalogProjection := modelcatalog.ProjectComposerCatalog(result.Models, selectedModel)
	options := composerModelOptionsFromCanonicalCatalog(result.Models)
	selection := catalogProjection.Selection
	// SelectModel keeps a non-catalog requested id as the effective selection.
	// That synthesized entry must stay selectable, but it is provenance-marked:
	// create validation runs against the raw catalog and would reject it.
	if selection.Found && !containsModelOption(options, selection.Model.ID) {
		options = append(options, ComposerConfigOptionValue{
			ID:        selection.Model.ID,
			Label:     selection.Model.DisplayName,
			Value:     selection.Model.ID,
			Requested: true,
		})
	}
	return composerModelCatalogProjection{
		Selection:         selection,
		ModelOptions:      options,
		ReasoningProfiles: catalogProjection.ReasoningOptionsByModel,
		Source:            strings.TrimSpace(result.Source),
		Stale:             result.Stale,
	}, true
}

func containsModelOption(options []ComposerConfigOptionValue, value string) bool {
	for _, option := range options {
		if option.Value == value {
			return true
		}
	}
	return false
}
