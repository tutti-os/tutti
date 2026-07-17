package agent

import (
	"context"
	"log/slog"
	"strings"
)

func composerOptionsProviderUsesModelCatalog(provider string) bool {
	return composerProfileFor(provider).UsesModelCatalog
}

func composerModelConfig(provider string, selected string, options []ComposerConfigOptionValue) ComposerConfigOption {
	if composerProfileFor(provider).Behavior.ModelOptionsAuthoritative {
		return ComposerConfigOption{}
	}
	values := make([]ComposerConfigOptionValue, 0, len(options))
	for _, option := range options {
		value := strings.TrimSpace(option.Value)
		if value == "" {
			continue
		}
		label := strings.TrimSpace(option.Label)
		if label == "" {
			label = value
		}
		values = append(values, ComposerConfigOptionValue{
			ID:                 value,
			Label:              label,
			Value:              value,
			Description:        strings.TrimSpace(option.Description),
			SupportsImageInput: option.SupportsImageInput,
			Requested:          option.Requested,
		})
	}
	selected = strings.TrimSpace(selected)
	return ComposerConfigOption{
		Configurable: composerProfileFor(provider).ModelSelection,
		CurrentValue: selected,
		DefaultValue: selected,
		Options:      values,
	}
}

type composerModelCatalogProjection struct {
	ModelOptions               []ComposerConfigOptionValue
	ReasoningProfiles          map[string]composerModelReasoningProfile
	DefaultReasoningEffort     string
	ReasoningEfforts           []AgentModelReasoningEffortOption
	ReasoningEffortsAdvertised bool
	Source                     string
}

func composerModelOptionsFromCatalog(ctx context.Context, catalog AgentModelCatalog, provider string, selectedModel string) (composerModelCatalogProjection, bool) {
	if catalog == nil {
		return composerModelCatalogProjection{}, false
	}
	result, err := catalog.ListModels(ctx, provider)
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
	options := make([]ComposerConfigOptionValue, 0, len(result.Models)+1)
	reasoningProfiles := make(map[string]composerModelReasoningProfile)
	for _, model := range result.Models {
		id := strings.TrimSpace(model.ID)
		if id == "" {
			continue
		}
		if containsModelOption(options, id) {
			continue
		}
		name := strings.TrimSpace(model.DisplayName)
		if name == "" {
			name = id
		}
		options = append(options, ComposerConfigOptionValue{
			ID:                 id,
			Label:              name,
			Value:              id,
			Description:        strings.TrimSpace(model.Description),
			SupportsImageInput: model.SupportsImageInput,
		})
		if model.ReasoningEffortsAdvertised {
			reasoningProfiles[id] = composerModelReasoningProfile{
				DefaultReasoningEffort: strings.TrimSpace(model.DefaultReasoningEffort),
				ReasoningEfforts: append(
					[]AgentModelReasoningEffortOption(nil),
					model.SupportedReasoningEfforts...,
				),
			}
		}
	}
	selected := strings.TrimSpace(selectedModel)
	if selected != "" && !containsModelOption(options, selected) {
		// The requested model is kept selectable even when the catalog does not
		// contain it, but the entry is provenance-marked: it mirrors the request
		// and is not catalog testimony (create validation runs against the raw
		// catalog and would reject it).
		options = append(options, ComposerConfigOptionValue{ID: selected, Label: selected, Value: selected, Requested: true})
	}
	projection := composerModelCatalogProjection{
		ModelOptions:      options,
		ReasoningProfiles: reasoningProfiles,
		Source:            strings.TrimSpace(result.Source),
	}
	if profile, ok := reasoningProfiles[selected]; ok {
		projection.DefaultReasoningEffort = profile.DefaultReasoningEffort
		projection.ReasoningEfforts = append([]AgentModelReasoningEffortOption(nil), profile.ReasoningEfforts...)
		projection.ReasoningEffortsAdvertised = true
	}
	return projection, true
}

func containsModelOption(options []ComposerConfigOptionValue, value string) bool {
	for _, option := range options {
		if option.Value == value {
			return true
		}
	}
	return false
}

func composerSelectedModelOptions(model string) []ComposerConfigOptionValue {
	model = strings.TrimSpace(model)
	if model == "" {
		return []ComposerConfigOptionValue{}
	}
	// Bootstrap echo: the sole entry mirrors the requested/effective settings,
	// so it carries the requested provenance marker.
	return []ComposerConfigOptionValue{{ID: model, Label: model, Value: model, Requested: true}}
}

func reasoningConfigOptionID(provider string) string {
	return strings.TrimSpace(composerProfileFor(provider).ReasoningConfigOptionID)
}
