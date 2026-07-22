package runtimeprep

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// OpenCodePreparer materializes a bound model access plan for OpenCode
// sessions. OpenCode natively speaks the OpenAI-compatible wire protocol via
// @ai-sdk/openai-compatible, so an "openai" plan needs no protocol conversion:
// the preparer writes a session-scoped opencode.json provider block and points
// OPENCODE_CONFIG at it. The API key stays out of the file — the config
// references it with an {env:...} token, which OpenCode substitutes for
// file-based config sources (inline OPENCODE_CONFIG_CONTENT does not
// substitute tokens, which is why the provider block must travel as a file).
type OpenCodePreparer struct{}

func (OpenCodePreparer) Provider() string {
	return "opencode"
}

func (OpenCodePreparer) Prepare(_ context.Context, input ProviderPrepareInput) (ProviderPrepareResult, error) {
	if !input.ModelEndpoint.supportsOpenCode() {
		return ProviderPrepareResult{Cwd: input.Cwd}, nil
	}
	configDir := filepath.Join(input.RuntimeRoot, "opencode")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return ProviderPrepareResult{}, fmt.Errorf("create opencode config directory: %w", err)
	}
	content, err := openCodeModelPlanConfig(input.ModelEndpoint)
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	configPath := filepath.Join(configDir, "opencode.json")
	if err := os.WriteFile(configPath, content, 0o600); err != nil {
		return ProviderPrepareResult{}, fmt.Errorf("write opencode model plan config: %w", err)
	}
	if input.Manifest != nil {
		input.Manifest.RecordManagedFile(configPath, "opencode-model-plan-config", true)
	}
	return ProviderPrepareResult{
		Cwd: input.Cwd,
		Env: []string{
			// The session-scoped config merges as OpenCode's environment
			// config layer; the adapter's OPENCODE_CONFIG_CONTENT (session
			// settings) still overrides scalar keys such as `model`.
			"OPENCODE_CONFIG=" + configPath,
			ModelPlanAPIKeyEnv + "=" + input.ModelEndpoint.APIKey,
		},
	}, nil
}

type openCodeConfigDocument struct {
	Schema   string                            `json:"$schema,omitempty"`
	Model    string                            `json:"model,omitempty"`
	Provider map[string]openCodeProviderConfig `json:"provider"`
}

type openCodeProviderConfig struct {
	NPM     string                         `json:"npm"`
	Name    string                         `json:"name,omitempty"`
	Options openCodeProviderOptions        `json:"options"`
	Models  map[string]openCodeModelConfig `json:"models"`
}

type openCodeProviderOptions struct {
	BaseURL string `json:"baseURL"`
	APIKey  string `json:"apiKey"`
}

type openCodeModelConfig struct {
	Name string `json:"name,omitempty"`
}

// openCodeModelPlanConfig renders the session-scoped opencode.json for a bound
// plan. The credential never enters the file: options.apiKey carries an
// {env:...} token resolved by OpenCode from the session process environment.
func openCodeModelPlanConfig(endpoint *ModelEndpointConfig) ([]byte, error) {
	models := make(map[string]openCodeModelConfig, len(endpoint.Models))
	for _, model := range endpoint.Models {
		id := strings.TrimSpace(model.ID)
		if id == "" {
			continue
		}
		models[id] = openCodeModelConfig{Name: strings.TrimSpace(model.Name)}
	}
	if defaultModel := OpenCodePlanModelID(endpoint.Model); defaultModel != "" {
		if _, exists := models[defaultModel]; !exists {
			models[defaultModel] = openCodeModelConfig{}
		}
	}
	document := openCodeConfigDocument{
		Schema: "https://opencode.ai/config.json",
		Model:  OpenCodePlanModelValue(endpoint.Model),
		Provider: map[string]openCodeProviderConfig{
			ModelPlanProviderID: {
				NPM:  "@ai-sdk/openai-compatible",
				Name: planProviderDisplayName(endpoint),
				Options: openCodeProviderOptions{
					BaseURL: strings.TrimSpace(endpoint.BaseURL),
					APIKey:  "{env:" + ModelPlanAPIKeyEnv + "}",
				},
				Models: models,
			},
		},
	}
	content, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode opencode model plan config: %w", err)
	}
	return append(content, '\n'), nil
}
