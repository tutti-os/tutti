package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agentactivity/daemon/httpx"
)

const (
	geminiSettingsSchemaURL     = "https://raw.githubusercontent.com/google-gemini/gemini-cli/main/schemas/settings.schema.json"
	geminiSettingsSchemaTimeout = 2500 * time.Millisecond
)

var geminiAliasOrder = map[string]int{
	"auto":       0,
	"pro":        1,
	"flash":      2,
	"flash-lite": 3,
}

var geminiCLIFallbackModels = []AgentModelOption{
	{ID: "auto", DisplayName: "auto", Description: "Gemini CLI model alias", IsDefault: true},
	{ID: "pro", DisplayName: "pro", Description: "Gemini CLI model alias"},
	{ID: "flash", DisplayName: "flash", Description: "Gemini CLI model alias"},
	{ID: "flash-lite", DisplayName: "flash-lite", Description: "Gemini CLI model alias"},
	{ID: "auto-gemini-3", DisplayName: "auto-gemini-3", Description: "Gemini CLI model"},
	{ID: "auto-gemini-2.5", DisplayName: "auto-gemini-2.5", Description: "Gemini CLI model"},
	{ID: "gemini-3.1-pro-preview", DisplayName: "gemini-3.1-pro-preview", Description: "Gemini CLI model"},
	{ID: "gemini-3-pro-preview", DisplayName: "gemini-3-pro-preview", Description: "Gemini CLI model"},
	{ID: "gemini-3-flash-preview", DisplayName: "gemini-3-flash-preview", Description: "Gemini CLI model"},
	{ID: "gemini-2.5-pro", DisplayName: "gemini-2.5-pro", Description: "Gemini CLI model"},
	{ID: "gemini-2.5-flash", DisplayName: "gemini-2.5-flash", Description: "Gemini CLI model"},
	{ID: "gemini-2.5-flash-lite", DisplayName: "gemini-2.5-flash-lite", Description: "Gemini CLI model"},
}

type GeminiCLIModelLister struct {
	URL    string
	Client *http.Client
}

func (l GeminiCLIModelLister) ListModels(ctx context.Context) (AgentModelListResult, error) {
	models, err := l.listModelsFromSchema(ctx)
	if err != nil || len(models) == 0 {
		return AgentModelListResult{
			Models:     cloneAgentModelOptions(geminiCLIFallbackModels),
			IsFallback: true,
		}, nil
	}
	return AgentModelListResult{Models: models}, nil
}

func (l GeminiCLIModelLister) listModelsFromSchema(ctx context.Context) ([]AgentModelOption, error) {
	url := strings.TrimSpace(l.URL)
	if url == "" {
		url = geminiSettingsSchemaURL
	}
	requestCtx, cancel := context.WithTimeout(ctx, geminiSettingsSchemaTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("accept", "application/json")
	client := l.Client
	if client == nil {
		client = httpx.Default()
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("fetch Gemini CLI settings schema: %s", response.Status)
	}
	var schema map[string]any
	if err := json.NewDecoder(response.Body).Decode(&schema); err != nil {
		return nil, err
	}
	return extractGeminiModelOptionsFromSchema(schema), nil
}

func extractGeminiModelOptionsFromSchema(schema map[string]any) []AgentModelOption {
	properties := mapValue(schema, "properties")
	modelConfigs := mapValue(properties, "modelConfigs")
	defaults := mapValue(modelConfigs, "default")
	modelDefinitions := mapValue(defaults, "modelDefinitions")
	modelIDResolutions := mapValue(defaults, "modelIdResolutions")
	if len(modelDefinitions) == 0 || len(modelIDResolutions) == 0 {
		return nil
	}
	modelsByID := make(map[string]AgentModelOption)
	for alias := range modelIDResolutions {
		if strings.HasPrefix(alias, "gemini-") || strings.HasPrefix(alias, "auto-gemini-") {
			continue
		}
		modelsByID[alias] = AgentModelOption{
			ID:          alias,
			DisplayName: alias,
			Description: "Gemini CLI model alias",
			IsDefault:   alias == "auto",
		}
	}
	for modelID, rawDefinition := range modelDefinitions {
		definition, ok := rawDefinition.(map[string]any)
		if !ok || !boolValue(definition, "isVisible") {
			continue
		}
		displayName := stringValue(definition, "displayName")
		if displayName == "" {
			displayName = modelID
		}
		modelsByID[modelID] = AgentModelOption{
			ID:          modelID,
			DisplayName: displayName,
			Description: stringValue(definition, "dialogDescription"),
		}
	}
	models := make([]AgentModelOption, 0, len(modelsByID))
	for _, model := range modelsByID {
		models = append(models, model)
	}
	sortGeminiModelOptions(models)
	if len(models) > 0 && !agentModelOptionsHaveDefault(models) {
		defaultIndex := 0
		for index, model := range models {
			if model.ID == "auto" {
				defaultIndex = index
				break
			}
		}
		models[defaultIndex].IsDefault = true
	}
	return models
}

func sortGeminiModelOptions(models []AgentModelOption) {
	sort.SliceStable(models, func(leftIndex, rightIndex int) bool {
		left := models[leftIndex].ID
		right := models[rightIndex].ID
		leftAlias, leftIsAlias := geminiAliasOrder[left]
		rightAlias, rightIsAlias := geminiAliasOrder[right]
		if leftIsAlias || rightIsAlias {
			if !leftIsAlias {
				return false
			}
			if !rightIsAlias {
				return true
			}
			return leftAlias < rightAlias
		}
		leftAuto := strings.HasPrefix(left, "auto-gemini-")
		rightAuto := strings.HasPrefix(right, "auto-gemini-")
		if leftAuto != rightAuto {
			return leftAuto
		}
		leftVersion := geminiVersion(left)
		rightVersion := geminiVersion(right)
		if leftVersion != rightVersion {
			return rightVersion < leftVersion
		}
		leftTier := geminiTierWeight(left)
		rightTier := geminiTierWeight(right)
		if leftTier != rightTier {
			return leftTier < rightTier
		}
		return strings.Compare(left, right) < 0
	})
}

func geminiTierWeight(modelID string) int {
	switch {
	case strings.Contains(modelID, "pro"):
		return 0
	case strings.Contains(modelID, "flash-lite"):
		return 2
	case strings.Contains(modelID, "flash"):
		return 1
	default:
		return 3
	}
}

func geminiVersion(modelID string) float64 {
	for _, prefix := range []string{"auto-gemini-", "gemini-"} {
		if !strings.HasPrefix(modelID, prefix) {
			continue
		}
		remainder := strings.TrimPrefix(modelID, prefix)
		end := 0
		for end < len(remainder) {
			char := remainder[end]
			if (char < '0' || char > '9') && char != '.' {
				break
			}
			end += 1
		}
		if end == 0 {
			return -1
		}
		version, err := strconv.ParseFloat(remainder[:end], 64)
		if err != nil {
			return -1
		}
		return version
	}
	return -1
}

func agentModelOptionsHaveDefault(models []AgentModelOption) bool {
	for _, model := range models {
		if model.IsDefault {
			return true
		}
	}
	return false
}

func mapValue(object map[string]any, key string) map[string]any {
	value, ok := object[key].(map[string]any)
	if !ok {
		return nil
	}
	return value
}

func stringValue(object map[string]any, key string) string {
	value, ok := object[key].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(value)
}

func boolValue(object map[string]any, key string) bool {
	value, ok := object[key].(bool)
	return ok && value
}
