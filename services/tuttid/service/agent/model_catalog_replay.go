package agent

import (
	"context"
	"strings"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

const replayFrozenModelCatalogSource = "replay-frozen"

// FrozenAgentModelCatalog exposes only the model values recorded in a
// cassette. It deliberately has no provider lister, cache, or clock: Replay
// must be independent of the host's current CLI/model directory.
type FrozenAgentModelCatalog struct {
	models map[string]AgentModelCatalogResult
}

// NewFrozenAgentModelCatalog builds a catalog from cassette prerequisites.
// Multiple cassettes may contribute the same provider; duplicate model IDs
// are collapsed while preserving insertion order.
func NewFrozenAgentModelCatalog(models map[string][]string) *FrozenAgentModelCatalog {
	catalog := &FrozenAgentModelCatalog{
		models: make(map[string]AgentModelCatalogResult, len(models)),
	}
	for provider, modelIDs := range models {
		provider = normalizeReplayModelCatalogProvider(provider)
		if provider == "" {
			continue
		}
		seen := make(map[string]struct{}, len(modelIDs))
		options := make([]AgentModelOption, 0, len(modelIDs))
		for _, modelID := range modelIDs {
			modelID = strings.TrimSpace(modelID)
			if modelID == "" {
				continue
			}
			if _, ok := seen[modelID]; ok {
				continue
			}
			seen[modelID] = struct{}{}
			options = append(options, AgentModelOption{
				ID:          modelID,
				DisplayName: modelID,
				Description: "Recorded in the Replay cassette",
				IsDefault:   len(options) == 0,
			})
		}
		catalog.models[provider] = AgentModelCatalogResult{
			Provider: provider,
			Source:   replayFrozenModelCatalogSource,
			Models:   options,
		}
	}
	return catalog
}

func (c *FrozenAgentModelCatalog) ListModels(
	_ context.Context,
	input AgentModelCatalogInput,
) (AgentModelCatalogResult, error) {
	provider := normalizeReplayModelCatalogProvider(input.Provider)
	if c == nil {
		return AgentModelCatalogResult{Provider: provider, Source: replayFrozenModelCatalogSource}, nil
	}
	result, ok := c.models[provider]
	if !ok {
		return AgentModelCatalogResult{Provider: provider, Source: replayFrozenModelCatalogSource}, nil
	}
	return cloneAgentModelCatalogResult(result), nil
}

func normalizeReplayModelCatalogProvider(provider string) string {
	provider = strings.TrimSpace(provider)
	if normalized := agentprovider.NormalizeOpen(provider); normalized != "" {
		return normalized
	}
	return provider
}
