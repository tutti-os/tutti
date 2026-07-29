package modelcatalog

import "strings"

// SelectModel resolves one effective model and projects only that model's
// reasoning and speed capabilities. A non-empty requested value remains the
// effective model even when a provider omits it from a partial catalog; in
// that case its capabilities are intentionally unadvertised. Without a
// request, the catalog default, then the first model, wins.
func SelectModel(models []ModelOption, requested string) ModelSelection {
	selected, found := effectiveModel(models, requested)
	if !found {
		return ModelSelection{}
	}
	selection := ModelSelection{
		Model:                      cloneModelOption(selected),
		Found:                      true,
		ReasoningEffortsAdvertised: selected.ReasoningEffortsAdvertised,
		ReasoningEfforts:           append([]ReasoningEffortOption(nil), selected.SupportedReasoningEfforts...),
		SpeedsAdvertised:           selected.SpeedsAdvertised,
		Speeds:                     append([]SpeedOption(nil), selected.SupportedSpeeds...),
	}
	selection.DefaultReasoningEffort = validReasoningDefault(selection.ReasoningEfforts, selected.DefaultReasoningEffort)
	selection.DefaultSpeed = validSpeedDefault(selection.Speeds, selected.DefaultSpeed)
	return selection
}

func effectiveModel(models []ModelOption, requested string) (ModelOption, bool) {
	requested = strings.TrimSpace(requested)
	if requested != "" {
		for _, model := range models {
			if strings.TrimSpace(model.ID) == requested {
				return model, true
			}
		}
		return ModelOption{ID: requested, DisplayName: requested}, true
	}
	for _, model := range models {
		if model.IsDefault && strings.TrimSpace(model.ID) != "" {
			return model, true
		}
	}
	for _, model := range models {
		if strings.TrimSpace(model.ID) != "" {
			return model, true
		}
	}
	return ModelOption{}, false
}

func validReasoningDefault(options []ReasoningEffortOption, requested string) string {
	requested = strings.TrimSpace(requested)
	for _, option := range options {
		if strings.TrimSpace(option.Value) == requested && requested != "" {
			return requested
		}
	}
	for _, option := range options {
		if option.Default && strings.TrimSpace(option.Value) != "" {
			return strings.TrimSpace(option.Value)
		}
	}
	if len(options) > 0 {
		return strings.TrimSpace(options[0].Value)
	}
	return ""
}

func validSpeedDefault(options []SpeedOption, requested string) string {
	requested = strings.TrimSpace(requested)
	for _, option := range options {
		if strings.TrimSpace(option.Value) == requested && requested != "" {
			return requested
		}
	}
	if len(options) > 0 {
		return strings.TrimSpace(options[0].Value)
	}
	return ""
}

func cloneModelOption(model ModelOption) ModelOption {
	model.SupportedReasoningEfforts = append([]ReasoningEffortOption(nil), model.SupportedReasoningEfforts...)
	model.SupportedSpeeds = append([]SpeedOption(nil), model.SupportedSpeeds...)
	if model.SupportsImageInput != nil {
		value := *model.SupportsImageInput
		model.SupportsImageInput = &value
	}
	return model
}
