package agent

import (
	"context"
	"log/slog"
	"strings"
)

type composerModelCatalogProjection struct {
	DefaultModel               string
	ModelOptions               []ComposerConfigOptionValue
	ReasoningProfiles          map[string]composerModelReasoningProfile
	DefaultReasoningEffort     string
	ReasoningEfforts           []AgentModelReasoningEffortOption
	ReasoningEffortsAdvertised bool
	Source                     string
}

func composerModelOptionsFromCatalog(ctx context.Context, catalog AgentModelCatalog, provider string, cwd string, selectedModel string) (composerModelCatalogProjection, bool) {
	if catalog == nil {
		return composerModelCatalogProjection{}, false
	}
	result, err := catalog.ListModels(ctx, AgentModelCatalogInput{Provider: provider, Cwd: cwd})
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
	defaultModel := ""
	for _, model := range result.Models {
		id := strings.TrimSpace(model.ID)
		if id == "" {
			continue
		}
		if defaultModel == "" && model.IsDefault {
			defaultModel = id
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
		options = append(options, ComposerConfigOptionValue{ID: selected, Label: selected, Value: selected})
	}
	projection := composerModelCatalogProjection{
		DefaultModel:      defaultModel,
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
