package agentruntime

// OpenCode exposes build/plan as ACP session modes. Those modes select a
// workflow agent and are intentionally independent from Tutti's permission
// tiers. Permissions are enforced through OpenCode's permission config plus
// client-side resolution of ACP permission requests.

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

const (
	openCodePermissionReadOnly   = "read-only"
	openCodePermissionAsk        = "ask"
	openCodePermissionFullAccess = "full-access"
	openCodePermissionEnv        = "OPENCODE_PERMISSION"
	openCodeSparkModelID         = providerregistry.OpenCodeSparkModelID
)

func newOpenCodeAdapterFromProviderDescriptor(
	descriptor providerregistry.ProviderDescriptor,
	transport ProcessTransport,
	host HostMetadata,
	commandResolver ProviderCommandResolver,
) *standardACPAdapter {
	adapter := newStandardACPAdapterFromProviderDescriptor(descriptor, transport, host, commandResolver)
	settingsEnvironment := descriptor.Runtime.StandardACP.SettingsEnvironment
	adapter.config.env = func(session Session) []string {
		return standardACPEnv(session, host)
	}
	adapter.config.finalizeEnv = func(env []string, session Session) ([]string, error) {
		return openCodeFinalEnv(settingsEnvironment, session, os.Getenv(settingsEnvironment.Variable), env)
	}
	adapter.config.automaticPermissionDecision = openCodeAutomaticPermissionDecision
	adapter.config.filterPermissionOptions = openCodePermissionOptions
	adapter.config.validateSettings = validateOpenCodeSettings
	adapter.config.filterRuntimeConfigOptionDescriptors = filterOpenCodeRuntimeConfigOptionDescriptors
	adapter.config.filterRuntimeConfigOptionValues = filterOpenCodeRuntimeConfigOptionValues
	return adapter
}

func validateOpenCodeSettings(session Session, patch SessionSettingsPatch) error {
	settings := session.SettingsValue()
	if patch.Model != nil {
		settings.Model = strings.TrimSpace(*patch.Model)
	}
	if patch.ReasoningEffort != nil {
		settings.ReasoningEffort = strings.TrimSpace(*patch.ReasoningEffort)
	}
	model := strings.TrimSpace(settings.Model)
	effort := strings.TrimSpace(settings.ReasoningEffort)
	if providerregistry.OpenCodeModelSupportsReasoningEffort(model, effort) {
		return nil
	}
	// OpenCode's generic ACP descriptor advertises "none", but the selected
	// Spark model rejects it at session/prompt. Do not silently choose a
	// different reasoning level; the service-side model catalog filters this
	// value for normal launches, while this adapter guard protects stale or
	// out-of-band settings before any prompt is sent.
	return fmt.Errorf(
		"OpenCode model %q does not support reasoning effort %q; supported values: low, medium, high, xhigh",
		model,
		effort,
	)
}

func filterOpenCodeRuntimeConfigOptionDescriptors(
	session Session,
	descriptors []map[string]any,
) []map[string]any {
	filtered := cloneConfigOptionDescriptors(descriptors)
	if len(filtered) == 0 {
		return filtered
	}
	currentModel := strings.TrimSpace(session.SettingsValue().Model)
	for _, descriptor := range filtered {
		if strings.TrimSpace(asString(descriptor["id"])) == "model" {
			if currentModel == "" {
				currentModel = strings.TrimSpace(asString(descriptor["currentValue"]))
			}
			for _, option := range configOptionEntries(descriptor["options"]) {
				modelID := strings.TrimSpace(asString(option["value"]))
				if strings.EqualFold(modelID, openCodeSparkModelID) {
					filterOpenCodeModelReasoningEfforts(option)
				}
			}
			continue
		}
		if strings.TrimSpace(asString(descriptor["id"])) == "reasoning_effort" &&
			strings.EqualFold(currentModel, openCodeSparkModelID) {
			filterOpenCodeReasoningDescriptor(descriptor)
		}
	}
	return filtered
}

func filterOpenCodeRuntimeConfigOptionValues(
	session Session,
	values map[string]any,
) map[string]any {
	filtered := clonePayload(values)
	if len(filtered) == 0 {
		return filtered
	}
	currentModel := strings.TrimSpace(asString(filtered["model"]))
	if currentModel == "" {
		currentModel = strings.TrimSpace(session.SettingsValue().Model)
	}
	if strings.EqualFold(currentModel, openCodeSparkModelID) &&
		!providerregistry.OpenCodeModelSupportsReasoningEffort(
			openCodeSparkModelID,
			asString(filtered["reasoning_effort"]),
		) {
		delete(filtered, "reasoning_effort")
	}
	return filtered
}

func filterOpenCodeModelReasoningEfforts(option map[string]any) {
	efforts := configOptionEntries(option["reasoningEfforts"])
	if len(efforts) == 0 {
		return
	}
	filtered := make([]map[string]any, 0, len(efforts))
	for _, effort := range efforts {
		if providerregistry.OpenCodeModelSupportsReasoningEffort(
			openCodeSparkModelID,
			asString(effort["value"]),
		) {
			filtered = append(filtered, effort)
		}
	}
	option["reasoningEfforts"] = filtered
	if !providerregistry.OpenCodeModelSupportsReasoningEffort(
		openCodeSparkModelID,
		asString(option["reasoningEffort"]),
	) {
		if len(filtered) > 0 {
			option["reasoningEffort"] = asString(filtered[0]["value"])
		} else {
			delete(option, "reasoningEffort")
		}
	}
}

func filterOpenCodeReasoningDescriptor(descriptor map[string]any) {
	efforts := configOptionEntries(descriptor["options"])
	filtered := make([]map[string]any, 0, len(efforts))
	for _, effort := range efforts {
		if providerregistry.OpenCodeModelSupportsReasoningEffort(
			openCodeSparkModelID,
			asString(effort["value"]),
		) {
			filtered = append(filtered, effort)
		}
	}
	descriptor["options"] = filtered
	if !providerregistry.OpenCodeModelSupportsReasoningEffort(
		openCodeSparkModelID,
		asString(descriptor["currentValue"]),
	) && len(filtered) > 0 {
		descriptor["currentValue"] = asString(filtered[0]["value"])
	}
}

func openCodeConfigContent(
	descriptor providerregistry.RuntimeSettingsEnvironmentDescriptor,
	session Session,
	baseContent string,
) (string, error) {
	config := map[string]any{}
	if strings.TrimSpace(baseContent) != "" {
		if err := json.Unmarshal([]byte(baseContent), &config); err != nil {
			return "", fmt.Errorf("decode %s: %w", descriptor.Variable, err)
		}
		if config == nil {
			config = map[string]any{}
		}
	}
	if settings := runtimeSettingsEnvironmentValue(descriptor, session); settings != "" {
		var generated map[string]any
		if err := json.Unmarshal([]byte(settings), &generated); err != nil {
			return "", fmt.Errorf("decode generated %s: %w", descriptor.Variable, err)
		}
		for key, value := range generated {
			config[key] = value
		}
	}
	config["permission"] = openCodeInteractivePermissionRules()
	agents, _ := config["agent"].(map[string]any)
	if agents == nil {
		agents = map[string]any{}
	}
	plan, _ := agents["plan"].(map[string]any)
	if plan == nil {
		plan = map[string]any{}
	}
	planPermission, _ := plan["permission"].(map[string]any)
	if planPermission == nil {
		planPermission = map[string]any{}
	}
	planPermission["edit"] = "deny"
	plan["permission"] = planPermission
	agents["plan"] = plan
	config["agent"] = agents
	data, err := json.Marshal(config)
	if err != nil {
		return "", fmt.Errorf("encode %s: %w", descriptor.Variable, err)
	}
	return string(data), nil
}

func openCodeFinalEnv(
	descriptor providerregistry.RuntimeSettingsEnvironmentDescriptor,
	session Session,
	inheritedContent string,
	env []string,
) ([]string, error) {
	variable := strings.TrimSpace(descriptor.Variable)
	baseContent := inheritedContent
	for index := len(env) - 1; index >= 0; index-- {
		key, value, ok := strings.Cut(env[index], "=")
		if ok && strings.EqualFold(strings.TrimSpace(key), variable) {
			baseContent = value
			break
		}
	}
	content, err := openCodeConfigContent(descriptor, session, baseContent)
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(env)+1)
	for _, item := range env {
		key, _, ok := strings.Cut(item, "=")
		if ok && (strings.EqualFold(strings.TrimSpace(key), variable) ||
			strings.EqualFold(strings.TrimSpace(key), openCodePermissionEnv)) {
			continue
		}
		result = append(result, item)
	}
	return append(result, openCodePermissionEnv+"={}", variable+"="+content), nil
}

// OpenCode's default policy allows most tools without consulting the ACP
// client. This baseline keeps local read/search operations immediate while
// routing every other tool through session/request_permission, which lets the
// selected Tutti tier ask, approve, or deny it live. The protected .env rules
// mirror OpenCode's built-in defaults.
func openCodeInteractivePermissionRules() map[string]any {
	return map[string]any{
		"*":          "ask",
		"glob":       "allow",
		"grep":       "allow",
		"list":       "allow",
		"lsp":        "allow",
		"plan_enter": "allow",
		"plan_exit":  "allow",
		"question":   "allow",
		"read": map[string]any{
			"*":             "allow",
			"*.env":         "deny",
			"*.env.*":       "deny",
			"*.env.example": "allow",
		},
		"skill":     "allow",
		"todowrite": "allow",
	}
}

func openCodeAutomaticPermissionDecision(permissionModeID string) string {
	switch strings.TrimSpace(permissionModeID) {
	case openCodePermissionReadOnly:
		return "denied"
	case openCodePermissionFullAccess:
		return "approved"
	case openCodePermissionAsk:
		return ""
	default:
		return ""
	}
}

// "Always allow" mutates OpenCode's in-memory permission rules and cannot be
// revoked by an ACP permission-tier change. Keep approvals one-shot so moving
// from Ask or Full access to Read-only takes effect on the next request.
func openCodePermissionOptions(options []map[string]any) []map[string]any {
	result := make([]map[string]any, 0, len(options))
	for _, option := range options {
		kind := normalizePermissionOptionToken(asString(option["kind"]))
		if kind == "allowalways" {
			continue
		}
		result = append(result, option)
	}
	return result
}
