package agentruntime

import "strings"

const (
	codexACPConfigModelReasoningSummary = "model_reasoning_summary"
	codexACPReasoningSummaryNone        = "none"
)

var codexACPModelsWithoutReasoningSummary = map[string]struct{}{
	"gpt-5.3-codex-spark": {},
}

func codexACPReasoningSummaryOverride(model string) string {
	if codexACPModelDisablesReasoningSummary(model) {
		return codexACPReasoningSummaryNone
	}
	return ""
}

func codexACPModelDisablesReasoningSummary(model string) bool {
	_, ok := codexACPModelsWithoutReasoningSummary[strings.ToLower(strings.TrimSpace(model))]
	return ok
}

func codexACPReasoningEffortValue(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "minimal":
		return "minimal"
	case "low":
		return "low"
	case "medium":
		return "medium"
	case "high":
		return "high"
	case "max", "xhigh":
		return "xhigh"
	default:
		return ""
	}
}

// codexServiceTierValue maps the orthogonal speed tier onto the codex
// app-server `service_tier` config value. The "fast" tier is sent verbatim;
// the codex app-server maps the legacy `fast` config onto the request value
// `priority` ("1.5x speed, increased usage"). The default/standard tier is
// represented by an empty value so the request omits the override.
func codexServiceTierValue(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "fast", "priority":
		return "fast"
	default:
		return ""
	}
}

func codexACPModeID(mode string) string {
	switch strings.TrimSpace(mode) {
	case "read-only":
		return "read-only"
	case "auto":
		return "auto"
	case "full-access":
		return "full-access"
	default:
		return ""
	}
}

func codexACPEffectiveModeID(session Session) string {
	return codexACPModeID(session.PermissionModeID)
}

func projectCodexWorkspaceCWD(cwd, roomID string) string {
	roomID = strings.Trim(strings.TrimSpace(roomID), "/")
	if cwd == "" || roomID == "" || strings.Contains(roomID, "/") {
		return cwd
	}
	workspaceRoot := "/workspace/" + roomID
	if cwd == workspaceRoot {
		return "/workspace"
	}
	if strings.HasPrefix(cwd, workspaceRoot+"/") {
		return "/workspace" + strings.TrimPrefix(cwd, workspaceRoot)
	}
	return cwd
}
