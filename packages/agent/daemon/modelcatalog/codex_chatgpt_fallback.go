package modelcatalog

import (
	_ "embed"
	"encoding/json"
	"sync"
)

// CodexChatGPTFallbackSource labels composer/runtime catalogs that are serving
// the local ChatGPT-subscription fallback instead of a live model/list result.
const CodexChatGPTFallbackSource = "codex-fallback"

//go:embed codex_chatgpt_fallback_models.json
var codexChatGPTFallbackModelsJSON []byte

var (
	codexChatGPTFallbackOnce    sync.Once
	codexChatGPTFallbackOptions []ModelOption
	codexChatGPTFallbackRaw     []map[string]any
)

func loadCodexChatGPTFallbackModels() {
	codexChatGPTFallbackOnce.Do(func() {
		var models []map[string]any
		if err := json.Unmarshal(codexChatGPTFallbackModelsJSON, &models); err != nil {
			return
		}
		options := make([]ModelOption, 0, len(models))
		raw := make([]map[string]any, 0, len(models))
		for _, model := range models {
			encoded, err := json.Marshal(model)
			if err != nil {
				continue
			}
			normalized, ok := NormalizeCodexModel(encoded)
			if !ok {
				continue
			}
			options = append(options, normalized)
			raw = append(raw, cloneStringAnyMap(model))
		}
		codexChatGPTFallbackOptions = options
		codexChatGPTFallbackRaw = raw
	})
}

// CodexChatGPTFallbackModelOptions returns the picker-ready ChatGPT
// subscription fallback catalog used when live model/list is empty or slow.
func CodexChatGPTFallbackModelOptions() []ModelOption {
	loadCodexChatGPTFallbackModels()
	if len(codexChatGPTFallbackOptions) == 0 {
		return nil
	}
	cloned := make([]ModelOption, len(codexChatGPTFallbackOptions))
	copy(cloned, codexChatGPTFallbackOptions)
	return cloned
}

// CodexChatGPTFallbackAppServerModels returns the same fallback catalog in the
// app-server model/list shape consumed by the Codex session adapter.
func CodexChatGPTFallbackAppServerModels() []map[string]any {
	loadCodexChatGPTFallbackModels()
	if len(codexChatGPTFallbackRaw) == 0 {
		return nil
	}
	cloned := make([]map[string]any, 0, len(codexChatGPTFallbackRaw))
	for _, model := range codexChatGPTFallbackRaw {
		cloned = append(cloned, cloneStringAnyMap(model))
	}
	return cloned
}

func cloneStringAnyMap(input map[string]any) map[string]any {
	if input == nil {
		return nil
	}
	cloned := make(map[string]any, len(input))
	for key, value := range input {
		switch typed := value.(type) {
		case []any:
			cloned[key] = cloneAnySlice(typed)
		case map[string]any:
			cloned[key] = cloneStringAnyMap(typed)
		default:
			cloned[key] = value
		}
	}
	return cloned
}

func cloneAnySlice(input []any) []any {
	cloned := make([]any, len(input))
	for i, value := range input {
		switch typed := value.(type) {
		case []any:
			cloned[i] = cloneAnySlice(typed)
		case map[string]any:
			cloned[i] = cloneStringAnyMap(typed)
		default:
			cloned[i] = value
		}
	}
	return cloned
}
