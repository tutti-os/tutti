package automationrule

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/url"
	"strings"

	"github.com/google/uuid"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	collabrunservice "github.com/tutti-os/tutti/services/tuttid/service/collabrun"
)

const (
	maxAutomationContextMessages = 48
	maxAutomationContextChars    = 32 * 1024
)

// DaemonExecutor uses the existing collaboration ledger and agent-session
// creation path. It also implements ContextReader and UsageReader, so one
// instance can be wired into all three Service collaborators.
type DaemonExecutor struct {
	Agents       *agentservice.Service
	Runs         *collabrunservice.Service
	IssueRescues IssueRescueCoordinator
}

func (e *DaemonExecutor) ExecuteAutomationRule(ctx context.Context, input ExecutionInput) (ExecutionResult, error) {
	if e == nil || e.Runs == nil {
		return ExecutionResult{}, fmt.Errorf("automation collaboration runner is unavailable")
	}
	rule := input.Rule
	reason := automationTriggerReason(rule.ID, input.TriggerID)
	if rule.Action == automationrulebiz.ActionConsult {
		question := strings.TrimSpace(rule.Prompt)
		if question == "" {
			question = "Review the completed work and identify correctness risks, missing validation, and concrete follow-up actions."
		}
		maxTokens := input.MaxOutputTokens
		if maxTokens <= 0 || maxTokens > 2048 {
			maxTokens = 2048
		}
		run, err := e.Runs.StartConsult(ctx, collabrunservice.StartConsultInput{
			WorkspaceID:     input.WorkspaceID,
			SourceSessionID: input.SourceSessionID,
			ModelPlanID:     rule.Target.ModelPlanID,
			Model:           rule.Target.Model,
			Question:        question,
			ContextText:     input.SourceContext,
			TriggerSource:   string(collabrunbiz.TriggerAutomation),
			TriggerReason:   reason,
			MaxTokens:       maxTokens,
		})
		if err != nil {
			return ExecutionResult{}, err
		}
		return ExecutionResult{
			RunID:       run.ID,
			TotalTokens: run.Usage.Total(),
			ResultText:  run.ResultText,
			Failed:      run.Status != collabrunbiz.StatusCompleted,
		}, nil
	}
	if e.Agents == nil {
		return ExecutionResult{}, fmt.Errorf("automation agent session service is unavailable")
	}
	instruction := automationAgentInstruction(rule)
	prompt := automationAgentPrompt(instruction, input.WorkspaceID, input.SourceSessionID, input.SourceContext)
	cwd := strings.TrimSpace(input.SourceCwd)
	var cwdPointer *string
	if cwd != "" {
		cwdPointer = &cwd
	}
	var permissionModeID *string
	if value := strings.TrimSpace(rule.Permissions.PermissionModeID); value != "" {
		permissionModeID = &value
	}
	targetSessionID := uuid.NewString()
	rescuePreparation := IssueRescuePreparation{}
	var err error
	if rule.Trigger == automationrulebiz.TriggerOnTaskFailed && e.IssueRescues != nil {
		rescuePreparation, err = e.IssueRescues.BeginAutomationIssueRescue(ctx, IssueRescueInput{
			WorkspaceID:         input.WorkspaceID,
			RuleID:              rule.ID,
			SourceSessionID:     input.SourceSessionID,
			TargetSessionID:     targetSessionID,
			TargetAgentTargetID: rule.Target.WorkspaceAgentID,
			ModelPlanID:         rule.Target.ModelPlanID,
			Model:               rule.Target.Model,
			ExecutionDirectory:  cwd,
		})
		if err != nil {
			return ExecutionResult{}, err
		}
	}
	run, err := e.Runs.RecordRun(ctx, collabrunservice.RecordRunInput{
		WorkspaceID:         input.WorkspaceID,
		Mode:                string(rule.Action),
		SourceSessionID:     input.SourceSessionID,
		TargetSessionID:     targetSessionID,
		TargetAgentTargetID: rule.Target.WorkspaceAgentID,
		ModelPlanID:         rule.Target.ModelPlanID,
		Model:               rule.Target.Model,
		ContextScope:        automationContextScope(input.SourceContext),
		Prompt:              instruction,
		RequestText:         instruction,
		ContextText:         input.SourceContext,
		TriggerSource:       string(collabrunbiz.TriggerAutomation),
		TriggerReason:       reason,
	})
	if err != nil {
		return ExecutionResult{}, e.failIssueRescue(ctx, rescuePreparation, input.WorkspaceID, targetSessionID, err)
	}
	_, err = e.Agents.Create(ctx, input.WorkspaceID, agentservice.CreateSessionInput{
		AgentSessionID:         targetSessionID,
		AgentTargetID:          rule.Target.WorkspaceAgentID,
		InitialContent:         []agentservice.PromptContentBlock{{Type: "text", Text: prompt}},
		InitialDisplayPrompt:   automationAgentDisplayPrompt(rule, input.SourceSessionID),
		Cwd:                    cwdPointer,
		PermissionModeID:       permissionModeID,
		StrictPermissionMode:   permissionModeID != nil,
		AgentTools:             append([]string(nil), rule.Permissions.AllowedTools...),
		AutomationRuleOverride: rescuePreparation.AutomationRuleOverride,
		ReasoningIntensity:     rescuePreparation.ReasoningIntensity,
		RuntimeContext: map[string]any{
			"automation": map[string]any{
				"ruleId":          rule.ID,
				"action":          string(rule.Action),
				"sourceSessionId": input.SourceSessionID,
				"depth":           input.AutomationDepth + 1,
			},
		},
		Metadata: map[string]any{
			"automationRuleId": rule.ID,
			"automationAction": string(rule.Action),
		},
	})
	if err != nil {
		_, _ = e.Runs.SettleRun(ctx, input.WorkspaceID, run.ID, collabrunservice.SettleRunInput{
			Status:        string(collabrunbiz.StatusFailed),
			FailureReason: err.Error(),
			FailureStage:  "target_launch",
		})
		return ExecutionResult{}, e.failIssueRescue(ctx, rescuePreparation, input.WorkspaceID, targetSessionID, err)
	}
	return ExecutionResult{RunID: run.ID}, nil
}

func (e *DaemonExecutor) failIssueRescue(
	ctx context.Context,
	preparation IssueRescuePreparation,
	workspaceID string,
	targetSessionID string,
	cause error,
) error {
	if !preparation.Associated || e.IssueRescues == nil {
		return cause
	}
	if err := e.IssueRescues.FailAutomationIssueRescue(ctx, IssueRescueFailureInput{
		WorkspaceID:     workspaceID,
		TargetSessionID: targetSessionID,
		ErrorMessage:    cause.Error(),
	}); err != nil {
		return fmt.Errorf("%w; fail associated Issue rescue: %v", cause, err)
	}
	return cause
}

func (e *DaemonExecutor) AutomationRuleUsage(ctx context.Context, workspaceID string, sourceSessionID string, ruleID string) (int, int64, error) {
	if e == nil || e.Runs == nil {
		return 0, 0, fmt.Errorf("automation collaboration runner is unavailable")
	}
	runs, err := e.Runs.ListRuns(ctx, workspaceID, sourceSessionID, 0)
	if err != nil {
		return 0, 0, err
	}
	prefix := automationTriggerReasonPrefix(ruleID)
	count := 0
	var tokens int64
	for _, run := range runs {
		if run.TriggerSource != collabrunbiz.TriggerAutomation || !strings.HasPrefix(run.TriggerReason, prefix) {
			continue
		}
		count++
		tokens += run.Usage.Total()
	}
	return count, tokens, nil
}

func (e *DaemonExecutor) AutomationRuleExecutionExists(ctx context.Context, workspaceID string, sourceSessionID string, ruleID string, triggerID string) (bool, error) {
	if e == nil || e.Runs == nil {
		return false, fmt.Errorf("automation collaboration runner is unavailable")
	}
	runs, err := e.Runs.ListRuns(ctx, workspaceID, sourceSessionID, 0)
	if err != nil {
		return false, err
	}
	reason := automationTriggerReason(ruleID, triggerID)
	for _, run := range runs {
		if run.TriggerSource == collabrunbiz.TriggerAutomation && run.TriggerReason == reason {
			return true, nil
		}
	}
	return false, nil
}

func (e *DaemonExecutor) AutomationSourceContext(ctx context.Context, workspaceID string, sessionID string) (string, string, error) {
	if e == nil || e.Agents == nil {
		return "", "", fmt.Errorf("automation agent session service is unavailable")
	}
	session, err := e.Agents.Get(ctx, workspaceID, sessionID)
	if err != nil {
		return "", "", err
	}
	page, err := e.Agents.ListMessages(ctx, workspaceID, sessionID, agentservice.ListMessagesInput{
		Limit: maxAutomationContextMessages,
		Order: agentactivitybiz.MessageOrderDesc,
	})
	if err != nil {
		return "", "", err
	}
	// The API returns newest-first for a descending page; reverse the bounded
	// page so the model sees conversational order.
	lines := make([]string, 0, len(page.Messages))
	for index := len(page.Messages) - 1; index >= 0; index-- {
		message := page.Messages[index]
		role := strings.TrimSpace(message.Role)
		if role != "user" && role != "assistant" {
			continue
		}
		text := automationMessageText(message.Payload)
		if text == "" {
			continue
		}
		lines = append(lines, strings.ToUpper(role[:1])+role[1:]+": "+text)
	}
	contextText := strings.Join(lines, "\n\n")
	if len(contextText) > maxAutomationContextChars {
		contextText = contextText[len(contextText)-maxAutomationContextChars:]
		contextText = "[Earlier context omitted]\n\n" + strings.TrimLeft(contextText, "\n")
	}
	return strings.TrimSpace(session.Cwd), strings.TrimSpace(contextText), nil
}

func automationMessageText(payload map[string]any) string {
	for _, key := range []string{"text", "content", "message"} {
		if value, ok := payload[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	blocks, _ := payload["content"].([]any)
	parts := make([]string, 0, len(blocks))
	for _, raw := range blocks {
		block, _ := raw.(map[string]any)
		text, _ := block["text"].(string)
		if strings.TrimSpace(text) != "" {
			parts = append(parts, strings.TrimSpace(text))
		}
	}
	return strings.Join(parts, "\n")
}

func automationAgentInstruction(rule automationrulebiz.Rule) string {
	instruction := strings.TrimSpace(rule.Prompt)
	if instruction == "" {
		switch rule.Action {
		case automationrulebiz.ActionFork:
			instruction = "Create an independent continuation of this work. Re-evaluate the approach and produce a complete result in this new session."
		case automationrulebiz.ActionDelegate:
			instruction = "Take ownership of the delegated follow-up. Complete it and report the result clearly."
		case automationrulebiz.ActionHandoff:
			instruction = "Continue the work from the source session and take ownership of the next steps."
		}
	}
	return instruction
}

func automationAgentPrompt(instruction string, workspaceID string, sourceSessionID string, sourceContext string) string {
	sections := []string{
		strings.TrimSpace(instruction),
		"Source session: mention://agent-session/" + strings.TrimSpace(sourceSessionID) + "?workspaceId=" + url.QueryEscape(strings.TrimSpace(workspaceID)),
	}
	if contextText := strings.TrimSpace(sourceContext); contextText != "" {
		sections = append(sections, "Source conversation context:\n\n"+contextText)
	}
	return strings.Join(sections, "\n\n")
}

func automationAgentDisplayPrompt(rule automationrulebiz.Rule, sourceSessionID string) string {
	action := string(rule.Action)
	if action != "" {
		action = strings.ToUpper(action[:1]) + action[1:]
	}
	return fmt.Sprintf("%s from session %s", action, strings.TrimSpace(sourceSessionID))
}

func automationTriggerReason(ruleID string, triggerID string) string {
	digest := sha256.Sum256([]byte(strings.TrimSpace(triggerID)))
	return fmt.Sprintf("%s%x", automationTriggerReasonPrefix(ruleID), digest[:8])
}

func automationTriggerReasonPrefix(ruleID string) string {
	return "automation_rule:" + strings.TrimSpace(ruleID) + ":"
}

func automationContextScope(value string) string {
	if strings.TrimSpace(value) == "" {
		return "none"
	}
	return "bounded_transcript"
}
