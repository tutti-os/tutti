package automationrule

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

// ExecutionRecorder persists automation launch attempts. The durable row is
// written before the target session exists so a duplicate trigger delivery
// or a daemon restart can never launch the same follow-up twice.
type ExecutionRecorder interface {
	RecordAutomationRuleExecution(context.Context, automationrulebiz.Execution) error
	MarkAutomationRuleExecutionLaunchFailed(ctx context.Context, workspaceID string, targetSessionID string, failureReason string) error
}

// DaemonExecutor launches the single automation behavior: one new target
// Agent session whose first message carries the rule prompt, a source
// session mention, and a short event note. It records an audit slog entry
// and a durable execution row instead of a CollaborationRun; the
// CollaborationRun infrastructure remains reserved for explicit user
// collaboration (@model consult, handoff menu).
type DaemonExecutor struct {
	Agents       *agentservice.Service
	Ledger       ExecutionRecorder
	IssueRescues IssueRescueCoordinator
}

func (e *DaemonExecutor) ExecuteAutomationRule(ctx context.Context, input ExecutionInput) (ExecutionResult, error) {
	if e == nil || e.Agents == nil {
		return ExecutionResult{}, fmt.Errorf("automation agent session service is unavailable")
	}
	if e.Ledger == nil {
		return ExecutionResult{}, fmt.Errorf("automation execution ledger is unavailable")
	}
	rule := input.Rule
	prompt := automationLaunchPrompt(rule, input.WorkspaceID, input.SourceSessionID)
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
			ExecutionDirectory:  cwd,
		})
		if err != nil {
			return ExecutionResult{}, err
		}
	}
	execution, err := automationrulebiz.NormalizeExecution(automationrulebiz.Execution{
		WorkspaceID:     input.WorkspaceID,
		RuleID:          rule.ID,
		SourceSessionID: input.SourceSessionID,
		TriggerID:       input.TriggerID,
		TargetSessionID: targetSessionID,
		Status:          automationrulebiz.ExecutionLaunched,
		CreatedAt:       time.Now().UTC(),
	})
	if err != nil {
		return ExecutionResult{}, e.failIssueRescue(ctx, rescuePreparation, input.WorkspaceID, targetSessionID, err)
	}
	if err := e.Ledger.RecordAutomationRuleExecution(ctx, execution); err != nil {
		return ExecutionResult{}, e.failIssueRescue(ctx, rescuePreparation, input.WorkspaceID, targetSessionID, err)
	}
	_, err = e.Agents.Create(ctx, input.WorkspaceID, agentservice.CreateSessionInput{
		AgentSessionID:         targetSessionID,
		AgentTargetID:          rule.Target.WorkspaceAgentID,
		InitialContent:         []agentservice.PromptContentBlock{{Type: "text", Text: prompt}},
		InitialDisplayPrompt:   automationLaunchDisplayPrompt(rule, input.SourceSessionID),
		Cwd:                    cwdPointer,
		PermissionModeID:       permissionModeID,
		StrictPermissionMode:   permissionModeID != nil,
		AgentTools:             append([]string(nil), rule.Permissions.AllowedTools...),
		AutomationRuleOverride: rescuePreparation.AutomationRuleOverride,
		ReasoningIntensity:     rescuePreparation.ReasoningIntensity,
		RuntimeContext: map[string]any{
			"automation": map[string]any{
				"ruleId":          rule.ID,
				"sourceSessionId": input.SourceSessionID,
				"depth":           input.AutomationDepth + 1,
			},
		},
		Metadata: map[string]any{
			"automationRuleId": rule.ID,
		},
	})
	if err != nil {
		if markErr := e.Ledger.MarkAutomationRuleExecutionLaunchFailed(ctx, input.WorkspaceID, targetSessionID, err.Error()); markErr != nil {
			slog.Warn("automation execution failure bookkeeping failed",
				"event", "automation_rule.execution_mark_failed",
				"workspace_id", input.WorkspaceID,
				"rule_id", rule.ID,
				"target_session_id", targetSessionID,
				"error", markErr)
		}
		slog.Warn("automation rule target session launch failed",
			"event", "automation_rule.session_launch_failed",
			"workspace_id", input.WorkspaceID,
			"rule_id", rule.ID,
			"trigger", string(rule.Trigger),
			"source_session_id", input.SourceSessionID,
			"target_session_id", targetSessionID,
			"agent_target_id", rule.Target.WorkspaceAgentID,
			"error", err)
		return ExecutionResult{}, e.failIssueRescue(ctx, rescuePreparation, input.WorkspaceID, targetSessionID, err)
	}
	slog.Info("automation rule launched target session",
		"event", "automation_rule.session_launched",
		"workspace_id", input.WorkspaceID,
		"rule_id", rule.ID,
		"trigger", string(rule.Trigger),
		"source_session_id", input.SourceSessionID,
		"target_session_id", targetSessionID,
		"agent_target_id", rule.Target.WorkspaceAgentID,
		"permission_mode_id", rule.Permissions.PermissionModeID,
		"allowed_tools", len(rule.Permissions.AllowedTools),
		"automation_depth", input.AutomationDepth+1)
	return ExecutionResult{TargetSessionID: targetSessionID}, nil
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

// AutomationSourceCwd implements SourceReader. Only the working directory is
// copied from the source session; conversation context travels through the
// session mention in the first message.
func (e *DaemonExecutor) AutomationSourceCwd(ctx context.Context, workspaceID string, sessionID string) (string, error) {
	if e == nil || e.Agents == nil {
		return "", fmt.Errorf("automation agent session service is unavailable")
	}
	session, err := e.Agents.Get(ctx, workspaceID, sessionID)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(session.Cwd), nil
}

// automationLaunchPrompt composes the fixed first-message contract: rule
// prompt, source session mention, then a short event note.
func automationLaunchPrompt(rule automationrulebiz.Rule, workspaceID string, sourceSessionID string) string {
	instruction := strings.TrimSpace(rule.Prompt)
	if instruction == "" {
		instruction = "Take over the follow-up work for the source session's task and report the result clearly."
	}
	mention := "Source session: mention://agent-session/" + strings.TrimSpace(sourceSessionID) +
		"?workspaceId=" + url.QueryEscape(strings.TrimSpace(workspaceID))
	note := "Automation event: the source session's task completed."
	if rule.Trigger == automationrulebiz.TriggerOnTaskFailed {
		note = "Automation event: the source session's task failed or was interrupted."
	}
	return strings.Join([]string{instruction, mention, note}, "\n\n")
}

func automationLaunchDisplayPrompt(rule automationrulebiz.Rule, sourceSessionID string) string {
	return fmt.Sprintf("Automation %q follow-up for session %s", rule.Name, strings.TrimSpace(sourceSessionID))
}
