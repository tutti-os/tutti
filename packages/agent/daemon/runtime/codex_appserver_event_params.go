package agentruntime

import (
	"encoding/json"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func appServerThreadReasoningSummaryConfig(model string) string {
	model = strings.TrimSpace(model)
	if model == "" || codexACPModelDisablesReasoningSummary(model) {
		return "auto"
	}
	return ""
}

func appServerThreadStartParams(session Session, cwd string) map[string]any {
	settings := session.SettingsValue()
	params := map[string]any{
		"cwd": firstNonEmpty(cwd, "/"),
	}
	if model := strings.TrimSpace(settings.Model); model != "" {
		params["model"] = model
	}
	config := map[string]any{}
	if reasoning := codexAppServerReasoningEffortValue(settings.ReasoningEffort); reasoning != "" {
		config["model_reasoning_effort"] = reasoning
	}
	if summary := appServerThreadReasoningSummaryConfig(settings.Model); summary != "" {
		config[codexACPConfigModelReasoningSummary] = summary
	}
	if serviceTier := codexServiceTierValue(settings.Speed); serviceTier != "" {
		config["service_tier"] = serviceTier
	}
	if len(config) > 0 {
		params["config"] = config
	}
	if approvalPolicy := codexAppServerApprovalPolicy(session.PermissionModeID); approvalPolicy != "" {
		params["approvalPolicy"] = approvalPolicy
	}
	if sandbox := codexAppServerSandboxMode(session.PermissionModeID); sandbox != "" {
		params["sandbox"] = sandbox
	}
	if approvalsReviewer := codexAppServerApprovalsReviewer(session.PermissionModeID); approvalsReviewer != "" {
		params["approvalsReviewer"] = approvalsReviewer
	}
	return params
}

func appServerTurnStartParams(
	session Session,
	threadID string,
	content []PromptContentBlock,
	planModeMask map[string]any,
	defaultModeMask map[string]any,
	defaultModel string,
	commandNetworkAccess bool,
	tuttiModeHostContext string,
) map[string]any {
	settings := session.SettingsValue()
	userInput := appServerUserInput(content)
	params := map[string]any{
		"threadId": threadID,
		"input":    userInput,
	}
	if collaborationMode := appServerCollaborationMode(settings, planModeMask, defaultModeMask, defaultModel, tuttiModeHostContext); collaborationMode != nil {
		params["collaborationMode"] = collaborationMode
	} else if hostContext := strings.TrimSpace(tuttiModeHostContext); hostContext != "" {
		// collaborationMode/list is an experimental capability and can be absent
		// or fail transiently. Preserve Tutti-owned turn state through a
		// provider-transport-only synthetic block instead of silently dropping
		// it. User prompt previews and activity projection continue to use the
		// original content passed to this function.
		params["input"] = append(userInput, map[string]any{
			"type": "text",
			"text": hostContext,
		})
	}
	if model := strings.TrimSpace(settings.Model); model != "" {
		params["model"] = model
	}
	if reasoning := codexAppServerReasoningEffortValue(settings.ReasoningEffort); reasoning != "" {
		params["effort"] = reasoning
	}
	if summary := codexACPReasoningSummaryOverride(settings.Model); summary != "" {
		params["summary"] = summary
	}
	if approvalPolicy := codexAppServerApprovalPolicy(session.PermissionModeID); approvalPolicy != "" {
		params["approvalPolicy"] = approvalPolicy
	}
	if sandboxPolicy := codexAppServerSandboxPolicy(session.PermissionModeID, commandNetworkAccess); sandboxPolicy != nil {
		params["sandboxPolicy"] = sandboxPolicy
	}
	if approvalsReviewer := codexAppServerApprovalsReviewer(session.PermissionModeID); approvalsReviewer != "" {
		params["approvalsReviewer"] = approvalsReviewer
	}
	return params
}

// appServerCollaborationMode assembles the turn/start collaborationMode
// payload. Collaboration mode is sticky thread state on the codex side, so
// once negotiation succeeded every turn declares its mode explicitly: the
// Plan preset while plan mode is on, the default mode otherwise (mirrors the
// codex TUI, which switches modes by submitting with the target mask). The
// schema requires a concrete settings.model — session override first, then
// the session default model, then the mask's own model; without any model
// the field is omitted rather than sending an invalid request.
func appServerCollaborationMode(
	settings SessionSettings,
	planModeMask map[string]any,
	defaultModeMask map[string]any,
	defaultModel string,
	tuttiModeHostContext string,
) map[string]any {
	if planModeMask == nil && defaultModeMask == nil {
		return nil
	}
	mode := "default"
	modeMask := defaultModeMask
	if settings.PlanMode {
		if planModeMask == nil {
			return nil
		}
		modeMask = planModeMask
		mode = strings.ToLower(strings.TrimSpace(firstNonEmpty(asString(planModeMask["mode"]), "plan")))
	}
	model := strings.TrimSpace(firstNonEmpty(settings.Model, defaultModel, asString(modeMask["model"])))
	if model == "" {
		return nil
	}
	baseDeveloperInstructions, _ := appServerCollaborationModeDeveloperInstructions(modeMask).(string)
	developerInstructions := strings.TrimSpace(baseDeveloperInstructions)
	if hostContext := strings.TrimSpace(tuttiModeHostContext); hostContext != "" {
		if developerInstructions == "" {
			developerInstructions = hostContext
		} else {
			developerInstructions += "\n\n" + hostContext
		}
	}
	collaborationSettings := map[string]any{"model": model}
	if developerInstructions != "" {
		collaborationSettings["developer_instructions"] = developerInstructions
	}
	if effort := codexAppServerReasoningEffortValue(settings.ReasoningEffort); effort != "" {
		collaborationSettings["reasoning_effort"] = effort
	} else if settings.PlanMode {
		if presetEffort := strings.TrimSpace(asString(modeMask["reasoning_effort"])); presetEffort != "" {
			collaborationSettings["reasoning_effort"] = presetEffort
		} else {
			collaborationSettings["reasoning_effort"] = nil
		}
	} else {
		collaborationSettings["reasoning_effort"] = nil
	}
	return map[string]any{
		"mode":     mode,
		"settings": collaborationSettings,
	}
}

func appServerCollaborationModeDeveloperInstructions(modeMask map[string]any) any {
	if modeMask == nil {
		return nil
	}
	if text, ok := modeMask["developer_instructions"].(string); ok && strings.TrimSpace(text) != "" {
		return text
	}
	if settings := payloadObject(modeMask["settings"]); settings != nil {
		if text, ok := settings["developer_instructions"].(string); ok && strings.TrimSpace(text) != "" {
			return text
		}
	}
	return nil
}

func appServerUserInput(content []PromptContentBlock) []map[string]any {
	out := make([]map[string]any, 0, len(content))
	for _, block := range content {
		switch block.Type {
		case "text":
			out = append(out, map[string]any{
				"type": "text",
				"text": block.Text,
			})
		case "image":
			url := strings.TrimSpace(block.URL)
			if url == "" {
				url = "data:" + firstNonEmpty(block.MimeType, "image/png") + ";base64," + block.Data
			}
			out = append(out, map[string]any{
				"type": "image",
				"url":  url,
			})
		case "skill", "mention":
			item := map[string]any{
				"type": block.Type,
				"name": block.Name,
				"path": block.Path,
			}
			out = append(out, item)
		}
	}
	return out
}

func appServerGoalSlashRequest(args string, threadID string) (string, map[string]any) {
	params := map[string]any{"threadId": threadID}
	args = strings.TrimSpace(args)
	if args == "" {
		return appServerMethodThreadGoalGet, params
	}
	if strings.EqualFold(args, "clear") {
		return appServerMethodThreadGoalClear, params
	}
	if status := appServerGoalStatus(args); status != "" {
		params["status"] = status
		return appServerMethodThreadGoalSet, params
	}
	params["objective"] = args
	params["status"] = "active"
	return appServerMethodThreadGoalSet, params
}

func appServerGoalStatus(value string) string {
	normalized := strings.ToLower(strings.NewReplacer("-", "", "_", "", " ", "").Replace(strings.TrimSpace(value)))
	switch normalized {
	case "active":
		return "active"
	case "pause", "paused":
		return "paused"
	case "block", "blocked":
		return "blocked"
	case "usagelimited":
		return "usageLimited"
	case "budgetlimited":
		return "budgetLimited"
	case "done", "complete", "completed":
		return "complete"
	default:
		return ""
	}
}

func appServerGoalFromResult(result json.RawMessage) map[string]any {
	if len(result) == 0 {
		return nil
	}
	var payload map[string]any
	if err := json.Unmarshal(result, &payload); err != nil {
		return nil
	}
	return payloadObject(payload["goal"])
}

func appServerGoalNoticeEvent(session Session, turnID string, method string, result json.RawMessage) *activityshared.Event {
	switch method {
	case appServerMethodThreadGoalClear:
		event := appServerSystemNoticeEvent(session, turnID, "system_notice", "Goal cleared.", "")
		return &event
	case appServerMethodThreadGoalGet:
		goal := appServerGoalFromResult(result)
		if len(goal) == 0 {
			event := appServerSystemNoticeEvent(session, turnID, "system_notice", "No active goal.", "")
			return &event
		}
		event := appServerSystemNoticeEvent(session, turnID, "system_notice", "Current goal: "+asStringRaw(goal["objective"]), appServerGoalStatusDetail(goal))
		return &event
	case appServerMethodThreadGoalSet:
		goal := appServerGoalFromResult(result)
		detail := appServerGoalStatusDetail(goal)
		event := appServerSystemNoticeEvent(session, turnID, "system_notice", "Goal updated.", detail)
		return &event
	default:
		return nil
	}
}

// appServerGoalStatusNoticeEvent describes a goal status transition into a
// non-progressing state the user did not ask for, so they learn why the goal
// stopped advancing. Deliberate transitions (paused via Stop or the banner)
// emit nothing: the banner already shows the state and repeated toggles would
// spam the transcript.
func appServerGoalStatusNoticeEvent(session Session, turnID string, newStatus string) *activityshared.Event {
	title := ""
	switch newStatus {
	case "blocked":
		title = "Goal blocked — the agent cannot continue without help."
	case "usageLimited":
		title = "Goal stopped: usage limit reached."
	case "budgetLimited":
		title = "Goal stopped: token budget exhausted."
	default:
		return nil
	}
	event := appServerSystemNoticeEvent(session, turnID, "system_notice", title, "")
	return &event
}

func appServerGoalStatusDetail(goal map[string]any) string {
	status := strings.TrimSpace(asString(goal["status"]))
	if status == "" {
		return ""
	}
	if objective := strings.TrimSpace(asStringRaw(goal["objective"])); objective != "" {
		return "status: " + status + "\nobjective: " + objective
	}
	return "status: " + status
}

func splitSlashCommand(prompt string) (string, string) {
	trimmed := strings.TrimSpace(prompt)
	if !strings.HasPrefix(trimmed, "/") {
		return "", ""
	}
	command, args, _ := strings.Cut(trimmed, " ")
	return strings.ToLower(strings.TrimSpace(command)), strings.TrimSpace(args)
}

// codexAppServerApprovalPolicy maps Tutti permission modes onto the
// app-server AskForApproval policy.
func codexAppServerApprovalPolicy(modeID string) string {
	switch codexACPModeID(modeID) {
	case "read-only", "auto":
		return "on-request"
	case "full-access":
		return "never"
	default:
		return ""
	}
}

func codexAppServerSandboxMode(modeID string) string {
	switch codexACPModeID(modeID) {
	case "read-only":
		return "read-only"
	case "auto":
		return "workspace-write"
	case "full-access":
		return "danger-full-access"
	default:
		return ""
	}
}

func codexAppServerSandboxPolicy(modeID string, commandNetworkAccess bool) map[string]any {
	var policy map[string]any
	switch codexACPModeID(modeID) {
	case "read-only":
		policy = map[string]any{"type": "readOnly"}
	case "auto":
		policy = map[string]any{"type": "workspaceWrite"}
	case "full-access":
		return map[string]any{"type": "dangerFullAccess"}
	default:
		return nil
	}
	if commandNetworkAccess {
		policy["networkAccess"] = true
	}
	return policy
}

func codexAppServerApprovalsReviewer(modeID string) string {
	switch codexACPModeID(modeID) {
	case "read-only":
		return "user"
	case "auto":
		return "auto_review"
	default:
		return ""
	}
}

// --- response decoding helpers ---
