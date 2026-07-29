package modelcatalog

import "strings"

// ComposerCatalogProjection is the provider-neutral projection of a model
// catalog into the model, reasoning, and speed dimensions exposed by a
// composer. Product services remain responsible only for localization and
// transport DTOs.
type ComposerCatalogProjection struct {
	Selection               ModelSelection
	ReasoningOptionsByModel map[string]ReasoningProfile
}

type ReasoningProfile struct {
	DefaultValue string
	Options      []ReasoningEffortOption
}

// ProjectComposerCatalog preserves every model's advertised capabilities and
// resolves the effective model in one shared owner. Callers must not replace an
// advertised empty capability set with provider-wide static options.
func ProjectComposerCatalog(models []ModelOption, requestedModel string) ComposerCatalogProjection {
	projection := ComposerCatalogProjection{
		Selection:               SelectModel(models, requestedModel),
		ReasoningOptionsByModel: make(map[string]ReasoningProfile),
	}
	for _, model := range models {
		modelID := strings.TrimSpace(model.ID)
		if modelID == "" || !model.ReasoningEffortsAdvertised {
			continue
		}
		options := append([]ReasoningEffortOption(nil), model.SupportedReasoningEfforts...)
		projection.ReasoningOptionsByModel[modelID] = ReasoningProfile{
			DefaultValue: validReasoningDefault(options, model.DefaultReasoningEffort),
			Options:      options,
		}
	}
	return projection
}
