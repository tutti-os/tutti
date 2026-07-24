package runtimeprep

import (
	"net/url"
	"strconv"
	"strings"
)

// ModelEndpointConfig injects a managed model access plan endpoint into a
// provider runtime for one session. The credential travels only through the
// session process environment or the session-scoped provider config; it must
// never be logged, recorded in manifests, or echoed into instructions.
type ModelEndpointConfig struct {
	PlanID   string
	PlanName string
	// Protocol is the plan wire protocol family: "openai" or "anthropic".
	Protocol string
	BaseURL  string
	APIKey   string
	// WireAPI is the provider-facing endpoint shape. Codex accepts "chat" or
	// "responses"; daemon gateways set "responses" while legacy/direct
	// callers retain "chat" when this field is empty.
	WireAPI string
	// Model is the default model id for the session; providers may still
	// switch models within the plan on later calls.
	Model string
	// Models lists every model the plan authorizes (redaction-safe ids and
	// display names). Providers that materialize a session-scoped catalog
	// (OpenCode's provider block) need the full list, not just the default.
	Models              []ModelEndpointModel
	PlanUpdatedAtUnixMS int64
}

// ModelEndpointModel is one selectable model exposed by the bound plan.
type ModelEndpointModel struct {
	ID   string
	Name string
}

// ModelPlanProviderID names the provider entry injected into a session-scoped
// provider config (Codex `[model_providers.*]` table, OpenCode `provider`
// block). The service layer namespaces OpenCode composer model values with the
// same id, so the two sides must never drift.
const ModelPlanProviderID = "tutti-model-plan"

// codexModelPlanProviderID names the injected Codex model provider entry.
const codexModelPlanProviderID = ModelPlanProviderID

// ModelPlanAPIKeyEnv carries the plan credential into the provider process;
// session-scoped configs reference it instead of embedding the key.
const ModelPlanAPIKeyEnv = "TUTTI_MODEL_PLAN_API_KEY"

// codexModelPlanAPIKeyEnv carries the plan credential into the Codex process.
const codexModelPlanAPIKeyEnv = ModelPlanAPIKeyEnv

func (c *ModelEndpointConfig) valid() bool {
	return c != nil && strings.TrimSpace(c.BaseURL) != "" && strings.TrimSpace(c.APIKey) != ""
}

func (c *ModelEndpointConfig) supportsCodex() bool {
	return c.valid() && strings.TrimSpace(c.Protocol) == "openai"
}

func (c *ModelEndpointConfig) supportsClaudeCode() bool {
	return c.valid() && strings.TrimSpace(c.Protocol) == "anthropic"
}

func (c *ModelEndpointConfig) supportsOpenCode() bool {
	return c.valid() && strings.TrimSpace(c.Protocol) == "openai"
}

// OpenCodePlanModelValue renders a plan model id in OpenCode's
// "<provider>/<model>" addressing, rooted at the injected provider entry.
// Already-namespaced values pass through unchanged.
func OpenCodePlanModelValue(modelID string) string {
	modelID = strings.TrimSpace(modelID)
	if modelID == "" || strings.HasPrefix(modelID, ModelPlanProviderID+"/") {
		return modelID
	}
	return ModelPlanProviderID + "/" + modelID
}

// OpenCodePlanModelID strips the injected-provider namespace from an OpenCode
// composer model value, returning the plan-domain model id.
func OpenCodePlanModelID(value string) string {
	return strings.TrimPrefix(strings.TrimSpace(value), ModelPlanProviderID+"/")
}

// modelEndpointClaudeEnv maps an anthropic-protocol plan endpoint onto the
// Claude Code environment contract. Anthropic's official endpoint and Kimi
// Coding authenticate with ANTHROPIC_API_KEY (x-api-key); relays and other
// coding-plan gateways generally expect the bearer ANTHROPIC_AUTH_TOKEN form.
func modelEndpointClaudeEnv(endpoint *ModelEndpointConfig) []string {
	if !endpoint.supportsClaudeCode() {
		return nil
	}
	baseURL := strings.TrimSpace(endpoint.BaseURL)
	env := []string{"ANTHROPIC_BASE_URL=" + strings.TrimSuffix(baseURL, "/v1")}
	if modelEndpointUsesAnthropicAPIKey(baseURL) {
		env = append(
			env,
			"ANTHROPIC_API_KEY="+endpoint.APIKey,
			"ANTHROPIC_AUTH_TOKEN=",
		)
	} else {
		env = append(
			env,
			"ANTHROPIC_AUTH_TOKEN="+endpoint.APIKey,
			"ANTHROPIC_API_KEY=",
		)
	}
	return env
}

func modelEndpointUsesAnthropicAPIKey(baseURL string) bool {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return false
	}
	switch strings.ToLower(parsed.Hostname()) {
	case "api.anthropic.com", "api.kimi.com":
		return true
	default:
		return false
	}
}

// codexConfigWithModelPlanEndpoint rewrites the session-scoped Codex
// config.toml to route through the injected plan endpoint: it pins the
// top-level model_provider (and default model when supplied) and appends the
// provider table. The API key stays out of the file; Codex reads it from the
// session env via env_key.
func codexConfigWithModelPlanEndpoint(content string, endpoint *ModelEndpointConfig) (string, bool) {
	if !endpoint.supportsCodex() {
		return content, false
	}
	next := codexConfigWithTopLevelAssignment(content, "model_provider", strconv.Quote(codexModelPlanProviderID))
	if model := strings.TrimSpace(endpoint.Model); model != "" {
		next = codexConfigWithTopLevelAssignment(next, "model", strconv.Quote(model))
	}
	table := "[model_providers." + codexModelPlanProviderID + "]\n" +
		"name = " + strconv.Quote(planProviderDisplayName(endpoint)) + "\n" +
		"base_url = " + strconv.Quote(strings.TrimSpace(endpoint.BaseURL)) + "\n" +
		"env_key = " + strconv.Quote(codexModelPlanAPIKeyEnv) + "\n" +
		"wire_api = " + strconv.Quote(codexModelEndpointWireAPI(endpoint)) + "\n"
	if !strings.Contains(next, "[model_providers."+codexModelPlanProviderID+"]") {
		if strings.TrimSpace(next) == "" {
			next = table
		} else {
			next = strings.TrimRight(next, "\r\n") + "\n\n" + table
		}
	}
	return next, next != content
}

func codexModelEndpointWireAPI(endpoint *ModelEndpointConfig) string {
	if endpoint != nil && strings.TrimSpace(endpoint.WireAPI) == "responses" {
		return "responses"
	}
	return "chat"
}

func planProviderDisplayName(endpoint *ModelEndpointConfig) string {
	if name := strings.TrimSpace(endpoint.PlanName); name != "" {
		return name
	}
	return "Tutti Model Plan"
}

// codexConfigWithTopLevelAssignment replaces the first top-level assignment of
// key before any table header, or prepends the assignment when the key is
// absent.
func codexConfigWithTopLevelAssignment(content string, key string, encodedValue string) string {
	line := key + " = " + encodedValue
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	for index, existingLine := range lines {
		trimmed := strings.TrimSpace(existingLine)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			break
		}
		if !codexConfigLineHasKey(trimmed, key) {
			continue
		}
		nextLines := append([]string{}, lines...)
		nextLines[index] = line
		return strings.Join(nextLines, "\n")
	}
	if strings.TrimSpace(content) == "" {
		return line + "\n"
	}
	return line + "\n" + strings.TrimLeft(content, "\r\n")
}
