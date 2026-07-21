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
	// Model is the default model id for the session; providers may still
	// switch models within the plan on later calls.
	Model string
}

// codexModelPlanProviderID names the injected Codex model provider entry.
const codexModelPlanProviderID = "tutti-model-plan"

// codexModelPlanAPIKeyEnv carries the plan credential into the Codex process.
const codexModelPlanAPIKeyEnv = "TUTTI_MODEL_PLAN_API_KEY"

func (c *ModelEndpointConfig) valid() bool {
	return c != nil && strings.TrimSpace(c.BaseURL) != "" && strings.TrimSpace(c.APIKey) != ""
}

func (c *ModelEndpointConfig) supportsCodex() bool {
	return c.valid() && strings.TrimSpace(c.Protocol) == "openai"
}

func (c *ModelEndpointConfig) supportsClaudeCode() bool {
	return c.valid() && strings.TrimSpace(c.Protocol) == "anthropic"
}

// modelEndpointClaudeEnv maps an anthropic-protocol plan endpoint onto the
// Claude Code environment contract. Official API endpoints authenticate with
// ANTHROPIC_API_KEY (x-api-key); relays and coding-plan gateways generally
// expect the bearer ANTHROPIC_AUTH_TOKEN form.
func modelEndpointClaudeEnv(endpoint *ModelEndpointConfig) []string {
	if !endpoint.supportsClaudeCode() {
		return nil
	}
	baseURL := strings.TrimSpace(endpoint.BaseURL)
	env := []string{"ANTHROPIC_BASE_URL=" + strings.TrimSuffix(baseURL, "/v1")}
	if modelEndpointIsOfficialAnthropic(baseURL) {
		env = append(env, "ANTHROPIC_API_KEY="+endpoint.APIKey)
	} else {
		env = append(env, "ANTHROPIC_AUTH_TOKEN="+endpoint.APIKey)
	}
	return env
}

func modelEndpointIsOfficialAnthropic(baseURL string) bool {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return false
	}
	return strings.EqualFold(parsed.Hostname(), "api.anthropic.com")
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
		"wire_api = \"chat\"\n"
	if !strings.Contains(next, "[model_providers."+codexModelPlanProviderID+"]") {
		if strings.TrimSpace(next) == "" {
			next = table
		} else {
			next = strings.TrimRight(next, "\r\n") + "\n\n" + table
		}
	}
	return next, next != content
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
