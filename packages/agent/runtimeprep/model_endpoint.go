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
	PlanName string
	// Protocol is the plan wire protocol family: "openai" or "anthropic".
	Protocol string
	BaseURL  string
	APIKey   string
	// Model is the default model id for the session; providers may still
	// switch models within the plan on later calls.
	Model string
	// Models lists every model the plan authorizes (redaction-safe ids and
	// display names). Providers that materialize a session-scoped catalog
	// (OpenCode's provider block) need the full list, not just the default.
	Models []ModelEndpointModel
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
	if modelEndpointIsOpenRouter(endpoint.BaseURL) {
		next = codexConfigWithOpenRouterFunctionToolsOnly(next)
	}
	table := "[model_providers." + codexModelPlanProviderID + "]\n" +
		"name = " + strconv.Quote(planProviderDisplayName(endpoint)) + "\n" +
		"base_url = " + strconv.Quote(strings.TrimSpace(endpoint.BaseURL)) + "\n" +
		"env_key = " + strconv.Quote(codexModelPlanAPIKeyEnv) + "\n" +
		"wire_api = \"responses\"\n"
	if !strings.Contains(next, "[model_providers."+codexModelPlanProviderID+"]") {
		if strings.TrimSpace(next) == "" {
			next = table
		} else {
			next = strings.TrimRight(next, "\r\n") + "\n\n" + table
		}
	}
	return next, next != content
}

func modelEndpointIsOpenRouter(baseURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return false
	}
	hostname := strings.ToLower(parsed.Hostname())
	return hostname == "openrouter.ai" || strings.HasSuffix(hostname, ".openrouter.ai")
}

// codexConfigWithOpenRouterFunctionToolsOnly keeps OpenRouter-backed model
// plans usable with Codex releases that emit native Responses API namespace
// tools. OpenRouter currently cannot route those tools to models such as
// DeepSeek, so the run-scoped config disables every known namespace source and
// hosted tool while preserving Codex's ordinary function-based coding tools.
// The user's global Codex config is never changed.
func codexConfigWithOpenRouterFunctionToolsOnly(content string) string {
	next := codexConfigWithoutTablePrefix(content, "mcp_servers")
	next = codexConfigWithTopLevelAssignment(next, "web_search", strconv.Quote("disabled"))
	for _, feature := range []string{
		"apps",
		"current_time_reminder",
		"image_generation",
		"imagegenext",
		"memories",
		"multi_agent",
		"multi_agent_v2",
		"plugins",
		"standalone_web_search",
		"tool_suggest",
	} {
		next = codexConfigWithTableAssignment(next, "features", feature, "false")
	}
	for _, table := range []string{"orchestrator.mcp", "orchestrator.skills"} {
		next = codexConfigWithTableAssignment(next, table, "enabled", "false")
	}
	return next
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

// codexConfigWithTableAssignment replaces or inserts a simple assignment in a
// TOML table. Codex's generated config only needs scalar feature flags here,
// so preserving the rest of the user's run-scoped copy is safer than
// re-serializing the whole document.
func codexConfigWithTableAssignment(content string, table string, key string, encodedValue string) string {
	line := key + " = " + encodedValue
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	for tableStart, existingLine := range lines {
		name, ok := codexConfigTableName(existingLine)
		if !ok || name != table {
			continue
		}
		tableEnd := len(lines)
		for index := tableStart + 1; index < len(lines); index++ {
			if _, ok := codexConfigTableName(lines[index]); ok {
				tableEnd = index
				break
			}
		}
		for index := tableStart + 1; index < tableEnd; index++ {
			trimmed := strings.TrimSpace(lines[index])
			if trimmed == "" || strings.HasPrefix(trimmed, "#") || !codexConfigLineHasKey(trimmed, key) {
				continue
			}
			if trimmed == line {
				return content
			}
			nextLines := append([]string{}, lines...)
			nextLines[index] = line
			return strings.Join(nextLines, "\n")
		}
		nextLines := make([]string, 0, len(lines)+1)
		nextLines = append(nextLines, lines[:tableEnd]...)
		nextLines = append(nextLines, line)
		nextLines = append(nextLines, lines[tableEnd:]...)
		return strings.Join(nextLines, "\n")
	}
	block := "[" + table + "]\n" + line + "\n"
	if strings.TrimSpace(content) == "" {
		return block
	}
	return strings.TrimRight(content, "\r\n") + "\n\n" + block
}

// codexConfigWithoutTablePrefix removes a table and all of its descendants
// from the run-scoped TOML copy. This is used for mcp_servers because merely
// disabling one known server still leaves other MCP namespaces in the model
// request.
func codexConfigWithoutTablePrefix(content string, prefix string) string {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	nextLines := make([]string, 0, len(lines))
	removing := false
	changed := false
	for _, line := range lines {
		if table, ok := codexConfigTableName(line); ok {
			removing = table == prefix || strings.HasPrefix(table, prefix+".")
		}
		if removing {
			changed = true
			continue
		}
		nextLines = append(nextLines, line)
	}
	if !changed {
		return content
	}
	return strings.TrimRight(strings.Join(nextLines, "\n"), "\n") + "\n"
}

func codexConfigTableName(line string) (string, bool) {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "[") {
		return "", false
	}
	if strings.HasPrefix(trimmed, "[[") {
		end := strings.Index(trimmed[2:], "]]")
		if end < 0 {
			return "", false
		}
		return strings.TrimSpace(trimmed[2 : end+2]), true
	}
	end := strings.IndexByte(trimmed[1:], ']')
	if end < 0 {
		return "", false
	}
	return strings.TrimSpace(trimmed[1 : end+1]), true
}
