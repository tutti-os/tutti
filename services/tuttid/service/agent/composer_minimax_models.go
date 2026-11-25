package agent

import "strings"

// OpenCode's built-in Zen catalog is distinct from user-configured providers.
// Keep the raw catalog for create validation and explicit legacy selections;
// only the ordinary composer choices follow the current MiniMax text lineup.
func composerOpenCodeMiniMaxModels(models []AgentModelOption, selected string) []AgentModelOption {
	selected = strings.TrimSpace(selected)
	var current []AgentModelOption
	for _, id := range []string{"opencode/minimax-m3.1-flash-free", "opencode/minimax-m3"} {
		for _, model := range models {
			if model.ID == id {
				current = append(current, model)
				break
			}
		}
	}
	result := make([]AgentModelOption, 0, len(models))
	inserted := false
	for _, model := range models {
		if !isOpenCodeMiniMaxTextModel(model.ID) {
			result = append(result, model)
			continue
		}
		if !inserted {
			result = append(result, current...)
			inserted = true
		}
		if model.ID == selected && model.ID != "opencode/minimax-m3.1-flash-free" && model.ID != "opencode/minimax-m3" {
			result = append(result, model)
		}
	}
	// Transfer only a MiniMax default. Other providers' defaults and explicit
	// requests must never be replaced by a MiniMax recommendation.
	miniMaxDefault := false
	for _, model := range models {
		if model.IsDefault && isOpenCodeMiniMaxTextModel(model.ID) {
			miniMaxDefault = true
		}
	}
	if miniMaxDefault && len(current) > 0 {
		for index := range result {
			if isOpenCodeMiniMaxTextModel(result[index].ID) {
				result[index].IsDefault = result[index].ID == current[0].ID
			}
		}
	}
	return result
}

func isOpenCodeMiniMaxTextModel(id string) bool {
	// Exact built-in IDs avoid classifying custom aliases or media models by
	// their display name. Unknown provider entries remain provider-owned.
	switch id {
	case "opencode/minimax-m1", "opencode/minimax-m2", "opencode/minimax-m2.1",
		"opencode/minimax-m2.1-free", "opencode/minimax-m2.5", "opencode/minimax-m2.5-free",
		"opencode/minimax-m2.7", "opencode/minimax-m2.7-free",
		"opencode/minimax-m3", "opencode/minimax-m3.1-flash-free":
		return true
	default:
		return false
	}
}
