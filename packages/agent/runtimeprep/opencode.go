package runtimeprep

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// OpenCodePreparer creates a session-scoped native config directory containing
// Tutti runtime instructions and Skills. A bound OpenAI-compatible model plan
// also gains an opencode.json provider block in that directory; its API key
// stays out of the file because the config references an {env:...} token.
type OpenCodePreparer struct{}

func (OpenCodePreparer) Provider() string {
	return "opencode"
}

func (OpenCodePreparer) Prepare(_ context.Context, input ProviderPrepareInput) (ProviderPrepareResult, error) {
	configDir := filepath.Join(input.RuntimeRoot, "opencode")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return ProviderPrepareResult{}, fmt.Errorf("create opencode config directory: %w", err)
	}
	policy, err := tuttiCLIPolicy(input.PrepareInput)
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	instructionsPath := filepath.Join(configDir, "AGENTS.md")
	writeResult, err := input.Store.WriteManagedBlock(instructionsPath, policy)
	if err != nil {
		return ProviderPrepareResult{}, err
	}
	if err := ensureRTKInstructionsReferenceFirst(instructionsPath, input.PrepareInput); err != nil {
		return ProviderPrepareResult{}, err
	}
	if _, err := installProviderNativeSkillsSessionScoped(filepath.Join(configDir, "skills"), input.PrepareInput); err != nil {
		return ProviderPrepareResult{}, fmt.Errorf("install opencode tutti skills: %w", err)
	}
	if input.RTKSaverMode {
		if err := installOpenCodeRTKPlugin(configDir); err != nil {
			return ProviderPrepareResult{}, err
		}
	}
	if input.Manifest != nil {
		input.Manifest.RecordManagedFile(instructionsPath, "provider-instructions", writeResult.Created)
		input.Manifest.RecordManagedFile(configDir, "opencode-home", true)
	}
	env := []string{"OPENCODE_CONFIG_DIR=" + configDir}
	if !input.ModelEndpoint.supportsOpenCode() {
		return ProviderPrepareResult{Cwd: input.Cwd, Env: env}, nil
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
		Env: append(env,
			// The session-scoped config merges as OpenCode's environment
			// config layer; the adapter's OPENCODE_CONFIG_CONTENT (session
			// settings) still overrides scalar keys such as `model`.
			"OPENCODE_CONFIG="+configPath,
			ModelPlanAPIKeyEnv+"="+input.ModelEndpoint.APIKey,
		),
	}, nil
}

const openCodeRTKPlugin = `import type { Plugin } from "@opencode-ai/plugin"

// Session-scoped RTK adapter. Rewrite behavior stays in the bundled RTK
// executable so this plugin does not duplicate the command registry.
export const RtkOpenCodePlugin: Plugin = async ({ $ }) => ({
  "tool.execute.before": async (input, output) => {
    const tool = String(input?.tool ?? "").toLowerCase()
    if (tool !== "bash" && tool !== "shell") return
    const args = output?.args
    if (!args || typeof args !== "object") return
    const command = (args as Record<string, unknown>).command
    if (typeof command !== "string" || !command) return

    try {
      const result = await $` + "`rtk rewrite ${command}`" + `.quiet().nothrow()
      const rewritten = String(result.stdout).trim()
      if (rewritten && rewritten !== command) {
        ;(args as Record<string, unknown>).command = rewritten
      }
    } catch {
      // RTK is an optimization. Preserve the original command on failure.
    }
  },
})
`

func installOpenCodeRTKPlugin(configDir string) error {
	pluginsDir := filepath.Join(configDir, "plugins")
	if err := os.MkdirAll(pluginsDir, 0o700); err != nil {
		return fmt.Errorf("create opencode RTK plugin directory: %w", err)
	}
	if err := os.WriteFile(filepath.Join(pluginsDir, "rtk.ts"), []byte(openCodeRTKPlugin), 0o600); err != nil {
		return fmt.Errorf("write opencode RTK plugin: %w", err)
	}
	return nil
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
