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
	return adapter
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
